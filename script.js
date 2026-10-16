/* ==========================================================================
 *  FIVE NIGHTS AT XAVIER'S — script.js
 *  A FNAF 4-style bedroom survival horror parody in vanilla JS + Canvas.
 *
 *  Sections
 *   1. Config & tuning
 *   2. Helpers
 *   3. Asset loader + horror photo color-grade
 *   4. Sound engine (100% synthesized with Web Audio — no audio files needed)
 *   5. Pre-rendered scenes (room, hallways, closet, bed)
 *   6. Villain drawing (vector fallbacks + photo faces)
 *   7. AI (Steven Pivac, Xavier, Little Xaviers, Zynovan Snusvac)
 *   8. Game state, input, update loop
 *   9. Rendering (views, lighting, post FX, jumpscare)
 *  10. UI / menus / boot
 *
 *  URL flags for testing:  ?fast  (8-second hours)   ?debug  (AI overlay)
 * ========================================================================== */
'use strict';

/* ==========================================================================
 * 1. CONFIG & TUNING
 * ========================================================================== */
const W = 1280, H = 720, TAU = Math.PI * 2;
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');

const CONFIG = {
  secondsPerHour: params.has('fast') ? 8 : 50,  // 6 hours → 5 real minutes
  batteryDrain: 0.55,       // % per second while the flashlight is on
  transitionTime: 0.34,     // seconds it takes Raoul to run between spots
  startGrace: 7,            // seconds of calm at 12 AM
  imageExtensions: ['png', 'jpg', 'jpeg', 'webp'],
  storageKey: 'fnax-progress',
};

/* Villain look + lines. Colors are used by the vector fallbacks. */
const VILLAINS = {
  xavier: {
    name: 'Xavier', body: '#6e4b1f', dark: '#241505', accent: '#c9a24a', eye: '#ff2a1a',
    quotes: ['"You should have looked behind you, Raoul."', '"Every friend has a face. I wear all of them."',
             '"Lights out, Raoul."', '"Did you really think the little ones were harmless?"'],
  },
  steven: {
    name: 'Steven Pivac', body: '#4a3b63', dark: '#171022', accent: '#9b88c4', eye: '#ff3b2f',
    quotes: ['"Breathing that loud? Rookie mistake."', '"I was RIGHT outside the door, Raoul."',
             '"You never close the door in time."'],
  },
  zynovan: {
    name: 'Zynovan Snusvac', body: '#3c5a36', dark: '#121e0e', accent: '#9fc37a', eye: '#ff2f6a',
    quotes: ['"Want a pouch? ...Too late."', '"The closet was never empty, Raoul."',
             '"Shhh. Tins rattle, Raoul. So do bones."'],
  },
};

/* AI aggression per night (0 = inactive, 20 = relentless). */
const NIGHTS = [
  { steven: 4,  xavier: 0,  minis: 3,  zynovan: 0,
    msg: '"Your parents are gone for the week, Raoul. Steven wants to say hi." — X',
    tip: 'Steven Pivac stalks the LEFT hall. Far away? Flash him. Breathing at the door? NO light — hold the door. Little Xaviers may crawl onto your bed: turn around and flash them.' },
  { steven: 7,  xavier: 3,  minis: 5,  zynovan: 2,
    msg: '"I let myself in. Hope you don\'t mind." — X',
    tip: 'Xavier now prowls the RIGHT hall. He doesn\'t breathe — he whispers. Something is rattling in the closet…' },
  { steven: 9,  xavier: 7,  minis: 7,  zynovan: 7,
    msg: '"Zynovan found your closet. He likes it in there." — X',
    tip: 'Check the CLOSET. Hold it shut to push Zynovan back. If he\'s fully out, hold it until the banging stops.' },
  { steven: 12, xavier: 11, minis: 9,  zynovan: 11,
    msg: '"We\'re getting hungry, Raoul." — X',
    tip: 'They\'re faster now. Stand at a door with the light OFF and listen.' },
  { steven: 16, xavier: 16, minis: 12, zynovan: 15,
    msg: '"No more games. Tonight I come myself." — X',
    tip: 'Xavier is done playing. Survive.' },
  { steven: 20, xavier: 20, minis: 16, zynovan: 20,
    msg: '"N̷I̵G̴H̸T̷M̶A̵R̸E̶."',
    tip: 'Nightmare mode. Everything. All at once.' },
];

/* ==========================================================================
 * 2. HELPERS
 * ========================================================================== */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));
const chance = (p) => Math.random() < p;
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const approach = (v, t, s) => (v < t ? Math.min(t, v + s) : Math.max(t, v - s));
const roll = (level) => Math.random() * 20 < level;   // FNAF-style AI opportunity roll

function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function seeded(seed) { return () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }; }

function rr(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
function poly(c, pts) {
  c.beginPath(); c.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
  c.closePath();
}
function ell(c, x, y, rx, ry, rot = 0) { c.beginPath(); c.ellipse(x, y, Math.abs(rx), Math.abs(ry), rot, 0, TAU); }
function circ(c, x, y, r) { c.beginPath(); c.arc(x, y, Math.abs(r), 0, TAU); }
function line(c, x1, y1, x2, y2) { c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); }
function linGrad(c, x1, y1, x2, y2, stops) {
  const g = c.createLinearGradient(x1, y1, x2, y2);
  stops.forEach((s, i) => g.addColorStop(i / (stops.length - 1), s));
  return g;
}
/* Draw an image so it covers the given box (like CSS object-fit: cover). */
function drawCover(c, img, x, y, w, h) {
  const s = Math.max(w / img.width, h / img.height);
  const iw = img.width * s, ih = img.height * s;
  c.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
}

/* ==========================================================================
 * 3. ASSET LOADER + HORROR COLOR GRADE
 *    Looks for optional photos in /assets/. Every missing file silently
 *    falls back to the built-in vector art, so the game always runs.
 * ========================================================================== */
const ASSET_MANIFEST = [
  { key: 'xavier/normal',     paths: ['assets/villains/xavier/normal'],     kind: 'head', label: 'Xavier — face (normal)' },
  { key: 'xavier/jumpscare',  paths: ['assets/villains/xavier/jumpscare'],  kind: 'full', label: 'Xavier — jumpscare' },
  { key: 'xavier/hallway',    paths: ['assets/villains/xavier/hallway'],    kind: 'full', label: 'Xavier — hallway' },
  { key: 'steven/normal',     paths: ['assets/villains/steven/normal'],     kind: 'head', label: 'Steven Pivac — face (normal)' },
  { key: 'steven/jumpscare',  paths: ['assets/villains/steven/jumpscare'],  kind: 'full', label: 'Steven Pivac — jumpscare' },
  { key: 'steven/hallway',    paths: ['assets/villains/steven/hallway'],    kind: 'full', label: 'Steven Pivac — hallway' },
  { key: 'zynovan/normal',    paths: ['assets/villains/zynovan/normal'],    kind: 'head', label: 'Zynovan Snusvac — face (normal)' },
  { key: 'zynovan/jumpscare', paths: ['assets/villains/zynovan/jumpscare'], kind: 'full', label: 'Zynovan Snusvac — jumpscare' },
  { key: 'zynovan/hallway',   paths: ['assets/villains/zynovan/hallway'],   kind: 'full', label: 'Zynovan Snusvac — closet/full body' },
  { key: 'player/raoul',      paths: ['assets/player/raoul', 'assets/player/normal'], kind: 'head', label: 'Raoul Mann — face' },
];

const Assets = {
  store: {},

  loadImage(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth > 0 ? img : null);
      img.onerror = () => resolve(null);           // 404 / not an image → fallback
      img.src = src;
    });
  },

  /* Try each base path with each extension until one loads. */
  async tryPaths(paths) {
    for (const base of paths) {
      for (const ext of CONFIG.imageExtensions) {
        const img = await this.loadImage(`${base}.${ext}`);
        if (img) return { img, path: `${base}.${ext}` };
      }
    }
    return null;
  },

  async loadAll(onProgress) {
    let done = 0;
    await Promise.all(ASSET_MANIFEST.map(async (entry) => {
      const result = await this.tryPaths(entry.paths);
      if (result) {
        let graded;
        try { graded = gradePhoto(result.img, entry.kind); } catch (e) { graded = result.img; }
        this.store[entry.key] = { found: true, path: result.path, graded };
      } else {
        this.store[entry.key] = { found: false };
      }
      done++;
      if (onProgress) onProgress(done / ASSET_MANIFEST.length, entry, !!result);
    }));
  },

  get(key) { const a = this.store[key]; return a && a.found ? a.graded : null; },
};

/**
 * gradePhoto — turns a bright, friendly real-life photo into something that
 * belongs in a dark animatronic nightmare:
 *   desaturate → crush blacks / boost contrast → sickly red-sodium tint →
 *   film grain → scratches → heavy vignette → feathered transparent edges.
 * Uses per-pixel processing; if the canvas is "tainted" (e.g. opened via
 * file://) it falls back to CSS-style canvas filters.
 */
function gradePhoto(img, kind) {
  const maxDim = 900;
  const s = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * s));
  const h = Math.max(1, Math.round(img.naturalHeight * s));
  const c = makeCanvas(w, h), x = c.getContext('2d');
  x.drawImage(img, 0, 0, w, h);

  try {
    const data = x.getImageData(0, 0, w, h), p = data.data;
    for (let i = 0; i < p.length; i += 4) {
      let r = p[i], g = p[i + 1], b = p[i + 2];
      const l = r * 0.299 + g * 0.587 + b * 0.114;
      r = l + (r - l) * 0.3; g = l + (g - l) * 0.3; b = l + (b - l) * 0.3;        // desaturate 70%
      r = (r - 128) * 1.6 + 128 - 20;                                              // contrast + crush
      g = (g - 128) * 1.6 + 128 - 26;
      b = (b - 128) * 1.6 + 128 - 32;
      r *= 1.12; g *= 0.9; b *= 0.78;                                              // sickly grade
      const n = (Math.random() - 0.5) * 30;                                        // grain
      p[i] = clamp(r + n, 0, 255); p[i + 1] = clamp(g + n, 0, 255); p[i + 2] = clamp(b + n, 0, 255);
    }
    x.putImageData(data, 0, 0);
  } catch (err) {
    // Tainted canvas (file://) → filter fallback (ignored by browsers without ctx.filter)
    x.clearRect(0, 0, w, h);
    x.filter = 'grayscale(0.7) sepia(0.35) contrast(1.6) brightness(0.72) saturate(1.4) hue-rotate(-12deg)';
    x.drawImage(img, 0, 0, w, h);
    x.filter = 'none';
  }

  // Scratches & dust
  const R = seeded(w * 31 + h);
  x.strokeStyle = 'rgba(255,240,220,0.08)';
  x.lineWidth = 1;
  for (let i = 0; i < 14; i++) { const sx = R() * w; line(x, sx, 0, sx + (R() - 0.5) * 40, h); }

  // Vignette
  const g = x.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.2, w / 2, h / 2, Math.max(w, h) * 0.72);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.92)');
  x.fillStyle = g;
  x.fillRect(0, 0, w, h);

  // Feather edges into transparency so the photo melts into the dark.
  x.globalCompositeOperation = 'destination-in';
  x.save();
  x.translate(w / 2, h / 2);
  x.scale(w / 2, h / 2);
  const f = x.createRadialGradient(0, 0, 0, 0, 0, 1);
  f.addColorStop(0, 'rgba(0,0,0,1)');
  f.addColorStop(kind === 'head' ? 0.62 : 0.78, 'rgba(0,0,0,1)');
  f.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = f;
  x.fillRect(-1, -1, 2, 2);
  x.restore();
  x.globalCompositeOperation = 'source-over';
  return c;
}

/* ==========================================================================
 * 4. SOUND ENGINE — everything is synthesized, so there are no audio files.
 * ========================================================================== */
const Sound = {
  ctx: null, master: null, noiseBuf: null, loops: {}, muted: false,

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 5;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(comp); comp.connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    const n = 1024, curve = new Float32Array(n), k = 60;
    for (let i = 0; i < n; i++) { const xx = (i * 2) / n - 1; curve[i] = ((1 + k) * xx) / (1 + k * Math.abs(xx)); }
    this.distCurve = curve;
  },
  get ok() { return !!this.ctx && !this.muted; },
  now() { return this.ctx.currentTime; },
  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, this.now(), 0.05);
  },
  suspend() { if (this.ctx) this.ctx.suspend(); },
  resume() { if (this.ctx) this.ctx.resume(); },

  noise() { const s = this.ctx.createBufferSource(); s.buffer = this.noiseBuf; s.loop = true; return s; },
  pan(v) {
    if (this.ctx.createStereoPanner) { const p = this.ctx.createStereoPanner(); p.pan.value = clamp(v, -1, 1); return p; }
    return this.ctx.createGain();
  },
  env(node, t0, attack, peak, dur) {
    const g = node.gain;
    g.setValueAtTime(0.0001, t0);
    g.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + attack);
    g.exponentialRampToValueAtTime(0.0001, t0 + Math.max(dur, attack + 0.01));
  },

  /* Filtered noise one-shot */
  burst({ type = 'lowpass', freq = 400, q = 1, dur = 0.2, vol = 0.5, pan = 0, when = 0, attack = 0.005 }) {
    if (!this.ok || vol <= 0) return;
    const c = this.ctx, t0 = this.now() + when;
    const s = this.noise(), f = c.createBiquadFilter(), g = c.createGain(), p = this.pan(pan);
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    this.env(g, t0, attack, vol, dur);
    s.connect(f).connect(g).connect(p).connect(this.master);
    s.start(t0, Math.random() * 1.5); s.stop(t0 + dur + 0.05);
  },
  /* Oscillator one-shot */
  tone({ type = 'sine', freq = 440, freqEnd = null, dur = 0.3, vol = 0.3, pan = 0, when = 0, attack = 0.008 }) {
    if (!this.ok || vol <= 0) return;
    const c = this.ctx, t0 = this.now() + when;
    const o = c.createOscillator(), g = c.createGain(), p = this.pan(pan);
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
    this.env(g, t0, attack, vol, dur);
    o.connect(g).connect(p).connect(this.master);
    o.start(t0); o.stop(t0 + dur + 0.05);
  },

  footstep(pan = 0, vol = 0.5, when = 0) {
    this.burst({ type: 'lowpass', freq: 170, q: 0.7, dur: 0.24, vol, pan, when });
    this.tone({ freq: 64, freqEnd: 36, dur: 0.26, vol: vol * 0.9, pan, when });
    this.burst({ type: 'bandpass', freq: 1300, q: 5, dur: 0.07, vol: vol * 0.12, pan, when: when + 0.03 }); // board creak
  },
  footsteps(pan, vol, n = 3, gap = 0.5, fade = 0) {
    for (let i = 0; i < n; i++) this.footstep(pan, vol * (1 - (fade * i) / n), i * gap + rand(0, 0.05));
  },
  rattle(pan = 0, vol = 0.15) {             // Zynovan's snus tin
    let w = 0;
    const n = 6 + ((Math.random() * 6) | 0);
    for (let i = 0; i < n; i++) {
      this.burst({ type: 'highpass', freq: 3800, q: 1, dur: 0.03, vol, pan, when: w });
      this.tone({ type: 'square', freq: rand(1700, 2700), dur: 0.02, vol: vol * 0.25, pan, when: w });
      w += rand(0.035, 0.085);
    }
  },
  giggle(pan = 0, vol = 0.06) {             // Little Xaviers
    const base = rand(620, 820);
    for (let i = 0; i < 5; i++) {
      const f = base * (1 + i * 0.11) * (i % 2 ? 1.06 : 1);
      this.tone({ type: 'triangle', freq: f, freqEnd: f * 0.86, dur: 0.09, vol, pan, when: i * 0.1 });
    }
  },
  whisper(pan = 0, vol = 0.18, n = 6) {     // Xavier's whispering
    for (let i = 0; i < n; i++) {
      this.burst({ type: 'bandpass', freq: rand(2200, 4400), q: 6, dur: rand(0.12, 0.26), vol, pan, when: i * 0.2 + rand(0, 0.08), attack: 0.04 });
    }
  },
  doorSlam(pan = 0) {
    this.burst({ type: 'lowpass', freq: 320, dur: 0.35, vol: 0.7, pan });
    this.tone({ freq: 72, freqEnd: 44, dur: 0.3, vol: 0.6, pan });
    this.burst({ type: 'bandpass', freq: 2100, q: 9, dur: 0.15, vol: 0.12, pan });
  },
  bang(pan = 0) {
    this.burst({ type: 'lowpass', freq: 260, dur: 0.4, vol: 0.9, pan });
    this.tone({ freq: 58, freqEnd: 32, dur: 0.35, vol: 0.8, pan });
    this.burst({ type: 'bandpass', freq: 900, q: 3, dur: 0.12, vol: 0.25, pan });
  },
  click() {
    this.tone({ type: 'square', freq: 2400, dur: 0.012, vol: 0.08 });
    this.tone({ type: 'square', freq: 900, dur: 0.015, vol: 0.06, when: 0.012 });
  },
  run() {
    this.burst({ type: 'bandpass', freq: 500, q: 0.6, dur: 0.3, vol: 0.18, attack: 0.08 });
    this.footstep(0, 0.12); this.footstep(0, 0.1, 0.16);
  },
  heartbeat(vol = 0.35) {
    this.tone({ freq: 58, freqEnd: 40, dur: 0.14, vol });
    this.tone({ freq: 52, freqEnd: 38, dur: 0.14, vol: vol * 0.7, when: 0.2 });
  },
  shuffle() { this.burst({ type: 'lowpass', freq: 700, dur: 0.5, vol: 0.25, attack: 0.1 }); },
  screech(pan = 0, vol = 0.3) {
    this.tone({ type: 'sawtooth', freq: 900, freqEnd: 300, dur: 0.35, vol, pan });
    this.burst({ type: 'bandpass', freq: 2600, q: 2, dur: 0.3, vol: vol * 0.6, pan });
  },
  glitch() {
    this.burst({ type: 'bandpass', freq: 3000, q: 0.4, dur: 0.12, vol: 0.4 });
    this.tone({ type: 'square', freq: 120, freqEnd: 2400, dur: 0.12, vol: 0.18 });
  },
  tick() { this.tone({ freq: 1400, dur: 0.05, vol: 0.06 }); },
  staticNoise(dur = 1.5, vol = 0.25) { this.burst({ type: 'bandpass', freq: 2600, q: 0.3, dur, vol, attack: 0.02 }); },
  chime() {                                   // 6 AM bells
    for (let i = 0; i < 6; i++) {
      const w = i * 0.95;
      [880, 1760, 2640].forEach((f, k) => this.tone({ freq: f, dur: 2.2, vol: 0.14 / (k + 1), when: w, attack: 0.005 }));
    }
    this.tone({ freq: 220, dur: 5, vol: 0.12, when: 0 });
  },
  scream() {                                  // the jumpscare
    if (!this.ok) return;
    const c = this.ctx, t0 = this.now(), dur = 1.9;
    const out = c.createGain();
    out.gain.setValueAtTime(0.0001, t0);
    out.gain.exponentialRampToValueAtTime(1.0, t0 + 0.03);
    out.gain.setValueAtTime(1.0, t0 + dur - 0.45);
    out.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    const ws = c.createWaveShaper(); ws.curve = this.distCurve;
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 120;
    ws.connect(hp).connect(out).connect(this.master);
    [180, 263, 377, 521, 740].forEach((f, i) => {
      const o = c.createOscillator(), g = c.createGain(), lfo = c.createOscillator(), lg = c.createGain();
      o.type = i % 2 ? 'sawtooth' : 'square';
      o.frequency.setValueAtTime(f * 0.7, t0);
      o.frequency.exponentialRampToValueAtTime(f * 1.6, t0 + 0.25);
      o.frequency.exponentialRampToValueAtTime(f * 1.1, t0 + dur);
      lfo.frequency.value = 21 + i * 3; lg.gain.value = f * 0.15;
      lfo.connect(lg).connect(o.frequency);
      g.gain.value = 0.16;
      o.connect(g).connect(ws);
      o.start(t0); lfo.start(t0); o.stop(t0 + dur); lfo.stop(t0 + dur);
    });
    const n = this.noise(), bp = c.createBiquadFilter(), ng = c.createGain();
    bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.7; ng.gain.value = 0.5;
    n.connect(bp).connect(ng).connect(ws); n.start(t0); n.stop(t0 + dur);
  },

  /* --- Continuous loops: ambience, Steven's breathing, Xavier's whispering --- */
  startLoops() {
    if (!this.ctx) return;
    this.stopLoops();
    const c = this.ctx, t = this.now();

    // Ambient drone + room hiss
    const dg = c.createGain(); dg.gain.value = 0; dg.connect(this.master);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 140; lp.connect(dg);
    const o1 = c.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 41.2; o1.connect(lp);
    const o2 = c.createOscillator(); o2.type = 'sawtooth'; o2.frequency.value = 41.9; o2.connect(lp);
    const o3 = c.createOscillator(); o3.type = 'sine'; o3.frequency.value = 61.7;
    const g3 = c.createGain(); g3.gain.value = 0.4; o3.connect(g3).connect(lp);
    const lfo = c.createOscillator(); lfo.frequency.value = 0.07;
    const lfoG = c.createGain(); lfoG.gain.value = 60; lfo.connect(lfoG).connect(lp.frequency);
    const hiss = this.noise(), hp = c.createBiquadFilter(), hg = c.createGain();
    hp.type = 'highpass'; hp.frequency.value = 5000; hg.gain.value = 0.05;
    hiss.connect(hp).connect(hg).connect(dg);
    [o1, o2, o3, lfo, hiss].forEach((s) => s.start(t));
    dg.gain.setTargetAtTime(0.2, t, 2);
    this.loops.drone = { gain: dg, srcs: [o1, o2, o3, lfo, hiss] };

    // Breathing (Steven, left) and whispering (Xavier, right)
    const mk = (name, pan, freq, q) => {
      const s = this.noise(), f = c.createBiquadFilter(), g = c.createGain(), p = this.pan(pan);
      f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
      g.gain.value = 0;
      s.connect(f).connect(g).connect(p).connect(this.master);
      s.start(t);
      this.loops[name] = { gain: g, filter: f, srcs: [s] };
    };
    mk('steven', -0.85, 450, 0.9);
    mk('xavier', 0.85, 2800, 5);
  },
  setLoop(name, vol, tc = 0.06, freq) {
    const L = this.loops[name];
    if (!L || !this.ctx) return;
    L.gain.gain.setTargetAtTime(this.muted ? 0 : vol, this.now(), tc);
    if (freq && L.filter) L.filter.frequency.setTargetAtTime(freq, this.now(), 0.05);
  },
  stopLoops() {
    if (!this.ctx) return;
    const t = this.now();
    Object.values(this.loops).forEach((L) => {
      L.gain.gain.cancelScheduledValues(t);
      L.gain.gain.setTargetAtTime(0, t, 0.05);
      L.srcs.forEach((s) => { try { s.stop(t + 0.4); } catch (e) { /* already stopped */ } });
    });
    this.loops = {};
  },
};

/* ==========================================================================
 * 5. PRE-RENDERED SCENES
 *    Static backgrounds are painted once into off-screen canvases; only the
 *    moving parts (villains, doors, light) are drawn every frame.
 * ========================================================================== */
const Scenes = {};
const DOOR = { L: 300, R: 980, T: 40, B: 720 };                  // hallway doorway (door views)
const FAR = { l: 595, r: 685, t: 335, b: 435 };                  // far end of the hallway

function stripes(c, x, y, w, h, gap = 34, alpha = 0.035) {
  c.fillStyle = `rgba(255,255,255,${alpha})`;
  for (let i = x; i < x + w; i += gap) c.fillRect(i, y, gap * 0.4, h);
  c.fillStyle = 'rgba(0,0,0,0.12)';
  for (let i = x + gap * 0.7; i < x + w; i += gap) c.fillRect(i, y, 2, h);
}
function grime(c, R, n, x, y, w, h) {
  for (let i = 0; i < n; i++) {
    const gx = x + R() * w, gy = y + R() * h, gr = 20 + R() * 90;
    const g = c.createRadialGradient(gx, gy, 0, gx, gy, gr);
    g.addColorStop(0, `rgba(20,10,5,${0.15 + R() * 0.25})`);
    g.addColorStop(1, 'rgba(20,10,5,0)');
    c.fillStyle = g; c.fillRect(gx - gr, gy - gr, gr * 2, gr * 2);
  }
}

function buildScenes() {
  const mk = (fn, ...a) => { const cv = makeCanvas(W, H); fn(cv.getContext('2d'), ...a); return cv; };
  Scenes.center = mk(paintCenter);
  Scenes.hall_left = mk(paintHall, false);
  Scenes.hall_right = mk(paintHall, true);
  Scenes.closetBack = mk(paintClosetBack);
  Scenes.clothes = mk(paintClothes, false);
  Scenes.clothesParted = mk(paintClothes, true);
  Scenes.bedBack = mk(paintBedBack);
  Scenes.bedFront = mk(paintBedFront);

  // Vignette
  Scenes.vignette = mk((c) => {
    const g = c.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, W * 0.72);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.7, 'rgba(0,0,0,0.45)'); g.addColorStop(1, 'rgba(0,0,0,0.92)');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
  });

  // Film grain tiles
  Scenes.grain = [];
  for (let k = 0; k < 4; k++) {
    const g = makeCanvas(256, 256), gc = g.getContext('2d'), img = gc.createImageData(256, 256);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
    }
    gc.putImageData(img, 0, 0);
    Scenes.grain.push(ctx.createPattern(g, 'repeat'));
  }
}

/* --- Center view: Raoul's bedroom looking forward --- */
function wallDoor(c, side) {
  const top = (x) => (110 * x) / 260, bot = (x) => 720 - (200 * x) / 260;
  const dt = (x) => top(x) + (bot(x) - top(x)) * 0.16;
  const x1 = 40, x2 = 205;
  let pts = [x1, dt(x1), x2, dt(x2), x2, bot(x2) - 2, x1, bot(x1) - 2];
  if (side === 'right') pts = pts.map((v, i) => (i % 2 === 0 ? W - v : v));
  c.fillStyle = '#040305'; poly(c, pts); c.fill();
  c.strokeStyle = '#3d2a1b'; c.lineWidth = 12; poly(c, pts); c.stroke();
  c.strokeStyle = 'rgba(0,0,0,0.6)'; c.lineWidth = 3; poly(c, pts); c.stroke();
}

function paintCenter(c) {
  const R = seeded(7);
  c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
  // ceiling
  c.fillStyle = linGrad(c, 0, 0, 0, 110, ['#16131b', '#29242f']); poly(c, [0, 0, W, 0, 1020, 110, 260, 110]); c.fill();
  // back wall
  c.fillStyle = '#3a3346'; c.fillRect(260, 110, 760, 410);
  stripes(c, 260, 110, 760, 330);
  grime(c, R, 8, 260, 110, 760, 330);
  c.fillStyle = '#2b2435'; c.fillRect(260, 440, 760, 80);
  c.fillStyle = '#4a3a2a'; c.fillRect(260, 436, 760, 6);
  // side walls
  c.fillStyle = linGrad(c, 0, 0, 260, 0, ['#17141d', '#312a3b']); poly(c, [0, 0, 260, 110, 260, 520, 0, 720]); c.fill();
  c.fillStyle = linGrad(c, W, 0, 1020, 0, ['#17141d', '#312a3b']); poly(c, [W, 0, 1020, 110, 1020, 520, W, 720]); c.fill();
  // floor
  c.fillStyle = linGrad(c, 0, 520, 0, 720, ['#3b2c20', '#1d150e']); poly(c, [260, 520, 1020, 520, W, 720, 0, 720]); c.fill();
  c.strokeStyle = 'rgba(0,0,0,0.35)'; c.lineWidth = 2;
  for (let i = 0; i <= 16; i++) { const u = i / 16; line(c, lerp(260, 1020, u), 520, lerp(-200, 1480, u), 720); }
  for (let j = 1; j < 6; j++) { const v = Math.pow(j / 6, 1.6), y = lerp(520, 720, v); line(c, lerp(260, 0, v), y, lerp(1020, W, v), y); }
  // rug
  c.fillStyle = '#3e1418'; ell(c, 640, 640, 320, 58); c.fill();
  c.strokeStyle = '#5a2228'; c.lineWidth = 4; ell(c, 640, 640, 290, 48); c.stroke();
  // doors
  wallDoor(c, 'left'); wallDoor(c, 'right');
  // closet
  c.fillStyle = '#24180f'; c.fillRect(506, 188, 268, 334);
  [[520, 200], [642, 200]].forEach(([x, y]) => {
    c.fillStyle = linGrad(c, x, 0, x + 118, 0, ['#4d3b29', '#5e4831', '#4a3826']); c.fillRect(x, y, 118, 320);
    c.strokeStyle = 'rgba(0,0,0,0.45)'; c.lineWidth = 3;
    c.strokeRect(x + 14, y + 16, 90, 120); c.strokeRect(x + 14, y + 160, 90, 140);
  });
  c.fillStyle = '#020202'; c.fillRect(638, 200, 4, 320);
  c.fillStyle = '#a08040'; circ(c, 628, 365, 6); c.fill(); circ(c, 652, 365, 6); c.fill();
  // poster: XAVIER'S
  c.save(); c.translate(300, 170); c.rotate(-0.03);
  c.fillStyle = '#b8a37a'; c.fillRect(0, 0, 150, 200);
  c.fillStyle = '#6e4b1f'; circ(c, 75, 95, 42); c.fill(); circ(c, 42, 60, 14); c.fill(); circ(c, 108, 60, 14); c.fill();
  c.fillStyle = '#111'; c.fillRect(52, 28, 46, 30); c.fillRect(42, 54, 66, 7);
  c.fillStyle = '#000'; circ(c, 60, 90, 7); c.fill(); circ(c, 90, 90, 7); c.fill();
  c.fillStyle = '#c00'; circ(c, 60, 90, 2.5); c.fill(); circ(c, 90, 90, 2.5); c.fill();
  c.strokeStyle = '#000'; c.lineWidth = 3; c.beginPath(); c.arc(75, 108, 18, 0.15, Math.PI - 0.15); c.stroke();
  c.fillStyle = '#4a0d0d'; c.font = 'bold 24px Georgia, serif'; c.textAlign = 'center'; c.fillText("XAVIER'S", 75, 165);
  c.font = '12px Georgia, serif'; c.fillText('FAMILY FUN CENTER', 75, 184);
  c.strokeStyle = 'rgba(60,0,0,0.6)'; c.lineWidth = 2;
  for (let i = 0; i < 3; i++) line(c, 100 + i * 9, 120, 120 + i * 9, 190);   // claw marks
  c.restore();
  // poster: child's drawing
  c.save(); c.translate(820, 205); c.rotate(0.04);
  c.fillStyle = '#d8d4c8'; c.fillRect(0, 0, 150, 115);
  c.strokeStyle = '#222'; c.lineWidth = 2;
  [[25, '#6e4b1f'], [60, '#4a3b63'], [95, '#3c5a36']].forEach(([x, col]) => {
    c.strokeStyle = col; c.lineWidth = 3;
    circ(c, x, 30, 10); c.stroke(); line(c, x, 40, x, 75); line(c, x, 50, x - 12, 62); line(c, x, 50, x + 12, 62);
    line(c, x, 75, x - 9, 95); line(c, x, 75, x + 9, 95);
    c.fillStyle = '#c00'; circ(c, x - 3, 28, 1.6); c.fill(); circ(c, x + 3, 28, 1.6); c.fill();
  });
  c.strokeStyle = '#2050a0'; c.lineWidth = 2;
  circ(c, 128, 62, 6); c.stroke(); line(c, 128, 68, 128, 85); line(c, 128, 85, 123, 97); line(c, 128, 85, 133, 97);
  c.fillStyle = '#a01010'; c.font = 'bold 12px "Comic Sans MS", cursive'; c.textAlign = 'left';
  c.fillText('ME + MY FRENDS', 12, 110); c.fillText('RAOUL', 112, 50);
  c.restore();
  // emergency light housing
  c.fillStyle = '#0c0c0c'; rr(c, 610, 20, 60, 24, 6); c.fill();
  // toy box (left front)
  c.fillStyle = '#3a2416'; poly(c, [70, 610, 230, 600, 250, 700, 60, 715]); c.fill();
  c.fillStyle = '#4c3020'; poly(c, [70, 610, 230, 600, 220, 580, 85, 588]); c.fill();
  c.fillStyle = '#7a1a1a'; c.font = 'bold 22px Georgia'; c.fillText('TOYS', 115, 668);
  // slumped purple plush (right front)
  c.fillStyle = '#4a3b63';
  ell(c, 1110, 670, 50, 38); c.fill(); circ(c, 1102, 615, 30); c.fill();
  c.save(); c.translate(1090, 585); c.rotate(-0.4); rr(c, -9, -50, 18, 55, 9); c.fill(); c.restore();
  c.save(); c.translate(1118, 590); c.rotate(0.9); rr(c, -9, -45, 18, 50, 9); c.fill(); c.restore();
  c.fillStyle = '#000'; circ(c, 1092, 612, 4); c.fill();
  c.strokeStyle = '#000'; c.lineWidth = 2; line(c, 1106, 606, 1116, 616); line(c, 1116, 606, 1106, 616); // X eye
  grime(c, R, 10, 0, 520, W, 200);
}

/* --- Door views: looking down the hallway. Mirrored for the right door. --- */
function paintHall(c, right) {
  const R = seeded(right ? 99 : 13);
  const { L, R: Rr, T, B } = DOOR, f = FAR;
  c.save();
  if (right) { c.translate(W, 0); c.scale(-1, 1); }
  // bedroom wall around the doorway
  c.fillStyle = '#231e2b'; c.fillRect(0, 0, W, H);
  stripes(c, 0, 0, W, H, 40, 0.03);
  grime(c, R, 10, 0, 0, W, H);
  // ceiling / walls / floor of the hallway
  c.fillStyle = '#141118'; poly(c, [L, T, Rr, T, f.r, f.t, f.l, f.t]); c.fill();
  c.fillStyle = linGrad(c, L, 0, f.l, 0, ['#3a3345', '#221d29']); poly(c, [L, T, f.l, f.t, f.l, f.b, L, B]); c.fill();
  c.fillStyle = linGrad(c, Rr, 0, f.r, 0, ['#332c3d', '#1d1924']); poly(c, [Rr, T, f.r, f.t, f.r, f.b, Rr, B]); c.fill();
  c.fillStyle = linGrad(c, 0, B, 0, f.b, ['#33271c', '#17110c']); poly(c, [L, B, f.l, f.b, f.r, f.b, Rr, B]); c.fill();
  // wallpaper lines receding
  c.strokeStyle = 'rgba(255,255,255,0.05)'; c.lineWidth = 3;
  for (let i = 1; i < 16; i++) {
    const d = 1 - 1 / (1 + i * 0.3);
    line(c, lerp(L, f.l, d), lerp(T, f.t, d), lerp(L, f.l, d), lerp(B, f.b, d));
    line(c, lerp(Rr, f.r, d), lerp(T, f.t, d), lerp(Rr, f.r, d), lerp(B, f.b, d));
  }
  // wainscot rail
  c.strokeStyle = '#3a2a1c'; c.lineWidth = 6;
  line(c, L, lerp(T, B, 0.66), f.l, lerp(f.t, f.b, 0.66));
  line(c, Rr, lerp(T, B, 0.66), f.r, lerp(f.t, f.b, 0.66));
  // floorboards
  c.strokeStyle = 'rgba(0,0,0,0.4)'; c.lineWidth = 2;
  for (let i = 0; i <= 10; i++) { const u = i / 10; line(c, lerp(L, Rr, u), B, lerp(f.l, f.r, u), f.b); }
  for (let i = 1; i < 9; i++) {
    const d = 1 - 1 / (1 + i * 0.4), y = lerp(B, f.b, d);
    line(c, lerp(L, f.l, d), y, lerp(Rr, f.r, d), y);
  }
  // runner rug
  c.fillStyle = 'rgba(80,15,20,0.55)';
  poly(c, [lerp(L, Rr, 0.3), B, lerp(f.l, f.r, 0.3), f.b, lerp(f.l, f.r, 0.7), f.b, lerp(L, Rr, 0.7), B]); c.fill();
  // far doorway
  c.fillStyle = '#000'; c.fillRect(f.l + 18, f.t + 10, f.r - f.l - 36, f.b - f.t - 10);
  // wall decoration
  const q = (d1, d2, y1, y2) => [lerp(L, f.l, d1), lerp(lerp(T, B, y1), lerp(f.t, f.b, y1), d1),
    lerp(L, f.l, d2), lerp(lerp(T, B, y1), lerp(f.t, f.b, y1), d2),
    lerp(L, f.l, d2), lerp(lerp(T, B, y2), lerp(f.t, f.b, y2), d2),
    lerp(L, f.l, d1), lerp(lerp(T, B, y2), lerp(f.t, f.b, y2), d1)];
  if (!right) {
    // creepy portrait
    c.fillStyle = '#2a1a10'; poly(c, q(0.14, 0.36, 0.22, 0.5)); c.fill();
    c.fillStyle = '#4a4038'; poly(c, q(0.17, 0.33, 0.26, 0.46)); c.fill();
    c.fillStyle = '#0d0a08'; ell(c, lerp(L, f.l, 0.25), lerp(lerp(T, B, 0.35), lerp(f.t, f.b, 0.35), 0.25), 18, 30); c.fill();
  } else {
    // stopped wall clock
    const cx = lerp(L, f.l, 0.22), cy = lerp(lerp(T, B, 0.3), lerp(f.t, f.b, 0.3), 0.22);
    c.fillStyle = '#2b1d12'; ell(c, cx, cy, 30, 44); c.fill();
    c.fillStyle = '#9c9480'; ell(c, cx, cy, 22, 34); c.fill();
    c.strokeStyle = '#111'; c.lineWidth = 3; line(c, cx, cy, cx, cy - 26); line(c, cx, cy, cx + 8, cy + 6);
  }
  // distance fog
  c.save(); c.beginPath(); c.rect(L, T, Rr - L, B - T); c.clip();
  const g = c.createRadialGradient(640, 385, 0, 640, 385, 430);
  g.addColorStop(0, 'rgba(0,0,0,0.97)'); g.addColorStop(0.3, 'rgba(0,0,0,0.65)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g; c.fillRect(L, T, Rr - L, B - T);
  c.restore();
  // door frame
  c.fillStyle = '#3a271a';
  c.fillRect(L - 36, T - 32, 36, B - T + 32); c.fillRect(Rr, T - 32, 36, B - T + 32); c.fillRect(L - 36, T - 32, Rr - L + 72, 32);
  c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 3;
  c.strokeRect(L - 26, T - 22, Rr - L + 52, B - T + 40);
  c.fillStyle = '#6a6050'; c.fillRect(L - 10, 140, 8, 46); c.fillRect(L - 10, 520, 8, 46);     // hinges
  // light switch on the bedroom wall
  c.fillStyle = '#c9c2b0'; rr(c, 1070, 330, 34, 56, 4); c.fill();
  c.fillStyle = '#888'; c.fillRect(1082, 346, 10, 22);
  c.restore();
}

/* --- Closet view --- */
function paintClosetBack(c) {
  const R = seeded(5);
  c.fillStyle = '#211c27'; c.fillRect(0, 0, W, H);
  stripes(c, 0, 0, W, H, 38, 0.028);
  c.fillStyle = '#3a271a'; c.fillRect(205, 0, 870, H);            // frame
  c.fillStyle = linGrad(c, 0, 30, 0, 720, ['#0e0a08', '#1d140d']); c.fillRect(240, 30, 800, 690);
  c.fillStyle = '#0a0705'; poly(c, [240, 30, 300, 80, 300, 690, 240, 720]); c.fill();
  poly(c, [1040, 30, 980, 80, 980, 690, 1040, 720]); c.fill();
  c.fillStyle = '#1a120c'; c.fillRect(300, 80, 680, 610);
  grime(c, R, 8, 300, 80, 680, 610);
  // shelf + boxes
  c.fillStyle = '#3c2a1b'; c.fillRect(240, 100, 800, 14);
  c.fillStyle = '#2a1d13'; c.fillRect(340, 58, 120, 42); c.fillRect(480, 70, 80, 30); c.fillRect(800, 50, 140, 50);
  c.fillStyle = '#5a1a1a'; c.font = 'bold 14px Georgia'; c.fillText('OLD TOYS', 356, 85);
  // rod
  c.strokeStyle = '#6d6a64'; c.lineWidth = 6; line(c, 300, 160, 980, 160);
  // floor of closet
  c.fillStyle = '#0c0805'; poly(c, [240, 720, 300, 690, 980, 690, 1040, 720]); c.fill();
  // old shoes
  c.fillStyle = '#1e1612'; ell(c, 380, 690, 34, 12); c.fill(); ell(c, 430, 694, 34, 12); c.fill();
}

function paintClothes(c, parted) {
  const R = seeded(42);
  const cols = ['#2b2f3a', '#3a2a2a', '#26332b', '#3a3530', '#1f1f26', '#40303f', '#33291f', '#283040'];
  const items = [{ x: 330, w: 88 }, { x: 410, w: 80 }, { x: 492, w: 94 }, { x: 570, w: 68 },
                 { x: 712, w: 72 }, { x: 792, w: 94 }, { x: 878, w: 84 }, { x: 952, w: 66 }];
  items.forEach((it, i) => {
    let x = it.x;
    if (parted) x += x < 640 ? -58 + (x - 640) * 0.08 : 58 + (x - 640) * 0.08;
    const len = 300 + R() * 170, w = it.w, col = cols[i % cols.length];
    c.strokeStyle = '#777'; c.lineWidth = 3;
    c.beginPath(); c.arc(x, 152, 8, Math.PI, TAU * 0.95); c.stroke();
    line(c, x - w / 2 + 6, 182, x, 162); line(c, x + w / 2 - 6, 182, x, 162);
    c.fillStyle = col;
    c.beginPath();
    c.moveTo(x - w / 2, 180); c.lineTo(x + w / 2, 180);
    c.lineTo(x + w / 2 + 8, 180 + len);
    for (let k = 6; k >= 0; k--) c.lineTo(x - w / 2 - 8 + ((w + 16) * k) / 6, 180 + len + (k % 2 ? 10 : -6) * R());
    c.closePath(); c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.45)'; c.lineWidth = 2;
    for (let k = 0; k < 3; k++) { const fx = x - w / 3 + (k * w) / 3 + R() * 8; line(c, fx, 200, fx + (R() - 0.5) * 10, 170 + len); }
    c.fillStyle = 'rgba(255,255,255,0.04)'; c.fillRect(x - w / 2, 180, w * 0.25, len);
  });
}

/* --- Bed view (turned around) --- */
function paintBedBack(c) {
  const R = seeded(77);
  c.fillStyle = '#2b2634'; c.fillRect(0, 0, W, H);
  stripes(c, 0, 0, W, 520, 36, 0.03);
  grime(c, R, 10, 0, 0, W, 520);
  c.fillStyle = '#251c14'; c.fillRect(0, 520, W, 200);
  c.fillStyle = '#3d2c1e'; c.fillRect(0, 512, W, 10);
  // window
  c.fillStyle = '#1a1212'; c.fillRect(830, 80, 220, 190);
  c.fillStyle = linGrad(c, 0, 90, 0, 260, ['#0c1324', '#1b2a4a']); c.fillRect(842, 92, 196, 166);
  c.fillStyle = 'rgba(170,190,230,0.55)'; circ(c, 990, 130, 20); c.fill();
  c.fillStyle = '#1a1212'; c.fillRect(936, 92, 8, 166); c.fillRect(842, 170, 196, 8);
  c.fillStyle = '#3b1f2a'; c.fillRect(800, 60, 44, 240); c.fillRect(1036, 60, 44, 240);
  c.strokeStyle = 'rgba(0,0,0,0.4)'; c.lineWidth = 2;
  for (let i = 0; i < 4; i++) { line(c, 806 + i * 10, 60, 806 + i * 10, 300); line(c, 1042 + i * 10, 60, 1042 + i * 10, 300); }
  // nightstand + dead lamp
  c.fillStyle = '#2e2016'; c.fillRect(110, 390, 160, 170);
  c.strokeStyle = 'rgba(0,0,0,0.5)'; c.strokeRect(124, 410, 132, 60); c.strokeRect(124, 482, 132, 60);
  c.fillStyle = '#4a3a2a'; c.fillRect(178, 340, 12, 50);
  c.fillStyle = '#5a4a3a'; poly(c, [150, 340, 218, 340, 204, 290, 164, 290]); c.fill();
}

function paintBedFront(c) {
  // headboard
  c.fillStyle = '#3a271a'; c.fillRect(312, 200, 26, 330); c.fillRect(942, 200, 26, 330);
  c.fillStyle = '#4a3322';
  c.beginPath(); c.moveTo(338, 420); c.lineTo(338, 270); c.quadraticCurveTo(640, 200, 942, 270); c.lineTo(942, 420); c.closePath(); c.fill();
  c.strokeStyle = 'rgba(0,0,0,0.4)'; c.lineWidth = 3;
  for (let i = 0; i < 8; i++) line(c, 380 + i * 75, 262 - Math.sin((i / 7) * Math.PI) * 30, 380 + i * 75, 420);
  // mattress + sheet
  c.fillStyle = '#4a4e66'; poly(c, [290, 400, 990, 400, 1160, 720, 120, 720]); c.fill();
  c.fillStyle = '#383b50'; poly(c, [120, 720, 290, 400, 280, 420, 100, 720]); c.fill();
  // pillow
  c.fillStyle = '#8c8ca6'; rr(c, 470, 382, 340, 72, 32); c.fill();
  c.fillStyle = 'rgba(0,0,0,0.18)'; rr(c, 470, 425, 340, 29, 14); c.fill();
  // blanket
  c.fillStyle = '#3c4058'; poly(c, [250, 535, 1030, 535, 1200, 720, 80, 720]); c.fill();
  c.strokeStyle = 'rgba(0,0,0,0.3)'; c.lineWidth = 3;
  for (let i = 0; i < 6; i++) {
    c.beginPath(); c.moveTo(300 + i * 130, 545); c.bezierCurveTo(330 + i * 130, 600, 260 + i * 150, 650, 240 + i * 170, 720); c.stroke();
  }
  c.fillStyle = 'rgba(255,255,255,0.05)'; poly(c, [250, 535, 1030, 535, 1040, 550, 240, 550]); c.fill();
}

/* ==========================================================================
 * 6. VILLAIN DRAWING
 *    Figures are drawn in local units: feet at (0,0), head centre at (0,-350).
 *    If assets/villains/<id>/normal.png exists, it becomes the robot's face.
 * ========================================================================== */
function eye(c, x, y, rx, ry, lit, col) {
  c.fillStyle = '#050303'; ell(c, x, y, rx, ry); c.fill();
  if (lit) {
    c.save(); c.shadowColor = col; c.shadowBlur = 22;
    c.fillStyle = col; circ(c, x, y, rx * 0.3); c.fill();
    c.fillStyle = '#fff'; circ(c, x, y, rx * 0.1); c.fill();
    c.restore();
  } else {
    c.fillStyle = 'rgba(255,255,255,0.55)'; circ(c, x, y, rx * 0.12); c.fill();
  }
}

function mouth(c, cx, cy, w, open, V, n = 9, sharp = 1) {
  const gap = 6 + open * 60;
  c.fillStyle = '#140404'; ell(c, cx, cy + gap / 2, w, gap / 2 + 8); c.fill();
  c.fillStyle = '#e6dcc4';
  const tw = (2 * w) / n;
  for (let i = 0; i < n; i++) {
    const x = cx - w + (i + 0.5) * tw, len = (12 + ((i * 7) % 5) * 3) * sharp;
    poly(c, [x - tw / 2 + 1, cy - 2, x + tw / 2 - 1, cy - 2, x, cy + len]); c.fill();
  }
  c.fillStyle = V.body; rr(c, cx - w * 0.92, cy + gap, w * 1.84, 26, 10); c.fill();
  c.strokeStyle = V.dark; c.lineWidth = 4; rr(c, cx - w * 0.92, cy + gap, w * 1.84, 26, 10); c.stroke();
  c.fillStyle = '#e6dcc4';
  for (let i = 0; i < n - 1; i++) {
    const x = cx - w * 0.85 + (i + 0.5) * ((w * 1.7) / (n - 1)), len = (10 + ((i * 5) % 4) * 3) * sharp;
    poly(c, [x - tw / 2 + 2, cy + gap + 2, x + tw / 2 - 2, cy + gap + 2, x, cy + gap - len]); c.fill();
  }
}

function limb(c, pts, w, V) {
  c.beginPath(); c.moveTo(pts[0], pts[1]); c.lineTo(pts[2], pts[3]); c.lineTo(pts[4], pts[5]);
  c.strokeStyle = V.dark; c.lineWidth = w + 8; c.stroke();
  c.strokeStyle = V.body; c.lineWidth = w; c.stroke();
  c.fillStyle = '#4c4c4c'; circ(c, pts[2], pts[3], w * 0.45); c.fill();
  c.fillStyle = '#1a1a1a'; circ(c, pts[2], pts[3], w * 0.18); c.fill();
}

function claw(c, x, y, dx, dy, V, size = 1) {
  c.save(); c.translate(x, y); c.rotate(Math.atan2(-dx, dy)); c.scale(size, size);
  c.fillStyle = V.body; circ(c, 0, 0, 19); c.fill();
  c.strokeStyle = V.dark; c.lineWidth = 3; circ(c, 0, 0, 19); c.stroke();
  c.strokeStyle = '#d8d0c0'; c.lineWidth = 5;
  for (let k = -1; k <= 1; k++) {
    c.beginPath(); c.moveTo(k * 10, 12); c.quadraticCurveTo(k * 15, 32, k * 9, 48); c.stroke();
  }
  c.restore();
}

function drawHead(c, id, o) {
  const V = VILLAINS[id], hy = -350, jaw = o.jaw || 0, lit = o.eyes !== false;
  const photo = Assets.get(id + '/normal');
  c.lineWidth = 5; c.strokeStyle = V.dark;

  // --- behind-head accessories ---
  if (id === 'steven') {         // torn bunny ears
    c.fillStyle = V.body;
    c.save(); c.translate(-45, hy - 66); c.rotate(-0.22);
    rr(c, -21, -135, 42, 140, 21); c.fill(); c.stroke();
    c.fillStyle = V.accent; rr(c, -10, -118, 20, 105, 10); c.fill(); c.restore();
    c.fillStyle = V.body;
    c.save(); c.translate(48, hy - 66); c.rotate(0.45);
    rr(c, -20, -72, 40, 78, 18); c.fill(); c.stroke();
    c.translate(0, -62); c.rotate(1.05);
    rr(c, -18, -70, 36, 74, 18); c.fill(); c.stroke();
    c.fillStyle = '#111'; c.fillRect(-12, -6, 24, 8);
    c.restore();
  } else if (id === 'xavier') {  // bear ears
    [-74, 74].forEach((ex) => {
      c.fillStyle = V.body; circ(c, ex, hy - 62, 30); c.fill(); c.stroke();
      c.fillStyle = V.dark; circ(c, ex, hy - 62, 14); c.fill();
    });
  } else if (id === 'zynovan') { // ragged crest
    c.fillStyle = V.dark;
    for (let i = 0; i < 6; i++) {
      const x = -50 + i * 20;
      poly(c, [x - 12, hy - 70, x + 12, hy - 70, x + (i - 2.5) * 8, hy - 130 - (i % 2) * 22]); c.fill();
    }
  }

  if (photo) {
    // --- PHOTO FACE on a mechanical skull rim ---
    c.fillStyle = '#0b0808'; ell(c, 0, hy, 98, 106); c.fill();
    c.save(); ell(c, 0, hy, 90, 98); c.clip();
    drawCover(c, photo, -90, hy - 98, 180, 196);
    c.fillStyle = 'rgba(110,0,0,0.16)'; c.fillRect(-92, hy - 100, 184, 200);
    c.restore();
    c.strokeStyle = V.dark; c.lineWidth = 7; ell(c, 0, hy, 92, 100); c.stroke();
    c.fillStyle = '#777';
    [[-82, hy - 30], [82, hy - 30], [-70, hy + 50], [70, hy + 50]].forEach(([bx, by]) => { circ(c, bx, by, 5); c.fill(); });
    if (jaw > 0.02) mouth(c, 0, hy + 88, 66, jaw, V, 10, 1.2);
  } else if (id === 'steven') {
    c.fillStyle = V.body; rr(c, -88, hy - 78, 176, 156, 52); c.fill(); c.stroke();
    c.fillStyle = V.accent; ell(c, 0, hy + 28, 60, 36); c.fill();
    eye(c, -36, hy - 16, 24, 28, lit, V.eye); eye(c, 36, hy - 16, 24, 28, lit, V.eye);
    c.fillStyle = '#c03050'; ell(c, 0, hy + 8, 12, 8); c.fill();
    mouth(c, 0, hy + 40, 50, jaw, V, 8, 1);
    c.fillStyle = '#b2102a'; rr(c, -26, hy + 92 + jaw * 60, 52, 16, 6); c.fill();   // bowtie
  } else if (id === 'zynovan') {
    c.fillStyle = V.body; ell(c, 0, hy, 82, 90); c.fill(); c.stroke();
    eye(c, -32, hy - 22, 20, 24, lit, V.eye); eye(c, 32, hy - 22, 20, 24, lit, V.eye);
    c.fillStyle = V.body; c.fillRect(-56, hy - 48, 112, 16);                    // heavy lids
    c.fillStyle = V.accent; ell(c, -26, hy + 14, 26, 14); c.fill();             // the snus bulge
    mouth(c, 0, hy + 28, 70, jaw, V, 14, 0.9);
  } else {
    c.fillStyle = V.body; ell(c, 0, hy, 94, 88); c.fill(); c.stroke();
    c.fillStyle = V.accent; ell(c, 0, hy + 30, 58, 40); c.fill();
    eye(c, -38, hy - 20, 22, 26, lit, V.eye); eye(c, 38, hy - 20, 22, 26, lit, V.eye);
    c.strokeStyle = V.dark; c.lineWidth = 8;
    line(c, -62, hy - 56, -18, hy - 40); line(c, 62, hy - 56, 18, hy - 40);  // angry brows
    c.fillStyle = '#1a0d04'; ell(c, 0, hy + 10, 15, 10); c.fill();
    mouth(c, 0, hy + 38, 54, jaw, V, 10, 1.3);
    c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 2;
    line(c, 40, hy - 80, 58, hy - 40); line(c, 58, hy - 40, 50, hy - 20);       // crack
  }

  // --- on-top accessories ---
  if (id === 'xavier') {          // top hat
    c.fillStyle = '#0d0d0d';
    rr(c, -48, hy - 178, 96, 92, 6); c.fill();
    rr(c, -76, hy - 94, 152, 14, 6); c.fill();
    c.fillStyle = '#6a0f0f'; c.fillRect(-48, hy - 112, 96, 14);
  }
}

function drawFigure(c, id, o = {}) {
  const V = VILLAINS[id], t = o.t ?? G.t, arms = o.arms || 'down';
  const thin = id === 'zynovan' ? 0.78 : id === 'steven' ? 1.12 : 1;
  const sway = Math.sin(t * 1.1) * 4, tw = 180 * thin;
  c.save(); c.lineCap = 'round'; c.lineJoin = 'round';
  c.fillStyle = 'rgba(0,0,0,0.55)'; ell(c, 0, 4, 120, 18); c.fill();
  // legs + feet
  limb(c, [-45 * thin, -150, -54 * thin, -76, -48 * thin, -8], 30 * thin, V);
  limb(c, [45 * thin, -150, 56 * thin, -76, 48 * thin, -8], 30 * thin, V);
  c.fillStyle = V.dark; rr(c, -84 * thin, -20, 64 * thin, 22, 9); c.fill(); rr(c, 20 * thin, -20, 64 * thin, 22, 9); c.fill();
  // torso
  c.fillStyle = V.body; rr(c, -tw / 2, -305, tw, 172, 46 * thin); c.fill();
  c.strokeStyle = V.dark; c.lineWidth = 5; rr(c, -tw / 2, -305, tw, 172, 46 * thin); c.stroke();
  c.globalAlpha = 0.5; c.fillStyle = V.accent; ell(c, 0, -212, tw * 0.3, 54); c.fill(); c.globalAlpha = 1;
  // torn hole with endoskeleton + wires
  c.fillStyle = '#080404'; poly(c, [-tw * 0.32, -268, -tw * 0.08, -282, -tw * 0.02, -236, -tw * 0.25, -220]); c.fill();
  c.strokeStyle = '#555'; c.lineWidth = 4; line(c, -tw * 0.28, -258, -tw * 0.06, -262); line(c, -tw * 0.26, -240, -tw * 0.05, -244);
  c.strokeStyle = '#a02020'; c.lineWidth = 2; c.beginPath(); c.moveTo(-tw * 0.18, -232); c.quadraticCurveTo(-tw * 0.2, -205, -tw * 0.1, -190); c.stroke();
  c.strokeStyle = '#c0a020'; c.beginPath(); c.moveTo(-tw * 0.12, -232); c.quadraticCurveTo(-tw * 0.05, -200, -tw * 0.14, -180); c.stroke();
  // character details
  if (id === 'zynovan') {
    [[34, -262], [10, -170]].forEach(([x, y]) => {
      c.fillStyle = '#d8e2dc'; circ(c, x, y, 19); c.fill();
      c.strokeStyle = '#2a3a2a'; c.lineWidth = 3; circ(c, x, y, 19); c.stroke();
      c.fillStyle = '#2a3a2a'; c.font = 'bold 10px Arial'; c.textAlign = 'center'; c.fillText('SNUS', x, y + 4);
    });
  } else if (id === 'xavier') {
    c.fillStyle = '#0d0d0d'; poly(c, [-30, -312, 0, -298, 30, -312, 30, -284, 0, -298, -30, -284]); c.fill();
    c.fillStyle = V.dark; circ(c, 0, -250, 7); c.fill(); circ(c, 0, -205, 7); c.fill();
  } else if (id === 'steven') {
    c.strokeStyle = '#21172e'; c.lineWidth = 12; line(c, -tw / 2 + 12, -290, tw / 2 - 10, -160);   // guitar strap
  }
  // arms
  if (arms === 'reach') {
    limb(c, [-tw / 2 + 12, -290, -tw / 2 - 60, -335, -tw / 2 - 105, -395], 26 * thin, V);
    limb(c, [tw / 2 - 12, -290, tw / 2 + 60, -335, tw / 2 + 105, -395], 26 * thin, V);
    claw(c, -tw / 2 - 105, -395, -0.6, -1, V, 1.25); claw(c, tw / 2 + 105, -395, 0.6, -1, V, 1.25);
  } else {
    limb(c, [-tw / 2 + 6, -288, -tw / 2 - 26, -206, -tw / 2 - 16 + sway, -124], 24 * thin, V);
    limb(c, [tw / 2 - 6, -288, tw / 2 + 26, -206, tw / 2 + 16 - sway, -124], 24 * thin, V);
    claw(c, -tw / 2 - 16 + sway, -124, 0, 1, V); claw(c, tw / 2 + 16 - sway, -124, 0, 1, V);
  }
  c.strokeStyle = '#1e1e1e'; c.lineWidth = 16; line(c, 0, -300, 0, -326);
  drawHead(c, id, o);
  c.restore();
}

/**
 * withShading — draws something into an off-screen buffer, then darkens it
 * with grime + falloff away from a light source (the flashlight), so flat
 * vector monsters look like grimy, half-lit animatronics.
 */
let figBuf = null;
function withShading(c, lx, ly, strength, drawFn) {
  if (!figBuf) figBuf = makeCanvas(W, H);
  const f = figBuf.getContext('2d');
  f.setTransform(1, 0, 0, 1, 0, 0);
  f.globalCompositeOperation = 'source-over';
  f.clearRect(0, 0, W, H);
  f.setTransform(c.getTransform());
  drawFn(f);
  f.setTransform(1, 0, 0, 1, 0, 0);
  f.globalCompositeOperation = 'source-atop';
  const g = f.createRadialGradient(lx, ly, 0, lx, ly, 520);
  g.addColorStop(0, `rgba(0,0,0,${0.1 * strength})`);
  g.addColorStop(1, `rgba(0,0,0,${0.82 * strength})`);
  f.fillStyle = g; f.fillRect(0, 0, W, H);
  f.fillStyle = linGrad(f, 0, 0, 0, H, ['rgba(40,0,0,0.0)', `rgba(20,0,0,${0.45 * strength})`]);
  f.fillRect(0, 0, W, H);
  f.globalAlpha = 0.18; f.fillStyle = Scenes.grain[1]; f.fillRect(0, 0, W, H); f.globalAlpha = 1;
  f.globalCompositeOperation = 'source-over';
  c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.drawImage(figBuf, 0, 0); c.restore();
}

/* Positioned villain. In the hallway a full-body hallway.png is used if present. */
function drawVillain(c, id, x, y, s, o = {}) {
  const full = o.context === 'hallway' ? Assets.get(id + '/hallway') : null;
  const paint = (cc) => {
    cc.translate(x, y); cc.scale(s, s);
    if (full) { const h = 440, w = (full.width / full.height) * h; cc.drawImage(full, -w / 2, -h, w, h); }
    else drawFigure(cc, id, o);
  };
  if (o.flat) { c.save(); paint(c); c.restore(); return; }
  withShading(c, Input.mx, Input.my, 1, paint);
}

/* Little Xaviers on the bed */
function drawMini(c, x, y, s, i) {
  const V = VILLAINS.xavier, photo = Assets.get('xavier/normal');
  const bob = Math.sin(G.t * 3 + i * 2) * 2;
  c.save(); c.translate(x, y + bob); c.scale(s, s);
  c.fillStyle = 'rgba(0,0,0,0.45)'; ell(c, 0, 2, 38, 8); c.fill();
  c.fillStyle = V.body; ell(c, 0, -30, 32, 30); c.fill();
  c.fillStyle = V.accent; ell(c, 0, -26, 18, 16); c.fill();
  c.fillStyle = V.body; ell(c, -30, -34, 9, 16, 0.5); c.fill(); ell(c, 30, -34, 9, 16, -0.5); c.fill();
  circ(c, -22, -98, 10); c.fill(); circ(c, 22, -98, 10); c.fill();
  circ(c, 0, -76, 29); c.fill();
  if (photo) {
    c.save(); circ(c, 0, -76, 26); c.clip(); drawCover(c, photo, -26, -102, 52, 52); c.restore();
  } else {
    c.fillStyle = V.accent; ell(c, 0, -66, 15, 11); c.fill();
    eye(c, -11, -82, 7, 8, true, V.eye); eye(c, 11, -82, 7, 8, true, V.eye);
    c.fillStyle = '#e6dcc4';
    for (let k = 0; k < 5; k++) { poly(c, [-10 + k * 4, -62, -6 + k * 4, -62, -8 + k * 4, -56]); c.fill(); }
  }
  c.fillStyle = '#0d0d0d'; c.fillRect(-13, -124, 26, 20); c.fillRect(-19, -106, 38, 5);
  c.restore();
}

/* Raoul (player) portrait — photo if provided, otherwise a vector kid. */
function drawRaoul(c, w, h, scared = 1) {
  c.clearRect(0, 0, w, h);
  const photo = Assets.get('player/raoul');
  c.save();
  circ(c, w / 2, h / 2, w / 2 - 4); c.clip();
  c.fillStyle = linGrad(c, 0, 0, 0, h, ['#1a0a10', '#050204']); c.fillRect(0, 0, w, h);
  if (photo) {
    drawCover(c, photo, 0, 0, w, h);
  } else {
    const s = w / 320;
    c.save();
    c.scale(s, s);
    c.fillStyle = '#2a3550'; ell(c, 160, 330, 130, 100); c.fill();                 // hoodie
    c.fillStyle = '#1e2740'; ell(c, 160, 170, 92, 102); c.fill();                  // hood
    c.fillStyle = '#c9a487'; ell(c, 160, 168, 64, 76); c.fill();                   // face
    c.fillStyle = '#2a1a10'; ell(c, 160, 104, 66, 30); c.fill();                   // hair
    c.fillStyle = '#fff'; ell(c, 136, 160, 15, 15 * scared); c.fill(); ell(c, 184, 160, 15, 15 * scared); c.fill();
    c.fillStyle = '#111'; circ(c, 136, 162, 5); c.fill(); circ(c, 184, 162, 5); c.fill();
    c.fillStyle = '#3a1010'; ell(c, 160, 210, 12, 16 * scared); c.fill();           // gasp
    c.fillStyle = 'rgba(160,200,255,0.7)'; ell(c, 206, 130, 5, 9); c.fill();      // sweat
    c.strokeStyle = '#2a1a10'; c.lineWidth = 4; line(c, 120, 136, 150, 142); line(c, 200, 136, 170, 142);
    c.restore();
  }
  const g = c.createRadialGradient(w / 2, h / 2, w * 0.2, w / 2, h / 2, w * 0.55);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.85)');
  c.fillStyle = g; c.fillRect(0, 0, w, h);
  c.restore();
  c.strokeStyle = 'rgba(160,0,20,0.6)'; c.lineWidth = 3; circ(c, w / 2, h / 2, w / 2 - 4); c.stroke();
}

/* ==========================================================================
 * 7. AI
 * ========================================================================== */

/**
 * HallStalker — Steven Pivac (left) and Xavier (right).
 *   stage 0: away   1: far end of hall   2: close in hall   3: AT THE DOOR (hidden)
 *   • Stages 1–2: flashlight on them pushes them back to 0.
 *   • Stage 3: you'll hear breathing/whispering. Shining the light = death.
 *     Hold the door shut long enough and they leave. Wait too long = breach.
 */
class HallStalker {
  constructor(id, side, level, o) {
    Object.assign(this, { id, side, level, o });
    this.stage = 0;
    this.timer = CONFIG.startGrace + o.interval * rand(0.5, 1.2);
    this.patience = 0; this.hold = 0; this.exposure = 0; this.litAtDoor = 0;
  }
  get pan() { return this.side === 'left' ? -0.85 : 0.85; }
  get sideName() { return this.side.toUpperCase(); }

  screenPos() {
    const dx = this.side === 'left' ? -50 : 50;
    if (this.stage === 1) return { x: 640, y: 440, s: 0.3 };
    if (this.stage === 2) return { x: 640 + dx, y: 715, s: 1.05 };
    return null;
  }

  update(dt) {
    if (this.level <= 0 && this.stage === 0) return;
    const here = G.view === this.side && !G.trans;
    const closed = here && G.doors[this.side] > 0.85;
    const p = this.screenPos();
    const lit = here && G.flashOn && p &&
      Math.hypot(Input.mx - p.x, Input.my - (p.y - 210 * p.s)) < 150 + 120 * p.s;

    if (this.stage === 1 || this.stage === 2) {
      if (lit) {
        this.exposure += dt;
        if (this.exposure > (this.stage === 1 ? 0.45 : 0.3)) { this.retreat(true); return; }
      } else this.exposure = Math.max(0, this.exposure - dt);
    }

    if (this.stage === 3) {
      // NEVER shine the light at someone standing in your doorway.
      if (here && G.flashOn && !closed) {
        this.litAtDoor += dt;
        if (this.litAtDoor > 0.12) { breach(this.id); return; }
      } else this.litAtDoor = 0;

      if (closed) {
        this.hold += dt;
        if (this.hold >= this.o.hold) { this.retreat(false); return; }
      } else {
        this.hold = Math.max(0, this.hold - dt * 0.5);
        this.patience -= dt;
        if (this.patience <= 0) { breach(this.id); return; }
      }
      return;
    }

    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = this.o.interval * rand(0.7, 1.3);
      if (!lit && roll(this.level)) this.advance();
    }
  }

  advance() {
    let n = this.stage + 1;
    if (this.stage === 1 && chance(this.o.skip)) n = 3;   // Xavier sometimes rushes the door
    this.stage = n;
    const near = G.view === this.side ? 1.4 : 1;
    if (n === 3) {
      this.patience = Math.max(4, this.o.patience - this.level * 0.18);
      this.hold = 0; this.litAtDoor = 0;
      Sound.footsteps(this.pan, 0.5 * near, 2, 0.55);
    } else {
      Sound.footsteps(this.pan, (n === 1 ? 0.16 : 0.32) * near, 3, 0.5);
    }
    if (this.id === 'xavier') {
      Sound.whisper(this.pan, 0.06 + n * 0.04, 4);
      addAlert(['', `whisper (${this.sideName}): "Raoul… I can hear you breathing."`,
        `whisper (${this.sideName}): "Raoul… come out and play."`, `*silence on the ${this.sideName}…*`][n], n === 3 ? 'sound' : 'whisper');
    } else {
      addAlert(['', `*thud… thud… heavy footsteps far down the ${this.sideName} hall*`,
        `*the floorboards groan — something big is close (${this.sideName})*`, '*the footsteps stop.*'][n], 'sound');
    }
  }

  retreat(byLight) {
    this.stage = 0; this.exposure = 0; this.hold = 0;
    this.timer = this.o.interval * rand(1.2, 1.9);
    Sound.footsteps(this.pan, 0.3, 4, 0.42, 0.9);
    if (byLight) {
      Sound.screech(this.pan, 0.18);
      addAlert(`${VILLAINS[this.id].name} recoils from the light.`, 'good');
    } else {
      addAlert(`*footsteps lumber away from the ${this.sideName} door*`, 'good');
    }
  }

  /* Volume of the breathing/whispering loop depending on where Raoul is. */
  cueVolume() {
    if (this.stage !== 3) return 0;
    if (G.view === this.side && !G.trans) return G.doors[this.side] > 0.85 ? 0.12 : 0.45;
    if (G.view === 'center') return 0.03;
    return 0;
  }
  listenText() {
    return this.id === 'xavier'
      ? `whisper, right at the ${this.sideName} doorframe: "let me in, Raoul…"`
      : `*…slow, wet breathing just past the ${this.sideName} doorframe…*`;
  }
}

/**
 * ClosetLurker — Zynovan Snusvac.
 *   stage 0 empty → 1 eyes → 2 a hand → 3 half out → 4 FULLY OUT.
 *   Advances only while you're NOT looking at the closet (sometimes 2 at once).
 *   Stages 1–3: hold the closet shut ~1s to push him back.
 *   Stage 4: hold it shut ~3s while he bangs; leave it open too long = breach.
 */
class ClosetLurker {
  constructor(level) {
    this.id = 'zynovan'; this.level = level; this.stage = 0;
    this.timer = CONFIG.startGrace + 6 * rand(0.6, 1.3);
    this.hold = 0; this.patience = 0; this.bangT = 0; this.rattleT = 8;
  }
  update(dt) {
    if (this.level <= 0 && this.stage === 0) return;
    const here = G.view === 'closet' && !G.trans;
    const closed = here && G.doors.closet > 0.85;

    if (this.stage === 4) {
      if (closed) {
        this.hold += dt; this.bangT -= dt;
        if (this.bangT <= 0) { this.bangT = rand(0.35, 0.7); Sound.bang(0); G.shake = Math.max(G.shake, 7); }
        if (this.hold >= 3) {
          this.reset();
          addAlert('*the banging stops. a snus tin rolls across the floor.*', 'good');
          Sound.rattle(0, 0.12);
        }
      } else {
        this.hold = Math.max(0, this.hold - dt);
        this.patience -= dt * (here && G.flashOn ? 1.6 : 1);
        if (this.patience <= 0) breach('zynovan');
      }
      return;
    }

    if (this.stage >= 1 && closed) {
      this.hold += dt;
      if (this.hold >= 1.1) { this.reset(); Sound.shuffle(); addAlert('*something shuffles back into the clothes*', 'good'); }
    } else this.hold = 0;

    if (!here) {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.timer = 6 * rand(0.6, 1.4);
        if (roll(this.level)) this.advance();
      }
    }
    // ambient rattles while he's in there
    if (this.stage >= 2) {
      this.rattleT -= dt;
      if (this.rattleT <= 0) { this.rattleT = rand(6, 12); Sound.rattle(rand(-0.2, 0.2), 0.04 + this.stage * 0.02); }
    }
  }
  advance() {
    this.stage = Math.min(4, this.stage + (chance(0.2) ? 2 : 1));
    Sound.rattle(0, 0.06 + this.stage * 0.04);
    addAlert(['', '*a snus tin rattles inside the closet*', '*the closet hangers scrape together*',
      'whisper (closet): "want a pouch, Raoul?"', '*THE CLOSET DOOR CREAKS OPEN*'][this.stage],
      this.stage === 4 ? 'danger' : this.stage === 3 ? 'whisper' : 'sound');
    if (this.stage === 4) { this.patience = Math.max(3.5, 7.5 - this.level * 0.18); this.hold = 0; }
  }
  reset() { this.stage = 0; this.hold = 0; this.timer = 6 * rand(1, 1.6); }
}

/**
 * BedMinis — Xavier's Little Xaviers.
 *   They pile onto the bed while your back is turned. Flash them away.
 *   Three at once → Xavier himself rises behind the bed. Clear them fast.
 */
class BedMinis {
  constructor(level) {
    this.id = 'xavier'; this.level = level; this.count = 0;
    this.timer = CONFIG.startGrace + 9 * rand(0.6, 1.3);
    this.exposure = 0; this.nightmare = -1; this.nightmareMax = 1; this.giggleT = 5;
  }
  update(dt) {
    if (this.level <= 0 && this.count === 0) return;
    const here = G.view === 'bed' && !G.trans;
    const lit = here && G.flashOn && Input.my > 330 && Input.mx > 160 && Input.mx < 1120;
    if (lit && this.count > 0) {
      this.exposure += dt;
      if (this.exposure > 0.45) {
        this.exposure = 0; this.count--;
        Sound.tone({ type: 'triangle', freq: 1100, freqEnd: 400, dur: 0.18, vol: 0.08 });
      }
    } else this.exposure = Math.max(0, this.exposure - dt * 0.5);

    if (!here) {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.timer = 9 * rand(0.6, 1.3);
        if (this.count < 3 && roll(this.level)) {
          this.count++;
          Sound.giggle(rand(-0.2, 0.2), 0.03 + this.count * 0.02);
          addAlert(this.count === 1 ? '*tiny giggles somewhere behind you*' : '*more giggling… from the bed*', 'sound');
        }
      }
      if (this.count > 0) {
        this.giggleT -= dt;
        if (this.giggleT <= 0) { this.giggleT = rand(5, 10); Sound.giggle(rand(-0.3, 0.3), 0.02 + this.count * 0.012); }
      }
    }

    if (this.count >= 3) {
      if (this.nightmare < 0) {
        this.nightmare = this.nightmareMax = Math.max(4.5, 9 - this.level * 0.2);
        addAlert('Xavier: "Raoul… look behind you."', 'whisper');
        Sound.whisper(0, 0.25, 7);
      }
      this.nightmare -= dt;
      if (this.nightmare <= 0) breach('xavier');
    } else this.nightmare = -1;
  }
}

/* ==========================================================================
 * 8. GAME STATE, INPUT, UPDATE
 * ========================================================================== */
const canvas = $('#game');
const ctx = canvas.getContext('2d');
const lightCanvas = makeCanvas(W, H);
const lctx = lightCanvas.getContext('2d');

const Input = { keys: {}, mx: W / 2, my: H / 2, mouseL: false, mouseR: false, touchFlash: false, holdBtn: false };

const G = {
  state: 'loading', night: 1, time: 0, hour: 0, t: 0,
  view: 'center', trans: null,
  battery: 100, flashOn: false, wantPrev: false,
  doors: { left: 0, right: 0, closet: 0 },
  shake: 0, flicker: 0, halluc: 0, heartT: 0, listen: 0, listened: false,
  ai: null, js: null, showHints: true, introT: 0,
  menuFlash: 0, menuFlashT: 3,
};

function loadProgress() { try { return parseInt(localStorage.getItem(CONFIG.storageKey), 10) || 0; } catch (e) { return 0; } }
function saveProgress(n) { try { if (n > loadProgress()) localStorage.setItem(CONFIG.storageKey, String(n)); } catch (e) { /* storage blocked */ } }

function startNight(n) {
  const cfg = NIGHTS[n - 1];
  Object.assign(G, {
    night: n, time: 0, hour: 0, view: 'center', trans: null, battery: 100, flashOn: false,
    doors: { left: 0, right: 0, closet: 0 }, shake: 0, flicker: 0, halluc: 0, heartT: 0,
    listen: 0, listened: false, js: null,
  });
  G.ai = {
    steven: new HallStalker('steven', 'left', cfg.steven, { interval: 5.2, patience: 11, hold: 2.6, skip: 0 }),
    xavier: new HallStalker('xavier', 'right', cfg.xavier, { interval: 4.2, patience: 8.5, hold: 3.2, skip: 0.25 }),
    zynovan: new ClosetLurker(cfg.zynovan),
    minis: new BedMinis(cfg.minis),
  };
  $('#alerts').innerHTML = '';
  $('#stage').classList.remove('shake');
  // Intro card
  $('.intro-time').textContent = '12:00 AM';
  $('.intro-night').textContent = n === 6 ? 'NIGHTMARE' : `Night ${n}`;
  $('.intro-msg').textContent = cfg.msg;
  $('.intro-tip').textContent = cfg.tip;
  // restart the CSS animation
  const it = $('.intro-time'); it.style.animation = 'none'; void it.offsetWidth; it.style.animation = '';
  showScreen('intro');
  G.state = 'intro'; G.introT = 0;
  Sound.stopLoops();
  Sound.staticNoise(0.6, 0.15);
}

function beginPlay() {
  if (G.state !== 'intro') return;
  G.state = 'playing';
  showScreen(null);
  $('#hud').classList.remove('hidden');
  Sound.startLoops();
  updateHUD(true);
}

function go(dir) {
  if (G.state !== 'playing' || G.trans) return;
  let to = null;
  if (G.view === 'center') { if (dir !== 'back') to = dir; }
  else if (dir === 'back') to = 'center';
  else if ((G.view === 'left' && dir === 'right') || (G.view === 'right' && dir === 'left') ||
           (G.view === 'bed' && (dir === 'closet' || dir === 'bed'))) to = 'center';
  if (!to || to === G.view) return;
  G.trans = { to, t: 0, switched: false };
  G.listen = 0; G.listened = false;
  Sound.run();
}

function breach(id) {
  if (G.state !== 'playing') return;
  G.state = 'jumpscare';
  G.js = { id, t: 0 };
  Sound.stopLoops();
  Sound.scream();
  $('#hud').classList.add('hidden');
  $('#stage').classList.add('shake');
}

function onHour(h) {
  if (h > 0) {
    Sound.tick();
    if (h === 2 || h === 4) Object.values(G.ai).forEach((a) => { if (a.level > 0) a.level += 1; });
  }
}

function winNight() {
  G.state = 'win';
  Sound.stopLoops();
  Sound.chime();
  $('#hud').classList.add('hidden');
  saveProgress(G.night);
  const last = G.night >= 5;
  $('#win-msg').textContent = G.night === 6
    ? 'You survived the NIGHTMARE. Raoul Mann is officially unkillable. (…for now.)'
    : last
      ? 'Raoul Mann survived Five Nights at Xavier\'s. The sun rises. The giggling stops. …Nightmare night unlocked.'
      : `Night ${G.night} survived. Raoul lives to see another sunrise.`;
  $('#next-btn').classList.toggle('hidden', G.night >= 6);
  $('#next-btn').textContent = G.night === 5 ? 'Nightmare' : 'Next Night';
  drawRaoul($('#win-portrait').getContext('2d'), 200, 200, 0.6);
  $('.win-clock .roll').querySelectorAll('span').forEach((s) => { s.style.animation = 'none'; void s.offsetWidth; s.style.animation = ''; });
  showScreen('win');
}

function showGameOver() {
  const id = G.js.id, V = VILLAINS[id];
  G.state = 'gameover';
  $('#stage').classList.remove('shake');
  Sound.staticNoise(2.5, 0.2);
  $('#go-who').textContent = `Raoul Mann was caught by ${V.name}.`;
  $('#go-quote').textContent = pick(V.quotes);
  const c = $('#gameover-portrait').getContext('2d');
  c.clearRect(0, 0, 300, 300);
  c.save(); c.translate(150, 150); c.scale(0.95, 0.95); c.translate(0, 350);
  drawFigure(c, id, { t: 0, jaw: 0.5, eyes: true });
  c.restore();
  showScreen('gameover');
}

/* --- Main update --- */
function update(dt) {
  G.t += dt;
  G.shake = Math.max(0, G.shake - dt * 30);
  G.flicker = Math.max(0, G.flicker - dt);
  G.halluc = Math.max(0, G.halluc - dt);

  if (G.state === 'playing') updatePlaying(dt);
  else if (G.state === 'jumpscare') {
    G.js.t += dt;
    G.shake = 22 * Math.max(0, 1 - G.js.t / 1.9);
    if (G.js.t > 1.9) showGameOver();
  } else if (G.state === 'intro') {
    G.introT += dt;
    if (G.introT > 9) beginPlay();
  } else if (G.state === 'menu' || G.state === 'loading') {
    G.menuFlashT -= dt;
    if (G.menuFlashT <= 0) {
      G.menuFlash = 0.18; G.menuFlashT = rand(3.5, 8);
      if (G.state === 'menu' && Sound.ctx) Sound.glitch();
    }
    G.menuFlash = Math.max(0, G.menuFlash - dt);
  }
  if (Math.random() < dt * 0.25) G.flicker = rand(0.03, 0.09);   // random CRT/light flicker
}

function updatePlaying(dt) {
  G.time += dt;
  const hour = Math.min(6, Math.floor(G.time / CONFIG.secondsPerHour));
  if (hour !== G.hour) { G.hour = hour; onHour(hour); if (hour >= 6) { winNight(); return; } }

  // Running between spots
  if (G.trans) {
    G.trans.t += dt;
    if (!G.trans.switched && G.trans.t >= CONFIG.transitionTime / 2) { G.view = G.trans.to; G.trans.switched = true; }
    if (G.trans.t >= CONFIG.transitionTime) G.trans = null;
  }
  const busy = !!G.trans;
  const doorView = G.view === 'left' || G.view === 'right' || G.view === 'closet';

  // Holding doors / closet
  const holding = doorView && !busy && (Input.keys.Space || Input.mouseR || Input.holdBtn);
  ['left', 'right', 'closet'].forEach((k) => {
    const before = G.doors[k];
    const target = holding && G.view === k ? 1 : 0;
    G.doors[k] = approach(before, target, dt * (target ? 7 : 5));
    if (before < 0.9 && G.doors[k] >= 0.9) Sound.doorSlam(k === 'left' ? -0.6 : k === 'right' ? 0.6 : 0);
  });

  // Flashlight
  const want = Input.mouseL || Input.keys.KeyF || Input.keys.ShiftLeft || Input.keys.ShiftRight || Input.touchFlash;
  if (want !== G.wantPrev) { if (G.battery > 0) Sound.click(); G.wantPrev = want; }
  const blocked = doorView && G.doors[G.view] > 0.5;
  let on = want && !busy && G.battery > 0 && !blocked;
  if (on) G.battery = Math.max(0, G.battery - CONFIG.batteryDrain * dt);
  if (on && G.battery < 15 && Math.random() < (15 - G.battery) / 45) on = false;   // dying bulb flicker
  G.flashOn = on;

  // AI
  G.ai.steven.update(dt);
  if (G.state !== 'playing') return;
  G.ai.xavier.update(dt);
  if (G.state !== 'playing') return;
  G.ai.zynovan.update(dt);
  if (G.state !== 'playing') return;
  G.ai.minis.update(dt);
  if (G.state !== 'playing') return;

  // Listening at a door (light off) reveals who's breathing on the other side
  if ((G.view === 'left' || G.view === 'right') && !busy && !G.flashOn && G.doors[G.view] < 0.5) {
    G.listen += dt;
    const st = G.view === 'left' ? G.ai.steven : G.ai.xavier;
    if (G.listen > 0.9 && !G.listened && st.stage === 3) { G.listened = true; addAlert(st.listenText(), 'whisper'); }
  } else if (!busy) G.listen = 0;

  // Hallucinations: Xavier's face flashes in the dark (harmless… probably)
  if (G.view === 'center' && G.flashOn && G.night >= 2 && G.halluc <= 0 && Math.random() < dt * 0.006 * G.night) {
    G.halluc = 0.14; Sound.glitch();
  }

  updateAudioMix(dt);
  updateHUD();
}

function dangerLevel() {
  const a = G.ai;
  let d = 0;
  if (a.steven.stage === 3 || a.xavier.stage === 3) d = Math.max(d, 0.8);
  if (a.zynovan.stage === 4) d = 1;
  else if (a.zynovan.stage === 3) d = Math.max(d, 0.4);
  if (a.minis.nightmare >= 0) d = 1;
  else if (a.minis.count === 2) d = Math.max(d, 0.35);
  return d;
}

function updateAudioMix(dt) {
  if (!Sound.ctx) return;
  const atSpot = G.view !== 'center';
  Sound.setLoop('drone', atSpot ? 0.07 : 0.2, 0.3);      // the room goes quiet when you listen
  // Steven's breathing
  const ph = (G.t % 3.4) / 3.4, shape = Math.pow(0.5 - 0.5 * Math.cos(ph * TAU), 2);
  Sound.setLoop('steven', G.ai.steven.cueVolume() * (0.15 + shape), 0.05, 380 + 260 * shape);
  // Xavier's whispering
  const syl = (Math.sin(G.t * 9.3) + Math.sin(G.t * 13.7)) > 0.5 ? 1 : 0.2;
  Sound.setLoop('xavier', G.ai.xavier.cueVolume() * 0.6 * syl, 0.03, 2400 + Math.sin(G.t * 5) * 900);
  // Heartbeat when danger is close
  const d = dangerLevel();
  if (d > 0.3) {
    G.heartT -= dt;
    if (G.heartT <= 0) { G.heartT = 1.05 - 0.5 * d; Sound.heartbeat(0.18 + 0.2 * d); }
  }
}

/* --- Input --- */
function toCanvas(e) {
  const r = canvas.getBoundingClientRect();
  Input.mx = clamp(((e.clientX - r.left) / r.width) * W, 0, W);
  Input.my = clamp(((e.clientY - r.top) / r.height) * H, 0, H);
}
window.addEventListener('mousemove', toCanvas);
$('#stage').addEventListener('mousedown', (e) => {
  if (e.target.closest('button, .panel, a')) return;
  toCanvas(e);
  if (e.button === 0) Input.mouseL = true;
  if (e.button === 2) Input.mouseR = true;
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) Input.mouseL = false;
  if (e.button === 2) Input.mouseR = false;
});
$('#stage').addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('blur', () => {
  Input.keys = {}; Input.mouseL = Input.mouseR = Input.touchFlash = Input.holdBtn = false;
  if (G.state === 'playing') pauseGame();
});
document.addEventListener('visibilitychange', () => { if (document.hidden && G.state === 'playing') pauseGame(); });

// Touch: drag on screen to aim; the on-screen LIGHT button switches it on.
canvas.addEventListener('touchstart', (e) => { document.body.classList.add('touch'); toCanvas(e.touches[0]); e.preventDefault(); }, { passive: false });
canvas.addEventListener('touchmove', (e) => { toCanvas(e.touches[0]); e.preventDefault(); }, { passive: false });
function holdButton(el, key) {
  const on = (e) => { e.preventDefault(); Input[key] = true; el.classList.add('active'); };
  const off = () => { Input[key] = false; el.classList.remove('active'); };
  el.addEventListener('pointerdown', on);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => el.addEventListener(ev, off));
}
holdButton($('#hold-btn'), 'holdBtn');
holdButton($('#flash-btn'), 'touchFlash');
if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) document.body.classList.add('touch');

$$('.nav').forEach((b) => b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); go(b.dataset.go); }));

const KEYMAP = {
  KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
  KeyW: 'closet', ArrowUp: 'closet', KeyS: 'back', ArrowDown: 'back',
};
window.addEventListener('keydown', (e) => {
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  Input.keys[e.code] = true;
  if (e.repeat) return;
  if (G.state === 'playing') {
    let dir = KEYMAP[e.code];
    if (dir === 'back' && G.view === 'center') dir = 'bed';
    if (dir) go(dir);
    if (e.code === 'KeyH') { G.showHints = !G.showHints; updateHUD(true); }
  }
  if (e.code === 'KeyM') Sound.toggleMute();
  if (e.code === 'Escape') {
    if (G.state === 'playing') pauseGame();
    else if (G.state === 'paused') resumeGame();
  }
  if (G.state === 'intro' && (e.code === 'Space' || e.code === 'Enter')) beginPlay();
});
window.addEventListener('keyup', (e) => { Input.keys[e.code] = false; });

function pauseGame() { G.state = 'paused'; Sound.suspend(); showScreen('pause'); }
function resumeGame() { G.state = 'playing'; Sound.resume(); showScreen(null); }

/* ==========================================================================
 * 9. RENDERING
 * ========================================================================== */
function render() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  ctx.save();
  if (G.shake > 0) ctx.translate(rand(-G.shake, G.shake), rand(-G.shake, G.shake));

  if (G.state === 'jumpscare') renderJumpscare();
  else if (['playing', 'paused'].includes(G.state)) renderWorld();
  else if (['menu', 'loading'].includes(G.state)) renderMenuBG();
  else if (G.state === 'gameover') renderStatic(0.5);

  ctx.restore();
  renderPostFX();
  if (DEBUG && G.ai) renderDebug();
}

function renderWorld() {
  drawView(G.view);
  drawLighting(G.view);
  if (G.halluc > 0) {
    ctx.save(); ctx.globalAlpha = 0.85;
    ctx.translate(W / 2 + rand(-20, 20), H / 2 + 120); ctx.scale(1.9, 1.9); ctx.translate(0, 330);
    drawFigure(ctx, 'xavier', { jaw: 0.8, eyes: true });
    ctx.restore();
    ctx.fillStyle = 'rgba(120,0,0,0.25)'; ctx.fillRect(0, 0, W, H);
  }
  if (G.trans) {
    const p = G.trans.t / CONFIG.transitionTime, a = 1 - Math.abs(p * 2 - 1);
    ctx.fillStyle = `rgba(0,0,0,${Math.min(1, a * 1.5)})`;
    ctx.fillRect(-40, -40, W + 80, H + 80);
  }
}

function drawView(view) {
  if (view === 'center') drawCenter();
  else if (view === 'left' || view === 'right') drawHallView(view);
  else if (view === 'closet') drawClosetView();
  else if (view === 'bed') drawBedView();
}

function drawCenter() {
  ctx.drawImage(Scenes.center, 0, 0);
  const z = G.ai ? G.ai.zynovan.stage : 0;
  const gap = [4, 4, 10, 22, 70][z];
  ctx.fillStyle = '#020102'; ctx.fillRect(640 - gap / 2, 200, gap, 320);
}

function drawHallView(side) {
  ctx.drawImage(Scenes['hall_' + side], 0, 0);
  const st = side === 'left' ? G.ai.steven : G.ai.xavier;
  const p = st.screenPos();
  if (p) {
    ctx.save();
    ctx.beginPath(); ctx.rect(DOOR.L, DOOR.T, DOOR.R - DOOR.L, DOOR.B - DOOR.T); ctx.clip();
    drawVillain(ctx, st.id, p.x, p.y, p.s, { context: 'hallway', eyes: true });
    if (st.stage === 1) {      // keep the far figure murky
      const g = ctx.createRadialGradient(640, 385, 0, 640, 385, 200);
      g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(440, 185, 400, 400);
    }
    ctx.restore();
  }
  const a = G.doors[side];
  if (a > 0.01) drawDoorPanel(side, a);
}

function drawDoorPanel(side, a) {
  const { L, R, T, B } = DOOR, w = (R - L) * a;
  const x = side === 'left' ? L : R - w;
  ctx.save();
  ctx.fillStyle = linGrad(ctx, x, 0, x + w, 0, ['#3e2c1d', '#5a412b', '#45311f']);
  ctx.fillRect(x, T, w, B - T);
  ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 4;
  if (w > 120) {
    ctx.strokeRect(x + w * 0.1, T + 50, w * 0.8, 260);
    ctx.strokeRect(x + w * 0.1, T + 350, w * 0.8, 280);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(side === 'left' ? x + w - 10 : x, T, 10, B - T);
  if (a > 0.8) {
    ctx.fillStyle = '#a08040';
    circ(ctx, side === 'left' ? x + w - 50 : x + 50, 400, 14); ctx.fill();
  }
  ctx.restore();
}

function drawClosetView() {
  ctx.drawImage(Scenes.closetBack, 0, 0);
  const z = G.ai.zynovan, s = z.stage;
  if (s >= 1) {   // snus tins on the floor
    [[560, 682], [610, 690], [720, 686]].slice(0, Math.min(3, s)).forEach(([x, y]) => {
      ctx.fillStyle = '#c8d4cc'; ell(ctx, x, y, 16, 6); ctx.fill();
      ctx.fillStyle = '#2a3a2a'; ell(ctx, x, y, 8, 3); ctx.fill();
    });
  }
  if (s === 2) drawVillain(ctx, 'zynovan', 660, 830, 0.85, { eyes: true });
  if (s === 3) drawVillain(ctx, 'zynovan', 640, 800, 1.05, { eyes: true, jaw: 0.25 });
  if (s !== 4) ctx.drawImage(s >= 3 ? Scenes.clothesParted : Scenes.clothes, 0, 0);
  if (s === 1) {  // eyes glinting between the clothes
    eye(ctx, 628, 330, 9, 10, true, VILLAINS.zynovan.eye); eye(ctx, 656, 330, 9, 10, true, VILLAINS.zynovan.eye);
  }
  if (s === 2) {  // a hand curling around the clothes
    claw(ctx, 615, 380, 0.5, 1, VILLAINS.zynovan, 1.1);
    eye(ctx, 640, 300, 10, 12, true, VILLAINS.zynovan.eye); eye(ctx, 672, 300, 10, 12, true, VILLAINS.zynovan.eye);
  }
  if (s === 4) {
    ctx.drawImage(Scenes.clothesParted, 0, 0);
    drawVillain(ctx, 'zynovan', 640 + Math.sin(G.t * 7) * 6, 1000, 1.75, { eyes: true, arms: 'reach', jaw: 0.35 + 0.2 * Math.sin(G.t * 9) });
  }
  // closet doors
  const a = G.doors.closet;
  const jig = s === 4 && a > 0.85 ? rand(-4, 4) : 0;
  [[240, -1], [1040, 1]].forEach(([hx, dir]) => {
    const fx = lerp(hx + dir * 150, 640 + dir * 2, a) + jig;
    const ty = lerp(-30, 30, a), by = lerp(770, 720, a);
    ctx.fillStyle = linGrad(ctx, hx, 0, fx, 0, a > 0.5 ? ['#4a3826', '#5e4831'] : ['#2e2216', '#4a3826']);
    poly(ctx, [hx, 30, fx, ty, fx, by, hx, 720]); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 3;
    const ix = (u) => lerp(hx, fx, u), iy = (u, v) => lerp(lerp(30, ty, u), lerp(720, by, u), v);
    poly(ctx, [ix(0.15), iy(0.15, 0.06), ix(0.85), iy(0.85, 0.06), ix(0.85), iy(0.85, 0.44), ix(0.15), iy(0.15, 0.44)]); ctx.stroke();
    poly(ctx, [ix(0.15), iy(0.15, 0.52), ix(0.85), iy(0.85, 0.52), ix(0.85), iy(0.85, 0.94), ix(0.15), iy(0.15, 0.94)]); ctx.stroke();
    if (a > 0.7) { ctx.fillStyle = '#a08040'; circ(ctx, fx - dir * 22, 380, 9); ctx.fill(); }
  });
}

function drawBedView() {
  ctx.drawImage(Scenes.bedBack, 0, 0);
  const m = G.ai.minis;
  if (m.nightmare >= 0) {
    const k = 1 - m.nightmare / m.nightmareMax;
    drawVillain(ctx, 'xavier', 640, 650, 1.2 + 0.2 * k, { eyes: true, jaw: k * 0.5 });
  }
  ctx.drawImage(Scenes.bedFront, 0, 0);
  [[470, 525], [655, 565], [835, 510]].slice(0, m.count).forEach(([x, y], i) => drawMini(ctx, x, y, 1, i));
}

/* Darkness + flashlight + red emergency lighting */
function drawLighting(view) {
  const radius = { center: 240, left: 270, right: 270, closet: 300, bed: 280 }[view] || 250;
  lctx.globalCompositeOperation = 'source-over';
  lctx.clearRect(0, 0, W, H);
  lctx.fillStyle = `rgba(0,0,0,${G.flicker > 0 ? 0.985 : 0.94})`;
  lctx.fillRect(0, 0, W, H);
  if (G.flashOn) {
    lctx.globalCompositeOperation = 'destination-out';
    const r = radius * (G.battery < 20 ? 0.75 + (0.25 * G.battery) / 20 : 1) * (1 + Math.sin(G.t * 13) * 0.012);
    const mx = Input.mx, my = Input.my;
    const g2 = lctx.createRadialGradient(mx, my, r * 0.6, mx, my, r * 2.3);
    g2.addColorStop(0, 'rgba(0,0,0,0.28)'); g2.addColorStop(1, 'rgba(0,0,0,0)');
    lctx.fillStyle = g2; lctx.fillRect(0, 0, W, H);
    const g = lctx.createRadialGradient(mx, my, 0, mx, my, r);
    g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(0.45, 'rgba(0,0,0,0.93)');
    g.addColorStop(0.8, 'rgba(0,0,0,0.35)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    lctx.fillStyle = g; lctx.fillRect(mx - r, my - r, r * 2, r * 2);
  }
  ctx.drawImage(lightCanvas, 0, 0);

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  if (G.flashOn) {   // warm bulb tint
    const g = ctx.createRadialGradient(Input.mx, Input.my, 0, Input.mx, Input.my, radius * 0.8);
    g.addColorStop(0, 'rgba(60,45,20,0.25)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
  // red emergency light
  const pulse = 0.5 + 0.5 * Math.sin(G.t * 1.8);
  const ex = view === 'center' ? 640 : W / 2, ey = view === 'center' ? 32 : -60;
  const rg = ctx.createRadialGradient(ex, ey, 0, ex, ey, 780);
  rg.addColorStop(0, `rgba(150,0,0,${0.22 + 0.12 * pulse})`); rg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
  if (view === 'center') {
    ctx.fillStyle = `rgba(255,30,20,${0.55 + 0.4 * pulse})`; rr(ctx, 622, 30, 36, 10, 4); ctx.fill();
    // Zynovan's eyes in the closet gap
    if (G.ai && G.ai.zynovan.stage >= 3) {
      ctx.fillStyle = `rgba(255,40,90,${0.5 + 0.3 * Math.sin(G.t * 3)})`;
      circ(ctx, 634, 320, 3); ctx.fill(); circ(ctx, 648, 320, 3); ctx.fill();
    }
  }
  ctx.restore();
}

function renderPostFX() {
  ctx.save();
  ctx.globalAlpha = 0.07;
  ctx.fillStyle = Scenes.grain[(G.t * 24 | 0) % Scenes.grain.length];
  ctx.translate(rand(-128, 0), rand(-128, 0));
  ctx.fillRect(0, 0, W + 256, H + 256);
  ctx.restore();
  // rolling CRT band
  const y = ((G.t * 110) % (H + 240)) - 120;
  ctx.fillStyle = 'rgba(255,255,255,0.025)'; ctx.fillRect(0, y, W, 70);
  ctx.drawImage(Scenes.vignette, 0, 0);
  if (G.flicker > 0) { ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(0, 0, W, H); }
}

function renderStatic(alpha) {
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(${200 + rand(55)},${rand(80)},${rand(80)},${rand(0.05, alpha * 0.3)})`;
    ctx.fillRect(0, rand(H), W, rand(1, 6));
  }
}

function renderJumpscare() {
  const js = G.js, t = js.t, id = js.id;
  const f = Math.floor(t * 24) % 3;
  if (t < 1.3) {
    if (f === 0) { ctx.fillStyle = Math.floor(t * 12) % 2 ? '#8a0000' : '#e8e0d8'; ctx.fillRect(0, 0, W, H); }
  }
  const k = clamp(t / 0.32, 0, 1), ease = 1 - Math.pow(1 - k, 3);
  const zoom = 0.3 + ease * 1.05 + Math.max(0, t - 0.32) * 0.22;
  const jit = 22 * Math.max(0.2, 1 - t / 1.9);
  const img = Assets.get(id + '/jumpscare');
  ctx.save();
  ctx.translate(W / 2 + rand(-jit, jit), H / 2 + rand(-jit, jit));
  ctx.rotate(rand(-0.04, 0.04));
  ctx.scale(zoom, zoom);
  if (img) {
    const sc = Math.max(W / img.width, H / img.height) * 1.05;
    ctx.drawImage(img, (-img.width * sc) / 2, (-img.height * sc) / 2, img.width * sc, img.height * sc);
  } else {
    ctx.scale(2.15, 2.15); ctx.translate(0, 330);
    withShading(ctx, W / 2, H * 0.35, 0.75, (c) => drawFigure(c, id, { jaw: 0.6 + 0.4 * Math.sin(t * 38), eyes: true, arms: 'reach' }));
  }
  ctx.restore();
  if (f === 1) { ctx.fillStyle = 'rgba(255,0,0,0.25)'; ctx.fillRect(0, 0, W, H); }
  renderStatic(t > 1.2 ? 1 : 0.6);
  if (t > 1.5) { ctx.fillStyle = `rgba(0,0,0,${(t - 1.5) / 0.4})`; ctx.fillRect(0, 0, W, H); }
}

/* Menu background: dark room, a sweeping flashlight, and Xavier in the closet. */
function renderMenuBG() {
  ctx.drawImage(Scenes.center, 0, 0);
  const flash = G.menuFlash > 0;
  // closet ajar with Xavier inside
  ctx.save();
  ctx.fillStyle = '#020102'; ctx.fillRect(600, 200, 80, 320);
  ctx.beginPath(); ctx.rect(600, 200, 80, 320); ctx.clip();
  drawVillain(ctx, 'xavier', 640, 640, 0.75, { eyes: true, flat: true });
  ctx.restore();
  // door panels of closet swung slightly
  ctx.fillStyle = '#4d3b29'; ctx.fillRect(560, 200, 40, 320); ctx.fillRect(680, 200, 40, 320);

  const mx = 640 + Math.sin(G.t * 0.37) * 420, my = 400 + Math.sin(G.t * 0.61) * 160;
  lctx.globalCompositeOperation = 'source-over';
  lctx.clearRect(0, 0, W, H);
  lctx.fillStyle = `rgba(0,0,0,${flash ? 0.55 : 0.95})`; lctx.fillRect(0, 0, W, H);
  lctx.globalCompositeOperation = 'destination-out';
  const g = lctx.createRadialGradient(mx, my, 0, mx, my, 230);
  g.addColorStop(0, 'rgba(0,0,0,0.9)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  lctx.fillStyle = g; lctx.fillRect(0, 0, W, H);
  ctx.drawImage(lightCanvas, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const pulse = 0.5 + 0.5 * Math.sin(G.t * 1.8);
  const rg = ctx.createRadialGradient(640, 32, 0, 640, 32, 800);
  rg.addColorStop(0, `rgba(150,0,0,${0.2 + 0.1 * pulse})`); rg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = `rgba(255,30,20,${0.5 + 0.4 * pulse})`; rr(ctx, 622, 30, 36, 10, 4); ctx.fill();
  // Xavier's eyes always watch from the closet
  ctx.fillStyle = 'rgba(255,40,20,0.85)';
  circ(ctx, 640 - 28 * 0.75, 640 - 370 * 0.75, 3); ctx.fill(); circ(ctx, 640 + 28 * 0.75, 640 - 370 * 0.75, 3); ctx.fill();
  ctx.restore();
  if (flash) { ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(0, 0, W, H); }
}

function renderDebug() {
  const a = G.ai;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(10, 10, 330, 120);
  ctx.fillStyle = '#0f0'; ctx.font = '14px monospace'; ctx.textAlign = 'left';
  [`state ${G.state} view ${G.view} t ${G.time.toFixed(1)}`,
   `steven L${a.steven.level} st${a.steven.stage} pat ${a.steven.patience.toFixed(1)} hold ${a.steven.hold.toFixed(1)}`,
   `xavier L${a.xavier.level} st${a.xavier.stage} pat ${a.xavier.patience.toFixed(1)} hold ${a.xavier.hold.toFixed(1)}`,
   `zyn L${a.zynovan.level} st${a.zynovan.stage} pat ${a.zynovan.patience.toFixed(1)}`,
   `minis L${a.minis.level} n${a.minis.count} nm ${a.minis.nightmare.toFixed(1)}`,
   `battery ${G.battery.toFixed(1)} flash ${G.flashOn}`].forEach((s, i) => ctx.fillText(s, 20, 30 + i * 17));
  ctx.restore();
}

/* ==========================================================================
 * 10. UI / MENUS / BOOT
 * ========================================================================== */
const SCREENS = ['loading', 'menu', 'nights', 'howto', 'guide', 'intro', 'pause', 'gameover', 'win'];
function showScreen(name) {
  SCREENS.forEach((s) => $('#screen-' + s).classList.toggle('hidden', s !== name));
}

let lastHudKey = '';
function updateHUD(force) {
  const hourLabel = G.hour === 0 ? '12' : String(G.hour);
  $('#hud-clock').innerHTML = `${hourLabel} <span>AM</span>`;
  $('#hud-night').textContent = G.night === 6 ? 'Nightmare' : `Night ${G.night}`;
  const pct = Math.ceil(G.battery);
  $('#hud-battery .fill').style.width = `${G.battery}%`;
  $('#hud-battery .pct').textContent = `${pct}%`;
  $('#hud-battery').classList.toggle('low', G.battery < 20);

  const key = `${G.view}|${!!G.trans}|${G.showHints}`;
  if (!force && key === lastHudKey) return;
  lastHudKey = key;
  const v = G.view, center = v === 'center';
  $('#nav-left').classList.toggle('hidden', !center);
  $('#nav-right').classList.toggle('hidden', !center);
  $('#nav-closet').classList.toggle('hidden', !center);
  $('#nav-bed').classList.toggle('hidden', !center);
  $('#nav-back').classList.toggle('hidden', center);
  $('#hold-btn').classList.toggle('show', v === 'left' || v === 'right' || v === 'closet');
  $('#flash-btn').classList.add('show');
  const hints = {
    center: '<kbd>A</kbd> left door · <kbd>D</kbd> right door · <kbd>W</kbd> closet · <kbd>S</kbd> bed · hold <kbd>MOUSE</kbd> flashlight',
    left: 'hold <kbd>MOUSE</kbd> light (far only!) · hold <kbd>SPACE</kbd>/<kbd>R-CLICK</kbd> door · light off = listen · <kbd>S</kbd> back',
    right: 'hold <kbd>MOUSE</kbd> light (far only!) · hold <kbd>SPACE</kbd>/<kbd>R-CLICK</kbd> door · light off = listen · <kbd>S</kbd> back',
    closet: 'hold <kbd>MOUSE</kbd> look · hold <kbd>SPACE</kbd>/<kbd>R-CLICK</kbd> to hold the closet shut · <kbd>S</kbd> back',
    bed: 'hold <kbd>MOUSE</kbd> to flash the bed · <kbd>S</kbd> back',
  };
  $('#hint').innerHTML = G.showHints ? hints[v] + ' · <kbd>H</kbd> hide' : '';
}

function addAlert(text, cls = 'sound') {
  if (!text) return;
  const box = $('#alerts');
  const el = document.createElement('div');
  el.className = 'alert ' + cls;
  el.textContent = text;
  box.appendChild(el);
  while (box.children.length > 3) box.removeChild(box.firstChild);
  setTimeout(() => el.remove(), 4700);
}

function buildNightGrid() {
  const done = loadProgress();
  const grid = $('#night-grid');
  grid.innerHTML = '';
  NIGHTS.forEach((n, i) => {
    const num = i + 1, nightmare = num === 6;
    const b = document.createElement('button');
    b.className = 'night-card' + (nightmare ? ' nightmare' : '') + (nightmare && done < 5 ? ' locked' : '');
    b.innerHTML = `${nightmare ? 'Nightmare' : 'Night ' + num}<span class="stars">${done >= num ? '★' : ''}</span>` +
      `<small>${nightmare ? (done < 5 ? 'beat Night 5' : 'all at max') : ['Steven', '+ Xavier', '+ Zynovan', 'faster', 'Xavier hunts'][i]}</small>`;
    b.addEventListener('click', () => startNight(num));
    grid.appendChild(b);
  });
}

function buildAssetStatus() {
  const box = $('#asset-status');
  box.innerHTML = '';
  ASSET_MANIFEST.forEach((e) => {
    const s = Assets.store[e.key] || { found: false };
    const a = document.createElement('span'); a.textContent = e.label;
    const b = document.createElement('span');
    b.className = s.found ? 'ok' : 'miss';
    b.textContent = s.found ? `✔ ${s.path}` : `✖ vector fallback (${e.paths[0]}.png)`;
    box.append(a, b);
  });
}

function nextNight() { const d = loadProgress(); return d >= 5 ? 6 : d + 1; }

function showMenu() {
  G.state = 'menu';
  Sound.stopLoops();
  $('#hud').classList.add('hidden');
  $('#stage').classList.remove('shake');
  const done = loadProgress();
  const cont = $('#continue-btn');
  cont.disabled = done === 0;
  cont.querySelector('small').textContent = done ? `(${nextNight() === 6 ? 'Nightmare' : 'Night ' + nextNight()})` : '';
  drawRaoul($('#menu-portrait').getContext('2d'), 320, 320, 1);
  showScreen('menu');
}

/* Menu / screen button actions */
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-action]');
  if (!b) return;
  Sound.init();
  switch (b.dataset.action) {
    case 'new': startNight(1); break;
    case 'continue': startNight(nextNight()); break;
    case 'nights': buildNightGrid(); showScreen('nights'); break;
    case 'howto': showScreen('howto'); break;
    case 'guide': buildAssetStatus(); showScreen('guide'); break;
    case 'menu': showMenu(); break;
    case 'resume': resumeGame(); break;
    case 'restart': Sound.resume(); startNight(G.night); break;
    case 'quit': Sound.resume(); showMenu(); break;
    case 'next': startNight(Math.min(G.night + 1, 6)); break;
  }
});
$('#screen-intro').addEventListener('click', () => { Sound.init(); beginPlay(); });

/* --- Main loop --- */
let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  try {
    update(dt);
    render();
  } catch (err) {
    console.error(err);
  }
  requestAnimationFrame(frame);
}

/* --- Boot --- */
async function boot() {
  buildScenes();
  requestAnimationFrame(frame);
  const fill = $('.progress-fill'), status = $('.loading-status');
  let found = 0;
  await Assets.loadAll((p, entry, ok) => {
    fill.style.width = `${Math.round(p * 100)}%`;
    if (ok) found++;
    status.textContent = `${found} custom photo${found === 1 ? '' : 's'} found · ${entry.label}`;
  });
  status.textContent = found
    ? `${found} custom photo${found === 1 ? '' : 's'} loaded and color-graded.`
    : 'No custom photos found — using built-in monsters. (See Asset Guide.)';
  const enter = $('#enter-btn');
  enter.classList.remove('hidden');
  enter.addEventListener('click', () => { Sound.init(); showMenu(); }, { once: true });
}

// Exposed for console tinkering / testing.
window.FNAX = { G, Assets, Sound, startNight, breach, go, NIGHTS, CONFIG };

boot();
