/**
 * One command to play with friends anywhere: opens a Cloudflare tunnel, waits
 * for the public address, then starts the game server already knowing that
 * address so the lobby hands out a link that actually works.
 *
 * Cloudflare rather than ngrok on purpose — ngrok's free tier puts a browser
 * warning page in front of the game (ERR_NGROK_6024), which just looks broken
 * to whoever you sent the link to.
 */
import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = process.env.PORT || '8080';

function have(cmd) {
  try { execSync(`command -v ${cmd}`, { stdio: 'ignore' }); return true; } catch { return false; }
}

if (!existsSync(join(ROOT, 'dist'))) {
  console.log('Building the client first...');
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
}

if (!have('cloudflared')) {
  console.error(`
  cloudflared is not installed. It is free and needs no account:

      brew install cloudflared

  Then run this again.  (Or use "npm start" for same-wifi play only.)
`);
  process.exit(1);
}

console.log('\n  Opening a public tunnel...');
const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

let publicUrl = null;
let server = null;

function onTunnelOutput(chunk) {
  const text = chunk.toString();
  const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (match && !publicUrl) {
    publicUrl = match[0];
    startServer();
  }
}
tunnel.stdout.on('data', onTunnelOutput);
tunnel.stderr.on('data', onTunnelOutput);

function startServer() {
  server = spawn('node', [join(ROOT, 'server', 'server.js')], {
    env: { ...process.env, PORT, PUBLIC_URL: publicUrl },
    stdio: 'inherit',
  });
  server.on('exit', shutdown);

  setTimeout(() => {
    const line = '  ' + '='.repeat(publicUrl.length + 10);
    console.log(`\n${line}`);
    console.log(`     SEND YOUR FRIENDS THIS LINK`);
    console.log(`     ${publicUrl}`);
    console.log(`${line}`);
    console.log('\n  It works from anywhere - no wifi, no accounts, no install.');
    console.log('  Keep this window open. Ctrl+C stops the game and the link.\n');
  }, 900);
}

const timeout = setTimeout(() => {
  if (!publicUrl) {
    console.error('  Could not get a tunnel address. Check your internet connection.');
    shutdown(1);
  }
}, 45000);

let closing = false;
function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  clearTimeout(timeout);
  try { tunnel.kill('SIGTERM'); } catch { /* already gone */ }
  try { server?.kill('SIGTERM'); } catch { /* already gone */ }
  process.exit(typeof code === 'number' ? code : 0);
}

process.on('SIGINT', () => { console.log('\n  Shutting down.'); shutdown(0); });
process.on('SIGTERM', () => shutdown(0));
tunnel.on('exit', () => { if (!closing) { console.error('  Tunnel closed.'); shutdown(1); } });
