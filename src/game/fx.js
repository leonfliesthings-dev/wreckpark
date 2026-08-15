/**
 * Particles, debris and explosions. Everything is pooled — no allocation in
 * the frame loop, no garbage-collector hitches mid-derby.
 */
import * as THREE from 'three';
import { RAPIER, GROUPS } from './physics.js';
import { rand, randInt } from '../core/util.js';

const VERT = `
  attribute float psize;
  attribute float palpha;
  attribute vec3 pcolor;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vAlpha = palpha;
    vColor = pcolor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = psize * 300.0 / max(0.001, -mv.z);
    gl_Position = projectionMatrix * mv;
  }`;

const FRAG = `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = dot(d, d);
    if (r > 0.25) discard;
    float soft = smoothstep(0.25, 0.0, r);
    gl_FragColor = vec4(vColor, vAlpha * soft);
  }`;

class ParticlePool {
  constructor(scene, capacity, additive) {
    this.capacity = capacity;
    this.next = 0;

    this.px = new Float32Array(capacity * 3);
    this.vx = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.size0 = new Float32Array(capacity);
    this.size1 = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.grav = new Float32Array(capacity);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.px, 3));
    geo.setAttribute('pcolor', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
    geo.setAttribute('psize', new THREE.BufferAttribute(new Float32Array(capacity), 1));
    geo.setAttribute('palpha', new THREE.BufferAttribute(new Float32Array(capacity), 1));
    geo.setDrawRange(0, capacity);
    // particles move constantly; a fixed generous sphere beats reuploading one
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 400);

    this.geo = geo;
    this.colAttr = geo.attributes.pcolor;
    this.sizeAttr = geo.attributes.psize;
    this.alphaAttr = geo.attributes.palpha;

    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);

    // park every particle far away and fully dead
    this.alphaAttr.array.fill(0);
  }

  spawn(x, y, z, vx, vy, vz, opts) {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    const i3 = i * 3;
    this.px[i3] = x; this.px[i3 + 1] = y; this.px[i3 + 2] = z;
    this.vx[i3] = vx; this.vx[i3 + 1] = vy; this.vx[i3 + 2] = vz;
    this.life[i] = opts.life;
    this.maxLife[i] = opts.life;
    this.size0[i] = opts.size0;
    this.size1[i] = opts.size1 ?? opts.size0;
    this.drag[i] = opts.drag ?? 1.5;
    this.grav[i] = opts.grav ?? 0;
    const c = opts.color;
    this.colAttr.array[i3] = c.r;
    this.colAttr.array[i3 + 1] = c.g;
    this.colAttr.array[i3 + 2] = c.b;
  }

  update(dt) {
    const { px, vx, life, maxLife, size0, size1, drag, grav } = this;
    const sizeA = this.sizeAttr.array;
    const alphaA = this.alphaAttr.array;
    for (let i = 0; i < this.capacity; i++) {
      if (life[i] <= 0) { if (alphaA[i] !== 0) alphaA[i] = 0; continue; }
      life[i] -= dt;
      const i3 = i * 3;
      if (life[i] <= 0) { alphaA[i] = 0; continue; }
      const d = Math.exp(-drag[i] * dt);
      vx[i3] *= d; vx[i3 + 1] *= d; vx[i3 + 2] *= d;
      vx[i3 + 1] += grav[i] * dt;
      px[i3] += vx[i3] * dt;
      px[i3 + 1] += vx[i3 + 1] * dt;
      px[i3 + 2] += vx[i3 + 2] * dt;
      const t = 1 - life[i] / maxLife[i];
      sizeA[i] = size0[i] + (size1[i] - size0[i]) * t;
      alphaA[i] = (1 - t) * (1 - t);
    }
    this.geo.attributes.position.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
  }

  dispose() {
    this.points.parent?.remove(this.points);
    this.geo.dispose();
    this.points.material.dispose();
  }
}

// ─────────────────────────────────────────────────────────────

const _c = new THREE.Color();
const SPARK = new THREE.Color(0xffb84d);
const SMOKE = new THREE.Color(0x2c3038);
const DUST = new THREE.Color(0x9a9182);
const FIRE = new THREE.Color(0xff7a1f);

export class FX {
  constructor(scene, world, quality = 'high') {
    this.scene = scene;
    this.world = world;
    const scale = quality === 'low' ? 0.4 : 1;
    this.add = new ParticlePool(scene, Math.floor(1400 * scale), true);
    this.norm = new ParticlePool(scene, Math.floor(900 * scale), false);

    // ── debris pool ──
    this.debris = [];
    this.debrisNext = 0;
    const DEBRIS_N = quality === 'low' ? 16 : 34;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0x4a4f57, roughness: 0.8, metalness: 0.5 });
    this.debrisGeo = geo;
    this.debrisMat = mat;
    for (let i = 0; i < DEBRIS_N; i++) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.visible = false;
      scene.add(mesh);
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(0, -500, 0)
          .setLinearDamping(0.2).setAngularDamping(0.3)
      );
      const col = world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.16, 0.16, 0.16).setMass(4)
          .setFriction(0.6).setRestitution(0.35)
          .setCollisionGroups(GROUPS.debris),
        body
      );
      this.debris.push({ mesh, body, col, life: 0 });
    }

    // ── explosion flash light ──
    this.flash = new THREE.PointLight(0xffa23a, 0, 60, 2);
    scene.add(this.flash);
    this.flashLife = 0;
  }

  // ── emitters ──────────────────────────────────────────────

  sparks(p, n, strength = 1, color = SPARK) {
    for (let i = 0; i < n; i++) {
      const s = 4 + rand(10) * strength;
      this.add.spawn(
        p.x, p.y, p.z,
        rand(-s, s), rand(-s * 0.4, s), rand(-s, s),
        { life: rand(0.22, 0.6), size0: rand(0.05, 0.13), size1: 0.01, color, drag: 2.2, grav: -14 }
      );
    }
  }

  smoke(p, n, spread = 1.4, color = SMOKE) {
    for (let i = 0; i < n; i++) {
      this.norm.spawn(
        p.x + rand(-0.3, 0.3), p.y + rand(-0.2, 0.2), p.z + rand(-0.3, 0.3),
        rand(-spread, spread), rand(0.4, 2.0), rand(-spread, spread),
        { life: rand(0.7, 1.6), size0: rand(0.3, 0.55), size1: rand(1.2, 2.2), color, drag: 1.1, grav: 1.2 }
      );
    }
  }

  dust(p, n) {
    for (let i = 0; i < n; i++) {
      this.norm.spawn(
        p.x + rand(-0.5, 0.5), p.y + 0.1, p.z + rand(-0.5, 0.5),
        rand(-2.4, 2.4), rand(0.3, 1.6), rand(-2.4, 2.4),
        { life: rand(0.4, 0.9), size0: 0.25, size1: 1.1, color: DUST, drag: 2.0, grav: 0.4 }
      );
    }
  }

  /** Boost plume out of the back of a car. */
  boost(p, dir, colorHex) {
    _c.set(colorHex);
    for (let i = 0; i < 3; i++) {
      const s = 6 + rand(6);
      this.add.spawn(
        p.x + rand(-0.14, 0.14), p.y + rand(-0.1, 0.1), p.z + rand(-0.14, 0.14),
        dir.x * s + rand(-1.4, 1.4), dir.y * s + rand(-1.0, 1.4), dir.z * s + rand(-1.4, 1.4),
        { life: rand(0.14, 0.34), size0: rand(0.16, 0.3), size1: 0.02, color: _c, drag: 3.4, grav: 2.0 }
      );
    }
  }

  /** Tyre smoke while drifting. */
  skid(p) {
    this.norm.spawn(
      p.x + rand(-0.15, 0.15), p.y + 0.06, p.z + rand(-0.15, 0.15),
      rand(-0.9, 0.9), rand(0.5, 1.5), rand(-0.9, 0.9),
      { life: rand(0.5, 1.1), size0: 0.2, size1: 0.9, color: SMOKE, drag: 1.6, grav: 0.7 }
    );
  }

  impact(p, magnitude) {
    this.sparks(p, Math.floor(6 + magnitude * 22), magnitude);
    if (magnitude > 0.35) this.smoke(p, Math.floor(magnitude * 6), 1.8);
  }

  explosion(p) {
    this.sparks(p, 90, 2.2, FIRE);
    this.sparks(p, 40, 1.4, SPARK);
    this.smoke(p, 34, 3.4);
    for (let i = 0; i < 26; i++) {
      const s = rand(3, 16);
      this.add.spawn(
        p.x, p.y, p.z,
        rand(-s, s), rand(1, s), rand(-s, s),
        { life: rand(0.4, 1.0), size0: rand(0.3, 0.7), size1: 0.02, color: FIRE, drag: 1.6, grav: -6 }
      );
    }
    this.flash.position.set(p.x, p.y + 1, p.z);
    this.flash.intensity = 900;
    this.flashLife = 0.32;
    this.throwDebris(p, randInt(7, 11), 13);
  }

  throwDebris(p, n, force) {
    for (let i = 0; i < n; i++) {
      const d = this.debris[this.debrisNext];
      this.debrisNext = (this.debrisNext + 1) % this.debris.length;
      const s = rand(0.16, 0.42);
      d.mesh.scale.set(s * rand(0.6, 1.6), s * rand(0.6, 1.4), s * rand(0.6, 1.6));
      d.mesh.visible = true;
      d.life = rand(5, 9);
      d.body.setTranslation({ x: p.x + rand(-0.4, 0.4), y: p.y + rand(0, 0.7), z: p.z + rand(-0.4, 0.4) }, true);
      d.body.setLinvel({ x: rand(-force, force), y: rand(force * 0.3, force), z: rand(-force, force) }, true);
      d.body.setAngvel({ x: rand(-12, 12), y: rand(-12, 12), z: rand(-12, 12) }, true);
    }
  }

  // ── per-frame ─────────────────────────────────────────────
  update(dt) {
    this.add.update(dt);
    this.norm.update(dt);

    if (this.flashLife > 0) {
      this.flashLife -= dt;
      this.flash.intensity = Math.max(0, this.flash.intensity * Math.exp(-9 * dt));
      if (this.flashLife <= 0) this.flash.intensity = 0;
    }

    for (const d of this.debris) {
      if (d.life <= 0) continue;
      d.life -= dt;
      const t = d.body.translation();
      const r = d.body.rotation();
      d.mesh.position.set(t.x, t.y, t.z);
      d.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      if (d.life <= 0 || t.y < -40) {
        d.mesh.visible = false;
        d.life = 0;
        d.body.setTranslation({ x: 0, y: -500, z: 0 }, true);
        d.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      }
    }
  }

  clearDebris() {
    for (const d of this.debris) {
      d.mesh.visible = false;
      d.life = 0;
      d.body.setTranslation({ x: 0, y: -500, z: 0 }, true);
      d.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  dispose() {
    this.add.dispose();
    this.norm.dispose();
    for (const d of this.debris) this.scene.remove(d.mesh);
    this.debrisGeo.dispose();
    this.debrisMat.dispose();
    this.scene.remove(this.flash);
  }
}
