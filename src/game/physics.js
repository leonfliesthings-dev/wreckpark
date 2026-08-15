/**
 * Rapier world setup + helpers shared by the arena, cars, props and debris.
 */
import RAPIER from '@dimforge/rapier3d-compat';

export { RAPIER };

// ── collision groups ───────────────────────────────────────────
export const G = {
  WORLD:  0x0001,
  CAR:    0x0002,   // the local player's car
  REMOTE: 0x0004,   // network ghosts (still solid, so ramming works)
  DEBRIS: 0x0008,
  PROP:   0x0010,   // smashable barrels / crates
  PICKUP: 0x0020,   // sensors
};

/** Rapier packs interaction groups as (membership << 16) | filter. */
export const groups = (membership, filter) => ((membership << 16) | filter) >>> 0;

const ALL_SOLID = G.WORLD | G.CAR | G.REMOTE | G.DEBRIS | G.PROP;

export const GROUPS = {
  world:  groups(G.WORLD,  ALL_SOLID),
  car:    groups(G.CAR,    ALL_SOLID | G.PICKUP),
  remote: groups(G.REMOTE, ALL_SOLID),
  debris: groups(G.DEBRIS, G.WORLD | G.PROP | G.DEBRIS),   // debris ignores cars, avoids shove-fests
  prop:   groups(G.PROP,   ALL_SOLID),
  pickup: groups(G.PICKUP, G.CAR),
};

// Heavier than real life for snappy arcs, but not so heavy that jumps feel
// stunted. Lowered from -21.5 after playtesting: floatier air, longer hang time.
export const GRAVITY = -18.0;
export const TIMESTEP = 1 / 60;

let inited = false;

export async function initPhysics() {
  if (!inited) {
    await RAPIER.init();
    inited = true;
  }
}

export function createWorld() {
  const world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
  world.timestep = TIMESTEP;
  // A few extra iterations keeps stacked props and heavy cars from sinking.
  world.numSolverIterations = 6;
  return world;
}

/**
 * Builds a static trimesh collider straight from a three.js BufferGeometry
 * that has already been baked into world space.
 */
export function addStaticTrimesh(world, geometry, opts = {}) {
  const pos = geometry.attributes.position.array;
  let idx = geometry.index ? geometry.index.array : null;
  if (!idx) {
    idx = new Uint32Array(pos.length / 3);
    for (let i = 0; i < idx.length; i++) idx[i] = i;
  }
  const verts = pos instanceof Float32Array ? pos : new Float32Array(pos);
  const indices = idx instanceof Uint32Array ? idx : new Uint32Array(idx);

  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const desc = RAPIER.ColliderDesc.trimesh(verts, indices)
    .setFriction(opts.friction ?? 1.0)
    .setRestitution(opts.restitution ?? 0.15)
    .setCollisionGroups(GROUPS.world);
  const collider = world.createCollider(desc, body);
  return { body, collider };
}

/** Static box — cheaper and more robust than a trimesh for simple slabs. */
export function addStaticBox(world, half, pos, quat, opts = {}) {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed()
      .setTranslation(pos.x, pos.y, pos.z)
      .setRotation(quat || { x: 0, y: 0, z: 0, w: 1 })
  );
  const desc = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
    .setFriction(opts.friction ?? 1.0)
    .setRestitution(opts.restitution ?? 0.15)
    .setCollisionGroups(GROUPS.world);
  const collider = world.createCollider(desc, body);
  return { body, collider };
}

/** Reusable scratch vectors so the hot loop allocates nothing. */
export const tmp = {
  v1: { x: 0, y: 0, z: 0 },
  v2: { x: 0, y: 0, z: 0 },
  q1: { x: 0, y: 0, z: 0, w: 1 },
};

export function vlen(v) {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

export function vdist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
