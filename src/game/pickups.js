/**
 * Pickup pads. Collection is a plain distance test against the local car —
 * cheaper and more predictable than physics sensors, and each client only ever
 * decides for itself, so there is nothing to disagree about.
 */
import * as THREE from 'three';

export const PICKUP_KINDS = {
  repair: { color: 0x46e08a, label: 'REPAIR', cooldown: 14 },
  boost: { color: 0x22e0ff, label: 'BOOST', cooldown: 8 },
  overdrive: { color: 0xff3fae, label: 'OVERDRIVE', cooldown: 26 },
};

const RADIUS = 3.2;

export class Pickups {
  constructor(scene, pads) {
    this.scene = scene;
    this.items = [];
    this.onCollect = null;

    const ringGeo = new THREE.TorusGeometry(1.5, 0.16, 8, 24);
    const coreGeo = new THREE.OctahedronGeometry(0.7, 0);
    this.geos = [ringGeo, coreGeo];

    for (const pad of pads) {
      const kind = PICKUP_KINDS[pad.type] || PICKUP_KINDS.boost;
      const mat = new THREE.MeshStandardMaterial({
        color: kind.color, emissive: kind.color, emissiveIntensity: 1.5,
        roughness: 0.35, metalness: 0.2, transparent: true, opacity: 0.95,
      });
      const group = new THREE.Group();
      const ring = new THREE.Mesh(ringGeo, mat);
      ring.rotation.x = Math.PI / 2;
      const core = new THREE.Mesh(coreGeo, mat);
      core.position.y = 0.1;
      group.add(ring, core);
      group.position.set(pad.pos[0], pad.pos[1] + 1.3, pad.pos[2]);
      scene.add(group);

      this.items.push({
        group, mat, type: pad.type, kind,
        pos: new THREE.Vector3(pad.pos[0], pad.pos[1] + 1.3, pad.pos[2]),
        cooldown: 0, ready: true,
      });
    }
  }

  reset() {
    for (const it of this.items) { it.cooldown = 0; it.ready = true; it.group.visible = true; }
  }

  update(dt, car, time) {
    const p = car ? car.position : null;
    for (const it of this.items) {
      if (!it.ready) {
        it.cooldown -= dt;
        if (it.cooldown <= 0) { it.ready = true; it.group.visible = true; }
        continue;
      }

      it.group.rotation.y += dt * 1.6;
      it.group.children[1].rotation.x += dt * 2.2;
      it.group.position.y = it.pos.y + Math.sin(time * 2 + it.pos.x) * 0.22;
      it.mat.emissiveIntensity = 1.2 + Math.sin(time * 4 + it.pos.z) * 0.35;

      if (!p || !car.alive) continue;
      const dx = p.x - it.pos.x, dy = p.y - it.pos.y, dz = p.z - it.pos.z;
      if (dx * dx + dy * dy + dz * dz < RADIUS * RADIUS) {
        it.ready = false;
        it.cooldown = it.kind.cooldown;
        it.group.visible = false;
        if (this.onCollect) this.onCollect(it.type, it.pos);
      }
    }
  }

  dispose() {
    for (const it of this.items) {
      this.scene.remove(it.group);
      it.mat.dispose();
    }
    for (const g of this.geos) g.dispose();
  }
}
