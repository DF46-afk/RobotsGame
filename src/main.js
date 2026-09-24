/* AUTO-MOVED from the original single-file index.html — do not hand-edit
 * section contents without checking against git history. */
'use strict';

import { showFatal } from './core/util.js';
import { Game, game } from './game/game.js';

/* ============================ STARTUP ==================================== */
window.__game = game;
window.__GAME_STATE = 'LOADING';
const _origSetOverlay = Game.prototype.setOverlay;
Game.prototype.setOverlay = function (n) {
  window.__GAME_STATE = this.state;
  _origSetOverlay.call(this, n);
};
game.boot().catch((e) => { showFatal('boot error: ' + ((e && e.stack) || e)); window.__BOOT_DONE = true; });
