/**
 * WRECKPARK — entry point and game loop.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { initPhysics, createWorld, RAPIER, TIMESTEP, groups, G as CG } from './game/physics.js';
import { buildArena, buildEnvironment, ARENA } from './game/arena.js';
import { Vehicle } from './game/vehicle.js';
import { buildCar } from './game/carBuilder.js';
import { DamageModel } from './game/damage.js';
import { FX } from './game/fx.js';
import { TrickTracker } from './game/tricks.js';
import { ChaseCamera } from './game/camera.js';
import { Pickups } from './game/pickups.js';
import { RemotePlayer } from './game/remotePlayer.js';
import { ReplayRecorder, ReplayPlayer } from './game/replay.js';
import { getCar } from './game/carTypes.js';
import { ITEMS } from './game/cosmetics.js';

import { Input, NEUTRAL_INTENT } from './core/input.js';
import { Audio } from './core/audio.js';
import { Profile, BestRun } from './core/storage.js';
import { clamp, fmtNum, playerColor, hexCss } from './core/util.js';

import { NetClient, makeSampleOut } from './net/client.js';
import { MODES, PHASE, normalizeCode } from './net/protocol.js';

import { HUD, escapeHtml } from './ui/hud.js';
import { Menu } from './ui/menu.js';
import { Garage } from './ui/garage.js';
import { Chat } from './ui/chat.js';

// ─────────────────────────────────────────────────────────────
const G = {
  state: 'menu',          // 'menu' | 'playing'
  quality: Profile.get().quality || 'high',
  uiScale: Profile.get().uiScale || 1.0,
  time: 0,
  localMatch: null,       // stands in for the server when playing solo
};

let renderer, scene, camera, composer, chase;
let world, arena, fx, pickups, env;
let localCar = null, localVisual = null, localDamage = null, tricks = null;
let showcase = null;
let hud, menu, garage, chat;
let net;
const remotes = new Map();          // playerId -> RemotePlayer
const colliderToPlayer = new Map(); // rapier collider handle -> playerId
const sampleOut = makeSampleOut();
let eventQueue;

let sessionStats = { wrecks: 0, trickScore: 0, bestCombo: 0 };
let killerCandidate = null;
let respawnTimer = 0;

let recorder = null;              // records the local car during a trick run
let replay = null;                // { player, visual, rec, returnTo }

// ═════════════════════════════ boot ═════════════════════════════
async function boot() {
  menu = new Menu({
    solo: startSolo,
    host: () => connect(''),
    join: (code) => connect(code),
    garage: openGarage,
    quality: cycleQuality,
    ready: toggleReady,
    leave: leaveRoom,
    resume: resumeGame,
    quit: quitToMenu,
    resultsDone: afterResults,
    carChanged: rebuildShowcase,
    modeChanged: (m) => { if (net?.online) net.setMode(m); },
    uiSize: cycleUiScale,
    watchBest: () => startReplay(BestRun.get(), 'menu'),
    watchRun: () => startReplay(lastRunRecording || BestRun.get(), 'results'),
  });
  menu.show('boot');
  menu.setQualityLabel(G.quality);
  applyUiScale(G.uiScale);

  menu.boot(8, 'starting up');
  setupRenderer();

  menu.boot(22, 'loading physics');
  await initPhysics();

  menu.boot(45, 'pouring concrete');
  world = createWorld();
  eventQueue = new RAPIER.EventQueue(true);
  arena = buildArena(scene, world, G.quality);
  env = buildEnvironment(scene, renderer, G.quality);

  menu.boot(70, 'scattering junk');
  fx = new FX(scene, world, G.quality);
  // let the chase camera avoid clipping through the park
  const camFilter = groups(CG.CAR, CG.WORLD);
  chase.probe = (from, dir, max) => {
    const hit = world.castRay(
      new RAPIER.Ray({ x: from.x, y: from.y, z: from.z }, { x: dir.x, y: dir.y, z: dir.z }),
      max, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, camFilter
    );
    return hit ? hit.timeOfImpact : null;
  };
  pickups = new Pickups(scene, arena.pickupPads);
  pickups.onCollect = onPickup;

  menu.boot(86, 'building your car');
  hud = new HUD();
  chat = new Chat((text) => net.chat(text));
  garage = new Garage(() => { rebuildShowcase(); menu.refreshScrap(); });
  net = makeNet();
  rebuildShowcase();

  menu.boot(100, 'ready');
  await new Promise((r) => setTimeout(r, 260));

  // a room code in the URL means someone shared a link
  const urlCode = normalizeCode(new URLSearchParams(location.search).get('room') || '');
  if (urlCode) {
    document.getElementById('join-code').value = urlCode;
    menu.show('menu');
    menu.netMessage(`Room ${urlCode} from your link - press JOIN`, 'ok');
  } else {
    menu.show('menu');
  }

  requestAnimationFrame(frame);
}

function setupRenderer() {
  const canvas = document.getElementById('view');
  renderer = new THREE.WebGLRenderer({
    canvas, antialias: G.quality !== 'low', powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, G.quality === 'high' ? 2 : 1.4));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = G.quality !== 'low';
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.22;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 0.25, 1400);
  chase = new ChaseCamera(camera);

  buildComposer();
  window.addEventListener('resize', onResize);

  // the audio context can only start from a real gesture
  const kick = () => { Audio.init(); Audio.resume(); };
  window.addEventListener('pointerdown', kick, { once: true });
  window.addEventListener('keydown', kick, { once: true });
}

function buildComposer() {
  composer = null;
  if (G.quality === 'low') return;
  try {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      G.quality === 'high' ? 0.62 : 0.4, 0.7, 0.82
    ));
    composer.addPass(new OutputPass());
  } catch (err) {
    // Bloom is a nice-to-have; never let it stop the game from running.
    console.warn('[wreckpark] post-processing unavailable, falling back to direct render', err);
    composer = null;
  }
}

function onResize() {
  applyUiScale();
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer?.setSize(window.innerWidth, window.innerHeight);
}

/**
 * The UI is authored against a 1280x800 reference and then scaled to whatever
 * screen it lands on. Without this it is laid out in fixed CSS pixels, so on a
 * 5K display the whole interface shrinks to a postage stamp in the corner.
 *
 * `G.uiScale` is the player's own multiplier on top of that.
 */
function autoUiScale() {
  const fit = Math.min(window.innerWidth / 1280, window.innerHeight / 800);
  return clamp(fit, 0.75, 4.0);
}

function applyUiScale(userScale = G.uiScale) {
  G.uiScale = userScale;
  const total = autoUiScale() * userScale;
  document.documentElement.style.setProperty('--u', total.toFixed(3));
  menu?.setUiScaleLabel(userScale, total);
}

const UI_SCALES = [0.85, 1.0, 1.2, 1.45, 1.75];
function cycleUiScale() {
  const i = UI_SCALES.findIndex((v) => Math.abs(v - G.uiScale) < 0.01);
  applyUiScale(UI_SCALES[(i + 1) % UI_SCALES.length]);
  Profile.setUiScale(G.uiScale);
}

function cycleQuality() {
  const order = ['low', 'medium', 'high'];
  G.quality = order[(order.indexOf(G.quality) + 1) % order.length];
  Profile.setQuality(G.quality);
  menu.setQualityLabel(G.quality);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, G.quality === 'high' ? 2 : 1.4));
  renderer.shadowMap.enabled = G.quality !== 'low';
  if (env?.sun) env.sun.castShadow = G.quality !== 'low';
  buildComposer();
}

// ═════════════════════════════ showcase ═════════════════════════════
function rebuildShowcase(carId) {
  // The Menu constructor fires carChanged while selecting the saved car, which
  // happens before the world (or `menu` itself) exists.
  if (!scene || !arena) return;
  if (showcase) { scene.remove(showcase.group); showcase.dispose(); }
  const type = getCar(carId || menu?.selectedCar || Profile.get().car);
  showcase = buildCar(type, Profile.loadout);
  const spawn = arena.spawns[0] || { pos: [0, 0, 60], yaw: 0 };
  showcase.group.position.set(spawn.pos[0], spawn.pos[1] + type.body.ride, spawn.pos[2]);
  const w = type.body;
  const wp = [
    [-w.track, -w.ride + type.phys.wheelRadius, w.front],
    [w.track, -w.ride + type.phys.wheelRadius, w.front],
    [-w.track, -w.ride + type.phys.wheelRadius, w.rear],
    [w.track, -w.ride + type.phys.wheelRadius, w.rear],
  ];
  showcase.wheels.forEach((wheel, i) => wheel.position.fromArray(wp[i]));
  scene.add(showcase.group);
}

// ═════════════════════════════ local car ═════════════════════════════
function spawnLocalCar() {
  destroyLocalCar();
  const type = getCar(menu.selectedCar);
  localCar = new Vehicle({ world, type });
  const slot = net?.online ? (net.players.get(net.id)?.slot ?? 0) : 0;
  localVisual = buildCar(type, Profile.loadout, net?.online ? playerColor(slot) : null);
  localDamage = new DamageModel(localVisual.shellMesh, type.body);
  scene.add(localVisual.group);

  localCar.onImpact = onLocalImpact;
  localCar.onDestroyed = onLocalDestroyed;

  tricks = new TrickTracker({
    trick: onTrick,
    bank: onBank,
    bail: onBail,
  });

  if (showcase) { showcase.group.visible = false; }
  placeAtSpawn();
}

function destroyLocalCar() {
  if (!localCar) return;
  localCar.dispose();
  scene.remove(localVisual.group);
  localVisual.dispose();
  localCar = null; localVisual = null; localDamage = null; tricks = null;
}

function placeAtSpawn() {
  if (!localCar) return;
  if (localVisual) for (const g of localVisual.accessories) g.visible = true;
  const slot = net?.online ? (net.players.get(net.id)?.slot ?? 0) : 0;
  const spawns = arena.spawns;
  const s = spawns[slot % spawns.length];
  localCar.revive(s.pos, s.yaw);
  localDamage?.reset();
  tricks?.reset();
  chase.snapTo(localCar);
  respawnTimer = 0;
}

// ═════════════════════════════ networking ═════════════════════════════
function makeNet() {
  const n = new NetClient();

  n.on('welcome', (msg) => {
    chat.clear();
    chat.setVisible(true);
    chat.system('Connected. Press T to chat.');
    menu.setMode(msg.mode);
    menu.showLobby(msg.room, shareLink(msg));
    Input.setEnabled(true);      // so T opens chat while waiting in the lobby
    menu.lobbyMessage('');
    for (const p of msg.players) if (p.id !== n.id) addRemote(p);
  });

  n.on('playerJoined', (p) => {
    chat.system(`${p.name} joined`);
    addRemote(p);
    hud.feedItem(`<b style="color:${hexCss(playerColor(p.slot))}">${escapeHtml(p.name)}</b> joined`);
  });

  n.on('playerLeft', (id) => {
    const r = remotes.get(id);
    if (r) {
      chat.system(`${r.name} left`);
      hud.feedItem(`<b>${escapeHtml(r.name)}</b> left`);
      colliderToPlayer.delete(r.collider.handle);
      r.dispose();
      remotes.delete(id);
    }
  });

  n.on('phase', ({ phase }) => onPhase(phase));

  n.on('scores', () => {
    if (G.state === 'menu' && menu.current === 'lobby') {
      menu.updateLobby(n.players, n.id, n.match.mode, n.match.phase, n.match.left);
    }
  });

  n.on('chat', (msg) => {
    const p = n.players.get(msg.id);
    chat.add(msg.name, msg.text, p?.slot ?? 0);
    if (msg.id !== n.id) Audio.ui('hover');
  });

  n.on('gameEvent', onNetEvent);

  n.on('error', (msg) => {
    if (menu.current === 'lobby') menu.lobbyMessage(msg, 'err');
    else menu.netMessage(msg, 'err');
  });

  n.on('disconnected', () => {
    clearRemotes();
    if (G.state === 'playing') {
      quitToMenu();
      menu.netMessage('Lost connection to the server.', 'err');
    } else {
      menu.show('menu');
      menu.netMessage('Disconnected.', 'err');
    }
  });

  return n;
}

/**
 * A link your mates can actually open. If you loaded the game on localhost,
 * "localhost" is useless to anyone else, so swap in the LAN address the server
 * reported. Anything else (a tunnel, a real host) is already shareable.
 */
function shareLink(welcome) {
  const host = location.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (isLocal && welcome.lan?.length) {
    return `http://${welcome.lan[0]}:${welcome.port}/?room=${welcome.room}`;
  }
  return `${location.origin}${location.pathname}?room=${welcome.room}`;
}

function connect(code) {
  const name = Profile.get().name || 'DRIVER';
  menu.netMessage(code ? `Joining ${normalizeCode(code)}...` : 'Creating a room...');
  net.connect({ room: code, name, car: menu.selectedCar, loadout: Profile.loadout });
}

function addRemote(p) {
  if (remotes.has(p.id) || p.id === net.id) return;
  const r = new RemotePlayer({
    scene, world,
    type: getCar(p.car),
    loadout: { ...Profile.loadout, ...p.loadout },
    slot: p.slot, name: p.name, id: p.id,
  });
  remotes.set(p.id, r);
  colliderToPlayer.set(r.collider.handle, p.id);
}

function clearRemotes() {
  for (const r of remotes.values()) { colliderToPlayer.delete(r.collider.handle); r.dispose(); }
  remotes.clear();
}

function toggleReady() {
  const me = net.players.get(net.id);
  net.setReady(!me?.ready);
}

function leaveRoom() {
  net.disconnect();
  clearRemotes();
  chat.setVisible(false);
  chat.close();
  menu.show('menu');
  menu.netMessage('');
}

// ═════════════════════════════ match flow ═════════════════════════════
/** The solo button means different things per mode. */
function startSolo() {
  if (menu.mode === 'tricks') startSoloTrickRun();
  else startFreeRoam();
}

function startFreeRoam() {
  G.localMatch = { mode: menu.mode, phase: PHASE.LIVE, left: Infinity, solo: true, freeRoam: true };
  sessionStats = { wrecks: 0, trickScore: 0, bestCombo: 0 };
  recorder = null;
  beginPlaying();
  hud.announce('FREE ROAM', '#22e0ff');
}

/** A timed solo Trick Battle, recorded so the best run can be watched back. */
function startSoloTrickRun() {
  const override = Number(new URLSearchParams(location.search).get('round'));
  const duration = Number.isFinite(override) && override > 0 ? override : MODES.tricks.duration;
  G.localMatch = {
    mode: 'tricks', phase: PHASE.COUNTDOWN, left: 3, solo: true, trickRun: true,
    duration,
  };
  sessionStats = { wrecks: 0, trickScore: 0, bestCombo: 0 };
  beginPlaying();
  arena.resetProps();
  pickups.reset();
  fx.clearDebris();
  recorder = new ReplayRecorder({
    car: menu.selectedCar,
    loadout: { ...Profile.loadout },
    mode: 'tricks',
  });
  hud.announce('GET READY', '#ffd23f');
  Audio.beep(false);
}

/** Drives the phase clock when there is no server to do it. */
function advanceLocalMatch(dt) {
  const m = G.localMatch;
  if (!m || m.freeRoam) return;
  m.left -= dt;
  if (m.left > 0) return;

  if (m.phase === PHASE.COUNTDOWN) {
    m.phase = PHASE.LIVE;
    m.left = m.duration;
    placeAtSpawn();
    hud.announce('GO!', '#46e08a');
    Audio.beep(true);
  } else if (m.phase === PHASE.LIVE) {
    m.phase = PHASE.RESULTS;
    m.left = 0;
    finishSoloTrickRun();
  }
}

let lastRunRecording = null;

function finishSoloTrickRun() {
  tricks?.cancel();
  const score = sessionStats.trickScore;
  const previousBest = BestRun.get()?.score ?? 0;

  let record = false;
  lastRunRecording = null;
  if (recorder) {
    lastRunRecording = recorder.finish(score);
    record = BestRun.saveIfBest(lastRunRecording);
    recorder = null;
  }

  const rewards = [{ label: 'Took a run', amount: 30 }];
  if (score > 0) rewards.push({ label: 'Trick score', amount: trickScrap(score) });
  if (record) rewards.push({ label: 'New personal best', amount: 150 });

  const total = rewards.reduce((n, r) => n + r.amount, 0);
  const before = affordableSet();
  Profile.addScrap(total);
  Profile.recordRound({ won: record, wrecks: 0, bestTrick: sessionStats.bestCombo });
  const unlocked = [...affordableSet()].filter((k) => !before.has(k))
    .slice(0, 4).map((k) => k.split('|')[1]);

  menu.refreshScrap();
  menu.refreshBestRun();
  menu.showResults({
    title: record ? 'BEST RUN YET' : 'RUN OVER',
    board: [{
      id: -1, name: Profile.get().name || 'YOU', slot: 0,
      score, wrecks: 0, alive: true,
    }],
    myId: -1,
    rewards,
    unlocked,
    scoreLabel: 'SCORE',
    record,
    best: Math.max(previousBest, score),
    canReplay: !!(lastRunRecording && lastRunRecording.frames > 0),
  });
  endPlaying();
}

function currentMatch() {
  return G.localMatch || net.match;
}

function onPhase(phase) {
  if (phase === PHASE.COUNTDOWN) {
    sessionStats = { wrecks: 0, trickScore: 0, bestCombo: 0 };
    recorder = net.match.mode === 'tricks'
      ? new ReplayRecorder({ car: menu.selectedCar, loadout: { ...Profile.loadout }, mode: 'tricks' })
      : null;
    beginPlaying();
    arena.resetProps();
    pickups.reset();
    fx.clearDebris();
    placeAtSpawn();
    hud.announce('GET READY', '#ffd23f');
    Audio.beep(false);
  } else if (phase === PHASE.LIVE) {
    hud.announce('GO!', '#46e08a');
    Audio.beep(true);
  } else if (phase === PHASE.LOBBY) {
    if (G.state === 'playing') endPlaying();
    menu.show('lobby');
  }
}

function beginPlaying() {
  G.state = 'playing';
  menu.hideAll();
  hud.show();
  spawnLocalCar();
  Input.setEnabled(true);
  Audio.init(); Audio.resume();
}

function endPlaying() {
  G.state = 'menu';
  hud.hide();
  destroyLocalCar();
  if (showcase) showcase.group.visible = true;
  Audio.silenceCar();
  Input.setEnabled(false);
}

function resumeGame() {
  menu.hideAll();
  hud.show();
  Input.setEnabled(true);
}

function quitToMenu() {
  G.localMatch = null;
  recorder = null;
  if (net.online) { net.disconnect(); clearRemotes(); }
  chat.setVisible(false);
  chat.close();
  endPlaying();
  menu.show('menu');
  menu.refreshScrap();
}

function openGarage() {
  garage.render();
  menu.show('garage');
}

function afterResults() {
  if (G.localMatch) { quitToMenu(); return; }
  menu.show('lobby');
}

// ── round results + scrap ──
function showResults(payload) {
  const cfg = MODES[currentMatch().mode] || MODES.derby;
  const myId = net.online ? net.id : -1;
  const board = payload.board || [];
  const me = board.find((r) => r.id === myId);
  const won = board.length > 0 && board[0].id === myId;

  // an online trick battle is still a run worth keeping
  let record = false;
  let previousBest;
  if (currentMatch().mode === 'tricks' && recorder) {
    previousBest = BestRun.get()?.score ?? 0;
    lastRunRecording = recorder.finish(me?.score ?? sessionStats.trickScore);
    record = BestRun.saveIfBest(lastRunRecording);
    recorder = null;
    menu.refreshBestRun();
  }

  const rewards = [];
  rewards.push({ label: 'Turned up', amount: 30 });
  if (me?.wrecks) rewards.push({ label: `Wrecked ${me.wrecks}`, amount: me.wrecks * 50 });
  if (currentMatch().mode === 'tricks' && me) {
    rewards.push({ label: 'Trick score', amount: trickScrap(me.score) });
  }
  if (won) rewards.push({ label: 'Won the round', amount: 120 });
  if (record) rewards.push({ label: 'New personal best', amount: 150 });

  const total = rewards.reduce((n, r) => n + r.amount, 0);
  const before = affordableSet();
  Profile.addScrap(total);
  Profile.recordRound({ won, wrecks: me?.wrecks || 0, bestTrick: sessionStats.bestCombo });
  const unlocked = [...affordableSet()].filter((k) => !before.has(k))
    .slice(0, 4).map((k) => k.split('|')[1]);

  menu.refreshScrap();
  menu.showResults({
    title: won ? 'YOU WON THE ROUND' : (payload.winner ? `${payload.winner.name} WINS` : 'ROUND OVER'),
    board, myId, rewards, unlocked, scoreLabel: cfg.scoreLabel,
    record,
    best: previousBest === undefined ? undefined : Math.max(previousBest, me?.score ?? 0),
    canReplay: !!(lastRunRecording && lastRunRecording.frames > 0),
  });
  endPlaying();
}

/**
 * Trick scores reach six figures on a long combo chain, so scrap is scaled and
 * capped. The whole cosmetic catalogue is about 13,700 scrap; a strong run
 * should be worth a few hundred, not all of it.
 */
function trickScrap(score) {
  return Math.min(600, Math.round(score / 500));
}

function affordableSet() {
  const s = new Set();
  for (const cat of Object.keys(ITEMS)) {
    for (const item of ITEMS[cat]) {
      if (!Profile.owns(cat, item.id) && Profile.scrap >= item.cost) s.add(`${cat}|${item.name}`);
    }
  }
  return s;
}

// ═════════════════════════════ replay ═════════════════════════════
function startReplay(rec, returnTo = 'menu') {
  if (!rec || !rec.frames) return;

  // stop whatever is happening now
  if (G.state === 'playing') endPlaying();
  menu.hideAll();
  if (showcase) showcase.group.visible = false;

  const type = getCar(rec.car);
  const visual = buildCar(type, { ...Profile.loadout, ...(rec.loadout || {}) });
  scene.add(visual.group);

  const player = new ReplayPlayer(rec);
  player.onEvent = (label, points) => {
    hud.popup(`+${fmtNum(points)}`, '#ffd23f');
    hud.announce(label, '#22e0ff');
    Audio.bank(2);
  };

  const wheelRest = [
    [-type.body.track, -type.body.ride + type.phys.wheelRadius, type.body.front],
    [type.body.track, -type.body.ride + type.phys.wheelRadius, type.body.front],
    [-type.body.track, -type.body.ride + type.phys.wheelRadius, type.body.rear],
    [type.body.track, -type.body.ride + type.phys.wheelRadius, type.body.rear],
  ];
  visual.wheels.forEach((w, i) => w.position.fromArray(wheelRest[i]));

  replay = { rec, player, visual, type, returnTo, wheelSpin: 0 };
  G.state = 'replay';

  hud.show();
  hud.setReplayMode(true);
  menu.showReplayBar(`<b>${fmtNum(rec.score)}</b> &nbsp;-&nbsp; ${escapeHtml(type.name)}`);
  chase.snapTo(player);
  Input.setEnabled(true);
  Audio.silenceCar();
}

function stopReplay() {
  if (!replay) return;
  const back = replay.returnTo;
  scene.remove(replay.visual.group);
  replay.visual.dispose();
  replay = null;
  G.state = 'menu';
  hud.setReplayMode(false);
  hud.hide();
  menu.hideReplayBar();
  Input.setEnabled(false);
  if (showcase) showcase.group.visible = true;
  menu.show(back === 'results' ? 'results' : 'menu');
  if (back !== 'results') menu.refreshBestRun();
}

function updateReplay(dt) {
  const r = replay;
  if (!r) return;

  if (Input.pressed('Escape')) { stopReplay(); return; }
  if (Input.pressed('Space')) { r.player.restart(); hud.hideCombo(); }
  if (Input.pressed('KeyC')) chase.cycle();

  r.player.update(dt);

  const p = r.player.position;
  const q = r.player.rotation;
  r.visual.group.position.set(p.x, p.y, p.z);
  r.visual.group.quaternion.set(q.x, q.y, q.z, q.w);

  r.wheelSpin -= (r.player.absSpeed / r.type.phys.wheelRadius) * dt;
  for (const w of r.visual.wheels) w.rotation.x = r.wheelSpin;

  if (r.player.boosting) {
    const fwd = forwardOf(q);
    _wpos.set(p.x - fwd.x * r.type.body.l, p.y + 0.1, p.z - fwd.z * r.type.body.l);
    const trailColor = (ITEMS.trail.find((i) => i.id === Profile.loadout.trail) || ITEMS.trail[0]).color;
    fx.boost(_wpos, { x: -fwd.x, y: -fwd.y + 0.1, z: -fwd.z }, trailColor);
  }

  chase.update(dt, r.player);
  world.step();
  arena.update();

  menu.setReplayProgress((r.player.time / Math.max(0.001, r.player.duration)) * 100);
  if (r.player.finished) menu.setReplayProgress(100);
}

const _fwdTmp = new THREE.Vector3();
function forwardOf(q) {
  return _fwdTmp.set(0, 0, 1).applyQuaternion(_qTmp.set(q.x, q.y, q.z, q.w));
}
const _qTmp = new THREE.Quaternion();

// ═════════════════════════════ events ═════════════════════════════
function onNetEvent(msg) {
  switch (msg.e) {
    case 'wreck': {
      const victim = msg.victim, killer = msg.killer;
      if (killer) {
        hud.feedItem(`<b>${escapeHtml(killer.name)}</b> wrecked <b>${escapeHtml(victim.name)}</b>`);
      } else {
        hud.feedItem(`<b>${escapeHtml(victim.name)}</b> wrecked themselves`);
      }
      if (killer && killer.id === net.id) {
        hud.popup('WRECKED THEM  +100', '#46e08a');
        sessionStats.wrecks++;
      }
      break;
    }
    case 'bigTrick':
      if (msg.id !== net.id) {
        hud.feedItem(`<b>${escapeHtml(msg.name)}</b> landed ${fmtNum(msg.points)}`);
      }
      break;
    case 'roundOver':
      showResults(msg);
      break;
    case 'go':
      break;
    case 'newHost':
      hud.feedItem(`<b>${escapeHtml(msg.name)}</b> is now host`);
      break;
  }
}

/** Shakes a bolt-on loose and throws it across the tarmac. */
function shedPart(worldPos) {
  if (!localVisual) return;
  const attached = localVisual.accessories.filter((g) => g.visible);
  if (!attached.length) return;
  const part = attached[Math.floor(Math.random() * attached.length)];
  part.visible = false;
  fx.throwDebris(worldPos, 4, 9);
  hud.popup('PARTS!', '#ff6a1f');
}

function onLocalImpact(magnitude, carId, localDir) {
  if (!localCar) return;
  const p = localCar.position;

  fx.impact(new THREE.Vector3(p.x, p.y, p.z), magnitude);
  Audio.impact(magnitude);
  chase.addShake(magnitude * 0.9);
  localDamage.apply(magnitude, localDir);

  // hitting another car hurts more, and scales with how heavy they are
  let dmg = magnitude * 38 / localCar.phys.armor;
  if (carId != null) {
    const attacker = remotes.get(carId);
    if (attacker) {
      dmg *= attacker.type.phys.ramPower * (attacker.boosting ? 1.55 : 1);
      killerCandidate = carId;
    }
  } else {
    dmg *= 0.8;    // scenery is more forgiving than a Mauler, but not by much
  }

  if (currentMatch().mode === 'tricks') dmg *= 0.35;
  localCar.damage(dmg, killerCandidate);

  // a proper wallop shakes something loose
  if (magnitude > 0.45 && Math.random() < magnitude * 0.7) {
    shedPart(new THREE.Vector3(p.x, p.y + 0.5, p.z));
  }
}

function onLocalDestroyed(killerId) {
  const p = localCar.position;
  fx.explosion(new THREE.Vector3(p.x, p.y + 0.4, p.z));
  Audio.explosion();
  chase.addShake(1.3);
  localDamage.scorch();
  tricks.cancel();
  hud.announce('WRECKED', '#ff3b52');
  respawnTimer = 3.0;
  if (net.online) net.reportWrecked(killerId ?? null);
  killerCandidate = null;
}

function onTrick(label, points, index) {
  Audio.trick(index);
  hud.showCombo(tricks.tricks, tricks.pending, tricks.multiplier);
}

function onBank(total, mult, list) {
  sessionStats.trickScore += total;
  recorder?.addEvent(list[list.length - 1] || 'COMBO', total);
  sessionStats.bestCombo = Math.max(sessionStats.bestCombo, total);
  hud.hideCombo();
  hud.popup(`+${fmtNum(total)}${mult > 1 ? ` x${mult}` : ''}`, '#ffd23f');
  Audio.bank(mult);
  if (net.online) net.reportTrick(total, list[list.length - 1] || '');
}

function onBail() {
  hud.hideCombo();
  hud.popup('BAILED', '#ff3b52');
  Audio.bail();
}

function onPickup(type, pos) {
  if (!localCar) return;
  const v = new THREE.Vector3(pos.x, pos.y, pos.z);
  if (type === 'repair') {
    localCar.repair(45);
    localDamage.partialRepair(0.5);   // patched up, not showroom fresh
    hud.popup('REPAIRED', '#46e08a');
    fx.sparks(v, 18, 0.6, new THREE.Color(0x46e08a));
  } else if (type === 'boost') {
    localCar.addBoost(localCar.phys.boostMax);
    hud.popup('BOOST FULL', '#22e0ff');
    fx.sparks(v, 18, 0.6, new THREE.Color(0x22e0ff));
  } else {
    localCar.overdrive = 12;
    hud.popup('OVERDRIVE', '#ff3fae');
    fx.sparks(v, 26, 1.0, new THREE.Color(0xff3fae));
  }
  Audio.ui('buy');
}

// ═════════════════════════════ loop ═════════════════════════════
let lastTime = performance.now();
let accumulator = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const rawDt = (now - lastTime) / 1000;
  lastTime = now;
  const dt = Math.min(rawDt, 0.1);
  G.time += dt;

  if (G.state === 'playing') updatePlaying(dt);
  else if (G.state === 'replay') updateReplay(dt);
  else updateMenu(dt);

  fx.update(dt);
  Input.endFrame();

  if (composer) composer.render();
  else renderer.render(scene, camera);
}

function updateMenu(dt) {
  const spawn = arena.spawns[0] || { pos: [0, 0, 60] };
  const centre = new THREE.Vector3(spawn.pos[0], spawn.pos[1] + 1.2, spawn.pos[2]);
  chase.orbit(dt, centre, 13, 4.4, G.time);
  if (showcase) showcase.group.rotation.y += dt * 0.25;
  arena.update();

  if (menu.current === 'lobby' && net.online) {
    menu.updateLobby(net.players, net.id, net.match.mode, net.match.phase, net.match.left);
    if (Input.pressed('KeyT') && !chat.typing) chat.open();
  }
}

function updatePlaying(dt) {
  const match = currentMatch();

  if (chat.typing) {
    // hands are on the keyboard, not the wheel
    if (localCar) { localCar.preStep(TIMESTEP); localCar.step(TIMESTEP, NEUTRAL_INTENT); }
    world.step(eventQueue);
    eventQueue.drainCollisionEvents(() => {});
    syncVisuals(dt);
    if (localCar) chase.update(dt, localCar);
    arena.update();
    updateHud(dt, match);
    if (localCar) net.pushState(dt, localCar);
    return;
  }
  if (Input.pressed('KeyT') && net.online) { chat.open(); return; }

  if (Input.pressed('Escape')) {
    if (menu.current === 'pause') { resumeGame(); }
    else { Input.setEnabled(false); hud.hide(); menu.show('pause'); }
    return;
  }
  if (menu.current === 'pause') return;

  // no rolling start: the car is frozen until GO
  const frozen = match.phase === PHASE.COUNTDOWN || respawnTimer > 0 || !localCar?.alive;
  const intent = frozen ? NEUTRAL_INTENT : Input.sample();
  if (intent.camera) chase.cycle();

  // remote cars chase their network pose once per frame
  for (const [id, r] of remotes) {
    const s = net.sample(id, sampleOut);
    if (s) r.applyNetwork(s, dt);
  }

  // ── fixed-step physics ──
  accumulator += dt;
  let steps = 0;
  while (accumulator >= TIMESTEP && steps < 5) {
    accumulator -= TIMESTEP;
    steps++;
    if (localCar) {
      localCar.preStep(TIMESTEP);
      localCar.step(TIMESTEP, intent);
    }
    world.step(eventQueue);
    drainContacts();
    if (localCar && tricks) {
      tricks.update(TIMESTEP, localCar, {
        nearby: [...remotes.values()].map((r) => r.position),
        enabled: match.phase === PHASE.LIVE || match.freeRoam === true,
      });
    }
  }
  if (steps === 5) accumulator = 0;   // fell behind; drop the backlog

  // ── respawn ──
  if (localCar && !localCar.alive) {
    respawnTimer -= dt;
    if (respawnTimer <= 0) {
      const me = net.online ? net.players.get(net.id) : null;
      const canRespawn = match.solo || match.mode === 'tricks' || !me || me.lives > 0;
      if (canRespawn) {
        placeAtSpawn();
        if (net.online) net.reportRespawn();
      }
    }
  }

  // ── fell out of the world ──
  if (localCar && localCar.alive) {
    const p = localCar.position;
    if (p.y < ARENA.killY || Math.hypot(p.x, p.z) > ARENA.escapeRadius) placeAtSpawn();
  }

  advanceLocalMatch(dt);
  if (recorder && localCar && match.phase === PHASE.LIVE) recorder.sample(dt, localCar);

  syncVisuals(dt);
  if (localCar) chase.update(dt, localCar);
  arena.update();
  pickups.update(dt, localCar, G.time);
  updateHud(dt, match);

  if (localCar) net.pushState(dt, localCar);
}

/** Turns Rapier collision events into "who just hit me". */
function drainContacts() {
  if (!localCar) return;
  const myHandle = localCar.collider.handle;
  eventQueue.drainCollisionEvents((h1, h2, started) => {
    if (!started) return;
    let other = null;
    if (h1 === myHandle) other = h2;
    else if (h2 === myHandle) other = h1;
    else return;
    const pid = colliderToPlayer.get(other);
    if (pid !== undefined) localCar.lastCarContact = { id: pid, t: performance.now() };
  });
}

const _wpos = new THREE.Vector3();
const _wrot = new THREE.Quaternion();

function syncVisuals(dt) {
  if (localCar && localVisual) {
    const t = localCar.position, r = localCar.rotation;
    localVisual.group.position.set(t.x, t.y, t.z);
    localVisual.group.quaternion.set(r.x, r.y, r.z, r.w);
    for (let i = 0; i < 4; i++) {
      const w = localVisual.wheels[i];
      localCar.wheelLocalTransform(i, w.position, w.quaternion);
    }
    localDamage.flush();

    // boost plume + tyre smoke
    if (localCar.boosting) {
      const { fwd } = localCar.axes();
      // vent out of whichever end is doing the pushing
      const d = localCar.boostDir || 1;
      const off = localCar.bodyDef.l * d;
      _wpos.set(t.x - fwd.x * off, t.y + 0.1, t.z - fwd.z * off);
      const trailColor = (ITEMS.trail.find((i) => i.id === Profile.loadout.trail) || ITEMS.trail[0]).color;
      fx.boost(_wpos, { x: -fwd.x * d, y: -fwd.y * d + 0.1, z: -fwd.z * d }, trailColor);
    }
    if (localCar.slip > 0.4 && !localCar.airborne) {
      for (let i = 2; i < 4; i++) {
        localCar.wheelTransform(i, _wpos, _wrot);
        if (Math.random() < localCar.slip) fx.skid(_wpos);
      }
    }
    const landing = localCar.takeLanding();
    if (landing > 0.35) {
      _wpos.set(t.x, t.y - localCar.bodyDef.ride, t.z);
      fx.dust(_wpos, Math.min(20, 4 + landing * 8));
      Audio.land(clamp(localCar.landImpact / 18, 0, 1));
      chase.addShake(clamp(landing * 0.28, 0, 0.7));
    }

    Audio.updateCar({
      rpm: clamp(Math.abs(localCar.speed) / localCar.phys.topSpeed, 0, 1),
      load: Math.abs(Input.sample().throttle),
      speed: localCar.absSpeed,
      slip: localCar.slip,
      boosting: localCar.boosting,
      airborne: localCar.airborne,
      electric: localCar.type.id === 'volt',
    });
  }

  for (const r of remotes.values()) {
    r.render(camera);
    if (r.boosting) {
      const t = r.body.translation();
      _wpos.set(t.x, t.y + 0.2, t.z);
      fx.boost(_wpos, { x: 0, y: 0.4, z: 0 }, 0xff8a1f);
    }
  }
}

function updateHud(dt, match) {
  const cfg = MODES[match.mode] || MODES.derby;
  hud.setMode(match.freeRoam ? 'FREE ROAM' : (match.solo ? 'SOLO TRICK RUN' : cfg.name));
  if (match.freeRoam) { match.elapsed = (match.elapsed || 0) + dt; hud.setTimer(match.elapsed); }
  else hud.setTimer(match.left);

  if (localCar) {
    hud.setHealth((localCar.health / localCar.maxHealth) * 100);
    hud.setBoost((localCar.boost / localCar.phys.boostMax) * 100);
    hud.setSpeed(localCar.absSpeed * 3.6);
    hud.setFlipReady(localCar.airborne && localCar.flipReady);
  }

  const me = net.online ? net.players.get(net.id) : null;
  hud.setLives(me ? me.lives : 0, match.solo ? 0 : cfg.lives);

  if (net.online) {
    const rows = [...net.players.values()]
      .map((p) => ({ id: p.id, name: p.name, slot: p.slot, score: p.score, alive: p.alive }))
      .sort((a, b) => b.score - a.score);
    hud.setScores(rows, net.id, cfg.scoreLabel);
  } else {
    hud.setScores([{ id: -1, name: Profile.get().name || 'YOU', slot: 0, score: sessionStats.trickScore, alive: true }], -1, 'SCORE');
  }

  if (localCar) {
    const t = localCar.position;
    const { fwd } = localCar.axes();
    hud.drawRadar(
      { x: t.x, z: t.z, yaw: Math.atan2(fwd.x, fwd.z) },
      [...remotes.values()].map((r) => {
        const p = r.body.translation();
        const info = net.players.get(r.id);
        return { x: p.x, z: p.z, slot: info?.slot ?? 0, alive: r.alive };
      }),
      ARENA.wallTop
    );
  }
}

// Small hook so the browser smoke test can assert on real game state
// rather than scraping the HUD.
window.__wp = {
  carPos: () => (localCar ? [localCar.position.x, localCar.position.y, localCar.position.z] : null),
  speed: () => (localCar ? localCar.absSpeed : 0),
  state: () => G.state,
  health: () => (localCar ? localCar.health : 0),
  airborne: () => !!localCar?.airborne,
  players: () => (net?.online ? net.players.size : 0),
  remotes: () => [...remotes.values()].map((r) => {
    const t = r.body.translation();
    return { id: r.id, name: r.name, x: t.x, y: t.y, z: t.z, alive: r.alive, health: r.health };
  }),
  phase: () => currentMatch().phase,
  scores: () => (net?.online ? [...net.players.values()].map((p) => ({ id: p.id, name: p.name, score: p.score, lives: p.lives, ready: p.ready })) : []),
  ping: () => net?.ping ?? -1,
  room: () => net?.room || null,
  trickScore: () => sessionStats.trickScore,
  bestRun: () => { const r = BestRun.get(); return r ? { score: r.score, frames: r.frames, car: r.car, kb: Math.round((r.data?.length || 0) * 0.75 / 1024) } : null; },
  replayTime: () => (replay ? replay.player.time : -1),
  replayPos: () => (replay ? [replay.player.position.x, replay.player.position.y, replay.player.position.z] : null),
  uiScale: () => ({ user: G.uiScale, auto: autoUiScale(), applied: getComputedStyle(document.documentElement).getPropertyValue('--u').trim(), vw: window.innerWidth, vh: window.innerHeight }),
  soloPhase: () => (G.localMatch ? G.localMatch.phase : null),
  soloLeft: () => (G.localMatch ? G.localMatch.left : -1),
  pendingTrick: () => (tricks ? tricks.pending : 0),
  comboLabels: () => (tricks ? tricks.tricks.slice() : []),
  arenaInfo: () => ({ tris: arena.triangleCount, spawns: arena.spawns.length, props: arena.props.items.length }),
};

// ═════════════════════════════ go ═════════════════════════════
boot().catch((err) => {
  console.error(err);
  document.getElementById('boot-msg').textContent = `Failed to start: ${err.message}`;
  document.getElementById('boot-msg').style.color = '#ff3b52';
});
