/**
 * All audio is synthesised at runtime with the Web Audio API — no asset files,
 * nothing to download, works offline.
 */

let ctx = null;
let master = null;
let ready = false;
let muted = false;
let volume = 0.55;

// continuous voices for the local car
let engine = null;
let wind = null;
let screech = null;
let boostV = null;

let noiseBuffer = null;

function makeNoiseBuffer(seconds = 2) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function noiseSource(loop = true) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = loop;
  return src;
}

export const Audio = {
  init() {
    if (ready) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
    noiseBuffer = makeNoiseBuffer();
    buildEngine();
    buildAmbience();
    ready = true;
  },

  resume() {
    if (ctx && ctx.state === 'suspended') ctx.resume();
  },

  get enabled() { return ready && !muted; },

  setMuted(v) {
    muted = v;
    if (master) master.gain.value = v ? 0 : volume;
  },

  /** 0 = off, 1 = full. */
  setVolume(v) {
    volume = Math.max(0, Math.min(1, v));
    muted = volume === 0;
    if (master) master.gain.value = volume;
  },

  get volume() { return volume; },

  /** Silences the continuous driving voices (menus, spectating, death). */
  silenceCar() {
    if (!ready) return;
    engine.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
    wind.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
    screech.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
    boostV.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
  },

  /**
   * Per-frame update of the driving loop.
   * @param {object} s  { rpm 0..1, load 0..1, speed m/s, slip 0..1, boosting, airborne, electric }
   */
  updateCar(s) {
    if (!ready || muted) return;
    const t = ctx.currentTime;

    // --- engine ---
    // A petrol engine is not a siren. Without a gearbox the note just climbs
    // from idle to redline and sits there droning, which is what made this
    // grating. Gears make it rise, drop, and rise again like an actual car.
    const rev = s.electric ? this._evRev(s) : this._gearedRev(s);

    const base = s.electric ? 90 : 46;
    const span = s.electric ? 430 : 190;
    const f = base + rev * span;

    // slight detune between the two saws gives body instead of a flat buzz
    engine.osc1.frequency.setTargetAtTime(f, t, 0.05);
    engine.osc2.frequency.setTargetAtTime(f * 2.01, t, 0.05);
    engine.osc3.frequency.setTargetAtTime(f * 0.5, t, 0.06);

    // gentler, darker filter: the old resonant sweep was the harsh part
    engine.filter.frequency.setTargetAtTime(360 + rev * 1500 + s.load * 520, t, 0.06);
    engine.noiseGain.gain.setTargetAtTime(s.electric ? 0.004 : 0.014 + s.load * 0.03, t, 0.07);

    // much quieter off-throttle, so cruising and coasting are restful
    const engVol = (s.airborne ? 0.07 : 0.085) + s.load * 0.10;
    engine.gain.gain.setTargetAtTime(engVol, t, 0.07);

    // --- wind ---
    const spd = Math.min(1, s.speed / 55);
    wind.filter.frequency.setTargetAtTime(300 + spd * 2400, t, 0.1);
    wind.gain.gain.setTargetAtTime(spd * spd * 0.16, t, 0.12);

    // --- tyre screech ---
    screech.gain.gain.setTargetAtTime(s.slip * 0.13, t, 0.05);
    screech.filter.frequency.setTargetAtTime(1400 + s.slip * 1900, t, 0.06);

    // --- boost roar ---
    boostV.gain.gain.setTargetAtTime(s.boosting ? 0.19 : 0, t, s.boosting ? 0.03 : 0.12);
  },

  /**
   * Six-speed box. Each gear covers a slice of the speed range; within it the
   * revs climb from just off idle to the limiter, then drop as it shifts up.
   */
  _gearedRev(s) {
    const BANDS = [0.13, 0.27, 0.43, 0.61, 0.80, 1.01];
    const frac = Math.min(1, Math.abs(s.speed) / 55);
    let g = 0;
    while (g < BANDS.length - 1 && frac > BANDS[g]) g++;
    const lo = g === 0 ? 0 : BANDS[g - 1];
    const within = (frac - lo) / Math.max(0.01, BANDS[g] - lo);
    // idling revs pick up with the throttle even when stationary
    const idle = 0.16 + s.load * 0.22;
    const driving = 0.34 + 0.66 * Math.min(1, Math.max(0, within));
    return frac < 0.02 ? idle : Math.max(idle, driving);
  },

  /** No gearbox on an EV — a single clean rise is the right sound. */
  _evRev(s) {
    const frac = Math.min(1, Math.abs(s.speed) / 60);
    return 0.1 + frac * 0.9;
  },

  /** Metal-on-something impact. force 0..1 */
  impact(force) {
    if (!ready || muted) return;
    const t = ctx.currentTime;
    const v = Math.min(1, force);

    // body slam: filtered noise burst
    const n = noiseSource(false);
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = 220 + v * 900;
    nf.Q.value = 0.7;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.22 + v * 0.5, t + 0.005);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.1 + v * 0.25);
    n.connect(nf).connect(ng).connect(master);
    n.start(t); n.stop(t + 0.5);

    // low thud
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(140 + v * 60, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.16);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.3 + v * 0.45, t + 0.008);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    o.connect(og).connect(master);
    o.start(t); o.stop(t + 0.35);
  },

  /** Landing thump — softer than an impact. */
  land(force) {
    if (!ready || muted) return;
    const t = ctx.currentTime;
    const v = Math.min(1, force);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(95, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.11);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.1 + v * 0.24, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(g).connect(master);
    o.start(t); o.stop(t + 0.25);
  },

  explosion() {
    if (!ready || muted) return;
    const t = ctx.currentTime;

    const n = noiseSource(false);
    const nf = ctx.createBiquadFilter();
    nf.type = 'lowpass';
    nf.frequency.setValueAtTime(2600, t);
    nf.frequency.exponentialRampToValueAtTime(180, t + 0.9);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.85, t + 0.012);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    n.connect(nf).connect(ng).connect(master);
    n.start(t); n.stop(t + 1.2);

    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(24, t + 0.55);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.6, t + 0.01);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    o.connect(og).connect(master);
    o.start(t); o.stop(t + 0.8);
  },

  /** Rising chime as a trick combo grows. step = how many tricks deep. */
  trick(step) {
    if (!ready || muted) return;
    const t = ctx.currentTime;
    const scale = [0, 4, 7, 11, 14, 16, 19, 23, 26];
    const semi = scale[Math.min(step, scale.length - 1)];
    const f = 523.25 * Math.pow(2, semi / 12);
    for (let i = 0; i < 2; i++) {
      const o = ctx.createOscillator();
      o.type = i ? 'triangle' : 'sine';
      o.frequency.value = f * (i ? 2 : 1);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(i ? 0.06 : 0.14, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.36);
      o.connect(g).connect(master);
      o.start(t); o.stop(t + 0.4);
    }
  },

  /** Cash-in sound when a combo banks. */
  bank(mult) {
    if (!ready || muted) return;
    const t0 = ctx.currentTime;
    const n = Math.min(6, 2 + Math.floor(mult));
    for (let i = 0; i < n; i++) {
      const t = t0 + i * 0.055;
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = 660 * Math.pow(2, i / 12 * 2);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.07, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      o.connect(g).connect(master);
      o.start(t); o.stop(t + 0.18);
    }
  },

  /** Failed combo. */
  bail() {
    if (!ready || muted) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(300, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.11, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 900;
    o.connect(f).connect(g).connect(master);
    o.start(t); o.stop(t + 0.5);
  },

  beep(high = false) {
    if (!ready || muted) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = high ? 880 : 440;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.1, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (high ? 0.5 : 0.16));
    o.connect(g).connect(master);
    o.start(t); o.stop(t + 0.55);
  },

  ui(kind = 'click') {
    if (!ready || muted) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    const f = kind === 'hover' ? 900 : kind === 'buy' ? 1200 : 620;
    o.frequency.setValueAtTime(f, t);
    if (kind === 'buy') o.frequency.exponentialRampToValueAtTime(f * 1.7, t + 0.09);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(kind === 'hover' ? 0.022 : 0.06, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(g).connect(master);
    o.start(t); o.stop(t + 0.15);
  },
};

// ─────────────────────────────────────────────────────────────

function buildEngine() {
  const gain = ctx.createGain();
  gain.gain.value = 0;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 700;
  filter.Q.value = 0.9;      // was 3.2 - the resonance was doing the whining

  // sawtooth + a quieter octave + a sine sub. The old square wave was the
  // buzziest part of the mix.
  const osc1 = ctx.createOscillator(); osc1.type = 'sawtooth'; osc1.frequency.value = 60;
  const osc2 = ctx.createOscillator(); osc2.type = 'sawtooth'; osc2.frequency.value = 120;
  const osc3 = ctx.createOscillator(); osc3.type = 'sine';     osc3.frequency.value = 30;
  const g2 = ctx.createGain(); g2.gain.value = 0.14;
  const g3 = ctx.createGain(); g3.gain.value = 0.62;

  const noise = noiseSource();
  const noiseGain = ctx.createGain(); noiseGain.gain.value = 0.03;

  osc1.connect(filter);
  osc2.connect(g2).connect(filter);
  osc3.connect(g3).connect(filter);
  noise.connect(noiseGain).connect(filter);
  filter.connect(gain).connect(master);

  osc1.start(); osc2.start(); osc3.start(); noise.start();
  engine = { osc1, osc2, osc3, filter, gain, noiseGain };
}

function buildAmbience() {
  // wind
  {
    const src = noiseSource();
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass'; filter.frequency.value = 700; filter.Q.value = 0.5;
    const gain = ctx.createGain(); gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(master);
    src.start();
    wind = { filter, gain };
  }
  // tyre screech
  {
    const src = noiseSource();
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass'; filter.frequency.value = 1800; filter.Q.value = 7;
    const gain = ctx.createGain(); gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(master);
    src.start();
    screech = { filter, gain };
  }
  // boost
  {
    const src = noiseSource();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = 1500; filter.Q.value = 2;
    const gain = ctx.createGain(); gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(master);
    src.start();
    boostV = { filter, gain };
  }
}
