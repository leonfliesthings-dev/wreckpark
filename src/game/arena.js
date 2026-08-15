/**
 * WRECKPARK — "The Pit".
 *
 * One enormous concrete bowl treated as a skatepark: a dished floor ringed by a
 * 20 m quarter-pipe you can carve and launch off, with a loop, a halfpipe, a
 * corkscrew tower, a mega gap and a pile of smashable junk in between.
 *
 * Everything is generated from geomKit primitives. Visual meshes are merged per
 * material; collision is one merged static trimesh plus a handful of primitives.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  arcPoints, prism, rampProfile, funboxProfile, sweepRibbon,
  loopFrames, helixFrames, railFrames, place,
} from './geomKit.js';
import { RAPIER, GROUPS, G, groups } from './physics.js';
import { makeRng } from '../core/util.js';

export const ARENA = {
  floorRadius: 105,
  wallTop: 125,
  wallHeight: 20,
  lipHeight: 30,
  dishRadius: 34,
  dishDepth: 4,
  killY: -40,        // below this you are respawned
  escapeRadius: 150, // beyond this too
};

// ── materials ──────────────────────────────────────────────────
function makeMaterials() {
  return {
    ground: new THREE.MeshStandardMaterial({
      color: 0x72787f, roughness: 0.95, metalness: 0.02, side: THREE.DoubleSide,
    }),
    ramp: new THREE.MeshStandardMaterial({
      color: 0x969ca6, roughness: 0.84, metalness: 0.04, side: THREE.DoubleSide,
    }),
    rampAlt: new THREE.MeshStandardMaterial({
      color: 0x828892, roughness: 0.88, metalness: 0.04, side: THREE.DoubleSide,
    }),
    metal: new THREE.MeshStandardMaterial({
      color: 0xa6adb8, roughness: 0.35, metalness: 0.85,
    }),
    paint: new THREE.MeshStandardMaterial({
      color: 0xff6a1f, roughness: 0.5, metalness: 0.1,
      emissive: 0xff6a1f, emissiveIntensity: 0.75,
    }),
    neon: new THREE.MeshStandardMaterial({
      color: 0x22e0ff, roughness: 0.4, metalness: 0.1,
      emissive: 0x22e0ff, emissiveIntensity: 1.5,
    }),
    hazard: new THREE.MeshStandardMaterial({
      color: 0xffd23f, roughness: 0.7, metalness: 0.15,
      emissive: 0xffd23f, emissiveIntensity: 0.22,
    }),
    prop: new THREE.MeshStandardMaterial({ color: 0xb35c2a, roughness: 0.8, metalness: 0.2 }),
    propAlt: new THREE.MeshStandardMaterial({ color: 0x6f7a86, roughness: 0.75, metalness: 0.35 }),
  };
}

// ── a little accumulator so we can merge by material ───────────
class Builder {
  constructor() {
    this.visual = new Map();   // matKey -> geometry[]
    this.collide = [];         // geometry[]
    this.footprints = new Map();
    this._cur = null;
  }

  /** Groups everything added until end() under one named footprint. */
  begin(name) {
    this._cur = name;
    this.footprints.set(name, { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity });
  }
  end() { this._cur = null; }

  add(matKey, geom, collide = true) {
    if (!this.visual.has(matKey)) this.visual.set(matKey, []);
    this.visual.get(matKey).push(geom);
    if (collide) {
      this.collide.push(geom);
      if (this._cur) {
        geom.computeBoundingBox();
        const bb = geom.boundingBox;
        const f = this.footprints.get(this._cur);
        f.x0 = Math.min(f.x0, bb.min.x); f.x1 = Math.max(f.x1, bb.max.x);
        f.z0 = Math.min(f.z0, bb.min.z); f.z1 = Math.max(f.z1, bb.max.z);
      }
    }
    return geom;
  }
  decor(matKey, geom) { return this.add(matKey, geom, false); }

  /**
   * Park features must not overlap on the ground plane — when they do you get
   * ramps buried inside other ramps and approaches that dead-end into a wall.
   * Cheap to check, and it fails loudly the moment a feature is moved.
   */
  layoutClashes() {
    const names = [...this.footprints.keys()];
    const bad = [];
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const a = this.footprints.get(names[i]);
        const b = this.footprints.get(names[j]);
        const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const oz = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
        if (ox > 0 && oz > 0) {
          bad.push(`${names[i]} <-> ${names[j]} overlap ${ox.toFixed(1)}x${oz.toFixed(1)} m`);
        }
      }
    }
    return bad;
  }
}

/** Concatenates position/index of many geometries — collider only, no attributes. */
function mergeForCollision(geoms) {
  let vCount = 0, iCount = 0;
  for (const g of geoms) {
    vCount += g.attributes.position.count;
    iCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const verts = new Float32Array(vCount * 3);
  const indices = new Uint32Array(iCount);
  let vo = 0, io = 0, base = 0;
  for (const g of geoms) {
    const pos = g.attributes.position.array;
    verts.set(pos, vo);
    const n = g.attributes.position.count;
    if (g.index) {
      const src = g.index.array;
      for (let i = 0; i < src.length; i++) indices[io + i] = src[i] + base;
      io += src.length;
    } else {
      for (let i = 0; i < n; i++) indices[io + i] = i + base;
      io += n;
    }
    vo += pos.length;
    base += n;
  }
  return { verts, indices };
}

// ── the ground shell: dish + floor + perimeter quarter-pipe ────
function groundProfile() {
  const { floorRadius: FR, wallHeight: WH, dishRadius: DR, dishDepth: DD } = ARENA;
  const pts = [];

  // dished centre — smoothstep so it meets the flat floor tangentially
  pts.push([0.02, -DD]);
  const flatBottom = 15;
  pts.push([flatBottom, -DD]);
  for (let i = 1; i <= 14; i++) {
    const t = i / 14;
    const r = flatBottom + (DR - flatBottom) * t;
    const y = -DD * (0.5 + 0.5 * Math.cos(Math.PI * t));
    pts.push([r, y]);
  }

  // flat floor out to the wall
  pts.push([FR, 0]);

  // perimeter quarter-pipe: horizontal at the bottom, vertical at the top
  const qp = arcPoints(FR, WH, WH, -Math.PI / 2, 0, 18);
  for (let i = 1; i < qp.length; i++) pts.push(qp[i]);

  // vertical lip, then the outside shell so the ground is a closed solid
  const topR = FR + WH;
  pts.push([topR, ARENA.lipHeight]);
  pts.push([topR + 4, ARENA.lipHeight]);
  pts.push([topR + 4, -7]);
  pts.push([0.02, -7]);
  pts.push([0.02, -DD]); // close

  return pts.map(([r, y]) => new THREE.Vector2(r, y));
}

// ── individual park features ───────────────────────────────────

/** A kicker / quarter-pipe. Rises toward local +X, extruded across Z. */
function kicker(b, mat, { pos, yaw = 0, radius, sweep, width }) {
  const g = prism(rampProfile(radius, sweep), width);
  place(g, { pos, rot: [0, yaw, 0] });
  return b.add(mat, g);
}

function funbox(b, mat, { pos, yaw = 0, base, top, height, width }) {
  const g = prism(funboxProfile(base, top, height), width);
  place(g, { pos, rot: [0, yaw, 0] });
  return b.add(mat, g);
}

function slab(b, mat, { pos, size, yaw = 0, tilt = 0 }, collide = true) {
  const g = new THREE.BoxGeometry(size[0], size[1], size[2]);
  place(g, { pos, rot: [0, yaw, tilt] });
  return b.add(mat, g, collide);
}

function pillar(b, mat, x, z, h, r = 1.6) {
  const g = new THREE.CylinderGeometry(r, r * 1.15, h, 12);
  place(g, { pos: [x, h / 2, z] });
  return b.add(mat, g);
}

// ── the build ──────────────────────────────────────────────────

export function buildArena(scene, world, quality = 'high') {
  const MATS = makeMaterials();
  const b = new Builder();
  const LATHE_SEGS = quality === 'low' ? 64 : 112;

  // ---------- ground shell ----------
  const ground = new THREE.LatheGeometry(groundProfile(), LATHE_SEGS);
  b.add('ground', ground);

  // Six big features sit on a 64 m ring at 60-degree spacing, with two smaller
  // ones tucked into the gaps. Footprints are asserted disjoint below.

  // ---------- E: loop-the-loop ----------
  // Tangent to the floor at x=64, so you line up along z=0 and drive at it.
  b.begin('loop');
  {
    const CX = 64, R = 13, WIDTH = 11, DRIFT = 12;
    const C = new THREE.Vector3(CX, R + 0.06, 0);
    // enters at z=-6, exits at z=+6 (see loopFrames' drift)
    const lf = loopFrames(C, R, new THREE.Vector3(1, 0, 0), quality === 'low' ? 40 : 72, DRIFT);
    b.add('ramp', sweepRibbon(lf, WIDTH, 0.9, false));
    // Kerbs are not decoration: the loop drifts sideways as it goes round, so
    // without them the car runs straight off the edge half-way up.
    for (const side of [-1, 1]) {
      b.add('rampAlt', sweepRibbon(railFrames(lf, WIDTH / 2, side, 1.5), 1.5, 0.35, false));
    }
    pillar(b, 'metal', CX, -11.5, C.y + R - 1, 0.6);
    pillar(b, 'metal', CX, 11.5, C.y + R - 1, 0.6);
    b.end();
    // run-up lane markings on the entry side
    for (let i = 0; i < 8; i++) {
      const g = new THREE.BoxGeometry(3.4, 0.06, 0.7);
      place(g, { pos: [34 + i * 4, 0.05, -6] });
      b.decor('hazard', g);
    }
    for (const dz of [-11.5, 11.5]) {
      const ring = new THREE.TorusGeometry(R + 0.5, 0.16, 6, 64);
      place(ring, { pos: [CX, C.y, dz] });
      b.decor('neon', ring);
    }
  }

  // ---------- NE-ish: vert wall + spine ----------
  b.begin('vertwall');
  {
    const Z = 28;
    kicker(b, 'ramp', { pos: [60, 0, Z], yaw: 0, radius: 12, sweep: Math.PI / 2 * 0.96, width: 26 });
    const SR = 9, SS = 1.1, sreach = SR * Math.sin(SS);
    kicker(b, 'rampAlt', { pos: [42, 0, Z], yaw: 0, radius: SR, sweep: SS, width: 20 });
    kicker(b, 'rampAlt', { pos: [42 + 2 * sreach, 0, Z], yaw: Math.PI, radius: SR, sweep: SS, width: 20 });
    b.end();
    const coping = new THREE.CylinderGeometry(0.3, 0.3, 20, 8);
    place(coping, { pos: [42 + sreach, SR * (1 - Math.cos(SS)) + 0.1, Z], rot: [Math.PI / 2, 0, 0] });
    b.decor('paint', coping);
  }

  // ---------- N: the mega gap ----------
  b.begin('gap');
  {
    const Z = 55, R = 16, SWEEP = 0.95, W = 22;
    const reach = R * Math.sin(SWEEP);        // ~13.0
    const h = R * (1 - Math.cos(SWEEP));      // ~6.7
    kicker(b, 'ramp', { pos: [8, 0, Z], yaw: 0, radius: R, sweep: SWEEP, width: W });
    kicker(b, 'ramp', { pos: [56, 0, Z], yaw: Math.PI, radius: R, sweep: SWEEP, width: W });
    b.end();
    for (const x of [8 + reach, 56 - reach]) {
      const c = new THREE.BoxGeometry(0.6, 0.4, W);
      place(c, { pos: [x, h + 0.2, Z] });
      b.decor('paint', c);
    }
    for (let i = -1; i <= 1; i++) {
      const g = new THREE.BoxGeometry(1.2, 0.08, W * 0.8);
      place(g, { pos: [32 + i * 6, 0.06, Z] });
      b.decor('hazard', g);
    }
  }

  // ---------- NW: halfpipe ----------
  b.begin('halfpipe');
  {
    const CX = -32, CZ = 55, LEN = 52, R = 9.5, SWEEP = Math.PI / 2 * 0.92;
    kicker(b, 'ramp', { pos: [CX - 11, 0, CZ], yaw: Math.PI, radius: R, sweep: SWEEP, width: LEN });
    kicker(b, 'ramp', { pos: [CX + 11, 0, CZ], yaw: 0, radius: R, sweep: SWEEP, width: LEN });
    b.end();
    const reach = R * Math.sin(SWEEP), h = R * (1 - Math.cos(SWEEP));
    for (const s of [-1, 1]) {
      const c = new THREE.CylinderGeometry(0.26, 0.26, LEN, 8);
      place(c, { pos: [CX + s * (11 + reach), h, CZ], rot: [Math.PI / 2, 0, 0] });
      b.decor('paint', c);
    }
  }

  // ---------- W: corkscrew tower ----------
  b.begin('corkscrew');
  const CORK = { x: -64, z: 0, r: 16, h: 17 };
  {
    const C = new THREE.Vector3(CORK.x, 0.3, CORK.z);
    const frames = helixFrames(C, CORK.r, 2, CORK.h, 0.38, quality === 'low' ? 60 : 110);
    b.add('ramp', sweepRibbon(frames, 11, 1.0));
    for (const side of [-1, 1]) {
      b.add('rampAlt', sweepRibbon(railFrames(frames, 5.5, side, 1.3), 1.3, 0.3, false));
    }
    for (let i = 8; i < frames.length - 4; i += 16) {
      const f = frames[i];
      if (f.p.y < 2) continue;
      pillar(b, 'metal', f.p.x, f.p.z, f.p.y, 0.55);
    }
    const end = frames[frames.length - 1];    // exits heading +Z, ~17 m up
    CORK.exit = [end.p.x, end.p.y, end.p.z];
    slab(b, 'rampAlt', { pos: [end.p.x, end.p.y - 0.5, end.p.z + 8], size: [12, 1, 16] });
    kicker(b, 'ramp', {
      pos: [end.p.x, end.p.y, end.p.z + 16], yaw: -Math.PI / 2,
      radius: 14, sweep: 0.5, width: 12,
    });
    b.end();
    for (let i = 0; i < frames.length - 1; i += 8) {
      const f = frames[i];
      const g = new THREE.SphereGeometry(0.3, 6, 5);
      place(g, { pos: [f.p.x + f.b.x * 5.6, f.p.y + f.b.y * 5.6 + 0.3, f.p.z + f.b.z * 5.6] });
      b.decor('neon', g);
    }
  }

  // ---------- SW: rollers ----------
  b.begin('rollers');
  {
    // Squeezed between the corkscrew and the tower — three is all that fits.
    const X = -62, Z = -34.5;
    for (let i = 0; i < 3; i++) {
      const g = new THREE.CylinderGeometry(2.6, 2.6, 22, 16, 1, false, 0, Math.PI);
      place(g, { pos: [X, 0, Z + i * 6 - 6], rot: [0, 0, Math.PI / 2] });
      b.add('rampAlt', g);
    }
  }
  b.end();

  // ---------- S: drop-in tower ----------
  b.begin('tower');
  const TOWER = { x: -32, z: -55, h: 15 };
  {
    const { x: X, z: Z, h: H } = TOWER;
    slab(b, 'rampAlt', { pos: [X, H / 2, Z], size: [20, H, 20] });
    const DR = H, DS = Math.PI / 2 * 0.98;
    const dreach = DR * Math.sin(DS);
    kicker(b, 'ramp', { pos: [X - 10 - dreach, 0, Z], yaw: 0, radius: DR, sweep: DS, width: 19 });
    const run = 22, len = Math.hypot(run, H);
    slab(b, 'rampAlt', {
      pos: [X + 10 + run / 2, H / 2, Z], size: [len, 1, 10], tilt: -Math.atan2(H, run),
    });
    b.end();
    slab(b, 'paint', { pos: [X, H + 0.14, Z], size: [20.4, 0.28, 20.4] }, false);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      const g = new THREE.CylinderGeometry(0.22, 0.22, 3, 6);
      place(g, { pos: [X + Math.cos(a) * 8, H + 1.5, Z + Math.sin(a) * 8] });
      b.decor('neon', g);
    }
  }

  // ---------- SE: funbox cluster ----------
  b.begin('funbox');
  {
    const X = 32, Z = -55;
    funbox(b, 'ramp', { pos: [X, 0, Z], base: 26, top: 15, height: 3.4, width: 17 });
    slab(b, 'metal', { pos: [X, 1.1, Z + 12], size: [22, 2.2, 2.4] });
    b.end();
    slab(b, 'paint', { pos: [X, 2.32, Z + 12], size: [22, 0.24, 2.6] }, false);
  }

  // ---------- mid-ring hazard pillars (derby cover) ----------
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.5;
    const x = Math.cos(a) * 40, z = Math.sin(a) * 40;
    b.begin(`pillar${i}`);
    pillar(b, 'hazard', x, z, 7, 1.7);
    b.end();
    const cap = new THREE.CylinderGeometry(2.2, 2.2, 0.5, 12);
    place(cap, { pos: [x, 7.2, z] });
    b.decor('paint', cap);
  }

  // ---------- perimeter neon ----------
  {
    const ring = new THREE.TorusGeometry(ARENA.wallTop, 0.35, 6, LATHE_SEGS);
    place(ring, { pos: [0, ARENA.wallHeight, 0], rot: [Math.PI / 2, 0, 0] });
    b.decor('neon', ring);
    const ring2 = new THREE.TorusGeometry(ARENA.dishRadius, 0.22, 6, 96);
    place(ring2, { pos: [0, 0.06, 0], rot: [Math.PI / 2, 0, 0] });
    b.decor('paint', ring2);
  }

  // ---------- layout sanity ----------
  const clashes = b.layoutClashes();
  if (clashes.length) {
    console.error('[arena] FEATURES OVERLAP:\n  ' + clashes.join('\n  '));
  }

  // ═══════ commit visuals ═══════
  // ExtrudeGeometry is non-indexed while everything else is indexed, so
  // normalise before merging. Collision still uses the originals.
  const meshes = [];
  for (const [key, geoms] of b.visual) {
    const flat = geoms.map((g) => (g.index ? g.toNonIndexed() : g));
    const merged = mergeGeometries(flat, false);
    if (!merged) {
      console.warn(`[arena] merge failed for material "${key}" — falling back to separate meshes`);
      for (const g of flat) {
        const m = new THREE.Mesh(g, MATS[key]);
        m.castShadow = m.receiveShadow = true;
        scene.add(m); meshes.push(m);
      }
      continue;
    }
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, MATS[key]);
    mesh.castShadow = key !== 'ground';
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    scene.add(mesh);
    meshes.push(mesh);
  }

  // ═══════ commit collision ═══════
  const { verts, indices } = mergeForCollision(b.collide);
  const staticBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const staticCollider = world.createCollider(
    RAPIER.ColliderDesc.trimesh(verts, indices)
      .setFriction(1.0)
      .setRestitution(0.12)
      .setCollisionGroups(GROUPS.world),
    staticBody
  );

  // ═══════ smashable props ═══════
  const props = buildProps(scene, world, MATS);

  // ═══════ spawns & pickup pads ═══════
  const spawns = findSpawns(world, 8);

  // Pickups: two of them reward actually climbing something.
  const pickupPads = [
    { pos: [0, -3.4, 0], type: 'repair' },        // bottom of the centre dish
    { pos: [40, 0.4, -6], type: 'boost' },        // on the loop run-up lane
    { pos: [-38, 0.4, 0], type: 'repair' },
    { pos: [0, 0.4, 34], type: 'boost' },
    { pos: [0, 0.4, -34], type: 'boost' },
    { pos: [CORK.exit[0], CORK.exit[1] + 0.6, CORK.exit[2] + 8], type: 'overdrive' },
    { pos: [TOWER.x, TOWER.h + 0.6, TOWER.z], type: 'overdrive' },
  ];

  return {
    meshes,
    staticCollider,
    props,
    spawns,
    pickupPads,
    triangleCount: indices.length / 3,

    update() { props.update(); },
    resetProps() { props.reset(); },

    dispose() {
      for (const m of meshes) { scene.remove(m); m.geometry.dispose(); }
      props.dispose();
    },
  };
}

// ── spawn placement ────────────────────────────────────────────
/**
 * Finds flat, clear, open-topped patches of floor by raycasting the finished
 * park. Deterministic, so every client picks the identical spawn ring — and it
 * keeps working when the layout above is edited.
 */
function findSpawns(world, count) {
  world.step();   // the broad phase must be populated before queries work
  const filter = groups(G.CAR, G.WORLD);

  const down = { x: 0, y: -1, z: 0 };
  const up = { x: 0, y: 1, z: 0 };

  const floorAt = (x, z) => {
    const hit = world.castRayAndGetNormal(
      new RAPIER.Ray({ x, y: 40, z }, down), 80, true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, filter
    );
    if (!hit) return null;
    return { y: 40 - hit.timeOfImpact, ny: hit.normal.y };
  };

  const isClear = (x, z) => {
    const c = floorAt(x, z);
    if (!c || Math.abs(c.y) > 0.6 || Math.abs(c.ny) < 0.97) return false;
    // surroundings must be flat too, so nobody spawns half-way up a transition
    for (const [dx, dz] of [[4, 0], [-4, 0], [0, 4], [0, -4], [3, 3], [-3, -3]]) {
      const n = floorAt(x + dx, z + dz);
      if (!n || Math.abs(n.y - c.y) > 0.8 || Math.abs(n.ny) < 0.95) return false;
    }
    // nothing overhead (no spawning under the loop or the corkscrew)
    const roof = world.castRay(
      new RAPIER.Ray({ x, y: c.y + 1.2, z }, up), 14, true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, filter
    );
    if (roof) return false;

    // ...and room to actually drive away. Flat ground is not enough: a car can
    // land in a slot beside a kerb where every downward ray says "fine" while
    // it is in fact wedged against a wall.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const dir = { x: Math.cos(a), y: 0, z: Math.sin(a) };
      const blocked = world.castRay(
        new RAPIER.Ray({ x, y: c.y + 0.9, z }, dir), 9, true,
        RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, filter
      );
      if (blocked) return false;
    }
    return true;
  };

  /**
   * How far you can drive from here on a given bearing before hitting
   * something, capped at `max`.
   */
  const runway = (x, z, y, a, max = 60) => {
    const hit = world.castRay(
      new RAPIER.Ray({ x, y: y + 0.9, z }, { x: Math.cos(a), y: 0, z: Math.sin(a) }),
      max, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, filter
    );
    return hit ? hit.timeOfImpact : max;
  };

  /**
   * Picks the heading with the longest clear run, nudged toward the middle of
   * the park. Facing the centre unconditionally is wrong — several spawns have
   * a loop or a tower between them and the middle, and you would start every
   * round nose-first into a wall.
   */
  const bestHeading = (x, z, y) => {
    const toCentre = Math.atan2(-z, -x);
    let bestA = toCentre, bestScore = -Infinity, bestRun = 0;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const run = runway(x, z, y, a);
      // bias toward the centre so cars still converge into the action
      const align = Math.cos(a - toCentre);
      const score = run + align * 18;
      if (score > bestScore) { bestScore = score; bestA = a; bestRun = run; }
    }
    return { angle: bestA, run: bestRun };
  };

  // Test a dense ring of candidates, then take the one closest to each of the
  // `count` evenly-spaced target bearings.
  const candidates = [];
  for (const r of [76, 68, 84, 60, 92]) {
    for (let i = 0; i < 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (isClear(x, z)) candidates.push({ x, z, a, r });
    }
  }

  const spawns = [];
  const used = [];
  for (let k = 0; k < count; k++) {
    const target = (k / count) * Math.PI * 2;
    let best = null, bestCost = Infinity;
    for (const c of candidates) {
      let d = Math.abs(((c.a - target + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      // stay away from spawns already chosen
      let tooClose = false;
      for (const u of used) {
        if (Math.hypot(u.x - c.x, u.z - c.z) < 24) { tooClose = true; break; }
      }
      if (tooClose) continue;
      const cost = d + Math.abs(c.r - 76) * 0.004;
      if (cost < bestCost) { bestCost = cost; best = c; }
    }
    if (!best) break;
    used.push(best);
    const h = bestHeading(best.x, best.z, 0);
    // yaw rotates the car's +Z nose; a heading of `angle` in the XZ plane
    // corresponds to yaw = atan2(cos a, sin a) ... expressed directly:
    spawns.push({
      pos: [best.x, 0.6, best.z],
      yaw: Math.atan2(Math.cos(h.angle), Math.sin(h.angle)),
      runway: Math.round(h.run),
    });
  }

  if (spawns.length < count) {
    console.warn(`[arena] only found ${spawns.length}/${count} clear spawns`);
  }
  return spawns;
}

// ── smashable junk ─────────────────────────────────────────────
function buildProps(scene, world, MATS) {
  const items = [];
  const barrelGeo = new THREE.CylinderGeometry(0.62, 0.62, 1.7, 12);
  const crateGeo = new THREE.BoxGeometry(1.5, 1.5, 1.5);
  const coneGeo = new THREE.ConeGeometry(0.55, 1.3, 10);

  // Seeded, NOT Math.random — every client must generate the identical park,
  // otherwise players collide with junk their mates cannot see.
  const rng = makeRng(0x57ac2f);

  const spots = [];
  // scattered around the mid ring and near features
  for (let i = 0; i < 34; i++) {
    const a = rng() * Math.PI * 2;
    const r = 20 + rng() * 68;
    spots.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  // tidy stacks worth ploughing through
  for (const [cx, cz] of [[0, -40], [40, 0], [-40, 20], [20, 40]]) {
    for (let i = 0; i < 5; i++) spots.push([cx + (i % 3) * 1.7 - 1.7, cz + Math.floor(i / 3) * 1.7]);
  }

  for (const [x, z] of spots) {
    const kind = rng();
    let geo, mat, half, mass, y;
    if (kind < 0.5) { geo = barrelGeo; mat = MATS.prop; half = 'barrel'; mass = 34; y = 0.9; }
    else if (kind < 0.85) { geo = crateGeo; mat = MATS.propAlt; half = 'crate'; mass = 42; y = 0.78; }
    else { geo = coneGeo; mat = MATS.paint; half = 'cone'; mass = 8; y = 0.68; }

    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);

    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setLinearDamping(0.22)
        .setAngularDamping(0.45)
        .setCanSleep(true)
    );
    let cd;
    if (half === 'barrel') cd = RAPIER.ColliderDesc.cylinder(0.85, 0.62);
    else if (half === 'crate') cd = RAPIER.ColliderDesc.cuboid(0.75, 0.75, 0.75);
    else cd = RAPIER.ColliderDesc.cone(0.65, 0.55);
    cd.setMass(mass).setFriction(0.7).setRestitution(0.25).setCollisionGroups(GROUPS.prop);
    world.createCollider(cd, body);

    items.push({ mesh, body, home: { x, y, z } });
  }

  return {
    items,
    update() {
      for (const it of items) {
        const t = it.body.translation();
        const r = it.body.rotation();
        it.mesh.position.set(t.x, t.y, t.z);
        it.mesh.quaternion.set(r.x, r.y, r.z, r.w);
        // anything that escapes the arena gets recycled
        if (t.y < -30 || Math.abs(t.x) > 140 || Math.abs(t.z) > 140) {
          it.body.setTranslation(it.home, true);
          it.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
          it.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        }
      }
    },
    reset() {
      for (const it of items) {
        it.body.setTranslation(it.home, true);
        it.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
        it.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        it.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      }
    },
    dispose() {
      for (const it of items) scene.remove(it.mesh);
      barrelGeo.dispose(); crateGeo.dispose(); coneGeo.dispose();
    },
  };
}

// ── sky, lights and fog ────────────────────────────────────────
export function buildEnvironment(scene, renderer, quality = 'high') {
  scene.background = new THREE.Color(0x1b2233);
  scene.fog = new THREE.Fog(0x2b3348, 170, 540);

  const hemi = new THREE.HemisphereLight(0xa8c8ff, 0x4a3a2c, 1.05);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffe2b8, 3.1);
  sun.position.set(-90, 130, 70);
  sun.castShadow = quality !== 'low';
  if (sun.castShadow) {
    const S = quality === 'high' ? 2048 : 1024;
    sun.shadow.mapSize.set(S, S);
    sun.shadow.camera.near = 20;
    sun.shadow.camera.far = 420;
    const D = 150;
    sun.shadow.camera.left = -D; sun.shadow.camera.right = D;
    sun.shadow.camera.top = D; sun.shadow.camera.bottom = -D;
    sun.shadow.bias = -0.0012;
    sun.shadow.normalBias = 0.04;
  }
  scene.add(sun);
  scene.add(sun.target);

  // cold rim light from the opposite side so cars read against the concrete
  const rim = new THREE.DirectionalLight(0x6ba3ff, 1.0);
  rim.position.set(80, 50, -110);
  scene.add(rim);

  // sky dome — cheap vertical gradient, no textures
  const skyGeo = new THREE.SphereGeometry(700, 32, 20);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(0x16203c) },
      mid: { value: new THREE.Color(0x4a4260) },
      bot: { value: new THREE.Color(0xa8613c) },
    },
    vertexShader: `
      varying vec3 vP;
      void main() {
        vP = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 top, mid, bot;
      varying vec3 vP;
      void main() {
        float h = normalize(vP).y;
        vec3 c = h > 0.0 ? mix(mid, top, pow(h, 0.65)) : mix(mid, bot, pow(-h, 0.5));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.frustumCulled = false;
  scene.add(sky);

  return { sun, hemi, rim, sky };
}
