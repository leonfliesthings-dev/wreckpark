/**
 * Wire protocol, shared by the client and the server.
 *
 * Physics is simulated on each client for its own car; the server relays
 * transforms and owns match state and the scoreboard. With a handful of mates
 * on a private room that is the right trade: zero input latency on your own
 * car, and no way to argue about the score.
 */

export const PROTOCOL_VERSION = 3;

// ── client -> server ──
export const C2S = {
  JOIN: 'join',
  STATE: 'state',
  READY: 'ready',
  MODE: 'mode',
  WRECKED: 'wrecked',   // "I was destroyed", with who did it
  TRICK: 'trick',       // "I banked a combo"
  RESPAWN: 'respawn',
  CHAT: 'chat',
  PING: 'ping',
  FIRE: 'fire',       // weapon discharged
  DEPLOY: 'deploy',   // countermeasure dropped
};

// ── server -> client ──
export const S2C = {
  WELCOME: 'welcome',
  JOINED: 'joined',
  LEFT: 'left',
  SNAP: 'snap',
  MATCH: 'match',
  SCORES: 'scores',
  EVENT: 'event',
  CHAT: 'chat',
  ERROR: 'error',
  PONG: 'pong',
  FIRE: 'fire',
  DEPLOY: 'deploy',
};

export const PHASE = {
  LOBBY: 'lobby',
  COUNTDOWN: 'countdown',
  LIVE: 'live',
  RESULTS: 'results',
};

export const MODES = {
  derby: {
    id: 'derby',
    name: 'SMASH DERBY',
    duration: 240,
    lives: 3,
    scoreLabel: 'PTS',
    points: { wreck: 100, survive: 60, win: 300 },
  },
  tricks: {
    id: 'tricks',
    name: 'TRICK BATTLE',
    duration: 180,
    lives: 0,
    scoreLabel: 'SCORE',
    points: { win: 0 },
  },
};

export const MAX_PLAYERS = 8;
export const SNAPSHOT_HZ = 20;

// ── state flag bits ──
export const FLAG = {
  BOOST: 1 << 0,
  AIRBORNE: 1 << 1,
  DRIFT: 1 << 2,
  DEAD: 1 << 3,
  BRAKING: 1 << 4,
};

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

/** Packs one car's transform for the wire. */
export function packState(car) {
  const p = car.position, q = car.rotation, v = car.velocity;
  return {
    p: [r2(p.x), r2(p.y), r2(p.z)],
    q: [r3(q.x), r3(q.y), r3(q.z), r3(q.w)],
    v: [r2(v.x), r2(v.y), r2(v.z)],
    f: (car.boosting ? FLAG.BOOST : 0)
      | (car.airborne ? FLAG.AIRBORNE : 0)
      | (car.slip > 0.35 ? FLAG.DRIFT : 0)
      | (car.alive ? 0 : FLAG.DEAD),
    h: Math.round(car.health),
  };
}

/** Four unambiguous characters — no O/0 or I/1 confusion over voice chat. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeRoomCode(rng = Math.random) {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)];
  return s;
}

export function normalizeCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
}

export function sanitizeName(s) {
  const clean = String(s || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 14);
  return clean || 'DRIVER';
}
