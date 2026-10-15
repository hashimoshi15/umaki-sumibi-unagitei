import * as THREE from 'three';
import { FISH, BOX, STATIONS, SKEWER_LEN, bodyRadius, thickness } from '../config.js';
import { FLESH, SKIN } from '../model/fish.js';
import { clamp, smooth, hash2 } from '../util.js';

// One mesh is the eel from start to finish. It is a slab (flesh on top, skin underneath) that
// starts wrapped into the round body, parts along the knife line, unrolls flat, curls a little on
// the grill, and finally is split into the three pieces. Colours come from the model's per-cell
// cook / char / tare / glaze values, so what you see is what is scored.
const RU = Math.round(FISH.L * 3) + 1; // rows along the length (u), 1/3 cm apart
const RS = 41;           // columns across (arc / width): enough for the two rounded lobes per half
const OPEN_SCALE = 0.74; // the flat fillet is narrower than the body's circumference

// Cross profile of the opened flesh (sw 0 seam .. 1 edge, sd 0 far / 1 near half), relative height.
// BAND_GLSL below is the same function for the colour shader.
const gss = (x, m, w) => Math.exp(-(((x - m) / w) ** 2));
function bandAt(sw, u, sd) {
  const wob = 0.03 * Math.sin(u * 0.23 + sd * 1.7);
  return 1 - 0.12 * gss(sw, 0, 0.08) - 0.08 * gss(sw, 0.45 + wob, 0.09) - 0.03 * gss(sw, 0.78 - wob, 0.06) + 0.04 * gss(sw, 0.22, 0.13) + 0.03 * gss(sw, 0.62, 0.11);
}
const BAND_GLSL = `
  float gss(float x, float m, float w) { float d = (x - m) / w; return exp(-d * d); }
  float bandAt(float sw, float u, float sd) {
    float wob = 0.03 * sin(u * 0.23 + sd * 1.7);
    return 1.0 - 0.12 * gss(sw, 0.0, 0.08) - 0.08 * gss(sw, 0.45 + wob, 0.09) - 0.03 * gss(sw, 0.78 - wob, 0.06) + 0.04 * gss(sw, 0.22, 0.13) + 0.03 * gss(sw, 0.62, 0.11);
  }`;

// Pieces in the box are longer than the box is deep: where one reaches the rim it rises onto the lip
// and past the outer wall it hangs down a little. Done in the vertex shader in world space (the piece
// holders only turn about y), per piece, so the cut faces at its ends follow too.
const DRAPE_GLSL = `
  uniform float uDrape; uniform vec4 uBox; uniform vec3 uRim;
  float drapeDy(vec3 wp) {
    float d = max(abs(wp.z - uBox.y) - uBox.w, abs(wp.x - uBox.x) - uBox.z);
    float lift = max(0.0, uRim.x + 0.05 - uRim.z) * smoothstep(-1.4, 0.0, d);
    float out_ = max(0.0, d - uRim.y);
    // stiff enough to rest on the lip and tip a little, not hang like cloth
    return uDrape * (lift - min(0.75, 0.26 * out_ + 0.04 * out_ * out_));
  }`;
export function drapeUniforms() {
  const X = STATIONS.box;
  return {
    uDrape: { value: 0 },
    uBox: { value: new THREE.Vector4(X.x, X.z, BOX.inner.x, BOX.inner.z) },
    uRim: { value: new THREE.Vector3(X.h, (X.d - 2 * BOX.inner.z) / 2, X.rice) },
  };
}
function addDrape(sh, du) {
  Object.assign(sh.uniforms, du);
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\n' + DRAPE_GLSL)
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n transformed.y += drapeDy((modelMatrix * vec4(transformed, 1.0)).xyz);');
}

export function createFishMaterial(tex, opts = {}) {
  // the 12 cm pattern tile is mirrored along the fish so its repeats never meet at a hard seam
  for (const t of [tex.pattern, tex.normal]) {
    if (!t) continue;
    t.wrapS = THREE.MirroredRepeatWrapping;
    t.needsUpdate = true;
  }
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.5, metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.3,
    sheen: 0.45, sheenRoughness: 0.55, sheenColor: new THREE.Color().setRGB(1, 0.92, 0.86, THREE.SRGBColorSpace),
    normalMap: tex.normal, normalScale: new THREE.Vector2(0.95, 0.95),
    // the fine muscle relief also breaks up the wet / glazed highlights into small glints
    clearcoatNormalMap: tex.normal, clearcoatNormalScale: new THREE.Vector2(0.4, 0.4),
    envMapIntensity: 0.8,
  });
  mat.userData.tex = tex;
  // the whole fish (not the plated pieces): darkens to an amber tint where it is under the tare surface
  const tu = opts.tare ? { uSurf: { value: STATIONS.tare.surf }, uTrough: { value: new THREE.Vector4(STATIONS.tare.x, STATIONS.tare.z, STATIONS.tare.inner.x, STATIONS.tare.inner.z) } } : null;
  if (tu) {
    mat.defines = { ...(mat.defines || {}), TARE_TINT: '' };
    mat.customProgramCacheKey = () => 'fish-tare';
  }
  const du = opts.drape ? drapeUniforms() : null;
  if (du) {
    mat.userData.drape = du;
    mat.customProgramCacheKey = () => 'fish-drape';
  }
  mat.onBeforeCompile = (sh) => {
    if (du) addDrape(sh, du);
    sh.uniforms.tPat = { value: tex.pattern };
    sh.uniforms.uTime = { value: 0 };
    if (tu) Object.assign(sh.uniforms, tu);
    mat.userData.shader = sh;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aCook;   // x doneness, y char, z glaze, w wet tare
        attribute vec4 aMisc;   // x face (0 flesh, 1 skin, 0.5 cut edge), y dorsal (0 belly..1 back), z torn centre, w sizzle
        varying vec4 vCook; varying vec4 vMisc; varying vec2 vFishUv;
        #ifdef TARE_TINT
        varying vec3 vWorldP;
        #endif`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vCook = aCook; vMisc = aMisc; vFishUv = uv;
        #ifdef TARE_TINT
        vWorldP = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D tPat; uniform float uTime;
        varying vec4 vCook; varying vec4 vMisc; varying vec2 vFishUv;
        #ifdef TARE_TINT
        varying vec3 vWorldP; uniform float uSurf; uniform vec4 uTrough;
        #endif
        vec3 lin(vec3 c) { return pow(c, vec3(2.2)); }
        float fSkin; float fGlaze; float fWet; float fDone; float fSpot; float fFilm; float fBead; float fRaw; float fGk; float fEdge; float fCrest; float fToks = 0.0;
        ` + BAND_GLSL)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec4 pat = texture2D(tPat, vFishUv);        // r chevron muscle, g fine noise (top = fat beads), b blotch
        float D = vCook.x, tb = vCook.y, gl = vCook.z, wet = vCook.w;
        float face = vMisc.x, dorsal = vMisc.y, torn = vMisc.z;
        float grain = pat.r - 0.5, fine = pat.g, blot = pat.b;
        fSkin = step(0.75, face);
        float edge = step(0.25, face) * (1.0 - fSkin);
        fEdge = edge;
        float et = clamp((face - 0.4) / 0.2, 0.0, 1.0); // side walls: 0 at the flesh edge .. 1 at the skin edge
        float wcm = (vFishUv.y - 0.5) * 12.0;
        fDone = smoothstep(0.25, 0.85, D);
        fRaw = (1.0 - fDone) * (1.0 - fSkin);
        // the long muscle bands (same profile as the geometry): +1 on a crest, -1 in a groove
        float crest = clamp((bandAt(dorsal, vFishUv.x * 12.0, step(0.5, vFishUv.y)) - 0.985) / 0.05, -1.0, 1.0) * (1.0 - fSkin) * (1.0 - edge);
        fCrest = crest;
        // browning starts as golden blisters on the band crests and the fat beads; the mean stays the model's D
        // (broken up along the length by the blotches, so crests read as blisters, not stripes)
        fSpot = smoothstep(0.45, 0.8, 0.42 * max(crest, 0.0) * (0.3 + 1.4 * blot) + 0.35 * smoothstep(0.8, 0.95, fine) + 0.2 * blot);
        float Dv = D + (blot - 0.5) * 0.08 + 0.3 * smoothstep(0.8, 1.0, dorsal) * (1.0 - fSkin) + 0.05 * crest;
        float Ds = Dv + 0.45 * (fSpot - 0.35);
        // --- raw: pale grey-pink and translucent, very soft striations, a pink line on the seam,
        // the thin edges greyer where the skin shows through (reference 03/04)
        vec3 raw = mix(lin(vec3(0.78, 0.7, 0.71)), lin(vec3(0.91, 0.87, 0.88)), clamp(0.42 + grain * 0.8 + (fine - 0.5) * 0.2, 0.0, 1.0));
        raw += 0.12 * smoothstep(0.1, 0.4, grain);
        // pale on the band crests, warmer peach down in the grooves (reference 03)
        raw = mix(raw, mix(lin(vec3(0.796, 0.58, 0.478)), lin(vec3(0.91, 0.855, 0.827)), 0.5 + 0.5 * crest), 0.4 * (1.0 - fSkin));
        raw = mix(raw, lin(vec3(0.83, 0.6, 0.6)), exp(-pow(wcm / 0.09, 2.0)) * 0.45);
        raw = mix(raw, lin(vec3(0.6, 0.59, 0.64)), smoothstep(0.78, 1.0, dorsal) * 0.6);
        // --- white-grilled: milky ivory with golden spots, specks only where it really browned
        vec3 ivory = mix(lin(vec3(0.878, 0.741, 0.584)), lin(vec3(0.918, 0.831, 0.729)), clamp(0.5 + 0.35 * crest + grain * 0.15, 0.0, 1.0));
        vec3 toast = lin(vec3(0.79, 0.54, 0.27));
        vec3 brown = lin(vec3(0.54, 0.31, 0.12));
        vec3 speck = lin(vec3(0.32, 0.14, 0.05));
        vec3 charC = lin(vec3(0.1, 0.04, 0.02));
        vec3 flesh = mix(raw, ivory, fDone);
        flesh = mix(flesh, toast, smoothstep(0.6, 1.12, Ds + 0.12 * (blot - 0.5)) * 0.82);
        flesh = mix(flesh, brown, smoothstep(1.18, 1.62, Ds) * 0.8);
        flesh = mix(flesh, speck, smoothstep(1.0, 1.45, Dv) * smoothstep(0.92, 0.98, fine) * (0.25 + 0.5 * max(crest, 0.0)));
        // burns show where they happen: on the crests and the thin outer edges first
        flesh = mix(flesh, charC, smoothstep(1.85, 2.3, Dv + 0.2 * crest) * 0.5);
        flesh = mix(flesh, lin(vec3(0.62, 0.53, 0.47)), torn * 0.5);
        // --- skin: countershaded raw (silver belly, bronze flank, near-black back) -> dark cooked
        // (dorsal 0 belly .. 1 back line; from the usual camera you see roughly 0.5..1, so the silvery
        // flank band reaches high and only the last stretch to the back line is near-black)
        vec3 skinRaw = mix(lin(vec3(0.84, 0.82, 0.78)), lin(vec3(0.7, 0.69, 0.63)), smoothstep(0.15, 0.4, dorsal));
        skinRaw = mix(skinRaw, lin(vec3(0.5, 0.5, 0.45)), smoothstep(0.4, 0.62, dorsal));
        skinRaw = mix(skinRaw, lin(vec3(0.28, 0.28, 0.26)), smoothstep(0.62, 0.78, dorsal));
        skinRaw = mix(skinRaw, lin(vec3(0.14, 0.15, 0.15)), smoothstep(0.78, 0.9, dorsal));
        skinRaw = mix(skinRaw, lin(vec3(0.07, 0.075, 0.08)), smoothstep(0.9, 0.99, dorsal));
        skinRaw *= 0.92 + 0.16 * blot;
        vec3 skinCk = mix(lin(vec3(0.275, 0.169, 0.082)), lin(vec3(0.118, 0.059, 0.016)), smoothstep(0.15, 0.8, dorsal));
        skinCk = mix(skinCk, lin(vec3(0.475, 0.341, 0.263)), smoothstep(0.7, 0.95, blot) * 0.5);
        vec3 skin = mix(skinRaw, skinCk, fDone) * (0.9 + 0.15 * fine);
        skin = mix(skin, lin(vec3(0.06, 0.03, 0.015)), smoothstep(1.9, 2.4, Dv) * 0.8);
        vec3 col = mix(flesh, skin, fSkin);
        // cut sides: show each face's own cooking a little darker, so browning underneath peeks out at
        // the edges (a cue to turn it, read from the food rather than a meter)
        col = mix(col, col * 0.72, edge);
        // side walls: below the flesh a thin pale fat line, then the dark skin line at the bottom
        vec3 fatC = mix(lin(vec3(0.894, 0.839, 0.8)), lin(vec3(0.86, 0.68, 0.45)), fDone);
        col = mix(col, fatC, edge * smoothstep(0.45, 0.58, et) * (1.0 - smoothstep(0.7, 0.78, et)));
        col = mix(col, mix(lin(vec3(0.196, 0.137, 0.106)), skin, 0.5), edge * smoothstep(0.72, 0.8, et));
        // --- tare: a thin translucent film that tints what is under it (so the muscle lines and
        // toast still read through it): amber at one coat, deep amber, dark caramel with layers
        fGlaze = clamp(gl, 0.0, 2.6);
        float gk = smoothstep(0.05, 0.8, fGlaze + (blot - 0.5) * 0.3);
        fGk = gk;
        // the tare pools in the long grooves and thins over the crests (not along every fine line)
        float thick = gk * (clamp(0.9 - 0.6 * crest - 0.25 * grain + 0.4 * (blot - 0.5), 0.15, 1.6) * (0.6 + 0.4 * smoothstep(0.3, 1.9, fGlaze)) + 0.22 * smoothstep(0.6, 1.6, fGlaze));
        // over the 白焼き ivory: one coat sets to about #a15718, the finished base to about #753218
        vec3 thinT = lin(vec3(0.62, 0.32, 0.14)), thickT = lin(vec3(0.4, 0.17, 0.08));
        vec3 coat = col * mix(thinT, thickT, smoothstep(0.15, 1.5, thick));
        col = mix(col, coat, gk);
        // dark pooled grooves, lighter amber on the crests
        col *= mix(1.0, 0.82, max(-crest, 0.0) * gk * smoothstep(0.4, 1.4, fGlaze));
        col = mix(col, lin(vec3(0.647, 0.294, 0.075)), max(crest, 0.0) * gk * 0.08 * (1.0 - smoothstep(1.3, 1.8, D)));
        // fresh tare still wet on the surface (just out of the trough): an amber-brown film, darker
        // where it is thick, that the grilling then sets into glaze
        fWet = clamp(wet * 1.8, 0.0, 1.0);
        // half a see-through tint (toast spots still show) and half the liquid's own colour:
        // amber #be5e10 where thin, #922f06 where it is thick or pooled
        vec3 wetC = mix(lin(vec3(0.745, 0.369, 0.063)), lin(vec3(0.573, 0.184, 0.024)), smoothstep(0.4, 1.2, wet - 0.3 * crest));
        col = mix(col, mix(col * lin(vec3(0.62, 0.3, 0.1)), wetC, 0.5), fWet * 0.9);
        // grilled-on tare: dark caramelised flecks where the surface browned most
        // (in spots: broken by the fine noise, so they never line up along a crest)
        col = mix(col, lin(vec3(0.12, 0.04, 0.02)), smoothstep(1.22, 1.72, Ds) * smoothstep(0.45, 0.85, fSpot) * max(crest, 0.0) * smoothstep(0.55, 0.85, fine) * gk * 0.85);
        col *= 1.0 - 0.1 * smoothstep(0.12, 0.42, grain) * smoothstep(1.6, 1.9, D) * gk;
        col = mix(col, lin(vec3(0.16, 0.055, 0.025)), smoothstep(0.86, 1.0, dorsal) * gk * smoothstep(1.1, 1.6, D) * 0.7 * (1.0 - fSkin));
        float fs = texture2D(tPat, vFishUv * 1.7 + 0.37).g; // round flecks, not streaks along the length
        col = mix(col, lin(vec3(0.1, 0.035, 0.015)), smoothstep(1.4, 1.85, Dv) * smoothstep(0.8, 0.92, fs) * max(crest, 0.0) * smoothstep(0.45, 0.8, blot) * gk * 0.8);
        // charred edges and blisters stay black through the glaze; burnt tare leaves black specks
        col = mix(col, charC, smoothstep(1.85, 2.3, Dv) * (0.55 + 0.4 * smoothstep(0.4, 0.8, fine)));
        col = mix(col, charC, smoothstep(0.4, 1.0, tb) * smoothstep(0.45, 0.75, fine));
        // local oil film on the glaze and tiny fat beads / tare bubbles (white-grilled and glazed)
        fFilm = smoothstep(0.62, 0.8, blot * 0.7 + fine * 0.3) * smoothstep(0.3, 1.2, fGlaze);
        fBead = smoothstep(0.92, 0.97, fine) * clamp(smoothstep(0.45, 0.9, D) * (1.0 - smoothstep(1.6, 2.0, D)) + vMisc.w + smoothstep(0.6, 1.4, fGlaze) * 0.7, 0.0, 1.0) * (1.0 - fSkin);
        fBead *= 1.0 - smoothstep(1.0, 3.0, length(fwidth(vFishUv * 1024.0)));
        col = mix(col, col * 1.1, fBead * 0.3);
        #ifdef TARE_TINT
        // under the tare surface: seen through the dark liquid
        float under = smoothstep(0.0, 1.0, uSurf - vWorldP.y) * step(abs(vWorldP.x - uTrough.x), uTrough.z) * step(abs(vWorldP.z - uTrough.y), uTrough.w);
        col = mix(col, col * vec3(0.16, 0.05, 0.012), under * 0.85);
        #endif
        diffuseColor.rgb = col;`)
      .replace('#include <normal_fragment_maps>', THREE.ShaderChunk.normal_fragment_maps.replace('mapN.xy *= normalScale;', 'float nsk = normalScale.x * (0.75 + 0.45 * smoothstep(0.8, 1.7, vCook.x)) * (1.0 - 0.3 * fGk) * mix(1.0, mix(0.22, 0.12, fDone), fSkin) * mix(0.45, 1.0, fDone) * (1.0 - 0.8 * fEdge); float nLen = length(mapN); fToks = clamp((1.0 - nLen) / max(nLen, 0.2), 0.0, 1.0) * nsk * nsk; mapN.xy *= nsk;'))
      // the tare film is smoother than the flesh under it: a broad wet sheen, not streaks on every ridge
      .replace('#include <clearcoat_normal_fragment_maps>', THREE.ShaderChunk.clearcoat_normal_fragment_maps.replace('clearcoatMapN.xy *= clearcoatNormalScale;', 'clearcoatMapN.xy *= clearcoatNormalScale * mix(1.0, 0.5, smoothstep(0.3, 1.2, vCook.z)) * (1.0 - 0.9 * fSkin) * mix(0.25, 1.0, fDone);'))
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        // raw: moist but soft; white-grilled: matte; skin: slick when raw
        roughnessFactor = mix(mix(0.42, 0.5, fDone), mix(0.3, 0.55, fDone), fSkin);
        // glaze is a satin film with oily patches, not a uniform plastic gloss
        roughnessFactor = mix(roughnessFactor, mix(0.42, 0.22, fFilm), smoothstep(0.3, 1.2, fGlaze) * (1.0 - fSkin * 0.4));
        roughnessFactor = mix(roughnessFactor, 0.07, fWet);
        roughnessFactor = mix(roughnessFactor, 0.07, fBead * (0.6 + 0.4 * sin(uTime * 7.0 + blot * 40.0) * vMisc.w));`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        // specular anti-aliasing (Toksvig): where the mip-averaged normal map is shorter, the relief is
        // finer than a pixel, so widen the lobe instead of letting single glints crawl like scratches
        material.roughness = min(sqrt(material.roughness * material.roughness + 1.5 * fToks), 1.0);
        #ifdef USE_SHEEN
          // raw eel skin: a cool silvery sheen at grazing angles (the slime), not a warm velvet
          material.sheenColor = mix(material.sheenColor, vec3(0.78, 0.82, 0.86), fSkin * (1.0 - fDone));
          material.sheenRoughness = mix(material.sheenRoughness, 0.3, fSkin * (1.0 - fDone));
          material.sheenColor *= max(fSkin * (1.0 - fDone), fRaw * 0.35) * (1.0 - smoothstep(0.1, 0.6, fGlaze));
        #endif
        #ifdef USE_CLEARCOAT
          // a thin wet layer on raw flesh and skin, a thin film on the glaze, small glints on beads
          // the set glaze is a glossy film: crisp highlights from the shoji above (照り)
          material.clearcoat = max(max(smoothstep(0.35, 1.2, fGlaze) * (0.55 + 0.35 * fFilm), fWet * 0.95), max(fRaw * 0.55 + (1.0 - fDone) * fSkin * 0.5, fBead * 0.5));
          material.clearcoatRoughness = mix(mix(0.3, 0.18, fRaw), mix(0.16, 0.1, fFilm), max(smoothstep(0.35, 1.2, fGlaze), fBead));
          material.clearcoatRoughness = mix(material.clearcoatRoughness, 0.06, fWet);
          material.clearcoatRoughness = min(sqrt(material.clearcoatRoughness * material.clearcoatRoughness + 0.3 * fToks), 1.0);
          // raw skin: one long smooth highlight along the back, not crinkles
          material.clearcoatRoughness = mix(material.clearcoatRoughness, 0.2, fSkin * (1.0 - fDone) * (1.0 - smoothstep(0.35, 1.2, fGlaze)));
        #endif`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        // light scattered inside thin, raw (and milky white-grilled) flesh: a soft glow, more at thin edges
        totalEmissiveRadiance += diffuseColor.rgb * (0.05 * fRaw + 0.025 * fDone * (1.0 - fSkin) * (1.0 - smoothstep(0.3, 1.0, fGlaze)));
        totalEmissiveRadiance += 0.06 * fRaw * smoothstep(0.7, 1.0, vMisc.y) * (0.4 + 0.6 * (1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0))) * vec3(0.69, 0.6, 0.71);`);
  };
  return mat;
}

export class FishView {
  constructor(parent, mat, headMat, boneMat) {
    this.group = new THREE.Group();      // fish-local frame: x = u, z = w, y up
    parent.add(this.group);
    this.mat = mat;
    const V = 2 * RU * RS + 4 * RU + 4 * RS;
    this.V = V;
    this.pos = new Float32Array(V * 3);
    this.nrm = new Float32Array(V * 3);
    this.uv = new Float32Array(V * 2);
    this.cook = new Float32Array(V * 4);
    this.misc = new Float32Array(V * 4);
    this.geo = new THREE.BufferGeometry();
    const dyn = (a, n) => new THREE.BufferAttribute(a, n).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', dyn(this.pos, 3));
    this.geo.setAttribute('normal', dyn(this.nrm, 3));
    this.geo.setAttribute('uv', dyn(this.uv, 2));
    this.geo.setAttribute('aCook', dyn(this.cook, 4));
    this.geo.setAttribute('aMisc', dyn(this.misc, 4));
    this.buildIndex();
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(FISH.L / 2, 0, 0), FISH.L);
    // pieces after slicing reuse the same buffers through their own index ranges
    this.pieceGroups = [];
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
    // soft contact shadow under the opened fillet on the board
    this.contact = new THREE.Mesh(new THREE.PlaneGeometry(FISH.L + 1.5, 10), contactMat());
    this.contact.rotation.x = -Math.PI / 2;
    this.contact.position.set(FISH.L / 2, -0.03, 0);
    this.contact.renderOrder = 1;
    this.group.add(this.contact);
    this.head = buildHead(headMat);
    this.group.add(this.head);
    this.bone = buildBone(boneMat);
    this.group.add(this.bone);
    this.skewerMeshes = [];
    this.skewerMat = new THREE.MeshStandardMaterial({ color: 0xc9cbcf, metalness: 1, roughness: 0.28 });
    this.P = new THREE.Vector3();
  }

  top(r, c) { return r * RS + c; }
  bot(r, c) { return RU * RS + r * RS + c; }

  buildIndex() {
    const idx = [];
    for (let r = 0; r < RU - 1; r++) {
      for (let c = 0; c < RS - 1; c++) {
        const a = this.top(r, c), b = this.top(r + 1, c), d = this.top(r, c + 1), e = this.top(r + 1, c + 1);
        idx.push(a, d, b, d, e, b);
        const f = this.bot(r, c), g = this.bot(r + 1, c), h = this.bot(r, c + 1), k = this.bot(r + 1, c + 1);
        idx.push(f, g, h, h, g, k);
      }
    }
    const s0 = 2 * RU * RS, s1 = s0 + 2 * RU, e0 = s1 + 2 * RU, e1 = e0 + 2 * RS;
    for (let r = 0; r < RU - 1; r++) {
      const a = s0 + r * 2, b = s0 + (r + 1) * 2;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
      const c = s1 + r * 2, d = s1 + (r + 1) * 2;
      idx.push(c, c + 1, d, d, c + 1, d + 1);
    }
    for (let c = 0; c < RS - 1; c++) {
      const a = e0 + c * 2, b = e0 + (c + 1) * 2;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
      const d = e1 + c * 2, e = e1 + (c + 1) * 2;
      idx.push(d, e, d + 1, e, e + 1, d + 1);
    }
    this.fullIndex = idx;
    this.geo.setIndex(idx);
  }

  // index list for the rows [r0, r1] only (one piece after slicing)
  pieceIndex(r0, r1) {
    const idx = [];
    for (let r = r0; r < r1; r++) {
      for (let c = 0; c < RS - 1; c++) {
        const a = this.top(r, c), b = this.top(r + 1, c), d = this.top(r, c + 1), e = this.top(r + 1, c + 1);
        idx.push(a, d, b, d, e, b);
        const f = this.bot(r, c), g = this.bot(r + 1, c), h = this.bot(r, c + 1), k = this.bot(r + 1, c + 1);
        idx.push(f, g, h, h, g, k);
      }
    }
    const s0 = 2 * RU * RS, s1 = s0 + 2 * RU;
    for (let r = r0; r < r1; r++) {
      const a = s0 + r * 2, b = s0 + (r + 1) * 2;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
      const c = s1 + r * 2, d = s1 + (r + 1) * 2;
      idx.push(c, c + 1, d, d, c + 1, d + 1);
    }
    return idx;
  }

  // ---- geometry for the current state ----
  // u along the fillet, a in [-1, 1] across (far edge → near edge), face 0 flesh / 1 skin
  update(game, time) {
    const F = game.fish;
    const L = F.L;
    const st = game.step;
    const openG = F.openK;
    const grilling = game.onGrill || st === 'toGrill';
    const puffBase = 1;
    const pos = this.pos, cook = this.cook, misc = this.misc, uv = this.uv;
    const down = game.grill.down;
    for (let r = 0; r < RU; r++) {
      const u = (r / (RU - 1)) * L;
      const i = F.bin(u);
      const R = bodyRadius(u);
      const cutHere = F.cut[i] ? 1 : 0;
      const k = Math.max(openG, cutHere * 0.07 * (1 - openG));
      const th0 = thickness(u);
      const far = F.farW(i), near = F.nearW(i);
      // arc lengths of the two halves around the body (the knife offset rotates the cut)
      const sFar = far / OPEN_SCALE, sNear = near / OPEN_SCALE;
      const Rmid = R - th0 * 0.5;
      // closed: the two halves exactly go round the body; open: they lie flat at the fillet width
      const scale = (Rmid / R) * (1 - openG) + OPEN_SCALE * openG;
      const kap = (1 - k) / Math.max(0.2, Rmid);
      // the flesh puffs as the core cooks
      const kCore = F.K[i * F.M + (F.M >> 1)];
      const th = th0 * (puffBase + 0.18 * smooth(0.6, 1.1, kCore));
      const curl = grilling ? F.sag[i] : 0;
      const loss = F.loss[i];
      for (let c = 0; c < RS; c++) {
        const a = (c / (RS - 1)) * 2 - 1; // -1 far edge .. +1 near edge
        let s = a < 0 ? a * sFar : a * sNear;
        // ragged knife edges: notches along the cut edges
        if (Math.abs(a) > 0.92 && F.rough[i] > 0.02) s *= 1 - F.rough[i] * 0.09 * (0.5 + hash2(r * 7, c > 12 ? 3 : 1));
        const se = s * scale;
        let z, y, nz, ny;
        if (kap > 1e-4) {
          z = Math.sin(kap * se) / kap;
          y = (1 - Math.cos(kap * se)) / kap;
          nz = -Math.sin(kap * se);
          ny = Math.cos(kap * se);
        } else {
          z = se;
          y = 0;
          nz = 0;
          ny = 1;
        }
        // the fillet rests on its skin; a torn centre dips
        const dip = loss * 0.35 * Math.exp(-((se / 1.2) ** 2)) * openG;
        // opened flesh: each half has the long muscle bands of a real 背開き fillet — a deep furrow on
        // the centre seam, a crest, a main groove a little under halfway out, a second crest and a
        // shallow groove before the thin edge. The grooves wander a little along the length. The
        // shader evaluates the same profile (bandAt) so toast, char and pooled tare follow it.
        const half = a < 0 ? far : near;
        const sw = clamp(Math.abs(se) / Math.max(0.5, half), 0, 1);
        const sd = a < 0 ? 0 : 1;
        const thin = 1 - 0.55 * smooth(0.7, 1.0, sw) ** 1.3;
        const band = bandAt(sw, u, sd);
        const relief = 0.55 - 0.2 * smooth(0.8, 1.5, F.D[FLESH][i * F.M + (F.M >> 1)]);
        const topK = 1 + openG * ((1 - relief * (1 - band)) * thin - 1);
        const crestJ = Math.max(0, clamp((band - 0.985) / 0.05, -1, 1));
        const lift = curl * (down === 0 ? 1 : -1) * (0.55 + 0.45 * Math.abs(a)) - openG * (0.1 + 0.32 * smooth(0.6, 1.5, F.D[SKIN][i * F.M + clamp(Math.floor(((a + 1) / 2) * F.M), 0, F.M - 1)])) * sw * sw;
        const cj = clamp(Math.floor(((a + 1) / 2) * F.M), 0, F.M - 1);
        const cell = i * F.M + cj;
        const yBase = th * 0.5 + lift;
        for (let f = 0; f < 2; f++) {
          const o = (f === 0 ? this.top(r, c) : this.bot(r, c));
          const blister = f === 0 ? openG * 0.07 * smooth(0.7, 1.3, F.D[FLESH][cell]) * (0.4 + 0.6 * hash2(r >> 1, c >> 1)) * (0.35 + 0.65 * crestJ) * (1 - smooth(0.85, 1, sw)) : 0;
          const off = f === 0 ? th * topK - th * 0.5 - dip + blister : -th * 0.5;
          // the thin skin reaches a little past the flesh and curls up as it cooks
          const rim = f === 1 && (c === 0 || c === RS - 1) ? openG : 0;
          pos[o * 3] = u;
          pos[o * 3 + 1] = y + ny * off + yBase + rim * (0.02 + 0.12 * smooth(0.6, 1.4, F.D[SKIN][cell]));
          pos[o * 3 + 2] = z + nz * off + rim * Math.sign(a) * 0.22;
          const face = f === 0 ? FLESH : SKIN;
          cook[o * 4] = F.D[face][cell];
          cook[o * 4 + 1] = F.B[face][cell];
          cook[o * 4 + 2] = F.G[face][cell];
          cook[o * 4 + 3] = F.A[face][cell];
          misc[o * 4] = f;
          misc[o * 4 + 1] = Math.abs(a);
          misc[o * 4 + 2] = f === 0 ? smooth(0.25, 0, Math.abs(se)) * loss : 0;
          misc[o * 4 + 3] = grilling && face !== down ? smooth(0.4, 0.9, F.D[down][cell]) * (1 - smooth(1.35, 1.75, F.D[face][cell])) : 0;
          uv[o * 2] = u / 12;
          uv[o * 2 + 1] = (a * (a < 0 ? far : near)) / 12 + 0.5;
        }
      }
    }
    if (this.contact) this.contact.visible = openG > 0.5 && !grilling && st !== 'toGrill' && st !== 'toBoard' && this.mesh.visible;
    this.edges();
    this.normals();
    for (const n of ['position', 'normal', 'uv', 'aCook', 'aMisc']) this.geo.attributes[n].needsUpdate = true;
    if (this.mat.userData.shader) this.mat.userData.shader.uniforms.uTime.value = time;
  }

  edges() {
    const pos = this.pos, cook = this.cook, misc = this.misc, uv = this.uv;
    const s0 = 2 * RU * RS, s1 = s0 + 2 * RU, e0 = s1 + 2 * RU, e1 = e0 + 2 * RS;
    // side walls: face code 0.4 along the flesh edge .. 0.6 along the skin edge, so the shader can
    // shade the strip flesh -> pale fat line -> dark skin line
    const copy = (dst, src) => {
      pos.copyWithin(dst * 3, src * 3, src * 3 + 3);
      cook.copyWithin(dst * 4, src * 4, src * 4 + 4);
      misc.copyWithin(dst * 4, src * 4, src * 4 + 4);
      uv.copyWithin(dst * 2, src * 2, src * 2 + 2);
      misc[dst * 4] = (dst & 1) ? 0.6 : 0.4;
    };
    // the side walls get their own texture span across the thickness (no stretched stripes)
    const dyOf = (t, b) => Math.hypot(pos[t * 3 + 1] - pos[b * 3 + 1], pos[t * 3 + 2] - pos[b * 3 + 2]) / 12;
    for (let r = 0; r < RU; r++) {
      copy(s0 + r * 2, this.top(r, 0));
      copy(s0 + r * 2 + 1, this.bot(r, 0));
      uv[(s0 + r * 2 + 1) * 2 + 1] -= dyOf(this.top(r, 0), this.bot(r, 0));
      copy(s1 + r * 2, this.top(r, RS - 1));
      copy(s1 + r * 2 + 1, this.bot(r, RS - 1));
      uv[(s1 + r * 2 + 1) * 2 + 1] += dyOf(this.top(r, RS - 1), this.bot(r, RS - 1));
    }
    for (let c = 0; c < RS; c++) {
      copy(e0 + c * 2, this.top(0, c));
      copy(e0 + c * 2 + 1, this.bot(0, c));
      uv[(e0 + c * 2 + 1) * 2] -= dyOf(this.top(0, c), this.bot(0, c));
      copy(e1 + c * 2, this.top(RU - 1, c));
      copy(e1 + c * 2 + 1, this.bot(RU - 1, c));
      uv[(e1 + c * 2 + 1) * 2] += dyOf(this.top(RU - 1, c), this.bot(RU - 1, c));
    }
  }

  normals() {
    const pos = this.pos, nrm = this.nrm;
    const grid = (base, sign) => {
      for (let r = 0; r < RU; r++) {
        const r0 = r > 0 ? r - 1 : r, r1 = r < RU - 1 ? r + 1 : r;
        for (let c = 0; c < RS; c++) {
          const c0 = c > 0 ? c - 1 : c, c1 = c < RS - 1 ? c + 1 : c;
          const A = (base + r1 * RS + c) * 3, B = (base + r0 * RS + c) * 3, Cc = (base + r * RS + c1) * 3, D = (base + r * RS + c0) * 3;
          const ux = pos[A] - pos[B], uy = pos[A + 1] - pos[B + 1], uz = pos[A + 2] - pos[B + 2];
          const vx = pos[Cc] - pos[D], vy = pos[Cc + 1] - pos[D + 1], vz = pos[Cc + 2] - pos[D + 2];
          let nx = vy * uz - vz * uy, ny = vz * ux - vx * uz, nz = vx * uy - vy * ux;
          const l = Math.hypot(nx, ny, nz) || 1;
          const o = (base + r * RS + c) * 3;
          nrm[o] = (nx / l) * sign;
          nrm[o + 1] = (ny / l) * sign;
          nrm[o + 2] = (nz / l) * sign;
        }
      }
    };
    grid(0, 1);
    grid(RU * RS, -1);
    const s0 = 2 * RU * RS, s1 = s0 + 2 * RU, e0 = s1 + 2 * RU, e1 = e0 + 2 * RS;
    const side = (dst, a, b) => {
      let x = pos[a * 3] - pos[b * 3], y = pos[a * 3 + 1] - pos[b * 3 + 1], z = pos[a * 3 + 2] - pos[b * 3 + 2];
      const l = Math.hypot(x, y, z) || 1;
      for (let f = 0; f < 2; f++) {
        nrm[(dst + f) * 3] = x / l;
        nrm[(dst + f) * 3 + 1] = y / l;
        nrm[(dst + f) * 3 + 2] = z / l;
      }
    };
    for (let r = 0; r < RU; r++) {
      side(s0 + r * 2, this.top(r, 0), this.top(r, 1));
      side(s1 + r * 2, this.top(r, RS - 1), this.top(r, RS - 2));
    }
    for (let c = 0; c < RS; c++) {
      side(e0 + c * 2, this.top(0, c), this.top(1, c));
      side(e1 + c * 2, this.top(RU - 1, c), this.top(RU - 2, c));
    }
  }

  // ---- head and bone (they leave together) ----
  updateHeadBone(game, dt) {
    const F = game.fish;
    const st = game.step;
    const R = bodyRadius(0);
    // head follows the closed / opening body; after the bone is lifted it goes with it
    const peelK = F.peel / F.L;
    const showBone = F.openK > 0.6 && !F.boneOff;
    this.bone.visible = showBone || (F.boneOff && this.boneGone < 1);
    this.head.position.set(-0.05, R * (1 - F.openK) + F.openK * 0.9, 0);
    this.head.rotation.set(0, 0, 0);
    if (F.openK > 0) {
      // the opened body lies flat, so the head turns onto its side a little
      this.head.rotation.z = -0.05 * F.openK;
    }
    if (st === 'bone' || F.boneOff) {
      const lift = F.boneOff ? 1 : smooth(0, 1, peelK);
      // bone strip arcs up behind the hand
      this.bone.userData.peel = F.peel;
      this.bendBone(F.peel, F.L);
      this.head.position.y += lift * 4;
      this.head.position.x -= lift * 2;
      this.head.rotation.z = 0.5 * lift;
    }
    if (F.boneOff) {
      this.boneGone = Math.min(1, (this.boneGone || 0) + dt * 1.2);
      const k = smooth(0, 1, this.boneGone);
      this.bone.position.set(-30 * k, 10 * k, -18 * k);
      this.head.position.set(-30 * k - 0.05, 4 + 10 * k + 0.9, -18 * k);
      this.head.visible = this.boneGone < 0.99;
      this.bone.visible = this.boneGone < 0.99;
    } else {
      this.boneGone = 0;
      this.head.visible = true;
      this.bone.position.set(0, 0, 0);
    }
    void dt;
  }

  bendBone(peel, L) {
    const pos = this.bone.geometry.attributes.position;
    const base = this.bone.userData.base;
    for (let i = 0; i < pos.count; i++) {
      const x = base[i * 3], y = base[i * 3 + 1], z = base[i * 3 + 2];
      let px = x, py = y;
      if (x < peel) {
        // the lifted part curls up and back toward the hand
        const t = peel - x;
        px = peel - Math.sin(Math.min(t / 6, 1.2)) * 6 - Math.max(0, t - 7.2) * 0.4;
        py = y + (1 - Math.cos(Math.min(t / 6, 1.2))) * 6 + Math.max(0, t - 7.2) * 0.9;
      }
      pos.setXYZ(i, px, py, z);
    }
    pos.needsUpdate = true;
    this.bone.geometry.computeVertexNormals();
    void L;
  }

  // ---- skewers ----
  syncSkewers(game) {
    const F = game.fish;
    const want = F.skewers;
    while (this.skewerMeshes.length < want.length) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, SKEWER_LEN, 8), this.skewerMat);
      m.rotation.x = Math.PI / 2;
      m.castShadow = true;
      m.userData.inK = 0;
      this.group.add(m);
      this.skewerMeshes.push(m);
    }
    this.skewerMeshes.forEach((m, k) => {
      const u = want[k];
      m.visible = u != null;
      if (u == null) return;
      const i = F.bin(u);
      const th = thickness(u);
      m.userData.inK = Math.min(1, m.userData.inK + 0.08);
      const slide = (1 - smooth(0, 1, m.userData.inK)) * 18;
      m.position.set(u, th * 0.5, (F.nearW(i) - F.farW(i)) * 0.5 + slide);
    });
  }

  // ---- pieces (after slicing) ----
  // one piece per span between cuts (2 after the first cut, 3 after the second); each gets cut faces
  makePieces(game) {
    const F = game.fish;
    this.clearPieces();
    const rowOf = (u) => Math.round((u / F.L) * (RU - 1));
    const b = [0, ...[...F.cuts].sort((x, y) => x - y), F.L];
    for (let k = 0; k < b.length - 1; k++) {
      const g = new THREE.BufferGeometry();
      for (const n of ['position', 'normal', 'uv', 'aCook', 'aMisc']) g.setAttribute(n, this.geo.attributes[n]);
      const r0 = rowOf(b[k]), r1 = rowOf(b[k + 1]);
      g.setIndex(this.pieceIndex(r0, r1));
      g.boundingSphere = this.geo.boundingSphere;
      // its own material (same look) so it can drape over the box rim on its own
      const pm = createFishMaterial(this.mat.userData.tex, { drape: true });
      const m = new THREE.Mesh(g, pm);
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      const holder = new THREE.Group();
      holder.add(m);
      // the holder pivots on the piece's own centre so it can be carried and turned
      const mid = (b[k] + b[k + 1]) / 2;
      m.position.x = -mid;
      // a soft contact shadow under the piece (grounds it on the rice / board)
      const iw = F.bin(mid);
      // only as long as the box is deep: the ends past the rims hang free
      const contact = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(b[k + 1] - b[k] + 1.4, 2 * BOX.inner.z + 0.4), F.farW(iw) + F.nearW(iw) + 1.4), contactMat());
      contact.rotation.x = -Math.PI / 2;
      contact.position.set(0, -0.04, (F.nearW(iw) - F.farW(iw)) * 0.5);
      contact.renderOrder = 1;
      holder.add(contact);
      const fm = faceMaterial(pm.userData.drape);
      for (const [r, sgn] of [[r0, -1], [r1, 1]]) {
        const cap = this.cutFace(game, r, sgn, fm);
        cap.position.x = -mid;
        holder.add(cap);
      }
      holder.position.set(mid, 0, 0);
      holder.userData = { k, mid, len: b[k + 1] - b[k], n: b.length - 1, drape: pm.userData.drape, mats: [pm, fm] };
      this.group.add(holder);
      this.pieceGroups.push(holder);
    }
    this.mesh.visible = false;
  }

  // The cut face at row r (reference 10): a thin dark film of tare on top, a tare-soaked band, then
  // white flesh that breaks into short flakes (a jagged, not flat, face), a translucent layer of fat
  // and the thin dark skin underneath. Pinkish and glassy where the core never cooked.
  cutFace(game, r, sgn, faceMat) {
    const F = game.fish, pos = this.pos, cook = this.cook;
    // layers from the glazed top to the skin: a thin tare film, a tare-soaked band, white flesh in
    // flakes, a thin translucent fat layer, then the dark skin
    const LAY = [0, 0.03, 0.07, 0.14, 0.3, 0.5, 0.68, 0.8, 0.87, 0.92, 1];
    const NL = LAY.length;
    const n = RS * NL;
    const P = new Float32Array(n * 3), C = new Float32Array(n * 3), UV = new Float32Array(n * 2);
    const col = (h) => new THREE.Color().setStyle(h, THREE.SRGBColorSpace);
    const glazeA = col('#8a3c12'), glazeB = col('#3f1406'), toast = col('#c99a62'), soak = col('#c8742e');
    const white = col('#ece0cc'), white2 = col('#e2d2bc'), rawPink = col('#dcc4bd'), fat = col('#cbbca8'), skin = col('#1e1712');
    const i = Math.min(F.N - 1, Math.floor((r / (RU - 1)) * F.N));
    for (let c = 0; c < RS; c++) {
      const t0 = this.top(r, c), b0 = this.bot(r, c);
      const D = cook[t0 * 4], G = cook[t0 * 4 + 2];
      const j = clamp(Math.floor((c / (RS - 1)) * F.M), 0, F.M - 1);
      const K = F.K[i * F.M + j];
      const rim = G > 0.2 ? glazeA.clone().lerp(glazeB, smooth(0.4, 1.6, G)) : white2.clone().lerp(toast, smooth(0.9, 1.5, D));
      const inner = white.clone().lerp(rawPink, 1 - smooth(0.7, 1.0, K));
      const soaked = G > 0.2 ? soak.clone().lerp(inner, 0.7) : inner.clone().lerp(toast, 0.15);
      const cols = [rim, rim.clone().lerp(soaked, 0.5), soaked, inner.clone().lerp(soaked, 0.25), inner, inner.clone().lerp(white2, 0.4), inner, white2, fat, skin.clone().lerp(fat, 0.3), skin];
      // flakes: neighbouring columns share a step, each layer breaks a little differently
      const flake = Math.floor(c / 4 + hash2(r, sgn + 3) * 3);
      for (let l = 0; l < NL; l++) {
        const v = c * NL + l, t = LAY[l];
        // flakes are shallow recesses into the cut (never bulging out past the glazed edge); the top
        // and bottom rows stay flush with the glaze and the skin so the face meets them cleanly
        const edge = l <= 1 || l >= NL - 2;
        const jag = edge ? 0 : Math.abs((hash2(flake * 3.1 + l * 0.37, r + sgn * 11) - 0.35) * 0.3 + (hash2(c, l + r) - 0.5) * 0.04) + 0.05 * Math.sin(Math.PI * t);
        for (let a = 0; a < 3; a++) P[v * 3 + a] = pos[t0 * 3 + a] + (pos[b0 * 3 + a] - pos[t0 * 3 + a]) * t;
        P[v * 3] -= sgn * jag;
        // a little darker toward the glazed top and the skin (cheap occlusion), flakes vary in tone
        const tone = (0.88 + 0.12 * hash2(flake, l * 7 + r)) * (0.8 + 0.2 * Math.sin(Math.PI * t));
        C[v * 3] = cols[l].r * tone; C[v * 3 + 1] = cols[l].g * tone; C[v * 3 + 2] = cols[l].b * tone;
        UV[v * 2] = (3 * c) / (RS - 1);
        UV[v * 2 + 1] = t;
      }
    }
    const idx = [];
    for (let c = 0; c < RS - 1; c++) {
      for (let l = 0; l < NL - 1; l++) {
        const a = c * NL + l, b2 = a + 1, d = a + NL, e = d + 1;
        if (sgn > 0) idx.push(a, b2, d, d, b2, e);
        else idx.push(a, d, b2, d, e, b2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('color', new THREE.BufferAttribute(C, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, faceMat);
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false;
    m.userData.cap = true;
    return m;
  }

  clearPieces() {
    const had = this.pieceGroups.length > 0;
    for (const h of this.pieceGroups) {
      h.parent && h.parent.remove(h);
      for (const ch of h.children) ch.geometry.dispose();
      for (const mt of h.userData.mats || []) mt.dispose();
    }
    this.pieceGroups = [];
    this.mesh.visible = true;
    // The pieces share the fish's vertex buffers, so disposing them freed those GPU buffers while the
    // fish's own vertex-array binding still pointed at them (the next plate showed the previous
    // play's glazed fillet). Dispose the fish geometry too: it re-uploads and rebinds on the next draw.
    if (had) this.geo.dispose();
  }

  reset() {
    this.clearPieces();
    for (const m of this.skewerMeshes) {
      m.parent && m.parent.remove(m);
      m.geometry.dispose();
    }
    this.skewerMeshes = [];
    this.boneGone = 0;
    this.bone.visible = false;
    this.head.visible = true;
    this.group.position.set(0, 0, 0);
    this.group.rotation.set(0, 0, 0);
  }
}

// head: a smooth tapered snout continuing the body, with a dark back, pale throat and small eye
function buildHead(mat) {
  // An eel's head continues the body: round at the neck, cheeks just behind the eyes, the top
  // flattening toward a blunt rounded snout that sits a little low. Elliptical cross-sections along
  // the length (uv: u around with the back at 0.75, v neck -> snout, as the head texture expects).
  const g = new THREE.Group();
  const NT = 28, NA = 40, L = FISH.headLen;
  const R0 = bodyRadius(0);
  const shape = (t) => {
    const w = R0 * (1 - 0.42 * t ** 1.8) * (1 + 0.05 * Math.sin(Math.PI * Math.min(1, t * 1.5)));
    const h = R0 * (1 - 0.62 * t ** 1.1);
    const tip = t > 0.86 ? Math.sqrt(Math.max(0, 1 - ((t - 0.86) / 0.14) ** 2)) : 1;
    // just inside the body's skin where the two overlap, so the body covers the joint
    const tuck = 1 - 0.03 * (1 - smooth(0.04, 0.1, t));
    return { w: w * Math.sqrt(tip) * tuck, h: h * tip * tuck, yc: -0.1 * R0 * smooth(0.35, 1, t) };
  };
  const pos = [], uv = [], idx = [];
  for (let k = 0; k <= NT; k++) {
    const t = k / NT;
    const { w, h, yc } = shape(t);
    for (let j = 0; j <= NA; j++) {
      const phi = (j / NA) * Math.PI * 2;
      let y = -Math.sin(phi);
      const z = Math.cos(phi);
      if (y > 0) y *= 1 - 0.18 * smooth(0.2, 0.8, t); // the crown flattens toward the snout
      // a slightly longer lower jaw; the head begins a little inside the body so there is no seam
      pos.push(0.8 - t * L - (y < 0 ? 0.2 * smooth(0.8, 1, t) : 0), yc + y * h, Math.sign(z) * Math.abs(z) ** 0.85 * w);
      uv.push(j / NA, t);
    }
  }
  for (let k = 0; k < NT; k++) {
    for (let j = 0; j < NA; j++) {
      const a = k * (NA + 1) + j, b = a + NA + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const head = new THREE.Mesh(geo, mat);
  head.castShadow = true;
  head.receiveShadow = true;
  g.add(head);
  // small, half-sunk eyes high on the sides (not cartoon-big)
  const eyeMat = new THREE.MeshPhysicalMaterial({ color: 0x14100c, roughness: 0.2, clearcoat: 0.7, clearcoatRoughness: 0.1 });
  const te = 0.7, se = shape(te);
  for (const sgn of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10), eyeMat);
    eye.scale.set(1, 0.85, 0.7);
    eye.position.set(-te * L, se.yc + se.h * 0.42, sgn * se.w * 0.8);
    g.add(eye);
  }
  // pectoral fins just behind the gill opening, translucent brown
  const finGeo = new THREE.CircleGeometry(0.85, 14, -Math.PI * 0.32, Math.PI * 0.64);
  finGeo.scale(1.25, 1, 1);
  const finMat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.42, 0.3, 0.2, THREE.SRGBColorSpace), roughness: 0.5, transparent: true, opacity: 0.82, side: THREE.DoubleSide, depthWrite: false });
  for (const sgn of [-1, 1]) {
    const fin = new THREE.Mesh(finGeo, finMat);
    fin.position.set(0.25, -0.25 * R0, sgn * (R0 * 0.97));
    fin.rotation.set(0, sgn * 0.15, -0.35);
    g.add(fin);
  }
  return g;
}

// backbone strip with little rib bones, lying along the opened centre
function buildBone(mat) {
  const L = FISH.L, segs = 80;
  const geo = new THREE.BoxGeometry(L + 2, 0.32, 0.55, segs, 1, 1);
  geo.translate((L + 2) / 2 - 2, 0.75, 0);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const taper = 1 - 0.7 * smooth(24, L, x);
    pos.setZ(i, z * taper);
    pos.setY(i, pos.getY(i) + Math.sin(x * 2.4) * 0.03);
  }
  const m = new THREE.Mesh(geo, mat);
  m.userData.base = Float32Array.from(pos.array);
  m.castShadow = true;
  m.visible = false;
  return m;
}

// cooked eel flesh breaks into short white flakes: irregular, mostly upright pieces with soft shadowed
// crevices between them (grey-scale, multiplied by the cut face's vertex colours)
let flakeTex = null;
function flakeTexture() {
  if (flakeTex) return flakeTex;
  const W = 256, H = 128;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // white flesh in long upright fibres, split here and there by thin shadowed cracks
  g.fillStyle = 'rgb(232,226,218)';
  g.fillRect(0, 0, W, H);
  for (let k = 0; k < 260; k++) {
    const x = rnd() * W, y = rnd() * H, w = 2 + rnd() * 3, h = 50 + rnd() * 60, a = (rnd() - 0.5) * 0.16, v = 0.97 + rnd() * 0.03;
    for (const dx of [-W, 0, W]) {
      g.save();
      g.translate(x + dx, y);
      g.rotate(a);
      const c0 = Math.round(255 * v);
      g.fillStyle = `rgb(${c0},${c0 - 3},${c0 - 7})`;
      g.beginPath();
      g.ellipse(0, 0, w, h * 0.5, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  }
  for (let k = 0; k < 70; k++) {
    const x = rnd() * W, y = rnd() * H, w = 1 + rnd() * 1.6, h = 18 + rnd() * 50, a = (rnd() - 0.5) * 0.2;
    for (const dx of [-W, 0, W]) {
      g.save();
      g.translate(x + dx, y);
      g.rotate(a);
      g.fillStyle = 'rgba(110,98,90,0.22)';
      g.beginPath();
      g.ellipse(0, 0, w * 0.3 + 0.4, h * 0.5, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  }
  flakeTex = new THREE.CanvasTexture(c);
  flakeTex.colorSpace = THREE.SRGBColorSpace;
  flakeTex.wrapS = THREE.RepeatWrapping;
  return flakeTex;
}

// a soft rounded-rectangle shadow (alpha falls off toward the edges), shared by all contact patches
let contactM = null;
function contactMat() {
  if (contactM) return contactM;
  const W = 128, H = 64;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const img = g.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = Math.max(0, Math.abs((x + 0.5) / W - 0.5) * 2 - 0.62) / 0.38;
      const dy = Math.max(0, Math.abs((y + 0.5) / H - 0.5) * 2 - 0.4) / 0.6;
      const d = Math.min(1, Math.hypot(dx, dy));
      const a = (1 - d) ** 2;
      const o = (y * W + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = 0;
      img.data[o + 3] = Math.round(255 * a);
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  contactM = new THREE.MeshBasicMaterial({ map: t, color: 0x000000, transparent: true, opacity: 0.42, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  return contactM;
}

// cut-face material: white flesh scatters light, so the face stays readable even facing away from the
// window; it drapes with its piece
function faceMaterial(du) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, map: flakeTexture(), roughness: 0.78, side: THREE.DoubleSide, envMapIntensity: 0.6 });
  m.customProgramCacheKey = () => 'cutface-drape';
  m.onBeforeCompile = (sh) => {
    addDrape(sh, du);
    sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += diffuseColor.rgb * 0.06;');
  };
  return m;
}
