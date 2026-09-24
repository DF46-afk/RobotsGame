#!/usr/bin/env python3
"""Rebuild src/ modules from the original single-file index.html (git HEAD).

Sections are extracted verbatim by line ranges, then:
  * 'GL' singleton references -> renderer.current (state.js)
  * per-module import/export headers generated from a dependency table.
"""
import os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ORIG = '/tmp/orig.html'          # git show HEAD:index.html
SRC = os.path.join(ROOT, 'src')

lines = open(ORIG, encoding='utf-8').read().split('\n')  # 0-based; file line N = lines[N-1]

def sec(a, b):                   # inclusive 1-based line range
    return '\n'.join(lines[a-1:b]).strip('\n') + '\n'

# ---------------------------------------------------------------- sections --
S = {
 'CONFIG':      sec(254, 316),
 'UTIL':        sec(317, 348),
 'MATH':        sec(349, 631),
 'GLB':         sec(632, 1069),
 'SHADERS':     sec(1070, 1339),
 'RENDERER':    sec(1340, 1861),
 'PROCEDURAL':  sec(1862, 2339),
 'FALLBACK':    sec(2340, 2415),
 'AUDIO':       sec(2416, 2524),
 'COLLISION':   sec(2525, 2578),
 'WORLD':       sec(2579, 2872),
 'SKINNED':     sec(2873, 3173),
 'PROP':        sec(3174, 3282),
 'GAME_HEAD':   sec(3283, 3288),   # header comment + 'let GL = null;'
 'MECH_DEFS':   sec(3289, 3337),   # MECH_DEFS array (+ class Game start? check below)
 'GAME_BODY':   sec(3338, 4453),
 'STARTUP':     sec(4454, 4462),
}

# sanity: every section must be balanced-ish; print sizes
for k, v in S.items():
    print(f'{k:11s} {len(v.splitlines()):5d} lines')

# ------------------------------------------------------------- transforms --
def gl_to_renderer(text):
    # let GL = null;  -> drop (renderer.current used instead)
    text = text.replace('let GL = null;                 // Renderer singleton (SkinnedMech ctor uses it)\n', '')
    text = re.sub(r'\bGL\b(?!\w)', 'renderer.current', text)
    return text

# renderer.js cannot import showFatal from core/util.js (util -> renderer cycle
# via the shader helpers). The two call sites there log to console instead.
def util_cycle_fix(text):
    text = text.replace("showFatal('shader compile failed: ' + name);",
                        "console.error('[metascape] shader compile failed: ' + name);")
    text = text.replace("showFatal('program link failed ' + name + ': ' + gl.getProgramInfoLog(p));",
                        "console.error('[metascape] program link failed ' + name + ': ' + gl.getProgramInfoLog(p));")
    return text

FILES = {}  # path -> body text (without header/imports)

# NOTE: core/util.js must not import renderer/shaders (would create an import
# cycle util -> renderer -> util). The two shader-error call sites in the
# RENDERER section are rewritten to console.error instead (see FIX below).
FILES['core/config.js']     = {'sec': ['CONFIG'], 'deps': []}
FILES['core/util.js']       = {'sec': ['UTIL'], 'deps': []}
FILES['core/math.js']       = {'sec': ['MATH'], 'deps': [('core/util.js', None)]}
FILES['render/shaders.js']  = {'sec': ['SHADERS'], 'deps': []}
FILES['render/renderer.js'] = {'sec': ['RENDERER'], 'deps': [
    ('core/config.js', None), ('core/math.js', None), ('core/util.js', None),
    ('render/shaders.js', None)]}
FILES['world/glb.js']       = {'sec': ['GLB'], 'deps': [('core/math.js', None), ('core/util.js', None)]}
FILES['core/audio.js']      = {'sec': ['AUDIO'], 'deps': [('core/config.js', None), ('core/util.js', None)]}
FILES['anim/procedural.js'] = {'sec': ['PROCEDURAL', 'FALLBACK'], 'deps': [
    ('core/config.js', None), ('core/math.js', None), ('core/util.js', None)]}
FILES['world/collision.js'] = {'sec': ['COLLISION'], 'deps': [
    ('core/config.js', None), ('core/math.js', None), ('core/util.js', None)]}
FILES['world/assets.js']    = {'sec': ['WORLD'], 'deps': [
    ('core/config.js', None), ('core/math.js', None), ('core/util.js', None),
    ('world/glb.js', None), ('render/renderer.js', None), ('anim/procedural.js', None),
    ('world/collision.js', None)]}
FILES['entities/mechs.js']  = {'sec': ['SKINNED', 'PROP'], 'deps': [
    ('core/config.js', None), ('core/math.js', None), ('core/util.js', None),
    ('render/renderer.js', None), ('anim/procedural.js', None),
    ('world/assets.js', None), ('game/state.js', ['renderer'])]}
FILES['game/game.js']       = {'sec': ['GAME_HEAD', 'MECH_DEFS', 'GAME_BODY'], 'deps': [
    ('core/config.js', None), ('core/math.js', None), ('core/util.js', None),
    ('core/audio.js', None), ('render/renderer.js', None), ('game/state.js', None),
    ('world/glb.js', None), ('world/assets.js', None), ('anim/procedural.js', None),
    ('entities/mechs.js', None), ('world/collision.js', None)]}
FILES['main.js']            = {'sec': ['STARTUP'], 'deps': [
    ('core/util.js', None), ('game/game.js', None)]}

STATE_JS = """/* ==========================================================================
 * === RENDERER SINGLETON ====================================================
 * The original single-file build kept a module-level `let GL` that both the
 * game and the mech classes read. In the modular layout this tiny module owns
 * that slot, which breaks the renderer <-> entities <-> game import cycle.
 * ==========================================================================*/
'use strict';

export const renderer = { current: null };
"""

# ------------------------------------------------------------ identifiers ---
DECL_RE = re.compile(
    r'^[ \t]*(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)\b'
    r'|^[ \t]*function[ \t]+([A-Za-z_$][\w$]*)\b'
    r'|^[ \t]*class[ \t]+([A-Za-z_$][\w$]*)\b', re.M)

def top_decls(text):
    out, depth = [], 0
    for ln in text.split('\n'):
        st = ln.strip()
        if depth == 0:
            m = DECL_RE.match(ln)
            if m:
                name = m.group(1) or m.group(2) or m.group(3)
                if name: out.append(name)
        depth += ln.count('{') + ln.count('(') + ln.count('[') \
               - ln.count('}') - ln.count(')') - ln.count(']')
    return out

USE_RE = lambda n: re.compile(r'\b' + re.escape(n) + r'\b')

def collect_exports(files_map):
    """returns dict path -> list of exported names (declared & used elsewhere)"""
    all_text = '\n'.join(b for b in files_map.values())
    exports = {}
    for path, body in files_map.items():
        names = []
        for n in top_decls(body):
            # count usages outside this file's own declarations region
            others = '\n'.join(b for p, b in files_map.items() if p != path)
            if USE_RE(n).search(others):
                names.append(n)
        exports[path] = names
    return exports

# --------------------------------------------------------------- imports ----
def needed_names(body_own, dep_bodies):
    """names imported from a dep = declared there and referenced in body_own."""
    res = []
    for dn in top_decls(dep_bodies):
        if USE_RE(dn).search(body_own) and dn not in top_decls(body_own):
            res.append(dn)
    return res

REL = lambda a, b: os.path.relpath(b, os.path.dirname(a)) if os.path.dirname(a) else b

# ------------------------------------------------------------------ build ---
bodies = {}
for path, spec in FILES.items():
    body = ''.join(S[k] for k in spec['sec'])
    body = gl_to_renderer(body)
    if path == 'render/renderer.js':
        body = util_cycle_fix(body)
    bodies[path] = body

# game/game.js owns the Renderer singleton slot assignment:
bodies['game/game.js'] = bodies['game/game.js'].replace(
    'renderer.current = this.r = new Renderer(canvas);',
    'this.r = new Renderer(canvas);\n      renderer.current = this.r;')

# main.js bootstraps via the exported `game` singleton (STARTUP section used
# to create it locally). Import the singleton instead of Game.
FILES['main.js']['deps'] = [('core/util.js', None), ('game/game.js', ['game'])]

def clean_exports(path, names):
    """drop GLSL false positives and locals that leaked through brace counting"""
    bad = {'float', 'bl', 'px', 'map', '_s', 'ANISO'}
    keep = [n for n in names if n not in bad]
    return keep

exports = collect_exports(dict(bodies))
exports = {p: clean_exports(p, ns) for p, ns in exports.items()}
# the `game` singleton lives at the bottom of game/game.js (see below);
# declare it so import generation can pick it up.
exports['game/game.js'] = sorted(set(exports['game/game.js']) | {'game'})
bodies['game/game.js'] += "\nexport const game = new Game();\n"
bodies['main.js'] = bodies['main.js'].replace('const game = new Game();', 'window.__game = game;')
# force-list exports for names referenced across files
print('\nExports:')
for p, names in exports.items():
    print(' ', p, names)

os.makedirs(SRC, exist_ok=True)

HEADER = """/* AUTO-MOVED from the original single-file index.html — do not hand-edit
 * section contents without checking against git history. */
'use strict';

"""

written = []
for path, spec in FILES.items():
    body = bodies[path]
    imports = []
    for dep_path, forced in spec['deps']:
        names = sorted(set(exports.get(dep_path, []) + (forced or [])) - set(top_decls(body)))
        # only import names actually referenced here
        names = [n for n in names if USE_RE(n).search(body)]
        if names:
            rel = REL(path, dep_path)
            imports.append("import { %s } from '%s';" % (', '.join(names), rel))
    exp_lines = ['export { %s };' % ', '.join(exports[path]) if exports.get(path) else '']
    out = HEADER
    if imports: out += '\n'.join(imports) + '\n\n'
    out += body
    if exports.get(path):
        out += '\n\nexport { %s };\n' % ', '.join(sorted(exports[path]))
    full = os.path.join(ROOT, 'src', path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    open(full, 'w', encoding='utf-8').write(out)
    written.append(full)

open(os.path.join(ROOT, 'src/game/state.js'), 'w').write(STATE_JS)
written.append(os.path.join(ROOT, 'src/game/state.js'))
print('\nwrote', len(written), 'files')
