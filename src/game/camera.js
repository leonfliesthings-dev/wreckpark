/**
 * Chase camera. Follows the car's heading rather than its orientation, so
 * flipping and rolling does not make the player seasick, but leans and widens
 * with speed so fast driving reads as fast.
 */
import * as THREE from 'three';
import { clamp, smoothTo } from '../core/util.js';

const MODES = ['chase', 'close', 'bumper'];

const _target = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _flat = new THREE.Vector3();
const _up = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _ray = new THREE.Vector3();
const _vel = new THREE.Vector3();

export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.modeIndex = 0;
    this.pos = new THREE.Vector3(0, 6, -12);
    this.look = new THREE.Vector3();
    this.yaw = 0;
    this.shake = 0;
    this.shakeT = 0;
    this.reversing = false;
    this.baseFov = 68;
    this.fov = 68;
    /**
     * Optional (from, dir, maxDist) -> hitDistance|null. Without it the camera
     * happily ends up inside the loop or behind a ramp, and the player spends
     * the corner staring at the inside of a wall.
     */
    this.probe = null;
  }

  get mode() { return MODES[this.modeIndex]; }

  cycle() {
    this.modeIndex = (this.modeIndex + 1) % MODES.length;
    return this.mode;
  }

  addShake(amount) {
    if (amount < 0.08) return;         // ignore trivial knocks entirely
    if (this.shake < 0.01) this.shakeT = 0;
    this.shake = Math.min(1.2, this.shake + amount);
  }

  /** Drops the camera straight behind the car — used on spawn. */
  snapTo(car) {
    this.reversing = false;
    this._compute(car, 1 / 60);
    this.camera.position.copy(_desired);
    this.pos.copy(_desired);
    this.look.copy(_look);
    this.camera.lookAt(this.look);
  }

  _compute(car, dt) {
    // Follow the interpolated transform when there is one, so the camera and
    // the car agree about where the car is on every rendered frame.
    const t = car.renderPos && car._hasPrev ? car.renderPos : car.position;
    _target.set(t.x, t.y + 0.6, t.z);

    const r = car.renderRot && car._hasPrev ? car.renderRot : car.rotation;
    _fwd.set(0, 0, 1).applyQuaternion(_quat.set(r.x, r.y, r.z, r.w));

    const v = car.velocity;
    _vel.set(v.x, 0, v.z);
    const speed = _vel.length();

    // Reversing swings the camera round to the front so you can see where you
    // are going. Sticky thresholds either side of zero, otherwise it flickers
    // back and forth every time the speed crosses the line.
    if (car.speed < -1.5) this.reversing = true;
    else if (car.speed > 0.6) this.reversing = false;

    // Start from the car's heading (flipped when reversing) rather than from
    // velocity. Deriving it from velocity and then flipping it double-negates
    // the moment you are travelling backwards at any pace, which snapped the
    // camera back behind the car — and boost got you there almost instantly.
    _flat.set(_fwd.x, 0, _fwd.z);
    if (_flat.lengthSq() < 1e-5) _flat.set(0, 0, 1);
    _flat.normalize();
    if (this.reversing) _flat.negate();

    // lean toward the actual direction of travel so drifts read
    if (speed > 6) {
      _vel.multiplyScalar(1 / speed);
      _flat.lerp(_vel, 0.32);
      if (_flat.lengthSq() < 1e-5) _flat.set(0, 0, 1);
      _flat.normalize();
    }

    const fast = clamp(speed / 55, 0, 1);
    let dist, height, lookAhead, lookUp;
    switch (this.mode) {
      case 'close': dist = 6.4 + fast * 2.0; height = 2.4; lookAhead = 5; lookUp = 1.2; break;
      case 'bumper': dist = -1.2; height = 1.1; lookAhead = 14; lookUp = 0.9; break;
      default: dist = 9.5 + fast * 4.2; height = 4.0 + fast * 0.7; lookAhead = 7; lookUp = 1.6;
    }

    // when airborne, pull back and up so you can see your landing
    if (car.airborne) { dist += 2.2; height += 1.4; }

    _desired.copy(_target)
      .addScaledVector(_flat, -dist)
      .add(_up.set(0, height, 0));

    _look.copy(_target)
      .addScaledVector(_flat, lookAhead)
      .add(_up.set(0, lookUp, 0));

    this.targetFov = this.baseFov + fast * 14 + (car.boosting ? 6 : 0);
  }

  update(dt, car) {
    this._compute(car, dt);

    // The bumper cam is rigid; the chase cams lag for weight.
    const posRate = this.mode === 'bumper' ? 40 : 9.5;
    const lookRate = this.mode === 'bumper' ? 40 : 13;
    this.pos.x = smoothTo(this.pos.x, _desired.x, posRate, dt);
    this.pos.y = smoothTo(this.pos.y, _desired.y, posRate, dt);
    this.pos.z = smoothTo(this.pos.z, _desired.z, posRate, dt);
    this.look.x = smoothTo(this.look.x, _look.x, lookRate, dt);
    this.look.y = smoothTo(this.look.y, _look.y, lookRate, dt);
    this.look.z = smoothTo(this.look.z, _look.z, lookRate, dt);

    // pull in if the view is blocked
    if (this.probe && this.mode !== 'bumper') {
      _ray.copy(this.pos).sub(_target);
      const want = _ray.length();
      if (want > 0.05) {
        _ray.multiplyScalar(1 / want);
        const hit = this.probe(_target, _ray, want + 0.6);
        if (hit !== null && hit < want) {
          this.pos.copy(_target).addScaledVector(_ray, Math.max(1.4, hit - 0.45));
        }
      }
    }

    this.camera.position.copy(this.pos);

    // Shake as a decaying oscillation, NOT per-frame randomness. Random offsets
    // every frame are 60 Hz white noise: the world looks fine because the
    // camera frames it, but the car appears to stutter in place. This was the
    // whole of the "car judder" — measured at 1% of screen height per frame
    // with random shake, and 0.000% without.
    if (this.shake > 0.001 && !this.shakeDisabled) {
      this.shakeT += dt;
      const t = this.shakeT;
      const s = this.shake * 0.15;
      this.camera.position.x += Math.sin(t * 24.0) * Math.sin(t * 9.3) * s;
      this.camera.position.y += Math.sin(t * 19.5 + 1.7) * Math.sin(t * 11.1) * s;
      this.camera.position.z += Math.sin(t * 21.7 + 3.1) * Math.sin(t * 8.4) * s * 0.5;
      this.shake *= Math.exp(-9 * dt);
    } else {
      this.shake = 0;
    }

    this.camera.lookAt(this.look);

    this.fov = smoothTo(this.fov, this.targetFov, 5, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.02) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Slow orbit used behind the menus. */
  orbit(dt, centre, radius, height, time) {
    const a = time * 0.12;
    this.camera.position.set(
      centre.x + Math.cos(a) * radius,
      centre.y + height,
      centre.z + Math.sin(a) * radius
    );
    this.camera.lookAt(centre);
    if (this.camera.fov !== this.baseFov) {
      this.camera.fov = this.baseFov;
      this.camera.updateProjectionMatrix();
    }
  }
}
