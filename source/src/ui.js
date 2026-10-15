import { TUNE } from './config.js';
import { ORDERS, grade } from './model/score.js';
import { t, setLang, onLang, lang, LANGS, regionList, regionName, checkNick, cleanNick, NICK_MAX, norm } from './i18n.js';
import { FLESH, SKIN } from './model/fish.js';

// DOM UI over the WebGL canvas: screens, step chips, umakiちゃん's guide bubble, the side meters and
// buttons. No framework; the only per-frame work is a 10 Hz refresh of a few meters and hints.

const $ = (id) => document.getElementById(id);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const POSES = ['idle', 'happy', 'wow', 'cheer'];

// ---------------------------------------------------------------- small inline diagrams (viewBox 120x70)
// Flat fills only (no gradient ids), so the same figure can sit in the how-to card and the bubble at once.
const FINGER = (x, y) => `<circle cx="${x}" cy="${y}" r="4.6" fill="#fff" fill-opacity=".82" stroke="#4a2b16" stroke-width="2.2"/>`;
const BOARD = '<rect x="1" y="1" width="118" height="68" rx="8" fill="#ecd3ad"/><path d="M1 13H119M1 58H119" stroke="#dfc196" stroke-width="1.2"/>';
const KONRO = '<rect x="1" y="1" width="118" height="68" rx="8" fill="#2a1c15"/>' +
  '<ellipse cx="64" cy="57" rx="30" ry="7" fill="#f47909" opacity=".7"><animate attributeName="opacity" values=".5;.85;.5" dur="1.7s" repeatCount="indefinite"/></ellipse>' +
  '<ellipse cx="22" cy="58" rx="13" ry="5" fill="#cb420f" opacity=".6"/><ellipse cx="102" cy="59" rx="11" ry="4" fill="#892f19" opacity=".7"/>' +
  '<g fill="#463831"><rect x="6" y="54" width="20" height="9" rx="4"/><rect x="29" y="52" width="22" height="9" rx="4"/><rect x="54" y="55" width="21" height="9" rx="4"/><rect x="78" y="52" width="19" height="9" rx="4"/><rect x="99" y="55" width="16" height="9" rx="4"/></g>' +
  '<g fill="#6a5a52"><rect x="8" y="54" width="14" height="2.2" rx="1"/><rect x="31" y="52" width="16" height="2.2" rx="1"/><rect x="57" y="55" width="14" height="2.2" rx="1"/><rect x="80" y="52" width="13" height="2.2" rx="1"/></g>' +
  '<path d="M3 21H117M3 47H117" stroke="#5b4436" stroke-width="2"/>';
const COUNTER = '<rect x="1" y="1" width="118" height="68" rx="8" fill="#a8703f"/><path d="M1 22H119M1 47H119" stroke="#966235" stroke-width="1.2"/>';
const JUBAKO = '<rect x="44" y="9" width="70" height="54" rx="6" fill="#1b0d07"/><rect x="48" y="13" width="62" height="46" rx="4" fill="#a92f16"/>' +
  '<rect x="51" y="16" width="56" height="40" rx="3" fill="#f4ede1"/>' +
  '<g fill="#e2d5c3"><ellipse cx="56" cy="20" rx="1.6" ry=".9"/><ellipse cx="102" cy="22" rx="1.6" ry=".9"/><ellipse cx="60" cy="52" rx="1.6" ry=".9"/><ellipse cx="99" cy="51" rx="1.6" ry=".9"/><ellipse cx="80" cy="18.5" rx="1.6" ry=".9"/><ellipse cx="78" cy="53.5" rx="1.6" ry=".9"/></g>';
const PIECE = (x, y) => `<g transform="translate(${x} ${y})"><rect width="16" height="32" rx="3" fill="#94400f"/><path d="M5 3V29M11 3V29" stroke="#6a2a0f" stroke-width="1.3"/><path d="M3 4V28" stroke="#c97b44" stroke-width="1.2" opacity=".8"/><rect y="29" width="16" height="3" rx="1.5" fill="#3a1a0c"/></g>`;
const FILLET_RAW = '<rect x="10" y="24" width="100" height="22" rx="6" fill="#ecdad0"/><path d="M14 35H106" stroke="#d29a87" stroke-width="1.1"/><path d="M12 24.5H108M12 45.5H108" stroke="#33291f" stroke-width="2.2" stroke-linecap="round"/>';
const FILLET_KABA = '<rect x="10" y="25" width="100" height="20" rx="5" fill="#9a4314"/><path d="M14 30H106M14 40H106" stroke="#6a2a0f" stroke-width="1.4"/><path d="M16 28H70" stroke="#d08a52" stroke-width="1.3" opacity=".8"/><path d="M12 45H108" stroke="#2a1208" stroke-width="2" stroke-linecap="round"/>';
const SKEWER = (x) => `<line x1="${x}" y1="17" x2="${x}" y2="53" stroke="#8a8582" stroke-width="2.6" stroke-linecap="round"/><line x1="${x - 0.6}" y1="18" x2="${x - 0.6}" y2="52" stroke="#e1e4e7" stroke-width=".8"/>`;
const ANIM = (attr, values, keyTimes, dur) => `<animate attributeName="${attr}" values="${values}" keyTimes="${keyTimes}" dur="${dur}s" repeatCount="indefinite"/>`;
const MOVE = (values, keyTimes, dur) => `<animateTransform attributeName="transform" type="translate" values="${values}" keyTimes="${keyTimes}" dur="${dur}s" repeatCount="indefinite"/>`;
const SVG = (body) => `<svg viewBox="0 0 120 70" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;

const FIG = {
  cut: SVG(BOARD +
    '<path d="M7 35C7 28.5 12 26.5 20 27L100 30C108 30.6 113 32.8 114.5 35C113 37.2 108 39.4 100 40L20 43C12 43.5 7 41.5 7 35Z" fill="#33291f"/>' +
    '<path d="M22 40.6L100 38.4" stroke="#7d6c5e" stroke-width="2" stroke-linecap="round"/><circle cx="13.5" cy="32.6" r="1.3" fill="#d8d2c8"/>' +
    '<path d="M20 34H108" stroke="#e1462a" stroke-width="1.7" stroke-dasharray="3.4 2.8" fill="none"/>' +
    `<path d="M20 34H108" stroke="#f4e3d8" stroke-width="3" stroke-linecap="round" fill="none" pathLength="100" stroke-dasharray="100 100" stroke-dashoffset="100">${ANIM('stroke-dashoffset', '100;0;0', '0;.75;1', 2.8)}</path>` +
    `<g>${MOVE('0 0;88 0;88 0', '0;.75;1', 2.8)}<path d="M20 34L10.5 11.5L18.5 8.6L22.6 31.6Z" fill="#e3e6e9" stroke="#7d848a" stroke-width="1.1" stroke-linejoin="round"/>` +
    '<path d="M20 34L10.8 12" stroke="#fff" stroke-width=".9"/><rect x="9.6" y="4.6" width="9.6" height="3.4" rx="1" fill="#1b130f" transform="rotate(-20 14.4 6.3)"/>' +
    `<rect x="10.2" y="-8" width="6.4" height="13" rx="2.4" fill="#c9a47c" transform="rotate(-20 13.4 -1.5)"/>${FINGER(20, 34)}</g>`),
  open: SVG(BOARD +
    `<rect x="12" y="35" width="96" height="0" rx="4" fill="#ecdad0">${ANIM('y', '35;24;24', '0;.6;1', 2.4)}${ANIM('height', '0;22;22', '0;.6;1', 2.4)}</rect>` +
    '<path d="M15 35H105" stroke="#d29a87" stroke-width="1.2"/>' +
    `<path d="M12 33.5H108" stroke="#33291f" stroke-width="3.6" stroke-linecap="round">${MOVE('0 0;0 -9.5;0 -9.5', '0;.6;1', 2.4)}</path>` +
    `<path d="M12 36.5H108" stroke="#33291f" stroke-width="3.6" stroke-linecap="round">${MOVE('0 0;0 9.5;0 9.5', '0;.6;1', 2.4)}</path>` +
    '<path d="M60 17V8M56 12L60 8L64 12M60 53V62M56 58L60 62L64 58" stroke="#e1462a" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
    `<g>${MOVE('0 0;0 10;0 10', '0;.6;1', 2.4)}${FINGER(78, 37)}</g>`),
  bone: SVG(BOARD + FILLET_RAW +
    `<line x1="16" y1="35" x2="106" y2="35" stroke="#b9ad9f" stroke-width="4.2">${ANIM('x1', '16;106;106', '0;.75;1', 2.8)}</line>` +
    `<line x1="16" y1="35" x2="106" y2="35" stroke="#fbf7f0" stroke-width="2.8" stroke-dasharray="2.2 1.1">${ANIM('x1', '16;106;106', '0;.75;1', 2.8)}</line>` +
    `<line x1="8" y1="9" x2="16" y2="35" stroke="#b9ad9f" stroke-width="4.2" stroke-linecap="round">${ANIM('x1', '8;64;64', '0;.75;1', 2.8)}${ANIM('x2', '16;106;106', '0;.75;1', 2.8)}</line>` +
    `<line x1="8" y1="9" x2="16" y2="35" stroke="#fbf7f0" stroke-width="2.8" stroke-dasharray="2.2 1.1">${ANIM('x1', '8;64;64', '0;.75;1', 2.8)}${ANIM('x2', '16;106;106', '0;.75;1', 2.8)}</line>` +
    `<g>${MOVE('0 0;90 0;90 0', '0;.75;1', 2.8)}${FINGER(16, 35)}</g>`),
  skewer: SVG(BOARD + FILLET_RAW +
    `<g opacity="0">${SKEWER(28)}${ANIM('opacity', '0;0;1;1', '0;.16;.2;1', 3.2)}</g>` +
    `<g opacity="0">${SKEWER(60)}${ANIM('opacity', '0;0;1;1', '0;.42;.46;1', 3.2)}</g>` +
    `<g opacity="0">${SKEWER(92)}${ANIM('opacity', '0;0;1;1', '0;.68;.72;1', 3.2)}</g>` +
    `<g opacity="0"><path d="M31 61H57M63 61H89" stroke="#e1462a" stroke-width="1.6" stroke-linecap="round"/><path d="M31 58V64M57 58V64M63 58V64M89 58V64" stroke="#e1462a" stroke-width="1.6"/>${ANIM('opacity', '0;0;1;1', '0;.78;.84;1', 3.2)}</g>` +
    `<g>${MOVE('28 0;28 0;60 0;60 0;92 0;92 0', '0;.2;.32;.46;.58;1', 3.2)}${FINGER(0, 35)}</g>`),
  white: SVG(KONRO +
    `<g>${MOVE('-14 0;12 0;12 0;-14 0', '0;.4;.6;1', 4.4)}` +
    `<rect x="24" y="25" width="72" height="14" rx="5" fill="#d8c6bd">${ANIM('fill', '#d8c6bd;#efd7b4;#e7bd86;#d8c6bd', '0;.45;.9;1', 4.4)}</rect>` +
    '<path d="M26 39H94" stroke="#2f1b0e" stroke-width="2" stroke-linecap="round"/>' +
    '<path d="M36 21V43M60 21V43M84 21V43" stroke="#9a938f" stroke-width="1.7" stroke-linecap="round"/></g>' +
    '<path d="M44 12H76M48.5 8L44 12L48.5 16M71.5 8L76 12L71.5 16" stroke="#ffd36e" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M104 18A6.5 6.5 0 1 1 97.5 11.5" stroke="#fff1d8" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M95 8.5L98.5 11.5L95 14.5" stroke="#fff1d8" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'),
  // つけダレ: lift the skewered fillet off the coals, down into the trough of tare, up and back onto the coals
  tare: SVG('<rect x="1" y="1" width="118" height="68" rx="8" fill="#2a1c15"/>' +
    '<ellipse cx="60" cy="25" rx="42" ry="5" fill="#f47909" opacity=".6"><animate attributeName="opacity" values=".45;.8;.45" dur="1.7s" repeatCount="indefinite"/></ellipse>' +
    '<path d="M5 31H115" stroke="#5b4436" stroke-width="2.2"/>' +
    '<rect x="7" y="38" width="106" height="29" rx="6" fill="#6a4429"/><rect x="11" y="42" width="98" height="21" rx="4" fill="#160903"/>' +
    '<path d="M14 45.5H106" stroke="#7a4216" stroke-width="1.2" opacity=".8"/>' +
    `<g>${MOVE('0 0;0 0;0 -5;0 26;0 32;0 32;0 26;0 -5;0 0;0 0', '0;.08;.16;.3;.38;.5;.58;.72;.8;1', 4.4)}` +
    `<rect x="22" y="15" width="76" height="10" rx="4" fill="#e7bd86">${ANIM('fill', '#e7bd86;#e7bd86;#8f3c11;#8f3c11', '0;.36;.44;1', 4.4)}</rect>` +
    `<path d="M26 17H70" stroke="#f2c79a" stroke-width="1.2" opacity="0">${ANIM('opacity', '0;0;.85;.85', '0;.5;.6;1', 4.4)}</path>` +
    '<path d="M34 11V29M60 11V29M86 11V29" stroke="#9a938f" stroke-width="1.6" stroke-linecap="round"/>' +
    `${FINGER(86, 12)}</g>` +
    // the tare surface over the dipped fish
    `<rect x="11" y="45" width="98" height="18" rx="3" fill="#2b1206" opacity="0">${ANIM('opacity', '0;0;.88;.88;0;0', '0;.33;.38;.52;.58;1', 4.4)}</rect>` +
    `<g fill="#5a2208">${[36, 58, 80].map((x, i) => `<circle cx="${x}" cy="44" r="1.1" opacity="0"><animate attributeName="cy" values="40;40;52" keyTimes="0;${(0.6 + i * 0.03).toFixed(2)};${(0.7 + i * 0.03).toFixed(2)}" dur="4.4s" repeatCount="indefinite"/><animate attributeName="opacity" values="0;0;1;0" keyTimes="0;${(0.6 + i * 0.03).toFixed(2)};${(0.62 + i * 0.03).toFixed(2)};${(0.72 + i * 0.03).toFixed(2)}" dur="4.4s" repeatCount="indefinite"/></circle>`).join('')}</g>` +
    '<path d="M110 9V27M106 23L110 27L114 23" stroke="#ffd36e" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M10 27V9M6 13L10 9L14 13" stroke="#ffd36e" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'),
  unskewer: SVG(BOARD + FILLET_KABA +
    `<g>${MOVE('0 0;0 0;0 -26;0 -26', '0;.18;.3;1', 3.2)}<g>${ANIM('opacity', '1;1;0;0', '0;.24;.32;1', 3.2)}${SKEWER(30)}</g></g>` +
    `<g>${MOVE('0 0;0 0;0 -26;0 -26', '0;.44;.56;1', 3.2)}<g>${ANIM('opacity', '1;1;0;0', '0;.5;.58;1', 3.2)}${SKEWER(60)}</g></g>` +
    `<g>${MOVE('0 0;0 0;0 -26;0 -26', '0;.7;.82;1', 3.2)}<g>${ANIM('opacity', '1;1;0;0', '0;.76;.84;1', 3.2)}${SKEWER(90)}</g></g>` +
    `<g>${MOVE('30 0;30 0;60 0;60 0;90 0;90 0', '0;.24;.34;.5;.6;1', 3.2)}${FINGER(0, 35)}</g>`),
  slice: SVG(BOARD + FILLET_KABA +
    '<path d="M43.5 17V53M76.5 17V53" stroke="#e1462a" stroke-width="1.5" stroke-dasharray="2.6 2.2"/>' +
    `<rect x="42.5" y="25" width="2" height="0" fill="#ecd3ad">${ANIM('height', '0;20;20', '0;.6;1', 2.4)}</rect>` +
    `<g>${MOVE('0 -12;0 16;0 16', '0;.6;1', 2.4)}<path d="M41 12H46L46.6 27L43.5 31L40.4 27Z" fill="#dfe3e6" stroke="#868d93" stroke-width="1"/>` +
    `<rect x="40.6" y="0" width="5.8" height="12" rx="2.2" fill="#b98f62"/>${FINGER(43.5, 22)}</g>`),
  plate: SVG(COUNTER + JUBAKO + PIECE(54, 20) + PIECE(71, 20) +
    `<g>${MOVE('-78 6;-44 -10;0 -3;0 1;0 0;0 0', '0;.3;.55;.62;.68;1', 2.8)}${PIECE(88, 20)}${FINGER(96, 36)}</g>`),
  finish: SVG(COUNTER + JUBAKO + PIECE(54, 20) + PIECE(71, 20) + PIECE(88, 20) +
    `<path d="M52 30Q62 27 72 31T92 30T106 31" stroke="#4a1606" stroke-width="1.6" fill="none" pathLength="100" stroke-dasharray="100 100" stroke-dashoffset="100" opacity=".9">${ANIM('stroke-dashoffset', '100;100;0;0', '0;.45;.8;1', 3)}</path>` +
    `<g fill="#5e4426">${[62, 70, 78, 86].map((x, i) => `<circle cx="${x}" cy="12" r="1"><animate attributeName="cy" values="12;12;34" keyTimes="0;${(0.05 + i * 0.07).toFixed(2)};${(0.3 + i * 0.07).toFixed(2)}" dur="3s" repeatCount="indefinite"/></circle>`).join('')}</g>` +
    `<g><animateTransform attributeName="transform" type="rotate" values="-30 22 18;-48 22 18;-30 22 18;-48 22 18;-30 22 18" keyTimes="0;.1;.2;.3;1" dur="3s" repeatCount="indefinite"/>` +
    '<rect x="14" y="6" width="16" height="22" rx="4" fill="#6b3f20"/><rect x="14" y="6" width="16" height="6" rx="3" fill="#3e2412"/><circle cx="22" cy="18" r="2" fill="#a26b3c"/></g>'),
};
FIG.toGrill = FIG.white;
FIG.toBoard = FIG.unskewer;

const FLAME = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.4c1.3 3.3 6 5.6 6 10.8a6 6 0 0 1-12 0c0-2.7 1.4-4.2 2.5-5.4.3 1.6 1 2.7 2 3.2-.3-3.1.2-5.9 1.5-8.6z" fill="#f47a1c"/><path d="M12 12.6c.9 1.3 2.7 2.3 2.7 4.3a2.7 2.7 0 0 1-5.4 0c0-1.3.7-2.3 1.3-2.9.2.6.5 1 .9 1.2-.1-1 .1-1.8.5-2.6z" fill="#ffd36e"/></svg>';
const FLIP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 10.5A7.8 7.8 0 0 1 18.4 6.6M19.5 13.5A7.8 7.8 0 0 1 5.6 17.4" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round"/><path d="M19.2 2.8V7H15M4.8 21.2V17H9" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SOUND_ON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16 8.5q3 3.5 0 7M18.5 6q5 6 0 12" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round"/></svg>';
const SOUND_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

// guide texts: dictionary keys 'g.<step or situation>' = [first time, repeat] (src/i18n/*.js)

// which chip (捌く 串 焼く たれ 盛る) each step belongs to
const CHIP = { cut: 0, open: 0, bone: 0, skewer: 1, toGrill: 2, white: 2, tare: 3, toBoard: 4, unskewer: 4, slice: 4, plate: 4, finish: 4, result: 5 };
const GRILL_STEPS = ['toGrill', 'white', 'tare', 'toBoard'];

// ---------------------------------------------------------------- cooked colours for the face indicator
const rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
// stops on the model's surface dose D: 0 raw, 0.85 white-grilled, 1.3 golden, 1.6 deep brown, 1.9+ char
const RAMP = {
  [FLESH]: [[0, '#cbbbb4'], [0.45, '#d6c4b8'], [0.85, '#e6cfae'], [1.3, '#dfa259'], [1.6, '#b8742f'], [1.9, '#5a2a10'], [2.3, '#1c0b05']],
  [SKIN]: [[0, '#6f6a65'], [0.5, '#5e4f43'], [0.85, '#4a2f1a'], [1.4, '#3a2412'], [1.9, '#1f120a'], [2.3, '#100804']],
};
for (const k of [FLESH, SKIN]) RAMP[k] = RAMP[k].map(([v, c]) => [v, rgb(c)]);
const GLAZE = rgb('#a34b15'), GLAZE_DEEP = rgb('#6a2810'), WET = rgb('#c27a30'), CHAR = rgb('#1c0b05');
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
function ramp(stops, v) {
  if (v <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) return mix(stops[i - 1][1], stops[i][1], (v - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]));
  }
  return stops[stops.length - 1][1];
}
function faceColor(f, d, ch, gl, ta) {
  let c = ramp(RAMP[f], d);
  if (gl > 0.01) c = mix(c, mix(GLAZE, GLAZE_DEEP, clamp01((gl - 1.1) / 1.2)), clamp01(gl / 1.1) * (f === FLESH ? 0.88 : 0.45));
  if (ta > 0.01) c = mix(c, WET, clamp01(ta / 0.7) * 0.6);
  if (ch > 0.02) c = mix(c, CHAR, clamp01(ch / 0.8) * 0.92);
  return `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
}
const SEGS = 8;

export class UI {
  constructor(h = {}) {
    this.h = h;
    this.first = true;       // first plate: longer guide texts
    this.mode = 'loading';
    this.step = '';
    this.key = '';
    this.keyAge = 0;
    this.cur = null;
    this.sayHold = 0;
    this.meterT = 0;
    this.poseName = 'idle';
    this.poseT = 0;
    this.order = null;
    this.chal = null;
    this.kbd = false;
    this.btn = {};
    this.st = null;
    this.el = {};
    for (const id of ['top', 'guide', 'side', 'say', 'fig', 'bubble', 'umaki', 'meter', 'actions', 'toast', 'title', 'howto', 'pause', 'rotate', 'result',
      'loading', 'loadMsg', 'steps', 'order', 'orderName', 'orderNote', 'orderPlate', 'soundBtn', 'titleSound', 'muteBtn', 'vol', 'pauseNote', 'pauseTitle',
      'nextBtn', 'againBtn', 'resTitleBtn']) this.el[id] = $(id);
    this.chips = [...this.el.steps.querySelectorAll('li')];
    this.entry = { nick: '', country: '' };
    this.pauseKey = 'pause.note';
    this.lastRes = null;
    // the pose images are small: load them now so a pose change never flickers
    this.poseImgs = POSES.map((p) => {
      const im = new Image();
      im.src = 'assets/umaki/' + p + '.webp';
      return im;
    });

    const on = (id, fn) => {
      const e = $(id);
      if (e) e.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
    };
    const call = (name, ...a) => () => this.h[name] && this.h[name](...a);
    // the form submits on the start button and on Enter in the nickname field
    $('entry').addEventListener('submit', (e) => {
      e.preventDefault();
      if (this.h.start) this.h.start(null);
    });
    on('howBtn', call('howto'));
    on('challengeBtn', call('challenge'));
    on('fsBtn', call('fullscreen'));
    this.setupEntry();
    on('howGo', call('howGo'));
    on('howBack', call('toTitle'));
    on('pauseBtn', call('pause'));
    on('resumeBtn', call('resume'));
    on('restartBtn', call('restart'));
    on('toTitleBtn', call('toTitle'));
    on('againBtn', call('restart'));
    on('nextBtn', call('next'));
    on('resTitleBtn', call('toTitle'));
    on('soundBtn', call('toggleMute'));
    on('titleSound', call('toggleMute'));
    on('muteBtn', call('toggleMute'));
    this.el.vol.addEventListener('input', () => {
      this.el.vol.style.setProperty('--p', this.el.vol.value + '%');
      if (this.h.volume) this.h.volume(this.el.vol.value / 100);
    });
    this.el.umaki.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.h.umakiTap) this.h.umakiTap();
      else this.pose('happy', 1);
    });
    for (const f of document.querySelectorAll('.hf')) f.innerHTML = FIG[f.dataset.fig] || '';
    // focus follows screens only for keyboard players (no stray focus rings for touch / mouse)
    addEventListener('keydown', () => (this.kbd = true), true);
    addEventListener('pointerdown', () => (this.kbd = false), true);
    this.layout();
    addEventListener('resize', () => this.layout());
    this.muted = false;
    this.volume = 0.8;
    onLang(() => this.relabel());
    this.setSound(false, 0.8);
  }

  // ------------------------------------------------------------ entry: language, nickname, country / region
  setupEntry() {
    for (const id of ['langSel', 'langSel2']) {
      const sel = $(id);
      sel.innerHTML = '';
      for (const L of LANGS) {
        const o = document.createElement('option');
        o.value = L.id;
        o.textContent = L.name; // each language in its own script
        o.lang = L.id;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => this.h.lang && this.h.lang(sel.value));
    }
    const nick = $('nick');
    nick.addEventListener('input', () => {
      this.entry.nick = nick.value;
      if (this.errKey === 'err.nickEmpty' || this.errKey === 'err.nickLong') this.showErr('');
    });
    $('countryBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      this.openPicker();
    });
    $('pickClose').addEventListener('click', (e) => {
      e.stopPropagation();
      this.closePicker();
    });
    const search = $('pickSearch');
    search.addEventListener('input', () => this.filterPicker(search.value));
    search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); this.movePick(1); }
      else if (e.key === 'Enter') { e.preventDefault(); const f = this.visiblePicks()[0]; if (f) this.choose(f.dataset.code); }
      else if (e.key === 'Escape') { e.preventDefault(); this.closePicker(); }
    });
    const list = $('pickList');
    list.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-code]');
      if (li) { e.stopPropagation(); this.choose(li.dataset.code); }
    });
    list.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this.movePick(e.key === 'ArrowDown' ? 1 : -1); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const li = document.activeElement.closest && document.activeElement.closest('li[data-code]'); if (li) this.choose(li.dataset.code); }
      else if (e.key === 'Escape') { e.preventDefault(); this.closePicker(); }
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) search.focus();
    });
    $('picker').addEventListener('click', (e) => { if (e.target.id === 'picker') this.closePicker(); });
  }

  // restore what this tab already entered (sessionStorage via main), then show it
  setEntry(nick, country) {
    this.entry.nick = nick || '';
    this.entry.country = country || '';
    $('nick').value = this.entry.nick;
    this.showCountry();
  }

  showCountry() {
    const v = $('countryVal');
    v.textContent = this.entry.country ? regionName(this.entry.country) : t('entry.countryPh');
    v.classList.toggle('ph', !this.entry.country);
  }

  showErr(key) {
    this.errKey = key;
    $('entryErr').textContent = key ? t(key, { n: NICK_MAX }) : '';
    $('nick').setAttribute('aria-invalid', key && key.startsWith('err.nick') ? 'true' : 'false');
    $('countryBtn').setAttribute('aria-invalid', key === 'err.country' ? 'true' : 'false');
  }

  // null (with the reason shown and the field focused) or { nick, country }
  checkEntry() {
    const e = checkNick($('nick').value);
    if (e) {
      this.showErr(e);
      this.shake($('nick'));
      $('nick').focus({ preventScroll: true });
      return null;
    }
    if (!this.entry.country) {
      this.showErr('err.country');
      this.shake($('countryBtn'));
      $('countryBtn').focus({ preventScroll: true });
      return null;
    }
    this.showErr('');
    const nick = cleanNick($('nick').value);
    $('nick').value = nick;
    this.entry.nick = nick;
    return { nick, country: this.entry.country };
  }

  shake(el) {
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
  }

  openPicker() {
    const list = $('pickList');
    if (list.dataset.lang !== lang()) {
      // built once per language: all 249 entries, sorted for that language
      list.innerHTML = '';
      const frag = document.createDocumentFragment();
      for (const it of regionList().items) {
        const li = document.createElement('li');
        li.dataset.code = it.code;
        li.dataset.key = it.key;
        li.setAttribute('role', 'option');
        li.tabIndex = -1;
        li.textContent = it.name;
        frag.appendChild(li);
      }
      list.appendChild(frag);
      list.dataset.lang = lang();
    }
    for (const li of list.children) li.setAttribute('aria-selected', li.dataset.code === this.entry.country ? 'true' : 'false');
    const search = $('pickSearch');
    search.value = '';
    this.filterPicker('');
    $('picker').hidden = false;
    this.pickerOpen = true;
    const sel = list.querySelector('[aria-selected="true"]');
    if (sel) sel.scrollIntoView({ block: 'center' });
    else list.scrollTop = 0;
    // keyboards (desktop) type straight into the search; on touch the list is shown first
    if (this.kbd || !matchMedia('(pointer: coarse)').matches) search.focus({ preventScroll: true });
  }

  closePicker(focusBack = true) {
    if (!this.pickerOpen) return;
    $('picker').hidden = true;
    this.pickerOpen = false;
    if (focusBack) $('countryBtn').focus({ preventScroll: true });
  }

  filterPicker(q) {
    const k = norm(q).trim();
    let n = 0;
    for (const li of $('pickList').children) {
      const hit = !k || li.dataset.key.includes(k);
      li.hidden = !hit;
      if (hit) n++;
    }
    $('pickNone').hidden = n > 0;
  }

  visiblePicks() {
    return [...$('pickList').children].filter((li) => !li.hidden);
  }

  movePick(d) {
    const vis = this.visiblePicks();
    if (!vis.length) return;
    const i = vis.indexOf(document.activeElement);
    const j = i < 0 ? (d > 0 ? 0 : vis.length - 1) : Math.max(0, Math.min(vis.length - 1, i + d));
    vis[j].focus();
  }

  choose(code) {
    this.entry.country = code;
    this.showCountry();
    if (this.errKey === 'err.country') this.showErr('');
    this.closePicker();
    if (this.h.entryChanged) this.h.entryChanged();
  }

  // language switched: everything that was built from the dictionary is rebuilt
  relabel() {
    for (const id of ['langSel', 'langSel2']) $(id).value = lang();
    this.setSound(this.muted, this.volume);
    this.showCountry();
    if (this.errKey) this.showErr(this.errKey);
    if (this.pickerOpen) { $('pickList').dataset.lang = ''; this.openPicker(); }
    this.el.pauseNote.textContent = this.pauseKey ? t(this.pauseKey) : '';
    if (this.order) this.setOrder(this.order, this.chal, true);
    if (this.mode === 'play' || this.mode === 'pause') {
      if (this.step) {
        const k = this.key;
        this.buildSide(this.step);
        this.cur = null;
        if (k) { this.key = ''; this.hint(k, this.hintN || 0, true); }
        if (this.lastGame) this.refresh(this.lastGame, true);
      }
    }
    if (this.lastRes) this.showResult(this.lastRes.res, this.lastRes.extra, true);
    for (const f of document.querySelectorAll('.hf')) f.innerHTML = FIG[f.dataset.fig] || '';
  }

  // --u = min(innerHeight, innerWidth * 0.5625) / 100 px; every size in style.css derives from it
  layout() {
    this.u = Math.min(innerHeight, innerWidth * 0.5625) / 100;
    document.documentElement.style.setProperty('--u', this.u + 'px');
  }

  insets() {
    if (!this.probe) {
      const p = document.createElement('div');
      p.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;' +
        'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
      document.body.appendChild(p);
      this.probe = p;
    }
    const cs = getComputedStyle(this.probe);
    return { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };
  }

  // ------------------------------------------------------------ screens
  setScreen(name) {
    this.mode = name;
    if (name !== 'title') this.closePicker(false);
    if (name !== 'result') this.lastRes = null;
    for (const s of ['title', 'howto', 'pause', 'result']) this.el[s].hidden = s !== name;
    this.showHud(name === 'play' || name === 'pause');
    document.body.dataset.screen = name;
    if (name === 'pause') this.setPause();
    const focus = { title: 'startBtn', howto: 'howGo', pause: 'resumeBtn', result: this.el.nextBtn.hidden ? 'againBtn' : 'nextBtn' }[name];
    if (focus && this.kbd) setTimeout(() => { const e = $(focus); if (e) e.focus({ preventScroll: true }); }, 30);
  }

  // the pause card's 全画面 button: only where the browser can do it and it is not already full screen
  setFullscreen(supported, active) {
    const b = $('fsBtn');
    if (b) b.hidden = !supported || active;
  }

  setRotate(on) {
    this.el.rotate.hidden = !on;
  }

  showHud(on) {
    this.el.top.hidden = !on;
    this.el.guide.hidden = !on;
    this.el.side.hidden = !on;
  }

  // pause card text (e.g. after coming back from portrait or a hidden tab)
  setPause(noteKey = 'pause.note') {
    this.pauseKey = noteKey;
    this.el.pauseTitle.textContent = t('pause.title');
    this.el.pauseNote.textContent = noteKey ? t(noteKey) : '';
  }

  loaded() {
    const L = this.el.loading;
    L.classList.add('out');
    setTimeout(() => { if (L.classList.contains('out')) L.hidden = true; }, 480);
  }

  // e.g. WebGL unavailable: keep the loading screen up with a clear message
  fatal(text) {
    const L = this.el.loading;
    L.hidden = false;
    L.classList.remove('out');
    L.classList.add('error');
    const img = L.querySelector('img');
    if (img) img.src = 'assets/umaki/wow.webp';
    this.el.loadMsg.textContent = text || t('err.webgl2');
  }

  setSound(muted, volume) {
    this.muted = muted;
    this.volume = volume;
    this.el.soundBtn.innerHTML = muted ? SOUND_OFF : SOUND_ON;
    this.el.soundBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
    const chip = (muted ? SOUND_OFF : SOUND_ON) + `<span>${t(muted ? 'sound.off' : 'sound.on')}</span>`;
    this.el.titleSound.innerHTML = chip;
    this.el.muteBtn.innerHTML = chip;
    const v = Math.round(clamp01(volume) * 100);
    this.el.vol.value = v;
    this.el.vol.style.setProperty('--p', v + '%');
  }

  // ------------------------------------------------------------ guide
  // free text from the game (events); situational hints wait while it is showing
  say(text, hold = 2.6) {
    this.sayHold = hold;
    this.key = '';
    this.setSay(String(text), false);
  }

  setSay(text, html) {
    if (this.cur === text) return;
    this.cur = text;
    if (html) this.el.say.innerHTML = text;
    else this.el.say.textContent = text;
    const b = this.el.bubble;
    b.classList.remove('pop');
    void b.offsetWidth;
    b.classList.add('pop');
  }

  // quick: a prompt that follows what the hand is doing right now (the つけダレ carry), so it may
  // replace the previous one at once instead of waiting until that one could be read
  hint(key, n = 0, force = false, quick = false) {
    const tx = t('g.' + key);
    if (!Array.isArray(tx)) return;
    if (!force) {
      if (this.sayHold > 0) return;
      // keep a hint up long enough to be read before a different one replaces it
      if (!quick && key !== this.key && this.key && this.keyAge < 1.3) return;
    }
    if (key !== this.key) {
      this.key = key;
      this.keyAge = 0;
    }
    this.hintN = n;
    this.setSay(tx[this.first ? 0 : 1].replace('{n}', String(n)), true);
  }

  fig(name) {
    this.el.fig.innerHTML = name && FIG[name] ? FIG[name] : '';
  }

  pose(name, hold = 1.6) {
    if (!POSES.includes(name)) name = 'idle';
    if (this.poseName !== name) {
      this.el.umaki.src = 'assets/umaki/' + name + '.webp';
      this.poseName = name;
    }
    this.poseT = name === 'idle' ? 0 : hold;
    const u = this.el.umaki;
    u.classList.remove('hop');
    void u.offsetWidth;
    if (name !== 'idle') u.classList.add('hop');
  }

  toast(text, soft) {
    const t = this.el.toast;
    t.textContent = text;
    t.classList.toggle('soft', !!soft);
    t.classList.remove('show');
    void t.offsetWidth;
    t.classList.add('show');
  }

  // order card (top-left). info = { n, of } in challenge mode; null hides it for the standard order.
  setOrder(key, info = null, quiet = false) {
    this.order = ORDERS[key] ? key : 'standard';
    this.chal = info;
    const show = !!info || this.order !== 'standard';
    const el = this.el.order;
    el.hidden = !show;
    if (!show) return;
    this.el.orderName.textContent = t('ord.' + this.order);
    this.el.orderNote.textContent = this.order === 'standard' ? t('order.stdNote') : t('ord.' + this.order + '.note');
    this.el.orderPlate.textContent = info ? t('order.plate', { n: info.n, of: info.of }) : '';
    if (quiet) return;
    el.classList.remove('fresh');
    void el.offsetWidth;
    el.classList.add('fresh');
  }

  // ------------------------------------------------------------ steps
  setStep(step, game) {
    this.step = step;
    this.key = '';
    this.keyAge = 0;
    this.sayHold = 0;
    this.meterT = 0;
    if (game && (game.order || 'standard') !== this.order) this.setOrder(game.order, this.chal);
    const k = CHIP[step] ?? -1;
    this.chips.forEach((li, i) => {
      li.className = i === k ? 'on' : i < k ? 'past' : '';
    });
    this.fig(step);
    this.buildSide(step);
    this.hint(step, 0, true);
    if (game) this.refresh(game, true);
  }

  addBtn(name, html, cls = '') {
    const b = document.createElement('button');
    b.className = 'btn ' + cls;
    b.innerHTML = html;
    b.dataset.act = name;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!b.disabled && this.h.action) this.h.action(name);
    });
    this.el.actions.appendChild(b);
    this.btn[name] = b;
    return b;
  }

  buildSide(step) {
    const m = this.el.meter;
    this.el.actions.innerHTML = '';
    this.btn = {};
    this.mEls = {};
    let html = '';
    if (step === 'cut' || step === 'open' || step === 'bone') {
      html = `<div class="m-title"><span>${t('m.' + step)}</span><small>${t('m.headTail')}</small></div><div class="bar ${step}"><i data-m="bar"></i></div>`;
    } else if (step === 'skewer' || step === 'unskewer') {
      const cnt = step === 'skewer' ? `<b data-m="count">0</b><small>${t('m.skewerOf')}</small>` : `<small>${t('m.left')}</small><b data-m="count">0</b>`;
      const slots = Array.from({ length: TUNE.maxSkewers }, (_, i) => `<i class="${step === 'skewer' && i >= TUNE.minSkewers ? 'opt' : ''}"></i>`).join('');
      html = `<div class="m-title"><span>${t('m.skewer')}</span><span>${cnt}</span></div><div class="sk" data-m="sk">${slots}</div>` +
        (step === 'skewer' ? `<p class="sk-note">${t('m.skNote')}</p>` : '');
      if (step === 'skewer') this.addBtn('toGrill', t('btn.toGrill'), 'big');
    } else if (GRILL_STEPS.includes(step)) {
      const row = (f, label) => `<span class="lb">${label}</span><div class="sw" data-f="${f}">${'<i></i>'.repeat(SEGS)}</div><span class="dn" data-f="${f}" title="${t('m.coalSide')}">${FLAME}</span>`;
      html = `<div class="m-title"><span>${t('m.color')}</span><small>${t('m.headTail')}</small></div>` +
        `<div class="face">${row(FLESH, t('m.flesh'))}${row(SKIN, t('m.skin'))}</div>` +
        `<div class="legend"><span>${t('m.raw')}</span><i class="grad"></i><span>${t('m.burnt')}</span></div>`;
      if (step === 'tare') {
        html += `<div class="dipm"><span class="lb">${t('m.tare')}</span><span class="dots" data-m="dips"><i></i><i></i><i class="opt"></i></span>` +
          '<div class="soak" data-m="soakbox"><i class="ok"></i><i data-m="soak"></i></div></div>';
      }
      if (step === 'white' || step === 'tare') {
        this.addBtn('flip', FLIP + `<span>${t('btn.flip')}</span>`, 'sub');
        if (step === 'white') this.addBtn('toTare', t('btn.toTare'), 'big').dataset.confirm = '1';
        else this.addBtn('toBoard', t('btn.toBoard'), 'big').dataset.confirm = '1';
      }
    } else if (step === 'slice') {
      html = `<div class="m-title"><span>${t('m.slice')}</span><span><b data-m="count">0</b><small>${t('m.sliceOf')}</small></span></div>` +
        '<div class="slicebar" data-m="slice"><i class="g" style="left:33.3%"></i><i class="g" style="left:66.7%"></i></div>';
    } else if (step === 'plate') {
      html = `<div class="m-title"><span>${t('m.plate')}</span><span><b data-m="count">0</b><small>${t('m.plateOf')}</small></span></div>` +
        `<div class="pcs" data-m="pcs">${'<i></i>'.repeat(3)}</div>`;
    } else if (step === 'finish') {
      this.addBtn('finish', t('btn.finish'), 'big two ready');
    }
    m.innerHTML = html;
    for (const e of m.querySelectorAll('[data-m]')) this.mEls[e.dataset.m] = e;
    this.sw = GRILL_STEPS.includes(step) ? [FLESH, SKIN].map((f) => [...m.querySelectorAll(`.sw[data-f="${f}"] i`)]) : null;
    this.dn = GRILL_STEPS.includes(step) ? [FLESH, SKIN].map((f) => m.querySelector(`.dn[data-f="${f}"]`)) : null;
    this.swCache = [[], []];
  }

  setBtn(name, enabled, ready) {
    const b = this.btn[name];
    if (!b) return;
    if (b.disabled === enabled) b.disabled = !enabled;
    b.classList.toggle('ready', !!(enabled && ready));
    // a step button that may be pressed but it is still early: quiet colours, and the first press
    // only asks (main.mainAction)
    const early = !!(enabled && !ready && b.dataset.confirm);
    b.classList.toggle('early', early);
    if (!early) b.classList.remove('armed');
  }

  isEarly(name) {
    const b = this.btn[name];
    return !!(b && !b.disabled && b.classList.contains('early'));
  }

  armBtn(name, on) {
    const b = this.btn[name];
    if (b) b.classList.toggle('armed', !!on);
  }

  // ------------------------------------------------------------ per frame
  frame(game, dt) {
    if (this.poseT > 0) {
      this.poseT -= dt;
      if (this.poseT <= 0) this.pose('idle');
    }
    if (this.sayHold > 0) this.sayHold -= dt;
    this.keyAge += dt;
    if (this.mode !== 'play' || !game) return;
    if (game.step !== this.step) this.setStep(game.step, game);
    this.meterT -= dt;
    if (this.meterT > 0) return;
    this.meterT = 0.1;
    this.refresh(game);
  }

  // grill stats: per-face means and the cooked colour of each segment along the fillet
  grillStats(g) {
    const F = g.fish, N = F.N, M = F.M;
    const st = { mean: [0, 0], gl: [0, 0], ta: [0, 0], hot: 0 };
    const down = g.grill.down;
    const hotD = 1.75; // just short of char (1.9)
    for (let f = 0; f < 2; f++) {
      const D = F.D[f], C = F.B[f], G = F.G[f], T = F.A[f];
      let sd = 0, sg = 0, sa = 0, hot = 0;
      for (let s = 0; s < SEGS; s++) {
        const i0 = Math.floor((s * N) / SEGS), i1 = Math.floor(((s + 1) * N) / SEGS);
        let a = 0, cm = 0, cx = 0, b = 0, t = 0, n = 0;
        for (let i = i0; i < i1; i++) {
          for (let j = 0; j < M; j++) {
            const c = i * M + j;
            a += D[c];
            cm += C[c];
            if (C[c] > cx) cx = C[c];
            b += G[c];
            t += T[c];
            if (D[c] > hotD) hot++;
            n++;
          }
        }
        sd += a;
        sg += b;
        sa += t;
        if (this.sw && this.sw[f][s]) {
          const col = faceColor(f, a / n, (cm / n) * 0.55 + cx * 0.45, b / n, t / n);
          if (this.swCache[f][s] !== col) {
            this.swCache[f][s] = col;
            this.sw[f][s].style.backgroundColor = col;
          }
        }
      }
      const tot = N * M;
      st.mean[f] = sd / tot;
      st.gl[f] = sg / tot;
      st.ta[f] = sa / tot;
      if (f === down) st.hot = hot / tot;
    }
    return st;
  }

  refresh(g, force) {
    this.lastGame = g;
    const F = g.fish, s = g.step, E = this.mEls || {};
    const early = g.stepT < 3.2;
    if (s === 'cut') {
      if (E.bar) E.bar.style.width = (100 * F.cutFront) / F.L + '%';
      this.hint(g.knife.active ? 'cutGo' : F.cutFront > 0.6 ? 'cutRest' : 'cut');
    } else if (s === 'open') {
      if (E.bar) E.bar.style.width = 100 * F.openK + '%';
    } else if (s === 'bone') {
      if (E.bar) E.bar.style.width = (100 * F.peel) / F.L + '%';
      this.hint(g.boner.active ? 'boneGo' : F.peel > 0.6 ? 'boneRest' : 'bone');
    } else if (s === 'skewer' || s === 'unskewer') {
      const n = F.skewers.length;
      if (E.count) E.count.textContent = String(n);
      if (E.sk) {
        const total = s === 'skewer' ? TUNE.maxSkewers : F.skewersGrill.length || TUNE.maxSkewers;
        [...E.sk.children].forEach((e, i) => {
          e.hidden = i >= total;
          e.classList.toggle('on', i < n);
        });
      }
      if (s === 'skewer') {
        const ok = g.canGrill();
        this.setBtn('toGrill', ok, ok);
        if (n >= TUNE.minSkewers) this.hint('skewerOk');
        else if (n > 0) this.hint('skewerMore', TUNE.minSkewers - n);
        else this.hint('skewer');
      }
    } else if (GRILL_STEPS.includes(s)) {
      const st = (this.st = this.grillStats(g));
      const down = g.grill.down, up = 1 - down;
      if (this.dn) this.dn.forEach((e, f) => e && e.classList.toggle('on', f === down));
      const flipping = g.grill.flipping > 0;
      if (s === 'white') {
        const done = st.mean[FLESH] >= 0.85 && st.mean[SKIN] >= 0.85;
        this.setBtn('flip', !flipping);
        this.setBtn('toTare', g.readyForTare(), done);
        if (!early) {
          if (st.hot > 0.05) this.hint('hot');
          else if (done && g.readyForTare()) this.hint('whiteDone');
          else if (st.mean[down] - st.mean[up] >= 0.2) this.hint('whiteFlip');
          else if (st.mean[down] < 0.5) this.hint('whiteWait');
          else this.hint('white');
        }
      } else if (s === 'tare') {
        const target = (ORDERS[g.order] || ORDERS.standard).Glo;
        const glazed = st.gl[FLESH] >= target;
        const D = g.dip, wetDown = st.ta[down] > 0.1, wetUp = st.ta[up] > 0.1;
        this.setBtn('flip', !flipping && g.onGrill);
        this.setBtn('toBoard', g.readyToServe(), glazed && D.count >= 2 && g.onGrill && !wetDown && !wetUp);
        if (E.dips) [...E.dips.children].forEach((e, i) => e.classList.toggle('on', i < D.count));
        if (E.soak) {
          // time right under: the green zone is a good dip, past it the coat gets heavy
          E.soak.style.width = (100 * clamp01(D.under / 2.2)).toFixed(1) + '%';
          E.soak.className = D.under > TUNE.soakAfter ? 'over' : '';
        }
        if (E.soakbox) E.soakbox.classList.toggle('live', D.phase !== 'grill');
        if (D.phase === 'carry') {
          if (D.depth > 0.5) this.hint(D.under > TUNE.soakAfter ? 'tareLong' : 'tareIn', 0, false, true);
          else if (D.dipped && D.out > 0.05) this.hint('tareBack', 0, false, true);
          else this.hint('tareCarry', 0, false, true);
        } else if (D.phase === 'rest') this.hint(D.under > TUNE.soakAfter ? 'tareLong' : 'tareRest', 0, false, true);
        else if (!early || D.count > 0) {
          if (st.hot > 0.05) this.hint('hot');
          else if (D.count === 0) this.hint('tare');
          else if (wetDown) this.hint('tareSear');
          else if (wetUp) this.hint('tareFlip');
          else if (glazed && D.count >= 2) this.hint('tareDone');
          else this.hint('tareMore');
        }
      }
    } else if (s === 'slice') {
      const n = F.cuts.length;
      if (E.count) E.count.textContent = String(n);
      const bar = E.slice;
      if (bar && bar.dataset.n !== String(n)) {
        bar.dataset.n = String(n);
        for (const c of bar.querySelectorAll('.c')) c.remove();
        for (const u of F.cuts) {
          const c = document.createElement('i');
          c.className = 'c';
          c.style.left = (100 * u) / F.L + '%';
          bar.appendChild(c);
        }
      }
      this.hint(n === 1 ? 'sliceOne' : 'slice');
    } else if (s === 'plate') {
      const placed = F.pieces.filter((p) => p.placed).length;
      if (E.count) E.count.textContent = String(placed);
      if (E.pcs) [...E.pcs.children].forEach((e, i) => e.classList.toggle('on', i < placed));
      this.hint(g.holding != null ? 'plateHold' : 'plate');
    }
    void force;
  }

  // ------------------------------------------------------------ result
  // extra: { challenge: { n, of, scores: [total of each plate so far] }, best: number, newBest: bool }
  showResult(res, extra = {}, relabel = false) {
    this.lastRes = { res, extra };
    const ok = ORDERS[res.order] ? res.order : 'standard';
    $('resOrder').textContent = t('res.order', { name: t('ord.' + ok) });
    const ch = extra.challenge || null;
    const plate = $('resPlate');
    plate.hidden = !ch;
    if (ch) plate.textContent = t('res.plate', { n: ch.n, of: ch.of });
    // the player's own name: textContent only
    $('resWho').textContent = extra.nick ? t('res.who', { name: extra.nick }) + (extra.country ? ` · ${regionName(extra.country)}` : '') : t('res.done');
    $('resTitle').textContent = res.titleKey ? t(res.titleKey) : res.title;
    $('resScore').innerHTML = t('res.score', { n: Math.round(res.total) });
    const rank = Math.max(1, Math.min(5, res.rank | 0));
    $('resStars').innerHTML = '★'.repeat(rank) + `<span class="off">${'★'.repeat(5 - rank)}</span>`;
    $('resStars').setAttribute('aria-label', t('res.stars', { n: rank }));
    const ul = $('cats');
    ul.innerHTML = '';
    let delay = 0.25;
    for (const k of ['clean', 'cook', 'glaze', 'plate']) {
      const gr = grade(res.cats[k]);
      const li = document.createElement('li');
      if (k === res.best) li.className = 'best';
      const pips = [1, 2, 3, 4, 5].map((i) => {
        const onp = i <= gr;
        const d = onp ? (delay += 0.05) : 0;
        return `<i class="${onp ? 'on' : ''}" style="animation-delay:${d.toFixed(2)}s"></i>`;
      }).join('');
      li.innerHTML = `<span>${t('cat.' + k)}</span><span class="pips" aria-label="${t('res.pips', { n: gr })}">${pips}</span><span class="cw">${t('grade.' + gr)}</span>`;
      ul.appendChild(li);
    }
    $('resGood').textContent = res.best ? t('good.' + res.best) : res.good || '';
    $('resTip').textContent = res.tipKey ? t(res.tipKey) : res.tip || '';
    $('resUmaki').src = 'assets/umaki/' + (rank >= 4 ? 'cheer' : rank === 3 ? 'happy' : 'idle') + '.webp';

    const chal = $('resChal');
    chal.hidden = !ch;
    const last = ch && ch.n >= ch.of;
    if (ch) {
      const scores = ch.scores || [];
      const sum = scores.reduce((a, b) => a + b, 0);
      let h = '';
      for (let i = 0; i < ch.of; i++) h += scores[i] != null ? `<span class="dish">${t('res.dish', { n: Math.round(scores[i]) })}</span>` : '<span class="dish empty">・・・</span>';
      h += `<span class="sum">${t('res.sumLine', { label: t(last ? 'res.sum3' : 'res.sumSoFar'), n: Math.round(sum) })}</span>`;
      chal.innerHTML = h;
    }
    const best = $('resBest');
    best.hidden = extra.best == null;
    if (extra.best != null) best.innerHTML = t('res.best', { n: Math.round(extra.best) }) + (extra.newBest ? `<em>${t('res.newBest')}</em>` : '');

    this.el.nextBtn.hidden = !(ch && !last);
    this.el.againBtn.hidden = !!(ch && !last);
    this.el.againBtn.textContent = t(ch ? 'res.again3' : 'res.again');
    if (relabel) return;
    const stamp = document.querySelector('.stamp');
    stamp.classList.remove('pop');
    void stamp.offsetWidth;
    stamp.classList.add('pop');
    this.first = false;
  }

  // ------------------------------------------------------------ camera framing
  // screen rectangles (px) not covered by the UI. Mirrors the sizes in style.css.
  freeRects(W = innerWidth, H = innerHeight) {
    const u = Math.min(H, W * 0.5625) / 100;
    const s = this.insets();
    const px = (k, min) => Math.max(min, k * u);
    const top = s.t + 1.6 * u + px(9.4, 46) + 1.4 * u;
    const right = s.r + 2 * u + px(30, 136) + 1.5 * u;
    const bottom = s.b + 1 * u + px(22, 66) + 1.2 * u;
    const left = s.l + 2 * u;
    const play = { x: left, y: top, w: Math.max(120, W - left - right), h: Math.max(100, H - top - bottom) };
    const resW = Math.min(W * 0.52, Math.max(330, 82 * u)) + 2.4 * u + s.r;
    const result = { x: s.l + 2 * u, y: 3 * u, w: Math.max(120, W - resW - s.l - 4 * u), h: Math.max(100, H - 6 * u) };
    const panelR = s.l + 3 * u + Math.min(W - s.l - s.r - 6 * u, Math.max(640, 112 * u));
    const tx = Math.max(panelR + 2 * u, W * 0.55);
    const title = { x: tx, y: 4 * u, w: Math.max(120, W - tx - 2 * u - s.r), h: Math.max(100, H - 8 * u) };
    return { play, result, title };
  }
}
