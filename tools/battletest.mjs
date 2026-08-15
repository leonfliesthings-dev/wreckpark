/**
 * Single-player combat: bots, weapons and countermeasures.
 * Runs a shortened bot derby and checks that the fight actually happens.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOTS = join(ROOT, 'shots');
mkdirSync(SHOTS, { recursive: true });
const PORT = 8087;

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
const page = await browser.newPage({ viewport: { width: 1400, height: 880 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`http://localhost:${PORT}/?round=45`);
await page.waitForFunction(() => document.getElementById('menu')?.classList.contains('active'), { timeout: 60000 });

console.log('\n── single player vs bots ──');
const soloLabel = await page.textContent('#solo-label');
check('solo button offers a bot battle', /BATTLE \d BOTS/.test(soloLabel || ''), soloLabel);

await page.click('.car-card[data-car="ripsaw"]');
await page.click('#btn-solo');
await page.waitForFunction(() => window.__wp.soloPhase() === 'live', { timeout: 25000 });
await page.waitForTimeout(1200);

const bots = await page.evaluate(() => window.__wp.bots());
check('bots spawn', bots.length === 3, bots.map((b) => `${b.name}(${b.car})`).join(' '));
check('bots start healthy', bots.every((b) => b.health === 100));

const arms0 = await page.evaluate(() => window.__wp.arms());
check('car has a weapon and a countermeasure', !!arms0?.weapon && !!arms0?.counter,
  `${arms0?.weapon} + ${arms0?.counter}`);

// ── fight ──
console.log('\n── the fight ──');
await page.keyboard.down('w');
let firedShots = 0;
for (let i = 0; i < 14; i++) {
  await page.keyboard.press('f');
  await page.waitForTimeout(320);
  const live = await page.evaluate(() => window.__wp.projectiles());
  if (live > 0) firedShots++;
  if (i === 6) await page.keyboard.press('g');       // drop a countermeasure
  if (i === 9) await page.screenshot({ path: join(SHOTS, '17-battle.png') });
}
await page.keyboard.up('w');

const arms1 = await page.evaluate(() => window.__wp.arms());
check('firing uses ammo', arms1.ammo < arms0.ammo, `${arms0.ammo} -> ${arms1.ammo}`);
check('projectiles exist in the world', firedShots > 0, `seen live on ${firedShots} samples`);
check('countermeasure was deployed', arms1.charges < arms0.charges, `${arms0.charges} -> ${arms1.charges} charges`);

// let the bots have a go at each other and at us
await page.waitForTimeout(9000);
const bots2 = await page.evaluate(() => window.__wp.bots());
const myHealth = await page.evaluate(() => window.__wp.health());
const someoneHurt = bots2.some((b) => b.health < 100) || myHealth < 100;
check('the fight does damage', someoneHurt,
  `bots ${bots2.map((b) => Math.round(b.health)).join('/')}, you ${Math.round(myHealth)}`);

const botsMoved = await page.evaluate(() => window.__wp.bots().length > 0);
check('bots are still driving', botsMoved);

const fps = await page.evaluate(() => new Promise((res) => {
  let n = 0; const t0 = performance.now();
  const tick = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(tick); else res(n); };
  requestAnimationFrame(tick);
}));
check('still runs fast with 4 cars and weapons', fps >= 30, `${fps} fps`);

// ── it ends ──
await page.waitForFunction(() => document.getElementById('results')?.classList.contains('active'), { timeout: 70000 });
const rows = await page.locator('.result-row').count();
check('round ends with everyone on the scoreboard', rows === 4, `${rows} rows`);
await page.screenshot({ path: join(SHOTS, '18-battle-results.png') });

check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.kill('SIGTERM');
console.log(`\n${failures === 0 ? 'battletest: ALL PASS' : `battletest: ${failures} FAILURE(S)`}\n`);
process.exit(failures ? 1 : 0);
