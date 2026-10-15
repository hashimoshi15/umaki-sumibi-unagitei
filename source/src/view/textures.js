import * as THREE from 'three';
import { rng } from '../util.js';

// All textures are painted once at start-up (Canvas 2D / typed arrays), from fixed seeds so every run
// looks the same. Colours are the sRGB values measured from the design references
// (work/spec/design-spec.json). Tiling textures use periodic noise so they repeat without seams.
// Results are cached: calling a function twice returns the same texture (clone() before changing
// repeat/offset for a second use). Roughness maps hold absolute roughness: use material.roughness = 1.

// ---------- quality, cache, timing ----------
let LOW = false;
// { low: true } halves every canvas (phones). Per-call opts override it.
export function setTextureQuality(q) {
  LOW = !!(q && q.low);
}
export const textureTimings = {}; // ms per function, for QA
const cache = new Map();
const isLow = (o) => (o && o.low !== undefined ? !!o.low : LOW);
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
function memo(key, name, fn) {
  if (cache.has(key)) return cache.get(key);
  const t0 = now();
  const v = fn();
  if (name) textureTimings[name] = Math.round(((textureTimings[name] || 0) + now() - t0) * 10) / 10;
  cache.set(key, v);
  return v;
}

// ---------- small math ----------
const fade = (t) => t * t * (3 - 2 * t);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const sstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
function gauss(R) {
  let u = 0;
  while (u === 0) u = R();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * R());
}
// fast white noise for per-pixel grain (xorshift32), deterministic
function whiteNoise(n, seed) {
  const out = new Float32Array(n);
  let s = seed | 0 || 1;
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    out[i] = (s >>> 0) / 4294967296;
  }
  return out;
}

// ---------- colour helpers ----------
function rgbOf(c) {
  if (Array.isArray(c)) return c;
  if (typeof c === 'number') return [(c >> 16) & 255, (c >> 8) & 255, c & 255];
  if (c && c.isColor) return rgbOf(c.getHex());
  let s = String(c).replace('#', '');
  if (s.length === 3) s = s.replace(/./g, '$&$&');
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const css = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const mixC = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mulC = (a, k) => [Math.min(255, a[0] * k), Math.min(255, a[1] * k), Math.min(255, a[2] * k)];

// 256-entry colour ramp (flat rgb floats) from [[t, colour], ...]
function rampLUT(stops) {
  const lut = new Float32Array(256 * 3);
  const cs = stops.map((s) => rgbOf(s[1]));
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const f = clamp01((t - stops[k][0]) / (stops[k + 1][0] - stops[k][0] || 1));
    for (let ch = 0; ch < 3; ch++) lut[i * 3 + ch] = cs[k][ch] + (cs[k + 1][ch] - cs[k][ch]) * f;
  }
  return lut;
}

// ---------- canvas + texture helpers ----------
function makeCanvas(w, h) {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h);
}
function canvas2(W, H) {
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return { c, ctx };
}
function pixels(W, H) {
  const { c, ctx } = canvas2(W, H);
  const img = ctx.createImageData(W, H);
  return { c, ctx, img, d: img.data };
}
function texOf(c, { color = true, wrap = true, aniso = 4 } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (wrap) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  return t;
}
function dataTex(bytes, W, H, aniso) {
  const t = new THREE.DataTexture(bytes, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}
// single-texture results that also carry extra maps: works as `map: T.x()` and as `{ map, rough } = T.x()`
function bundle(tex, extra) {
  tex.map = tex;
  return Object.assign(tex, extra);
}
// grey map (roughness etc.) from a Float32 array of 0..1 values
function greyCanvas(v, W, H) {
  const { c, ctx, img, d } = pixels(W, H);
  for (let i = 0, o = 0; i < v.length; i++, o += 4) {
    const g = v[i] * 255;
    d[o] = d[o + 1] = d[o + 2] = g;
    d[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// ---------- periodic value noise ----------
// Cell counts across the texture are integers, so every field tiles exactly.
function addOctave(R, f, w, h, nx, ny, amp) {
  const g = new Float32Array(nx * ny);
  for (let i = 0; i < g.length; i++) g[i] = R() * amp;
  const X0 = new Int32Array(w), X1 = new Int32Array(w), FX = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const t = ((x + 0.5) * nx) / w, i = Math.floor(t);
    X0[x] = i % nx;
    X1[x] = (i + 1) % nx;
    FX[x] = fade(t - i);
  }
  for (let y = 0; y < h; y++) {
    const t = ((y + 0.5) * ny) / h, j = Math.floor(t), fy = fade(t - j);
    const r0 = (j % ny) * nx, r1 = ((j + 1) % ny) * nx, row = y * w;
    for (let x = 0; x < w; x++) {
      const fx = FX[x], x0 = X0[x], x1 = X1[x];
      const a = g[r0 + x0], ab = a + (g[r0 + x1] - a) * fx;
      const c = g[r1 + x0], cd = c + (g[r1 + x1] - c) * fx;
      f[row + x] += ab + (cd - ab) * fy;
    }
  }
}
function upsample(f, w, h, W, H) {
  const out = new Float32Array(W * H);
  const X0 = new Int32Array(W), X1 = new Int32Array(W), FX = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const t = ((x + 0.5) * w) / W - 0.5, i = Math.floor(t);
    X0[x] = (i + w) % w;
    X1[x] = (i + 1 + w) % w;
    FX[x] = t - i;
  }
  for (let y = 0; y < H; y++) {
    const t = ((y + 0.5) * h) / H - 0.5, j = Math.floor(t), fy = t - j;
    const r0 = ((j + h) % h) * w, r1 = ((j + 1 + h) % h) * w, row = y * W;
    for (let x = 0; x < W; x++) {
      const fx = FX[x], x0 = X0[x], x1 = X1[x];
      const a = f[r0 + x0], ab = a + (f[r0 + x1] - a) * fx;
      const c = f[r1 + x0], cd = c + (f[r1 + x1] - c) * fx;
      out[row + x] = ab + (cd - ab) * fy;
    }
  }
  return out;
}
// fbm in 0..1: base cells (cx, cy) across the whole texture, doubling per octave; `div` computes it
// at a lower resolution and upsamples (fine for smooth, low-frequency fields).
function fbm(R, W, H, cx, cy, oct = 1, gain = 0.5, div = 1) {
  const w = Math.max(1, Math.round(W / div)), h = Math.max(1, Math.round(H / div));
  const f = new Float32Array(w * h);
  let sum = 0;
  for (let o = 0, a = 1; o < oct; o++, a *= gain) sum += a;
  for (let o = 0, a = 1 / sum; o < oct; o++, a *= gain) {
    const k = 2 ** o;
    addOctave(R, f, w, h, Math.max(1, Math.round(cx * k)), Math.max(1, Math.round(cy * k)), a);
  }
  return w === W && h === H ? f : upsample(f, w, h, W, H);
}
function stretch(f) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < f.length; i++) {
    const v = f[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const k = 1 / (hi - lo || 1);
  for (let i = 0; i < f.length; i++) f[i] = (f[i] - lo) * k;
  return f;
}
function quantile(f, q) {
  const n = Math.min(f.length, 8192), s = new Float32Array(n), step = f.length / n;
  for (let i = 0; i < n; i++) s[i] = f[Math.floor(i * step)];
  s.sort();
  return s[Math.min(n - 1, Math.max(0, Math.floor(q * n)))];
}
// periodic 1D value noise, n cells over `len` samples
function noise1(R, len, n) {
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) g[i] = R();
  const out = new Float32Array(len);
  for (let x = 0; x < len; x++) {
    const t = ((x + 0.5) * n) / len, i = Math.floor(t);
    out[x] = g[i % n] + (g[(i + 1) % n] - g[i % n]) * fade(t - i);
  }
  return out;
}
// separable box blur (periodic), in place
function blur(f, W, H, r) {
  const tmp = new Float32Array(Math.max(W, H));
  const k = 1 / (2 * r + 1);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    let s = 0;
    for (let i = -r; i <= r; i++) s += f[row + ((i + W) % W)];
    for (let x = 0; x < W; x++) {
      tmp[x] = s * k;
      s += f[row + ((x + r + 1) % W)] - f[row + ((x - r + W) % W)];
    }
    for (let x = 0; x < W; x++) f[row + x] = tmp[x];
  }
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += f[((i + H) % H) * W + x];
    for (let y = 0; y < H; y++) {
      tmp[y] = s * k;
      s += f[((y + r + 1) % H) * W + x] - f[((y - r + H) % H) * W + x];
    }
    for (let y = 0; y < H; y++) f[y * W + x] = tmp[y];
  }
  return f;
}

// Tangent-space normals (OpenGL convention) from a height field in cm. sx, sy: cm per pixel.
// flip: canvas textures (flipY) have rows running toward -v.
function normalsInto(out, h, W, H, sx, sy, k, wrap, flip, maxSlope = 4) {
  const XM = new Int32Array(W), XP = new Int32Array(W);
  for (let x = 0; x < W; x++) {
    XM[x] = wrap ? (x - 1 + W) % W : Math.max(0, x - 1);
    XP[x] = wrap ? (x + 1) % W : Math.min(W - 1, x + 1);
  }
  const kx = k / (2 * sx), ky = (flip ? -k : k) / (2 * sy);
  for (let y = 0; y < H; y++) {
    const ym = wrap ? (y - 1 + H) % H : Math.max(0, y - 1);
    const yp = wrap ? (y + 1) % H : Math.min(H - 1, y + 1);
    const row = y * W, rm = ym * W, rp = yp * W;
    for (let x = 0; x < W; x++) {
      let dx = (h[row + XP[x]] - h[row + XM[x]]) * kx;
      let dy = (h[rp + x] - h[rm + x]) * ky;
      if (dx > maxSlope) dx = maxSlope; else if (dx < -maxSlope) dx = -maxSlope;
      if (dy > maxSlope) dy = maxSlope; else if (dy < -maxSlope) dy = -maxSlope;
      const inv = 127.5 / Math.sqrt(dx * dx + dy * dy + 1);
      const o = (row + x) << 2;
      out[o] = 128 - dx * inv;
      out[o + 1] = 128 - dy * inv;
      out[o + 2] = 128 + inv;
      out[o + 3] = 255;
    }
  }
  return out;
}
function normalCanvas(h, W, H, sx, sy, k, wrap = true) {
  const { c, ctx, img, d } = pixels(W, H);
  normalsInto(d, h, W, H, sx, sy, k, wrap, true);
  ctx.putImageData(img, 0, 0);
  return c;
}
// call fn(x, y) for every periodic copy of a small item (radius r px) that touches the canvas
function wrapAt(W, H, x, y, r, fn) {
  for (let i = -1; i <= 1; i++) {
    const X = x + i * W;
    if (X + r < 0 || X - r > W) continue;
    for (let j = -1; j <= 1; j++) {
      const Y = y + j * H;
      if (Y + r < 0 || Y - r > H) continue;
      fn(X, Y);
    }
  }
}

// =====================================================================================
// Eel flesh pattern: uv = (u / 12, w / 12 + 0.5), u along the fillet (cm, toward the tail), w across.
// R myomere chevrons + longitudinal ridges, G fine noise (top 10 % = fat bubbles), B soft blotches.
// DataTextures (row 0 = v 0, no flip), tiling in both directions.
// =====================================================================================
export function fishPattern(opts) {
  const low = isLow(opts);
  return memo('fish' + low, 'fishPattern', () => {
    const S = low ? 512 : 1024, TILE = 12, c = TILE / S;
    const R = rng(0x51ab1e);
    const N = 24, P = TILE / N, invP = 1 / P; // myomere pitch 0.5 cm, 24 per tile so u repeats exactly

    // across-the-fillet profile over a = |w|: [R base, height base, zigzag, line strength, jitter fade]
    const AL = 2048, AMAX = 6.6, AK = AL / AMAX, prof = new Float32Array(AL * 5);
    for (let k = 0; k < AL; k++) {
      const a = k / AK;
      const cr = -Math.cos(Math.PI * a); // crowns at |w| = 1 and 3, grooves at 0 (seam) and 2
      const ridge = Math.sign(cr) * Math.abs(cr) ** 0.75;
      const seam = Math.exp(-((a / 0.16) ** 2));
      const groove = Math.exp(-(((a - 2) / 0.13) ** 2));
      const fat = Math.exp(-(((a - 3.85) / 0.12) ** 2));
      const m = (a % 4) - 2;
      prof[k * 5] = 0.5 + 0.08 * ridge - 0.26 * seam - 0.05 * groove + 0.1 * fat;
      prof[k * 5 + 1] = 0.014 * ridge - 0.05 * seam - 0.008 * groove;
      // W-shaped myomere: apex toward the tail on the seam, toward the head on the side groove
      prof[k * 5 + 2] = 0.45 * (Math.sqrt(m * m + 0.03) - Math.sqrt(0.03));
      // lines fade out past the widest fillet (|w| > 4.4 cm) so those rows can skip them
      prof[k * 5 + 3] = (0.55 + 0.45 * sstep(-0.7, 0.7, ridge)) * (1 - 0.7 * seam) * (1 - sstep(4.4, 4.65, a));
      prof[k * 5 + 4] = 1 - sstep(5.2, 6.0, a); // no side-specific jitter near the v wrap
    }
    // crest line and the shadowed trough just behind it (toward the tail)
    const DL = 1024, DM = 0.3, DK = DL / (2 * DM);
    const lCrest = new Float32Array(DL), lTrough = new Float32Array(DL);
    for (let k = 0; k < DL; k++) {
      const d = k / DK - DM;
      lCrest[k] = Math.exp(-((d / 0.045) ** 2));
      lTrough[k] = Math.exp(-(((d - 0.1) / 0.055) ** 2));
    }
    // per-line jitter and gaps (separate for the two halves of the fillet)
    const jitA = new Float32Array(2 * N), jitB = new Float32Array(2 * N);
    for (let i = 0; i < 2 * N; i++) {
      jitA[i] = (R() - 0.5) * 0.12;
      jitB[i] = (R() - 0.5) * 0.14;
    }
    const GC = 16, GS = 0.45;
    const gapA = new Float32Array(2 * N * GC), gapB = new Float32Array(2 * N * GC);
    for (let i = 0; i < gapA.length; i++) {
      gapA[i] = sstep(0.1, 0.3, R()); // ~15 % of each main line is broken
      gapB[i] = sstep(0.3, 0.5, R());
    }
    // ridges wander a little along the length; each line wiggles along its own 1D noise; fine muscle
    // fibres run along u (a noise across w whose rows sway slowly)
    const wanA = noise1(R, S, 6), wanB = noise1(R, S, 20);
    const wan = new Float32Array(S);
    for (let i = 0; i < S; i++) wan[i] = (wanA[i] - 0.5) * 0.12 + (wanB[i] - 0.5) * 0.05;
    const WTL = 4096, WT = noise1(R, WTL, 29);
    for (let i = 0; i < WTL; i++) WT[i] = (WT[i] - 0.5) * 0.09;
    const fibW = noise1(R, S, 200), fibS = noise1(R, S, 6), fibOff = new Int32Array(S);
    for (let i = 0; i < S; i++) fibOff[i] = Math.round((fibS[i] - 0.5) * 0.12 / c);

    const Rf = new Float32Array(S * S), Hf = new Float32Array(S * S);
    for (let j = 0; j < S; j++) {
      const w = (j + 0.5) * c - TILE / 2, aw = Math.abs(w), side = w < 0 ? 0 : N;
      const wanK = sstep(0.25, 0.8, aw);
      if (aw > 4.75) {
        // outside any fillet: profile and fibres only
        for (let i = 0; i < S; i++) {
          const p = j * S + i, pi = Math.min(AL - 1, ((aw + wan[i] * wanK) * AK) | 0) * 5;
          Rf[p] = prof[pi] + 0.06 * (fibW[(j + fibOff[i]) & (S - 1)] - 0.5);
          Hf[p] = prof[pi + 1];
        }
        continue;
      }
      for (let i = 0; i < S; i++) {
        const p = j * S + i, u = (i + 0.5) * c;
        const a = aw + wan[i] * wanK;
        let ai = (a * AK) | 0;
        if (ai < 0) ai = 0; else if (ai >= AL) ai = AL - 1;
        const pi = ai * 5, fd = prof[pi + 4];
        const s0 = u - prof[pi + 2];
        const kw = ((s0 * invP + 32.25) | 0) + side;
        const s = s0 - WT[(ai + kw * 331) & (WTL - 1)] * fd;
        const ga = a / GS, gi = ga | 0, gt = ga - gi, gf = gt * gt * (3 - 2 * gt);
        // main lines
        let k = ((s * invP + 32) | 0) - 32;
        let k0 = k < 0 ? k + N : k >= N ? k - N : k;
        let k1 = k0 + 1 === N ? 0 : k0 + 1;
        let d0 = s - (k * P + jitA[side + k0] * fd), d1 = s - ((k + 1) * P + jitA[side + k1] * fd);
        let d = d0, kl = k0;
        if ((d1 < 0 ? -d1 : d1) < (d0 < 0 ? -d0 : d0)) {
          d = d1;
          kl = k1;
        }
        let di = ((d + DM) * DK) | 0;
        if (di < 0) di = 0; else if (di >= DL) di = DL - 1;
        let gb = (side + kl) * GC + gi;
        const visA = (gapA[gb] + (gapA[gb + 1] - gapA[gb]) * gf) * fd + 1 - fd;
        const cA = lCrest[di] * visA, tA = lTrough[di] * visA;
        // fainter secondary lines between them
        const sB = s - P * 0.5;
        k = ((sB * invP + 32) | 0) - 32;
        k0 = k < 0 ? k + N : k >= N ? k - N : k;
        k1 = k0 + 1 === N ? 0 : k0 + 1;
        d0 = sB - (k * P + jitB[side + k0] * fd);
        d1 = sB - ((k + 1) * P + jitB[side + k1] * fd);
        d = d0;
        kl = k0;
        if ((d1 < 0 ? -d1 : d1) < (d0 < 0 ? -d0 : d0)) {
          d = d1;
          kl = k1;
        }
        di = ((d + DM) * DK) | 0;
        if (di < 0) di = 0; else if (di >= DL) di = DL - 1;
        gb = (side + kl) * GC + gi;
        const visB = (gapB[gb] + (gapB[gb + 1] - gapB[gb]) * gf) * fd + 1 - fd;
        const cB = lCrest[di] * visB, tB = lTrough[di] * visB;

        const st = prof[pi + 3], fb = fibW[(j + fibOff[i]) & (S - 1)] - 0.5;
        Rf[p] = prof[pi] + st * (0.46 * cA - 0.26 * tA + 0.2 * cB - 0.1 * tB) + 0.06 * fb;
        Hf[p] = prof[pi + 1] + st * (0.02 * cA - 0.014 * tA + 0.008 * cB - 0.005 * tB) + 0.003 * fb;
      }
    }

    // G: fine noise, with fat bubbles (0.82..1) clustered on the crests
    const gA = fbm(R, S, S, 30, 30, 1, 0.5, 4), gB = fbm(R, S, S, 96, 96, 1, 0.5, 2), wn = whiteNoise(S * S, 0x2f6b);
    const G = new Float32Array(S * S);
    for (let p = 0; p < G.length; p++) {
      const v = 0.5 * gA[p] + 0.3 * gB[p] + 0.2 * wn[p];
      G[p] = 0.06 + 0.74 * fade(clamp01(0.5 + (v - 0.5) * 1.7));
      Hf[p] += 0.004 * (gB[p] - 0.5);
    }
    let placed = 0;
    for (let tries = 0; placed < 3600 && tries < 60000; tries++) {
      const x = R() * S, y = R() * S;
      if (R() > 0.25 + 0.75 * clamp01((Rf[(y | 0) * S + (x | 0)] - 0.4) * 2)) continue;
      placed++;
      const rad = (0.022 + 0.045 * R() * R()) / c, pk = 0.9 + 0.1 * R();
      const x0 = Math.floor(x - rad), x1 = Math.ceil(x + rad), y0 = Math.floor(y - rad), y1 = Math.ceil(y + rad);
      for (let yy = y0; yy <= y1; yy++) {
        const dy = yy + 0.5 - y, row = (((yy % S) + S) % S) * S;
        for (let xx = x0; xx <= x1; xx++) {
          const dx = xx + 0.5 - x, q = 1 - (dx * dx + dy * dy) / (rad * rad);
          if (q <= 0) continue;
          const p = row + (((xx % S) + S) % S);
          const v = 0.81 + (pk - 0.81) * Math.sqrt(q);
          if (v > G[p]) G[p] = v;
          Hf[p] += 0.008 * q;
        }
      }
    }
    // B: soft 1-3 cm blotches
    const Bf = stretch(fbm(R, S, S, 4, 4, 3, 0.55, 8));

    const pat = new Uint8Array(S * S * 4);
    for (let p = 0, o = 0; p < S * S; p++, o += 4) {
      pat[o] = clamp01(Rf[p]) * 255 + 0.5;
      pat[o + 1] = G[p] * 255 + 0.5;
      pat[o + 2] = clamp01(0.5 + (Bf[p] - 0.5) * 1.15) * 255 + 0.5;
      pat[o + 3] = 255;
    }
    const nb = new Uint8Array(S * S * 4);
    normalsInto(nb, Hf, S, S, c, c, 1, true, false);
    return { pattern: dataTex(pat, S, S, 8), normal: dataTex(nb, S, S, 8) };
  });
}

// =====================================================================================
// Backbone strip: u along the 42 cm strip, v across. Pale translucent vertebrae ~0.6 cm, fine ribs.
// =====================================================================================
export function boneTexture(opts) {
  const low = isLow(opts);
  return memo('bone' + low, 'boneTexture', () => {
    const W = low ? 512 : 1024, H = low ? 32 : 64, NSEG = 70;
    const R = rng(0xb0e5);
    const { c, ctx, img, d } = pixels(W, H);
    const n1 = fbm(R, W, H, 40, 3, 2, 0.5, 1);
    const segJ = new Float32Array(NSEG + 1);
    for (let i = 0; i <= NSEG; i++) segJ[i] = (R() - 0.5) * 0.12;
    const base = rgbOf('#d8d2c8'), joint = rgbOf('#aaa196'), body = rgbOf('#e9e4dc'), blood = rgbOf('#9a6a5e');
    for (let y = 0; y < H; y++) {
      const v = (y + 0.5) / H, vc = Math.abs(v - 0.5) * 2;
      for (let x = 0; x < W; x++) {
        const su = ((x + 0.5) / W) * NSEG, k = Math.floor(su);
        const fs = su - k + segJ[k];
        const jd = Math.min(Math.abs(fs), Math.abs(1 - fs));
        const jt = Math.exp(-((jd / 0.07) ** 2));
        // centrum: hourglass, brightest across the middle of each segment, narrower at its waist
        const waist = 1 - 0.35 * Math.sin(Math.PI * clamp01(fs));
        const bd = sstep(0.95, 0.55, vc / waist) * (1 - jt);
        const n = n1[y * W + x];
        let r = base[0], g = base[1], b = base[2];
        r += (body[0] - r) * bd * 0.8; g += (body[1] - g) * bd * 0.8; b += (body[2] - b) * bd * 0.8;
        r += (joint[0] - r) * jt * 0.6; g += (joint[1] - g) * jt * 0.6; b += (joint[2] - b) * jt * 0.6;
        const bl = Math.exp(-((vc / 0.12) ** 2)) * sstep(0.45, 0.8, n) * 0.35;
        r += (blood[0] - r) * bl; g += (blood[1] - g) * bl; b += (blood[2] - b) * bl;
        const k2 = 0.94 + 0.1 * n - 0.12 * sstep(0.7, 1, vc);
        const o = (y * W + x) * 4;
        d[o] = r * k2; d[o + 1] = g * k2; d[o + 2] = b * k2; d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // fine translucent ribs angled back toward the tail from both edges
    const sw = W / NSEG;
    ctx.lineWidth = Math.max(1, W / 1024);
    for (let i = 0; i < NSEG; i++) {
      const x = (i + 0.5 + segJ[i]) * sw;
      for (const e of [0, 1]) {
        const y0 = e ? H * 0.62 : H * 0.38, y1 = e ? H : 0;
        ctx.strokeStyle = 'rgba(246,242,236,0.38)';
        ctx.beginPath();
        ctx.moveTo(x, y0);
        ctx.quadraticCurveTo(x + sw * 0.35, (y0 + y1) / 2, x + sw * (0.8 + 0.3 * R()), y1);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(120,108,96,0.16)';
        ctx.beginPath();
        ctx.moveTo(x + 1, y0);
        ctx.quadraticCurveTo(x + sw * 0.35 + 1, (y0 + y1) / 2, x + sw * 0.9 + 1, y1);
        ctx.stroke();
      }
    }
    return texOf(c, { wrap: false });
  });
}

// =====================================================================================
// Head skin for the head lathe. u = around the lathe (fishview rotates it so the back is at u = 0.75
// and the throat at u = 0.25), v = neck (0) -> snout (1). Dark olive cap, cream-tan cheek and jaw,
// mouth groove, gill slit, nostrils. Repeats around u.
// =====================================================================================
export function headSkin(opts) {
  const low = isLow(opts);
  return memo('head' + low, 'headSkin', () => {
    const W = low ? 256 : 512, H = low ? 128 : 256;
    const R = rng(0x4ead5);
    const n1 = stretch(fbm(R, W, H, 8, 3, 3, 0.55, 2));
    const n2 = fbm(R, W, H, 48, 4, 1);
    const { c, ctx, img, d } = pixels(W, H);
    // colour along the dorsal coordinate (0 throat .. 1 back), for the head and for the neck (body);
    // the cap boundary rises a little toward the snout, so keep a few LUTs along the length
    const headLuts = [];
    for (let i = 0; i <= 8; i++) {
      const bnd = 0.4 + 0.01 * i;
      // pale throat, bronze cheeks below the eye, darkening gradually over the crown (as in 02)
      headLuts.push(rampLUT([[0, '#d6d1c7'], [0.4, '#b3b0a1'], [bnd + 0.2, '#807f73'], [0.76, '#474742'], [0.9, '#242626'], [1, '#131416']]));
    }
    const bodyLut = rampLUT([[0, '#d6d1c7'], [0.4, '#b3b0a1'], [0.62, '#807f73'], [0.78, '#474742'], [0.9, '#242626'], [1, '#131416']]);
    const DORS = new Float32Array(W);
    for (let x = 0; x < W; x++) DORS[x] = 0.5 - 0.5 * Math.sin((2 * Math.PI * (x + 0.5)) / W);
    const groove = rgbOf('#2a1d14'), gill = rgbOf('#5d4127');
    for (let y = 0; y < H; y++) {
      const t = 1 - (y + 0.5) / H, bnd = 0.4 + 0.08 * t, lut = headLuts[Math.round(t * 8)], nb = sstep(0, 0.3, t);
      const mouthRow = sstep(0.62, 0.7, t) * 0.85, md = bnd - 0.07, gillRow = Math.abs(t - 0.1) < 0.06, noseRow = t > 0.93;
      for (let x = 0; x < W; x++) {
        const dors = DORS[x], p = y * W + x, li = ((dors * 255) | 0) * 3;
        const m = 0.93 + 0.14 * n1[p];
        let r = (bodyLut[li] + (lut[li] - bodyLut[li]) * nb) * m;
        let g = (bodyLut[li + 1] + (lut[li + 1] - bodyLut[li + 1]) * nb) * m;
        let b = (bodyLut[li + 2] + (lut[li + 2] - bodyLut[li + 2]) * nb) * m;
        // faint slime streaks along the back
        if (dors > 0.55) {
          const sl = sstep(0.6, 0.9, n2[p]) * sstep(0.55, 0.9, dors) * 0.08;
          r += (150 - r) * sl; g += (140 - g) * sl; b += (130 - b) * sl;
        }
        // mouth groove on both sides toward the snout, nostrils at the tip
        let dk = mouthRow > 0 ? (1 - sstep(0.006, 0.016, Math.abs(dors - md))) * mouthRow : 0;
        if (noseRow) {
          const u = (x + 0.5) / W, a = (u - 0.66) * 3, e = (u - 0.84) * 3, f = t - 0.965;
          dk = Math.max(dk, 1 - sstep(0.012, 0.022, Math.sqrt(Math.min(a * a, e * e) + f * f)));
        }
        r += (groove[0] - r) * dk; g += (groove[1] - g) * dk; b += (groove[2] - b) * dk;
        // gill slit near the neck, below the midline
        if (gillRow && dors > 0.27 && dors < 0.46) {
          const gk = (1 - sstep(0.008, 0.016, Math.abs(t - 0.1 - 0.15 * (dors - 0.36)))) * sstep(0.27, 0.3, dors) * (1 - sstep(0.43, 0.46, dors)) * 0.7;
          r += (gill[0] - r) * gk; g += (gill[1] - g) * gk; b += (gill[2] - b) * gk;
        }
        const o = p * 4;
        d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = texOf(c);
    tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  });
}

// =====================================================================================
// Hinoki cutting board, top face 74 x 28 cm (canvas x = +x, canvas top = far edge).
// Pale wood, fine straight grain, knife scratches, a damp darker zone where the eel lies.
// Colour map with .rough.
// =====================================================================================
export function boardWood(opts) {
  const low = isLow(opts);
  return memo('board' + low, 'boardWood', () => {
    const W = low ? 1024 : 2048, H = low ? 384 : 768, CW = 74, CH = 28;
    const kx = W / CW, ky = H / CH, px = W / 2048;
    const R = rng(0xb0a7d);
    const { c, ctx } = canvas2(W, H);
    // 1) slow colour drift (8 cm) and soft tone stripes along the grain, painted small and enlarged
    {
      const sw = 128, sh = 192;
      const nf = stretch(fbm(R, sw, sh, 9, 4, 3, 0.5));
      const st = noise1(R, sh, 19), st2 = noise1(R, sh, 47);
      const s = pixels(sw, sh);
      const lut = rampLUT([[0, '#d5b592'], [0.5, '#dfc4a2'], [1, '#e6cfb1']]);
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
        const i = y * sw + x;
        const v = clamp01(0.5 + (nf[i] - 0.5) * 0.9 + (st[y] - 0.5) * 0.45 + (st2[y] - 0.5) * 0.25);
        const li = ((v * 255) | 0) * 3;
        s.d[i * 4] = lut[li]; s.d[i * 4 + 1] = lut[li + 1]; s.d[i * 4 + 2] = lut[li + 2]; s.d[i * 4 + 3] = 255;
      }
      s.ctx.putImageData(s.img, 0, 0);
      ctx.drawImage(s.c, 0, 0, W, H);
    }
    // 2) growth rings: lognormal spacing (mean 0.38 cm), every 5th-8th a darker latewood line
    const ph1 = R() * 6.28, ph2 = R() * 6.28;
    const lines = [];
    let y = R() * 0.3, nextLate = 5 + Math.floor(R() * 4), count = 0;
    while (y < CH + 0.4) {
      const gap = Math.min(0.7, Math.max(0.15, Math.exp(Math.log(0.38) - 0.06 + 0.35 * gauss(R))));
      y += gap;
      count++;
      const late = count >= nextLate;
      if (late) {
        count = 0;
        nextLate = 5 + Math.floor(R() * 4);
      }
      lines.push({ y, gap, late, a: 0.16 + 0.12 * R(), ph: R() * 6.28, j: R() });
    }
    // neighbouring lines run nearly parallel; the sway drifts slowly across the board
    const wave = (x, y0, L) => y0 + 0.22 * Math.sin((2 * Math.PI * x) / 31 + ph1 + 0.21 * y0)
      + 0.07 * Math.sin((2 * Math.PI * x) / 11.3 + ph2 + 0.37 * y0) + 0.035 * L.j * Math.sin((2 * Math.PI * x) / 4.1 + L.ph);
    const path = (g, L, off, sx, sy) => {
      g.beginPath();
      for (let x = -0.5; x <= CW + 0.5; x += 0.5) {
        const yy = (wave(x, L.y, L) + off) * sy;
        if (x < 0) g.moveTo(x * sx, yy);
        else g.lineTo(x * sx, yy);
      }
    };
    const ring = rgbOf('#c9a57f'), lateC = rgbOf('#b88f66');
    for (const L of lines) {
      // soft band (earlywood -> latewood) just before each line
      ctx.strokeStyle = css(ring, L.late ? 0.09 : 0.05);
      ctx.lineWidth = L.gap * ky * 0.55;
      path(ctx, L, -L.gap * 0.32, kx, ky);
      ctx.stroke();
      ctx.strokeStyle = L.late ? css(lateC, 0.28) : css(ring, L.a);
      ctx.lineWidth = (L.late ? 2.4 : 1.3 + 0.6 * L.j) * px * 1.4;
      path(ctx, L, 0, kx, ky);
      ctx.stroke();
    }
    // 3) fine fibre streaks along the grain + pores
    {
      const sw = W / 16;
      const s = pixels(sw, H), wn = whiteNoise(sw * H, 0x51a7);
      for (let i = 0; i < sw * H; i++) {
        s.d[i * 4] = s.d[i * 4 + 1] = s.d[i * 4 + 2] = wn[i] * 255;
        s.d[i * 4 + 3] = 255;
      }
      s.ctx.putImageData(s.img, 0, 0);
      ctx.save();
      ctx.globalCompositeOperation = 'overlay';
      ctx.globalAlpha = 0.08;
      ctx.drawImage(s.c, 0, 0, W, H);
      ctx.restore();
      ctx.fillStyle = css(rgbOf('#c2a07c'), 0.15);
      const np = Math.round(CW * CH * 2.2);
      for (let i = 0; i < np; i++) {
        const x = R() * W, yy = R() * H, len = (0.1 + 0.2 * R()) * kx;
        ctx.fillRect(x, yy, len, Math.max(1, px * 1.5));
      }
    }
    // 4) knife scratches, mostly across the grain in the working area
    const scratches = [];
    for (let i = 0; i < 56; i++) {
      const x = (8 + 58 * R()) * kx, yy = (3 + 22 * R()) * ky;
      const a = (R() - 0.5) * 0.7 + (R() < 0.15 ? Math.PI / 2 : 0), len = (1 + 5 * R() * R()) * ky;
      scratches.push([x, yy, x + Math.sin(a) * len, yy + Math.cos(a) * len, 0.1 + 0.1 * R()]);
    }
    ctx.lineWidth = Math.max(1, px * 1.2);
    for (const s of scratches) {
      ctx.strokeStyle = `rgba(150,112,76,${s[4] * 0.45})`;
      ctx.beginPath(); ctx.moveTo(s[0] + 1, s[1]); ctx.lineTo(s[2] + 1, s[3]); ctx.stroke();
      ctx.strokeStyle = css(rgbOf('#ecd6ba'), s[4] + 0.04);
      ctx.beginPath(); ctx.moveTo(s[0], s[1]); ctx.lineTo(s[2], s[3]); ctx.stroke();
    }
    // 5) damp zone where the eel lies (board-local x 12..58 cm, centred across): one broad soft
    // darkening with a few overlapping lobes so its edge is irregular
    const blobs = [[35, 14, 26, 6.5, 1]];
    for (let i = 0; i < 9; i++) blobs.push([16 + 38 * R(), 14 + (R() - 0.5) * 4, 6 + 7 * R(), 3 + 2.5 * R(), 0.5]);
    const blobPaint = (g, sx, sy, col, a) => {
      for (const b of blobs) {
        g.save();
        g.translate(b[0] * kx * sx, b[1] * ky * sy);
        g.scale(b[2] / b[3], 1);
        const r = b[3] * ky * sy;
        const gr = g.createRadialGradient(0, 0, 0, 0, 0, r);
        gr.addColorStop(0, css(col, a * b[4]));
        gr.addColorStop(0.55, css(col, a * b[4] * 0.75));
        gr.addColorStop(1, css(col, 0));
        g.fillStyle = gr;
        g.beginPath();
        g.arc(0, 0, r, 0, Math.PI * 2);
        g.fill();
        g.restore();
      }
    };
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    blobPaint(ctx, 1, 1, rgbOf('#c99a6c'), 0.16);
    ctx.restore();
    const beads = [];
    for (let i = 0; i < 18; i++) beads.push([(10 + 50 * R()) * kx, (8 + 12 * R()) * ky, (0.08 + 0.18 * R()) * ky]);
    // 6) slightly grimy worn edges
    {
      const e = 0.9 * ky;
      for (const [x0, y0, x1, y1, gx0, gy0, gx1, gy1] of [
        [0, 0, W, e, 0, 0, 0, e], [0, H - e, W, H, 0, H, 0, H - e],
        [0, 0, e, H, 0, 0, e, 0], [W - e, 0, W, H, W, 0, W - e, 0],
      ]) {
        const gr = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
        gr.addColorStop(0, 'rgba(150,110,70,0.14)');
        gr.addColorStop(1, 'rgba(150,110,70,0)');
        ctx.fillStyle = gr;
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      }
    }
    // roughness (half size): 0.66 wood, 0.72 latewood lines, 0.75 scratches, 0.45 damp, 0.1 water beads
    const rw = W / 2, rh = H / 2;
    const r = canvas2(rw, rh);
    const rg = r.ctx;
    rg.fillStyle = 'rgb(168,168,168)';
    rg.fillRect(0, 0, rw, rh);
    for (const L of lines) {
      rg.strokeStyle = `rgba(184,184,184,${L.late ? 0.9 : 0.5})`;
      rg.lineWidth = L.late ? 1.5 : 1;
      path(rg, L, 0, kx / 2, ky / 2);
      rg.stroke();
    }
    rg.strokeStyle = 'rgba(191,191,191,0.6)';
    rg.lineWidth = 1;
    for (const s of scratches) {
      rg.beginPath(); rg.moveTo(s[0] / 2, s[1] / 2); rg.lineTo(s[2] / 2, s[3] / 2); rg.stroke();
    }
    blobPaint(rg, 0.5, 0.5, [115, 115, 115], 0.6);
    rg.fillStyle = 'rgb(26,26,26)';
    for (const b of beads) {
      rg.beginPath(); rg.arc(b[0] / 2, b[1] / 2, b[2] / 2, 0, Math.PI * 2); rg.fill();
    }
    const map = texOf(c, { wrap: false, aniso: 8 });
    const rough = texOf(r.c, { color: false, wrap: false, aniso: 8 });
    return bundle(map, { rough });
  });
}

// =====================================================================================
// Keyaki counter planks: tile 128 x 64 cm (4 planks of 16 cm running along x), repeats in x and z.
// Flat-sawn grain: uneven growth rings bending into long cathedral arches, ring-porous earlywood.
// Colour map with .rough. 12 px/cm (6 low): it is mostly seen at a distance.
// =====================================================================================
export function counterWood(opts) {
  const low = isLow(opts);
  return memo('counter' + low, 'counterWood', () => {
    const W = low ? 768 : 1536, H = low ? 384 : 768, CW = 128, CH = 64, NP = 4, PH = CH / NP;
    const sy = CH / H;
    const R = rng(0xce1a);
    const bases = ['#9a6a40', '#8f5f36', '#96663c', '#845532'].map(rgbOf);
    // ring index as a function of distance from the pith: uneven yearly growth
    const RL = 4096, RMAX = 60, ringOf = new Float32Array(RL);
    {
      let r0 = 0, yr = 0, wdt = 0.5;
      for (let i = 0; i < RL; i++) {
        const rad = (i / RL) * RMAX;
        while (rad > r0 + wdt) {
          r0 += wdt;
          yr++;
          wdt = Math.max(0.2, 0.55 * (0.55 + 0.9 * R()) * (0.8 + 0.4 * Math.sin(yr * 0.21)));
        }
        ringOf[i] = yr + (rad - r0) / wdt;
      }
    }
    const planks = [];
    for (let i = 0; i < NP; i++) {
      const flat = i !== 2; // one plank nearly straight-grained
      planks.push({
        base: mulC(bases[i], 0.97 + 0.06 * R()),
        yc: flat ? PH * (0.25 + 0.5 * R()) : -25 - 10 * R(),
        z0: flat ? 2 + 4 * R() : 1, amp: flat ? 5 + 5 * R() : 2, ph: R(), off: R() * 20,
      });
    }
    // depth of the cut below the pith along x: a slow rise then a quicker fall (arches mostly
    // pointing one way, like a tapering log), one period per tile
    const D2 = new Float32Array(NP * W);
    for (let i = 0; i < NP; i++) {
      const P = planks[i];
      for (let x = 0; x < W; x++) {
        const t = ((x + 0.5) / W + P.ph) % 1;
        const tri = t < 0.75 ? fade(t / 0.75) : fade((1 - t) / 0.25);
        const D = P.z0 + P.amp * tri;
        D2[i * W + x] = D * D;
      }
    }
    const warp = fbm(R, W, H, 12, 6, 3, 0.5, 4);
    const pore = fbm(R, W, H, 384, 384, 1);
    const { c, ctx, img, d } = pixels(W, H);
    const rw = W / 2, rh = H / 2, rough = new Float32Array(rw * rh);
    const poreC = rgbOf('#4a2a14'), seamC = rgbOf('#3a1e0a');
    const RK = RL / RMAX;
    for (let y = 0; y < H; y++) {
      const yc = (y + 0.5) * sy, pi = Math.min(NP - 1, Math.floor(yc / PH)), P = planks[pi];
      const yl = yc - pi * PH, dyc = yl - P.yc, dy2 = dyc * dyc;
      const edge = Math.min(yl, PH - yl);
      const seam = 1 - sstep(0.03, 0.09, edge), bevel = 1 - sstep(0.05, 0.35, edge);
      const base = P.base, drow = pi * W;
      for (let x = 0; x < W; x++) {
        const p = y * W + x, wv = warp[p];
        let ri = ((Math.sqrt(dy2 + D2[drow + x]) + (wv - 0.5) * 1.6 + P.off) * RK) | 0;
        if (ri >= RL) ri = RL - 1;
        const ring = ringOf[ri], f = ring - Math.floor(ring);
        const late = sstep(0.45, 0.9, f) * (1 - sstep(0.94, 1, f));
        const early = 1 - sstep(0.03, 0.2, f);
        const pr = early * sstep(0.55, 0.78, pore[p]) + 0.15 * sstep(0.8, 0.9, pore[p]);
        const k = (0.95 + 0.12 * wv) * (1.05 - 0.17 * late) * (1 - 0.4 * pr);
        let r = base[0] * k, g = base[1] * k, b = base[2] * k;
        const pt = pr * 0.35;
        r += (poreC[0] - r) * pt; g += (poreC[1] - g) * pt; b += (poreC[2] - b) * pt;
        const bv = 1 - bevel * 0.25;
        r *= bv; g *= bv; b *= bv;
        r += (seamC[0] - r) * seam; g += (seamC[1] - g) * seam; b += (seamC[2] - b) * seam;
        const o = p * 4;
        d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
        if (!(x & 1) && !(y & 1)) rough[(y >> 1) * rw + (x >> 1)] = 0.45 - 0.05 * late + 0.15 * pr + 0.4 * seam;
      }
    }
    ctx.putImageData(img, 0, 0);
    const map = texOf(c, { aniso: 8 });
    return bundle(map, { rough: texOf(greyCanvas(rough, rw, rh), { color: false, aniso: 8 }) });
  });
}

// =====================================================================================
// Charred konro wood (design 05): char black, shallow checks elongated along the grain, soot runs
// from the rim, soft grey-brown ash weathering, brown wood showing through worn edges.
// Canvas top = top edge (rim). Repeats along x.
// =====================================================================================
function charWood(R, W, H, CW, CH, o) {
  const sx = CW / W, sy = CH / H, N = W * H;
  const base = stretch(fbm(R, W, H, CW / 4, CH / 4, 4, 0.5, 2));
  // alligator checks: Worley with one jittered seed per cell, cells 2.4 x 1.3 cm along the grain;
  // seeds are stored with a one-cell periodic border so the 3x3 search needs no wrapping
  const gx = Math.max(1, Math.round(CW / 2.4)), gy = Math.max(1, Math.round(CH / 1.3));
  const cw = W / gx, ch = H / gy, PW = gx + 2;
  const SX = new Float32Array(gx * gy), SY = new Float32Array(gx * gy);
  for (let j = 0; j < gy; j++) for (let i = 0; i < gx; i++) {
    SX[j * gx + i] = (i + 0.1 + 0.8 * R()) * cw;
    SY[j * gx + i] = (j + 0.1 + 0.8 * R()) * ch;
  }
  const PX = new Float32Array(PW * (gy + 2)), PY = new Float32Array(PW * (gy + 2));
  for (let j = -1; j <= gy; j++) for (let i = -1; i <= gx; i++) {
    const ii = (i + gx) % gx, jj = (j + gy) % gy, q = (j + 1) * PW + i + 1;
    PX[q] = SX[jj * gx + ii] + (i < 0 ? -W : i >= gx ? W : 0);
    PY[q] = SY[jj * gx + ii] + (j < 0 ? -H : j >= gy ? H : 0);
  }
  // grain lines along x: nearest-line strength lookup over y (cm)
  const glines = [];
  for (let y = R() * 0.4; y < CH + 0.6; y += 0.25 + 0.35 * R()) glines.push(y);
  const GL = H * 4, gdist = new Float32Array(GL);
  for (let i = 0; i < GL; i++) {
    const yy = ((i + 0.5) / GL) * CH;
    let m = 9;
    for (const g of glines) m = Math.min(m, Math.abs(yy - g));
    gdist[i] = Math.exp(-((m / 0.035) ** 2));
  }
  const gw = fbm(R, W, H, CW / 2, CH / 1.5, 2, 0.5, 2);
  // soot runs from the rim
  const soot = new Float32Array(N);
  if (o.soot) {
    const streak = fbm(R, W, H, CW / 0.35, Math.max(1, CH / 5), 1, 0.5, 2);
    const fall = new Float32Array(H);
    for (let k = 0; k < o.soot; k++) {
      const xc = R() * W, sig = (0.8 + 2.2 * R()) / 2 / sx, len = (0.4 + 0.5 * R()) * CH, al = 0.35 + 0.25 * R();
      let ymax = 0;
      for (let y = 0; y < H; y++) {
        const yc = (y + 0.5) * sy;
        fall[y] = yc > len ? 0 : 1 - sstep(len * 0.55, len, yc);
        if (fall[y] > 0) ymax = y;
      }
      const x0 = Math.floor(xc - 2.2 * sig), x1 = Math.ceil(xc + 2.2 * sig);
      for (let xx = x0; xx <= x1; xx++) {
        const xw = ((xx % W) + W) % W, gxv = Math.exp(-(((xx - xc) / sig) ** 2)) * al;
        for (let y = 0; y <= ymax; y++) {
          const p = y * W + xw;
          const a = Math.min(1, gxv * fall[y] * (0.55 + 0.9 * streak[p]));
          soot[p] = 1 - (1 - soot[p]) * (1 - a);
        }
      }
    }
  }
  // ash weathering (more toward the rim) and scuffs at the edges
  const ashN = fbm(R, W, H, CW / 1.5, CH / 1.5, 3, 0.55, 2);
  const ashF = fbm(R, W, H, CW / 0.3, CH / 0.3, 1, 0.5, 2);
  const sp = stretch(fbm(R, W, H, CW / 2.5, CH / 2.5, 3, 0.55, 2));
  const tint = gw; // colour variation of ash and scuffs
  const wn = whiteNoise(N, 0x7a11 + W);
  for (let y = 0; y < H; y++) {
    const yc = (y + 0.5) * sy, top = o.ashTop * (1 - yc / CH);
    const em = Math.max(1 - sstep(0, 1.2, yc), o.scuffBottom ? 1 - sstep(0, 1.2, CH - yc) : 0);
    const sk = 0.35 + 0.65 * em;
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      ashN[p] += top;
      sp[p] *= sk;
    }
  }
  const ath = quantile(ashN, 1 - o.ash), sth = quantile(sp, 1 - o.scuff);
  const ashLut = rampLUT([[0, '#4f3d31'], [0.45, '#655045'], [0.75, '#685140'], [1, '#8a6854']]);
  const scLut = rampLUT([[0, '#3b2311'], [0.45, '#523724'], [0.85, '#6d3d17'], [1, '#81522a']]);

  const cA = rgbOf('#090401'), cB = rgbOf('#23160c'), grainC = rgbOf('#0d0704'), crackC = rgbOf('#050200');
  const fl = rgbOf('#c4ab97');
  const col = pixels(W, H), d = col.d;
  const rough = new Float32Array(N), hgt = new Float32Array(N);
  for (let y = 0; y < H; y++) {
    const yc = (y + 0.5) * sy, cj = Math.min(gy - 1, Math.floor((y + 0.5) / ch));
    const wornTop = 1 - sstep(0.2, 0.6, yc);
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      // Worley F1/F2 in cm
      const ci = Math.min(gx - 1, Math.floor((x + 0.5) / cw));
      let f1 = 1e9, f2 = 1e9;
      for (let dj = 0; dj < 3; dj++) {
        const qr = (cj + dj) * PW + ci;
        for (let di = 0; di < 3; di++) {
          const q = qr + di;
          const dx = (x + 0.5 - PX[q]) * sx, dy = (y + 0.5 - PY[q]) * sy;
          const dd = dx * dx + dy * dy;
          if (dd < f1) { f2 = f1; f1 = dd; } else if (dd < f2) f2 = dd;
        }
      }
      f1 = Math.sqrt(f1);
      f2 = Math.sqrt(f2);
      const border = 1 - sstep(0.025, 0.08, f2 - f1);
      const dome = 1 - sstep(0, 1.1, f1);
      let gi = Math.floor(((yc + (gw[p] - 0.5) * 0.2) / CH) * GL);
      gi = gi < 0 ? 0 : gi >= GL ? GL - 1 : gi;
      const grain = gdist[gi];

      const bf = clamp01(0.5 + (base[p] - 0.5) * 1.3);
      const lift = 1 + 0.04 * dome;
      let r = (cA[0] + (cB[0] - cA[0]) * bf) * lift, g = (cA[1] + (cB[1] - cA[1]) * bf) * lift, b = (cA[2] + (cB[2] - cA[2]) * bf) * lift;
      const gt = grain * 0.5;
      r += (grainC[0] - r) * gt; g += (grainC[1] - g) * gt; b += (grainC[2] - b) * gt;
      const bt = border * 0.42;
      r += (crackC[0] - r) * bt; g += (crackC[1] - g) * bt; b += (crackC[2] - b) * bt;
      const st = soot[p];
      r += (grainC[0] - r) * st; g += (grainC[1] - g) * st; b += (grainC[2] - b) * st;
      // ash: soft-edged, broken up by fine noise so it reads as weathering, not paint
      const ash = sstep(ath - 0.03, ath + 0.09, ashN[p]) * (0.45 + 0.55 * ashF[p]) * (1 - 0.6 * border);
      if (ash > 0.002) {
        const li = (clamp01(tint[p] * 0.75 + wn[p] * 0.25 + (wn[p] > 0.96 ? 0.3 : 0)) * 255 | 0) * 3;
        const at = ash * 0.68;
        r += (ashLut[li] - r) * at; g += (ashLut[li + 1] - g) * at; b += (ashLut[li + 2] - b) * at;
      }
      // scuffs: worn char showing brown wood
      const scuff = sstep(sth, sth + 0.06, sp[p]) * (0.6 + 0.4 * ashF[p]);
      if (scuff > 0.002) {
        const li = (clamp01(tint[p] * 0.9 + bf * 0.2) * 255 | 0) * 3;
        const kt = scuff * 0.8;
        r += (scLut[li] - r) * kt; g += (scLut[li + 1] - g) * kt; b += (scLut[li + 2] - b) * kt;
      }
      if (o.flecks && wn[p] < o.flecks) {
        r += (fl[0] - r) * 0.55; g += (fl[1] - g) * 0.55; b += (fl[2] - b) * 0.55;
      }
      const q4 = p * 4;
      d[q4] = r; d[q4 + 1] = g; d[q4 + 2] = b; d[q4 + 3] = 255;
      rough[p] = (0.9 + 0.1 * ash) * (1 - scuff) + 0.72 * scuff - 0.15 * wornTop * (1 - ash);
      hgt[p] = 0.08 * dome * dome - 0.1 * border - 0.02 * grain + 0.02 * ash - 0.03 * scuff + 0.015 * (base[p] - 0.5);
    }
  }
  col.ctx.putImageData(col.img, 0, 0);
  return {
    map: texOf(col.c, { aniso: 8 }),
    normal: texOf(normalCanvas(hgt, W, H, sx, sy, 0.6), { color: false, aniso: 8 }),
    rough: texOf(greyCanvas(rough, W, H), { color: false, aniso: 8 }),
  };
}
function konroInner(R, W, H, CW, CH) {
  const sy = CH / H;
  const f = stretch(fbm(R, W, H, CW / 3, CH / 3, 3, 0.5, 2));
  const bl = stretch(fbm(R, W, H, CW / 1.5, CH / 1.5, 3, 0.55, 2));
  const { c, ctx, img, d } = pixels(W, H);
  const c0 = rgbOf('#120a05'), c1 = rgbOf('#22150a'), base = rgbOf('#0d0704'), ashC = rgbOf('#4b3a37');
  const rough = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const fromBottom = CH - (y + 0.5) * sy;
    for (let x = 0; x < W; x++) {
      const p = y * W + x, t = f[p];
      let r = base[0] * 0.15 + (c0[0] + (c1[0] - c0[0]) * t) * 0.85;
      let g = base[1] * 0.15 + (c0[1] + (c1[1] - c0[1]) * t) * 0.85;
      let b = base[2] * 0.15 + (c0[2] + (c1[2] - c0[2]) * t) * 0.85;
      const a = clamp01((1 - sstep(0.5, 3.2, fromBottom + (bl[p] - 0.5) * 2.2)) * (0.6 + 0.5 * bl[p]));
      r += (ashC[0] - r) * a; g += (ashC[1] - g) * a; b += (ashC[2] - b) * a;
      const o = p * 4;
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
      rough[p] = 0.92 + 0.08 * a;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { map: texOf(c), rough: texOf(greyCanvas(rough, W, H), { color: false }) };
}
// { map, normal, rough } for a 64 x 16 cm outer face; also .rim (64 x 4 cm rim top, ~30 % ash) and
// .inner (sooty inside wall with ash at the bottom 3 cm, canvas bottom = floor; map + rough).
export function konroWalls(opts) {
  const low = isLow(opts);
  return memo('konro' + low, 'konroWalls', () => {
    const k = low ? 0.5 : 1;
    const R = rng(0x6a20);
    const wall = charWood(R, 1024 * k, 256 * k, 64, 16, { ash: 0.17, ashTop: 0.06, scuff: 0.05, scuffBottom: true, soot: 25, flecks: 0.0005 });
    const rim = charWood(R, 1024 * k, 64 * k, 64, 4, { ash: 0.32, ashTop: 0, scuff: 0.07, scuffBottom: true, soot: 0, flecks: 0.006 });
    const inner = konroInner(R, 512 * k, 128 * k, 64, 16);
    return { ...wall, rim, inner };
  });
}

// =====================================================================================
// Binchotan: u = around the log (~8 cm), v = along it (~7 cm). Shared crack layout for coal + ember.
// =====================================================================================
function coalBase(low) {
  return memo('coalbase' + low, null, () => {
    const W = low ? 256 : 512, H = low ? 128 : 256, CU = 8, CV = 7;
    const R = rng(0xc0a1);
    const kx = W / CU, ky = H / CV;
    const f1 = stretch(fbm(R, W, H, 16, 14, 3, 0.55));
    const fineV = fbm(R, W, H, 160, 5, 1);
    const ashN = stretch(fbm(R, W, H, 6, 5, 4, 0.55, 2));
    const glowN = stretch(fbm(R, W, H, 8, 6, 3, 0.5, 2));
    // ash collects on one side of the log (u around 0.3), the glowing underside is opposite (u ~ 0.8)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      ashN[y * W + x] += 0.3 * Math.cos(2 * Math.PI * ((x + 0.5) / W - 0.3));
    }
    const ath = quantile(ashN, 0.62);
    const ash = new Float32Array(W * H);
    for (let i = 0; i < ash.length; i++) ash[i] = sstep(ath - 0.05, ath + 0.1, ashN[i]) * (0.55 + 0.45 * f1[i]);
    // crack polylines (cm): splits along the log, and short cross checks between neighbouring splits
    const cracks = [], longs = [];
    let u = R() * 0.5;
    while (u < CU - 0.4) {
      const pts = [], full = R() < 0.5;
      const v0 = full ? -0.3 : R() * CV * 0.6, v1 = full ? CV + 0.3 : v0 + (0.25 + 0.5 * R()) * CV;
      let uu = u;
      for (let v = v0; v <= v1; v += 0.3) {
        uu += (R() - 0.5) * 0.14;
        pts.push([uu, v]);
      }
      cracks.push({ pts, w: 0.8 + 1.8 * R() });
      longs.push({ u, v0, v1 });
      u += 0.5 + 0.6 * R();
    }
    for (let i = 0; i < longs.length; i++) {
      const A = longs[i], B = longs[(i + 1) % longs.length], ub = i + 1 < longs.length ? B.u : B.u + CU;
      for (let v = Math.max(A.v0, B.v0) + R() * 0.8; v < Math.min(A.v1, B.v1); v += 0.7 + 0.9 * R()) {
        if (R() < 0.35) continue;
        const dv = (R() - 0.5) * 0.25;
        cracks.push({ pts: [[A.u, v], [(A.u + ub) / 2, v + dv * 0.5 + (R() - 0.5) * 0.1], [ub, v + dv]], w: 0.7 + 0.8 * R() });
      }
    }
    const drawCracks = (g, widen, lip) => {
      g.lineCap = 'round';
      g.lineJoin = 'round';
      for (let i = -1; i <= 1; i++) {
        for (const cr of cracks) {
          g.lineWidth = Math.max(0.5, (cr.w + widen) * (W / 512));
          g.beginPath();
          cr.pts.forEach((pt, k) => {
            const X = (pt[0] + lip) * kx + i * W, Y = pt[1] * ky;
            if (k) g.lineTo(X, Y); else g.moveTo(X, Y);
          });
          g.stroke();
        }
      }
    };
    const mask = (widen, lip) => {
      const { c, ctx } = canvas2(W, H);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = '#fff';
      drawCracks(ctx, widen, lip);
      const src = ctx.getImageData(0, 0, W, H).data, out = new Float32Array(W * H);
      for (let i = 0; i < out.length; i++) out[i] = src[i * 4] / 255;
      return out;
    };
    const crack = mask(0, 0), lipM = mask(-0.5, 0.05), wide = blur(mask(2, 0), W, H, Math.max(1, (W / 256) | 0));
    return { W, H, f1, fineV, ash, glowN, crack, lipM, wide };
  });
}
// binchotan crust colour map; also .normal, .rough and .cap (end-grain disc for cylinder caps)
export function coalTexture(opts) {
  const low = isLow(opts);
  return memo('coal' + low, 'coalTexture', () => {
    const B = coalBase(low), { W, H } = B;
    const R = rng(0xc0a2);
    const { c, ctx, img, d } = pixels(W, H);
    // binchotan: near-black body, sparse grey ash (kept a step darker than the measured highlights)
    const c0 = rgbOf('#2a221f'), cLo = rgbOf('#2f2622'), cHi = rgbOf('#4a3d37'), crackC = rgbOf('#120d0a');
    const lipC = rgbOf('#7a6d69'), speck = rgbOf('#cdbfb8');
    const ashLut = rampLUT([[0, '#766a66'], [0.6, '#857873'], [1, '#968985']]);
    const wn = whiteNoise(W * H, 0x3c0a);
    const rough = new Float32Array(W * H), hgt = new Float32Array(W * H);
    for (let p = 0; p < W * H; p++) {
      const f = B.f1[p], fv = B.fineV[p];
      const k = 0.82 + 0.3 * fv;
      let r = (c0[0] * 0.15 + (cLo[0] + (cHi[0] - cLo[0]) * f) * 0.85) * k;
      let g = (c0[1] * 0.15 + (cLo[1] + (cHi[1] - cLo[1]) * f) * 0.85) * k;
      let b = (c0[2] * 0.15 + (cLo[2] + (cHi[2] - cLo[2]) * f) * 0.85) * k;
      const lp = B.lipM[p] * (1 - B.crack[p]) * 0.45;
      r += (lipC[0] - r) * lp; g += (lipC[1] - g) * lp; b += (lipC[2] - b) * lp;
      const a = B.ash[p] * 0.85 * (1 - 0.7 * B.crack[p]);
      const li = ((B.glowN[p] * 0.7 + wn[p] * 0.3) * 255 | 0) * 3;
      r += (ashLut[li] - r) * a; g += (ashLut[li + 1] - g) * a; b += (ashLut[li + 2] - b) * a;
      if (B.ash[p] > 0.4 && wn[p] > 0.992) {
        r += (speck[0] - r) * 0.6; g += (speck[1] - g) * 0.6; b += (speck[2] - b) * 0.6;
      }
      const cr = B.crack[p];
      r += (crackC[0] - r) * cr; g += (crackC[1] - g) * cr; b += (crackC[2] - b) * cr;
      const o = p * 4;
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
      rough[p] = 0.72 + 0.28 * B.ash[p];
      hgt[p] = -0.05 * cr + 0.012 * B.ash[p] + 0.02 * (f - 0.5) + 0.006 * (fv - 0.5);
    }
    ctx.putImageData(img, 0, 0);
    // end cap: growth rings, radial cracks, ashy rim
    const CS = low ? 64 : 128, cap = pixels(CS, CS);
    const rad = [];
    const nr = 5 + Math.floor(R() * 4);
    for (let i = 0; i < nr; i++) rad.push(R() * Math.PI * 2);
    const ringA = rgbOf('#2d201a'), ringB = rgbOf('#513b32'), ashRim = rgbOf('#8f7b74');
    for (let y = 0; y < CS; y++) for (let x = 0; x < CS; x++) {
      const dx = (x + 0.5) / CS - 0.5, dy = (y + 0.5) / CS - 0.5, rr = Math.hypot(dx, dy) * 2, an = Math.atan2(dy, dx);
      const rcm = rr * 1.25;
      let col = mixC(ringA, ringB, 0.5 + 0.5 * Math.sin((rcm / 0.15) * Math.PI * 2 + 0.6 * Math.sin(an * 3)));
      let crk = 0;
      for (const a0 of rad) {
        let da = Math.abs(an - a0);
        if (da > Math.PI) da = 2 * Math.PI - da;
        crk = Math.max(crk, (1 - sstep(0.004, 0.012, da * rr)) * sstep(0.12, 0.35, rr));
      }
      col = mixC(col, crackC, crk);
      col = mixC(col, ashRim, sstep(0.8, 0.98, rr) * 0.7);
      const o = (y * CS + x) * 4;
      cap.d[o] = col[0]; cap.d[o + 1] = col[1]; cap.d[o + 2] = col[2]; cap.d[o + 3] = 255;
    }
    cap.ctx.putImageData(cap.img, 0, 0);
    const map = texOf(c);
    return bundle(map, {
      normal: texOf(normalCanvas(hgt, W, H, 8 / W, 7 / H, 1), { color: false }),
      rough: texOf(greyCanvas(rough, W, H), { color: false }),
      cap: texOf(cap.c, { wrap: false }),
    });
  });
}
// Emissive colour map in the coal UVs: glowing cracks, a dim red underside strip (u ~ 0.8, away from
// the ash), rare white-hot cores. Use emissive = white and scale emissiveIntensity by heat.
export function emberTexture(opts) {
  const low = isLow(opts);
  return memo('ember' + low, 'emberTexture', () => {
    const B = coalBase(low), { W, H } = B;
    const R = rng(0xe3b);
    const core = fbm(R, W, H, 24, 20, 1);
    const lut = rampLUT([[0, '#000000'], [0.05, '#1a0603'], [0.2, '#501d0e'], [0.4, '#892f19'], [0.6, '#cb420f'], [0.8, '#f47909'], [1, '#f4af43']]);
    const { c, ctx, img, d } = pixels(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = y * W + x, u = (x + 0.5) / W;
      let du = Math.abs(u - 0.8);
      if (du > 0.5) du = 1 - du;
      const under = (1 - sstep(0.04, 0.14, du)) * sstep(0.5, 0.85, B.glowN[p]);
      const noAsh = 1 - 0.9 * B.ash[p];
      const cr = Math.max(B.crack[p] * 0.95, B.wide[p] * 0.6) * noAsh;
      let t = Math.max(cr * (0.5 + 0.35 * B.glowN[p]), under * 0.42 * noAsh);
      if (B.crack[p] > 0.5 && core[p] > 0.86) t = Math.max(t, 0.85 + 0.15 * sstep(0.86, 0.95, core[p]));
      const li = Math.min(255, (t * 255) | 0) * 3, o = p * 4;
      d[o] = lut[li]; d[o + 1] = lut[li + 1]; d[o + 2] = lut[li + 2]; d[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return texOf(c);
  });
}

// =====================================================================================
// Loose ash bed (~68 x 25 cm, tiles). .emissive holds dull red hot spots for the hot zone.
// =====================================================================================
export function ashTexture(opts) {
  const low = isLow(opts);
  return memo('ash' + low, 'ashTexture', () => {
    const W = low ? 256 : 512, H = low ? 96 : 192;
    const R = rng(0xa5b);
    const f = stretch(fbm(R, W, H, 40, 15, 4, 0.6));
    const hot = stretch(fbm(R, W, H, 12, 4, 3, 0.5));
    const crumbs = fbm(R, W, H, 120, 45, 1);
    const wn = whiteNoise(W * H, 0xa5c);
    const hth = quantile(hot, 0.82);
    const { c, ctx, img, d } = pixels(W, H);
    const e = pixels(W, H);
    const lut = rampLUT([[0, '#4a3227'], [0.5, '#6b544e'], [1, '#87716d']]);
    const sp = rgbOf('#ae9892'), cr = rgbOf('#2a1e19'), emi = rgbOf('#892f19');
    for (let p = 0; p < W * H; p++) {
      const v = f[p], li = ((v * 255) | 0) * 3;
      let r = lut[li], g = lut[li + 1], b = lut[li + 2];
      const rv = wn[p];
      if (rv < 0.02) {
        r += (sp[0] - r) * 0.6; g += (sp[1] - g) * 0.6; b += (sp[2] - b) * 0.6;
      } else if (crumbs[p] > 0.8 && rv < 0.35) {
        r += (cr[0] - r) * 0.6; g += (cr[1] - g) * 0.6; b += (cr[2] - b) * 0.6;
      }
      const o = p * 4;
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
      const h = sstep(hth, hth + 0.08, hot[p]) * sstep(0.35, 0.6, 1 - v);
      e.d[o] = emi[0] * h; e.d[o + 1] = emi[1] * h; e.d[o + 2] = emi[2] * h; e.d[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    e.ctx.putImageData(e.img, 0, 0);
    return bundle(texOf(c), { emissive: texOf(e.c) });
  });
}

// =====================================================================================
// Jubako lacquer: { black, red, rough, normal }. Very smooth; gloss comes from an env map.
// rough: absolute 0.08-0.14 with faint wipe marks to 0.2 (material.roughness = 1).
// normal: very slow waviness so reflections wobble slightly (normalScale ~1).
// =====================================================================================
export function lacquerTextures(opts) {
  const low = isLow(opts);
  return memo('lacquer' + low, 'lacquerTextures', () => {
    const S1 = low ? 128 : 256, S2 = low ? 256 : 512;
    const R = rng(0x1ac);
    const fb = stretch(fbm(R, S1, S1, 3, 3, 2));
    const bl = pixels(S1, S1);
    const b0 = rgbOf('#0d0301'), b1 = rgbOf('#170801');
    for (let p = 0; p < S1 * S1; p++) {
      const t = fb[p] * 0.85;
      bl.d[p * 4] = b0[0] + (b1[0] - b0[0]) * t; bl.d[p * 4 + 1] = b0[1] + (b1[1] - b0[1]) * t;
      bl.d[p * 4 + 2] = b0[2] + (b1[2] - b0[2]) * t; bl.d[p * 4 + 3] = 255;
    }
    bl.ctx.putImageData(bl.img, 0, 0);
    const fr = stretch(fbm(R, S2, S2, 8, 8, 3, 0.5, 2));
    const brush = fbm(R, S2, S2, 6, 96, 1);
    const rd = pixels(S2, S2);
    const r0 = mixC(rgbOf('#6e1802'), rgbOf('#7a1b03'), 0.35), r1 = mixC(rgbOf('#8e2603'), rgbOf('#7a1b03'), 0.35);
    for (let p = 0; p < S2 * S2; p++) {
      const t = fr[p], k = 0.975 + 0.05 * brush[p];
      rd.d[p * 4] = (r0[0] + (r1[0] - r0[0]) * t) * k; rd.d[p * 4 + 1] = (r0[1] + (r1[1] - r0[1]) * t) * k;
      rd.d[p * 4 + 2] = (r0[2] + (r1[2] - r0[2]) * t) * k; rd.d[p * 4 + 3] = 255;
    }
    rd.ctx.putImageData(rd.img, 0, 0);
    // roughness + very slow waviness
    const fro = fbm(R, S1, S1, 7, 7, 2);
    const rough = new Float32Array(S1 * S1);
    for (let p = 0; p < rough.length; p++) rough[p] = 0.08 + 0.06 * fro[p];
    const rc = greyCanvas(rough, S1, S1), rg = rc.getContext('2d');
    rg.strokeStyle = 'rgba(51,51,51,0.3)';
    rg.lineWidth = Math.max(1, S1 / 512);
    for (let i = 0; i < 30; i++) {
      const x = R() * S1, y = R() * S1, len = (0.1 + 0.17 * R()) * S1, a = (R() - 0.5) * 0.35;
      wrapAt(S1, S1, x, y, len, (X, Y) => {
        rg.beginPath(); rg.moveTo(X, Y); rg.lineTo(X + Math.cos(a) * len, Y + Math.sin(a) * len); rg.stroke();
      });
    }
    const hw = fbm(R, S1, S1, 4, 4, 1);
    return {
      black: texOf(bl.c),
      red: texOf(rd.c),
      rough: texOf(rc, { color: false }),
      normal: texOf(normalCanvas(hw, S1, S1, 30 / S1, 30 / S1, 0.6), { color: false }),
    };
  });
}

// =====================================================================================
// Cooked rice seen from above, 8 x 8 cm tile: { map, normal, rough }.
// Plump grains ~0.6 x 0.32 cm packed in three layers, slightly translucent rims, small warm gaps.
// =====================================================================================
export function riceTextures(opts) {
  const low = isLow(opts);
  return memo('rice' + low, 'riceTextures', () => {
    const S = low ? 256 : 512, T = 8, pc = S / T, cpx = T / S;
    const R = rng(0x51ce);
    const zb = new Float32Array(S * S).fill(-0.3), gq = new Float32Array(S * S).fill(1);
    const gid = new Int16Array(S * S).fill(-1);
    const pal = ['#ece4dc', '#e4dad0', '#ddd1c6', '#d4c6ba', '#c9b8a8'].map(rgbOf);
    const wts = [0.15, 0.35, 0.25, 0.15, 0.1];
    const grains = [];
    const addLayer = (n, z0, z1, skip) => {
      const cell = T / n;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        if (R() < skip) continue;
        let pr = R(), ci = 0;
        while (ci < 4 && pr > wts[ci]) pr -= wts[ci++];
        grains.push({
          x: (i + 0.1 + 0.8 * R()) * cell, y: (j + 0.1 + 0.8 * R()) * cell, z: z0 + (z1 - z0) * R(),
          a: 0.28 + 0.06 * R(), b: 0.145 + 0.035 * R(), c: 0.12 + 0.04 * R(), th: R() * Math.PI,
          tilt: (R() - 0.5) * 0.08, col: pal[ci], shade: 0.95 + 0.08 * R(),
        });
      }
    };
    addLayer(15, -0.2, -0.12, 0);
    addLayer(19, -0.1, -0.03, 0.05);
    addLayer(21, 0, 0.06, 0.12);
    grains.forEach((G, id) => {
      const ca = Math.cos(G.th), sa = Math.sin(G.th);
      const ex = Math.hypot(G.a * ca, G.b * sa) * pc + 1.5, ey = Math.hypot(G.a * sa, G.b * ca) * pc + 1.5;
      const ia2 = 1 / (G.a * G.a), ib2 = 1 / (G.b * G.b);
      wrapAt(S, S, G.x * pc, G.y * pc, Math.max(ex, ey), (X, Y) => {
        const x0 = Math.max(0, Math.floor(X - ex)), x1 = Math.min(S - 1, Math.ceil(X + ex));
        const y0 = Math.max(0, Math.floor(Y - ey)), y1 = Math.min(S - 1, Math.ceil(Y + ey));
        for (let y = y0; y <= y1; y++) {
          const dy = (y + 0.5 - Y) * cpx;
          for (let x = x0; x <= x1; x++) {
            const dx = (x + 0.5 - X) * cpx;
            const al = dx * ca + dy * sa, ac = -dx * sa + dy * ca;
            const q = al * al * ia2 + ac * ac * ib2;
            if (q >= 1) continue;
            const hz = G.z + G.c * Math.sqrt(1 - q) + G.tilt * (al / G.a);
            const p = y * S + x;
            if (hz > zb[p]) {
              zb[p] = hz;
              gid[p] = id;
              gq[p] = q;
            }
          }
        }
      });
    });
    const occ = blur(Float32Array.from(zb), S, S, Math.max(2, Math.round(0.1 * pc)));
    const { c, ctx, img, d } = pixels(S, S);
    // warm light-grey crevices: cooked rice is translucent, so the gaps never go dark brown (no gravel look)
    const cav = rgbOf('#8f7f72'), hole = rgbOf('#a89482'), deepC = rgbOf('#a8968a'), rim = rgbOf('#c4b9b0');
    const rough = new Float32Array(S * S);
    for (let p = 0; p < S * S; p++) {
      const id = gid[p], o = p * 4;
      let r, g, b;
      if (id < 0) {
        r = hole[0]; g = hole[1]; b = hole[2];
        rough[p] = 0.9;
      } else {
        const G = grains[id], q = gq[p];
        const k = G.shade * (0.88 + 0.12 * Math.sqrt(1 - q));
        r = G.col[0] * k; g = G.col[1] * k; b = G.col[2] * k;
        const t = sstep(0.55, 1, q) * 0.42;
        r += (rim[0] - r) * t; g += (rim[1] - g) * t; b += (rim[2] - b) * t;
        const deep = (1 - sstep(-0.2, 0.04, zb[p])) * 0.6;
        r += (deepC[0] - r) * deep; g += (deepC[1] - g) * deep; b += (deepC[2] - b) * deep;
        rough[p] = 0.36 + 0.12 * q + 0.25 * deep;
      }
      // contact shadows in the crevices
      const ao = clamp01((occ[p] - zb[p]) * 7) * 0.32;
      r += (cav[0] - r) * ao; g += (cav[1] - g) * ao; b += (cav[2] - b) * ao;
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return {
      map: texOf(c, { aniso: 8 }),
      normal: texOf(normalCanvas(zb, S, S, cpx, cpx, 0.8, true), { color: false, aniso: 8 }),
      rough: texOf(greyCanvas(rough, S, S), { color: false, aniso: 8 }),
    };
  });
}

// =====================================================================================
// Speckled glazed stoneware (tare trough, small dishes): u = around (~38 cm), v = height (~10 cm),
// canvas top = lip. opts: { lip: colour of a stained lip band, drips: n tare drips from the lip }.
// Returns the colour map with .rough. Repeats around u.
// =====================================================================================
export function stoneware(base = '#ad8d72', speckle = '#5d3c1d', opts = {}) {
  const low = isLow(opts);
  const B = rgbOf(base), Sp = rgbOf(speckle);
  const key = `stone${low}|${B}|${Sp}|${opts.lip || ''}|${opts.drips || 0}`;
  return memo(key, 'stoneware', () => {
    const W = low ? 512 : 1024, H = low ? 128 : 256, CU = 38, CV = 10;
    const kx = W / CU, ky = H / CV;
    const R = rng(0x570e + (B[0] << 8) + B[2]);
    const f = stretch(fbm(R, W, H, 12, 3, 3, 0.5, 2));
    const patch = stretch(fbm(R, W, H, 12, 3, 3, 0.55, 2));
    const fine = whiteNoise(W * H, 0x570f);
    const pth = quantile(patch, 0.82);
    const dark = mulC(B, 0.88), light = mulC(B, 1.05), run = mulC(B, 0.8);
    // glaze runs from the lip
    const runA = new Float32Array(W * H);
    for (let i = 0; i < 25; i++) {
      const xc = R() * W, sig = (0.1 + 0.15 * R()) * kx, len = (1 + 2 * R()) * ky, al = 0.35 + 0.3 * R();
      for (let x = Math.floor(xc - 2.5 * sig); x <= Math.ceil(xc + 2.5 * sig); x++) {
        const xw = ((x % W) + W) % W, gx = Math.exp(-(((x - xc) / sig) ** 2)) * al;
        for (let y = 0; y < Math.min(H, len); y++) runA[y * W + xw] = Math.max(runA[y * W + xw], gx * (1 - y / len));
      }
    }
    const { c, ctx, img, d } = pixels(W, H);
    const rough = new Float32Array(W * H);
    for (let p = 0; p < W * H; p++) {
      const t = f[p], pa = sstep(pth, pth + 0.08, patch[p]) * 0.4, ru = runA[p] * 0.6, k = 0.985 + 0.03 * fine[p];
      let r = dark[0] + (light[0] - dark[0]) * t, g = dark[1] + (light[1] - dark[1]) * t, b = dark[2] + (light[2] - dark[2]) * t;
      r += (Sp[0] - r) * pa; g += (Sp[1] - g) * pa; b += (Sp[2] - b) * pa;
      r += (run[0] - r) * ru; g += (run[1] - g) * ru; b += (run[2] - b) * ru;
      const o = p * 4;
      d[o] = r * k; d[o + 1] = g * k; d[o + 2] = b * k; d[o + 3] = 255;
      rough[p] = 0.35 + 0.1 * pa - 0.08 * runA[p];
    }
    ctx.putImageData(img, 0, 0);
    const rc = greyCanvas(rough, W, H), rg = rc.getContext('2d');
    // iron speckles, mostly fine (drawn as ellipses so they stay round on the pot)
    const n = Math.round(CU * CV * 9);
    const buckets = [[], [], []];
    for (let i = 0; i < n; i++) buckets[(R() * 3) | 0].push([R() * W, R() * H, 0.02 + 0.07 * R() ** 2.2]);
    buckets.forEach((bk, bi) => {
      ctx.fillStyle = css(Sp, 0.45 + 0.17 * bi);
      rg.fillStyle = 'rgba(128,128,128,0.5)';
      ctx.beginPath();
      rg.beginPath();
      for (const [x, y, r] of bk) {
        wrapAt(W, H, x, y, r * kx, (X, Y) => {
          ctx.moveTo(X + r * kx, Y);
          ctx.ellipse(X, Y, r * kx, r * ky, 0, 0, Math.PI * 2);
          rg.moveTo(X + r * kx, Y);
          rg.ellipse(X, Y, r * kx, r * ky, 0, 0, Math.PI * 2);
        });
      }
      ctx.fill();
      rg.fill();
    });
    if (opts.lip) {
      const lc = rgbOf(opts.lip);
      for (let x = 0; x < W; x += 2) {
        const h = (0.35 + 0.25 * Math.sin(x * 0.05) * Math.sin(x * 0.013) + 0.1 * R()) * ky;
        ctx.fillStyle = css(lc, 0.85);
        ctx.fillRect(x, 0, 2, h);
        rg.fillStyle = 'rgb(51,51,51)';
        rg.fillRect(x, 0, 2, h);
      }
    }
    // tare drips: translucent dark brown with amber edges, wavy and tapering
    for (let i = 0; i < (opts.drips || 0); i++) {
      const x = R() * W, len = (3 + 7 * R()) * ky, w = (0.5 + 0.7 * R()) * kx, sw = (R() - 0.5) * 0.6 * kx, ph = R() * 6;
      for (const X of [x, x - W, x + W]) {
        if (X + w < 0 || X - w > W) continue;
        const shape = (g) => {
          g.beginPath();
          const n2 = 12;
          for (let k = 0; k <= n2; k++) {
            const t = k / n2, hw = (w / 2) * (1 - 0.75 * t) * (0.85 + 0.15 * Math.sin(t * 9 + ph));
            const cx = X + sw * t * t;
            if (k) g.lineTo(cx - hw, t * len); else g.moveTo(cx - hw, 0);
          }
          g.quadraticCurveTo(X + sw, len + w * 0.35, X + sw + (w / 2) * 0.25, len);
          for (let k = n2; k >= 0; k--) {
            const t = k / n2, hw = (w / 2) * (1 - 0.75 * t) * (0.85 + 0.15 * Math.sin(t * 7 + ph + 1));
            g.lineTo(X + sw * t * t + hw, t * len);
          }
          g.closePath();
        };
        const gr = ctx.createLinearGradient(0, 0, 0, len);
        gr.addColorStop(0, 'rgba(53,21,14,0.92)');
        gr.addColorStop(0.7, 'rgba(40,20,9,0.85)');
        gr.addColorStop(1, 'rgba(28,17,7,0.7)');
        shape(ctx);
        ctx.fillStyle = gr;
        ctx.fill();
        ctx.strokeStyle = 'rgba(150,80,36,0.55)';
        ctx.lineWidth = 1.5 * (W / 1024);
        ctx.stroke();
        shape(rg);
        rg.fillStyle = 'rgb(26,26,26)';
        rg.fill();
      }
    }
    const map = texOf(c);
    map.wrapT = THREE.ClampToEdgeWrapping;
    const rough2 = texOf(rc, { color: false });
    rough2.wrapT = THREE.ClampToEdgeWrapping;
    return bundle(map, { rough: rough2 });
  });
}

// =====================================================================================
// Indigo / white cotton kitchen cloth: plain weave, yarn-dyed check, 12 cm tile. Map with .normal.
// =====================================================================================
export function clothTexture(opts) {
  const low = isLow(opts);
  return memo('cloth' + low, 'clothTexture', () => {
    const S = low ? 256 : 512, NT = 128, pitch = S / NT;
    const R = rng(0xc107);
    // stripe layout over 32 threads (3 cm): indigo 10, white 4, indigo 2, white 16
    const indigo = new Uint8Array(NT);
    for (let i = 0; i < NT; i++) {
      const m = i % 32;
      indigo[i] = m < 10 || (m >= 14 && m < 16) ? 1 : 0;
    }
    const tv = new Float32Array(NT * 2), tw = new Float32Array(NT * 2);
    for (let i = 0; i < NT * 2; i++) {
      tv[i] = 0.92 + 0.12 * R();
      tw[i] = 0.85 + 0.25 * R();
    }
    // cross profiles of each thread for every sub-pixel position inside its pitch
    const PR = new Float32Array(pitch * NT * 2), AL = new Float32Array(pitch);
    for (let t = 0; t < NT * 2; t++) for (let s = 0; s < pitch; s++) {
      const f = (s + 0.5) / pitch;
      PR[t * pitch + s] = Math.sqrt(Math.sin(Math.PI * clamp01((f - 0.5) / tw[t] + 0.5)));
    }
    for (let s = 0; s < pitch; s++) AL[s] = Math.sin(Math.PI * ((s + 0.5) / pitch));
    const fuzz = fbm(R, S, S, 64, 64, 1);
    const blot = fbm(R, S, S, 4, 4, 2, 0.5, 4);
    const ind = rgbOf('#26345a'), ind2 = rgbOf('#33436c'), wht = rgbOf('#ece8e0');
    const { c, ctx, img, d } = pixels(S, S);
    const hgt = new Float32Array(S * S);
    for (let y = 0; y < S; y++) {
      const j = (y / pitch) | 0, sy = y - j * pitch;
      for (let x = 0; x < S; x++) {
        const i = (x / pitch) | 0, sx = x - i * pitch;
        const warpTop = ((i + j) & 1) === 0;
        const prof = warpTop ? PR[i * pitch + sx] : PR[(NT + j) * pitch + sy];
        const along = warpTop ? AL[sy] : AL[sx];
        const p = y * S + x, vv = warpTop ? tv[i] : tv[NT + j];
        let r, g, b;
        if (warpTop ? indigo[i] : indigo[j]) {
          const t = clamp01(blot[p] * vv - 0.3);
          r = ind[0] + (ind2[0] - ind[0]) * t; g = ind[1] + (ind2[1] - ind[1]) * t; b = ind[2] + (ind2[2] - ind[2]) * t;
        } else {
          r = wht[0] * vv; g = wht[1] * vv; b = wht[2] * vv;
        }
        const k = (0.62 + 0.38 * prof * (0.75 + 0.25 * along)) * (0.95 + 0.1 * fuzz[p]);
        const o = p * 4;
        d[o] = r * k; d[o + 1] = g * k; d[o + 2] = b * k; d[o + 3] = 255;
        hgt[p] = 0.02 * prof * prof * (0.6 + 0.4 * along) + 0.004 * fuzz[p];
      }
    }
    ctx.putImageData(img, 0, 0);
    return bundle(texOf(c, { aniso: 8 }), { normal: texOf(normalCanvas(hgt, S, S, 12 / S, 12 / S, 1), { color: false, aniso: 8 }) });
  });
}

// =====================================================================================
// Back wall: { plaster (40 cm tile), window (machiya front: glowing shoji panels either side, koshi
// slats in the middle with a defocused sunlit garden behind, sudare blind on top; repeats along x),
// lattice (same texture as window) }.
// =====================================================================================
export function wallTextures(opts) {
  const low = isLow(opts);
  return memo('wall' + low, 'wallTextures', () => {
    const R = rng(0x3a11);
    // plaster
    const S = low ? 256 : 512;
    const f = stretch(fbm(R, S, S, 4, 4, 4, 0.55, 2));
    const fine = fbm(R, S, S, 96, 96, 1), wn = whiteNoise(S * S, 0x3a12);
    const pl = pixels(S, S);
    const p0 = rgbOf('#c9b28d'), p1 = rgbOf('#dccaae'), sd = rgbOf('#8a7458'), sl = rgbOf('#efe3cf');
    for (let p = 0; p < S * S; p++) {
      const t = f[p], k = 0.96 + 0.08 * fine[p], rv = wn[p];
      let r = p0[0] + (p1[0] - p0[0]) * t, g = p0[1] + (p1[1] - p0[1]) * t, b = p0[2] + (p1[2] - p0[2]) * t;
      if (rv < 0.012) {
        r += (sd[0] - r) * 0.6; g += (sd[1] - g) * 0.6; b += (sd[2] - b) * 0.6;
      } else if (rv < 0.03) {
        r += (sl[0] - r) * 0.5; g += (sl[1] - g) * 0.5; b += (sl[2] - b) * 0.5;
      }
      pl.d[p * 4] = r * k; pl.d[p * 4 + 1] = g * k; pl.d[p * 4 + 2] = b * k; pl.d[p * 4 + 3] = 255;
    }
    pl.ctx.putImageData(pl.img, 0, 0);

    // garden: painted small with smooth colour transitions, enlarged twice so it reads out of focus
    const W = low ? 512 : 1024, H = low ? 256 : 512;
    const gw = 64, gh = 32, gd = pixels(gw, gh);
    const fol = stretch(fbm(R, gw, gh, 6, 3, 3, 0.55));
    const garden = rampLUT([[0, '#564023'], [0.35, '#6e5b3f'], [0.55, '#887354'], [0.75, '#c6a85d'], [1, '#f3dc83']]);
    const sky = rgbOf('#f3dca8'), ground = rgbOf('#564023');
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const t = (y + 0.5) / gh, p = y * gw + x, li = ((fol[p] * 255) | 0) * 3;
      const fk = sstep(0.12, 0.35, t) * (1 - sstep(0.7, 0.92, t)), tk = sstep(0.3, 1, t);
      let r = sky[0] + (ground[0] - sky[0]) * tk, g = sky[1] + (ground[1] - sky[1]) * tk, b = sky[2] + (ground[2] - sky[2]) * tk;
      r += (garden[li] - r) * fk; g += (garden[li + 1] - g) * fk; b += (garden[li + 2] - b) * fk;
      gd.d[p * 4] = r; gd.d[p * 4 + 1] = g; gd.d[p * 4 + 2] = b; gd.d[p * 4 + 3] = 255;
    }
    gd.ctx.putImageData(gd.img, 0, 0);
    const mid = canvas2(gw * 4, gh * 4);
    mid.ctx.drawImage(gd.c, 0, 0, gw * 4, gh * 4);
    const { c, ctx } = canvas2(W, H);
    ctx.drawImage(mid.c, 0, 0, W, H);
    const top = H * 0.09, bot = H * 0.88;
    // shoji panels left and right: glowing paper with a fine kumiko grid
    const panel = (x0, x1) => {
      const gr = ctx.createLinearGradient(0, top, 0, bot);
      gr.addColorStop(0, '#f0cf9c');
      gr.addColorStop(0.6, '#e2b27e');
      gr.addColorStop(1, '#cd9965');
      ctx.fillStyle = gr;
      ctx.fillRect(x0, top, x1 - x0, bot - top);
      ctx.fillStyle = 'rgba(110,64,30,0.85)';
      const lw = Math.max(1, W / 512);
      for (let i = 0; i <= 6; i++) ctx.fillRect(x0 + ((x1 - x0) * i) / 6 - lw / 2, top, lw, bot - top);
      for (let i = 0; i <= 9; i++) ctx.fillRect(x0, top + ((bot - top) * i) / 9 - lw / 2, x1 - x0, lw);
    };
    panel(W * 0.03, W * 0.3);
    panel(W * 0.7, W * 0.97);
    // koshi slats over the open middle
    const slat = (x, w, y0, y1) => {
      const gr = ctx.createLinearGradient(x, 0, x + w, 0);
      gr.addColorStop(0, '#a26a3e');
      gr.addColorStop(0.3, '#7a4620');
      gr.addColorStop(1, '#4e2a12');
      ctx.fillStyle = gr;
      ctx.fillRect(x, y0, w, y1 - y0);
    };
    const pitch = (W * 0.4) / 16;
    for (let i = 0; i < 16; i++) slat(W * 0.3 + i * pitch + pitch * 0.35, pitch * 0.3, top, bot);
    // sudare blind across the top
    ctx.fillStyle = '#a06c41';
    ctx.fillRect(0, 0, W, top);
    ctx.fillStyle = 'rgba(242,205,169,0.4)';
    for (let y = 1; y < top; y += Math.max(2, H / 170)) ctx.fillRect(0, y, W, 1);
    ctx.fillStyle = 'rgba(80,50,28,0.6)';
    for (let x = W / 16; x < W; x += W / 8) ctx.fillRect(x, 0, Math.max(1, W / 512), top);
    // rails, sill and posts (a post centred on each tile edge so the texture repeats along x)
    for (const [y, h] of [[top, H * 0.03], [bot, H - bot]]) {
      const gr = ctx.createLinearGradient(0, y, 0, y + h);
      gr.addColorStop(0, '#9a6236');
      gr.addColorStop(1, '#5a3216');
      ctx.fillStyle = gr;
      ctx.fillRect(0, y, W, h);
    }
    const post = W * 0.05;
    slat(-post / 2, post, 0, H);
    slat(W - post / 2, post, 0, H);
    slat(W * 0.3 - post * 0.3, post * 0.6, 0, H);
    slat(W * 0.7 - post * 0.3, post * 0.6, 0, H);
    // daylight wrapping softly over the wood
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.14;
    ctx.drawImage(mid.c, 0, 0, W, H);
    ctx.restore();
    const win = texOf(c);
    win.wrapT = THREE.ClampToEdgeWrapping;
    return { plaster: texOf(pl.c), window: win, lattice: win };
  });
}
