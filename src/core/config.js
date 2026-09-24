/* AUTO-MOVED from the original single-file index.html — do not hand-edit
 * section contents without checking against git history. */
'use strict';

/* ==========================================================================
 * === CONFIG ===============================================================
 * Every tunable of the procedural animation + gameplay lives here.
 * ==========================================================================*/
const CONFIG = {
  urls: {
    city:   'https://raw.githubusercontent.com/DF46-afk/RobotsGame/refs/heads/main/city.glb',
    hangar: 'https://raw.githubusercontent.com/DF46-afk/RobotsGame/refs/heads/main/atlas_hangar_ld.glb',
    mechA:  'https://raw.githubusercontent.com/DF46-afk/RobotsGame/refs/heads/main/kid_war_robots.glb',
    mechB:  'https://raw.githubusercontent.com/DF46-afk/RobotsGame/refs/heads/main/kitsune_harpy_rig.glb'
  },
  world: {
    up: [0, 1, 0],
    scale: 0.1,               // GLB authoring units -> metres (atlas mech is ~28u tall)
    groundY: 0,               // default floor when heightmap has no sample
    cityMin: [-0.6, -0.2, -19.0],   // measured city.glb world bbox (scaled by `scale`)
    cityMax: [15.2, 2.2, 6.3],
    bounds: [-1.5, 14.5, -17.5, 4.8], // scaled playfield walls inside the city block
    fogColor: [0.045, 0.075, 0.115],
    fogDensity: 0.016,
    sunDir: [0.42, 0.72, 0.55],
    sunColor: [1.0, 0.93, 0.82],
    skyColor: [0.22, 0.36, 0.55],
    groundColor: [0.30, 0.33, 0.37]
  },
  shadow: { size: 1024, range: 34, bias: 0.0022, normalBias: 0.035 },
  bloom: { threshold: 1.05, knee: 0.55, intensity: 0.72, radius: 1.0, samples: 9 },
  render: { maxAniso: 4, exposure: 1.18, skinJoints: 64, pixelCap: 2.35e6 },
  mech: {
    /* --- procedural torso sway (quaternion offset on spine/root bone) --- */
    sway:   { freq: 1.55, ampRoll: 0.052, ampPitch: 0.030, velGain: 0.055, idleMul: 0.42 },
    /* --- step bobbing: easeInOutCubic Y offset tied to move speed ------ */
    bob:    { freq: 2.55, amp: 0.085, easePow: 3 },
    /* --- firing recoil: angular impulse + critically damped spring ------ */
    recoil: { pitchImpulse: 0.115, yawJitter: 0.035, kickback: 0.16,
              springK: 62, damping: 11.5, maxAngle: 0.30 },
    /* --- foot grounding / leg IK --------------------------------------- */
    ik:     { hipDrop: 0.055, toeLift: 0.10, groundSmooth: 12, kneeBias: 0.35 },
    /* --- locomotion ----------------------------------------------------- */
    walk:   { speed: 5.6, strafe: 0.78, accel: 14, friction: 11, turnSmooth: 10 },
    boost:  { mult: 2.05, drain: 30, regen: 16, airMult: 1.35 },
    jump:   { impulse: 7.4, gravity: 17.5, coyote: 0.12 },
    stride: { length: 1.55, minFreq: 0.55 }
  },
  combat: {
    fireRate: 5.2,            // rounds per second
    magSize: 18, reloadTime: 1.9,
    bulletSpeed: 62, bulletLife: 2.2, bulletRadius: 0.28,
    damage: 12, headshotMul: 1.0, spreadDeg: 0.9, aimSpreadDeg: 0.15,
    recoilCamera: 0.55, shake: 0.28,
    lockRange: 78, lockAngleDeg: 22, lockSlip: 6.5
  },
  enemy: {
    baseCount: 4, perWave: 2, maxAlive: 9, hp: 46, hpPerWave: 11,
    speed: 3.1, speedPerWave: 0.22, fireRate: 0.85, dmg: 6, burst: 3,
    engageRange: 46, strafePeriod: 4.2, hitFlash: 0.14, score: 100,
    height: 1.75, radius: 0.85          // drone capsule (metres)
  },
  player: { hp: 100, radius: 1.6, eyeHeight: 2.4, thirdPerson: 7.2 },
  audio: { master: 0.8, sfx: 0.9, music: 0.45 },
  perf: { maxDrawCalls: 200, dtCap: 0.1 }
};


export { CONFIG };
