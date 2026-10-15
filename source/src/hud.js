import { FISH, GRILL, GRILL_MOVE, STATIONS, BOX, heatAt } from './config.js';
import { t as tr, fontStack } from './i18n.js';
import { clamp } from './util.js';
import * as THREE from 'three';
import { TICKS } from './model/game.js';

// labels follow the display language's font (the Japanese subset font is not used for Korean / Chinese)
const P = { x: 0, y: 0 };

// 2D overlay: where to start each gesture, which way to move, tap targets, the charcoal heat strip.
export class Hud {
  constructor(canvas) {
    this.c = canvas;
    this.g = canvas.getContext('2d');
    this.W = 1;
    this.H = 1;
    this.dpr = 1;
    this.t = 0;
    this.seen = {};
  }

  resize(W, H, dpr) {
    this.W = W;
    this.H = H;
    this.dpr = dpr;
    this.c.width = Math.round(W * dpr);
    this.c.height = Math.round(H * dpr);
  }

  // fit: the widest the text may be (px); longer translations shrink instead of running off screen
  label(text, x, y, size, color = '#fff', fit = 0) {
    const g = this.g;
    const font = fontStack();
    g.font = `800 ${size}px ${font}`;
    const maxW = fit || this.W * 0.46;
    const w = g.measureText(text).width;
    if (w > maxW) {
      size = Math.max(9, size * (maxW / w));
      g.font = `800 ${size}px ${font}`;
    }
    // keep it inside the canvas
    const half = Math.min(g.measureText(text).width, maxW) / 2 + size * 0.3;
    x = Math.min(Math.max(x, half), this.W - half);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = size * 0.3;
    g.strokeStyle = 'rgba(52,30,16,0.92)';
    g.strokeText(text, x, y);
    g.fillStyle = color;
    g.fillText(text, x, y);
  }

  finger(x, y, s, press) {
    const g = this.g;
    g.save();
    g.translate(x, y);
    g.scale(s, s);
    g.fillStyle = 'rgba(255,255,255,0.33)';
    g.beginPath();
    g.arc(0, 0, press ? 22 : 17, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.strokeStyle = '#4a2b16';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(0, 0, 9, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.restore();
  }

  // a hint finger; on touch it sits below the line (by the tool lift) with a thin link up to the
  // point the tool will work, which is how the gesture is meant to be held
  hintFinger(input, x, y, s, press) {
    const L = input.touch ? input.lift() : 0;
    if (L > 0) {
      const g = this.g;
      g.strokeStyle = 'rgba(255,255,255,0.7)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x, y + L);
      g.lineTo(x, y);
      g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.95)';
      g.beginPath();
      g.arc(x, y, 3.2, 0, Math.PI * 2);
      g.fill();
    }
    this.finger(x, y + L, s, press);
  }

  // a flat outline on the table / rice / coals from world points (fill and/or dashed stroke)
  poly(D, pts, fill, stroke, w = 2, dash = null) {
    const g = this.g;
    const q = pts.map((p) => D.project(new THREE.Vector3(p[0], p[1], p[2])));
    if (q.some((v) => v.behind)) return;
    g.beginPath();
    q.forEach((v, k) => (k ? g.lineTo(v.x, v.y) : g.moveTo(v.x, v.y)));
    g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) {
      g.strokeStyle = stroke;
      g.lineWidth = w;
      if (dash) g.setLineDash(dash);
      g.stroke();
      g.setLineDash([]);
    }
  }

  // the footprint of a plated piece (length along the box depth, turned by rot), world points
  pieceRect(X, x, z, len, half, rot) {
    const a = -Math.PI / 2 + rot, ca = Math.cos(a), sa = Math.sin(a);
    // local x (along the piece) → world (cos a, -sin a); local z (across) → world (sin a, cos a)
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => {
      const lx = (i * len) / 2, lz = j * half;
      return [X.x + x + lx * ca + lz * sa, X.rice + 0.7, X.z + z - lx * sa + lz * ca];
    });
  }

  arrow(x0, y0, x1, y1, w, color, dash = true) {
    const g = this.g;
    const a = Math.atan2(y1 - y0, x1 - x0);
    g.strokeStyle = color;
    g.lineWidth = w;
    g.lineCap = 'round';
    if (dash) {
      g.setLineDash([w * 1.5, w * 1.3]);
      g.lineDashOffset = -this.t * 40;
    }
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1 - Math.cos(a) * w * 1.6, y1 - Math.sin(a) * w * 1.6);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x1 - Math.cos(a - 0.5) * w * 3.2, y1 - Math.sin(a - 0.5) * w * 3.2);
    g.lineTo(x1 - Math.cos(a + 0.5) * w * 3.2, y1 - Math.sin(a + 0.5) * w * 3.2);
    g.closePath();
    g.fill();
  }

  draw(dt, app) {
    this.t += dt;
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.c.width, this.c.height);
    if (app.mode !== 'play' || app.paused) return;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const game = app.game, D = app.director, input = app.input, F = game.fish;
    const u = app.u, s = game.step;
    const fp = (uu, y, w) => D.projectFish(uu, y, w, { x: 0, y: 0 });
    const loop = (period) => (this.t % period) / period;
    if (s === 'cut' && !game.knife.active) {
      // the back line from where the cut stands to the tail
      const top = FISH.R * 2 + 0.05;
      g.strokeStyle = 'rgba(255,236,190,0.95)';
      g.lineWidth = Math.max(2, u * 0.45);
      g.setLineDash([u * 1.4, u * 1.1]);
      g.lineDashOffset = -this.t * 30;
      g.beginPath();
      for (let k = 0; k <= 40; k++) {
        const uu = F.cutFront + ((F.L - F.cutFront) * k) / 40;
        const q = fp(uu, top, 0);
        if (!k) g.moveTo(q.x, q.y);
        else g.lineTo(q.x, q.y);
      }
      g.stroke();
      g.setLineDash([]);
      const a = fp(F.cutFront + 0.3, top, 0), b = fp(Math.min(F.L, F.cutFront + F.L * 0.25), top, 0);
      this.arrow(a.x, a.y - u * 5, b.x, b.y - u * 5, u * 0.9, 'rgba(225,70,42,0.95)');
      const k = loop(2.2);
      const f = fp(F.cutFront + 0.3 + F.L * 0.3 * k, top, 0);
      this.hintFinger(input, f.x, f.y, u / 6, k < 0.85);
      this.label(tr(F.cutFront < 1 ? 'h.cut' : 'h.cutCont'), a.x + u * 4, a.y - u * 10, u * 3.6);
    }
    if (s === 'open') {
      const m = fp(F.L / 2, 2.5, 0);
      const k = loop(1.6);
      const dy = u * (3 + 7 * k);
      this.arrow(m.x, m.y - u * 2, m.x, m.y - dy - u * 4, u * 0.9, 'rgba(255,255,255,0.95)', false);
      this.arrow(m.x, m.y + u * 2, m.x, m.y + dy + u * 4, u * 0.9, 'rgba(255,255,255,0.95)', false);
      this.finger(m.x, m.y + dy, u / 6, true);
      this.label(tr('h.open'), m.x, m.y - u * 15, u * 3.6);
    }
    if (s === 'bone' && !game.boner.active) {
      const a = fp(Math.max(0.5, F.peel + 0.5), 1.4, 0), b = fp(Math.min(F.L - 1, F.peel + F.L * 0.35), 1.4, 0);
      this.arrow(a.x, a.y, b.x, b.y, u * 0.9, 'rgba(255,236,190,0.95)');
      const k = loop(2);
      const f = fp(F.peel + 0.5 + F.L * 0.3 * k, 1.4, 0);
      this.hintFinger(input, f.x, f.y, u / 6, true);
      this.label(tr('h.bone'), a.x + u * 6, a.y - u * 9, u * 3.4);
    }
    if (s === 'skewer') {
      const n = F.skewers.length;
      // faint even marks as a starting hint (the player still chooses)
      if (n < 3 && !this.seen.skewer) {
        for (const su of TICKS) {
          g.strokeStyle = 'rgba(255,255,255,0.55)';
          g.lineWidth = 2;
          g.setLineDash([4, 5]);
          const a = fp(su, 1.1, -4.5), b = fp(su, 1.1, 4.5);
          g.beginPath();
          g.moveTo(a.x, a.y);
          g.lineTo(b.x, b.y);
          g.stroke();
          g.setLineDash([]);
        }
        const q = fp(TICKS[0], 1.1, 0);
        this.finger(q.x, q.y, u / 6, loop(1.2) < 0.5);
      }
      if (n >= 3) this.seen.skewer = true;
      const c = fp(F.L / 2, 1.1, -7);
      this.label(tr('h.skewers', { n }), c.x, c.y - u * 4, u * 3.4);
    }
    if (game.onGrill) this.drawGrill(g, app, fp, u);
    if (s === 'tare') this.drawTare(g, app, fp, u, loop);
    void heatAt;
    if (s === 'unskewer') {
      for (const su of F.skewers) {
        const q = fp(su, 1.2, 6.5);
        g.strokeStyle = 'rgba(255,255,255,0.95)';
        g.lineWidth = u * 0.6;
        g.beginPath();
        g.arc(q.x, q.y, u * 3.2 * (1 + Math.sin(this.t * 6 + su) * 0.08), 0, Math.PI * 2);
        g.stroke();
      }
      if (F.skewers.length) {
        const q = fp(F.skewers[0], 1.2, 6.5);
        this.label(tr('h.unskewer'), q.x, q.y + u * 7, u * 3.4);
      }
    }
    if (s === 'slice') {
      for (const gu of [F.L / 3, (2 * F.L) / 3]) {
        if (F.cuts.some((c) => Math.abs(c - gu) < 3)) continue;
        const a = fp(gu, 1.3, -6.5), b = fp(gu, 1.3, 6.5);
        g.strokeStyle = 'rgba(255,255,255,0.9)';
        g.lineWidth = u * 0.5;
        g.setLineDash([u * 1.2, u * 0.9]);
        g.lineDashOffset = -this.t * 25;
        g.beginPath();
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
        g.stroke();
        g.setLineDash([]);
      }
      if (!game.slicer.active) {
        const gu = F.cuts.length ? (2 * F.L) / 3 : F.L / 3;
        const a = fp(gu, 1.3, -6.5), b = fp(gu, 1.3, 6.5);
        const k = loop(1.6);
        this.finger(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, u / 6, true);
        this.label(tr('h.slice'), a.x, a.y - u * 4, u * 3.4);
      }
    }
    if (s === 'plate') {
      const X = STATIONS.box;
      const used = new Set(F.pieces.filter((p) => p.placed).map((p) => p.slot));
      const held = game.holding != null && D.carry && D.carry.box ? D.carry.box : null;
      const pv = held ? game.previewDrop(held.x, held.z, input.vel.x, input.vel.z) : null;
      const hp = game.holding != null ? F.pieces[game.holding] : null;
      const len = hp ? hp.u1 - hp.u0 : F.L / 3;
      // slot guides as long as the pieces (they hang over the rims); the one a held piece will
      // snap to is lit, the others stay dashed
      BOX.slots.forEach((sl, i) => {
        if (used.has(i)) return;
        const lit = pv && pv.inside && pv.slot === i;
        this.poly(D, this.pieceRect(X, sl.x, sl.z, len, 3.3, 0), lit ? 'rgba(255,214,120,0.22)' : null,
          lit ? 'rgba(255,226,150,0.95)' : held && pv && !pv.inside ? 'rgba(200,190,180,0.5)' : 'rgba(255,240,200,0.85)',
          u * (lit ? 0.6 : 0.45), lit ? null : [u * 1.1, u * 0.8]);
      });
      // where the held piece will come to rest (the same rule as the drop itself)
      if (pv && pv.inside) this.poly(D, this.pieceRect(X, pv.x, pv.z, len, 3.1, pv.rot), 'rgba(255,255,255,0.14)', pv.err < 1 ? 'rgba(170,255,170,0.9)' : 'rgba(255,255,255,0.75)', 2);
      if (game.holding == null) {
        const boxes = D.pieceScreenBoxes(game);
        // mouse: outline the piece under the pointer
        if (input.hover && input.hover.piece != null) {
          const b = boxes.find((q) => q.k === input.hover.piece);
          if (b) { g.strokeStyle = 'rgba(255,240,200,0.8)'; g.lineWidth = 2; g.strokeRect(b.x0 - 4, b.y0 - 4, b.x1 - b.x0 + 8, b.y1 - b.y0 + 8); }
        }
        if (boxes.length) {
          const b = boxes[0];
          const to = D.project(new THREE.Vector3(X.x + BOX.slots[[...Array(3).keys()].find((i) => !used.has(i)) ?? 1].x, X.rice + 1, X.z));
          const from = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
          this.arrow(from.x, from.y - u * 3, to.x, to.y - u * 3, u * 0.8, 'rgba(255,255,255,0.9)');
          this.label(tr('h.plate'), (from.x + to.x) / 2, Math.min(from.y, to.y) - u * 9, u * 3.4);
        }
      }
    }
    // mouse: a soft outline round the fish that can be picked up / moved
    if (input.hover === 'fish' && (s === 'tare' || game.onGrill)) {
      const P = app.fishView.group.position;
      const y = P.y + 0.6;
      this.poly(D, [[P.x - 1, y, P.z - 5], [P.x + F.L + 1, y, P.z - 5], [P.x + F.L + 1, y, P.z + 5], [P.x - 1, y, P.z + 5]], null, 'rgba(255,240,200,0.55)', 2, [6, 5]);
    }
    // touch: show where the tool actually is (above the finger)
    if (input.touch && input.toolScreen && input.fingerScreen) {
      g.strokeStyle = 'rgba(255,255,255,0.6)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(input.fingerScreen.x, input.fingerScreen.y);
      g.lineTo(input.toolScreen.x, input.toolScreen.y);
      g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.92)';
      g.beginPath();
      g.arc(input.toolScreen.x, input.toolScreen.y, u * 1.1, 0, Math.PI * 2);
      g.fill();
    }
  }

  // the charcoal's three bands (強 back, 中 middle, 弱 front) and where the fish sits
  drawGrill(g, app, fp, u) {
    const game = app.game, D = app.director, F = game.fish;
    const y = GRILL.rimY + 0.3;
    // just beyond the head end of the fish's travel, kept on screen whatever the framing
    const x = GRILL_MOVE.x0 - 1.8;
    const bands = [[tr('h.hi'), -8, '#ff8a3a'], [tr('h.mid'), 0, '#ffb35c'], [tr('h.lo'), 8, '#ffd9a0']];
    const W = this.W, m = u * 3.4;
    const onScreen = (p) => { p.x = Math.min(Math.max(p.x, m), W - m); return p; };
    for (const [t, z, c] of bands) {
      const p = onScreen(D.project(new THREE.Vector3(x, y, z)));
      g.fillStyle = 'rgba(40,22,12,0.72)';
      g.beginPath();
      g.arc(p.x, p.y, u * 2.6, 0, Math.PI * 2);
      g.fill();
      this.label(t, p.x, p.y + 1, u * 3, c, u * 4.6);
    }
    const head = onScreen(D.project(new THREE.Vector3(x, y, game.grill.fishZ)));
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(head.x + u * 3.2, head.y);
    g.lineTo(head.x + u * 5.5, head.y);
    g.stroke();
    // flip cue: whenever the side on the coals has browned clearly more than the top (the same
    // moment the guide line says 返しどき), a small curved arrow over the fish; words only the first time
    const down = game.grill.down, up = 1 - down;
    let dd = 0, du = 0;
    const i0 = Math.round(F.N * 0.2), i1 = Math.round(F.N * 0.8);
    for (let i = i0; i < i1; i++) {
      dd += F.D[down][i * F.M + (F.M >> 1)];
      du += F.D[up][i * F.M + (F.M >> 1)];
    }
    dd /= i1 - i0;
    du /= i1 - i0;
    // in the tare step: when the tare on the coals' side has set and the top is still wet
    const wet = (f) => { let a = 0; for (let i = i0; i < i1; i++) a += F.A[f][i * F.M + (F.M >> 1)]; return a / (i1 - i0); };
    const setTare = game.step === 'tare' && game.dip.count > 0 && wet(down) < 0.1 && wet(up) > 0.1;
    const ready = game.grill.flipping === 0 && ((game.step === 'white' && dd > 0.45 && dd - du >= 0.2) || setTare);
    if (ready) {
      const q = fp(F.L / 2, 2, 0);
      const r = u * 6;
      const pulse = 0.75 + 0.25 * Math.sin(this.t * 6);
      g.strokeStyle = `rgba(255,255,255,${0.95 * pulse})`;
      g.lineWidth = u * 0.8;
      g.beginPath();
      g.arc(q.x, q.y - u * 6, r, Math.PI * 0.15, Math.PI * 0.85, true);
      g.stroke();
      if (!this.seen.flip) this.label(tr('h.flip'), q.x, q.y - u * 14, u * 3.4);
    }
    if (game.grill.flips > 0 && game.step === 'white') this.seen.flip = true;
  }

  // つけダレ: where to take the fish (the trough in front), and back onto the coals
  drawTare(g, app, fp, u, loop) {
    const game = app.game, D = app.director, dip = game.dip, T = STATIONS.tare, F = game.fish;
    const trough = D.project(new THREE.Vector3(T.x, T.surf, T.z));
    const grp = app.fishView.group.position;
    const mid = D.project(new THREE.Vector3(grp.x + F.L / 2, grp.y + 1, grp.z));
    const k = loop(1.8);
    if (dip.phase === 'grill' && game.grill.flipping === 0) {
      // first time, or when the coat has set and another round would help: from the fish down into the tare
      let wetAny = 0;
      for (let c = 0; c < F.N * F.M; c += 7) wetAny = Math.max(wetAny, F.A[0][c], F.A[1][c]);
      if (dip.count === 0 || (dip.count < 2 && wetAny < 0.15)) {
        this.arrow(mid.x, mid.y + u * 3, trough.x, trough.y - u * 2, u * 0.9, 'rgba(255,236,190,0.95)');
        const f = { x: mid.x + (trough.x - mid.x) * k, y: mid.y + (trough.y - mid.y) * k };
        this.finger(f.x, f.y, u / 6, k > 0.05 && k < 0.9);
        if (!this.seen.dip) this.label(tr('h.dip'), mid.x + u * 16, (mid.y + trough.y) / 2, u * 3.6);
      }
    } else if (dip.phase === 'carry') {
      this.seen.dip = true;
      // where the fish goes if the hand opens now: into the tare, or onto this spot on the coals
      const r = game.previewRelease();
      if (r.into === 'tare') {
        this.poly(D, [[T.x - T.inner.x, T.surf, T.z - T.inner.z], [T.x + T.inner.x, T.surf, T.z - T.inner.z], [T.x + T.inner.x, T.surf, T.z + T.inner.z], [T.x - T.inner.x, T.surf, T.z + T.inner.z]],
          'rgba(255,170,70,0.10)', 'rgba(255,200,120,0.75)', 2);
      } else {
        const y = GRILL.rimY + 0.2;
        this.poly(D, [[r.x, y, r.z - 4.5], [r.x + F.L, y, r.z - 4.5], [r.x + F.L, y, r.z + 4.5], [r.x, y, r.z + 4.5]],
          'rgba(255,255,255,0.10)', 'rgba(255,255,255,0.8)', 2, [8, 6]);
      }
      if (!dip.dipped) {
        if (dip.depth < 0.1) {
          this.arrow(mid.x, mid.y + u * 2, trough.x, trough.y - u * 1, u * 0.8, 'rgba(255,236,190,0.9)');
          this.label(tr('h.overTare'), trough.x, trough.y + u * 7, u * 3.4);
        }
      } else if (dip.depth < 0.3) {
        // lifted out: back over the coals
        const grill = D.project(new THREE.Vector3(game.grill.fishX + F.L / 2, GRILL.rimY, game.grill.fishZ));
        this.arrow(mid.x, mid.y - u * 2, grill.x, grill.y, u * 0.9, 'rgba(255,236,190,0.95)');
        this.label(tr('h.backToGrill'), grill.x, grill.y - u * 7, u * 3.4);
      } else if (dip.under > 0.25) {
        // under: lift when it is covered, the ring fills up as it soaks
        const full = clamp(dip.under / 1.4, 0, 1);
        g.strokeStyle = dip.under > 1.4 ? 'rgba(255,120,90,0.95)' : 'rgba(255,255,255,0.92)';
        g.lineWidth = u * 0.8;
        g.beginPath();
        g.arc(trough.x, trough.y - u * 9, u * 3, -Math.PI / 2, -Math.PI / 2 + full * Math.PI * 2);
        g.stroke();
        this.label(tr(dip.under > 1.4 ? 'h.liftNow' : 'h.lift'), trough.x, trough.y - u * 15, u * 3.4);
      }
    } else if (dip.phase === 'rest') {
      const r = u * (5 + Math.sin(this.t * 6) * 0.4);
      g.strokeStyle = 'rgba(255,255,255,0.92)';
      g.lineWidth = u * 0.6;
      g.beginPath();
      g.arc(trough.x, trough.y, r, 0, Math.PI * 2);
      g.stroke();
      this.label(tr('h.grabLift'), trough.x, trough.y - u * 9, u * 3.4);
    }
  }
}
