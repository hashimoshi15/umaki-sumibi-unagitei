import * as THREE from 'three';
import { FISH, GRILL, GRILL_MOVE, STATIONS, BOARD_FISH_X, BOX, thickness } from '../config.js';
import { clamp, smooth, damp, lerp } from '../util.js';

const V3 = THREE.Vector3;
const WAIT_DZ = 23; // pieces waiting to be plated sit this far in front of the box centre (they are 20 cm long)
const tmp = new V3();
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// Camera framing per station, where the one fish is at each step (board → grill → board → box),
// the flip arc over the coals, and the tools that follow the hands.
export class Director {
  constructor(stage, fishView, props) {
    this.stage = stage;
    this.camera = stage.camera;
    this.fv = fishView;
    this.props = props;
    this.W = 1280;
    this.H = 720;
    this.free = {};
    this.cur = { pos: new V3(0, 80, 80), target: new V3(0, 0, 0), offX: 0, offY: 0 };
    this.from = null;
    this.to = null;
    this.t = 1;
    this.dur = 1;
    this.view = 'title';
    this.time = 0;
    this.raycaster = new THREE.Raycaster();
    this.flipRot = 0;
    this.flipTarget = 0;
    this.carry = null;
    this.placed = new Map();
    this.knifeRot = new THREE.Euler();
    this.flipFrom = 0;
    this.flipT = 1;
    this.lastFlipTarget = 0;
    this.serveFrom = null;
    // flip about the fillet's own length first, then tip it (one end resting on the trough wall)
    fishView.group.rotation.order = 'ZYX';
  }

  resize(W, H, free) {
    this.W = W;
    this.H = H;
    this.free = free;
    this.camera.aspect = W / H;
    this.to = this.computeView(this.view);
    if (this.t >= 1) this.cur = this.cloneView(this.to);
    this.apply();
  }

  cloneView(v) {
    return { pos: v.pos.clone(), target: v.target.clone(), offX: v.offX, offY: v.offY };
  }

  boxFor(name) {
    const B = STATIONS.board, G = STATIONS.grill, X = STATIONS.box;
    if (name === 'board') return { min: new V3(BOARD_FISH_X - 7, B.h, B.z - 7), max: new V3(BOARD_FISH_X + FISH.L + 1, B.h + 4, B.z + 7), el: 48, az: 0, free: 'play' };
    // the fish (60 cm) can slide a little along the konro and across its three heat bands
    if (name === 'grill') return { min: new V3(GRILL_MOVE.x0 - 1, 4, -13), max: new V3(GRILL_MOVE.x1 + FISH.L + 1, G.h + 4, 13), el: 46, az: 0, free: 'play' };
    // つけダレ: the konro and the deep trough in front of it, so the fish can be carried between them
    if (name === 'tare') {
      const T = STATIONS.tare;
      // a little tighter at the front (the near wall may be cut): the fish reads bigger on phones
      return { min: new V3(T.x - T.len / 2 - 1, 0, -13), max: new V3(T.x + T.len / 2 + 1, G.h + 5, T.z + T.w / 2 - 3), el: 58, az: 0, free: 'play' };
    }
    // plating: the cut pieces wait in a row in front of the box, so the view is just box + pieces
    if (name === 'plate') return { min: new V3(X.x - 15, 0, X.z - 12), max: new V3(X.x + 19, X.h + 2, X.z + WAIT_DZ + 11), el: 56, az: 0, free: 'play' };
    // result: the box fills the frame from a little to the side, so the cut faces show and the big
    // pieces are seen hanging over the front and back rims
    if (name === 'result') return { min: new V3(X.x - 11, X.rice - 1.5, X.z - 11.5), max: new V3(X.x + 11, X.h + 1, X.z + 11.5), el: 38, az: -28, free: 'result' };
    if (name === 'box') return { min: new V3(X.x - 13, 0, X.z - 12.5), max: new V3(X.x + 13, X.h + 3, X.z + 12.5), el: 52, az: 0, free: 'play' };
    // title: the whole little workstation, slowly breathing
    return { min: new V3(-100, 0, -20), max: new V3(75, 16, 30), el: 34 + Math.sin(this.time * 0.12) * 1.5, az: -6 + Math.sin(this.time * 0.09) * 4, free: 'title' };
  }

  computeView(name) {
    const b = this.boxFor(name);
    const free = this.free[b.free] || { x: 0, y: 0, w: this.W, h: this.H };
    const target = new V3().addVectors(b.min, b.max).multiplyScalar(0.5);
    const el = (b.el * Math.PI) / 180, az = (b.az * Math.PI) / 180;
    const dir = new V3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    const cam = this.camera;
    cam.clearViewOffset();
    cam.aspect = this.W / this.H;
    cam.updateProjectionMatrix();
    const corners = [];
    for (let i = 0; i < 8; i++) corners.push(new V3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z));
    let d = 120, offX = 0, offY = 0;
    for (let it = 0; it < 7; it++) {
      cam.position.copy(target).addScaledVector(dir, d);
      cam.lookAt(target);
      cam.updateMatrixWorld();
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (const c of corners) {
        tmp.copy(c).project(cam);
        const px = (tmp.x * this.W) / 2, py = (-tmp.y * this.H) / 2;
        x0 = Math.min(x0, px);
        x1 = Math.max(x1, px);
        y0 = Math.min(y0, py);
        y1 = Math.max(y1, py);
      }
      d *= clamp(Math.max((x1 - x0) / free.w, (y1 - y0) / free.h), 0.5, 2);
      offX = (x0 + x1) / 2 - (free.x + free.w / 2 - this.W / 2);
      offY = (y0 + y1) / 2 - (free.y + free.h / 2 - this.H / 2);
    }
    return { pos: cam.position.clone(), target, offX, offY };
  }

  setView(name, dur = 1) {
    if (name === this.view && this.t >= 1 && dur > 0) return;
    this.view = name;
    this.from = this.cloneView(this.cur);
    this.to = this.computeView(name);
    this.t = dur > 0 ? 0 : 1;
    this.dur = Math.max(0.001, dur);
    if (dur <= 0) this.cur = this.cloneView(this.to);
  }

  apply() {
    const cam = this.camera, v = this.cur;
    cam.position.copy(v.pos);
    cam.lookAt(v.target);
    cam.setViewOffset(this.W, this.H, v.offX, v.offY, this.W, this.H);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  updateCamera(dt) {
    if (this.view === 'title') this.to = this.computeView('title');
    if (this.t < 1) {
      this.t = Math.min(1, this.t + dt / this.dur);
      const k = ease(this.t);
      this.cur.pos.lerpVectors(this.from.pos, this.to.pos, k);
      this.cur.target.lerpVectors(this.from.target, this.to.target, k);
      this.cur.offX = lerp(this.from.offX, this.to.offX, k);
      this.cur.offY = lerp(this.from.offY, this.to.offY, k);
    } else if (this.to) this.cur = this.cloneView(this.to);
    this.apply();
  }

  // world point → screen px
  project(v, out = { x: 0, y: 0 }) {
    tmp.copy(v).project(this.camera);
    out.x = ((tmp.x + 1) / 2) * this.W;
    out.y = ((1 - tmp.y) / 2) * this.H;
    out.behind = tmp.z > 1;
    return out;
  }

  // fish-local (u, y, w) → screen px
  projectFish(u, y, w, out) {
    tmp.set(u, y, w);
    this.fv.group.updateMatrixWorld();
    this.fv.group.localToWorld(tmp);
    return this.project(tmp, out);
  }

  // screen px → point on a horizontal world plane y = h
  toWorldPlane(px, py, h) {
    const ndc = new THREE.Vector2((px / this.W) * 2 - 1, -(py / this.H) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const r = this.raycaster.ray;
    if (Math.abs(r.direction.y) < 1e-6) return null;
    const t = (h - r.origin.y) / r.direction.y;
    if (t < 0) return null;
    return new V3(r.origin.x + r.direction.x * t, h, r.origin.z + r.direction.z * t);
  }

  // screen px → fish-local (u, w) on the fish's own surface plane (local y = yLocal)
  toFish(px, py, yLocal = 1) {
    const g = this.fv.group;
    g.updateMatrixWorld();
    const ndc = new THREE.Vector2((px / this.W) * 2 - 1, -(py / this.H) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const inv = g.matrixWorld.clone().invert();
    const ray = this.raycaster.ray.clone().applyMatrix4(inv);
    if (Math.abs(ray.direction.y) < 1e-6) return null;
    const t = (yLocal - ray.origin.y) / ray.direction.y;
    if (t < 0) return null;
    return { u: ray.origin.x + ray.direction.x * t, w: ray.origin.z + ray.direction.z * t };
  }

  // screen px → box-local (x, z) on the rice surface
  toBox(px, py) {
    const X = STATIONS.box;
    const p = this.toWorldPlane(px, py, X.rice + 1);
    if (!p) return null;
    return { x: p.x - X.x, z: p.z - X.z, world: p };
  }

  // ---------------- where the fish is ----------------
  placeFish(game, dt) {
    const g = this.fv.group;
    const s = game.step, G = game.grill;
    const B = STATIONS.board;
    const th = thickness(20);
    const boardPos = new V3(BOARD_FISH_X, B.h, B.z);
    const grillPos = new V3(G.fishX, GRILL.rimY - th * 0.5, G.fishZ);
    // flip: half a turn about the long axis with a little hop
    this.flipTarget = G.down === 0 ? Math.PI : 0;
    if (this.flipTarget !== this.lastFlipTarget) {
      this.flipFrom = this.flipRot;
      this.flipT = 0;
      this.lastFlipTarget = this.flipTarget;
    }
    // a turn with some weight: a little dip as the skewers are gripped, the lift and half turn, a
    // small overshoot that settles back onto the rims
    this.flipT = Math.min(1, this.flipT + dt / 0.5);
    const fp = this.flipT, fq = smooth(0, 1, fp) - 1;
    const fe = fp >= 1 ? 1 : 1 + 2.2 * fq * fq * fq + 1.2 * fq * fq;
    this.flipRot = this.flipFrom + (this.flipTarget - this.flipFrom) * fe;
    const hop = fp >= 1 ? 0 : Math.sin(Math.PI * fp) * 4.5 - (fp < 0.16 ? Math.sin((fp / 0.16) * Math.PI) * 0.5 : 0);
    const rimLift = -Math.cos(this.flipRot) * th * 0.5 + th * 0.5;
    if (s !== 'toBoard') this.serveFrom = null;
    if (s === 'toGrill' || s === 'toBoard') {
      const k = ease(clamp(game.stepT / 1.6, 0, 1));
      // served from the hand or the trough: it leaves from where it is
      if (s === 'toBoard' && !this.serveFrom) this.serveFrom = g.position.clone();
      const a = s === 'toGrill' ? boardPos : this.serveFrom;
      const b = s === 'toGrill' ? grillPos : boardPos;
      g.position.lerpVectors(a, b, k);
      g.position.y += Math.sin(Math.PI * k) * 14;
      g.rotation.z = s === 'toBoard' ? lerp(g.rotation.z, 0, damp(10, dt)) : 0;
      if (s === 'toBoard') {
        // comes back flesh side up
        g.rotation.x = lerp(this.flipRot, 0, k);
        if (k >= 1) this.flipRot = 0;
      } else g.rotation.x = 0;
    } else if (s === 'tare') {
      // つけダレ: lifted off the coals it follows the hand with a little weight, sinks as deep as the
      // model says (and tips when one end rests on the trough wall), and settles back onto the rims
      const D = game.dip;
      const want = new V3(), cosR = Math.cos(this.flipRot);
      let tilt = 0;
      if (D.phase === 'grill') want.set(grillPos.x, grillPos.y + rimLift + hop, grillPos.z);
      else {
        const pose = game.dipPose();
        want.set(D.x, pose.yH - cosR * th * 0.5, D.z);
        tilt = Math.atan2(pose.yT - pose.yH, FISH.L);
      }
      const prev = this.tarePrev || g.position.clone();
      const rate = D.phase === 'grill' ? (this.tareBlend > 0 ? 9 : 40) : 13;
      const k = damp(rate, dt), T = STATIONS.tare, P = g.position;
      // never through the trough's walls: down in the tare it only slides along the trough (rise
      // first, then travel), and it goes down only once the skewers are lined up inside
      const wallTop = T.h + 0.4 + th * 0.5 - cosR * th * 0.5;
      const overX = P.x + FISH.L > T.x - T.len / 2 && P.x < T.x + T.len / 2;
      const inTrough = overX && Math.abs(P.z - T.z) < T.inner.z && P.y < wallTop;
      let nz = lerp(P.z, want.z, k);
      if (inTrough) nz = clamp(nz, T.z - 0.4, T.z + 0.4);
      let ny = lerp(P.y, want.y, k);
      if (overX && Math.abs(nz - T.z) > 0.4 && Math.abs(nz - T.z) < T.w / 2 + 12) ny = Math.max(ny, Math.min(P.y, wallTop));
      P.set(lerp(P.x, want.x, k), ny, nz);
      this.tareBlend = D.phase === 'grill' ? Math.max(0, (this.tareBlend || 0) - dt) : 0.45;
      // a swing with the hand's motion while carried
      const vz = (g.position.z - prev.z) / Math.max(dt, 1e-3);
      this.tarePrev = g.position.clone();
      this.swing = lerp(this.swing || 0, D.phase === 'carry' && D.depth < 0.1 ? clamp(-vz * 0.004, -0.12, 0.12) : 0, damp(8, dt));
      g.rotation.x = this.flipRot + this.swing;
      g.rotation.z = lerp(g.rotation.z, tilt, damp(D.phase === 'grill' ? 12 : 9, dt));
    } else if (game.onGrill) {
      g.position.set(grillPos.x, grillPos.y + rimLift + hop, grillPos.z);
      g.rotation.x = this.flipRot;
      g.rotation.z = 0;
    } else {
      g.position.copy(boardPos);
      g.rotation.x = 0;
      g.rotation.z = 0;
      this.flipRot = 0;
    }
  }

  // pieces: on the board, in the hand, or resting on the rice
  placePieces(game, dt) {
    const F = game.fish, X = STATIONS.box;
    for (const h of this.fv.pieceGroups) {
      const p = F.pieces[h.userData.k];
      if (!p) continue;
      if (!p.placed) this.setDrape(h, 0, 0);
      if (this.carry && this.carry.k === p.k) {
        // follows the hand, lifted above everything
        const c = this.carry;
        h.userData.flyFrom = null; // if it is let go off the rice it arcs back to its spot
        // held with chopsticks: it lags the hand a touch and tips toward the way it is moving
        const prev = h.userData.prevPos || h.position.clone();
        h.position.lerp(c.world, damp(16, dt));
        const vx = (h.position.x - prev.x) / Math.max(dt, 1e-3), vz = (h.position.z - prev.z) / Math.max(dt, 1e-3);
        h.userData.prevPos = h.position.clone();
        h.rotation.set(clamp(vz * 0.004, -0.18, 0.18), lerp(h.rotation.y, -Math.PI / 2, damp(10, dt)), clamp(-vx * 0.004, -0.18, 0.18), 'YXZ');
        continue;
      }
      if (p.placed) {
        // shingled like a real unajū: each piece rests a little on the one to its left
        const slotK = p.slot ?? 1;
        const want = new V3(X.x + p.x, X.rice + 0.04 + slotK * 0.28, X.z + p.z); // pressed a little into the rice, overlapping lightly
        const land = this.placed.get(p.k) || 0;
        this.placed.set(p.k, Math.min(1, land + dt * 3.2));
        const k = smooth(0, 1, this.placed.get(p.k));
        h.position.lerp(want, damp(18, dt));
        // a little sink and bounce into the rice
        h.position.y = want.y + Math.sin(k * Math.PI) * 0.6 - (1 - k) * 0.3;
        h.rotation.set(slotK > 0 ? -0.05 : -0.015, -Math.PI / 2 + p.rot, 0, 'YXZ');
        // the ends that reach the rims rest on them and hang over the outside a little
        this.setDrape(h, k, h.position.y);
        continue;
      }
      // waiting on the board, spread apart a little so the cut faces show
      const mid = h.userData.mid;
      const spread = (h.userData.k - (h.userData.n - 1) / 2) * 2.2;
      if (h.parent === this.fv.group) {
        // still part of the fish on the board (between the two cuts): fish-local frame
        h.position.lerp(new V3(mid + spread, 0, 0), damp(10, dt));
        continue;
      }
      // carried over from the board in a short arc to its spot in front of the box
      // a little to the right of the box's centre line, clear of the sansho shaker by the trough
      const want = new V3(X.x + 4 + (h.userData.k - 1) * 9, 0.15, X.z + WAIT_DZ);
      const U = h.userData;
      if (!U.flyFrom) {
        U.flyFrom = h.position.clone();
        U.fly = 0;
      }
      U.fly = Math.min(1, U.fly + dt / (0.75 + 0.12 * U.k));
      const e = smooth(0, 1, U.fly);
      h.position.lerpVectors(U.flyFrom, want, e);
      h.position.y += Math.sin(Math.PI * e) * 22;
      h.rotation.y = lerp(0, -Math.PI / 2, e);
    }
  }

  setDrape(h, k, y) {
    const du = h.userData.drape;
    if (!du) return;
    du.uDrape.value = k;
    du.uRim.value.z = y;
  }

  pieceScreenBoxes(game) {
    const out = [];
    for (const h of this.fv.pieceGroups) {
      const p = game.fish.pieces[h.userData.k];
      if (!p || p.placed) continue;
      h.updateMatrixWorld();
      const half = h.userData.len / 2;
      const pts = [];
      for (const dx of [-half, half]) for (const dz of [-4.5, 4.5]) pts.push(this.project(h.localToWorld(new V3(dx, 0.6, dz))));
      const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
      out.push({ k: p.k, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) });
    }
    return out;
  }

  // ---------------- tools ----------------
  updateTools(game, input, dt, mode) {
    const P = this.props;
    if (!P) return;
    const s = mode === 'play' ? game.step : 'none';
    const kn = P.knife;
    // knife: along the cut front while cutting, across the fillet while slicing
    if (kn) {
      if (s === 'cut' || s === 'slice') {
        const tool = input.toolFish;
        this.fv.group.updateMatrixWorld();
        if (s === 'cut') {
          // the blade's tip sits on the cut point and leads toward the tail, the handle trailing
          // up behind it; before the press it waits just beside the fish so the head stays visible
          const pressing = game.knife.active;
          const u = tool ? tool.u : game.fish.cutFront + 0.6;
          const w = pressing && tool ? tool.w * 0.55 : -4.2;
          const y = FISH.R * 2 + (pressing ? 0.08 : 2.4);
          const roll = pressing ? 0.3 : 0.48;
          this.knifeRot.set(0, Math.PI, roll);
          const tip = new V3(-13.5, 0, 0).applyEuler(this.knifeRot);
          const wp = this.fv.group.localToWorld(new V3(u, y, w)).sub(tip);
          kn.position.lerp(wp, damp(pressing ? 30 : 12, dt));
          kn.rotation.set(0, lerp(kn.rotation.y, Math.PI, damp(10, dt)), lerp(kn.rotation.z, roll, damp(10, dt)));
        } else {
          const u = tool ? tool.u : game.fish.L / 3;
          const w = tool ? tool.w : -6;
          const wp = this.fv.group.localToWorld(new V3(u, game.slicer.active ? 1.25 : 2.2, w));
          kn.position.lerp(wp, damp(26, dt));
          kn.rotation.set(0, lerp(kn.rotation.y, Math.PI / 2, damp(10, dt)), 0);
        }
        kn.visible = true;
      } else if (kn.userData.rest) {
        kn.position.lerp(kn.userData.rest.pos, damp(6, dt));
        kn.rotation.set(kn.userData.rest.rot.x, kn.userData.rest.rot.y, kn.userData.rest.rot.z);
      }
    }
  }

  update(dt, game, input, mode) {
    this.time += dt;
    if (mode === 'play' || mode === 'result') {
      this.placeFish(game, dt);
      this.placePieces(game, dt);
    }
    this.updateTools(game, input, dt, mode);
    this.updateCamera(dt);
  }

  reset() {
    this.flipRot = 0;
    this.flipFrom = 0;
    this.flipT = 1;
    this.lastFlipTarget = 0;
    this.carry = null;
    this.placed.clear();
    this.serveFrom = null;
    this.tarePrev = null;
    this.tareBlend = 0;
    this.swing = 0;
    this.fv.group.rotation.z = 0;
  }
}

export { BOX };

