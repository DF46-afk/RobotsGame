/* AUTO-MOVED from the original single-file index.html — do not hand-edit
 * section contents without checking against git history. */
'use strict';

import { CONFIG } from '../core/config.js';
import { clamp } from '../core/util.js';
import { FS_BLUR, FS_BRIGHT, FS_COMPOSITE, FS_DEPTH, FS_MESH, VS_DEPTH, VS_MESH, VS_QUAD, createProgram } from './shaders.js';
import { setAniso } from '../world/glb.js';

/* ==========================================================================
 * === RENDERER =============================================================
 * WebGL2 wrapper: program/VAO caching, texture units, uniform batching,
 * a directional shadow pass and a bloom post chain.
 * ==========================================================================*/
class Renderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    const gl = this.gl = canvas.getContext('webgl2', {
      antialias: false, alpha: false, depth: true, stencil: false,
      powerPreference: 'high-performance', preserveDrawingBuffer: false
    });
    if (!gl) throw new Error('WebGL2 unsupported');
    setAniso(gl.getExtension('EXT_texture_filter_anisotropic')
      ? gl.getExtension('EXT_texture_filter_anisotropic').TEXTURE_MAX_ANISOTROPY_EXT : 0);
    // shared 1x1 white texture — created BEFORE any GLB parsing so that
    // material fallbacks can reference it (single owner: the Renderer).
    this.whiteTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.whiteTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255,255,255,255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    gl.clearColor(...CONFIG.world.fogColor, 1);
    this.progs = {
      mesh: createProgram(gl, VS_MESH, FS_MESH, 'mesh'),
      depth: createProgram(gl, VS_DEPTH, FS_DEPTH, 'depth'),
      bright: createProgram(gl, VS_QUAD, FS_BRIGHT, 'bright'),
      blur: createProgram(gl, VS_QUAD, FS_BLUR, 'blur'),
      comp: createProgram(gl, VS_QUAD, FS_COMPOSITE, 'comp')
    };
    this.emptyVao = gl.createVertexArray();   // used by all fullscreen passes
    this.vaoCache = new Map();                // key -> vao (+attrib descriptors)
    this.jointTex = null; this.jointTexW = 0; this.jointData = null;
    this.pointTex = this.makeFloatTexture(8, 1, new Float32Array(8 * 4));
    this.pointPosArr = new Float32Array(8 * 3);
    this.numPoints = 0;
    this.stats = { draws: 0, tris: 0 };
    this.w = 1; this.h = 1;
    this.program = null;
    this.texUnit = 0;
    this._u = {};                             // last-set uniform memo (batching)
    this.resize();
  }
  /* ------------------------- resources ----------------------------------- */
  makeFloatTexture(w, h, data) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  /** Get (or build+cache) a VAO for a primitive. Attrib locations are fixed. */
  vaoFor(prim) {
    if (prim._vao) return prim._vao;
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const bind = (loc, buf, size, type, norm) => {
      if (!buf || loc < 0) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(loc);
      if (norm) gl.vertexAttribIPointer(loc, size, type, 0, 0);
      else gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    bind(0, prim.gpu.POSITION, 3, gl.FLOAT, false);
    bind(1, prim.gpu.NORMAL, 3, gl.FLOAT, false);
    bind(2, prim.gpu.TEXCOORD_0, 2, gl.FLOAT, false);
    bind(3, prim.gpu.JOINTS_0, 4, gl.UNSIGNED_SHORT, true);   // integer joints
    bind(4, prim.gpu.WEIGHTS_0, 4, gl.FLOAT, false);
    if (prim.hasColor) {
      gl.bindBuffer(gl.ARRAY_BUFFER, prim.gpu.COLOR_0);
      gl.enableVertexAttribArray(5);
      gl.vertexAttribPointer(5, 3, gl.FLOAT, false, 0, 0);
    }
    if (!prim.gpu.NORMAL) { // synthesise flat normal via attrib divisor-free constant
      gl.disableVertexAttribArray(1); gl.vertexAttrib3f(1, 0, 1, 0);
    }
    if (!prim.gpu.TEXCOORD_0) { gl.disableVertexAttribArray(2); gl.vertexAttrib2f(2, 0.5, 0.5); }
    if (!prim.gpu.JOINTS_0) { gl.disableVertexAttribArray(3); gl.vertexAttrib4f(3, 0, 0, 0, 0); }
    if (!prim.gpu.WEIGHTS_0) { gl.disableVertexAttribArray(4); gl.vertexAttrib4f(4, 1, 0, 0, 0); }
    if (prim.indexed) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, prim.ibo);
    }
    gl.bindVertexArray(null);
    prim._vao = vao;
    return vao;
  }
  disposeVaoCache() {
    const gl = this.gl;
    for (const p of this.vaoCache.values()) if (p._vao) gl.deleteVertexArray(p._vao);
    this.vaoCache.clear();
  }
  /** Delete the GPU buffers backing a primitive + forget its cached VAO. */
  freePrim(prim) {
    const gl = this.gl;
    if (prim._vao) { gl.deleteVertexArray(prim._vao); prim._vao = null; }
    if (prim.ibo) { gl.deleteBuffer(prim.ibo); prim.ibo = null; }
    if (prim.gpu) { for (const k in prim.gpu) { gl.deleteBuffer(prim.gpu[k]); } prim.gpu = {}; }
    prim._dead = true;
  }
  /** Bilinear gaussian splat of a scalar field into a Float32Array grid. */
  static splat(gm, cx, cz, w, h, x, z, radius, amount) {
    const gx = (x - gm.minX) / gm.dx, gz = (z - gm.minZ) / gm.dz;
    const r = Math.max(1, radius / gm.dx);
    const i0 = Math.max(0, Math.floor(gx - r)), i1 = Math.min(w - 1, Math.ceil(gx + r));
    const j0 = Math.max(0, Math.floor(gz - r)), j1 = Math.min(h - 1, Math.ceil(gz + r));
    const inv2r2 = 1 / (2 * r * r);
    for (let j = j0; j <= j1; j++) {
      const dz = (j + 0.5) - gz;
      for (let i = i0; i <= i1; i++) {
        const ddx = (i + 0.5) - gx;
        const g = Math.exp(-(ddx * ddx + dz * dz) * inv2r2);
        if (g < 0.02) continue;
        const k = j * w + i;
        gm.field[k] += amount * g;
        if (gm.field[k] > gm.maxVal) gm.maxVal = gm.field[k];
      }
    }
  }
  /** Diffuse-occlusion map: per-cell occluder height + ray march to the sun. */
  computeLightmap(gm, cellsX, cellsZ, lightDirXZ, step) {
    this.gm = {
      minX: gm.minX, minZ: gm.minZ, dx: gm.dx, dz: gm.dz,
      w: cellsX, h: cellsZ,
      occ: new Float32Array(cellsX * cellsZ).fill(1),   // 1 = fully lit
      top: new Float32Array(cellsX * cellsZ).fill(-Infinity),
      field: new Float32Array(cellsX * cellsZ),
      maxVal: 0
    };
    // rasterise geometry: highest surface per cell
    const nx = gm.nx, nz = gm.nz, gy = gm.gy;
    for (let t = 0; t < nx.length; t++) {
      const i = ((nx[t] - gm.minX) / gm.dx) | 0, j = ((nz[t] - gm.minZ) / gm.dz) | 0;
      if (i < 0 || j < 0 || i >= cellsX || j >= cellsZ) continue;
      const k = j * cellsX + i;
      if (gy[t] > this.gm.top[k]) this.gm.top[k] = gy[t];
    }
    const g = this.gm;
    for (let k = 0; k < g.top.length; k++) if (!isFinite(g.top[k])) g.top[k] = CONFIG.world.groundY;
    // march toward the sun sampling occluder heights above the sample point
    const lx = lightDirXZ[0], lz = lightDirXZ[1];
    for (let j = 0; j < cellsZ; j++) {
      for (let i = 0; i < cellsX; i++) {
        const k = j * cellsX + i;
        let y = g.top[k] + 0.35;               // start just above the surface
        let ox = gm.minX + (i + 0.5) * gm.dx, oz = gm.minZ + (j + 0.5) * gm.dz;
        let occl = 0;
        for (let s = 1; s <= 14; s++) {
          ox += lx * step; oz += lz * step;
          y += step * 1.35;                     // climb at the sun's elevation
          const si = ((ox - gm.minX) / gm.dx) | 0, sj = ((oz - gm.minZ) / gm.dz) | 0;
          if (si < 0 || sj < 0 || si >= cellsX || sj >= cellsZ) break;
          const th = g.top[sj * cellsX + si];
          if (th > y) occl = Math.max(occl, Math.min(1, (th - y) * 0.8));
        }
        g.occ[k] = 1 - occl * 0.75;
      }
    }
  }
  updateLightmap() {
    const gl = this.gl, g = this.gm;
    if (!g) return;
    const W = g.w * g.h;
    if (!this.lightTex) {
      this.lightData = new Float32Array(W * 4);
      this.lightTex = this.makeFloatTexture(g.w, g.h, this.lightData);
    }
    const d = this.lightData;
    const norm = g.maxVal > 0 ? 1 / g.maxVal : 0;
    for (let k = 0; k < W; k++) {
      const heat = clamp(g.field[k] * norm, 0, 1);
      const o = k * 4;
      d[o] = g.occ[k];
      d[o + 1] = heat;
      d[o + 2] = 0; d[o + 3] = 1;
      g.field[k] *= 0.965;                      // exponential decay of scorch marks
    }
    if (g.maxVal > 0 && g.maxVal < 0.02) g.maxVal = 0;
    gl.bindTexture(gl.TEXTURE_2D, this.lightTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, g.w, g.h, gl.RGBA, gl.FLOAT, d);
  }
  /** Add a scorch mark at world (x,z) — called on every impact. Zero alloc. */
  addScorch(x, z, radius, amount) {
    if (!this.gm) return;
    const g = this.gm;
    Renderer.splat(g, g.w, g.h, g.w, g.h, x, z, radius, amount);
  }
  /* ------------------------- framebuffers -------------------------------- */
  ensureTargets(w, h) {
    const gl = this.gl;
    if (this.scene && this.sw === w && this.sh === h) return;
    this.disposeTargets();
    this.sw = w; this.sh = h;
    const mk = (bw, bh, depth) => {
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, bw, bh, 0, gl.RGBA, gl.HALF_FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      let db = null;
      if (depth) {
        db = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, db);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, bw, bh);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, db);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { fb, tex, db, w: bw, h: bh };
    };
    this.scene = mk(w, h, true);
    const bw = Math.max(2, w >> 1), bh = Math.max(2, h >> 1);
    this.bloomA = mk(bw, bh, false);
    this.bloomB = mk(bw, bh, false);
    // shadow map
    const S = CONFIG.shadow.size;
    this.shadowTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT32F, S, S, 0, gl.DEPTH_COMPONENT, gl.FLOAT, null);
    // hardware PCF: comparing sampler + linear filter => free 2x2 taps
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.shadowFb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shadowTex, 0);
    gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  disposeTargets() {
    const gl = this.gl;
    for (const k of ['scene', 'bloomA', 'bloomB']) {
      const t = this[k]; if (!t) continue;
      gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.tex);
      if (t.db) gl.deleteRenderbuffer(t.db);
      this[k] = null;
    }
    if (this.shadowTex) { gl.deleteTexture(this.shadowTex); this.shadowTex = null; }
    if (this.shadowFb) { gl.deleteFramebuffer(this.shadowFb); this.shadowFb = null; }
  }
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = this.canvas.clientWidth || window.innerWidth;
    const ch = this.canvas.clientHeight || window.innerHeight;
    let w = Math.round(cw * dpr), h = Math.round(ch * dpr);
    const cap = CONFIG.render.pixelCap;
    if (w * h > cap) { const s = Math.sqrt(cap / (w * h)); w = Math.round(w * s); h = Math.round(h * s); }
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
      this.dirty = true;
    }
    this.w = this.canvas.width; this.h = this.canvas.height;
    this.dprScaleX = this.w / (cw || 1);
    return this.w !== 0 && this.h !== 0;
  }
  /* ------------------------- uniforms (memoised batching) ---------------- */
  use(prog) {
    if (this.program === prog) return;
    this.gl.useProgram(prog.p);
    this.program = prog; this._u = {};
  }
  u1f(prog, name, v) {
    if (this._u[name] === v) return; this._u[name] = v;
    const l = prog.u[name]; if (l) this.gl.uniform1f(l, v);
  }
  u1i(prog, name, v) {
    if (this._u[name] === v) return; this._u[name] = v;
    const l = prog.u[name]; if (l) this.gl.uniform1i(l, v);
  }
  u3(prog, name, a, b, c) {
    const arr = Array.isArray(a) ? a : [a, b, c];
    const key = name;
    const prev = this._u[key];
    if (prev && prev[0] === arr[0] && prev[1] === arr[1] && prev[2] === arr[2]) return;
    this._u[key] = [arr[0], arr[1], arr[2]];
    const l = prog.u[key]; if (l) this.gl.uniform3f(l, arr[0], arr[1], arr[2]);
  }
  um4(prog, name, m) {
    const l = prog.u[name]; if (!l) return;
    this.gl.uniformMatrix4fv(l, false, m);
  }
  uSkinTex(prog, skin) {
    const gl = this.gl;
    if (!this.jointTex || this.jointTexMax < CONFIG.render.skinJoints) {
      if (this.jointTex) gl.deleteTexture(this.jointTex);
      const W = 32; // 32*32 = 1024 texels >= 64 joints * 4
      this.jointTexW = W; this.jointTexMax = 64;
      this.jointData = new Float32Array(W * W * 4);
      this.jointTex = this.makeFloatTexture(W, W, this.jointData);
    }
    // upload this skin's matrices into rows 0..ceil(n/8)
    const n = skin.count, W = this.jointTexW, data = this.jointData;
    for (let j = 0; j < n; j++) {
      const b = j * 4, x = (b % W), y = ((b / W) | 0);
      for (let c = 0; c < 4; c++) {
        const off = ((y * W) + x + c) * 4;
        for (let k = 0; k < 4; k++) data[off + k] = skin.jointMat[j * 16 + c * 4 + k];
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, this.jointTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, Math.ceil(n * 4 / W), gl.RGBA, gl.FLOAT, data.subarray(0, Math.ceil(n * 4 / W) * W * 4));
    this.bindTex(prog, 'uJointTex', this.jointTex, 5);
    this.u1i(prog, 'uJointTexW', W);
  }
  bindTex(prog, name, tex, unit) {
    const gl = this.gl;
    const l = prog.u[name]; if (!l) return;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (this._u['T' + name] !== unit) { this._u['T' + name] = unit; gl.uniform1i(l, unit); }
  }
  /* ------------------------- draw calls ---------------------------------- */
  /**
   * Draw one primitive with material overrides.
   * @param {Object} prim parsed primitive
   * @param {Object} st scene state (camera/light/etc.)
   * @param {Object} o {model, normalMat, tint, emissive, emisBoost, metallic, roughness, unlit, skinned, skin, hitFlash, receiveShadow, alpha, doubleSided, baseTex}
   */
  drawPrim(prim, st, o) {
    const gl = this.gl;
    const prog = this.progs.mesh;
    this.use(prog);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.BLEND);
    const vao = this.vaoFor(prim);
    gl.bindVertexArray(vao);
    if (o.doubleSided) gl.disable(gl.CULL_FACE); else gl.enable(gl.CULL_FACE);
    this.um4(prog, 'uViewProj', st.viewProj);
    this.um4(prog, 'uLightVP', st.lightVP);
    this.um4(prog, 'uModel', o.model);
    const l = prog.u.uNormalMat; if (l) gl.uniformMatrix3fv(l, false, o.normalMat);
    this.u3(prog, 'uCamPos', st.camPos);
    this.u3(prog, 'uLightDir', CONFIG.world.sunDir);
    this.u3(prog, 'uLightColor', st.sunColorScaled);
    this.u3(prog, 'uSkyColor', CONFIG.world.skyColor);
    this.u3(prog, 'uGroundColor', CONFIG.world.groundColor);
    this.u3(prog, 'uFogColor', CONFIG.world.fogColor);
    this.u1f(prog, 'uFogDensity', CONFIG.world.fogDensity);
    this.u1f(prog, 'uTime', st.time);
    this.u1f(prog, 'uShadowBias', CONFIG.shadow.bias);
    this.bindTex(prog, 'uShadowMap', st.shadowTex || st.whiteTex, 2);
    // planar lightmap (baked AO + dynamic scorch) — ground receives it
    if (o.useLightmap && st.lightTex) {
      this.bindTex(prog, 'uLightmap', st.lightTex, 3);
      this.u1i(prog, 'uUseLightmap', 1);
      const l4 = prog.u.uLMRect;
      if (l4) {
        const key = 'RECT';
        const prev = this._u[key];
        const r = st.lmRect;
        if (!prev || prev[0] !== r[0] || prev[1] !== r[1] || prev[2] !== r[2] || prev[3] !== r[3]) {
          this._u[key] = [r[0], r[1], r[2], r[3]];
          gl.uniform4f(l4, r[0], r[1], r[2], r[3]);
        }
      }
    } else {
      this.u1i(prog, 'uUseLightmap', 0);
    }
    this.u1i(prog, 'uReceiveShadow', o.receiveShadow === false ? 0 : 1);
    this.u1i(prog, 'uSkinned', o.skinned ? 1 : 0);
    if (o.skinned && o.skin) this.uSkinTex(prog, o.skin);
    const mat = prim.mat;
    const tint = o.tint || [1, 1, 1];
    const base = mat ? mat.base : [0.7, 0.7, 0.7];
    this.u3(prog, 'uBaseColor', [base[0] * tint[0], base[1] * tint[1], base[2] * tint[2]]);
    this.u1f(prog, 'uMetallic', o.metallic !== undefined ? o.metallic : (mat ? mat.metallic : 0.6));
    this.u1f(prog, 'uRoughness', o.roughness !== undefined ? o.roughness : (mat ? clamp(mat.roughness, 0.06, 1) : 0.6));
    this.u1f(prog, 'uAlpha', o.alpha !== undefined ? o.alpha : 1);
    const em = o.emissive || (mat ? mat.emissive : [0, 0, 0]);
    this.u3(prog, 'uEmissive', em);
    this.u1f(prog, 'uEmissiveBoost', o.emisBoost !== undefined ? o.emisBoost : (mat && mat.emissive && (mat.emissive[0] + mat.emissive[1] + mat.emissive[2]) > 0.02 ? 1.6 : 1.0));
    this.u1f(prog, 'uHitFlash', o.hitFlash || 0);
    this.u1i(prog, 'uUnlit', o.unlit ? 1 : 0);
    this.u1i(prog, 'uUseVColor', (prim.hasColor && !o.flatColor) ? 1 : 0);
    const tex = o.baseTex !== undefined ? o.baseTex : (mat && mat.baseTex >= 0 ? prim._tex : null);
    if (tex) {
      this.bindTex(prog, 'uBaseTexS', tex, 0);
      this.u1i(prog, 'uUseBaseTex', 1);
    } else {
      this.bindTex(prog, 'uBaseTexS', st.whiteTex, 0);
      this.u1i(prog, 'uUseBaseTex', 0);
    }
    // point lights
    this.u1i(prog, 'uNumPoints', st.numPoints);
    if (st.numPoints > 0) {
      const l2 = prog.u.uPointPos; if (l2) gl.uniform3fv(l2, st.pointPosArr.subarray(0, st.numPoints * 3));
      this.bindTex(prog, 'uPointColors', st.pointTex, 1);
    }
    if (prim.indexed) {
      gl.drawElements(gl.TRIANGLES, prim.iboCount, prim.iboType, 0);
      this.stats.tris += prim.iboCount / 3;
    } else {
      gl.drawArrays(gl.TRIANGLES, 0, prim.count);
      this.stats.tris += prim.count / 3;
    }
    this.stats.draws++;
    gl.bindVertexArray(null);
  }
  /** Depth-only pass for the shadow map. */
  drawPrimDepth(prim, model, skinned, skin) {
    const gl = this.gl, prog = this.progs.depth;
    this.use(prog);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.BLEND);
    this.um4(prog, 'uLightVP', this._lightVP);
    this.um4(prog, 'uModel', model);
    this.u1i(prog, 'uSkinned', skinned ? 1 : 0);
    if (skinned && skin) {
      // bind FIRST (activeTexture state), then push sampler uniforms
      gl.activeTexture(gl.TEXTURE0 + 5);
      gl.bindTexture(gl.TEXTURE_2D, skin.texBuf || this.jointTex);
      this.uSkinTexSimple(prog, skin);
    }
    gl.disable(gl.CULL_FACE);   // two-sided shadows reduce acne on thin props
    const vao = this.vaoFor(prim);
    gl.bindVertexArray(vao);
    if (prim.indexed) gl.drawElements(gl.TRIANGLES, prim.iboCount, prim.iboType, 0);
    else gl.drawArrays(gl.TRIANGLES, 0, prim.count);
    this.stats.draws++;
    gl.bindVertexArray(null);
  }
  uSkinTexSimple(prog, skin) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + 5);
    gl.bindTexture(gl.TEXTURE_2D, this.jointTex);
    if (this._u['JT' + prog.name] !== 5) { this._u['JT' + prog.name] = 5; const l = prog.u.uJointTex; if (l) gl.uniform1i(l, 5); }
    const l = prog.u.uJointTexW; if (l) gl.uniform1i(l, this.jointTexW);
  }
  setLightVP(m) { this._lightVP = m; }
  /** Fullscreen triangle-strip-free quad using gl_VertexID (no buffers). */
  fullscreen(prog, drawFn) {
    const gl = this.gl;
    this.use(prog);
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(this.emptyVao);
    drawFn();
    gl.bindVertexArray(null);
  }
  beginPost(st) {
    const gl = this.gl;
    this.stats.draws = 0; this.stats.tris = 0;
    // 1) bright pass
    this.ensureTargets(this.w, this.h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA.fb);
    gl.viewport(0, 0, this.bloomA.w, this.bloomA.h);
    const pb = this.progs.bright;
    this.fullscreen(pb, () => {
      this.bindTex(pb, 'uSrc', this.scene.tex, 0);
      this.u1f(pb, 'uThresh', CONFIG.bloom.threshold);
      this.u1f(pb, 'uKnee', CONFIG.bloom.knee);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    });
    // 2) separable gaussian blur (H then V) at half res
    const bl = this.progs.blur;
    const px = (1 / this.bloomA.w) * CONFIG.bloom.radius, py = (1 / this.bloomA.h) * CONFIG.bloom.radius;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomB.fb);
    gl.viewport(0, 0, this.bloomB.w, this.bloomB.h);
    this.fullscreen(bl, () => {
      this.bindTex(bl, 'uSrc', this.bloomA.tex, 0);
      gl.uniform2f(bl.u.uDir, px, 0); this._u.uDir = null;
      this.u1i(bl, 'uSamples', CONFIG.bloom.samples);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomA.fb);
    gl.viewport(0, 0, this.bloomA.w, this.bloomA.h);
    this.fullscreen(bl, () => {
      this.bindTex(bl, 'uSrc', this.bloomB.tex, 0);
      gl.uniform2f(bl.u.uDir, 0, py); this._u.uDir = null;
      this.u1i(bl, 'uSamples', CONFIG.bloom.samples);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    });
    // 3) composite to default framebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    const pc = this.progs.comp;
    this.fullscreen(pc, () => {
      this.bindTex(pc, 'uScene', this.scene.tex, 0);
      this.bindTex(pc, 'uBloom', this.bloomA.tex, 1);
      this.u1f(pc, 'uExposure', CONFIG.render.exposure);
      this.u1f(pc, 'uBloomInt', CONFIG.bloom.intensity);
      gl.uniform1f(pc.u.uTime, st.time); this._u.uTime = null;
      gl.uniform1f(pc.u.uVignette, st.vignette !== undefined ? st.vignette : 0.55);
      gl.uniform1f(pc.u.uAberr, st.aberr || 0);
      gl.uniform1f(pc.u.uDamage, st.damage || 0);
      gl.uniform1f(pc.u.uScan, st.scan || 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    });
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
  }
  beginScene() {
    const gl = this.gl;
    this.ensureTargets(this.w, this.h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fb);
    gl.viewport(0, 0, this.w, this.h);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }
  beginShadow() {
    const gl = this.gl, S = CONFIG.shadow.size;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFb);
    gl.viewport(0, 0, S, S);
    gl.clear(gl.DEPTH_BUFFER_BIT);
  }
  endShadow() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fb);
    gl.viewport(0, 0, this.w, this.h);
  }
}


export { Renderer };
