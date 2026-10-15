import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GRILL, STATIONS, BOX, heatAt } from '../config.js';
import { clamp, smooth, rng, hash2 } from '../util.js';
import * as T from './textures.js';

// The still life around the one eel: keyaki counter, plaster wall with a lattice window, hinoki
// board, the charred konro with binchotan whose glow follows the heat map, the lacquered jubako
// with its rice, the tare trough, the yanagiba, sansho and the side dishes.
// Everything is in centimetres with the counter top at y = 0 (see config.js).

const C = (hex) => new THREE.Color(hex);
const KONRO_END = 2.5; // end-wall thickness of the konro; the U-handles fill the rest of its 82 cm

// ---------------------------------------------------------------- texture plumbing
// textures.js is written in parallel: call by name, tolerate missing functions or other shapes.
function callTex(lib, name, ...args) {
  const f = lib && lib[name];
  if (typeof f !== 'function') return null;
  try {
    return f(...args) || null;
  } catch (e) {
    console.warn('[props] ' + name + '() failed', e);
    return null;
  }
}

function pick(v, ...keys) {
  if (!v) return null;
  if (v.isTexture) return v;
  for (const k of keys) if (v[k] && v[k].isTexture) return v[k];
  return null;
}

// a named extra map on a texture bundle (textures.js returns textures that carry .rough/.normal)
function sub(v, ...keys) {
  if (!v) return null;
  for (const k of keys) if (v[k] && v[k].isTexture) return v[k];
  return null;
}

function tiling(t) {
  if (t && (t.wrapS !== THREE.RepeatWrapping || t.wrapT !== THREE.RepeatWrapping)) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.needsUpdate = true;
  }
  return t;
}

function canvasTex(w, h, paint, srgb = true) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  paint(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------- geometry helpers
// planar UVs in cm from the dominant normal axis (tops: x/z, fronts: x/y, ends: z/y)
function planarUV(geo, sx, sy, sz, ox = 0, oy = 0, oz = 0) {
  const p = geo.attributes.position, n = geo.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) + ox, y = p.getY(i) + oy, z = p.getZ(i) + oz;
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    if (ay >= ax && ay >= az) {
      uv[i * 2] = x / sx;
      uv[i * 2 + 1] = z / sz;
    } else if (az >= ax) {
      uv[i * 2] = x / sx;
      uv[i * 2 + 1] = y / sy;
    } else {
      uv[i * 2] = z / sz;
      uv[i * 2 + 1] = y / sy;
    }
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

// per-vertex multiply colours: fn(x, y, z, nx, ny, nz, out, index) writes out[0..2]
function paintColors(geo, fn) {
  const p = geo.attributes.position, n = geo.attributes.normal;
  const c = new Float32Array(p.count * 3);
  const o = [1, 1, 1];
  for (let i = 0; i < p.count; i++) {
    o[0] = o[1] = o[2] = 1;
    fn(p.getX(i), p.getY(i), p.getZ(i), n.getX(i), n.getY(i), n.getZ(i), o, i);
    c[i * 3] = o[0];
    c[i * 3 + 1] = o[1];
    c[i * 3 + 2] = o[2];
  }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo;
}

function rbox(w, h, d, r, x, y, z, seg = 2) {
  const g = new RoundedBoxGeometry(w, h, d, seg, r);
  g.translate(x, y, z);
  return g;
}

function lathe(points, segs) {
  return new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), segs);
}

// rounded rectangle centred on the origin (a Shape, or a Path for holes)
function rrShape(w, h, r, hole = false) {
  const s = hole ? new THREE.Path() : new THREE.Shape();
  const x0 = -w / 2, x1 = w / 2, y0 = -h / 2, y1 = h / 2;
  s.moveTo(x0 + r, y0);
  s.lineTo(x1 - r, y0);
  s.absarc(x1 - r, y0 + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x1, y1 - r);
  s.absarc(x1 - r, y1 - r, r, 0, Math.PI / 2, false);
  s.lineTo(x0 + r, y1);
  s.absarc(x0 + r, y1 - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(x0, y0 + r);
  s.absarc(x0 + r, y0 + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

// regroup a non-indexed geometry's triangles by classify(cx, cy, cz, nx, ny, nz) → material index
function splitTris(geo, classify, groups) {
  const src = geo.index ? geo.toNonIndexed() : geo;
  const P = src.attributes.position.array, N = src.attributes.normal.array;
  const bucket = Array.from({ length: groups }, () => []);
  for (let t = 0; t < P.length; t += 9) {
    const cx = (P[t] + P[t + 3] + P[t + 6]) / 3, cy = (P[t + 1] + P[t + 4] + P[t + 7]) / 3, cz = (P[t + 2] + P[t + 5] + P[t + 8]) / 3;
    const nx = N[t] + N[t + 3] + N[t + 6], ny = N[t + 1] + N[t + 4] + N[t + 7], nz = N[t + 2] + N[t + 5] + N[t + 8];
    const l = Math.hypot(nx, ny, nz) || 1;
    bucket[clamp(classify(cx, cy, cz, nx / l, ny / l, nz / l) | 0, 0, groups - 1)].push(t);
  }
  const count = P.length;
  const pos = new Float32Array(count), nor = new Float32Array(count);
  const out = new THREE.BufferGeometry();
  let w = 0;
  bucket.forEach((list, g) => {
    const start = w / 3;
    for (const t of list) {
      for (let k = 0; k < 9; k++) {
        pos[w + k] = P[t + k];
        nor[w + k] = N[t + k];
      }
      w += 9;
    }
    if (list.length) out.addGroup(start, w / 3 - start, g);
  });
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}

function shade(obj, cast = true, receive = true) {
  obj.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = cast;
      o.receiveShadow = receive;
    }
  });
  return obj;
}

// ---------------------------------------------------------------- shared GLSL
const GLSL_NOISE = /* glsl */ `
float pHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float pNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(pHash(i), pHash(i + vec3(1.0, 0.0, 0.0)), f.x),
                 mix(pHash(i + vec3(0.0, 1.0, 0.0)), pHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(pHash(i + vec3(0.0, 0.0, 1.0)), pHash(i + vec3(1.0, 0.0, 1.0)), f.x),
                 mix(pHash(i + vec3(0.0, 1.0, 1.0)), pHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
// measured ember ramp (design-spec grill: dead → deep red → orange → yellow-white cores)
vec3 emberRamp(float t) {
  t = clamp(t, 0.0, 1.0);
  if (t < 0.05) return mix(uRamp[0], uRamp[1], t / 0.05);
  if (t < 0.2) return mix(uRamp[1], uRamp[2], (t - 0.05) / 0.15);
  if (t < 0.4) return mix(uRamp[2], uRamp[3], (t - 0.2) / 0.2);
  if (t < 0.6) return mix(uRamp[3], uRamp[4], (t - 0.4) / 0.2);
  if (t < 0.8) return mix(uRamp[4], uRamp[5], (t - 0.6) / 0.2);
  return mix(uRamp[5], uRamp[6], (t - 0.8) / 0.2);
}
`;

function rampUniform() {
  const hexes = ['#1a130f', '#3a0d04', '#501d0e', '#892f19', '#cb420f', '#f47909', '#f4af43'];
  const a = new Float32Array(hexes.length * 3);
  hexes.forEach((h, i) => C(h).toArray(a, i * 3));
  return { value: a };
}

// ================================================================ room: counter, ledge, wall, window
function buildRoom(tex) {
  const group = new THREE.Group();
  group.name = 'room';
  const wood = tiling(pick(tex.counter, 'map', 'color'));

  // counter top, keyaki planks running along x (texture tile 128 x 64 cm)
  const cGeo = new THREE.BoxGeometry(250, 4, 105);
  cGeo.translate(-5, -2, -7.5);
  planarUV(cGeo, 80, 40, 40);
  const cRough = sub(tex.counter, 'rough');
  const counter = new THREE.Mesh(cGeo, new THREE.MeshStandardMaterial({
    map: wood, color: wood ? C('#a88f7c') : C('#9f6839'), roughnessMap: cRough, roughness: cRough ? 1 : 0.46, metalness: 0,
  }));
  counter.name = 'counter';
  counter.receiveShadow = true;
  group.add(counter);
  const apronGeo = new THREE.BoxGeometry(250, 90, 3);
  apronGeo.translate(-5, -49, 43.5);
  planarUV(apronGeo, 128, 64, 64);
  const apron = new THREE.Mesh(apronGeo, new THREE.MeshStandardMaterial({ map: wood, color: wood ? C('#8c6a52') : C('#5e3a1e'), roughness: 0.6 }));
  apron.name = 'counter-front';
  apron.receiveShadow = true;
  group.add(apron);

  // a low ledge at the back of the counter (12 cm, like 12)
  const ledgeGeo = rbox(262, 12, 12, 0.5, -5, 6, -54);
  planarUV(ledgeGeo, 128, 64, 64, 31, 0, 0);
  const ledge = new THREE.Mesh(ledgeGeo, new THREE.MeshStandardMaterial({
    map: wood, color: wood ? C('#a88468') : C('#7a4a26'), roughness: 0.55,
  }));
  ledge.name = 'ledge';
  shade(ledge);
  group.add(ledge);

  // plaster wall with a window opening
  const wt = callTex(tex.lib, 'wallTextures', tex.q);
  const plaster = pick(wt, 'plaster', 'wall', 'map');
  const winTex = wt && !wt.isTexture ? pick(wt, 'window', 'lattice', 'shoji', 'daylight', 'glow') : null;
  const WZ = -60, OX0 = -85, OX1 = 85, OY0 = 24, OY1 = 108, TOP = 170;
  const panels = [[-180, OX0, 12, TOP], [OX1, 170, 12, TOP], [OX0, OX1, 12, OY0], [OX0, OX1, OY1, TOP]];
  const wallGeo = mergeGeometries(panels.map(([a, b, c, d]) => {
    const g = new THREE.BoxGeometry(b - a, d - c, 2);
    g.translate((a + b) / 2, (c + d) / 2, WZ - 1);
    return g;
  }));
  planarUV(wallGeo, 40, 40, 40); // plaster tile 40 cm
  const wall = new THREE.Mesh(wallGeo, new THREE.MeshStandardMaterial({
    map: plaster, color: plaster ? 0xffffff : C('#c8b08e'), roughness: 0.95,
  }));
  wall.name = 'wall';
  wall.receiveShadow = true;
  group.add(wall);

  // dark wood: window frame, posts, (lattice)
  const latMat = new THREE.MeshStandardMaterial({ map: wood, color: wood ? C('#8a5f44') : C('#6f3c18'), roughness: 0.7 });
  const lat = [];
  const fw = 5;
  lat.push(rbox(OX1 - OX0 + 2 * fw, fw, 4, 0.4, 0, OY0 - fw / 2, WZ + 0.5));
  lat.push(rbox(OX1 - OX0 + 2 * fw, fw, 4, 0.4, 0, OY1 + fw / 2, WZ + 0.5));
  lat.push(rbox(fw, OY1 - OY0, 4, 0.4, OX0 - fw / 2, (OY0 + OY1) / 2, WZ + 0.5));
  lat.push(rbox(fw, OY1 - OY0, 4, 0.4, OX1 + fw / 2, (OY0 + OY1) / 2, WZ + 0.5));
  for (const x of [OX0 - 16, OX1 + 16]) lat.push(rbox(11, TOP - 12, 11, 0.6, x, (TOP + 12) / 2, WZ + 5.6));
  const winW = OX1 - OX0, winH = OY1 - OY0;
  if (winTex) {
    // painted koshi window from textures.js (2:1 tile with posts at both edges = this opening)
    const pg = new THREE.PlaneGeometry(winW, winH);
    pg.translate(0, (OY0 + OY1) / 2, WZ - 1.2);
    const win = new THREE.Mesh(pg, new THREE.MeshBasicMaterial({ map: winTex, color: new THREE.Color(1.25, 1.2, 1.12) }));
    win.name = 'window';
    group.add(win);
  } else {
    // koshi lattice: slats 1.5 cm at 4.5 cm pitch, rails every 28 cm, daylight behind
    for (let x = OX0 + 3; x < OX1 - 1; x += 4.5) lat.push(new THREE.BoxGeometry(1.5, winH, 1.2).translate(x, (OY0 + OY1) / 2, WZ - 1));
    for (let y = OY0 + 28; y < OY1 - 4; y += 28) lat.push(new THREE.BoxGeometry(winW, 2, 1.6).translate(0, y, WZ - 1));
    lat.forEach((g, i) => { if (g.index) lat[i] = g.toNonIndexed(); });
    const day = canvasTex(256, 128, (g, w, h) => {
      const grd = g.createLinearGradient(0, 0, 0, h);
      grd.addColorStop(0, '#f6dcb4');
      grd.addColorStop(0.45, '#e2b27e');
      grd.addColorStop(0.75, '#9a8358');
      grd.addColorStop(1, '#6e5b3f');
      g.fillStyle = grd;
      g.fillRect(0, 0, w, h);
      g.filter = 'blur(7px)';
      const R = rng(77);
      for (let i = 0; i < 26; i++) {
        g.fillStyle = R() < 0.5 ? 'rgba(198,168,93,0.55)' : 'rgba(243,220,131,0.5)';
        g.beginPath();
        g.ellipse(120 + R() * 120, 18 + R() * 60, 6 + R() * 16, 4 + R() * 10, 0, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = 'rgba(86,64,35,0.8)';
      g.fillRect(205, 52, 18, 40);
      g.fillRect(198, 46, 32, 8);
      g.filter = 'none';
    });
    const dayMat = new THREE.MeshBasicMaterial({ map: day, color: day ? new THREE.Color(1.2, 1.12, 1.02) : new THREE.Color(1.3, 1.0, 0.7) });
    const dayPlane = new THREE.Mesh(new THREE.PlaneGeometry(winW + 60, winH + 40), dayMat);
    dayPlane.position.set(0, (OY0 + OY1) / 2, WZ - 16);
    dayPlane.name = 'daylight';
    group.add(dayPlane);
    // sudare blind across the top of the opening
    const sud = canvasTex(16, 256, (g, w, h) => {
      g.clearRect(0, 0, w, h);
      for (let y = 0; y < h; y += 8) {
        g.fillStyle = y % 16 ? '#a06c41' : '#8f5f37';
        g.fillRect(0, y, w, 6);
      }
    });
    if (sud) {
      const sm = new THREE.MeshStandardMaterial({ map: sud, alphaTest: 0.5, roughness: 0.8, side: THREE.DoubleSide });
      const sp = new THREE.Mesh(new THREE.PlaneGeometry(winW, 18), sm);
      sp.position.set(0, OY1 - 9, WZ + 0.4);
      sp.name = 'sudare';
      group.add(sp);
    }
  }
  const latGeo = mergeGeometries(lat.map((g) => (g.index ? g.toNonIndexed() : g)));
  planarUV(latGeo, 60, 60, 60);
  const lattice = new THREE.Mesh(latGeo, latMat);
  lattice.name = 'lattice';
  shade(lattice);
  group.add(lattice);
  return { group, counter, ledge, wall, lattice };
}

// ================================================================ hinoki board
function buildBoard(tex) {
  const S = STATIONS.board;
  // keep a 1 cm gap to the konro body (the config footprint would overlap it)
  const right = Math.min(S.x + S.w / 2, -(GRILL.x1 + KONRO_END) + STATIONS.grill.x - 1);
  const half = Math.min(S.w / 2, right - S.x);
  const bw = half * 2;
  const geo = new RoundedBoxGeometry(bw, S.h, S.d, 2, 0.35);
  geo.translate(S.x, S.h / 2, S.z);
  // the texture covers the full 74 x 28 cm footprint (canvas top = far edge): keep its scale
  planarUV(geo, S.w, S.d, S.d, -(S.x - S.w / 2), 0, -(S.z - S.d / 2));
  const n = geo.attributes.normal, uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) if (Math.abs(n.getY(i)) > Math.abs(n.getX(i)) && Math.abs(n.getY(i)) > Math.abs(n.getZ(i))) uv.setY(i, 1 - uv.getY(i));
  const bt = tex.board;
  const map = pick(bt, 'map', 'color');
  const rough = sub(bt, 'rough', 'roughness', 'roughnessMap');
  const top = new THREE.MeshStandardMaterial({ map, roughnessMap: rough, roughness: rough ? 1 : 0.64, color: map ? 0xffffff : C('#dfc4a2') });
  const side = new THREE.MeshStandardMaterial({ map, color: map ? C('#eadccb') : C('#cda686'), roughness: 0.72 });
  const end = new THREE.MeshStandardMaterial({ map, color: map ? C('#c9a47c') : C('#88562e'), roughness: 0.78 });
  const board = new THREE.Mesh(geo, [end, end, top, top, side, side]);
  board.name = 'board';
  board.userData.top = S.h;
  board.userData.bounds = { x0: S.x - half, x1: S.x + half, z0: S.z - S.d / 2, z1: S.z + S.d / 2 };
  shade(board);
  return board;
}

// ================================================================ konro, binchotan, ash, ember glow
function coalGeometry(seed) {
  // binchotan: long, hard, slightly bent sticks split lengthwise (faceted, not round), the ends
  // tapering and broken off rather than sawn flat. Unit length along +x, unit radius.
  const g = new THREE.CylinderGeometry(1, 1, 1, 8, 8);
  g.rotateZ(-Math.PI / 2); // axis along +x
  const p = g.attributes.position;
  const bend = (hash2(seed * 13, 5) - 0.5) * 0.5;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const a = Math.atan2(z, y);
    const ka = Math.round(((a + Math.PI) / (Math.PI * 2)) * 8) % 8;
    const kx = Math.round(x * 8);
    const n = hash2(ka + seed * 31, kx + 7) * 2 - 1;
    const r = Math.hypot(y, z);
    // faceted split surface, tapering over the last 8 % toward a broken tip
    const taper = 0.7 + 0.3 * smooth(0.5, 0.42, Math.abs(x));
    const f = (1 + 0.14 * n) * taper;
    const brk = Math.abs(x) > 0.49 ? (hash2(ka + seed * 17, Math.round(r * 5)) - 0.3) * 0.06 : 0;
    p.setXYZ(i, x + brk * Math.sign(x), y * f + bend * Math.sin(Math.PI * (x + 0.5)), z * f);
  }
  g.computeVertexNormals();
  return g;
}

function buildGrill(tex, opts) {
  const G = STATIONS.grill;
  const group = new THREE.Group();
  group.name = 'konro';
  group.position.set(G.x, 0, G.z);
  const x1 = GRILL.x1, zh = GRILL.zHalf, KX = x1 + KONRO_END, OZ = G.d / 2;
  const rimTop = GRILL.rimY - 0.5;   // timber rim; the steel rail on top reaches rimY
  const foot = 0.8, floorTop = 2.2, ashTop = floorTop + 0.3;

  // -- charred timber body (walls, floor, feet): one mesh
  const parts = [];
  const wt = OZ - zh;
  parts.push(rbox(2 * KX, rimTop - foot, wt, 0.4, 0, (rimTop + foot) / 2, zh + wt / 2));
  parts.push(rbox(2 * KX, rimTop - foot, wt, 0.4, 0, (rimTop + foot) / 2, -zh - wt / 2));
  for (const s of [-1, 1]) parts.push(rbox(KONRO_END, rimTop - 0.3 - foot, 2 * zh + 1.2, 0.3, s * (x1 + KONRO_END / 2), (rimTop - 0.3 + foot) / 2, 0));
  parts.push(rbox(2 * x1 + 1, floorTop - foot, 2 * zh + 1, 0.2, 0, (floorTop + foot) / 2, 0));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push(rbox(6, foot, 5, 0.2, sx * (KX - 4), foot / 2, sz * (OZ - 3), 1));
  const merged = mergeGeometries(parts);
  const mp = merged.attributes.position;
  for (let i = 0; i < mp.count; i++) {
    const y = mp.getY(i);
    if (y > rimTop - 0.45) {
      // worn, slightly uneven rim tops (never above the rail)
      const x = mp.getX(i), z = mp.getZ(i);
      mp.setY(i, y - 0.08 - 0.06 * Math.sin(x * 0.43 + z * 0.7) - 0.04 * Math.sin(x * 1.37 + 1.3));
    }
  }
  // three surfaces with their own maps: outer faces, ashy rim tops, sooty inside
  const body = splitTris(merged, (cx, cy, cz, nx, ny) => {
    if (ny > 0.55 && cy > rimTop - 0.8) return 1;
    if (Math.abs(cx) < x1 + 0.45 && Math.abs(cz) < zh + 0.45 && cy > floorTop - 0.05) return 2;
    return 0;
  }, 3);
  {
    const p = body.attributes.position, n = body.attributes.normal;
    const uv = new Float32Array(p.count * 2);
    for (const g of body.groups) {
      for (let i = g.start; i < g.start + g.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
        let u, v;
        if (g.materialIndex === 1) {
          // rim tops: 64 x 4 cm strip across the rim width
          if (Math.abs(z) > zh - 0.5) { u = x / 64; v = (Math.abs(z) - zh) / (OZ - zh); }
          else { u = z / 64; v = (Math.abs(x) - x1) / KONRO_END; }
        } else if (g.materialIndex === 2) {
          // inside: canvas bottom = floor
          if (ay >= ax && ay >= az) { u = x / 64; v = z / 16; }
          else if (az >= ax) { u = x / 64; v = (y - floorTop) / 16; }
          else { u = z / 64; v = (y - floorTop) / 16; }
        } else if (ay >= ax && ay >= az) {
          u = x / 64; v = z / 16;
        } else {
          // outer faces: canvas top = rim (soot runs hang from it)
          u = (az >= ax ? x : z) / 64;
          v = (y + 16 - rimTop) / 16;
        }
        uv[i * 2] = u;
        uv[i * 2 + 1] = v;
      }
    }
    body.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  const kw = tex.konro || {};
  const kRim = kw.rim || {}, kIn = kw.inner || {};
  const charMat = (set, fallback, normalScale) => {
    const map = pick(set, 'map', 'color'), nor = sub(set, 'normal', 'normalMap'), rough = sub(set, 'rough', 'roughness', 'roughnessMap');
    const m = new THREE.MeshStandardMaterial({
      map: tiling(map), normalMap: tiling(nor), roughnessMap: tiling(rough), roughness: rough ? 1 : 0.9,
      color: map ? 0xffffff : C(fallback), metalness: 0,
    });
    if (nor) m.normalScale.set(normalScale, normalScale);
    return m;
  };
  const walls = new THREE.Mesh(body, [charMat(kw, '#1c120a', 0.8), charMat(kRim, '#2f2116', 0.8), charMat(kIn, '#0d0704', 0.5)]);
  walls.name = 'konro-walls';
  shade(walls);
  group.add(walls);

  // -- steel skewer rails on the front and back rims + U handles on the ends
  const steelParts = [];
  for (const s of [-1, 1]) steelParts.push(rbox(2 * KX - 1.5, 0.5, 0.8, 0.12, 0, rimTop + 0.25, s * (zh + 1.2), 1));
  for (const s of [-1, 1]) {
    const h = new THREE.TorusGeometry(3.0, 0.42, 6, 14, Math.PI).toNonIndexed();
    h.rotateX(Math.PI / 2);
    h.rotateY(s * Math.PI / 2);
    h.translate(s * KX, rimTop - 2.6, 0);
    steelParts.push(h);
  }
  const rails = new THREE.Mesh(mergeGeometries(steelParts), new THREE.MeshStandardMaterial({ color: C('#4a3a30'), metalness: 0.75, roughness: 0.46 }));
  rails.name = 'konro-rails';
  shade(rails);
  group.add(rails);

  const uTime = { value: 0 }, uGlow = { value: 1 }, uRamp = rampUniform();

  // -- ash bed, heaped against the walls; dull red spots show through where it is hot
  const aGeo = new THREE.PlaneGeometry(2 * x1 - 0.2, 2 * zh - 0.2, 56, 18);
  aGeo.rotateX(-Math.PI / 2);
  const ap = aGeo.attributes.position;
  for (let i = 0; i < ap.count; i++) {
    const x = ap.getX(i), z = ap.getZ(i);
    const dw = Math.min(x1 - Math.abs(x), zh - Math.abs(z));
    const heap = 1.5 * Math.pow(1 - smooth(0, 3.2, dw), 1.5);
    const n = 0.12 * Math.sin(x * 0.9 + z * 0.4) + 0.1 * Math.sin(z * 1.3 - x * 0.35) + 0.06 * Math.sin(x * 2.7 + z * 2.1);
    ap.setY(i, ashTop - 0.1 + n + heap);
  }
  aGeo.computeVertexNormals();
  aGeo.setAttribute('aHeat', new THREE.BufferAttribute(new Float32Array(ap.count), 1));
  const ashMap = pick(tex.ash, 'map', 'color'), ashEmi = sub(tex.ash, 'emissive');
  const ashMat = new THREE.MeshStandardMaterial({
    map: tiling(ashMap), color: ashMap ? 0xffffff : C('#6b544e'), roughness: 1,
    emissive: ashEmi ? 0xffffff : 0x000000, emissiveMap: tiling(ashEmi),
  });
  ashMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { uTime, uGlow });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aHeat;\nvarying float vAshHeat;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAshHeat = aHeat;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uGlow;\nvarying float vAshHeat;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance *= smoothstep(0.45, 1.0, vAshHeat) * 1.6 * uGlow * (1.0 + 0.12 * sin(uTime * 1.7 + vAshHeat * 9.0));`);
  };
  const ash = new THREE.Mesh(aGeo, ashMat);
  ash.name = 'ash';
  ash.receiveShadow = true;
  group.add(ash);

  // -- binchotan: two instanced variants, lying mostly along x, denser where it is hotter.
  // The coal texture keeps its ash at u ~ 0.3 and its glowing underside at u ~ 0.8, so each log is
  // rolled to put u = 0.3 on top (roll ≈ 2.83 rad for this cylinder) with a little jitter.
  const R = rng(4242);
  const roll = () => 2.83 + (R() - 0.5) * 1.8;
  const list = [];
  const rows = 6, rowP = (2 * zh - 1.2) / rows;
  for (let r = 0; r < rows; r++) {
    const zr = -zh + 0.6 + rowP * (r + 0.5);
    let x = -x1 + 0.5 + R() * 1.2;
    while (x < x1 - 3) {
      let len = 10 + R() * 8;
      if (x + len > x1 - 0.5) len = x1 - 0.5 - x;
      if (len < 4) break;
      const rad = 1.0 + R() * 0.4;
      const h = heatAt(G.x + x + len / 2, G.z + zr);
      if (R() < 0.05 + 0.2 * (1 - clamp(h, 0, 1))) {
        x += len * 0.5;
        continue;
      }
      list.push({ x: x + len / 2, z: zr + (R() - 0.5) * 0.5, y: ashTop + rad * 0.85, len, rad, yaw: (R() - 0.5) * 0.3, pitch: (R() - 0.5) * 0.06, roll: roll() });
      x += len + 0.3 + R() * 0.7;
    }
  }
  for (let r = 0; r < rows - 1; r++) {
    const zr = -zh + 0.6 + rowP * (r + 1);
    let x = -x1 + 1.5 + R() * 3;
    while (x < x1 - 3) {
      const cross = R() < 0.16;
      const len = cross ? 5 + R() * 3 : 8 + R() * 6;
      const rad = 0.95 + R() * 0.35;
      const cx = x + len / 2;
      const h = heatAt(G.x + cx, G.z + zr);
      if (R() < clamp(0.08 + 0.9 * h, 0.08, 0.95)) {
        const yaw = cross ? (R() < 0.5 ? 1 : -1) * (0.6 + R() * 0.8) : (R() - 0.5) * 0.8;
        const ez = (Math.abs(Math.sin(yaw)) * len) / 2 + rad;
        const ex = (Math.abs(Math.cos(yaw)) * len) / 2 + rad * Math.abs(Math.sin(yaw));
        list.push({
          x: clamp(cx, -x1 + ex + 0.2, x1 - ex - 0.2), z: clamp(zr + (R() - 0.5) * 0.8, -zh + ez + 0.2, zh - ez - 0.2),
          y: ashTop + 2.6 + rad * 0.9, len, rad, yaw, pitch: (R() - 0.5) * 0.18, roll: roll(),
        });
      }
      x += (cross ? 4 : len) + 0.6 + R() * 1.2;
    }
  }

  const coalTex = tex.coal;
  const makeCoalMat = (cap) => {
    const map = cap ? null : pick(coalTex, 'map', 'color');
    const nor = cap ? null : sub(coalTex, 'normal');
    const rough = cap ? null : sub(coalTex, 'rough');
    const emi = cap ? null : pick(tex.ember, 'map', 'emissive', 'mask');
    const m = new THREE.MeshStandardMaterial({
      map: cap ? map : tiling(map), normalMap: tiling(nor), roughnessMap: tiling(rough), roughness: rough ? 0.75 : 0.65, metalness: 0.35,
      color: map ? C('#9a9693') : C('#2a2522'), emissive: 0xffffff, emissiveMap: tiling(emi),
    });
    if (cap) m.defines = { COAL_CAP: '' };
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, { uTime, uGlow, uRamp });
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
attribute float aHeat;
attribute float aSeed;
varying float vHeat;
varying float vSeed;
varying float vUpY;
varying vec3 vObj;`)
        .replace('#include <uv_vertex>', `#include <uv_vertex>
#ifndef COAL_CAP
#ifdef USE_MAP
vMapUv.y += aSeed * 0.613;
#endif
#ifdef USE_NORMALMAP
vNormalMapUv.y += aSeed * 0.613;
#endif
#ifdef USE_ROUGHNESSMAP
vRoughnessMapUv.y += aSeed * 0.613;
#endif
#ifdef USE_EMISSIVEMAP
vEmissiveMapUv.y += aSeed * 0.613;
#endif
#endif`)
        .replace('#include <defaultnormal_vertex>', `#include <defaultnormal_vertex>
vec3 cwN = objectNormal;
#ifdef USE_INSTANCING
mat3 cwM = mat3(instanceMatrix);
cwN = cwM * (cwN / vec3(dot(cwM[0], cwM[0]), dot(cwM[1], cwM[1]), dot(cwM[2], cwM[2])));
#endif
vUpY = normalize(mat3(modelMatrix) * cwN).y;
vHeat = aHeat;
vSeed = aSeed;
vObj = position;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
uniform float uTime;
uniform float uGlow;
uniform vec3 uRamp[7];
varying float vHeat;
varying float vSeed;
varying float vUpY;
varying vec3 vObj;
${GLSL_NOISE}`)
        .replace('#include <color_fragment>', `#include <color_fragment>
float cHeat = clamp(vHeat, 0.0, 1.3);
// cooler coals carry a little more grey ash on top
float cUp = smoothstep(0.25, 0.85, vUpY);
float cAshN = pNoise(vObj * vec3(1.7, 2.6, 2.6) + vSeed * 31.0) * 0.7 + pNoise(vObj * vec3(5.0, 8.0, 8.0) + vSeed * 7.0) * 0.3;
float cAsh = cUp * smoothstep(0.55, 0.75, cAshN + 0.35 * (1.0 - min(cHeat, 1.0)));
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.13, 0.12, 0.115), cAsh * 0.5);
// packed pile: every log darkens toward its underside
diffuseColor.rgb *= mix(0.3, 1.0, smoothstep(-0.7, 0.55, vUpY));`)
        .replace('#include <emissivemap_fragment>', `
// glow structure: the painted ember map (cracks, underside band) or a procedural crack net on caps;
// colour and strength come from the heat at this coal, so the bed reads where it is hot
float cMask;
#ifdef USE_EMISSIVEMAP
vec3 cE = texture2D(emissiveMap, vEmissiveMapUv).rgb;
cMask = clamp(max(cE.r * 1.1, cE.g * 2.2), 0.0, 1.0);
#else
cMask = 0.8 * (1.0 - smoothstep(0.0, 0.035, abs(pNoise(vObj * vec3(2.0, 6.0, 6.0) + vSeed * 13.0) - 0.5)));
#endif
float cUnder = smoothstep(0.1, -0.7, vUpY);
float cSide = 1.0 - smoothstep(0.1, 0.75, vUpY);
float cGlowM = cMask * mix(0.18, 1.0, cSide) + cUnder * 0.22;
#ifdef COAL_CAP
cGlowM *= 0.2;
#endif
cGlowM = pow(clamp(cGlowM, 0.0, 1.0), mix(2.6, 1.0, smoothstep(0.2, 1.0, cHeat)));
float cFl = 1.0 + 0.1 * sin(uTime * 2.5 + vSeed * 37.0) + 0.06 * sin(uTime * 1.1 + vSeed * 91.0) + 0.035 * sin(uTime * 50.0 + vSeed * 13.0);
float cInt = mix(0.35, 2.4, smoothstep(0.22, 1.0, cHeat)) * uGlow;
totalEmissiveRadiance = emberRamp(cHeat * (0.68 + 0.34 * cMask)) * cGlowM * cInt * cFl;`);
    };
    return m;
  };
  const coalMats = [makeCoalMat(false), makeCoalMat(true), makeCoalMat(true)];

  const dummy = new THREE.Object3D();
  dummy.rotation.order = 'YZX';
  const coals = [];
  for (let v = 0; v < 2; v++) {
    const subset = list.filter((_, i) => i % 2 === v);
    const geo = coalGeometry(v + 1);
    geo.setAttribute('aHeat', new THREE.InstancedBufferAttribute(new Float32Array(subset.length), 1));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(Float32Array.from(subset, () => R()), 1));
    const im = new THREE.InstancedMesh(geo, coalMats, subset.length);
    subset.forEach((c, i) => {
      dummy.position.set(c.x, c.y, c.z);
      dummy.rotation.set(c.roll, c.yaw, c.pitch);
      dummy.scale.set(c.len, c.rad, c.rad);
      dummy.updateMatrix();
      im.setMatrixAt(i, dummy.matrix);
    });
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    im.userData.coals = subset;
    im.name = 'binchotan-' + v;
    shade(im);
    group.add(im);
    coals.push(im);
  }

  // -- ember glow sheet just above the ash: shows only in the gaps between the logs
  const gGeo = new THREE.PlaneGeometry(2 * x1 - 1, 2 * zh - 1, 68, 22);
  gGeo.rotateX(-Math.PI / 2);
  gGeo.translate(0, ashTop + 0.55, 0);
  gGeo.setAttribute('aHeat', new THREE.BufferAttribute(new Float32Array(gGeo.attributes.position.count), 1));
  const glowMat = new THREE.ShaderMaterial({
    uniforms: { uTime, uGlow, uRamp, uHalf: { value: new THREE.Vector2(x1, zh) } },
    vertexShader: /* glsl */ `
attribute float aHeat;
varying float vHeat;
varying vec3 vP;
void main() {
  vHeat = aHeat;
  vP = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
    fragmentShader: /* glsl */ `
uniform float uTime;
uniform float uGlow;
uniform vec3 uRamp[7];
uniform vec2 uHalf;
varying float vHeat;
varying vec3 vP;
${GLSL_NOISE}
void main() {
  vec2 p = vP.xz;
  float n = pNoise(vec3(p * 0.5, uTime * 0.12)) * 0.62 + pNoise(vec3(p * 1.3, uTime * 0.2 + 3.0)) * 0.38;
  float h = clamp(vHeat, 0.0, 1.3);
  float thr = mix(0.7, 0.42, smoothstep(0.2, 1.0, h));
  float blob = smoothstep(thr, thr + 0.2, n);
  float fl = 1.0 + 0.12 * sin(uTime * 2.6 + n * 9.0) + 0.04 * sin(uTime * 41.0 + p.x);
  float edge = smoothstep(0.0, 1.5, min(uHalf.x - abs(p.x), uHalf.y - abs(p.y)));
  vec3 c = emberRamp(h * (0.72 + 0.3 * blob)) * (blob * mix(0.2, 2.1, smoothstep(0.2, 1.0, h)) + 0.12 * h) * fl * uGlow * edge;
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const glow = new THREE.Mesh(gGeo, glowMat);
  glow.name = 'ember-glow';
  glow.renderOrder = 2;
  group.add(glow);

  // -- ember lights under the coals (below the floor, so they light undersides and inner walls,
  //    not the grey coal tops); candela for centimetre units
  const underLight = new THREE.PointLight(C('#ff6a20'), 0, 40, 2);
  underLight.name = 'ember-under';
  group.add(underLight);
  const glowLights = [0, 1, 2].map((k) => {
    const l = new THREE.PointLight(C('#ff7a2a'), 0, 46, 2);
    l.name = 'ember-light-' + k;
    l.userData.base = 0;
    group.add(l);
    return l;
  });

  let heatFn = heatAt;
  function placeLights() {
    const slabs = [[-x1, -x1 / 3], [-x1 / 3, x1 / 3], [x1 / 3, x1]];
    slabs.forEach(([a, b], k) => {
      let sw = 0, sx = 0, sz = 0, sh = 0;
      for (let x = a + 0.5; x < b; x += 1) {
        for (let z = -zh + 0.5; z < zh; z += 1) {
          const h = Math.max(0, heatFn(G.x + x, G.z + z) || 0);
          const w = h * h * h * h + 1e-6;
          sw += w;
          sx += w * x;
          sz += w * z;
          sh += w * h;
        }
      }
      const L = glowLights[k];
      L.position.set(sx / sw, -0.5, sz / sw);
      L.userData.base = 220 * (sh / sw);
      L.intensity = L.userData.base * uGlow.value;
    });
    underLight.position.set(glowLights[1].position.x, GRILL.rimY - 2.5, glowLights[1].position.z); // group sits on the counter (y 0)
    underLight.userData.base = 100;
    underLight.intensity = 100 * uGlow.value;
  }

  function setHeat(fn) {
    heatFn = typeof fn === 'function' ? fn : heatAt;
    for (const im of coals) {
      const a = im.geometry.attributes.aHeat;
      im.userData.coals.forEach((c, i) => {
        a.array[i] = Math.max(0, heatFn(G.x + c.x, G.z + c.z) || 0);
      });
      a.needsUpdate = true;
    }
    const gp = gGeo.attributes.position, gh = gGeo.attributes.aHeat;
    for (let i = 0; i < gp.count; i++) gh.array[i] = Math.max(0, heatFn(G.x + gp.getX(i), G.z + gp.getZ(i)) || 0);
    gh.needsUpdate = true;
    const ah = aGeo.attributes.aHeat;
    for (let i = 0; i < ap.count; i++) ah.array[i] = Math.max(0, heatFn(G.x + ap.getX(i), G.z + ap.getZ(i)) || 0);
    ah.needsUpdate = true;
    placeLights();
  }

  function update(t) {
    uTime.value = t;
    glowLights.forEach((L, k) => {
      const f = 1 + 0.08 * Math.sin(t * 2.3 + k * 1.9) + 0.05 * Math.sin(t * 6.1 + k * 4.3) + 0.03 * Math.sin(t * 13.7 + k);
      L.intensity = L.userData.base * f * uGlow.value;
    });
    underLight.intensity = underLight.userData.base * (1 + 0.08 * Math.sin(t * 3.1) + 0.04 * Math.sin(t * 9.3)) * uGlow.value;
  }

  setHeat(heatAt);
  return {
    group, walls, rails, ash, glow, coals, glowLights, setHeat, update,
    setGlowScale(k) { uGlow.value = Math.max(0, k); },
    railY: GRILL.rimY, rimTop, inner: { x0: GRILL.x0, x1: GRILL.x1, zHalf: zh },
    coalCount: list.length,
  };
}

// ================================================================ jubako + rice
function buildBox(tex, opts) {
  const X = STATIONS.box, ix = BOX.inner.x, iz = BOX.inner.z;
  const group = new THREE.Group();
  group.name = 'jubako';
  group.position.set(X.x, 0, X.z);
  const plinth = 0.5, H = X.h - plinth, bt = 0.18, bs = 0.18;

  const lac = tex.lacquer || {};
  const bMap = tiling(pick(lac.black, 'map', 'color')), rMap = tiling(pick(lac.red, 'map', 'color'));
  const bRough = tiling(sub(lac, 'rough') || sub(lac.black, 'rough')), lNor = tiling(sub(lac, 'normal') || sub(lac.black, 'normal'));
  const black = new THREE.MeshPhysicalMaterial({
    map: bMap, color: bMap ? 0xffffff : C('#0d0301'), roughness: bRough ? 1 : 0.12, roughnessMap: bRough,
    envMap: tex.env || null, envMapIntensity: 0.5, // own env: tops at grazing angles would mirror the window white
    normalMap: lNor, normalScale: new THREE.Vector2(0.18, 0.18),
    metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04,
  });
  const red = new THREE.MeshPhysicalMaterial({
    map: rMap, color: rMap ? 0xffffff : C('#7c1c02'), roughness: 0.24, metalness: 0, clearcoat: 0.5, clearcoatRoughness: 0.15,
  });

  // shell: rounded walls with a rolled lip; vermilion inside, black outside and on the lip
  const shape = rrShape(X.w - 2 * bs, X.d - 2 * bs, 1.6 - bs);
  shape.holes.push(rrShape(2 * ix + 2 * bs, 2 * iz + 2 * bs, 0.9 + bs, true));
  const ext = new THREE.ExtrudeGeometry(shape, { depth: H - 2 * bt, bevelEnabled: true, bevelThickness: bt, bevelSize: bs, bevelSegments: 2, curveSegments: 6 });
  ext.rotateX(-Math.PI / 2);
  ext.translate(0, plinth + bt, 0);
  const shellGeo = splitTris(ext, (cx, cy, cz, nx, ny, nz) => {
    const inward = nx * cx + nz * cz < 0;
    const nearHole = Math.max(Math.abs(cx) - ix, Math.abs(cz) - iz) < 0.75;
    return Math.abs(ny) < 0.6 && inward && nearHole && cy < X.h - 0.42 ? 1 : 0;
  }, 2);
  planarUV(shellGeo, 30, 30, 30);
  const shell = new THREE.Mesh(shellGeo, [black, red]);
  shell.name = 'jubako-shell';
  shade(shell);
  group.add(shell);
  const foot = new THREE.Mesh(planarUV(rbox(X.w - 0.8, plinth, X.d - 0.8, 0.2, 0, plinth / 2, 0, 1), 30, 30, 30), black);
  foot.name = 'jubako-foot';
  shade(foot);
  group.add(foot);

  // rice bed heightfield (box-local), gentle dome, rising a little against the walls
  const NX = 42, NZ = 34, dx = (2 * ix) / NX, dz = (2 * iz) / NZ;
  const H0 = new Float32Array((NX + 1) * (NZ + 1));
  const Hc = new Float32Array(H0.length);
  const pressed = new Float32Array(H0.length);
  const baseRice = (x, z) => {
    const nx = x / ix, nz = z / iz;
    const dome = 0.5 * (1 - nx * nx) * (1 - nz * nz);
    const dw = Math.min(ix - Math.abs(x), iz - Math.abs(z));
    const wall = 0.2 * (1 - smooth(0, 1.4, dw));
    const n = 0.03 * Math.sin(x * 2.1 + z * 1.3) + 0.025 * Math.sin(z * 2.9 - x * 0.7);
    return X.rice - 0.12 + dome + wall + n;
  };
  for (let j = 0; j <= NZ; j++) for (let i = 0; i <= NX; i++) H0[j * (NX + 1) + i] = baseRice(-ix + i * dx, -iz + j * dz);
  Hc.set(H0);
  const riceY = (x, z) => {
    const fx = clamp((x + ix) / dx, 0, NX - 1e-4), fz = clamp((z + iz) / dz, 0, NZ - 1e-4);
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const k = j * (NX + 1) + i;
    const a = Hc[k] + (Hc[k + 1] - Hc[k]) * tx;
    const b = Hc[k + NX + 1] + (Hc[k + NX + 2] - Hc[k + NX + 1]) * tx;
    return a + (b - a) * tz;
  };

  const bedGeo = new THREE.PlaneGeometry(2 * ix, 2 * iz, NX, NZ);
  bedGeo.rotateX(-Math.PI / 2);
  const bp = bedGeo.attributes.position;
  const vmap = new Int32Array(bp.count);
  for (let v = 0; v < bp.count; v++) {
    const i = Math.round((bp.getX(v) + ix) / dx), j = Math.round((bp.getZ(v) + iz) / dz);
    vmap[v] = j * (NX + 1) + i;
  }
  const uvb = bedGeo.attributes.uv;
  for (let v = 0; v < bp.count; v++) uvb.setXY(v, bp.getX(v) / 8, bp.getZ(v) / 8); // rice tile 8 cm
  const syncBed = () => {
    for (let v = 0; v < bp.count; v++) bp.setY(v, Hc[vmap[v]]);
    bp.needsUpdate = true;
    bedGeo.computeVertexNormals();
  };
  syncBed();
  const rt = tex.rice || {};
  const riceMap = tiling(pick(rt, 'map', 'color')), riceNor = tiling(sub(rt, 'normal', 'normalMap')), riceRough = tiling(sub(rt, 'rough'));
  const bedMat = new THREE.MeshPhysicalMaterial({
    map: riceMap, normalMap: riceNor, roughnessMap: riceRough, color: riceMap ? C('#f6f3ee') : C('#d9cfc6'), roughness: riceRough ? 1 : 0.5, normalScale: new THREE.Vector2(0.6, 0.6),
    sheen: 0.3, sheenColor: C('#fff4e8'), sheenRoughness: 0.5,
  });
  const bed = new THREE.Mesh(bedGeo, bedMat);
  bed.name = 'rice-bed';
  bed.receiveShadow = true;
  group.add(bed);

  // individually readable grains on top (one instanced draw)
  const pitch = opts.low ? 0.44 : 0.34;
  const R = rng(9001);
  const gx = [], gz = [], lift = [], yaw = [], tx = [], tz = [], sc = [];
  // scattered, not gridded: dart-throwing with a minimum spacing (no rows or repeated streaks)
  const target = Math.round(((2 * ix - 0.3) * (2 * iz - 0.3)) / (pitch * pitch));
  const cellS = pitch * 0.72, gw = Math.ceil((2 * ix) / cellS) + 1, ghash = new Map();
  for (let tries = 0; gx.length < target && tries < target * 30; tries++) {
    const x = -ix + 0.2 + R() * (2 * ix - 0.4), z = -iz + 0.2 + R() * (2 * iz - 0.4);
    const ci = Math.floor((x + ix) / cellS), cj = Math.floor((z + iz) / cellS);
    let ok = true;
    for (let dj = -1; dj <= 1 && ok; dj++) {
      for (let di = -1; di <= 1 && ok; di++) {
        const k = ghash.get((cj + dj) * gw + ci + di);
        if (k !== undefined && Math.hypot(gx[k] - x, gz[k] - z) < cellS) ok = false;
      }
    }
    if (!ok) continue;
    ghash.set(cj * gw + ci, gx.length);
    gx.push(x);
    gz.push(z);
    lift.push(0.03 + R() * 0.09);
    yaw.push(R() * Math.PI * 2);
    tx.push((R() - 0.5) * 1.8);
    tz.push((R() - 0.5) * 1.8);
    sc.push(0.82 + R() * 0.34);
  }
  const NG = gx.length;
  // polished rice is pearly white; a few grains catch the tare
  const pal = [['#f8f7f4', 35], ['#f2f0ec', 35], ['#e9e6e1', 22], ['#dcd6cf', 8]].map(([h, w]) => [C(h), w]);
  const colBase = new Float32Array(NG * 3);
  for (let i = 0; i < NG; i++) {
    let r = R() * 100, c = pal[0][0];
    for (const [cc, w] of pal) {
      if (r < w) { c = cc; break; }
      r -= w;
    }
    c.toArray(colBase, i * 3);
  }
  const grainGeo = new THREE.SphereGeometry(1, 10, 6);
  grainGeo.scale(0.27, 0.14, 0.16);
  // standard material: sheen and clearcoat on 3 mm grains are invisible but cost per pixel
  const grainMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.3,
    emissive: C('#1d1d21'), emissiveIntensity: 0.35, // cooked rice is translucent: no dead-black shadows
  });
  const grains = new THREE.InstancedMesh(grainGeo, grainMat, NG);
  grains.name = 'rice-grains';
  grains.receiveShadow = true;
  const st = {
    x: Float32Array.from(gx), z: Float32Array.from(gz), lift: Float32Array.from(lift),
    tx: Float32Array.from(tx), tz: Float32Array.from(tz), hid: new Uint8Array(NG), col: new Float32Array(NG * 3),
  };
  const gDummy = new THREE.Object3D();
  gDummy.rotation.order = 'YXZ';
  const setGrain = (i) => {
    if (st.hid[i]) {
      gDummy.scale.setScalar(0);
    } else {
      gDummy.position.set(st.x[i], riceY(st.x[i], st.z[i]) + st.lift[i], st.z[i]);
      gDummy.rotation.set(st.tx[i], yaw[i], st.tz[i]);
      gDummy.scale.setScalar(sc[i]);
    }
    gDummy.updateMatrix();
    grains.setMatrixAt(i, gDummy.matrix);
  };
  const tmpC = new THREE.Color();
  const resetGrains = () => {
    st.x.set(gx);
    st.z.set(gz);
    st.lift.set(lift);
    st.tx.set(tx);
    st.tz.set(tz);
    st.hid.fill(0);
    st.col.set(colBase);
    for (let i = 0; i < NG; i++) {
      setGrain(i);
      grains.setColorAt(i, tmpC.fromArray(colBase, i * 3));
    }
    grains.instanceMatrix.needsUpdate = true;
    if (grains.instanceColor) grains.instanceColor.needsUpdate = true;
  };
  resetGrains();
  grains.computeBoundingSphere();
  group.add(grains);

  // signed distance to a footprint: a circle, or a rounded rectangle {hx, hz, rot} (rot = piece rotation.y)
  const footSD = (px, pz, cx, cz, r, shape) => {
    const ddx = px - cx, ddz = pz - cz;
    if (!shape) return Math.hypot(ddx, ddz) - r;
    const c = Math.cos(shape.rot || 0), s = Math.sin(shape.rot || 0);
    const lx = c * ddx - s * ddz, lz = s * ddx + c * ddz;
    const rr = Math.min(r, shape.hx, shape.hz);
    const qx = Math.abs(lx) - shape.hx + rr, qz = Math.abs(lz) - shape.hz + rr;
    return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - rr;
  };
  const stain = C('#b38662');
  function dent(x, z, r = 1.5, depth = 0.25, shape = null) {
    const ring = 0.55;
    for (let j = 0; j <= NZ; j++) {
      for (let i = 0; i <= NX; i++) {
        const k = j * (NX + 1) + i;
        const d = footSD(-ix + i * dx, -iz + j * dz, x, z, r, shape);
        if (d < 0) {
          const want = H0[k] - depth * smooth(0, 0.45, -d);
          if (want < Hc[k]) Hc[k] = want;
          pressed[k] = 1;
        } else if (d < ring && !pressed[k]) {
          Hc[k] = Math.max(Hc[k], H0[k] + 0.6 * depth * Math.sin((d / ring) * Math.PI) * (1 - d / ring * 0.3));
        }
      }
    }
    syncBed();
    for (let i = 0; i < NG; i++) {
      if (st.hid[i]) continue;
      const d = footSD(st.x[i], st.z[i], x, z, r, shape);
      if (d > 1.0) continue;
      if (d < -0.12) {
        st.hid[i] = 1;
      } else if (d < ring) {
        // pushed out, raised and tipped up around the piece
        let ux = st.x[i] - x, uz = st.z[i] - z;
        const l = Math.hypot(ux, uz) || 1;
        ux /= l;
        uz /= l;
        const k = 1 - Math.max(0, d) / ring;
        st.x[i] = clamp(st.x[i] + ux * 0.1 * k, -ix + 0.15, ix - 0.15);
        st.z[i] = clamp(st.z[i] + uz * 0.1 * k, -iz + 0.15, iz - 0.15);
        st.lift[i] += 0.1 * k;
        st.tx[i] += uz * 0.3 * k;
        st.tz[i] -= ux * 0.3 * k;
      }
      // tare halo on the rice next to the eel
      const s = 0.55 * (1 - clamp(d, 0, 1));
      for (let c = 0; c < 3; c++) {
        const base = st.col[i * 3 + c];
        const target = c === 0 ? stain.r : c === 1 ? stain.g : stain.b;
        st.col[i * 3 + c] = base + (target - base) * s;
      }
      grains.setColorAt(i, tmpC.fromArray(st.col, i * 3));
      setGrain(i);
    }
    grains.instanceMatrix.needsUpdate = true;
    if (grains.instanceColor) grains.instanceColor.needsUpdate = true;
  }
  function reset() {
    Hc.set(H0);
    pressed.fill(0);
    syncBed();
    resetGrains();
  }

  // the lid rests flat at the right rear of the box (as in 11)
  const lidShape = rrShape(X.w + 0.2 - 2 * bs, X.d + 0.2 - 2 * bs, 1.6);
  const lidGeo = new THREE.ExtrudeGeometry(lidShape, { depth: 2.2 - 2 * bt, bevelEnabled: true, bevelThickness: bt, bevelSize: bs, bevelSegments: 2, curveSegments: 6 });
  lidGeo.rotateX(-Math.PI / 2);
  lidGeo.translate(0, bt, 0);
  planarUV(lidGeo, 30, 30, 30);
  // softer sheen than the box itself so its broad top never flashes white behind the food
  const lidMat = black.clone();
  lidMat.roughness = bRough ? 1.6 : 0.22;
  lidMat.clearcoatRoughness = 0.14;
  lidMat.envMapIntensity = 0.35;
  const lid = new THREE.Mesh(lidGeo, lidMat);
  lid.name = 'jubako-lid';
  lid.position.set(20, 0, -25);
  lid.rotation.y = 0.16;
  shade(lid);
  group.add(lid);

  return { group, shell, bed, grains, lid, riceY, dent, reset, materials: { black, red }, inner: { x: ix, z: iz } };
}

// ================================================================ tare trough
// A long, deep glazed-stoneware trough of tare in front of the konro, wide enough inside for the
// 24 cm skewers, so the whole skewered fillet can be lowered in. The tare is a dark glossy surface with
// an amber meniscus; rings spread from where the fish goes in or comes out.
function buildTareTrough(tex, opts) {
  const P = STATIONS.tare;
  const group = new THREE.Group();
  group.name = 'tare-trough';
  group.position.set(P.x, 0, P.z);
  const ix = P.inner.x, iz = P.inner.z, H = P.h, base = 1.0;
  const stoneT = callTex(tex.lib, 'stoneware', '#5b3b24', '#24140a', { ...tex.q, lip: '#2a1608', drips: 10 });
  const stone = pick(stoneT, 'map', 'color'), stoneR = sub(stoneT, 'rough');
  const glaze = new THREE.MeshPhysicalMaterial({
    map: tiling(stone), color: stone ? 0xffffff : C('#5b3b24'), roughnessMap: tiling(stoneR), roughness: stoneR ? 1 : 0.42,
    clearcoat: 0.55, clearcoatRoughness: 0.28, envMapIntensity: 0.5,
  });
  const shape = rrShape(P.len, P.w, 3.2);
  shape.holes.push(rrShape(2 * ix, 2 * iz, 2.2, true));
  const wallGeo = new THREE.ExtrudeGeometry(shape, { depth: H - base - 0.3, bevelEnabled: true, bevelThickness: 0.3, bevelSize: 0.3, bevelSegments: 2, curveSegments: 6 });
  wallGeo.rotateX(-Math.PI / 2);
  wallGeo.translate(0, base, 0);
  // the stoneware texture is 38 cm around by 10 cm high with the glazed lip at the top: map the walls
  // at that scale (no stretched speckle 'slats') and put the rim top on the lip band
  planarUV(wallGeo, 38, 10, 38);
  {
    const n = wallGeo.attributes.normal, uv = wallGeo.attributes.uv;
    for (let i = 0; i < n.count; i++) if (Math.abs(n.getY(i)) > 0.5) uv.setY(i, 0.975);
    uv.needsUpdate = true;
  }
  const walls = new THREE.Mesh(wallGeo, glaze);
  walls.name = 'trough-walls';
  shade(walls);
  group.add(walls);
  const floor = new THREE.Mesh(planarUV(rbox(P.len - 0.6, base, P.w - 0.6, 1.2, 0, base / 2, 0, 1), 38, 10, 38), glaze);
  shade(floor);
  group.add(floor);
  // tare-darkened inner walls down from the surface: unlit, so no box edges show through the tare
  const lining = new THREE.Mesh(new THREE.BoxGeometry(2 * ix - 0.05, P.surf - base, 2 * iz - 0.05), new THREE.MeshBasicMaterial({ color: C('#0b0402'), side: THREE.BackSide }));
  lining.position.y = base + (P.surf - base) / 2 - 0.02;
  group.add(lining);

  // the tare surface: its colour comes from the depth under it (near-black mahogany in the middle,
  // warmer where it is shallow over the glazed walls, a thin amber meniscus at the wall), slow
  // micro-waves keep it alive, and rings spread from where the fish goes in or out and from drops.
  // Glossy: it reflects the shoji transom of the environment as a striped highlight.
  const uT = { value: 0 }, uRip = { value: [0, 1, 2, 3].map(() => new THREE.Vector4(0, 0, -99, 0)) };
  const linC = (h) => { const c = C(h); return new THREE.Vector3(c.r, c.g, c.b); };
  const liqU = { uHalf: { value: new THREE.Vector2(ix, iz) }, uShallow: { value: linC('#3a1606') }, uDeep: { value: linC('#090301') }, uMen: { value: linC('#8c4a18') } };
  const liquidMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.22, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.07,
    envMap: tex.env || null, envMapIntensity: 0.65,
    // a little see-through: the dipped fish shows as a dark shape just under the surface
    transparent: true, opacity: 0.86,
  });
  liquidMat.onBeforeCompile = (sh) => {
    sh.uniforms.uT = uT;
    sh.uniforms.uRip = uRip;
    Object.assign(sh.uniforms, liqU);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vLocal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocal = position.xy;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uT; uniform vec4 uRip[4]; varying vec2 vLocal; uniform vec2 uHalf; uniform vec3 uShallow, uDeep, uMen;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float dw = min(uHalf.x - abs(vLocal.x), uHalf.y - abs(vLocal.y));
        vec3 tc = mix(uShallow, uDeep, smoothstep(0.0, 2.5, dw));
        tc = mix(tc, uMen, (1.0 - smoothstep(0.0, 0.25, dw)) * 0.8);
        diffuseColor.rgb = tc;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        // slow micro-waves, plus expanding rings from where the fish went in / came out and from
        // falling drops (x, z, start time, strength); tilts are in the tare's own plane
        // small and irregular (no regular wave train: that turned the shoji reflection into a row of bars)
        vec2 tilt = 0.007 * vec2(sin(vLocal.x * 0.37 + vLocal.y * 0.21 + uT * 1.3) + 0.6 * sin(vLocal.x * 1.13 - vLocal.y * 0.47 - uT * 0.9),
                                 cos(vLocal.y * 0.53 + vLocal.x * 0.17 - uT * 1.1) + 0.6 * cos(vLocal.x * 0.71 + vLocal.y * 1.31 + uT * 0.7));
        for (int k = 0; k < 4; k++) {
          float age = uT - uRip[k].z;
          if (age < 0.0 || age > 2.6) continue;
          vec2 dlt = vec2(vLocal.x - uRip[k].x, -vLocal.y - uRip[k].y);
          dlt.x *= uRip[k].w >= 0.5 ? 0.45 : 1.0; // the fish is long: its rings spread along it
          float r = length(dlt) + 1e-3;
          float wave = sin(r * 2.6 - age * 9.0) * exp(-abs(r - age * 7.0) * 0.6) * exp(-age * 1.4) * uRip[k].w;
          tilt += normalize(dlt) * wave * 0.6;
        }
        // near the wall the surface curls up into the meniscus and catches the light as a thin line
        float dwN = min(uHalf.x - abs(vLocal.x), uHalf.y - abs(vLocal.y));
        vec2 toWall = abs(vLocal.x) / uHalf.x > abs(vLocal.y) / uHalf.y ? vec2(sign(vLocal.x), 0.0) : vec2(0.0, -sign(vLocal.y));
        tilt += toWall * (1.0 - smoothstep(0.0, 0.3, dwN)) * 0.5;
        normal = normalize(normal + (viewMatrix * vec4(tilt.x, 0.0, tilt.y, 0.0)).xyz);`);
  };
  const liquid = new THREE.Mesh(new THREE.PlaneGeometry(2 * ix - 0.1, 2 * iz - 0.1, 1, 1), liquidMat);
  liquid.rotation.x = -Math.PI / 2;
  liquid.position.y = P.surf;
  liquid.name = 'tare';
  liquid.receiveShadow = true;
  group.add(liquid);

  let rk = 0, dk = 0;
  return {
    group, walls, liquid,
    surfY: P.surf,
    // a ring of ripples at world x, z (strength 0..1); the fish going in or out uses two slots,
    // small drops the other two, so a drop never wipes out the big ring
    ripple(x, z, strength = 1) {
      const k = strength >= 0.5 ? rk : 2 + dk;
      if (strength >= 0.5) rk = (rk + 1) % 2;
      else dk = (dk + 1) % 2;
      uRip.value[k].set(x - P.x, z - P.z, uT.value, strength);
    },
    update(t) { uT.value = t; },
  };
}

function buildKnife(tex, board, env) {
  const knife = new THREE.Group();
  knife.name = 'knife';
  // Local frame: origin at the middle of the edge; the edge runs along x with the tip at -x and
  // the handle at +x; the blade rises along +y; the bevelled (omote) face looks to -z.
  const L = 27, xa = -L / 2, N = 40;
  const st = [];
  for (let i = 0; i <= N; i++) {
    const s = L * Math.pow(i / N, 1.35);
    const base = 2.6 + 0.7 * (s / L);
    const H = s < 6 ? base * Math.pow(Math.sin(((s / 6) * Math.PI) / 2), 0.7) : base;
    const t = 0.06 + 0.29 * Math.pow(s / L, 0.8);
    const eY = s > L - 0.9 ? ((s - (L - 0.9)) / 0.9) * 0.75 : 0; // heel (machi) rises into the collar
    const b = Math.min(0.75, 0.32 * H);
    st.push({ x: xa + s, H: Math.max(H, eY + 0.02), t, b: Math.max(eY, b), eY });
  }
  const E = [], S = [], So = [], Su = [];
  for (const p of st) {
    const zu = p.t / 2;
    E.push([p.x, p.eY, zu]);
    S.push([p.x, p.b, zu - p.t * 0.85]);
    So.push([p.x, p.H, zu - p.t]);
    Su.push([p.x, p.H, zu]);
  }
  const strip = (A, B, expect, color) => {
    const build = (flip) => {
      const n = A.length;
      const pos = new Float32Array(n * 6);
      const idx = [];
      for (let i = 0; i < n; i++) {
        pos.set(A[i], i * 6);
        pos.set(B[i], i * 6 + 3);
      }
      for (let i = 0; i < n - 1; i++) {
        const a = 2 * i, b = a + 1, c = a + 2, d = a + 3;
        if (flip) idx.push(a, c, b, b, c, d);
        else idx.push(a, b, c, b, d, c);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      return g;
    };
    let g = build(false);
    const m = Math.floor(A.length / 2) * 2;
    const n = g.attributes.normal;
    if (n.getX(m) * expect[0] + n.getY(m) * expect[1] + n.getZ(m) * expect[2] < 0) g = build(true);
    const c = C(color);
    paintColors(g, (x, y, z, nx, ny, nz, o) => { o[0] = c.r; o[1] = c.g; o[2] = c.b; });
    g.deleteAttribute('uv');
    return g;
  };
  const bevelGeo = strip(E, S, [0, -0.3, -1], '#c8c7ca');
  const capPts = [E[N], S[N], So[N], Su[N]];
  const cap = new THREE.BufferGeometry();
  cap.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capPts.flat()), 3));
  cap.setIndex([0, 1, 2, 0, 2, 3]);
  cap.computeVertexNormals();
  if (cap.attributes.normal.getX(0) < 0) {
    cap.setIndex([0, 2, 1, 0, 3, 2]);
    cap.computeVertexNormals();
  }
  paintColors(cap, (x, y, z, nx, ny, nz, o) => { o[0] = o[1] = o[2] = 0.6; });
  const bodyGeo = mergeGeometries([
    strip(S, So, [0, 0, -1], '#b9b7b8'),
    strip(So, Su, [0, 1, 0], '#a9a7a8'),
    strip(Su, E, [0, 0, 1], '#bdbcbe'),
    cap,
  ]);
  // brighter own reflections: held upright the blade would otherwise mirror only the dim room
  const steel = (rough) => new THREE.MeshPhysicalMaterial({ color: 0xffffff, vertexColors: true, metalness: 1, roughness: rough, envMap: env || null, envMapIntensity: 2.2 });
  const bevel = new THREE.Mesh(bevelGeo, steel(0.42));
  bevel.name = 'knife-bevel';
  const blade = new THREE.Mesh(bodyGeo, steel(0.34));
  blade.name = 'knife-blade';
  knife.add(blade, bevel);

  // black horn collar and ho-wood handle, octagonal, on the axis at y = 2.0
  const yH = 2.0, xc = L / 2;
  const collarGeo = new THREE.CylinderGeometry(1, 1, 2.4, 8);
  collarGeo.rotateZ(Math.PI / 2);
  collarGeo.rotateX(Math.PI / 8);
  collarGeo.scale(1, 1.15, 1.0);
  collarGeo.translate(xc + 1.2, yH, 0);
  const collar = new THREE.Mesh(collarGeo, new THREE.MeshPhysicalMaterial({ color: C('#1a1613'), roughness: 0.32, clearcoat: 0.5, clearcoatRoughness: 0.25 }));
  collar.name = 'knife-collar';
  const hGeo = new THREE.CylinderGeometry(0.97, 1.05, 13, 8);
  hGeo.rotateZ(Math.PI / 2);
  hGeo.rotateX(Math.PI / 8);
  hGeo.scale(1, 1.12, 1.0);
  hGeo.translate(xc + 2.4 + 6.5, yH, 0);
  const huv = hGeo.attributes.uv;
  for (let i = 0; i < huv.count; i++) {
    const u = huv.getX(i), v = huv.getY(i);
    huv.setXY(i, 0.2 + v * 0.18, 0.35 + u * 0.25);
  }
  const boardMap = pick(tex.board, 'map', 'color');
  const handle = new THREE.Mesh(hGeo, new THREE.MeshStandardMaterial({ map: boardMap, color: boardMap ? C('#efd9bf') : C('#cfae8b'), roughness: 0.6 }));
  handle.name = 'knife-handle';
  knife.add(collar, handle);
  shade(knife, true, false);

  // rest: lying flat on the far edge of the board, tip left, edge away from the player, bevel up,
  // the tip touching the board and the collar holding the heel up
  const B = board.userData.bounds, top = board.userData.top;
  const tilt = Math.asin(0.96 / L);
  const q = new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.025)
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), tilt))
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2));
  const rot = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  const pos = new THREE.Vector3(
    clamp(STATIONS.board.x - 8, B.x0 + L / 2 + 1.5, B.x1 - L / 2 - 17),
    top + 1.0 - (L / 2) * Math.sin(tilt),
    B.z0 + 1.0,
  );
  knife.userData.rest = { pos: pos.clone(), rot: rot.clone() };
  knife.userData.bladeLength = L;
  knife.position.copy(pos);
  knife.rotation.copy(rot);
  return knife;
}

// ================================================================ small things
function buildSansho(tex) {
  const wood = pick(tex.counter, 'map', 'color');
  const prof = [[0, 0], [1.7, 0], [1.85, 0.15], [1.9, 0.6], [1.85, 3.4], [1.95, 3.6], [1.95, 4.15], [1.88, 4.22], [1.82, 4.4], [1.4, 4.7], [0.55, 4.85], [0.5, 5.2], [0.65, 5.5], [0.55, 5.75], [0, 5.8]];
  const geo = lathe(prof, 28);
  const np = prof.length;
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.3, 0.3 + uv.getY(i) * 0.06); // turning rings
  paintColors(geo, (x, y, z, nx, ny, nz, o, i) => {
    const j = i % np;
    const k = j === 6 || j === 7 ? 0.35 : 1 - 0.08 * Math.sin(y * 31);
    o[0] = k; o[1] = k; o[2] = k;
  });
  const mat = new THREE.MeshPhysicalMaterial({ map: wood, color: wood ? C('#7a4a2e') : C('#4a2410'), vertexColors: true, roughness: 0.38, clearcoat: 0.4, clearcoatRoughness: 0.3 });
  const shaker = new THREE.Group();
  shaker.name = 'sansho';
  shaker.add(new THREE.Mesh(geo, mat));
  shade(shaker);
  const J = STATIONS.jar;
  shaker.position.set(J.x + 4, 0, J.z + 2);
  shaker.userData.rest = { pos: shaker.position.clone(), rot: new THREE.Euler(0, 0, 0) };
  shaker.userData.height = 5.8;
  return shaker;
}

function buildSanshoDish() {
  const g = new THREE.Group();
  g.name = 'sansho-dish';
  const dish = new THREE.Mesh(
    lathe([[0, 0], [2.2, 0], [2.4, 0.2], [3.3, 1.5], [3.5, 1.95], [3.35, 2.02], [3.0, 1.55], [2.1, 0.55], [0, 0.45]], 28),
    new THREE.MeshPhysicalMaterial({ color: C('#24180e'), roughness: 0.3, clearcoat: 0.6, clearcoatRoughness: 0.2 }),
  );
  const pGeo = new THREE.SphereGeometry(1.7, 18, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  pGeo.scale(1, 0.32, 1);
  pGeo.translate(0.2, 0.45, 0.1);
  const lo = C('#4d3518'), hi = C('#9d794b'), tc = new THREE.Color();
  paintColors(pGeo, (x, y, z, nx, ny, nz, o) => {
    tc.copy(lo).lerp(hi, hash2(Math.round(x * 40), Math.round(z * 40)));
    o[0] = tc.r; o[1] = tc.g; o[2] = tc.b;
  });
  const powder = new THREE.Mesh(pGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  g.add(dish, powder);
  shade(g);
  return g;
}

function buildCloth(tex) {
  const ct = pick(tex.cloth, 'map', 'color'), cn = sub(tex.cloth, 'normal');
  const geo = new RoundedBoxGeometry(16, 1.5, 11, 3, 0.55);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    if (y > 0.3) p.setY(i, y + 0.06 * Math.sin(x * 0.8 + z * 0.5) - 0.12 * Math.exp(-((z - 1.2) ** 2) / 0.3));
  }
  geo.computeVertexNormals();
  planarUV(geo, 12, 12, 12, 8, 0, 5.5); // cloth tile 12 cm
  const cloth = new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({
    map: tiling(ct), normalMap: tiling(cn), color: ct ? 0xffffff : C('#2d3f63'), roughness: 0.95, sheen: 0.5, sheenRoughness: 0.8, sheenColor: C('#c8cbd8'),
  }));
  cloth.name = 'cloth';
  cloth.position.set(-60, 0.75, -26);
  cloth.rotation.y = 0.14;
  shade(cloth);
  return cloth;
}

function buildPickles(tex) {
  const g = new THREE.Group();
  g.name = 'pickles';
  const geo = lathe([[0, 0], [3.0, 0], [3.4, 0.3], [4.6, 1.6], [5.0, 2.4], [4.85, 2.55], [4.4, 2.1], [3.2, 0.9], [0, 0.8]], 40);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + 0.06 * Math.cos(5 * Math.atan2(z, x)) * smooth(0.5, 2.5, y);
    p.setXYZ(i, x * k, y, z * k);
  }
  geo.computeVertexNormals();
  const duv = geo.attributes.uv;
  for (let i = 0; i < duv.count; i++) duv.setXY(i, duv.getX(i) * 0.83, clamp(p.getY(i) / 2.55, 0, 1));
  const stoneT = callTex(tex.lib, 'stoneware', '#e0c4a3', '#935832', { ...tex.q, lip: '#935832' });
  const stone = pick(stoneT, 'map', 'color'), stoneR = sub(stoneT, 'rough');
  const dish = new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({
    map: stone, color: stone ? 0xffffff : C('#e0c4a3'), roughnessMap: stoneR, roughness: stoneR ? 1 : 0.4, clearcoat: 0.4, clearcoatRoughness: 0.3,
  }));
  g.add(dish);

  const cap = canvasTex(128, 128, (c, w) => {
    const r = w / 2;
    const grd = c.createRadialGradient(r, r, 0, r, r, r);
    grd.addColorStop(0, '#c9bd70');
    grd.addColorStop(0.55, '#b1a144');
    grd.addColorStop(0.86, '#9c8e34');
    grd.addColorStop(0.9, '#524804');
    grd.addColorStop(1, '#413a04');
    c.fillStyle = grd;
    c.fillRect(0, 0, w, w);
    c.fillStyle = 'rgba(208,196,138,0.85)';
    for (let k = 0; k < 9; k++) {
      const a = (k / 9) * Math.PI * 2;
      c.beginPath();
      c.ellipse(r + Math.cos(a) * r * 0.36, r + Math.sin(a) * r * 0.36, r * 0.09, r * 0.05, a, 0, Math.PI * 2);
      c.fill();
    }
  });
  const cuc = new THREE.InstancedMesh(new THREE.CylinderGeometry(1.4, 1.4, 0.38, 20), [
    new THREE.MeshPhysicalMaterial({ color: C('#3c3606'), roughness: 0.35, clearcoat: 0.5 }),
    new THREE.MeshPhysicalMaterial({ map: cap, color: cap ? 0xffffff : C('#b1a144'), roughness: 0.35, clearcoat: 0.4 }),
    new THREE.MeshPhysicalMaterial({ map: cap, color: cap ? 0xffffff : C('#b1a144'), roughness: 0.35 }),
  ], 4);
  const d = new THREE.Object3D();
  for (let k = 0; k < 4; k++) {
    d.position.set(-2.2 + k * 1.15, 1.25 + k * 0.12, -0.6 + k * 0.25);
    d.rotation.set(0.05, k * 0.4, -0.22);
    d.updateMatrix();
    cuc.setMatrixAt(k, d.matrix);
  }
  cuc.name = 'cucumber';
  g.add(cuc);
  const half = new THREE.Shape();
  half.absarc(0, 0, 1.75, 0, Math.PI, false);
  half.lineTo(1.75, 0);
  const tGeo = new THREE.ExtrudeGeometry(half, { depth: 0.4, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 1, curveSegments: 12 });
  tGeo.rotateX(-Math.PI / 2);
  const tak = new THREE.InstancedMesh(tGeo, new THREE.MeshPhysicalMaterial({ color: C('#efc887'), roughness: 0.35, clearcoat: 0.4 }), 2);
  for (let k = 0; k < 2; k++) {
    d.position.set(1.6 + k * 0.5, 1.0 + k * 0.4, 1.6 - k * 0.3);
    d.rotation.set(0.1 * k, 2.6 + k * 0.5, 0.1);
    d.updateMatrix();
    tak.setMatrixAt(k, d.matrix);
  }
  tak.name = 'takuan';
  g.add(tak);
  shade(g);
  return g;
}

function buildSoup(blackMat) {
  const g = new THREE.Group();
  g.name = 'soup';
  const bowl = new THREE.Mesh(
    lathe([[0, 0.6], [2.9, 0.6], [3.0, 0], [3.6, 0], [3.7, 0.8], [5.2, 2.6], [5.9, 5.0], [6.0, 7.2], [5.85, 7.5], [5.6, 7.25], [5.42, 5.0], [4.7, 2.9], [3.0, 1.45], [0, 1.25]], 44),
    blackMat,
  );
  const brothGeo = new THREE.CircleGeometry(5.5, 44);
  brothGeo.rotateX(-Math.PI / 2);
  const broth = new THREE.Mesh(brothGeo, new THREE.MeshPhysicalMaterial({ color: C('#3a3114'), roughness: 0.03, clearcoat: 1, clearcoatRoughness: 0.02 }));
  broth.position.y = 6.3;
  const leaf = canvasTex(128, 128, (c, w) => {
    c.clearRect(0, 0, w, w);
    const r = w / 2;
    for (let k = 0; k < 3; k++) {
      const a = -Math.PI / 2 + (k - 1) * 1.15;
      c.save();
      c.translate(r, r * 1.1);
      c.rotate(a + Math.PI / 2);
      c.fillStyle = '#4d5b11';
      c.beginPath();
      c.ellipse(0, -r * 0.42, r * 0.26, r * 0.4, 0, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = '#6a7a20';
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(0, -r * 0.05);
      c.lineTo(0, -r * 0.78);
      c.stroke();
      c.restore();
    }
  });
  if (leaf) {
    const lGeo = new THREE.PlaneGeometry(3.4, 3.4);
    lGeo.rotateX(-Math.PI / 2);
    const lm = new THREE.Mesh(lGeo, new THREE.MeshStandardMaterial({ map: leaf, alphaTest: 0.5, roughness: 0.45, side: THREE.DoubleSide }));
    lm.position.set(0.8, 6.33, -0.5);
    lm.rotation.y = 0.7;
    g.add(lm);
  }
  g.add(bowl, broth);
  shade(g);
  return g;
}

function buildOke(tex) {
  const g = new THREE.Group();
  g.name = 'oke';
  const map = pick(tex.board, 'map', 'color');
  const geo = lathe([[0, 0.2], [12.4, 0.2], [12.6, 0], [13.0, 0.3], [13.2, 13], [12.9, 13.3], [12.5, 13], [12.3, 1.6], [0, 1.5]], 48);
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.2 + uv.getY(i) * 0.25, 0.05 + uv.getX(i) * 0.9); // staves: grain upright
  const tub = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map, color: map ? C('#f2dcc0') : C('#d8b48a'), roughness: 0.62 }));
  const bands = [3.2, 10.2].map((y) => {
    const b = new THREE.TorusGeometry(13.05 + (y - 3.2) * 0.02, 0.32, 6, 56).toNonIndexed();
    b.rotateX(Math.PI / 2);
    b.translate(0, y, 0);
    return b;
  });
  const copper = new THREE.Mesh(mergeGeometries(bands), new THREE.MeshStandardMaterial({ color: C('#b87333'), metalness: 1, roughness: 0.35 }));
  g.add(tub, copper);
  shade(g);
  return g;
}

// ================================================================ entry
// contact shadow: a flat quad just above the counter with a soft rounded-rect (or round) falloff
const shadowTex = {};
function groundShadow(x, z, w, d, opacity, round) {
  const key = round ? 'r' : 'q';
  if (!shadowTex[key]) {
    const W = round ? 64 : 128, H = 64;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    const img = g.createImageData(W, H);
    for (let y = 0; y < H; y++) {
      for (let xx = 0; xx < W; xx++) {
        const u = Math.abs((xx + 0.5) / W - 0.5) * 2, v = Math.abs((y + 0.5) / H - 0.5) * 2;
        // 0 inside the footprint .. 1 at the quad's edge
        const dd = round ? clamp((Math.hypot(u, v) - 0.72) / 0.28, 0, 1) : Math.min(1, Math.hypot(Math.max(0, u - 0.82) / 0.18, Math.max(0, v - 0.7) / 0.3));
        img.data[(y * W + xx) * 4 + 3] = Math.round(255 * (1 - dd) ** 2);
      }
    }
    g.putImageData(img, 0, 0);
    shadowTex[key] = new THREE.CanvasTexture(c);
  }
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ map: shadowTex[key], color: 0x000000, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, 0.03, z);
  m.renderOrder = -1;
  m.name = 'contact-shadow';
  return m;
}

// buildProps(scene, T) → handles; T is the textures.js namespace. opts.low halves the rice grains etc.
export function buildProps(scene, lib = T, opts = {}) {
  // textures.js has its own quality switch (setTextureQuality): only override it when asked
  const q = opts.low !== undefined ? { low: !!opts.low } : undefined;
  const o = { low: !!opts.low };
  const tex = {
    lib, q: q || {}, env: scene.environment || null,
    counter: callTex(lib, 'counterWood', q),
    board: callTex(lib, 'boardWood', q),
    konro: callTex(lib, 'konroWalls', q),
    coal: callTex(lib, 'coalTexture', q),
    ember: callTex(lib, 'emberTexture', q),
    ash: callTex(lib, 'ashTexture', q),
    lacquer: callTex(lib, 'lacquerTextures', q),
    rice: callTex(lib, 'riceTextures', q),
    cloth: callTex(lib, 'clothTexture', q),
  };
  const root = new THREE.Group();
  root.name = 'props';

  const room = buildRoom(tex);
  root.add(room.group);
  const board = buildBoard(tex);
  root.add(board);
  const grill = buildGrill(tex, o);
  root.add(grill.group);
  const box = buildBox(tex, o);
  root.add(box.group);
  // the tare trough replaces the old jar and brush (the fish itself is dipped)
  const trough = buildTareTrough(tex, o);
  root.add(trough.group);

  const sansho = buildSansho(tex);
  root.add(sansho);
  const sanshoDish = buildSanshoDish();
  sanshoDish.position.set(STATIONS.jar.x - 2, 0, STATIONS.jar.z + 5);
  root.add(sanshoDish);
  const cloth = buildCloth(tex);
  root.add(cloth);
  const pickles = buildPickles(tex);
  pickles.position.set(STATIONS.box.x + 27, 0, STATIONS.box.z + 18); // front right, clear of the soup and of the pieces waiting in front of the box
  pickles.rotation.y = -0.5;
  root.add(pickles);
  const soup = buildSoup(box.materials.black);
  soup.position.set(STATIONS.box.x + 26, 0, STATIONS.box.z - 2);
  root.add(soup);
  const oke = buildOke(tex);
  oke.position.set(STATIONS.board.x - 48, 0, -35);
  root.add(oke);
  scene.add(root);
  root.updateMatrixWorld(true);
  // soft contact darkening where things stand on the counter (the sun's soft shadow alone lets them float)
  const G = STATIONS.grill, Tr = STATIONS.tare, Bx = STATIONS.box, Bd = STATIONS.board;
  root.add(groundShadow(G.x, G.z, G.w + 4, G.d + 4, 0.5, false));
  root.add(groundShadow(Tr.x, Tr.z, Tr.len + 4, Tr.w + 4, 0.5, false));
  root.add(groundShadow(Bx.x, Bx.z, Bx.w + 3, Bx.d + 3, 0.55, false));
  root.add(groundShadow(Bd.x, Bd.z, Bd.w + 2, Bd.d + 2, 0.35, false));
  for (const o of [box.lid, soup, pickles, oke, sanshoDish]) {
    const bb = new THREE.Box3().setFromObject(o);
    if (bb.isEmpty() || bb.min.y > 1.5) continue;
    const c = bb.getCenter(new THREE.Vector3()), sz = bb.getSize(new THREE.Vector3());
    const round = o !== box.lid;
    root.add(groundShadow(c.x, c.z, sz.x * 1.12 + 1, sz.z * 1.12 + 1, round ? 0.45 : 0.5, round));
  }

  // tools are direct children of the scene: the director moves them in world space
  const knife = buildKnife(tex, board, tex.env);
  scene.add(knife);

  const props = {
    root, counter: room.counter, room, board, grill, box, trough, knife, sansho, cloth,
    dishes: { pickles, soup, sanshoDish, oke, lid: box.lid },
    update(t) {
      grill.update(t);
      trough.update(t);
    },
    // back to the start of a round: fresh rice, tools home
    reset() {
      box.reset();
      for (const tool of [knife, sansho]) {
        const r = tool.userData.rest;
        tool.position.copy(r.pos);
        tool.rotation.copy(r.rot);
        tool.visible = true;
      }
    },
  };
  return props;
}
