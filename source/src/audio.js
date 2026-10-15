// 炭火うなぎ亭 sound. Everything is synthesised with Web Audio (no files, no ScriptProcessor).
// Nothing is created or played until unlock() runs inside the first user gesture.

const D4 = 293.66;
const YO = [0, 2, 5, 7, 9];          // yo pentatonic on D: D E G A B
const STEP = 60 / 80 / 2;            // BGM eighth note at 80 bpm
const LOOP_STEPS = 64;               // 8 bars, ~24 s
const CLICK_LEN = 0.03;              // one crackle grain slot in the click buffer (s)
const CLICK_VARIANTS = 8;
const LEVELS = ['coals', 'sizzle', 'knife'];

const clamp01 = (v) => (v > 1 ? 1 : v > 0 ? v : 0);
const rnd = (a, b) => a + Math.random() * (b - a);

// scale degree -> Hz (0 = D4, 5 = D5, -5 = D3)
function yoHz(deg) {
  const oct = Math.floor(deg / 5);
  return D4 * 2 ** ((12 * oct + YO[deg - 5 * oct]) / 12);
}

// Minimum seconds between two plays of the same one-shot (guards against per-frame triggering).
const GAP = {
  tap: 0.04, step: 0.15, 'knife-start': 0.12, open: 0.25, bone: 0.3, skewer: 0.1, 'skewer-out': 0.1,
  flip: 0.15, flare: 0.14, 'tare-in': 0.3, 'tare-out': 0.3, 'tare-hiss': 0.12, slice: 0.07, pick: 0.06, drop: 0.08,
  sansho: 0.09, good: 0.25, miss: 0.4, 'burn-warn': 0.9, result: 1,
};

// BGM: a calm koto tune over a soft low koto line, with the odd shamisen accent.
// [step, degree, length in steps, velocity]
const MELODY = [
  [0, 4, 2, 0.9], [2, 5, 2, 0.8], [4, 6, 3, 1], [7, 5, 1, 0.6],
  [8, 4, 2, 0.8], [10, 3, 2, 0.75], [12, 2, 2, 0.8], [14, 3, 2, 0.7],
  [16, 5, 1, 0.85], [17, 6, 1, 0.7], [18, 7, 2, 0.95], [20, 6, 2, 0.8], [22, 5, 1, 0.7], [23, 4, 1, 0.65],
  [24, 3, 3, 0.9], [27, 2, 1, 0.6], [28, 1, 2, 0.7], [30, 0, 2, 0.8],
  [32, 0, 2, 0.8], [34, 2, 1, 0.7], [35, 3, 1, 0.7], [36, 4, 2, 0.9], [38, 3, 2, 0.7],
  [40, 5, 3, 1], [43, 4, 1, 0.6], [44, 3, 2, 0.75], [46, 2, 2, 0.7],
  [48, 3, 1, 0.8], [49, 4, 1, 0.7], [50, 5, 2, 0.9], [52, 6, 2, 0.95], [54, 5, 1, 0.7], [55, 4, 1, 0.65],
  [56, 3, 2, 0.85], [58, 2, 1, 0.65], [59, 1, 1, 0.6], [60, 0, 4, 0.85],
];
const MEL = new Array(LOOP_STEPS).fill(null);
for (const [s, d, l, v] of MELODY) MEL[s] = [d, l, v];
const BASS = [[-5, -2], [-3, 0], [-4, -1], [-2, -5], [-5, -2], [-3, 0], [-2, 1], [-5, -2]];

// ---------- buffers (generated once at unlock) ----------

function normalise(d, peak) {
  let m = 0;
  for (let i = 0; i < d.length; i++) {
    const a = Math.abs(d[i]);
    if (a > m) m = a;
  }
  if (m > 0) for (let i = 0; i < d.length; i++) d[i] *= peak / m;
  return d;
}

function white(n) {
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return d;
}

function pink(n) {
  const d = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    d[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
  return d;
}

function brown(n) {
  const d = new Float32Array(n);
  let b = 0;
  for (let i = 0; i < n; i++) {
    b = (b + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    d[i] = b;
  }
  return d;
}

// coloured noise with a crossfaded seam so the loop never ticks
function seamless(gen, sr, sec) {
  const n = Math.floor(sr * sec);
  const f = Math.floor(sr * 0.05);
  const tmp = gen(n + f);
  const d = tmp.slice(0, n);
  for (let i = 0; i < f; i++) {
    const k = (i / f) * Math.PI * 0.5;
    d[i] = tmp[i] * Math.sin(k) + tmp[n + i] * Math.cos(k);
  }
  return normalise(d, 0.9);
}

// a decaying noise grain; wraps at the end so loops stay seamless
function grain(d, at, len, amp, ring, sr) {
  const n = d.length;
  const rise = Math.max(1, Math.min(6, len >> 2));
  for (let j = 0; j < len; j++) {
    const e = (j < rise ? j / rise : 1) * Math.exp((-4.5 * j) / len) * (1 - j / len);
    let s = Math.random() * 2 - 1;
    if (ring) s = s * 0.4 + Math.sin((2 * Math.PI * ring * j) / sr);
    d[(at + j) % n] += s * amp * e;
  }
}

// binchotan: a faint hiss with sparse fine ticks and the odd ringing snap
function crackleBuf(sr) {
  const sec = 3.7;
  const n = Math.floor(sr * sec);
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * 0.02;
  const count = Math.floor(sec * 26);
  for (let k = 0; k < count; k++) {
    const big = Math.random() < 0.12;
    const len = Math.floor(sr * (big ? rnd(0.004, 0.012) : rnd(0.0006, 0.004)));
    const amp = big ? rnd(0.45, 1) : 0.06 + Math.random() ** 3 * 0.5;
    grain(d, (Math.random() * n) | 0, len, amp, big && Math.random() < 0.6 ? rnd(1400, 3200) : 0, sr);
  }
  return normalise(d, 0.95);
}

// fat frying on hot coals: hiss floor + a dense rain of tiny bursts, slow integer-cycle surges
function sizzleBuf(sr) {
  const sec = 3.1;
  const n = Math.floor(sr * sec);
  const d = new Float32Array(n);
  const w = (2 * Math.PI) / n;
  for (let i = 0; i < n; i++) {
    const surge = 0.8 + 0.12 * Math.sin(w * 3 * i) + 0.08 * Math.sin(w * 7 * i + 1.3);
    d[i] = (Math.random() * 2 - 1) * 0.16 * surge;
  }
  const count = Math.floor(sec * 600);
  for (let k = 0; k < count; k++) {
    const len = Math.floor(sr * (0.0006 + Math.random() ** 2 * 0.007));
    grain(d, (Math.random() * n) | 0, len, 0.08 + Math.random() ** 3 * 0.7, 0, sr);
  }
  return normalise(d, 0.9);
}

// a blade gliding through soft wet flesh: pink noise with slow pressure changes and sticky fibres
function knifeBuf(sr) {
  const sec = 2.6;
  const d = seamless(pink, sr, sec);
  const n = d.length;
  const w = (2 * Math.PI) / n;
  for (let i = 0; i < n; i++) d[i] *= 0.55 + 0.25 * Math.sin(w * 5 * i) + 0.2 * Math.sin(w * 11 * i + 2);
  const count = Math.floor(sec * 45);
  for (let k = 0; k < count; k++) grain(d, (Math.random() * n) | 0, Math.floor(sr * rnd(0.001, 0.005)), rnd(0.05, 0.3), 0, sr);
  return normalise(d, 0.9);
}

// short crackle grains, each ending in silence well inside its slot
function clickBuf(sr) {
  const slot = Math.floor(sr * CLICK_LEN);
  const d = new Float32Array(slot * CLICK_VARIANTS);
  for (let v = 0; v < CLICK_VARIANTS; v++) {
    const len = Math.floor(slot * (0.12 + (0.5 * v) / CLICK_VARIANTS));
    const ring = v % 3 === 0 ? 1600 + 350 * v : 0;
    for (let j = 0; j < len; j++) {
      const e = (j < 3 ? j / 3 : 1) * Math.exp((-6 * j) / len) * (1 - j / len);
      let s = Math.random() * 2 - 1;
      if (ring) s = s * 0.5 + 0.8 * Math.sin((2 * Math.PI * ring * j) / sr);
      d[v * slot + j] = s * e;
    }
  }
  return normalise(d, 0.95);
}

// small wooden kitchen: short, dark, diffuse
function roomIR(ctx) {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * 1.1);
  const pre = Math.floor(sr * 0.012);
  const b = ctx.createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let y = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sr;
      const a = 0.08 + 0.55 * Math.exp(-t * 4);
      y += a * (Math.random() * 2 - 1 - y);
      d[i] = y * Math.exp(-t * 6) * (i - pre < 64 ? (i - pre) / 64 : 1);
    }
  }
  return b;
}

function wave(ctx, amps) {
  const real = new Float32Array(amps.length + 1);
  const imag = new Float32Array(amps.length + 1);
  amps.forEach((a, i) => { imag[i + 1] = a; });
  return ctx.createPeriodicWave(real, imag);
}

export class Sound {
  constructor() {
    this.ctx = null;
    this.volume = 0.8;
    this.muted = false;
    this.paused = false;
    this.bgmOn = false;
    this.bgmRunning = false;
    this.bgmStep = 0;
    this.bgmNext = 0;
    this.bgmStopAt = 0;
    this.bgmLoop = 0;
    this.lv = { coals: 0, sizzle: 0, knife: 0 };
    this.last = {};
    this.sent = new Map();
    this.voices = 0;
    this.timer = 0;
    this.pauseTimer = 0;
    this.unlockedAt = 0;
  }

  get ready() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  // Call from a user gesture (tap/click/key). Safe to call on every gesture.
  unlock() {
    if (!this.ctx) {
      const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
      if (!AC) return false;
      let ctx = null;
      try {
        ctx = new AC({ latencyHint: 'interactive' });
      } catch (e) {
        try { ctx = new AC(); } catch (e2) { return false; }
      }
      this.ctx = ctx;
      this.unlockedAt = performance.now();
      this._build();
      // iOS only opens the output once something has started inside the gesture
      const s = ctx.createBufferSource();
      s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      s.connect(ctx.destination);
      s.start(0);
      this.timer = setInterval(() => this._tickBgm(), 90);
      if (this.bgmOn) this.setBgm(true);
      if (this.paused) ctx.suspend().catch(() => {});
    }
    if (!this.paused && this.ctx.state !== 'running' && this.ctx.state !== 'closed') {
      this.unlockedAt = performance.now();
      this.ctx.resume().catch(() => {});
    }
    return true;
  }

  setVolume(v) {
    this.volume = clamp01(+v || 0);
    this._applyGain();
  }

  setMuted(m) {
    this.muted = !!m;
    this._applyGain();
  }

  // Pause fades the master out quickly, then suspends the context (no click, no CPU).
  setPaused(p) {
    this.paused = !!p;
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'closed') return;
    clearTimeout(this.pauseTimer);
    if (this.paused) {
      this.master.gain.setTargetAtTime(0, ctx.currentTime, 0.012);
      this.pauseTimer = setTimeout(() => {
        if (this.paused && this.ctx.state !== 'closed') this.ctx.suspend().catch(() => {});
      }, 90);
    } else {
      this.unlockedAt = performance.now();
      if (ctx.state !== 'running') ctx.resume().catch(() => {});
      this.master.gain.setTargetAtTime(this._gainFor(), ctx.currentTime, 0.03);
    }
  }

  // Gentle koto/shamisen loop for title and result.
  setBgm(on) {
    this.bgmOn = !!on;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const g = this.bgmBus.gain;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(this.bgmOn ? 0.7 : 0, now, this.bgmOn ? 0.3 : 0.35);
    if (this.bgmOn && !this.bgmRunning) {
      this.bgmRunning = true;
      this.bgmStep = 0;
      this.bgmLoop = 0;
      this.bgmNext = now + 0.2;
    }
    if (!this.bgmOn) this.bgmStopAt = now + 1.8;
    this._tickBgm();
  }

  // Zero every looped texture at once (restart / back to title).
  silence() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const k of LEVELS) this.lv[k] = 0;
    for (const l of Object.values(this.loops)) this._set(l.g.gain, 0, now, 0.03);
  }

  // Every frame. levels: { coals, sizzle, knife } in 0..1.
  update(dt, levels) {
    const ctx = this.ctx;
    if (!ctx || this.paused || ctx.state !== 'running') return;
    dt = Math.min(Math.max(+dt || 0, 0), 0.1);
    const L = levels || {};
    const lv = this.lv;
    for (const k of LEVELS) {
      const target = clamp01(+L[k] || 0);
      const rate = target > lv[k] ? 22 : 7;
      lv[k] += (target - lv[k]) * (1 - Math.exp(-rate * dt));
      if (target === 0 && lv[k] < 0.003) lv[k] = 0;
    }
    const now = ctx.currentTime;
    this._drive(now);

    // loose sparks of crackle on top of the loops so they never sound like a loop
    if (lv.coals > 0.03) {
      const k = this._poisson(2.6 * lv.coals * dt);
      for (let i = 0; i < k; i++) this._pop(now + 0.015 + Math.random() * dt, (0.08 + 0.3 * Math.random() ** 2) * lv.coals, rnd(0.6, 1.5), this.popCoal);
    }
    if (lv.sizzle > 0.03) {
      const k = this._poisson(16 * lv.sizzle * dt);
      for (let i = 0; i < k; i++) this._pop(now + 0.015 + Math.random() * dt, (0.06 + 0.16 * Math.random() ** 2) * lv.sizzle, rnd(0.9, 2), this.popFat);
    }
    if (lv.knife > 0.05) {
      const k = this._poisson(5 * lv.knife * dt);
      for (let i = 0; i < k; i++) this._pop(now + 0.015 + Math.random() * dt, rnd(0.03, 0.07) * lv.knife, rnd(0.4, 0.7), this.popSoft);
    }
    this._tickBgm();
  }

  // One-shots. opts: { gain|strength 0..1.5, pan -1..1 or x (world cm), delay (s), rank, heat, shakes }
  play(name, opts = {}) {
    const ctx = this.ctx;
    if (!ctx || this.paused || ctx.state === 'closed') return;
    if (ctx.state !== 'running' && performance.now() - this.unlockedAt > 1500) return;
    const fn = FX[name];
    if (!fn) return;
    const now = ctx.currentTime;
    if (now - (this.last[name] ?? -9) < (GAP[name] ?? 0.03)) return;
    if (this.voices > 140 && name !== 'result' && name !== 'good') return;
    this.last[name] = now;
    const v = Math.min(1.5, Math.max(0, opts.gain ?? opts.strength ?? 1));
    const pan = opts.pan ?? (Number.isFinite(opts.x) ? Math.max(-0.7, Math.min(0.7, opts.x / 110)) : 0);
    fn(this, now + 0.006 + Math.max(0, opts.delay || 0), v, pan, opts);
  }

  dispose() {
    clearInterval(this.timer);
    clearTimeout(this.pauseTimer);
    if (this.ctx && this.ctx.state !== 'closed') this.ctx.close().catch(() => {});
    this.ctx = null;
  }

  // ---------- graph ----------

  _build() {
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const mk = (data) => {
      const b = ctx.createBuffer(1, data.length, sr);
      b.getChannelData(0).set(data);
      return b;
    };
    this.buf = {
      white: mk(white(sr * 2)),
      pink: mk(seamless(pink, sr, 2.3)),
      brown: mk(seamless(brown, sr, 2.9)),
      crackle: mk(crackleBuf(sr)),
      sizzle: mk(sizzleBuf(sr)),
      knife: mk(knifeBuf(sr)),
      click: mk(clickBuf(sr)),
    };
    const gain = (v, to) => {
      const g = ctx.createGain();
      g.gain.value = v;
      if (to) g.connect(to);
      return g;
    };
    const filter = (type, f, q, to) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      if (to) b.connect(to);
      return b;
    };

    // master: volume -> soft high shelf (never shrill) -> compressor
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.004;
    comp.release.value = 0.25;
    comp.connect(ctx.destination);
    const shelf = filter('highshelf', 6500, 0.7, comp);
    shelf.gain.value = -4;
    this.master = gain(this.paused ? 0 : this._gainFor(), shelf);

    const rev = ctx.createConvolver();
    rev.buffer = roomIR(ctx);
    rev.connect(gain(0.5, this.master));
    this.revIn = gain(1, rev);

    this.sfx = gain(1, this.master);
    this.sfx.connect(gain(0.1, this.revIn));
    this.amb = gain(1, this.master);
    this.music = gain(0.9, this.master);
    this.music.connect(gain(0.3, this.revIn));
    this.duck = gain(1, this.music);
    this.bgmBus = gain(0, this.duck);

    // shared colour for loose crackle grains
    this.popCoal = filter('bandpass', 2400, 0.7, this.amb);
    this.popFat = filter('highpass', 2600, 0.5, filter('lowpass', 8000, 0.5, this.amb));
    this.popSfx = filter('lowpass', 7000, 0.5, this.sfx);
    this.popSoft = filter('lowpass', 2200, 0.5, this.sfx);

    this.waveKoto = wave(ctx, [1, 0.5, 0.33, 0.22, 0.12, 0.09, 0.05, 0.03, 0.02]);
    this.waveShami = wave(ctx, [1, 0.75, 0.6, 0.48, 0.42, 0.3, 0.26, 0.2, 0.15, 0.12, 0.09, 0.07, 0.05]);

    this.loops = {
      coals: this._loop('crackle', [['highpass', 450, 0.6], ['lowpass', 6800, 0.5]], -0.08),
      breath: this._loop('brown', [['lowpass', 380, 0.5]], 0),
      sizzle: this._loop('sizzle', [['highpass', 1700, 0.6], ['peaking', 4000, 0.9, 3], ['lowpass', 7800, 0.5]], 0.04),
      knife: this._loop('knife', [['bandpass', 1050, 0.8], ['lowpass', 3200, 0.6]], -0.1),
    };
  }

  _loop(name, chain, pan) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.buf[name];
    src.loop = true;
    const f = [];
    let n = src;
    for (const [type, hz, q, g] of chain) {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = hz;
      b.Q.value = q;
      if (g) b.gain.value = g;
      n = n.connect(b);
      f.push(b);
    }
    const mod = ctx.createGain();
    const g = ctx.createGain();
    g.gain.value = 0;
    n.connect(mod).connect(g);
    this._out(g, this.amb, pan);
    src.start(ctx.currentTime, Math.random() * src.buffer.duration * 0.9);
    return { src, f, mod, g };
  }

  // map smoothed levels onto the loop gains / filters
  _drive(now) {
    const lv = this.lv;
    const L = this.loops;
    this._set(L.coals.g.gain, 0.42 * lv.coals, now);
    this._set(L.breath.g.gain, 0.3 * lv.coals, now);
    this._set(L.sizzle.g.gain, 0.65 * lv.sizzle ** 1.2, now);
    this._set(L.sizzle.f[1].frequency, 3600 + 1000 * lv.sizzle, now, 0.08);
    this._set(L.knife.g.gain, 0.75 * lv.knife, now);
    this._set(L.knife.f[0].frequency, 850 + 700 * lv.knife, now, 0.06);
  }

  // only touch an AudioParam when the value really changed (keeps the event list short)
  _set(param, v, now, tc = 0.035) {
    const last = this.sent.get(param);
    if (last === v) return;
    if (last !== undefined && v !== 0 && Math.abs(last - v) < 0.002 + Math.abs(v) * 0.01) return;
    this.sent.set(param, v);
    param.setTargetAtTime(v, now, tc);
  }

  _gainFor() {
    return this.muted ? 0 : this.volume ** 1.5;
  }

  _applyGain() {
    if (!this.master || this.paused) return;
    this.master.gain.setTargetAtTime(this._gainFor(), this.ctx.currentTime, 0.04);
  }

  _poisson(x) {
    let n = 0;
    while (x > 0 && n < 4) {
      if (Math.random() < Math.min(1, x)) n++;
      x -= 1;
    }
    return n;
  }

  _track(src) {
    this.voices++;
    src.onended = () => {
      this.voices--;
      src.disconnect();
    };
  }

  _out(node, bus, pan) {
    if (pan && this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      node.connect(p).connect(bus);
    } else node.connect(bus);
  }

  // click-free envelope: 0 -> peak (linear) -> silence (exponential)
  _env(t, a, d, peak) {
    const g = this.ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(Math.max(peak, 0.0002), t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    return g;
  }

  // filtered noise burst. o: { t, a, d, gain, type, f, f2, fs, sweep:[[hz, at]...], q, lp, buf, rate, bus, pan }
  _noise(o) {
    const ctx = this.ctx;
    const t = o.t;
    const a = o.a ?? 0.004;
    const d = o.d ?? 0.1;
    const buf = this.buf[o.buf || 'white'];
    const rate = o.rate || 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const f = ctx.createBiquadFilter();
    f.type = o.type || 'bandpass';
    f.Q.value = o.q ?? 1;
    f.frequency.setValueAtTime(o.f || 1000, t);
    if (o.sweep) for (const [hz, at] of o.sweep) f.frequency.exponentialRampToValueAtTime(hz, t + at);
    else if (o.f2) f.frequency.exponentialRampToValueAtTime(o.f2, t + (o.fs ?? a + d));
    let tail = src.connect(f);
    if (o.lp) {
      const l = ctx.createBiquadFilter();
      l.type = 'lowpass';
      l.frequency.value = o.lp;
      l.Q.value = 0.5;
      tail = tail.connect(l);
    }
    const g = this._env(t, a, d, o.gain ?? 0.1);
    tail.connect(g);
    this._out(g, o.bus || this.sfx, o.pan);
    const len = a + d + 0.03;
    const room = buf.duration - len * rate - 0.02;
    src.start(t, room > 0 ? Math.random() * room : 0);
    src.stop(t + len);
    this._track(src);
  }

  // o: { t, f, f2, fs, type, a, d, gain, bus, pan }
  _tone(o) {
    const ctx = this.ctx;
    const t = o.t;
    const a = o.a ?? 0.003;
    const d = o.d ?? 0.1;
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f, t);
    if (o.f2) osc.frequency.exponentialRampToValueAtTime(o.f2, t + (o.fs ?? d));
    const g = this._env(t, a, d, o.gain ?? 0.1);
    osc.connect(g);
    this._out(g, o.bus || this.sfx, o.pan);
    osc.start(t);
    osc.stop(t + a + d + 0.03);
    this._track(osc);
  }

  _pop(t, gain, rate, dest) {
    if (this.voices > 90) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.buf.click;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(dest);
    const v = (Math.random() * CLICK_VARIANTS) | 0;
    src.start(t, v * CLICK_LEN, CLICK_LEN * 0.9);
    this._track(src);
  }

  // light steel ring (skewer tip, knife): inharmonic partials, short
  _ting(t, f, g, pan) {
    for (const [r, k, d] of [[1, 1, 0.45], [2.76, 0.45, 0.26], [4.2, 0.2, 0.14]]) this._tone({ t, f: f * r, d, gain: g * k, pan });
  }

  // koto / shamisen pluck. o: { vel, dur, kind: 'koto'|'shami', bright, bus, pan, nail }
  _pluck(t, f, o = {}) {
    const ctx = this.ctx;
    const shami = o.kind === 'shami';
    const vel = o.vel ?? 0.2;
    const dur = o.dur ?? (shami ? 0.7 : 1.4);
    const bus = o.bus || this.music;
    const bright = o.bright ?? 1;
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(shami ? this.waveShami : this.waveKoto);
    osc.frequency.setValueAtTime(f * (shami ? 1.012 : 1.004), t);
    osc.frequency.exponentialRampToValueAtTime(f, t + (shami ? 0.06 : 0.04));
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = shami ? 1.3 : 0.6;
    const f0 = Math.min(shami ? 6000 : 5500, f * (shami ? 9 : 6) * bright);
    const f1 = Math.max(f * 1.3, Math.min(f0, f * (shami ? 2.6 : 2.2) * bright));
    lp.frequency.setValueAtTime(f0, t);
    lp.frequency.exponentialRampToValueAtTime(f1, t + (shami ? 0.12 : 0.35));
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + 0.004);
    g.gain.exponentialRampToValueAtTime(vel * (shami ? 0.3 : 0.42), t + (shami ? 0.07 : 0.12));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(lp).connect(g);
    this._out(g, bus, o.pan);
    osc.start(t);
    osc.stop(t + dur + 0.03);
    this._track(osc);
    if (o.nail !== false) {
      this._noise({ t, a: 0.001, d: shami ? 0.02 : 0.014, gain: vel * (shami ? 0.5 : 0.25), type: 'bandpass', f: Math.min(5000, f * 4), q: 1.2, bus, pan: o.pan });
    }
    if (shami) this._tone({ t, f: 150, f2: 105, d: 0.05, gain: vel * 0.3, bus, pan: o.pan });
  }

  _wood(t, g, bus) {
    this._tone({ t, f: 820, f2: 780, d: 0.05, gain: g, type: 'triangle', bus });
    this._noise({ t, a: 0.001, d: 0.015, gain: g * 0.8, type: 'bandpass', f: 1500, q: 1.2, bus });
  }

  _duck(sec) {
    const now = this.ctx.currentTime;
    const g = this.duck.gain;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(0.25, now, 0.06);
    g.setTargetAtTime(1, now + sec, 0.5);
  }

  // ---------- BGM ----------

  _tickBgm() {
    const ctx = this.ctx;
    if (!ctx || this.paused || !this.bgmRunning || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    // switched off: let the scheduled notes fade with the bus, schedule nothing new
    if (!this.bgmOn) {
      if (now > this.bgmStopAt) this.bgmRunning = false;
      return;
    }
    // fell behind (throttled timer): skip ahead rather than bunching notes
    if (this.bgmNext < now - 0.05) this.bgmNext = now + 0.05;
    while (this.bgmNext < now + 0.3) {
      if (!this.muted) this._bgmStep(this.bgmStep, this.bgmNext);
      this.bgmNext += STEP;
      this.bgmStep = (this.bgmStep + 1) % LOOP_STEPS;
      if (this.bgmStep === 0) this.bgmLoop++;
    }
  }

  _bgmStep(step, t) {
    const bus = this.bgmBus;
    const tt = t + (step & 1 ? 0.022 : 0) + (Math.random() - 0.5) * 0.01;   // slight lilt
    const m = MEL[step];
    if (m) {
      let deg = m[0];
      if (this.bgmLoop % 2 === 1 && (step === 18 || step === 52)) deg += 1;   // small variation every other pass
      this._pluck(tt, yoHz(deg), { vel: 0.2 * m[2], dur: Math.min(2.2, 0.7 + m[1] * STEP * 1.4), bus, pan: 0.12 });
      if (m[1] >= 3 && Math.random() < 0.35) this._pluck(tt + STEP * 1.5, yoHz(deg + 1), { vel: 0.06, dur: 0.6, bus, pan: 0.12 });
    }
    const beat = step % 8;
    if (beat === 0 || beat === 4) {
      const deg = BASS[step >> 3][beat ? 1 : 0];
      this._pluck(t, yoHz(deg), { vel: beat ? 0.11 : 0.17, dur: 1.6, bright: 0.55, bus, pan: -0.15, nail: false });
    }
    if (step === 31 || step === 63) this._pluck(tt, yoHz(5), { kind: 'shami', vel: 0.09, dur: 0.45, bus, pan: 0.2 });
    if (step === 15 || step === 47) this._pluck(tt, yoHz(3), { kind: 'shami', vel: 0.07, dur: 0.4, bus, pan: 0.2 });
    if (step % 16 === 0) this._wood(t, 0.035, bus);
  }
}

// ---------- one-shots: (sound, t, volume, pan, opts) ----------

const FX = {
  // soft wooden UI tick
  tap(s, t, v, p) {
    s._tone({ t, f: 1180, f2: 1040, d: 0.055, gain: 0.2 * v, pan: p });
    s._tone({ t, f: 590, d: 0.045, gain: 0.12 * v, type: 'triangle', pan: p });
    s._noise({ t, a: 0.001, d: 0.012, gain: 0.08 * v, type: 'highpass', f: 2500, q: 0.7, pan: p });
  },

  // next step: two quiet koto notes
  step(s, t, v) {
    s._pluck(t, yoHz(3), { vel: 0.12 * v, dur: 0.9 });
    s._pluck(t + 0.085, yoHz(5), { vel: 0.13 * v, dur: 1.1 });
  },

  // the blade settles on the skin: a short soft scrape and a faint ring of steel
  'knife-start'(s, t, v, p) {
    s._noise({ t, a: 0.006, d: 0.09, gain: 0.16 * v, type: 'bandpass', f: 2600, f2: 1600, q: 1.1, pan: p });
    s._ting(t + 0.01, 1750, 0.08 * v, p);
  },

  // the fillet opens along the back: a wet peel, sticky fibres, the half settles flat
  open(s, t, v, p) {
    s._noise({ t, a: 0.05, d: 0.32, gain: 0.2 * v, type: 'lowpass', f: 2600, f2: 650, q: 1.2, buf: 'pink', pan: p });
    s._noise({ t: t + 0.02, a: 0.02, d: 0.2, gain: 0.06 * v, type: 'bandpass', f: 1800, f2: 1200, q: 2, pan: p });
    for (let i = 0; i < 6; i++) s._pop(t + 0.03 + i * 0.04 + Math.random() * 0.02, 0.06 * v * rnd(0.5, 1), rnd(0.5, 0.9), s.popSfx);
    s._tone({ t: t + 0.3, f: 170, f2: 100, d: 0.12, gain: 0.16 * v, pan: p });
  },

  // lifting the backbone: a little zipper of bone ticks over a soft tear
  bone(s, t, v, p) {
    const n = 11;
    for (let i = 0; i < n; i++) {
      const k = i / (n - 1);
      s._pop(t + 0.42 * k ** 0.8 + Math.random() * 0.012, (0.2 + 0.15 * Math.random()) * v, rnd(1, 1.5), s.popSfx);
    }
    s._noise({ t, a: 0.08, d: 0.36, gain: 0.22 * v, type: 'bandpass', f: 1300, f2: 800, q: 1.3, buf: 'pink', pan: p });
    s._noise({ t: t + 0.4, a: 0.03, d: 0.12, gain: 0.1 * v, type: 'bandpass', f: 700, f2: 1400, q: 0.8, pan: p });
  },

  // skewer pushed through: a soft fibrous tear, then the tip rings once on steel
  skewer(s, t, v, p) {
    s._noise({ t, a: 0.035, d: 0.17, gain: 0.17 * v, type: 'bandpass', f: 650, f2: 1900, q: 1.5, pan: p });
    for (let i = 0; i < 3; i++) s._pop(t + 0.03 + i * 0.045 + Math.random() * 0.015, 0.05 * v, rnd(0.6, 0.9), s.popSfx);
    s._ting(t + 0.17, 1850, 0.06 * v, p);
    s._tone({ t: t + 0.17, f: 420, f2: 300, d: 0.05, gain: 0.05 * v, pan: p });
  },

  // skewer twisted out: faint ring, a sliding squeak, a small release
  'skewer-out'(s, t, v, p) {
    s._ting(t, 2100, 0.07 * v, p);
    s._noise({ t, a: 0.02, d: 0.2, gain: 0.25 * v, type: 'bandpass', f: 2300, f2: 900, q: 2.5, pan: p });
    s._pop(t + 0.19, 0.2 * v, 0.6, s.popSfx);
  },

  // turn the skewers: whoosh, skewers settle on the rail, then the fresh face hits the heat
  flip(s, t, v, p, o) {
    const h = clamp01(o.heat ?? 0.7);
    s._noise({ t, a: 0.13, d: 0.17, gain: 0.28 * v, type: 'bandpass', f: 380, sweep: [[1400, 0.13], [520, 0.3]], q: 0.9, buf: 'pink', pan: p });
    s._tone({ t: t + 0.21, f: 980, f2: 820, d: 0.04, gain: 0.1 * v, type: 'triangle', pan: p });
    s._ting(t + 0.21, 2400, 0.04 * v, p);
    s._noise({ t: t + 0.22, a: 0.02, d: 0.8 + 0.5 * h, gain: (0.12 + 0.22 * h) * v, type: 'highpass', f: 2000, q: 0.6, lp: 8500, buf: 'sizzle', pan: p });
    const k = 4 + Math.round(8 * h);
    for (let i = 0; i < k; i++) s._pop(t + 0.24 + Math.random() * 0.6, (0.06 + 0.12 * Math.random()) * v * (0.5 + h), rnd(0.9, 2), s.popFat);
  },

  // fat drips on the coals: a soft whump, a burst of crackle and a sizzling tail
  flare(s, t, v, p) {
    s._noise({ t, a: 0.03, d: 0.55, gain: 0.26 * v, type: 'lowpass', f: 220, sweep: [[1500, 0.09], [500, 0.5]], q: 1.1, buf: 'pink', pan: p });
    s._tone({ t, a: 0.02, f: 82, f2: 52, d: 0.32, gain: 0.12 * v, pan: p });
    for (let i = 0; i < 9; i++) s._pop(t + 0.04 + Math.random() ** 1.5 * 0.8, (0.06 + 0.16 * Math.random() ** 2) * v, rnd(0.6, 1.6), s.popCoal);
    s._noise({ t: t + 0.05, a: 0.05, d: 1, gain: 0.09 * v, type: 'highpass', f: 2400, q: 0.5, lp: 8000, buf: 'sizzle', pan: p });
  },

  // the whole skewered fillet goes into the thick tare: a heavy, muffled gloop and slow bubbles
  'tare-in'(s, t, v, p) {
    s._noise({ t, a: 0.03, d: 0.42, gain: 0.22 * v, type: 'lowpass', f: 760, f2: 260, q: 1.6, buf: 'pink', pan: p });
    s._tone({ t, f: 170, f2: 92, d: 0.18, gain: 0.2 * v, pan: p });
    for (let i = 0; i < 4; i++) {
      const f = rnd(260, 520);
      s._tone({ t: t + 0.2 + i * rnd(0.12, 0.2), f, f2: f * 1.6, d: rnd(0.04, 0.07), gain: rnd(0.04, 0.07) * v, pan: p });
    }
  },

  // lifted out: the tare sheets off and drips back into the trough
  'tare-out'(s, t, v, p) {
    s._noise({ t, a: 0.05, d: 0.5, gain: 0.12 * v, type: 'lowpass', f: 380, f2: 1300, q: 1.2, buf: 'pink', pan: p });
    for (let i = 0; i < 6; i++) {
      const f = rnd(780, 1350);
      s._tone({ t: t + 0.12 + i * rnd(0.08, 0.16), f, f2: f * 1.45, d: rnd(0.025, 0.045), gain: rnd(0.03, 0.06) * v * (1 - i * 0.12), pan: p });
    }
  },

  // tare meets the hot eel: a steamy hiss with caramel bubbles
  'tare-hiss'(s, t, v, p) {
    s._noise({ t, a: 0.04, d: 0.85, gain: 0.2 * v, type: 'bandpass', f: 3400, f2: 2700, q: 0.55, lp: 7500, pan: p });
    s._noise({ t, a: 0.06, d: 0.6, gain: 0.1 * v, type: 'bandpass', f: 1100, q: 0.8, buf: 'sizzle', pan: p });
    for (let i = 0; i < 7; i++) {
      const f = rnd(480, 1000);
      s._tone({ t: t + 0.05 + Math.random() * 0.7, f, f2: f * 1.3, d: rnd(0.02, 0.04), gain: rnd(0.016, 0.04) * v, pan: p });
    }
  },

  // knife through the glazed eel: crisp skin, then a soft tock on the board
  slice(s, t, v, p) {
    for (let i = 0; i < 4; i++) s._pop(t + i * 0.018 + Math.random() * 0.008, rnd(0.03, 0.06) * v, rnd(0.9, 1.4), s.popSfx);
    const tt = t + 0.075;
    s._tone({ t: tt, f: 230, f2: 125, fs: 0.06, d: 0.1, gain: 0.22 * v, pan: p });
    s._noise({ t: tt, a: 0.002, d: 0.045, gain: 0.1 * v, type: 'bandpass', f: 1150, q: 1.3, pan: p });
    s._tone({ t: tt, f: 455, d: 0.06, gain: 0.04 * v, type: 'triangle', pan: p });
  },

  // a piece is lifted
  pick(s, t, v, p) {
    s._noise({ t, a: 0.01, d: 0.06, gain: 0.35 * v, type: 'bandpass', f: 1600, f2: 2600, q: 1, pan: p });
    s._tone({ t, f: 1450, d: 0.03, gain: 0.15 * v, pan: p });
  },

  // soft landing on rice with a small rebound
  drop(s, t, v, p) {
    s._noise({ t, a: 0.005, d: 0.16, gain: 0.45 * v, type: 'lowpass', f: 520, f2: 300, q: 0.7, buf: 'pink', pan: p });
    s._tone({ t, f: 140, f2: 92, d: 0.12, gain: 0.26 * v, pan: p });
    s._noise({ t: t + 0.11, a: 0.004, d: 0.07, gain: 0.14 * v, type: 'lowpass', f: 650, q: 0.7, buf: 'pink', pan: p });
    for (let i = 0; i < 4; i++) s._pop(t + 0.01 + Math.random() * 0.08, rnd(0.02, 0.05) * v, rnd(0.5, 0.8), s.popSfx);
  },

  // a tiny wooden shaker of sansho: two or three little rattles and a puff of powder
  sansho(s, t, v, p, o) {
    const shakes = Math.max(1, Math.min(4, Math.round(o.shakes ?? 2)));
    for (let k = 0; k < shakes; k++) {
      const ts = t + k * 0.14;
      const n = 5 + ((Math.random() * 3) | 0);
      for (let i = 0; i < n; i++) {
        s._noise({ t: ts + Math.random() * 0.045, a: 0.001, d: rnd(0.008, 0.02), gain: rnd(0.16, 0.36) * v, type: 'bandpass', f: rnd(2600, 4400), q: 3.5, pan: p });
      }
      s._noise({ t: ts + 0.01, a: 0.02, d: 0.12, gain: 0.03 * v, type: 'highpass', f: 4000, q: 0.5, pan: p });
    }
  },

  // cheerful: three rising koto notes and a shamisen touch
  good(s, t, v, p) {
    [[5, 0, 0.2], [6, 0.075, 0.2], [8, 0.15, 0.26]].forEach(([d, dt, g]) => s._pluck(t + dt, yoHz(d), { vel: g * v, dur: 1, pan: p * 0.5 }));
    s._pluck(t + 0.15, yoHz(3), { kind: 'shami', vel: 0.1 * v, dur: 0.6 });
  },

  // gentle "oh well": two soft low notes, never a buzzer
  miss(s, t, v) {
    s._pluck(t, yoHz(3), { vel: 0.12 * v, dur: 0.7, bright: 0.6 });
    s._pluck(t + 0.14, yoHz(1), { vel: 0.11 * v, dur: 0.9, bright: 0.5 });
  },

  // two soft wooden clapper knocks: noticeable, never harsh
  'burn-warn'(s, t, v, p) {
    for (const dt of [0, 0.13]) {
      s._tone({ t: t + dt, f: 1020, f2: 980, d: 0.07, gain: 0.1 * v, type: 'triangle', pan: p });
      s._tone({ t: t + dt, f: 2280, d: 0.03, gain: 0.03 * v, pan: p });
      s._noise({ t: t + dt, a: 0.001, d: 0.02, gain: 0.08 * v, type: 'bandpass', f: 1800, q: 1.4, pan: p });
    }
  },

  // result stinger, longer and brighter with the rank (1..5); always friendly
  result(s, t, v, p, o) {
    const r = Math.max(1, Math.min(5, Math.round(o.rank || 3)));
    s._duck(2.8);
    const P = (deg, dt, vel, x = {}) => s._pluck(t + dt, yoHz(deg), { vel: vel * v, dur: x.dur ?? 1.2, kind: x.kind, pan: x.pan, bright: x.bright });
    if (r <= 2) {
      const seq = r === 1 ? [2, 3, 5] : [3, 4, 5, 7];
      seq.forEach((d, i) => P(d, i * 0.17, 0.17, { dur: 1.1 }));
      const end = seq.length * 0.17 + 0.05;
      P(0, end, 0.12, { dur: 1.8 });
      P(5, end + 0.02, 0.14, { dur: 2 });
      return;
    }
    if (r === 3) {
      [2, 3, 4, 5, 6, 7].forEach((d, i) => P(d, i * 0.11, 0.17));
      [0, 3, 5, 6].forEach((d, i) => P(d, 0.75 + i * 0.018, 0.13, { dur: 2.2 }));
      return;
    }
    // 4 and 5: shamisen flourish, koto glissando, full chord
    P(5, 0, 0.18, { kind: 'shami', dur: 0.5 });
    P(7, 0.12, 0.16, { kind: 'shami', dur: 0.5 });
    P(10, 0.24, 0.15, { kind: 'shami', dur: 0.7 });
    const top = r === 5 ? 10 : 8;
    const gap = r === 5 ? 0.05 : 0.065;
    for (let d = 0; d <= top; d++) P(d, 0.42 + d * gap, 0.12 + 0.006 * d, { dur: 1.2, pan: (d / top - 0.5) * 0.6 });
    const end = 0.42 + (top + 1) * gap + 0.08;
    const chord = r === 5 ? [-5, 0, 3, 5, 8, 10] : [0, 3, 5, 8];
    chord.forEach((d, i) => P(d, end + i * 0.022, 0.13, { dur: 2.6 }));
    if (r === 5) {
      // a soft taiko "don" and a small bowl bell
      s._tone({ t: t + end, a: 0.006, f: 105, f2: 62, fs: 0.3, d: 0.45, gain: 0.22 * v, bus: s.music });
      s._noise({ t: t + end, a: 0.002, d: 0.1, gain: 0.08 * v, type: 'lowpass', f: 420, q: 0.7, buf: 'pink', bus: s.music });
      for (const [r2, k, d] of [[1, 1, 2.2], [1.002, 0.6, 2], [2.74, 0.35, 1.2], [5.2, 0.12, 0.6]]) {
        s._tone({ t: t + end + 0.05, a: 0.004, f: 1880 * r2, d, gain: 0.045 * k * v, bus: s.music });
      }
    }
  },
};
