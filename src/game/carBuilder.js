/**
 * Procedural car meshes. No modelling package, no downloads — every car is
 * generated from rounded boxes, cylinders and cones.
 *
 * The whole structural shell is merged into ONE welded mesh with vertex
 * colours. That matters: it means damage.js can crumple the body continuously
 * (no torn seams), and liveries can be painted per-vertex so they deform with
 * the panel instead of sliding around like a decal.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { getItem, DEFAULT_LOADOUT } from './cosmetics.js';
import { loadoutFor } from './weapons.js';
import { makeRng } from '../core/util.js';

const _c = new THREE.Color();

/** Attaches a flat vertex colour to a geometry so parts can be merged. */
function tint(geom, hex) {
  _c.set(hex);
  const n = geom.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = _c.r; arr[i * 3 + 1] = _c.g; arr[i * 3 + 2] = _c.b;
  }
  geom.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  return geom;
}

function box(w, h, d, radius = 0.06, seg = 3) {
  return new RoundedBoxGeometry(w, h, d, seg, Math.min(radius, Math.min(w, h, d) / 2.05));
}

function at(geom, x, y, z, rot) {
  if (rot) {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0] || 0, rot[1] || 0, rot[2] || 0));
    geom.applyQuaternion(q);
  }
  geom.translate(x, y, z);
  return geom;
}

// ─────────────────────────────────────────────────────────────
// liveries — painted per-vertex, so they crumple with the panel
// ─────────────────────────────────────────────────────────────
const LIVERY = {
  stripes(x, y, z, bd) {
    return Math.abs(x) < bd.w * 0.30 && Math.abs(x) > bd.w * 0.08 ? 'accent' : null;
  },
  checker(x, y, z) {
    return (Math.floor(x / 0.34) + Math.floor(z / 0.34)) % 2 === 0 ? 'accent' : null;
  },
  hazard(x, y, z) {
    return Math.floor((x + z) / 0.30) % 2 === 0 ? 'accent' : null;
  },
  flames(x, y, z, bd) {
    const t = (z + bd.l) / (bd.l * 2);          // 0 at back, 1 at front
    const wig = Math.sin(x * 5.5) * 0.12 + Math.sin(x * 11.0 + 1.7) * 0.06;
    return t > 0.52 + wig ? 'accent' : null;
  },
  camo(x, y, z) {
    const n = Math.sin(x * 2.6) * Math.cos(z * 1.9) + Math.sin(z * 3.7 + 1.1) * 0.6;
    if (n > 0.55) return 'accent';
    if (n < -0.65) return 'dark';
    return null;
  },
  splatter(x, y, z) {
    const n = Math.sin(x * 7.3 + z * 4.1) * Math.cos(z * 6.7 - x * 3.3);
    return n > 0.72 ? 'accent' : null;
  },
  circuit(x, y, z) {
    const gx = Math.abs((x * 4) % 1 - 0.5) < 0.07;
    const gz = Math.abs((z * 3) % 1 - 0.5) < 0.07;
    return gx || gz ? 'accent' : null;
  },
};

const ACCENTS = {
  stripes: 0xf2f4f8, checker: 0x14171d, hazard: 0x14171d, flames: 0xff7a18,
  camo: 0x3f4a32, splatter: 0x14171d, circuit: 0x22e0ff,
};

function paintLivery(geom, patternId, bd, accentHex) {
  const fn = LIVERY[patternId];
  if (!fn) return;
  const pos = geom.attributes.position;
  const col = geom.attributes.color;
  const accent = new THREE.Color(accentHex);
  const dark = new THREE.Color(0x1a1f26);
  for (let i = 0; i < pos.count; i++) {
    // never paint over glass or lights — they are already emissive/dark
    const r = col.getX(i), g = col.getY(i), b = col.getZ(i);
    const lum = r + g + b;
    if (lum < 0.22) continue;
    const hit = fn(pos.getX(i), pos.getY(i), pos.getZ(i), bd);
    if (hit === 'accent') col.setXYZ(i, accent.r, accent.g, accent.b);
    else if (hit === 'dark') col.setXYZ(i, dark.r, dark.g, dark.b);
  }
  col.needsUpdate = true;
}

// ─────────────────────────────────────────────────────────────
// shells
// ─────────────────────────────────────────────────────────────
const GLASS = 0x10151f;
const TRIM = 0x23282f;

/**
 * The bodywork.
 *
 * Every car is built as a set of separate panels — wings, doors, bonnet, roof,
 * pillars, arches — rather than one box, because that is what makes it read as
 * a vehicle rather than a shape. It is then welded into a single mesh so the
 * damage model can crumple across panel boundaries.
 *
 * A per-car seed decides where the rust sits, which panel got replaced with a
 * mismatched one, where the scrap armour is welded on and how it is already
 * dented. No two cars in a lobby look the same.
 */
function buildShell(type, paint, seed = 1) {
  const bd = type.body;
  const cab = bd.cabin;
  const rng = makeRng(seed * 2654435761);
  const parts = [];
  const P = (g, hex) => parts.push(tint(g, hex));

  // a mismatched replacement panel: this car has been repaired badly before
  const SALVAGE = [0x5a5f66, 0x6b5a3f, 0x3f4a52, 0x7a4a33, 0x4a4038];
  const salvage = SALVAGE[Math.floor(rng() * SALVAGE.length)];
  const salvageSide = rng() > 0.5 ? 1 : -1;
  const salvagedDoor = rng() > 0.45;
  const salvagedBonnet = rng() > 0.7;

  const w = bd.w, h = bd.h, l = bd.l;

  // ── chassis tub ──
  P(at(box(w * 1.9, h * 1.7, l * 1.98, 0.1, 3), 0, 0, 0), paint);

  // ── sills ──
  for (const sx of [-1, 1]) {
    P(at(box(0.16, h * 0.7, l * 1.5, 0.04), sx * (w * 0.96), -h * 0.72, 0), paint);
  }

  // ── front wings and rear haunches, with arch lips ──
  for (const sx of [-1, 1]) {
    P(at(box(0.3, h * 1.5, l * 0.62, 0.09), sx * (w * 0.92), h * 0.1, bd.front * 0.75), paint);
    P(at(box(0.34, h * 1.7, l * 0.66, 0.09), sx * (w * 0.92), h * 0.18, bd.rear * 0.78), paint);
    // arch lips over the wheels
    for (const zz of [bd.front, bd.rear]) {
      const arch = new THREE.TorusGeometry(type.phys.wheelRadius * 1.18, 0.075, 5, 10, Math.PI);
      at(arch, sx * (w * 0.99), h * 0.05, zz, [0, Math.PI / 2, 0]);
      P(arch, paint);
    }
  }

  // ── bonnet and boot as their own panels, with a gap around them ──
  const bonnetZ = l * 0.55;
  P(at(box(w * 1.62, 0.1, l * 0.72, 0.04), 0, h + 0.03, bonnetZ),
    salvagedBonnet ? salvage : paint);
  P(at(box(w * 1.5, 0.1, l * 0.5, 0.04), 0, h * 0.92, -l * 0.68), paint);

  // ── doors, slightly proud, one of them salvaged ──
  for (const sx of [-1, 1]) {
    const isSalvage = salvagedDoor && sx === salvageSide;
    P(at(box(0.12, h * 1.25, l * 0.78, 0.05), sx * (w * 1.0), h * 0.05, cab.z + 0.1),
      isSalvage ? salvage : paint);
    // door handle
    P(at(box(0.06, 0.07, 0.26, 0.02), sx * (w * 1.06), h * 0.4, cab.z - 0.1), TRIM);
  }

  // ── greenhouse: roof, pillars, and the openings the glass sits in ──
  const roofY = cab.y + cab.h;
  P(at(box(cab.w * 1.9, 0.11, cab.l * 1.75, 0.05), 0, roofY, cab.z), paint);
  const pillar = (sx, z, lean, thick = 0.13) =>
    P(at(box(thick, cab.h * 2.05, thick + 0.03, 0.03), sx * cab.w * 0.94, cab.y, cab.z + z, [lean, 0, 0]), paint);
  for (const sx of [-1, 1]) {
    pillar(sx, cab.l * 0.95, -0.34);      // A
    pillar(sx, -cab.l * 0.05, 0, 0.11);   // B
    pillar(sx, -cab.l * 0.95, 0.26);      // C
  }
  // ── interior ──
  // Without something behind the glass the cabin reads as a hole. Dark tub,
  // seats, and a lit dashboard so the windows glow at night.
  P(at(box(cab.w * 1.8, cab.h * 1.6, cab.l * 1.7, 0.04), 0, cab.y - 0.06, cab.z), 0x0b0d11);
  for (const sx of [-1, 1]) {
    P(at(box(0.3, cab.h * 0.9, 0.16, 0.03), sx * cab.w * 0.42, cab.y - cab.h * 0.15, cab.z - cab.l * 0.35), 0x14171d);
    P(at(box(0.32, 0.16, 0.34, 0.03), sx * cab.w * 0.42, cab.y - cab.h * 0.72, cab.z - cab.l * 0.05), 0x14171d);
  }
  // steering wheel
  {
    const wheelG = new THREE.TorusGeometry(0.14, 0.028, 5, 10);
    at(wheelG, -cab.w * 0.42, cab.y - cab.h * 0.35, cab.z + cab.l * 0.42, [1.15, 0, 0]);
    P(wheelG, 0x1a1d23);
  }

  // scuttle below the windscreen and a parcel shelf behind the rear glass
  P(at(box(cab.w * 1.86, 0.1, 0.2, 0.03), 0, cab.y - cab.h * 0.85, cab.z + cab.l * 0.95), paint);
  P(at(box(cab.w * 1.86, 0.1, 0.2, 0.03), 0, cab.y - cab.h * 0.85, cab.z - cab.l * 0.95), paint);

  // window surrounds
  for (const sx of [-1, 1]) {
    P(at(box(0.05, 0.06, cab.l * 1.55, 0.02), sx * cab.w * 0.95, cab.y + cab.h * 0.92, cab.z), TRIM);
    P(at(box(0.05, 0.06, cab.l * 1.5, 0.02), sx * cab.w * 0.95, cab.y - cab.h * 0.75, cab.z), TRIM);
  }

  // ── nose: grille, lamp buckets, bumper ──
  P(at(box(w * 1.75, h * 0.95, 0.16, 0.04), 0, h * 0.05, l * 1.0), TRIM);
  for (let i = -3; i <= 3; i++) {
    P(at(box(0.06, h * 0.7, 0.1, 0.02), i * (w * 0.21), h * 0.05, l * 1.05), 0x0d1014);
  }
  for (const sx of [-1, 1]) {
    P(at(box(0.34, 0.22, 0.14, 0.05), sx * w * 0.62, h * 0.12, l * 1.0), TRIM);
  }
  P(at(box(w * 1.95, 0.22, 0.22, 0.06), 0, -h * 0.6, l * 1.03), TRIM);
  P(at(box(w * 1.9, 0.2, 0.2, 0.06), 0, -h * 0.5, -l * 1.03), TRIM);

  // ── welded-on scrap armour: the ragtag layer ──
  const plates = 2 + Math.floor(rng() * 4);
  for (let i = 0; i < plates; i++) {
    const sx = rng() > 0.5 ? 1 : -1;
    const pw = 0.07;
    const ph = 0.22 + rng() * 0.42;
    const pl = 0.35 + rng() * 0.7;
    const z = (rng() - 0.5) * l * 1.4;
    const y = (rng() - 0.35) * h * 1.5;
    const g = box(pw, ph, pl, 0.02);
    at(g, sx * (w * 1.05), y, z, [0, 0, (rng() - 0.5) * 0.3]);
    P(g, SALVAGE[Math.floor(rng() * SALVAGE.length)]);
    // tack welds along the edge
    for (let k = 0; k < 3; k++) {
      P(at(new THREE.SphereGeometry(0.035, 5, 4),
        sx * (w * 1.09), y + ph * 0.5, z - pl * 0.35 + k * pl * 0.35), TRIM);
    }
  }

  // ── per-style extras ──
  switch (bd.style) {
    case 'muscle':
      if (bd.hoodScoop) {
        P(at(box(0.46, 0.19, 0.62, 0.05), 0, h + 0.14, bonnetZ + 0.1), TRIM);
        P(at(box(0.34, 0.1, 0.12, 0.02), 0, h + 0.24, bonnetZ + 0.42), 0x0d1014);
      }
      P(at(box(w * 1.9, 0.09, 0.4, 0.03), 0, -h * 0.85, l * 0.98), TRIM);
      break;

    case 'buggy': {
      if (bd.rollCage) {
        const tube = (x1, y1, z1, x2, y2, z2, r = 0.055) => {
          const a = new THREE.Vector3(x1, y1, z1), b2 = new THREE.Vector3(x2, y2, z2);
          const len = a.distanceTo(b2);
          const g = new THREE.CylinderGeometry(r, r, len, 6);
          const mid = a.clone().add(b2).multiplyScalar(0.5);
          const q = new THREE.Quaternion().setFromUnitVectors(
            new THREE.Vector3(0, 1, 0), b2.clone().sub(a).normalize());
          g.applyQuaternion(q); g.translate(mid.x, mid.y, mid.z);
          P(g, TRIM);
        };
        const hx = w * 0.82, hy = roofY + 0.2, hz = cab.z;
        tube(-hx, 0.1, hz + 0.6, -hx, hy, hz - 0.1);
        tube(hx, 0.1, hz + 0.6, hx, hy, hz - 0.1);
        tube(-hx, hy, hz - 0.1, hx, hy, hz - 0.1);
        tube(-hx, hy, hz - 0.1, -hx, -h * 0.4, hz - 1.05);
        tube(hx, hy, hz - 0.1, hx, -h * 0.4, hz - 1.05);
        tube(-hx, hy * 0.6, hz + 0.25, hx, hy * 0.6, hz + 0.25, 0.045);
      }
      P(at(box(w * 1.2, h * 1.1, 0.5, 0.11), 0, -0.02, l * 1.05), paint);
      break;
    }

    case 'truck':
      // flatbed with slatted sides
      P(at(box(w * 1.86, 0.14, l * 0.8, 0.04), 0, h * 0.95, -l * 0.5), TRIM);
      for (const sx of [-1, 1]) {
        for (let i = 0; i < 4; i++) {
          P(at(box(0.09, 0.36, l * 0.18, 0.02),
            sx * w * 0.93, h * 1.2, -l * 0.5 + (i - 1.5) * l * 0.2), paint);
        }
      }
      for (const sx of [-1, 1]) {
        P(at(new THREE.CylinderGeometry(0.1, 0.1, 1.3, 8), sx * w * 0.78, h + 0.6, cab.z - cab.l), TRIM);
      }
      // bullbar
      P(at(box(w * 2.0, 0.16, 0.16, 0.05), 0, -h * 0.1, l * 1.12), TRIM);
      for (const sx of [-1, 1]) {
        P(at(box(0.12, h * 1.3, 0.12, 0.03), sx * w * 0.7, h * 0.2, l * 1.12), TRIM);
      }
      break;

    default: // hyper
      P(at(box(w * 1.55, h * 0.9, l * 0.5, 0.1), 0, -h * 0.35, l * 0.95), paint);
      for (const sx of [-1, 1]) {
        P(at(box(0.22, h * 1.1, l * 0.85, 0.05), sx * w * 1.03, -0.02, -l * 0.12), TRIM);
      }
      if (bd.lowWing) P(at(box(w * 1.85, 0.07, 0.34, 0.02), 0, h * 0.9, -l * 1.02), TRIM);
      break;
  }

  return parts;
}

/**
 * Glass. A separate mesh with its own material — dark, reflective and slightly
 * transparent, with a crack pattern etched in per car.
 */
function buildGlass(type, seed = 1) {
  const bd = type.body;
  const cab = bd.cabin;
  const rng = makeRng(seed * 40503 + 7);
  const parts = [];

  const inset = 0.02;
  // windscreen, raked back
  {
    const g = box(cab.w * 1.72, cab.h * 1.5, 0.05, 0.02, 1);
    at(g, 0, cab.y + 0.02, cab.z + cab.l * 0.9, [-0.34, 0, 0]);
    parts.push(g);
  }
  // rear screen
  {
    const g = box(cab.w * 1.66, cab.h * 1.3, 0.05, 0.02, 1);
    at(g, 0, cab.y + 0.02, cab.z - cab.l * 0.9, [0.26, 0, 0]);
    parts.push(g);
  }
  // side windows, front and rear on each side
  for (const sx of [-1, 1]) {
    const front = box(0.05, cab.h * 1.25, cab.l * 0.8, 0.02, 1);
    at(front, sx * (cab.w * 0.92 - inset), cab.y + 0.05, cab.z + cab.l * 0.44);
    parts.push(front);
    const rear = box(0.05, cab.h * 1.1, cab.l * 0.62, 0.02, 1);
    at(rear, sx * (cab.w * 0.92 - inset), cab.y + 0.05, cab.z - cab.l * 0.5);
    parts.push(rear);
  }

  const merged = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)), false);
  return { geometry: merged, cracked: rng() > 0.45 };
}

/**
 * The junk bolted to the outside: spare wheel, jerry cans, roof rack, mirrors,
 * aerial. Seeded, so each car carries a different load of rubbish.
 */
function buildScrap(type, seed, trimMat, rustMat) {
  const bd = type.body;
  const cab = bd.cabin;
  const rng = makeRng(seed * 99991 + 13);
  const g = new THREE.Group();
  const add = (geom, mat, x, y, z, rot) => {
    const m = new THREE.Mesh(at(geom, x, y, z, rot), mat);
    m.castShadow = true;
    g.add(m);
    return m;
  };

  // spare wheel on the back
  if (rng() > 0.35) {
    add(new THREE.TorusGeometry(type.phys.wheelRadius * 0.72, type.phys.wheelRadius * 0.26, 6, 12),
      rustMat, 0, bd.h * 0.5, -bd.l - 0.22);
  }
  // jerry cans on the flank or the bed
  const cans = Math.floor(rng() * 3);
  for (let i = 0; i < cans; i++) {
    const sx = rng() > 0.5 ? 1 : -1;
    add(box(0.16, 0.34, 0.24, 0.03), rustMat,
      sx * (bd.w + 0.12), bd.h * 0.35, -bd.l * (0.3 + i * 0.3));
  }
  // roof rack with a strapped-down load
  if (rng() > 0.5) {
    const top = cab.y + cab.h + 0.12;
    for (const sx of [-1, 1]) {
      add(new THREE.CylinderGeometry(0.035, 0.035, cab.l * 1.7, 6), trimMat,
        sx * cab.w * 0.8, top, cab.z, [Math.PI / 2, 0, 0]);
    }
    for (let i = -1; i <= 1; i++) {
      add(new THREE.CylinderGeometry(0.03, 0.03, cab.w * 1.6, 6), trimMat,
        0, top, cab.z + i * cab.l * 0.6, [0, 0, Math.PI / 2]);
    }
    add(box(cab.w * 1.1, 0.2, cab.l * 0.8, 0.03), rustMat, 0, top + 0.14, cab.z - 0.1,
      [0, rng() * 0.3 - 0.15, 0]);
  }
  // wing mirrors
  for (const sx of [-1, 1]) {
    if (rng() > 0.2) {
      add(new THREE.CylinderGeometry(0.02, 0.02, 0.2, 5), trimMat,
        sx * (bd.w + 0.1), cab.y - cab.h * 0.2, cab.z + cab.l * 0.85, [0, 0, Math.PI / 2.4]);
      add(box(0.05, 0.14, 0.1, 0.02), trimMat,
        sx * (bd.w + 0.24), cab.y - cab.h * 0.1, cab.z + cab.l * 0.85);
    }
  }
  // aerial with a rag on it
  if (rng() > 0.45) {
    add(new THREE.CylinderGeometry(0.014, 0.02, 1.5, 5), trimMat,
      bd.w * 0.7, cab.y + cab.h + 0.7, cab.z - cab.l * 0.7);
    add(box(0.02, 0.16, 0.3, 0.01), rustMat,
      bd.w * 0.7, cab.y + cab.h + 1.32, cab.z - cab.l * 0.85);
  }
  // exhaust out the side
  if (rng() > 0.5) {
    const sx = rng() > 0.5 ? 1 : -1;
    add(new THREE.CylinderGeometry(0.07, 0.08, bd.l * 0.9, 8), trimMat,
      sx * (bd.w + 0.14), -bd.h * 0.55, -bd.l * 0.15, [Math.PI / 2, 0, 0]);
    add(new THREE.CylinderGeometry(0.1, 0.08, 0.18, 8), trimMat,
      sx * (bd.w + 0.14), -bd.h * 0.55, -bd.l * 0.62, [Math.PI / 2, 0, 0]);
  }
  return g;
}

/**
 * Rust, soot and a lifetime of bad repairs, painted straight into the vertex
 * colours so it deforms with the panel it is on.
 */
function weatherShell(geom, seed) {
  const rng = makeRng(seed * 7919 + 3);
  const pos = geom.attributes.position;
  const col = geom.attributes.color;

  // Rust blooms, big and plentiful. This is the difference between "painted
  // green" and "was green once".
  const blooms = [];
  for (let i = 0; i < 18; i++) {
    blooms.push({
      x: (rng() - 0.5) * 2.8, y: (rng() - 0.5) * 2.0, z: (rng() - 0.5) * 5.0,
      r: 0.45 + rng() * 1.1,
      c: new THREE.Color([0x6b3a1c, 0x7d4a24, 0x4a2f18, 0x8a5a2c, 0x3d3a34][Math.floor(rng() * 5)]),
    });
  }
  // vertical grime runs, as if it has stood out in this rain for years
  const runs = [];
  for (let i = 0; i < 12; i++) {
    runs.push({ x: (rng() - 0.5) * 2.8, z: (rng() - 0.5) * 5.0, w: 0.12 + rng() * 0.3 });
  }

  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    c.setRGB(col.getX(i), col.getY(i), col.getZ(i));

    // glass, lamps and the dash stay clean
    if (c.r + c.g + c.b > 0.2) {
      for (const b of blooms) {
        const d = Math.hypot(x - b.x, y - b.y, z - b.z);
        if (d < b.r) c.lerp(b.c, (1 - d / b.r) ** 0.75 * 0.88);
      }
      for (const r of runs) {
        const d = Math.hypot(x - r.x, z - r.z);
        if (d < r.w) c.multiplyScalar(1 - (1 - d / r.w) * 0.4);
      }
      // filthy overall, filthier the lower down you go
      const dirt = 0.84 - Math.max(0, 0.25 - y) * 0.42;
      const grain = 0.8 + ((Math.sin(x * 31.7 + z * 17.3) * 0.5 + 0.5) * 0.3)
                        + ((Math.sin(x * 9.1 - z * 5.7) * 0.5 + 0.5) * 0.14);
      c.multiplyScalar(dirt * grain);
      // knock the saturation back: nothing out here is factory fresh
      const lum = c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
      c.setRGB(c.r + (lum - c.r) * 0.16, c.g + (lum - c.g) * 0.16, c.b + (lum - c.b) * 0.16);
    }
    col.setXYZ(i, c.r, c.g, c.b);
  }
  col.needsUpdate = true;
}

/** Pre-existing dents, so the car arrives already second-hand. */
function batterShell(geom, seed, bd) {
  const rng = makeRng(seed * 6151 + 29);
  const pos = geom.attributes.position;
  const hits = 3 + Math.floor(rng() * 4);
  for (let k = 0; k < hits; k++) {
    const hx = (rng() - 0.5) * bd.w * 2.4;
    const hy = (rng() - 0.4) * bd.h * 2.6;
    const hz = (rng() - 0.5) * bd.l * 2.2;
    const r = 0.35 + rng() * 0.6;
    const depth = 0.05 + rng() * 0.11;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const d = Math.hypot(x - hx, y - hy, z - hz);
      if (d > r) continue;
      const f = (1 - d / r) ** 2 * depth;
      const len = Math.hypot(x, y, z) || 1;
      pos.setXYZ(i, x - (x / len) * f, y - (y / len) * f, z - (z / len) * f);
    }
  }
  pos.needsUpdate = true;
}

/**
 * Collapses a group of meshes into one mesh per material.
 *
 * All the bolted-on detail is static relative to the car, so there is no reason
 * to pay a draw call for every pipe and rivet. Four fully-detailed cars was
 * ~160 draw calls; this brings it down to a handful.
 */
function collapseByMaterial(group) {
  const buckets = new Map();
  group.traverse((o) => {
    if (!o.isMesh) return;
    const key = o.material.uuid;
    if (!buckets.has(key)) buckets.set(key, { mat: o.material, geos: [] });
    const g = o.geometry.clone();
    o.updateMatrix();
    g.applyMatrix4(o.matrix);
    buckets.get(key).geos.push(g.index ? g.toNonIndexed() : g);
  });

  const out = new THREE.Group();
  for (const { mat, geos } of buckets.values()) {
    if (!geos.length) continue;
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (!merged) {
      // fall back rather than silently losing the parts
      for (const g of geos) out.add(new THREE.Mesh(g, mat));
      continue;
    }
    const m = new THREE.Mesh(merged, mat);
    m.castShadow = true;
    out.add(m);
  }
  // release the originals
  group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
  return out;
}

/**
 * The weapon hardware, actually bolted to the car. Each one is the silhouette
 * you see coming: a gatling on the buggy, rocket pods on the muscle car, a
 * mortar tube out of the truck bed, an emitter array on the EV.
 */
function buildWeaponRig(type, trimMat, rustMat, glowMat) {
  const bd = type.body;
  const cab = bd.cabin;
  const { weapon, counter } = loadoutFor(type.id);
  const g = new THREE.Group();
  const add = (geom, mat, x, y, z, rot) => {
    const m = new THREE.Mesh(at(geom, x, y, z, rot), mat);
    m.castShadow = true;
    g.add(m);
    return m;
  };
  const roof = cab.y + cab.h;

  // ── offensive ──
  if (weapon === 'gatling') {
    // pintle-mounted rotary gun on the roll cage
    add(box(0.22, 0.16, 0.3, 0.03), trimMat, 0, roof + 0.2, cab.z - 0.1);
    add(new THREE.CylinderGeometry(0.11, 0.11, 0.34, 10), trimMat,
      0, roof + 0.36, cab.z + 0.1, [Math.PI / 2, 0, 0]);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      add(new THREE.CylinderGeometry(0.028, 0.028, 0.78, 6), trimMat,
        Math.cos(a) * 0.062, roof + 0.36 + Math.sin(a) * 0.062, cab.z + 0.55,
        [Math.PI / 2, 0, 0]);
    }
    // ammo box and belt
    add(box(0.2, 0.18, 0.26, 0.02), rustMat, -0.24, roof + 0.22, cab.z - 0.25);

  } else if (weapon === 'rockets') {
    // pods over each front wing
    for (const sx of [-1, 1]) {
      add(box(0.26, 0.24, 0.8, 0.05), rustMat, sx * bd.w * 0.72, bd.h + 0.2, bd.l * 0.3);
      for (let i = 0; i < 4; i++) {
        const ox = (i % 2) * 0.11 - 0.055;
        const oy = Math.floor(i / 2) * 0.11 - 0.055;
        add(new THREE.CylinderGeometry(0.045, 0.045, 0.1, 8), glowMat,
          sx * bd.w * 0.72 + ox, bd.h + 0.2 + oy, bd.l * 0.3 + 0.42, [Math.PI / 2, 0, 0]);
      }
    }

  } else if (weapon === 'mortar') {
    // stubby tube on the flatbed, angled up
    add(new THREE.CylinderGeometry(0.19, 0.22, 1.15, 10), trimMat,
      0, bd.h + 0.75, -bd.l * 0.45, [-0.55, 0, 0]);
    add(new THREE.CylinderGeometry(0.24, 0.24, 0.12, 10), rustMat,
      0, bd.h + 0.28, -bd.l * 0.72);
    // bracing legs
    for (const sx of [-1, 1]) {
      add(new THREE.CylinderGeometry(0.035, 0.035, 0.8, 5), trimMat,
        sx * 0.3, bd.h + 0.5, -bd.l * 0.62, [0.3, 0, sx * 0.4]);
    }
    // shells in a rack
    for (let i = 0; i < 3; i++) {
      add(new THREE.CylinderGeometry(0.075, 0.075, 0.3, 8), rustMat,
        -0.4 + i * 0.18, bd.h + 0.28, -bd.l * 0.15);
    }

  } else if (weapon === 'laser') {
    // emitter array along the nose with a capacitor bank behind it
    add(box(bd.w * 1.2, 0.14, 0.5, 0.04), trimMat, 0, bd.h * 0.55, bd.l * 0.72);
    add(new THREE.CylinderGeometry(0.07, 0.05, 0.6, 8), glowMat,
      0, bd.h * 0.55, bd.l * 1.05, [Math.PI / 2, 0, 0]);
    for (const sx of [-1, 1]) {
      add(new THREE.CylinderGeometry(0.09, 0.09, 0.44, 8), trimMat,
        sx * bd.w * 0.5, bd.h * 0.62, bd.l * 0.3, [Math.PI / 2, 0, 0]);
      add(new THREE.TorusGeometry(0.1, 0.022, 5, 10), glowMat,
        sx * bd.w * 0.5, bd.h * 0.62, bd.l * 0.5, [Math.PI / 2, 0, 0]);
    }
  }

  // ── defensive ──
  if (counter === 'oil') {
    // drum on the back deck with a drip pipe
    add(new THREE.CylinderGeometry(0.26, 0.26, 0.5, 10), rustMat, 0, bd.h + 0.28, -bd.l * 0.62);
    add(new THREE.CylinderGeometry(0.04, 0.04, 0.7, 6), trimMat,
      0, -bd.h * 0.2, -bd.l * 0.95, [0.5, 0, 0]);

  } else if (counter === 'caltrops') {
    // hopper hanging off the tail
    add(box(0.5, 0.26, 0.22, 0.03), rustMat, 0, -bd.h * 0.1, -bd.l - 0.16, [0.25, 0, 0]);
    add(box(0.44, 0.06, 0.16, 0.02), trimMat, 0, -bd.h * 0.36, -bd.l - 0.24);

  } else if (counter === 'mace') {
    // winch and davit the ball hangs from
    add(new THREE.CylinderGeometry(0.14, 0.14, 0.4, 8), trimMat,
      0, bd.h + 0.55, -bd.l * 0.85, [0, 0, Math.PI / 2]);
    add(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 6), trimMat,
      0, bd.h + 0.75, -bd.l * 1.05, [0.9, 0, 0]);

  } else if (counter === 'deflector') {
    // emitter pylons at the corners
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        add(new THREE.CylinderGeometry(0.05, 0.07, 0.3, 6), trimMat,
          sx * bd.w * 0.85, bd.h + 0.16, sz * bd.l * 0.72);
        add(new THREE.OctahedronGeometry(0.075), glowMat,
          sx * bd.w * 0.85, bd.h + 0.34, sz * bd.l * 0.72);
      }
    }
  }

  return g;
}

// ─────────────────────────────────────────────────────────────
// bolt-on cosmetics
// ─────────────────────────────────────────────────────────────
function buildSpoiler(kind, bd, mat) {
  if (!kind) return null;
  const g = new THREE.Group();
  const zb = -bd.l * 0.94;
  const add = (geom, x, y, z) => { const m = new THREE.Mesh(at(geom, x, y, z), mat); m.castShadow = true; g.add(m); };
  if (kind === 'ducktail') {
    add(box(bd.w * 1.8, 0.10, 0.34, 0.04), 0, bd.h + 0.10, zb + 0.1);
  } else if (kind === 'gt') {
    add(box(bd.w * 2.0, 0.07, 0.42, 0.03), 0, bd.h + 0.52, zb);
    for (const s of [-1, 1]) add(box(0.08, 0.5, 0.16, 0.02), s * bd.w * 0.7, bd.h + 0.28, zb);
  } else if (kind === 'monster') {
    add(box(bd.w * 2.3, 0.09, 0.6, 0.03), 0, bd.h + 0.82, zb);
    for (const s of [-1, 1]) {
      add(box(0.1, 0.8, 0.2, 0.02), s * bd.w * 0.82, bd.h + 0.44, zb);
      add(box(0.06, 0.26, 0.6, 0.02), s * bd.w * 1.14, bd.h + 0.9, zb);
    }
  } else if (kind === 'dual') {
    add(box(bd.w * 2.0, 0.06, 0.34, 0.02), 0, bd.h + 0.40, zb);
    add(box(bd.w * 1.8, 0.06, 0.28, 0.02), 0, bd.h + 0.68, zb - 0.05);
    for (const s of [-1, 1]) add(box(0.08, 0.72, 0.16, 0.02), s * bd.w * 0.7, bd.h + 0.38, zb);
  }
  return g;
}

function buildRoof(kind, bd, mat, glowMat) {
  if (!kind) return null;
  const cab = bd.cabin;
  const g = new THREE.Group();
  const top = cab.y + cab.h;
  const add = (geom, x, y, z, m = mat) => { const me = new THREE.Mesh(at(geom, x, y, z), m); me.castShadow = true; g.add(me); };
  if (kind === 'scoop') {
    add(box(0.42, 0.2, 0.62, 0.05), 0, top + 0.08, cab.z + 0.1);
  } else if (kind === 'lights') {
    add(box(bd.w * 1.2, 0.1, 0.16, 0.03), 0, top + 0.12, cab.z);
    for (let i = -2; i <= 2; i++) {
      add(new THREE.CylinderGeometry(0.07, 0.07, 0.06, 8), i * 0.22, top + 0.2, cab.z, glowMat);
    }
  } else if (kind === 'fin') {
    add(box(0.08, 0.34, 0.9, 0.03), 0, top + 0.16, cab.z - 0.2);
  } else if (kind === 'spikes') {
    for (let i = -1; i <= 1; i++) {
      for (const s of [-1, 1]) {
        add(new THREE.ConeGeometry(0.07, 0.32, 6), s * 0.26, top + 0.16, cab.z + i * 0.3);
      }
    }
  } else if (kind === 'siren') {
    add(box(0.5, 0.12, 0.2, 0.04), 0, top + 0.1, cab.z);
    add(new THREE.CylinderGeometry(0.1, 0.1, 0.14, 10), -0.14, top + 0.21, cab.z, glowMat);
    add(new THREE.CylinderGeometry(0.1, 0.1, 0.14, 10), 0.14, top + 0.21, cab.z, glowMat);
  }
  return g;
}

function buildBumper(kind, bd, mat) {
  if (!kind) return null;
  const g = new THREE.Group();
  const zf = bd.l * 1.02;
  const add = (geom, x, y, z, rot) => { const m = new THREE.Mesh(at(geom, x, y, z, rot), mat); m.castShadow = true; g.add(m); };
  if (kind === 'rambar') {
    add(box(bd.w * 1.9, 0.16, 0.14, 0.05), 0, -bd.h * 0.2, zf);
    for (const s of [-1, 1]) add(box(0.12, 0.5, 0.12, 0.03), s * bd.w * 0.75, 0.05, zf - 0.05);
  } else if (kind === 'spikes') {
    add(box(bd.w * 1.9, 0.16, 0.14, 0.05), 0, -bd.h * 0.2, zf);
    for (let i = -2; i <= 2; i++) {
      add(new THREE.ConeGeometry(0.09, 0.42, 7), i * (bd.w * 0.42), -bd.h * 0.2, zf + 0.2, [Math.PI / 2, 0, 0]);
    }
  } else if (kind === 'plow') {
    add(box(bd.w * 2.3, 0.7, 0.1, 0.03), 0, -bd.h * 0.1, zf + 0.18, [-0.42, 0, 0]);
    add(box(bd.w * 2.3, 0.12, 0.14, 0.03), 0, -bd.h * 0.55, zf + 0.3);
  } else if (kind === 'wedge') {
    add(box(bd.w * 2.1, 0.1, 1.0, 0.02), 0, -bd.h * 0.62, zf + 0.35, [-0.24, 0, 0]);
    for (const s of [-1, 1]) add(box(0.09, 0.4, 0.7, 0.02), s * bd.w * 0.95, -bd.h * 0.35, zf + 0.3);
  }
  return g;
}

function buildWheel(radius, width, wheelItem) {
  const g = new THREE.Group();
  const tyreMat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.95, metalness: 0.0 });
  const rimMat = new THREE.MeshStandardMaterial({
    color: wheelItem.rim,
    roughness: wheelItem.metal ? 0.16 : 0.5,
    metalness: wheelItem.metal ?? 0.6,
    emissive: wheelItem.glow ? wheelItem.rim : 0x000000,
    emissiveIntensity: wheelItem.glow ? 0.9 : 0,
  });

  const tyre = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, width, 16), tyreMat);
  tyre.rotation.z = Math.PI / 2;
  tyre.castShadow = true;
  g.add(tyre);

  // tread blocks so the wheel visibly spins
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const t = new THREE.Mesh(new THREE.BoxGeometry(width * 1.03, radius * 0.13, radius * 0.3), tyreMat);
    t.position.set(0, Math.sin(a) * radius * 0.97, Math.cos(a) * radius * 0.97);
    t.rotation.x = -a;
    g.add(t);
  }

  const hub = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.6, radius * 0.6, width * 1.04, 14), rimMat);
  hub.rotation.z = Math.PI / 2;
  g.add(hub);

  const n = wheelItem.spokes || 5;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const sp = new THREE.Mesh(new THREE.BoxGeometry(width * 1.06, radius * 1.12, radius * 0.16), rimMat);
    sp.rotation.x = a;
    g.add(sp);
  }
  return g;
}

// ─────────────────────────────────────────────────────────────
// the public builder
// ─────────────────────────────────────────────────────────────

/**
 * @param {object} type      entry from CAR_TYPES
 * @param {object} loadout   equipped cosmetics
 * @param {number} teamColor overrides paint in multiplayer so players are told apart
 */
export function buildCar(type, loadout, teamColor = null, seed = null) {
  // Bots and previews pass nothing; fall back to the stock kit.
  loadout = { ...DEFAULT_LOADOUT, ...(loadout || {}) };
  const bd = type.body;
  const cab = bd.cabin;

  // The wear seed has to be identical on every machine or your car would be
  // battered differently on your mate's screen. Derived from the car and the
  // player's colour slot, both of which everyone already agrees on.
  let idHash = 0;
  for (let i = 0; i < type.id.length; i++) idHash = (idHash * 31 + type.id.charCodeAt(i)) | 0;
  const wearSeed = seed ?? (Math.abs(idHash) + (teamColor ?? 0) % 9973) + 1;
  const group = new THREE.Group();

  const paintItem = getItem('paint', loadout.paint);
  const finish = getItem('finish', loadout.finish);
  const liveryItem = getItem('livery', loadout.livery);
  const wheelItem = getItem('wheels', loadout.wheels);
  const glowItem = getItem('underglow', loadout.underglow);

  let paintHex = finish.forceColor ?? paintItem.color ?? type.color;
  if (teamColor !== null) paintHex = teamColor;

  // ── shell ──
  const shellParts = buildShell(type, paintHex, wearSeed);
  // RoundedBoxGeometry is non-indexed while Cylinder/Cone are indexed; merging
  // a mix of the two silently returns null. Normalise first.
  const flatParts = shellParts.map((g) => (g.index ? g.toNonIndexed() : g));
  let shell = mergeGeometries(flatParts, false);
  if (!shell) throw new Error(`car shell merge failed for "${type.id}"`);
  shell = mergeVertices(shell, 1e-3);      // weld so crumpling stays continuous
  paintLivery(shell, liveryItem.pattern, bd, ACCENTS[liveryItem.pattern] || 0xffffff);
  // then age it: dents first so the rust follows the deformed surface
  batterShell(shell, wearSeed, bd);
  weatherShell(shell, wearSeed);
  shell.computeVertexNormals();

  const shellMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    // a bit rougher and more metallic than spec: wet, used, and it catches the
    // neon instead of sitting flat
    roughness: Math.min(1, (finish.rough ?? 0.3) + 0.12),
    metalness: Math.min(1, (finish.metal ?? 0.3) + 0.22),
    envMapIntensity: 1.0,
    emissive: finish.emissive ? new THREE.Color(paintHex) : 0x000000,
    emissiveIntensity: finish.emissive ?? 0,
    flatShading: false,
  });
  const shellMesh = new THREE.Mesh(shell, shellMat);
  shellMesh.castShadow = true;
  shellMesh.receiveShadow = true;
  group.add(shellMesh);

  // ── glass ──
  const glass = buildGlass(type, wearSeed);
  let glassMesh = null;
  if (glass.geometry) {
    // Reflective rather than refractive. MeshPhysicalMaterial's transmission
    // forces an extra render pass per frame and halved the frame rate; a dark
    // transparent surface with a strong environment reflection reads the same
    // at this distance for nothing.
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x1d3444, roughness: 0.06, metalness: 0.75,
      transparent: true, opacity: 0.6,
      emissive: 0x0a1c2a, emissiveIntensity: 0.55,
      envMapIntensity: 3.2, side: THREE.DoubleSide,
    });
    glassMesh = new THREE.Mesh(glass.geometry, glassMat);
    glassMesh.castShadow = false;
    group.add(glassMesh);
  }

  // dashboard glow, so the cabin reads as occupied after dark
  {
    const dash = new THREE.Mesh(
      box(cab.w * 1.3, 0.05, 0.12, 0.02),
      new THREE.MeshStandardMaterial({
        color: 0x37e0b0, emissive: 0x2ad0a0, emissiveIntensity: 2.4, roughness: 0.4,
      })
    );
    dash.position.set(0, cab.y - cab.h * 0.42, cab.z + cab.l * 0.5);
    group.add(dash);
  }

  // ── lights ──
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xfff2d0, emissive: 0xfff2d0, emissiveIntensity: 2.0, roughness: 0.3,
  });
  const tailMat = new THREE.MeshStandardMaterial({
    color: 0xff2a2a, emissive: 0xff2a2a, emissiveIntensity: 1.6, roughness: 0.3,
  });
  for (const s of [-1, 1]) {
    const h = new THREE.Mesh(box(0.28, 0.11, 0.06, 0.02), headMat);
    h.position.set(s * bd.w * 0.6, bd.h * 0.1, bd.l * 1.0);
    group.add(h);
    const t = new THREE.Mesh(box(0.3, 0.09, 0.05, 0.02), tailMat);
    t.position.set(s * bd.w * 0.62, bd.h * 0.28, -bd.l * 1.0);
    group.add(t);
  }

  // ── bolt-ons ──
  // Brass rather than grey plastic: the steampunk layer under the neon.
  const trimMat = new THREE.MeshStandardMaterial({
    color: 0x8a6428, roughness: 0.38, metalness: 0.95, envMapIntensity: 1.4,
  });
  const glowMat = new THREE.MeshStandardMaterial({
    color: 0x22e0ff, emissive: 0x22e0ff, emissiveIntensity: 2.2, roughness: 0.3,
  });
  // scrap junk and the weapon it carries, both bolted on
  const rustMat = new THREE.MeshStandardMaterial({
    color: 0x6b4326, roughness: 0.86, metalness: 0.42, envMapIntensity: 0.9,
  });
  const scrap = collapseByMaterial(buildScrap(type, wearSeed, trimMat, rustMat));
  group.add(scrap);
  const weaponRig = collapseByMaterial(buildWeaponRig(type, trimMat, rustMat, glowMat));
  group.add(weaponRig);

  const accessories = [];
  for (const part of [
    buildSpoiler(getItem('spoiler', loadout.spoiler).kind, bd, trimMat),
    buildRoof(getItem('roof', loadout.roof).kind, bd, trimMat, glowMat),
    buildBumper(getItem('bumper', loadout.bumper).kind, bd, trimMat),
  ]) {
    if (part) { group.add(part); accessories.push(part); }
  }

  // ── underglow ──
  let underglow = null;
  if (glowItem.color !== null && glowItem.color !== undefined) {
    const geo = new THREE.PlaneGeometry(bd.w * 3.4, bd.l * 3.4);
    const mat = new THREE.MeshBasicMaterial({
      color: glowItem.color, transparent: true, opacity: 0.34,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    underglow = new THREE.Mesh(geo, mat);
    underglow.rotation.x = -Math.PI / 2;
    underglow.position.y = -bd.h - 0.34;
    group.add(underglow);
  }

  // ── Tron edge lighting ──
  // Thin light strips along the sills and around the tail. They read as the
  // hard neon edge of the aesthetic and double as player identification.
  const edgeColor = teamColor !== null ? teamColor : paintHex;
  const edgeMat = new THREE.MeshBasicMaterial({ color: edgeColor });
  const edgeGeos = [];
  for (const sx of [-1, 1]) {
    edgeGeos.push(at(new THREE.BoxGeometry(0.05, 0.05, bd.l * 1.55),
      sx * (bd.w + 0.02), -bd.h * 0.55, 0));
  }
  edgeGeos.push(at(new THREE.BoxGeometry(bd.w * 1.75, 0.05, 0.05), 0, bd.h * 0.55, -bd.l - 0.02));
  edgeGeos.push(at(new THREE.BoxGeometry(bd.w * 1.5, 0.05, 0.05), 0, -bd.h * 0.3, bd.l + 0.02));
  edgeGeos.push(at(new THREE.BoxGeometry(0.05, 0.05, cab.l * 1.8), 0, cab.y + cab.h + 0.02, cab.z));
  const edges = new THREE.Mesh(
    mergeGeometries(edgeGeos.map((g) => (g.index ? g.toNonIndexed() : g)), false), edgeMat
  );
  group.add(edges);

  // ── steampunk pipework ── (merged into the trim mesh below)
  const pipeGeos = [];
  {
    for (const sx of [-1, 1]) {
      pipeGeos.push(at(new THREE.CylinderGeometry(0.075, 0.075, bd.l * 1.25, 8),
        sx * (bd.w + 0.09), -bd.h * 0.1, -bd.l * 0.1, [Math.PI / 2, 0, 0]));
    }
    for (let i = -3; i <= 3; i++) {
      pipeGeos.push(at(new THREE.SphereGeometry(0.045, 6, 5),
        i * (bd.w * 0.26), bd.h + 0.02, bd.l * 0.55));
    }
    for (const sx of [-1, 1]) {
      pipeGeos.push(at(new THREE.CylinderGeometry(0.11, 0.13, 0.34, 10),
        sx * bd.w * 0.5, -bd.h * 0.5, -bd.l - 0.14, [Math.PI / 2, 0, 0]));
    }
    const merged = mergeGeometries(pipeGeos.map((g) => (g.index ? g.toNonIndexed() : g)), false);
    if (merged) {
      const m = new THREE.Mesh(merged, trimMat);
      m.castShadow = true;
      group.add(m);
    }
  }

  // ── wheels ──
  const wheelWidth = bd.exposedWheels ? type.phys.wheelRadius * 0.75 : type.phys.wheelRadius * 0.58;
  const wheels = [];
  for (let i = 0; i < 4; i++) {
    const w = buildWheel(type.phys.wheelRadius, wheelWidth, wheelItem);
    wheels.push(w);
    group.add(w);
  }

  return {
    group,
    shellMesh,
    wheels,
    accessories,
    underglow,
    paintHex,
    edges,
    glassMesh,
    scrap,
    weaponRig,
    wearSeed,
    materials: { shellMat, trimMat, headMat, tailMat, glowMat, edgeMat, rustMat },

    dispose() {
      group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
          else o.material.dispose();
        }
      });
    },
  };
}

/** A slowly rotating preview car for the menu and the garage. */
export function buildPreviewRig(type, loadout) {
  const car = buildCar(type, loadout);
  car.group.position.y = type.body.ride;
  const w = type.body;
  const pos = [
    [-w.track, 0, w.front], [w.track, 0, w.front],
    [-w.track, 0, w.rear], [w.track, 0, w.rear],
  ];
  car.wheels.forEach((wheel, i) => {
    wheel.position.set(pos[i][0], -type.body.ride + type.phys.wheelRadius, pos[i][2]);
  });
  return car;
}
