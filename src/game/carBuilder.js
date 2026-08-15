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
import { getItem } from './cosmetics.js';

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

function buildShell(type, paint) {
  const bd = type.body;
  const cab = bd.cabin;
  const parts = [];
  const P = (g, hex) => parts.push(tint(g, hex));

  switch (bd.style) {
    case 'muscle': {
      P(at(box(bd.w * 2, bd.h * 2, bd.l * 2, 0.16, 4), 0, 0, 0), paint);
      // raised rear haunches
      P(at(box(bd.w * 2.02, bd.h * 1.5, bd.l * 0.7, 0.14), 0, bd.h * 0.5, -bd.l * 0.55), paint);
      // cabin + glasshouse
      P(at(box(cab.w * 2, cab.h * 2, cab.l * 2, 0.14, 4), 0, cab.y, cab.z), paint);
      P(at(box(cab.w * 1.86, cab.h * 1.2, cab.l * 1.7, 0.06), 0, cab.y + 0.06, cab.z), GLASS);
      // bonnet scoop
      if (bd.hoodScoop) P(at(box(0.5, 0.17, 0.7, 0.05), 0, bd.h + 0.06, bd.l * 0.42), TRIM);
      // splitter
      P(at(box(bd.w * 2.05, 0.09, 0.42, 0.03), 0, -bd.h * 0.75, bd.l * 0.96), TRIM);
      break;
    }
    case 'buggy': {
      P(at(box(bd.w * 1.5, bd.h * 2, bd.l * 2, 0.14, 4), 0, 0, 0), paint);
      P(at(box(cab.w * 2, cab.h * 2, cab.l * 2, 0.12, 3), 0, cab.y, cab.z), paint);
      P(at(box(cab.w * 1.8, cab.h * 1.1, cab.l * 1.6, 0.05), 0, cab.y + 0.05, cab.z), GLASS);
      // exposed tube roll cage
      if (bd.rollCage) {
        const tube = (x1, y1, z1, x2, y2, z2) => {
          const a = new THREE.Vector3(x1, y1, z1), b2 = new THREE.Vector3(x2, y2, z2);
          const len = a.distanceTo(b2);
          const g = new THREE.CylinderGeometry(0.055, 0.055, len, 6);
          const mid = a.clone().add(b2).multiplyScalar(0.5);
          const dir = b2.clone().sub(a).normalize();
          const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
          g.applyQuaternion(q); g.translate(mid.x, mid.y, mid.z);
          P(g, TRIM);
        };
        const hx = bd.w * 0.78, hy = cab.y + cab.h + 0.16, hz = cab.z;
        tube(-hx, 0.1, hz + 0.5, -hx, hy, hz - 0.1);
        tube(hx, 0.1, hz + 0.5, hx, hy, hz - 0.1);
        tube(-hx, hy, hz - 0.1, hx, hy, hz - 0.1);
        tube(-hx, hy, hz - 0.1, -hx, 0.0, hz - 0.95);
        tube(hx, hy, hz - 0.1, hx, 0.0, hz - 0.95);
      }
      // nose cone
      P(at(box(bd.w * 1.1, bd.h * 1.1, 0.5, 0.12), 0, -0.02, bd.l * 0.98), paint);
      break;
    }
    case 'truck': {
      P(at(box(bd.w * 2, bd.h * 2, bd.l * 2, 0.14, 4), 0, 0, 0), paint);
      // tall cab
      P(at(box(cab.w * 2, cab.h * 2, cab.l * 2, 0.13, 4), 0, cab.y, cab.z), paint);
      P(at(box(cab.w * 1.84, cab.h * 1.15, cab.l * 1.75, 0.05), 0, cab.y + 0.08, cab.z), GLASS);
      // flat bed at the back
      P(at(box(bd.w * 1.94, 0.16, bd.l * 0.85, 0.05), 0, bd.h * 0.9, -bd.l * 0.5), TRIM);
      for (const s of [-1, 1]) {
        P(at(box(0.1, 0.34, bd.l * 0.85, 0.04), s * bd.w * 0.94, bd.h * 1.15, -bd.l * 0.5), paint);
      }
      // exhaust stacks
      for (const s of [-1, 1]) {
        P(at(new THREE.CylinderGeometry(0.09, 0.09, 1.1, 8), s * bd.w * 0.8, bd.h + 0.55, cab.z - cab.l), TRIM);
      }
      break;
    }
    default: { // 'hyper'
      P(at(box(bd.w * 2, bd.h * 2, bd.l * 2, 0.18, 4), 0, 0, 0), paint);
      // low wedge nose
      P(at(box(bd.w * 1.7, bd.h * 1.1, bd.l * 0.55, 0.12), 0, -bd.h * 0.3, bd.l * 0.92), paint);
      P(at(box(cab.w * 2, cab.h * 2, cab.l * 2, 0.16, 4), 0, cab.y, cab.z), GLASS);
      // side pods
      for (const s of [-1, 1]) {
        P(at(box(0.2, bd.h * 1.2, bd.l * 0.9, 0.06), s * bd.w * 1.02, -0.02, -bd.l * 0.1), TRIM);
      }
      if (bd.lowWing) P(at(box(bd.w * 1.9, 0.07, 0.36, 0.03), 0, bd.h * 0.9, -bd.l * 1.0), TRIM);
      break;
    }
  }

  // headlights + tail lights (kept dark in vertex colour; the emissive layer
  // is a separate mesh so damage does not make the lights glow)
  return parts;
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
export function buildCar(type, loadout, teamColor = null) {
  const bd = type.body;
  const group = new THREE.Group();

  const paintItem = getItem('paint', loadout.paint);
  const finish = getItem('finish', loadout.finish);
  const liveryItem = getItem('livery', loadout.livery);
  const wheelItem = getItem('wheels', loadout.wheels);
  const glowItem = getItem('underglow', loadout.underglow);

  let paintHex = finish.forceColor ?? paintItem.color ?? type.color;
  if (teamColor !== null) paintHex = teamColor;

  // ── shell ──
  const shellParts = buildShell(type, paintHex);
  // RoundedBoxGeometry is non-indexed while Cylinder/Cone are indexed; merging
  // a mix of the two silently returns null. Normalise first.
  const flatParts = shellParts.map((g) => (g.index ? g.toNonIndexed() : g));
  let shell = mergeGeometries(flatParts, false);
  if (!shell) throw new Error(`car shell merge failed for "${type.id}"`);
  shell = mergeVertices(shell, 1e-3);      // weld so crumpling stays continuous
  shell.computeVertexNormals();
  paintLivery(shell, liveryItem.pattern, bd, ACCENTS[liveryItem.pattern] || 0xffffff);

  const shellMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: finish.rough ?? 0.3,
    metalness: finish.metal ?? 0.3,
    emissive: finish.emissive ? new THREE.Color(paintHex) : 0x000000,
    emissiveIntensity: finish.emissive ?? 0,
    flatShading: false,
  });
  const shellMesh = new THREE.Mesh(shell, shellMat);
  shellMesh.castShadow = true;
  shellMesh.receiveShadow = true;
  group.add(shellMesh);

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
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.45, metalness: 0.75 });
  const glowMat = new THREE.MeshStandardMaterial({
    color: 0x22e0ff, emissive: 0x22e0ff, emissiveIntensity: 2.2, roughness: 0.3,
  });
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
    materials: { shellMat, trimMat, headMat, tailMat, glowMat },

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
