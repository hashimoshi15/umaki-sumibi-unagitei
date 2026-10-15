import { clamp, mean, std, smooth } from '../util.js';
import { FLESH, SKIN } from './fish.js';
import { FISH } from '../config.js';

// Four grades read from the same arrays that paint the eel. Each category adds penalty points and
// shows round(100·exp(−pen/60)): small slips cost little, and a dish never scores 0.
//   身のきれいさ  knife line, ragged edges, flesh torn with the bone, crease, skewer layout, slicing
//   焼き加減      both faces in the target band, even, not burnt, still juicy, cooked through
//   たれの艶      glaze amount and evenness, bare spots, puddles, burnt tare, wet tare left
//   盛り付け      even pieces resting in their places on the rice, not skewed, set down gently
export const ORDERS = {
  standard: { name: 'いつもの', note: '', loF: 1.35, hiF: 1.7, loS: 1.35, hiS: 1.8, phi: 0.12, charMul: 1, Wmin: 0.7, Wk: 40, Glo: 0.8, Ghi: 1.35, tb0: 0.02, w: { clean: 0.22, cook: 0.3, glaze: 0.26, plate: 0.22 } },
  fukkura: { name: 'ふっくら', note: '中火でじっくり、焦げは少なめ', loF: 1.25, hiF: 1.55, loS: 1.25, hiS: 1.65, phi: 0.07, charMul: 1.6, Wmin: 0.8, Wk: 80, Glo: 0.8, Ghi: 1.3, tb0: 0.02, w: { clean: 0.2, cook: 0.36, glaze: 0.24, plate: 0.2 } },
  kobashiku: { name: '香ばしく', note: '仕上げは強火、皮はぱりっと', loF: 1.65, hiF: 1.95, loS: 1.7, hiS: 2.05, phi: 0.15, charMul: 0.5, Wmin: 0.55, Wk: 40, Glo: 0.7, Ghi: 1.25, tb0: 0.06, w: { clean: 0.2, cook: 0.32, glaze: 0.28, plate: 0.2 } },
  taretappuri: { name: '照りたっぷり', note: 'タレを重ねて照りを深く、でも焦がさず', loF: 1.35, hiF: 1.7, loS: 1.35, hiS: 1.8, phi: 0.12, charMul: 1, Wmin: 0.7, Wk: 40, Glo: 1.4, Ghi: 2.0, tb0: 0.02, w: { clean: 0.2, cook: 0.26, glaze: 0.34, plate: 0.2 } },
};

const soft = (p) => Math.round(100 * Math.exp(-Math.max(0, p) / 60));

export function evaluate(game) {
  const F = game.fish;
  const O = ORDERS[game.order || 'standard'] || ORDERS.standard;
  const shape = F.shapeStats();
  const sk = F.skewerStats();
  const fl = F.faceStats(FLESH), sn = F.faceStats(SKIN);

  // ---- 身のきれいさ
  let pClean = 26 * shape.meanE + 10 * Math.max(0, shape.maxE - 0.7) + 60 * shape.rough + 85 * shape.loss + 25 * shape.crack + 4 * shape.holes;
  pClean += 12 * Math.max(0, sk.sagMax - 0.6) + 22 * Math.max(0, sk.cv - 0.08);
  for (const spread of F.cutAngles || []) pClean += 0.5 * Math.max(0, (Math.atan2(spread, 8) * 180) / Math.PI - 8);

  // ---- 焼き加減
  let pCook = 95 * Math.max(0, O.loF - fl.dMean) + 55 * Math.max(0, fl.dMean - O.hiF) + 70 * Math.max(0, O.loS - sn.dMean) + 40 * Math.max(0, sn.dMean - O.hiS);
  pCook += 90 * fl.raw + 45 * sn.raw + 35 * Math.max(0, fl.dStd - 0.12);
  pCook += O.charMul * (80 * Math.max(0, fl.burnt - O.phi) + 45 * Math.max(0, sn.burnt - O.phi));
  pCook += O.Wk * Math.max(0, O.Wmin - fl.W) + 30 * fl.rawK;

  // ---- たれの艶
  let pGlaze = 75 * Math.max(0, O.Glo - fl.glMean) + 30 * Math.max(0, fl.glMean - O.Ghi) + 40 * Math.max(0, fl.glCV - 0.15);
  pGlaze += 80 * fl.bare + 45 * fl.blob + 60 * Math.max(0, fl.tareBurnt - O.tb0) + 25 * Math.max(0, fl.wet - 0.2);
  pGlaze += 10 * Math.max(0, 0.5 - sn.cover) + O.charMul * 30 * Math.max(0, fl.burnt - O.phi);

  // ---- 盛り付け
  const P = F.pieces;
  const lens = P.map((p) => p.u1 - p.u0);
  const lenCV = lens.length ? std(lens) / (mean(lens) || 1) : 1;
  const errs = P.map((p) => p.err), rots = P.map((p) => Math.abs(p.rot)), speeds = P.map((p) => p.v);
  // a piece much longer than a third of the eel (a lopsided cut); a big piece hanging over the box's rims
  // is how a generous unajū looks and costs nothing
  const over = lens.reduce((a, l) => a + Math.max(0, l - (F.L / 3) * 1.17), 0);
  let pPlate = 9 * mean(errs) + 3 * Math.max(0, ...errs) + 45 * mean(rots) + 85 * lenCV + 4 * over + 15 * smooth(40, 120, mean(speeds));
  pPlate += (game.stats.finished ? 0 : 6) + 4 * (game.regrabs || 0);
  if (P.some((p) => !p.placed)) pPlate += 40;

  const cats = { clean: soft(pClean), cook: soft(pCook), glaze: soft(pGlaze), plate: soft(pPlate) };
  const total = Math.round(cats.clean * O.w.clean + cats.cook * O.w.cook + cats.glaze * O.w.glaze + cats.plate * O.w.plate);

  // ---- the single most useful thing to say next
  const issues = {
    cutLine: clamp((shape.meanE - 0.2) / 0.5, 0, 1) * 0.9 + clamp((shape.rough - 0.08) / 0.3, 0, 1) * 0.7,
    boneTear: clamp(shape.loss / 0.25, 0, 1) * 0.9 + clamp(shape.crack / 0.4, 0, 1) * 0.4,
    skewers: clamp((sk.sagMax - 0.6) / 0.8, 0, 1) * 0.7 + clamp((sk.cv - 0.1) / 0.4, 0, 1) * 0.6,
    raw: clamp((O.loF - fl.dMean) / 0.4, 0, 1) + clamp(fl.rawK * 2, 0, 1) * 0.5,
    burnt: clamp((fl.burnt - O.phi) * 4 * O.charMul, 0, 1) + clamp((sn.burnt - O.phi) * 2 * O.charMul, 0, 1) * 0.5,
    dry: clamp((O.Wmin - fl.W) / 0.25, 0, 1) * 0.8,
    uneven: clamp((fl.dStd - 0.18) / 0.3, 0, 1) * 0.8,
    noTare: clamp((O.Glo - fl.glMean) / 0.6, 0, 1) * 0.9,
    patchyTare: clamp((fl.bare - 0.06) / 0.35, 0, 1) * 0.8 + clamp((fl.glCV - 0.2) / 0.8, 0, 1) * 0.5,
    thickTare: clamp(fl.blob * 5, 0, 1) * 0.7 + clamp((fl.tareBurnt - O.tb0) * 6, 0, 1) * 0.5,
    // lifted out of the tare and served without going back onto the coals
    wetTare: (game.dip && game.dip.servedWet ? 0.9 : 0) + clamp((fl.wet - 0.25) / 0.4, 0, 1) * 0.6,
    sizes: clamp((lenCV - 0.08) / 0.3, 0, 1) * 0.7,
    rushed: clamp((mean(errs) - 0.6) / 2.2, 0, 1) * 0.7 + smooth(40, 120, mean(speeds)) * 0.5,
  };
  let top = null, topV = 0.2;
  for (const [k, v] of Object.entries(issues)) if (v > topV) { top = k; topV = v; }
  let best = 'clean', bv = -1;
  for (const [k, v] of Object.entries(cats)) if (v > bv) { best = k; bv = v; }

  const rank = total >= 90 ? 5 : total >= 78 ? 4 : total >= 62 ? 3 : total >= 45 ? 2 : 1;
  return {
    cats, total, rank, issue: top, issues, best,
    title: title(rank, top, topV),
    good: GOOD[best],
    tip: top ? TIPS[top] : NEXT[lowest(cats)],
    // dictionary keys (src/i18n): the UI shows these in the player's language
    titleKey: titleKey(rank, top, topV),
    tipKey: top ? 'tip.' + top : 'next.' + lowest(cats),
    order: game.order || 'standard',
    orderName: O.name,
    details: { shape, sk, flesh: fl, skin: sn, lens, errs, speeds, L: FISH.L },
  };
}

function lowest(cats) {
  let k0 = 'clean', v0 = 101;
  for (const [k, v] of Object.entries(cats)) if (v < v0) { k0 = k; v0 = v; }
  return k0;
}

const TITLES = {
  5: '炭火名人の 特上うな重',
  4: 'のれん自慢の うな重',
  3: 'まかないの おいしいうな重',
  2: 'のびしろ たっぷりうな重',
  1: 'はじめての 手づくりうな重',
};
const ODD = {
  burnt: 'こんがり 炭火の香ばし重',
  raw: 'じっくり待ちの 白焼き重',
  dry: 'しっかり焼きの うな重',
  noTare: 'さっぱり 白焼き風うな重',
  patchyTare: 'まだら照り うな重',
  wetTare: 'たれ漬け うな重',
  cutLine: 'のびのび 開き うな重',
  boneTear: 'ほろほろ 身割れうな重',
  rushed: 'いそぎ盛り うな重',
};
function titleKey(rank, top, v) {
  if (rank <= 2 && top && v > 0.45 && ODD[top]) return 'odd.' + top;
  return 'rank.' + rank;
}
function title(rank, top, v) {
  if (rank <= 2 && top && v > 0.45 && ODD[top]) return ODD[top];
  return TITLES[rank];
}

export const CAT_LABEL = { clean: '身のきれいさ', cook: '焼き加減', glaze: 'たれの艶', plate: '盛り付け' };

const GOOD = {
  clean: '開き身の幅がそろって、きれいな一枚になったね。',
  cook: '身はふっくら、皮はぱりっと焼けたね。',
  glaze: 'たれの照りが むらなく、つやつやだよ。',
  plate: 'ご飯の上に三切れ、きれいに並んだね。',
};

const TIPS = {
  cutLine: '包丁は背の線を目で追いながら、ゆっくり同じ速さで。左右の幅がそろうよ。',
  boneTear: '骨は頭のほうから、まっすぐ尾へ ゆっくり引こう。身が割れにくいよ。',
  skewers: '串は端から少し入った所に、同じ間かくで打とう。反りにくく、焼きむらが減るよ。',
  raw: 'もう少し 中や強の炭で焼こう。身が白く不透明になったら返しどき。',
  burnt: '端や尾が濃くなってきたら、手前の弱い炭へずらすか、早めに返そう。',
  dry: '焼きすぎると身がかたくなるよ。焼き色がついたら、弱い炭で休ませよう。',
  uneven: '焼き色が薄い所を、熱い炭の上へずらしてみよう。',
  noTare: 'うなぎをタレの壺へ ぐっと沈めてから炭火へ戻そう。焼き付けると照りが出るよ。',
  patchyTare: '壺の真ん中へ まっすぐ沈めて、全体がつかるまで少し待とう。ちょんと付けるだけだと 片面しか照らないよ。',
  wetTare: 'タレから上げたら 炭火へ戻して焼き付けよう。ぬれたままだと照りが出ないし、身も焼き足りないよ。',
  thickTare: '長くつけすぎると たれが重くなって焦げやすい。さっとくぐらせて焼く、を2回がおすすめ。',
  sizes: '切るときは三等分の目安線に合わせよう。大きさがそろうと盛り付けが映えるよ。',
  rushed: 'お重には ゆっくり置こう。勢いがあると、ご飯の上ですべっちゃう。',
};

const NEXT = {
  clean: 'つぎは包丁をもっと背の線に沿わせてみよう。',
  cook: 'つぎは強い炭とやさしい炭を使い分けて、焼き色をそろえよう。',
  glaze: 'つぎはタレにくぐらせて焼く、を2回重ねて照りを深くしよう。',
  plate: 'つぎは三切れの間をそろえて置いてみよう。',
};

export function grade(v) {
  return v >= 90 ? 5 : v >= 75 ? 4 : v >= 58 ? 3 : v >= 40 ? 2 : 1;
}
export const GRADE_WORD = { 5: 'お見事', 4: 'じょうず', 3: 'いい感じ', 2: 'もうすこし', 1: 'これから' };
