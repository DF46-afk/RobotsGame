/* AUTO-MOVED from the original single-file index.html — do not hand-edit
 * section contents without checking against git history. */
'use strict';

import { MAT4_ID, V3, mat4, vec3 } from '../core/math.js';
import { clamp, logLine, rnd } from '../core/util.js';

/* ==========================================================================
 * === GAME WORLD ===========================================================
 * Asset loading with local->CDN fallback, static batching of the city,
 * procedural enemy drones and the GPU particle pool.
 * ==========================================================================*/

/** Fetch an asset: try the local file first (repo root / same server), then
 *  fall back to the raw.githubusercontent URL. Never rejects hard: returns
 *  null after both attempts so callers can degrade to procedural geometry. */
async function fetchGLB(name, url) {
  const tries = [name, url];
  for (let i = 0; i < tries.length; i++) {
    try {
      const r = await fetch(tries[i]);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = await r.arrayBuffer();
      if (buf.byteLength < 32) throw new Error('empty response');
      logLine(name + ' fetched (' + (buf.byteLength / 1048576).toFixed(1) + ' MB via ' + (i === 0 ? 'local' : 'cdn') + ')');
      return buf;
    } catch (e) {
      logLine(name + ': ' + tries[i].slice(0, 40) + ' failed (' + e.message + ')', true);
    }
  }
  return null;
}

/** Static batcher: merges every primitive of a parsed asset into ONE big
 *  interleaved VBO (pos/nrm/uv/color) grouped by material, applying each
 *  node's world matrix at bake time. The city has ~2455 mesh nodes; without
 *  this we would issue thousands of draw calls per frame. */
function batchAsset(gl, asset) {
  const groups = new Map();          // matIdx -> { mat, srcs:[{prim,m}] }
  // index prims by mesh id once (the city has 2455 meshes x nodes; a nested
  // scan here would be quadratic)
  const byMesh = new Map();
  for (const prim of asset.prims) {
    if (prim.skinned || !prim.cpu) continue;
    if (!byMesh.has(prim.mesh)) byMesh.set(prim.mesh, []);
    byMesh.get(prim.mesh).push(prim);
  }
  for (const nd of asset.nodes) {
    if (nd.mesh < 0) continue;
    const list = byMesh.get(nd.mesh);
    if (!list) continue;
    for (const prim of list) {
      const mi = prim.mat ? prim.mat.idx : -1;
      let g = groups.get(mi);
      if (!g) { g = { mat: prim.mat, srcs: [] }; groups.set(mi, g); }
      g.srcs.push({ prim, m: nd.world });
    }
  }
  const batches = [];
  for (const [mi, g] of groups) {
    if (!g.srcs.length) continue;
    let tverts = 0, tidx = 0;
    for (const s of g.srcs) { tverts += s.prim.count; tidx += s.prim.indexed ? s.prim.iboCount : s.prim.count; }
    const inter = new Float32Array(tverts * 11);   // pos3 nrm3 uv2 col3
    const indices = tverts > 65535 ? new Uint32Array(tidx) : new Uint16Array(tidx);
    let vo = 0, io = 0, base = 0;
    const tn = MAT4_ID(), invT = MAT4_ID();
    for (const s of g.srcs) {
      const p = s.prim, m = s.m;
      mat4.invert(invT, m); mat4.transpose(tn, invT);
      const P = p.cpu.POSITION, N = p.cpu.NORMAL, U = p.cpu.TEXCOORD_0, C = p.cpu.COLOR_0;
      for (let v = 0; v < p.count; v++) {
        const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
        inter[vo]     = m[0] * x + m[4] * y + m[8] * z + m[12];
        inter[vo + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        inter[vo + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        if (N) {
          const nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2];
          let ax = tn[0] * nx + tn[4] * ny + tn[8] * nz;
          let ay = tn[1] * nx + tn[5] * ny + tn[9] * nz;
          let az = tn[2] * nx + tn[6] * ny + tn[10] * nz;
          const l = Math.hypot(ax, ay, az) || 1;
          inter[vo + 3] = ax / l; inter[vo + 4] = ay / l; inter[vo + 5] = az / l;
        } else { inter[vo + 3] = 0; inter[vo + 4] = 1; inter[vo + 5] = 0; }
        if (U) { inter[vo + 6] = U[v * 2]; inter[vo + 7] = U[v * 2 + 1]; }
        else { inter[vo + 6] = 0.5; inter[vo + 7] = 0.5; }
        if (C) { inter[vo + 8] = C[v * 3]; inter[vo + 9] = C[v * 3 + 1]; inter[vo + 10] = C[v * 3 + 2]; }
        else { inter[vo + 8] = 1; inter[vo + 9] = 1; inter[vo + 10] = 1; }
        vo += 11;
      }
      if (p.indexed) {
        const I = p.cpu.IBO;
        for (let i = 0; i < I.length; i++) indices[io++] = I[i] + base;
      } else {
        for (let i = 0; i < p.count; i++) indices[io++] = base + i;
      }
      base += p.count;
    }
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, inter, gl.STATIC_DRAW);
    const STR = 44;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STR, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, STR, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, STR, 24);
    gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 3, gl.FLOAT, false, STR, 32);
    gl.disableVertexAttribArray(3); gl.vertexAttrib4f(3, 0, 0, 0, 0);
    gl.disableVertexAttribArray(4); gl.vertexAttrib4f(4, 1, 0, 0, 0);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    batches.push({
      vao, ib, count: io, type: indices instanceof Uint32Array ? 0x1405 : 0x1403,
      mat: g.mat, tris: io / 3
    });
  }
  batches.sort((a, b) => b.tris - a.tris);
  return batches;
}

/** Procedural sci-fi drone: octahedral core + hull plates + rotor ring +
 *  glowing eye. Built as one static batch (few hundred tris, 1 draw call). */
function makeDroneAsset(gl) {
  const pos = [], nrm = [], col = [], idx = [];
  let base = 0;
  function quad(a, b, c, d, color) {
    const e1 = vec3.sub(V3(), b, a), e2 = vec3.sub(V3(), c, a);
    const n = vec3.norm(V3(), vec3.cross(V3(), e1, e2));
    for (const v of [a, b, c]) { pos.push(v[0], v[1], v[2]); nrm.push(n[0], n[1], n[2]); col.push(color[0], color[1], color[2]); }
    pos.push(d[0], d[1], d[2]); nrm.push(n[0], n[1], n[2]); col.push(color[0], color[1], color[2]);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    base += 4;
  }
  function tri(a, b, c, color) {
    const e1 = vec3.sub(V3(), b, a), e2 = vec3.sub(V3(), c, a);
    const n = vec3.norm(V3(), vec3.cross(V3(), e1, e2));
    for (const v of [a, b, c]) { pos.push(v[0], v[1], v[2]); nrm.push(n[0], n[1], n[2]); col.push(color[0], color[1], color[2]); }
    idx.push(base, base + 1, base + 2);
    base += 3;
  }
  const box = (cx, cy, cz, sx, sy, sz, color) => {
    const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
    const V = (x, y, z) => V3(x, y, z);
    quad(V(x0, y0, z1), V(x1, y0, z1), V(x1, y1, z1), V(x0, y1, z1), color);
    quad(V(x1, y0, z0), V(x0, y0, z0), V(x0, y1, z0), V(x1, y1, z0), color);
    quad(V(x0, y1, z1), V(x1, y1, z1), V(x1, y1, z0), V(x0, y1, z0), color);
    quad(V(x0, y0, z0), V(x1, y0, z0), V(x1, y0, z1), V(x0, y0, z1), color);
    quad(V(x1, y0, z1), V(x1, y0, z0), V(x1, y1, z0), V(x1, y1, z1), color);
    quad(V(x0, y0, z0), V(x0, y0, z1), V(x0, y1, z1), V(x0, y1, z0), color);
  };
  const body = [0.34, 0.36, 0.42], dark = [0.12, 0.13, 0.16], trim = [0.85, 0.4, 0.12];
  // core hull
  box(0, 0, 0, 1.0, 0.62, 1.25, body);
  box(0, 0.05, -0.72, 0.7, 0.42, 0.35, dark);           // tail boom
  box(0.62, 0.02, 0.1, 0.34, 0.3, 0.8, dark);           // side pods
  box(-0.62, 0.02, 0.1, 0.34, 0.3, 0.8, dark);
  box(0, 0.42, 0.05, 0.5, 0.24, 0.6, trim);             // dorsal spine
  // sensor "eye" housing at the front
  box(0, 0.02, 0.68, 0.34, 0.26, 0.16, dark);
  // rotor pylons
  box(0.85, 0.24, 0.1, 0.16, 0.5, 0.16, body);
  box(-0.85, 0.24, 0.1, 0.16, 0.5, 0.16, body);
  // thin rotor blades (spin animated via whole-drone yaw wobble in shader-free code)
  box(0.85, 0.5, 0.1, 1.15, 0.03, 0.12, dark);
  box(-0.85, 0.5, 0.1, 1.15, 0.03, 0.12, dark);
  const arr = {
    POSITION: new Float32Array(pos), NORMAL: new Float32Array(nrm),
    COLOR_0: new Float32Array(col), IBO: new Uint16Array(idx)
  };
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const bufs = {};
  const upload = (key, size, loc) => {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, arr[key], gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    bufs[key] = b;
  };
  upload('POSITION', 3, 0); upload('NORMAL', 3, 1); upload('COLOR_0', 3, 5);
  gl.disableVertexAttribArray(2); gl.vertexAttrib2f(2, 0.5, 0.5);
  gl.disableVertexAttribArray(3); gl.vertexAttrib4f(3, 0, 0, 0, 0);
  gl.disableVertexAttribArray(4); gl.vertexAttrib4f(4, 1, 0, 0, 0);
  const ib = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, arr.IBO, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return {
    vao, ibo: ib, count: idx.length, type: 0x1403, tris: idx.length / 3,
    dispose() { gl.deleteVertexArray(vao); for (const k in bufs) gl.deleteBuffer(bufs[k]); gl.deleteBuffer(ib); }
  };
}

/** Emissive eye sprite for drones (small unlit quad pair that faces camera). */
function makeGlowQuads(gl, quads) {
  // quads: [{x,y,z,r,g,b,size}] rebuilt every frame from a preallocated buffer
  const MAXQ = 64;
  const data = new Float32Array(MAXQ * 4 * 11);
  const idxArr = new Uint16Array(MAXQ * 6);
  for (let q = 0; q < MAXQ; q++) {
    const b = q * 4;
    idxArr[q * 6] = b; idxArr[q * 6 + 1] = b + 1; idxArr[q * 6 + 2] = b + 2;
    idxArr[q * 6 + 3] = b; idxArr[q * 6 + 4] = b + 2; idxArr[q * 6 + 5] = b + 3;
  }
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 44, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 44, 12);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 44, 24);
  gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 3, gl.FLOAT, false, 44, 32);
  gl.disableVertexAttribArray(3); gl.vertexAttrib4f(3, 0, 0, 0, 0);
  gl.disableVertexAttribArray(4); gl.vertexAttrib4f(4, 1, 0, 0, 0);
  const ib = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idxArr, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return { vao, vb, ib, data, MAXQ };
}

/** Simple additive particle pool rendered through the mesh program unlit. */
class Particles {
  constructor(max = 900) {
    this.max = max; this.n = 0;
    this.px = new Float32Array(max); this.py = new Float32Array(max); this.pz = new Float32Array(max);
    this.vx = new Float32Array(max); this.vy = new Float32Array(max); this.vz = new Float32Array(max);
    this.life = new Float32Array(max); this.maxLife = new Float32Array(max);
    this.r = new Float32Array(max); this.g = new Float32Array(max); this.b = new Float32Array(max);
    this.size = new Float32Array(max); this.grav = new Float32Array(max);
  }
  spawn(x, y, z, vx, vy, vz, life, color, size, grav = -9) {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.life[i] = this.maxLife[i] = life;
    this.r[i] = color[0]; this.g[i] = color[1]; this.b[i] = color[2];
    this.size[i] = size; this.grav[i] = grav;
  }
  burst(x, y, z, num, speed, color, life, size, spreadY = 1) {
    for (let i = 0; i < num; i++) {
      const th = rnd(Math.PI * 2), ph = Math.acos(rnd(-1, 1));
      const s = speed * rnd(0.35, 1);
      this.spawn(x, y, z,
        Math.sin(ph) * Math.cos(th) * s, Math.abs(Math.cos(ph)) * s * spreadY, Math.sin(ph) * Math.sin(th) * s,
        life * rnd(0.6, 1.2), color, size * rnd(0.6, 1.3));
    }
  }
  update(dt) {
    for (let i = 0; i < this.n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {   // swap-remove
        const j = --this.n;
        if (j !== i) {
          this.px[i] = this.px[j]; this.py[i] = this.py[j]; this.pz[i] = this.pz[j];
          this.vx[i] = this.vx[j]; this.vy[i] = this.vy[j]; this.vz[i] = this.vz[j];
          this.life[i] = this.life[j]; this.maxLife[i] = this.maxLife[j];
          this.r[i] = this.r[j]; this.g[i] = this.g[j]; this.b[i] = this.b[j];
          this.size[i] = this.size[j]; this.grav[i] = this.grav[j];
        }
        i--;
        continue;
      }
      this.vy[i] += this.grav[i] * dt;
      this.px[i] += this.vx[i] * dt; this.py[i] += this.vy[i] * dt; this.pz[i] += this.vz[i] * dt;
    }
  }
  /** Fill a glow-quad buffer (camera-facing) for rendering. */
  fillQuads(gq, camRight, camUp) {
    const d = gq.data;
    let o = 0;
    const count = Math.min(this.n, gq.MAXQ);
    for (let i = 0; i < count; i++) {
      const fade = clamp(this.life[i] / this.maxLife[i], 0, 1);
      const s = this.size[i] * (0.4 + fade * 0.8);
      const x = this.px[i], y = this.py[i], z = this.pz[i];
      const rx = camRight[0] * s, ry = camRight[1] * s, rz = camRight[2] * s;
      const ux = camUp[0] * s, uy = camUp[1] * s, uz = camUp[2] * s;
      const cr = this.r[i] * (0.5 + fade), cg = this.g[i] * (0.5 + fade), cb = this.b[i] * (0.5 + fade);
      const corners = [[x - rx - ux, y - ry - uy, z - rz - uz], [x + rx - ux, y + ry - uy, z + rz - uz],
                       [x + rx + ux, y + ry + uy, z + rz + uz], [x - rx + ux, y - ry + uy, z - rz + uz]];
      const uvs = [0, 0, 1, 0, 1, 1, 0, 1];
      for (let c = 0; c < 4; c++) {
        d[o] = corners[c][0]; d[o + 1] = corners[c][1]; d[o + 2] = corners[c][2];
        d[o + 3] = 0; d[o + 4] = 1; d[o + 5] = 0;
        d[o + 6] = uvs[c * 2]; d[o + 7] = uvs[c * 2 + 1];
        d[o + 8] = cr; d[o + 9] = cg; d[o + 10] = cb;
        o += 11;
      }
    }
    return count;
  }
}


export { Particles, batchAsset, makeDroneAsset, makeGlowQuads };
