/**
 * Trick detection and scoring.
 *
 * Rotation is accumulated as a running total in the car's own local axes, so a
 * backflip stays a backflip no matter which way the car is pointing. Points sit
 * in a "pending" pot with a multiplier while you are in the air, and are only
 * banked if you land it — bin it and you lose the lot.
 */
import * as THREE from 'three';

const TAU = Math.PI * 2;

const _qPrev = new THREE.Quaternion();
const _dq = new THREE.Quaternion();
const _axis = new THREE.Vector3();

export const TRICK_POINTS = {
  flip: 520,
  roll: 460,
  spin: 210,        // per 180
  bigAir: 300,
  hugeAir: 750,
  orbit: 1600,
  skyHigh: 620,
  wallRide: 420,    // per second on the wall
  loop: 1400,
  corkscrew: 900,
  closeCall: 260,
  stomp: 180,
  perfect: 250,     // dead-flat landing
};

export class TrickTracker {
  constructor(handlers = {}) {
    this.on = handlers;   // { trick, bank, bail, wallRide }
    this.reset();
  }

  reset() {
    this.pitch = 0; this.yaw = 0; this.roll = 0;
    this.airborne = false;
    this.airTime = 0;
    this.takeoffY = 0;
    this.apexY = 0;

    this.pending = 0;
    this.tricks = [];             // labels this combo
    this.kinds = new Set();
    this.counts = { flip: 0, roll: 0, spin: 0 };
    this.chain = 0;               // combos linked back to back
    this.chainTimer = 0;

    this.wallTime = 0;
    this.wallBanked = 0;
    this.closeCallCooldown = 0;
    this.hasQ = false;

    // loop-the-loop signature: went upside-down while still on a surface,
    // then came back upright on a surface shortly afterwards
    this.loopArmed = false;
    this.loopTimer = 0;
  }

  get multiplier() {
    return Math.max(1, this.kinds.size + this.chain);
  }

  get active() {
    return this.pending > 0;
  }

  _award(label, points, kind) {
    this.kinds.add(kind);
    this.tricks.push(label);
    this.pending += points;
    if (this.on.trick) this.on.trick(label, points, this.tricks.length);
  }

  /**
   * @param {number} dt
   * @param {Vehicle} car
   * @param {object} ctx  { nearby: [{x,y,z}], enabled: boolean }
   */
  update(dt, car, ctx = {}) {
    if (ctx.enabled === false || !car.alive) { this._flushWall(); return; }

    const r = car.rotation;
    if (!this.hasQ) {
      _qPrev.set(r.x, r.y, r.z, r.w);
      this.hasQ = true;
      return;
    }

    // ── rotation delta expressed in the car's own frame ──
    _dq.set(r.x, r.y, r.z, r.w);
    _dq.premultiply(_qPrev.clone().invert());
    if (_dq.w < 0) { _dq.x *= -1; _dq.y *= -1; _dq.z *= -1; _dq.w *= -1; }
    const s = Math.hypot(_dq.x, _dq.y, _dq.z);
    let dPitch = 0, dYaw = 0, dRoll = 0;
    if (s > 1e-7) {
      const angle = 2 * Math.atan2(s, _dq.w);
      _axis.set(_dq.x / s, _dq.y / s, _dq.z / s);
      dPitch = _axis.x * angle;
      dYaw = _axis.y * angle;
      dRoll = _axis.z * angle;
    }
    _qPrev.set(r.x, r.y, r.z, r.w);

    this.chainTimer = Math.max(0, this.chainTimer - dt);
    if (this.chainTimer === 0 && !this.airborne) this.chain = 0;
    this.closeCallCooldown = Math.max(0, this.closeCallCooldown - dt);

    const wasAir = this.airborne;
    // a car stranded on its roof counts as landed, not still flying
    this.airborne = car.airborne && !car.beached;
    this._checkLoop(dt, car);

    // ── takeoff ──
    if (this.airborne && !wasAir) {
      this.pitch = this.yaw = this.roll = 0;
      this.counts = { flip: 0, roll: 0, spin: 0 };
      this.airTime = 0;
      this.takeoffY = car.position.y;
      this.apexY = car.position.y;
      if (this.chainTimer > 0) this.chain++; else { this.pending = 0; this.tricks = []; this.kinds.clear(); }
    }

    if (this.airborne) {
      this.airTime += dt;
      this.pitch += dPitch;
      this.yaw += dYaw;
      this.roll += dRoll;
      this.apexY = Math.max(this.apexY, car.position.y);
      this._scoreAir(car, ctx);
      this._flushWall();
    } else {
      // ── landing ──
      if (wasAir) this._land(car);
      this._scoreGround(dt, car);
    }
  }

  _scoreAir(car, ctx) {
    // flips
    const flips = Math.floor(Math.abs(this.pitch) / TAU);
    while (this.counts.flip < flips) {
      this.counts.flip++;
      const n = this.counts.flip;
      const back = this.pitch < 0;
      const label = n === 1 ? (back ? 'BACKFLIP' : 'FRONT FLIP')
                            : `${back ? 'BACKFLIP' : 'FRONT FLIP'} x${n}`;
      this._award(label, TRICK_POINTS.flip * n, 'flip');
    }

    // barrel rolls
    const rolls = Math.floor(Math.abs(this.roll) / TAU);
    while (this.counts.roll < rolls) {
      this.counts.roll++;
      const n = this.counts.roll;
      this._award(n === 1 ? 'BARREL ROLL' : `BARREL ROLL x${n}`, TRICK_POINTS.roll * n, 'roll');
    }

    // spins, in 180s
    const spins = Math.floor(Math.abs(this.yaw) / Math.PI);
    while (this.counts.spin < spins) {
      this.counts.spin++;
      const deg = this.counts.spin * 180;
      this._award(`${deg}`, TRICK_POINTS.spin * this.counts.spin, 'spin');
    }

    // corkscrew: meaningful rotation on two axes at once
    if (!this.kinds.has('cork') && Math.abs(this.pitch) > Math.PI && Math.abs(this.roll) > Math.PI) {
      this._award('CORKSCREW', TRICK_POINTS.corkscrew, 'cork');
    }

    // hang time
    if (!this.kinds.has('air') && this.airTime > 1.2) this._award('BIG AIR', TRICK_POINTS.bigAir, 'air');
    if (!this.kinds.has('air2') && this.airTime > 2.5) this._award('HUGE AIR', TRICK_POINTS.hugeAir, 'air2');
    if (!this.kinds.has('air3') && this.airTime > 4.0) this._award('LOW ORBIT', TRICK_POINTS.orbit, 'air3');

    // altitude
    if (!this.kinds.has('high') && this.apexY - this.takeoffY > 14) {
      this._award('SKYSCRAPER', TRICK_POINTS.skyHigh, 'high');
    }

    // buzzing another car mid-air
    if (this.closeCallCooldown === 0 && ctx.nearby && car.absSpeed > 16) {
      const p = car.position;
      for (const o of ctx.nearby) {
        const d = Math.hypot(o.x - p.x, o.y - p.y, o.z - p.z);
        if (d < 3.6) {
          this._award('CLOSE CALL', TRICK_POINTS.closeCall, 'close');
          this.closeCallCooldown = 1.5;
          break;
        }
      }
    }
  }

  _scoreGround(dt, car) {
    // wall ride: wheels on a surface that is nowhere near horizontal
    const n = car.contactNormal;
    const steep = car.wheelsOnGround >= 2 && n.y < 0.55 && car.absSpeed > 7;
    if (steep) {
      this.wallTime += dt;
      if (this.wallTime > 0.55) {
        this.wallBanked += TRICK_POINTS.wallRide * dt;
        if (this.on.wallRide) this.on.wallRide(this.wallTime);
      }
    } else {
      this._flushWall();
    }

  }

  /**
   * Detecting the loop by accumulating pitch is unreliable — the car is on a
   * banked, drifting surface and briefly goes light over the top. The robust
   * signature is simply: it was upside-down with wheels on a surface, and came
   * back upright on a surface soon after. Air flips can never satisfy that,
   * because an airborne car has no wheels in contact.
   */
  _checkLoop(dt, car) {
    if (car.wheelsOnGround >= 2 && car.upright < -0.45) {
      this.loopArmed = true;
      this.loopTimer = 3.5;
    }
    if (this.loopTimer > 0) {
      this.loopTimer -= dt;
      if (this.loopArmed && car.wheelsOnGround >= 2 && car.upright > 0.5) {
        this.loopArmed = false;
        this.loopTimer = 0;
        this.kinds.add('loop');
        this.tricks.push('LOOP THE LOOP');
        this.pending += TRICK_POINTS.loop;
        if (this.on.trick) this.on.trick('LOOP THE LOOP', TRICK_POINTS.loop, this.tricks.length);
        this._bank(1);
      }
      if (this.loopTimer <= 0) this.loopArmed = false;
    }
  }

  _flushWall() {
    if (this.wallBanked > 0) {
      const pts = Math.round(this.wallBanked);
      this.wallBanked = 0;
      this.kinds.add('wall');
      this.tricks.push('WALL RIDE');
      this.pending += pts;
      if (this.on.trick) this.on.trick('WALL RIDE', pts, this.tricks.length);
      this._bank(1);
    }
    this.wallTime = 0;
  }

  _land(car) {
    if (this.pending <= 0) { this.chainTimer = 0.9; return; }

    const upright = car.upright;
    const impact = car.landImpact;

    if (upright < 0.30 || impact > 26) {
      // landed on the roof or absolutely destroyed it
      this.pending = 0;
      this.tricks = [];
      this.kinds.clear();
      this.chain = 0;
      this.chainTimer = 0;
      if (this.on.bail) this.on.bail();
      return;
    }

    let quality = 1;
    if (upright > 0.90 && impact < 12) {
      this.kinds.add('clean');
      this.pending += TRICK_POINTS.perfect;
      this.tricks.push('CLEAN LANDING');
    } else if (upright < 0.6) {
      quality = 0.55;   // scrappy, but you kept it
    }
    this._bank(quality);
  }

  _bank(quality) {
    const mult = this.multiplier;
    const total = Math.round(this.pending * mult * quality);
    const tricks = this.tricks.slice();
    this.pending = 0;
    this.tricks = [];
    this.kinds.clear();
    this.chainTimer = 1.6;     // land another one quickly to keep the chain
    if (total > 0 && this.on.bank) this.on.bank(total, mult, tricks);
    return total;
  }

  /** Called when the car is wrecked or the round ends — no free points. */
  cancel() {
    if (this.pending > 0 && this.on.bail) this.on.bail();
    this.pending = 0;
    this.tricks = [];
    this.kinds.clear();
    this.chain = 0;
    this.chainTimer = 0;
    this.wallBanked = 0;
    this.wallTime = 0;
  }
}
