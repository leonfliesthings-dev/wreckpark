/**
 * Headless physics test.
 *
 * Driving mechanics are tested on a bare flat plane so a stray ramp cannot
 * quietly invalidate the result; the arena is used only where the level
 * geometry is the thing under test (the loop).
 */
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { initPhysics, createWorld, TIMESTEP, GROUPS } from '../src/game/physics.js';
import { buildArena } from '../src/game/arena.js';
import { Vehicle } from '../src/game/vehicle.js';
import { CAR_TYPES, getCar } from '../src/game/carTypes.js';

await initPhysics();

const NEUTRAL = {
  throttle: 0, steer: 0, yaw: 0, boost: false, handbrake: false,
  jump: false, jumpHeld: false, reset: false, camera: false, scores: false,
};
const intent = (o = {}) => ({ ...NEUTRAL, ...o });

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
  if (!cond) failures++;
}

function rig({ car: carId = 'ripsaw', arena = false } = {}) {
  const world = createWorld();
  let park = null;
  if (arena) {
    park = buildArena(new THREE.Scene(), world, 'low');
  } else {
    const gb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -2, 0));
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(400, 2, 400).setFriction(1.0).setCollisionGroups(GROUPS.world),
      gb
    );
  }
  const car = new Vehicle({ world, type: getCar(carId) });
  let impacts = 0, damageTaken = 0;
  car.onImpact = (mag) => { impacts++; damageTaken += mag; };
  const run = (steps, it) => {
    for (let i = 0; i < steps; i++) {
      car.preStep(TIMESTEP);
      car.step(TIMESTEP, it);
      world.step();
    }
  };
  return { world, car, park, run, stats: () => ({ impacts, damageTaken }) };
}

// ══════════════════════════════════════════════════════════════
console.log('\n── rapier api surface ──');
{
  const { world, car } = rig();
  check('QueryFilterFlags.EXCLUDE_SENSORS exists',
    typeof RAPIER.QueryFilterFlags?.EXCLUDE_SENSORS === 'number');
  check('world.removeVehicleController exists', typeof world.removeVehicleController === 'function');
  check('forward axis is Z', car.vc.indexForwardAxis === 2, `got ${car.vc.indexForwardAxis}`);
  check('up axis is Y', car.vc.indexUpAxis === 1, `got ${car.vc.indexUpAxis}`);
  check('4 wheels attached', car.vc.numWheels() === 4);
  check('chassis mass matches spec', Math.abs(car.body.mass() - 1250) < 1,
    `got ${car.body.mass().toFixed(1)}`);
}

// ══════════════════════════════════════════════════════════════
console.log('\n── resting pose ──');
for (const type of CAR_TYPES) {
  const { car, run } = rig({ car: type.id });
  car.resetTo([0, 0.2, 0], 0);
  run(180, intent());
  const t = car.position;
  const ok = Math.abs(t.y - type.body.ride) < 0.3 && car.upright > 0.99 && car.wheelsOnGround === 4;
  check(`${type.name.padEnd(7)} rests level`, ok,
    `y=${t.y.toFixed(2)} (want ~${type.body.ride}) wheels=${car.wheelsOnGround}`);
}

// ══════════════════════════════════════════════════════════════
console.log('\n── suspension is damped, not pogoing ──');
for (const type of CAR_TYPES) {
  const { car, run } = rig({ car: type.id });
  car.resetTo([0, 1.6, 0], 0);       // drop it from a height and let it settle
  run(150, intent());
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < 90; i++) {
    run(1, intent({ throttle: 1 }));
    const l = car.vc.wheelSuspensionLength(2) ?? 0;
    min = Math.min(min, l); max = Math.max(max, l);
  }
  check(`${type.name.padEnd(7)} suspension settles`, max - min < 0.09,
    `travel swing ${(max - min).toFixed(3)} m`);
}

// ══════════════════════════════════════════════════════════════
console.log('\n── acceleration (5 s flat out) ──');
for (const type of CAR_TYPES) {
  const { car, run } = rig({ car: type.id });
  car.resetTo([0, 0.2, 0], 0);
  run(60, intent());
  run(300, intent({ throttle: 1 }));
  check(`${type.name.padEnd(7)} accelerates`, car.speed > 18,
    `${(car.speed * 3.6).toFixed(0)} km/h`);
}

console.log('\n── boost adds real speed ──');
{
  const a = rig(); a.car.resetTo([0, 0.2, 0], 0); a.run(60, intent()); a.run(300, intent({ throttle: 1 }));
  const b = rig(); b.car.resetTo([0, 0.2, 0], 0); b.run(60, intent()); b.run(300, intent({ throttle: 1, boost: true }));
  check('boosting is faster than not', b.car.speed > a.car.speed + 3,
    `${(a.car.speed * 3.6).toFixed(0)} -> ${(b.car.speed * 3.6).toFixed(0)} km/h`);
}

// ══════════════════════════════════════════════════════════════
console.log('\n── steering ──');
{
  const { car, run } = rig();
  car.resetTo([0, 0.2, 0], 0);                     // facing +Z
  run(60, intent());
  run(150, intent({ throttle: 1 }));
  const before = car.axes().fwd.clone();
  run(120, intent({ throttle: 1, steer: 1 }));     // steer:+1 == LEFT
  const after = car.axes().fwd.clone();
  check('steer +1 turns left', after.x < before.x - 0.05,
    `fwd.x ${before.x.toFixed(3)} -> ${after.x.toFixed(3)}`);
}
{
  const { car, run } = rig();
  car.resetTo([0, 0.2, 0], 0);
  run(60, intent());
  run(150, intent({ throttle: 1 }));
  const before = car.axes().fwd.clone();
  run(120, intent({ throttle: 1, steer: -1 }));
  const after = car.axes().fwd.clone();
  check('steer -1 turns right', after.x > before.x + 0.05,
    `fwd.x ${before.x.toFixed(3)} -> ${after.x.toFixed(3)}`);
}

// ══════════════════════════════════════════════════════════════
console.log('\n── jumping ──');
{
  const { car, run, stats } = rig();
  car.resetTo([0, 0.2, 0], 0);
  run(90, intent());
  for (let i = 0; i < 6; i++) { run(1, intent({ jump: true })); run(80, intent()); }
  const s = stats();
  check('no phantom damage from jumping', s.impacts === 0,
    `${s.impacts} impact event(s), score ${s.damageTaken.toFixed(2)}`);
}
{
  const { car, run } = rig();
  car.resetTo([0, 0.2, 0], 0);
  run(90, intent());
  const base = car.position.y;
  run(1, intent({ jump: true }));
  let peak = base;
  for (let i = 0; i < 90; i++) { run(1, intent()); peak = Math.max(peak, car.position.y); }
  check('jump clears 1 m', peak - base > 1.0, `peak +${(peak - base).toFixed(2)} m`);
}

// ══════════════════════════════════════════════════════════════
console.log('\n── air control ──');
// Measured as steady-state LOCAL angular velocity. Comparing quaternion angles
// is useless here: a full flip wraps past 180 deg and reads as a small number.
for (const [name, axis, key, sign] of [
  ['flip',        'x', 'throttle',  1],
  ['barrel roll', 'z', 'steer',     1],
  ['spin',        'y', 'yaw',      -1],
]) {
  const { car, run } = rig({ car: 'hornet' });
  car.resetTo([0, 30, 0], 0);
  run(4, intent());
  run(45, intent({ [key]: 1 }));
  const av = car.body.angvel();
  const q = car.axes().q.clone();
  const local = new THREE.Vector3(av.x, av.y, av.z).applyQuaternion(q.invert());
  const got = local[axis];
  const others = ['x', 'y', 'z'].filter((a) => a !== axis).map((a) => Math.abs(local[a]));
  check(`${name.padEnd(11)} spins about local ${axis}`,
    sign * got > 3.0 && Math.max(...others) < 1.5,
    `local angvel (${local.x.toFixed(2)}, ${local.y.toFixed(2)}, ${local.z.toFixed(2)}) rad/s`);
}

// ══════════════════════════════════════════════════════════════
console.log('\n── flip-dash ──');
{
  const { car, run } = rig({ car: 'hornet' });
  car.resetTo([0, 0.2, 0], 0);
  run(60, intent());
  run(200, intent({ throttle: 1 }));
  run(1, intent({ jump: true }));           // hop
  run(12, intent());
  const before = car.absSpeed;
  check('flip is available in the air', car.airborne && car.flipReady);
  run(1, intent({ jump: true, throttle: 1 }));   // dash forward
  run(4, intent());
  check('flip-dash adds speed', car.absSpeed > before + 2,
    `${before.toFixed(1)} -> ${car.absSpeed.toFixed(1)} m/s`);
  check('flip is consumed', !car.flipReady);
}

// ══════════════════════════════════════════════════════════════
console.log('\n── self-righting ──');
{
  const { car, run } = rig();
  car.resetTo([0, 0.2, 0], 0);
  car.body.setRotation({ x: 1, y: 0, z: 0, w: 0 }, true);   // upside down
  run(120, intent());
  check('starts inverted', car.upright < -0.8, `up=${car.upright.toFixed(2)}`);
  run(1, intent({ reset: true }));
  run(120, intent());
  check('R flips the car back over', car.upright > 0.95, `up=${car.upright.toFixed(2)}`);
}
{
  const { car, run } = rig();
  car.resetTo([0, 0.2, 0], 0);
  car.body.setRotation({ x: 1, y: 0, z: 0, w: 0 }, true);
  run(60 * 5, intent());     // 5 s stuck on the roof, no input at all
  check('auto-rights after being stuck', car.upright > 0.95, `up=${car.upright.toFixed(2)}`);
}

// ══════════════════════════════════════════════════════════════
console.log('\n── damage ──');
{
  const { car, run } = rig();
  car.onImpact = (mag) => car.damage(mag * 40, null);
  car.resetTo([0, 0.2, 0], 0);
  run(90, intent());
  run(300, intent({ throttle: 1 }));
  check('no damage from ordinary driving', car.health === 100, `health ${car.health.toFixed(0)}`);
}
{
  // drive a wall into existence and hit it hard
  const r = rig();
  const wb = r.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 3, 70));
  r.world.createCollider(
    RAPIER.ColliderDesc.cuboid(30, 4, 1).setCollisionGroups(GROUPS.world), wb);
  r.car.onImpact = (mag) => r.car.damage(mag * 60, null);
  r.car.resetTo([0, 0.2, 0], 0);
  r.run(60, intent());
  r.run(300, intent({ throttle: 1, boost: true }));
  const hitSpeed = r.car.absSpeed;
  r.run(90, intent({ throttle: 1 }));
  check('hitting a wall hurts', r.car.health < 95,
    `health ${r.car.health.toFixed(0)} after a ${(hitSpeed * 3.6).toFixed(0)} km/h hit`);
  check('but is survivable', r.car.health > 0 || !r.car.alive);
}

// ══════════════════════════════════════════════════════════════
console.log('\n── the loop (real arena geometry) ──');
{
  const { car, run } = rig({ car: 'volt', arena: true });
  car.resetTo([34, 0.3, -6], Math.PI / 2);         // on the run-up lane, facing +X at the loop
  run(10, intent());
  car.body.setLinvel({ x: 34, y: 0, z: 0 }, true); // arrive with real pace
  let peakY = 0, inverted = false;
  for (let i = 0; i < 300; i++) {
    run(1, intent({ throttle: 1, boost: true }));
    peakY = Math.max(peakY, car.position.y);
    if (car.upright < -0.5) inverted = true;
  }
  check('gets round the loop', peakY > 20 && inverted,
    `peak y=${peakY.toFixed(1)} m, inverted=${inverted}`);
}

console.log(`\n${failures === 0 ? 'simtest: ALL PASS' : `simtest: ${failures} FAILURE(S)`}\n`);
process.exit(failures ? 1 : 0);
