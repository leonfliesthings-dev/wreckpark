/**
 * Browser smoke test: boots the real game in Chrome, plays it, and fails on any
 * console error, unhandled rejection or WebGL problem. Also grabs screenshots
 * so the visuals can actually be looked at.
 *
 * Uses the installed Google Chrome rather than downloading a browser.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOTS = join(ROOT, 'shots');
mkdirSync(SHOTS, { recursive: true });

const PORT = 8099;
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
  if (!ok) failures++;
};

// ── start the server ──
const server = spawn('node', [join(ROOT, 'server', 'server.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const stop = () => { try { server.kill('SIGTERM'); } catch { /* already gone */ } };
process.on('exit', stop);

await new Promise((r) => setTimeout(r, 1200));

// ── launch chrome ──
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
const warnings = [];
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error') errors.push(m.text());
  else if (t === 'warning') warnings.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

console.log('\n── boot ──');
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });

// wait for the menu to appear (boot finished)
let booted = false;
try {
  await page.waitForFunction(
    () => document.getElementById('menu')?.classList.contains('active'),
    { timeout: 45000 }
  );
  booted = true;
} catch { /* reported below */ }
check('game boots to the menu', booted, booted ? '' : `boot-msg: ${await page.textContent('#boot-msg').catch(() => '?')}`);

const renderInfo = await page.evaluate(() => {
  const c = document.getElementById('view');
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  if (!gl) return { ok: false };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    ok: true,
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
    size: [c.width, c.height],
  };
});
check('WebGL context is live', renderInfo.ok, renderInfo.renderer || '');

await page.waitForTimeout(1500);
await page.screenshot({ path: join(SHOTS, '1-menu.png') });

// ── car select + garage ──
console.log('\n── menus ──');
await page.click('.car-card[data-car="mauler"]');
await page.waitForTimeout(400);
const statsText = await page.textContent('#car-stats');
check('car select updates the stat panel', /ARMOUR/i.test(statsText || ''), '');
await page.screenshot({ path: join(SHOTS, '2-carselect.png') });

await page.click('#btn-garage');
await page.waitForTimeout(500);
const garageActive = await page.evaluate(() => document.getElementById('garage').classList.contains('active'));
check('garage opens', garageActive);
const itemCount = await page.locator('.item-card').count();
check('garage lists items', itemCount > 5, `${itemCount} items`);
await page.screenshot({ path: join(SHOTS, '3-garage.png') });
await page.click('#garage-back');
await page.waitForTimeout(300);

// ── free roam ──
console.log('\n── driving ──');

const startSolo = async () => {
  await page.click('#btn-solo');
  await page.waitForTimeout(2200);
};
const peakStart = () => page.evaluate(() => {
  window.__peak = 0;
  clearInterval(window.__sampler);
  window.__sampler = setInterval(() => {
    window.__peak = Math.max(window.__peak, window.__wp.speed());
  }, 40);
});
const peakRead = () => page.evaluate(() => {
  clearInterval(window.__sampler);
  return window.__peak * 3.6;
});
const quitToMenu = async () => {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.click('#pause-quit');
  await page.waitForTimeout(600);
};

await page.click('.car-card[data-car="ripsaw"]');
await startSolo();

const hudActive = await page.evaluate(() => document.getElementById('hud').classList.contains('active'));
check('HUD appears', hudActive);

const arenaInfo = await page.evaluate(() => window.__wp.arenaInfo());
check('arena built in the browser', arenaInfo.tris > 5000 && arenaInfo.spawns === 8,
  `${arenaInfo.tris} collision tris, ${arenaInfo.spawns} spawns, ${arenaInfo.props} props`);

// ── throttle only ──
const startPos = await page.evaluate(() => window.__wp.carPos());
await peakStart();
await page.keyboard.down('w');
await page.waitForTimeout(2600);
const plainPeak = await peakRead();
const endPos = await page.evaluate(() => window.__wp.carPos());
await page.screenshot({ path: join(SHOTS, '4-driving.png') });
await page.keyboard.up('w');

const moved = Math.hypot(endPos[0] - startPos[0], endPos[2] - startPos[2]);
check('car accelerates', plainPeak > 45, `peak ${plainPeak.toFixed(0)} km/h`);
check('car moves through the world', moved > 20, `${moved.toFixed(0)} m travelled`);

// ── same run, with boost ──
await quitToMenu();
await startSolo();
await peakStart();
await page.keyboard.down('w');
await page.keyboard.down('Shift');
await page.waitForTimeout(2600);
const boostPeak = await peakRead();
await page.keyboard.up('Shift');
await page.keyboard.up('w');
check('boost is faster', boostPeak > plainPeak + 8,
  `${plainPeak.toFixed(0)} -> ${boostPeak.toFixed(0)} km/h from the same spawn`);

// ── jump, flip and land a trick ──
await quitToMenu();
await page.click('.car-card[data-car="hornet"]');
await startSolo();
await page.keyboard.down('w');
await page.waitForTimeout(1800);
const airborneSeen = [];
let comboSeen = [];
// jump then flip-dash: the dash adds ~9 rad/s of pitch, so a front flip
// completes well inside the hornet's hang time
for (let attempt = 0; attempt < 4; attempt++) {
  await page.keyboard.press('Space');
  await page.waitForTimeout(90);
  await page.keyboard.press('Space');
  await page.waitForTimeout(680);
  const mid = await page.evaluate(() => ({
    air: window.__wp.airborne(),
    labels: window.__wp.comboLabels(),
  }));
  airborneSeen.push(mid.air);
  if (mid.labels.length > comboSeen.length) comboSeen = mid.labels;
  if (attempt === 1) await page.screenshot({ path: join(SHOTS, '5-air.png') });
  await page.waitForTimeout(1600);
}
await page.keyboard.up('w');
await page.waitForTimeout(500);
const trickScore = await page.evaluate(() => window.__wp.trickScore());

check('jump leaves the ground', airborneSeen.some(Boolean));
check('tricks are detected in flight', comboSeen.length > 0, comboSeen.slice(0, 6).join(', '));
// Whether a combo BANKS depends on landing it, which is genuinely stochastic
// with scripted key presses. tools/tricktest.mjs covers banking, bailing and
// multipliers deterministically; here it is reported, not asserted.
console.log(`  info  banked this run: ${trickScore} points`);

// ── crashing hurts ──
await quitToMenu();
await startSolo();
const healthBefore = await page.evaluate(() => window.__wp.health());
await page.keyboard.down('w');
await page.keyboard.down('Shift');
await page.waitForTimeout(5200);               // run out of runway into the wall
await page.keyboard.up('Shift');
await page.keyboard.up('w');
await page.waitForTimeout(600);
const healthAfter = await page.evaluate(() => window.__wp.health());
check('crashing damages the car', healthAfter < healthBefore,
  `${healthBefore.toFixed(0)} -> ${healthAfter.toFixed(0)} hull`);
await page.screenshot({ path: join(SHOTS, '7-damage.png') });

// frame rate under load
const fps = await page.evaluate(() => new Promise((res) => {
  let n = 0;
  const t0 = performance.now();
  const tick = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(tick); else res(n); };
  requestAnimationFrame(tick);
}));
check('renders at a playable frame rate', fps >= 30, `${fps} fps at 1440x900`);

await page.keyboard.press('Escape');
await page.waitForTimeout(400);
const paused = await page.evaluate(() => document.getElementById('pause').classList.contains('active'));
check('escape opens the pause menu', paused);
await page.screenshot({ path: join(SHOTS, '6-pause.png') });

// ── errors ──
console.log('\n── console ──');
const ignorable = /WEBGL_debug_renderer_info|Failed to load resource.*favicon|Autoplay/i;
const real = errors.filter((e) => !ignorable.test(e));
check('no console errors', real.length === 0, real.slice(0, 6).join(' | '));

await browser.close();
stop();

console.log(`\nscreenshots in ${SHOTS}`);
console.log(`${failures === 0 ? 'browsertest: ALL PASS' : `browsertest: ${failures} FAILURE(S)`}\n`);
if (failures) console.log('server log:\n' + serverLog);
process.exit(failures ? 1 : 0);
