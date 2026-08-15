/**
 * Bot drivers.
 *
 * A bot is a completely normal Vehicle — same physics, same weapons, same
 * damage — with a small state machine writing its intent each frame instead of
 * a keyboard. Nothing about the car is special-cased, so anything that feels
 * good to drive feels good to fight.
 */
import * as THREE from 'three';
import { Vehicle } from './vehicle.js';
import { buildCar } from './carBuilder.js';
import { DamageModel } from './damage.js';
import { Armoury } from './weapons.js';
import { getCar, CAR_TYPES } from './carTypes.js';
import { clamp, rand, pick, playerColor } from '../core/util.js';

const NAMES = [
  'RUST', 'BOLT', 'DIESEL', 'CRUSH', 'SPANNER', 'GRIT',
  'AXLE', 'TORQUE', 'PISTON', 'SCRAP', 'WELDER', 'CLUTCH',
];

export const DIFFICULTY = {
  easy:   { aim: 0.30, react: 0.55, aggression: 0.55, skill: 0.55, fireCone: 0.30 },
  normal: { aim: 0.16, react: 0.30, aggression: 0.78, skill: 0.78, fireCone: 0.22 },
  hard:   { aim: 0.07, react: 0.16, aggression: 1.0,  skill: 1.0,  fireCone: 0.16 },
};

const _v = new THREE.Vector3();
const _to = new THREE.Vector3();

export class Bot {
  constructor({ scene, world, carId, slot, name, difficulty = 'normal', spawn }) {
    const type = getCar(carId);
    this.type = type;
    this.id = -100 - slot;              // ids that can never collide with server ids
    this.slot = slot;
    this.name = name;
    this.isBot = true;
    this.diff = DIFFICULTY[difficulty] || DIFFICULTY.normal;

    this.vehicle = new Vehicle({ world, type });
    this.visual = buildCar(type, null, playerColor(slot));
    this.damage = new DamageModel(this.visual.shellMesh, type.body);
    this.arms = new Armoury(type.id);
    scene.add(this.visual.group);
    this.scene = scene;

    this.target = null;
    this.retarget = 0;
    this.think = 0;
    this.steerNoise = rand(-1, 1);
    this.wander = new THREE.Vector3(rand(-70, 70), 0, rand(-70, 70));
    this.stuckFor = 0;
    this.jumpCool = rand(1, 4);
    this.alive = true;
    this.score = 0;
    this.wrecks = 0;
    this.lives = 3;

    this.onFire = null;      // (weaponId, origin, dir) => void
    this.onDeploy = null;    // (counterId, pos) => void
    this.onWrecked = null;   // (killerId) => void

    this.vehicle.onImpact = (mag, carId2, localDir) => this._hurt(mag * 42, carId2, localDir);
    this.vehicle.onDestroyed = (killer) => {
      this.alive = false;
      this.damage.scorch();
      if (this.onWrecked) this.onWrecked(killer);
    };

    if (spawn) this.vehicle.revive(spawn.pos, spawn.yaw);
  }

  get position() { return this.vehicle.position; }
  get body() { return this.vehicle.body; }

  _hurt(amount, sourceId, localDir) {
    if (!this.alive) return;
    this.damage.apply(clamp(amount / 55, 0, 1), localDir);
    this.vehicle.damage(amount / this.type.phys.armor, sourceId);
  }

  /** Weapons call this when something of theirs lands on the bot. */
  takeHit(amount, sourceId, worldDirToward) {
    if (!this.alive) return;
    const r = this.vehicle.rotation;
    _v.copy(worldDirToward).applyQuaternion(
      new THREE.Quaternion(r.x, r.y, r.z, r.w).invert()
    ).normalize();
    this._hurt(amount, sourceId, _v);
  }

  revive(spawn) {
    this.alive = true;
    this.damage.reset();
    this.arms.reset();
    this.vehicle.revive(spawn.pos, spawn.yaw);
  }

  /**
   * @param {object} ctx { rivals: [{id, position, alive}], dt }
   */
  think2(dt, rivals) {
    const v = this.vehicle;
    const it = {
      throttle: 0, steer: 0, yaw: 0, airPitch: 0, airRoll: 0, trimPitch: 0, trimRoll: 0,
      boost: false, handbrake: false, jump: false, dash: false, jumpHeld: false,
      reset: false, camera: false, scores: false, fire: false, firePress: false, deploy: false,
    };
    if (!this.alive) return it;

    // ── choose someone to bully ──
    this.retarget -= dt;
    if (this.retarget <= 0 || !this.target || !this.target.alive) {
      this.retarget = rand(2, 4.5);
      let best = null, bestD = Infinity;
      const p = v.position;
      for (const r of rivals) {
        if (!r.alive || r.id === this.id) continue;
        const d = Math.hypot(r.position.x - p.x, r.position.z - p.z);
        if (d < bestD) { bestD = d; best = r; }
      }
      this.target = best;
    }

    const p = v.position;
    const { fwd, right, up } = v.axes();

    // where we are heading: a rival, or a wander point if we are alone
    if (this.target) {
      _to.set(this.target.position.x - p.x, 0, this.target.position.z - p.z);
    } else {
      _to.copy(this.wander).sub(_v.set(p.x, 0, p.z));
      if (_to.length() < 12) this.wander.set(rand(-70, 70), 0, rand(-70, 70));
    }
    const dist = _to.length();
    if (dist > 0.01) _to.multiplyScalar(1 / dist);

    // keep away from the perimeter wall
    const fromCentre = Math.hypot(p.x, p.z);
    if (fromCentre > 92) {
      _to.set(-p.x, 0, -p.z).normalize();
    }

    // ── steering ──
    const ahead = _to.dot(_v.set(fwd.x, 0, fwd.z).normalize());
    const side = _to.dot(_v.set(right.x, 0, right.z).normalize());
    // steer +1 is left, and +side means the target is to our right
    let steer = clamp(-side * 2.4, -1, 1);
    if (ahead < -0.2) steer = side > 0 ? -1 : 1;     // behind us: commit to a full turn
    this.steerNoise += rand(-dt, dt);
    this.steerNoise = clamp(this.steerNoise, -1, 1);
    it.steer = clamp(steer + this.steerNoise * (1 - this.diff.skill) * 0.5, -1, 1);

    // ── throttle ──
    it.throttle = 1;
    if (ahead < -0.35 && v.absSpeed < 6) it.throttle = -1;        // reverse out of a corner
    it.boost = ahead > 0.75 && dist > 14 && v.boost > 25 && Math.random() < this.diff.aggression;

    // ── the odd handbrake flick for tight turns ──
    it.handbrake = Math.abs(side) > 0.8 && v.absSpeed > 22 && Math.random() < 0.02 * this.diff.skill;

    // ── unstick ──
    if (v.absSpeed < 1.5 && !v.airborne) this.stuckFor += dt; else this.stuckFor = 0;
    if (this.stuckFor > 2.2) {
      it.throttle = -1;
      it.steer = this.steerNoise > 0 ? 1 : -1;
      if (this.stuckFor > 4) { it.reset = true; this.stuckFor = 0; }
    }

    // ── air: try to land on the wheels ──
    if (v.airborne) {
      const upness = up.y;
      if (upness < 0.9) {
        it.trimPitch = clamp(-fwd.y * 3, -1, 1) * this.diff.skill;
        it.trimRoll = clamp(right.y * 3, -1, 1) * this.diff.skill;
      }
    } else {
      this.jumpCool -= dt;
      if (this.jumpCool <= 0 && Math.random() < 0.4) {
        it.jump = true;
        this.jumpCool = rand(2.5, 7);
      }
    }

    // ── shooting ──
    this.arms.update(dt);
    this.think -= dt;
    if (this.target && this.arms.canFire()) {
      const aimAt = _v.set(
        this.target.position.x - p.x,
        this.target.position.y - p.y,
        this.target.position.z - p.z
      );
      const range = this.arms.w.range ?? 90;
      const d3 = aimAt.length();
      if (d3 < range) {
        aimAt.multiplyScalar(1 / d3);
        const cone = aimAt.dot(fwd);
        if (cone > 1 - this.diff.fireCone) {
          it.fire = true;
          it.firePress = true;
        }
      }
    }

    // ── countermeasures when someone is on our tail ──
    if (this.arms.canDeploy() && this.target) {
      const behind = _v.set(
        this.target.position.x - p.x, 0, this.target.position.z - p.z
      );
      const bd = behind.length();
      if (bd < 18 && bd > 2) {
        behind.multiplyScalar(1 / bd);
        const dotBack = behind.dot(_to.set(-fwd.x, 0, -fwd.z).normalize());
        if (dotBack > 0.55 && Math.random() < 0.02 * this.diff.aggression) it.deploy = true;
      }
    }

    return it;
  }

  /** Physics step. Call inside the fixed-timestep loop. */
  step(dt, rivals) {
    const it = this.think2(dt, rivals);
    this._lastIntent = it;
    this.vehicle.preStep(dt);
    this.vehicle.step(dt, it);
    return it;
  }

  /** Visual sync + weapon firing, once per rendered frame. */
  render(dt, camera) {
    const v = this.vehicle;
    const t = v._hasPrev ? v.renderPos : v.position;
    const r = v._hasPrev ? v.renderRot : v.rotation;
    this.visual.group.position.set(t.x, t.y, t.z);
    this.visual.group.quaternion.set(r.x, r.y, r.z, r.w);
    for (let i = 0; i < 4; i++) {
      v.wheelLocalTransform(i, this.visual.wheels[i].position, this.visual.wheels[i].quaternion);
    }
    if (!window.__wpNoFlush) this.damage.flush();

    const it = this._lastIntent;
    if (!it || !this.alive) return;

    const { fwd, up } = v.axes();
    if (it.fire && this.arms.canFire()) {
      const aim = _v.copy(fwd);
      // deliberate inaccuracy, scaled by difficulty
      aim.x += rand(-this.diff.aim, this.diff.aim);
      aim.y += rand(-this.diff.aim, this.diff.aim) * 0.4;
      aim.z += rand(-this.diff.aim, this.diff.aim);
      aim.normalize();
      const o = new THREE.Vector3(
        t.x + fwd.x * this.type.body.l + up.x * 0.25,
        t.y + fwd.y * this.type.body.l + up.y * 0.25,
        t.z + fwd.z * this.type.body.l + up.z * 0.25
      );
      this.arms.spendShot();
      if (this.onFire) this.onFire(this.arms.weaponId, o, aim.clone());
    }
    if (it.deploy && this.arms.canDeploy()) {
      this.arms.spendCharge();
      const o = new THREE.Vector3(
        t.x - fwd.x * (this.type.body.l + 1.6), t.y, t.z - fwd.z * (this.type.body.l + 1.6)
      );
      if (this.onDeploy) this.onDeploy(this.arms.counterId, o);
    }
  }

  dispose() {
    this.scene.remove(this.visual.group);
    this.visual.dispose();
    this.vehicle.dispose();
  }
}

/** Builds a field of bots on the spare spawn points. */
export function makeBots({ scene, world, count, spawns, difficulty, takenSlots = [1] }) {
  const bots = [];
  const names = [...NAMES].sort(() => Math.random() - 0.5);
  let slot = 1;
  for (let i = 0; i < count; i++) {
    while (takenSlots.includes(slot)) slot++;
    const spawn = spawns[(i + 1) % spawns.length];
    bots.push(new Bot({
      scene, world,
      carId: pick(CAR_TYPES).id,
      slot,
      name: names[i % names.length],
      difficulty,
      spawn,
    }));
    slot++;
  }
  return bots;
}
