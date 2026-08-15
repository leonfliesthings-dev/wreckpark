/**
 * Plays a complete round to the results screen and checks the payout.
 * Rounds are shortened via WRECKPARK_ROUND so this finishes in seconds.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOTS = join(ROOT, 'shots');
mkdirSync(SHOTS, { recursive: true });
const PORT = 8095;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
  if (!ok) failures++;
};

const server = spawn('node', [join(ROOT, 'server', 'server.js')],
  { env: { ...process.env, PORT: String(PORT), WRECKPARK_ROUND: '12' }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
process.on('exit', () => { try { server.kill('SIGTERM'); } catch {} });
await new Promise((r) => setTimeout(r, 1200));

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--mute-audio'] });
const errors = [];

async function client(name, car) {
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 780 } })).newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => document.getElementById('menu')?.classList.contains('active'), { timeout: 45000 });
  await page.fill('#name-input', name);
  await page.click(`.car-card[data-car="${car}"]`);
  return page;
}

console.log('\n── a full derby round ──');
const a = await client('ALICE', 'ripsaw');
const b = await client('BOB', 'volt');

const scrapBefore = await a.evaluate(() => JSON.parse(localStorage.getItem('wreckpark.profile.v1') || '{}').scrap ?? 0);

await a.click('#btn-host');
await a.waitForFunction(() => document.getElementById('lobby')?.classList.contains('active'), { timeout: 15000 });
const room = await a.textContent('#room-code');
await b.fill('#join-code', room);
await b.click('#btn-join');
await b.waitForFunction(() => document.getElementById('lobby')?.classList.contains('active'), { timeout: 15000 });
await a.waitForTimeout(900);

await a.click('#btn-ready');
await b.click('#btn-ready');
await a.waitForFunction(() => window.__wp.phase() === 'live', { timeout: 25000 });
check('round went live', true);

// drive around for the round
await a.keyboard.down('w');
await b.keyboard.down('w');
await a.waitForTimeout(3000);
await a.keyboard.down('Shift');
await a.waitForTimeout(3000);
await a.keyboard.up('Shift');
await a.keyboard.up('w');
await b.keyboard.up('w');

await a.waitForFunction(() => document.getElementById('results')?.classList.contains('active'), { timeout: 30000 })
  .catch(() => {});
const resultsUp = await a.evaluate(() => document.getElementById('results').classList.contains('active'));
check('results screen appears when the timer runs out', resultsUp);

if (resultsUp) {
  const rows = await a.locator('.result-row').count();
  check('results list both players', rows === 2, `${rows} rows`);
  const rewardText = await a.textContent('#results-rewards');
  check('scrap is itemised', /SCRAP EARNED/i.test(rewardText || ''), (rewardText || '').replace(/\s+/g, ' ').trim().slice(0, 90));
  await a.screenshot({ path: join(SHOTS, '10-results.png') });

  const scrapAfter = await a.evaluate(() => JSON.parse(localStorage.getItem('wreckpark.profile.v1') || '{}').scrap ?? 0);
  check('scrap is banked to the profile', scrapAfter > scrapBefore, `${scrapBefore} -> ${scrapAfter}`);

  await a.click('#results-continue');
  await a.waitForTimeout(800);
  const backToLobby = await a.evaluate(() => document.getElementById('lobby').classList.contains('active'));
  check('continue returns to the lobby for another round', backToLobby);
}

check('no client errors', errors.length === 0, errors.slice(0, 4).join(' | '));

await browser.close();
server.kill('SIGTERM');
console.log(`\n${failures === 0 ? 'roundtest: ALL PASS' : `roundtest: ${failures} FAILURE(S)`}\n`);
if (failures) console.log('server log:\n' + serverLog);
process.exit(failures ? 1 : 0);
