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

export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.modeIndex = 0;
    this.pos = new THREE.Vector3(0, 6, -12);
    this.look = new THREE.Vector3();
    this.yaw = 0;
    this.shake = 0;
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
    this.shake = Math.min(1.4, this.shake + amount);
  }

  /** Drops the camera straight behind the car — used on spawn. */
  snapTo(car) {
    this._compute(car, 1 / 60);
    this.camera.position.copy(_desired);
    this.pos.copy(_desired);
    this.look.copy(_look);
    this.camera.lookAt(this.look);
  }

  _compute(car, dt) {
    const t = car.position;
    _target.set(t.x, t.y + 0.6, t.z);

    const r = car.rotation;
    _fwd.set(0, 0, 1).applyQuaternion(_quat.set(r.x, r.y, r.z, r.w));

    // Follow the direction of travel when moving, the nose when crawling. Using
    // velocity alone makes the camera swing wildly during a spin.
    const v = car.velocity;
    _flat.set(v.x, 0, v.z);
    const speed = _flat.length();
    if (speed > 4) _flat.multiplyScalar(1 / speed);
    else { _flat.set(_fwd.x, 0, _fwd.z).normalize(); }
    if (car.speed < -1) _flat.negate();       // reversing: look the way you are going

    // blend toward the car's own heading so a drift still shows where you point
    _flat.x = _flat.x * 0.72 + _fwd.x * 0.28;
    _flat.z = _flat.z * 0.72 + _fwd.z * 0.28;
    _flat.y = 0;
    if (_flat.lengthSq() < 1e-5) _flat.set(0, 0, 1);
    _flat.normalize();

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

    if (this.shake > 0.001) {
      const s = this.shake * 0.5;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
      this.camera.position.z += (Math.random() - 0.5) * s;
      this.shake *= Math.exp(-6 * dt);
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
