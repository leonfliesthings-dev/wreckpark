/**
 * Look development: loads the game, parks the car at a set of fixed vantage
 * points and screenshots each one, so successive art passes can be compared
 * like for like.
 *
 *   node tools/look.mjs <tag>
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TAG = process.argv[2] || 'look';
const OUT = join(ROOT, 'shots', 'look');
mkdirSync(OUT, { recursive: true });
const PORT = 8086;

// x, y, z, yaw, name — chosen to show off different bits of the park
const VIEWS = [
  [30, 0.5, -6, Math.PI / 2, 'loop'],
  [-40, 0.5, 6, Math.PI / 2, 'corkscrew'],
  [-32, 0.5, 30, Math.PI, 'halfpipe'],
  [0, 0.5, 20, Math.PI, 'dish'],
  [46, 0.5, 20, -Math.PI / 2, 'vertwall'],
  [-20, 0.5, -60, 0, 'tower'],
  [40, 0.5, -40, 2.2, 'car'],
];

const server = spawn('node', [join(ROOT, 'server', 'server.js')],
  { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
process.on('exit', () => { try { server.kill('SIGTERM'); } catch {} });
await new Promise((r) => setTimeout(r, 1200));

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--use-angle=metal', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`http://localhost:${PORT}/`);
await page.waitForFunction(() => document.getElementById('menu')?.classList.contains('active'), { timeout: 60000 });

// The menu orbits the showcase car — hide the overlay and shoot each car in
// turn, which is the only clean look at the bodywork.
for (const car of ['ripsaw', 'hornet', 'mauler', 'volt']) {
  await page.click(`.car-card[data-car="${car}"]`);
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    document.querySelectorAll('.screen').forEach((e) => e.classList.remove('active'));
    window.__wp.carCam(6.2, 2.2, 0.85);
  });
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT, `${TAG}-CAR-${car}.png`) });
  await page.evaluate(() => { window.__wp.carCamOff(); document.getElementById('menu').classList.add('active'); });
  await page.waitForTimeout(200);
}
await page.click('.car-card[data-car="ripsaw"]');

// bots off, straight into free roam
for (let i = 0; i < 6; i++) {
  const l = await page.textContent('#btn-bots');
  if (/OFF/.test(l || '')) break;
  await page.click('#btn-bots');
  await page.waitForTimeout(100);
}
await page.click('#btn-solo');
await page.waitForTimeout(2500);
await page.evaluate(() => window.__wp.freeze(true));

for (const [x, y, z, yaw, name] of VIEWS) {
  await page.evaluate(([a, b, c, d]) => window.__wp.pose(a, b, c, d), [x, y, z, yaw]);
  if (name === 'car') {
    // swing to the close chase camera so the bodywork fills the frame
    await page.keyboard.press('KeyC');
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT, `${TAG}-${name}.png`) });
}

const fps = await page.evaluate(() => new Promise((res) => {
  let n = 0; const t0 = performance.now();
  const tick = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(tick); else res(n); };
  requestAnimationFrame(tick);
}));
console.log(`${TAG}: ${VIEWS.length} views, ${fps} fps`);
if (errors.length) console.log('errors:', errors.slice(0, 3));
await browser.close();
server.kill('SIGTERM');
