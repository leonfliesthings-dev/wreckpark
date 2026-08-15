/**
 * Two real browser clients, one room. Proves the multiplayer path end to end:
 * lobby, ready-up, countdown, live round, and that each client actually sees
 * the other car moving around the park.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOTS = join(ROOT, 'shots');
mkdirSync(SHOTS, { recursive: true });
const PORT = 8096;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
  if (!ok) failures++;
};

const server = spawn('node', [join(ROOT, 'server', 'server.js')],
  { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
process.on('exit', () => { try { server.kill('SIGTERM'); } catch {} });
await new Promise((r) => setTimeout(r, 1200));

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--use-angle=metal', '--mute-audio'],
});

const errors = [];
async function makeClient(name) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => document.getElementById('menu')?.classList.contains('active'), { timeout: 45000 });
  await page.fill('#name-input', name);
  return page;
}

console.log('\n── two clients, one room ──');
const alice = await makeClient('ALICE');
const bob = await makeClient('BOB');

await alice.click('.car-card[data-car="mauler"]');
await alice.click('#btn-host');
await alice.waitForFunction(() => document.getElementById('lobby')?.classList.contains('active'), { timeout: 15000 });
const room = await alice.textContent('#room-code');
check('host gets a room code', /^[A-Z0-9]{4}$/.test(room || ''), room);

await bob.click('.car-card[data-car="hornet"]');
await bob.fill('#join-code', room);
await bob.click('#btn-join');
await bob.waitForFunction(() => document.getElementById('lobby')?.classList.contains('active'), { timeout: 15000 });
await alice.waitForTimeout(1200);

const aCount = await alice.evaluate(() => window.__wp.players());
const bCount = await bob.evaluate(() => window.__wp.players());
check('both clients see 2 players', aCount === 2 && bCount === 2, `alice=${aCount} bob=${bCount}`);
await alice.screenshot({ path: join(SHOTS, '8-lobby.png') });

// ── a lone host must not start without their mate ──
console.log('\n── lobby gating ──');
{
  const solo = await makeClient('SOLO');
  await solo.click('#btn-host');
  await solo.waitForFunction(() => document.getElementById('lobby')?.classList.contains('active'), { timeout: 15000 });
  await solo.waitForTimeout(900);
  const disabled = await solo.evaluate(() => document.getElementById('btn-ready').disabled);
  const phase = await solo.evaluate(() => window.__wp.phase());
  check('a lone host cannot start the round', disabled && phase === 'lobby',
    `readyDisabled=${disabled} phase=${phase}`);
  await solo.close();
}

// ── ready up, round starts ──
await alice.click('#btn-ready');
await bob.click('#btn-ready');
await alice.waitForTimeout(1000);
const countdownSeen = await alice.evaluate(() => window.__wp.phase());
check('readying up starts the countdown', countdownSeen === 'countdown', `phase=${countdownSeen}`);

await alice.waitForFunction(() => window.__wp.phase() === 'live', { timeout: 20000 }).catch(() => {});
const aPhase = await alice.evaluate(() => window.__wp.phase());
const bPhase = await bob.evaluate(() => window.__wp.phase());
check('round goes live for both', aPhase === 'live' && bPhase === 'live', `alice=${aPhase} bob=${bPhase}`);

const startLives = await alice.evaluate(() => window.__wp.scores());
check('derby starts everyone on 3 lives', startLives.every((s) => s.lives === 3),
  startLives.map((s) => `${s.name}:${s.lives}`).join(' '));

// ── drive and check each sees the other move ──
const beforeA = await alice.evaluate(() => window.__wp.remotes());
await bob.keyboard.down('w');
await bob.keyboard.down('Shift');
await alice.waitForTimeout(2600);
await bob.keyboard.up('Shift');
await bob.keyboard.up('w');
await alice.waitForTimeout(400);
const afterA = await alice.evaluate(() => window.__wp.remotes());

check('alice sees bob as a remote car', afterA.length === 1, `${afterA.length} remotes`);
if (beforeA.length && afterA.length) {
  const moved = Math.hypot(afterA[0].x - beforeA[0].x, afterA[0].z - beforeA[0].z);
  check('bob driving shows up on alice screen', moved > 15, `${moved.toFixed(0)} m of movement replicated`);
}
await alice.screenshot({ path: join(SHOTS, '9-multiplayer.png') });

// ── both driving at once ──
await alice.keyboard.down('w');
await bob.keyboard.down('w');
await alice.waitForTimeout(2000);
const aSeesB = await alice.evaluate(() => window.__wp.remotes());
const bSeesA = await bob.evaluate(() => window.__wp.remotes());
check('each client tracks the other while both drive',
  aSeesB.length === 1 && bSeesA.length === 1,
  `alice sees ${aSeesB.length}, bob sees ${bSeesA.length}`);
await alice.keyboard.up('w');
await bob.keyboard.up('w');

const ping = await alice.evaluate(() => window.__wp.ping());
check('round-trip ping is measured', ping >= 0 && ping < 500, `${ping} ms (loopback)`);

// ── chat ──
console.log('\n── room chat ──');
const chatVisible = await alice.evaluate(() => document.getElementById('chat').classList.contains('active'));
check('chat panel shows when connected', chatVisible);

await alice.keyboard.press('KeyT');
await alice.waitForTimeout(300);
const typing = await alice.evaluate(() => document.getElementById('chat').classList.contains('typing'));
check('T opens the chat box', typing);

await alice.keyboard.type('oi bob watch this');
await alice.keyboard.press('Enter');
await alice.waitForTimeout(700);

const bobSaw = await bob.evaluate(() =>
  [...document.querySelectorAll('#chat-log .chat-msg')].map((e) => e.textContent).join(' | '));
check('bob receives the message', /oi bob watch this/.test(bobSaw), bobSaw.slice(0, 90));

const aliceSaw = await alice.evaluate(() =>
  [...document.querySelectorAll('#chat-log .chat-msg')].map((e) => e.textContent).join(' | '));
check('alice sees her own message', /oi bob watch this/.test(aliceSaw));

const closedAfterSend = await alice.evaluate(() => !document.getElementById('chat').classList.contains('typing'));
check('chat box closes after sending', closedAfterSend);

// typing must not drive the car. Let it roll to a stop first, otherwise this
// just measures the car coasting.
await alice.waitForTimeout(3500);
await alice.keyboard.press('KeyT');
await alice.waitForTimeout(250);
const speedBefore = await alice.evaluate(() => window.__wp.speed());
await alice.keyboard.type('wwwwdddd');
await alice.waitForTimeout(1200);
const speedAfter = await alice.evaluate(() => window.__wp.speed());
check('typing does not drive the car', speedAfter < Math.max(1.5, speedBefore + 0.5),
  `${speedBefore.toFixed(2)} -> ${speedAfter.toFixed(2)} m/s while typing`);
await alice.keyboard.press('Escape');
await alice.waitForTimeout(300);

// ── scores replicate ──
const aScores = await alice.evaluate(() => window.__wp.scores());
check('scoreboard has both players', aScores.length === 2,
  aScores.map((s) => `${s.name}:${s.score}`).join(' '));
check('lives are tracked and can be lost', aScores.every((s) => s.lives >= 0 && s.lives <= 3),
  aScores.map((s) => `${s.name}:${s.lives}`).join(' '));

// ── turning up mid-round ──
console.log('\n── joining a round already in progress ──');
{
  const late = await makeClient('LATE');
  await late.fill('#join-code', room);
  await late.click('#btn-join');
  await late.waitForTimeout(4000);

  const inGame = await late.evaluate(() => document.getElementById('hud').classList.contains('active'));
  const stuckInLobby = await late.evaluate(() => document.getElementById('lobby').classList.contains('active'));
  check('late joiner drops straight into the game', inGame && !stuckInLobby,
    `hud=${inGame} lobby=${stuckInLobby}`);

  const p0 = await late.evaluate(() => window.__wp.carPos());
  check('late joiner gets a car', !!p0, p0 ? `spawned at (${p0[0].toFixed(0)}, ${p0[2].toFixed(0)})` : 'no car');

  await late.keyboard.down('w');
  await late.waitForTimeout(1800);
  await late.keyboard.up('w');
  const p1 = await late.evaluate(() => window.__wp.carPos());
  const moved = p0 && p1 ? Math.hypot(p1[0] - p0[0], p1[2] - p0[2]) : 0;
  check('late joiner can drive', moved > 8, `${moved.toFixed(0)} m`);

  await alice.waitForTimeout(800);
  const aliceSees = await alice.evaluate(() => window.__wp.remotes().length);
  check('everyone already playing sees the newcomer', aliceSees === 2, `${aliceSees} remotes`);
  await late.close();
  await alice.waitForTimeout(1200);
}

// ── a client leaving is cleaned up ──
await bob.close();
await alice.waitForTimeout(1500);
const afterLeave = await alice.evaluate(() => ({ players: window.__wp.players(), remotes: window.__wp.remotes().length }));
check('leaving removes the car and the player', afterLeave.players === 1 && afterLeave.remotes === 0,
  `players=${afterLeave.players} remotes=${afterLeave.remotes}`);

check('no client errors', errors.length === 0, errors.slice(0, 4).join(' | '));

await browser.close();
server.kill('SIGTERM');
console.log(`\n${failures === 0 ? 'nettest: ALL PASS' : `nettest: ${failures} FAILURE(S)`}\n`);
if (failures) console.log('server log:\n' + serverLog);
process.exit(failures ? 1 : 0);
