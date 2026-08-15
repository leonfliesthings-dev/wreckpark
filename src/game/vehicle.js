/**
 * The car. A Rapier raycast-vehicle for the driving, plus a layer of arcade
 * nonsense on top: boost, jumps, flip-dashes, direct air control, downforce
 * that lets you hold a loop, and impact damage.
 */
import * as THREE from 'three';
import { RAPIER, GROUPS, G, groups, GRAVITY } from './physics.js';
import { clamp, smoothTo } from '../core/util.js';

// Sign convention verified empirically by tools/simtest.mjs: with axle = -X and
// forward = +Z, a positive Rapier steering angle already turns the car left,
// which matches "steer +1 = left" from Input.sample().
const STEER_SIGN = 1;
const GRAV = -GRAVITY;   // positive magnitude, used to cancel gravity out of impact detection
const FORWARD_AXIS = 2;   // +Z
const UP_AXIS = 1;        // +Y

// air-control rates (rad/s) before the car's airControl multiplier
const RATE_PITCH = 5.6;
const RATE_ROLL = 6.6;
const RATE_YAW = 3.8;
const AIR_RESPONSE = 14;
// Arrow keys rotate at this fraction of the full rate: enough to line a landing
// up, not enough to throw a flip with.
const TRIM_FACTOR = 0.34;

const WHEEL_FL = 0, WHEEL_FR = 1, WHEEL_RL = 2, WHEEL_RR = 3;

const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _av = new THREE.Vector3();
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);

export class Vehicle {
  /**
   * @param {object} opts
   *   world      Rapier world
   *   type       entry from CAR_TYPES
   *   isRemote   network ghost (uses the REMOTE collision group)
   */
  constructor({ world, type, isRemote = false }) {
    this.world = world;
    this.type = type;
    this.phys = type.phys;
    this.bodyDef = type.body;
    this.isRemote = isRemote;

    // ── derived suspension geometry ──
    const bd = type.body, ph = type.phys;
    this.connY = -bd.h * 0.5;
    this.susRest = Math.max(0.20, bd.ride + this.connY - ph.wheelRadius + 0.10);

    // ── chassis ──
    const rbDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, bd.ride + 2, 0)
      .setLinearDamping(0.04)
      .setAngularDamping(0.55)
      .setCcdEnabled(true)
      .setCanSleep(false);
    this.body = world.createRigidBody(rbDesc);

    // Centre of mass sits well below the geometric centre — this is what stops
    // an arcade car tipping over every time it corners hard.
    const m = ph.mass;
    const I = {
      x: (m / 3) * (bd.h * bd.h + bd.l * bd.l),
      y: (m / 3) * (bd.w * bd.w + bd.l * bd.l),
      z: (m / 3) * (bd.w * bd.w + bd.h * bd.h),
    };
    // A rounded box, not a sharp one. A sharp front-bottom corner digs into any
    // surface that curves upward — the nose catches on ramp transitions and the
    // car stops dead instead of driving up. The rounded corner rides over them.
    const CR = 0.14;
    const colDesc = RAPIER.ColliderDesc.roundCuboid(bd.w - CR, bd.h - CR, bd.l - CR, CR)
      .setMassProperties(m, { x: 0, y: this.connY - 0.18, z: 0 }, I, { x: 0, y: 0, z: 0, w: 1 })
      .setFriction(0.42)
      .setRestitution(0.18)
      .setCollisionGroups(isRemote ? GROUPS.remote : GROUPS.car)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    this.collider = world.createCollider(colDesc, this.body);

    // ── raycast vehicle ──
    const vc = world.createVehicleController(this.body);
    vc.indexUpAxis = UP_AXIS;
    vc.setIndexForwardAxis = FORWARD_AXIS;   // setter is spelled differently to the getter
    this.vc = vc;

    const dir = { x: 0, y: -1, z: 0 };
    const axle = { x: -1, y: 0, z: 0 };
    const wheelPos = [
      { x: -bd.track, y: this.connY, z: bd.front },   // FL
      { x: bd.track, y: this.connY, z: bd.front },    // FR
      { x: -bd.track, y: this.connY, z: bd.rear },    // RL
      { x: bd.track, y: this.connY, z: bd.rear },     // RR
    ];
    for (const p of wheelPos) vc.addWheel(p, dir, axle, this.susRest, ph.wheelRadius);

    // Damping is specified as a fraction of critical damping for the chosen
    // stiffness. Raw values are wildly stiffness-dependent and produce a car
    // that pogos down the road.
    const crit = 2 * Math.sqrt(ph.suspensionStiffness);
    for (let i = 0; i < 4; i++) {
      vc.setWheelSuspensionStiffness(i, ph.suspensionStiffness);
      vc.setWheelMaxSuspensionTravel(i, ph.suspensionTravel);
      vc.setWheelSuspensionCompression(i, ph.suspensionDamp * crit);
      vc.setWheelSuspensionRelaxation(i, ph.suspensionRelax * crit);
      vc.setWheelMaxSuspensionForce(i, ph.mass * 42);
      vc.setWheelFrictionSlip(i, ph.frictionSlip);
      vc.setWheelSideFrictionStiffness(i, ph.sideFriction);
    }

    this.rayFilter = groups(
      isRemote ? G.REMOTE : G.CAR,
      G.WORLD | G.PROP | (isRemote ? G.CAR : G.REMOTE)
    );

    // ── runtime state ──
    this.health = 100;
    this.maxHealth = 100;
    this.boost = ph.boostMax;
    this.alive = true;

    this.steerAngle = 0;
    this.speed = 0;            // signed forward speed, m/s
    this.absSpeed = 0;
    this.wheelsOnGround = 0;
    this.airborne = false;
    this.airTime = 0;
    this.groundTime = 0;
    this.slip = 0;
    this.boosting = false;
    this.boostDir = 1;          // -1 when boosting in reverse
    this.overdrive = 0;        // seconds of doubled ram damage remaining

    this.slick = 0;              // seconds of no-grip left after hitting oil
    this.cleanLanding = false;   // wheels-down and upright: impacts are forgiven
    this.restTime = 0;
    this.beached = false;      // stopped on its roof / wedged: no wheels, but not flying
    this.jumpCooldown = 0;
    this.flipReady = true;
    this.flipLock = 0;
    this.resetCooldown = 0;
    this.stuckTime = 0;

    this.contactNormal = new THREE.Vector3(0, 1, 0);
    this._prevVel = new THREE.Vector3();
    this._vel = new THREE.Vector3();
    this._selfImp = new THREE.Vector3();     // impulses applied this step
    this._prevSelfImp = new THREE.Vector3(); // ...which only show up in next frame's velocity
    this._justLanded = 0;
    this._landImpact = 0;

    // set by the game loop from Rapier collision events
    this.lastCarContact = null;      // { id, t }
    this.onImpact = null;            // (magnitude 0..1, worldPoint, isCar) => void
    this.onDestroyed = null;         // (killerId) => void
  }

  // ── placement ────────────────────────────────────────────────
  resetTo(pos, yaw) {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.body.setTranslation({ x: pos[0], y: pos[1] + this.bodyDef.ride, z: pos[2] }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this._prevVel.set(0, 0, 0);
    this.steerAngle = 0;
    this.airTime = 0;
    this.stuckTime = 0;
    this.flipReady = true;
  }

  revive(pos, yaw) {
    this.health = this.maxHealth;
    this.boost = this.phys.boostMax;
    this.alive = true;
    this.overdrive = 0;
    this.resetTo(pos, yaw);
  }

  /** Flips the car back onto its wheels, keeping its heading. */
  selfRight() {
    const t = this.body.translation();
    const r = this.body.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    _fwd.set(0, 0, 1).applyQuaternion(_q);
    const yaw = Math.atan2(_fwd.x, _fwd.z);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setTranslation({ x: t.x, y: t.y + 1.1, z: t.z }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    const v = this.body.linvel();
    this.body.setLinvel({ x: v.x * 0.3, y: 0, z: v.z * 0.3 }, true);
    this.resetCooldown = 1.6;
    this.stuckTime = 0;
  }

  // ── frame helpers ────────────────────────────────────────────
  get position() { return this.body.translation(); }
  get rotation() { return this.body.rotation(); }
  get velocity() { return this.body.linvel(); }

  axes() {
    const r = this.body.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    _fwd.set(0, 0, 1).applyQuaternion(_q);
    _up.set(0, 1, 0).applyQuaternion(_q);
    _right.set(1, 0, 0).applyQuaternion(_q);
    return { q: _q, fwd: _fwd, up: _up, right: _right };
  }

  get upright() {
    const { up } = this.axes();
    return up.y;   // 1 = level, -1 = on the roof
  }

  // ── the main step ────────────────────────────────────────────
  /**
   * @param {number} dt fixed timestep
   * @param {object} it driving intent from Input.sample()
   */
  step(dt, it) {
    const ph = this.phys;
    const vc = this.vc;

    this.jumpCooldown = Math.max(0, this.jumpCooldown - dt);
    this.flipLock = Math.max(0, this.flipLock - dt);
    this.resetCooldown = Math.max(0, this.resetCooldown - dt);
    if (this.overdrive > 0) this.overdrive = Math.max(0, this.overdrive - dt);

    // ---- read chassis state ----
    const now = performance.now();
    const { q, fwd, up, right } = this.axes();
    const lv = this.body.linvel();
    this._vel.set(lv.x, lv.y, lv.z);
    this.speed = this._vel.dot(fwd);
    this.absSpeed = this._vel.length();

    // ---- ground contact ----
    let onGround = 0;
    this.contactNormal.set(0, 0, 0);
    for (let i = 0; i < 4; i++) {
      if (vc.wheelIsInContact(i)) {
        onGround++;
        const n = vc.wheelContactNormal(i);
        if (n) this.contactNormal.x += n.x, this.contactNormal.y += n.y, this.contactNormal.z += n.z;
      }
    }
    this.wheelsOnGround = onGround;
    if (onGround > 0) this.contactNormal.normalize();
    else this.contactNormal.copy(up);

    const wasAirborne = this.airborne;
    this.airborne = onGround === 0;
    // A car resting on its roof reports zero wheels in contact, because the
    // suspension rays point at the sky. Without this it would count as
    // airborne indefinitely and never register a landing.
    if (this.airborne && Math.abs(lv.y) < 1.6 && this.absSpeed < 6) this.restTime += dt;
    else this.restTime = 0;
    this.beached = this.restTime > 0.22;

    if (this.airborne) {
      this.airTime += dt;
      this.groundTime = 0;
    } else {
      if (wasAirborne) {
        this._justLanded = this.airTime;
        this._landImpact = Math.abs(this._prevVel.y - lv.y);
        this.flipReady = true;
      }
      // Coming down on your wheels the right way up is landing it, not
      // crashing. Suspension takes the hit; the bodywork should not.
      this.cleanLanding = up.y > 0.55 && onGround >= 2;
      this.airTime = 0;
      this.groundTime += dt;
    }

    if (!this.alive) {
      // wrecked cars still roll around, they just have no engine
      for (let i = 0; i < 4; i++) {
        vc.setWheelEngineForce(i, 0);
        vc.setWheelBrake(i, ph.brakeForce * 0.5);
        vc.setWheelSteering(i, 0);
      }
      this._detectImpacts(dt, now);
      return;
    }

    // ---- steering ----
    const grip = 1 - clamp(this.absSpeed / 90, 0, 0.62);   // less lock at speed
    const targetSteer = it.steer * ph.maxSteer * grip * STEER_SIGN;
    this.steerAngle = smoothTo(this.steerAngle, targetSteer, ph.steerSpeed, dt);
    vc.setWheelSteering(WHEEL_FL, this.steerAngle);
    vc.setWheelSteering(WHEEL_FR, this.steerAngle);

    // ---- engine / brakes ----
    let engine = 0;
    let brake = 0;
    // A wreck drives worse, but should still be fun rather than useless.
    const damageFactor = 0.74 + 0.26 * (this.health / this.maxHealth);

    if (it.throttle > 0) {
      const t = clamp(this.speed / ph.topSpeed, 0, 1);
      engine = ph.engineForce * it.throttle * (1 - t * t) * damageFactor;
    } else if (it.throttle < 0) {
      if (this.speed > 1.5) brake = ph.brakeForce;
      else engine = -ph.reverseForce * damageFactor;
    } else {
      brake = ph.brakeForce * 0.06;    // gentle engine braking
    }

    const handbrake = it.handbrake && !this.airborne;

    vc.setWheelEngineForce(WHEEL_FL, engine * 0.35);
    vc.setWheelEngineForce(WHEEL_FR, engine * 0.35);
    vc.setWheelEngineForce(WHEEL_RL, handbrake ? 0 : engine * 0.65);
    vc.setWheelEngineForce(WHEEL_RR, handbrake ? 0 : engine * 0.65);

    // Front brakes stay light under handbrake so the nose keeps steering while
    // the back end comes round — that is what makes a slide controllable
    // rather than just a spin.
    vc.setWheelBrake(WHEEL_FL, handbrake ? brake * 0.25 : brake);
    vc.setWheelBrake(WHEEL_FR, handbrake ? brake * 0.25 : brake);
    vc.setWheelBrake(WHEEL_RL, handbrake ? ph.brakeForce * 2.2 : brake);
    vc.setWheelBrake(WHEEL_RR, handbrake ? ph.brakeForce * 2.2 : brake);

    // oil: everything lets go for a moment
    this.slick = Math.max(0, this.slick - dt);
    const slickMul = this.slick > 0 ? 0.12 : 1;
    for (let i = 0; i < 4; i++) vc.setWheelFrictionSlip(i, ph.frictionSlip * slickMul);

    // drifting: let the back end go
    const rearGrip = (handbrake ? ph.sideFriction * 0.12 : ph.sideFriction) * slickMul;
    vc.setWheelSideFrictionStiffness(WHEEL_RL, rearGrip);
    vc.setWheelSideFrictionStiffness(WHEEL_RR, rearGrip);
    // a touch more front bite so it turns in hard
    const frontGrip = (handbrake ? ph.sideFriction * 1.25 : ph.sideFriction) * slickMul;
    vc.setWheelSideFrictionStiffness(WHEEL_FL, frontGrip);
    vc.setWheelSideFrictionStiffness(WHEEL_FR, frontGrip);

    // ---- boost ----
    this.boosting = false;
    if (it.boost && this.boost > 0.5) {
      this.boosting = true;
      this.boost = Math.max(0, this.boost - ph.boostDrain * dt);
      // Reversing? Boost backwards. Holding reverse while still rolling forward
      // is a brake, not a request to rocket backwards, so require low speed.
      this.boostDir = (it.throttle < 0 && this.speed < 1.5) ? -1 : 1;
      const f = ph.boostForce * (this.airborne ? 0.72 : 1) * dt * this.boostDir;
      this._impulse(fwd.x * f, fwd.y * f, fwd.z * f);
    } else {
      const regen = ph.boostRegen * (this.airborne ? 0.5 : 1);
      this.boost = Math.min(ph.boostMax, this.boost + regen * dt);
    }

    // ---- downforce: what makes the loop and the vert wall stick ----
    if (onGround > 0) {
      const s = Math.min(this.absSpeed, 60);
      const f = Math.min(ph.downforce * s * s, ph.mass * 42) * dt * (onGround / 4);
      const n = this.contactNormal;
      this._impulse(-n.x * f, -n.y * f, -n.z * f);
    }

    // ---- jump (CTRL) ----
    if (it.jump && this.alive) {
      if (onGround >= 2 && this.jumpCooldown <= 0) {
        const j = ph.mass * ph.jumpImpulse * 7.2;
        const n = this.contactNormal;
        this._impulse(n.x * j * 0.35, j, n.z * j * 0.35);
        this.jumpCooldown = 0.4;
        this.flipReady = true;
        this.flipLock = 0.12;
      }
    }
    // ---- flip-dash (SPACE, in the air only) ----
    if ((it.dash ?? it.jump) && this.alive && this.airborne && this.flipReady && this.flipLock <= 0) {
      this._flipDash(it, fwd, up, right);
    }

    // ---- air control ----
    if (this.airborne) this._airControl(dt, it, q);

    // ---- stuck / upside-down handling ----
    if (it.reset && this.resetCooldown <= 0) this.selfRight();
    // Note: an upside-down car reports zero wheels on the ground, because the
    // suspension rays point at the sky. So this must not test wheel contact.
    const av = this.body.angvel();
    const spinning = Math.hypot(av.x, av.y, av.z) > 1.2;
    if (up.y < 0.35 && this.absSpeed < 1.8 && !spinning) {
      this.stuckTime += dt;
      if (this.stuckTime > 2.0) this.selfRight();
    } else if (up.y > 0.5) {
      this.stuckTime = 0;
    }

    // ---- tyre slip (for audio + smoke) ----
    let lateral = 0;
    for (let i = 0; i < 4; i++) {
      const si = vc.wheelSideImpulse(i);
      if (si) lateral += Math.abs(si);
    }
    const slipRaw = lateral / (ph.mass * 0.14);
    this.slip = clamp(onGround > 0 ? slipRaw : 0, 0, 1);
    // smoke on demand: yanking the handbrake should always light the tyres up
    if (handbrake && this.absSpeed > 6) this.slip = Math.max(this.slip, 0.75);

    this._detectImpacts(dt, now);
  }

  _airControl(dt, it, q) {
    const ac = this.phys.airControl;
    // WASD throws the trick at full rate; the arrows trim it at a third of that
    const pitchIn = it.airPitch ?? it.throttle;
    const rollIn = it.airRoll ?? it.steer;
    const trimPitch = it.trimPitch || 0;
    const trimRoll = it.trimRoll || 0;
    const yawIn = it.yaw;
    if (!pitchIn && !rollIn && !yawIn && !trimPitch && !trimRoll) return;

    _qi.copy(q).invert();
    const av = this.body.angvel();
    _av.set(av.x, av.y, av.z).applyQuaternion(_qi);   // into local space

    const maxPitch = RATE_PITCH * ac;
    const maxRoll = RATE_ROLL * ac;

    if (pitchIn || trimPitch) {
      const target = clamp(pitchIn * maxPitch + trimPitch * maxPitch * TRIM_FACTOR, -maxPitch, maxPitch);
      _av.x = smoothTo(_av.x, target, AIR_RESPONSE, dt);
    }
    if (rollIn || trimRoll) {
      const target = clamp(rollIn * maxRoll + trimRoll * maxRoll * TRIM_FACTOR, -maxRoll, maxRoll);
      _av.z = smoothTo(_av.z, target, AIR_RESPONSE, dt);
    }
    if (yawIn) _av.y = smoothTo(_av.y, -yawIn * RATE_YAW * ac, AIR_RESPONSE, dt);

    _av.applyQuaternion(q);                            // back to world
    this.body.setAngvel({ x: _av.x, y: _av.y, z: _av.z }, true);
  }

  _flipDash(it, fwd, up, right) {
    const ph = this.phys;
    const m = ph.mass;
    const dirX = it.steer, dirZ = it.throttle;
    const imp = m * ph.dashImpulse * 6.4;

    if (!dirX && !dirZ) {
      // no stick input: straight forward dash with a front flip
      this._impulse(fwd.x * imp, fwd.y * imp, fwd.z * imp);
      this._spin(right, 1, 9);
    } else {
      const len = Math.hypot(dirX, dirZ);
      const nx = dirX / len, nz = dirZ / len;
      _v.set(0, 0, 0)
        .addScaledVector(fwd, nz * imp)
        .addScaledVector(right, -nx * imp);
      // keep a little lift so a side-dash does not just scrub the ground
      this._impulse(_v.x, _v.y + m * 0.9, _v.z);
      // rotate about the axis perpendicular to the dash
      _v.set(0, 0, 0).addScaledVector(right, nz).addScaledVector(fwd, nx).normalize();
      this._spin(_v, 1, 9.5);
    }

    this.flipReady = false;
    this.flipLock = 0.25;
  }

  _spin(axis, sign, rate) {
    const av = this.body.angvel();
    _av.set(av.x, av.y, av.z).addScaledVector(axis, sign * rate);
    // stop the car becoming an uncontrollable gyroscope
    if (_av.length() > 14) _av.setLength(14);
    this.body.setAngvel({ x: _av.x, y: _av.y, z: _av.z }, true);
  }

  /** Applies an impulse and remembers it, so it is not mistaken for a crash. */
  _impulse(x, y, z) {
    this._selfImp.x += x; this._selfImp.y += y; this._selfImp.z += z;
    this.body.applyImpulse({ x, y, z }, true);
  }

  /**
   * Impacts are detected from the per-step change in velocity — far more stable
   * than reading contact forces, and it scales naturally with how hard you hit.
   * Gravity and our own boost/jump impulses are subtracted first, otherwise
   * every jump would read as a head-on collision.
   */
  _detectImpacts(dt, now) {
    // The impulses to cancel are the ones applied LAST frame — those are what
    // this frame's velocity actually reflects.
    const m = this.phys.mass;
    const dvx = this._vel.x - this._prevVel.x - this._prevSelfImp.x / m;
    const dvy = this._vel.y - this._prevVel.y - this._prevSelfImp.y / m + GRAV * dt;
    const dvz = this._vel.z - this._prevVel.z - this._prevSelfImp.z / m;
    const dv = Math.hypot(dvx, dvy, dvz);

    this._prevVel.copy(this._vel);
    this._prevSelfImp.copy(this._selfImp);
    this._selfImp.set(0, 0, 0);

    // Landing squarely on the wheels needs a far bigger jolt to count as a hit,
    // and hurts much less when it does.
    const clean = this.cleanLanding;
    const THRESH = clean ? 19 : 6.5;
    if (dv <= THRESH) return;

    const contact = this.lastCarContact;
    const isCar = contact && now - contact.t < 120;
    let magnitude = clamp((dv - THRESH) / 26, 0, 1);
    if (clean) magnitude *= 0.25;

    // The car was shoved along dv, so whatever hit it is on the opposite side.
    // Express that in body-local space for the deformation model.
    _v.set(-dvx / dv, -dvy / dv, -dvz / dv);
    const r = this.body.rotation();
    _qa.set(r.x, r.y, r.z, r.w).invert();
    _v.applyQuaternion(_qa);

    if (this.onImpact) this.onImpact(magnitude, isCar ? contact.id : null, _v);
  }

  /** Applies damage. Returns true if this blow wrecked the car. */
  damage(amount, sourceId) {
    if (!this.alive) return false;
    this.health = Math.max(0, this.health - amount);
    if (this.health <= 0) {
      this.alive = false;
      if (this.onDestroyed) this.onDestroyed(sourceId);
      return true;
    }
    return false;
  }

  repair(amount) {
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  addBoost(amount) {
    this.boost = Math.min(this.phys.boostMax, this.boost + amount);
  }

  /**
   * Wheel transform in CHASSIS-LOCAL space — what the renderer actually wants,
   * since the wheel meshes are children of the car group. Avoids a world->local
   * conversion against a matrix that has not been updated yet this frame.
   */
  wheelLocalTransform(i, outPos, outRot) {
    const vc = this.vc;
    const conn = vc.wheelChassisConnectionPointCs(i);
    const len = vc.wheelSuspensionLength(i) ?? this.susRest;
    outPos.set(conn.x, conn.y - len, conn.z);
    const steer = vc.wheelSteering(i) || 0;
    const spin = vc.wheelRotation(i) || 0;
    outRot.setFromAxisAngle(AXIS_Y, steer).multiply(_qb.setFromAxisAngle(AXIS_X, -spin));
    return outPos;
  }

  /** Wheel transform in world space (used by effects). */
  wheelTransform(i, outPos, outRot) {
    const vc = this.vc;
    const t = this.body.translation();
    const r = this.body.rotation();
    _q.set(r.x, r.y, r.z, r.w);

    const conn = vc.wheelChassisConnectionPointCs(i);
    const len = vc.wheelSuspensionLength(i) ?? this.susRest;
    _v.set(conn.x, conn.y - len, conn.z).applyQuaternion(_q);
    outPos.set(t.x + _v.x, t.y + _v.y, t.z + _v.z);

    const steer = vc.wheelSteering(i) || 0;
    const spin = vc.wheelRotation(i) || 0;
    outRot.copy(_q)
      .multiply(_qa.setFromAxisAngle(AXIS_Y, steer))
      .multiply(_qb.setFromAxisAngle(AXIS_X, -spin));
    return { pos: outPos, rot: outRot };
  }

  /** Runs the suspension solve. MUST be called before world.step(). */
  preStep(dt) {
    this.vc.updateVehicle(
      dt,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      this.rayFilter
    );
  }

  /** Consumes the "we just landed" edge, returning air time or 0. */
  takeLanding() {
    const t = this._justLanded;
    this._justLanded = 0;
    return t;
  }

  get landImpact() { return this._landImpact; }

  dispose() {
    this.world.removeVehicleController(this.vc);
    this.world.removeRigidBody(this.body);
  }
}
