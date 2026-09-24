/* ==========================================================================
 * === RENDERER SINGLETON ====================================================
 * The original single-file build kept a module-level `let GL` that both the
 * game and the mech classes read. In the modular layout this tiny module owns
 * that slot, which breaks the renderer <-> entities <-> game import cycle.
 * ==========================================================================*/
'use strict';

export const renderer = { current: null };
