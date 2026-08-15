/**
 * Guards against wrong-script characters sneaking into source files — the
 * Cyrillic/CJK homoglyphs that look fine in a diff and break a string compare.
 *
 * Emoji, box drawing and typographic punctuation are all deliberate and fine,
 * so this checks for specific suspicious script blocks rather than "not ASCII".
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXTS = new Set(['.js', '.mjs', '.css', '.html', '.json', '.md']);
const SKIP = new Set(['node_modules', 'dist', '.git']);

const SUSPICIOUS = [
  [0x0370, 0x03ff, 'Greek'],
  [0x0400, 0x04ff, 'Cyrillic'],
  [0x0500, 0x052f, 'Cyrillic supplement'],
  [0x0530, 0x058f, 'Armenian'],
  [0x0590, 0x05ff, 'Hebrew'],
  [0x0600, 0x06ff, 'Arabic'],
  [0x2e80, 0x9fff, 'CJK'],
  [0xa000, 0xa4cf, 'Yi'],
  [0xac00, 0xd7af, 'Hangul'],
  [0xff00, 0xffef, 'Fullwidth forms'],
];

function scriptOf(cp) {
  for (const [lo, hi, name] of SUSPICIOUS) if (cp >= lo && cp <= hi) return name;
  return null;
}

const bad = [];

function scanFile(p) {
  const lines = readFileSync(p, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const found = new Map();
    for (const ch of line) {
      const s = scriptOf(ch.codePointAt(0));
      if (s) found.set(ch, s);
    }
    if (found.size) {
      const detail = [...found].map(([c, s]) => `"${c}" (${s})`).join(', ');
      bad.push(`${relative(ROOT, p)}:${i + 1}  ${detail}\n      ${line.trim().slice(0, 90)}`);
    }
  });
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (EXTS.has(extname(p))) scanFile(p);
  }
}

walk(join(ROOT, 'src'));
walk(join(ROOT, 'server'));
walk(join(ROOT, 'tools'));
scanFile(join(ROOT, 'index.html'));

if (bad.length) {
  console.error(`charcheck: ${bad.length} wrong-script character(s) found:\n  ` + bad.join('\n  '));
  process.exit(1);
}
console.log('charcheck: clean');
