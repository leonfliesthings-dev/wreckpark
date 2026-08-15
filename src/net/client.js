/**
 * WebSocket client. Owns the connection, the outgoing state rate, and the
 * interpolation buffer for everyone else's cars.
 */
import { C2S, S2C, PHASE, SNAPSHOT_HZ, packState, normalizeCode } from './protocol.js';

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

/** Render remote cars this far in the past, so there is always a pair to lerp between. */
const INTERP_DELAY = 0.11;
const BUFFER_KEEP = 1.2;

function socketURL() {
  const loc = window.location;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  // `npm run dev` serves the client from Vite on 5173 while the game server
  // sits on 8080; anywhere else the two share an origin.
  const port = loc.port === '5173' ? '8080' : loc.port;
  const host = port ? `${loc.hostname}:${port}` : loc.hostname;
  return `${proto}//${host}/ws`;
}

export class NetClient {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.id = null;
    this.room = null;
    this.isHost = false;

    this.players = new Map();   // id -> { id, name, car, loadout, slot, score, ... }
    this.buffers = new Map();   // id -> [{ t, p, q, v, f, h }]
    this.match = { mode: 'derby', phase: PHASE.LOBBY, left: 0, round: 0 };

    this.handlers = {};         // event -> fn[]
    this._sendAcc = 0;
    this._offset = 0;           // local clock -> server-ish time
    this.ping = 0;
    this._pingSent = 0;
    this.lastError = null;
  }

  on(event, fn) {
    (this.handlers[event] ||= []).push(fn);
    return this;
  }

  emit(event, payload) {
    for (const fn of this.handlers[event] || []) fn(payload);
  }

  // ── connection ───────────────────────────────────────────────
  connect({ room, name, car, loadout }) {
    this.disconnect();
    this.lastError = null;
    const url = socketURL();
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.emit('error', `Could not open a connection: ${err.message}`);
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      ws.send(JSON.stringify({
        t: C2S.JOIN,
        room: normalizeCode(room),
        name, car, loadout,
      }));
      this._pingSent = performance.now();
      ws.send(JSON.stringify({ t: C2S.PING, c: this._pingSent }));
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      this._handle(msg);
    };

    ws.onerror = () => {
      this.emit('error',
        'Could not reach the game server. Is it running? (npm start)');
    };

    ws.onclose = () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.ws = null;
      this.players.clear();
      this.buffers.clear();
      if (wasConnected) this.emit('disconnected');
    };
  }

  disconnect() {
    if (this.ws) {
      this.ws.onclose = null;
      try { this.ws.close(); } catch { /* already gone */ }
    }
    this.ws = null;
    this.connected = false;
    this.id = null;
    this.room = null;
    this.players.clear();
    this.buffers.clear();
  }

  get online() { return this.connected && this.id !== null; }

  _send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  // ── inbound ──────────────────────────────────────────────────
  _handle(msg) {
    switch (msg.t) {
      case S2C.WELCOME:
        this.id = msg.id;
        this.room = msg.room;
        this.isHost = msg.host;
        this.players.clear();
        for (const p of msg.players) this.players.set(p.id, p);
        this.match = { mode: msg.mode, phase: msg.phase, left: msg.left, round: 0 };
        this.emit('welcome', msg);
        break;

      case S2C.JOINED:
        this.players.set(msg.p.id, msg.p);
        this.emit('playerJoined', msg.p);
        break;

      case S2C.LEFT:
        this.players.delete(msg.id);
        this.buffers.delete(msg.id);
        this.emit('playerLeft', msg.id);
        break;

      case S2C.SNAP: {
        const now = performance.now() / 1000;
        for (const s of msg.s) {
          if (s.id === this.id) continue;
          let buf = this.buffers.get(s.id);
          if (!buf) { buf = []; this.buffers.set(s.id, buf); }
          buf.push({ t: now, p: s.p, q: s.q, v: s.v, f: s.f, h: s.h });
          while (buf.length > 2 && now - buf[0].t > BUFFER_KEEP) buf.shift();
        }
        break;
      }

      case S2C.MATCH: {
        const prevPhase = this.match.phase;
        this.match = { mode: msg.mode, phase: msg.phase, left: msg.left, round: msg.round };
        if (msg.phase !== prevPhase) this.emit('phase', { phase: msg.phase, prev: prevPhase, match: this.match });
        break;
      }

      case S2C.SCORES:
        for (const s of msg.s) {
          const p = this.players.get(s.id);
          if (p) Object.assign(p, s);
        }
        this.emit('scores', this.players);
        break;

      case S2C.EVENT:
        this.emit('gameEvent', msg);
        break;

      case S2C.CHAT:
        this.emit('chat', msg);
        break;

      case S2C.ERROR:
        this.lastError = msg.msg;
        this.emit('error', msg.msg);
        break;

      case S2C.FIRE:
        this.emit('fire', msg);
        break;

      case S2C.DEPLOY:
        this.emit('deploy', msg);
        break;

      case S2C.PONG:
        this.ping = Math.round(performance.now() - msg.c);
        setTimeout(() => {
          this._pingSent = performance.now();
          this._send({ t: C2S.PING, c: this._pingSent });
        }, 2000);
        break;
    }
  }

  // ── outbound ─────────────────────────────────────────────────
  /** Rate-limited transform upload. Call every frame; it sends at SNAPSHOT_HZ. */
  pushState(dt, car) {
    if (!this.online) return;
    this._sendAcc += dt;
    const interval = 1 / SNAPSHOT_HZ;
    if (this._sendAcc < interval) return;
    this._sendAcc = 0;
    this._send({ t: C2S.STATE, ...packState(car) });
  }

  setReady(v) { this._send({ t: C2S.READY, ready: v }); }
  setMode(mode) { this._send({ t: C2S.MODE, mode }); }
  reportWrecked(byId) { this._send({ t: C2S.WRECKED, by: byId }); }
  reportTrick(points, label) { this._send({ t: C2S.TRICK, points, label }); }
  reportRespawn() { this._send({ t: C2S.RESPAWN }); }
  chat(text) { this._send({ t: C2S.CHAT, text }); }

  reportFire(weaponId, origin, dir) {
    this._send({
      t: C2S.FIRE, w: weaponId,
      o: [r2(origin.x), r2(origin.y), r2(origin.z)],
      d: [r3(dir.x), r3(dir.y), r3(dir.z)],
    });
  }

  reportDeploy(counterId, pos) {
    this._send({ t: C2S.DEPLOY, c: counterId, p: [r2(pos.x), r2(pos.y), r2(pos.z)] });
  }

  // ── interpolation ────────────────────────────────────────────
  /**
   * Returns the interpolated pose for a remote player, or null if we have not
   * heard enough from them yet.
   */
  sample(id, out) {
    const buf = this.buffers.get(id);
    if (!buf || buf.length === 0) return null;
    const target = performance.now() / 1000 - INTERP_DELAY;

    if (buf.length === 1 || target <= buf[0].t) {
      const s = buf[0];
      out.px = s.p[0]; out.py = s.p[1]; out.pz = s.p[2];
      out.qx = s.q[0]; out.qy = s.q[1]; out.qz = s.q[2]; out.qw = s.q[3];
      out.vx = s.v[0]; out.vy = s.v[1]; out.vz = s.v[2];
      out.f = s.f; out.h = s.h;
      return out;
    }

    let a = buf[0], b = buf[buf.length - 1];
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i].t <= target && buf[i + 1].t >= target) { a = buf[i]; b = buf[i + 1]; break; }
    }

    if (target > b.t) {
      // Ran dry — extrapolate briefly from the last known velocity rather than
      // freezing the car mid-air, but cap it so a dropout cannot fling them
      // across the arena.
      const ahead = Math.min(target - b.t, 0.25);
      out.px = b.p[0] + b.v[0] * ahead;
      out.py = b.p[1] + b.v[1] * ahead;
      out.pz = b.p[2] + b.v[2] * ahead;
      out.qx = b.q[0]; out.qy = b.q[1]; out.qz = b.q[2]; out.qw = b.q[3];
      out.vx = b.v[0]; out.vy = b.v[1]; out.vz = b.v[2];
      out.f = b.f; out.h = b.h;
      return out;
    }

    const span = b.t - a.t;
    const k = span > 1e-5 ? (target - a.t) / span : 0;
    out.px = a.p[0] + (b.p[0] - a.p[0]) * k;
    out.py = a.p[1] + (b.p[1] - a.p[1]) * k;
    out.pz = a.p[2] + (b.p[2] - a.p[2]) * k;

    // shortest-arc quaternion lerp, normalised
    let ax = a.q[0], ay = a.q[1], az = a.q[2], aw = a.q[3];
    const bx = b.q[0], by = b.q[1], bz = b.q[2], bw = b.q[3];
    if (ax * bx + ay * by + az * bz + aw * bw < 0) { ax = -ax; ay = -ay; az = -az; aw = -aw; }
    let qx = ax + (bx - ax) * k, qy = ay + (by - ay) * k;
    let qz = az + (bz - az) * k, qw = aw + (bw - aw) * k;
    const len = Math.hypot(qx, qy, qz, qw) || 1;
    out.qx = qx / len; out.qy = qy / len; out.qz = qz / len; out.qw = qw / len;

    out.vx = b.v[0]; out.vy = b.v[1]; out.vz = b.v[2];
    out.f = b.f; out.h = b.h;
    return out;
  }
}

export function makeSampleOut() {
  return {
    px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1,
    vx: 0, vy: 0, vz: 0, f: 0, h: 100,
  };
}
