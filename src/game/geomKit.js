/**
 * Small procedural-geometry toolkit. Everything in the park is generated from
 * these four primitives — no modelling software, no asset downloads.
 */
import * as THREE from 'three';

/** Points along a circular arc in 2D. Angles in radians. */
export function arcPoints(cx, cy, r, a0, a1, steps) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

/**
 * Extrudes a closed 2D polygon (XY) along +Z into a solid.
 * @param {number[][]} poly  closed polygon, [[x,y], ...]
 * @param {number} depth
 */
export function prism(poly, depth) {
  const shape = new THREE.Shape();
  shape.moveTo(poly[0][0], poly[0][1]);
  for (let i = 1; i < poly.length; i++) shape.lineTo(poly[i][0], poly[i][1]);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 12 });
  g.translate(0, 0, -depth / 2); // centre it on Z so placement is intuitive
  return g;
}

/**
 * A quarter-pipe / kicker profile as a closed polygon.
 * Rises from (0,0) to (reach, height) along a circular arc that starts
 * horizontal, then drops straight back down to the base.
 *
 * @param {number} radius  arc radius — bigger = mellower transition
 * @param {number} sweep   how far around the arc to go (radians, max PI/2)
 */
export function rampProfile(radius, sweep, steps = 14) {
  // Arc centred at (0, radius): starts at angle -PI/2 (the point (0,0)).
  const pts = arcPoints(0, radius, radius, -Math.PI / 2, -Math.PI / 2 + sweep, steps);
  const last = pts[pts.length - 1];
  const poly = pts.slice();
  poly.push([last[0], 0]);        // drop straight down from the lip
  return poly;
}

/** A vert wall / bowl transition: same arc but continues to a vertical lip. */
export function bowlProfile(radius, lipHeight, steps = 16) {
  const pts = arcPoints(0, radius, radius, -Math.PI / 2, 0, steps); // quarter, ends vertical
  const top = pts[pts.length - 1];
  const poly = pts.slice();
  poly.push([top[0], top[1] + lipHeight]);
  poly.push([top[0] + 2.2, top[1] + lipHeight]);
  poly.push([top[0] + 2.2, 0]);
  return poly;
}

/** Symmetric trapezoid (funbox) cross-section. */
export function funboxProfile(baseLen, topLen, height) {
  const b = baseLen / 2, t = topLen / 2;
  return [[-b, 0], [-t, height], [t, height], [b, 0]];
}

/**
 * Sweeps a rectangular cross-section along an oriented path, producing a
 * closed solid. Used for the loop, the corkscrew and banked turns.
 *
 * @param {{p:THREE.Vector3, n:THREE.Vector3, b:THREE.Vector3}[]} frames
 *        p = centre of the driving surface, n = surface normal (the side the
 *        car drives on), b = width direction.
 * @param {number} width
 * @param {number} thickness
 * @param {boolean} closed  join the last frame back to the first
 */
export function sweepRibbon(frames, width, thickness, closed = false) {
  const hw = width / 2;
  const verts = [];
  const uvs = [];
  const idx = [];

  let run = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (i > 0) run += f.p.distanceTo(frames[i - 1].p);
    const { p, n, b } = f;
    // 4 corners, ordered consistently around the cross-section
    const ax = p.x + b.x * hw, ay = p.y + b.y * hw, az = p.z + b.z * hw;
    const bx = p.x - b.x * hw, by = p.y - b.y * hw, bz = p.z - b.z * hw;
    verts.push(
      ax, ay, az,
      bx, by, bz,
      bx - n.x * thickness, by - n.y * thickness, bz - n.z * thickness,
      ax - n.x * thickness, ay - n.y * thickness, az - n.z * thickness
    );
    const u = run / 8;
    uvs.push(u, 0, u, 1, u, 1 + thickness / 8, u, thickness / 8);
  }

  const n = frames.length;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = i * 4;
    const c = ((i + 1) % n) * 4;
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      idx.push(a + k, a + k2, c + k2);
      idx.push(a + k, c + k2, c + k);
    }
  }

  // end caps
  if (!closed) {
    const last = (n - 1) * 4;
    idx.push(0, 2, 1, 0, 3, 2);
    idx.push(last, last + 1, last + 2, last, last + 2, last + 3);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Frames for a loop-the-loop. The car enters at the bottom travelling along
 * `forward`.
 *
 * `drift` slides the loop sideways as it goes round, so the descending end
 * lands beside the entry instead of on top of it. Without it the loop is a
 * circle tangent to the ground at a single point, and a car driving at that
 * point simply crashes into the back of the loop coming down. Real stunt-show
 * loops are built exactly this way. Keep drift > road width.
 */
export function loopFrames(centre, radius, forward, steps = 56, drift = 0) {
  const up = new THREE.Vector3(0, 1, 0);
  const fwd = forward.clone().normalize();
  const side = new THREE.Vector3().crossVectors(fwd, up).normalize();
  const frames = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const th = t * Math.PI * 2;
    const p = centre.clone()
      .addScaledVector(up, -Math.cos(th) * radius)
      .addScaledVector(fwd, Math.sin(th) * radius)
      .addScaledVector(side, (t - 0.5) * drift);
    // normal points at the loop's axis, ignoring the sideways drift
    const axis = centre.clone().addScaledVector(side, (t - 0.5) * drift);
    frames.push({ p, n: axis.sub(p).normalize(), b: side.clone() });
  }
  return frames;
}

/**
 * Frames for a helix (corkscrew ramp) winding around a vertical axis.
 */
export function helixFrames(centre, radius, turns, height, bank, steps = 90) {
  const frames = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const th = t * Math.PI * 2 * turns;
    const p = new THREE.Vector3(
      centre.x + Math.cos(th) * radius,
      centre.y + t * height,
      centre.z + Math.sin(th) * radius
    );
    // tangent of the helix
    const tang = new THREE.Vector3(
      -Math.sin(th) * radius,
      height / (Math.PI * 2 * turns),
      Math.cos(th) * radius
    ).normalize();
    // outward radial direction
    const out = new THREE.Vector3(Math.cos(th), 0, Math.sin(th));
    // bank the surface inwards so cars stick through the turn
    const n = new THREE.Vector3(0, 1, 0).addScaledVector(out, -Math.tan(bank)).normalize();
    const b = new THREE.Vector3().crossVectors(tang, n).normalize();
    frames.push({ p, n, b });
  }
  return frames;
}

/**
 * Derives frames for a side rail running along an existing ribbon.
 *
 * Loops and corkscrews need these: without a kerb the car simply drives off
 * the edge, and a drifting loop is impossible to hold at all.
 *
 * @param {number} side  -1 or +1, which edge of the road
 */
export function railFrames(frames, halfWidth, side, height) {
  return frames.map((f) => ({
    p: f.p.clone()
      .addScaledVector(f.b, side * halfWidth)
      .addScaledVector(f.n, height / 2),
    n: f.b.clone().multiplyScalar(-side),   // faces in, toward the road centre
    b: f.n.clone(),                         // rail height runs along the road normal
  }));
}

/** Frames for a banked arc turn at constant height. */
export function bankedArcFrames(centre, radius, a0, a1, bank, steps = 40) {
  const frames = [];
  for (let i = 0; i <= steps; i++) {
    const th = a0 + ((a1 - a0) * i) / steps;
    const p = new THREE.Vector3(
      centre.x + Math.cos(th) * radius,
      centre.y,
      centre.z + Math.sin(th) * radius
    );
    const out = new THREE.Vector3(Math.cos(th), 0, Math.sin(th));
    const tang = new THREE.Vector3(-Math.sin(th), 0, Math.cos(th));
    const n = new THREE.Vector3(0, 1, 0).addScaledVector(out, -Math.tan(bank)).normalize();
    const b = new THREE.Vector3().crossVectors(tang, n).normalize();
    frames.push({ p, n, b });
  }
  return frames;
}

/** Applies position/rotation/scale to a geometry, baking it into world space. */
export function place(geometry, { pos, rot, scale } = {}) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  if (rot) q.setFromEuler(new THREE.Euler(rot[0] || 0, rot[1] || 0, rot[2] || 0));
  m.compose(
    new THREE.Vector3(pos?.[0] || 0, pos?.[1] || 0, pos?.[2] || 0),
    q,
    new THREE.Vector3(scale?.[0] ?? 1, scale?.[1] ?? 1, scale?.[2] ?? 1)
  );
  geometry.applyMatrix4(m);
  return geometry;
}
