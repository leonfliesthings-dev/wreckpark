export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothTo = (cur, target, rate, dt) => lerp(cur, target, 1 - Math.exp(-rate * dt));
export const rand = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));
export const randInt = (a, b) => Math.floor(rand(a, b + 1));
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const deg = (r) => (r * 180) / Math.PI;
export const rad = (d) => (d * Math.PI) / 180;

/**
 * Seeded PRNG (mulberry32). Anything that affects the shared world — prop
 * placement especially — must use this so every player's arena is identical.
 */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Formats seconds as m:ss */
export function fmtTime(sec) {
  sec = Math.max(0, Math.ceil(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 12345 -> "12,345" */
export function fmtNum(n) {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Deterministic-ish colour per player slot. */
export const PLAYER_COLORS = [
  0xff6a1f, 0x22e0ff, 0x46e08a, 0xffd23f,
  0xff3fae, 0x9b4bff, 0xff3b52, 0x8bff2e,
];

export function playerColor(i) {
  return PLAYER_COLORS[i % PLAYER_COLORS.length];
}

export function hexCss(hex) {
  return '#' + hex.toString(16).padStart(6, '0');
}
