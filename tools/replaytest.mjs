/**
 * Solo Trick Battle: takes a timed run, checks the score is banked as a
 * personal best with a stored replay, then watches the replay back and
 * confirms the car actually retraces the run.
 *
 * Runs are shortened with ?round=N so this finishes in seconds.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOTS = join(ROOT, 'shots');
mkdirSync(SHOTS, { recursive: true });
const PORT = 8094;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
  if (!ok) failures++;
};

const server = spawn('node', [join(ROOT, 'server', 'server.js')],
  { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
process.on('exit', () => { try { server.kill('SIGTERM'); } catch {} });
await new Promise((r) => setTimeout(r, 1200));

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`http://localhost:${PORT}/?round=26`);
await page.waitForFunction(() => document.getElementById('menu')?.classList.contains('active'), { timeout: 45000 });
await page.fill('#name-input', 'SOLO');

console.log('\n── trick battle is playable alone ──');
const emptyBest = await page.textContent('#best-run');
check('no personal best to start with', /No trick run recorded/i.test(emptyBest || ''));

await page.click('.mode-btn[data-mode="tricks"]');
await page.waitForTimeout(300);
const soloLabel = await page.textContent('#solo-label');
check('solo button switches to a trick run', /SOLO TRICK RUN/i.test(soloLabel || ''), soloLabel);
await page.screenshot({ path: join(SHOTS, '11-trickmode.png') });

await page.click('.car-card[data-car="hornet"]');
await page.click('#btn-solo');
await page.waitForTimeout(600);
const phase0 = await page.evaluate(() => window.__wp.soloPhase());
check('run starts with a countdown', phase0 === 'countdown', `phase=${phase0}`);

await page.waitForFunction(() => window.__wp.soloPhase() === 'live', { timeout: 12000 });
check('countdown hands over to a live run', true);

// drive and throw some tricks
await page.keyboard.down('w');
await page.waitForTimeout(1500);
// jump + flip-dash; not every attempt sticks the landing, which is the point
for (let i = 0; i < 8; i++) {
  const live = await page.evaluate(() => window.__wp.soloPhase() === 'live');
  if (!live) break;
  await page.keyboard.press('Space');
  await page.waitForTimeout(90);
  await page.keyboard.press('Space');
  await page.waitForTimeout(680);
  await page.waitForTimeout(1450);
}
await page.keyboard.up('w');

await page.waitForFunction(() => document.getElementById('results')?.classList.contains('active'), { timeout: 30000 });
check('run ends on the results screen', true);
await page.screenshot({ path: join(SHOTS, '12-runresults.png') });

const best = await page.evaluate(() => window.__wp.bestRun());
check('personal best saved', best && best.score > 0, best ? `${best.score} pts, ${best.frames} frames, ~${best.kb} KB` : 'nothing saved');
check('replay was recorded', best && best.frames > 100, best ? `${best.frames} frames` : '');

const replayBtnVisible = await page.evaluate(() => {
  const b = document.getElementById('results-replay');
  return b && b.style.display !== 'none';
});
check('results offers the replay', replayBtnVisible);

console.log('\n── watching it back ──');
await page.click('#results-replay');
await page.waitForTimeout(1200);
const barUp = await page.evaluate(() => document.getElementById('replay-bar').classList.contains('active'));
check('replay overlay appears', barUp);

// Accumulate path length rather than start-to-end distance: the recorded run
// includes jumps and crashes, so the car can end up near where it started.
let travelled = 0;
let prev = await page.evaluate(() => window.__wp.replayPos());
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(250);
  const now = await page.evaluate(() => window.__wp.replayPos());
  if (prev && now) travelled += Math.hypot(now[0] - prev[0], now[1] - prev[1], now[2] - prev[2]);
  prev = now;
}
const t1 = await page.evaluate(() => window.__wp.replayTime());
check('replay car retraces the run', travelled > 20, `${travelled.toFixed(0)} m of path replayed`);
check('replay clock advances', t1 > 4, `t=${t1.toFixed(1)} s`);
await page.screenshot({ path: join(SHOTS, '13-replay.png') });

// restart and exit
await page.keyboard.press('Space');
await page.waitForTimeout(400);
const tRestart = await page.evaluate(() => window.__wp.replayTime());
check('space restarts the replay', tRestart < 1.5, `t=${tRestart.toFixed(2)} s`);

await page.keyboard.press('Escape');
await page.waitForTimeout(600);
const backAtResults = await page.evaluate(() => document.getElementById('results').classList.contains('active'));
check('escape returns to where you came from', backAtResults);

console.log('\n── best run is watchable from the menu ──');
await page.click('#results-continue');
await page.waitForTimeout(700);
const menuBest = await page.textContent('#best-run');
check('menu shows the personal best', !/No trick run recorded/i.test(menuBest || ''),
  (menuBest || '').replace(/\s+/g, ' ').trim().slice(0, 60));
await page.screenshot({ path: join(SHOTS, '14-bestrun.png') });

await page.click('#btn-watch-best');
await page.waitForTimeout(1200);
const barAgain = await page.evaluate(() => document.getElementById('replay-bar').classList.contains('active'));
check('watch button replays from the menu', barAgain);
await page.keyboard.press('Escape');
await page.waitForTimeout(600);
const backAtMenu = await page.evaluate(() => document.getElementById('menu').classList.contains('active'));
check('escape returns to the menu', backAtMenu);

// a second, worse run must not overwrite the best
console.log('\n── the best run is the one that is kept ──');
const before = await page.evaluate(() => window.__wp.bestRun());
await page.click('#btn-solo');
await page.waitForFunction(() => window.__wp.soloPhase() === 'live', { timeout: 12000 });
await page.waitForFunction(() => document.getElementById('results')?.classList.contains('active'), { timeout: 30000 });
const after = await page.evaluate(() => window.__wp.bestRun());
check('a worse run does not replace the best', after.score >= before.score,
  `${before.score} kept vs new run`);

check('no console errors', errors.length === 0, errors.slice(0, 4).join(' | '));

await browser.close();
server.kill('SIGTERM');
console.log(`\n${failures === 0 ? 'replaytest: ALL PASS' : `replaytest: ${failures} FAILURE(S)`}\n`);
process.exit(failures ? 1 : 0);
