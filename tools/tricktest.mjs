/**
 * Trick-detection tests. Flies the car through specific manoeuvres and checks
 * the right trick fires, the combo banks on a good landing, and is lost on a bad one.
 */
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { initPhysics, createWorld, TIMESTEP, GROUPS } from '../src/game/physics.js';
import { buildArena } from '../src/game/arena.js';
import { Vehicle } from '../src/game/vehicle.js';
import { TrickTracker } from '../src/game/tricks.js';
import { getCar } from '../src/game/carTypes.js';

await initPhysics();

const NEUTRAL = {
  throttle: 0, steer: 0, yaw: 0, boost: false, handbrake: false,
  jump: false, jumpHeld: false, reset: false, camera: false, scores: false,
};
const intent = (o = {}) => ({ ...NEUTRAL, ...o });

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
  if (!cond) failures++;
};

function rig({ car: carId = 'hornet', arena = false } = {}) {
  const world = createWorld();
  if (arena) buildArena(new THREE.Scene(), world, 'low');
  else {
    const gb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -2, 0));
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(400, 2, 400).setFriction(1.0).setCollisionGroups(GROUPS.world), gb);
  }
  const car = new Vehicle({ world, type: getCar(carId) });
  const log = { tricks: [], banks: [], bails: 0 };
  const tt = new TrickTracker({
    trick: (label, pts) => log.tricks.push({ label, pts }),
    bank: (total, mult, tricks) => log.banks.push({ total, mult, tricks }),
    bail: () => log.bails++,
  });
  const run = (steps, it, ctx) => {
    for (let i = 0; i < steps; i++) {
      car.preStep(TIMESTEP);
      car.step(TIMESTEP, it);
      world.step();
      tt.update(TIMESTEP, car, ctx || {});
    }
  };
  return { world, car, tt, log, run };
}

const labels = (log) => log.tricks.map((t) => t.label);

// ══════════════════════════════════════════════════════════════
console.log('\n── single manoeuvres ──');
for (const [name, key, expect] of [
  ['front flip',  'throttle', 'FRONT FLIP'],
  ['barrel roll', 'steer',    'BARREL ROLL'],
  ['spin 360',    'yaw',      '360'],
]) {
  const { car, run, log } = rig();
  car.resetTo([0, 26, 0], 0);
  run(5, intent());
  run(70, intent({ [key]: 1 }));      // rotate
  run(200, intent());                 // fall and land
  check(`${name.padEnd(12)} detected`, labels(log).some((l) => l.startsWith(expect)),
    labels(log).join(', ') || '(nothing)');
}

console.log('\n── landing it banks the points ──');
{
  const { car, run, log } = rig();
  car.resetTo([0, 26, 0], 0);
  run(5, intent());
  run(70, intent({ throttle: 1 }));
  run(240, intent());
  check('combo banked', log.banks.length > 0,
    log.banks.map((b) => `${b.total} pts x${b.mult}`).join(' | ') || '(none)');
  check('no bail on a good landing', log.bails === 0, `${log.bails} bail(s)`);
}

console.log('\n── binning it loses the points ──');
{
  const { car, run, log } = rig();
  car.resetTo([0, 30, 0], 0);
  run(5, intent());
  run(70, intent({ throttle: 1 }));       // earn a flip so there is a pot to lose
  check('has points pending', log.tricks.length > 0);
  // force it onto its roof for the landing
  car.body.setRotation({ x: 1, y: 0, z: 0, w: 0 }, true);
  car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  run(300, intent());
  check('bailed', log.bails > 0, `${log.bails} bail(s), ${log.banks.length} bank(s)`);
}

console.log('\n── multiplier grows with distinct tricks ──');
{
  const { car, run, log } = rig();
  car.resetTo([0, 40, 0], 0);
  run(5, intent());
  run(60, intent({ throttle: 1 }));   // flip
  run(60, intent({ steer: 1 }));      // roll
  run(50, intent({ yaw: 1 }));        // spin
  // level it off like a player would, so the landing sticks
  car.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  run(300, intent());
  const best = Math.max(0, ...log.banks.map((b) => b.mult));
  check('multiplier above 2', best >= 3, `best x${best}, tricks: ${labels(log).join(', ')}`);
}

console.log('\n── big air is time-based ──');
{
  const { car, run, log } = rig();
  car.resetTo([0, 60, 0], 0);
  run(5, intent());
  run(400, intent());                 // just fall, no rotation at all
  check('BIG AIR awarded for hang time', labels(log).includes('BIG AIR'),
    labels(log).join(', ') || '(nothing)');
}

console.log('\n── ordinary driving scores nothing ──');
{
  const { car, run, log } = rig({ car: 'ripsaw' });
  car.resetTo([0, 0.2, 0], 0);
  run(60, intent());
  run(420, intent({ throttle: 1 }));
  run(180, intent({ throttle: 1, steer: 1 }));
  check('no phantom tricks while driving', log.tricks.length === 0,
    labels(log).join(', ') || 'clean');
}

console.log('\n── the loop scores LOOP THE LOOP ──');
{
  const { car, run, log } = rig({ car: 'volt', arena: true });
  car.resetTo([34, 0.3, -6], Math.PI / 2);
  run(10, intent());
  // 30-38 m/s on the boost is the band that holds the surface all the way round
  car.body.setLinvel({ x: 34, y: 0, z: 0 }, true);
  run(300, intent({ throttle: 1, boost: true }));
  check('loop detected', labels(log).includes('LOOP THE LOOP'),
    labels(log).join(', ') || '(nothing)');
}

console.log(`\n${failures === 0 ? 'tricktest: ALL PASS' : `tricktest: ${failures} FAILURE(S)`}\n`);
process.exit(failures ? 1 : 0);
