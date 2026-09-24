import re, os

src = open('/tmp/game.js').read().split('\n')  # index 0 = line 1
def seg(a, b):  # inclusive 1-based line numbers
    return '\n'.join(src[a-1:b])

def head(title_lines, imports=''):
    s = "/* ==========================================================================\n"
    for t in title_lines:
        s += " * " + t + "\n"
    s += " * ==========================================================================*/\n'use strict';\n\n"
    if imports:
        s += imports + "\n"
    return s

os.chdir('/workspace')
for d in ['src/core', 'src/render', 'src/anim', 'src/world', 'src/entities', 'src/game']:
    os.makedirs(d, exist_ok=True)

# ---------- src/core/config.js ----------
open('src/core/config.js', 'w').write(
"""/* ============================================================================
 * MECHA / "META SCAPE" — WebGL2 mech combat game (modular ES source).
 * ZERO external libraries. Math, GLB parser, renderer, procedural animation,
 * audio and gameplay are all hand written, one module per concern.
 *
 * Module map
 *   core/     config, util helpers, math lib, synthesised audio
 *   render/   GLSL shader sources + WebGL2 Renderer
 *   world/    GLB parser, collision helpers, asset batching/particles
 *   anim/     procedural rig animation + fallback geometry
 *   entities/ skinned & rigid mech instances
 *   game/     state machine, shared runtime state; entry point is src/main.js
 * ==========================================================================*/
'use strict';

/* ==========================================================================
 * === CONFIG ===============================================================
 * Every tunable of the procedural animation + gameplay lives here.
 * ==========================================================================*/
""" + seg(20, 78) + "\n\nexport { CONFIG };\n")

# ---------- src/core/util.js ----------
u = seg(82, 109)
for a, b in [("const $ =", "export const $ ="),
             ("const clamp =", "export const clamp ="),
             ("const lerp =", "export const lerp ="),
             ("const smoothstep =", "export const smoothstep ="),
             ("const easeInOutCubic =", "export const easeInOutCubic ="),
             ("const rnd =", "export const rnd ="),
             ("const rndi =", "export const rndi ="),
             ("const damp =", "export const damp ="),
             ("const DEG =", "export const DEG ="),
             ("function logLine", "export function logLine"),
             ("function showFatal", "export function showFatal")]:
    u = u.replace(a, b)
open('src/core/util.js', 'w').write(
    head(["=== UTIL ================================================================",
          "DOM shorthand, scalar math helpers and the loading-console logger."]) + u + "\n")

# ---------- src/core/math.js ----------
m = seg(116, 392)
for name in ['MAT4_ID', 'V3', 'Q4', 'vec3', 'quat', 'mat4', '_s']:
    m = re.sub(r'^const %s =' % name, 'export const %s =' % name, m, flags=re.M)
open('src/core/math.js', 'w').write(
    head(["=== MATH LIB =============================================================",
          "Flat Float32Array column-major matrices (glTF/WebGL convention).",
          "Nothing here allocates: every function writes into a caller-owned out array."],
         "import { clamp } from './util.js';") + m + "\n")

# ---------- src/render/shaders.js ----------
sh = seg(836, 1069)
sh = re.sub(r'^const (VS_\w+|FS_\w+) =', r'export const \1 =', sh, flags=re.M)
open('src/render/shaders.js', 'w').write(
    head(["=== SHADERS ==============================================================",
          "GLSL 300 es, embedded as strings."]) + sh + "\n")

# ---------- src/render/renderer.js ----------
r = seg(1071, 1623)
r = r.replace("function compileShader", "export function compileShader") \
     .replace("function createProgram", "export function createProgram") \
     .replace("class Renderer {", "export class Renderer {")
r += "\n" + seg(4107, 4168) + "\n"   # drawBatchDepth / drawBatch prototype helpers
open('src/render/renderer.js', 'w').write(
    head(["=== RENDERER =============================================================",
          "WebGL2 wrapper: program/VAO caching, texture units, uniform batching,",
          "a directional shadow pass and a bloom post chain.",
          "Also carries the static-batch draw helpers (drawBatch/drawBatchDepth)."],
         "import { CONFIG } from '../core/config.js';\n"
         "import { clamp } from '../core/util.js';\n"
         "import { mat4 } from '../core/math.js';\n"
         "import { VS_MESH, FS_MESH, VS_DEPTH, FS_DEPTH, VS_QUAD, FS_BRIGHT, FS_BLUR, FS_COMPOSITE } from './shaders.js';")
    + r + "\n")

# ---------- src/world/glb.js ----------
g = seg(422, 830)
g = g.replace("let ANISO = 0;", "export let ANISO = 0;")
g = re.sub(r'^function (glbSplit|glbReadAccessor|glbReadIndices|computeNodeWorlds|expandBounds)',
           r'export function \1', g, flags=re.M)
g = g.replace("async function glbTexture", "export async function glbTexture") \
     .replace("async function parseGLB", "export async function parseGLB")
open('src/world/glb.js', 'w').write(
    head(["=== GLB PARSER ===========================================================",
          "Hand written binary glTF (GLB 2.0) reader. This is the most fragile part of",
          "the engine, so every step is defensive: bounds checks everywhere, and any",
          "failure degrades to a coloured box instead of throwing into the frame loop.",
          "",
          "GLB layout (little endian): header | chunk0 (JSON glTF document) |",
          "chunk1 (BIN payload). Accessors are DE-INTERLEAVED on the CPU into tightly",
          "packed typed arrays so VAO setup can use stride = 0."],
         "import { CONFIG } from '../core/config.js';\n"
         "import { logLine } from '../core/util.js';\n"
         "import { mat4, _s } from '../core/math.js';") + g + "\n")

# ---------- src/anim/procedural.js ----------
p = seg(1641, 2101)
p = re.sub(r'^const (RIG_PATTERNS_ATLAS|RIG_PATTERNS_KITSUNE) =', r'export const \1 =', p, flags=re.M)
p = re.sub(r'^function (rigPatternsFor|buildRig)', r'export function \1', p, flags=re.M)
for a, b in [("class Spring {", "export class Spring {"),
             ("class HeightMap {", "export class HeightMap {"),
             ("class ProceduralMech {", "export class ProceduralMech {"),
             ("function makeBoxPrim", "export function makeBoxPrim"),
             ("function makeBoltPrim", "export function makeBoltPrim")]:
    p = p.replace(a, b)
open('src/anim/procedural.js', 'w').write(
    head(["=== PROCEDURAL ANIMATION =================================================",
          "No animation clips are assumed to exist in the GLBs, so every motion is",
          "synthesised from code:",
          "  - MechRig: joint-name pattern matching -> a semantic rig description",
          "    (hips / spine / head / 2 arms / 2 legs) that works on BOTH provided",
          "    mech skeletons and degrades gracefully when parts are absent.",
          "  - torsoSway / stepBob / recoil spring / foot grounding IK.",
          "All of it writes into pre-allocated Float32Arrays (zero GC).",
          "Also hosts the procedural fallback geometry (labelled boxes / bolts) used",
          "when a GLB cannot be parsed — the app never white-screens."],
         "import { CONFIG } from '../core/config.js';\n"
         "import { clamp, lerp, smoothstep, easeInOutCubic, rnd, damp, DEG } from '../core/util.js';\n"
         "import { MAT4_ID, V3, vec3, quat, mat4, _s } from '../core/math.js';") + p + "\n")

# ---------- src/core/audio.js ----------
a = seg(2182, 2285) + "\nconst audio = new AudioEngine();\nexport { audio };\n"
a = a.replace("class AudioEngine {", "export class AudioEngine {")
open('src/core/audio.js', 'w').write(
    head(["=== AUDIO ================================================================",
          "Fully synthesised Web Audio: no samples fetched anywhere."],
         "import { CONFIG } from './config.js';\n"
         "import { logLine, clamp } from './util.js';") + a + "\n")

# ---------- src/world/collision.js ----------
c = seg(2290, 2344)
c = re.sub(r'^function (resolveCircleAABB|rayAABB|raySphere)', r'export function \1', c, flags=re.M)
open('src/world/collision.js', 'w').write(
    head(["=== COLLISION / WORLD HELPERS ============================================="],
         "import { clamp } from '../core/util.js';") + c + "\n")

# ---------- src/world/assets.js ----------
w = seg(2350, 2458) + "\n" + seg(4170, 4214) + "\n" + seg(2459, 2634)
for a_, b_ in [("async function fetchGLB", "export async function fetchGLB"),
               ("function batchAsset", "export function batchAsset"),
               ("function batchCluster", "export function batchCluster"),
               ("function makeDroneAsset", "export function makeDroneAsset"),
               ("function makeGlowQuads", "export function makeGlowQuads"),
               ("class Particles {", "export class Particles {")]:
    w = w.replace(a_, b_)
open('src/world/assets.js', 'w').write(
    head(["=== GAME WORLD ASSETS ====================================================",
          "Asset loading with local->CDN fallback, static batching of the city,",
          "procedural enemy drones and the GPU particle pool."],
         "import { CONFIG } from '../core/config.js';\n"
         "import { logLine, clamp, rnd } from '../core/util.js';\n"
         "import { MAT4_ID, V3, vec3, mat4 } from '../core/math.js';") + w + "\n")

# ---------- src/entities/mechs.js ----------
e = seg(2642, 3044)
for a_, b_ in [("class SkinnedMech {", "export class SkinnedMech {"),
               ("class PropMech {", "export class PropMech {"),
               ("function clusterRobot", "export function clusterRobot")]:
    e = e.replace(a_, b_)
e = e.replace("GL.gl", "renderer.current.gl")
open('src/entities/mechs.js', 'w').write(
    head(["=== MECH ENTITIES ========================================================",
          "  - SkinnedMech: wraps a parsed skinned asset (atlas_hangar_ld /",
          "    kitsune_harpy_rig) with a per-instance root transform, additive",
          "    procedural animation on top of the GLTF rest pose and joint-matrix",
          "    upload for the skin program. Reaches the GL context through the",
          "    shared renderer singleton (src/game/state.js).",
          "  - PropMech: kid_war_robots has no skeleton — rigid meshes baked into",
          "    static batches drawn with a per-instance model matrix + bob/aim yaw."],
         "import { CONFIG } from '../core/config.js';\n"
         "import { clamp, lerp, rnd, damp } from '../core/util.js';\n"
         "import { MAT4_ID, V3, vec3, quat, mat4, _s } from '../core/math.js';\n"
         "import { buildRig } from '../anim/procedural.js';\n"
         "import { computeNodeWorlds } from '../world/glb.js';\n"
         "import { renderer } from '../game/state.js';") + e + "\n")

# ---------- src/game/state.js ----------
open('src/game/state.js', 'w').write(
"""/* ==========================================================================
 * === SHARED RUNTIME STATE =================================================
 * Tiny leaf module holding cross-module singletons, so entities can reach the
 * active renderer without importing the whole Game (avoids circular imports).
 * ==========================================================================*/
'use strict';

/** The active Renderer instance (set by Game.boot), or null before boot.
 *  @type {{current: import('../render/renderer.js').Renderer|null}} */
export const renderer = { current: null };
""")

# ---------- src/game/game.js ----------
gm = seg(3051, 4105)
gm = gm.replace("const MECH_DEFS = [", "export const MECH_DEFS = [") \
       .replace("class Game {", "export class Game {")
gm = gm.replace("GL = this.r = new Renderer(canvas);",
                "renderer.current = this.r = new Renderer(canvas);")
gm = re.sub(r'\bGL\b(?!\w)', 'renderer.current', gm)
open('src/game/game.js', 'w').write(
    head(["=== GAME STATE MACHINE ===================================================",
          "LOADING -> MENU -> HANGAR -> GAMEPLAY (+ PAUSE / END overlays).",
          "Owns asset preparation, input, camera, combat simulation and the frame loop."],
         "import { CONFIG } from '../core/config.js';\n"
         "import { $, clamp, lerp, smoothstep, easeInOutCubic, rnd, rndi, damp, DEG, logLine, showFatal } from '../core/util.js';\n"
         "import { MAT4_ID, V3, Q4, vec3, quat, mat4, _s } from '../core/math.js';\n"
         "import { audio } from '../core/audio.js';\n"
         "import { Renderer } from '../render/renderer.js';\n"
         "import { parseGLB, computeNodeWorlds } from '../world/glb.js';\n"
         "import { resolveCircleAABB, rayAABB, raySphere } from '../world/collision.js';\n"
         "import { fetchGLB, batchAsset, batchCluster, makeDroneAsset, makeGlowQuads, Particles } from '../world/assets.js';\n"
         "import { HeightMap, makeBoxPrim, makeBoltPrim } from '../anim/procedural.js';\n"
         "import { SkinnedMech, PropMech, clusterRobot } from '../entities/mechs.js';\n"
         "import { renderer } from './state.js';\n")
    + gm + "\n")

# ---------- src/main.js ----------
open('src/main.js', 'w').write(
"""/* ============================ ENTRY POINT =================================
 * Boots the game and exposes test hooks (window.__BOOT_DONE / __GAME_STATE)
 * consumed by tests/pwcheck.py.
 * ==========================================================================*/
'use strict';

import { showFatal } from './core/util.js';
import { Game } from './game/game.js';

const game = new Game();
window.__game = game;             // debug handle
window.__GAME_STATE = 'LOADING';
const _origSetOverlay = Game.prototype.setOverlay;
Game.prototype.setOverlay = function (n) {
  window.__GAME_STATE = this.state;
  _origSetOverlay.call(this, n);
};
game.boot().catch((e) => { showFatal('boot error: ' + ((e && e.stack) || e)); window.__BOOT_DONE = true; });
""")

print("modules written OK")
