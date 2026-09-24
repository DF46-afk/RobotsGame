/* AUTO-MOVED from the original single-file index.html — do not hand-edit
 * section contents without checking against git history. */
'use strict';

/* ==========================================================================
 * === UTIL ================================================================
 * ==========================================================================*/
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
/** easeInOutCubic — used by the step-bob curve. */
const easeInOutCubic = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const rnd = (a = 1, b) => b === undefined ? Math.random() * a : a + Math.random() * (b - a);
const rndi = (n) => (Math.random() * n) | 0;
/** Frame-rate independent exponential smoothing factor. */
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);
const DEG = Math.PI / 180;

let LOAD_ERRORS = 0;
/** Log a line into the loading console + devtools. Never throws. */
function logLine(msg, isErr) {
  const box = $('logBox');
  if (box) {
    const d = document.createElement('div');
    d.innerHTML = (isErr ? '<b>[warn]</b> ' : '&gt; ') + msg;
    box.appendChild(d); box.scrollTop = box.scrollHeight;
  }
  (isErr ? console.warn : console.log)('[metascape] ' + msg);
  if (isErr) LOAD_ERRORS++;
}
function showFatal(msg) {
  const e = $('err'); e.style.display = 'block'; e.textContent += msg + '\n';
  console.error('[metascape][fatal] ' + msg);
}


export { $, DEG, clamp, damp, easeInOutCubic, lerp, logLine, rnd, rndi, showFatal, smoothstep };
