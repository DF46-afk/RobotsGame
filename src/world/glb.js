/* AUTO-MOVED from the original single-file index.html — do not hand-edit
 * section contents without checking against git history. */
'use strict';

import { CONFIG } from '../core/config.js';
import { MAT4_ID, mat4 } from '../core/math.js';
import { clamp, logLine } from '../core/util.js';

/* ==========================================================================
 * === GLB PARSER ===========================================================
 * Hand written binary glTF (GLB 2.0) reader. This is the most fragile part of
 * the engine, so every step is defensive: bounds checks everywhere, and any
 * failure degrades to a coloured box instead of throwing into the frame loop.
 *
 * GLB layout (all little endian):
 *   +----------------------------------------------------------+
 *   | header : uint32 magic 'glTF' | uint32 version | uint32 len|
 *   +----------------------------------------------------------+
 *   | chunk0 : uint32 len | uint32 type(='JSON') | payload     |
 *   | chunk1 : uint32 len | uint32 type(='BIN\0')| payload     |
 *   +----------------------------------------------------------+
 * The JSON chunk is a full glTF document: buffers / bufferViews / accessors /
 * meshes / materials / nodes / skins / images / textures / samplers.
 *
 * Accessor model (important!):
 *   accessor -> bufferView{byteOffset,byteStride,target} -> BIN chunk (+ the
 *   accessor's own byteOffset). componentType decides element size & type:
 *       5120 i8 | 5121 u8 | 5122 i16 | 5123 u16 | 5125 u32 | 5126 f32
 *   NORMALIZED u8/u16 attributes (weights, joints as u8) must be rescaled to
 *   [0,1] / [0,65535] — we do that manually because WebGL2 vertex attrib
 *   "normalized" flags are per attribute and easier to control on the CPU.
 *   We always DE-INTERLEAVE into tightly packed typed arrays so VAO setup can
 *   use stride = 0 (tightly packed), which keeps the shader/attrib code simple.
 * ==========================================================================*/

/** Component metadata table: [bytesPerElement, TypedArrayCtor, glEnum]. */
const GLB_COMP = {
  5120: [1, Int8Array,    0x1400], // BYTE
  5121: [1, Uint8Array,   0x1401], // UNSIGNED_BYTE
  5122: [2, Int16Array,   0x1402], // SHORT
  5123: [2, Uint16Array,  0x1403], // UNSIGNED_SHORT
  5125: [4, Uint32Array,  0x1405], // UNSIGNED_INT
  5126: [4, Float32Array, 0x1406]  // FLOAT
};
const GLB_NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const GL_TARGET_ARRAY_BUFFER = 0x8892, GL_TARGET_ELEMENT_ARRAY_BUFFER = 0x8893;
/* anisotropy enum is owned by the renderer module (avoids cyclic import);
 * call setAniso(v) from Renderer init. */
let _aniso = 0;
export function setAniso(v) { _aniso = v; }

/**
 * Split a GLB ArrayBuffer into its JSON document + binary blob.
 * @param {ArrayBuffer} buf raw file bytes
 * @returns {{json:Object, bin:ArrayBuffer}}
 * @throws if magic/version/chunks are malformed
 */
function glbSplit(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 12) throw new Error('GLB too small: ' + buf.byteLength + ' bytes');
  const magic = dv.getUint32(0, true), version = dv.getUint32(4, true), total = dv.getUint32(8, true);
  if (magic !== 0x46546C67 /* 'glTF' */) throw new Error('bad GLB magic 0x' + magic.toString(16));
  if (version !== 2) logLine('glb version ' + version + ' (expected 2) — attempting parse', true);
  let off = 12, jsonTxt = null, bin = null;
  // Walk chunks until the declared total length; tolerate trailing padding.
  while (off + 8 <= Math.min(total, buf.byteLength)) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    const start = off + 8, end = start + len;
    if (len < 0 || end > buf.byteLength) throw new Error('chunk overruns file at offset ' + off);
    if (type === 0x4E4F534A /* 'JSON' */) {
      jsonTxt = new TextDecoder('utf-8').decode(new Uint8Array(buf, start, len));
    } else if (type === 0x004E4942 /* 'BIN\0' */) {
      bin = buf.slice(start, end);            // copy: keeps alignment independent
    }
    off = end + ((4 - (end % 4)) % 4);        // chunks are 4-byte aligned
  }
  if (!jsonTxt) throw new Error('no JSON chunk found');
  if (!bin) bin = new ArrayBuffer(0);         // some GLBs are JSON-only
  return { json: JSON.parse(jsonTxt), bin };
}

/**
 * Read an accessor into a tightly packed Float32Array (de-interleaved,
 * normalized where required by the spec). Indices keep their integer type.
 * @returns {{data:Float32Array|Int32Array|Uint16Array, comps:number, count:number, intType?:number}}
 */
function glbReadAccessor(gltf, bin, accIndex, forceFloat = true) {
  const A = gltf.accessors && gltf.accessors[accIndex];
  if (!A) throw new Error('missing accessor ' + accIndex);
  const comps = GLB_NCOMP[A.type];
  if (!comps) throw new Error('unsupported accessor type ' + A.type);
  const meta = GLB_COMP[A.componentType];
  if (!meta) throw new Error('unsupported componentType ' + A.componentType);
  const [elemSize, Ctor, glType] = meta;
  const count = A.count;
  const out = new Float32Array(count * comps);
  const bv = (A.bufferView !== undefined) ? gltf.bufferViews[A.bufferView] : null;
  if (bv) {
    // byteStride is OPTIONAL: when absent the data is tightly packed.
    const tight = comps * elemSize;
    const stride = bv.byteStride || tight;
    const base = (bv.byteOffset || 0) + (A.byteOffset || 0);
    if (base < 0 || base % elemSize !== 0)
      throw new Error('accessor ' + accIndex + ': misaligned base ' + base + ' for elemSize ' + elemSize);
    if (base + (count - 1) * stride + tight > bin.byteLength)
      throw new Error('accessor ' + accIndex + ' exceeds BIN chunk');
    // Per spec, a typed-array view over an interleaved row must never read
    // past the last component of the final element — clamp the view length.
    const tailPad = (stride > tight) ? (stride - tight) / elemSize : 0;   // elems after last comp in final row
    const viewLen = Math.max(0, Math.min(count * comps + tailPad,
      Math.floor((bin.byteLength - base) / elemSize)) - tailPad);
    const src = new Ctor(bin, base, viewLen);
    const elemsPerRow = stride / elemSize;   // components per interleaved row
    // NORMALIZED integer attributes (u8/u16 weights on some exporters) must be
    // rescaled on the CPU: u8 -> /255, u16 -> /65535, i8 -> /127, i16 -> /32767.
    let normDiv = 1;
    if (A.normalized === true) {
      normDiv = A.componentType === 5121 ? 255 : A.componentType === 5123 ? 65535
              : A.componentType === 5120 ? 127 : A.componentType === 5122 ? 32767 : 1;
    }
    if (elemsPerRow === comps) {
      // fast path: tightly packed — bulk copy, scale only when needed
      if (normDiv === 1) out.set(src.subarray(0, count * comps));
      else for (let i = 0; i < src.length; i++) out[i] = src[i] / normDiv;
    } else {
      for (let i = 0; i < count; i++) {
        const rb = i * elemsPerRow;
        for (let c = 0; c < comps; c++) out[i * comps + c] = src[rb + c] / normDiv;
      }
    }
  } else if (A.type && A.count) {
    // Accessor with no bufferView (rare): values may be all-zero or sparse.
    // We intentionally leave `out` zero-filled and log once — a wrong guess
    // here corrupts geometry silently, so visibility matters.
    logLine('accessor ' + accIndex + ' has no bufferView (sparse?) — zero-filled', true);
  }
  if (!forceFloat) {
    const ints = new Int32Array(count * comps);
    for (let i = 0; i < ints.length; i++) ints[i] = Math.round(out[i]);
    return { data: ints, comps, count, intType: A.componentType };
  }
  return { data: out, comps, count, intType: A.componentType, glType };
}

/** Read index accessor preserving GPU-friendly types (u16 preferred). */
function glbReadIndices(gltf, bin, accIndex) {
  const A = gltf.accessors[accIndex];
  if (!A) throw new Error('missing index accessor ' + accIndex);
  const comps = 1, meta = GLB_COMP[A.componentType];
  if (!meta) throw new Error('bad index componentType ' + A.componentType);
  const [, Ctor] = meta;
  const bv = gltf.bufferViews[A.bufferView];
  const base = (bv.byteOffset || 0) + (A.byteOffset || 0);
  if (base + A.count * meta[0] > bin.byteLength) throw new Error('index accessor exceeds BIN');
  const raw = new Ctor(bin, base, A.count);
  let maxI = 0;
  for (let i = 0; i < A.count; i++) if (raw[i] > maxI) maxI = raw[i];
  const arr = (maxI <= 65535) ? new Uint16Array(A.count) : new Uint32Array(A.count);
  arr.set(raw);
  return { data: arr, count: A.count, glType: (arr instanceof Uint16Array) ? 0x1403 : 0x1405 };
}

/**
 * Create a WebGL2 texture from embedded image bytes (PNG/JPEG via browser
 * decode) or from a base64 data URI. Returns null on failure (never throws).
 */
async function glbTexture(gl, gltf, bin, texIndex) {
  try {
    const t = gltf.textures[texIndex]; if (!t) return null;
    const img = gltf.images[t.source]; if (!img) return null;
    let blobUrl = null, bitmap = null;
    if (img.bufferView !== undefined) {
      const bv = gltf.bufferViews[img.bufferView];
      const off = bv.byteOffset || 0, len = bv.byteLength;
      const mime = img.mimeType || 'image/png';
      const bytes = new Uint8Array(bin, off, len);
      blobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
    } else if (typeof img.uri === 'string' && img.uri.startsWith('data:')) {
      blobUrl = img.uri;
    } else if (typeof img.uri === 'string') {
      const r = await fetch(img.uri); blobUrl = URL.createObjectURL(await r.blob());
    } else return null;
    if (typeof createImageBitmap === 'function') {
      const resp = await fetch(blobUrl);
      try { bitmap = await createImageBitmap(resp.body ? await resp.blob() : resp); } catch (e) { bitmap = null; }
    }
    let el = null;
    if (!bitmap) {
      el = new Image(); el.decoding = 'async';
      await new Promise((res, rej) => { el.onload = res; el.onerror = () => rej(new Error('img decode')); el.src = blobUrl; });
    }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const src = bitmap || el;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.generateMipmap(gl.TEXTURE_2D);
    const smp = gltf.samplers ? gltf.samplers[(gltf.textures[texIndex].sampler ?? 0)] : null;
    const wrap = smp ? smp.wrapS : 10497;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap === 33071 ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, (smp ? smp.wrapT : 10497) === 33071 ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    const linear = !smp || smp.magFilter !== 9728;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    if (_aniso) gl.texParameterf(gl.TEXTURE_2D, _aniso, CONFIG.render.maxAniso);
    if (blobUrl && blobUrl.startsWith('blob:')) URL.revokeObjectURL(blobUrl);
    if (bitmap && bitmap.close) bitmap.close();
    return tex;
  } catch (e) {
    logLine('texture ' + texIndex + ' failed: ' + e.message, true);
    return null;
  }
}

/**
 * Parse a GLB into GPU-ready structures.
 * @returns {Promise<Object>} asset {prims,nodes,skins,bounds,textures,ok,label}
 */
export async function parseGLB(gl, arrayBuffer, label, opts) {
  opts = opts || {};
  const { json: g, bin } = glbSplit(arrayBuffer);
  const asset = {
    label, gltf: g, bin, prims: [], nodes: [], skins: [], textures: new Map(),
    bounds: { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] },
    scale: 1,
    ok: true
  };
  /* ---- materials: resolve PBR factors + textures ------------------------- */
  const mats = (g.materials || []).map((m, mi) => {
    const pbr = m.pbrMetallicRoughness || {};
    const bf = pbr.baseColorFactor || [1, 1, 1, 1];
    const em = m.emissiveFactor || [0, 0, 0];
    return {
      idx: mi, name: m.name || ('mat' + mi),
      base: [bf[0], bf[1], bf[2]], alpha: bf[3],
      metallic: pbr.metallicFactor !== undefined ? pbr.metallicFactor : 1,
      roughness: pbr.roughnessFactor !== undefined ? pbr.roughnessFactor : 1,
      emissive: em, doubleSided: !!m.doubleSided, alphaMode: m.alphaMode || 'OPAQUE',
      baseTex: pbr.baseColorTexture ? pbr.baseColorTexture.index : -1,
      mrTex: pbr.metallicRoughnessTexture ? pbr.metallicRoughnessTexture.index : -1,
      occTex: m.occlusionTexture ? m.occlusionTexture.index : -1,
      emisTex: m.emissiveTexture ? m.emissiveTexture.index : -1
    };
  });
  asset.materials = mats;
  /* ---- meshes -> primitives (one draw item each) ------------------------- */
  const meshList = g.meshes || [];
  for (let mi = 0; mi < meshList.length; mi++) {
    for (let pi = 0; pi < meshList[mi].primitives.length; pi++) {
      const p = meshList[mi].primitives[pi];
      if (p.mode !== undefined && p.mode !== 4) continue;   // TRIANGLES only
      const attrs = p.attributes || {};
      if (!attrs.POSITION) continue;                        // nothing drawable
      try {
        const prim = {
          mesh: mi, prim: pi, mat: (p.material !== undefined ? mats[p.material] : mats[0]) || null,
          mode: 4, vbo: {}, ibo: null, count: 0, indexed: false, skinned: false,
          bboxMin: null, bboxMax: null, name: (meshList[mi].name || ('mesh' + mi))
        };
        const pos = glbReadAccessor(g, bin, attrs.POSITION);
        prim.vbo.POSITION = pos.data; prim.count = pos.count;
        prim.bboxMin = [pos.data[0], pos.data[1], pos.data[2]];
        prim.bboxMax = [pos.data[0], pos.data[1], pos.data[2]];
        for (let i = 0; i < pos.count; i++) {
          for (let c = 0; c < 3; c++) {
            const v = pos.data[i * 3 + c];
            if (v < prim.bboxMin[c]) prim.bboxMin[c] = v;
            if (v > prim.bboxMax[c]) prim.bboxMax[c] = v;
          }
        }
        if (attrs.NORMAL) prim.vbo.NORMAL = glbReadAccessor(g, bin, attrs.NORMAL).data;
        if (attrs.TEXCOORD_0) {
          const uv = glbReadAccessor(g, bin, attrs.TEXCOORD_0);
          if (uv.comps >= 2) {
            prim.vbo.TEXCOORD_0 = uv.data instanceof Float32Array && uv.comps === 2
              ? uv.data : (() => { const o = new Float32Array(uv.count * 2);
                for (let i = 0; i < uv.count; i++) { o[i * 2] = uv.data[i * uv.comps]; o[i * 2 + 1] = uv.data[i * uv.comps + 1]; } return o; })();
          }
        }
        if (attrs.COLOR_0) {
          // glbReadAccessor already normalises `normalized:true` integer accessors;
          // non-normalised u8/u16 vertex colors still need the 255/65535 divide.
          const c = glbReadAccessor(g, bin, attrs.COLOR_0);
          const oc = new Float32Array(c.count * 3);
          const colAcc = g.accessors[attrs.COLOR_0];
          const div = (colAcc.normalized || !colAcc.componentType) ? 1 :
            (colAcc.componentType === 5121 || colAcc.componentType === 5120) ? 255 :
            (colAcc.componentType === 5123 || colAcc.componentType === 5122) ? 65535 : 1;
          for (let i = 0; i < c.count; i++) {
            oc[i * 3] = Math.min(1, c.data[i * c.comps] / div);
            oc[i * 3 + 1] = Math.min(1, c.data[i * c.comps + 1] / div);
            oc[i * 3 + 2] = Math.min(1, c.data[i * c.comps + 2] / div);
          }
          prim.vbo.COLOR_0 = oc; prim.hasColor = true;
        }
        if (attrs.JOINTS_0 && attrs.WEIGHTS_0) {
          // joints: keep as float (converted to Uint16 below); weights already normalized by accessor
          const j = glbReadAccessor(g, bin, attrs.JOINTS_0);
          const w = glbReadAccessor(g, bin, attrs.WEIGHTS_0);
          const jc = new Uint16Array(j.count * j.comps);
          for (let i = 0; i < jc.length; i++) jc[i] = Math.min(CONFIG.render.skinJoints - 1, Math.round(j.data[i]));
          const wc = new Float32Array(w.count * 4);
          for (let i = 0; i < w.count; i++) {
            let s = 0; for (let c = 0; c < Math.min(4, w.comps); c++) s += w.data[i * w.comps + c];
            for (let c = 0; c < 4; c++) {
              const v = c < Math.min(4, w.comps) ? w.data[i * w.comps + c] : 0;
              wc[i * 4 + c] = s > 0 ? v / s : (c === 0 ? 1 : 0);
            }
          }
          prim.vbo.JOINTS_0 = jc; prim.vbo.WEIGHTS_0 = wc; prim.skinned = true;
        }
        if (p.indices !== undefined) {
          const idx = glbReadIndices(g, bin, p.indices);
          prim.iboData = idx.data; prim.iboType = idx.glType; prim.indexed = true;
        }
        // upload immediately: keeps peak memory low and simplifies lifetime mgmt
        prim.gpu = {};
        const mkGLBuf = (arr) => {
          const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
          gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW); return b;
        };
        // keepCpu: retain CPU copies so batchAsset() can merge static meshes
        // into a few big VBOs (the city has ~2455 nodes -> 1-3 draw calls).
        if (opts.keepCpu) {
          prim.cpu = Object.assign({}, prim.vbo);
          if (prim.indexed) prim.cpu.IBO = prim.iboData;
        }
        prim.gpu.POSITION = mkGLBuf(prim.vbo.POSITION); delete prim.vbo.POSITION;
        for (const key of ['NORMAL', 'TEXCOORD_0', 'COLOR_0', 'JOINTS_0', 'WEIGHTS_0']) {
          if (!prim.vbo[key]) continue;
          prim.gpu[key] = mkGLBuf(prim.vbo[key]); delete prim.vbo[key];
        }
        if (prim.indexed) {
          prim.ibo = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, prim.ibo);
          gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, prim.iboData, gl.STATIC_DRAW);
          prim.iboCount = prim.iboData.length; delete prim.iboData;
        }
        asset.prims.push(prim);
      } catch (e) {
        logLine(label + ' primitive ' + mi + '.' + pi + ' skipped: ' + e.message, true);
      }
    }
  }
  /* ---- node graph -------------------------------------------------------- */
  const nodes = g.nodes || [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    asset.nodes.push({
      index: i, name: n.name || ('node' + i), children: n.children || [], mesh: (n.mesh !== undefined ? n.mesh : -1),
      skin: (n.skin !== undefined ? n.skin : -1),
      T: new Float32Array(n.translation || [0, 0, 0]),
      R: new Float32Array(n.rotation || [0, 0, 0, 1]),
      S: new Float32Array(n.scale || [1, 1, 1]),
      M: n.matrix ? new Float32Array(n.matrix) : null,
      local: MAT4_ID(), world: MAT4_ID(), worldN: MAT4_ID()
    });
  }
  /* ---- skins: joint list + inverse bind matrices ------------------------- */
  const skins = g.skins || [];
  for (let si = 0; si < skins.length; si++) {
    const s = skins[si];
    let ibm = null;
    if (s.inverseBindMatrices !== undefined) {
      try { ibm = glbReadAccessor(g, bin, s.inverseBindMatrices).data; } catch (e) { logLine('IBM read failed: ' + e.message, true); }
    }
    const nj = s.joints.length;
    const ibmArr = new Float32Array(nj * 16);
    if (ibm && ibm.length >= nj * 16) ibmArr.set(ibm.subarray(0, nj * 16));
    else for (let j = 0; j < nj; j++) mat4.ident(ibmArr.subarray(j * 16, j * 16 + 16));
    asset.skins.push({
      index: si, joints: s.joints.slice(), ibm: ibmArr, skeleton: s.skeleton !== undefined ? s.skeleton : -1,
      jointMat: new Float32Array(nj * 16),   // full count (prepSkin writes W*4 texels)
      gpuBuf: gl.createBuffer(), count: Math.min(nj, CONFIG.render.skinJoints)
    });
  }
  /* ---- global (bind/rest) transforms + aggregate bounds ------------------ */
  computeNodeWorlds(asset, false);
  for (const nd of asset.nodes) {
    if (nd.mesh < 0) continue;
    for (const pr of asset.prims) {
      if (pr.mesh !== nd.mesh) continue;
      if (pr.skinned) continue;               // skinned geometry is authored in bind space
      expandBounds(asset.bounds, nd.world, pr.bboxMin, pr.bboxMax);
    }
  }
  /* ---- textures (lazy, deduped) ------------------------------------------ */
  asset.texFor = async (idx) => {
    if (idx < 0) return null;
    if (asset.textures.has(idx)) return asset.textures.get(idx);
    const t = await glbTexture(gl, g, bin, idx);
    asset.textures.set(idx, t);
    return t;
  };
  asset.dispose = () => {
    for (const p of asset.prims) {
      if (p._vao) gl.deleteVertexArray(p._vao);
      if (p.ibo) gl.deleteBuffer(p.ibo);
      for (const k in p.gpu) gl.deleteBuffer(p.gpu[k]);
    }
    for (const t of asset.textures.values()) if (t) gl.deleteTexture(t);
    for (const s of asset.skins) gl.deleteBuffer(s.gpuBuf);
    asset.prims.length = 0;
  };
  if (!asset.prims.length) { asset.ok = false; logLine(label + ': no drawable primitives', true); }
  return asset;
}

/** Multiply node TRS/M into local, then DFS parent*child into world. */
function computeNodeWorlds(asset, animated) {
  const nodes = asset.nodes;
  const childOf = new Set();
  for (const n of nodes) for (const c of n.children) childOf.add(c);
  for (const n of nodes) {
    if (n.M) mat4.copy(n.local, n.M);
    else mat4.compose(n.local, n.T, n.R, n.S);
  }
  const stack = [];
  for (let i = 0; i < nodes.length; i++) if (!childOf.has(i)) { stack.push(i); mat4.copy(nodes[i].world, nodes[i].local); }
  while (stack.length) {
    const i = stack.pop(), nd = nodes[i];
    for (const c of nd.children) {
      if (c < 0 || c >= nodes.length) continue;
      mat4.mul(nodes[c].world, nd.world, nodes[c].local);
      stack.push(c);
    }
  }
  if (animated) {
    for (const n of nodes) {
      mat4.invert(_s.mTmp, n.world); mat4.transpose(n.worldN, _s.mTmp);
    }
  }
}

/** AABB transform helper (axis aligned box -> world AABB). */
function expandBounds(out, m, mn, mx) {
  for (let c = 0; c < 3; c++) {
    const a = Math.abs(m[c]) * mn[0], b = Math.abs(m[4 + c]) * mn[1], d = Math.abs(m[8 + c]) * mn[2];
    const lo = Math.min(a, b, d), hi = Math.max(a, b, d);
    const tx = m[12] * mn[c];
    void tx;
    const c0 = m[c] * mn[0] + m[4 + c] * mn[1] + m[8 + c] * mn[2] + m[12 + c];
    const c1 = m[c] * mx[0] + m[4 + c] * mn[1] + m[8 + c] * mn[2] + m[12 + c];
    const c2 = m[c] * mn[0] + m[4 + c] * mx[1] + m[8 + c] * mn[2] + m[12 + c];
    const c3 = m[c] * mx[0] + m[4 + c] * mx[1] + m[8 + c] * mx[2] + m[12 + c];
    out.min[c] = Math.min(out.min[c], Math.min(Math.min(c0, c1), Math.min(c2, c3)));
    out.max[c] = Math.max(out.max[c], Math.max(Math.max(c0, c1), Math.max(c2, c3)));
    void lo; void hi; void d;
  }
}


/** Prepare a skin for GPU skinning. The mesh shader reads matrix j from the
 *  RGBA32F strip texels [j*4 .. j*4+3] addressed as x = b % W, y = b / W with
 *  b = j*4 — i.e. a flat 4·count-texel strip padded to width `texW`. */
function prepSkin(r, asset, skin) {
  const W = Math.max(8, skin.count * 4);
  skin.texW = W;
  skin.jointTexData = new Float32Array(W * 4);   // one row of 4-component texels
  let o = 0;
  for (let j = 0; j < skin.count; j++)           // identity prefill
    for (let c = 0; c < 4; c++)
      for (let k = 0; k < 4; k++) skin.jointTexData[o++] = (c === k) ? 1 : 0;
  skin.texBuf = r.makeFloatTexture(W, 1, skin.jointTexData);
  skin.prims = [];
  for (const prim of asset.prims) {
    if (!prim.skinned) continue;
    prim._vao = r.vaoFor(prim);                   // fixed attrib layout
    skin.prims.push(prim);
  }
  return skin;
}

export { computeNodeWorlds, prepSkin };
