import * as THREE from 'three';
import { GRILL, FISH, heatAt } from '../config.js';
import { rng, smooth, clamp } from '../util.js';

const MAX = 260;
const MAXD = 90;
const MAXS = 160;

function softSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.4)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// four wisps of smoke in a 2x2 atlas (alpha only): warped fbm noise inside a soft round falloff, so
// each puff is a torn, curling wisp rather than a smooth ball. Painted once.
function wispAtlas() {
  const N = 256, C = 128;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d');
  const img = g.createImageData(N, N);
  const R = rng(91);
  const lat = new Float32Array(17 * 17);
  const vnoise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const at = (i, j) => lat[((j & 15) * 17) + (i & 15)];
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * sx;
    const b = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * sx;
    return a + (b - a) * sy;
  };
  const fbm = (x, y) => { let v = 0, amp = 0.5, f = 1; for (let o = 0; o < 4; o++) { v += amp * vnoise(x * f, y * f); f *= 2.03; amp *= 0.5; } return v / 0.9375; };
  for (let cell = 0; cell < 4; cell++) {
    for (let i = 0; i < lat.length; i++) lat[i] = R();
    const ox = (cell & 1) * C, oy = (cell >> 1) * C;
    for (let y = 0; y < C; y++) {
      for (let x = 0; x < C; x++) {
        const u = (x + 0.5) / C - 0.5, v = (y + 0.5) / C - 0.5;
        const nx = u * 4 + 8, ny = v * 4 + 8;
        const w = fbm(nx + 1.6 * fbm(nx + 3.1, ny), ny + 1.6 * fbm(nx, ny + 5.7));
        const r = Math.hypot(u, v) * 2;
        const fall = Math.max(0, 1 - r) ** 1.4;
        const a = Math.max(0, Math.min(1, (w - 0.32) * 2.2)) * fall;
        img.data[((oy + y) * N + ox + x) * 4 + 3] = Math.round(255 * a);
      }
    }
  }
  g.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}

// a drop of tare: a small teardrop, dark amber at the rim, lighter where the light passes through,
// one bright point of reflection
function dropSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.translate(32, 34);
  g.beginPath();
  g.moveTo(0, -26);
  g.bezierCurveTo(6, -14, 15, -2, 15, 9);
  g.arc(0, 9, 15, 0, Math.PI, false);
  g.bezierCurveTo(-15, -2, -6, -14, 0, -26);
  g.closePath();
  const grd = g.createRadialGradient(-3, 6, 2, 0, 6, 17);
  grd.addColorStop(0, 'rgba(214,130,48,1)');
  grd.addColorStop(0.55, 'rgba(140,62,16,1)');
  grd.addColorStop(1, 'rgba(58,20,4,1)');
  g.fillStyle = grd;
  g.fill();
  g.fillStyle = 'rgba(255,240,215,0.95)';
  g.beginPath();
  g.ellipse(-5, 2, 3.2, 4.2, -0.4, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Smoke and steam over the grill (thicker when fat drips onto the coals), tiny sparks, a flare of
// smoke when the fish is flipped or put back wet with tare, and drops of tare running off the lifted fish.
export class Fx {
  constructor(scene) {
    this.r = rng(17);
    this.p = [];
    for (let i = 0; i < MAX; i++) this.p.push({ on: false });
    this.pos = new Float32Array(MAX * 3);
    this.size = new Float32Array(MAX);
    this.alpha = new Float32Array(MAX);
    this.col = new Float32Array(MAX * 3);
    this.frame = new Float32Array(MAX);
    this.rot = new Float32Array(MAX);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aCol', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aFrame', new THREE.BufferAttribute(this.frame, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aRot', new THREE.BufferAttribute(this.rot, 1).setUsage(THREE.DynamicDrawUsage));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 400);
    this.uScale = { value: 400 };
    this.uMaxPx = { value: 200 };
    // smoke and steam use the wisp atlas (frame 0-3, turned by aRot); sparks (frame -1) the soft dot
    const mat = new THREE.ShaderMaterial({
      uniforms: { tSprite: { value: softSprite() }, tWisp: { value: wispAtlas() }, uScale: this.uScale, uMaxPx: this.uMaxPx },
      vertexShader: `attribute float aSize; attribute float aAlpha; attribute vec3 aCol; attribute float aFrame; attribute float aRot;
        varying float vA; varying vec3 vC; varying float vF; varying float vR; uniform float uScale; uniform float uMaxPx;
        void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mv; gl_PointSize = min(aSize * uScale / -mv.z, uMaxPx); vA = aAlpha; vC = aCol; vF = aFrame; vR = aRot; }`,
      fragmentShader: `uniform sampler2D tSprite; uniform sampler2D tWisp; varying float vA; varying vec3 vC; varying float vF; varying float vR;
        void main(){
          float a;
          if (vF < 0.0) a = texture2D(tSprite, gl_PointCoord).a;
          else {
            vec2 pc = gl_PointCoord - 0.5;
            float cs = cos(vR), sn = sin(vR);
            pc = mat2(cs, -sn, sn, cs) * pc;
            if (dot(pc, pc) > 0.25) discard;
            a = texture2D(tWisp, (pc + 0.5 + vec2(mod(vF, 2.0), floor(vF / 2.0))) * 0.5).a;
          }
          a *= vA;
          if (a < 0.003) discard;
          gl_FragColor = vec4(vC * a, a); // premultiplied
        }`,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    scene.add(this.points);
    this.acc = 0;
    this.sparkAcc = 0;
    // drops of tare: their own small pool and a crisp teardrop sprite (the soft smoke sprite makes
    // them look like glowing embers)
    this.d = [];
    for (let i = 0; i < MAXD; i++) this.d.push({ on: false });
    this.dPos = new Float32Array(MAXD * 3);
    this.dSize = new Float32Array(MAXD);
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(this.dPos, 3).setUsage(THREE.DynamicDrawUsage));
    dg.setAttribute('aSize', new THREE.BufferAttribute(this.dSize, 1).setUsage(THREE.DynamicDrawUsage));
    dg.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 400);
    const dm = new THREE.ShaderMaterial({
      uniforms: { tSprite: { value: dropSprite() }, uScale: this.uScale },
      vertexShader: `attribute float aSize; uniform float uScale;
        void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mv; gl_PointSize = aSize > 0.0 ? clamp(aSize * uScale / -mv.z, 5.0, 64.0) : 0.0; }`,
      fragmentShader: `uniform sampler2D tSprite;
        void main(){ vec4 c = texture2D(tSprite, gl_PointCoord); if (c.a < 0.05) discard; gl_FragColor = c; }`,
      transparent: true,
      depthWrite: false,
    });
    this.drops = new THREE.Points(dg, dm);
    this.drops.frustumCulled = false;
    this.drops.renderOrder = 7;
    scene.add(this.drops);
    // 山椒: tiny dark green-brown flakes shaken over the finished box; they fall and stay where they land
    this.s = [];
    this.sPos = new Float32Array(MAXS * 3);
    this.sCol = new Float32Array(MAXS * 3);
    this.sSize = new Float32Array(MAXS);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(this.sPos, 3).setUsage(THREE.DynamicDrawUsage));
    sg.setAttribute('aCol', new THREE.BufferAttribute(this.sCol, 3).setUsage(THREE.DynamicDrawUsage));
    sg.setAttribute('aSize', new THREE.BufferAttribute(this.sSize, 1).setUsage(THREE.DynamicDrawUsage));
    sg.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 400);
    const sm = new THREE.ShaderMaterial({
      uniforms: { uScale: this.uScale },
      vertexShader: `attribute float aSize; attribute vec3 aCol; varying vec3 vC; uniform float uScale;
        void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mv; gl_PointSize = aSize > 0.0 ? clamp(aSize * uScale / -mv.z, 1.5, 6.0) : 0.0; vC = aCol; }`,
      fragmentShader: `varying vec3 vC;
        void main(){ vec2 d = gl_PointCoord - 0.5; if (dot(d, d) > 0.25) discard; gl_FragColor = vec4(vC * (0.8 + 0.4 * (0.5 - d.y)), 1.0); }`,
    });
    this.flakes = new THREE.Points(sg, sm);
    this.flakes.frustumCulled = false;
    this.flakes.renderOrder = 5;
    scene.add(this.flakes);
  }

  // shake sansho over a w x d area centred on x, z; flakes land at the height floorAt(x, z) gives
  sansho(x, z, w, d, floorAt, n = 90) {
    const r = this.r;
    for (let k = 0; k < n; k++) {
      if (this.s.length >= MAXS) break;
      // denser along the middle of the box, a few stray ones
      const fx = x + (r() + r() - 1) * w * 0.5, fz = z + (r() + r() - 1) * d * 0.5;
      const tone = r();
      this.s.push({ x: fx + (r() - 0.5) * 3, y: floorAt(fx, fz) + 9 + r() * 4, z: fz + (r() - 0.5) * 2, vx: (r() - 0.5) * 2, vy: -2 - r() * 4, tx: fx, tz: fz, floor: floorAt(fx, fz) + 0.05, t: -k * 0.012,
        c: tone < 0.5 ? [0.2, 0.19, 0.09] : tone < 0.85 ? [0.27, 0.22, 0.11] : [0.36, 0.33, 0.17], s: 0.17 + r() * 0.12, on: true });
    }
  }

  // a falling drop of tare at x, y, z that stops at height floor
  drop(x, y, z, vy, floor) {
    const p = this.d.find((q) => !q.on);
    if (!p) return;
    Object.assign(p, { on: true, x, y, z, vy, floor, s: 1.5 + this.r() * 0.6 }); // drawn larger than life so they read from the play camera
  }

  resize(heightPx, fovDeg) {
    this.uScale.value = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
    this.uMaxPx.value = Math.max(48, heightPx * 0.25); // no screen-filling puffs (fill rate on phones)
  }

  spawn(x, y, z, o) {
    const p = this.p.find((q) => !q.on);
    if (!p) return;
    const r = this.r;
    Object.assign(p, {
      on: true, x, y, z,
      vx: (r() - 0.5) * (o.spread ?? 2), vy: o.vy ?? 4 + r() * 3, vz: (r() - 0.5) * (o.spread ?? 2) - 0.8,
      life: 0, max: o.life ?? 2 + r() * 1.6, s0: o.s0 ?? 2 + r(), s1: o.s1 ?? 9 + r() * 6, a: o.a ?? 0.1 + r() * 0.06,
      c: o.c || [0.9, 0.88, 0.86], spark: !!o.spark, warm: !!o.warm,
      fr: o.spark ? -1 : Math.floor(r() * 4), rot: r() * Math.PI * 2, spin: (r() - 0.5) * 0.8,
    });
  }

  flare(x, z) {
    for (let k = 0; k < 10; k++) this.spawn(x + (this.r() - 0.5) * 16, GRILL.rimY - 2, z + (this.r() - 0.5) * 6, { a: 0.22, vy: 7 + this.r() * 4, s1: 11, c: [0.82, 0.8, 0.79], warm: true });
  }

  steam(x, y, z, n = 4) {
    for (let k = 0; k < n; k++) this.spawn(x + (this.r() - 0.5) * 6, y, z + (this.r() - 0.5) * 3, { a: 0.12, vy: 3, s0: 1.5, s1: 6, life: 1.6, c: [1, 0.99, 0.97] });
  }

  update(dt, game, ctx) {
    const r = this.r;
    // tare running off the fish: dark amber drops from its underside while it is held up
    if (ctx.drip && ctx.drip.rate > 0) {
      const d = ctx.drip;
      this.dAcc = (this.dAcc || 0) + dt * d.rate;
      while (this.dAcc >= 1) {
        this.dAcc -= 1;
        const u = (0.04 + 0.92 * r()) * FISH.L;
        const x = d.x + u, z = d.z + (r() - 0.5) * 5;
        this.drop(x, d.y + d.slope * u - 0.15, z, -2 - r() * 3, d.floorAt(x, z));
      }
    } else this.dAcc = 0;
    if (ctx.grillOn) {
      // smoke from fat on the coals: heavier when the skin side is down over strong heat
      const G = game.grill;
      const heat = game.heatNow || 0.4;
      const fat = G.down === 1 ? 1 : 0.45;
      // fat and tare dripping onto the coals make the thick smoke
      this.acc += dt * (4 + 16 * heat * fat + 40 * Math.min(1, G.drip || 0)) * (G.flipping > 0 ? 0.3 : 1);
      while (this.acc >= 1) {
        this.acc -= 1;
        const u = r() * FISH.L;
        const x = G.fishX + u;
        const z = G.fishZ + (r() - 0.5) * 6;
        this.spawn(x, GRILL.rimY + 0.8, z, { a: 0.1 + 0.11 * clamp(heatAt(x, z), 0, 1), s1: (9 + r() * 6) * 0.75, c: [0.86, 0.84, 0.83], warm: true });
      }
      // a few sparks lifting off the hottest coals
      this.sparkAcc += dt * 3;
      while (this.sparkAcc >= 1) {
        this.sparkAcc -= 1;
        const x = GRILL.x0 + r() * (GRILL.x1 - GRILL.x0);
        const z = (r() - 0.5) * 18;
        if (r() < heatAt(x, z) * 0.6) this.spawn(x, GRILL.coalY + 3, z, { spark: true, a: 0.9, vy: 10 + r() * 8, s0: 0.35, s1: 0.2, life: 0.7 + r() * 0.5, c: [1.0, 0.55, 0.18], spread: 4 });
      }
    } else {
      this.acc = 0;
      // the coals keep smouldering softly even when the fish is elsewhere
      this.sparkAcc += dt * 0.8;
      while (this.sparkAcc >= 1) {
        this.sparkAcc -= 1;
        this.spawn(GRILL.x0 + r() * (GRILL.x1 - GRILL.x0), GRILL.rimY, (r() - 0.5) * 12, { a: 0.07, vy: 3.5, c: [0.85, 0.84, 0.83], warm: true });
      }
    }
    if (ctx.plateSteam && ctx.plateAt) {
      this.pAcc = (this.pAcc || 0) + dt * ctx.plateSteam;
      while (this.pAcc >= 1) {
        this.pAcc -= 1;
        const o = ctx.plateAt;
        this.spawn(o.x + (r() - 0.5) * 16, o.y, o.z + (r() - 0.5) * 12, { a: 0.1, vy: 2.6, s0: 2, s1: 8, c: [1, 0.99, 0.97] });
      }
    }
    let k = 0;
    for (const p of this.p) {
      if (p.on) {
        p.life += dt;
        if (p.life >= p.max) p.on = false;
      }
      if (!p.on) {
        this.alpha[k] = 0;
        this.size[k] = 0;
        k++;
        continue;
      }
      const t = p.life / p.max;
      const sway = Math.sin(p.life * 1.7 + p.x * 0.3) * (p.spark ? 2 : 1.2);
      p.x += (p.vx + sway) * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.vy *= 1 - (p.spark ? 1.2 : 0.18) * dt;
      this.pos[k * 3] = p.x;
      this.pos[k * 3 + 1] = p.y;
      this.pos[k * 3 + 2] = p.z;
      this.size[k] = p.s0 + (p.s1 - p.s0) * Math.sqrt(t);
      this.alpha[k] = p.a * (p.spark ? 1 - t : smooth(0, 0.15, t) * (1 - smooth(0.5, 1, t)));
      // smoke right over the coals is lit orange from below, then turns grey as it rises
      const wm = p.warm ? 1 - smooth(0, 0.35, t) : 0;
      this.col[k * 3] = p.c[0] + (0.6 - p.c[0]) * wm;
      this.col[k * 3 + 1] = p.c[1] + (0.33 - p.c[1]) * wm;
      this.col[k * 3 + 2] = p.c[2] + (0.15 - p.c[2]) * wm;
      this.frame[k] = p.fr;
      this.rot[k] = p.rot + p.spin * p.life;
      k++;
    }
    // drops fall with gravity; landing back in the trough (or on the coals) is reported
    k = 0;
    for (const p of this.d) {
      if (p.on) {
        p.vy -= 160 * dt;
        p.y += p.vy * dt;
        if (p.y <= p.floor) {
          p.on = false;
          if (this.onDrop) this.onDrop(p.x, p.floor, p.z);
        }
      }
      this.dPos[k * 3] = p.on ? p.x : 0;
      this.dPos[k * 3 + 1] = p.on ? p.y : -99;
      this.dPos[k * 3 + 2] = p.on ? p.z : 0;
      this.dSize[k] = p.on ? p.s : 0;
      k++;
    }
    // sansho flakes: a short fall with a little drift, then they stay on the eel and the rice
    for (let i = 0; i < MAXS; i++) {
      const f = this.s[i];
      if (!f) { this.sSize[i] = 0; continue; }
      f.t += dt;
      if (f.t > 0 && f.on) {
        f.vy -= 120 * dt;
        f.y += f.vy * dt;
        f.x += (f.tx - f.x) * Math.min(1, dt * 3);
        f.z += (f.tz - f.z) * Math.min(1, dt * 3);
        if (f.y <= f.floor) { f.y = f.floor; f.on = false; }
      }
      this.sPos[i * 3] = f.x;
      this.sPos[i * 3 + 1] = f.t > 0 ? f.y : -99;
      this.sPos[i * 3 + 2] = f.z;
      this.sCol.set(f.c, i * 3);
      this.sSize[i] = f.s;
    }
    if (this.s.length || this.sWas) {
      const sa = this.flakes.geometry.attributes;
      sa.position.needsUpdate = sa.aCol.needsUpdate = sa.aSize.needsUpdate = true;
    }
    this.sWas = this.s.length > 0;
    this.drops.geometry.attributes.position.needsUpdate = true;
    this.drops.geometry.attributes.aSize.needsUpdate = true;
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
    g.attributes.aCol.needsUpdate = true;
    g.attributes.aFrame.needsUpdate = true;
    g.attributes.aRot.needsUpdate = true;
  }

  clear() {
    this.s.length = 0;
    for (const p of this.p) p.on = false;
    for (const p of this.d) p.on = false;
  }
}
