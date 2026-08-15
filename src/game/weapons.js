/**
 * Weapons: one offensive and one defensive system per car.
 *
 * Authority follows the same rule as ramming — the shooter broadcasts that it
 * fired, every client simulates the projectile locally, and each client decides
 * only whether IT got hit and reports its own damage. Nobody ever asserts
 * damage onto somebody else's car, so there is nothing to disagree about.
 */
import * as THREE from 'three';
import { RAPIER, GROUPS, G, groups } from './physics.js';
import { rand, clamp } from '../core/util.js';

// ── offensive ──────────────────────────────────────────────────
export const WEAPONS = {
  gatling: {
    name: 'GATLING', kind: 'rapid', icon: '///',
    damage: 5, rof: 14, range: 95, spread: 0.035,
    ammo: 260, reload: 6, tracer: 0xffd23f,
    blurb: 'Hoses rounds downrange. Chews armour up close.',
  },
  rockets: {
    name: 'ROCKETS', kind: 'projectile', icon: '>>>',
    damage: 30, splash: 6.5, speed: 78, gravity: 0.15,
    ammo: 10, cooldown: 0.9, reload: 9, tracer: 0xff6a1f,
    blurb: 'Flat and fast. Point it at someone and let go.',
  },
  mortar: {
    name: 'MORTAR', kind: 'lobbed', icon: '^^^',
    damage: 44, splash: 12, speed: 46, gravity: 1.0, arc: 0.62,
    ammo: 7, cooldown: 1.7, reload: 11, tracer: 0x9bff2e,
    blurb: 'Lobs a shell over cover. Enormous bang, slow to land.',
  },
  laser: {
    name: 'LASER', kind: 'beam', icon: '===',
    damage: 30, range: 130, ammo: 100, drain: 42, reload: 7, tracer: 0x22e0ff,
    blurb: 'Instant beam. Burns while you hold it, drains fast.',
  },
};

// ── defensive ──────────────────────────────────────────────────
export const COUNTERS = {
  oil: {
    name: 'OIL SLICK', kind: 'patch', icon: 'OIL',
    radius: 5.0, life: 20, charges: 4, reload: 10, color: 0x14161d,
    blurb: 'Leaves a slick. Anyone who drives through loses all grip.',
  },
  caltrops: {
    name: 'CALTROPS', kind: 'scatter', icon: 'x x', count: 10,
    radius: 1.3, life: 24, damage: 14, charges: 4, reload: 10, color: 0xb9c2cf,
    blurb: 'Scatters spikes behind you. Shreds anything that follows.',
  },
  mace: {
    name: 'WRECKING BALL', kind: 'flail', icon: 'O--',
    life: 12, charges: 3, reload: 13, damage: 40, color: 0x6f7a86,
    blurb: 'Drops a chained ball. Swing it into people.',
  },
  deflector: {
    name: 'DEFLECTOR', kind: 'shield', icon: '( )',
    life: 6, charges: 3, reload: 12, color: 0x22e0ff,
    blurb: 'Refracting field. Bounces damage off for a few seconds.',
  },
};

/** Which car carries what. */
export const LOADOUTS = {
  ripsaw: { weapon: 'rockets', counter: 'oil' },
  hornet: { weapon: 'gatling', counter: 'caltrops' },
  mauler: { weapon: 'mortar', counter: 'mace' },
  volt: { weapon: 'laser', counter: 'deflector' },
};

export function loadoutFor(carId) {
  return LOADOUTS[carId] || LOADOUTS.ripsaw;
}

// ───────────────────────────────────────────────────────────────
const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();

/**
 * Owns every live projectile, hazard and beam in the world, for every player.
 */
export class WeaponSystem {
  /**
   * @param {object} o
   *   scene, world, fx
   *   onSelfHit(damage, sourceId, localDir)  we were hit by something
   */
  constructor({ scene, world, fx, onSelfHit }) {
    this.scene = scene;
    this.world = world;
    this.fx = fx;
    this.onSelfHit = onSelfHit;

    this.projectiles = [];
    this.hazards = [];
    this.beams = [];
    this.flails = new Map();     // ownerId -> flail
    this.shields = new Map();    // ownerId -> { until }

    this.rayFilter = groups(G.CAR, G.WORLD | G.PROP);

    // shared geometry so spawning costs nothing
    this.geo = {
      rocket: new THREE.CapsuleGeometry(0.16, 0.5, 4, 8),
      shell: new THREE.SphereGeometry(0.3, 10, 8),
      slick: new THREE.CircleGeometry(1, 24),
      caltrop: new THREE.TetrahedronGeometry(0.28),
      ball: new THREE.SphereGeometry(0.65, 14, 12),
      link: new THREE.BoxGeometry(0.14, 0.14, 0.42),
      beam: new THREE.CylinderGeometry(0.09, 0.09, 1, 6, 1, true),
    };
  }

  // ── firing ───────────────────────────────────────────────────
  /**
   * Spawns whatever `weaponId` produces. Called both for the local player and
   * for a network `fire` event from someone else.
   */
  fire(weaponId, ownerId, origin, dir, isLocal) {
    const w = WEAPONS[weaponId];
    if (!w) return;

    switch (w.kind) {
      case 'rapid':
        this._tracer(origin, dir, w, w.range);
        this.fx.sparks(origin, 3, 0.4, new THREE.Color(w.tracer));
        if (!isLocal) return;                  // hit resolution is per-victim
        break;
      case 'beam':
        this._beam(origin, dir, w);
        break;
      case 'projectile':
      case 'lobbed':
        this._spawnProjectile(weaponId, w, ownerId, origin, dir);
        break;
    }
  }

  _spawnProjectile(weaponId, w, ownerId, origin, dir) {
    const mesh = new THREE.Mesh(
      w.kind === 'lobbed' ? this.geo.shell : this.geo.rocket,
      new THREE.MeshStandardMaterial({
        color: w.tracer, emissive: w.tracer, emissiveIntensity: 1.6, roughness: 0.4,
      })
    );
    mesh.castShadow = true;
    this.scene.add(mesh);

    const vel = _dir.copy(dir).normalize().multiplyScalar(w.speed).clone();
    if (w.kind === 'lobbed') vel.y += w.speed * w.arc;

    this.projectiles.push({
      weaponId, w, ownerId, mesh,
      pos: origin.clone(),
      vel,
      life: 6,
      prev: origin.clone(),
    });
  }

  _tracer(origin, dir, w, len) {
    const end = _v.copy(dir).normalize().multiplyScalar(len).add(origin);
    const geo = new THREE.BufferGeometry().setFromPoints([origin.clone(), end.clone()]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: w.tracer, transparent: true, opacity: 0.85,
    }));
    this.scene.add(line);
    this.beams.push({ obj: line, life: 0.06, fade: true });
  }

  _beam(origin, dir, w) {
    const end = _v.copy(dir).normalize().multiplyScalar(w.range).add(origin);
    const geo = new THREE.BufferGeometry().setFromPoints([origin.clone(), end.clone()]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: w.tracer, transparent: true, opacity: 0.95,
    }));
    this.scene.add(line);
    this.beams.push({ obj: line, life: 0.1, fade: true });
    this.fx.sparks(end, 4, 0.5, new THREE.Color(w.tracer));
  }

  // ── hazards ──────────────────────────────────────────────────
  deploy(counterId, ownerId, pos, dirBack, isLocal, chassisBody) {
    const c = COUNTERS[counterId];
    if (!c) return;

    if (c.kind === 'patch') {
      const mesh = new THREE.Mesh(this.geo.slick, new THREE.MeshStandardMaterial({
        color: c.color, roughness: 0.15, metalness: 0.6,
        transparent: true, opacity: 0.85, depthWrite: false,
      }));
      mesh.rotation.x = -Math.PI / 2;
      mesh.scale.setScalar(c.radius);
      mesh.position.set(pos.x, pos.y + 0.06, pos.z);
      this.scene.add(mesh);
      this.hazards.push({ kind: 'oil', c, ownerId, mesh, pos: mesh.position.clone(), r: c.radius, life: c.life });

    } else if (c.kind === 'scatter') {
      for (let i = 0; i < c.count; i++) {
        const mesh = new THREE.Mesh(this.geo.caltrop, new THREE.MeshStandardMaterial({
          color: c.color, roughness: 0.4, metalness: 0.8,
        }));
        const p = new THREE.Vector3(
          pos.x + rand(-3, 3), pos.y + 0.2, pos.z + rand(-3, 3)
        );
        mesh.position.copy(p);
        mesh.rotation.set(rand(0, 6), rand(0, 6), rand(0, 6));
        mesh.castShadow = true;
        this.scene.add(mesh);
        this.hazards.push({ kind: 'caltrop', c, ownerId, mesh, pos: p, r: c.radius, life: c.life });
      }

    } else if (c.kind === 'flail') {
      this._spawnFlail(c, ownerId, pos, chassisBody);

    } else if (c.kind === 'shield') {
      this.shields.set(ownerId, { until: performance.now() / 1000 + c.life });
    }
  }

  _spawnFlail(c, ownerId, pos, chassisBody) {
    this.removeFlail(ownerId);
    const mat = new THREE.MeshStandardMaterial({ color: c.color, roughness: 0.45, metalness: 0.9 });
    const ball = new THREE.Mesh(this.geo.ball, mat);
    ball.castShadow = true;
    this.scene.add(ball);

    const links = [];
    for (let i = 0; i < 6; i++) {
      const l = new THREE.Mesh(this.geo.link, mat);
      this.scene.add(l);
      links.push(l);
    }

    // A real jointed chain is fiddly and unstable at speed. A single heavy ball
    // held at a max distance behaves the same and never explodes.
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(pos.x, pos.y + 0.5, pos.z)
        .setLinearDamping(0.35).setAngularDamping(0.6).setCcdEnabled(true)
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.ball(0.65).setMass(240).setFriction(0.5).setRestitution(0.4)
        .setCollisionGroups(GROUPS.prop),
      body
    );

    this.flails.set(ownerId, {
      c, ownerId, ball, links, body, chassisBody,
      life: c.life, length: 5.0,
    });
  }

  removeFlail(ownerId) {
    const f = this.flails.get(ownerId);
    if (!f) return;
    this.scene.remove(f.ball);
    for (const l of f.links) this.scene.remove(l);
    this.world.removeRigidBody(f.body);
    this.flails.delete(ownerId);
  }

  hasShield(ownerId) {
    const s = this.shields.get(ownerId);
    return !!s && s.until > performance.now() / 1000;
  }

  // ── per-frame ────────────────────────────────────────────────
  /**
   * @param {Array} combatants  everything simulated on THIS machine that can be
   *   hit — the local player and any bots. Each needs { id, position, alive,
   *   takeHit(amount, sourceId, worldDirToward) }. Remote players are not in
   *   here: their own client decides whether they were hit.
   */
  update(dt, combatants) {
    const list = combatants || [];
    const now = performance.now() / 1000;

    // ---- projectiles ----
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.prev.copy(p.pos);
      p.vel.y -= 18 * p.w.gravity * dt;
      p.pos.addScaledVector(p.vel, dt);
      p.life -= dt;

      p.mesh.position.copy(p.pos);
      p.mesh.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0), _dir.copy(p.vel).normalize()
      );

      let hit = false;

      // did it reach any of the cars we simulate?
      let direct = null;
      for (const cb of list) {
        if (!cb.alive || p.ownerId === cb.id) continue;
        const d = p.pos.distanceTo(_v.set(cb.position.x, cb.position.y, cb.position.z));
        if (d < 2.4) { direct = cb; break; }
      }
      if (direct) { hit = true; this._explode(p, direct, list); }
      // did it reach the world?
      if (!hit) {
        const seg = _dir.copy(p.pos).sub(p.prev);
        const dist = seg.length();
        if (dist > 1e-4) {
          const ray = new RAPIER.Ray(
            { x: p.prev.x, y: p.prev.y, z: p.prev.z },
            { x: seg.x / dist, y: seg.y / dist, z: seg.z / dist }
          );
          const h = this.world.castRay(ray, dist, true,
            RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, this.rayFilter);
          if (h) { hit = true; this._explode(p, null, list); }
        }
      }

      if (hit || p.life <= 0) {
        if (!hit) this._explode(p, null, list);
        this.scene.remove(p.mesh);
        p.mesh.material.dispose();
        this.projectiles.splice(i, 1);
      }
    }

    // ---- hazards ----
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      const h = this.hazards[i];
      h.life -= dt;
      if (h.life < 2) h.mesh.visible = Math.floor(h.life * 6) % 2 === 0;   // blink out
      if (h.life <= 0) {
        this.scene.remove(h.mesh);
        this.hazards.splice(i, 1);
      }
    }

    // ---- flails ----
    for (const [ownerId, f] of this.flails) {
      f.life -= dt;
      if (f.life <= 0 || !f.chassisBody) { this.removeFlail(ownerId); continue; }

      const anchor = f.chassisBody.translation();
      const bp = f.body.translation();
      _v.set(bp.x - anchor.x, bp.y - anchor.y, bp.z - anchor.z);
      const d = _v.length();
      if (d > f.length) {
        // haul it back in to the chain's length
        _v.multiplyScalar(1 / d);
        const target = {
          x: anchor.x + _v.x * f.length,
          y: anchor.y + _v.y * f.length,
          z: anchor.z + _v.z * f.length,
        };
        const bv = f.body.linvel();
        const pull = (d - f.length) / Math.max(dt, 1e-3);
        f.body.setLinvel({
          x: bv.x + (target.x - bp.x) * 8 - _v.x * pull * 0.25,
          y: bv.y + (target.y - bp.y) * 8 - _v.y * pull * 0.25,
          z: bv.z + (target.z - bp.z) * 8 - _v.z * pull * 0.25,
        }, true);
      }

      f.ball.position.set(bp.x, bp.y, bp.z);
      for (let i = 0; i < f.links.length; i++) {
        const t = (i + 1) / (f.links.length + 1);
        f.links[i].position.set(
          anchor.x + (bp.x - anchor.x) * t,
          anchor.y + (bp.y - anchor.y) * t,
          anchor.z + (bp.z - anchor.z) * t
        );
        f.links[i].lookAt(bp.x, bp.y, bp.z);
      }

      // it only hurts other people
      if (f._justHit > 0) f._justHit -= dt;
      for (const cb of list) {
        if (!cb.alive || ownerId === cb.id) continue;
        const dm = _v.set(bp.x - cb.position.x, bp.y - cb.position.y, bp.z - cb.position.z).length();
        if (dm < 2.2 && f._justHit <= 0) {
          f._justHit = 0.8;
          const bv = f.body.linvel();
          const speed = Math.hypot(bv.x, bv.y, bv.z);
          if (speed > 6) {
            this._hurt(cb, f.c.damage * clamp(speed / 20, 0.4, 1.4), ownerId,
              _v.normalize().negate());
          }
        }
      }
    }

    // ---- shields ----
    for (const [id, s] of this.shields) if (s.until < now) this.shields.delete(id);

    // ---- beams / tracers ----
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i];
      b.life -= dt;
      if (b.fade) b.obj.material.opacity = Math.max(0, b.life * 10);
      if (b.life <= 0) {
        this.scene.remove(b.obj);
        b.obj.geometry.dispose();
        b.obj.material.dispose();
        this.beams.splice(i, 1);
      }
    }
  }

  /**
   * Who is standing in something nasty. Returns the set of combatant ids that
   * are currently on oil.
   */
  checkHazards(combatants) {
    const slipping = new Set();
    const list = combatants || [];
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      const h = this.hazards[i];
      let consumed = false;
      for (const cb of list) {
        if (!cb.alive || h.ownerId === cb.id) continue;   // your own mess does not bite
        const dx = cb.position.x - h.pos.x;
        const dz = cb.position.z - h.pos.z;
        const dy = Math.abs(cb.position.y - h.pos.y);
        if (dy > 3 || dx * dx + dz * dz > h.r * h.r) continue;

        if (h.kind === 'oil') {
          slipping.add(cb.id);
        } else if (h.kind === 'caltrop') {
          this._hurt(cb, h.c.damage, h.ownerId, _v.set(0, -1, 0));
          consumed = true;
          break;
        }
      }
      if (consumed) {
        this.scene.remove(h.mesh);
        this.hazards.splice(i, 1);
      }
    }
    return slipping;
  }

  _explode(p, directHit, list) {
    this.fx.impact(p.pos, 0.7);
    this.fx.sparks(p.pos, 22, 1.2, new THREE.Color(p.w.tracer));
    this.fx.smoke(p.pos, 6, 2);

    if (!p.w.splash) return;
    for (const cb of list) {
      if (!cb.alive || p.ownerId === cb.id) continue;
      const d = p.pos.distanceTo(_v.set(cb.position.x, cb.position.y, cb.position.z));
      if (d >= p.w.splash) continue;
      const falloff = cb === directHit ? 1 : 1 - d / p.w.splash;
      _dir.set(cb.position.x - p.pos.x, cb.position.y - p.pos.y, cb.position.z - p.pos.z)
        .normalize().negate();
      this._hurt(cb, p.w.damage * falloff, p.ownerId, _dir);
    }
  }

  _hurt(cb, amount, sourceId, worldDirToward) {
    if (this.hasShield(cb.id)) {
      this.fx.sparks(_v.set(cb.position.x, cb.position.y + 0.6, cb.position.z), 14, 0.8,
        new THREE.Color(COUNTERS.deflector.color));
      return;
    }
    cb.takeHit(amount, sourceId, worldDirToward);
  }

  clear() {
    for (const p of this.projectiles) { this.scene.remove(p.mesh); p.mesh.material.dispose(); }
    for (const h of this.hazards) this.scene.remove(h.mesh);
    for (const b of this.beams) { this.scene.remove(b.obj); b.obj.geometry.dispose(); b.obj.material.dispose(); }
    for (const id of [...this.flails.keys()]) this.removeFlail(id);
    this.projectiles.length = 0;
    this.hazards.length = 0;
    this.beams.length = 0;
    this.shields.clear();
  }

  dispose() {
    this.clear();
    for (const g of Object.values(this.geo)) g.dispose();
  }
}

/**
 * Ammo, cooldowns and reloads for one car. Kept separate from the world so the
 * HUD can read it without touching the simulation.
 */
export class Armoury {
  constructor(carId) {
    this.set(carId);
  }

  set(carId) {
    const l = loadoutFor(carId);
    this.weaponId = l.weapon;
    this.counterId = l.counter;
    this.w = WEAPONS[this.weaponId];
    this.c = COUNTERS[this.counterId];
    this.reset();
  }

  reset() {
    this.ammo = this.w.ammo;
    this.charges = this.c.charges;
    this.cool = 0;
    this.reloadT = 0;
    this.chargeT = 0;
  }

  update(dt) {
    this.cool = Math.max(0, this.cool - dt);
    if (this.ammo <= 0) {
      this.reloadT += dt;
      if (this.reloadT >= this.w.reload) { this.ammo = this.w.ammo; this.reloadT = 0; }
    }
    if (this.charges < this.c.charges) {
      this.chargeT += dt;
      if (this.chargeT >= this.c.reload) { this.charges++; this.chargeT = 0; }
    }
  }

  canFire() {
    return this.ammo > 0 && this.cool <= 0;
  }

  spendShot() {
    const w = this.w;
    this.ammo--;
    this.cool = w.kind === 'rapid' ? 1 / w.rof : (w.cooldown ?? 0.12);
    return true;
  }

  canDeploy() { return this.charges > 0; }

  spendCharge() {
    this.charges--;
    this.chargeT = 0;
  }

  get ammoFrac() { return this.ammo / this.w.ammo; }
  get reloading() { return this.ammo <= 0; }
  get reloadFrac() { return this.reloading ? this.reloadT / this.w.reload : 1; }
}
