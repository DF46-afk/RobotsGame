/* ==========================================================================
 * === SKINNED / STATIC MECH ENTITIES =======================================
 * Procedurally-animated wrappers around parsed GLB assets.
 * ==========================================================================*/
'use strict';

import { CONFIG } from '../core/config.js';
import { MAT4_ID, V3, mat4, vec3 } from '../core/math.js';
import { clamp, damp, lerp, rnd } from '../core/util.js';
import { buildRig } from '../anim/procedural.js';
import { renderer } from '../game/state.js';

class SkinnedMech {
  /** @param {Object} asset parsed GLB asset with skins[]
   *  @param {Object} opts { scale, tint, accent } */
  constructor(asset, opts = {}) {
    this.asset = asset;
    this.skin = asset.skins[0];
    if (!this.skin) throw new Error('asset has no skin');
    const RIG = buildRig(asset, this.skin);
    this.rig = RIG;
    this.scale = opts.scale !== undefined ? opts.scale : CONFIG.world.scale;
    this.tint = opts.tint || [1, 1, 1];
    this.accent = opts.accent || [0.25, 0.9, 1];
    this.pos = V3(0, 0, 0);          // feet position, metres
    this.yaw = 0;
    this.vel = V3(0, 0, 0);
    this.phase = rnd(Math.PI * 2);
    this.animT = 0;
    this.hitFlash = 0;
    this.fireGlow = 0;
    this.dead = false; this.deathT = 0;
    // muzzle anchor is a bone tip we resolve every frame
    this.muzzle = V3(0, 0, 0);
    this.eyePos = V3(0, 0, 0);
    // bind-space bbox (metres): from POSITION accessor of first skinned prim
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const p of asset.prims) {
      if (!p.skinned || !p.cpu || !p.cpu.POSITION) continue;
      const P = p.cpu.POSITION;
      for (let i = 0; i < P.length; i += 3)
        for (let c = 0; c < 3; c++) {
          if (P[i + c] < mn[c]) mn[c] = P[i + c];
          if (P[i + c] > mx[c]) mx[c] = P[i + c];
        }
    }
    this.bindMin = mn.map(v => v * this.scale);
    this.bindMax = mx.map(v => v * this.scale);
    this.height = this.bindMax[1] - this.bindMin[1];
    this.radius = Math.max(this.bindMax[0], this.bindMax[2]) * 0.75;
    // rest-pose local matrices (computeNodeWorlds(false) leaves them in node.local)
    this.restLocal = asset.nodes.map(n => Float32Array.from(n.local));
    this._chainW = asset.nodes.map(() => MAT4_ID());
    /* GPU: one VAO per skinned primitive, shared skin texture buffer */
    const gl = renderer.current.gl;
    this.gpuPrims = [];
    for (const p of asset.prims) {
      if (!p.skinned) continue;
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const loc = (idx, size, arr, type) => {
        const b = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(idx);
        gl.vertexAttribPointer(idx, size, type || gl.FLOAT, false, 0, 0);
        return b;
      };
      const bufs = {};
      bufs.P = loc(0, 3, p.cpu.POSITION);
      if (p.cpu.NORMAL) bufs.N = loc(1, 3, p.cpu.NORMAL);
      else { gl.disableVertexAttribArray(1); gl.vertexAttrib3f(1, 0, 1, 0); }
      if (p.cpu.TEXCOORD_0) bufs.U = loc(2, 2, p.cpu.TEXCOORD_0);
      else { gl.disableVertexAttribArray(2); gl.vertexAttrib2f(2, 0.5, 0.5); }
      bufs.J = loc(3, 4, new Float32Array(p.cpu.JOINTS_0.buffer, p.cpu.JOINTS_0.byteOffset, p.cpu.JOINTS_0.length), gl.FLOAT); // bit-reinterpreted u16 joints
      bufs.W = loc(4, 4, p.cpu.WEIGHTS_0);
      gl.disableVertexAttribArray(5); gl.vertexAttrib3f(5, 1, 1, 1);
      let ibo = null, iboCount = 0, iboType = gl.UNSIGNED_SHORT;
      if (p.indexed) {
        ibo = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, p.cpu.IBO, gl.STATIC_DRAW);
        iboCount = p.cpu.IBO.length;
        iboType = p.cpu.IBO instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
      }
      gl.bindVertexArray(null);
      this.gpuPrims.push({
        vao, ibo, iboCount, iboType, count: p.count, indexed: p.indexed, mat: p.mat,
        cpu: p.cpu, tex: null, normalMat: MAT4_ID(), _nmOk: false
      });
    }
    // joint texture buffer lives on the skin (shared by all instances)
    if (!this.skin.texBuf) {
      this.skin.texBuf = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.skin.texBuf);
      const w = Math.min(CONFIG.render.skinJoints, this.skin.count);
      const h = Math.ceil(w / 4) || 1;
      this.skin.texW = w; this.skin.texH = h;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
  }
  /** Additive pose -> writes skin.jointMat then uploads to skin.texBuf. */
  update(dt, t) {
    this.animT += dt;
    const rig = this.rig, M = this.skin.jointMat, nodes = this.asset.nodes;
    // start from REST local matrices every frame (additive layers only)
    for (let i = 0; i < nodes.length; i++) mat4.copy(this.tmpLocal(i), this.restLocal[i]);
    const kitsune = rig.kind === 'kitsune';
    const A = (slot, rx, ry, rz) => {
      const ni = rig.bones[slot];
      if (ni === undefined || ni < 0) return;
      const m = this.tmpLocal(ni);
      if (rx) mat4.rotX(m, m, rx);
      if (ry) mat4.rotY(m, m, ry);
      if (rz) mat4.rotZ(m, m, rz);
    };
    const walk = clamp(vec3.len(this.vel) * 0.55, 0, 1.4);
    const ph = this.animT * (2.2 + walk * 4.5) + this.phase;
    const s = Math.sin(ph), c2 = Math.sin(ph * 2), sw = Math.sin(t * 0.8 + this.phase);
    this.bobY = Math.abs(c2) * 0.06 * walk;
    if (!this.dead) this.yaw = lerp(this.yaw, this.targetYaw, damp(9, dt));
    if (kitsune) {
      /* kitsune_harpy_rig: quadruped bird-woman. B_38 pelvis drives the body,
         Head_17 looks around, L1..L5 chains are wings, Tail [LTR] is a fan. */
      A('hips', 0, 0, walk * 0.05 * s);
      A('spine1', walk * 0.04, s * 0.04 * walk, 0);
      A('head', -walk * 0.03 + sw * 0.02, Math.sin(t * 0.6) * 0.12, 0);
      const flap = Math.sin(t * (1.4 + walk * 3.2) + this.phase) * (0.10 + walk * 0.45);
      A('clavL', 0, 0, flap);       A('upperL', 0, 0, flap * 0.65); A('foreL', 0, 0, flap * 0.35);
      A('clavR', 0, 0, -flap);      A('upperR', 0, 0, -flap * 0.65); A('foreR', 0, 0, -flap * 0.35);
      const tw = Math.sin(t * 1.7 + this.phase);
      A('tailC', tw * 0.08, tw * 0.10, 0);
      A('tailL', 0, tw * 0.06, 0);
      A('tailR', 0, -tw * 0.06, 0);
    } else {
      // torso bob & lean (atlas tower chassis)
      A('hips', 0, 0, walk * 0.06 * s);
      A('spine2', walk * 0.05, s * 0.05 * walk, 0);
      A('neck', -walk * 0.04 + sw * 0.02, 0, 0);
      A('head', Math.sin(t * 1.3 + this.phase) * 0.03, Math.sin(t * 0.6) * 0.08, 0);
      // arms: counter-swing to legs; raise while firing
      const fire = this.fireGlow;
      A('clavL', 0, 0, -s * 0.35 * walk - fire * 1.15);
      A('upperL', s * 0.5 * walk + fire * 0.2, 0, -0.12 - fire * 0.25);
      A('foreL', -Math.abs(s) * 0.25 * walk - fire * 0.35, 0, 0);
      A('clavR', 0, 0, s * 0.35 * walk - fire * 1.15);
      A('upperR', -s * 0.5 * walk + fire * 0.2, 0, 0.12 + fire * 0.25);
      A('foreR', -Math.abs(s) * 0.25 * walk - fire * 0.35, 0, 0);
      // legs
      A('thighL', -s * 0.5 * walk, 0, 0);
      A('kneeL', Math.max(0, s) * 0.7 * walk, 0, 0);
      A('ankleL', s * 0.3 * walk, 0, 0);
      A('thighR', s * 0.5 * walk, 0, 0);
      A('kneeR', Math.max(0, -s) * 0.7 * walk, 0, 0);
      A('ankleR', -s * 0.3 * walk, 0, 0);
    }
    // death: collapse forward
    if (this.dead) {
      const k = clamp(this.deathT / 1.4, 0, 1);
      const ease = k * k;
      A('hips', ease * 1.15, 0, 0); A('spine2', ease * 0.5, 0, 0); A('spine1', ease * 0.3, 0, 0);
      A('head', -ease * 0.8, 0, 0);
      A('clavL', 0, 0, ease * 1.6); A('clavR', 0, 0, -ease * 1.6);
      A('upperL', ease * 0.9, 0, 0); A('upperR', ease * 0.9, 0, 0);
      A('thighL', ease * 0.9, 0, 0); A('thighR', ease * 0.9, 0, 0);
    }
    // ---- rebuild world chain from the skeleton root down, write jointMat --
    const rootIdx = this.skin.joints[0];
    const RW = this.rootWorld;
    mat4.ident(RW);
    mat4.translate(RW, RW, [this.pos[0], this.pos[1] + this.bobY, this.pos[2]]);
    mat4.rotY(RW, RW, this.yaw);
    mat4.scale(RW, RW, [this.scale, this.scale, this.scale]);
    this._writeChain(rootIdx, RW, M, t);
    // muzzle/eye anchors (bone tips in world space)
    const handL = rig.bones.handL !== undefined && rig.bones.handL >= 0 ? rig.bones.handL : rig.bones.foreL;
    this._anchor(handL, this.muzzle);
    this._anchor(rig.bones.head, this.eyePos);
    if (!this._muzzleOk) {
      vec3.set(this.muzzle, this.pos[0], this.pos[1] + this.height * 0.55, this.pos[2]);
      vec3.set(this.eyePos, this.pos[0], this.pos[1] + this.height * 0.8, this.pos[2]);
    }
    // upload joints into the skin's float texture
    const gl = renderer.current.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.skin.texBuf);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.skin.texW, this.skin.texH, gl.RGBA, gl.FLOAT,
      this.skin.jointTexData.subarray(0, this.skin.texW * this.skin.texH * 4));
  }
  _writeChain(ni, parentWorld, M, t) {
    const nodes = this.asset.nodes;
    const n = nodes[ni];
    const w = this._chainW[ni];
    mat4.mul(w, parentWorld, this.tmpLocal(ni));
    this._lastWorld = this._chainW;
    if (parentWorld === this.rootWorld) this._muzzleOk = true;
    const ji = this._jointIndexOf(ni);
    if (ji >= 0) {
      // jointMat = world * inverseBindMatrix
      const ibm = this.skin.ibm.subarray(ji * 16, ji * 16 + 16);
      mat4.mul(M.subarray(ji * 16, ji * 16 + 16), w, ibm);
    }
    for (const ch of n.children) if (ch >= 0 && ch < nodes.length) this._writeChain(ch, w, M, t);
  }
  _jointIndexOf(nodeIdx) {
    if (!this._jmap) {
      this._jmap = new Map();
      this.skin.joints.forEach((j, i) => this._jmap.set(j, i));
    }
    const v = this._jmap.get(nodeIdx);
    return v === undefined || v >= this.skin.count ? -1 : v;
  }
  tmpLocal(i) {
    if (!this._locals) this._locals = [];
    if (!this._locals[i]) this._locals[i] = MAT4_ID();
    return this._locals[i];
  }
  _anchor(ni, out) {
    if (ni === undefined || ni < 0 || !this._lastWorld) { out[0] = out[1] = out[2] = 0; return; }
    const w = this._lastWorld[ni];
    if (!w) { out[0] = out[1] = out[2] = 0; return; }
    out[0] = w[12]; out[1] = w[13]; out[2] = w[14];
  }
  render(r, st) {
    const gl = r.gl, prog = r.progs.mesh;
    r.use(prog);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    // joint texture lives on this skin (uploaded every update())
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.skin.texBuf);
    const lJT = prog.u.uJointTex; if (lJT) gl.uniform1i(lJT, 5);
    const lJW = prog.u.uJointTexW; if (lJW && this._jtW !== this.skin.texW) { this._jtW = this.skin.texW; gl.uniform1i(lJW, this.skin.texW); }
    r.um4(prog, 'uViewProj', st.viewProj);
    r.um4(prog, 'uLightVP', st.lightVP);
    r.um4(prog, 'uModel', this.rootWorld);
    r.u3(prog, 'uCamPos', st.camPos);
    r.u3(prog, 'uLightDir', CONFIG.world.sunDir);
    r.u3(prog, 'uLightColor', st.sunColorScaled);
    r.u3(prog, 'uSkyColor', CONFIG.world.skyColor);
    r.u3(prog, 'uGroundColor', CONFIG.world.groundColor);
    r.u3(prog, 'uFogColor', CONFIG.world.fogColor);
    r.u1f(prog, 'uFogDensity', CONFIG.world.fogDensity);
    r.u1f(prog, 'uTime', st.time);
    r.u1f(prog, 'uShadowBias', CONFIG.shadow.bias);
    r.bindTex(prog, 'uShadowMap', st.shadowTex || st.whiteTex, 2);
    r.u1i(prog, 'uUseLightmap', 0);
    r.u1i(prog, 'uReceiveShadow', st.receiveShadow === false ? 0 : 1);
    r.u1i(prog, 'uSkinned', 1);
    r.u1i(prog, 'uNumPoints', st.numPoints);
    if (st.numPoints > 0) {
      const lp = prog.u.uPointPos; if (lp) gl.uniform3fv(lp, st.pointPosArr.subarray(0, st.numPoints * 3));
      r.bindTex(prog, 'uPointColors', st.pointTex, 1);
    }
    r.u1f(prog, 'uAlpha', 1);
    r.u1f(prog, 'uHitFlash', this.hitFlash);
    r.u1i(prog, 'uUnlit', 0);
    r.u1i(prog, 'uUseVColor', 0);
    // rotation-only normal matrix (uniform scale cancels out)
    {
      const m = this.rootWorld;
      mat4.toQuat(_s.q1, m);
      mat4.compose(_s.mTmp, _s.v1.set ? (vec3.set(_s.v1, 0, 0, 0), _s.v1) : _s.v1, _s.q1, vec3.set(_s.v3, 1, 1, 1));
      const l = prog.u.uNormalMat;
      if (l) {
        const nm = this._normalMat9 || (this._normalMat9 = new Float32Array(9));
        nm[0]=_s.mTmp[0]; nm[1]=_s.mTmp[1]; nm[2]=_s.mTmp[2];
        nm[3]=_s.mTmp[4]; nm[4]=_s.mTmp[5]; nm[5]=_s.mTmp[6];
        nm[6]=_s.mTmp[8]; nm[7]=_s.mTmp[9]; nm[8]=_s.mTmp[10];
        gl.uniformMatrix3fv(l, false, nm);
      }
    }
    for (const gp of this.gpuPrims) {
      const mat = gp.mat;
      const base = mat ? mat.base : [0.7, 0.7, 0.7];
      r.u3(prog, 'uBaseColor', [base[0] * this.tint[0], base[1] * this.tint[1], base[2] * this.tint[2]]);
      r.u1f(prog, 'uMetallic', mat ? mat.metallic : 0.6);
      r.u1f(prog, 'uRoughness', mat ? clamp(mat.roughness, 0.06, 1) : 0.6);
      const em = mat && mat.emissive ? mat.emissive : [0, 0, 0];
      r.u3(prog, 'uEmissive', em);
      r.u1f(prog, 'uEmissiveBoost', (em[0] + em[1] + em[2]) > 0.02 ? 1.6 : 1.0);
      if (gp.tex) {
        r.bindTex(prog, 'uBaseTexS', gp.tex, 0);
        r.u1i(prog, 'uUseBaseTex', 1);
      } else if (mat && mat.baseTex >= 0 && !gp.texFailed) {
        // lazy texture resolve through the owning asset (async-safe)
        gp.texFailed = true;
        const self = this;
        this.asset.texFor(mat.baseTex).then((tx) => { if (tx) gp.tex = tx; }).catch(() => {});
        r.bindTex(prog, 'uBaseTexS', st.whiteTex, 0);
        r.u1i(prog, 'uUseBaseTex', 0);
      } else {
        r.bindTex(prog, 'uBaseTexS', st.whiteTex, 0);
        r.u1i(prog, 'uUseBaseTex', 0);
      }
      gl.bindVertexArray(gp.vao);
      if (gp.indexed) gl.drawElements(gl.TRIANGLES, gp.iboCount, gp.iboType, 0);
      else gl.drawArrays(gl.TRIANGLES, 0, gp.count);
      r.stats.draws++; r.stats.tris += gp.count / 3;
    }
    gl.bindVertexArray(null);
  }
}
/* ==========================================================================
 * === STATIC PROP (rigid GLB mech) =========================================
 * kid_war_robots has no skeleton: it is baked into one static batch and drawn
 * with a per-instance model matrix (position/yaw/scale) + procedural bob &
 * weapon-aim yaw on the root only.
 * ==========================================================================*/
class PropMech {
  constructor(batches, opts = {}) {
    this.batches = batches;
    this.scale = opts.scale || 1;
    this.tint = opts.tint || [1, 1, 1];
    this.pos = V3(0, 0, 0);
    this.yaw = 0;
    this.model = MAT4_ID();
    this.normalMat = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    this.height = opts.height || 3;
    this.radius = opts.radius || 1.4;
    this.bobY = 0;
  }
  /** Recompose the instance matrix from pos/yaw/scale/bob. */
  sync(t) {
    const s = this.scale;
    mat4.ident(this.model);
    mat4.translate(this.model, this.model, [this.pos[0], this.pos[1] + this.bobY, this.pos[2]]);
    mat4.rotY(this.model, this.model, this.yaw);
    mat4.scale(this.model, this.model, [s, s, s]);
    const c = Math.cos(this.yaw), sn = Math.sin(this.yaw);
    this.normalMat[0] = c; this.normalMat[1] = 0; this.normalMat[2] = -sn;
    this.normalMat[3] = sn; this.normalMat[4] = 0; this.normalMat[5] = c;
    this.normalMat[6] = 0; this.normalMat[7] = 1; this.normalMat[8] = 0;
  }
  render(r, st) {
    const gl = r.gl, prog = r.progs.mesh;
    r.use(prog);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    r.um4(prog, 'uViewProj', st.viewProj);
    r.um4(prog, 'uLightVP', st.lightVP);
    r.um4(prog, 'uModel', this.model);
    const l = prog.u.uNormalMat; if (l) gl.uniformMatrix3fv(l, false, this.normalMat);
    r.u3(prog, 'uCamPos', st.camPos);
    r.u3(prog, 'uLightDir', CONFIG.world.sunDir);
    r.u3(prog, 'uLightColor', st.sunColorScaled);
    r.u3(prog, 'uSkyColor', CONFIG.world.skyColor);
    r.u3(prog, 'uGroundColor', CONFIG.world.groundColor);
    r.u3(prog, 'uFogColor', CONFIG.world.fogColor);
    r.u1f(prog, 'uFogDensity', CONFIG.world.fogDensity);
    r.u1f(prog, 'uTime', st.time);
    r.u1f(prog, 'uShadowBias', CONFIG.shadow.bias);
    r.bindTex(prog, 'uShadowMap', st.shadowTex || st.whiteTex, 2);
    r.u1i(prog, 'uUseLightmap', 0);
    r.u1i(prog, 'uReceiveShadow', 1);
    r.u1i(prog, 'uSkinned', 0);
    r.u1i(prog, 'uNumPoints', st.numPoints);
    if (st.numPoints > 0) {
      const lp = prog.u.uPointPos; if (lp) gl.uniform3fv(lp, st.pointPosArr.subarray(0, st.numPoints * 3));
      r.bindTex(prog, 'uPointColors', st.pointTex, 1);
    }
    r.u1f(prog, 'uAlpha', 1);
    r.u1f(prog, 'uHitFlash', this.hitFlash || 0);
    r.u1i(prog, 'uUnlit', 0);
    r.u1i(prog, 'uJointTexW', 8);
    for (const b of this.batches) {
      const mat = b.mat;
      const base = mat ? mat.base : [0.7, 0.7, 0.7];
      r.u1i(prog, 'uUseVColor', b.hasColor ? 1 : 0);
      r.u3(prog, 'uBaseColor', [base[0] * this.tint[0], base[1] * this.tint[1], base[2] * this.tint[2]]);
      r.u1f(prog, 'uMetallic', mat ? mat.metallic : 0.6);
      r.u1f(prog, 'uRoughness', mat ? clamp(mat.roughness, 0.06, 1) : 0.6);
      const em = mat && mat.emissive ? mat.emissive : [0, 0, 0];
      r.u3(prog, 'uEmissive', em);
      r.u1f(prog, 'uEmissiveBoost', (em[0] + em[1] + em[2]) > 0.02 ? 1.6 : 1.0);
      r.bindTex(prog, 'uBaseTexS', st.whiteTex, 0);
      r.u1i(prog, 'uUseBaseTex', 0);
      gl.bindVertexArray(b.vao);
      gl.drawElements(gl.TRIANGLES, b.count, b.type, 0);
      r.stats.draws++; r.stats.tris += b.count / 3;
      gl.bindVertexArray(null);
    }
  }
}
/** Split kid_war_robots rigid meshes into per-robot clusters (union-find over
 *  XZ footprint proximity). Returns clusters of prims, biggest first. */
function clusterRobot(asset) {
  const items = [];
  for (const prim of asset.prims) {
    if (!prim.bboxMin) continue;
    items.push({
      prim, cx: (prim.bboxMin[0] + prim.bboxMax[0]) / 2,
      cz: (prim.bboxMin[2] + prim.bboxMax[2]) / 2, root: items.length
    });
  }
  const find = (i) => { while (items[i].root !== i) i = items[i].root; return i; };
  const uni = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) items[rb].root = ra; };
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const dx = items[i].cx - items[j].cx, dz = items[i].cz - items[j].cz;
      if (dx * dx + dz * dz < 7 * 7) uni(i, j);
    }
  const map = new Map();
  items.forEach((it, i) => {
    const k = find(i);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(it.prim);
  });
  return [...map.values()].sort((a, b) => b.length - a.length);
}

export { SkinnedMech, PropMech, clusterRobot };
