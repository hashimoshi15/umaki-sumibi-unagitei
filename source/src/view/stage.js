import * as THREE from 'three';

const S = (r, g, b) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);

// Small warm shop interior rendered once into the environment map (window light for the glaze,
// the lacquer and the steel). Kept tiny so it is cheap to build.
function shopRoom() {
  const s = new THREE.Scene();
  // darker walls: grazing reflections stay dark, so glaze and lacquer keep their colour
  const room = new THREE.Mesh(new THREE.BoxGeometry(10, 6, 10), new THREE.MeshBasicMaterial({ color: S(0.2, 0.165, 0.14), side: THREE.BackSide }));
  room.position.y = 2;
  s.add(room);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshBasicMaterial({ color: S(0.14, 0.1, 0.07) }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.9;
  s.add(floor);
  const win = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.5), new THREE.MeshBasicMaterial({ color: new THREE.Color(7.0, 6.6, 6.0) }));
  win.position.set(-1.5, 2.6, -4.9);
  s.add(win);
  const top = new THREE.Mesh(new THREE.PlaneGeometry(4.5, 3.5), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 2.1, 1.7) }));
  top.position.set(0.5, 4.95, 0.5);
  top.rotation.x = Math.PI / 2;
  s.add(top);
  // a broad dim softbox high in front, and a warm horizon band: wide soft sheens on glaze and lacquer
  const soft = new THREE.Mesh(new THREE.PlaneGeometry(7, 4), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.15, 1.02, 0.86) }));
  soft.position.set(0, 3.6, 4.2);
  soft.lookAt(0, 0, 0);
  s.add(soft);
  const band = new THREE.Mesh(new THREE.PlaneGeometry(9, 1.6), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.9, 0.72, 0.55) }));
  band.position.set(0, 1.4, 4.9);
  band.rotation.y = Math.PI;
  s.add(band);
  // a shoji transom high on the back wall and along the ceiling behind: the play cameras look down at
  // 38-58 degrees, so flat glossy surfaces (the tare, lacquer, glaze tops) reflect exactly this band.
  // Bright slats with dark gaps: a soft striped highlight instead of a dull ceiling
  const slat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.9, 2.75, 2.5) });
  for (let k = 0; k < 3; k++) {
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 0.26), slat);
    wall.position.set(0, 3.75 + k * 0.42, -4.94);
    s.add(wall);
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 0.3), slat);
    ceil.position.set(0, 4.94, -2.7 - k * 0.72);
    ceil.rotation.x = Math.PI / 2;
    s.add(ceil);
  }
  // ember glow low on one side: warm rim light on the fish and lacquer
  const ember = new THREE.Mesh(new THREE.PlaneGeometry(3, 1.2), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 0.6, 0.2) }));
  ember.position.set(0, -0.6, 4.9);
  ember.rotation.y = Math.PI;
  s.add(ember);
  return s;
}

export function createStage(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Neutral keeps the measured albedos (milky 白焼き, mahogany glaze, slate skin) close to the
  // design references; ACES greyed the ivory and crushed the glaze to red-black.
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 0.9; // keeps the milky 白焼き ivory from washing out to white
  renderer.shadowMap.enabled = true;
  // soft, blurred shadows (variance shadow maps): contact shading without razor-edged bands
  renderer.shadowMap.type = THREE.VSMShadowMap;

  const scene = new THREE.Scene();
  scene.background = S(0.16, 0.11, 0.08);
  const camera = new THREE.PerspectiveCamera(32, 16 / 9, 2, 900);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(shopRoom(), 0.04).texture;
  scene.environmentIntensity = 0.7;
  pmrem.dispose();

  // warm side daylight from the window (back-left), soft fill, and the charcoal's own glow
  const hemi = new THREE.HemisphereLight(S(1, 0.94, 0.86), S(0.3, 0.26, 0.22), 0.7);
  const key = new THREE.DirectionalLight(S(1, 0.9, 0.76), 2.7);
  key.position.set(-60, 90, -70);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -50, right: 50, top: 36, bottom: -36, near: 30, far: 320 });
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.04;
  key.shadow.radius = 5;
  key.shadow.blurSamples = 14;
  key.target.position.set(0, 0, 0);
  // a soft bounce from the counter side keeps shadows readable (food never sits in dead black)
  const fill = new THREE.DirectionalLight(S(1, 0.86, 0.72), 0.8);
  fill.position.set(50, 40, 80);
  scene.add(hemi, key, key.target, fill);

  // per station light: near-neutral daylight on the board (raw flesh must not turn peach),
  // warmer over the charcoal and at the box
  const MOOD = {
    board: { key: S(1, 0.957, 0.918), k: 2.4, hemi: 0.9 },
    grill: { key: S(1, 0.937, 0.859), k: 1.8, hemi: 0.56 }, // a little darker so the fish and embers carry the scene
    box: { key: S(1, 0.94, 0.86), k: 2.35, hemi: 0.88 },
    result: { key: S(1, 0.94, 0.86), k: 2.1, hemi: 0.7 },
  };
  const want = { key: key.color.clone(), k: key.intensity, hemi: hemi.intensity };

  return {
    renderer, scene, camera, key, fill, hemi,
    setMood(view) {
      const m = MOOD[view === 'grill' || view === 'tare' ? 'grill' : view === 'board' ? 'board' : view === 'result' ? 'result' : 'box'];
      // the finished box: a front fill from the camera side lights the cut faces
      want.fill = view === 'result' ? 1.35 : 0.8;
      want.key.copy(m.key);
      want.k = m.k;
      want.hemi = m.hemi;
    },
    updateMood(dt) {
      const a = 1 - Math.exp(-dt * 3);
      key.color.lerp(want.key, a);
      key.intensity += (want.k - key.intensity) * a;
      hemi.intensity += (want.hemi - hemi.intensity) * a;
      fill.intensity += ((want.fill ?? 0.8) - fill.intensity) * a;
    },
    // keep the sun's shadow box over whatever station is being shown
    aimShadow(x, z) {
      key.position.set(x - 45, 130, z - 55); // higher sun: soft relief, shorter shadows
      key.target.position.set(x, 0, z);
      key.target.updateMatrixWorld();
    },
  };
}
