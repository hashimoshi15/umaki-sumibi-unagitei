// Languages: Japanese, English, Korean, Simplified and Traditional Chinese. Every on-screen text goes
// through t(key); the dictionaries live in src/i18n/*.js (ja.js is the reference: every other
// language must have exactly its keys, checked by tools/i18n.test.mjs).
//   static HTML: data-i18n (text), data-i18n-html (trusted dictionary markup), data-i18n-aria,
//   data-i18n-alt, data-i18n-ph (placeholder), data-i18n-title
import ja from './i18n/ja.js';
import en from './i18n/en.js';
import ko from './i18n/ko.js';
import zhHans from './i18n/zh-Hans.js';
import zhHant from './i18n/zh-Hant.js';

export const LANGS = [
  { id: 'ja', name: '日本語' },
  { id: 'en', name: 'English' },
  { id: 'ko', name: '한국어' },
  { id: 'zh-Hans', name: '简体中文' },
  { id: 'zh-Hant', name: '繁體中文' },
];
export const DICT = { ja, en, ko, 'zh-Hans': zhHans, 'zh-Hant': zhHant };

// The rounded game font is a Japanese subset (kana, the kanji on screen, ASCII): used for Japanese
// and English only. Korean and Chinese use the system's own fonts, never the Japanese glyphs.
const FONTS = {
  ja: "'UmakiRound','Hiragino Maru Gothic ProN','Hiragino Sans','Yu Gothic UI','Meiryo',sans-serif",
  en: "'UmakiRound',ui-rounded,'Arial Rounded MT Bold','Segoe UI',system-ui,sans-serif",
  ko: "'Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR','Nanum Gothic',system-ui,sans-serif",
  'zh-Hans': "'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Noto Sans SC','Source Han Sans SC',system-ui,sans-serif",
  'zh-Hant': "'PingFang TC','PingFang HK','Microsoft JhengHei','Noto Sans TC','Source Han Sans TC',system-ui,sans-serif",
};

let cur = 'ja';
const listeners = new Set();
export const missing = new Set(); // keys that fell back to Japanese (QA reads this)

export function lang() {
  return cur;
}
export function fontStack(l = cur) {
  return FONTS[l] || FONTS.ja;
}

// browser language -> one of ours (Chinese by script / region; anything else unknown -> English)
export function detect(list = typeof navigator !== 'undefined' ? navigator.languages || [navigator.language] : []) {
  for (const raw of list) {
    const l = String(raw || '').toLowerCase();
    if (!l) continue;
    if (l.startsWith('ja')) return 'ja';
    if (l.startsWith('ko')) return 'ko';
    if (l.startsWith('en')) return 'en';
    if (l.startsWith('zh')) return /hant|-tw|-hk|-mo/.test(l) ? 'zh-Hant' : 'zh-Hans';
  }
  return 'en';
}

export function t(key, vars) {
  let s = DICT[cur] && DICT[cur][key];
  if (s == null) {
    if (cur !== 'ja') missing.add(cur + ':' + key);
    s = ja[key];
  }
  if (s == null) {
    missing.add('?:' + key);
    return key;
  }
  if (Array.isArray(s)) return s;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m)) : s;
}

export function setLang(id) {
  if (!DICT[id]) id = 'ja';
  cur = id;
  const html = document.documentElement;
  html.lang = id;
  html.dataset.lang = id;
  html.style.setProperty('--font', fontStack(id));
  document.title = t('meta.title');
  const md = document.querySelector('meta[name="description"]');
  if (md) md.setAttribute('content', t('meta.desc'));
  applyDom(document);
  for (const fn of listeners) fn(id);
}
export function onLang(fn) {
  listeners.add(fn);
}

export function applyDom(root) {
  for (const e of root.querySelectorAll('[data-i18n]')) e.textContent = t(e.dataset.i18n);
  for (const e of root.querySelectorAll('[data-i18n-html]')) e.innerHTML = t(e.dataset.i18nHtml);
  for (const e of root.querySelectorAll('[data-i18n-aria]')) e.setAttribute('aria-label', t(e.dataset.i18nAria));
  for (const e of root.querySelectorAll('[data-i18n-alt]')) e.setAttribute('alt', t(e.dataset.i18nAlt));
  for (const e of root.querySelectorAll('[data-i18n-ph]')) e.setAttribute('placeholder', t(e.dataset.i18nPh));
  for (const e of root.querySelectorAll('[data-i18n-title]')) e.setAttribute('title', t(e.dataset.i18nTitle));
}

// ---------------------------------------------------------------- countries and regions
// Every ISO 3166-1 alpha-2 code in use (249), named in the display language by the browser
// (Intl.DisplayNames); nothing is left out. Search matches the shown name, the English name and the code.
export const REGIONS = ('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR ' +
  'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP ' +
  'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ ' +
  'NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW ' +
  'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ ' +
  'UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' ');

const regionCache = {};
function namer(l) {
  try {
    if (typeof Intl !== 'undefined' && Intl.DisplayNames) return new Intl.DisplayNames([l], { type: 'region', fallback: 'code' });
  } catch (e) { /* old browser: fall back to the codes */ }
  return null;
}
export function regionName(code, l = cur) {
  return regionList(l).byCode[code] || code;
}
export function regionList(l = cur) {
  if (regionCache[l]) return regionCache[l];
  const dn = namer(l), dnEn = l === 'en' ? dn : namer('en');
  const items = REGIONS.map((code) => {
    const name = (dn && dn.of(code)) || code;
    const enName = (dnEn && dnEn.of(code)) || code;
    return { code, name, key: norm(name + ' ' + enName + ' ' + code) };
  });
  let coll = null;
  try { coll = new Intl.Collator(l); } catch (e) { /* default order */ }
  items.sort((a, b) => (coll ? coll.compare(a.name, b.name) : a.name < b.name ? -1 : 1));
  const byCode = {};
  for (const it of items) byCode[it.code] = it.name;
  return (regionCache[l] = { items, byCode });
}
export function norm(s) {
  let v = String(s || '');
  try { v = v.normalize('NFKC'); } catch (e) { /* keep */ }
  return v.toLowerCase();
}

// ---------------------------------------------------------------- nickname
// Unicode-aware: counts user-perceived characters (grapheme clusters), strips control characters,
// trims ordinary and ideographic spaces. Displayed with textContent only.
export const NICK_MAX = 12;
export function graphemes(s) {
  try {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].length;
  } catch (e) { /* fall through */ }
  return [...s].length;
}
export function cleanNick(raw) {
  let s = String(raw || '');
  try { s = s.normalize('NFC'); } catch (e) { /* keep */ }
  // control characters, line/paragraph separators and bidi overrides out; collapse runs of spaces
  s = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '').replace(/[\s\u3000]+/g, ' ').trim();
  return s;
}
// '' when fine, otherwise the error key
export function checkNick(raw) {
  const s = cleanNick(raw);
  if (!s) return 'err.nickEmpty';
  if (graphemes(s) > NICK_MAX) return 'err.nickLong';
  return '';
}
