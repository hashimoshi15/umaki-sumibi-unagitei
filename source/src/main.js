import * as THREE from 'three';
import { createStage } from './view/stage.js';
import * as T from './view/textures.js';
import { buildProps } from './view/props.js';
import { FishView, createFishMaterial } from './view/fishview.js';
import { Director } from './view/director.js';
import { Fx } from './view/fx.js';
import { Game } from './model/game.js';
import { STATIONS, BOX, heatAt, FISH } from './config.js';
import { Hud } from './hud.js';
import { UI } from './ui.js';
import { Sound } from './audio.js';
import { Input } from './input.js';
import { clamp } from './util.js';
import { t, setLang, detect, lang, missing } from './i18n.js';

const VERSION = '0.4.0';
const STORE = 'umaki-unagitei:v1';
const STEP = 1 / 60;
const CHALLENGE = ['fukkura', 'kobashiku', 'taretappuri'];

function load() {
  try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (_) { return {}; }
}
function save(s) {
  try { localStorage.setItem(STORE, JSON.stringify(s)); return true; } catch (_) { return false; }
}
// nickname and country / region: this tab only (sessionStorage), never sent anywhere
const ENTRY = 'umaki-unagitei:entry';
function loadEntry() {
  try { return JSON.parse(sessionStorage.getItem(ENTRY)) || {}; } catch (_) { return {}; }
}
function saveEntry(e) {
  try { sessionStorage.setItem(ENTRY, JSON.stringify(e)); } catch (_) { /* private mode: keep in memory only */ }
}
const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;

const VIEW_OF = {
  cut: 'board', open: 'board', bone: 'board', skewer: 'board', toGrill: 'grill', white: 'grill', tare: 'tare',
  toBoard: 'board', unskewer: 'board', slice: 'board', plate: 'plate', finish: 'box', result: 'result',
};

class App {
  constructor() {
    this.settings = Object.assign({ muted: false, volume: 0.8, tutorial: false, plays: 0, best: 0 }, load());
    this.mode = 'loading';
    this.paused = false;
    this.portrait = false;
    this.W = innerWidth;
    this.H = innerHeight;
    this.u = 7;
    this.acc = 0;
    this.last = performance.now();
    this.dprMax = Math.min(window.devicePixelRatio || 1, 2);
    this.dprCap = this.dprMax;
    this.low = Math.min(innerWidth, innerHeight) < 500;
    this.perf = { buf: new Float32Array(90), n: 0, good: 0, ups: 0 };
    this.challenge = null;
    const gl = document.getElementById('gl');
    this.ui = new UI({
      start: () => this.start(null),
      challenge: () => this.start('challenge'),
      howto: () => this.showHowto(),
      howGo: () => this.beginGame(),
      pause: () => this.pause('menu'),
      resume: () => this.resume(),
      restart: () => this.restart(),
      toTitle: () => this.toTitle(),
      toggleMute: () => this.toggleMute(),
      volume: (v) => this.setVolume(v),
      next: () => this.nextPlate(),
      action: (name) => this.action(name),
      lang: (id) => this.setLanguage(id),
      fullscreen: () => this.enterFullscreen(),
      entryChanged: () => saveEntry({ nick: this.ui.entry.nick, country: this.ui.entry.country }),
    });
    // language: the saved choice, else the browser's (never derived from the country / region)
    setLang(this.settings.lang || window.__bootLang || detect());
    const e0 = loadEntry();
    this.ui.setEntry(e0.nick, e0.country);
    this.player = null;
    try {
      this.stage = createStage(gl);
    } catch (err) {
      this.ui.fatal(t('err.webgl'));
      throw err;
    }
    // phones: a smaller (still soft) shadow map; the blur passes run every frame
    if (this.low) this.stage.key.shadow.mapSize.set(1024, 1024);
    this.props = buildProps(this.stage.scene, T);
    const fishTex = T.fishPattern({ low: this.low });
    this.fishMat = createFishMaterial(fishTex, { tare: true });
    // the same slick raw-skin surface as the body's (one surface, no ring where they meet)
    const headMat = new THREE.MeshPhysicalMaterial({
      map: T.headSkin(), roughness: 0.32, clearcoat: 0.5, clearcoatRoughness: 0.2, envMapIntensity: 0.8,
      sheen: 0.45, sheenRoughness: 0.3, sheenColor: new THREE.Color(0.78, 0.82, 0.86),
    });
    const boneMat = new THREE.MeshStandardMaterial({ map: T.boneTexture(), roughness: 0.5 });
    this.fishView = new FishView(this.stage.scene, this.fishMat, headMat, boneMat);
    this.director = new Director(this.stage, this.fishView, this.props);
    this.fx = new Fx(this.stage.scene);
    // a drop of tare landing back in the trough leaves a small ring; on the coals it sizzles to smoke
    this.fx.onDrop = (x, y, z) => {
      const T = STATIONS.tare;
      if (Math.abs(y - T.surf) < 0.01) { if (Math.random() < 0.18 && this.props.trough) this.props.trough.ripple(x, z, 0.18); }
      else if (y > 1 && Math.random() < 0.3) this.fx.spawn(x, y + 1, z, { a: 0.08, vy: 4, s1: 6, c: [0.86, 0.84, 0.83] });
    };
    this.hud = new Hud(document.getElementById('hud'));
    this.sound = new Sound();
    this.sound.setVolume(this.settings.volume);
    this.sound.setMuted(this.settings.muted);
    this.game = new Game();
    this.game.on((t, d) => this.onEvent(t, d));
    this.ui.setSound(this.settings.muted, this.settings.volume);
    this.input = new Input(gl, this);
    if (this.props.grill && this.props.grill.setHeat) this.props.grill.setHeat(heatAt);
    addEventListener('resize', () => this.resize());
    addEventListener('orientationchange', () => setTimeout(() => this.resize(), 120));
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.lostFocus('hidden'); });
    addEventListener('blur', () => this.lostFocus('blur'));
    addEventListener('pagehide', () => this.lostFocus('hidden'));
    // leaving full screen (Esc, the system back gesture, a notification…) pauses; the pause card offers
    // to go back to full screen
    for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(ev, () => this.onFullscreen());
    // the browser's back button / swipe while cooking pauses instead of leaving the page
    addEventListener('popstate', () => {
      if (this.mode === 'play' || this.mode === 'result') {
        if (this.mode === 'play') this.pause('back');
        try { history.pushState({ unagi: 1 }, ''); } catch (_) { /* ignore */ }
      }
    });
    this.resize();
    this.placeIdleFish();
    requestAnimationFrame((t) => this.frame(t));
    setTimeout(() => this.boot(), 30);
  }

  boot() {
    this.mode = 'title';
    this.ui.setScreen('title');
    this.director.setView('title', 0);
    this.ui.loaded();
    this.sound.setBgm(true);
    this.checkPortrait();
  }

  // on the title the whole uncut eel rests on the board
  placeIdleFish() {
    this.fishView.update(this.game, 0);
    this.fishView.updateHeadBone(this.game, 0);
    const B = STATIONS.board;
    this.fishView.group.position.set(-70 - 22, B.h, B.z);
  }

  resize() {
    const W = innerWidth, H = innerHeight;
    this.W = W;
    this.H = H;
    this.u = Math.min(H / 100, (W * 0.5625) / 100);
    document.documentElement.style.setProperty('--u', this.u + 'px');
    const dpr = Math.min(window.devicePixelRatio || 1, this.dprCap);
    this.stage.renderer.setPixelRatio(dpr);
    this.stage.renderer.setSize(W, H, false);
    this.hud.resize(W, H, Math.min(window.devicePixelRatio || 1, 2));
    this.director.resize(W, H, this.ui.freeRects(W, H));
    this.dirty = true;
    this.fx.resize(H * dpr, this.stage.camera.fov);
    this.checkPortrait();
  }

  checkPortrait() {
    const portrait = innerHeight > innerWidth * 1.05;
    // the entry screen works upright too (typing a nickname); cooking, how-to and results are landscape only
    this.ui.setRotate(portrait && this.mode !== 'loading' && this.mode !== 'title');
    if (portrait === this.portrait) return;
    this.portrait = portrait;
    if (portrait) {
      this.input.cancelAll();
      if (this.mode === 'play' && !this.paused) this.pause('rotate');
      this.sound.setPaused(true);
    } else if (this.mode === 'play' && this.paused) {
      this.showPause('pause.rotated');
    } else if (!this.paused) this.sound.setPaused(false);
  }

  canPlay() {
    return this.mode === 'play' && !this.paused && !this.portrait;
  }

  userGesture() {
    this.sound.unlock();
  }

  // ---------------- flow ----------------
  start(kind) {
    this.userGesture();
    // nickname and country / region first; nothing starts cooking before they are given
    if (this.mode !== 'title') {
      this.mode = 'title';
      this.ui.setScreen('title');
      this.director.setView('title', 0.8);
    }
    const e = this.ui.checkEntry();
    if (!e) {
      this.sound.play('miss');
      return;
    }
    this.player = e;
    saveEntry(e);
    this.sound.play('tap');
    this.enterFullscreen();
    this.challenge = kind === 'challenge' ? { n: 0, results: [] } : null;
    // the title's three lines are the whole start explanation; each step then shows its own one hint
    // (the full あそびかた card stays one tap away on the title)
    this.beginGame();
  }

  showHowto() {
    this.userGesture();
    this.mode = 'howto';
    this.ui.setScreen('howto');
    this.checkPortrait();
  }

  setLanguage(id) {
    setLang(id);
    this.settings.lang = lang();
    save(this.settings);
  }

  // Full screen + landscape lock where the browser allows it (Android Chrome, desktop, iPad). Must run
  // inside the tap on スタート. Refused or unsupported (iPhone Safari): the game simply uses the whole
  // visible viewport; nothing waits for it.
  fsSupported() {
    const d = document.documentElement;
    return !!((document.fullscreenEnabled || document.webkitFullscreenEnabled) && (d.requestFullscreen || d.webkitRequestFullscreen));
  }

  enterFullscreen() {
    const lock = () => {
      try {
        const o = screen.orientation;
        if (o && o.lock) o.lock('landscape').catch(() => {});
      } catch (_) { /* not supported */ }
    };
    if (!this.fsSupported() || fsElement()) return lock();
    const d = document.documentElement;
    try {
      const p = d.requestFullscreen ? d.requestFullscreen({ navigationUI: 'hide' }) : d.webkitRequestFullscreen();
      this.fsWanted = true;
      if (p && p.then) p.then(lock, () => { this.fsWanted = false; });
      else setTimeout(lock, 300);
    } catch (_) {
      this.fsWanted = false;
    }
  }

  onFullscreen() {
    this.ui.setFullscreen(this.fsSupported(), !!fsElement());
    if (fsElement()) return;
    if (this.fsWanted && this.mode === 'play' && !this.paused) this.pause('fsExit');
    setTimeout(() => this.resize(), 60);
  }

  beginGame() {
    this.sound.play('tap');
    this.sound.setBgm(false);
    const order = this.challenge ? CHALLENGE[this.challenge.n] : null;
    this.resetPlay(order);
    this.ui.setOrder(order || 'standard', this.challenge ? { n: this.challenge.n + 1, of: CHALLENGE.length } : null);
    this.mode = 'play';
    this.paused = false;
    this.ui.setScreen('play');
    this.director.setView('board', 1.1);
    this.ui.setStep(this.game.step, this.game);
    this.ui.pose('happy');
    if (this.player) this.ui.toast(t('greet', { name: this.player.nick }));
    if (!this.histGuard) {
      // one history entry so the back button pauses the game instead of leaving it
      try { history.pushState({ unagi: 1 }, ''); this.histGuard = true; } catch (_) { /* ignore */ }
    }
    // started upright (portrait): wait, paused, until the phone is turned
    if (this.portrait) {
      this.paused = true;
      this.pauseReason = 'rotate';
      this.input.cancelAll();
      this.sound.setPaused(true);
      this.ui.setRotate(true);
    }
  }

  resetPlay(order) {
    this.input.cancelAll();
    this.game.reset(order);
    this.fishView.reset();
    this.director.reset();
    if (this.props.reset) this.props.reset(); // fresh rice, tools back in place
    this.fx.clear();
    this.acc = 0;
    this.lastResult = null;
  }

  restart() {
    this.sound.play('tap');
    this.paused = false;
    this.sound.setPaused(false);
    if (this.challenge) this.challenge = { n: 0, results: [] };
    this.beginGame();
  }

  nextPlate() {
    if (!this.challenge) return this.restart();
    this.challenge.n++;
    if (this.challenge.n >= CHALLENGE.length) return this.toTitle();
    this.beginGame();
  }

  toTitle() {
    this.sound.play('tap');
    this.resetPlay(null);
    this.challenge = null;
    this.paused = false;
    this.sound.setPaused(false);
    this.mode = 'title';
    this.ui.setScreen('title');
    this.director.setView('title', 1.2);
    this.placeIdleFish();
    this.sound.setBgm(true);
  }

  pause(reason) {
    if (this.mode !== 'play' || this.paused) return;
    this.paused = true;
    this.pauseReason = reason;
    this.input.cancelAll();
    this.sound.setPaused(true);
    if (reason !== 'rotate') this.showPause(reason === 'menu' ? 'pause.note' : reason === 'fsExit' ? 'pause.fsExit' : reason === 'back' ? 'pause.back' : 'pause.away');
  }

  showPause(noteKey) {
    this.ui.setScreen('pause');
    this.ui.setPause(noteKey);
    this.ui.setFullscreen(this.fsSupported(), !!fsElement());
  }

  resume() {
    if (this.portrait) return;
    this.sound.play('tap');
    this.paused = false;
    this.ui.setScreen('play');
    this.sound.setPaused(false);
    this.sound.unlock();
    this.last = performance.now();
    this.acc = 0;
  }

  togglePause() {
    if (this.mode !== 'play') return;
    if (this.paused) this.resume();
    else this.pause('menu');
  }

  lostFocus(why) {
    this.input.cancelAll();
    if (this.mode === 'play' && !this.paused) this.pause(why);
    else if (why === 'hidden') this.sound.setPaused(true);
  }

  keyConfirm() {
    if (this.ui.pickerOpen) return;
    if (this.mode === 'title') this.start(null);
    else if (this.mode === 'howto') this.start(null);
    else if (this.mode === 'play' && this.paused && !this.portrait) this.resume();
    else if (this.mode === 'result') this.challenge ? this.nextPlate() : this.restart();
  }

  toggleMute() {
    this.settings.muted = !this.settings.muted;
    this.sound.setMuted(this.settings.muted);
    this.ui.setSound(this.settings.muted, this.settings.volume);
    save(this.settings);
    this.userGesture();
  }

  setVolume(v) {
    this.settings.volume = v;
    if (v > 0 && this.settings.muted) {
      this.settings.muted = false;
      this.sound.setMuted(false);
    }
    this.sound.setVolume(v);
    this.ui.setSound(this.settings.muted, v);
    save(this.settings);
  }

  skewerTap(u, w) {
    const r = this.game.skewerTap(u, w);
    if (r) this.sound.play(r === 'add' ? 'skewer' : 'skewer-out');
  }

  // a side button by name (返す / 焼き場へ / たれへ / 焼き上がり / 仕上げ)
  action(name) {
    if (!this.canPlay()) return;
    if (name === 'flip') {
      this.userGesture();
      this.game.flip();
    } else this.mainAction();
  }

  // the step's main button (also Space / N). Pressed while it is still early (white not done yet, or
  // the tare not set), the first press only says so; a second press within 2.5 s goes ahead.
  mainAction() {
    if (!this.canPlay()) return;
    const g = this.game;
    this.userGesture();
    const name = g.step === 'white' ? 'toTare' : g.step === 'tare' ? 'toBoard' : null;
    if (name && this.ui.isEarly(name)) {
      const now = performance.now();
      if (!this.armed || this.armed.name !== name || now > this.armed.until) {
        this.armed = { name, until: now + 2500 };
        this.ui.armBtn(name, true);
        const wet = g.dip.phase !== 'grill' || g.fish.faceStats(0).wet > 0.1 || g.fish.faceStats(1).wet > 0.1;
        this.ui.toast(t(name === 'toTare' ? 'early.toTare' : wet ? 'early.wet' : 'early.glaze'), true);
        this.sound.play('tap');
        return;
      }
    }
    this.armed = null;
    if (name) this.ui.armBtn(name, false);
    if (g.step === 'skewer') g.toGrill();
    else if (g.step === 'white') g.toTare();
    else if (g.step === 'tare') g.toBoard();
    else if (g.step === 'finish') {
      this.sound.play('sansho');
      this.shakeSansho();
      g.finish();
    }
  }

  // the blade's sound follows the hand: louder and brighter the faster it draws, silent when the finger rests
  knifeLevel(g) {
    const lv = (sp, k, active) => {
      if (!active || !sp || !sp.s.length) return 0;
      const moving = g.time - sp.s[sp.s.length - 1].t < 0.15;
      return moving ? clamp(Math.abs(sp.v) / 28, 0.2, 1) * k : 0;
    };
    if (g.slicer.active) return 0.8;
    return Math.max(lv(g.knifeSpeed, 1, g.knife.active), lv(g.boneSpeed, 0.45, g.boner && g.boner.active));
  }

  // 仕上げ: sansho shaken over the box; each flake lands on whatever is under it (the eel or the rice)
  shakeSansho() {
    const X = STATIONS.box;
    const rc = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0), from = new THREE.Vector3();
    const targets = [];
    for (const h of this.fishView.pieceGroups) h.traverse((o) => { if (o.isMesh && !o.material.transparent) targets.push(o); });
    if (this.props.box && this.props.box.bed) targets.push(this.props.box.bed);
    for (const t of targets) t.updateMatrixWorld();
    const floorAt = (x, z) => {
      from.set(x, X.rice + 30, z);
      rc.set(from, down);
      const hit = rc.intersectObjects(targets, false)[0];
      return hit ? hit.point.y : X.rice;
    };
    this.fx.sansho(X.x, X.z, BOX.inner.x * 1.7, BOX.inner.z * 1.7, floorAt, 80);
  }

  showResult() {
    const res = this.game.result;
    this.mode = 'result';
    const prevBest = this.settings.best || 0;
    const extra = { best: Math.max(prevBest, res.total), newBest: (this.settings.plays || 0) > 0 && res.total > prevBest };
    if (this.player) Object.assign(extra, { nick: this.player.nick, country: this.player.country });
    if (this.challenge) {
      this.challenge.results.push(res.total);
      extra.challenge = { n: this.challenge.results.length, of: CHALLENGE.length, scores: [...this.challenge.results] };
    }
    this.ui.showResult(res, extra);
    this.ui.setScreen('result');
    this.director.setView('result', 1.2);
    this.sound.play('result', { rank: res.rank });
    setTimeout(() => this.sound.setBgm(true), 1800);
    this.settings.tutorial = true;
    this.settings.plays = (this.settings.plays || 0) + 1;
    this.settings.best = Math.max(this.settings.best || 0, res.total);
    if (!save(this.settings)) this.ui.toast(t('err.save'), true);
    this.lastResult = res;
  }

  // ---------------- events ----------------
  onEvent(type, d) {
    const ui = this.ui, s = this.sound, g = this.game;
    switch (type) {
      case 'step':
        ui.setStep(d.step, g);
        if (VIEW_OF[d.step]) this.director.setView(VIEW_OF[d.step], d.step === 'toGrill' || d.step === 'toBoard' ? 1.6 : 1.0);
        if (['open', 'bone', 'skewer', 'white', 'tare', 'unskewer', 'slice', 'plate', 'finish'].includes(d.step)) s.play('step');
        if (d.step === 'plate') {
          this.fishView.makePieces(g);
          for (const h of this.fishView.pieceGroups) this.stage.scene.attach(h);
        }
        if (d.step === 'white') ui.pose('happy');
        if (d.step === 'result') this.showResult();
        break;
      case 'knife-down': s.play('knife-start'); break;
      case 'knife-miss':
        if ((this.missT || 0) < performance.now() - 1500) {
          this.missT = performance.now();
          ui.toast(t(d.front < 1 ? 't.cutStart' : 't.cutCont'), true);
          s.play('miss');
        }
        break;
      case 'cut-done': ui.toast(t('t.cutDone')); s.play('good'); ui.pose('cheer'); break;
      case 'open-done': s.play('open'); ui.toast(t('t.openDone')); break;
      case 'bone-done': s.play('bone'); ui.toast(t('t.boneDone')); ui.pose('cheer'); break;
      case 'bone-miss': ui.toast(t('t.boneMiss'), true); break;
      case 'skewer-full': ui.toast(t('t.skewerFull'), true); break;
      case 'flip':
        s.play('flip', { heat: clamp(g.heatNow || 0.4, 0, 1) });
        if (g.step === 'tare') s.play('tare-hiss', { delay: 0.2 });
        else s.play('flare', { delay: 0.15, gain: 0.6 });
        this.fx.flare(g.grill.fishX + FISH.L / 2, g.grill.fishZ);
        break;
      // つけダレ: lifted off the coals, into the trough, out, and back onto the coals
      case 'lift': s.play('pick', { gain: 0.7 }); break;
      case 'dip-in': {
        s.play('tare-in');
        const P = this.props.trough;
        if (P) P.ripple(d.x, d.z, 1);
        if (d.n === 1) ui.toast(t('t.dipIn'));
        break;
      }
      case 'dip-out': {
        s.play('tare-out');
        const P = this.props.trough;
        if (P) P.ripple(d.x, d.z, 0.7);
        break;
      }
      case 'dip-rest': if (!this.input.cancelling) ui.toast(t('t.dipRest')); break;
      case 'return':
        if (d.wet > 0.05) {
          s.play('tare-hiss', { gain: clamp(0.6 + d.wet, 0.6, 1.3) });
          s.play('flare', { delay: 0.1, gain: 0.5 });
          this.fx.flare(g.grill.fishX + FISH.L / 2, g.grill.fishZ);
        } else s.play('drop', { gain: 0.6 });
        if (d.dropped && !this.input.cancelling) ui.toast(t('t.dropped'), true);
        else if (d.wet > 0.05) { ui.toast(t('t.sear')); ui.pose('happy'); }
        break;
      case 'burning':
        ui.toast(t('t.burning'), true);
        ui.pose('wow');
        s.play('burn-warn');
        break;
      case 'unskewer': s.play('skewer-out'); break;
      case 'slice':
        s.play('slice');
        // the knife parts the fillet: show the pieces and their cut faces right away
        if (g.fish.cuts.length < 2) this.fishView.makePieces(g);
        break;
      case 'slice-miss': ui.toast(t('t.sliceMiss'), true); break;
      case 'pick': s.play('pick'); break;
      case 'drop': {
        s.play('drop');
        ui.pose(d.err < 1 ? 'happy' : 'idle');
        if (d.err < 1) ui.toast(t('t.perfect'));
        // the piece settles into the rice: a shallow press, grains pushed aside, a little tare on them
        const p = g.fish.pieces[d.k], B = this.props.box;
        if (p && B && B.dent) {
          const i = g.fish.bin((p.u0 + p.u1) / 2);
          B.dent(p.x, p.z, 1.2, 0.3, { hx: (p.u1 - p.u0) / 2, hz: (g.fish.farW(i) + g.fish.nearW(i)) / 2, rot: -Math.PI / 2 + p.rot });
        }
        break;
      }
      case 'drop-miss': ui.toast(t('t.dropMiss'), true); break;
      default:
    }
  }

  // ---------------- per frame ----------------
  // Adaptive resolution: if play frames are slow (median over 90 frames above 26 ms) the pixel ratio
  // steps down by 0.25 (never below 1); after 4 fast windows in a row it may step back up, twice at
  // most so it cannot oscillate. Never measured during a drag, a pause, or with the tab hidden.
  govern(ms) {
    const P = this.perf;
    if (this.mode !== 'play' || this.paused || this.portrait || this.input.mode || document.hidden || !(ms > 0) || ms > 250) {
      P.n = 0;
      return;
    }
    P.buf[P.n++] = ms;
    if (P.n < P.buf.length) return;
    P.n = 0;
    const med = [...P.buf].sort((a, b) => a - b)[P.buf.length >> 1];
    if (med > 26 && this.dprCap > 1) {
      this.dprCap = Math.max(1, this.dprCap - 0.25);
      P.good = 0;
      this.resize();
    } else if (med < 15 && this.dprCap < this.dprMax && P.ups < 2) {
      if (++P.good >= 4) {
        this.dprCap = Math.min(this.dprMax, this.dprCap + 0.25);
        P.good = 0;
        P.ups++;
        this.resize();
      }
    } else P.good = 0;
  }

  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    this.govern(now - this.last);
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (!(dt > 0)) dt = STEP;
    dt = Math.min(dt, 0.05);
    const g = this.game;
    const playing = this.mode === 'play' && !this.paused && !this.portrait;
    if (this.paused || this.portrait) {
      // stopped: simulate nothing and draw nothing (the last frame stays on screen); one redraw
      // only after a resize so the frozen view still fits the window
      if (!this.dirty) return;
      this.dirty = false;
      dt = 0;
    }
    if (playing) {
      this.acc += dt;
      let n = 0;
      while (this.acc >= STEP && n < 4) {
        g.update(STEP);
        this.acc -= STEP;
        n++;
      }
      if (n === 4) this.acc = 0;
      this.ui.frame(g, dt);
    }
    if (this.mode === 'play' || this.mode === 'result') {
      this.fishView.update(g, g.time);
      this.fishView.updateHeadBone(g, dt);
      this.fishView.syncSkewers(g);
    }
    if (this.props.update) this.props.update(now / 1000);
    const atBox = this.mode === 'result' || (this.mode === 'play' && (g.step === 'finish' || g.step === 'plate'));
    this.fx.update(dt, g, {
      grillOn: this.mode === 'play' && g.onGrill,
      drip: this.mode === 'play' ? this.dripCtx(g) : null,
      plateSteam: atBox ? 3 : 0,
      plateAt: { x: STATIONS.box.x, y: STATIONS.box.rice + 1.5, z: STATIONS.box.z },
    });
    this.director.update(dt, g, this.input, this.mode);
    const view = this.director.view;
    // single rice grains only where the box is seen up close; from afar the bed texture reads cleaner
    this.props.box.grains.visible = view === 'plate' || view === 'box' || view === 'result';
    // the sun's shadow box follows the station on screen (the つけダレ view spans the konro and the trough)
    const focus = view === 'grill' ? STATIONS.grill : view === 'tare' ? { x: 0, z: 14 } : view === 'board' ? STATIONS.board : view === 'title' ? { x: -10, z: 0 } : STATIONS.box;
    this.stage.aimShadow(focus.x, focus.z);
    this.stage.setMood(view);
    this.stage.updateMood(dt || 0.016);
    if (playing || this.mode === 'title' || this.mode === 'result') {
      this.sound.update(dt, {
        coals: g.atGrill ? 0.6 : this.mode === 'title' ? 0.15 : 0.25,
        sizzle: g.onGrill && g.grill.flipping === 0 ? clamp((g.heatNow || 0) * (g.grill.down === 1 ? 1.1 : 0.7), 0, 1) : 0,
        knife: this.knifeLevel(g),
      });
    }
    this.hud.draw(dt, this);
    this.stage.renderer.render(this.stage.scene, this.stage.camera);
    this.dirty = false; // drawn: a later pause needs no extra frame
  }

  // tare running off the lifted fish: how many drops a second, from where, and where they land
  dripCtx(g) {
    const D = g.dip;
    if (g.step !== 'tare' || D.phase === 'grill' || D.depth > 0.3 || this.paused) return null;
    const grp = this.fishView.group, T = STATIONS.tare;
    const flipped = Math.cos(grp.rotation.x) < 0;
    return {
      rate: clamp(D.drip / 25, 0, 1.6) * 34,
      x: grp.position.x, z: grp.position.z, y: grp.position.y - (flipped ? 1 : 0), slope: Math.tan(grp.rotation.z),
      floorAt: (x, z) => (Math.abs(x - T.x) < T.inner.x && Math.abs(z - T.z) < T.inner.z ? T.surf : Math.abs(z) < 11 && Math.abs(x) < 34 ? 6 : 0.1),
    };
  }

  snapshot() {
    const g = this.game, F = g.fish;
    return {
      version: VERSION, mode: this.mode, paused: this.paused, pauseReason: this.pauseReason || '', portrait: this.portrait,
      step: g.step, stepT: +g.stepT.toFixed(2), time: +g.time.toFixed(2), order: g.order,
      cutFront: +F.cutFront.toFixed(2), openK: +F.openK.toFixed(2), peel: +F.peel.toFixed(2), skewers: [...F.skewers], skewersGrill: [...F.skewersGrill],
      fishX: +g.grill.fishX.toFixed(2), fishZ: +g.grill.fishZ.toFixed(2), heat: +(g.heatNow || 0).toFixed(2), down: g.grill.down, flips: g.grill.flips, L: FISH.L,
      dip: { phase: g.dip.phase, x: +g.dip.x.toFixed(2), z: +g.dip.z.toFixed(2), depth: +g.dip.depth.toFixed(2), count: g.dip.count, under: +g.dip.under.toFixed(2), servedWet: g.dip.servedWet },
      flesh: F.faceStats(0), skin: F.faceStats(1), cuts: [...F.cuts], pieces: F.pieces.map((p) => ({ k: p.k, placed: p.placed, slot: p.slot, err: +p.err.toFixed(2), v: Math.round(p.v) })),
      frames: this.stage.renderer.info.render.frame, inputMode: this.input.mode, holding: g.holding, audio: this.sound.ctx ? this.sound.ctx.state : 'none', muted: this.settings.muted,
      result: g.result ? { total: g.result.total, title: g.result.title, cats: g.result.cats, issue: g.result.issue, tip: g.result.tip, good: g.result.good } : null,
      challenge: this.challenge ? { n: this.challenge.n, results: [...this.challenge.results] } : null,
      view: { W: this.W, H: this.H, u: +this.u.toFixed(2), dpr: this.stage.renderer.getPixelRatio(), dprCap: this.dprCap, fullscreen: !!fsElement(), portrait: this.portrait },
      lang: lang(), player: this.player ? { nickLen: [...this.player.nick].length, country: this.player.country } : null,
    };
  }
}

const app = new App();
// dev builds only (stripped from the published bundle): lets the QA console inspect the scene
if (process.env.NODE_ENV !== 'production') window.__app = app;
// Read-only hooks for automated checks: tests aim real pointer events with these; nothing here changes the game.
window.unagi = {
  version: VERSION,
  snapshot: () => app.snapshot(),
  fishToScreen: (u, y, w) => { const p = app.director.projectFish(u, y, w, {}); return { x: p.x, y: p.y }; },
  worldToScreen: (x, y, z) => { const p = app.director.project(new THREE.Vector3(x, y, z)); return { x: p.x, y: p.y }; },
  pieceBoxes: () => app.director.pieceScreenBoxes(app.game),
  // on the same plane Director.toBox reads the pointer on
  boxSlotScreen: (i) => { const s = BOX.slots[i]; const p = app.director.project(new THREE.Vector3(STATIONS.box.x + s.x, STATIONS.box.rice + 1, STATIONS.box.z + s.z)); return { x: p.x, y: p.y }; },
  fishWidths: (i) => ({ far: app.game.fish.farW(i), near: app.game.fish.nearW(i) }),
  grillPlane: () => STATIONS.grill.h,
  // the tare trough's centre on its surface, and the height the pointer is read at while carrying
  troughScreen: () => { const T = STATIONS.tare; const p = app.director.project(new THREE.Vector3(T.x, T.surf, T.z)); return { x: p.x, y: p.y }; },
  carryPlane: () => 11,
  memory: () => ({ ...app.stage.renderer.info.memory, programs: app.stage.renderer.info.programs?.length }),
  render: () => app.stage.renderer.render(app.stage.scene, app.stage.camera),
  // language in use and any dictionary key that had to fall back (should stay empty)
  i18n: () => ({ lang: lang(), missing: [...missing] }),
};
