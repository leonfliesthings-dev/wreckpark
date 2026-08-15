/**
 * Body damage. Impacts physically push the shell's vertices in, so a car that
 * has been shunted round a derby for two minutes genuinely looks like it.
 *
 * Operates on the merged, welded shell from carBuilder, so dents stay
 * continuous across what used to be separate panels.
 */
import * as THREE from 'three';

const _hit = new THREE.Vector3();
const _v = new THREE.Vector3();
const _d = new THREE.Vector3();

export class DamageModel {
  /**
   * @param {THREE.Mesh} shellMesh  welded shell with position + color attributes
   * @param {object} bodyDef        carType.body (half-extents)
   */
  constructor(shellMesh, bodyDef) {
    this.mesh = shellMesh;
    this.bd = bodyDef;

    const pos = shellMesh.geometry.attributes.position;
    this.pos = pos;
    this.col = shellMesh.geometry.attributes.color;
    this.original = new Float32Array(pos.array);          // pristine shape
    this.originalCol = new Float32Array(this.col.array);
    this.count = pos.count;

    // how far each vertex has been pushed in, so we can cap total mangling
    this.dentDepth = new Float32Array(this.count);
    this.totalDamage = 0;
    this.dirty = false;
  }

  /**
   * Crumples the body.
   * @param {number} magnitude 0..1
   * @param {THREE.Vector3} localDir unit vector from the car's centre toward
   *                                 whatever hit it, in body-local space
   */
  apply(magnitude, localDir) {
    if (magnitude <= 0.02) return;
    const bd = this.bd;

    // Where on the body shell that direction lands: intersect the ray with the
    // body's bounding box rather than just scaling, so hits on the long nose
    // land on the nose and not somewhere inside the cabin.
    _d.copy(localDir).normalize();
    const tx = Math.abs(_d.x) > 1e-4 ? bd.w / Math.abs(_d.x) : Infinity;
    const ty = Math.abs(_d.y) > 1e-4 ? (bd.h * 1.6) / Math.abs(_d.y) : Infinity;
    const tz = Math.abs(_d.z) > 1e-4 ? bd.l / Math.abs(_d.z) : Infinity;
    _hit.copy(_d).multiplyScalar(Math.min(tx, ty, tz));

    const radius = 0.66 + magnitude * 1.05;
    const depth = magnitude * 0.95;
    const maxDent = Math.min(bd.w, bd.l) * 1.75;
    const r2 = radius * radius;

    const arr = this.pos.array;
    const col = this.col.array;

    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;
      const dx = arr[i3] - _hit.x;
      const dy = arr[i3 + 1] - _hit.y;
      const dz = arr[i3 + 2] - _hit.z;
      const dist2 = dx * dx + dy * dy + dz * dz;
      if (dist2 > r2) continue;

      const fall = 1 - Math.sqrt(dist2) / radius;
      const f = fall * fall;
      let push = depth * f;

      // stop the panel folding through itself
      const already = this.dentDepth[i];
      if (already + push > maxDent) push = Math.max(0, maxDent - already);
      if (push <= 0) continue;
      this.dentDepth[i] = already + push;

      // push inward, plus a little crease so dents are not perfect spheres
      const jitter = 1 + Math.sin(arr[i3] * 21.7 + arr[i3 + 2] * 17.3) * 0.45;
      arr[i3] -= _d.x * push * jitter;
      arr[i3 + 1] -= _d.y * push * jitter;
      arr[i3 + 2] -= _d.z * push * jitter;

      // scuff the paint
      const scuff = 1 - f * magnitude * 0.72;
      col[i3] *= scuff;
      col[i3 + 1] *= scuff;
      col[i3 + 2] *= scuff;
    }

    this.totalDamage += magnitude;
    this.dirty = true;
  }

  /**
   * Partially beats the panels back out — a repair pickup patches the car up
   * but does not make it factory fresh. A car that has been round the houses
   * should still look like it.
   */
  partialRepair(amount = 0.45) {
    const arr = this.pos.array;
    const col = this.col.array;
    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;
      arr[i3] += (this.original[i3] - arr[i3]) * amount;
      arr[i3 + 1] += (this.original[i3 + 1] - arr[i3 + 1]) * amount;
      arr[i3 + 2] += (this.original[i3 + 2] - arr[i3 + 2]) * amount;
      col[i3] += (this.originalCol[i3] - col[i3]) * amount;
      col[i3 + 1] += (this.originalCol[i3 + 1] - col[i3 + 1]) * amount;
      col[i3 + 2] += (this.originalCol[i3 + 2] - col[i3 + 2]) * amount;
      this.dentDepth[i] *= 1 - amount;
    }
    this.totalDamage *= 1 - amount;
    this.dirty = true;
  }

  /** Uploads changes once per frame at most. */
  flush() {
    if (!this.dirty) return;
    this.pos.needsUpdate = true;
    this.col.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    this.mesh.geometry.computeBoundingSphere();
    this.dirty = false;
  }

  /** Straightens the panels out again — used on respawn. */
  reset() {
    this.pos.array.set(this.original);
    this.col.array.set(this.originalCol);
    this.dentDepth.fill(0);
    this.totalDamage = 0;
    this.dirty = true;
    this.flush();
  }

  /** Blackens the whole shell when the car is wrecked. */
  scorch() {
    const col = this.col.array;
    for (let i = 0; i < col.length; i++) col[i] *= 0.3;
    this.col.needsUpdate = true;
  }
}
