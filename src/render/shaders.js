/* AUTO-MOVED from the original single-file index.html — do not hand-edit
 * section contents without checking against git history. */
'use strict';

import { showFatal } from '../core/util.js';
/* ==========================================================================
 * === SHADERS ==============================================================
 * GLSL 300 es, embedded as strings.
 * ==========================================================================*/
const VS_MESH = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUV;
layout(location=3) in vec4 aJoints;
layout(location=4) in vec4 aWeights;
layout(location=5) in vec3 aColor;   // COLOR_0 (constant 1 when absent)
uniform mat4 uModel, uViewProj, uLightVP;
uniform mat3 uNormalMat;
uniform bool uSkinned;
uniform sampler2D uJointTex;   // packed skin matrices (RGBA32F, 4 texels/matrix)
uniform int uJointTexW;
out vec3 vWorld; out vec3 vNormal; out vec2 vUV; out vec3 vColor;
mat4 skinMatrix(float idx){
  int b = int(idx) * 4;
  int x = b % uJointTexW; int y = b / uJointTexW;
  mat4 m;
  for(int i=0;i<4;i++){
    ivec2 tc = ivec2(x + i, y);
    m[i] = texelFetch(uJointTex, tc, 0);
  }
  return m;
}
void main(){
  vec3 p = aPos; vec3 n = aNormal;
  if(uSkinned){
    mat4 sm = skinMatrix(aJoints.x)*aWeights.x + skinMatrix(aJoints.y)*aWeights.y
            + skinMatrix(aJoints.z)*aWeights.z + skinMatrix(aJoints.w)*aWeights.w;
    p = (sm * vec4(aPos,1.0)).xyz;
    n = normalize(mat3(sm) * n);
  }
  vec4 wp = uModel * vec4(p,1.0);
  vWorld = wp.xyz;
  vNormal = normalize(uNormalMat * n);
  vUV = aUV;
  vColor = aColor;
  gl_Position = uViewProj * wp;
}`;

const FS_MESH = `#version 300 es
precision highp float;
in vec3 vWorld; in vec3 vNormal; in vec2 vUV; in vec3 vColor;
out vec4 fragColor;
uniform vec3 uCamPos, uBaseColor, uEmissive, uLightDir, uLightColor, uSkyColor, uGroundColor, uFogColor;
uniform float uMetallic, uRoughness, uAlpha, uEmissiveBoost, uFogDensity, uTime, uHitFlash;
uniform int uUseBaseTex, uUnlit, uReceiveShadow;
uniform sampler2D uBaseTexS;      // baseColor map (unit 0) — declared here so it is never optimized out
uniform bool uUseVColor;          // fold per-vertex COLOR_0 into albedo (city props)
uniform highp sampler2DShadow uShadowMap;   // hardware PCF depth texture
uniform mat4 uLightVP;
uniform sampler2D uPointColors;   // RGBA32F texture: xyz=color, w=intensity, up to 8 lights
uniform int uNumPoints;
uniform vec3 uPointPos[8];
uniform float uShadowBias;
uniform int uUseLightmap;
uniform sampler2D uLightmap;      // R = baked AO toward sun, G = dynamic scorch heat
uniform vec4 uLMRect;             // world-space origin + cell size (minX, minZ, dx, dz)
const float PI = 3.14159265359;
float D_GGX(float nh, float r){ float a = r*r; float d = nh*nh*(a*a-1.0)+1.0; return a*a/(PI*d*d+1e-7); }
float V_SmithGGX(float nv,float nl,float r){ float a=r*r; float gv=nv*sqrt(nl*nl*(1.0-a*a)+a*a); float gl=nl*sqrt(nv*nv*(1.0-a*a)+a*a); return 0.5/max(gv+gl,1e-6); }
vec3 F_Schlick(vec3 f0,float u){ return f0 + (1.0-f0)*pow(1.0-u,5.0); }
vec3 fresnelRoughness(float ct, vec3 f0, float rough){
  return f0 + (max(vec3(1.0-rough),f0)-f0)*pow(clamp(1.0-ct,0.0,1.0),5.0);
}
/** Shadow lookup: world-space offset along the normal kills acne on thin
 *  geometry, constant depth bias handles the rest, hardware PCF smooths edges. */
float shadowFactor(vec3 wpos, vec3 n, vec3 lightDir){
  if(uReceiveShadow==0) return 1.0;
  vec4 ls = uLightVP * vec4(wpos + n*uShadowBias*2.0 + lightDir*uShadowBias, 1.0);
  vec3 sc = ls.xyz/ls.w*0.5+0.5;
  if(sc.z>1.0||sc.x<0.0||sc.x>1.0||sc.y<0.0||sc.y>1.0) return 1.0;
  return texture(uShadowMap, sc.xy);
}
vec3 lighting(vec3 albedo, float metal, float rough, vec3 n, vec3 v){
  vec3 f0 = mix(vec3(0.04), albedo, metal);
  vec3 diffCol = albedo*(1.0-metal);
  vec3 Ldir = normalize(uLightDir);          // direction TOWARD the sun
  vec3 L = -Ldir;                            // light travel direction
  vec3 H = normalize(L+v);
  float nh=max(dot(n,H),0.0), nl=max(dot(n,L),0.0), nv=max(dot(n,v),1e-4);
  float sh = shadowFactor(vWorld, n, Ldir);
  vec3 spec = F_Schlick(f0,max(dot(H,v),0.0))*D_GGX(nh,rough)*V_SmithGGX(nv,nl,rough)*nl*uLightColor*sh;
  vec3 diff = diffCol*nl*uLightColor*sh*0.85;
  // hemisphere ambient IBL approximation
  float hemi = dot(n, vec3(0.0,1.0,0.0))*0.5+0.5;
  vec3 amb = mix(uGroundColor, uSkyColor, hemi)*mix(vec3(1.0),albedo,metal)*0.55;
  vec3 envSpec = mix(uGroundColor,uSkyColor,hemi)*fresnelRoughness(nv,f0,rough)*(1.0-rough)*0.6;
  // point lights (tracer bolts + impacts)
  vec3 pts = vec3(0.0);
  for(int i=0;i<8;i++){
    if(i>=uNumPoints) break;
    vec3 dl = uPointPos[i]-vWorld; float dist=length(dl);
    vec3 col = texture(uPointColors, vec2((float(i)+0.5)/8.0,0.5)).rgb;
    float inten = texture(uPointColors, vec2((float(i)+0.5)/8.0,0.5)).a;
    float att = inten/(1.0+dist*dist*0.09);
    vec3 pl = dl/max(dist,1e-4);
    vec3 ph = normalize(pl+v);
    float pnl = max(dot(n,pl),0.0);
    pts += (diffCol*pnl + f0*D_GGX(max(dot(n,ph),0.0),rough)*pnl)*col*att;
  }
  return diff + spec + amb + envSpec + pts;
}
void main(){
  vec3 albedo = uBaseColor;
  float metal = uMetallic, rough = clamp(uRoughness,0.04,1.0);
  if(uUseBaseTex==1){
    vec4 t = texture(uBaseTexS, vUV);
    albedo *= t.rgb;
    metal *= 1.0;                 // single-texture assets: keep factor metallic
    rough = clamp(rough*t.a*1.2,0.04,1.0);
  }
  if(uUseVColor) albedo *= vColor;
  if(uUnlit==1){
    vec3 e = albedo*uEmissiveBoost;
    fragColor = vec4(e, uAlpha);
    return;
  }
  vec3 n = normalize(vNormal);
  if(!gl_FrontFacing) n = -n;
  vec3 v = normalize(uCamPos - vWorld);
  vec3 col = lighting(albedo, metal, rough, n, v);
  if(uUseLightmap==1){
    // planar lightmap: baked sun-facing AO (R) + dynamic scorch heat (G)
    vec2 luv = (vWorld.xz - uLMRect.xy)/uLMRect.zw;
    vec4 lm = texture(uLightmap, clamp(luv,0.001,0.999));
    float upMix = smoothstep(0.55,0.9,abs(n.y));      // only affects near-flat ground
    col = mix(col, col*lm.r, upMix);
    col += upMix*lm.g*(vec3(0.06,0.015,0.008) + vec3(0.5,0.18,0.05)*pow(lm.g,3.0)*0.25);
  }
  col += uEmissive*uEmissiveBoost;
  col = mix(col, vec3(1.0,0.35,0.35), uHitFlash);
  // distance fog
  float d = length(uCamPos - vWorld);
  float fog = 1.0-exp(-d*uFogDensity);
  col = mix(col, uFogColor, clamp(fog,0.0,1.0));
  fragColor = vec4(col, uAlpha);
}`;

const VS_DEPTH = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=3) in vec4 aJoints;
layout(location=4) in vec4 aWeights;
uniform mat4 uModel, uLightVP;
uniform bool uSkinned;
uniform sampler2D uJointTex; uniform int uJointTexW;
mat4 skinMatrix(float idx){
  int b = int(idx)*4; int x=b%uJointTexW; int y=b/uJointTexW;
  mat4 m; for(int i=0;i<4;i++) m[i]=texelFetch(uJointTex, ivec2(x+i,y),0);
  return m;
}
void main(){
  vec3 p=aPos;
  if(uSkinned){
    mat4 sm = skinMatrix(aJoints.x)*aWeights.x+skinMatrix(aJoints.y)*aWeights.y
            + skinMatrix(aJoints.z)*aWeights.z+skinMatrix(aJoints.w)*aWeights.w;
    p=(sm*vec4(aPos,1.0)).xyz;
  }
  gl_Position = uLightVP * (uModel*vec4(p,1.0));
}`;

const FS_DEPTH = `#version 300 es
precision highp float;
void main(){}`;

const VS_QUAD = `#version 300 es
precision highp float;
out vec2 vUV;
void main(){
  vec2 p = vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2));
  vUV = p; gl_Position = vec4(p*2.0-1.0, 0.0, 1.0);
}`;

const FS_BRIGHT = `#version 300 es
precision highp float;
in vec2 vUV; out vec4 o;
uniform sampler2D uSrc; uniform float uThresh, uKnee;
void main(){
  vec3 c = texture(uSrc,vUV).rgb;
  float br = max(c.r,max(c.g,c.b));
  float soft = clamp(br-uThresh+uKnee,0.0,2.0*uKnee);
  soft = soft*soft/(4.0*uKnee+1e-5);
  float w = max(soft, br-uThresh)/max(br,1e-5);
  o = vec4(c*w,1.0);
}`;

const FS_BLUR = `#version 300 es
precision highp float;
in vec2 vUV; out vec4 o;
uniform sampler2D uSrc; uniform vec2 uDir; uniform int uSamples;
void main(){
  vec3 sum = texture(uSrc,vUV).rgb*0.227027;
  float w[4] = float[4](0.1945946,0.1216216,0.054054,0.016216);
  for(int i=1;i<4;i++){
    vec2 off = uDir*float(i);
    sum += texture(uSrc,vUV+off).rgb*w[i-1];
    sum += texture(uSrc,vUV-off).rgb*w[i-1];
  }
  o = vec4(sum,1.0);
}`;

const FS_COMPOSITE = `#version 300 es
precision highp float;
in vec2 vUV; out vec4 o;
uniform sampler2D uScene, uBloom;
uniform float uExposure, uBloomInt, uTime, uVignette, uAberr, uDamage, uScan;
vec3 aces(vec3 x){
  const float a=2.51,b=0.03,c=2.43,d=0.59,e=0.14;
  return clamp((x*(a*x+b))/(x*(c*x+d)+e),0.0,1.0);
}
void main(){
  vec2 uv = vUV;
  vec2 dir = uv-0.5;
  float r2 = dot(dir,dir);
  vec2 ab = dir*r2*uAberr*0.02;
  vec3 col;
  col.r = texture(uScene,uv+ab).r;
  col.g = texture(uScene,uv).g;
  col.b = texture(uScene,uv-ab).b;
  vec3 bl = texture(uBloom,uv).rgb;
  col += bl*uBloomInt;
  col *= uExposure;
  col = aces(col);
  // damage chromatic stress + red push
  col = mix(col, vec3(col.r*1.25, col.g*0.75, col.b*0.75), uDamage*0.6);
  float vig = 1.0 - r2*uVignette;
  col *= vig;
  col *= 1.0 - uScan*0.06*sin((uv.y)*1100.0);
  float g = fract(sin(dot(uv*vec2(1024.0,768.0)+uTime, vec2(12.9898,78.233)))*43758.5453);
  col += (g-0.5)*0.018;
  o = vec4(pow(max(col,0.0),vec3(1.0/2.2)),1.0);
}`;

/** Compile/link helpers with verbose console diagnostics. */
function compileShader(gl, type, src, name) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src); gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(sh);
    console.error('[shader ' + name + '] ' + info + '\n' + src.split('\n').map((l, i) => (i + 1) + ': ' + l).join('\n'));
    showFatal('shader compile failed: ' + name);
    gl.deleteShader(sh); return null;
  }
  return sh;
}
function createProgram(gl, vsSrc, fsSrc, name) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc, name + '.vs');
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc, name + '.fs');
  if (!vs || !fs) return null;
  const p = gl.createProgram();
  gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    showFatal('program link failed ' + name + ': ' + gl.getProgramInfoLog(p));
    return null;
  }
  gl.deleteShader(vs); gl.deleteShader(fs);
  const prog = { p, u: {}, name };
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    const clean = info.name.replace(/\[0\]$/, '');
    prog.u[clean] = gl.getUniformLocation(p, info.name);
  }
  return prog;
}


export { FS_BLUR, FS_BRIGHT, FS_COMPOSITE, FS_DEPTH, FS_MESH, VS_DEPTH, VS_MESH, VS_QUAD, createProgram };
