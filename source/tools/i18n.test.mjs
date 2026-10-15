#!/usr/bin/env node
// Dictionary checks: every language has exactly the Japanese keys, the same {placeholders}, the same
// HTML tags and the same [first, repeat] shape; every key used in the source and index.html exists;
// the region list is complete; nickname validation.   node tools/i18n.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const GAME = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const load = async (f) => (await import(path.join(GAME, 'src/i18n', f))).default;
const ja = await load('ja.js');
const langs = { en: await load('en.js'), ko: await load('ko.js'), 'zh-Hans': await load('zh-Hans.js'), 'zh-Hant': await load('zh-Hant.js') };
let problems = 0;
const bad = (m) => { problems++; console.log('  ✗ ' + m); };
const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const tags = (s) => [...String(s).matchAll(/<\/?(\w+)/g)].map((m) => m[0]).sort().join(',');

for (const [id, d] of Object.entries(langs)) {
  for (const k of Object.keys(ja)) {
    if (!(k in d)) { bad(`${id}: missing ${k}`); continue; }
    const a = ja[k], b = d[k];
    if (Array.isArray(a) !== Array.isArray(b) || (Array.isArray(a) && a.length !== b.length)) { bad(`${id}: ${k} shape`); continue; }
    const as = Array.isArray(a) ? a : [a], bs = Array.isArray(b) ? b : [b];
    as.forEach((x, i) => {
      if (ph(x) !== ph(bs[i])) bad(`${id}: ${k}[${i}] placeholders ${ph(x)} vs ${ph(bs[i])}`);
      if (tags(x) !== tags(bs[i])) bad(`${id}: ${k}[${i}] tags ${tags(x)} vs ${tags(bs[i])}`);
      if (!String(bs[i]).trim()) bad(`${id}: ${k}[${i}] empty`);
    });
  }
  for (const k of Object.keys(d)) if (!(k in ja)) bad(`${id}: extra key ${k}`);
}

// keys referenced from the code and the page
const used = new Set();
const scan = [path.join(GAME, 'index.html')];
for (const dir of ['src', 'src/model', 'src/view']) for (const f of fs.readdirSync(path.join(GAME, dir))) if (f.endsWith('.js')) scan.push(path.join(GAME, dir, f));
for (const f of scan) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/data-i18n(?:-html|-aria|-alt|-ph|-title)?="([\w.]+)"/g)) used.add(m[1]);
  for (const m of s.matchAll(/\b(?:t|tr)\(\s*'([\w.]+)'\s*[,)]/g)) used.add(m[1]);
}
for (const k of used) if (!(k in ja)) bad(`used but not in ja: ${k}`);
// no Japanese left hard-coded in the UI code (comments excluded)
for (const f of scan.filter((p) => /src[\\/](ui|main|hud)\.js$/.test(p))) {
  fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    if (/[\u3041-\u3096\u30a1-\u30fa]/.test(code)) bad(`${path.basename(f)}:${i + 1} Japanese in code: ${line.trim().slice(0, 80)}`);
  });
}

// regions and nicknames (the browser-side helpers run fine in node: Intl is there)
globalThis.document = undefined;
const I = await import(path.join(GAME, 'src/i18n.js'));
assert.equal(I.REGIONS.length, 249, 'ISO 3166-1 alpha-2: 249 codes');
assert.equal(new Set(I.REGIONS).size, 249, 'no duplicate codes');
for (const l of ['ja', 'en', 'ko', 'zh-Hans', 'zh-Hant']) {
  const R = I.regionList(l);
  assert.equal(R.items.length, 249);
  const jp = R.byCode.JP;
  assert.ok(jp && jp !== 'JP', `${l}: Japan has a name (${jp})`);
  console.log(`  ${l}: JP=${jp} KR=${R.byCode.KR} TW=${R.byCode.TW} US=${R.byCode.US}`);
}
assert.equal(I.checkNick(''), 'err.nickEmpty');
assert.equal(I.checkNick('   \u3000 '), 'err.nickEmpty');
assert.equal(I.checkNick('\u0007\u202e'), 'err.nickEmpty');
assert.equal(I.checkNick('うなぎ'), '');
assert.equal(I.checkNick('👨‍👩‍👧‍👦'.repeat(12)), '', '12 family emoji are 12 characters');
assert.equal(I.checkNick('a'.repeat(13)), 'err.nickLong');
assert.equal(I.cleanNick('  ab  \t cd '), 'ab cd');
assert.equal(I.detect(['zh-TW']), 'zh-Hant');
assert.equal(I.detect(['zh-HK']), 'zh-Hant');
assert.equal(I.detect(['zh-CN']), 'zh-Hans');
assert.equal(I.detect(['ko-KR']), 'ko');
assert.equal(I.detect(['fr-FR', 'ja']), 'ja');
assert.equal(I.detect(['fr-FR']), 'en');

console.log(`keys ${Object.keys(ja).length}, used ${used.size}, problems ${problems}`);
if (problems) process.exit(1);
console.log('ok');
