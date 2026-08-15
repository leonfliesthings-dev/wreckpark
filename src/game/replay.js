/**
 * Run recording and playback.
 *
 * A three-minute run at 30 Hz is 5,400 frames, so storing it as JSON numbers
 * would be a few hundred KB of text. Instead each frame is quantised into
 * seven int16s (position to the centimetre, quaternion to ~1/32767) plus one
 * flags byte, then base64'd — about 100 KB for a full run, which sits
 * comfortably inside a localStorage quota.
 */

export const REPLAY_HZ = 30;
export const REPLAY_VERSION = 1;

const BYTES_PER_FRAME = 7 * 2 + 1;   // 7 int16 + 1 flag byte
const POS_SCALE = 100;               // centimetres
const QUAT_SCALE = 32767;

export const RFLAG = { BOOST: 1, AIRBORNE: 2, DEAD: 4 };

// ─────────────────────────────────────────────────────────────
function bytesToBase64(bytes) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ─────────────────────────────────────────────────────────────
export class ReplayRecorder {
  constructor({ car, loadout, mode }) {
    this.meta = { car, loadout, mode };
    this.frames = [];      // flat array of quantised values
    this.flags = [];
    this.events = [];      // { f, label, points }
    this.acc = 0;
    this.recording = true;
  }

  /** Call every rendered frame; it samples at REPLAY_HZ. */
  sample(dt, vehicle) {
    if (!this.recording || !vehicle) return;
    this.acc += dt;
    const step = 1 / REPLAY_HZ;
    if (this.acc < step) return;
    // never bank more than a couple of frames if the tab stalls
    this.acc = Math.min(this.acc - step, step * 2);

    const p = vehicle.position;
    const q = vehicle.rotation;
    this.frames.push(
      clampInt16(p.x * POS_SCALE), clampInt16(p.y * POS_SCALE), clampInt16(p.z * POS_SCALE),
      clampInt16(q.x * QUAT_SCALE), clampInt16(q.y * QUAT_SCALE),
      clampInt16(q.z * QUAT_SCALE), clampInt16(q.w * QUAT_SCALE)
    );
    this.flags.push(
      (vehicle.boosting ? RFLAG.BOOST : 0) |
      (vehicle.airborne ? RFLAG.AIRBORNE : 0) |
      (vehicle.alive ? 0 : RFLAG.DEAD)
    );
  }

  /** Records a banked combo so the replay can pop the same numbers up. */
  addEvent(label, points) {
    this.events.push({ f: this.frameCount, label: String(label).slice(0, 40), points });
  }

  get frameCount() { return this.flags.length; }
  get seconds() { return this.frameCount / REPLAY_HZ; }

  /** Produces the storable object. */
  finish(score) {
    this.recording = false;
    const n = this.frameCount;
    const buf = new Uint8Array(n * BYTES_PER_FRAME);
    const view = new DataView(buf.buffer);
    for (let i = 0; i < n; i++) {
      const o = i * BYTES_PER_FRAME;
      for (let k = 0; k < 7; k++) view.setInt16(o + k * 2, this.frames[i * 7 + k], true);
      buf[o + 14] = this.flags[i];
    }
    return {
      v: REPLAY_VERSION,
      hz: REPLAY_HZ,
      frames: n,
      score,
      car: this.meta.car,
      loadout: this.meta.loadout,
      mode: this.meta.mode,
      date: new Date().toISOString(),
      events: this.events,
      data: bytesToBase64(buf),
    };
  }
}

function clampInt16(v) {
  v = Math.round(v);
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

// ─────────────────────────────────────────────────────────────
/**
 * Plays a recording back. Exposes the same surface the chase camera and the
 * car renderer expect from a live Vehicle, so nothing downstream has to know
 * it is watching a replay.
 */
export class ReplayPlayer {
  constructor(rec) {
    this.rec = rec;
    this.n = rec.frames;
    this.hz = rec.hz || REPLAY_HZ;
    this.duration = this.n / this.hz;
    this.time = 0;
    this.finished = this.n === 0;
    this.speedScale = 1;

    const bytes = base64ToBytes(rec.data);
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.bytes = bytes;

    this.position = { x: 0, y: 0, z: 0 };
    this.rotation = { x: 0, y: 0, z: 0, w: 1 };
    this.velocity = { x: 0, y: 0, z: 0 };
    this.speed = 0;
    this.absSpeed = 0;
    this.airborne = false;
    this.boosting = false;
    this.alive = true;
    this.slip = 0;
    this.wheelsOnGround = 4;

    this._nextEvent = 0;
    this.onEvent = null;      // (label, points) => void

    if (this.n > 0) this._apply(0, 0);
  }

  _frame(i, out) {
    const o = i * BYTES_PER_FRAME;
    out.px = this.view.getInt16(o, true) / POS_SCALE;
    out.py = this.view.getInt16(o + 2, true) / POS_SCALE;
    out.pz = this.view.getInt16(o + 4, true) / POS_SCALE;
    out.qx = this.view.getInt16(o + 6, true) / QUAT_SCALE;
    out.qy = this.view.getInt16(o + 8, true) / QUAT_SCALE;
    out.qz = this.view.getInt16(o + 10, true) / QUAT_SCALE;
    out.qw = this.view.getInt16(o + 12, true) / QUAT_SCALE;
    out.flags = this.bytes[o + 14];
    return out;
  }

  _apply(index, frac) {
    const a = this._frame(Math.min(index, this.n - 1), _fa);
    const b = this._frame(Math.min(index + 1, this.n - 1), _fb);

    this.position.x = a.px + (b.px - a.px) * frac;
    this.position.y = a.py + (b.py - a.py) * frac;
    this.position.z = a.pz + (b.pz - a.pz) * frac;

    let ax = a.qx, ay = a.qy, az = a.qz, aw = a.qw;
    if (ax * b.qx + ay * b.qy + az * b.qz + aw * b.qw < 0) { ax = -ax; ay = -ay; az = -az; aw = -aw; }
    let qx = ax + (b.qx - ax) * frac, qy = ay + (b.qy - ay) * frac;
    let qz = az + (b.qz - az) * frac, qw = aw + (b.qw - aw) * frac;
    const len = Math.hypot(qx, qy, qz, qw) || 1;
    this.rotation.x = qx / len; this.rotation.y = qy / len;
    this.rotation.z = qz / len; this.rotation.w = qw / len;

    // velocity from the frame delta, so the chase camera behaves normally
    const dt = 1 / this.hz;
    this.velocity.x = (b.px - a.px) / dt;
    this.velocity.y = (b.py - a.py) / dt;
    this.velocity.z = (b.pz - a.pz) / dt;
    this.absSpeed = Math.hypot(this.velocity.x, this.velocity.y, this.velocity.z);

    // signed forward speed
    const q = this.rotation;
    const fx = 2 * (q.x * q.z + q.w * q.y);
    const fy = 2 * (q.y * q.z - q.w * q.x);
    const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    this.speed = this.velocity.x * fx + this.velocity.y * fy + this.velocity.z * fz;

    this.boosting = !!(a.flags & RFLAG.BOOST);
    this.airborne = !!(a.flags & RFLAG.AIRBORNE);
    this.alive = !(a.flags & RFLAG.DEAD);
    this.wheelsOnGround = this.airborne ? 0 : 4;
  }

  update(dt) {
    if (this.finished) return;
    this.time += dt * this.speedScale;
    const f = this.time * this.hz;
    const index = Math.floor(f);
    if (index >= this.n - 1) {
      this._apply(this.n - 1, 0);
      this.finished = true;
      return;
    }
    this._apply(index, f - index);

    const events = this.rec.events || [];
    while (this._nextEvent < events.length && events[this._nextEvent].f <= index) {
      const e = events[this._nextEvent++];
      if (this.onEvent) this.onEvent(e.label, e.points);
    }
  }

  seek(seconds) {
    this.time = Math.max(0, Math.min(seconds, this.duration));
    this.finished = false;
    this._nextEvent = 0;
    const events = this.rec.events || [];
    const idx = Math.floor(this.time * this.hz);
    while (this._nextEvent < events.length && events[this._nextEvent].f <= idx) this._nextEvent++;
    this._apply(Math.min(idx, this.n - 1), 0);
  }

  restart() { this.seek(0); }

  /** Rough size of the stored recording, for the UI. */
  static sizeKB(rec) {
    return Math.round((rec.data?.length || 0) * 0.75 / 1024);
  }
}

const _fa = {};
const _fb = {};
