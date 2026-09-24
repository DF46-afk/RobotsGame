/* AUTO-MOVED from the original single-file index.html — do not hand-edit
 * section contents without checking against git history. */
'use strict';

import { clamp } from '../core/util.js';

/* ==========================================================================
 * === COLLISION / WORLD HELPERS =============================================
 * ==========================================================================*/
/** Cylinder-vs-AABB push-out used for mech-vs-building collision. */
function resolveCircleAABB(pos, radius, min, max) {
  const cx = clamp(pos[0], min[0], max[0]), cz = clamp(pos[2], min[2], max[2]);
  const dx = pos[0] - cx, dz = pos[2] - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 > radius * radius) return false;
  // inside footprint vertically?
  if (pos[1] + 3.2 < min[1] || pos[1] > max[1]) return false;
  if (d2 > 1e-8) {
    const d = Math.sqrt(d2), push = (radius - d);
    pos[0] += dx / d * push; pos[2] += dz / d * push;
  } else {
    // centre inside: eject along smallest penetration axis
    const pxl = pos[0] - min[0], pxr = max[0] - pos[0], pzl = pos[2] - min[2], pzr = max[2] - pos[2];
    const m = Math.min(pxl, pxr, pzl, pzr);
    if (m === pxl) pos[0] = min[0] - radius; else if (m === pxr) pos[0] = max[0] + radius;
    else if (m === pzl) pos[2] = min[2] - radius; else pos[2] = max[2] + radius;
  }
  return true;
}

/** Ray vs AABB (slab method). Returns hit distance or Infinity. */
function rayAABB(ro, rd, min, max) {
  let tmin = -Infinity, tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(rd[i]) < 1e-8) {
      if (ro[i] < min[i] || ro[i] > max[i]) return Infinity;
      continue;
    }
    const inv = 1 / rd[i];
    let t1 = (min[i] - ro[i]) * inv, t2 = (max[i] - ro[i]) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return Infinity;
  }
  return tmin >= 0 ? tmin : (tmax >= 0 ? 0 : Infinity);
}

/** Segment vs sphere (for hitscan bullets against enemy capsules). */
function raySphere(ro, rd, c, r) {
  const ox = ro[0] - c[0], oy = ro[1] - c[1], oz = ro[2] - c[2];
  const b = ox * rd[0] + oy * rd[1] + oz * rd[2];
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return Infinity;
  const s = Math.sqrt(disc);
  const t = -b - s;
  return t >= 0 ? t : (-b + s >= 0 ? 0 : Infinity);
}


export { rayAABB, resolveCircleAABB };
