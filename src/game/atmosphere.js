/**
 * Atmosphere: rain, neon signage, steam and the wet-tarmac look.
 *
 * The target is dirty sci-fi — Blade Runner's perpetual wet night, with Tron's
 * hard neon edges and a steampunk layer of brass and pipework on top of the
 * concrete. All procedural: noise textures are painted into canvases at boot.
 */
import * as THREE from 'three';
import { rand, makeRng } from '../core/util.js';

/**
 * Textures are painted into canvases, which needs a DOM. The headless physics
 * tests run the same arena code in plain Node, where there isn't one — they do
 * not care what anything looks like, so hand back null and let the materials
 * render untextured.
 */
const HAS_DOM = typeof document !== 'undefined' && !!document.createElement;

// ─────────────────────────────────────────────────────────────
// procedural textures
// ─────────────────────────────────────────────────────────────

/**
 * Puddles. Low values read as smooth standing water, high as dry grit, so this
 * goes straight into a roughnessMap and the ground stops looking like lino.
 */
export function makePuddleTexture(size = 512, seed = 7) {
  if (!HAS_DOM) return null;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const rng = makeRng(seed);

  ctx.fillStyle = '#c4c4c4';           // mostly dry
  ctx.fillRect(0, 0, size, size);

  // Two octaves of soft blobs. A single size reads as a regular dot pattern
  // once the texture tiles across a 200 m floor.
  for (const [n, lo, hi, alpha] of [[14, 90, 190, 0.85], [46, 26, 90, 0.55]]) {
    for (let i = 0; i < n; i++) {
      const x = rng() * size, y = rng() * size;
      const r = lo + rng() * (hi - lo);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(58,58,58,${alpha})`);
      g.addColorStop(0.65, `rgba(96,96,96,${alpha * 0.5})`);
      g.addColorStop(1, 'rgba(196,196,196,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
  }
  // fine grit so dry areas are not flat
  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rng() - 0.5) * 26;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 6);
  return tex;
}

/** Grime and staining for the concrete. */
export function makeGrimeTexture(size = 512, seed = 19) {
  if (!HAS_DOM) return null;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const rng = makeRng(seed);

  ctx.fillStyle = '#9a9a9a';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 160; i++) {
    const x = rng() * size, y = rng() * size;
    const r = 8 + rng() * 90;
    const dark = rng() > 0.35;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, dark ? 'rgba(70,64,58,0.5)' : 'rgba(190,185,175,0.35)');
    g.addColorStop(1, 'rgba(154,154,154,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  // rust streaks running down
  for (let i = 0; i < 40; i++) {
    const x = rng() * size;
    const w = 2 + rng() * 7;
    const h = 40 + rng() * 200;
    const g = ctx.createLinearGradient(0, rng() * size, 0, rng() * size + h);
    g.addColorStop(0, 'rgba(120,70,35,0.30)');
    g.addColorStop(1, 'rgba(120,70,35,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, rng() * size, w, h);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(10, 10);
  return tex;
}

/** Diagonal hazard striping — the one thing that stops a pillar looking like a toy. */
export function makeHazardTexture(size = 256) {
  if (!HAS_DOM) return null;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0e0f12';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = '#c9a233';
  ctx.lineWidth = size / 7;
  ctx.beginPath();
  for (let i = -size; i < size * 2; i += size / 3.5) {
    ctx.moveTo(i, 0);
    ctx.lineTo(i + size, size);
  }
  ctx.stroke();
  // wear
  const rng = makeRng(5);
  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rng() - 0.5) * 46;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 3);
  return tex;
}

// ─────────────────────────────────────────────────────────────
// rain
// ─────────────────────────────────────────────────────────────
const RAIN_VERT = `
  attribute float len;
  attribute float speed;
  varying float vFade;
  uniform float uTime;
  uniform vec3 uCam;
  uniform float uBox;
  void main() {
    vec3 p = position;
    // fall, and wrap around a box that follows the camera
    p.y = mod(p.y - uTime * speed, uBox);
    vec3 world = vec3(
      mod(p.x - uCam.x + uBox * 0.5, uBox) + uCam.x - uBox * 0.5,
      p.y + uCam.y - uBox * 0.35,
      mod(p.z - uCam.z + uBox * 0.5, uBox) + uCam.z - uBox * 0.5
    );
    vec4 mv = modelViewMatrix * vec4(world, 1.0);
    vFade = clamp(1.0 - (-mv.z) / 140.0, 0.0, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = len * 260.0 / max(1.0, -mv.z);
  }`;

const RAIN_FRAG = `
  varying float vFade;
  uniform vec3 uColor;
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    // a vertical streak rather than a dot
    float a = smoothstep(0.5, 0.0, abs(d.x) * 6.0) * smoothstep(0.5, 0.0, abs(d.y));
    gl_FragColor = vec4(uColor, a * vFade * 0.55);
  }`;

export class Rain {
  constructor(scene, { count = 3500, box = 120, color = 0x9fc7ff } = {}) {
    const pos = new Float32Array(count * 3);
    const len = new Float32Array(count);
    const speed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = rand(0, box);
      pos[i * 3 + 1] = rand(0, box);
      pos[i * 3 + 2] = rand(0, box);
      len[i] = rand(0.5, 1.6);
      speed[i] = rand(38, 62);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('len', new THREE.BufferAttribute(len, 1));
    geo.setAttribute('speed', new THREE.BufferAttribute(speed, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    this.mat = new THREE.ShaderMaterial({
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uCam: { value: new THREE.Vector3() },
        uBox: { value: box },
        uColor: { value: new THREE.Color(color) },
      },
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    scene.add(this.points);
    this.scene = scene;
  }

  update(dt, camera) {
    this.mat.uniforms.uTime.value += dt;
    this.mat.uniforms.uCam.value.copy(camera.position);
  }

  setIntensity(v) { this.points.visible = v > 0; }

  dispose() {
    this.scene.remove(this.points);
    this.points.geometry.dispose();
    this.mat.dispose();
  }
}

// ─────────────────────────────────────────────────────────────
// neon signage
// ─────────────────────────────────────────────────────────────
const SIGN_COLORS = [0xff2d78, 0x22e0ff, 0xffb020, 0x9b4bff, 0x2dff9b, 0xff4422];

/**
 * Glowing hoardings around the bowl. Painted into canvases so they read as
 * signage rather than plain rectangles, and given a flicker so the place feels
 * like it has bad wiring.
 */
export function buildSignage(scene, { radius = 122, height = 21, count = 22, rng = makeRng(31) } = {}) {
  const signs = [];
  if (!HAS_DOM) return { signs, update() {}, dispose() {} };
  const glyphs = ['SHINKO', 'DENKI', 'RAMEN', 'MOTORS', 'FUEL', 'NEO-KOBE', '24H', 'SCRAP',
    'TYRE', 'OIL', 'ARCADE', 'NOODLE', 'GARAGE', 'VOLTAGE', 'BAR', 'HOTEL'];

  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rng() * 0.1;
    const color = SIGN_COLORS[Math.floor(rng() * SIGN_COLORS.length)];
    const vertical = rng() > 0.55;
    const text = glyphs[Math.floor(rng() * glyphs.length)];

    const c = document.createElement('canvas');
    c.width = vertical ? 128 : 512;
    c.height = vertical ? 512 : 128;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);

    // border
    ctx.strokeStyle = '#' + color.toString(16).padStart(6, '0');
    ctx.lineWidth = 8;
    ctx.strokeRect(10, 10, c.width - 20, c.height - 20);

    ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (vertical) {
      ctx.font = 'bold 62px ui-sans-serif, system-ui, sans-serif';
      const chars = text.slice(0, 6).split('');
      chars.forEach((ch, k) => {
        ctx.fillText(ch, c.width / 2, 70 + k * (c.height - 140) / Math.max(1, chars.length - 1));
      });
    } else {
      ctx.font = 'bold 84px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(text, c.width / 2, c.height / 2);
    }

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });

    const w = vertical ? 4 : 12;
    const h = vertical ? 14 : 4;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    const r = radius - rand(0, 3);
    mesh.position.set(Math.cos(a) * r, height + rng() * 8 - 2, Math.sin(a) * r);
    mesh.lookAt(0, mesh.position.y, 0);
    scene.add(mesh);

    // a light so the sign spills colour onto the concrete near it
    let light = null;
    if (i % 3 === 0) {
      light = new THREE.PointLight(color, 220, 60, 2);
      light.position.set(Math.cos(a) * (r - 6), mesh.position.y - 4, Math.sin(a) * (r - 6));
      scene.add(light);
    }

    signs.push({
      mesh, light, mat, base: 1,
      flicker: rng() > 0.75 ? rand(3, 9) : 0,
      phase: rng() * 10,
    });
  }

  return {
    signs,
    update(t) {
      for (const s of signs) {
        let k = 1;
        if (s.flicker) {
          const n = Math.sin(t * s.flicker + s.phase) * Math.sin(t * s.flicker * 2.3 + s.phase);
          k = n > -0.75 ? 1 : 0.15;
        } else {
          k = 0.86 + Math.sin(t * 1.7 + s.phase) * 0.14;
        }
        s.mat.opacity = k;
        if (s.light) s.light.intensity = 220 * k;
      }
    },
    dispose() {
      for (const s of signs) {
        scene.remove(s.mesh);
        if (s.light) scene.remove(s.light);
        s.mesh.geometry.dispose();
        s.mat.map.dispose();
        s.mat.dispose();
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────
// steam vents
// ─────────────────────────────────────────────────────────────
export function buildVents(fx, spots) {
  let acc = 0;
  return {
    update(dt) {
      acc += dt;
      if (acc < 0.09) return;
      acc = 0;
      for (const [x, y, z] of spots) {
        if (Math.random() > 0.5) continue;
        fx.steam(x + rand(-0.6, 0.6), y, z + rand(-0.6, 0.6));
      }
    },
  };
}
