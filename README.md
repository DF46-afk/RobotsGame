# MECHSIGHT — Zero-Dependency WebGL2 Mech Combat

A browser-based third-person mech combat game built entirely with vanilla
JavaScript and raw **WebGL2** — no Three.js, no bundlers, no npm packages.
Robots are skinned procedurally from GLB assets; the world, particles, audio
and UI are all generated in code.

## Features

- **Zero runtime dependencies** — pure ES modules + WebGL2 + WebAudio.
- **Wave-based combat** with pulse cannon, lock-on missiles, boost & jump.
- **Procedural animation & skinning** of rigged GLB mech models
  (`kitsune_harpy_rig.glb`, `kid_war_robots.glb`).
- **Vast city arena** streamed from `city.glb` with collision and lightmaps.
- **Mech Hangar** — preview/orbit screen to select your machine
  (`atlas_hangar_ld.glb`).
- Retro-scanline HUD, overlay state machine (menu → hangar → gameplay → pause).

## Project structure

```
index.html            Page shell: canvas, HUD, menu/hangar/pause overlays
css/ui.css            HUD & overlay styling (scanlines, meters, panels)
src/
  main.js             Startup entry point, boots Game, exposes test hooks
  core/               math (vec/mat/quat), config constants, util helpers,
                      procedural WebAudio synth
  render/             WebGL2 renderer: shaders, FBO post-FX, batched draws
  world/              GLB parser, asset builders, collision queries
  anim/               Procedural walk/idle/aim animation for rigs
  entities/           Mech controllers (player + enemy AI archetypes)
  game/               Main loop, input, state machine, waves, camera
*.glb                 Binary assets loaded at runtime via fetch()
tests/pwcheck.py      Playwright smoke test (boot + console-error check)
tools/, analysis/     Dev scripts used to split/refactor the original file
```

## Running locally

Any static file server works (fetch of `.glb` files requires HTTP, not
`file://`):

```bash
cd /workspace
python3 -m http.server 8765
# open http://localhost:8765/index.html
```

Requires a browser with WebGL2 (Chrome/Edge/Firefox/Safari 15+).

## Controls

| Input          | Action                     |
|----------------|----------------------------|
| `W A S D`      | Thrust / strafe            |
| `Mouse`        | Look & aim (pointer lock)  |
| `LMB` / `RMB`  | Fire / lock-on             |
| `Shift` / `Space` | Boost / jump          |
| `R` / `Esc`    | Reload / pause             |

## Testing

The Playwright smoke test boots the page headlessly (SwiftShader WebGL),
waits for `window.__BOOT_DONE`, and dumps game state plus any console errors:

```bash
python3 -m http.server 8765 &      # serve the game
python3 tests/pwcheck.py           # needs: pip install playwright
                                   #       playwright install chromium
```

Global hooks available in the console for debugging:
`window.__game` (Game instance) and `window.__GAME_STATE` (current state).

## Known issues / TODO

- Duplicate `requestAnimationFrame` kick may still exist after the loading
  fix — verify only one loop is scheduled in `src/game/game.js`.
- Modules referenced by `_s` should be exported explicitly; check imports.
- No FBO completeness fallback yet — low-end drivers may fail on float
  textures; consider RGBA16F → RGBA8 degradation.
- Assets load sequentially; parallelizing `fetchGLB` calls would cut boot
  time significantly.
- Triangle stats counter reports incorrect totals in the debug HUD.
- Large `.glb` binaries (~40 MB total) are committed to the repo; consider
  Git LFS or external CDN hosting for production.

## License

© 2026 — All rights reserved (prototype).
