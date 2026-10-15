// Model-level check: simulated cooks with different habits must get clearly different, sensible results.
// Drives the pure game model through its input API (no browser). Real-input play tests run in the browser.
//   node tools/sim.test.mjs [--verbose]
import assert from 'node:assert/strict';
import { Game, FLESH, SKIN, TICKS } from '../src/model/game.js';
import { BOX, FISH, STATIONS } from '../src/config.js';

const DT = 1 / 60;
const L = FISH.L;
const verbose = process.argv.includes('--verbose');

function run(g, until, max, each) {
  for (let t = 0; t < max && !until(); t += DT) {
    if (each) each(t);
    g.update(DT);
  }
}
const meanD = (g, f) => g.fish.faceStats(f).dMean;
const wait = (g, s) => run(g, () => false, s);
function flipNow(g) { g.flip(); run(g, () => g.grill.flipping === 0, 2); }

export function play(style, order = null) {
  const g = new Game(order);
  // 捌く
  let u = 0.2;
  assert.ok(g.knifeDown(u, style.cutW(u), g.time));
  const v = (L + 0.6) / style.cutT;
  run(g, () => g.step !== 'cut', 30, () => { u += v * DT; g.knifeMove(u, style.cutW(u), g.time); });
  g.knifeUp();
  assert.equal(g.step, 'open');
  g.openDown(L / 2, 0, g.time);
  let w = 0;
  run(g, () => g.step !== 'open', 5, () => { w += 12 * DT; g.openMove(L / 2, w, g.time); });
  g.openUp();
  run(g, () => g.step !== 'open', 3);
  assert.equal(g.step, 'bone');
  u = 0.4;
  assert.ok(g.boneDown(u, 0, g.time));
  run(g, () => g.step !== 'bone', 30, () => { u += ((L + 0.5) / style.boneT) * DT; g.boneMove(u, style.boneW || 0, g.time); });
  assert.equal(g.step, 'skewer');
  for (const s of style.skewers) g.skewerTap(s, 0);
  assert.ok(g.toGrill());
  run(g, () => g.step !== 'toGrill', 5);
  assert.equal(g.step, 'white');
  style.white(g);
  assert.ok(g.toTare(), 'can move on to tare');
  style.tare(g);
  assert.ok(g.toBoard(), 'can serve');
  run(g, () => g.step !== 'toBoard', 5);
  for (const s of [...g.fish.skewers]) g.unskewerTap(s);
  assert.equal(g.step, 'slice');
  for (const c of style.cuts) {
    g.sliceDown(c, -6);
    for (let k = 0; k <= 12; k++) g.sliceMove(c, -6 + k);
    g.sliceUp();
  }
  assert.equal(g.step, 'plate');
  g.fish.pieces.forEach((p, k) => {
    assert.ok(g.grabPiece(k));
    const d = style.drop(k);
    g.dropPiece(d.x, d.z, d.vx, d.vz);
  });
  assert.equal(g.step, 'finish');
  g.finish();
  assert.equal(g.step, 'result');
  return g;
}

// white-grill in the middle band, turning each time the down face gains ~0.2 (what the flip hint asks for)
function whiteCareful(g, zone = 0, target = 0.85, gain = 0.2) {
  g.moveFish(0, zone - g.grill.fishZ);
  for (let n = 0; n < 12; n++) {
    const f = g.grill.down;
    const start = meanD(g, f);
    run(g, () => meanD(g, f) >= start + gain, 30);
    flipNow(g);
    if (meanD(g, FLESH) >= target && meanD(g, SKIN) >= target) break;
  }
}

const T = STATIONS.tare;
// one dip: lift the fish, carry it over the trough (head-end x, centre z), keep it under for `hold`
// seconds once it is right under, lift it out, let it drip and put it back on the coals
function dip(g, { hold = 0.5, x = T.x - L / 2, z = T.z, touch = false, drip = 0.4, back = true } = {}) {
  const G = g.grill;
  const gx = G.fishX, gz = G.fishZ;
  assert.ok(g.grabFish(), 'lift the fish');
  for (let k = 1; k <= 12; k++) { g.moveCarry(gx + ((x - gx) * k) / 12, gz + ((z - gz) * k) / 12); g.update(DT); }
  if (touch) run(g, () => g.dip.depth >= 0.55, 2);
  else { run(g, () => g.dip.depth >= 1, 2); wait(g, hold); }
  if (!back) return;
  for (let k = 1; k <= 12; k++) { g.moveCarry(x + ((gx - x) * k) / 12, z + ((gz - z) * k) / 12); g.update(DT); }
  wait(g, drip);
  g.releaseFish();
}
// let the tare set: the face on the coals until its wet coat is gone, then the other face
function setCoat(g, maxEach = 9) {
  for (let n = 0; n < 2; n++) {
    const f = g.grill.down;
    run(g, () => g.fish.faceStats(f).wet < 0.1, maxEach);
    flipNow(g);
  }
}
function tareCareful(g, opts = {}) {
  for (let r = 0; r < (opts.rounds ?? 2); r++) {
    dip(g, opts.dip || {});
    setCoat(g);
    wait(g, 1);
  }
}

const neat = (k) => ({ x: BOX.slots[k].x + 0.2, z: 0.1, vx: 8, vz: 0 });
const careLine = (u) => 0.08 * Math.sin((2 * Math.PI * u) / 30);
const base = { cutT: 2.7 * (L / 40), cutW: careLine, boneT: 2.0 * (L / 40), skewers: TICKS, white: (g) => whiteCareful(g), tare: (g) => tareCareful(g), cuts: [L / 3, (2 * L) / 3], drop: neat };

const STYLES = {
  careful: { ...base },
  miscut: { ...base, cutT: 1.35 * (L / 40), cutW: (u) => 0.4 + 0.9 * Math.sin((2 * Math.PI * u) / 5) },
  burnt: { ...base, white: (g) => { g.moveFish(0, -6.5); if (g.grill.down !== FLESH) flipNow(g); wait(g, 22); g.moveFish(0, 6.5); whiteCareful(g); } },
  // 短い片側浸し: only touches the tare, half of the fish off the end of the trough
  patchy: { ...base, tare: (g) => { for (let r = 0; r < 2; r++) { dip(g, { touch: true, x: T.x + T.inner.x - L * 0.55 }); setCoat(g); wait(g, 5); } } },
  // 浸し過ぎ: holds it under for seconds every round
  overDip: { ...base, tare: (g) => tareCareful(g, { dip: { hold: 4.5 } }) },
  // 戻し忘れ: leaves it in the trough and serves it from there, the coat never set
  noReturn: { ...base, tare: (g) => { dip(g, { hold: 0.5, back: false }); g.releaseFish(); wait(g, 3); } },
  rushed: { ...base, cuts: [L * 0.22, L * 0.78], drop: (k) => ({ x: BOX.slots[k].x + 2.5, z: 2, vx: 95, vz: 70 }) },
  raw: { ...base, white: (g) => wait(g, 3.2), tare: (g) => { dip(g); wait(g, 2); } },
  noTare: { ...base, tare: (g) => { dip(g, { touch: true, drip: 0.6 }); wait(g, 1); } },
  skewersBad: { ...base, skewers: [2, 9, 36, 57] },
};

const out = {};
for (const [name, st] of Object.entries(STYLES)) {
  const g = play(st);
  const r = g.result;
  out[name] = r;
  const c = r.cats;
  console.log(name.padEnd(10), 'total', String(r.total).padStart(3), '| 身', String(c.clean).padStart(3), '焼', String(c.cook).padStart(3), '艶', String(c.glaze).padStart(3), '盛', String(c.plate).padStart(3), '|', r.issue || '-', '|', r.title, '| t=', g.time.toFixed(0) + 's', '| dips', g.dip.count);
  if (verbose) {
    const d = r.details;
    const f = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(3) : v])));
    console.log('   shape', f(d.shape), 'skew', f(d.sk));
    console.log('   flesh', f(d.flesh));
    console.log('   skin ', f(d.skin));
  }
}
// orders: the same careful play is judged against different targets
for (const o of ['fukkura', 'kobashiku', 'taretappuri']) {
  const r = play(STYLES.careful, o).result;
  console.log(('order:' + o).padEnd(18), 'total', r.total, JSON.stringify(r.cats));
}
// 照りたっぷり rewards a third round
{
  const r = play({ ...STYLES.careful, tare: (g) => tareCareful(g, { rounds: 3 }) }, 'taretappuri').result;
  console.log('order:taretappuri x3 total', r.total, JSON.stringify(r.cats));
  out.tare3 = r;
}

const Tt = (k) => out[k].total;
assert.ok(Tt('careful') >= 85, 'careful play earns a high grade');
for (const k of ['miscut', 'burnt', 'patchy', 'overDip', 'noReturn', 'rushed', 'raw', 'noTare']) assert.ok(Tt(k) < Tt('careful') - 6, k + ' is clearly below careful');
assert.ok(out.miscut.cats.clean < out.careful.cats.clean - 25, 'a crooked cut hurts 身のきれいさ');
assert.ok(out.burnt.cats.cook < out.careful.cats.cook - 25, 'overcooking one side hurts 焼き加減');
assert.ok(out.patchy.cats.glaze < out.careful.cats.glaze - 25, 'a short, one-sided dip hurts たれの艶');
assert.ok(out.overDip.cats.glaze < out.careful.cats.glaze - 10, 'soaking too long hurts たれの艶');
assert.ok(out.noReturn.cats.glaze < out.careful.cats.glaze - 25, 'serving it straight from the tare hurts たれの艶');
assert.ok(out.rushed.cats.plate < out.careful.cats.plate - 25, 'rushed plating hurts 盛り付け');
assert.ok(out.raw.cats.cook < out.careful.cats.cook - 25, 'pulling it early hurts 焼き加減');
assert.ok(out.noTare.cats.glaze < 45, 'a bare touch of tare, no shine');
assert.ok(out.skewersBad.cats.clean < out.careful.cats.clean - 8, 'uneven skewers cost 身のきれいさ');
assert.ok(out.careful.cats.plate >= 90, 'big pieces hanging over the rims are not penalised');
for (const k of ['miscut', 'burnt', 'patchy', 'rushed']) assert.ok(out[k].total >= 20, k + ' still finishes a dish worth something');
assert.equal(play(STYLES.careful).result.total, out.careful.total, 'same input, same score');
console.log('ok');
