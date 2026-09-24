/* AUTO-MOVED from the original single-file index.html — do not hand-edit
 * section contents without checking against git history. */
'use strict';

import { CONFIG } from '../core/config.js';
import { MAT4_ID, V3, mat4, quat, vec3 } from '../core/math.js';
import { clamp, damp, easeInOutCubic, lerp, rnd } from '../core/util.js';

/* ==========================================================================
 * === PROCEDURAL ANIMATION =================================================
 * No animation clips are assumed to exist in the GLBs, so every motion is
 * synthesised from code:
 *   - MechRig: joint-name pattern matching -> a semantic rig description
 *     (hips / spine / head / 2 arms / 2 legs) that works on BOTH provided
 *     mech skeletons (atlas "Pelvis/Spine_1/L_Arm_1..." and kitsune
 *     "B_38/B_0/B_37/B_14..") and degrades gracefully when parts are absent.
 *   - torsoSway / stepBob / recoil spring / foot grounding IK.
 * All of it writes into pre-allocated Float32Arrays (zero GC).
 * ==========================================================================*/

/** Bone classification keywords (lowercase substring match, first hit wins).
 *  Verified against the actual joint lists of both skinned GLBs:
 *   atlas_hangar_ld: Bone_Pelvis_01 / Bone_Tower(_End)_017/018 / Bone_Antlers_019 /
 *     Bone_[LR]_Arm_1..3 / Bone_Leg[LR]_Upper|Middle|Lower|Foot / SS2_043 (shield)
 *   kitsune_harpy_rig: B_38 (pelvis) / Head_17 / Tail [LTR]_* / L1..L5 [LR]_* (wing arms) */
const RIG_PATTERNS_ATLAS = {
  hips:    ['bone_pelvis', 'pelvis', 'hips'],
  spine1:  ['bone_hip_02', 'hip_root'],
  spine2:  ['bone_tower_017', 'bone_tower_0', 'spine_2', 'chest'],
  neck:    ['bone_tower_end', 'neck'],
  head:    ['antlers', 'head_1', 'head'],
  shield:  ['ss2_0', 'shield'],
  clavL:   ['l_arm_1', 'shoulder_l', 'clavicle_l'],
  upperL:  ['l_arm_2', 'upperarm_l'],
  foreL:   ['l_arm_3', 'forearm_l'],
  handL:   ['l_claw', 'l_hand'],
  pipesL:  ['pipe_1', 'pipe_2', 'pipe_3'],
  clavR:   ['r_arm_1', 'shoulder_r', 'clavicle_r'],
  upperR:  ['r_arm_2', 'upperarm_r'],
  foreR:   ['r_arm_3', 'forearm_r'],
  handR:   ['r_claw', 'r_hand'],
  thighL:  ['legl_upper', 'thigh_l'],
  kneeL:   ['legl_middle', 'calf_l'],
  ankleL:  ['legl_lower', 'shin_l'],
  footL:   ['legl_foot_0', 'foot_l'],
  thighR:  ['legr_upper', 'thigh_r'],
  kneeR:   ['legr_middle', 'calf_r'],
  ankleR:  ['legr_lower', 'shin_r'],
  footR:   ['legr_foot_0', 'foot_r'],
};
/** kitsune_harpy_rig is a quadruped bird-woman: pelvis B_38, Head_17, two
 *  wing arms L1..L5 (left/right), tail fan T/L/R — mapped onto the humanoid
 *  slots so the same pose code drives it (wings = "arms", tail = sway). */
const RIG_PATTERNS_KITSUNE = {
  hips:   ['b_38'],
  spine1: ['main_39'],
  spine2: ['b_38'],
  neck:   ['head_17'],
  head:   ['head_17'],
  jaw:    ['jaw_0'],
  clavL:  ['l1 l_', 'l1_l'], upperL: ['l2 l_', 'l2_l'], foreL: ['l3 l_', 'l3_l'], handL: ['l4 l_', 'l4_l'],
  clawL:  ['l5 l_', 'l5_l'],
  clavR:  ['l1 r_', 'l1_r'], upperR: ['l2 r_', 'l2_r'], foreR: ['l3 r_', 'l3_r'], handR: ['l4 r_', 'l4_r'],
  clawR:  ['l5 r_', 'l5_r'],
  tailC:  ['tail t_', 'tail_t'], tailL: ['tail l_', 'tail_l'], tailR: ['tail r_', 'tail_r'],
  ikL:    ['ik l_', 'ik_l'], poleL: ['ik pole l_'], tipL: ['x3 l_', 'x3_l'],
  ikR:    ['ik r_', 'ik_r'], poleR: ['ik pole r_'], tipR: ['x3 r_', 'x3_r'],
};
/** Pick the pattern table whose slot names match the asset's joint list. */
function rigPatternsFor(asset, skin) {
  const nm = skin.joints.map(j => (asset.nodes[j] ? asset.nodes[j].name : '').toLowerCase()).join('|');
  if (nm.indexOf('b_38') !== -1 || nm.indexOf('tail l_') !== -1) return RIG_PATTERNS_KITSUNE;
  return RIG_PATTERNS_ATLAS;
}

/**
 * Build a semantic rig descriptor from a parsed skin + node list.
 * @param {Object} asset parsed GLB asset
 * @param {Object} skin  parsed skin (joints as node indices)
 * @returns {Object} rig {hips,spine1,spine2,head,arms:[{up,fore,hand}],legs:[...],jointIndex:{}}
 */
function buildRig(asset, skin) {
  const rig = { ok: !!skin, map: {}, joints: skin ? skin.joints : [], skin };
  if (!skin) return rig;
  const PATTERNS = rigPatternsFor(asset, skin);
  rig.kind = PATTERNS === RIG_PATTERNS_KITSUNE ? 'kitsune' : 'atlas';
  const used = new Set();
  const nameOf = (nodeIdx) => (asset.nodes[nodeIdx] ? asset.nodes[nodeIdx].name : '');
  for (const slot in PATTERNS) {
    const pats = PATTERNS[slot];
    let found = -1;
    for (let j = 0; j < skin.joints.length; j++) {
      if (used.has(j)) continue;
      const nm = nameOf(skin.joints[j]).toLowerCase();
      for (const p of pats) {
        if (nm.indexOf(p) !== -1) { found = j; break; }
      }
      if (found >= 0) break;
    }
    if (found < 0) {
      // relaxed pass: token containment ignoring separators
      for (let j = 0; j < skin.joints.length && found < 0; j++) {
        if (used.has(j)) continue;
        const nm = nameOf(skin.joints[j]).toLowerCase().replace(/[_\s]/g, '');
        for (const p of pats) {
          if (nm.indexOf(p.replace(/_/g, '')) !== -1) { found = j; break; }
        }
      }
    }
    rig.map[slot] = found;
    if (found >= 0) used.add(found);
  }
  // SkinnedMech addresses slots via rig.bones — expose the same table under
  // both names so neither call site breaks.
  rig.bones = rig.map;
  // derive bind-space positions of each joint (model space) from IBM
  rig.bindPos = new Float32Array(skin.count * 3);
  const ibm = skin.ibm;
  const inv = MAT4_ID();
  for (let j = 0; j < skin.count; j++) {
    mat4.invert(inv, ibm.subarray(j * 16, j * 16 + 16));
    rig.bindPos[j * 3] = inv[12]; rig.bindPos[j * 3 + 1] = inv[13]; rig.bindPos[j * 3 + 2] = inv[14];
  }
  rig.parentOf = {};
  for (let j = 0; j < skin.joints.length; j++) rig.parentOf[skin.joints[j]] = j;
  return rig;
}

/** Small spring scalar used for recoil + camera shake recovery. */
class Spring {
  constructor(k, d) { this.k = k; this.d = d; this.x = 0; this.v = 0; }
  /** Add an instantaneous angular velocity impulse. */
  impulse(v) { this.v += v; }
  /** Integrate toward zero with semi-implicit Euler (stable at dt<=0.1). */
  step(dt) {
    const a = -this.k * this.x - this.d * this.v;
    this.v += a * dt;
    this.x += this.v * dt;
    if (Math.abs(this.x) < 1e-5 && Math.abs(this.v) < 1e-4) { this.x = 0; this.v = 0; }
    return this.x;
  }
}

/**
 * Heightmap sampling over the city mesh (raycast approximation).
 * Built once by rasterising world-space vertices into a coarse grid and
 * keeping the highest surface below the feet per cell.
 */
class HeightMap {
  constructor(minX, maxX, minZ, maxZ, cellsX, cellsZ) {
    this.minX = minX; this.maxX = maxX; this.minZ = minZ; this.maxZ = maxZ;
    this.cx = cellsX; this.cz = cellsZ;
    this.h = new Float32Array(cellsX * cellsZ).fill(-Infinity);
    this.dx = (maxX - minX) / cellsX; this.dz = (maxZ - minZ) / cellsZ;
  }
  add(x, y, z) {
    const i = ((x - this.minX) / this.dx) | 0, j = ((z - this.minZ) / this.dz) | 0;
    if (i < 0 || j < 0 || i >= this.cx || j >= this.cz) return;
    const k = j * this.cx + i;
    if (y > this.h[k]) this.h[k] = y;
  }
  /** Bilinear ground height at (x,z); falls back to default floor. */
  sample(x, z) {
    const fx = (x - this.minX) / this.dx - 0.5, fz = (z - this.minZ) / this.dz - 0.5;
    const i0 = clamp(Math.floor(fx), 0, this.cx - 1), j0 = clamp(Math.floor(fz), 0, this.cz - 1);
    const i1 = clamp(i0 + 1, 0, this.cx - 1), j1 = clamp(j0 + 1, 0, this.cz - 1);
    const tx = clamp(fx - i0, 0, 1), tz = clamp(fz - j0, 0, 1);
    const h00 = this.h[j0 * this.cx + i0], h10 = this.h[j0 * this.cx + i1];
    const h01 = this.h[j1 * this.cx + i0], h11 = this.h[j1 * this.cx + i1];
    const g = CONFIG.world.groundY;
    const a = lerp(isFinite(h00) ? h00 : g, isFinite(h10) ? h10 : g, tx);
    const b = lerp(isFinite(h01) ? h01 : g, isFinite(h11) ? h11 : g, tx);
    return lerp(a, b, tz);
  }
}

/**
 * ProceduralMech — drives one skinned (or rigid) mech instance.
 * Owns: root transform, locomotion state, sway/bob/recoil springs, IK targets,
 * and the final joint matrix array uploaded to the GPU.
 */
class ProceduralMech {
  /**
   * @param {Object} asset parsed GLB
   * @param {Object|null} skin parsed skin or null (rigid body fallback)
   * @param {Object} def visual/gameplay definition
   */
  constructor(asset, skin, def) {
    this.asset = asset; this.skin = skin; this.def = def;
    this.rig = skin ? buildRig(asset, skin) : { ok: false, map: {} };
    this.pos = V3(0, 0, 0);
    this.vel = V3(0, 0, 0);
    this.facing = 0;                 // yaw radians
    this.targetFacing = 0;
    this.groundY = 0;
    this.airborne = false;
    this.phase = rnd(Math.PI * 2);   // gait phase
    this.speedNorm = 0;
    this.recoilP = new Spring(CONFIG.mech.recoil.springK, CONFIG.mech.recoil.damping);
    this.recoilY = new Spring(CONFIG.mech.recoil.springK * 0.8, CONFIG.mech.recoil.damping);
    this.bodyKick = new Spring(48, 9);
    this.swayT = rnd(10);
    this.aimPitch = 0;
    this.aimYaw = 0;
    this.hitFlash = 0;
    this.dead = false;
    this.hp = 1; this.maxHp = 1;
    this.footGround = [V3(), V3()];  // smoothed foot contact heights
    this.stepEvents = [];            // consumed by audio (footfall triggers)
    this._lastStepSign = 1;
    // per-joint override rotations produced by the procedural layer
    const nj = skin ? skin.count : 1;
    this.jointRot = new Float32Array(nj * 4);   // quaternion offsets
    this.jointPos = new Float32Array(nj * 4);   // absolute local position overrides (vec4 slot)
    this.jointHasPos = new Uint8Array(nj);
    // computed matrices
    this.rootWorld = MAT4_ID();
    this.localAnim = [];
    for (let i = 0; i < asset.nodes.length; i++) this.localAnim.push(MAT4_ID());
    this.globalAnim = [];
    for (let i = 0; i < asset.nodes.length; i++) this.globalAnim.push(MAT4_ID());
    this.childSets = asset.nodes.map(n => n.children);
    this.parents = new Int32Array(asset.nodes.length).fill(-1);
    for (let i = 0; i < asset.nodes.length; i++)
      for (const c of asset.nodes[i].children) if (c < this.parents.length) this.parents[c] = i;
    this.isRoot = (() => {
      const has = new Set(); for (const n of asset.nodes) for (const c of n.children) has.add(c);
      const r = new Uint8Array(asset.nodes.length);
      for (let i = 0; i < r.length; i++) r[i] = has.has(i) ? 0 : 1;
      return r;
    })();
  }
  /** Register a firing impulse: pitch-up + random yaw + body kickback. */
  fireRecoil(strength = 1) {
    const C = CONFIG.mech.recoil;
    this.recoilP.impulse(C.pitchImpulse * 34 * strength);
    this.recoilY.impulse(rnd(-1, 1) * C.yawJitter * 30 * strength);
    this.bodyKick.impulse(-C.kickback * 22 * strength);
  }
  /**
   * Core update.
   * @param {number} dt seconds (already clamped)
   * @param {number} moveMag 0..1 desired locomotion intensity
   * @param {Object} ctl {moveX, moveZ, boost, jump, aimYaw, aimPitch}
   * @param {HeightMap|null} hm
   */
  update(dt, ctl, hm) {
    const M = CONFIG.mech;
    this.swayT += dt;
    /* ---- locomotion integration ---------------------------------------- */
    const wish = _s.v1;
    vec3.set(wish, ctl.moveX, 0, ctl.moveZ);
    const wishLen = vec3.len(wish);
    if (wishLen > 1e-4) vec3.scale(wish, wish, Math.min(1, wishLen) / wishLen);
    const boost = ctl.boost && (ctl.boostCharge === undefined || ctl.boostCharge > 0);
    const spd = M.walk.speed * (boost ? M.boost.mult : 1) * (this.airborne ? M.boost.airMult : 1);
    const target = _s.v2;
    vec3.scale(target, wish, wishLen > 0 ? spd : 0);
    const rate = wishLen > 0 ? M.walk.accel : M.walk.friction;
    const k = damp(rate, dt);
    vec3.madd(this.vel, this.vel, target, k);
    if (wishLen > 0) vec3.scale(this.vel, this.vel, 1 - k);
    // gravity + ground
    if (!this.airborne) this.vel[1] = 0;
    else this.vel[1] -= M.jump.gravity * dt;
    vec3.madd(this.pos, this.pos, this.vel, dt);
    const gy = hm ? hm.sample(this.pos[0], this.pos[2]) : CONFIG.world.groundY;
    this.groundY = gy;
    if (this.pos[1] <= gy) {
      if (this.airborne && this.vel[1] < -3) this.onLand(-this.vel[1]);
      this.pos[1] = gy; this.vel[1] = 0; this.airborne = false;
    } else if (this.pos[1] - gy > 0.02) this.airborne = true;
    if (ctl.jump && !this.airborne) { this.vel[1] = M.jump.impulse; this.airborne = true; }
    /* ---- facing --------------------------------------------------------- */
    this.aimYaw = ctl.aimYaw !== undefined ? ctl.aimYaw : this.aimYaw;
    this.aimPitch = ctl.aimPitch !== undefined ? ctl.aimPitch : this.aimPitch;
    let faceTarget = this.facing;
    if (wishLen > 0.05) {
      // move direction relative to camera yaw: model forward is +Z in bind space
      faceTarget = Math.atan2(ctl.moveX, ctl.moveZ) + (ctl.camYaw !== undefined ? ctl.camYaw : 0);
    }
    if (ctl.faceAim) faceTarget = this.aimYaw;
    let dAng = faceTarget - this.facing;
    while (dAng > Math.PI) dAng -= Math.PI * 2;
    while (dAng < -Math.PI) dAng += Math.PI * 2;
    this.facing += dAng * damp(M.walk.turnSmooth, dt);
    /* ---- gait phase + bobbing ------------------------------------------ */
    const speed = Math.hypot(this.vel[0], this.vel[2]);
    this.speedNorm = clamp(speed / M.walk.speed, 0, 2.2);
    const strideFreq = Math.max(M.stride.minFreq, speed / M.stride.length * Math.PI);
    this.phase += strideFreq * dt * (this.airborne ? 0.25 : 1);
    const bobRaw = easeInOutCubic((Math.sin(this.phase) + 1) * 0.5) * 2 - 1;
    const bob = bobRaw * M.bob.amp * Math.min(1, this.speedNorm) * (this.airborne ? 0 : 1);
    // footfall events (audio): detect sign change of sin(phase)
    const sgn = Math.sin(this.phase) >= 0 ? 1 : -1;
    if (sgn !== this._lastStepSign && !this.airborne && this.speedNorm > 0.25) {
      this.stepEvents.push(this.pos[0], this.pos[1], this.pos[2]);
    }
    this._lastStepSign = sgn;
    /* ---- springs -------------------------------------------------------- */
    const recP = clamp(this.recoilP.step(dt), -M.recoil.maxAngle, M.recoil.maxAngle);
    const recY = clamp(this.recoilY.step(dt), -M.recoil.maxAngle, M.recoil.maxAngle);
    const kick = this.bodyKick.step(dt);
    /* ---- torso sway ----------------------------------------------------- */
    const sw = M.sway;
    const swayAmt = (0.35 + this.speedNorm * sw.velGain);
    const roll = Math.sin(this.swayT * sw.freq) * sw.ampRoll * swayAmt
               + Math.cos(this.phase * 0.5) * sw.ampRoll * 0.5 * Math.min(1, this.speedNorm);
    const pitch = Math.sin(this.swayT * sw.freq * 0.73 + 1.1) * sw.ampPitch * swayAmt;
    /* ---- write joint overrides ----------------------------------------- */
    // aim deltas are RELATIVE to the body facing: only the residual between
    // where the camera looks and where the chassis points drives arms/head.
    let aimYawOff = this.aimYaw - this.facing;
    while (aimYawOff > Math.PI) aimYawOff -= Math.PI * 2;
    while (aimYawOff < -Math.PI) aimYawOff += Math.PI * 2;
    this.applyPose({ bob, kick, roll, pitch, recP, recY, speed: this.speedNorm, dt, hm,
                     aimPitch: this.aimPitch, aimYawOffset: clamp(aimYawOff, -1.4, 1.4) });
    if (this.hitFlash > 0) this.hitFlash = Math.max(0, this.hitFlash - dt * 6);
  }
  /** Landing squash: extra spring energy proportional to impact speed. */
  onLand(impact) {
    this.bodyKick.impulse(-clamp(impact, 0, 14) * 2.4);
    this.recoilP.impulse(clamp(impact, 0, 14) * 1.2);
  }
  /**
   * Compose all procedural layers into per-joint quaternion offsets and run
   * the skeleton evaluation (forward kinematics + simple analytic leg IK).
   */
  applyPose(P) {
    const rig = this.rig, M = CONFIG.mech;
    // reset offsets
    const jr = this.jointRot, jp = this.jointPos, jhp = this.jointHasPos;
    for (let i = 0; i < jr.length; i += 4) quat.ident(jr, jr.subarray(i, i + 4)), jp[i] = 0;
    for (let i = 0; i < jhp.length; i++) jhp[i] = 0;
    const off = (slot) => rig.map[slot];
    const setQ = (slot, q) => {
      const j = off(slot); if (j < 0) return;
      quat.copy(jr.subarray(j * 4, j * 4 + 4), q);
    };
    const addQ = (slot, x, y, z, w) => {
      const j = off(slot); if (j < 0) return;
      quat.mul(_s.q3, jr.subarray(j * 4, j * 4 + 4), quat.set(_s.q2, x, y, z, w));
      quat.copy(jr.subarray(j * 4, j * 4 + 4), _s.q3);
    };
    const eulerTo = (out, rx, ry, rz) => quat.fromEulerXYZ(out, rx, ry, rz);
    /* root (hips): bob + kickback along local Z + slight lean into movement */
    const hj = off('hips');
    if (hj >= 0) {
      jhp[hj] = 1;
      jp[hj * 3] = 0; jp[hj * 3 + 1] = P.bob + P.kick * 0.12; jp[hj * 3 + 2] = P.kick * 0.5;
      eulerTo(_s.q1, P.pitch * 0.5 + P.recP * 0.35, P.roll * 0.35 + P.recY * 0.35, P.roll * 0.25);
      quat.copy(jr.subarray(hj * 4, hj * 4 + 4), _s.q1);
    }
    /* spine chain: sway split across spine1/spine2, recoil mostly upper body */
    eulerTo(_s.q1, P.pitch * 0.4 + P.recP * 0.45, P.recY * 0.5 + P.roll * 0.2, P.roll * 0.55);
    setQ('spine1', _s.q1);
    eulerTo(_s.q1, P.pitch * 0.35 + P.recP * 0.55, P.recY * 0.4, P.roll * 0.45);
    setQ('spine2', _s.q1);
    /* head counter-stabilise (looks slightly opposite to sway) + aim pitch */
    eulerTo(_s.q1, -P.pitch * 0.5 - P.recP * 0.25 + P.aimPitch * 0.35, -P.recY * 0.3 - P.aimYawOffset * 0.3, 0);
    setQ('head', _s.q1);
    /* arms: right arm tracks aim (weapon arm), left arm counter-balances */
    const swing = Math.sin(this.phase) * 0.30 * Math.min(1, P.speed);
    const swing2 = Math.sin(this.phase + Math.PI) * 0.30 * Math.min(1, P.speed);
    eulerTo(_s.q1, -(0.10 + P.aimPitch * 0.55) - P.recP * 0.6, P.aimYawOffset * 0.55, 0.06);
    setQ('upperR', _s.q1);
    eulerTo(_s.q1, -(0.18 + P.aimPitch * 0.35) - P.recP * 0.4, P.aimYawOffset * 0.25, 0.10);
    setQ('foreR', _s.q1);
    eulerTo(_s.q1, swing * 0.8 + P.pitch * 0.3, -P.aimYawOffset * 0.2, -0.10);
    setQ('upperL', _s.q1);
    eulerTo(_s.q1, swing * 0.5 - 0.12, 0, -0.14);
    setQ('foreL', _s.q1);
    /* legs: analytic 2-bone IK-ish using gait phase + foot grounding */
    const lift = M.ik.toeLift;
    const gp = P.hm ? P.hm : null;
    for (let side = 0; side < 2; side++) {
      const ph = this.phase + (side === 0 ? 0 : Math.PI);
      const sinp = Math.sin(ph), cosp = Math.cos(ph);
      const moving = Math.min(1, P.speed);
      const swingLeg = Math.max(0, sinp) * moving;
      const thighSlot = side === 0 ? 'thighL' : 'thighR';
      const kneeSlot = side === 0 ? 'kneeL' : 'kneeR';
      const ankleSlot = side === 0 ? 'ankleL' : 'ankleR';
      // hip drop / stance lift
      const stance = Math.max(0, -sinp) * moving;
      eulerTo(_s.q1, (-swingLeg * 0.55 + stance * 0.18) * 1.0, cosp * 0.06 * moving, (side ? -1 : 1) * (0.04 + P.roll * 0.3));
      setQ(thighSlot, _s.q1);
      eulerTo(_s.q1, (swingLeg * 0.95 + 0.12 * moving) * -1, 0, 0);
      setQ(kneeSlot, _s.q1);
      eulerTo(_s.q1, swingLeg * 0.45 - stance * 0.25 + lift * 0.4, 0, 0);
      setQ(ankleSlot, _s.q1);
      // foot grounding: sample terrain under each foot and bias ankle pitch
      if (gp) {
        const fx = this.pos[0] + (side ? -0.45 : 0.45) * Math.cos(this.facing) + 0.35 * Math.sin(this.facing);
        const fz = this.pos[2] + (side ? -0.45 : 0.45) * Math.sin(this.facing) - 0.35 * Math.cos(this.facing);
        const gh = gp.sample(fx, fz);
        const slope = clamp((gh - this.groundY) * 1.4, -0.35, 0.35);
        this.footGround[side][0] = lerp(this.footGround[side][0], gh, damp(M.ik.groundSmooth, P.dt));
        addQ(ankleSlot, 0, Math.sin(-slope * 0.5), 0, Math.cos(-slope * 0.5));
        addQ(thighSlot, Math.sin(-slope * 0.25), 0, 0, Math.cos(-slope * 0.25));
      }
    }
    /* ---- FK evaluation -------------------------------------------------- */
    this.evaluateSkeleton(P);
  }
  /** Rebuild animated global matrices + skin joint matrices. */
  evaluateSkeleton(P) {
    const nodes = this.asset.nodes, na = this.localAnim, ga = this.globalAnim;
    const rootScale = this.def.scale || 1;
    // root transform: position, facing yaw, uniform scale
    quat.fromAxisAngle(_s.q1, 0, 1, 0, this.facing);
    vec3.set(_s.v3, rootScale, rootScale, rootScale);
    mat4.compose(this.rootWorld, this.pos, _s.q1, _s.v3);
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (this.isRoot[i]) {
        mat4.mul(na[i], this.rootWorld, n.local);
      } else {
        const p = this.parents[i];
        mat4.mul(na[i], ga[p], n.local);
      }
      // apply procedural offset (rotation about joint origin + optional pos)
      const m = this.skinJointIndex(i);
      if (m >= 0) {
        const jr = this.jointRot, jhp = this.jointHasPos, jp = this.jointPos;
        if (jhp[m]) {
          vec3.set(_s.v4, jp[m * 3], jp[m * 3 + 1], jp[m * 3 + 2]);
          mat4.translate(na[i], na[i], _s.v4);
        }
        if (jr[m * 4] || jr[m * 4 + 1] || jr[m * 4 + 2] || jr[m * 4 + 3] !== 1) {
          mat4.compose(_s.mTmp, _s.v5.set ? (vec3.set(_s.v5, 0, 0, 0), _s.v5) : _s.v5, jr.subarray(m * 4, m * 4 + 4), _s.v3.set ? (vec3.set(_s.v3, 1, 1, 1), _s.v3) : _s.v3);
          mat4.mul(na[i], na[i], _s.mTmp);
        }
      }
      mat4.copy(ga[i], na[i]);
    }
    // skin matrices: globalAnimated * inverseBindMatrix
    if (this.skin) {
      const s = this.skin;
      for (let j = 0; j < s.count; j++) {
        const nodeIdx = s.joints[j];
        mat4.mul(s.jointMat.subarray(j * 16, j * 16 + 16),
          ga[nodeIdx], s.ibm.subarray(j * 16, j * 16 + 16));
      }
    }
    // normal matrix for root (uniform scale -> rotation only)
    mat4.copy(_s.m2, this.rootWorld);
    mat4.toQuat(_s.q2, this.rootWorld);
    mat4.compose(_s.m2, _s.v1.set ? (vec3.set(_s.v1, 0, 0, 0), _s.v1) : _s.v1, _s.q2, vec3.set(_s.v3, rootScale, rootScale, rootScale));
    this.normalMat = this.normalMat || new Float32Array(9);
    const m = _s.m2;
    this.normalMat[0] = m[0]; this.normalMat[1] = m[1]; this.normalMat[2] = m[2];
    this.normalMat[3] = m[4]; this.normalMat[4] = m[5]; this.normalMat[5] = m[6];
    this.normalMat[6] = m[8]; this.normalMat[7] = m[9]; this.normalMat[8] = m[10];
  }
  skinJointIndex(nodeIdx) {
    if (!this.rig.ok) return -1;
    if (this._jointLookup === undefined || this._jointLookupAsset !== this.asset) {
      this._jointLookupAsset = this.asset;
      this._jointLookup = new Int32Array(this.asset.nodes.length).fill(-1);
      for (let j = 0; j < this.skin.joints.length; j++) this._jointLookup[this.skin.joints[j]] = j;
    }
    return this._jointLookup[nodeIdx];
  }
  /** Approximate muzzle position in world space (right-hand weapon bone). */
  muzzleWorld(out) {
    const rig = this.rig;
    let node = rig.map.foreR >= 0 ? this.skin.joints[rig.map.foreR]
             : rig.map.upperR >= 0 ? this.skin.joints[rig.map.upperR]
             : rig.map.spine2 >= 0 ? this.skin.joints[rig.map.spine2] : -1;
    if (node < 0) node = 0;
    const g = this.globalAnim[node] || this.rootWorld;
    out[0] = g[12] + g[8] * 0.9; out[1] = g[13] + g[9] * 0.9 + 0.2; out[2] = g[14] + g[10] * 0.9;
    return out;
  }
  /** Eye/torso anchor for cameras & targeting. */
  chestWorld(out) {
    const rig = this.rig;
    let node = rig.map.spine2 >= 0 ? this.skin.joints[rig.map.spine2]
             : rig.map.hips >= 0 ? this.skin.joints[rig.map.hips] : -1;
    if (node < 0) { out[0] = this.pos[0]; out[1] = this.pos[1] + 2; out[2] = this.pos[2]; return out; }
    const g = this.globalAnim[node];
    out[0] = g[12]; out[1] = g[13]; out[2] = g[14];
    return out;
  }
}
/* ==========================================================================
 * === PROCEDURAL FALLBACK GEOMETRY =========================================
 * If a GLB cannot be parsed we still draw something: a labelled coloured box
 * built entirely in code (never white-screens the app).
 * ==========================================================================*/
/** Build a unit cube primitive (pos/norm/uv/idx) directly on the GPU. */
function makeBoxPrim(gl, color, emissive) {
  const p = {
    mesh: -1, prim: -1, mat: { base: color, metallic: 0.4, roughness: 0.6, emissive: emissive || [0, 0, 0],
      baseTex: -1, name: 'procedural-box', doubleSided: false },
    count: 24, indexed: true, skinned: false, vbo: {}, gpu: {},
    bboxMin: [-0.5, -0.5, -0.5], bboxMax: [0.5, 0.5, 0.5], name: 'box'
  };
  const pos = [], nor = [], uv = [];
  const faces = [
    [[0, 0, 1], [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]]],
    [[0, 0, -1], [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]]],
    [[0, 1, 0], [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]]],
    [[0, -1, 0], [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]]],
    [[1, 0, 0], [[0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]]],
    [[-1, 0, 0], [[-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5]]]
  ];
  const idx = [];
  for (let f = 0; f < 6; f++) {
    const nrm = faces[f][0], vs = faces[f][1];
    for (const v of vs) { pos.push(v[0], v[1], v[2]); nor.push(nrm[0], nrm[1], nrm[2]); }
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    const b = f * 4; idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const mkBuf = (arr, type) => {
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW); return b;
  };
  p.gpu.POSITION = mkBuf(new Float32Array(pos));
  p.gpu.NORMAL = mkBuf(new Float32Array(nor));
  p.gpu.TEXCOORD_0 = mkBuf(new Float32Array(uv));
  p.ibo = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, p.ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
  p.iboCount = idx.length; p.iboType = gl.UNSIGNED_SHORT;
  return p;
}

/** A glowing tracer bolt mesh (elongated octahedron-ish spindle). */
function makeBoltPrim(gl) {
  const L = 1.0, R = 0.09;
  const v = [
    0, 0, 0.5 * L, 0, 0, -0.5 * L,                       // tips
    R, 0, 0, -R, 0, 0, 0, R, 0, 0, -R, 0                 // ring
  ];
  const idx = [2, 0, 4, 4, 0, 3, 3, 0, 5, 5, 0, 2, 2, 1, 3, 3, 1, 5, 5, 1, 4, 4, 1, 2];
  const pos = [], nor = [];
  // flat normals per triangle
  for (let i = 0; i < idx.length; i += 3) {
    const a = [v[idx[i] * 3], v[idx[i] * 3 + 1], v[idx[i] * 3 + 2]];
    const b = [v[idx[i + 1] * 3], v[idx[i + 1] * 3 + 1], v[idx[i + 1] * 3 + 2]];
    const c = [v[idx[i + 2] * 3], v[idx[i + 2] * 3 + 1], v[idx[i + 2] * 3 + 2]];
    const e1 = vec3.sub(V3(), b, a), e2 = vec3.sub(V3(), c, a), nn = vec3.norm(V3(), vec3.cross(V3(), e1, e2));
    for (const q of [a, b, c]) { pos.push(q[0], q[1], q[2]); nor.push(nn[0], nn[1], nn[2]); }
  }
  const n = pos.length / 3;
  const uv = new Float32Array(n * 2);
  const prim = {
    mesh: -1, prim: -1, count: n, indexed: false, skinned: false, vbo: {}, gpu: {},
    mat: { base: [1, 1, 1], metallic: 0, roughness: 0.4, emissive: [1, 1, 1], baseTex: -1, name: 'bolt' },
    bboxMin: [-R, -R, -L / 2], bboxMax: [R, R, L / 2], name: 'bolt'
  };
  const mkBuf = (arr) => {
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW); return b;
  };
  prim.gpu.POSITION = mkBuf(new Float32Array(pos));
  prim.gpu.NORMAL = mkBuf(new Float32Array(nor));
  prim.gpu.TEXCOORD_0 = mkBuf(uv);
  return prim;
}


export { HeightMap, Spring, buildRig, makeBoltPrim, makeBoxPrim };
