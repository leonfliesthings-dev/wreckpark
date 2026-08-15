/**
 * A network ghost: someone else's car, driven by their client.
 *
 * It is a real dynamic body rather than a kinematic one. That matters for feel
 * — ramming someone visibly shoves them for a moment before they settle back
 * onto their own client's authoritative position. A kinematic ghost would just
 * stop you dead like a lamp post, which feels awful in a demolition derby.
 */
import * as THREE from 'three';
import { RAPIER, GROUPS } from './physics.js';
import { buildCar } from './carBuilder.js';
import { DamageModel } from './damage.js';
import { FLAG } from '../net/protocol.js';
import { playerColor, clamp } from '../core/util.js';

const CORRECTION_TIME = 0.14;   // seconds to close a position error
const BLEND = 0.45;             // how hard we chase it (1 = instant, kills the shove)
const SNAP_DIST = 7;            // beyond this, teleport instead

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class RemotePlayer {
  constructor({ scene, world, type, loadout, slot, name, id }) {
    this.id = id;
    this.name = name;
    this.type = type;
    this.scene = scene;
    this.world = world;
    this.alive = true;
    this.health = 100;
    this.flags = 0;
    this.boosting = false;
    this.hasState = false;

    const bd = type.body;
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, -200, 0)
        .setLinearDamping(0.1)
        .setAngularDamping(0.8)
        .setCanSleep(false)
    );
    const CR = 0.14;
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.roundCuboid(bd.w - CR, bd.h - CR, bd.l - CR, CR)
        .setMass(type.phys.mass)
        .setFriction(0.42)
        .setRestitution(0.18)
        .setCollisionGroups(GROUPS.remote)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      this.body
    );

    this.visual = buildCar(type, loadout, playerColor(slot));
    this.damage = new DamageModel(this.visual.shellMesh, bd);
    scene.add(this.visual.group);

    // wheels are cosmetic here — spun from speed, not simulated
    this.wheelSpin = 0;
    const w = bd;
    this.wheelHome = [
      [-w.track, -bd.ride + type.phys.wheelRadius, w.front],
      [w.track, -bd.ride + type.phys.wheelRadius, w.front],
      [-w.track, -bd.ride + type.phys.wheelRadius, w.rear],
      [w.track, -bd.ride + type.phys.wheelRadius, w.rear],
    ];
    this.visual.wheels.forEach((wheel, i) => wheel.position.fromArray(this.wheelHome[i]));

    this.nameTag = makeNameTag(name, playerColor(slot));
    scene.add(this.nameTag);
  }

  get position() { return this.body.translation(); }

  /** @param {object} s sampled network pose from NetClient.sample() */
  applyNetwork(s, dt) {
    this.hasState = true;
    const t = this.body.translation();
    const dx = s.px - t.x, dy = s.py - t.y, dz = s.pz - t.z;
    const err = Math.hypot(dx, dy, dz);

    if (err > SNAP_DIST) {
      this.body.setTranslation({ x: s.px, y: s.py, z: s.pz }, true);
      this.body.setLinvel({ x: s.vx, y: s.vy, z: s.vz }, true);
    } else {
      const cv = this.body.linvel();
      const tx = s.vx + dx / CORRECTION_TIME;
      const ty = s.vy + dy / CORRECTION_TIME;
      const tz = s.vz + dz / CORRECTION_TIME;
      this.body.setLinvel({
        x: cv.x + (tx - cv.x) * BLEND,
        y: cv.y + (ty - cv.y) * BLEND,
        z: cv.z + (tz - cv.z) * BLEND,
      }, true);
    }

    // orientation is taken straight from the owner — they are the authority on
    // which way their own car is pointing
    this.body.setRotation({ x: s.qx, y: s.qy, z: s.qz, w: s.qw }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);

    this.flags = s.f;
    this.boosting = !!(s.f & FLAG.BOOST);
    const wasAlive = this.alive;
    this.alive = !(s.f & FLAG.DEAD);
    if (wasAlive && !this.alive) this.damage.scorch();
    if (!wasAlive && this.alive) this.damage.reset();

    if (s.h < this.health) {
      // crude but effective: dent them roughly where they are being shoved
      _v.set(-s.vx, -s.vy, -s.vz);
      if (_v.lengthSq() > 1) {
        _v.normalize();
        _q.set(s.qx, s.qy, s.qz, s.qw).invert();
        _v.applyQuaternion(_q);
        this.damage.apply(clamp((this.health - s.h) / 40, 0, 1), _v);
      }
    }
    this.health = s.h;

    const speed = Math.hypot(s.vx, s.vy, s.vz);
    this.wheelSpin -= (speed / this.type.phys.wheelRadius) * dt;
  }

  /** Syncs the visual to the physics body. */
  render(camera) {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.visual.group.position.set(t.x, t.y, t.z);
    this.visual.group.quaternion.set(r.x, r.y, r.z, r.w);

    for (let i = 0; i < 4; i++) {
      this.visual.wheels[i].rotation.x = this.wheelSpin;
    }
    this.damage.flush();

    this.nameTag.position.set(t.x, t.y + 2.4, t.z);
    if (camera) this.nameTag.quaternion.copy(camera.quaternion);
    const d = camera ? camera.position.distanceTo(this.nameTag.position) : 0;
    this.nameTag.visible = d > 8 && d < 130;
    const s = Math.max(1, d / 26);
    this.nameTag.scale.set(s, s, s);
  }

  dispose() {
    this.scene.remove(this.visual.group);
    this.scene.remove(this.nameTag);
    this.nameTag.material.map?.dispose();
    this.nameTag.material.dispose();
    this.visual.dispose();
    this.world.removeRigidBody(this.body);
  }
}

/** Canvas-textured billboard — no font files, no loading. */
function makeNameTag(name, colorHex) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 256, 64);
  ctx.font = 'bold 34px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 7;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(name, 128, 34);
  ctx.fillStyle = '#' + colorHex.toString(16).padStart(6, '0');
  ctx.fillText(name, 128, 34);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(4.2, 1.05, 1);
  sprite.renderOrder = 10;
  return sprite;
}
