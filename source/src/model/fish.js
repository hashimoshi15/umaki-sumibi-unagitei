import { FISH, LSCALE, bodyRadius, halfWidth, thickness } from '../config.js';
import { clamp, smooth } from '../util.js';

// Everything about the one eel: how it was cut, opened and boned, where the skewers went, and the
// heat / tare / glaze history of every cell on both faces. The renderer, the cut face and the
// score all read these same arrays.
//   D  surface dose per face: 0 raw, 0.85 white-grilled, 1.3 golden, 1.6 deep brown, 1.9+ char
//   A  wet tare per face, G glaze per face, B burnt tare per face
//   K  core doneness (shared), W moisture (shared, 1 = juicy)
export const FLESH = 0, SKIN = 1;
export const N = FISH.bins, M = FISH.cols, DU = FISH.L / FISH.bins;

export class Fish {
  constructor() {
    this.N = N;
    this.M = M;
    this.L = FISH.L;
    this.du = DU;
    // filleting
    this.e = new Float32Array(N);       // cut offset from the back line (cm, + = toward the near half)
    this.cut = new Uint8Array(N);
    this.rough = new Float32Array(N);   // ragged cut edge 0..1
    this.cutFront = 0;
    this.openK = 0;
    this.crack = 0;                     // crease from yanking the halves open
    this.peel = 0;
    this.loss = new Float32Array(N);    // flesh torn away along the centre with the bone 0..1
    this.boneOff = false;
    // skewers
    this.skewers = [];
    this.skewersGrill = [];
    this.holes = 0;
    this.sag = new Float32Array(N);     // sag toward the coals (cm) between / beyond skewers
    // grilling
    const C = N * M;
    this.D = [new Float32Array(C), new Float32Array(C)];
    this.A = [new Float32Array(C), new Float32Array(C)];
    this.G = [new Float32Array(C), new Float32Array(C)];
    this.B = [new Float32Array(C), new Float32Array(C)];
    this.Atotal = [new Float32Array(C), new Float32Array(C)];
    this.K = new Float32Array(C);
    this.W = new Float32Array(C).fill(1);
    this.geo = new Float32Array(C);     // edge + thinness heat factor
    this.th = new Float32Array(C);
    this.edge = new Uint8Array(C);
    // slicing / plating
    this.cuts = [];
    this.pieces = [];
    this.refreshGeometry();
  }

  u(i) { return (i + 0.5) * DU; }
  bin(u) { return clamp(Math.floor(u / DU), 0, N - 1); }

  farW(i) {
    const u = this.u(i);
    return halfWidth(u) * (1 + 0.5 * (this.e[i] / bodyRadius(u)));
  }

  nearW(i) {
    const u = this.u(i);
    return halfWidth(u) * (1 - 0.5 * (this.e[i] / bodyRadius(u)));
  }

  // lateral position (cm) of column j at bin i, across the opened fillet (far edge negative)
  colW(i, j) {
    const a = -this.farW(i), b = this.nearW(i);
    return a + ((b - a) * (j + 0.5)) / M;
  }

  // per-cell thickness and how exposed it is (edges and the thin tail cook and burn first)
  refreshGeometry() {
    for (let i = 0; i < N; i++) {
      const u = this.u(i);
      const far = this.farW(i), near = this.nearW(i);
      for (let j = 0; j < M; j++) {
        const c = i * M + j;
        const s = -1 + ((j + 0.5) * 2) / M;
        const th = thickness(u) * (1 - 0.35 * s * s);
        const half = s < 0 ? far : near;
        let e = Math.min((1 - Math.abs(s)) * half, u, FISH.L - u);
        e = Math.max(0.05, e - 0.25 * this.rough[i] * (Math.abs(s) > 0.6 ? 1 : 0));
        this.th[c] = th;
        this.geo[c] = Math.min(1.4, (1 + 0.28 * Math.exp(-e / 0.6)) * (1 / th) ** 0.35);
        this.edge[c] = j === 0 || j === M - 1 || u > FISH.L - 2 ? 1 : 0;
      }
    }
  }

  setSag() {
    const s = [...(this.skewers.length ? this.skewers : this.skewersGrill)].sort((a, b) => a - b);
    this.sag.fill(0);
    if (!s.length) return;
    for (let i = 0; i < N; i++) {
      const u = this.u(i);
      let v = 0;
      if (u < s[0]) {
        const o = s[0];
        v = 0.9 * smooth(4 * LSCALE, 10 * LSCALE, o) * ((s[0] - u) / o) ** 2 * (o / (6 * LSCALE));
      } else if (u > s[s.length - 1]) {
        const o = FISH.L - s[s.length - 1];
        v = 0.9 * smooth(4 * LSCALE, 10 * LSCALE, o) * ((u - s[s.length - 1]) / o) ** 2 * (o / (6 * LSCALE));
      } else {
        for (let k = 0; k < s.length - 1; k++) {
          if (u >= s[k] && u <= s[k + 1]) {
            const g = s[k + 1] - s[k];
            // a bigger eel is stiffer: gaps are judged relative to its size
            v = 0.55 * (g / (12 * LSCALE)) ** 2 * smooth(8 * LSCALE, 13 * LSCALE, g) * Math.sin((Math.PI * (u - s[k])) / g);
          }
        }
      }
      this.sag[i] = v;
    }
  }

  shapeStats() {
    let sumE = 0, maxE = 0, rough = 0, loss = 0, wob = 0;
    for (let i = 0; i < N; i++) {
      const e = Math.abs(this.e[i]);
      sumE += e;
      maxE = Math.max(maxE, e);
      rough += this.rough[i];
      loss += this.loss[i];
      if (i) wob += Math.abs(this.e[i] - this.e[i - 1]);
    }
    return { meanE: sumE / N, maxE, rough: rough / N, loss: loss / N, wobble: wob / (N - 1), crack: this.crack, holes: this.holes };
  }

  skewerStats() {
    const s = [...(this.skewersGrill.length ? this.skewersGrill : this.skewers)].sort((a, b) => a - b);
    let sagMax = 0;
    for (const v of this.sag) sagMax = Math.max(sagMax, v);
    if (s.length < 2) return { count: s.length, gapMax: FISH.L, cv: 1, endMax: FISH.L, sagMax };
    const gaps = [];
    for (let k = 1; k < s.length; k++) gaps.push(s[k] - s[k - 1]);
    const m = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - m) ** 2, 0) / gaps.length);
    return { count: s.length, gapMax: Math.max(...gaps), cv: m ? sd / m : 1, endMax: Math.max(s[0], FISH.L - s[s.length - 1]), sagMax };
  }

  faceStats(f) {
    const C = N * M;
    let sD = 0, sD2 = 0, burnt = 0, raw = 0, sG = 0, sG2 = 0, bare = 0, blob = 0, tb = 0, sA = 0, cov = 0, edgeBurnt = 0, ne = 0;
    let sW = 0, rawK = 0, sK = 0;
    for (let c = 0; c < C; c++) {
      const D = this.D[f][c];
      sD += D;
      sD2 += D * D;
      if (D > 1.9) burnt++;
      if (D < 0.75) raw++;
      const G = this.G[f][c];
      sG += G;
      sG2 += G * G;
      if (G < 0.3) bare++;
      if (G >= 0.6) cov++;
      if (G > 2.2 || this.Atotal[f][c] > 3.2) blob++;
      if (this.B[f][c] > 0.5) tb++;
      sA += this.A[f][c];
      sW += this.W[c];
      sK += this.K[c];
      if (this.K[c] < 0.8) rawK++;
      if (this.edge[c]) {
        ne++;
        if (D > 1.9) edgeBurnt++;
      }
    }
    const mD = sD / C, mG = sG / C;
    return {
      dMean: mD, dStd: Math.sqrt(Math.max(0, sD2 / C - mD * mD)), burnt: burnt / C, raw: raw / C, edgeBurnt: ne ? edgeBurnt / ne : 0,
      glMean: mG, glCV: Math.sqrt(Math.max(0, sG2 / C - mG * mG)) / (mG || 1), bare: bare / C, cover: cov / C, blob: blob / C,
      tareBurnt: tb / C, wet: sA / C, W: sW / C, K: sK / C, rawK: rawK / C,
    };
  }
}
