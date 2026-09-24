# Changelog

## v1.0.0 — 2026-09-24
First playable release of MECHSIGHT.

### Fixed
- Black screen on startup: FBO now requests renderable color formats with RGBA8 fallback when HDR float textures are unsupported.
- Loading overlay animation freeze: the render loop now starts before asset preparation in `boot()`.
- Sampler/texture format mismatch warnings via automatic float-texture capability detection.

### Added
- Zero-dependency WebGL2 renderer: deferred lighting, shadows, post-processing (bloom, tonemap).
- Full game flow: menu → briefing → waves of enemy mechs → boss → score/game over.
- GLB asset pipeline (city.glb arena, hangar atlas, kitsune rig, warbot templates split into 3 robot types).
- Procedural mech animation, WebAudio SFX, HUD with hull/boost/heat/targeting readouts.
- Playwright smoke test (`tests/pwcheck.py`) and README with run instructions.
