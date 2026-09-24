/* AUTO-MOVED from the original single-file index.html — do not hand-edit
 * section contents without checking against git history. */
'use strict';

import { CONFIG } from '../core/config.js';
import { MAT4_ID, V3, mat4, quat, vec3 } from '../core/math.js';
import { $, DEG, clamp, damp, easeInOutCubic, lerp, logLine, rnd, rndi, showFatal } from '../core/util.js';
import { audio } from '../core/audio.js';
import { Renderer } from '../render/renderer.js';
import { computeNodeWorlds, parseGLB, prepSkin } from '../world/glb.js';
import { Particles, batchAsset, fetchGLB, makeDroneAsset, makeGlowQuads } from '../world/assets.js';
import { HeightMap, makeBoltPrim, makeBoxPrim } from '../anim/procedural.js';
import { PropMech, SkinnedMech, clusterRobot } from '../entities/mechs.js';
import { rayAABB, resolveCircleAABB } from '../world/collision.js';
import { renderer } from './state.js';

/* ==========================================================================
 * === GAME STATE MACHINE ===================================================
 * LOADING -> MENU -> HANGAR -> GAMEPLAY (+ PAUSE / END overlays).
 * Owns asset preparation, input, camera, combat simulation and the frame loop.
 * ==========================================================================*/
const MECH_DEFS = [
  { key: 'atlas',   name: 'ATLAS-7',   role: 'HEAVY ASSAULT', file: 'atlas_hangar_ld.glb',
    scale: 0.1, tint: [1, 1, 1], accent: [0.25, 0.9, 1], hpMul: 1.3, spdMul: 0.88, dmgMul: 1.25,
    desc: 'Centimetre-authored heavy chassis. Slow, armoured, hits like a freight train.' },
  { key: 'kitsune', name: 'KITSUNE',   role: 'AGILE RECON',   file: 'kitsune_harpy_rig.glb',
    scale: 0.16, tint: [1, 1, 1], accent: [1, 0.55, 0.2], hpMul: 0.8, spdMul: 1.25, dmgMul: 0.85,
    desc: 'Feathered harpy rig. Wings beat as it runs — fast, fragile, lethal at range.' },
  { key: 'warbot',  name: 'WAR-BOT',   role: 'STANDARD LINE', file: 'kid_war_robots.glb',
    scale: 0.42, tint: [1, 1, 1], accent: [0.6, 1, 0.7], hpMul: 1.0, spdMul: 1.0, dmgMul: 1.0,
    desc: 'Rigid-mesh battlefield robot (no skeleton): bob + yaw are baked on the root.' }
];
const NM_ID = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
function _sunScaled() { return CONFIG.world.sunColor; }

class Game {
  constructor() {
    this.state = 'LOADING';
    this.assets = {};                 // key -> parsed asset
    this.cityBatches = [];            // static merged city geometry
    this.robotClusters = [];          // kid_war_robots per-robot batches
    this.playerMech = null;           // SkinnedMech | PropMech
    this.hangarMech = null;
    this.playerDef = MECH_DEFS[0];
    this.enemies = [];
    this.bolts = [];                  // {p:[x,y,z] typed, v:[..], life, team, dmg}
    this.particles = new Particles(900);
    this.glow = null;                 // glow quad pool for particles
    this.boxPrim = null;              // fallback cube prim
    this.boltPrim = null;             // tracer spindle prim
    this.droneAsset = null;           // procedural drone batch
    this.heightMap = null;
    this.colliders = [];              // building AABBs (metres)
    this.time = 0; this.last = performance.now();
    this.fpsAcc = 0; this.fpsN = 0; this.fps = 60;
    /* --- player state --- */
    this.hp = CONFIG.player.hp; this.boost = 100;
    this.ammo = CONFIG.combat.magSize; this.heat = 0;
    this.reloadT = 0; this.fireCd = 0;
    this.score = 0; this.kills = 0; this.wave = 0;
    this.waveTimer = 3; this.spawnLeft = 0; this.intermission = false;
    this.yaw = 0; this.pitch = 0; this.camDist = CONFIG.player.thirdPerson;
    this.lockTarget = null; this.lockOn = false;
    this.shake = 0; this.dmgFx = 0;
    /* --- input --- */
    this.keys = {}; this.mouseDown = 0; this.pointerLocked = false;
    this.hangarYaw = 0; this.hangarPitch = 0.18; this.hangarZoom = 1;
    this._hudT = 0;
  }
  /* ============================ BOOT ==================================== */
  async boot() {
    const canvas = $('gl');
    try {
      this.r = new Renderer(canvas);
      renderer.current = this.r;
    } catch (e) {
      showFatal('WebGL2 context creation failed: ' + e.message);
      window.__BOOT_DONE = true;
      return;
    }
    logLine('webgl2 ok · renderer "' + (renderer.current.gl.getParameter(renderer.current.gl.RENDERER) || '?') + '"');
    // the frame loop must run from the very first moment so the loading bar /
    // overlay transitions keep animating while assets stream in
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
    this.boxPrim = makeBoxPrim(renderer.current.gl, [0.4, 0.6, 0.8]);
    this.boltPrim = makeBoltPrim(renderer.current.gl);
    this.droneAsset = makeDroneAsset(renderer.current.gl);
    this.glow = makeGlowQuads(renderer.current.gl);
    this.bindUI();
    await this.loadAssets();
    this.prepWorld();
    window.__BOOT_DONE = true;
    this.setOverlay('menu');
    logLine('boot complete — entering MENU');
  }

  setBar(frac, txt) {
    $('bar').style.width = Math.round(clamp(frac, 0, 1) * 100) + '%';
    if (txt) $('loadText').textContent = txt;
  }

  async loadAssets() {
    const U = CONFIG.urls;
    const jobs = [
      ['city',   'city.glb',                U.city],
      ['atlas',  'atlas_hangar_ld.glb',     U.hangar],
      ['kitsune','kitsune_harpy_rig.glb',   U.mechB],
      ['warbot', 'kid_war_robots.glb',      U.mechA]
    ];
    let done = 0;
    for (const [key, file, url] of jobs) {
      this.setBar(done / jobs.length * 0.8, 'fetching ' + file + ' …');
      const buf = await fetchGLB(file, url);
      if (buf) {
        try {
          const keepCpu = (key === 'city' || key === 'warbot');
          const asset = await parseGLB(renderer.current.gl, buf, key, { keepCpu });
          if (asset.ok) { this.assets[key] = asset; logLine(key + ': parsed (' + asset.prims.length + ' prims, ' + asset.nodes.length + ' nodes)'); }
          else logLine(key + ': nothing drawable — fallback box will be used', true);
        } catch (e) {
          logLine(key + ': parse failed — ' + e.message, true);
        }
      }
      done++;
    }
    this.setBar(0.9, 'preparing world …');
    // resolve embedded textures eagerly (lazy promise chain inside parser)
    for (const a of Object.values(this.assets)) {
      const texIds = new Set();
      for (const p of a.prims) if (p.mat && p.mat.baseTex >= 0) texIds.add(p.mat.baseTex);
      for (const id of texIds) {
        try {
          const tx = await a.texFor(id);
          if (tx) for (const p of a.prims) if (p.mat && p.mat.baseTex === id) p._tex = tx;
        } catch (e) { /* non fatal */ }
      }
    }
    this.setBar(1, 'ready');
  }

  /** Build heightmap + colliders from the city, prep skins & robot clusters. */
  prepWorld() {
    const gl = renderer.current.gl;
    const city = this.assets.city;
    if (city) {
      computeNodeWorlds(city, false);
      this.cityBatches = batchAsset(gl, city);
      logLine('city batched into ' + this.cityBatches.length + ' draw groups');
      // heightmap + collider AABBs from world-space vertex data
      const hm = this.heightMap = new HeightMap(-40, 60, -60, 40, 160, 160);
      const seen = new Set();
      for (const nd of city.nodes) {
        if (nd.mesh < 0 || seen.has(nd.mesh)) continue;
        seen.add(nd.mesh);
        for (const pr of city.prims) {
          if (pr.mesh !== nd.mesh || !pr.cpu || !pr.cpu.POSITION) continue;
          const P = pr.cpu.POSITION, m = nd.world;
          const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
          for (let i = 0; i < P.length; i += 3) {
            const x = P[i], y = P[i + 1], z = P[i + 2];
            const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
            const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
            const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
            if (wx < mn[0]) mn[0] = wx; if (wx > mx[0]) mx[0] = wx;
            if (wy < mn[1]) mn[1] = wy; if (wy > mx[1]) mx[1] = wy;
            if (wz < mn[2]) mn[2] = wz; if (wz > mx[2]) mx[2] = wz;
            hm.add(wx, wy, wz);
          }
          const h = mx[1] - mn[1];
          const fx = mx[0] - mn[0], fz = mx[2] - mn[2];
          if (h > 2.2 && fx > 0.8 && fz > 0.8 && fx < 40 && fz < 40)
            this.colliders.push({ min: mn.slice(), max: mx.slice() });
        }
      }
      logLine('heightmap built · ' + this.colliders.length + ' building colliders');
      // planar lightmap grid over the playfield
      const B = CONFIG.world.bounds;
      const cellsX = 96, cellsZ = 96;
      const gx = [], gz = [], gyy = [];
      seen.clear();
      for (const nd of city.nodes) {
        if (nd.mesh < 0 || seen.has(nd.mesh)) continue;
        seen.add(nd.mesh);
        for (const pr of city.prims) {
          if (pr.mesh !== nd.mesh || !pr.cpu || !pr.cpu.POSITION) continue;
          const P = pr.cpu.POSITION, m = nd.world;
          for (let i = 0; i < P.length; i += 3) {
            const x = P[i], y = P[i + 1], z = P[i + 2];
            const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
            if (wy < 2.5) {
              gx.push(m[0] * x + m[4] * y + m[8] * z + m[12]);
              gz.push(m[2] * x + m[6] * y + m[10] * z + m[14]);
              gyy.push(wy);
            }
          }
        }
      }
      const gm = { minX: B[0], minZ: B[2], dx: (B[1] - B[0]) / cellsX, dz: (B[3] - B[2]) / cellsZ,
                   nx: Float32Array.from(gx), nz: Float32Array.from(gz), gy: Float32Array.from(gyy) };
      const sun = CONFIG.world.sunDir;
      const sl = Math.hypot(sun[0], sun[2]) || 1;
      renderer.current.computeLightmap(gm, cellsX, cellsZ, [sun[0] / sl, sun[2] / sl], 0.9);
      renderer.current.lmRect = [gm.minX, gm.minZ, gm.dx * cellsX, gm.dz * cellsZ];
      renderer.current.updateLightmap();
      logLine('lightmap baked (' + cellsX + '×' + cellsZ + ')');
    } else {
      this.heightMap = new HeightMap(-40, 60, -60, 40, 8, 8);   // all default floor
    }
    // skinned mechs: prepare joint textures
    for (const key of ['atlas', 'kitsune']) {
      const a = this.assets[key];
      if (a && a.skins.length) { try { prepSkin(renderer.current, a, a.skins[0]); } catch (e) { logLine('prepSkin ' + key + ': ' + e.message, true); } }
    }
    // warbot clusters -> one static batch per robot template
    const wb = this.assets.warbot;
    if (wb) {
      computeNodeWorlds(wb, false);
      const clusters = clusterRobot(wb);
      for (const cl of clusters.slice(0, 6)) {
        try { this.robotClusters.push(batchCluster(gl, wb, cl)); }
        catch (e) { logLine('cluster bake: ' + e.message, true); }
      }
      logLine('warbot split into ' + this.robotClusters.length + ' robot templates');
    }
  }

  /* ============================ UI / INPUT ============================== */
  bindUI() {
    $('btnDeploy').onclick = () => { audio.init(); audio.uiTick(); this.startMission(); };
    $('btnHangar').onclick = () => { audio.init(); audio.uiTick(); this.enterHangar(); };
    $('btnHangarBack').onclick = () => { audio.uiTick(); this.state = 'MENU'; this.setOverlay('menu'); };
    $('btnResume').onclick = () => { audio.uiTick(); this.setPaused(false); };
    $('btnQuit').onclick = () => { audio.uiTick(); this.abortMission(); };
    $('btnRetry').onclick = () => { audio.uiTick(); this.startMission(); };
    $('btnMenu').onclick = () => { audio.uiTick(); this.state = 'MENU'; this.setOverlay('menu'); };
    addEventListener('resize', () => this.r.resize());
    addEventListener('keydown', (e) => {
      this.keys[e.code] = true;
      if (e.code === 'Escape' && this.state === 'GAMEPLAY') this.setPaused(true);
      if (e.code === 'KeyR' && this.state === 'GAMEPLAY') this.startReload();
    });
    addEventListener('keyup', (e) => { this.keys[e.code] = false; });
    const cv = $('gl');
    cv.addEventListener('mousedown', (e) => {
      if (this.state === 'HANGAR') { this._drag = { x: e.clientX, y: e.clientY }; return; }
      if (this.state !== 'GAMEPLAY') return;
      if (!this.pointerLocked) { cv.requestPointerLock && cv.requestPointerLock(); return; }
      if (e.button === 0) this.mouseDown |= 1;
      if (e.button === 2) this.toggleLock();
    });
    addEventListener('mouseup', (e) => { if (e.button === 0) this.mouseDown &= ~1; });
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === cv;
      if (!this.pointerLocked && this.state === 'GAMEPLAY') this.setPaused(true);
    });
    addEventListener('mousemove', (e) => {
      if (this._drag) {
        this.hangarYaw += (e.clientX - this._drag.x) * 0.008;
        this.hangarPitch = clamp(this.hangarPitch + (e.clientY - this._drag.y) * 0.005, -0.4, 1.1);
        this._drag = { x: e.clientX, y: e.clientY };
        return;
      }
      if (this.state !== 'GAMEPLAY' || !this.pointerLocked) return;
      this.yaw -= e.movementX * 0.0024;
      this.pitch = clamp(this.pitch - e.movementY * 0.0022, -1.25, 1.25);
    });
    addEventListener('wheel', (e) => {
      if (this.state === 'HANGAR') this.hangarZoom = clamp(this.hangarZoom * (1 + e.deltaY * 0.001), 0.4, 2.5);
      else if (this.state === 'GAMEPLAY') this.camDist = clamp(this.camDist + e.deltaY * 0.008, 3.5, 14);
    }, { passive: true });
  }

  setOverlay(name) {
    for (const id of ['loading', 'menu', 'hangar', 'pause', 'end']) $(id).classList.add('hidden');
    if (name) $(name).classList.remove('hidden');
    $('hud').classList.toggle('on', name === null && this.state === 'GAMEPLAY');
  }

  enterHangar() {
    this.state = 'HANGAR';
    this.setOverlay('hangar');
    const cards = $('cards'); cards.innerHTML = '';
    MECH_DEFS.forEach((d) => {
      const el = document.createElement('div');
      el.className = 'card' + (d.key === this.playerDef.key ? ' sel' : '');
      const bar = (lbl, v) => '<div class="stat"><i>' + lbl + '</i><em style="--v:' + Math.round(v * 100) + '%"></em></div>';
      el.innerHTML = '<h3>' + d.name + '</h3><div class="role">' + d.role + '</div>' +
        bar('ARMOR', d.hpMul / 1.3) + bar('SPEED', d.spdMul / 1.25) + bar('FIREPOWER', d.dmgMul / 1.25) +
        '<div class="desc">' + d.desc + '</div>';
      el.onclick = () => {
        audio.uiTick(); this.playerDef = d;
        [...cards.children].forEach(c => c.classList.remove('sel'));
        el.classList.add('sel');
        this.buildPlayerMech(true);
      };
      cards.appendChild(el);
    });
    this.buildPlayerMech(true);
  }

  buildPlayerMech(forHangar) {
    const mech = this.makeMech(this.playerDef, [1, 1, 1]);
    if (!mech) return;
    if (forHangar) { this.hangarMech = mech; mech.pos[0] = 0; mech.pos[2] = 0; }
    else this.playerMech = mech;
  }

  /** Instantiate a playable mech from its definition (skinned or rigid). */
  makeMech(def, tint) {
    const asset = this.assets[def.key];
    if (!asset) return null;
    try {
      if (asset.skins.length) {
        const m = new SkinnedMech(asset, { scale: def.scale, tint, accent: def.accent });
        m.def = def;
        return m;
      }
      if (this.robotClusters.length) {
        const b = def.key === 'warbot' ? this.robotClusters[0] : this.robotClusters[rndi(this.robotClusters.length)];
        const m = new PropMech(b, { scale: def.scale, tint });
        m.height = 3.4; m.radius = 1.2; m.def = def; m.isProp = true;
        return m;
      }
    } catch (e) { logLine('makeMech(' + def.key + '): ' + e.message, true); }
    return null;
  }

  startMission() {
    this.state = 'GAMEPLAY';
    this.setOverlay(null);
    $('hud').classList.add('on');
    this.hp = CONFIG.player.hp; this.boost = 100; this.ammo = CONFIG.combat.magSize;
    this.score = 0; this.kills = 0; this.wave = 0; this.heat = 0; this.reloadT = 0;
    this.enemies.length = 0; this.bolts.length = 0;
    this.yaw = Math.PI * 0.25; this.pitch = -0.05;
    this.lockOn = false; this.lockTarget = null;
    this.nextWave();
    this.buildPlayerMech(false);
    const m = this.playerMech;
    if (m) {
      const spawn = this.findSpawn();
      vec3.set(m.pos, spawn[0], spawn[1], spawn[2]);
      vec3.set(m.vel, 0, 0, 0);
      m.yaw = this.yaw; m.targetYaw = this.yaw;
      if (m.airborne !== undefined) m.airborne = false;
      m.dead = false;
    }
    $('feed').innerHTML = '';
    this.banner('WAVE 1', 'HOSTILES INBOUND');
    $('gl').requestPointerLock && $('gl').requestPointerLock();
  }

  abortMission() {
    this.state = 'MENU';
    this.setOverlay('menu');
    document.exitPointerLock && document.exitPointerLock();
  }

  setPaused(on) {
    if (on && this.state === 'GAMEPLAY') {
      this.state = 'PAUSED'; this.setOverlay('pause');
      document.exitPointerLock && document.exitPointerLock();
    } else if (!on && this.state === 'PAUSED') {
      this.state = 'GAMEPLAY'; this.setOverlay(null); $('hud').classList.add('on');
      $('gl').requestPointerLock && $('gl').requestPointerLock();
    }
  }

  banner(big, small) {
    const b = $('banner');
    b.innerHTML = big + (small ? '<small>' + small + '</small>' : '');
    b.classList.add('show');
    clearTimeout(this._bt);
    this._bt = setTimeout(() => b.classList.remove('show'), 2200);
  }

  feed(msg) {
    const f = $('feed');
    const d = document.createElement('div'); d.textContent = msg;
    f.prepend(d);
    while (f.children.length > 6) f.removeChild(f.lastChild);
    setTimeout(() => { if (d.parentNode) d.parentNode.removeChild(d); }, 5000);
  }

  /* ============================ WAVES / ENEMIES ========================= */
  nextWave() {
    this.wave++;
    this.spawnLeft = CONFIG.enemy.baseCount + (this.wave - 1) * CONFIG.enemy.perWave;
    this.intermission = false;
    this.banner('WAVE ' + this.wave, this.spawnLeft + ' HOSTILES DETECTED');
    audio.waveStart();
  }

  findSpawn() {
    const B = CONFIG.world.bounds;
    for (let tries = 0; tries < 24; tries++) {
      const ang = rnd(Math.PI * 2), rad = rnd(18, 34);
      const x = clamp((B[0] + B[1]) / 2 + Math.cos(ang) * rad, B[0] + 2, B[1] - 2);
      const z = clamp((B[2] + B[3]) / 2 + Math.sin(ang) * rad, B[2] + 2, B[3] - 2);
      const y = this.heightMap ? this.heightMap.sample(x, z) : CONFIG.world.groundY;
      let blocked = false;
      for (const c of this.colliders)
        if (x > c.min[0] - 2 && x < c.max[0] + 2 && z > c.min[2] - 2 && z < c.max[2] + 2) { blocked = true; break; }
      if (!blocked) return [x, y, z];
    }
    return [0, this.heightMap ? this.heightMap.sample(0, 0) : 0, 0];
  }

  spawnEnemy() {
    const E = CONFIG.enemy;
    const pool = MECH_DEFS.filter(d => this.assets[d.key]);
    const def = pool.length ? pool[rndi(pool.length)] : MECH_DEFS[0];
    const m = this.makeMech(def, [1, 1, 1]);
    const pos = this.findSpawn();
    const hp = E.hp + (this.wave - 1) * E.hpPerWave;
    if (m) {
      vec3.set(m.pos, pos[0], pos[1], pos[2]);
      vec3.set(m.vel, 0, 0, 0);
      m.dead = false;
      this.enemies.push({
        kind: 'mech', mech: m, def, pos: m.pos, hp, maxHp: hp,
        speed: (E.speed + (this.wave - 1) * E.speedPerWave) * def.spdMul,
        fireCd: rnd(0.5, 2), strafeT: rnd(10), strafeSign: Math.random() < 0.5 ? -1 : 1,
        hitFlash: 0, dead: false, deathT: 0, radius: Math.max(0.9, m.radius || 1.2),
        height: m.height || 3, score: E.score
      });
    } else {
      // procedural drone fallback (always available, zero assets needed)
      this.enemies.push({
        kind: 'drone', pos: V3(pos[0], pos[1] + 2.4, pos[2]), vel: V3(),
        hp, maxHp: hp, speed: E.speed + (this.wave - 1) * E.speedPerWave,
        fireCd: rnd(0.5, 2), strafeT: rnd(10), strafeSign: Math.random() < 0.5 ? -1 : 1,
        hitFlash: 0, dead: false, deathT: 0, radius: E.radius, height: E.height,
        phase: rnd(6.28), score: Math.round(E.score * 0.7)
      });
    }
  }

  /* ============================ COMBAT ================================== */
  toggleLock() {
    this.lockOn = !this.lockOn;
    if (this.lockOn) { this.acquireLock(); audio.lockBeep(); }
    else this.lockTarget = null;
  }
  acquireLock() {
    this.lockTarget = this.pickTarget(CONFIG.combat.lockAngleDeg * DEG);
    if (this.lockTarget) audio.lockBeep();
  }
  camForward(out) {
    const cp = Math.cos(this.pitch);
    return vec3.set(out, -Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }
  pickTarget(angTol) {
    const eye = this.eyePos(V3()), fwd = this.camForward(V3());
    let best = null, bestScore = Infinity;
    for (const e of this.enemies) {
      if (e.dead) continue;
      const c = _s.v4;
      vec3.set(c, e.pos[0], e.pos[1] + e.height * 0.55, e.pos[2]);
      const d = vec3.sub(_s.v5, c, eye), dist = vec3.len(d);
      if (dist > CONFIG.combat.lockRange || dist < 1) continue;
      vec3.scale(d, d, 1 / dist);
      const cosA = vec3.dot(d, fwd);
      if (cosA < Math.cos(angTol)) continue;
      const s = dist * (2 - cosA);
      if (s < bestScore) { bestScore = s; best = e; }
    }
    return best;
  }
  eyePos(out) {
    const m = this.playerMech;
    if (m && m.eyePos && (m.eyePos[0] || m.eyePos[2]))
      return vec3.set(out, m.eyePos[0], m.eyePos[1], m.eyePos[2]);
    const p = m && m.pos ? m.pos : V3();
    return vec3.set(out, p[0], p[1] + (m && m.height ? m.height * 0.8 : 2.4), p[2]);
  }

  startReload() {
    if (this.reloadT > 0 || this.ammo === CONFIG.combat.magSize) return;
    this.reloadT = CONFIG.combat.reloadTime; audio.reload();
  }

  tryFire(dt) {
    this.fireCd -= dt;
    if (!(this.mouseDown & 1) || this.fireCd > 0 || this.reloadT > 0) return;
    if (this.ammo <= 0) { this.startReload(); return; }
    this.fireCd = 1 / CONFIG.combat.fireRate;
    this.ammo--;
    const C = CONFIG.combat;
    const eye = this.eyePos(V3()), fwd = this.camForward(V3());
    let dir = fwd;
    if (this.lockOn && this.lockTarget && !this.lockTarget.dead) {
      const t = this.lockTarget;
      const to = vec3.sub(V3(), V3(t.pos[0], t.pos[1] + t.height * 0.55, t.pos[2]), eye);
      vec3.norm(to, to);
      dir = vec3.lerp(V3(), fwd, to, 0.85); vec3.norm(dir, dir);
    } else {
      const sp = (this.keys['ShiftLeft'] ? C.aimSpreadDeg : C.spreadDeg) * DEG;
      dir = vec3.norm(V3(), vec3.set(V3(),
        fwd[0] + rnd(-sp, sp), fwd[1] + rnd(-sp, sp), fwd[2] + rnd(-sp, sp)));
    }
    const muzzle = V3(eye[0] + dir[0] * 1.6, eye[1] + dir[1] * 1.6 - 0.2, eye[2] + dir[2] * 1.6);
    this.bolts.push({
      p: Float32Array.from(muzzle), v: Float32Array.from(vec3.scale(V3(), dir, C.bulletSpeed)),
      life: C.bulletLife, team: 0, dmg: C.damage * this.playerDef.dmgMul
    });
    const m = this.playerMech;
    if (m && m.fireRecoil) m.fireRecoil(1);
    if (m) m.fireGlow = 1;
    this.shake = Math.min(1.2, this.shake + CONFIG.combat.shake * 0.5);
    this.heat = Math.min(100, this.heat + 4);
    audio.cannon();
    this.particles.burst(muzzle[0], muzzle[1], muzzle[2], 5, 6, [1, 0.8, 0.4], 0.18, 0.35, 1);
  }

  updateBolts(dt) {
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.life -= dt;
      const stepV = _s.v1; vec3.scale(stepV, b.v, dt);
      const steps = Math.max(1, Math.ceil(vec3.len(stepV) / 1.2));
      let hit = null, hitPoint = null;
      for (let s = 0; s < steps && !hit; s++) {
        const px = b.p[0] + stepV[0] * (s + 1) / steps, py = b.p[1] + stepV[1] * (s + 1) / steps, pz = b.p[2] + stepV[2] * (s + 1) / steps;
        if (b.team === 0) {
          for (const e of this.enemies) {
            if (e.dead) continue;
            const d2 = (px - e.pos[0]) ** 2 + (pz - e.pos[2]) ** 2;
            if (d2 < e.radius * e.radius && py > e.pos[1] && py < e.pos[1] + e.height) {
              hit = e; hitPoint = [px, py, pz]; break;
            }
          }
        } else {
          const m = this.playerMech;
          if (m && !m.dead) {
            const d2 = (px - m.pos[0]) ** 2 + (pz - m.pos[2]) ** 2;
            const hh = m.height || 3;
            if (d2 < 1.6 * 1.6 && py > m.pos[1] && py < m.pos[1] + hh) { hit = 'player'; hitPoint = [px, py, pz]; }
          }
        }
        if (!hit) {
          const gy = this.heightMap ? this.heightMap.sample(px, pz) : 0;
          if (py < gy) { hit = 'ground'; hitPoint = [px, gy, pz]; }
        }
      }
      vec3.add(b.p, b.p, stepV);
      if (hit) { this.onBoltImpact(hit, hitPoint, b); this.bolts.splice(i, 1); continue; }
      if (b.life <= 0) this.bolts.splice(i, 1);
    }
  }

  onBoltImpact(hit, pt, b) {
    const P = this.particles;
    if (hit === 'ground') {
      P.burst(pt[0], pt[1] + 0.05, pt[2], 8, 5, [1, 0.6, 0.25], 0.5, 0.3, 0.6);
      this.r.addScorch(pt[0], pt[2], 0.9, 0.5);
      audio.impact(0.3);
      return;
    }
    if (hit === 'player') {
      this.damagePlayer(b.dmg);
      P.burst(pt[0], pt[1], pt[2], 10, 6, [1, 0.3, 0.2], 0.5, 0.3);
      audio.hurt();
      return;
    }
    hit.hp -= b.dmg; hit.hitFlash = CONFIG.enemy.hitFlash * 8;
    P.burst(pt[0], pt[1], pt[2], 9, 7, [1, 0.75, 0.35], 0.45, 0.3);
    this.r.addScorch(pt[0], pt[2], 0.7, 0.3);
    audio.impact(0.6);
    this.hitmark(false);
    if (hit.hp <= 0) this.killEnemy(hit);
  }

  killEnemy(e) {
    e.dead = true; e.deathT = 0;
    if (e.mech) e.mech.dead = true;
    this.score += e.score * this.wave;
    this.kills++;
    this.particles.burst(e.pos[0], e.pos[1] + e.height * 0.5, e.pos[2], 26, 10, [1, 0.55, 0.2], 1.1, 0.6);
    this.particles.burst(e.pos[0], e.pos[1] + e.height * 0.5, e.pos[2], 14, 6, [0.3, 0.6, 1], 1.4, 0.45, 0.4);
    audio.explode();
    this.hitmark(true);
    this.feed('TARGET DESTROYED +' + (e.score * this.wave));
    if (this.lockTarget === e) { this.lockTarget = null; if (this.lockOn) this.acquireLock(); }
  }

  damagePlayer(d) {
    this.hp -= d;
    this.dmgFx = Math.min(1, this.dmgFx + 0.5);
    $('dmgFlash').style.opacity = 0.8;
    setTimeout(() => { $('dmgFlash').style.opacity = 0; }, 120);
    this.shake = Math.min(1.5, this.shake + 0.4);
    if (this.hp <= 0) { this.hp = 0; this.gameOver(false); }
  }

  hitmark(kill) {
    const h = $('hitmark');
    h.classList.toggle('kill', !!kill);
    h.classList.add('show');
    clearTimeout(this._hmT);
    this._hmT = setTimeout(() => h.classList.remove('show'), 130);
  }

  gameOver(win) {
    this.state = 'END';
    document.exitPointerLock && document.exitPointerLock();
    $('endTitle').textContent = win ? 'SECTOR CLEARED' : 'MISSION FAILED';
    $('endStats').innerHTML =
      'SCORE <b>' + this.score + '</b><br>KILLS <b>' + this.kills +
      '</b><br>WAVES SURVIVED <b>' + this.wave + '</b><br>HULL LEFT <b>' + Math.max(0, Math.round(this.hp)) + '%</b>';
    this.setOverlay('end');
  }

  /* ============================ SIM STEP ================================ */
  update(dt) {
    this.time += dt;
    if (this.state === 'HANGAR') { this.updateHangar(dt); return; }
    if (this.state !== 'GAMEPLAY') return;
    const M = CONFIG.mech, B = CONFIG.world.bounds;
    let mx = 0, mz = 0;
    if (this.keys['KeyW']) mz -= 1; if (this.keys['KeyS']) mz += 1;
    if (this.keys['KeyA']) mx -= 1; if (this.keys['KeyD']) mx += 1;
    const boost = !!(this.keys['ShiftLeft'] || this.keys['ShiftRight']) && this.boost > 1;
    const jumping = !!this.keys['Space'];
    if (boost && (mx || mz)) this.boost = Math.max(0, this.boost - M.boost.drain * dt);
    else this.boost = Math.min(100, this.boost + M.boost.regen * dt);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const wishX = mx * cy - mz * sy, wishZ = mx * sy + mz * cy;
    const m = this.playerMech;
    const ctl = { moveX: wishX, moveZ: wishZ, boost, jump: jumping,
                  aimYaw: this.yaw, aimPitch: this.pitch, camYaw: this.yaw, faceAim: false };
    if (m && !m.dead) {
      if (m.isProp) {
        // rigid mech: integrate locomotion manually (same feel, no skeleton)
        const spd = M.walk.speed * this.playerDef.spdMul * (boost ? M.boost.mult : 1);
        const k = damp(wishX || wishZ ? M.walk.accel : M.walk.friction, dt);
        m.vel[0] = lerp(m.vel[0], wishX * spd, k); m.vel[2] = lerp(m.vel[2], wishZ * spd, k);
        m.vel[1] -= M.jump.gravity * dt;
        vec3.madd(m.pos, m.pos, m.vel, dt);
        const gy = this.heightMap ? this.heightMap.sample(m.pos[0], m.pos[2]) : 0;
        if (m.pos[1] <= gy) { m.pos[1] = gy; m.vel[1] = 0; m.onGround = true; if (jumping) m.vel[1] = M.jump.impulse; }
        else m.onGround = false;
        const moving = Math.hypot(m.vel[0], m.vel[2]);
        if (moving > 0.3) m.targetYaw = Math.atan2(m.vel[0], m.vel[2]);
        m.yaw = lerp(m.yaw, m.targetYaw, damp(M.walk.turnSmooth, dt));
        m.bobY = easeInOutCubic((Math.sin(this.time * (2 + moving * 1.2)) + 1) * 0.5) * 0.09 * clamp(moving / 4, 0, 1);
        m.sync(this.time);
        m.fireGlow = Math.max(0, (m.fireGlow || 0) - dt * 6);
      } else {
        m.targetYaw = this.yaw;
        m.update(dt, ctl, this.heightMap);
        m.fireGlow = Math.max(0, (m.fireGlow || 0) - dt * 6);
        if (m.stepEvents && m.stepEvents.length) { m.stepEvents.length = 0; audio.footfall(0.25); }
        if (jumping && m.airborne === false) audio.jumpJet();
      }
      for (const c of this.colliders) resolveCircleAABB(m.pos, 1.6, c.min, c.max);
      m.pos[0] = clamp(m.pos[0], B[0], B[1]); m.pos[2] = clamp(m.pos[2], B[2], B[3]);
    }
    if (this.reloadT > 0) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) { this.ammo = CONFIG.combat.magSize; this.feed('MAGAZINE RENEWED'); }
    }
    this.heat = Math.max(0, this.heat - dt * 12);
    this.tryFire(dt);
    if (this.lockOn && (!this.lockTarget || this.lockTarget.dead)) this.acquireLock();
    /* ---- waves ---- */
    if (this.spawnLeft > 0) {
      this.waveTimer -= dt;
      if (this.waveTimer <= 0) { this.spawnEnemy(); this.spawnLeft--; this.waveTimer = 1.4; }
    } else if (!this.enemies.some(e => !e.dead) && !this.intermission) {
      this.intermission = true; this.waveTimer = 4;
      this.banner('SECTOR CLEAR', 'NEXT WAVE INCOMING');
      this.hp = Math.min(CONFIG.player.hp, this.hp + 25);
    }
    if (this.intermission) {
      this.waveTimer -= dt;
      if (this.waveTimer <= 0) {
        if (this.wave >= 8) { this.gameOver(true); return; }
        this.intermission = false; this.nextWave();
      }
    }
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (e.dead) {
        e.deathT += dt;
        if (e.mech && e.mech.update) {
          e.mech.vel[0] = e.mech.vel[2] = 0; e.mech.deathT = e.deathT;
          e.mech.update(dt, { moveX: 0, moveZ: 0 }, this.heightMap);
        }
        if (e.deathT > 3.2) this.enemies.splice(i, 1);
        continue;
      }
      this.updateEnemy(e, dt);
    }
    this.updateBolts(dt);
    this.particles.update(dt);
    /* ---- HUD refresh (throttled) ---- */
    this._hudT -= dt;
    if (this._hudT <= 0) {
      this._hudT = 0.1;
      $('hpFill').style.transform = 'scaleX(' + clamp(this.hp / CONFIG.player.hp, 0, 1) + ')';
      $('hpVal').textContent = Math.max(0, Math.round(this.hp)) + '%';
      $('boostFill').style.transform = 'scaleX(' + (this.boost / 100) + ')';
      $('bsVal').textContent = Math.round(this.boost) + '%';
      $('ammoNum').textContent = this.reloadT > 0 ? '--' : this.ammo;
      $('ammoNum').classList.toggle('low', this.ammo <= 4);
      $('heatVal').textContent = 'HEAT ' + Math.round(this.heat);
      $('waveTxt').textContent = 'WAVE ' + this.wave;
      $('scoreTxt').textContent = 'SCORE ' + this.score;
      $('objTxt').textContent = this.intermission ? 'REGROUP — NEXT WAVE' :
        (this.spawnLeft > 0 ? this.spawnLeft + ' SPAWNS PENDING' : this.enemies.filter(x => !x.dead).length + ' ENGAGED');
      const tgt = this.lockTarget;
      $('tgtInfo').textContent = tgt ? (tgt.def ? tgt.def.name : 'DRONE') + ' ' +
        Math.round(vec3.dist(tgt.pos, m ? m.pos : V3())) + 'M' : (this.lockOn ? 'SCANNING…' : 'NO TARGET');
      $('lockTag').classList.toggle('on', !!(this.lockOn && tgt));
      $('cross').classList.toggle('lock', !!(this.lockOn && tgt));
      $('lowWarn').style.opacity = this.hp < 30 ? String(0.6 + 0.4 * Math.abs(Math.sin(this.time * 6))) : 0;
      $('perf').textContent = this.fps.toFixed(0) + ' FPS · ' + this.r.stats.draws + ' DC · ' + ((this.r.stats.tris / 1000) | 0) + 'k TRI';
    }
    const spr = 1 + clamp(m ? Math.hypot(m.vel[0], m.vel[2]) / 10 : 0, 0, 1);
    $('crossG').setAttribute('transform', 'scale(' + spr.toFixed(2) + ')');
    this.dmgFx = Math.max(0, this.dmgFx - dt * 1.5);
    this.shake = Math.max(0, this.shake - dt * 3.2);
    audio.music(clamp(1 - this.enemies.filter(x => !x.dead).length / 8, 0.15, 1));
  }

  updateEnemy(e, dt) {
    const E = CONFIG.enemy;
    const m = this.playerMech;
    if (!m || m.dead) return;
    const dx = m.pos[0] - e.pos[0], dz = m.pos[2] - e.pos[2];
    const dist = Math.hypot(dx, dz) || 1e-4;
    const nx = dx / dist, nz = dz / dist;
    e.strafeT += dt;
    if (e.strafeT > E.strafePeriod) { e.strafeT = 0; e.strafeSign *= -1; }
    const wantIn = dist > E.engageRange * 0.6 ? 1 : (dist < E.engageRange * 0.35 ? -0.7 : 0);
    const vx = (nx * wantIn - nz * e.strafeSign * 0.55) * e.speed;
    const vz = (nz * wantIn + nx * e.strafeSign * 0.55) * e.speed;
    if (e.kind === 'mech') {
      const mm = e.mech;
      mm.targetYaw = Math.atan2(nx, nz);
      mm.update(dt, { moveX: vx / E.speed, moveZ: vz / E.speed, boost: false, jump: false,
                      aimYaw: mm.targetYaw, aimPitch: 0, faceAim: true }, this.heightMap);
      e.pos = mm.pos;
    } else {
      e.vel[0] = lerp(e.vel[0], vx, damp(6, dt)); e.vel[2] = lerp(e.vel[2], vz, damp(6, dt));
      vec3.madd(e.pos, e.pos, e.vel, dt);
      const gy = this.heightMap ? this.heightMap.sample(e.pos[0], e.pos[2]) : 0;
      e.pos[1] = lerp(e.pos[1], gy + 2.4 + Math.sin(this.time * 2 + e.phase) * 0.35, damp(4, dt));
    }
    const B = CONFIG.world.bounds;
    e.pos[0] = clamp(e.pos[0], B[0], B[1]); e.pos[2] = clamp(e.pos[2], B[2], B[3]);
    for (const c of this.colliders) resolveCircleAABB(e.pos, e.radius, c.min, c.max);
    e.hitFlash = Math.max(0, e.hitFlash - dt * 6);
    e.fireCd -= dt;
    if (e.fireCd <= 0 && dist < E.engageRange) {
      e.fireCd = 1 / E.fireRate;
      const shots = Math.random() < 0.4 ? E.burst : 1;
      for (let s = 0; s < shots; s++) {
        setTimeout(() => {
          if (e.dead || this.state !== 'GAMEPLAY') return;
          const pm = this.playerMech; if (!pm) return;
          const from = V3(e.pos[0], e.pos[1] + e.height * 0.6, e.pos[2]);
          const to = V3(pm.pos[0], pm.pos[1] + (pm.height || 3) * 0.5, pm.pos[2]);
          const dir = vec3.sub(V3(), to, from); vec3.norm(dir, dir);
          dir[0] += rnd(-0.05, 0.05); dir[1] += rnd(-0.03, 0.03); dir[2] += rnd(-0.05, 0.05);
          vec3.norm(dir, dir);
          this.bolts.push({ p: Float32Array.from(from), v: Float32Array.from(vec3.scale(V3(), dir, 34)),
                            life: 3, team: 1, dmg: E.dmg });
          this.particles.burst(from[0], from[1], from[2], 3, 4, [1, 0.4, 0.2], 0.2, 0.25);
        }, s * 140);
      }
      audio.tone(240, 0.12, 0.12, 'square', 90);
    }
  }

  updateHangar(dt) {
    const mm = this.hangarMech;
    if (!mm) return;
    if (mm.isProp) {
      mm.pos[0] = 0; mm.pos[2] = 0;
      mm.pos[1] = this.heightMap ? this.heightMap.sample(0, 0) : 0;
      mm.yaw += dt * 0.4; mm.targetYaw = mm.yaw;
      mm.bobY = Math.sin(this.time * 2) * 0.05;
      mm.sync(this.time);
    } else {
      mm.targetYaw = 0;
      mm.update(dt, { moveX: 0, moveZ: 0, boost: false, jump: false,
                      aimYaw: 0, aimPitch: 0, camYaw: 0, faceAim: false }, this.heightMap);
    }
  }

  /* ============================ RENDER ================================== */
  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    let dt = (now - this.last) / 1000; this.last = now;
    dt = clamp(dt, 0, CONFIG.perf.dtCap);
    this.fpsAcc += dt; this.fpsN++;
    if (this.fpsAcc > 0.5) { this.fps = this.fpsN / this.fpsAcc; this.fpsAcc = 0; this.fpsN = 0; }
    if (document.hidden) return;
    this.r.resize();
    this.update(dt);
    this.render();
  }

  render() {
    const r = this.r, gl = r.gl;
    r.stats.draws = 0; r.stats.tris = 0;
    const st = this.sceneState();
    r.beginScene();
    r.beginShadow();
    this.drawShadowPass(st);
    r.endShadow();
    this.drawWorld(st);
    this.drawEntities(st);
    r.beginPost(st);
    gl.enable(gl.DEPTH_TEST);
  }

  cameraPose() {
    const m = this.playerMech;
    let px = 0, py = 0, pz = 0, h = 3;
    if (m && m.pos) { px = m.pos[0]; py = m.pos[1]; pz = m.pos[2]; h = m.height || 3; }
    if (this.state === 'HANGAR') {
      const d = 9 * this.hangarZoom;
      const eye = V3(Math.sin(this.hangarYaw) * d * Math.cos(this.hangarPitch),
                     2.5 + Math.sin(this.hangarPitch) * d,
                     Math.cos(this.hangarYaw) * d * Math.cos(this.hangarPitch));
      return { eye, target: V3(0, 2.2, 0), up: V3(0, 1, 0) };
    }
    if (this.state === 'MENU') {
      const a = this.time * 0.1;
      return { eye: V3(Math.sin(a) * 26, 12, Math.cos(a) * 26), target: V3(7, 2, -6), up: V3(0, 1, 0) };
    }
    const fwd = this.camForward(V3());
    const shx = (Math.random() - 0.5) * this.shake * 0.25;
    const shy = (Math.random() - 0.5) * this.shake * 0.25;
    const back = this.camDist;
    const headY = py + h * 0.85;
    const eye = V3(px - fwd[0] * back + shx, headY - fwd[1] * back + shy - 0.4, pz - fwd[2] * back);
    // don't clip through buildings: pull in if blocked
    const ro = V3(px, headY, pz), rd = V3(eye[0] - ro[0], eye[1] - ro[1], eye[2] - ro[2]);
    const rlen = vec3.len(rd) || 1e-3;
    let closest = 1;
    for (const c of this.colliders) {
      const t = rayAABB(ro, rd, c.min, c.max);
      if (t < Infinity) closest = Math.min(closest, Math.max(0, (t * rlen - 0.5)) / rlen);
    }
    if (closest < 1) {
      eye[0] = ro[0] + rd[0] * closest; eye[2] = ro[2] + rd[2] * closest;
      eye[1] = Math.max(eye[1], ro[1] + 0.3);
    }
    const target = V3(eye[0] + fwd[0] * 10, eye[1] + fwd[1] * 10, eye[2] + fwd[2] * 10);
    return { eye, target, up: V3(0, 1, 0) };
  }

  sceneState() {
    const r = this.r, gl = r.gl;
    const cam = this.cameraPose();
    const proj = MAT4_ID(), view = MAT4_ID(), vp = MAT4_ID();
    mat4.perspective(proj, 62 * DEG, r.w / r.h, 0.1, 400);
    mat4.lookAt(view, cam.eye, cam.target, cam.up);
    mat4.mul(vp, proj, view);
    const sun = vec3.norm(V3(), V3(CONFIG.world.sunDir[0], CONFIG.world.sunDir[1], CONFIG.world.sunDir[2]));
    const ctr = V3(cam.eye[0] - sun[0] * 2, cam.eye[1], cam.eye[2] - sun[2] * 2);
    const far = V3(ctr[0] + sun[0] * 60, ctr[1] + sun[1] * 60, ctr[2] + sun[2] * 60);
    const lv = MAT4_ID(), lp = MAT4_ID();
    mat4.lookAt(lv, far, ctr, V3(0, 1, 0));
    const S = CONFIG.shadow.range;
    mat4.ortho(lp, -S, S, -S, S, 1, 140);
    const lvp = MAT4_ID(); mat4.mul(lvp, lp, lv);
    r.setLightVP(lvp);
    // point lights from bolts (max 8)
    let np = 0;
    const cd = r.pointColorsData || (r.pointColorsData = new Float32Array(8 * 4));
    for (const b of this.bolts) {
      if (np >= 8) break;
      r.pointPosArr[np * 3] = b.p[0]; r.pointPosArr[np * 3 + 1] = b.p[1]; r.pointPosArr[np * 3 + 2] = b.p[2];
      const o = np * 4;
      if (b.team === 0) { cd[o] = 1; cd[o + 1] = 0.75; cd[o + 2] = 0.35; }
      else { cd[o] = 1; cd[o + 1] = 0.25; cd[o + 2] = 0.15; }
      cd[o + 3] = 2.2;
      np++;
    }
    if (!r.pointColorsTex) r.pointColorsTex = r.makeFloatTexture(8, 1, cd);
    else {
      gl.bindTexture(gl.TEXTURE_2D, r.pointColorsTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 8, 1, gl.RGBA, gl.FLOAT, cd);
    }
    return {
      viewProj: vp, lightVP: lvp, camPos: cam.eye, time: this.time,
      shadowTex: r.shadowTex, whiteTex: r.whiteTex, lightTex: r.lightTex,
      lmRect: r.lmRect || [0, 0, 1, 1],
      sunColorScaled: _sunScaled(), numPoints: np, pointPosArr: r.pointPosArr, pointTex: r.pointColorsTex,
      vignette: this.state === 'GAMEPLAY' ? 0.5 : 0.42,
      aberr: this.dmgFx * 1.4 + this.shake * 0.4, damage: this.dmgFx, scan: 0.6
    };
  }

  drawShadowPass(st) {
    const r = this.r;
    const ID = MAT4_ID();
    for (const b of this.cityBatches) r.drawBatchDepth(b, ID);
    if (this.state === 'GAMEPLAY' || this.state === 'PAUSED' || this.state === 'END') {
      const m = this.playerMech;
      if (m) this.drawEntityDepth(m);
      for (const e of this.enemies) if (!e.dead && e.kind === 'mech') this.drawEntityDepth(e.mech);
    }
    if (this.state === 'HANGAR' && this.hangarMech) this.drawEntityDepth(this.hangarMech);
  }

  drawEntityDepth(m) {
    const r = this.r, gl = r.gl;
    if (m.isProp) {
      for (const b of m.batches) r.drawBatchDepth(b, m.model);
    } else if (m.rootWorld && m.gpuPrims) {
      const prog = r.progs.depth;
      r.use(prog);
      gl.activeTexture(gl.TEXTURE0 + 5);
      gl.bindTexture(gl.TEXTURE_2D, m.skin.texBuf);
      r.u1i(prog, 'uJointTexW', m.skin.texW);
      gl.uniformMatrix4fv(prog.u.uModel, false, m.rootWorld);
      gl.uniform1i(prog.u.uSkinned, 1);
      gl.disable(gl.CULL_FACE);
      for (const gp of m.gpuPrims) {
        gl.bindVertexArray(gp.vao);
        if (gp.indexed) gl.drawElements(gl.TRIANGLES, gp.iboCount, gp.iboType, 0);
        else gl.drawArrays(gl.TRIANGLES, 0, gp.count);
      }
      gl.bindVertexArray(null);
    }
  }

  drawWorld(st) {
    const r = this.r;
    if (this.cityBatches.length) {
      const ID = MAT4_ID();
      for (const b of this.cityBatches) r.drawBatch(b, st, ID, NM_ID);
    } else {
      const mdl = MAT4_ID();
      mat4.translate(mdl, mdl, [7, -0.5, -6]); mat4.scale(mdl, mdl, [200, 1, 200]);
      r.drawPrim(this.boxPrim, st, { model: mdl, normalMat: NM_ID,
        tint: [0.5, 0.55, 0.6], receiveShadow: false });
    }
  }

  drawEntities(st) {
    const r = this.r, gl = r.gl;
    if (this.state === 'HANGAR') {
      if (this.hangarMech) this.hangarMech.render(r, st);
    } else if (this.state !== 'MENU' && this.state !== 'LOADING') {
      const m = this.playerMech;
      if (m) m.render(r, st);
      for (const e of this.enemies) {
        if (e.kind === 'mech') {
          if (!e.dead) e.mech.hitFlash = Math.max(e.mech.hitFlash || 0, e.hitFlash * 0.12);
          e.mech.render(r, st);
        } else this.drawDrone(e, st);
      }
    }
    // bolts: emissive spindles stretched along velocity
    if (this.bolts.length) {
      for (const b of this.bolts) {
        const mdl = _s.m2;
        quat.fromTo(_s.q1, 0, 0, 1, b.v[0], b.v[1], b.v[2]);
        vec3.set(_s.v2, 0.35, 0.35, 3.2);
        mat4.compose(mdl, b.p, _s.q1, _s.v2);
        r.drawPrim(this.boltPrim, st, {
          model: mdl, normalMat: NM_ID, emisBoost: 6,
          emissive: b.team === 0 ? [1, 0.8, 0.35] : [1, 0.25, 0.15],
          tint: [1, 1, 1], unlit: false, receiveShadow: false
        });
      }
    }
    // particles as additive billboard glow quads
    const n = this.particles.n;
    if (n && this.glow) {
      const prog = r.progs.mesh;
      r.use(prog);
      const look = V3(st.camPos[0], st.camPos[1] + 0.001, st.camPos[2]);
      const fwd = vec3.norm(V3(), V3(look[0], look[1], look[2]));
      const right = vec3.norm(V3(), vec3.cross(V3(), fwd, V3(0, 1, 0)));
      const up = vec3.cross(V3(), right, fwd);
      const cnt = this.particles.fillQuads(this.glow, right, up);
      gl.bindVertexArray(this.glow.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.glow.vb);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.glow.data.subarray(0, cnt * 4 * 11));
      const ID = MAT4_ID();
      r.um4(prog, 'uViewProj', st.viewProj);
      r.um4(prog, 'uLightVP', st.lightVP);
      r.um4(prog, 'uModel', ID);
      const nl = prog.u.uNormalMat; if (nl) gl.uniformMatrix3fv(nl, false, NM_ID);
      r.u3(prog, 'uCamPos', st.camPos);
      r.u3(prog, 'uLightDir', CONFIG.world.sunDir);
      r.u3(prog, 'uLightColor', st.sunColorScaled);
      r.u3(prog, 'uSkyColor', CONFIG.world.skyColor);
      r.u3(prog, 'uGroundColor', CONFIG.world.groundColor);
      r.u3(prog, 'uFogColor', CONFIG.world.fogColor);
      r.u1f(prog, 'uFogDensity', 0);
      r.u1f(prog, 'uTime', st.time);
      r.u1f(prog, 'uShadowBias', CONFIG.shadow.bias);
      r.bindTex(prog, 'uShadowMap', st.whiteTex, 2);
      r.u1i(prog, 'uUseLightmap', 0);
      r.u1i(prog, 'uReceiveShadow', 0);
      r.u1i(prog, 'uSkinned', 0);
      r.u1i(prog, 'uNumPoints', 0);
      r.u1f(prog, 'uAlpha', 0.9);
      r.u1f(prog, 'uHitFlash', 0);
      r.u1i(prog, 'uUnlit', 1);
      r.u1i(prog, 'uUseVColor', 1);
      r.u3(prog, 'uBaseColor', [0, 0, 0]);
      r.u1f(prog, 'uMetallic', 0);
      r.u1f(prog, 'uRoughness', 1);
      r.u3(prog, 'uEmissive', [1, 1, 1]);
      r.u1f(prog, 'uEmissiveBoost', 2.2);
      r.bindTex(prog, 'uBaseTexS', st.whiteTex, 0);
      r.u1i(prog, 'uUseBaseTex', 0);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.depthMask(false); gl.disable(gl.CULL_FACE);
      gl.drawElements(gl.TRIANGLES, cnt * 6, gl.UNSIGNED_SHORT, 0);
      gl.depthMask(true); gl.disable(gl.BLEND); gl.enable(gl.CULL_FACE);
      gl.bindVertexArray(null);
      r.stats.draws++;
    }
  }

  drawDrone(e, st) {
    const r = this.r, gl = r.gl, prog = r.progs.mesh;
    r.use(prog);
    const mdl = MAT4_ID();
    const yaw = Math.atan2(st.camPos[0] - e.pos[0], st.camPos[2] - e.pos[2]);
    quat.fromAxisAngle(_s.q1, 0, 1, 0, yaw);
    vec3.set(_s.v3, 1.4, 1.4, 1.4);
    mat4.compose(mdl, e.pos, _s.q1, _s.v3);
    r.um4(prog, 'uViewProj', st.viewProj);
    r.um4(prog, 'uLightVP', st.lightVP);
    r.um4(prog, 'uModel', mdl);
    const nm = new Float32Array([Math.cos(yaw), 0, -Math.sin(yaw), 0, 1, 0, Math.sin(yaw), 0, Math.cos(yaw)]);
    const l = prog.u.uNormalMat; if (l) gl.uniformMatrix3fv(l, false, nm);
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
    r.u1f(prog, 'uHitFlash', e.hitFlash);
    r.u1i(prog, 'uUnlit', 0);
    r.u1i(prog, 'uUseVColor', 1);
    r.u3(prog, 'uBaseColor', [1, 1, 1]);
    r.u1f(prog, 'uMetallic', 0.7);
    r.u1f(prog, 'uRoughness', 0.4);
    r.u3(prog, 'uEmissive', [0.05, 0.1, 0.15]);
    r.u1f(prog, 'uEmissiveBoost', 1);
    r.bindTex(prog, 'uBaseTexS', st.whiteTex, 0);
    r.u1i(prog, 'uUseBaseTex', 0);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.BLEND); gl.enable(gl.CULL_FACE);
    gl.bindVertexArray(this.droneAsset.vao);
    gl.drawElements(gl.TRIANGLES, this.droneAsset.count, this.droneAsset.type, 0);
    gl.bindVertexArray(null);
    r.stats.draws++; r.stats.tris += this.droneAsset.tris;
  }
}

/* ---------- extra Renderer helpers (static batch draws) ------------------ */
Renderer.prototype.drawBatchDepth = function (b, model) {
  const gl = this.gl, prog = this.progs.depth;
  this.use(prog);
  gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
  this.um4(prog, 'uLightVP', this._lightVP);
  this.um4(prog, 'uModel', model);
  this.u1i(prog, 'uSkinned', 0);
  gl.disable(gl.CULL_FACE);
  gl.bindVertexArray(b.vao);
  gl.drawElements(gl.TRIANGLES, b.count, b.type, 0);
  gl.bindVertexArray(null);
  this.stats.draws++;
};
Renderer.prototype.drawBatch = function (b, st, model, normalMat) {
  const gl = this.gl, prog = this.progs.mesh;
  this.use(prog);
  gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.BLEND);
  if (b.doubleSided) gl.disable(gl.CULL_FACE); else gl.enable(gl.CULL_FACE);
  this.um4(prog, 'uViewProj', st.viewProj);
  this.um4(prog, 'uLightVP', st.lightVP);
  this.um4(prog, 'uModel', model);
  const l = prog.u.uNormalMat; if (l) gl.uniformMatrix3fv(l, false, normalMat);
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
  this.bindTex(prog, 'uLightmap', st.lightTex || st.whiteTex, 3);
  const l4 = prog.u.uLMRect;
  if (l4) gl.uniform4f(l4, st.lmRect[0], st.lmRect[1], st.lmRect[2], st.lmRect[3]);
  this.u1i(prog, 'uUseLightmap', st.lightTex ? 1 : 0);
  this.u1i(prog, 'uReceiveShadow', 1);
  this.u1i(prog, 'uSkinned', 0);
  this.u1i(prog, 'uNumPoints', st.numPoints);
  if (st.numPoints > 0) {
    const lp = prog.u.uPointPos; if (lp) gl.uniform3fv(lp, st.pointPosArr.subarray(0, st.numPoints * 3));
    this.bindTex(prog, 'uPointColors', st.pointTex, 1);
  }
  const mat = b.mat;
  this.u1i(prog, 'uUseVColor', b.hasColor ? 1 : 0);
  this.u3(prog, 'uBaseColor', mat ? mat.base : [0.7, 0.7, 0.7]);
  this.u1f(prog, 'uMetallic', mat ? mat.metallic : 0.5);
  this.u1f(prog, 'uRoughness', mat ? clamp(mat.roughness, 0.06, 1) : 0.7);
  const em = mat && mat.emissive ? mat.emissive : [0, 0, 0];
  this.u3(prog, 'uEmissive', em);
  this.u1f(prog, 'uEmissiveBoost', (em[0] + em[1] + em[2]) > 0.02 ? 1.8 : 1);
  this.u1f(prog, 'uAlpha', 1);
  this.u1f(prog, 'uHitFlash', 0);
  this.u1i(prog, 'uUnlit', 0);
  this.bindTex(prog, 'uBaseTexS', st.whiteTex, 0);
  this.u1i(prog, 'uUseBaseTex', 0);
  gl.bindVertexArray(b.vao);
  gl.drawElements(gl.TRIANGLES, b.count, b.type, 0);
  gl.bindVertexArray(null);
  this.stats.draws++; this.stats.tris += b.count / 3;
};

/** Bake one robot cluster (already node-transformed prims) into a single
 *  static indexed batch usable by PropMech. */
/** Append all values of a typed array/plain array onto a JS array. */
function pushArr(dst, src) { for (let i = 0; i < src.length; i++) dst.push(src[i]); }

function batchCluster(gl, asset, prims) {
  const P = [], N = [], U = [], C = [], IDX = [];
  let base = 0, hasC = false, mat = null;
  for (const srcP of prims) {
    const cpu = srcP.cpu || srcP.vbo;
    if (!cpu || !cpu.POSITION) continue;
    if (!mat) mat = srcP.mat;
    const p = cpu.POSITION, nv = p.length / 3;
    pushArr(P, p);
    if (cpu.NORMAL) pushArr(N, cpu.NORMAL); else for (let i = 0; i < nv; i++) N.push(0, 1, 0);
    if (cpu.TEXCOORD_0) pushArr(U, cpu.TEXCOORD_0); else for (let i = 0; i < nv; i++) U.push(0.5, 0.5);
    if (cpu.COLOR_0) { hasC = true; pushArr(C, cpu.COLOR_0); }
    if (srcP.indexed && cpu.IBO) { const idx = cpu.IBO; for (let i = 0; i < idx.length; i++) IDX.push(idx[i] + base); }
    else for (let i = 0; i < nv; i++) IDX.push(base + i);
    base += nv;
  }
  const inter = new Float32Array(base * 11);
  for (let i = 0; i < base; i++) {
    inter[i * 11] = P[i * 3]; inter[i * 11 + 1] = P[i * 3 + 1]; inter[i * 11 + 2] = P[i * 3 + 2];
    inter[i * 11 + 3] = N[i * 3] || 0; inter[i * 11 + 4] = N[i * 3 + 1] !== undefined ? N[i * 3 + 1] : 1; inter[i * 11 + 5] = N[i * 3 + 2] || 0;
    inter[i * 11 + 6] = U[i * 2] || 0.5; inter[i * 11 + 7] = U[i * 2 + 1] || 0.5;
    inter[i * 11 + 8] = hasC ? C[i * 3] : 1; inter[i * 11 + 9] = hasC ? C[i * 3 + 1] : 1; inter[i * 11 + 10] = hasC ? C[i * 3 + 2] : 1;
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
  const useU32 = base > 65535;
  const idxArr = useU32 ? Uint32Array.from(IDX) : Uint16Array.from(IDX);
  const ib = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idxArr, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return [{ vao, ib, count: idxArr.length, type: useU32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
            mat, tris: idxArr.length / 3, hasColor: true }];
}

export const game = new Game();


export { Game };
