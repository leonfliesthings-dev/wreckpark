import * as THREE from 'three';
import { initPhysics, createWorld } from '../src/game/physics.js';
import { buildArena } from '../src/game/arena.js';
await initPhysics();
const world = createWorld();
const a = buildArena(new THREE.Scene(), world, 'low');
console.log(`found ${a.spawns.length} spawns:`);
for (const s of a.spawns) {
  console.log(`  (${s.pos[0].toFixed(1).padStart(6)}, ${s.pos[2].toFixed(1).padStart(6)})  r=${Math.hypot(s.pos[0],s.pos[2]).toFixed(0).padStart(3)}  yaw=${(s.yaw*180/Math.PI).toFixed(0).padStart(4)}deg  runway=${String(s.runway).padStart(2)}m`);
}
