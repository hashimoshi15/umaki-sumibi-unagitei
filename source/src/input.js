import { FISH, STATIONS, GRILL_MOVE } from './config.js';
import { clamp, smooth } from './util.js';

// the pointer is read on this plane while the fish is carried (between the konro rims and the tare)
const CARRY_PLANE = 11;

// Pointer (mouse / touch / pen) and keyboard → game actions.
// Every gesture is converted to the fish's own coordinates (u along, w across) or box coordinates.
// On touch, tools that would sit under the fingertip (knife) are drawn a little above it.
// つけダレ: the skewered fish is picked up by a press-and-drag, carried to the trough and back.
export class Input {
  constructor(canvas, app) {
    this.canvas = canvas;
    this.app = app;
    this.id = null;
    this.mode = null;
    this.touch = false;
    this.trail = [];
    this.toolFish = null;      // where the knife is, in fish coords (for drawing)
    this.fingerScreen = null;
    this.toolScreen = null;
    this.downAt = null;
    this.downT = 0;
    this.moved = 0;
    this.lastBox = null;
    this.vel = { x: 0, z: 0 };
    this.keys = new Set();
    this.offY = 0;             // touch: how far above the finger the tool sits for this gesture (px)
    this.disp = 0;             // largest distance from the press point so far (px)
    this.hover = null;         // mouse, nothing pressed: what is under the pointer (for the cursor / outline)
    this.carryShown = null;    // plating: where the held piece is drawn (screen px)
    // touch devices start in touch mode, so the first hints already show the finger below the line
    this.touch = !!(window.matchMedia && matchMedia('(any-pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches);
    const opt = { passive: false };
    canvas.addEventListener('pointerdown', (e) => this.down(e), opt);
    canvas.addEventListener('pointermove', (e) => this.move(e), opt);
    canvas.addEventListener('pointerup', (e) => this.up(e, false), opt);
    canvas.addEventListener('pointercancel', (e) => this.up(e, true), opt);
    canvas.addEventListener('lostpointercapture', (e) => { if (e.pointerId === this.id) this.up(e, true); });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.keyDown(e));
    window.addEventListener('keyup', (e) => this.keys.delete(e.key));
  }

  get game() { return this.app.game; }
  get dir() { return this.app.director; }

  local(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  lift() {
    return this.touch ? clamp(this.app.H * 0.08, 24, 54) : 0;
  }

  // a finger wobbles: a press counts as a tap until it has moved this far from where it went down
  slop() {
    return this.touch ? 12 : 5;
  }

  // touch: decide once per gesture how far above the finger the tool sits. A finger on the line
  // works the line directly; a finger below it lifts the tool onto the line (at most lift() px),
  // so the line stays visible. Fixed for the whole stroke, so the tool never jumps.
  gestureLift(p, u, yLocal) {
    if (!this.touch) return 0;
    const line = this.dir.projectFish(clamp(u, 0, FISH.L), yLocal, 0, { x: 0, y: 0 });
    return clamp(p.y - line.y, 0, this.lift());
  }

  // pointer → fish coordinates on the fish's surface (lifted: the tool point of this gesture)
  fishAt(p, yLocal, lifted) {
    const y = lifted ? p.y - this.offY : p.y;
    const q = this.dir.toFish(p.x, y, yLocal);
    if (q && lifted && this.touch) {
      this.fingerScreen = p;
      this.toolScreen = { x: p.x, y };
    }
    return q;
  }

  now() {
    return this.game.time;
  }

  down(e) {
    if (!this.app.canPlay() || this.id !== null) return;
    e.preventDefault();
    this.app.userGesture();
    this.id = e.pointerId;
    this.touch = e.pointerType === 'touch' || e.pointerType === 'pen';
    try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointer */ }
    const p = this.local(e);
    this.downAt = p;
    this.downT = performance.now();
    this.moved = 0;
    this.disp = 0;
    this.offY = 0;
    this.trail = [p];
    this.mode = null;
    this.setCursor(null);
    const g = this.game, s = g.step;
    const topY = FISH.R * 2;
    if (s === 'cut') {
      const q0 = this.fishAt(p, topY, false);
      if (q0) this.offY = this.gestureLift(p, q0.u, topY);
      const q = this.fishAt(p, topY, true);
      if (q && g.knifeDown(q.u, q.w, this.now())) { this.mode = 'cut'; this.toolFish = q; }
    } else if (s === 'open') {
      const q = this.fishAt(p, 1.2, false);
      if (q && g.openDown(q.u, q.w)) this.mode = 'open';
    } else if (s === 'bone') {
      const q0 = this.fishAt(p, 1.0, false);
      if (q0) this.offY = this.gestureLift(p, q0.u, 1.0);
      const q = this.fishAt(p, 1.0, true);
      if (q && g.boneDown(q.u, q.w, this.now())) this.mode = 'bone';
    } else if (s === 'skewer') {
      this.mode = 'tapSkewer';
    } else if (s === 'tare') {
      // the fillet or its skewer ends; while it soaks, anywhere on the trough picks it up again
      const q = this.fishAt(p, 0.6, false);
      const onFish = q && q.u > -2 && q.u < FISH.L + 2 && Math.abs(q.w) < 15;
      const T = STATIONS.tare, tw = this.dir.toWorldPlane(p.x, p.y, T.surf);
      const onTrough = g.dip.phase === 'rest' && tw && Math.abs(tw.x - T.x) < T.len / 2 + 2 && Math.abs(tw.z - T.z) < T.w / 2 + 2;
      if (onFish || onTrough) {
        this.mode = 'lift?';
        const w = this.dir.toWorldPlane(p.x, p.y, CARRY_PLANE);
        const D = g.dip, from = D.phase === 'grill' ? { x: g.grill.fishX, z: g.grill.fishZ } : { x: D.x, z: D.z };
        this.grabOff = w ? { x: from.x - w.x, z: from.z - w.z } : { x: 0, z: 0 };
      }
    } else if (g.onGrill) {
      const q = this.fishAt(p, 0.6, false);
      const onFish = q && q.u > -1 && q.u < FISH.L + 1 && q.w > -6 && q.w < 6;
      const onHandles = q && q.u > -1 && q.u < FISH.L + 1 && Math.abs(q.w) >= 6 && Math.abs(q.w) < 15;
      if (onFish || onHandles) {
        this.mode = 'grab';
        this.grabX = this.dir.toWorldPlane(p.x, p.y, STATIONS.grill.h);
      }
    } else if (s === 'unskewer') {
      this.mode = 'tapUnskewer';
    } else if (s === 'slice') {
      // the stroke only has to cross the fillet: it follows the finger; the knife is drawn above it
      this.offY = this.lift();
      const q = this.fishAt(p, 1.2, false);
      if (q && g.sliceDown(q.u, q.w)) { this.mode = 'slice'; this.toolFish = this.fishAt(p, 1.2, true) || q; }
    } else if (s === 'plate') {
      const hit = this.dir.pieceScreenBoxes(g).find((b) => p.x > b.x0 - 12 && p.x < b.x1 + 12 && p.y > b.y0 - 12 && p.y < b.y1 + 12);
      if (hit && g.grabPiece(hit.k)) {
        this.mode = 'carry';
        this.carryK = hit.k;
        this.vel = { x: 0, z: 0 };
        this.lastBox = null;
        this.updateCarry(p, e.timeStamp);
      }
    }
    if (!this.mode) this.release();
  }

  move(e) {
    if (this.id === null && e.pointerType === 'mouse') { this.hoverAt(this.local(e)); return; }
    if (e.pointerId !== this.id) return;
    e.preventDefault();
    const p = this.local(e);
    const last = this.trail[this.trail.length - 1] || p;
    this.moved += Math.hypot(p.x - last.x, p.y - last.y);
    if (this.downAt) this.disp = Math.max(this.disp, Math.hypot(p.x - this.downAt.x, p.y - this.downAt.y));
    this.trail.push(p);
    if (this.trail.length > 48) this.trail.shift();
    const g = this.game;
    const topY = FISH.R * 2;
    switch (this.mode) {
      case 'cut': {
        const q = this.fishAt(p, topY, true);
        if (q) { g.knifeMove(q.u, q.w, this.now()); this.toolFish = q; }
        break;
      }
      case 'open': {
        const q = this.fishAt(p, 1.2, false);
        if (q) g.openMove(q.u, q.w);
        break;
      }
      case 'bone': {
        const q = this.fishAt(p, 1.0, this.touch);
        if (q) g.boneMove(q.u, q.w, this.now());
        break;
      }
      case 'lift?':
        // a press that really moves lifts the fish off the coals (or out of the tare); a tap flips
        if (this.disp > this.slop() && g.grabFish()) {
          this.mode = 'dip';
          this.setCursor('grabbing');
          this.carryTo(p);
        }
        break;
      case 'dip':
        this.carryTo(p);
        break;
      case 'grab': {
        const w = this.dir.toWorldPlane(p.x, p.y, STATIONS.grill.h);
        if (w && this.grabX && this.disp > this.slop()) {
          g.moveFish(w.x - this.grabX.x, w.z - this.grabX.z);
          this.grabX = w;
          this.dragging = true;
        }
        break;
      }
      case 'slice': {
        const q = this.fishAt(p, 1.2, false);
        if (q) { g.sliceMove(q.u, q.w); this.toolFish = this.fishAt(p, 1.2, true) || q; }
        if (g.step !== 'slice' || !g.slicer.active) { this.mode = null; }
        break;
      }
      case 'carry':
        this.updateCarry(p, e.timeStamp);
        break;
      default:
    }
    if (this.mode === 'tapSkewer' || this.mode === 'tapUnskewer') {
      // nothing to do while moving; taps resolve on release
    }
  }

  carryTo(p) {
    const w = this.dir.toWorldPlane(p.x, p.y, CARRY_PLANE);
    if (w) this.game.moveCarry(w.x + this.grabOff.x, w.z + this.grabOff.z);
  }

  // plating: the held piece is drawn on the same view ray it will land on, so what you see is where
  // it goes; on touch it floats a little above the finger (eased in over the first 40 px)
  carryPoint(p) {
    if (!this.touch) return p;
    return { x: p.x, y: p.y - this.lift() * smooth(0, 40, this.disp) };
  }

  updateCarry(p, ts) {
    const lp = this.carryPoint(p);
    const b = this.dir.toBox(lp.x, lp.y);
    const world = b ? this.dir.toWorldPlane(lp.x, lp.y, STATIONS.box.rice + 4.5) : null;
    if (b && world) {
      if (this.lastBox) {
        const dt = Math.max(0.008, (ts - this.lastBox.t) / 1000);
        const vx = (b.x - this.lastBox.x) / dt, vz = (b.z - this.lastBox.z) / dt;
        // smoothed hand speed (cm/s) for the landing
        this.vel.x += (vx - this.vel.x) * 0.45;
        this.vel.z += (vz - this.vel.z) * 0.45;
      }
      this.lastBox = { x: b.x, z: b.z, t: ts };
      this.dir.carry = { k: this.carryK, world, box: { x: b.x, z: b.z } };
      this.carryShown = lp;
    }
  }

  up(e, cancelled) {
    if (e && e.pointerId !== this.id) return;
    const g = this.game;
    const p = e ? this.local(e) : this.downAt;
    const held = (performance.now() - this.downT) / 1000;
    if (p && this.downAt) this.disp = Math.max(this.disp, Math.hypot(p.x - this.downAt.x, p.y - this.downAt.y));
    // a tap: the finger stayed within the slop; a slow, careful tap still counts (nothing here needs
    // a long press). A quick swipe is no longer a flip: sliding the fish must never turn it.
    const tap = !cancelled && held < 0.8 && this.disp <= this.slop();
    switch (this.mode) {
      case 'cut': g.knifeUp(); break;
      case 'open': g.openUp(); break;
      case 'bone': g.boneUp(); break;
      case 'tapSkewer':
        if (tap) {
          const q = this.fishAt(p, 1.0, false);
          if (q) this.app.skewerTap(q.u, q.w);
        }
        break;
      case 'lift?':
        if (tap && g.onGrill) g.flip();
        break;
      case 'dip':
        // let go over the trough: it stays in and soaks; anywhere else it goes onto the coals as
        // close as it can to where it was let go (the HUD shows where before the hand opens).
        // A cancelled pointer puts it back where it was.
        g.releaseFish(!!cancelled);
        break;
      case 'grab':
        if (tap) g.flip();
        else if (this.dragging) {
          // let go near a band's centre (強 back / 中 / 弱 front): settle onto it
          const z = g.grill.fishZ;
          const c = [GRILL_MOVE.z0, 0, GRILL_MOVE.z1].reduce((a, b) => (Math.abs(b - z) < Math.abs(a - z) ? b : a));
          if (Math.abs(c - z) < 2.2) g.moveFish(0, c - z);
        }
        break;
      case 'tapUnskewer':
        if (tap) {
          // the nearest skewer on screen, if the tap is within its own width or 26 px of it
          const s = this.nearestSkewer(p);
          if (s != null) g.unskewerTap(s);
          else {
            const q = this.fishAt(p, 1.0, false);
            if (q) g.unskewerTap(q.u);
          }
        }
        break;
      case 'slice': g.sliceUp(); break;
      case 'carry': {
        const lp = p ? this.carryPoint(p) : null;
        const b = lp ? this.dir.toBox(lp.x, lp.y) : null;
        this.dir.carry = null;
        this.carryShown = null;
        if (b && !cancelled) g.dropPiece(b.x, b.z, this.vel.x, this.vel.z);
        else g.dropPiece(999, 999, 0, 0);
        break;
      }
      default:
    }
    this.release();
  }

  release() {
    if (this.id !== null) {
      try { this.canvas.releasePointerCapture(this.id); } catch (_) { /* not captured */ }
    }
    this.id = null;
    this.mode = null;
    this.trail = [];
    this.toolScreen = null;
    this.fingerScreen = null;
    this.dragging = false;
    this.carryShown = null;
    this.setCursor(null);
  }

  // the skewer whose screen line is nearest to p (fish-local u), or null if none is close enough
  nearestSkewer(p) {
    const F = this.game.fish;
    let best = null, bd = 1e9;
    for (const s of F.skewers) {
      const a = this.dir.projectFish(s, 1.2, -6.5, { x: 0, y: 0 }), b = this.dir.projectFish(s, 1.2, 6.5, { x: 0, y: 0 });
      const vx = b.x - a.x, vy = b.y - a.y, L2 = vx * vx + vy * vy || 1;
      const t = clamp(((p.x - a.x) * vx + (p.y - a.y) * vy) / L2, 0, 1);
      const d = Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
      if (d < bd) { bd = d; best = s; }
    }
    if (best == null) return null;
    const one = Math.abs(this.dir.projectFish(best + 2.2, 1.2, 0, { x: 0, y: 0 }).x - this.dir.projectFish(best, 1.2, 0, { x: 0, y: 0 }).x);
    return bd <= Math.max(one, 26) ? best : null;
  }

  // mouse cursor: only touched when it changes
  setCursor(c) {
    const v = c || '';
    if (this.cursor !== v) { this.cursor = v; this.canvas.style.cursor = v; }
  }

  // mouse, nothing pressed: show what can be picked up or worked on under the pointer
  hoverAt(p) {
    if (!this.app.canPlay()) { this.hover = null; this.setCursor(null); return; }
    const g = this.game, s = g.step;
    let h = null, c = null;
    const onFishQ = (yLocal, wMax) => { const q = this.fishAt(p, yLocal, false); return q && q.u > -2 && q.u < FISH.L + 2 && Math.abs(q.w) < wMax ? q : null; };
    if (s === 'tare') {
      const T = STATIONS.tare, tw = this.dir.toWorldPlane(p.x, p.y, T.surf);
      const onTrough = g.dip.phase === 'rest' && tw && Math.abs(tw.x - T.x) < T.len / 2 + 2 && Math.abs(tw.z - T.z) < T.w / 2 + 2;
      if (onFishQ(0.6, 15) || onTrough) { h = 'fish'; c = 'grab'; }
    } else if (g.onGrill) {
      if (onFishQ(0.6, 15)) { h = 'fish'; c = 'grab'; }
    } else if (s === 'plate') {
      const hit = this.dir.pieceScreenBoxes(g).find((b) => p.x > b.x0 - 12 && p.x < b.x1 + 12 && p.y > b.y0 - 12 && p.y < b.y1 + 12);
      if (hit) { h = { piece: hit.k }; c = 'grab'; }
    } else if (s === 'cut' || s === 'bone' || s === 'slice') {
      if (onFishQ(s === 'cut' ? FISH.R * 2 : 1.2, 9)) c = 'crosshair';
    } else if (s === 'skewer' || s === 'open') {
      if (onFishQ(1.0, 8)) c = 'pointer';
    } else if (s === 'unskewer') {
      if (this.nearestSkewer(p) != null) c = 'pointer';
    }
    this.hover = h;
    this.setCursor(c);
  }

  // drop everything held (pause, blur, hidden tab, rotation)
  cancelAll() {
    const g = this.game;
    this.cancelling = true; // the release comes from the system (pause, blur, rotation), not the player
    if (g) {
      g.knifeUp();
      g.openUp();
      g.boneUp();
      if (g.dip && g.dip.phase === 'carry') g.releaseFish(true);
      g.sliceUp();
      if (g.holding != null) g.dropPiece(999, 999, 0, 0);
    }
    if (this.dir) this.dir.carry = null;
    this.keys.clear();
    this.hover = null;
    this.release();
    this.cancelling = false;
  }

  keyDown(e) {
    const k = e.key;
    // typing a nickname / searching a country: no game shortcuts (m, p, Space…)
    const tg = e.target;
    if (tg && tg.closest && tg.closest('input, select, textarea, [contenteditable]') && tg.type !== 'range') return;
    if (e.isComposing) return;
    if (k === 'Escape' || k === 'p' || k === 'P') {
      e.preventDefault();
      this.app.togglePause();
      return;
    }
    if (k === 'm' || k === 'M') {
      this.app.toggleMute();
      return;
    }
    if (e.repeat) return;
    // Enter / Space on a focused button (keyboard users tabbing through a screen) is that button's own
    // click, not the screen's default action
    const t = e.target;
    if ((k === ' ' || k === 'Enter') && t && t.closest && t.closest('button, input, a, select, textarea')) return;
    if (!this.app.canPlay()) {
      if (k === ' ' || k === 'Enter') { e.preventDefault(); this.app.keyConfirm(); }
      return;
    }
    const g = this.game;
    // keyboard helpers: Space = the step's main button / flip on the grill, ←→ slide the fish
    if (k === ' ' || k === 'Enter') {
      e.preventDefault();
      if (g.onGrill) g.flip();
      else this.app.mainAction();
    } else if ((k === 'ArrowLeft' || k === 'a' || k === 'A') && g.onGrill) {
      e.preventDefault();
      g.moveFish(-3, 0);
    } else if ((k === 'ArrowRight' || k === 'd' || k === 'D') && g.onGrill) {
      e.preventDefault();
      g.moveFish(3, 0);
    } else if ((k === 'ArrowUp' || k === 'w' || k === 'W') && g.onGrill) {
      e.preventDefault();
      g.moveFish(0, -3);
    } else if ((k === 'ArrowDown' || k === 's' || k === 'S') && g.onGrill) {
      e.preventDefault();
      g.moveFish(0, 3);
    } else if ((k === 'n' || k === 'N') && g.onGrill) {
      this.app.mainAction();
    }
  }
}
