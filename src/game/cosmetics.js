/**
 * Cosmetic catalog. Everything here is purely visual — deliberately no stat
 * changes, so nobody can buy an advantage over their mates.
 *
 * `cost: 0` items are owned from the start.
 */

export const CATEGORIES = [
  { id: 'paint',     name: 'Paint' },
  { id: 'finish',    name: 'Finish' },
  { id: 'livery',    name: 'Livery' },
  { id: 'spoiler',   name: 'Spoiler' },
  { id: 'roof',      name: 'Roof' },
  { id: 'wheels',    name: 'Wheels' },
  { id: 'bumper',    name: 'Bumper' },
  { id: 'underglow', name: 'Underglow' },
  { id: 'trail',     name: 'Boost Trail' },
];

export const ITEMS = {
  paint: [
    { id: 'stock',     name: 'Factory',      cost: 0,    color: null }, // null = car's own colour
    { id: 'blood',     name: 'Blood Red',    cost: 0,    color: 0xc4142a },
    { id: 'midnight',  name: 'Midnight',     cost: 0,    color: 0x141a2e },
    { id: 'bone',      name: 'Bone',         cost: 60,   color: 0xe8e2d0 },
    { id: 'toxic',     name: 'Toxic',        cost: 60,   color: 0x9bff2e },
    { id: 'tangerine', name: 'Tangerine',    cost: 90,   color: 0xff7a18 },
    { id: 'bubblegum', name: 'Bubblegum',    cost: 90,   color: 0xff5fa8 },
    { id: 'deepsea',   name: 'Deep Sea',     cost: 120,  color: 0x0f5fa8 },
    { id: 'violet',    name: 'Ultraviolet',  cost: 150,  color: 0x8b4bff },
    { id: 'rust',      name: 'Rust Bucket',  cost: 150,  color: 0x7a4a24 },
    { id: 'mint',      name: 'Mint',         cost: 200,  color: 0x6fffd2 },
    { id: 'void',      name: 'Void Black',   cost: 320,  color: 0x05060a },
  ],

  finish: [
    { id: 'gloss',   name: 'Gloss',      cost: 0,    rough: 0.28, metal: 0.30 },
    { id: 'matte',   name: 'Matte',      cost: 80,   rough: 0.92, metal: 0.05 },
    { id: 'satin',   name: 'Satin',      cost: 140,  rough: 0.55, metal: 0.20 },
    { id: 'metallic',name: 'Metallic',   cost: 220,  rough: 0.22, metal: 0.85 },
    { id: 'chrome',  name: 'Chrome',     cost: 420,  rough: 0.04, metal: 1.0 },
    { id: 'neon',    name: 'Neon Glow',  cost: 560,  rough: 0.35, metal: 0.2, emissive: 0.85 },
    { id: 'gold',    name: 'Solid Gold', cost: 900,  rough: 0.12, metal: 1.0, forceColor: 0xffc23a },
    { id: 'holo',    name: 'Holographic', cost: 1200, rough: 0.10, metal: 0.9, holo: true },
  ],

  livery: [
    { id: 'none',    name: 'Clean',        cost: 0,   pattern: null },
    { id: 'stripes', name: 'Race Stripes', cost: 70,  pattern: 'stripes' },
    { id: 'checker', name: 'Checkers',     cost: 110, pattern: 'checker' },
    { id: 'flames',  name: 'Flames',       cost: 190, pattern: 'flames' },
    { id: 'camo',    name: 'Camo',         cost: 190, pattern: 'camo' },
    { id: 'hazard',  name: 'Hazard Tape',  cost: 240, pattern: 'hazard' },
    { id: 'splatter',name: 'Splatter',     cost: 300, pattern: 'splatter' },
    { id: 'circuit', name: 'Circuit',      cost: 460, pattern: 'circuit' },
  ],

  spoiler: [
    { id: 'none',     name: 'None',       cost: 0,   kind: null },
    { id: 'ducktail', name: 'Ducktail',   cost: 90,  kind: 'ducktail' },
    { id: 'gt',       name: 'GT Wing',    cost: 180, kind: 'gt' },
    { id: 'monster',  name: 'Monster',    cost: 340, kind: 'monster' },
    { id: 'dual',     name: 'Dual Deck',  cost: 520, kind: 'dual' },
  ],

  roof: [
    { id: 'none',    name: 'Bare',        cost: 0,   kind: null },
    { id: 'scoop',   name: 'Air Scoop',   cost: 80,  kind: 'scoop' },
    { id: 'lights',  name: 'Light Bar',   cost: 160, kind: 'lights' },
    { id: 'fin',     name: 'Shark Fin',   cost: 220, kind: 'fin' },
    { id: 'spikes',  name: 'Roof Spikes', cost: 380, kind: 'spikes' },
    { id: 'siren',   name: 'Siren',       cost: 470, kind: 'siren' },
  ],

  wheels: [
    { id: 'stock',   name: 'Steelies',    cost: 0,   rim: 0x2a2f3a, spokes: 5 },
    { id: 'chrome',  name: 'Chrome',      cost: 100, rim: 0xd8dee8, spokes: 5, metal: 1.0 },
    { id: 'gold',    name: 'Gold Rims',   cost: 260, rim: 0xffc23a, spokes: 6, metal: 1.0 },
    { id: 'mesh',    name: 'Mesh',        cost: 190, rim: 0x808896, spokes: 10 },
    { id: 'blade',   name: 'Blades',      cost: 330, rim: 0xff4d2a, spokes: 3 },
    { id: 'neon',    name: 'Neon Rims',   cost: 480, rim: 0x22e0ff, spokes: 6, glow: true },
  ],

  bumper: [
    { id: 'stock',  name: 'Stock',      cost: 0,   kind: null },
    { id: 'rambar', name: 'Ram Bar',    cost: 120, kind: 'rambar' },
    { id: 'spikes', name: 'Spike Bar',  cost: 280, kind: 'spikes' },
    { id: 'plow',   name: 'Snow Plow',  cost: 400, kind: 'plow' },
    { id: 'wedge',  name: 'Wedge',      cost: 560, kind: 'wedge' },
  ],

  underglow: [
    { id: 'none',   name: 'Off',      cost: 0,   color: null },
    { id: 'cyan',   name: 'Cyan',     cost: 90,  color: 0x22e0ff },
    { id: 'pink',   name: 'Pink',     cost: 90,  color: 0xff3fae },
    { id: 'green',  name: 'Acid',     cost: 130, color: 0x8bff2e },
    { id: 'orange', name: 'Ember',    cost: 130, color: 0xff6a1f },
    { id: 'purple', name: 'Violet',   cost: 200, color: 0x9b4bff },
    { id: 'white',  name: 'Xenon',    cost: 280, color: 0xffffff },
  ],

  trail: [
    { id: 'fire',   name: 'Fire',     cost: 0,   color: 0xff8a1f },
    { id: 'ice',    name: 'Ice',      cost: 110, color: 0x7fdfff },
    { id: 'toxic',  name: 'Toxic',    cost: 160, color: 0x9bff2e },
    { id: 'plasma', name: 'Plasma',   cost: 240, color: 0xff3fae },
    { id: 'void',   name: 'Void',     cost: 380, color: 0x7a3fff },
    { id: 'gold',   name: 'Gold',     cost: 620, color: 0xffc23a },
  ],
};

/** Icons for the garage grid — keeps the UI readable without any image assets. */
export const CAT_ICON = {
  paint: '🎨', finish: '✨', livery: '🏁', spoiler: '🪽', roof: '🚨',
  wheels: '⚙️', bumper: '🛡️', underglow: '💡', trail: '🔥',
};

export const DEFAULT_LOADOUT = {
  paint: 'stock', finish: 'gloss', livery: 'none', spoiler: 'none', roof: 'none',
  wheels: 'stock', bumper: 'stock', underglow: 'none', trail: 'fire',
};

export function getItem(cat, id) {
  const list = ITEMS[cat] || [];
  return list.find((i) => i.id === id) || list[0];
}

/** Every zero-cost item is unlocked from the very first launch. */
export function freeItemKeys() {
  const keys = [];
  for (const cat of Object.keys(ITEMS)) {
    for (const item of ITEMS[cat]) if (item.cost === 0) keys.push(`${cat}:${item.id}`);
  }
  return keys;
}
