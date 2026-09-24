/* AUTO-MOVED from the original single-file index.html — do not hand-edit
 * section contents without checking against git history. */
'use strict';

import { CONFIG } from './config.js';
import { clamp, logLine } from './util.js';

/* ==========================================================================
 * === AUDIO ================================================================
 * Fully synthesised Web Audio: no samples fetched anywhere.
 * ==========================================================================*/
class AudioEngine {
  constructor() {
    this.ctx = null; this.master = null; this.musicGain = null; this.sfxGain = null;
    this.noiseBuf = null; this.enabled = false; this._musicTimer = 0;
  }
  /** Must be called from a user gesture (browser autoplay policy). */
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -18; comp.ratio.value = 6; comp.attack.value = 0.003; comp.release.value = 0.25;
      this.master = this.ctx.createGain(); this.master.gain.value = CONFIG.audio.master;
      this.sfxGain = this.ctx.createGain(); this.sfxGain.gain.value = CONFIG.audio.sfx;
      this.musicGain = this.ctx.createGain(); this.musicGain.gain.value = CONFIG.audio.music;
      this.sfxGain.connect(comp); this.musicGain.connect(comp);
      comp.connect(this.master); this.master.connect(this.ctx.destination);
      // 2 second noise buffer reused by all percussive sounds
      const len = this.ctx.sampleRate * 2;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.enabled = true;
    } catch (e) { logLine('audio unavailable: ' + e.message, true); }
  }
  get t() { return this.ctx ? this.ctx.currentTime : 0; }
  noise(dur, freq, q, gain, type = 'bandpass', pan = 0) {
    if (!this.enabled) return;
    const ctx = this.ctx, t0 = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    src.connect(f); f.connect(g);
    if (p) { p.pan.value = clamp(pan, -1, 1); g.connect(p); p.connect(this.sfxGain); }
    else g.connect(this.sfxGain);
    src.start(t0); src.stop(t0 + dur + 0.05);
  }
  tone(freq, dur, gain, type = 'sine', slideTo = 0, delay = 0, detune = 0) {
    if (!this.enabled) return;
    const ctx = this.ctx, t0 = ctx.currentTime + delay;
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (detune) o.detune.value = detune;
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(this.sfxGain);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
  cannon() {
    this.tone(190, 0.28, 0.55, 'square', 42);
    this.tone(88, 0.4, 0.5, 'sine', 30);
    this.noise(0.22, 1700, 0.9, 0.35, 'highpass');
  }
  impact(vol = 0.5) {
    this.noise(0.16, 620, 1.4, vol * 0.5);
    this.tone(150, 0.12, vol * 0.35, 'triangle', 60);
  }
  explode() {
    this.noise(0.75, 320, 0.7, 0.7, 'lowpass');
    this.tone(70, 0.6, 0.6, 'sine', 24);
    this.noise(0.35, 2600, 1.2, 0.25, 'bandpass');
  }
  lockBeep() { this.tone(1180, 0.07, 0.2, 'sine'); this.tone(1560, 0.06, 0.14, 'sine', 0, 0.07); }
  dryClick() { this.tone(2200, 0.03, 0.12, 'square', 1400); }
  reload() {
    this.noise(0.06, 2400, 3, 0.2); this.noise(0.06, 1800, 3, 0.2);
    this.tone(420, 0.1, 0.18, 'square', 700, 0.42);
  }
  footfall(vol = 0.3) { this.noise(0.12, 240, 1.1, vol * 0.4, 'lowpass'); this.tone(60, 0.1, vol * 0.3, 'sine', 40); }
  jumpJet() { this.noise(0.35, 900, 0.6, 0.25, 'bandpass'); this.tone(320, 0.3, 0.2, 'sawtooth', 90); }
  hurt() { this.noise(0.2, 300, 0.8, 0.4, 'lowpass'); this.tone(120, 0.25, 0.3, 'square', 55); }
  uiTick() { this.tone(880, 0.05, 0.1, 'sine'); this.tone(1320, 0.05, 0.07, 'sine', 0, 0.05); }
  waveStart() {
    this.tone(330, 0.5, 0.2, 'sawtooth', 330, 0);
    this.tone(494, 0.5, 0.16, 'sawtooth', 494, 0.12);
    this.tone(660, 0.7, 0.14, 'sawtooth', 660, 0.24);
  }
  /** Simple procedural tension bed: low pulse + filtered noise pad. */
  music(intensity) {
    if (!this.enabled) return;
    const now = this.t();
    if (now - this._musicTimer < 0.5) return;
    this._musicTimer = now;
    const ctx = this.ctx, t0 = now;
    const notes = [55, 55, 73.4, 65.4];
    const f = notes[(Math.random() * notes.length) | 0];
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.value = 180 + intensity * 700; lp.Q.value = 4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.10 + intensity * 0.06, t0 + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.46);
    o.connect(lp); lp.connect(g); g.connect(this.musicGain);
    o.start(t0); o.stop(t0 + 0.5);
  }
}
const audio = new AudioEngine();


export { audio };
