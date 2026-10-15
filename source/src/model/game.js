import { FISH, TUNE, GRILL_MOVE, BOX, STATIONS, heatAt, bodyRadius } from '../config.js';
import { Fish, FLESH, SKIN, N, M, DU } from './fish.js';
import { evaluate } from './score.js';
import { clamp, smooth, lerp } from '../util.js';

// Game flow for one plate. Pure logic: no DOM and no WebGL. Inputs come in fish coordinates
// (u along the fillet from the head end, w across it) or box coordinates for plating.
//   cut → open → bone → skewer → toGrill → white → tare → toBoard → unskewer → slice → plate → finish → result
// In the tare step the skewered fillet is lifted off the coals, dipped in the tare trough, lifted out
// and put back on the coals to set the coat (two or so rounds).
const MOVE_T = 1.6;
// centre height of the fillet while it is carried: clear of the konro rims (12) and the trough walls (10)
export const CARRY_Y = 16.5;

// hand speed over a ≥ 60 ms window, so several pointer events in one frame do not look like a jerk
class Speed {
  constructor() { this.s = []; this.v = 0; }
  reset(t, x) { this.s = [{ t, x }]; this.v = 0; }
  push(t, x) {
    this.s.push({ t, x });
    while (this.s.length > 2 && t - this.s[1].t >= 0.06) this.s.shift();
    const a = this.s[0];
    const dt = t - a.t;
    if (dt >= 0.03) this.v = (x - a.x) / dt;
    return this.v;
  }
}
// skewer guide marks: 3 cm in from each end, equal gaps
const TICKS = [0, 1, 2, 3].map((k) => +(3 + (k * (FISH.L - 6)) / 3).toFixed(2));

export class Game {
  constructor(order = null) {
    this.handlers = new Set();
    this.reset(order);
  }

  on(fn) {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  emit(type, data = {}) {
    for (const fn of this.handlers) fn(type, data, this);
  }

  reset(order = this.order) {
    this.order = order;
    this.fish = new Fish();
    this.time = 0;
    this.stepT = 0;
    this.step = 'cut';
    this.knife = { active: false, lastU: 0, lastW: 0, lastT: 0, strokes: 0, speeds: [], misses: 0 };
    this.opener = { active: false, u0: 0, w0: 0, dist: 0, lastT: 0, lastD: 0, vmax: 0, flips: 0, lastSign: 0 };
    this.boner = { active: false, lastU: 0, lastT: 0, speeds: [], side: [] };
    this.grill = { fishX: -FISH.L / 2, fishZ: 0, down: SKIN, flipping: 0, flipT: 0.42, flips: 0, flipsWhite: 0, flipsTare: 0, moved: 0, drip: 0, heatT: 0 };
    // the tare round: on the coals (grill), held in the hand (carry), or left in the trough (rest)
    this.dip = { phase: 'grill', x: 0, z: 0, depth: 0, under: 0, heavy: 0, count: 0, inside: false, drip: 0, rest: 0, out: 0, servedWet: false, dipped: false };
    this.slicer = { active: false, minW: 0, maxW: 0, us: [] };
    this.holding = null;
    this.regrabs = 0;
    this.result = null;
    this.stats = { whiteT: 0, tareT: 0, plateT: 0, finishT: 0, rounds: 0, finished: false };
    this.warnT = 0;
    this.heatNow = 0;
    this.autoOpen = false;
    this.emit('reset');
  }

  setStep(step) {
    this.step = step;
    this.stepT = 0;
    this.emit('step', { step });
  }

  // ---------------- 捌く: trace the back line from the head end ----------------
  knifeDown(u, w, t) {
    if (this.step !== 'cut') return false;
    const F = this.fish;
    if (u > F.cutFront + 3.5 || u < F.cutFront - 8 || Math.abs(w) > 3.2) {
      this.knife.misses++;
      this.emit('knife-miss', { front: F.cutFront });
      return false;
    }
    Object.assign(this.knife, { active: true, lastU: Math.max(u, F.cutFront), lastW: w, lastT: t, startW: w });
    this.knifeSpeed = this.knifeSpeed || new Speed();
    this.knifeSpeed.reset(t, u);
    this.emit('knife-down');
    return true;
  }

  knifeMove(u, w, t) {
    const K = this.knife, F = this.fish;
    if (!K.active || this.step !== 'cut') return;
    const v = this.knifeSpeed.push(t, u);
    if (u > F.cutFront) {
      const to = Math.min(F.L, u);
      K.speeds.push(v);
      // the blade is drawn toward the back line, less so when rushed; big strays stay visible
      const alpha = 0.5 * (1 - 0.6 * smooth(35, 70, v));
      const i0 = F.bin(F.cutFront), i1 = Math.min(N - 1, Math.ceil(to / DU) - 1);
      for (let i = i0; i <= i1; i++) {
        if (F.cut[i]) continue;
        const k = clamp((F.u(i) - K.lastU) / Math.max(0.01, u - K.lastU), 0, 1);
        const y = K.lastW + (w - K.lastW) * k;
        const e = clamp(y - alpha * y * Math.exp(-(y * y) / 1.28), -TUNE.knifeMax, TUNE.knifeMax);
        const prev = i > 0 && F.cut[i - 1] ? F.e[i - 1] : e;
        const jump = i > 0 && F.cut[i - 1] && Math.abs(F.u(i) - K.lastU) < DU * 1.5 && K.restart ? Math.abs(e - prev) : 0;
        F.e[i] = e;
        F.cut[i] = 1;
        const slope = Math.abs(e - prev) / DU;
        F.rough[i] = clamp(0.8 * smooth(0.12, 0.9, slope) + 0.35 * smooth(40, 80, v) + 0.5 * smooth(0.1, 0.6, jump), 0, 1);
      }
      K.restart = false;
      F.cutFront = to;
      this.emit('cut-progress', { front: F.cutFront, v });
      if (F.cutFront >= F.L - 0.4) {
        for (let i = 0; i < N; i++) if (!F.cut[i]) { F.e[i] = i ? F.e[i - 1] : 0; F.cut[i] = 1; }
        F.cutFront = F.L;
        K.active = false;
        F.refreshGeometry();
        this.emit('cut-done');
        this.setStep('open');
      }
    }
    K.lastU = Math.max(K.lastU, u);
    K.lastW = w;
    K.lastT = t;
  }

  knifeUp() {
    if (!this.knife.active) return;
    this.knife.active = false;
    this.knife.strokes++;
    this.knife.restart = true;
  }

  // ---------------- 開く ----------------
  openDown(u, w, t = this.time) {
    if (this.step !== 'open') return false;
    Object.assign(this.opener, { active: true, u0: u, w0: w, dist: 0, lastT: t, lastD: 0 });
    this.openSpeed = new Speed();
    this.openSpeed.reset(t, 0);
    return true;
  }

  openMove(u, w, t = this.time) {
    const O = this.opener;
    if (!O.active) return;
    const d = Math.hypot((u - O.u0) * 0.35, w - O.w0);
    const v = this.openSpeed.push(t, d);
    O.vmax = Math.max(O.vmax, Math.abs(v));
    // count real back-and-forth (more than half a centimetre), not jitter
    const sign = Math.abs(d - O.lastD) > 0.5 ? Math.sign(d - O.lastD) : 0;
    if (sign && O.lastSign && sign !== O.lastSign) O.flips++;
    if (sign) O.lastSign = sign;
    if (!sign) { O.lastT = t; O.dist = Math.max(O.dist, d); this.fish.openK = Math.max(this.fish.openK, clamp(O.dist / 5, 0, 1)); if (this.fish.openK >= 1) this.finishOpen(); return; }
    O.lastD = d;
    O.lastT = t;
    O.dist = Math.max(O.dist, d);
    this.fish.openK = Math.max(this.fish.openK, clamp(O.dist / 5, 0, 1));
    if (this.fish.openK >= 1) this.finishOpen();
  }

  openUp() {
    if (!this.opener.active) return;
    this.opener.active = false;
    if (this.fish.openK > 0.55) this.autoOpen = true;
  }

  finishOpen() {
    if (this.step !== 'open') return;
    const O = this.opener;
    this.fish.openK = 1;
    // yanking it open hard or back and forth leaves a crease along the centre
    this.fish.crack = clamp(0.5 * smooth(35, 80, O.vmax) + 0.15 * Math.min(3, O.flips), 0, 1);
    O.active = false;
    this.autoOpen = false;
    this.emit('open-done');
    this.setStep('bone');
  }

  // ---------------- 骨 ----------------
  boneDown(u, w, t) {
    if (this.step !== 'bone') return false;
    const F = this.fish;
    if (u > F.peel + 6 || Math.abs(w) > 3) {
      this.emit('bone-miss');
      return false;
    }
    Object.assign(this.boner, { active: true, lastU: Math.max(u, F.peel), lastT: t });
    this.boneSpeed = new Speed();
    this.boneSpeed.reset(t, u);
    this.emit('bone-down');
    return true;
  }

  boneMove(u, w, t) {
    const B = this.boner, F = this.fish;
    if (!B.active || this.step !== 'bone') return;
    const v = this.boneSpeed.push(t, u);
    if (u > F.peel) {
      B.speeds.push(v);
      B.side.push(Math.abs(w));
      const i0 = F.bin(F.peel), i1 = Math.min(N - 1, Math.ceil(Math.min(u, F.L) / DU) - 1);
      // yanking it fast, or pulling it off to the side, tears the soft centre
      const tear = clamp(smooth(26, 60, v) * 0.75 + smooth(1.6, 3.4, Math.abs(w)) * 0.55, 0, 1);
      // an off-centre knife line also leaves the bone stuck to one side
      for (let i = i0; i <= i1; i++) F.loss[i] = Math.max(F.loss[i], tear, 0.4 * smooth(0.4, 1.4, Math.abs(F.e[i])));
      F.peel = Math.min(F.L, u);
      this.emit('bone-progress', { peel: F.peel, v });
      if (F.peel >= F.L - 1) {
        F.peel = F.L;
        F.boneOff = true;
        B.active = false;
        this.emit('bone-done');
        this.setStep('skewer');
      }
    }
    B.lastU = Math.max(B.lastU, u);
    B.lastT = t;
  }

  boneUp() {
    this.boner.active = false;
  }

  // ---------------- 串打ち ----------------
  skewerTap(u, w) {
    if (this.step !== 'skewer') return null;
    const F = this.fish;
    const i = F.bin(u);
    if (u < 0.6 || u > F.L - 0.6 || w < -F.farW(i) - 0.8 || w > F.nearW(i) + 0.8) return null;
    const near = F.skewers.findIndex((s) => Math.abs(s - u) < 1.7);
    if (near >= 0) {
      const [s] = F.skewers.splice(near, 1);
      F.holes = Math.min(3, F.holes + 1);
      F.setSag();
      this.emit('skewer-remove', { u: s });
      return 'remove';
    }
    if (F.skewers.length >= TUNE.maxSkewers) {
      this.emit('skewer-full');
      return null;
    }
    // soft guide: a tap near a guide mark moves half way onto it
    let p = u;
    for (const t of TICKS) if (Math.abs(p - t) < 1.5) p += (t - p) * 0.5;
    if (F.skewers.some((s) => Math.abs(s - p) < 3)) {
      this.emit('skewer-full');
      return null;
    }
    F.skewers.push(+p.toFixed(2));
    F.skewers.sort((a, b) => a - b);
    F.setSag();
    this.emit('skewer-add', { u: p });
    return 'add';
  }

  canGrill() {
    return this.step === 'skewer' && this.fish.skewers.length >= TUNE.minSkewers;
  }

  toGrill() {
    if (!this.canGrill()) return false;
    const F = this.fish;
    F.skewersGrill = [...F.skewers];
    F.setSag();
    const st = F.skewerStats();
    // uneven skewers flop when turned over: slower, clumsier flips
    this.grill.flipT = 0.42 + 0.3 * st.cv + (st.count === 3 ? 0.15 : 0);
    this.setStep('toGrill');
    return true;
  }

  // ---------------- 焼く ----------------
  // the fish is on the coals (not in the hand or in the tare)
  get onGrill() {
    return this.step === 'white' || (this.step === 'tare' && this.dip.phase === 'grill');
  }

  // the grill / tare part of the game is showing (whatever the hand is doing)
  get atGrill() {
    return this.step === 'white' || this.step === 'tare';
  }

  moveFish(dx, dz = 0) {
    if (!this.onGrill) return;
    const G = this.grill;
    const x = clamp(G.fishX + dx, GRILL_MOVE.x0, GRILL_MOVE.x1);
    const z = clamp(G.fishZ + dz, GRILL_MOVE.z0, GRILL_MOVE.z1);
    G.moved += Math.hypot(x - G.fishX, z - G.fishZ);
    G.fishX = x;
    G.fishZ = z;
  }

  flip() {
    if (!this.onGrill || this.grill.flipping > 0) return false;
    const G = this.grill;
    G.down = 1 - G.down;
    G.flipping = G.flipT;
    G.flips++;
    if (this.step === 'white') G.flipsWhite++;
    else G.flipsTare++;
    this.emit('flip', { down: G.down });
    return true;
  }

  // ---------------- つけダレ: lift, dip, lift out, back onto the coals ----------------
  // trough footprint (world, inner) and whether a fish whose head end is at x, centred at z, is over it
  troughOver(x, z) {
    const T = STATIONS.tare;
    const overlap = Math.min(x + FISH.L, T.x + T.inner.x) - Math.max(x, T.x - T.inner.x);
    return Math.abs(z - T.z) < T.inner.z - 1.2 && overlap > FISH.L * 0.3;
  }

  grabFish() {
    const D = this.dip, G = this.grill;
    if (this.step !== 'tare' || G.flipping > 0) return false;
    if (D.phase === 'grill') { D.x = G.fishX; D.z = G.fishZ; D.dipped = false; }
    else if (D.phase !== 'rest') return false;
    D.phase = 'carry';
    this.emit('lift', { from: D.depth > 0.5 ? 'tare' : 'grill' });
    return true;
  }

  // x = head end, z = centre line (world cm). Over the trough the fish is drawn toward its middle
  // (beginner help) and lined up with it so the skewers fit, but a far-off hand still leaves one end
  // outside: that end rests on the wall and only the rest goes in.
  moveCarry(x, z) {
    const D = this.dip;
    if (D.phase !== 'carry') return;
    const T = STATIONS.tare;
    x = clamp(x, -80, 40);
    z = clamp(z, -14, T.z + T.inner.z);
    const near = smooth(T.inner.z + 4, T.inner.z - 2, Math.abs(z - T.z));
    const cx = T.x - FISH.L / 2;
    x += (cx - x) * 0.4 * near;
    if (near > 0) x = clamp(x, cx - 30, cx + 30);
    if (this.troughOver(x, z)) z = T.z;
    D.x = x;
    D.z = z;
  }

  // world y of the fillet's centre at its head and tail end while it is off the coals.
  // depth 0 = carried high, 0.15 = the down face meets the tare, 0.8 = just under, 1 = deep.
  // With one end outside the trough that end rests on the wall and the fish tips into the tare.
  // The view draws exactly this and updateDip wets exactly the cells below the surface.
  dipPose() {
    const D = this.dip, P = STATIONS.tare, L = FISH.L, s = P.surf, dd = D.depth;
    const c = dd < 0.15 ? lerp(CARRY_Y, s + 0.5, dd / 0.15) : dd < 0.8 ? lerp(s + 0.5, s - 0.55, (dd - 0.15) / 0.65) : lerp(s - 0.55, s - 0.95, (dd - 0.8) / 0.2);
    const lo = P.x - P.inner.x, hi = P.x + P.inner.x, yW = P.h + 0.7;
    let yH = c, yT = c;
    if (c < yW && this.troughOver(D.x, D.z)) {
      if (D.x < lo) yH = yW + ((yW - c) * (lo - D.x)) / Math.max(1, D.x + L - lo);
      else if (D.x + L > hi) yT = yW + ((yW - c) * (D.x + L - hi)) / Math.max(1, hi - D.x);
    }
    return { yH, yT };
  }

  // where the fish goes if it is let go now: into the tare (it stays and soaks) when it is over the
  // trough, otherwise onto the coals as close as the konro allows to where it is held. The HUD draws
  // this before the hand opens, and releaseFish uses the same answer.
  previewRelease() {
    const D = this.dip;
    if (this.troughOver(D.x, D.z)) return { into: 'tare', x: D.x, z: STATIONS.tare.z };
    return { into: 'grill', x: clamp(D.x, GRILL_MOVE.x0, GRILL_MOVE.x1), z: clamp(D.z, GRILL_MOVE.z0, GRILL_MOVE.z1) };
  }

  // cancelled = the system took the pointer away (pause, blur, rotation, pointercancel): then the
  // fish goes back where it was on the coals instead of where the hand happened to be
  releaseFish(cancelled = false) {
    const D = this.dip;
    if (D.phase !== 'carry') return false;
    const r = this.previewRelease();
    if (r.into === 'tare') {
      D.phase = 'rest';       // left in the tare: it keeps soaking until it is lifted out
      D.rest = 0;
      this.emit('dip-rest');
      return true;
    }
    if (cancelled) this.putBack(this.grill.fishX, this.grill.fishZ, true);
    else this.putBack(r.x, r.z, false);
    return true;
  }

  putBack(x, z, dropped = false) {
    const D = this.dip, G = this.grill, F = this.fish;
    G.fishX = clamp(x, GRILL_MOVE.x0, GRILL_MOVE.x1);
    G.fishZ = clamp(z, GRILL_MOVE.z0, GRILL_MOVE.z1);
    D.phase = 'grill';
    D.depth = 0;
    let wet = 0;
    for (const a of F.A[G.down]) wet += a;
    this.emit('return', { wet: wet / (N * M), dropped });
  }

  updateDip(dt) {
    const D = this.dip, F = this.fish, G = this.grill, T = TUNE, P = STATIONS.tare;
    const over = this.troughOver(D.x, D.z);
    const want = D.phase === 'rest' || (D.phase === 'carry' && over) ? 1 : 0;
    const before = D.depth;
    D.depth = want > D.depth ? Math.min(want, D.depth + T.sinkRate * dt) : Math.max(want, D.depth - T.liftRate * dt);
    if (before < 0.5 && D.depth >= 0.5) {
      D.count++;
      D.heavy = 0;
      D.dipped = true;
      this.emit('dip-in', { x: D.x + FISH.L / 2, z: D.z, n: D.count });
    }
    if (before >= 0.3 && D.depth < 0.3) this.emit('dip-out', { x: D.x + FISH.L / 2, z: D.z });
    D.under = D.depth > 0.8 ? D.under + dt : D.depth < 0.2 ? 0 : D.under;
    // soaked in, not just clinging: that part does not run off when it is lifted out
    if (D.under > T.soakAfter) D.heavy += T.soak * dt;
    if (D.phase === 'rest') D.rest += dt;
    D.inside = over;
    const d = G.down, o = 1 - d;
    const flip = d === FLESH ? -1 : 1;
    const k = 1 - Math.exp(-dt / T.dipTau);
    const pose = this.dipPose();
    let drip = 0;
    for (let i = 0; i < N; i++) {
      const x = D.x + F.u(i);
      const inX = Math.abs(x - P.x) < P.inner.x;
      const y = pose.yH + ((pose.yT - pose.yH) * F.u(i)) / FISH.L;
      // the face toward the coals touches first; the other is coated once it goes right under
      const faces = y + 0.5 <= P.surf - 0.05 + 1e-3 ? [d, o] : y - 0.5 <= P.surf + 1e-3 ? [d] : null;
      for (let j = 0; j < M; j++) {
        const c = i * M + j;
        const inside = inX && Math.abs(D.z + flip * F.colW(i, j) - P.z) < P.inner.z;
        if (inside && faces) {
          for (const f of faces) {
            const a0 = F.A[f][c];
            let a = a0 < T.dipCoat ? a0 + (T.dipCoat - a0) * k : a0;
            if (D.under > T.soakAfter) a += T.soak * dt;   // kept under too long: a heavy coat
            F.A[f][c] = a;
            F.Atotal[f][c] += a - a0;
          }
        } else if (D.depth < 0.3) {
          // out of the tare: the excess runs off
          for (const f of [d, o]) {
            const a = F.A[f][c];
            const floor = T.dripTo + 0.85 * D.heavy;
            if (a > floor) {
              const r = (a - floor) * (1 - Math.exp(-dt * T.dripRate));
              F.A[f][c] -= r;
              drip += r;
            }
          }
        }
      }
    }
    D.drip = D.drip * Math.exp(-dt / 0.4) + drip;
    D.out = D.depth < 0.3 ? D.out + dt : 0;
    this.heatNow = 0;
  }

  updateGrill(dt) {
    const G = this.grill, F = this.fish;
    if (G.flipping > 0) {
      G.flipping = Math.max(0, G.flipping - dt);
      return;
    }
    const d = G.down, o = 1 - d;
    const T = TUNE;
    const kDown = d === FLESH ? T.kF : T.kS;
    const flip = d === FLESH ? -1 : 1; // flesh down: the fish is upside down, its w runs the other way
    let hot = 0, burning = 0, drip = 0;
    for (let i = 0; i < N; i++) {
      const x = G.fishX + F.u(i);
      const sag = 1 + 0.12 * F.sag[i];
      for (let j = 0; j < M; j++) {
        const c = i * M + j;
        const q = heatAt(x, G.fishZ + flip * F.colW(i, j)) * sag;
        const g = F.geo[c];
        const Dd = F.D[d][c];
        const knee = 1 - T.knee * smooth(T.kneeLo, T.kneeHi, Dd);
        const shield = 1 - T.shield * smooth(0, 0.8, F.A[d][c]);
        F.D[d][c] += kDown * q * g * knee * shield * dt;
        F.D[o][c] += T.kUp * kDown * q * Math.sqrt(g) * (1 - T.knee * smooth(T.kneeLo, T.kneeHi, F.D[o][c])) * dt;
        // core follows the faces; moisture goes once it is cooked through, fast when overdone
        const tgt = 0.5 * (F.D[0][c] + F.D[1][c]);
        F.K[c] += ((Math.min(tgt, 1.6) - F.K[c]) * dt) / (T.tauK * F.th[c] * F.th[c]);
        F.W[c] = Math.max(0.2, F.W[c] - T.wLoss * q * smooth(0.7, 1.05, F.K[c]) * (1 + 4 * Math.max(0, Dd - 1.35)) * dt);
        // tare on the down face dries into glaze; too much drips onto the coals
        const A = F.A[d][c];
        if (A > 0) {
          const conv = T.cDry * q * A * dt;
          F.A[d][c] -= conv;
          F.G[d][c] += conv;
          const dr = T.drip * Math.max(0, F.A[d][c] - 0.9) * dt;
          F.A[d][c] -= dr;
          drip += dr;
        }
        const Au = F.A[o][c];
        if (Au > 0) {
          const conv = T.cDry * T.cUp * q * Au * dt;
          F.A[o][c] -= conv;
          F.G[o][c] += conv;
        }
        if (F.G[d][c] > 0.05) F.B[d][c] += T.burnB * q * g * smooth(0.4, 2.4, F.G[d][c]) * smooth(1.45, 1.95, F.D[d][c]) * (F.A[d][c] < 0.25 ? 1 : 0.3) * dt;
        if (F.D[d][c] > 1.75) burning++;
        hot += q;
      }
    }
    G.drip = G.drip * Math.exp(-dt / 1.5) + drip;
    G.heatT += dt;
    this.heatNow = hot / (N * M);
    this.warnT -= dt;
    if (burning > N * M * 0.05 && this.warnT <= 0) {
      this.emit('burning', { face: d });
      this.warnT = 3.5;
    }
  }

  readyForTare() {
    return this.step === 'white' && this.stepT > 3;
  }

  toTare() {
    if (!this.readyForTare()) return false;
    this.stats.whiteT = this.stepT;
    this.setStep('tare');
    return true;
  }

  readyToServe() {
    return this.step === 'tare' && this.dip.count > 0;
  }

  toBoard() {
    if (!this.readyToServe()) return false;
    if (this.dip.phase !== 'grill') {
      // served straight from the hand or the trough: the last coat never set on the coals
      this.dip.servedWet = true;
      this.dip.phase = 'grill';
      this.dip.depth = 0;
    }
    this.stats.tareT = this.stepT;
    this.setStep('toBoard');
    return true;
  }

  // ---------------- 串を外す・切る ----------------
  unskewerTap(u) {
    if (this.step !== 'unskewer') return false;
    const F = this.fish;
    const k = F.skewers.findIndex((s) => Math.abs(s - u) < 2.2);
    if (k < 0) return false;
    const [s] = F.skewers.splice(k, 1);
    this.emit('unskewer', { u: s });
    if (!F.skewers.length) this.setStep('slice');
    return true;
  }

  sliceDown(u, w) {
    if (this.step !== 'slice') return false;
    Object.assign(this.slicer, { active: true, minW: w, maxW: w, us: [u], ws: [w] });
    return true;
  }

  sliceMove(u, w) {
    const S = this.slicer;
    if (!S.active) return;
    S.minW = Math.min(S.minW, w);
    S.maxW = Math.max(S.maxW, w);
    S.us.push(u);
    S.ws.push(w);
    const F = this.fish;
    const i = F.bin(u);
    if (S.minW < -F.farW(i) + 0.4 && S.maxW > F.nearW(i) - 0.4) this.commitSlice();
  }

  sliceUp() {
    this.slicer.active = false;
  }

  commitSlice() {
    const S = this.slicer, F = this.fish;
    S.active = false;
    let u = S.us.reduce((a, b) => a + b, 0) / S.us.length;
    const spread = Math.max(...S.us) - Math.min(...S.us);
    for (const g of [F.L / 3, (2 * F.L) / 3]) if (Math.abs(u - g) < 1.4) u += (g - u) * 0.5;
    if (u < 4 || u > F.L - 4 || F.cuts.some((c) => Math.abs(c - u) < 4)) {
      this.emit('slice-miss');
      return;
    }
    F.cuts.push(+u.toFixed(2));
    F.cuts.sort((a, b) => a - b);
    (F.cutAngles || (F.cutAngles = [])).push(spread);
    this.emit('slice', { u });
    if (F.cuts.length >= 2) {
      const b = [0, ...F.cuts, F.L];
      F.pieces = [0, 1, 2].map((k) => ({ k, u0: b[k], u1: b[k + 1], placed: false, slot: -1, x: 0, z: 0, rot: 0, err: 0, v: 0 }));
      this.setStep('plate');
    }
  }

  // ---------------- 盛り付け ----------------
  grabPiece(k) {
    if (this.step !== 'plate' && this.step !== 'finish') return false;
    const p = this.fish.pieces[k];
    if (!p) return false;
    if (p.placed) {
      p.placed = false;
      this.regrabs++;
      if (this.step === 'finish') this.setStep('plate');
    }
    this.holding = k;
    this.emit('pick', { k });
    return true;
  }

  // where a piece lands if it is let go at box-local (x, z) moving at (vx, vz) cm/s: the nearest free
  // slot pulls it in a little, a hurried drop skids and twists. Pure; the HUD previews it.
  previewDrop(x, z, vx, vz) {
    const F = this.fish;
    const inside = Math.abs(x) < BOX.inner.x + 1.5 && Math.abs(z) < BOX.inner.z + 1.5;
    if (!inside) return { inside: false };
    const used = new Set(F.pieces.filter((q) => q.placed && q.k !== this.holding).map((q) => q.slot));
    let best = -1, bd = 1e9;
    BOX.slots.forEach((s, i) => {
      if (used.has(i)) return;
      const dd = Math.hypot(s.x - x, s.z - z);
      if (dd < bd) { bd = dd; best = i; }
    });
    if (best < 0) return { inside: false };
    const v = Math.hypot(vx, vz);
    const skid = clamp((v - 25) / 120, 0, 1);
    const lx = clamp(x + vx * 0.035 * skid, -BOX.inner.x + 1.2, BOX.inner.x - 1.2);
    const lz = clamp(z + vz * 0.035 * skid, -BOX.inner.z + 1, BOX.inner.z - 1);
    const s = BOX.slots[best];
    const snap = 0.55 * (1 - skid);
    const px = lx + (s.x - lx) * snap, pz = lz + (s.z - lz) * snap;
    return {
      inside: true, slot: best, x: px, z: pz, v, skid,
      rot: clamp((vx * 0.004 + vz * 0.003) * skid + (lx - s.x) * 0.01, -0.45, 0.45),
      err: Math.hypot(px - s.x, pz - s.z),
    };
  }

  dropPiece(x, z, vx, vz) {
    if (this.holding == null) return false;
    const F = this.fish, p = F.pieces[this.holding];
    const r = this.previewDrop(x, z, vx, vz);
    this.holding = null;
    if (!r.inside) {
      this.emit('drop-miss', { k: p.k });
      return false;
    }
    Object.assign(p, { placed: true, slot: r.slot, x: r.x, z: r.z, rot: r.rot, v: r.v, err: r.err });
    this.emit('drop', { k: p.k, err: p.err, v: r.v });
    if (F.pieces.every((q) => q.placed)) {
      this.stats.plateT = this.stepT;
      this.setStep('finish');
    }
    return true;
  }

  finish() {
    if (this.step !== 'finish') return false;
    this.stats.finishT = this.stepT;
    this.stats.finished = true;
    this.result = evaluate(this);
    this.setStep('result');
    this.emit('result', this.result);
    return true;
  }

  // ---------------- main update ----------------
  update(dt) {
    this.time += dt;
    this.stepT += dt;
    const s = this.step;
    if (s === 'open' && this.autoOpen) {
      this.fish.openK = Math.min(1, this.fish.openK + dt * 2.2);
      if (this.fish.openK >= 1) this.finishOpen();
    }
    if (s === 'toGrill' && this.stepT >= MOVE_T) this.setStep('white');
    if (s === 'toBoard' && this.stepT >= MOVE_T) this.setStep('unskewer');
    if (this.onGrill) this.updateGrill(dt);
    else if (s === 'tare') this.updateDip(dt);
  }
}

export { FLESH, SKIN, bodyRadius, TICKS };
