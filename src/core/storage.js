/**
 * Player profile — scrap balance, unlocked cosmetics, equipped loadout.
 * Persists to localStorage so unlocks survive between sessions.
 */
import { DEFAULT_LOADOUT, freeItemKeys, ITEMS } from '../game/cosmetics.js';

const KEY = 'wreckpark.profile.v1';
// The replay blob lives under its own key. It is ~100 KB, and if it ever hits
// the storage quota it must not take the profile (scrap, unlocks) down with it.
const RUN_KEY = 'wreckpark.bestrun.v1';

function blank() {
  return {
    name: '',
    car: 'ripsaw',
    scrap: 0,
    lifetimeScrap: 0,
    unlocked: freeItemKeys(),
    loadout: { ...DEFAULT_LOADOUT },
    stats: { rounds: 0, wins: 0, wrecks: 0, bestTrick: 0 },
    quality: 'high',
    uiScale: 1.0,   // multiplier on top of the automatic screen-size fit
  };
}

let profile = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return blank();
    const p = { ...blank(), ...JSON.parse(raw) };
    p.loadout = { ...DEFAULT_LOADOUT, ...(p.loadout || {}) };
    p.stats = { ...blank().stats, ...(p.stats || {}) };
    // Free items should always be present even if the catalog grew.
    const free = freeItemKeys();
    p.unlocked = [...new Set([...(p.unlocked || []), ...free])];
    return p;
  } catch {
    return blank();
  }
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(profile)); } catch { /* private mode */ }
}

export const Profile = {
  get() { return profile; },

  get scrap() { return profile.scrap; },
  get loadout() { return profile.loadout; },

  setName(n) { profile.name = n.slice(0, 14); save(); },
  setCar(id) { profile.car = id; save(); },
  setQuality(q) { profile.quality = q; save(); },
  setUiScale(v) { profile.uiScale = v; save(); },

  addScrap(n) {
    profile.scrap += n;
    profile.lifetimeScrap += n;
    save();
  },

  owns(cat, id) {
    return profile.unlocked.includes(`${cat}:${id}`);
  },

  /** Attempts a purchase. Returns true on success. */
  buy(cat, id) {
    const item = (ITEMS[cat] || []).find((i) => i.id === id);
    if (!item || this.owns(cat, id)) return false;
    if (profile.scrap < item.cost) return false;
    profile.scrap -= item.cost;
    profile.unlocked.push(`${cat}:${id}`);
    save();
    return true;
  },

  equip(cat, id) {
    if (!this.owns(cat, id)) return false;
    profile.loadout[cat] = id;
    save();
    return true;
  },

  recordRound({ won, wrecks, bestTrick }) {
    profile.stats.rounds++;
    if (won) profile.stats.wins++;
    profile.stats.wrecks += wrecks || 0;
    if (bestTrick > profile.stats.bestTrick) profile.stats.bestTrick = bestTrick;
    save();
  },

  /** How many items are still locked — used to show "new stuff available". */
  lockedCount() {
    let n = 0;
    for (const cat of Object.keys(ITEMS)) {
      for (const item of ITEMS[cat]) if (!this.owns(cat, item.id)) n++;
    }
    return n;
  },

  reset() { profile = blank(); save(); },
};

/**
 * The best solo trick run ever recorded, with its replay.
 * Only one is kept — the point is "beat your best", not an archive.
 */
export const BestRun = {
  get() {
    try {
      const raw = localStorage.getItem(RUN_KEY);
      if (!raw) return null;
      const rec = JSON.parse(raw);
      return rec && rec.data && rec.frames > 0 ? rec : null;
    } catch {
      return null;
    }
  },

  get score() { return this.get()?.score ?? 0; },

  /** Saves only if it beats the existing best. Returns true if it was a record. */
  saveIfBest(rec) {
    if (!rec || !(rec.score > 0)) return false;   // a scoreless run is not a best
    const current = this.get();
    if (current && current.score >= rec.score) return false;
    try {
      localStorage.setItem(RUN_KEY, JSON.stringify(rec));
      return true;
    } catch (err) {
      // Quota exceeded: keep the score even if the replay will not fit.
      try {
        localStorage.setItem(RUN_KEY, JSON.stringify({ ...rec, data: '', frames: 0, events: [] }));
      } catch { /* nothing more we can do */ }
      console.warn('[wreckpark] could not store the replay', err);
      return true;
    }
  },

  clear() {
    try { localStorage.removeItem(RUN_KEY); } catch { /* ignore */ }
  },
};
