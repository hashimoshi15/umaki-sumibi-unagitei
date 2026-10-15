// Build the static site.
//   node tools/build.mjs          → ../outputs/unagi-web (minified, for publishing)
//   node tools/build.mjs --dev    → ../work/dev (readable, with source maps, for testing)
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GAME = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dev = process.argv.includes('--dev');
const out = path.resolve(GAME, dev ? '../work/dev' : '../outputs/unagi-web');
const pkg = JSON.parse(fs.readFileSync(path.join(GAME, 'package.json'), 'utf8'));
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
const build = `${pkg.version}-${stamp}`;

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const res = await esbuild.build({
  entryPoints: [path.join(GAME, 'src/main.js')],
  bundle: true,
  format: 'iife',
  target: ['es2020', 'safari15', 'chrome90', 'firefox90'],
  minify: !dev,
  sourcemap: dev ? 'linked' : false,
  legalComments: 'eof',
  define: { 'process.env.NODE_ENV': dev ? '"development"' : '"production"' },
  outfile: path.join(out, 'game.js'),
  metafile: true,
  logLevel: 'warning',
});

const copy = (rel) => {
  const src = path.join(GAME, rel), dst = path.join(out, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
};
copy('style.css');
copy('manifest.webmanifest');
copy('assets');
fs.copyFileSync(path.join(GAME, 'node_modules/three/LICENSE'), path.join(out, 'THREE-LICENSE.txt'));
let html = fs.readFileSync(path.join(GAME, 'index.html'), 'utf8');
html = html.replace('href="style.css"', `href="style.css?v=${build}"`).replace('src="game.js"', `src="game.js?v=${build}"`);
fs.writeFileSync(path.join(out, 'index.html'), html);

// sanity checks: every referenced local file exists, nothing points off-site
const problems = [];
for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const ref = m[1].split('?')[0];
  if (/^https?:/.test(ref)) problems.push('external reference ' + ref);
  else if (!fs.existsSync(path.join(out, ref))) problems.push('missing ' + ref);
}
const css = fs.readFileSync(path.join(out, 'style.css'), 'utf8');
for (const m of css.matchAll(/url\('([^']+)'\)/g)) if (!fs.existsSync(path.join(out, m[1]))) problems.push('missing ' + m[1]);
const js = fs.readFileSync(path.join(out, 'game.js'), 'utf8');
for (const m of js.matchAll(/assets\/umaki\/'\s*\+|'assets\/[a-z0-9/_.-]+'/g)) {
  const ref = m[0].replace(/'/g, '');
  if (ref.endsWith('+')) continue;
  if (!fs.existsSync(path.join(out, ref))) problems.push('missing ' + ref);
}
for (const pose of ['idle', 'happy', 'wow', 'cheer', 'hero']) if (!fs.existsSync(path.join(out, 'assets/umaki', pose + '.webp'))) problems.push('missing pose ' + pose);
if (!dev) {
  // URLs inside GLSL comments of three.js shaders are text, not requests: ignore those
  const bad = [];
  for (const m of js.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
    const lineStart = js.lastIndexOf('\n', m.index) + 1;
    const before = js.slice(Math.max(lineStart, m.index - 120), m.index);
    if (/\/\/[^"'`]*$/.test(before)) continue;
    if (['www.w3.org'].includes(m[1])) continue;
    bad.push(m[1]);
  }
  if (bad.length) problems.push('URLs in bundle: ' + [...new Set(bad)].join(', '));
}

const size = (p) => fs.statSync(path.join(out, p)).size;
let total = 0;
const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else total += fs.statSync(p).size; } };
walk(out);
console.log(JSON.stringify({ out, build, gameJs: size('game.js'), total, problems }, null, 1));
if (problems.length) process.exit(1);
void res;
