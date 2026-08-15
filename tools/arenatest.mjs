/**
 * Headless check that the park's geometry and colliders actually build.
 * three.js geometry needs no WebGL context, so this runs in plain Node.
 */
import * as THREE from 'three';
import { initPhysics, createWorld, groups, G } from '../src/game/physics.js';
import { buildArena, buildEnvironment, ARENA } from '../src/game/arena.js';

await initPhysics();
const world = createWorld();
const scene = new THREE.Scene();

console.time('build');
const arena = buildArena(scene, world, 'high');
console.timeEnd('build');

buildEnvironment(scene, null, 'high');

console.log('collision triangles :', arena.triangleCount.toLocaleString());
console.log('merged meshes       :', arena.meshes.length);
console.log('props               :', arena.props.items.length);
console.log('spawns              :', arena.spawns.length);
console.log('rapier colliders    :', world.colliders.len());
console.log('rapier bodies       :', world.bodies.len());

// sanity: nothing should be NaN, and the park should sit inside the bounds
let minY = Infinity, maxY = -Infinity, maxR = 0, nan = 0;
for (const m of arena.meshes) {
  const p = m.geometry.attributes.position.array;
  for (let i = 0; i < p.length; i += 3) {
    if (!Number.isFinite(p[i]) || !Number.isFinite(p[i + 1]) || !Number.isFinite(p[i + 2])) { nan++; continue; }
    minY = Math.min(minY, p[i + 1]);
    maxY = Math.max(maxY, p[i + 1]);
    maxR = Math.max(maxR, Math.hypot(p[i], p[i + 2]));
  }
}
console.log(`bounds: y ${minY.toFixed(1)} .. ${maxY.toFixed(1)}   maxRadius ${maxR.toFixed(1)}`);
if (nan) { console.error(`FAIL: ${nan} NaN vertices`); process.exit(1); }

// drop test: does a body land on the floor rather than through it?
import RAPIER from '@dimforge/rapier3d-compat';
const probes = [
  ['centre dish',    0,   8,   0,  -3.5],
  ['loop run-up',   40,   8,   0,   0.5],
  ['loop bottom',   64,   8,   0,   0.5],
  ['halfpipe floor',-32,  8,  55,   0.5],
  ['tower roof',   -32,  24, -55,  15.5],
  ['funbox top',    32,  12, -55,   3.9],
  ['gap landing',   32,   8,  55,   0.5],
];
const bodies = probes.map(([, x, y, z]) => {
  const rb = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z));
  // only collide with static world geometry, so a stray barrel does not skew the probe
  world.createCollider(RAPIER.ColliderDesc.ball(0.5).setMass(10)
    .setCollisionGroups(groups(G.CAR, G.WORLD)), rb);
  return rb;
});
for (let i = 0; i < 240; i++) world.step();

let fails = 0;
probes.forEach(([name, , , , want], i) => {
  const t = bodies[i].translation();
  const ok = Number.isFinite(t.y) && Math.abs(t.y - want) < 0.6;
  if (!ok) fails++;
  console.log(`  ${ok ? 'ok  ' : 'BAD '} ${name.padEnd(15)} rest y=${t.y.toFixed(2)}  (expected ~${want})`);
});

if (fails) { console.error(`FAIL: ${fails} probe(s) fell through the world`); process.exit(1); }
console.log('\narena test: PASS');
