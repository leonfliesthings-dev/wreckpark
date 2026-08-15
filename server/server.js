/**
 * WRECKPARK game server.
 *
 * Serves the built client AND runs the room/match logic on one port, so
 * inviting a mate is a single URL. Physics stays on the clients; the server
 * relays transforms and is the sole authority on match phase and the
 * scoreboard, so nobody can argue about who won.
 */
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import express from 'express';
import { WebSocketServer } from 'ws';
import {
  C2S, S2C, PHASE, MODES, MAX_PLAYERS, SNAPSHOT_HZ, PROTOCOL_VERSION,
  makeRoomCode, normalizeCode, sanitizeName,
} from '../src/net/protocol.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
// Shorten rounds for testing, or for a quick blast: WRECKPARK_ROUND=60
const ROUND_OVERRIDE = process.env.WRECKPARK_ROUND ? Number(process.env.WRECKPARK_ROUND) : null;

// ───────────────────────────── http ─────────────────────────────
const app = express();
const DIST = join(ROOT, 'dist');

if (existsSync(DIST)) {
  app.use(express.static(DIST, { maxAge: '1h', index: 'index.html' }));
} else {
  app.get('/', (_req, res) => {
    res.status(503).type('html').send(`
      <body style="font-family:ui-sans-serif,system-ui;background:#07080b;color:#e9edf4;padding:60px;line-height:1.6">
      <h1 style="color:#ff6a1f">WRECKPARK</h1>
      <p>The client has not been built yet. Run:</p>
      <pre style="background:#11141b;padding:16px;border-radius:8px">npm run build</pre>
      <p>...then restart the server. For development, run <code>npm run dev</code>
      and open <a style="color:#22e0ff" href="http://localhost:5173">localhost:5173</a> instead.</p>
      </body>`);
  });
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    protocol: PROTOCOL_VERSION,
    rooms: rooms.size,
    players: [...rooms.values()].reduce((n, r) => n + r.players.size, 0),
    uptime: Math.round(process.uptime()),
  });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ───────────────────────────── rooms ─────────────────────────────
const rooms = new Map();
let nextId = 1;

function createRoom(code) {
  const room = {
    code,
    players: new Map(),
    hostId: null,
    mode: 'derby',
    phase: PHASE.LOBBY,
    phaseEnds: 0,
    roundNum: 0,
    lastActivity: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function freshRoomCode() {
  for (let i = 0; i < 200; i++) {
    const c = makeRoomCode();
    if (!rooms.has(c)) return c;
  }
  return makeRoomCode() + Date.now().toString(36).slice(-2);
}

function send(ws, type, data) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({ t: type, ...data }));
}

function broadcast(room, type, data, exceptId = null) {
  const msg = JSON.stringify({ t: type, ...data });
  for (const p of room.players.values()) {
    if (p.id === exceptId) continue;
    if (p.ws.readyState === 1) p.ws.send(msg);
  }
}

function publicPlayer(p) {
  return {
    id: p.id, name: p.name, car: p.car, loadout: p.loadout, slot: p.slot,
    ready: p.ready, score: p.score, wrecks: p.wrecks, lives: p.lives,
    alive: p.alive, host: p.id === roomOf(p)?.hostId,
  };
}

function roomOf(p) { return rooms.get(p.roomCode); }

function freeSlot(room) {
  const used = new Set([...room.players.values()].map((p) => p.slot));
  for (let i = 0; i < MAX_PLAYERS; i++) if (!used.has(i)) return i;
  return 0;
}

// ───────────────────────────── match flow ─────────────────────────────
function modeCfg(room) {
  const cfg = MODES[room.mode] || MODES.derby;
  return ROUND_OVERRIDE ? { ...cfg, duration: ROUND_OVERRIDE } : cfg;
}

function setPhase(room, phase, seconds) {
  room.phase = phase;
  room.phaseEnds = Date.now() + seconds * 1000;
  broadcastMatch(room);
}

function broadcastMatch(room) {
  broadcast(room, S2C.MATCH, {
    mode: room.mode,
    phase: room.phase,
    left: Math.max(0, (room.phaseEnds - Date.now()) / 1000),
    round: room.roundNum,
  });
}

function broadcastScores(room) {
  broadcast(room, S2C.SCORES, {
    s: [...room.players.values()].map((p) => ({
      id: p.id, score: p.score, wrecks: p.wrecks, lives: p.lives, alive: p.alive, ready: p.ready,
    })),
  });
}

function startRound(room) {
  const cfg = modeCfg(room);
  room.roundNum++;
  for (const p of room.players.values()) {
    p.score = 0;
    p.wrecks = 0;
    p.lives = cfg.lives;
    p.alive = true;
    p.ready = false;
  }
  setPhase(room, PHASE.COUNTDOWN, 5);
  broadcastScores(room);
}

function endRound(room, reason = 'time') {
  const cfg = modeCfg(room);
  const alive = [...room.players.values()].filter((p) => p.alive);

  if (room.mode === 'derby') {
    for (const p of alive) p.score += cfg.points.survive;
  }
  const ranked = [...room.players.values()].sort((a, b) => b.score - a.score);
  const winner = ranked[0];
  if (winner && ranked.length > 1 && winner.score > 0) {
    winner.score += cfg.points.win || 0;
  }

  broadcast(room, S2C.EVENT, {
    e: 'roundOver',
    reason,
    winner: winner ? { id: winner.id, name: winner.name } : null,
    board: ranked.map((p) => ({
      id: p.id, name: p.name, car: p.car, slot: p.slot,
      score: p.score, wrecks: p.wrecks, alive: p.alive,
    })),
  });
  setPhase(room, PHASE.RESULTS, 14);
  broadcastScores(room);
}

function tickRoom(room) {
  const now = Date.now();
  const remaining = (room.phaseEnds - now) / 1000;

  switch (room.phase) {
    case PHASE.LOBBY: {
      const ps = [...room.players.values()];
      if (ps.length > 0 && ps.every((p) => p.ready)) startRound(room);
      break;
    }
    case PHASE.COUNTDOWN:
      if (remaining <= 0) {
        setPhase(room, PHASE.LIVE, modeCfg(room).duration);
        broadcast(room, S2C.EVENT, { e: 'go' });
      }
      break;
    case PHASE.LIVE: {
      if (remaining <= 0) { endRound(room, 'time'); break; }
      if (room.mode === 'derby' && room.players.size > 1) {
        const alive = [...room.players.values()].filter((p) => p.alive);
        if (alive.length <= 1) endRound(room, 'lastStanding');
      }
      break;
    }
    case PHASE.RESULTS:
      if (remaining <= 0) {
        for (const p of room.players.values()) p.ready = false;
        setPhase(room, PHASE.LOBBY, 0);
        broadcastScores(room);
      }
      break;
  }
}

// ───────────────────────────── snapshots ─────────────────────────────
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.players.size === 0) continue;
    const states = [];
    for (const p of room.players.values()) {
      if (p.state) states.push({ id: p.id, ...p.state });
    }
    if (states.length) broadcast(room, S2C.SNAP, { s: states });
  }
}, 1000 / SNAPSHOT_HZ);

// match/score tick + idle room cleanup
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.players.size === 0) {
      if (now - room.lastActivity > 120000) rooms.delete(code);
      continue;
    }
    room.lastActivity = now;
    tickRoom(room);
    broadcastMatch(room);
    broadcastScores(room);
  }
}, 500);

// ───────────────────────────── addresses ─────────────────────────────
function localAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}
const LAN = localAddresses();

// ───────────────────────────── sockets ─────────────────────────────
wss.on('connection', (ws) => {
  let player = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;

    // ── join is the only message allowed before you are in a room ──
    if (msg.t === C2S.JOIN) {
      if (player) return;
      let code = normalizeCode(msg.room);
      let room;
      if (!code) {
        code = freshRoomCode();
        room = createRoom(code);
      } else {
        room = rooms.get(code);
        if (!room) {
          // Joining a code nobody is hosting creates it. Handy when two people
          // agree on a code up front, and it removes a whole class of
          // "host must click first" faff.
          room = createRoom(code);
        }
      }
      if (room.players.size >= MAX_PLAYERS) {
        send(ws, S2C.ERROR, { msg: 'That room is full (8 max).' });
        return;
      }

      player = {
        id: nextId++,
        ws,
        roomCode: code,
        name: sanitizeName(msg.name),
        car: typeof msg.car === 'string' ? msg.car : 'ripsaw',
        loadout: msg.loadout && typeof msg.loadout === 'object' ? msg.loadout : {},
        slot: freeSlot(room),
        ready: false,
        score: 0, wrecks: 0, lives: modeCfg(room).lives, alive: true,
        state: null,
      };
      room.players.set(player.id, player);
      if (room.hostId === null) room.hostId = player.id;

      send(ws, S2C.WELCOME, {
        id: player.id,
        room: code,
        lan: LAN,
        port: PORT,
        protocol: PROTOCOL_VERSION,
        host: room.hostId === player.id,
        players: [...room.players.values()].map(publicPlayer),
        mode: room.mode,
        phase: room.phase,
        left: Math.max(0, (room.phaseEnds - Date.now()) / 1000),
      });
      broadcast(room, S2C.JOINED, { p: publicPlayer(player) }, player.id);
      broadcast(room, S2C.EVENT, { e: 'joined', name: player.name });
      return;
    }

    if (!player) return;
    const room = rooms.get(player.roomCode);
    if (!room) return;

    switch (msg.t) {
      case C2S.STATE:
        player.state = { p: msg.p, q: msg.q, v: msg.v, f: msg.f, h: msg.h };
        break;

      case C2S.READY:
        player.ready = !!msg.ready;
        broadcastScores(room);
        break;

      case C2S.MODE:
        if (player.id === room.hostId && MODES[msg.mode] && room.phase === PHASE.LOBBY) {
          room.mode = msg.mode;
          for (const p of room.players.values()) p.ready = false;
          broadcastMatch(room);
          broadcastScores(room);
        }
        break;

      case C2S.WRECKED: {
        if (room.phase !== PHASE.LIVE || !player.alive) break;
        const killer = room.players.get(msg.by);
        const cfg = modeCfg(room);
        if (room.mode === 'derby') {
          player.lives = Math.max(0, player.lives - 1);
          if (player.lives === 0) player.alive = false;
        }
        if (killer && killer.id !== player.id) {
          killer.wrecks++;
          killer.score += cfg.points.wreck;
        }
        broadcast(room, S2C.EVENT, {
          e: 'wreck',
          victim: { id: player.id, name: player.name },
          killer: killer ? { id: killer.id, name: killer.name } : null,
          lives: player.lives,
        });
        broadcastScores(room);
        break;
      }

      case C2S.TRICK: {
        if (room.phase !== PHASE.LIVE) break;
        const pts = Math.max(0, Math.min(200000, Math.round(msg.points || 0)));
        if (room.mode === 'tricks') player.score += pts;
        if (pts >= 4000) {
          broadcast(room, S2C.EVENT, {
            e: 'bigTrick', id: player.id, name: player.name, points: pts,
            label: String(msg.label || '').slice(0, 40),
          });
        }
        break;
      }

      case C2S.RESPAWN:
        if (room.mode === 'derby' && player.lives > 0) player.alive = true;
        else if (room.mode === 'tricks') player.alive = true;
        broadcastScores(room);
        break;

      case C2S.CHAT: {
        const text = String(msg.text || '').slice(0, 120).replace(/[\x00-\x1f\x7f]/g, '');
        if (text) broadcast(room, S2C.CHAT, { id: player.id, name: player.name, text });
        break;
      }

      case C2S.PING:
        send(ws, S2C.PONG, { c: msg.c });
        break;
    }
  });

  ws.on('close', () => {
    if (!player) return;
    const room = rooms.get(player.roomCode);
    if (!room) return;
    room.players.delete(player.id);
    broadcast(room, S2C.LEFT, { id: player.id });
    broadcast(room, S2C.EVENT, { e: 'left', name: player.name });
    if (room.hostId === player.id) {
      const next = room.players.values().next().value;
      room.hostId = next ? next.id : null;
      if (next) broadcast(room, S2C.EVENT, { e: 'newHost', id: next.id, name: next.name });
    }
    if (room.players.size === 0) {
      room.lastActivity = Date.now();
      room.phase = PHASE.LOBBY;
    }
    player = null;
  });
});

// drop sockets that stop responding
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* already closing */ }
  }
}, 30000);

// ───────────────────────────── boot ─────────────────────────────
server.listen(PORT, () => {
  const lan = LAN;
  console.log('');
  console.log('  WRECKPARK server up');
  console.log(`  local     http://localhost:${PORT}`);
  for (const a of lan) console.log(`  same wifi http://${a}:${PORT}`);
  console.log('');
  if (!existsSync(DIST)) {
    console.log('  (client not built — run `npm run build`, or use `npm run dev` for hot reload)');
    console.log('');
  }
});
