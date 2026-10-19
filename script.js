/* ==========================================================================
 *  FIVE NIGHTS AT XAVIER'S — script.js
 *  FNAF 4-style classroom survival horror parody.
 *
 *  RENDERING PIPELINE (why it looks pre-rendered, not flat):
 *    1. Three.js builds the classroom, hallway, storage closet and the three
 *       animatronics as real 3D geometry with procedural PBR textures.
 *    2. At load time the BAKER renders every camera view and every villain
 *       pose OFFLINE (real soft shadows, bump mapping) into G-buffers:
 *         albedo (pre-lit colour + coverage) · view-space normals · depth/emissive.
 *       That's the "pre-rendered" step — exactly how FNAF 4's art works.
 *    3. PixiJS displays those baked layers with a custom deferred-lighting
 *       shader: a narrow conical flashlight (per-pixel N·L, distance falloff,
 *       hot-spot, volumetric haze) and a deep red emergency light. Anything
 *       outside the beam falls to pitch black.
 *    4. A full-screen post shader adds film grain, CRT scanlines, barrel
 *       distortion, chromatic aberration (boosted during jumpscares) and vignette.
 *  Photos you add (faces, sprites, backgrounds) are fed into the same
 *  pipeline: faces are wrapped onto the 3D skulls before baking; sprites get
 *  generated normal maps so the beam rakes across them.
 *
 *  Sections
 *   1. Config        2. Helpers & noise      3. Asset loader & photo blending
 *   4. Procedural textures                   5. World (classroom/hall/storage)
 *   6. Animatronics  7. Baker (Three.js)     8. Graphics (PixiJS + shaders)
 *   9. Sound (HRTF)  10. AI                  11. Game loop & input
 *  12. UI & boot
 *
 *  URL flags:  ?fast (8 s hours)  ?debug  ?quality=low|medium|high
 * ========================================================================== */
'use strict';

/* ==========================================================================
 * 1. CONFIG
 * ========================================================================== */
const VW = 1280, VH = 720;                 // virtual game resolution (16:9)
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');

const CONFIG = {
  secondsPerHour: params.has('fast') ? 8 : 50,
  batteryDrain: 0.5,          // % per second with the beam on
  transitionTime: 0.36,
  startGrace: 7,
  fovY: 58,                   // all baked cameras share this
  far: 40,                    // depth encoding range (metres)
  storageKey: 'fnax-classroom-progress',
};

/* Automated asset scaling: bake resolution adapts to the device. */
function pickBakeWidth() {
  const q = params.get('quality');
  if (q === 'low') return 960;
  if (q === 'medium') return 1280;
  if (q === 'high') return 1920;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const px = Math.max(screen.width, screen.height) * dpr;
  if (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) return 960;
  return px >= 2400 ? 1600 : 1280;
}
const BAKE_W = pickBakeWidth();
const BAKE_H = BAKE_W * 9 / 16;
const TAN_Y = Math.tan((CONFIG.fovY / 2) * Math.PI / 180);
const TAN_X = TAN_Y * 16 / 9;

const VILLAINS = {
  xavier: {
    name: 'Xavier', fur: '#6b4a22', belly: '#b08a52', eye: 0xff2a1a,
    quotes: ['"You should have turned around, Raoul."', '"Class is in session. Forever."',
             '"Every friend has a face. I wear all of them."', '"Did you think the little ones were harmless?"'],
  },
  steven: {
    name: 'Steven Pivac', fur: '#4b3f6e', belly: '#8e7fb8', eye: 0xff3b2f,
    quotes: ['"Breathing that loud? Rookie mistake."', '"I was RIGHT outside the door, Raoul."',
             '"Hall pass? I don\'t think so."'],
  },
  zynovan: {
    name: 'Zynovan Snusvac', fur: '#3f5a37', belly: '#93ad6e', eye: 0xff2f6a,
    quotes: ['"Want a pouch? ...Too late."', '"Supplies are running low, Raoul."',
             '"Shhh. Tins rattle. So do bones."'],
  },
  harry: {
    name: 'Hazza the Cyclist',
    quotes: ['"Ding ding, Raoul."', '"I can\'t see you. I didn\'t need to."', '"Should\'ve locked your door. I don\'t brake."'],
  },
};
VILLAINS.kirk = {
  name: 'Croissant Kirk',
  quotes: ['"You looked. Everyone always looks."', '"Got leaked. Got kirkified. Got YOU."', '"This is a true story, Raoul."'],
};
const VILLAIN_IDS = Object.keys(VILLAINS);

/* AI levels per night (0 = absent, 20 = relentless). Tuned to ramp like FNAF 4,
 * just a notch harder: Hazza arrives on Night 2, Croissant Kirk on Night 3. */
const NIGHTS = [
  { steven: 3, xavier: 0, minis: 2, zynovan: 3, harry: 0, kirk: 0,
    msg: '"Detention, Raoul. All night." — X', tip: 'Survive until 6 AM.' },
  { steven: 5, xavier: 3, minis: 4, zynovan: 5, harry: 3, kirk: 0,
    msg: '"I brought some friends." — X', tip: 'Survive until 6 AM.' },
  { steven: 7, xavier: 6, minis: 6, zynovan: 8, harry: 5, kirk: 3,
    msg: '"Something new moved in tonight." — X', tip: 'Survive until 6 AM.' },
  { steven: 10, xavier: 9, minis: 8, zynovan: 11, harry: 8, kirk: 6,
    msg: '"Pop quiz, Raoul." — X', tip: 'Survive until 6 AM.' },
  { steven: 13, xavier: 13, minis: 10, zynovan: 14, harry: 11, kirk: 9,
    msg: '"Final exam. I\'m grading you myself." — X', tip: 'Survive until 6 AM.' },
  { steven: 18, xavier: 18, minis: 14, zynovan: 18, harry: 18, kirk: 16,
    msg: '"N̷I̵G̴H̸T̷M̶A̵R̸E̶."', tip: 'Survive until 6 AM.' },
];

/* ==========================================================================
 * 2. HELPERS & NOISE
 * ========================================================================== */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));
const chance = (p) => Math.random() < p;
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const approach = (v, t, s) => (v < t ? Math.min(t, v + s) : Math.max(t, v - s));
const roll = (level) => Math.random() * 20 < level;
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function seeded(seed) { return () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }; }
function hexRGB(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function hash2(x, y) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/* Tileable value noise + fbm (periods Px/Py keep textures seamless). */
const Noise = (() => {
  const perm = new Uint8Array(512), R = seeded(1337), p = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = (R() * (i + 1)) | 0; [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const h = (x, y) => perm[perm[x & 255] + (y & 255)];
  function vp(x, y, Px, Py) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const x0 = ((xi % Px) + Px) % Px, y0 = ((yi % Py) + Py) % Py, x1 = (x0 + 1) % Px, y1 = (y0 + 1) % Py;
    const u = xf * xf * (3 - 2 * xf), w = yf * yf * (3 - 2 * yf);
    return lerp(lerp(h(x0, y0), h(x1, y0), u), lerp(h(x0, y1), h(x1, y1), u), w) / 255;
  }
  function fbm(x, y, oct = 4, Px = 8, Py = Px) {
    let s = 0, amp = 0.5, f = 1, n = 0;
    for (let i = 0; i < oct; i++) { s += vp(x * f, y * f, Px * f, Py * f) * amp; n += amp; amp *= 0.5; f *= 2; }
    return s / n;
  }
  return { vp, fbm };
})();

/* ==========================================================================
 * 3. ASSET LOADER & PHOTO BLENDING
 * ========================================================================== */
const IMG_EXT = ['png', 'jpg', 'jpeg', 'webp'];
const AUDIO_EXT = ['wav', 'mp3', 'ogg'];
const CLASSROOM_VIEWS = ['center', 'door_left', 'door_right', 'locker', 'desks'];

function buildManifest() {
  const m = [];
  const add = (key, path, label, group) => m.push({ key, path, label, group });
  add('player/raoul', 'assets/player/raoul', 'Raoul Mann — headshot', 'player');
  for (const id of VILLAIN_IDS) {
    const n = VILLAINS[id].name;
    add(`${id}/face`, `assets/villains/${id}/face`, `${n} — face (pasted on 3D head)`, id);
    add(`${id}/face_2`, `assets/villains/${id}/face_2`, `${n} — second face (used for half his appearances)`, id);
    if (id === 'zynovan') {
      for (let s = 1; s <= 4; s++) add(`${id}/locker_stage_${s}`, `assets/villains/${id}/locker_stage_${s}`, `${n} — locker stage ${s}`, id);
    } else {
      add(`${id}/hallway_far`, `assets/villains/${id}/hallway_far`, `${n} — far sprite`, id);
      add(`${id}/hallway_near`, `assets/villains/${id}/hallway_near`, `${n} — near sprite`, id);
    }
    if (id === 'xavier') add('xavier/podium', 'assets/villains/xavier/podium', 'Xavier — behind podium', id);
    if (id === 'kirk') ['room_far', 'room_mid', 'room_near'].forEach((k) => add(`kirk/${k}`, `assets/villains/kirk/${k}`, `Croissant Kirk — ${k.replace('_', ' ')}`, id));
    add(`${id}/gameover`, `assets/villains/${id}/gameover`, `${n} — game-over portrait`, id);
    add(`${id}/poster`, `assets/villains/${id}/poster`, `${n} — classroom wall poster`, id);
  }
  for (const v of CLASSROOM_VIEWS) {
    add(`classroom/${v}`, `assets/classroom/${v}`, `Classroom — ${v}`, 'classroom');
    add(`classroom/${v}_normal`, `assets/classroom/${v}_normal`, `Classroom — ${v} normal map`, 'classroom');
    add(`classroom/${v}_depth`, `assets/classroom/${v}_depth`, `Classroom — ${v} depth map`, 'classroom');
  }
  for (const v of ['door_left_closed', 'door_right_closed', 'locker_closed']) {
    add(`classroom/${v}`, `assets/classroom/${v}`, `Classroom — ${v}`, 'classroom');
  }
  return m;
}

const Assets = {
  store: {}, jumpscares: {}, manifest: buildManifest(),

  loadImage(src) {
    return new Promise((res) => {
      const img = new Image();
      img.onload = () => res(img.naturalWidth > 0 ? img : null);
      img.onerror = () => res(null);
      img.src = src;
    });
  },
  async probe(base) {
    for (const ext of IMG_EXT) {
      const img = await this.loadImage(`${base}.${ext}`);
      if (img) return { img, path: `${base}.${ext}` };
    }
    return null;
  },
  async loadAll(onProgress) {
    let done = 0;
    const total = this.manifest.length + 3;
    await Promise.all(this.manifest.map(async (e) => {
      const r = await this.probe(e.path);
      this.store[e.key] = r ? { found: true, ...r } : { found: false };
      onProgress(++done / total);
    }));
    // Jumpscare frame sequences: jumpscare_stage_1.png, _2, … until one is missing.
    for (const id of VILLAIN_IDS) {
      const frames = [];
      for (let i = 1; i <= 12; i++) {
        const r = await this.probe(`assets/villains/${id}/jumpscare_stage_${i}`);
        if (!r) break;
        frames.push(r);
      }
      this.jumpscares[id] = frames;
      onProgress(++done / total);
    }
  },
  img(key) { const a = this.store[key]; return a && a.found ? a.img : null; },
  count() { return Object.values(this.store).filter((a) => a.found).length + Object.values(this.jumpscares).reduce((s, f) => s + f.length, 0); },
};

/* Draw an image "cover"-fit into a canvas of the given size. */
function coverCanvas(img, w, h) {
  const c = makeCanvas(w, h), x = c.getContext('2d');
  const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  x.drawImage(img, (w - img.naturalWidth * s) / 2, (h - img.naturalHeight * s) / 2, img.naturalWidth * s, img.naturalHeight * s);
  return c;
}

/**
 * gradePhoto — desaturate, crush blacks, sickly tint, grain, vignette and
 * feathered alpha. Used for faces (before they're wrapped on 3D skulls) and
 * for sprite/jumpscare overrides. Falls back to ctx.filter if tainted.
 */
function gradePhoto(img, { w, h, feather = 0.6, vignette = 0.85, contrast = 1.55, crush = 1, lift = 1 } = {}) {
  w = w || Math.min(1024, img.naturalWidth); h = h || Math.round(w * img.naturalHeight / img.naturalWidth);
  const c = coverCanvas(img, w, h), x = c.getContext('2d');
  try {
    const d = x.getImageData(0, 0, w, h), p = d.data;
    for (let i = 0; i < p.length; i += 4) {
      let r = p[i], g = p[i + 1], b = p[i + 2];
      const l = r * 0.299 + g * 0.587 + b * 0.114;
      r = l + (r - l) * 0.35; g = l + (g - l) * 0.35; b = l + (b - l) * 0.35;
      r = (r - 128) * contrast + 128 - 16 * crush; g = (g - 128) * contrast + 128 - 22 * crush; b = (b - 128) * contrast + 128 - 28 * crush;
      r *= 1.1 * lift; g *= 0.92 * lift; b *= 0.8 * lift;
      const n = (Math.random() - 0.5) * 26;
      p[i] = r + n; p[i + 1] = g + n; p[i + 2] = b + n;
    }
    x.putImageData(d, 0, 0);
  } catch (e) {
    x.clearRect(0, 0, w, h);
    x.filter = 'grayscale(0.65) sepia(0.3) contrast(1.55) brightness(0.75)';
    const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    x.drawImage(img, (w - img.naturalWidth * s) / 2, (h - img.naturalHeight * s) / 2, img.naturalWidth * s, img.naturalHeight * s);
    x.filter = 'none';
  }
  if (vignette > 0) {
    const g = x.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.2, w / 2, h / 2, Math.max(w, h) * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${vignette})`);
    x.fillStyle = g; x.fillRect(0, 0, w, h);
  }
  if (feather > 0) {
    x.globalCompositeOperation = 'destination-in';
    x.save(); x.translate(w / 2, h / 2); x.scale(w / 2, h / 2);
    const f = x.createRadialGradient(0, 0, 0, 0, 0, 1);
    f.addColorStop(0, '#000'); f.addColorStop(feather, '#000'); f.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = f; x.fillRect(-1, -1, 2, 2);
    x.restore(); x.globalCompositeOperation = 'source-over';
  }
  return c;
}

/* Normal map from luminance (Sobel) — lets the flashlight "rake" across photos. */
function normalsFromLuma(src, w, h, strength = 2.2) {
  const out = new Uint8Array(w * h * 4);
  const L = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) L[i] = (src[i * 4] * 0.3 + src[i * 4 + 1] * 0.59 + src[i * 4 + 2] * 0.11) / 255;
  const at = (x, y) => L[clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1)];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
    const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
    let nx = -dx * strength, ny = dy * strength, nz = 1;
    const len = Math.hypot(nx, ny, nz); nx /= len; ny /= len; nz /= len;
    const i = (y * w + x) * 4;
    out[i] = (nx * 0.5 + 0.5) * 255; out[i + 1] = (ny * 0.5 + 0.5) * 255; out[i + 2] = (nz * 0.5 + 0.5) * 255; out[i + 3] = 255;
  }
  return out;
}

/* Pack a metric depth into the RG channels (16-bit) like the baker does. */
function packDepth(buf, i, metres, emissive = 0, spec = 0.1) {
  const d = clamp(metres / CONFIG.far, 0, 0.9999) * 255;
  buf[i] = Math.floor(d); buf[i + 1] = Math.floor((d - Math.floor(d)) * 255); buf[i + 2] = spec * 255; buf[i + 3] = emissive * 255;
}

/* ==========================================================================
 * 4. PROCEDURAL TEXTURES (the "hyper-detailed" surfaces)
 * ========================================================================== */
const TexGen = {
  canvas(w, h) { const c = makeCanvas(w, h); return [c, c.getContext('2d')]; },
  tex(c, srgb = true) {
    const t = new THREE.CanvasTexture(c);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
    return t;
  },
  pair(r) { return { map: this.tex(r.c), bump: this.tex(r.b, false), canvas: r.c }; },
  /* per-pixel painter: fn(x, y, out[r,g,b,bump]) */
  pixels(w, h, fn) {
    const [c, x] = this.canvas(w, h), [b, bx] = this.canvas(w, h);
    const id = x.createImageData(w, h), bd = bx.createImageData(w, h), o = [0, 0, 0, 128];
    for (let y = 0; y < h; y++) for (let X = 0; X < w; X++) {
      o[3] = 128; fn(X, y, o);
      const i = (y * w + X) * 4;
      id.data[i] = o[0]; id.data[i + 1] = o[1]; id.data[i + 2] = o[2]; id.data[i + 3] = 255;
      bd.data[i] = bd.data[i + 1] = bd.data[i + 2] = o[3]; bd.data[i + 3] = 255;
    }
    x.putImageData(id, 0, 0); bx.putImageData(bd, 0, 0);
    return { c, x, b, bx };
  },
  scratches(x, w, h, n, col, R) {
    x.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      x.strokeStyle = col.replace('A', (0.05 + R() * 0.15).toFixed(2)); x.lineWidth = 0.5 + R() * 1.5;
      const sx = R() * w, sy = R() * h; x.beginPath(); x.moveTo(sx, sy);
      x.quadraticCurveTo(sx + (R() - 0.5) * 60, sy + (R() - 0.5) * 60, sx + (R() - 0.5) * 90, sy + (R() - 0.5) * 90); x.stroke();
    }
  },
  stains(x, w, h, n, R, rgb = '40,25,10') {
    for (let i = 0; i < n; i++) {
      const gx = R() * w, gy = R() * h, gr = 10 + R() * 70;
      const g = x.createRadialGradient(gx, gy, gr * 0.6, gx, gy, gr);
      g.addColorStop(0, `rgba(${rgb},${0.05 + R() * 0.12})`); g.addColorStop(0.85, `rgba(${rgb},${0.15 + R() * 0.2})`); g.addColorStop(1, `rgba(${rgb},0)`);
      x.fillStyle = g; x.fillRect(gx - gr, gy - gr, gr * 2, gr * 2);
    }
  },

  floor() {          // vinyl composition tile, 4×4 tiles = 1.2 m
    const S = 512, T = 128, R = seeded(3);
    const pal = [[178, 172, 152], [158, 152, 136], [170, 165, 148], [186, 180, 162]];
    const r = this.pixels(S, S, (x, y, o) => {
      const tx = (x / T) | 0, ty = (y / T) | 0, lx = x % T, ly = y % T;
      const edge = Math.min(lx, ly, T - 1 - lx, T - 1 - ly);
      let c = pal[(hash2(tx, ty) * 4) | 0]; if (hash2(tx + 9, ty + 3) > 0.88) c = [120, 112, 98];
      const n = Noise.fbm(x / S * 8, y / S * 8, 4, 8), dirt = Noise.fbm(x / S * 3 + 5, y / S * 3, 3, 3), sp = hash2(x, y);
      let k = 0.82 + n * 0.3 - dirt * 0.3;
      if (sp > 0.93) k *= 0.7; else if (sp < 0.05) k *= 1.12;
      let bump = 200 + (n - 0.5) * 50;
      if (edge < 2) { k *= 0.3; bump = 40; } else if (edge < 4) { k *= 0.75; bump = 140; }
      o[0] = c[0] * k; o[1] = c[1] * k; o[2] = c[2] * k; o[3] = bump;
    });
    this.scratches(r.x, S, S, 70, 'rgba(25,18,10,A)', R);
    this.stains(r.x, S, S, 6, R);
    return this.pair(r);
  },

  block(paint) {      // painted cinder block, 0.8 m square
    const S = 512, R = seeded(11), c = hexRGB(paint);
    const r = this.pixels(S, S, (x, y, o) => {
      const row = (y / 128) | 0, off = row % 2 ? 128 : 0, bx = (x + off) % 256, by = y % 128;
      const mortar = bx < 7 || by < 7;
      const n = Noise.fbm(x / S * 16, y / S * 16, 4, 16), big = Noise.fbm(x / S * 2, y / S * 2, 3, 2);
      const streak = Noise.fbm(x / S * 8, y / S, 3, 8, 1);
      let k = 0.9 + (n - 0.5) * 0.2 - streak * 0.25 + big * 0.1, bump = 190 + (n - 0.5) * 90;
      if (hash2(x, y) > 0.965) { k *= 0.72; bump -= 60; }
      if (mortar) { k *= 0.78; bump = 60; } else if (bx < 9 || by < 9) { k *= 0.9; bump = 130; }
      o[0] = c[0] * k; o[1] = c[1] * k; o[2] = c[2] * k; o[3] = bump;
    });
    this.stains(r.x, S, S, 5, R, '30,25,15');
    return this.pair(r);
  },

  ceiling() {         // acoustic tiles 2×2 = 1.2 m
    const S = 512, R = seeded(21);
    const r = this.pixels(S, S, (x, y, o) => {
      const lx = x % 256, ly = y % 256, edge = Math.min(lx, ly, 255 - lx, 255 - ly);
      const n = Noise.fbm(x / S * 24, y / S * 24, 3, 24);
      let k = 0.86 + n * 0.16, bump = 200 + (n - 0.5) * 60;
      if (hash2(x, y) > 0.88) { k *= 0.82; bump -= 70; }
      let c = [196, 194, 186];
      if (edge < 6) { c = [150, 150, 146]; k = 1; bump = 255; }
      o[0] = c[0] * k; o[1] = c[1] * k; o[2] = c[2] * k; o[3] = bump;
    });
    this.stains(r.x, S, S, 5, R, '90,60,20');
    return this.pair(r);
  },

  chalk(lines, drawing) {   // chalkboard 1024×512
    const W = 1024, H = 512, R = seeded(lines.length * 7);
    const r = this.pixels(W, H, (x, y, o) => {
      const sm = Noise.fbm(x / W * 6, y / H * 3, 4, 6, 3), n = Noise.fbm(x / W * 40, y / H * 20, 2, 40, 20);
      const k = 0.85 + n * 0.25;
      const w = Math.max(0, sm - 0.45) * 120;
      o[0] = 26 * k + w; o[1] = 46 * k + w; o[2] = 38 * k + w * 0.95; o[3] = 128 + n * 30;
    });
    const x = r.x;
    for (let i = 0; i < 14; i++) {    // erased swirls
      x.strokeStyle = `rgba(210,220,210,${0.03 + R() * 0.04})`; x.lineWidth = 20 + R() * 40;
      x.beginPath(); x.arc(R() * W, R() * H, 40 + R() * 120, R() * 6, R() * 6 + 2); x.stroke();
    }
    const [tc, tx] = this.canvas(W, H);
    tx.fillStyle = 'rgba(235,238,228,0.85)'; tx.strokeStyle = 'rgba(235,238,228,0.8)'; tx.textBaseline = 'top';
    lines.forEach(([txt, px, py, size, rot]) => {
      tx.save(); tx.translate(px, py); tx.rotate(rot || 0);
      tx.font = `${size}px "Chalkboard SE", "Comic Sans MS", "Segoe Print", cursive`;
      for (let j = 0; j < 3; j++) tx.fillText(txt, (R() - 0.5) * 2, (R() - 0.5) * 2);
      tx.restore();
    });
    if (drawing) drawing(tx, R);
    tx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 26000; i++) { tx.fillStyle = `rgba(0,0,0,${0.4 + R() * 0.6})`; tx.fillRect(R() * W, R() * H, 1 + R() * 2, 1 + R() * 2); }
    x.drawImage(tc, 0, 0);
    return this.pair(r);
  },

  lockerDoor(paint, label) {   // supply-locker door panel 256×768
    const W = 256, H = 768, R = seeded(31), c = hexRGB(paint);
    const louver = (y) => (y > 70 && y < 190) || (y > 600 && y < 700);
    const r = this.pixels(W, H, (x, y, o) => {
      const br = Noise.fbm(x / W * 2, y / H * 48, 3, 2, 48), n = Noise.fbm(x / W * 6, y / H * 18, 3, 6, 18);
      const rust = Noise.fbm(x / W * 5 + 2, y / H * 15, 4, 5, 15);
      let k = 0.85 + (br - 0.5) * 0.18 + (n - 0.5) * 0.12, bump = 170 + (n - 0.5) * 40;
      let col = c;
      const edgeRust = (y > H - 110 ? (y - (H - 110)) / 110 : 0) + (x < 12 || x > W - 12 ? 0.5 : 0);
      if (rust + edgeRust * 0.5 > 0.78) { col = [104, 58, 30]; k = 0.6 + rust * 0.5; bump = 120 + rust * 80; }
      if (louver(y) && x > 50 && x < 206) {
        const ly = (y - (y > 600 ? 600 : 70)) % 17;
        if (ly < 7) { k *= 0.12; bump = 20; } else if (ly < 9) { k *= 1.3; bump = 240; }
      }
      if (x < 6 || x > W - 6) { k *= 0.6; bump = 230; }
      o[0] = col[0] * k; o[1] = col[1] * k; o[2] = col[2] * k; o[3] = bump;
    });
    this.scratches(r.x, W, H, 90, 'rgba(220,225,230,A)', R);
    // dents
    for (let i = 0; i < 6; i++) {
      const dx = R() * W, dy = 220 + R() * 350, dr = 10 + R() * 22;
      const g = r.bx.createRadialGradient(dx, dy, 0, dx, dy, dr);
      g.addColorStop(0, 'rgba(0,0,0,0.6)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      r.bx.fillStyle = g; r.bx.fillRect(dx - dr, dy - dr, dr * 2, dr * 2);
    }
    if (label) {
      r.x.fillStyle = '#b8b2a0'; r.x.fillRect(78, 250, 100, 34);
      r.x.fillStyle = '#1a1a1a'; r.x.font = 'bold 22px Arial'; r.x.textAlign = 'center'; r.x.fillText(label, 128, 275);
    }
    return this.pair(r);
  },

  hallLocker(paint) {   // one hallway locker 128×512, tiled along the walls
    const W = 128, H = 512, R = seeded(41), c = hexRGB(paint);
    const r = this.pixels(W, H, (x, y, o) => {
      const n = Noise.fbm(x / W * 4, y / H * 16, 3, 4, 16), rust = Noise.fbm(x / W * 4 + 7, y / H * 16, 3, 4, 16);
      let k = 0.8 + (n - 0.5) * 0.25, bump = 170, col = c;
      if (rust > 0.74 && (y > 430 || x < 10 || x > W - 10)) { col = [95, 55, 30]; k = 0.7; }
      const louv = (y > 40 && y < 100) || (y > 420 && y < 470);
      if (louv && x > 26 && x < 102 && (y % 12) < 5) { k *= 0.15; bump = 20; }
      if (x < 4 || x > W - 4) { k *= 0.25; bump = 10; }
      if (x > 92 && x < 108 && y > 230 && y < 300) { k *= 0.35; bump = 60; }   // latch recess
      o[0] = col[0] * k; o[1] = col[1] * k; o[2] = col[2] * k; o[3] = bump;
    });
    this.scratches(r.x, W, H, 30, 'rgba(230,230,230,A)', R);
    r.x.fillStyle = 'rgba(200,190,170,0.7)'; r.x.fillRect(40, 130, 48, 18);
    r.x.fillStyle = '#111'; r.x.font = 'bold 14px Arial'; r.x.textAlign = 'center'; r.x.fillText('13' + ((R() * 9) | 0), 64, 144);
    return this.pair(r);
  },

  door() {            // classroom door 256×512 (window area left dark, glass is geometry)
    const W = 256, H = 512, R = seeded(51);
    const r = this.pixels(W, H, (x, y, o) => {
      const warp = Noise.fbm(x / W * 2, y / H * 4, 3, 2, 4);
      const grain = 0.5 + 0.5 * Math.sin((x / W) * 70 + warp * 14);
      const n = Noise.fbm(x / W * 8, y / H * 32, 3, 8, 32);
      let k = 0.6 + grain * 0.25 + n * 0.2, col = [124, 84, 48], bump = 150 + grain * 50;
      if (x > 58 && x < 198 && y > 68 && y < 232) { col = [20, 18, 16]; k = 1; bump = 60; }
      if (y > 448) { col = [128, 126, 118]; k = 0.8 + n * 0.3; bump = 210; }
      o[0] = col[0] * k; o[1] = col[1] * k; o[2] = col[2] * k; o[3] = bump;
    });
    this.scratches(r.x, W, H, 50, 'rgba(20,10,5,A)', R);
    r.x.fillStyle = '#c8c0a8'; r.x.fillRect(96, 252, 64, 26);
    r.x.fillStyle = '#111'; r.x.font = 'bold 18px Arial'; r.x.textAlign = 'center'; r.x.fillText('13', 128, 272);
    return this.pair(r);
  },

  desk() {            // laminate desk top 512×384
    const W = 512, H = 384, R = seeded(61);
    const r = this.pixels(W, H, (x, y, o) => {
      const warp = Noise.fbm(x / W * 2, y / H * 3, 3, 2, 3);
      const grain = 0.5 + 0.5 * Math.sin((y / H) * 90 + warp * 10);
      const n = Noise.fbm(x / W * 16, y / H * 12, 3, 16, 12);
      const k = 0.75 + grain * 0.18 + n * 0.15;
      o[0] = 178 * k; o[1] = 142 * k; o[2] = 98 * k; o[3] = 160 + grain * 40;
    });
    const x = r.x;
    this.scratches(x, W, H, 120, 'rgba(40,25,10,A)', R);
    x.save(); x.translate(130, 200); x.rotate(-0.2); x.font = 'bold 30px "Comic Sans MS", cursive';
    x.fillStyle = 'rgba(30,30,80,0.55)'; x.fillText('RAOUL WAS HERE', 0, 0); x.restore();
    x.save(); x.translate(360, 110); x.rotate(0.3); x.strokeStyle = 'rgba(120,0,0,0.6)'; x.lineWidth = 4;
    x.beginPath(); x.moveTo(-20, -20); x.lineTo(20, 20); x.moveTo(20, -20); x.lineTo(-20, 20); x.stroke(); x.restore();
    for (let i = 0; i < 5; i++) { x.fillStyle = `rgba(90,80,70,0.7)`; x.beginPath(); x.arc(R() * W, R() * H, 4 + R() * 5, 0, 7); x.fill(); }
    return this.pair(r);
  },

  cork() {            // bulletin board with pinned papers & red yarn
    const S = 512, R = seeded(71);
    const r = this.pixels(S, S, (x, y, o) => {
      const n = hash2(x, y), m = Noise.fbm(x / S * 10, y / S * 10, 3, 10);
      const k = 0.7 + n * 0.35 + m * 0.2;
      o[0] = 150 * k; o[1] = 108 * k; o[2] = 68 * k; o[3] = 90 + n * 120;
    });
    const x = r.x, pins = [];
    const papers = ['#e8e4d8', '#e8dc9a', '#e8b8c8', '#c8dce8', '#e8e4d8'];
    for (let i = 0; i < 9; i++) {
      const px = 30 + R() * 400, py = 30 + R() * 380, pw = 80 + R() * 60, ph = 90 + R() * 50;
      x.save(); x.translate(px + pw / 2, py + ph / 2); x.rotate((R() - 0.5) * 0.3);
      x.fillStyle = papers[i % papers.length]; x.fillRect(-pw / 2, -ph / 2, pw, ph);
      x.strokeStyle = 'rgba(40,40,80,0.5)'; x.lineWidth = 1.5;
      if (i % 3 === 0) {   // a kid's drawing of the three
        [[-25, '#6b4a22'], [0, '#4b3f6e'], [25, '#3f5a37']].forEach(([fx, col]) => {
          x.strokeStyle = col; x.lineWidth = 3; x.beginPath(); x.arc(fx, -15, 8, 0, 7); x.stroke();
          x.beginPath(); x.moveTo(fx, -7); x.lineTo(fx, 20); x.moveTo(fx - 9, 0); x.lineTo(fx + 9, 0); x.stroke();
          x.fillStyle = '#c00'; x.fillRect(fx - 4, -17, 2, 2); x.fillRect(fx + 2, -17, 2, 2);
        });
        x.fillStyle = '#a00'; x.font = 'bold 10px "Comic Sans MS"'; x.fillText('MY TEACHERS', -32, 36);
      } else {
        for (let l = 0; l < 7; l++) { x.beginPath(); x.moveTo(-pw / 2 + 8, -ph / 2 + 14 + l * 10); x.lineTo(-pw / 2 + 8 + R() * (pw - 16), -ph / 2 + 14 + l * 10); x.stroke(); }
      }
      x.restore();
      pins.push([px + pw / 2, py + 8]);
    }
    x.strokeStyle = 'rgba(170,10,10,0.85)'; x.lineWidth = 2.5; x.beginPath();
    pins.forEach(([px, py], i) => (i ? x.lineTo(px, py) : x.moveTo(px, py))); x.stroke();
    pins.forEach(([px, py]) => { x.fillStyle = '#c01010'; x.beginPath(); x.arc(px, py, 5, 0, 7); x.fill(); });
    return this.pair(r);
  },

  cardboard(label, seed) {
    const S = 256, R = seeded(seed);
    const r = this.pixels(S, S, (x, y, o) => {
      const n = Noise.fbm(x / S * 6, y / S * 6, 3, 6), corr = 0.5 + 0.5 * Math.sin(x * 0.9);
      const k = 0.72 + n * 0.3 + corr * 0.04;
      let col = [158, 118, 74];
      if (y > 112 && y < 144) col = [186, 166, 120];
      o[0] = col[0] * k; o[1] = col[1] * k; o[2] = col[2] * k; o[3] = 140 + corr * 30;
    });
    r.x.fillStyle = 'rgba(20,20,20,0.8)'; r.x.font = 'bold 30px "Marker Felt", "Comic Sans MS", cursive'; r.x.textAlign = 'center';
    r.x.fillText(label, 128, 200);
    this.stains(r.x, S, S, 3, R, '60,35,15');
    return this.pair(r);
  },

  metal(hex, seed) {
    const S = 256, R = seeded(seed), c = hexRGB(hex);
    const r = this.pixels(S, S, (x, y, o) => {
      const n = Noise.fbm(x / S * 4, y / S * 32, 3, 4, 32), rust = Noise.fbm(x / S * 5, y / S * 5, 4, 5);
      let k = 0.8 + (n - 0.5) * 0.3, col = c;
      if (rust > 0.66) { col = [100, 55, 28]; k = 0.6 + rust * 0.4; }
      o[0] = col[0] * k; o[1] = col[1] * k; o[2] = col[2] * k; o[3] = rust > 0.66 ? 90 + rust * 100 : 180;
    });
    this.scratches(r.x, S, S, 40, 'rgba(230,230,230,A)', R);
    return this.pair(r);
  },

  /* Blood: soaked-through patches, a collar of blood running down from the
   * neck, fine spray, and thin drips. Dark and wet, not cartoon-red. */
  bloodify(x, w, h, R, amt = 1, collar = true) {
    const reds = ['#7a0000', '#8f0606', '#5c0101', '#a00c0c', '#6a0303'];
    for (let i = 0; i < 4 * amt; i++) {           // soaked patches
      const cx = R() * w, cy = R() * h, r = 50 + R() * 110, g = x.createRadialGradient(cx, cy, r * 0.15, cx, cy, r);
      g.addColorStop(0, `rgba(120,0,0,${0.7 + R() * 0.25})`); g.addColorStop(0.7, 'rgba(100,0,0,0.35)'); g.addColorStop(1, 'rgba(90,0,0,0)');
      x.fillStyle = g; x.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
    if (collar) {                                  // blood pouring down from the neck
      const g = x.createLinearGradient(0, 0, 0, h * 0.4);
      g.addColorStop(0, 'rgba(110,0,0,0.95)'); g.addColorStop(0.5, 'rgba(100,0,0,0.55)'); g.addColorStop(1, 'rgba(90,0,0,0)');
      x.fillStyle = g; x.fillRect(0, 0, w, h * 0.4);
    }
    for (let i = 0; i < 18 * amt; i++) {          // fine spray around a few impact points
      const cx = R() * w, cy = R() * h;
      x.fillStyle = reds[(R() * reds.length) | 0];
      for (let k = 0; k < 40; k++) {
        const a = R() * 6.28, d = Math.pow(R(), 2) * 45, dr = 0.6 + R() * 2.4;
        x.globalAlpha = 0.6 + R() * 0.4; x.beginPath(); x.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d * 1.3, dr, 0, 7); x.fill();
      }
    }
    x.globalAlpha = 1; x.lineCap = 'round';
    for (let i = 0; i < 22 * amt; i++) {          // thin drips running down
      let px = R() * w, py = collar && R() < 0.6 ? R() * h * 0.25 : R() * h * 0.8;
      const len = 30 + R() * 260, wd = 1.2 + R() * 2.8;
      x.strokeStyle = reds[(R() * reds.length) | 0]; x.lineWidth = wd;
      x.beginPath(); x.moveTo(px, py);
      for (let t = 0; t < len; t += 10) { px += (R() - 0.5) * 2; py += 10; x.lineTo(px, py); }
      x.stroke();
      x.fillStyle = x.strokeStyle; x.beginPath(); x.ellipse(px, py + 2, wd * 0.9, wd * 1.5, 0, 0, 7); x.fill();
    }
  },

  /* Torn, bloodstained clothing. kind: blazer | singlet | shirt | trousers */
  cloth(kind, seed, gore = 1) {
    const S = 512, R = seeded(seed);
    const base = { blazer: [44, 88, 52], singlet: [196, 190, 172], shirt: [164, 182, 204], trousers: [38, 38, 44] }[kind];
    const r = this.pixels(S, S, (x, y, o) => {
      const weave = (x + y) % 4 < 2 ? 1 : 0.94, n = Noise.fbm(x / S * 8, y / S * 8, 4, 8), dirt = Noise.fbm(x / S * 3 + 9, y / S * 3, 3, 3);
      let c = base, k = (0.82 + n * 0.25 - dirt * 0.25) * weave;
      if (kind === 'blazer') { const sx = x % 26; if (sx === 9 || sx === 10) c = [104, 40, 40]; else if (sx === 13) c = [150, 146, 128]; }
      if (kind === 'singlet') k *= 0.92 + 0.08 * Math.sin(x * 1.3);
      o[0] = c[0] * k; o[1] = c[1] * k; o[2] = c[2] * k; o[3] = 140 + (weave - 0.97) * 600 + n * 40;
    });
    this.stains(r.x, S, S, 8, R, '40,30,20');
    // rips: dark torn holes with frayed edges
    for (let i = 0; i < 5; i++) {
      const cx = R() * S, cy = R() * S, rw = 10 + R() * 26;
      r.x.fillStyle = 'rgba(30,8,6,0.95)'; r.x.beginPath();
      for (let a = 0; a < 6.3; a += 0.4) { const rr = rw * (0.6 + R() * 0.6); r.x.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 1.6); }
      r.x.fill();
      r.bx.fillStyle = '#000'; r.bx.beginPath(); r.bx.arc(cx, cy, rw, 0, 7); r.bx.fill();
    }
    this.bloodify(r.x, S, S, R, gore, kind !== 'trousers');
    return this.pair(r);
  },

  /* Skin with bruises, cuts and smeared blood. */
  skin(hex, seed) {
    const S = 512, R = seeded(seed), c = hexRGB(hex);
    const r = this.pixels(S, S, (x, y, o) => {
      const n = Noise.fbm(x / S * 10, y / S * 10, 4, 10), m = Noise.fbm(x / S * 2 + 4, y / S * 2, 3, 2);
      let k = 0.88 + n * 0.2 - m * 0.12;
      if (hash2(x, y) > 0.97) k *= 0.9;
      o[0] = c[0] * k; o[1] = c[1] * k; o[2] = c[2] * k; o[3] = 150 + n * 60;
    });
    for (let i = 0; i < 6; i++) {                 // bruises
      const bx = R() * S, by = R() * S, br = 20 + R() * 40, g = r.x.createRadialGradient(bx, by, 0, bx, by, br);
      g.addColorStop(0, 'rgba(60,20,50,0.45)'); g.addColorStop(1, 'rgba(60,20,50,0)');
      r.x.fillStyle = g; r.x.fillRect(bx - br, by - br, br * 2, br * 2);
    }
    r.x.lineCap = 'round';
    for (let i = 0; i < 8; i++) {                 // cuts
      const cx = R() * S, cy = R() * S, a = R() * 3, l = 20 + R() * 50;
      r.x.strokeStyle = '#3a0202'; r.x.lineWidth = 3 + R() * 3;
      r.x.beginPath(); r.x.moveTo(cx, cy); r.x.lineTo(cx + Math.cos(a) * l, cy + Math.sin(a) * l); r.x.stroke();
      r.bx.strokeStyle = '#000'; r.bx.lineWidth = 4; r.bx.beginPath(); r.bx.moveTo(cx, cy); r.bx.lineTo(cx + Math.cos(a) * l, cy + Math.sin(a) * l); r.bx.stroke();
    }
    this.bloodify(r.x, S, S, R, 1.1, false);
    return this.pair(r);
  },

  /* Simple drawn signage (posters, exit sign, labels) */
  sign(w, h, draw) { const [c, x] = this.canvas(w, h); draw(x, w, h); return { map: this.tex(c), canvas: c }; },
};

function makeTextures() {
  const T = {};
  T.floor = TexGen.floor();
  T.block = TexGen.block('#b4bcc6');
  T.blockLow = TexGen.block('#3d5266');
  T.hallBlock = TexGen.block('#9aa4ae');
  T.storeBlock = TexGen.block('#8e8a7c');
  T.ceil = TexGen.ceiling();
  T.chalkL = TexGen.chalk([['Welcome back, Raoul :)', 60, 40, 54, -0.02], ['NIGHT  1  2  3  4  5', 70, 150, 44], ['||||  ||||  ||', 90, 220, 50],
    ['2 + 2 = RUN', 120, 320, 48, 0.03], ['homework due 6 AM', 520, 420, 36, -0.04]]);
  T.chalkR = TexGen.chalk([['HE IS IN THE LOCKER', 60, 50, 52, 0.02], ["DON'T TURN AROUND", 80, 150, 50, -0.03], ["Mr. Xavier's class", 460, 400, 40]],
    (x) => {   // crude chalk bear with a top hat
      x.lineWidth = 6; x.strokeStyle = 'rgba(235,238,228,0.85)';
      x.beginPath(); x.arc(270, 340, 70, 0, 7); x.stroke();
      x.beginPath(); x.arc(215, 280, 22, 0, 7); x.stroke(); x.beginPath(); x.arc(325, 280, 22, 0, 7); x.stroke();
      x.strokeRect(235, 200, 70, 60); x.beginPath(); x.moveTo(205, 262); x.lineTo(335, 262); x.stroke();
      x.fillStyle = 'rgba(235,238,228,0.9)'; x.beginPath(); x.arc(245, 330, 9, 0, 7); x.fill(); x.beginPath(); x.arc(295, 330, 9, 0, 7); x.fill();
      x.beginPath(); for (let i = 0; i < 6; i++) { x.moveTo(235 + i * 14, 370); x.lineTo(242 + i * 14, 388); x.lineTo(249 + i * 14, 370); } x.stroke();
    });
  T.supplyDoorL = TexGen.lockerDoor('#5d6b73', 'SUPPLIES');
  T.supplyDoorR = TexGen.lockerDoor('#5d6b73', '');
  T.supplyBody = TexGen.metal('#56636a', 81);
  T.hallLockerA = TexGen.hallLocker('#6e2a2a');
  T.hallLockerB = TexGen.hallLocker('#2c466e');
  T.door = TexGen.door();
  T.desk = TexGen.desk();
  T.cork = TexGen.cork();
  T.boxes = [TexGen.cardboard('ART SUPPLIES', 91), TexGen.cardboard('XMAS', 92), TexGen.cardboard('DO NOT OPEN', 93), TexGen.cardboard('TESTS 2019', 94)];
  T.metalDark = TexGen.metal('#5a5a5a', 95);
  T.shelf = TexGen.metal('#7a7d7f', 96);
  T.skin = {}; T.top = {};
  Object.entries(HUMANS).forEach(([id, H], i) => { T.skin[id] = TexGen.skin(H.skin, 100 + i); T.top[id] = H.top === 'bare' ? TexGen.skin(H.skin, 400 + i) : TexGen.cloth(H.top, 200 + i, 1.8); });
  T.pants = TexGen.cloth('trousers', 300, 0.6);
  T.exit = TexGen.sign(256, 96, (x, w, h) => {
    x.fillStyle = '#1a0606'; x.fillRect(0, 0, w, h); x.fillStyle = '#ff2a1a';
    x.font = 'bold 70px Arial'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('EXIT', w / 2, h / 2 + 4);
  });
  T.rules = TexGen.sign(256, 340, (x, w, h) => {
    x.fillStyle = '#d8d0b8'; x.fillRect(0, 0, w, h); x.fillStyle = '#7a1010'; x.font = 'bold 30px Georgia'; x.textAlign = 'center';
    x.fillText('CLASS RULES', w / 2, 44); x.fillStyle = '#222'; x.font = '19px Georgia'; x.textAlign = 'left';
    ['1. No running', '2. No screaming', '3. Stay in your seat', '4. Lights OFF at night', "5. DON'T LOOK BEHIND", '   YOU'].forEach((l, i) => x.fillText(l, 20, 96 + i * 38));
    x.fillStyle = 'rgba(80,30,10,0.25)'; x.fillRect(0, h - 70, w, 70);
  });
  T.mascot = TexGen.sign(256, 340, (x, w, h) => {
    x.fillStyle = '#b8a37a'; x.fillRect(0, 0, w, h);
    x.fillStyle = '#6b4a22'; x.beginPath(); x.arc(128, 150, 70, 0, 7); x.fill();
    x.beginPath(); x.arc(72, 95, 24, 0, 7); x.fill(); x.beginPath(); x.arc(184, 95, 24, 0, 7); x.fill();
    x.fillStyle = '#111'; x.fillRect(90, 40, 76, 50); x.fillRect(72, 86, 112, 10);
    x.fillStyle = '#000'; x.beginPath(); x.arc(104, 140, 11, 0, 7); x.fill(); x.beginPath(); x.arc(152, 140, 11, 0, 7); x.fill();
    x.fillStyle = '#c00'; x.beginPath(); x.arc(104, 140, 4, 0, 7); x.fill(); x.beginPath(); x.arc(152, 140, 4, 0, 7); x.fill();
    x.strokeStyle = '#000'; x.lineWidth = 4; x.beginPath(); x.arc(128, 168, 28, 0.2, Math.PI - 0.2); x.stroke();
    x.fillStyle = '#4a0d0d'; x.font = 'bold 34px Georgia'; x.textAlign = 'center'; x.fillText("XAVIER'S", 128, 270);
    x.font = '16px Georgia'; x.fillText('LEARNING CENTER', 128, 300);
  });
  T.posters = [];
  [['xavier', 'TEACHER OF THE MONTH', 'MR. XAVIER'], ['steven', 'HALL MONITOR', 'STEVEN PIVAC'], ['zynovan', 'SUPPLY MANAGER', 'ZYNOVAN SNUSVAC'], ['harry', 'CYCLIST OF THE YEAR', 'HAZZA'], ['kirk', 'WANTED: LEAKED', 'CROISSANT KIRK']].forEach(([id, title, name]) => {
    const img = Assets.img(`${id}/poster`);
    if (!img) return;
    T.posters.push(TexGen.sign(256, 340, (x, w, h) => {
      x.fillStyle = '#d8ccb0'; x.fillRect(0, 0, w, h);
      x.fillStyle = '#5a1018'; x.fillRect(0, 0, w, 52);
      x.fillStyle = '#f0d890'; x.font = 'bold 21px Georgia'; x.textAlign = 'center'; x.fillText(title, w / 2, 34);
      try { x.drawImage(gradePhoto(img, { w: 216, h: 216, feather: 0, vignette: 0.5 }), 20, 64); } catch (e) { /* tainted */ }
      x.strokeStyle = '#2a1a10'; x.lineWidth = 4; x.strokeRect(20, 64, 216, 216);
      x.fillStyle = '#2a1a10'; x.font = 'bold 22px Georgia'; x.fillText(name, w / 2, 314);
      x.fillStyle = 'rgba(60,20,5,0.18)'; x.fillRect(0, h - 40, w, 40);
    }));
  });
  T.paper = TexGen.sign(128, 160, (x, w, h) => {
    x.fillStyle = '#e8e6dc'; x.fillRect(0, 0, w, h); x.strokeStyle = 'rgba(80,110,190,0.5)';
    for (let i = 1; i < 14; i++) { x.beginPath(); x.moveTo(0, i * 11); x.lineTo(w, i * 11); x.stroke(); }
    x.strokeStyle = 'rgba(20,20,20,0.7)'; x.lineWidth = 1.5;
    for (let i = 1; i < 9; i++) { x.beginPath(); x.moveTo(10, i * 11 + 9); x.lineTo(10 + Math.random() * 100, i * 11 + 9); x.stroke(); }
  });
  T.clock = TexGen.sign(256, 256, (x, w) => {
    x.fillStyle = '#e8e4d8'; x.beginPath(); x.arc(128, 128, 124, 0, 7); x.fill();
    x.fillStyle = '#111'; x.font = 'bold 26px Arial'; x.textAlign = 'center'; x.textBaseline = 'middle';
    for (let i = 1; i <= 12; i++) { const a = (i / 12) * Math.PI * 2 - Math.PI / 2; x.fillText(String(i), 128 + Math.cos(a) * 96, 128 + Math.sin(a) * 96); }
    x.strokeStyle = '#111'; x.lineWidth = 7; x.beginPath(); x.moveTo(128, 128); x.lineTo(128, 62); x.stroke();
    x.lineWidth = 4; x.beginPath(); x.moveTo(128, 128); x.lineTo(186, 128); x.stroke();
  });
  T.wet = TexGen.sign(128, 192, (x, w, h) => {
    x.fillStyle = '#e8c21a'; x.fillRect(0, 0, w, h); x.fillStyle = '#111'; x.font = 'bold 20px Arial'; x.textAlign = 'center';
    x.fillText('CAUTION', w / 2, 40); x.font = 'bold 15px Arial'; x.fillText('WET FLOOR', w / 2, 160);
    x.beginPath(); x.arc(64, 95, 26, 0, 7); x.lineWidth = 5; x.strokeStyle = '#111'; x.stroke();
  });
  T.banner = TexGen.sign(512, 96, (x, w, h) => {
    x.fillStyle = '#5a1018'; x.fillRect(0, 0, w, h); x.fillStyle = '#e8c860'; x.font = 'bold 54px Impact, Arial'; x.textAlign = 'center';
    x.fillText("GO XAVIER'S!", w / 2, 68); x.clearRect(w - 60, 0, 60, 30);
  });
  T.snus = TexGen.sign(128, 128, (x) => {
    x.fillStyle = '#dfe8e2'; x.fillRect(0, 0, 128, 128); x.fillStyle = '#2a4a32'; x.beginPath(); x.arc(64, 64, 52, 0, 7); x.fill();
    x.fillStyle = '#dfe8e2'; x.font = 'bold 30px Arial'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('SNUS', 64, 66);
  });
  T.wire = TexGen.sign(128, 128, (x) => {
    x.fillStyle = '#080a0d'; x.fillRect(0, 0, 128, 128); x.strokeStyle = 'rgba(150,150,140,0.5)'; x.lineWidth = 1.5;
    for (let i = -128; i < 256; i += 16) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i + 128, 128); x.stroke(); x.beginPath(); x.moveTo(i + 128, 0); x.lineTo(i, 128); x.stroke(); }
  });
  T.label = TexGen.sign(128, 64, (x) => {
    x.fillStyle = '#c8c0a8'; x.fillRect(0, 0, 128, 64); x.fillStyle = '#7a1010'; x.fillRect(0, 20, 128, 24);
    x.fillStyle = '#eee'; x.font = 'bold 16px Arial'; x.textAlign = 'center'; x.fillText('PAINT', 64, 38);
  });
  return T;
}

/* ==========================================================================
 * 5. WORLD — classroom, hallway, storage closet
 *    Units are metres. The player stands in the classroom (x∈[-4,4], z∈[-5,5]).
 * ========================================================================== */
const WORLD = {
  classDoorZ: [-3.6, -2.6], doorTop: 2.1,
  cams: {
    center: { pos: [0, 1.55, 2.2],   look: [0, 1.4, -5] },
    left:   { pos: [-3.35, 1.55, -3.1], look: [-26, 1.45, -3.1] },
    right:  { pos: [3.35, 1.55, -3.1],  look: [9, 1.45, -3.1] },
    locker: { pos: [0, 1.55, -3.0],  look: [0, 1.35, -4.7] },
    desks:  { pos: [0, 1.55, 0.2],   look: [0, 1.25, 5] },
  },
  red: {   // deep-red emergency light source per view (world space)
    center: [0, 2.85, -4.9], locker: [0, 2.85, -4.9], left: [-25.85, 2.45, -3.1], right: [8.95, 2.3, -2.6], desks: [2.8, 2.75, 4.9],
  },
  listen: { center: [0, 0, -1], left: [-1, 0, 0], right: [1, 0, 0], locker: [0, 0, -1], desks: [0, 0, 1] },
};

function M(o = {}) {
  const m = new THREE.MeshStandardMaterial({
    color: o.color ?? 0xffffff, map: o.map || null, bumpMap: o.bump || null, bumpScale: o.bumpScale ?? 1.5,
    roughness: o.rough ?? 0.85, metalness: o.metal ?? 0, transparent: !!o.transparent,
    side: o.side ?? THREE.FrontSide,
  });
  m.userData.emissive = o.emissive || 0;
  m.userData.spec = o.spec ?? 0.12;
  return m;
}
function addMesh(geo, mat, parent, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
  m.castShadow = true; m.receiveShadow = true;
  parent.add(m); return m;
}
const BOX = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const CYL = (rt, rb, h, s = 16) => new THREE.CylinderGeometry(rt, rb, h, s);
const SPH = (r, w = 20, h = 14) => new THREE.SphereGeometry(r, w, h);
function texRepeat(t, rx, ry) { const c = t.clone(); c.repeat.set(rx, ry); c.needsUpdate = true; return c; }

/* A wall/floor quad whose UVs are in world metres so tiling stays consistent. */
function worldQuad(parent, mat, w, h, u0, v0, tileU, tileV, pos, rot) {
  const g = new THREE.PlaneGeometry(w, h), uv = g.attributes.uv, p = g.attributes.position;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (u0 + p.getX(i) + w / 2) / tileU, (v0 + p.getY(i) + h / 2) / tileV);
  const m = new THREE.Mesh(g, mat);
  m.position.set(...pos); m.rotation.set(...rot); m.receiveShadow = true; m.castShadow = true;
  parent.add(m); return m;
}

/* Box room with door openings; optional lower paint band (school wainscot). */
function buildRoom(parent, o) {
  const sides = {
    front: { ry: 0,            range: [o.x0, o.x1], pos: (s, y) => [s, y, o.z0] },
    back:  { ry: Math.PI,      range: [o.x0, o.x1], pos: (s, y) => [s, y, o.z1] },
    left:  { ry: Math.PI / 2,  range: [o.z0, o.z1], pos: (s, y) => [o.x0, y, s] },
    right: { ry: -Math.PI / 2, range: [o.z0, o.z1], pos: (s, y) => [o.x1, y, s] },
  };
  const tile = o.tile || 0.8;
  for (const [name, sd] of Object.entries(sides)) {
    if (o.skip && o.skip.includes(name)) continue;
    const ops = ((o.openings && o.openings[name]) || []).slice().sort((a, b) => a.a - b.a);
    const cuts = [sd.range[0]];
    ops.forEach((op) => cuts.push(op.a, op.b));
    cuts.push(sd.range[1]);
    const bands = o.low ? [[0, o.lowH, o.low], [o.lowH, o.h, o.wall]] : [[0, o.h, o.wall]];
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i], b = cuts[i + 1];
      if (b - a < 0.001) continue;
      const op = i % 2 === 1 ? ops[(i - 1) / 2] : null;
      for (const [y0, y1, mat] of bands) {
        const yy0 = op ? Math.max(y0, op.top) : y0;
        if (yy0 >= y1) continue;
        worldQuad(parent, mat, b - a, y1 - yy0, a, yy0, tile, tile, sd.pos((a + b) / 2, (yy0 + y1) / 2), [0, sd.ry, 0]);
      }
    }
  }
  const w = o.x1 - o.x0, d = o.z1 - o.z0, cx = (o.x0 + o.x1) / 2, cz = (o.z0 + o.z1) / 2;
  worldQuad(parent, o.floor, w, d, o.x0, o.z0, 1.2, 1.2, [cx, 0, cz], [-Math.PI / 2, 0, 0]);
  worldQuad(parent, o.ceil, w, d, o.x0, o.z0, 1.2, 1.2, [cx, o.h, cz], [Math.PI / 2, 0, 0]);
  // baseboard
  if (o.base) {
    addMesh(BOX(w, 0.1, 0.02), o.base, parent, cx, 0.05, o.z0 + 0.01);
    addMesh(BOX(w, 0.1, 0.02), o.base, parent, cx, 0.05, o.z1 - 0.01);
  }
}

/* Classroom door: hinge at z=-3.6. side=-1 (left wall, x=-4) or +1 (right wall). */
function buildClassDoor(parent, side, T, mats) {
  const pivot = new THREE.Group();
  pivot.position.set(side * 3.985, 0, WORLD.classDoorZ[0] + 0.01);
  const doorM = M({ map: T.door.map, bump: T.door.bump, bumpScale: 1, rough: 0.6, spec: 0.25 });
  const slab = addMesh(BOX(0.045, 2.06, 0.96), [doorM, doorM, mats.frame, mats.frame, mats.frame, mats.frame], pivot, 0, 1.03, 0.48);
  slab.name = 'slab';
  const glassM = M({ map: T.wire.map, color: 0xffffff, rough: 0.08, spec: 1.0 });
  for (const s of [-1, 1]) {
    addMesh(new THREE.PlaneGeometry(0.52, 0.62), glassM, pivot, s * 0.024, 1.46, 0.48, 0, s * Math.PI / 2, 0);
    addMesh(CYL(0.012, 0.012, 0.13, 8), mats.chrome, pivot, s * 0.06, 1.0, 0.86, 0, 0, Math.PI / 2);
    addMesh(BOX(0.025, 0.025, 0.14), mats.chrome, pivot, s * 0.12, 1.0, 0.8);
  }
  parent.add(pivot);
  return pivot;
}
function setClassDoor(pivot, side, deg) { pivot.rotation.y = -side * (deg * Math.PI / 180); }

function doorFrame(parent, xWall, side, mats) {
  const [a, b] = WORLD.classDoorZ, top = WORLD.doorTop, xc = xWall + side * 0.075;
  addMesh(BOX(0.22, top + 0.08, 0.07), mats.frame, parent, xc, (top + 0.08) / 2, a - 0.035);
  addMesh(BOX(0.22, top + 0.08, 0.07), mats.frame, parent, xc, (top + 0.08) / 2, b + 0.035);
  addMesh(BOX(0.22, 0.08, b - a + 0.14), mats.frame, parent, xc, top + 0.04, (a + b) / 2);
}

/* The central supply locker (FNAF 4's closet). */
function buildSupplyLocker(parent, T, mats) {
  const g = new THREE.Group(); g.position.set(0, 0, -4.72); parent.add(g);
  const W = 1.3, H = 2.15, D = 0.55, t = 0.025;
  const body = M({ map: T.supplyBody.map, bump: T.supplyBody.bump, bumpScale: 1, rough: 0.55, metal: 0.25, spec: 0.5 });
  const inner = M({ map: T.supplyBody.map, color: 0x3a3a3a, rough: 0.8, spec: 0.2 });
  addMesh(BOX(W, H, t), inner, g, 0, H / 2, -D / 2 + t / 2);
  addMesh(BOX(t, H, D), body, g, -W / 2 + t / 2, H / 2, 0); addMesh(BOX(t, H, D), body, g, W / 2 - t / 2, H / 2, 0);
  addMesh(BOX(W, t, D), body, g, 0, H - t / 2, 0);
  addMesh(BOX(W, 0.09, D), mats.metalDark, g, 0, 0.045, 0);
  addMesh(BOX(W - 0.06, 0.02, D - 0.06), inner, g, 0, 1.86, 0);                 // shelf
  addMesh(BOX(0.12, 0.12, 0.3), M({ map: T.boxes[0].map }), g, -0.42, 1.93, -0.05);
  addMesh(CYL(0.06, 0.06, 0.14), M({ map: T.label.map, rough: 0.4, spec: 0.4 }), g, 0.4, 1.94, 0);
  for (const s of [-1, 1]) addMesh(CYL(0.008, 0.008, 0.08, 6), mats.chrome, g, s * 0.4, 1.7, -0.2, Math.PI / 2, 0, 0);   // hooks
  // label plate above doors
  const plate = TexGen.sign(256, 48, (x, w, h) => { x.fillStyle = '#b8b2a0'; x.fillRect(0, 0, w, h); x.fillStyle = '#222'; x.font = 'bold 30px Arial'; x.textAlign = 'center'; x.fillText('SUPPLIES — STAFF ONLY', w / 2, 36); });
  addMesh(new THREE.PlaneGeometry(0.6, 0.08), M({ map: plate.map, rough: 0.5 }), g, 0, H + 0.06, D / 2 + 0.001);
  // doors
  const doors = [];
  for (const s of [-1, 1]) {
    const pivot = new THREE.Group(); pivot.position.set(s * W / 2, 0.1, D / 2); g.add(pivot);
    const front = M({ map: (s < 0 ? T.supplyDoorL : T.supplyDoorR).map, bump: (s < 0 ? T.supplyDoorL : T.supplyDoorR).bump, bumpScale: 1.5, rough: 0.5, metal: 0.25, spec: 0.55 });
    addMesh(BOX(0.64, H - 0.14, 0.022), [body, body, body, body, front, inner], pivot, -s * 0.32, (H - 0.14) / 2, 0.011);
    addMesh(BOX(0.03, 0.22, 0.03), mats.chrome, pivot, -s * 0.58, 1.0, 0.04);
    if (s > 0) {   // hanging open padlock
      addMesh(BOX(0.05, 0.06, 0.02), mats.brass, pivot, -s * 0.58, 0.82, 0.06);
      addMesh(new THREE.TorusGeometry(0.02, 0.005, 6, 12, Math.PI), mats.chrome, pivot, -s * 0.58, 0.86, 0.06);
    }
    doors.push(pivot);
  }
  return { group: g, doors };
}
function setLockerDoors(L, deg) {
  const a = deg * Math.PI / 180;
  L.doors[0].rotation.y = -a; L.doors[1].rotation.y = a;
}

function buildDesk(parent, T, mats, x, z, ry = 0, tipped = false) {
  const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = ry; parent.add(g);
  const top = M({ map: T.desk.map, bump: T.desk.bump, bumpScale: 0.8, rough: 0.45, spec: 0.35 });
  addMesh(BOX(0.66, 0.03, 0.48), [mats.plastic, mats.plastic, top, mats.plastic, mats.plastic, mats.plastic], g, 0, 0.74, 0);
  for (const [lx, lz] of [[-0.28, -0.2], [0.28, -0.2], [-0.28, 0.2], [0.28, 0.2]]) addMesh(CYL(0.014, 0.014, 0.73, 8), mats.chrome, g, lx, 0.365, lz);
  addMesh(BOX(0.56, 0.12, 0.36), mats.wireBasket, g, 0, 0.6, 0);
  // chair
  const chair = new THREE.Group(); chair.position.set(0, 0, -0.5); g.add(chair);
  addMesh(BOX(0.42, 0.03, 0.4), mats.chair, chair, 0, 0.44, 0);
  addMesh(BOX(0.42, 0.3, 0.03), mats.chair, chair, 0, 0.72, -0.2, -0.1, 0, 0);
  for (const [lx, lz] of [[-0.18, -0.16], [0.18, -0.16], [-0.18, 0.16], [0.18, 0.16]]) addMesh(CYL(0.012, 0.012, 0.44, 6), mats.chrome, chair, lx, 0.22, lz);
  if (tipped) { g.rotation.z = 1.45; g.position.y = 0.36; }
  return g;
}

function buildShelfUnit(parent, T, mats, x, z, w, d, h, ry, R) {
  const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = ry; parent.add(g);
  const steel = M({ map: T.shelf.map, bump: T.shelf.bump, bumpScale: 0.6, rough: 0.5, metal: 0.4, spec: 0.5 });
  for (const sx of [-w / 2, w / 2]) for (const sz of [-d / 2, d / 2]) addMesh(BOX(0.035, h, 0.035), steel, g, sx, h / 2, sz);
  const levels = 4;
  for (let l = 0; l < levels; l++) {
    const y = 0.12 + l * (h - 0.2) / (levels - 1);
    addMesh(BOX(w, 0.025, d), steel, g, 0, y, 0);
    let cx = -w / 2 + 0.06;
    while (cx < w / 2 - 0.15) {
      const bw = 0.2 + R() * 0.3, bh = Math.min(0.12 + R() * 0.3, (h - 0.2) / (levels - 1) - 0.05), bd = d * (0.6 + R() * 0.35);
      if (cx + bw > w / 2 - 0.04) break;
      if (R() < 0.75) {
        const bt = T.boxes[(R() * T.boxes.length) | 0];
        addMesh(BOX(bw, bh, bd), M({ map: bt.map, bump: bt.bump, bumpScale: 0.5, rough: 0.95 }), g, cx + bw / 2, y + 0.0125 + bh / 2, (R() - 0.5) * 0.05, 0, (R() - 0.5) * 0.15, 0);
      } else {
        for (let k = 0; k < 2; k++) addMesh(CYL(0.08, 0.08, 0.18), M({ map: T.label.map, rough: 0.4, metal: 0.3, spec: 0.5 }), g, cx + 0.09 + k * 0.17, y + 0.1, 0);
      }
      cx += bw + 0.03;
    }
  }
  return g;
}

function buildWorld(T) {
  const world = new THREE.Group();
  const R = seeded(2024);
  const mats = {
    frame: M({ map: T.metalDark.map, color: 0x6a5a48, rough: 0.6, spec: 0.3 }),
    chrome: M({ color: 0xb0b0b0, rough: 0.3, metal: 0.7, spec: 0.9 }),
    brass: M({ color: 0xa08040, rough: 0.35, metal: 0.6, spec: 0.8 }),
    metalDark: M({ map: T.metalDark.map, bump: T.metalDark.bump, rough: 0.6, metal: 0.3 }),
    plastic: M({ color: 0x3a3632, rough: 0.6 }),
    chair: M({ color: 0x8a4a22, rough: 0.5, spec: 0.35 }),
    wireBasket: M({ color: 0x2a2a2a, rough: 0.5, metal: 0.4 }),
    base: M({ color: 0x1e1a18, rough: 0.6 }),
  };
  const wallM = M({ map: T.block.map, bump: T.block.bump, bumpScale: 2, rough: 0.92 });
  const lowM = M({ map: T.blockLow.map, bump: T.blockLow.bump, bumpScale: 2, rough: 0.7, spec: 0.25 });
  const floorM = M({ map: T.floor.map, bump: T.floor.bump, bumpScale: 1, rough: 0.5, spec: 0.35 });
  const ceilM = M({ map: T.ceil.map, bump: T.ceil.bump, bumpScale: 1.5, rough: 1 });
  const op = [{ a: WORLD.classDoorZ[0], b: WORLD.classDoorZ[1], top: WORLD.doorTop }];

  /* ---------- CLASSROOM ---------- */
  buildRoom(world, { x0: -4, x1: 4, z0: -5, z1: 5, h: 3.2, wall: wallM, low: lowM, lowH: 1.0, floor: floorM, ceil: ceilM, base: mats.base,
    openings: { left: op, right: op } });
  doorFrame(world, -4, -1, mats); doorFrame(world, 4, 1, mats);
  const doorL = buildClassDoor(world, -1, T, mats), doorR = buildClassDoor(world, 1, T, mats);
  const locker = buildSupplyLocker(world, T, mats);

  // chalkboards flanking the locker
  const alu = M({ color: 0x9a9a96, rough: 0.35, metal: 0.6, spec: 0.7 });
  [[-2.3, T.chalkL], [2.3, T.chalkR]].forEach(([cx, tx]) => {
    addMesh(new THREE.PlaneGeometry(2.55, 1.2), M({ map: tx.map, bump: tx.bump, bumpScale: 0.6, rough: 0.95, spec: 0.05 }), world, cx, 1.55, -4.985);
    addMesh(BOX(2.65, 0.05, 0.04), alu, world, cx, 2.17, -4.97); addMesh(BOX(2.65, 0.05, 0.04), alu, world, cx, 0.93, -4.97);
    addMesh(BOX(0.05, 1.3, 0.04), alu, world, cx - 1.31, 1.55, -4.97); addMesh(BOX(0.05, 1.3, 0.04), alu, world, cx + 1.31, 1.55, -4.97);
    addMesh(BOX(2.6, 0.03, 0.09), alu, world, cx, 0.92, -4.94);   // chalk tray
  });
  // red emergency light above the locker
  addMesh(BOX(0.36, 0.14, 0.12), mats.metalDark, world, 0, 2.85, -4.94);
  addMesh(BOX(0.28, 0.08, 0.02), M({ color: 0xff2010, emissive: 1, rough: 0.3 }), world, 0, 2.85, -4.875);
  // clock + PA speaker
  addMesh(new THREE.CircleGeometry(0.2, 32), M({ map: T.clock.map, rough: 0.3, spec: 0.6 }), world, -2.3, 2.62, -4.975);
  addMesh(BOX(0.4, 0.4, 0.08), M({ color: 0x8a8678, rough: 0.6 }), world, 2.3, 2.62, -4.96);
  // posters on the side walls
  addMesh(new THREE.PlaneGeometry(0.42, 0.56), M({ map: T.rules.map, rough: 0.9 }), world, 0.42, 1.95, 4.985, 0, Math.PI, 0);
  T.posters.forEach((pt, i) => {   // photo posters: back wall first, then the side walls near the front
    const spots = [[-1.1, 1.95, 4.985], [-0.6, 1.95, 4.985], [-0.1, 1.95, 4.985], [1.75, 1.7, 4.97], [2.6, 1.72, 4.97]];   // last two are pinned to the cork board
    if (!spots[i]) return;
    const [px, py, pz] = spots[i];
    addMesh(new THREE.PlaneGeometry(0.42, 0.56), M({ map: pt.map, rough: 0.6, spec: 0.35 }), world, px, py, pz, 0, Math.PI, 0);
  });
  addMesh(new THREE.PlaneGeometry(0.62, 0.82), M({ map: T.mascot.map, rough: 0.9 }), world, 3.985, 1.75, -0.8, 0, -Math.PI / 2, 0);
  // fluorescent troffers (off), one hanging loose
  const troffer = M({ color: 0x8a8a86, rough: 0.4, spec: 0.6 });
  [[-1.8, -2], [1.8, -2], [-1.8, 2], [1.8, 2]].forEach(([tx, tz], i) => {
    const m = addMesh(BOX(1.2, 0.06, 0.6), troffer, world, tx, 3.17, tz);
    if (i === 3) { m.position.y = 2.85; m.rotation.set(0.5, 0, 0.25); }
  });
  // trash can, papers on the floor
  addMesh(CYL(0.18, 0.15, 0.45, 16), mats.metalDark, world, -3.4, 0.225, -4.4);
  const paperM = M({ map: T.paper.map, rough: 0.9, side: THREE.DoubleSide });
  for (let i = 0; i < 14; i++) addMesh(new THREE.PlaneGeometry(0.21, 0.28), paperM, world, (R() - 0.5) * 6.5, 0.003 + i * 0.0005, -3.5 + R() * 8, -Math.PI / 2, 0, R() * 6);

  // back of the classroom: desk cluster, podium, window, bulletin board
  const desks = [[-1.6, 2.4, 0.05], [0, 2.4, -0.04], [1.6, 2.4, 0.12], [-1.6, 3.5, -0.1], [1.6, 3.5, 0.3]];
  desks.forEach(([dx, dz, ry]) => buildDesk(world, T, mats, dx, dz, Math.PI + ry));
  buildDesk(world, T, mats, 0.2, 3.6, 2.6, true);              // knocked over
  const podium = new THREE.Group(); podium.position.set(0, 0, 4.35); world.add(podium);
  const oak = M({ map: T.door.map, bump: T.door.bump, bumpScale: 0.8, rough: 0.55, spec: 0.3 });
  addMesh(BOX(0.7, 1.05, 0.5), oak, podium, 0, 0.525, 0);
  addMesh(BOX(0.8, 0.04, 0.6), oak, podium, 0, 1.12, -0.02, -0.28, 0, 0);
  const plaque = TexGen.sign(256, 64, (x, w, h) => { x.fillStyle = '#a08040'; x.fillRect(0, 0, w, h); x.fillStyle = '#2a1a05'; x.font = 'bold 34px Georgia'; x.textAlign = 'center'; x.fillText("MR. XAVIER", w / 2, 44); });
  addMesh(new THREE.PlaneGeometry(0.4, 0.1), M({ map: plaque.map, rough: 0.35, metal: 0.5, spec: 0.8 }), podium, 0, 0.8, -0.252, 0, Math.PI, 0);
  // window with blinds (faint moonlight glow is emissive)
  addMesh(BOX(2.3, 1.5, 0.06), mats.frame, world, -2.5, 1.75, 4.98);
  addMesh(new THREE.PlaneGeometry(2.15, 1.35), M({ color: 0x5a7ab8, emissive: 0.32, rough: 0.1 }), world, -2.5, 1.75, 4.945, 0, Math.PI, 0);
  const slat = M({ color: 0xb8b4a8, rough: 0.6, spec: 0.3 });
  for (let i = 0; i < 13; i++) addMesh(BOX(2.15, 0.012, 0.07), slat, world, -2.5, 1.12 + i * 0.105, 4.9, 0.55, 0, i === 9 ? 0.15 : 0);
  addMesh(new THREE.PlaneGeometry(2.4, 1.1), M({ map: T.cork.map, bump: T.cork.bump, bumpScale: 0.8, rough: 0.95 }), world, 2.2, 1.65, 4.985, 0, Math.PI, 0);
  addMesh(BOX(0.18, 0.12, 0.08), M({ color: 0xff1a10, emissive: 0.9, rough: 0.3 }), world, 2.8, 2.75, 4.95);
  addMesh(new THREE.CircleGeometry(0.2, 32), M({ map: T.clock.map, rough: 0.3, spec: 0.6 }), world, 0, 2.7, 4.975, 0, Math.PI, 0);
  // backpack slumped by a desk
  addMesh(BOX(0.32, 0.4, 0.2), M({ color: 0x2a3a5a, rough: 0.9 }), world, 1.1, 0.2, 1.8, 0.2, 0.5, 0.1);

  /* ---------- HALLWAY (beyond the left door) ---------- */
  const hallWall = M({ map: T.hallBlock.map, bump: T.hallBlock.bump, bumpScale: 2, rough: 0.9 });
  buildRoom(world, { x0: -26, x1: -4.15, z0: -4.4, z1: -1.8, h: 3.0, wall: hallWall, floor: floorM, ceil: ceilM, base: mats.base,
    openings: { right: op } });
  const lockerSide = M({ map: T.metalDark.map, rough: 0.6, metal: 0.3 });
  [[-4.4, 0, T.hallLockerA], [-1.8, Math.PI, T.hallLockerB]].forEach(([wz, ry, lt]) => {
    [[-24.8, -15.6], [-14.2, -5.2]].forEach(([a, b]) => {
      const len = b - a, front = M({ map: texRepeat(lt.map, len / 0.38, 1), bump: texRepeat(lt.bump, len / 0.38, 1), bumpScale: 1.5, rough: 0.5, metal: 0.25, spec: 0.5 });
      const g = addMesh(BOX(len, 1.85, 0.36), [lockerSide, lockerSide, lockerSide, lockerSide, front, lockerSide], world, (a + b) / 2, 0.1 + 0.925, wz + (ry ? -0.18 : 0.18), 0, ry, 0);
      g.userData.hall = true;
      addMesh(BOX(len, 0.1, 0.36), mats.base, world, (a + b) / 2, 0.05, wz + (ry ? -0.18 : 0.18));
    });
    // a closed classroom door in the gap
    addMesh(BOX(0.96, 2.06, 0.05), [mats.frame, mats.frame, mats.frame, mats.frame, M({ map: T.door.map, bump: T.door.bump, rough: 0.6 }), mats.frame], world, -14.9, 1.03, wz + (ry ? -0.03 : 0.03), 0, ry, 0);
  });
  // far end: exit doors + EXIT sign (red light source for this view)
  for (const dz of [-3.45, -2.75]) {
    addMesh(BOX(0.06, 2.1, 0.68), mats.frame, world, -25.96, 1.05, dz);
    addMesh(BOX(0.04, 0.05, 0.55), mats.chrome, world, -25.9, 1.0, dz);
  }
  addMesh(BOX(0.08, 0.2, 0.5), M({ map: T.exit.map, emissive: 1, rough: 0.3 }), world, -25.92, 2.45, -3.1);
  [-22, -18, -14, -10, -6.5].forEach((tx) => addMesh(BOX(0.6, 0.05, 1.2), troffer, world, tx, 2.97, -3.1));
  // wet floor sign, banner, fire extinguisher cabinet, water fountain
  const wet = M({ map: T.wet.map, rough: 0.5, side: THREE.DoubleSide });
  addMesh(new THREE.PlaneGeometry(0.3, 0.6), wet, world, -11, 0.29, -2.45, -0.18, Math.PI / 2 + 0.3, 0);
  addMesh(new THREE.PlaneGeometry(0.3, 0.6), wet, world, -11.12, 0.29, -2.38, 0.18, Math.PI / 2 + 0.3, 0);
  addMesh(new THREE.PlaneGeometry(2.2, 0.42), M({ map: T.banner.map, rough: 0.9, side: THREE.DoubleSide }), world, -10, 2.35, -4.385, 0, 0, 0.03);
  addMesh(BOX(0.4, 0.6, 0.15), M({ color: 0x8a1010, rough: 0.4, spec: 0.5 }), world, -4.85, 1.4, -1.88);

  /* ---------- STORAGE CLOSET (beyond the right door) ---------- */
  const storeWall = M({ map: T.storeBlock.map, bump: T.storeBlock.bump, bumpScale: 2, rough: 0.9 });
  buildRoom(world, { x0: 4.15, x1: 9, z0: -5, z1: -1.2, h: 2.8, wall: storeWall, floor: floorM, ceil: ceilM, base: mats.base,
    openings: { left: op } });
  buildShelfUnit(world, T, mats, 5.6, -4.68, 1.7, 0.55, 2.1, 0, R);
  buildShelfUnit(world, T, mats, 7.5, -4.68, 1.7, 0.55, 2.1, 0, R);
  buildShelfUnit(world, T, mats, 7.0, -1.5, 1.8, 0.5, 2.0, Math.PI, R);
  buildShelfUnit(world, T, mats, 8.7, -3.15, 1.3, 0.5, 2.2, -Math.PI / 2, R);
  const bucket = M({ color: 0xc8a018, rough: 0.5, spec: 0.4 });
  addMesh(CYL(0.2, 0.17, 0.32, 18), bucket, world, 5.2, 0.16, -1.75);
  addMesh(CYL(0.012, 0.012, 1.3, 6), M({ color: 0x8a6a40 }), world, 5.25, 0.75, -1.72, 0.15, 0, 0.1);
  addMesh(BOX(0.6, 0.8, 0.5), mats.metalDark, world, 7.9, 0.4, -2.2);               // AV cart
  addMesh(BOX(0.5, 0.42, 0.45), M({ color: 0x2a2a28, rough: 0.5 }), world, 7.9, 1.01, -2.2);
  addMesh(new THREE.PlaneGeometry(0.38, 0.3), M({ color: 0x1a2622, emissive: 0.08, rough: 0.1, spec: 0.9 }), world, 7.65, 1.03, -2.2, 0, -Math.PI / 2, 0);
  addMesh(CYL(0.004, 0.004, 0.35, 4), M({ color: 0x111111 }), world, 6.5, 2.62, -3.1);
  addMesh(SPH(0.05), M({ color: 0xd8d0b0, rough: 0.2, spec: 0.8 }), world, 6.5, 2.42, -3.1);
  addMesh(BOX(0.06, 0.12, 0.14), M({ color: 0xff2010, emissive: 1, rough: 0.3 }), world, 8.96, 2.3, -2.6);

  world.traverse((o) => { if (o.isMesh) o.userData.world = true; });
  return { world, doorL, doorR, locker, mats };
}

/* ==========================================================================
 * 6. VILLAINS — bloodied human bodies; the face photo is pasted on the head.
 * ========================================================================== */
/* Each villain is a bloodied human in what they were wearing; the face photo is
 * pasted on the front of the head. */
const HUMANS = {
  xavier:  { skin: '#5e3b26', hair: '#3a2414', top: 'blazer',  sleeves: true,  tie: true },
  steven:  { skin: '#c39478', hair: '#6a645c', top: 'singlet', sleeves: false, tie: false },
  zynovan: { skin: '#d8ae94', hair: '#2a1e16', top: 'shirt',   sleeves: true,  tie: false },
  harry:   { skin: '#e2a88e', hair: '#5a3c26', top: 'blazer',  sleeves: true,  tie: true, bike: true },
  kirk:    { skin: '#e6b48e', hair: '#c9a15e', top: 'bare',    sleeves: false, tie: false, croissant: true },
};

/* A tube between two points (bicycle frame, spokes). */
function tube(parent, a, b, r, mat) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = B.clone().sub(A);
  const m = addMesh(new THREE.CylinderGeometry(r, r, d.length(), 8), mat, parent);
  m.position.copy(A).add(B).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  return m;
}
/* Hazza became his bicycle: wheels where his legs were, the frame through his hips. */
function buildBicycle(g, blood) {
  const frame = M({ color: 0x1e3a6e, rough: 0.35, metal: 0.5, spec: 0.7 });
  const steel = M({ color: 0x9a9a9a, rough: 0.3, metal: 0.8, spec: 0.9 });
  const tyre = M({ color: 0x111111, rough: 0.8 });
  const R = 0.33;
  for (const z of [-0.5, 0.52]) {
    const w = addMesh(new THREE.TorusGeometry(R, 0.028, 10, 40), tyre, g, 0, R + 0.03, z, 0, Math.PI / 2, 0);
    addMesh(new THREE.TorusGeometry(R - 0.03, 0.01, 6, 40), steel, g, 0, R + 0.03, z, 0, Math.PI / 2, 0);
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      tube(g, [0, R + 0.03, z], [0, R + 0.03 + Math.sin(a) * (R - 0.03), z + Math.cos(a) * (R - 0.03)], 0.003, steel);
    }
    addMesh(new THREE.CylinderGeometry(0.03, 0.03, 0.08, 12), steel, g, 0, R + 0.03, z, 0, 0, Math.PI / 2);
    w.castShadow = true;
  }
  const hub = [0, R + 0.03], seat = [0, 0.86, -0.12], head = [0, 0.9, 0.42], bb = [0, 0.32, 0];
  tube(g, [0, hub[1], -0.5], [0, bb[1], bb[2]], 0.016, frame);        // chain stay
  tube(g, [0, hub[1], -0.5], [0, seat[1] - 0.04, seat[2]], 0.014, frame);   // seat stay
  tube(g, [0, bb[1], bb[2]], [0, seat[1], seat[2]], 0.02, frame);     // seat tube (through his hips)
  tube(g, [0, bb[1], bb[2]], [0, head[1] - 0.08, head[2]], 0.024, frame);   // down tube
  tube(g, [0, seat[1] - 0.04, seat[2]], [0, head[1], head[2]], 0.02, frame);   // top tube
  tube(g, [0, head[1] + 0.1, head[2] + 0.02], [0, hub[1], 0.52], 0.016, steel); // fork
  tube(g, [-0.27, 1.0, 0.44], [0.27, 1.0, 0.44], 0.014, steel);        // handlebars
  tube(g, [0, head[1], head[2]], [0, 1.0, 0.44], 0.016, steel);        // stem
  addMesh(new THREE.TorusGeometry(0.1, 0.012, 6, 20), steel, g, 0.05, bb[1], bb[2], 0, Math.PI / 2, 0);   // chainring
  for (const z of [-0.2, 0.2, 0.45]) addMesh(SPH(0.03, 8, 6), blood, g, 0.02, 0.6 + z * 0.3, z).scale.set(0.6, 1.8, 1.2);   // blood on the frame
}

/* The pasted-on face photo: unlit, so it shows at full colour in the beam —
 * but not emissive, so it is invisible in the dark (no free hints). */
function faceMaterial(tex) {
  const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide });
  m.userData.emissive = 0; m.userData.spec = 0;
  return m;
}

/* Body-part geometry, rotated so the texture seam faces backwards. */
const LIMB = (rTop, rBot, len) => new THREE.CylinderGeometry(rTop, rBot, len, 18, 1).rotateY(Math.PI);
const JOINT = (r) => new THREE.SphereGeometry(r, 16, 12).rotateY(Math.PI);
function torsoGeometry() {   // hips → waist → chest → sloped shoulders → neck base
  const pts = [[0.001, -0.02], [0.15, 0.0], [0.155, 0.08], [0.14, 0.2], [0.165, 0.34], [0.19, 0.48], [0.195, 0.56], [0.17, 0.64], [0.11, 0.7], [0.06, 0.73], [0.001, 0.735]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  return new THREE.LatheGeometry(pts, 32).rotateY(Math.PI);
}

function buildHuman(id, T, faceTex) {
  const H = HUMANS[id], g = new THREE.Group(); g.userData.id = id;
  const skin = M({ map: T.skin[id].map, bump: T.skin[id].bump, bumpScale: 0.8, rough: 0.85, spec: 0.08 });
  const top = M({ map: T.top[id].map, bump: T.top[id].bump, bumpScale: 1, rough: 0.85, spec: 0.1 });
  const pants = M({ map: T.pants.map, bump: T.pants.bump, bumpScale: 1, rough: 0.9 });
  const shoe = M({ color: 0x121010, rough: 0.4, spec: 0.5 });
  const blood = M({ color: 0x7a0000, rough: 0.2, spec: 0.9 });            // wet, glossy blood
  const hair = M({ color: H.hair, rough: 0.95, spec: 0.05 });
  const sleeve = H.sleeves ? top : skin;

  // legs (or, for Hazza, a bicycle)
  const hips = new THREE.Group(); hips.position.y = 0.92; g.add(hips);
  addMesh(JOINT(0.17), pants, hips, 0, -0.02, 0).scale.set(1.25, 0.7, 0.8);
  if (H.bike) buildBicycle(g, blood);
  for (const s of (H.bike ? [] : [-1, 1])) {
    const leg = new THREE.Group(); leg.position.set(s * 0.11, 0, 0); hips.add(leg);
    addMesh(LIMB(0.095, 0.068, 0.44), pants, leg, 0, -0.22, 0);
    addMesh(JOINT(0.068), pants, leg, 0, -0.44, 0);
    addMesh(LIMB(0.068, 0.048, 0.42), pants, leg, 0, -0.65, 0);
    addMesh(BOX(0.11, 0.08, 0.27), shoe, leg, 0, -0.88, 0.05);
  }
  // torso
  const torso = new THREE.Group(); torso.position.y = 0.92; g.add(torso);
  const rz = 0.19 * 0.72;
  addMesh(torsoGeometry(), top, torso, 0, 0.02, 0).scale.set(1.3, 1, 0.72);
  if (H.tie) {   // school shirt collar + tie under the blazer
    addMesh(BOX(0.13, 0.06, 0.02), M({ color: 0xb8b0a4, rough: 0.8 }), torso, 0, 0.68, rz - 0.01);
    addMesh(BOX(0.05, 0.32, 0.012), M({ color: 0x5a0c16, rough: 0.6 }), torso, 0, 0.52, rz + 0.004);
  }
  addMesh(LIMB(0.06, 0.07, 0.16), skin, torso, 0, 0.78, 0);    // neck

  // head: hair-coloured skull behind the pasted face photo
  const head = new THREE.Group(); head.position.set(0, 0.93, 0); torso.add(head);
  addMesh(SPH(0.19, 28, 22), hair, head).scale.set(1, 1.12, 1);
  for (const s of [-1, 1]) addMesh(SPH(0.04, 10, 8), skin, head, s * 0.19, -0.02, 0).scale.set(0.5, 1, 0.8);
  if (H.bike) {   // cracked cycling helmet
    const shell = M({ color: 0xb01818, rough: 0.35, spec: 0.7 });
    addMesh(new THREE.SphereGeometry(0.225, 24, 14, 0, Math.PI * 2, 0, Math.PI / 2.1), shell, head, 0, 0.06, -0.03).scale.set(1, 0.85, 1.2);
    for (let k = -2; k <= 2; k++) addMesh(BOX(0.025, 0.02, 0.36), M({ color: 0x111111 }), head, k * 0.07, 0.25 - Math.abs(k) * 0.03, -0.03);
  }
  if (faceTex) {
    const plate = addMesh(new THREE.PlaneGeometry(0.5, 0.5), faceMaterial(faceTex), head, 0, -0.01, 0.2);
    plate.castShadow = false; head.userData.facePlate = plate;
  } else {      // fallback face: hollow eyes and a bloody mouth
    addMesh(SPH(0.17, 24, 16), skin, head, 0, -0.02, 0.05).scale.set(1, 1.1, 0.9);
    for (const s of [-1, 1]) addMesh(SPH(0.032, 12, 10), M({ color: 0x050303 }), head, s * 0.06, 0.02, 0.19);
    addMesh(SPH(0.045, 12, 10), blood, head, 0, -0.1, 0.18).scale.set(1.4, 0.5, 0.5);
  }
  const jaw = new THREE.Group(); head.add(jaw);

  // arms with bloody, dripping hands
  const arms = [];
  for (const s of [-1, 1]) {
    const sh = new THREE.Group(); sh.position.set(s * 0.27, 0.6, 0); torso.add(sh);
    addMesh(JOINT(0.075), sleeve, sh).scale.set(1.1, 1, 1);
    addMesh(LIMB(0.068, 0.05, 0.34), sleeve, sh, 0, -0.17, 0);
    const el = new THREE.Group(); el.position.set(0, -0.34, 0); sh.add(el);
    addMesh(JOINT(0.05), sleeve, el);
    addMesh(LIMB(0.05, 0.038, 0.3), sleeve, el, 0, -0.15, 0);
    const hand = new THREE.Group(); hand.position.set(0, -0.34, 0); el.add(hand);
    addMesh(BOX(0.085, 0.1, 0.04), skin, hand, 0, -0.03, 0);
    if (H.croissant && s > 0) {   // his croissant, half eaten
      const pastry = M({ color: 0xc8852f, rough: 0.7, spec: 0.3 });
      addMesh(new THREE.TorusGeometry(0.06, 0.03, 10, 18, Math.PI * 1.25), pastry, hand, 0, -0.1, 0.05, 0, 0, Math.PI * 0.4).scale.set(1, 1, 0.8);
    }
    for (let f = 0; f < 4; f++) addMesh(new THREE.CapsuleGeometry(0.009, 0.055, 4, 6), skin, hand, (f - 1.5) * 0.019, -0.11, 0.004, 0.1, 0, 0);
    addMesh(new THREE.CapsuleGeometry(0.01, 0.04, 4, 6), skin, hand, s * -0.045, -0.04, 0.012, 0, 0, s * 0.6);
    addMesh(SPH(0.03, 10, 8), blood, hand, 0, -0.06, 0.02).scale.set(1.3, 1.2, 0.6);         // blood-soaked palm
    for (let d = 0; d < 2; d++) addMesh(SPH(0.008, 6, 6), blood, hand, (d - 0.5) * 0.03, -0.17 - d * 0.03, 0).scale.set(1, 2.6, 1);   // drips
    arms.push({ sh, el, s });
  }
  // pool of blood at the feet
  const pool = addMesh(new THREE.CircleGeometry(0.42, 28), blood, g, 0.05, 0.007, 0.08, -Math.PI / 2, 0, 0.4);
  pool.scale.set(1, 0.7, 1); pool.castShadow = false;

  g.userData.rig = { torso, head, arms, jaw };
  g.userData.facePlate = head.userData.facePlate || null;
  g.traverse((o) => { if (o.isMesh) o.userData.actor = id; });
  return g;
}

function pose(g, name, jaw = 0) {
  const r = g.userData.rig;
  r.torso.rotation.set(0, 0, 0); r.head.rotation.set(0, 0, 0);
  r.arms.forEach((a) => { a.sh.rotation.set(0, 0, 0); a.el.rotation.set(0, 0, 0); });
  r.arms.forEach(({ sh, el, s }) => {
    switch (name) {
      case 'stand': sh.rotation.set(-0.15, 0, s * 0.12); el.rotation.x = -0.35; break;
      case 'lean':  sh.rotation.set(-0.55, 0, s * 0.1); el.rotation.x = -0.4; break;
      case 'reach': sh.rotation.set(-1.45, 0, -s * 0.12); el.rotation.x = -0.25; break;
      case 'peek':  if (s > 0) { sh.rotation.set(-1.1, 0, -0.5); el.rotation.x = -0.9; } else sh.rotation.set(-0.1, 0, -0.1); break;
      case 'loom':  sh.rotation.set(-0.95, 0, s * 0.55); el.rotation.x = -0.6; break;
      case 'crouch': sh.rotation.set(-0.3, 0, s * 0.2); el.rotation.x = -1.2; break;
      case 'ride':  sh.rotation.set(-0.95, 0, -s * 0.05); el.rotation.x = -0.35; break;
    }
  });
  switch (name) {
    case 'stand': r.head.rotation.z = 0.14; break;
    case 'lean':  r.torso.rotation.x = 0.22; r.head.rotation.set(0.12, 0, -0.1); break;
    case 'reach': r.torso.rotation.x = 0.35; r.head.rotation.x = 0.05; break;
    case 'peek':  r.torso.rotation.set(0.15, 0, 0.18); r.head.rotation.set(0, 0, -0.4); break;
    case 'loom':  r.torso.rotation.x = 0.45; r.head.rotation.x = 0.15; break;
    case 'crouch': r.torso.rotation.x = 0.35; r.head.rotation.set(-0.2, 0, 0.3); break;
    case 'ride':  r.torso.rotation.x = 0.32; r.head.rotation.set(-0.25, 0, 0.12); break;
  }
  r.jaw.rotation.x = jaw * 0.8;
}

/* ==========================================================================
 * 7. BAKER — Three.js offline pre-renderer → G-buffers → PixiJS textures
 * ========================================================================== */
const Baker = {
  init() {
    const canvas = makeCanvas(BAKE_W, BAKE_H);
    this.r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
    this.r.setPixelRatio(1);
    this.r.setSize(BAKE_W, BAKE_H, false);
    this.r.shadowMap.enabled = true;
    this.r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.r.toneMapping = THREE.NoToneMapping;
    this.gl = this.r.getContext();
    this.scene = new THREE.Scene();
    this.ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this.hemi = new THREE.HemisphereLight(0xb8c0d0, 0x302820, 0.45);
    this.camLight = new THREE.PointLight(0xfff2e0, 2.2, 0, 0);
    this.camLight.castShadow = true;
    this.camLight.shadow.mapSize.set(1024, 1024);
    this.camLight.shadow.camera.near = 0.05; this.camLight.shadow.camera.far = 32;
    this.camLight.shadow.bias = -0.0015; this.camLight.shadow.normalBias = 0.02;
    this.scene.add(this.ambient, this.hemi, this.camLight);
    this.depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
    this.normCache = new Map(); this.depthCache = new Map();
    this.catcher = new THREE.Mesh(new THREE.PlaneGeometry(3.5, 3.5), new THREE.ShadowMaterial({ opacity: 0.55 }));
    this.catcher.rotation.x = -Math.PI / 2; this.catcher.receiveShadow = true; this.catcher.userData.albedoOnly = true;
    this.catcher.visible = false; this.scene.add(this.catcher);
  },
  camera(view) {
    const c = WORLD.cams[view], cam = new THREE.PerspectiveCamera(CONFIG.fovY, 16 / 9, 0.05, CONFIG.far);
    cam.position.set(...c.pos); cam.lookAt(new THREE.Vector3(...c.look)); cam.updateMatrixWorld(true);
    return cam;
  },
  normalMat(orig) {
    if (!this.normCache.has(orig.uuid)) {
      this.normCache.set(orig.uuid, new THREE.MeshNormalMaterial({ bumpMap: orig.bumpMap || null, bumpScale: orig.bumpScale ?? 1, side: orig.side }));
    }
    return this.normCache.get(orig.uuid);
  },
  depthMat(orig) {
    if (!this.depthCache.has(orig.uuid)) {
      this.depthCache.set(orig.uuid, new THREE.ShaderMaterial({
        side: orig.side,
        uniforms: { uFar: { value: CONFIG.far }, uSpec: { value: orig.userData.spec ?? 0.12 }, uEm: { value: orig.userData.emissive || 0 } },
        vertexShader: 'varying float vD; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vD = -mv.z; gl_Position = projectionMatrix * mv; }',
        fragmentShader: 'uniform float uFar, uSpec, uEm; varying float vD; void main(){ float d = clamp(vD/uFar,0.0,0.9999)*255.0; float hi = floor(d); gl_FragColor = vec4(hi/255.0, fract(d), uSpec, uEm); }',
      }));
    }
    return this.depthCache.get(orig.uuid);
  },
  /* Assign per-pass materials. subjects: Set of meshes drawn normally; everything
   * else is drawn normally (background bakes) or as depth-only occluders. */
  setPass(pass, subjects, occlude) {
    this.scene.traverse((o) => {
      if (!o.isMesh) return;
      if (!o.userData.orig) o.userData.orig = o.material;
      const orig = o.userData.orig;
      const isSubj = subjects.has(o);
      if (o.userData.albedoOnly) { o.visible = pass === 'albedo' && isSubj; return; }
      if (!isSubj && occlude) { o.material = this.depthOnly; return; }
      const conv = (mm) => (pass === 'albedo' ? mm : pass === 'normal' ? this.normalMat(mm) : this.depthMat(mm));
      o.material = Array.isArray(orig) ? orig.map(conv) : conv(orig);
    });
  },
  restore() { this.scene.traverse((o) => { if (o.isMesh && o.userData.orig) o.material = o.userData.orig; }); },
  read(w = BAKE_W, h = BAKE_H) {
    const buf = new Uint8Array(w * h * 4);
    this.gl.readPixels(0, 0, w, h, this.gl.RGBA, this.gl.UNSIGNED_BYTE, buf);
    return buf;
  },
  render(cam, clear, alpha, colorSpace) {
    this.r.outputColorSpace = colorSpace;
    this.r.setClearColor(clear, alpha);
    this.r.render(this.scene, cam);
  },

  /**
   * bake(view, opts) → { rect, A, N, D } (PIXI textures + rect in bake px)
   *   subjects: Object3D[] to isolate (villain, door…) — empty = full background
   *   catcherAt: [x,z] puts a shadow catcher under a standing villain
   */
  bake(view, { subjects = [], catcherAt = null } = {}) {
    const cam = this.camera(view);
    this.camLight.position.copy(cam.localToWorld(new THREE.Vector3(0.35, 0.3, 0.15)));
    const subj = new Set();
    subjects.forEach((s) => s.traverse((o) => { if (o.isMesh) subj.add(o); }));
    if (catcherAt) { this.catcher.position.set(catcherAt[0], 0.004, catcherAt[1]); subj.add(this.catcher); }
    const occlude = subjects.length > 0;
    this.setPass('albedo', subj, occlude); this.render(cam, 0x000000, 0, THREE.SRGBColorSpace); const A = this.read();
    this.setPass('normal', subj, occlude); this.render(cam, 0x8080ff, occlude ? 0 : 1, THREE.LinearSRGBColorSpace); const N = this.read();
    this.setPass('depth', subj, occlude);  this.render(cam, 0xff0000, 0, THREE.LinearSRGBColorSpace); const D = this.read();
    this.restore();
    this.catcher.visible = false;
    const rect = occlude ? alphaBounds(A, BAKE_W, BAKE_H) : { x: 0, y: 0, w: BAKE_W, h: BAKE_H };
    if (!rect) return null;
    return toLayer(A, N, D, rect);
  },

  /* Multi-frame jumpscare: the camera rushes the villain's face as the jaw opens. */
  bakeJumpscare(actor, view, frames = 10, d0 = 3.0, d1 = 1.05) {
    const w = Math.min(1280, BAKE_W), h = w * 9 / 16;
    this.r.setSize(w, h, false);
    const cam = this.camera(view), fwd = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    cam.getWorldDirection(fwd);
    const base = cam.position.clone();
    const spot = new THREE.SpotLight(0xfff0dd, 10, 4.5, 0.6, 0.5, 1.2); spot.castShadow = false;
    const rim = new THREE.PointLight(0xff1a0a, 6, 6, 1.2);
    this.scene.add(spot, spot.target, rim);
    const saved = [this.ambient.intensity, this.hemi.intensity, this.camLight.intensity];
    this.ambient.intensity = 0.08; this.hemi.intensity = 0.05; this.camLight.intensity = 0;
    actor.visible = true;
    const out = [];
    for (let i = 0; i < frames; i++) {
      const t = i / (frames - 1), e = t * t;
      const dist = lerp(d0, d1, e);
      const headH = 1.85 * actor.scale.y;
      actor.position.copy(base).addScaledVector(fwd, dist + 0.25);
      actor.position.y = base.y - headH + 0.06 + Math.sin(i * 2.1) * 0.03;
      actor.lookAt(base.x, actor.position.y, base.z);
      pose(actor, 'reach', clamp(0.25 + t * 0.9, 0, 1));
      actor.userData.rig.head.rotation.z += Math.sin(i * 1.7) * 0.12;
      actor.updateMatrixWorld(true);
      const headPos = actor.userData.rig.head.getWorldPosition(new THREE.Vector3());
      cam.position.copy(base); cam.up.set(Math.sin(i * 1.3) * 0.08, 1, 0);
      cam.lookAt(headPos.clone().add(new THREE.Vector3(0, -0.1 - t * 0.05, 0)));
      cam.updateMatrixWorld(true);
      spot.position.copy(base).addScaledVector(up, -0.45); spot.target.position.copy(headPos);
      rim.position.copy(headPos).add(new THREE.Vector3(0.45, 0.35, 0)).addScaledVector(fwd, 0.5);
      this.setPass('albedo', new Set(), false);
      this.render(cam, 0x000000, 1, THREE.SRGBColorSpace);
      out.push(PIXI.Texture.fromBuffer(flipRows(this.read(w, h), w, h), w, h, { alphaMode: PIXI.ALPHA_MODES.NPM }));
    }
    this.restore();
    this.scene.remove(spot, spot.target, rim);
    [this.ambient.intensity, this.hemi.intensity, this.camLight.intensity] = saved;
    actor.visible = false; cam.up.set(0, 1, 0);
    this.r.setSize(BAKE_W, BAKE_H, false);
    return out;
  },
};

function flipRows(buf, w, h) {
  const out = new Uint8Array(buf.length), row = w * 4;
  for (let y = 0; y < h; y++) out.set(buf.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  return out;
}
/* Bounding box of non-transparent pixels (returned in top-down coords, even-aligned). */
function alphaBounds(A, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) if (A[row + x * 4 + 3] > 3) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  const pad = 4;
  x0 = Math.max(0, (x0 - pad) & ~1); x1 = Math.min(w, (x1 + pad + 2) & ~1);
  const ty0 = Math.max(0, (h - 1 - y1 - pad) & ~1), ty1 = Math.min(h, (h - y0 + pad + 2) & ~1);
  return { x: x0, y: ty0, w: x1 - x0, h: ty1 - ty0 };
}
/* Crop (and flip to top-down) a bottom-up readback. step=2 → half resolution. */
function crop(buf, W, H, r, step = 1) {
  const w = (r.w / step) | 0, h = (r.h / step) | 0, out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = H - 1 - (r.y + y * step);
    if (step === 1) { const si = (sy * W + r.x) * 4; out.set(buf.subarray(si, si + w * 4), y * w * 4); continue; }
    for (let x = 0; x < w; x++) {
      const si = (sy * W + r.x + x * step) * 4, di = (y * w + x) * 4;
      out[di] = buf[si]; out[di + 1] = buf[si + 1]; out[di + 2] = buf[si + 2]; out[di + 3] = buf[si + 3];
    }
  }
  return { data: out, w, h };
}
function texFrom(data, w, h, nearest = false) {
  return PIXI.Texture.fromBuffer(data, w, h, {
    alphaMode: PIXI.ALPHA_MODES.NPM,
    scaleMode: nearest ? PIXI.SCALE_MODES.NEAREST : PIXI.SCALE_MODES.LINEAR,
    mipmap: PIXI.MIPMAP_MODES.OFF,
  });
}
function toLayer(A, N, D, rect) {
  const a = crop(A, BAKE_W, BAKE_H, rect), n = crop(N, BAKE_W, BAKE_H, rect), d = crop(D, BAKE_W, BAKE_H, rect, 2);
  return { rect, A: texFrom(a.data, a.w, a.h), N: texFrom(n.data, n.w, n.h), D: texFrom(d.data, d.w, d.h, true) };
}

/* Replace a baked layer's G-buffer with a user photo (graded + generated normals). */
function overrideLayer(layer, img, metres, full = false) {
  const rect = full ? { x: 0, y: 0, w: BAKE_W, h: BAKE_H } : layer.rect;
  let c;
  try {
    if (full) c = coverCanvas(img, rect.w, rect.h);
    else c = gradePhoto(img, { w: rect.w, h: rect.h, feather: 0.75, vignette: 0.6 });
    const id = c.getContext('2d').getImageData(0, 0, rect.w, rect.h).data;
    const A = new Uint8Array(id.length);
    for (let i = 0; i < id.length; i += 4) { const a = id[i + 3] / 255; A[i] = id[i] * a; A[i + 1] = id[i + 1] * a; A[i + 2] = id[i + 2] * a; A[i + 3] = id[i + 3]; }
    const N = normalsFromLuma(id, rect.w, rect.h);
    const dw = rect.w >> 1, dh = rect.h >> 1, D = new Uint8Array(dw * dh * 4);
    for (let i = 0; i < dw * dh; i++) packDepth(D, i * 4, metres, 0, 0.15);
    return { rect, A: texFrom(A, rect.w, rect.h), N: texFrom(N, rect.w, rect.h), D: texFrom(D, dw, dh, true) };
  } catch (e) {
    console.warn('Photo override skipped (canvas tainted? use a web server):', e);
    return layer;
  }
}
/* Full-frame background override with optional _normal / _depth maps. */
function overrideBackground(layer, key) {
  const img = Assets.img(`classroom/${key}`);
  if (!img) return layer;
  try {
    const w = BAKE_W, h = BAKE_H;
    const px = coverCanvas(img, w, h).getContext('2d').getImageData(0, 0, w, h).data;
    const A = new Uint8Array(px.length); for (let i = 0; i < px.length; i += 4) { A[i] = px[i]; A[i + 1] = px[i + 1]; A[i + 2] = px[i + 2]; A[i + 3] = 255; }
    const nImg = Assets.img(`classroom/${key}_normal`);
    const N = nImg ? new Uint8Array(coverCanvas(nImg, w, h).getContext('2d').getImageData(0, 0, w, h).data) : normalsFromLuma(px, w, h, 1.4);
    const dImg = Assets.img(`classroom/${key}_depth`);
    const dw = w >> 1, dh = h >> 1, D = new Uint8Array(dw * dh * 4);
    const dpx = dImg ? coverCanvas(dImg, dw, dh).getContext('2d').getImageData(0, 0, dw, dh).data : null;
    for (let i = 0; i < dw * dh; i++) packDepth(D, i * 4, dpx ? lerp(14, 0.8, dpx[i * 4] / 255) : 4, 0, 0.15);
    return { rect: { x: 0, y: 0, w, h }, A: texFrom(A, w, h), N: texFrom(N, w, h), D: texFrom(D, dw, dh, true) };
  } catch (e) { console.warn('Background override skipped:', e); return layer; }
}

/* ==========================================================================
 * 8. GRAPHICS — PixiJS stage, deferred flashlight shader, post FX
 * ========================================================================== */
const LAYER_VERT = `
attribute vec2 aVertexPosition; attribute vec2 aUV;
uniform mat3 translationMatrix; uniform mat3 projectionMatrix;
varying vec2 vUV;
void main(){ vUV = aUV; gl_Position = vec4((projectionMatrix * translationMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0); }`;

/* Deferred lighting: reconstruct view-space position from depth, then light it
 * with a conical flashlight + red emergency light + emissive. */
const LAYER_FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUV;
uniform sampler2D uAlbedo, uNormal, uDepth;
uniform vec4 uRect; uniform float uAlpha, uHaze;
uniform vec2 uTan; uniform float uFar;
uniform vec3 uLightPos, uLightDir; uniform float uLightOn, uCosOuter, uCosInner;
uniform vec3 uRedPos, uRedColor, uAmbColor; uniform float uRedPower, uAmbient;
void main(){
  vec4 alb = texture2D(uAlbedo, vUV);
  if (alb.a < 0.004) { gl_FragColor = vec4(0.0); return; }
  vec3 base = alb.rgb / alb.a;
  base = pow(base, vec3(2.2));                     // to linear
  vec3 N = normalize(texture2D(uNormal, vUV).xyz * 2.0 - 1.0);
  vec4 dt = texture2D(uDepth, vUV);
  float d = (dt.r + dt.g / 255.0) * uFar;
  vec2 s = uRect.xy + vUV * uRect.zw;
  vec3 P = vec3((s.x * 2.0 - 1.0) * uTan.x * d, (1.0 - s.y * 2.0) * uTan.y * d, -d);
  // ---- flashlight cone ----
  vec3 Lv = P - uLightPos; float dist = length(Lv); vec3 L = Lv / dist;
  float cd = dot(L, uLightDir);
  float cone = smoothstep(uCosOuter, uCosInner, cd);
  float hot = smoothstep(uCosInner, 1.0, cd);
  float atten = 1.0 / (1.0 + 0.09 * dist * dist);
  float ndl = max(dot(N, -L), 0.0);
  vec3 V = normalize(-P), Hh = normalize(V - L);
  float sp = pow(max(dot(N, Hh), 0.0), 48.0) * dt.b * 2.0;
  // ---- screen-space ambient occlusion (background only): soft contact
  //      shadows in corners and around objects, like FNAF 4's GI renders ----
  float ao = 1.0;
  if (uHaze > 0.5) {
    float occ = 0.0, rad = clamp(0.8 / d, 0.006, 0.06);
    for (int i = 0; i < 12; i++) {
      float fi = float(i), a = fi * 2.39996 + 0.5, rr = rad * (0.35 + 0.65 * fract(fi * 0.618));
      vec4 t = texture2D(uDepth, vUV + vec2(cos(a), sin(a) * 1.7778) * rr);
      float diff = d - (t.r + t.g / 255.0) * uFar;
      occ += smoothstep(0.02, 0.2, diff) * (1.0 - smoothstep(0.5, 1.2, diff));
    }
    ao = 1.0 - (occ / 12.0) * 0.9;
  }
  vec3 beam = vec3(1.0, 0.96, 0.9) * cone * (1.0 + hot * 1.0) * atten * uLightOn * 4.0;
  vec3 col = (base * beam * (ndl * 0.9 + 0.1) + beam * sp) * ao;
  // ---- red emergency light ----
  vec3 Rv = uRedPos - P; float rd = length(Rv);
  float rn = max(dot(N, Rv / rd), 0.0) * 0.75 + 0.25;
  col += base * uRedColor * uRedPower * rn / (1.0 + 0.35 * rd * rd);
  col += base * uAmbColor * uAmbient * ao;
  col += base * dt.a * 2.5;                         // emissive (eyes, signs)
  // ---- volumetric haze in the beam (background only) ----
  vec3 ray = normalize(P);
  col += vec3(0.9, 0.85, 0.7) * smoothstep(uCosOuter, 1.0, dot(ray, uLightDir)) * uHaze * uLightOn * 0.05;
  col = col / (1.0 + col * 0.35);                   // soft shoulder
  col = pow(col, vec3(1.0 / 2.2));
  float a = alb.a * uAlpha;
  gl_FragColor = vec4(col * a, a);
}`;

const POST_FRAG = `
precision highp float;
varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform vec4 inputSize; uniform vec4 outputFrame;
uniform float uTime, uFlicker, uShake, uGrain;
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main(){
  vec2 s = vTextureCoord * inputSize.xy / outputFrame.zw;
  vec2 c = s - 0.5; float r2 = dot(c, c);
  vec2 sd = 0.5 + c * (1.0 + 0.07 * r2 + 0.04 * r2 * r2);
  if (sd.x < 0.0 || sd.x > 1.0 || sd.y < 0.0 || sd.y > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec2 tc = sd * outputFrame.zw * inputSize.zw;
  vec2 ab = c * (0.003 + uShake * 0.03) * outputFrame.zw * inputSize.zw;
  vec3 col = vec3(texture2D(uSampler, tc + ab).r, texture2D(uSampler, tc).g, texture2D(uSampler, tc - ab).b);
  col *= 0.95 + 0.05 * sin(gl_FragCoord.y * 2.2);                                 // faint scanlines
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(lum), col, 0.82);                                                  // slightly desaturated
  col = mix(col * vec3(0.78, 0.86, 1.2), col * vec3(1.05, 1.0, 0.93), smoothstep(0.04, 0.45, lum)); // blue shadows, warm highlights
  col = clamp(col, 0.0, 1.0); col = mix(col, col * col * (3.0 - 2.0 * col), 0.35);  // gentle S-curve
  col += (hash(gl_FragCoord.xy * 0.71 + fract(uTime * 13.7) * 91.0) - 0.5) * uGrain;  // film grain
  col += vec3(0.004, 0.006, 0.018) * (1.0 - smoothstep(0.0, 0.2, lum));            // deep blue-black, never pure black
  col *= smoothstep(0.85, 0.2, length(c * vec2(1.0, 1.1))) * 0.88 + 0.12;           // vignette
  col *= 0.97 + 0.03 * smoothstep(0.0, 0.04, abs(fract(s.y - uTime * 0.11) - 0.5)); // rolling band
  col *= 1.0 - uFlicker;
  gl_FragColor = vec4(col, 1.0);
}`;

const Gfx = {
  layers: {}, views: {}, jsFrames: {},

  init() {
    this.app = new PIXI.Application({ resizeTo: window, background: '#000000', antialias: false, autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2), powerPreference: 'high-performance' });
    $('#pixi-host').appendChild(this.app.view);
    const st = this.app.stage;
    this.root = new PIXI.Container(); st.addChild(this.root);
    this.letter = new PIXI.Container(); this.root.addChild(this.letter);
    this.shaker = new PIXI.Container(); this.letter.addChild(this.shaker);
    this.content = new PIXI.Container(); this.shaker.addChild(this.content);
    this.content.pivot.set(VW / 2, VH / 2); this.content.position.set(VW / 2, VH / 2); this.content.scale.set(1.035);
    this.mask = new PIXI.Graphics().beginFill(0xffffff).drawRect(0, 0, VW, VH).endFill();
    this.letter.addChild(this.mask); this.letter.mask = this.mask;
    this.fade = new PIXI.Graphics().beginFill(0x000000).drawRect(-100, -100, VW + 200, VH + 200).endFill(); this.fade.alpha = 0;
    this.jsBox = new PIXI.Container(); this.jsBox.visible = false;
    this.jsSprite = new PIXI.Sprite(PIXI.Texture.EMPTY); this.jsSprite.anchor.set(0.5); this.jsBox.addChild(this.jsSprite);
    this.flash = new PIXI.Graphics().beginFill(0xffffff).drawRect(-100, -100, VW + 200, VH + 200).endFill(); this.flash.alpha = 0;
    this.shaker.addChild(this.fade, this.jsBox, this.flash);

    this.light = new PIXI.UniformGroup({
      uTan: new Float32Array([TAN_X, TAN_Y]), uFar: CONFIG.far,
      uLightPos: new Float32Array([0.18, -0.22, 0.0]), uLightDir: new Float32Array([0, 0, -1]),
      uLightOn: 0, uCosOuter: Math.cos(0.42), uCosInner: Math.cos(0.2),
      uRedPos: new Float32Array([0, 1, -5]), uRedColor: new Float32Array([1.0, 0.08, 0.05]), uRedPower: 0.22, uAmbient: 0.02, uAmbColor: new Float32Array([0.4, 0.5, 1.0]),
    });
    this.post = new PIXI.Filter(undefined, POST_FRAG, { uTime: 0, uFlicker: 0, uShake: 0, uGrain: 0.06 });
    this.post.resolution = this.app.renderer.resolution;
    this.root.filters = [this.post];
    this.root.filterArea = this.app.screen;
    window.addEventListener('resize', () => this.resize());
    this.resize();
  },

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const s = Math.min(w / VW, h / VH);
    this.scale = s;
    this.letter.scale.set(s);
    this.letter.position.set((w - VW * s) / 2, (h - VH * s) / 2);
    const ui = $('#ui');
    ui.style.left = `${(w - VW * s) / 2}px`; ui.style.top = `${(h - VH * s) / 2}px`;
    ui.style.width = `${VW * s}px`; ui.style.height = `${VH * s}px`;
  },

  view(name) {
    if (!this.views[name]) {
      const c = new PIXI.Container(); c.visible = false;
      this.content.addChild(c);
      this.views[name] = { c, layers: {} };
    }
    return this.views[name];
  },
  /* Turn a baked layer into a lit PIXI.Mesh inside a view. */
  addLayer(viewName, key, L, haze = 0) {
    if (!L) return null;
    const k = VW / BAKE_W, r = L.rect;
    const x = r.x * k, y = r.y * k, w = r.w * k, h = r.h * k;
    const geom = new PIXI.Geometry()
      .addAttribute('aVertexPosition', [x, y, x + w, y, x + w, y + h, x, y + h], 2)
      .addAttribute('aUV', [0, 0, 1, 0, 1, 1, 0, 1], 2)
      .addIndex([0, 1, 2, 0, 2, 3]);
    const shader = PIXI.Shader.from(LAYER_VERT, LAYER_FRAG, {
      uAlbedo: L.A, uNormal: L.N, uDepth: L.D, uRect: new Float32Array([x / VW, y / VH, w / VW, h / VH]),
      uAlpha: 1, uHaze: haze, light: this.light,
    });
    const mesh = new PIXI.Mesh(geom, shader);
    mesh.rect = { x, y, w, h };
    const v = this.view(viewName);
    v.c.addChild(mesh); v.layers[key] = mesh;
    this.layers[key] = mesh;
    return mesh;
  },
  show(viewName) { Object.entries(this.views).forEach(([n, v]) => { v.c.visible = n === viewName; }); },
  setAlpha(key, a) { const m = this.layers[key]; if (m) { m.shader.uniforms.uAlpha = a; m.visible = a > 0.001; } },

  /* Point the beam: content-space mouse → view-space direction. */
  aim(vx, vy) {
    const u = vx / VW, v = vy / VH;
    const dx = (u * 2 - 1) * TAN_X, dy = (1 - v * 2) * TAN_Y, dz = -1;
    const len = Math.hypot(dx, dy, dz);
    const d = this.light.uniforms.uLightDir; d[0] = dx / len; d[1] = dy / len; d[2] = dz / len;
  },
  setRed(view) {
    const cam = Baker.camera(view), p = new THREE.Vector3(...WORLD.red[view]).applyMatrix4(cam.matrixWorldInverse);
    const u = this.light.uniforms.uRedPos; u[0] = p.x; u[1] = p.y; u[2] = p.z;
  },
  toContent(gx, gy) { const p = this.content.toLocal(new PIXI.Point(gx, gy)); return [p.x, p.y]; },
};

/* ==========================================================================
 * 9. SOUND — Web Audio with 3D HRTF positioning, reverb and door muffling.
 *    Drop .wav/.mp3/.ogg files into /assets/audio/ to replace synth sounds.
 * ========================================================================== */
const SPOTS = {
  hallFar: [-18, 1.0, -3.1], hallNear: [-6, 1.0, -3.1], hallDoor: [-4.4, 1.6, -3.3],
  storeFar: [8.2, 1.0, -3.4], storeNear: [5.3, 1.0, -3.0], storeDoor: [4.4, 1.6, -3.3],
  locker: [0, 1.3, -4.6], desks: [0, 0.9, 3.0], podium: [0, 1.8, 4.6],
};
const AUDIO_FILES = ['scream', 'breathing', 'whisper', 'footstep', 'locker_creak', 'locker_bang', 'giggle', 'ambience', 'bell'];

const Sound = {
  ctx: null, master: null, buffers: {}, loops: {}, ch: {}, muted: false,

  async preload() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const c = this.ctx;
    const comp = c.createDynamicsCompressor(); comp.threshold.value = -12; comp.ratio.value = 4;
    this.master = c.createGain(); this.master.gain.value = 0.9; this.master.connect(comp); comp.connect(c.destination);
    const len = c.sampleRate * 2;
    this.noiseBuf = c.createBuffer(1, len, c.sampleRate);
    const d = this.noiseBuf.getChannelData(0); for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.distCurve = new Float32Array(1024).map((_, i) => { const x = i / 512 - 1; return ((1 + 80) * x) / (1 + 80 * Math.abs(x)); });
    // generated reverb impulse (long school-hallway tail)
    const ir = c.createBuffer(2, c.sampleRate * 2.8, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const b = ir.getChannelData(ch); for (let i = 0; i < b.length; i++) b[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / b.length, 3.2); }
    this.reverb = c.createConvolver(); this.reverb.buffer = ir;
    // a bicycle freewheel ticking (used for Hazza waiting at a door)
    const fw = c.createBuffer(1, c.sampleRate, c.sampleRate), fd = fw.getChannelData(0);
    for (let k = 0; k < 9; k++) { const o = Math.floor(k * c.sampleRate / 9); for (let i = 0; i < 260; i++) fd[o + i] = (Math.random() * 2 - 1) * Math.exp(-i / 40) * 0.8; }
    this.buffers.__freewheel = fw;
    const rg = c.createGain(); rg.gain.value = 0.5; this.reverb.connect(rg).connect(this.master);
    // channels: each zone has a muffle filter (closed door) + a reverb send
    const sends = { hall: 0.7, store: 0.25, locker: 0.15, desks: 0.2, room: 0.12 };
    for (const [name, send] of Object.entries(sends)) {
      const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 20000;
      const g = c.createGain(); g.gain.value = send;
      f.connect(this.master); f.connect(g).connect(this.reverb);
      this.ch[name] = f;
    }
    await Promise.all(AUDIO_FILES.map(async (n) => {
      for (const ext of AUDIO_EXT) {
        try {
          const r = await fetch(`assets/audio/${n}.${ext}`);
          if (!r.ok) continue;
          const ab = await r.arrayBuffer();
          this.buffers[n] = await new Promise((res, rej) => c.decodeAudioData(ab, res, rej));
          break;
        } catch (e) { /* try next extension */ }
      }
    }));
  },
  unlock() { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume(); },
  get ok() { return !!this.ctx && !this.muted; },
  now() { return this.ctx.currentTime; },
  toggleMute() { this.muted = !this.muted; if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, this.now(), 0.05); },
  suspend() { if (this.ctx) this.ctx.suspend(); },
  resume() { if (this.ctx) this.ctx.resume(); },

  setListener(view) {
    if (!this.ctx) return;
    const L = this.ctx.listener, p = WORLD.cams[view].pos, f = WORLD.listen[view], t = this.now();
    if (L.positionX) {
      L.positionX.setTargetAtTime(p[0], t, 0.08); L.positionY.setTargetAtTime(p[1], t, 0.08); L.positionZ.setTargetAtTime(p[2], t, 0.08);
      L.forwardX.setTargetAtTime(f[0], t, 0.08); L.forwardY.setTargetAtTime(f[1], t, 0.08); L.forwardZ.setTargetAtTime(f[2], t, 0.08);
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    } else { L.setPosition(...p); L.setOrientation(...f, 0, 1, 0); }
  },
  muffle(chName, closed) { const f = this.ch[chName]; if (f) f.frequency.setTargetAtTime(closed ? 550 : 20000, this.now(), 0.06); },

  /* Returns the input node for a sound at a 3D world position. */
  at(pos, ch = 'room') {
    const c = this.ctx;
    if (!pos) return this.ch[ch] || this.master;
    const p = c.createPanner();
    p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = 1.2; p.rolloffFactor = 1.3; p.maxDistance = 60;
    if (p.positionX) { p.positionX.value = pos[0]; p.positionY.value = pos[1]; p.positionZ.value = pos[2]; } else p.setPosition(...pos);
    p.connect(this.ch[ch] || this.master);
    return p;
  },
  env(node, t0, a, peak, dur) {
    node.gain.setValueAtTime(0.0001, t0);
    node.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + a);
    node.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(dur, a + 0.01));
  },
  noise() { const s = this.ctx.createBufferSource(); s.buffer = this.noiseBuf; s.loop = true; return s; },
  burst({ type = 'lowpass', freq = 400, q = 1, dur = 0.2, vol = 0.5, pos = null, ch = 'room', when = 0, attack = 0.005 }) {
    if (!this.ok || vol <= 0) return;
    const c = this.ctx, t0 = this.now() + when;
    const s = this.noise(), f = c.createBiquadFilter(), g = c.createGain();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    this.env(g, t0, attack, vol, dur);
    s.connect(f).connect(g).connect(this.at(pos, ch));
    s.start(t0, Math.random() * 1.5); s.stop(t0 + dur + 0.05);
  },
  tone({ type = 'sine', freq = 440, freqEnd = null, dur = 0.3, vol = 0.3, pos = null, ch = 'room', when = 0, attack = 0.008 }) {
    if (!this.ok || vol <= 0) return;
    const c = this.ctx, t0 = this.now() + when;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
    this.env(g, t0, attack, vol, dur);
    o.connect(g).connect(this.at(pos, ch));
    o.start(t0); o.stop(t0 + dur + 0.05);
  },
  buffer(name, { pos = null, ch = 'room', vol = 1, rate = 1, when = 0 } = {}) {
    const b = this.buffers[name];
    if (!b || !this.ok) return false;
    const s = this.ctx.createBufferSource(), g = this.ctx.createGain();
    s.buffer = b; s.playbackRate.value = rate; g.gain.value = vol;
    s.connect(g).connect(this.at(pos, ch)); s.start(this.now() + when);
    return true;
  },

  /* --- sound vocabulary --- */
  footstep(pos, ch, vol = 0.6, when = 0) {
    if (this.buffer('footstep', { pos, ch, vol, rate: rand(0.9, 1.1), when })) return;
    this.burst({ type: 'lowpass', freq: 180, q: 0.7, dur: 0.24, vol, pos, ch, when });
    this.tone({ freq: 66, freqEnd: 36, dur: 0.26, vol: vol * 0.9, pos, ch, when });
    this.burst({ type: 'bandpass', freq: 2400, q: 6, dur: 0.05, vol: vol * 0.2, pos, ch, when: when + 0.01 });   // heel click on tile
  },
  footsteps(pos, ch, vol, n = 3, gap = 0.55, fade = 0) { for (let i = 0; i < n; i++) this.footstep(pos, ch, vol * (1 - (fade * i) / n), i * gap + rand(0, 0.05)); },
  metalCreak(pos, vol = 0.3) {            // locker hinge
    if (this.buffer('locker_creak', { pos, ch: 'locker', vol })) return;
    if (!this.ok) return;
    const c = this.ctx, t0 = this.now(), o = c.createOscillator(), f = c.createBiquadFilter(), g = c.createGain();
    o.type = 'sawtooth'; o.frequency.setValueAtTime(rand(70, 110), t0);
    for (let i = 1; i < 8; i++) o.frequency.setValueAtTime(rand(60, 160), t0 + i * 0.08);
    f.type = 'bandpass'; f.frequency.value = rand(900, 1500); f.Q.value = 12;
    this.env(g, t0, 0.05, vol, 0.8);
    o.connect(f).connect(g).connect(this.at(pos, 'locker')); o.start(t0); o.stop(t0 + 0.9);
  },
  latch(pos, vol = 0.25) {
    [1850, 2950, 4100].forEach((fr, i) => this.burst({ type: 'bandpass', freq: fr, q: 30, dur: 0.18 - i * 0.04, vol, pos, ch: 'locker' }));
  },
  metalBang(pos, vol = 0.9) {
    if (this.buffer('locker_bang', { pos, ch: 'locker', vol })) return;
    this.burst({ type: 'lowpass', freq: 300, dur: 0.35, vol, pos, ch: 'locker' });
    [420, 1130, 1870, 2650].forEach((fr) => this.burst({ type: 'bandpass', freq: fr, q: 25, dur: 0.9, vol: vol * 0.35, pos, ch: 'locker' }));
  },
  rattle(pos, vol = 0.15) {               // snus tin
    let w = 0;
    for (let i = 0; i < 8; i++) { this.burst({ type: 'highpass', freq: 3800, dur: 0.03, vol, pos, ch: 'locker', when: w }); w += rand(0.035, 0.085); }
  },
  boxes(pos, vol = 0.35) {                // cardboard shuffled in storage
    this.burst({ type: 'lowpass', freq: 900, q: 0.5, dur: 0.6, vol, pos, ch: 'store', attack: 0.12 });
    this.burst({ type: 'lowpass', freq: 200, dur: 0.25, vol: vol * 0.8, pos, ch: 'store', when: 0.5 });
  },
  whisper(pos, ch, vol = 0.2, n = 6) {
    if (this.buffer('whisper', { pos, ch, vol: vol * 2 })) return;
    for (let i = 0; i < n; i++) this.burst({ type: 'bandpass', freq: rand(2200, 4400), q: 6, dur: rand(0.12, 0.26), vol, pos, ch, when: i * 0.2 + rand(0, 0.08), attack: 0.04 });
  },
  giggle(pos, vol = 0.08) {
    if (this.buffer('giggle', { pos, ch: 'desks', vol: vol * 4, rate: rand(0.95, 1.15) })) return;
    const base = rand(620, 820);
    for (let i = 0; i < 5; i++) { const f = base * (1 + i * 0.11) * (i % 2 ? 1.06 : 1); this.tone({ type: 'triangle', freq: f, freqEnd: f * 0.86, dur: 0.09, vol, pos, ch: 'desks', when: i * 0.1 }); }
  },
  doorSlam(pos, ch) {
    this.burst({ type: 'lowpass', freq: 320, dur: 0.35, vol: 0.8, pos, ch: 'room' });
    this.tone({ freq: 72, freqEnd: 44, dur: 0.3, vol: 0.6, pos, ch: 'room' });
    this.burst({ type: 'bandpass', freq: 3100, q: 18, dur: 0.12, vol: 0.2, pos, ch: 'room', when: 0.02 });  // latch
  },
  crunch(pos, vol = 0.15) {               // chewing a croissant
    for (let i = 0; i < 4; i++) {
      this.burst({ type: 'bandpass', freq: rand(1800, 3200), q: 2, dur: 0.05, vol, pos, ch: 'room', when: i * 0.32 + rand(0, 0.05) });
      this.burst({ type: 'lowpass', freq: 300, dur: 0.12, vol: vol * 0.6, pos, ch: 'room', when: i * 0.32 + 0.03 });
    }
  },
  bikeBell(pos, ch, vol = 0.2) {         // ding-ding
    for (const w of [0, 0.22]) [2250, 3420, 5100].forEach((f, k) => this.tone({ freq: f, dur: 0.9, vol: vol / (k + 1), pos, ch, when: w, attack: 0.002 }));
  },
  roll(pos, ch, vol = 0.3) {             // tyres rolling + chain ticking
    this.burst({ type: 'lowpass', freq: 380, q: 0.6, dur: 1.4, vol, pos, ch, attack: 0.5 });
    for (let i = 0; i < 18; i++) this.burst({ type: 'highpass', freq: 4500, dur: 0.012, vol: vol * 0.4, pos, ch, when: 0.15 + i * 0.065 });
  },
  click() { this.tone({ type: 'square', freq: 2400, dur: 0.012, vol: 0.07 }); this.tone({ type: 'square', freq: 900, dur: 0.015, vol: 0.05, when: 0.012 }); },
  run() { this.burst({ type: 'bandpass', freq: 500, q: 0.6, dur: 0.3, vol: 0.16, attack: 0.08 }); this.footstep(null, 'room', 0.12); this.footstep(null, 'room', 0.1, 0.16); },
  screech(pos, ch, vol = 0.25) { this.tone({ type: 'sawtooth', freq: 900, freqEnd: 300, dur: 0.35, vol, pos, ch }); },
  glitch() { this.burst({ type: 'bandpass', freq: 3000, q: 0.4, dur: 0.12, vol: 0.35 }); this.tone({ type: 'square', freq: 120, freqEnd: 2400, dur: 0.12, vol: 0.15 }); },
  tick() { this.tone({ freq: 1400, dur: 0.05, vol: 0.06 }); },
  staticNoise(dur = 1.5, vol = 0.2) { this.burst({ type: 'bandpass', freq: 2600, q: 0.3, dur, vol, attack: 0.02 }); },
  bell() {                                // 6 AM school bell
    if (this.buffer('bell', { vol: 0.8 })) return;
    if (!this.ok) return;
    const c = this.ctx, t0 = this.now(), g = c.createGain(), am = c.createOscillator(), amg = c.createGain();
    am.type = 'square'; am.frequency.value = 22; amg.gain.value = 0.5; am.connect(amg).connect(g.gain);
    g.gain.setValueAtTime(0.5, t0); g.gain.setValueAtTime(0.5, t0 + 3.2); g.gain.linearRampToValueAtTime(0, t0 + 3.6);
    g.connect(this.ch.room);
    [1760, 2390, 3150, 4410].forEach((f, i) => { const o = c.createOscillator(); o.frequency.value = f; const og = c.createGain(); og.gain.value = 0.12 / (i + 1); o.connect(og).connect(g); o.start(t0); o.stop(t0 + 3.7); });
    am.start(t0); am.stop(t0 + 3.7);
  },
  scream() {
    if (!this.ok) return;
    const c = this.ctx, t0 = this.now();
    const ws = c.createWaveShaper(); ws.curve = this.distCurve; ws.oversample = '2x';
    const out = c.createGain(); out.gain.value = 1.0;
    ws.connect(out).connect(this.master);
    if (this.buffers.scream) {                       // the scream audio file, driven hard
      const s = c.createBufferSource(), g = c.createGain();
      s.buffer = this.buffers.scream; g.gain.value = 2.2; s.connect(g).connect(ws); s.start(t0);
    }
    [190, 280, 410].forEach((f, i) => {            // synthesized layer on top
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'sawtooth'; o.frequency.setValueAtTime(f * 0.7, t0); o.frequency.exponentialRampToValueAtTime(f * 1.7, t0 + 0.2);
      o.frequency.exponentialRampToValueAtTime(f, t0 + 1.8);
      this.env(g, t0, 0.02, 0.18, 1.9); o.connect(g).connect(ws); o.start(t0); o.stop(t0 + 2);
    });
  },

  startLoops() {
    if (!this.ctx) return;
    this.stopLoops();
    const c = this.ctx, t = this.now();
    // ambience: HVAC hum + low drone (or ambience file)
    const dg = c.createGain(); dg.gain.value = 0; dg.connect(this.master);
    const srcs = [];
    if (this.buffers.ambience) {
      const s = c.createBufferSource(); s.buffer = this.buffers.ambience; s.loop = true; s.connect(dg); srcs.push(s);
    } else {
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 160; lp.connect(dg);
      [[41.2, 'sawtooth', 1], [41.9, 'sawtooth', 1], [60, 'sine', 0.5], [120, 'sine', 0.25]].forEach(([f, type, gv]) => {
        const o = c.createOscillator(); o.type = type; o.frequency.value = f; const g = c.createGain(); g.gain.value = gv; o.connect(g).connect(lp); srcs.push(o);
      });
      const lfo = c.createOscillator(), lg = c.createGain(); lfo.frequency.value = 0.07; lg.gain.value = 60; lfo.connect(lg).connect(lp.frequency); srcs.push(lfo);
      const hiss = this.noise(), hp = c.createBiquadFilter(), hg = c.createGain(); hp.type = 'highpass'; hp.frequency.value = 5000; hg.gain.value = 0.05;
      hiss.connect(hp).connect(hg).connect(dg); srcs.push(hiss);
    }
    srcs.forEach((s) => s.start(t));
    dg.gain.setTargetAtTime(0.2, t, 2);
    this.loops.drone = { gain: dg, srcs };
    // positional loops at the doors: Steven breathes, Xavier whispers
    const mk = (name, pos, ch, freq, q, file) => {
      const g = c.createGain(); g.gain.value = 0;
      let s, f = null;
      if (this.buffers[file]) { s = c.createBufferSource(); s.buffer = this.buffers[file]; s.loop = true; s.connect(g); }
      else { s = this.noise(); f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q; s.connect(f).connect(g); }
      g.connect(this.at(pos, ch)); s.start(t);
      this.loops[name] = { gain: g, filter: f, srcs: [s] };
    };
    mk('steven', SPOTS.hallDoor, 'hall', 450, 0.9, 'breathing');
    mk('xavier', SPOTS.storeDoor, 'store', 2800, 5, 'whisper');
    mk('harry_left', SPOTS.hallDoor, 'hall', 0, 0, '__freewheel');    // a freewheel ticking outside the door
    mk('harry_right', SPOTS.storeDoor, 'store', 0, 0, '__freewheel');
  },
  setLoop(name, vol, tc = 0.06, freq) {
    const L = this.loops[name]; if (!L || !this.ctx) return;
    L.gain.gain.setTargetAtTime(this.muted ? 0 : vol, this.now(), tc);
    if (freq && L.filter) L.filter.frequency.setTargetAtTime(freq, this.now(), 0.05);
  },
  stopLoops() {
    if (!this.ctx) return;
    const t = this.now();
    Object.values(this.loops).forEach((L) => {
      L.gain.gain.cancelScheduledValues(t); L.gain.gain.setTargetAtTime(0, t, 0.05);
      L.srcs.forEach((s) => { try { s.stop(t + 0.4); } catch (e) { /* stopped */ } });
    });
    this.loops = {};
  },
};

/* ==========================================================================
 * 10. AI
 * ========================================================================== */

/* HallStalker — Steven (hallway door) & Xavier (storage door).
 *   0 away · 1 far · 2 near · 3 AT THE DOOR (hidden; breathing / whispering).
 *   Beam pushes back stages 1–2. At 3: light = death, hold the door to repel. */
class HallStalker {
  constructor(id, side, level, o) {
    Object.assign(this, { id, side, level, o });
    this.stage = 0; this.timer = CONFIG.startGrace + o.interval * rand(0.5, 1.2);
    this.patience = 0; this.hold = 0; this.exposure = 0; this.litAtDoor = 0;
    this.setSide(side);
  }
  setSide(side) {
    this.side = side;
    this.ch = side === 'left' ? 'hall' : 'store';
    this.spots = side === 'left' ? [null, SPOTS.hallFar, SPOTS.hallNear, SPOTS.hallDoor] : [null, SPOTS.storeFar, SPOTS.storeNear, SPOTS.storeDoor];
    this.place = side === 'left' ? 'hallway' : 'storage closet';
  }
  get layerKey() { return this.stage === 1 ? `${this.id}_far` : this.stage === 2 ? `${this.id}_near` : null; }
  update(dt) {
    if (this.level <= 0 && this.stage === 0) return;
    const here = G.view === this.side && !G.trans;
    const closed = here && G.doors[this.side] > 0.85;
    const lit = !this.o.blind && here && G.flashOn && this.layerKey && beamHits(this.layerKey);
    if (this.stage === 1 || this.stage === 2) {
      if (lit) { this.exposure += dt; if (this.exposure > (this.stage === 1 ? 0.45 : 0.3)) { this.retreat(true); return; } }
      else this.exposure = Math.max(0, this.exposure - dt);
    }
    if (this.stage === 3) {
      if (!this.o.blind && here && G.flashOn && !closed) { this.litAtDoor += dt; if (this.litAtDoor > 0.12) { breach(this.id); return; } }
      else this.litAtDoor = 0;
      if (closed) { this.hold += dt; if (this.hold >= this.o.hold) { this.retreat(false); return; } }
      else { this.hold = Math.max(0, this.hold - dt * 0.5); this.patience -= dt; if (this.patience <= 0) { breach(this.id); return; } }
      return;
    }
    this.timer -= dt;
    if (this.timer <= 0) { this.timer = this.o.interval * rand(0.7, 1.3); if (!lit && roll(this.level)) this.advance(); }
  }
  advance() {
    if (this.stage === 0 && this.o.roam) this.setSide(chance(0.5) ? 'left' : 'right');
    let n = this.stage + 1;
    if (this.stage === 1 && chance(this.o.skip)) n = 3;
    this.stage = n;
    const pos = this.spots[n];
    if (n === 3) { this.patience = Math.max(4, this.o.patience - this.level * 0.18); this.hold = 0; this.litAtDoor = 0; }
    if (this.id === 'harry') {
      Sound.roll(pos, this.ch, 0.25 + n * 0.12);
      if (n < 3) Sound.bikeBell(pos, this.ch, 0.12 + n * 0.08);
    } else if (this.id === 'steven') {
      Sound.footsteps(pos, this.ch, n === 3 ? 0.7 : 0.55, n === 3 ? 2 : 3, 0.6);
      addAlert(['', '*footsteps echo far down the hallway*', '*heavy footsteps — close, in the hallway*', '*the footsteps stop.*'][n], 'sound');
    } else {
      Sound.boxes(pos, 0.3 + n * 0.1); Sound.whisper(pos, this.ch, 0.08 + n * 0.04, 4);
      addAlert(['', 'whisper (storage closet): "Raoul… I can hear you breathing."', '*boxes slide in the storage closet — something is close*', '*silence from the storage closet…*'][n], n === 1 ? 'whisper' : 'sound');
    }
  }
  retreat(byLight) {
    this.stage = 0; this.exposure = 0; this.hold = 0; this.timer = this.o.interval * rand(1.2, 1.9);
    if (this.id === 'harry') Sound.roll(this.spots[1], this.ch, 0.3);
    else Sound.footsteps(this.spots[2], this.ch, 0.4, 4, 0.45, 0.9);
    if (byLight) { Sound.screech(this.spots[2], this.ch, 0.2); addAlert(`${VILLAINS[this.id].name} recoils from the light.`, 'good'); }
    else addAlert(`*something retreats from the ${this.place} door*`, 'good');
  }
  cueVolume() { return this.stage === 3 ? (this.id === 'steven' ? 0.9 : this.id === 'harry' ? 0.8 : 0.7) : 0; }
  listenText() {
    return this.id === 'xavier'
      ? 'whisper, right behind the storage door: "let me in, Raoul…"'
      : '*…slow, wet breathing just outside the classroom door…*';
  }
}

/* Cyclist — Hazza. Rides up to EITHER door (picks one each run). He's blind:
 * the flashlight neither repels nor provokes him. Hold the door when he arrives. */
class Cyclist extends HallStalker {
  constructor(level) { super('harry', 'left', level, { interval: 4.6, patience: 9, hold: 2.8, skip: 0.2, blind: true, roam: true }); }
  get layerKey() { return this.stage === 1 ? `harry_${this.side}_far` : this.stage === 2 ? `harry_${this.side}_near` : null; }
}

/* Croissant Kirk — creeps through the middle of the classroom (centre view).
 * He feeds on attention: keep the beam on him and he steps closer. Stand in
 * the room with the light OFF for a few seconds and he backs off. While you're
 * away from the centre he edges closer on his own. Reaching you = breach.
 * Cue: chewing, louder the closer he is. */
const KIRK_SPOTS = [null, [-1.3, 1.5, -4.2], [0.6, 1.5, -1.6], [0.05, 1.5, 0.75]];
class Creeper {
  constructor(level) {
    this.id = 'kirk'; this.level = level; this.stage = 0;
    this.timer = CONFIG.startGrace + 8 * rand(0.8, 1.3); this.lit = 0; this.dark = 0; this.cueT = 3;
  }
  update(dt) {
    if (this.level <= 0 && this.stage === 0) return;
    const here = G.view === 'center' && !G.trans;
    if (this.stage > 0) {
      if (here && G.flashOn && beamHits(`kirk_${this.stage}`, 60)) {
        this.lit += dt;
        if (this.lit > 0.7) { this.lit = 0; this.step(1); if (G.state !== 'playing') return; }
      } else this.lit = Math.max(0, this.lit - dt * 0.5);
      if (here && !G.flashOn) { this.dark += dt; if (this.dark > 3.2) { this.dark = 0; this.step(-1); } }
      else this.dark = 0;
      this.cueT -= dt;
      if (this.cueT <= 0 && this.stage > 0) { this.cueT = rand(2.5, 5); Sound.crunch(KIRK_SPOTS[this.stage], 0.08 + this.stage * 0.07); }
    }
    if (!here) {
      this.timer -= dt;
      if (this.timer <= 0) { this.timer = 7 * rand(0.7, 1.3); if (roll(this.level)) this.step(1); }
    }
  }
  step(d) {
    this.stage = clamp(this.stage + d, 0, 4);
    if (this.stage === 4) { breach('kirk'); return; }
    if (d > 0 && this.stage > 0) Sound.crunch(KIRK_SPOTS[this.stage], 0.12 + this.stage * 0.08);
    if (d < 0) this.timer = 7 * rand(1, 1.5);
  }
}

/* LockerLurker — Zynovan in the supply locker. 0 empty → 4 fully out. */
class LockerLurker {
  constructor(level) {
    this.id = 'zynovan'; this.level = level; this.stage = 0;
    this.timer = CONFIG.startGrace + 4.5 * rand(0.6, 1.3);
    this.hold = 0; this.patience = 0; this.bangT = 0; this.cueT = 8;
  }
  update(dt) {
    if (this.level <= 0 && this.stage === 0) return;
    const here = G.view === 'locker' && !G.trans;
    const closed = here && G.doors.locker > 0.85;
    if (this.stage === 4) {
      if (closed) {
        this.hold += dt; this.bangT -= dt;
        if (this.bangT <= 0) { this.bangT = rand(0.35, 0.7); Sound.metalBang(SPOTS.locker); G.shake = Math.max(G.shake, 7); }
        if (this.hold >= 3) { this.reset(); addAlert('*the banging stops. a snus tin rolls across the floor.*', 'good'); Sound.rattle(SPOTS.locker, 0.12); }
      } else {
        this.hold = Math.max(0, this.hold - dt);
        this.patience -= dt * (here && G.flashOn ? 1.6 : 1);
        if (this.patience <= 0) breach('zynovan');
      }
      return;
    }
    if (this.stage >= 1 && closed) {
      this.hold += dt;
      if (this.hold >= 1.1) { this.reset(); Sound.latch(SPOTS.locker, 0.2); addAlert('*the latch clicks. something shrinks back into the locker.*', 'good'); }
    } else this.hold = 0;
    if (!here) {
      this.timer -= dt;
      if (this.timer <= 0) { this.timer = 4.5 * rand(0.6, 1.4); if (roll(this.level)) this.advance(); }
    }
    if (this.stage >= 1) {
      this.cueT -= dt;
      if (this.cueT <= 0) { this.cueT = rand(5, 10); chance(0.5) ? Sound.rattle(SPOTS.locker, 0.04 + this.stage * 0.02) : Sound.metalCreak(SPOTS.locker, 0.08 + this.stage * 0.04); }
    }
  }
  advance() {
    this.stage = Math.min(4, this.stage + (chance(0.2) ? 2 : 1));
    if (this.stage <= 2) Sound.latch(SPOTS.locker, 0.15 + this.stage * 0.05);
    Sound.metalCreak(SPOTS.locker, 0.15 + this.stage * 0.1);
    addAlert(['', '*a metal latch clicks inside the supply locker*', '*a locker door creaks open an inch*',
      'whisper (supply locker): "want a pouch, Raoul?"', '*THE SUPPLY LOCKER SWINGS OPEN*'][this.stage],
      this.stage === 4 ? 'danger' : this.stage === 3 ? 'whisper' : 'sound');
    if (this.stage === 4) { this.patience = Math.max(3.5, 7.5 - this.level * 0.18); this.hold = 0; }
  }
  reset() { this.stage = 0; this.hold = 0; this.timer = 4.5 * rand(0.9, 1.4); }
}

/* DeskMinis — Little Xaviers gather on the desks behind you. */
class DeskMinis {
  constructor(level) {
    this.id = 'xavier'; this.level = level; this.count = 0;
    this.timer = CONFIG.startGrace + 9 * rand(0.6, 1.3);
    this.exposure = 0; this.nightmare = -1; this.nightmareMax = 1; this.giggleT = 5;
  }
  update(dt) {
    if (this.level <= 0 && this.count === 0) return;
    const here = G.view === 'desks' && !G.trans;
    const lit = here && G.flashOn && this.count > 0 && [1, 2, 3].slice(0, this.count).some((i) => beamHits(`mini_${i}`, 130));
    if (lit) {
      this.exposure += dt;
      if (this.exposure > 0.45) { this.exposure = 0; this.count--; Sound.tone({ type: 'triangle', freq: 1100, freqEnd: 400, dur: 0.18, vol: 0.08, pos: SPOTS.desks, ch: 'desks' }); }
    } else this.exposure = Math.max(0, this.exposure - dt * 0.5);
    if (!here) {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.timer = 9 * rand(0.6, 1.3);
        if (this.count < 3 && roll(this.level)) {
          this.count++;
          Sound.giggle([rand(-1.6, 1.6), 0.9, rand(2.3, 3.5)], 0.05 + this.count * 0.02);
          addAlert(this.count === 1 ? '*tiny giggles somewhere behind you*' : '*more giggling… from the desks*', 'sound');
        }
      }
      if (this.count > 0) { this.giggleT -= dt; if (this.giggleT <= 0) { this.giggleT = rand(5, 10); Sound.giggle(SPOTS.desks, 0.03 + this.count * 0.015); } }
    }
    if (this.count >= 3) {
      if (this.nightmare < 0) {
        this.nightmare = this.nightmareMax = Math.max(4.5, 9 - this.level * 0.2);
        addAlert('Xavier: "Raoul… turn around."', 'whisper'); Sound.whisper(SPOTS.podium, 'desks', 0.25, 7);
      }
      this.nightmare -= dt;
      if (this.nightmare <= 0) breach('xavier');
    } else this.nightmare = -1;
  }
}

/* Is the flashlight beam on a layer? (cursor near/inside its bounds) */
function beamHits(key, pad = 40) {
  const m = Gfx.layers[key]; if (!m) return false;
  const r = m.rect, x = Input.cx, y = Input.cy;
  return x > r.x - pad && x < r.x + r.w + pad && y > r.y - pad && y < r.y + r.h * 0.8 + pad;
}

/* ==========================================================================
 * 11. GAME STATE, INPUT, LOOP
 * ========================================================================== */
const Input = { keys: {}, gx: innerWidth / 2, gy: innerHeight / 2, cx: VW / 2, cy: VH / 2, mouseL: false, mouseR: false, touchFlash: false, holdBtn: false };
const G = {
  state: 'loading', night: 1, time: 0, hour: 0, t: 0,
  view: 'center', trans: null, battery: 100, flashOn: false, wantPrev: false,
  doors: { left: 0, right: 0, locker: 0 },
  shake: 0, flicker: 0, halluc: 0, listen: 0, listened: false,
  ai: null, js: null, showHints: true, introT: 0,
};
const VIEW_DOOR = { left: 'door_left', right: 'door_right', locker: 'locker' };

function loadProgress() { try { return parseInt(localStorage.getItem(CONFIG.storageKey), 10) || 0; } catch (e) { return 0; } }
function saveProgress(n) { try { if (n > loadProgress()) localStorage.setItem(CONFIG.storageKey, String(n)); } catch (e) { /* blocked */ } }

function setView(v) {
  G.view = v;
  Gfx.show(v);
  Gfx.setRed(v);
  Sound.setListener(v);
}

function startNight(n) {
  const cfg = NIGHTS[n - 1];
  Object.assign(G, { night: n, time: 0, hour: 0, trans: null, battery: 100, flashOn: false,
    doors: { left: 0, right: 0, locker: 0 }, shake: 0, flicker: 0, halluc: 0, listen: 0, listened: false, js: null });
  G.ai = {
    steven: new HallStalker('steven', 'left', cfg.steven, { interval: 5.2, patience: 11, hold: 2.6, skip: 0 }),
    xavier: new HallStalker('xavier', 'right', cfg.xavier, { interval: 4.2, patience: 8.5, hold: 3.2, skip: 0.25 }),
    zynovan: new LockerLurker(cfg.zynovan),
    minis: new DeskMinis(cfg.minis),
    harry: new Cyclist(cfg.harry || 0),
    kirk: new Creeper(cfg.kirk || 0),
  };
  setView('center');
  Gfx.jsBox.visible = false; Gfx.content.visible = true;
  $('#alerts').innerHTML = '';
  $('.intro-time').textContent = '12:00 AM';
  $('.intro-night').textContent = n === 6 ? 'NIGHTMARE' : `Night ${n}`;
  $('.intro-msg').textContent = cfg.msg;
  $('.intro-tip').textContent = cfg.tip;
  const it = $('.intro-time'); it.style.animation = 'none'; void it.offsetWidth; it.style.animation = '';
  showScreen('intro');
  G.state = 'intro'; G.introT = 0;
  Sound.stopLoops(); Sound.staticNoise(0.6, 0.15);
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
  else if ((G.view === 'left' && dir === 'right') || (G.view === 'right' && dir === 'left') || (G.view === 'desks' && (dir === 'locker' || dir === 'desks'))) to = 'center';
  if (!to || to === G.view) return;
  G.trans = { to, t: 0, switched: false };
  G.listen = 0; G.listened = false;
  Sound.run();
}
function breach(id) {
  if (G.state !== 'playing') return;
  G.state = 'jumpscare';
  G.js = { id, t: 0, frames: Gfx.jsFrames[id] || [] };
  Sound.stopLoops(); Sound.scream();
  $('#hud').classList.add('hidden');
  Gfx.content.visible = false; Gfx.jsBox.visible = true;
}
function onHour(h) {
  if (h > 0) { Sound.tick(); if (h === 2 || h === 4) Object.values(G.ai).forEach((a) => { if (a.level > 0) a.level += 1; }); }
}
function winNight() {
  G.state = 'win';
  Sound.stopLoops(); Sound.bell();
  $('#hud').classList.add('hidden');
  saveProgress(G.night);
  $('#win-msg').textContent = G.night === 6 ? 'You survived the NIGHTMARE. Raoul Mann graduates. (…for now.)'
    : G.night === 5 ? 'Raoul Mann survived Five Nights at Xavier\'s. The bell rings. School\'s out. …Nightmare unlocked.'
    : `Night ${G.night} survived. The morning bell rings.`;
  $('#next-btn').classList.toggle('hidden', G.night >= 6);
  $('#next-btn').textContent = G.night === 5 ? 'Nightmare' : 'Next Night';
  drawRaoul($('#win-portrait'));
  $('.win-clock .roll').querySelectorAll('span').forEach((s) => { s.style.animation = 'none'; void s.offsetWidth; s.style.animation = ''; });
  showScreen('win');
}
function showGameOver() {
  const V = VILLAINS[G.js.id];
  G.state = 'gameover';
  Gfx.jsBox.visible = false;
  Sound.staticNoise(2.5, 0.2);
  $('#go-who').textContent = `Raoul Mann was caught by ${V.name}.`;
  $('#go-quote').textContent = pick(V.quotes);
  const portrait = $('#go-portrait'), img = Assets.img(`${G.js.id}/gameover`);
  portrait.classList.toggle('hidden', !img);
  if (img) {
    const c = portrait.getContext('2d');
    c.clearRect(0, 0, portrait.width, portrait.height);
    try { c.drawImage(gradePhoto(img, { w: portrait.width, h: portrait.height, feather: 0.7, vignette: 0.6 }), 0, 0); }
    catch (e) { c.drawImage(coverCanvas(img, portrait.width, portrait.height), 0, 0); }
  }
  showScreen('gameover');
}

function update(dt) {
  G.t += dt;
  G.shake = Math.max(0, G.shake - dt * 30);
  G.flicker = Math.max(0, G.flicker - dt);
  G.halluc = Math.max(0, G.halluc - dt);
  if (Math.random() < dt * 0.25) G.flicker = rand(0.03, 0.08);
  if (G.state === 'playing') updatePlaying(dt);
  else if (G.state === 'jumpscare') { G.js.t += dt; if (G.js.t > 1.9) showGameOver(); }
  else if (G.state === 'intro') { G.introT += dt; if (G.introT > 9) beginPlay(); }
}

function updatePlaying(dt) {
  G.time += dt;
  const hour = Math.min(6, Math.floor(G.time / CONFIG.secondsPerHour));
  if (hour !== G.hour) { G.hour = hour; onHour(hour); if (hour >= 6) { winNight(); return; } }
  if (G.trans) {
    G.trans.t += dt;
    if (!G.trans.switched && G.trans.t >= CONFIG.transitionTime / 2) { setView(G.trans.to); G.trans.switched = true; }
    if (G.trans.t >= CONFIG.transitionTime) G.trans = null;
  }
  const busy = !!G.trans;
  const doorView = G.view in VIEW_DOOR;
  const holding = doorView && !busy && (Input.keys.Space || Input.mouseR || Input.holdBtn);
  for (const k of ['left', 'right', 'locker']) {
    const before = G.doors[k], target = holding && G.view === k ? 1 : 0;
    G.doors[k] = approach(before, target, dt * (target ? 6 : 4.5));
    if (before < 0.9 && G.doors[k] >= 0.9) {
      if (k === 'locker') Sound.metalBang(SPOTS.locker, 0.45); else Sound.doorSlam(k === 'left' ? SPOTS.hallDoor : SPOTS.storeDoor);
    }
  }
  Sound.muffle('hall', G.doors.left > 0.85); Sound.muffle('store', G.doors.right > 0.85); Sound.muffle('locker', G.doors.locker > 0.85);

  const want = Input.mouseL || Input.keys.KeyF || Input.keys.ShiftLeft || Input.keys.ShiftRight || Input.touchFlash;
  if (want !== G.wantPrev) { if (G.battery > 0) Sound.click(); G.wantPrev = want; }
  const blocked = doorView && G.doors[G.view] > 0.5;
  let on = want && !busy && G.battery > 0 && !blocked;
  if (on) G.battery = Math.max(0, G.battery - CONFIG.batteryDrain * dt);
  if (on && G.battery < 15 && Math.random() < (15 - G.battery) / 45) on = false;
  G.flashOn = on;

  for (const k of ['steven', 'xavier', 'zynovan', 'minis', 'harry', 'kirk']) { G.ai[k].update(dt); if (G.state !== 'playing') return; }

  // Listening: at a door, light off, door open
  const listening = (G.view === 'left' || G.view === 'right') && !busy && !G.flashOn && G.doors[G.view] < 0.5;
  if (listening) {
    G.listen += dt;
    const st = G.view === 'left' ? G.ai.steven : G.ai.xavier;
    if (G.listen > 0.9 && !G.listened && st.stage === 3) { G.listened = true; addAlert(st.listenText(), 'whisper'); }
  } else if (!busy) G.listen = 0;
  $('#listen-meter').classList.toggle('hidden', !(listening && G.listen > 0.4));

  if (G.view === 'center' && G.flashOn && G.night >= 2 && G.halluc <= 0 && Math.random() < dt * 0.005 * G.night) { G.halluc = 0.12; Sound.glitch(); }
  updateAudioMix(dt);
  updateHUD();
}

function updateAudioMix(dt) {
  if (!Sound.ctx) return;
  Sound.setLoop('drone', G.view === 'center' ? 0.2 : 0.06, 0.3);   // the room goes quiet when you listen
  const ph = (G.t % 3.4) / 3.4, shape = Math.pow(0.5 - 0.5 * Math.cos(ph * Math.PI * 2), 2);
  Sound.setLoop('steven', G.ai.steven.cueVolume() * (0.12 + shape), 0.05, 380 + 260 * shape);
  const syl = (Math.sin(G.t * 9.3) + Math.sin(G.t * 13.7)) > 0.5 ? 1 : 0.2;
  Sound.setLoop('xavier', G.ai.xavier.cueVolume() * syl, 0.03, 2400 + Math.sin(G.t * 5) * 900);
  const hz = G.ai.harry;
  Sound.setLoop('harry_left', hz.side === 'left' ? hz.cueVolume() : 0, 0.05);
  Sound.setLoop('harry_right', hz.side === 'right' ? hz.cueVolume() : 0, 0.05);
}

/* --- per-frame graphics state --- */
function syncGraphics(dt) {
  const L = Gfx.light.uniforms;
  [Input.cx, Input.cy] = Gfx.toContent(Input.gx, Input.gy);
  const playing = G.state === 'playing' || G.state === 'paused';
  if (G.state === 'menu' || G.state === 'loading') {
    // menu: the beam sweeps the classroom by itself
    Gfx.show('center');
    Gfx.aim(VW / 2 + Math.sin(G.t * 0.37) * 470, VH * 0.52 + Math.sin(G.t * 0.61) * 150);
    L.uLightOn = 0.95 + Math.sin(G.t * 31) * 0.03;
    Gfx.setAlpha('menu_xavier', 1);
    for (const k of ['center_zyn', 'kirk_1', 'kirk_2', 'kirk_3']) Gfx.setAlpha(k, 0);
  } else if (playing) {
    Gfx.setAlpha('menu_xavier', 0);
    Gfx.aim(Input.cx, Input.cy);
    const batt = G.battery < 20 ? 0.6 + 0.4 * (G.battery / 20) : 1;
    L.uLightOn = G.flashOn ? batt * (1 + Math.sin(G.t * 13) * 0.015) : 0;
    L.uCosOuter = Math.cos(0.42 * (G.battery < 20 ? 0.85 : 1));
    // villains & doors visibility
    const a = G.ai;
    Gfx.setAlpha('steven_far', a.steven.stage === 1 ? 1 : 0); Gfx.setAlpha('steven_near', a.steven.stage === 2 ? 1 : 0);
    for (const sd of ['left', 'right']) {
      Gfx.setAlpha(`harry_${sd}_far`, a.harry.side === sd && a.harry.stage === 1 ? 1 : 0);
      Gfx.setAlpha(`harry_${sd}_near`, a.harry.side === sd && a.harry.stage === 2 ? 1 : 0);
    }
    Gfx.setAlpha('xavier_far', a.xavier.stage === 1 ? 1 : 0); Gfx.setAlpha('xavier_near', a.xavier.stage === 2 ? 1 : 0);
    for (let s = 1; s <= 4; s++) Gfx.setAlpha(`zyn_${s}`, a.zynovan.stage === s ? 1 : 0);
    Gfx.setAlpha('center_zyn', a.zynovan.stage >= 3 ? 1 : 0);
    for (let k = 1; k <= 3; k++) Gfx.setAlpha(`kirk_${k}`, a.kirk.stage === k ? 1 : 0);
    for (let i = 1; i <= 3; i++) Gfx.setAlpha(`mini_${i}`, a.minis.count >= i ? 1 : 0);
    Gfx.setAlpha('xavier_podium', a.minis.nightmare >= 0 ? clamp(1.2 - a.minis.nightmare / a.minis.nightmareMax, 0.35, 1) : 0);
    for (const [view, key] of Object.entries(VIEW_DOOR)) {
      const d = G.doors[view];
      Gfx.setAlpha(`${key}_open`, 1 - clamp(d * 2, 0, 1));
      Gfx.setAlpha(`${key}_mid`, clamp(d * 2, 0, 1) * (1 - clamp(d * 2 - 1, 0, 1)));
      Gfx.setAlpha(`${key}_closed`, clamp(d * 2 - 1, 0, 1));
    }
  }
  // transition fade, camera sway, shake
  Gfx.fade.alpha = G.trans ? Math.min(1, (1 - Math.abs((G.trans.t / CONFIG.transitionTime) * 2 - 1)) * 1.5) : 0;
  const sx = (Input.gx / innerWidth - 0.5) * -16, sy = (Input.gy / innerHeight - 0.5) * -9;
  Gfx.content.position.x = lerp(Gfx.content.position.x, VW / 2 + sx, 0.08);
  Gfx.content.position.y = lerp(Gfx.content.position.y, VH / 2 + sy, 0.08);
  let shake = G.shake;
  if (G.state === 'jumpscare') shake = 26 * Math.max(0.15, 1 - G.js.t / 1.9);
  Gfx.shaker.position.set(shake ? rand(-shake, shake) : 0, shake ? rand(-shake, shake) : 0);
  Gfx.shaker.rotation = shake ? rand(-0.012, 0.012) * shake / 10 : 0;
  // hallucination: Xavier's face flashes up
  if (G.halluc > 0 && Gfx.jsFrames.xavier && Gfx.jsFrames.xavier.length) {
    Gfx.jsBox.visible = true; showJsFrame(Gfx.jsFrames.xavier[Gfx.jsFrames.xavier.length - 1], 1.1, 0.8);
  } else if (G.state !== 'jumpscare') Gfx.jsBox.visible = false;
  if (G.state === 'jumpscare') renderJumpscare();
  else Gfx.flash.alpha = 0;
  // post FX
  const P = Gfx.post.uniforms;
  P.uTime = G.t; P.uFlicker = G.flicker > 0 ? 0.35 : 0;
  P.uShake = G.state === 'jumpscare' ? 1 : G.shake / 25;
}

function showJsFrame(tex, zoom, alpha = 1) {
  const s = Gfx.jsSprite; s.texture = tex;
  const k = Math.max(VW / tex.width, VH / tex.height) * zoom;
  s.scale.set(k); s.position.set(VW / 2, VH / 2); s.alpha = alpha;
}
function renderJumpscare() {
  const js = G.js, t = js.t, frames = js.frames;
  if (frames.length) {
    const fi = Math.min(frames.length - 1, Math.floor((t / 0.55) * frames.length));
    const hold = Math.max(0, t - 0.55);
    showJsFrame(frames[fi], 1.04 + hold * 0.18 + Math.sin(t * 60) * 0.012);
    Gfx.jsSprite.rotation = Math.sin(t * 47) * 0.02;
  }
  const f = Math.floor(t * 24) % 3;
  Gfx.flash.tint = f === 0 ? 0xffffff : 0xaa0000;
  Gfx.flash.alpha = t < 1.3 ? (f === 2 ? 0 : f === 0 ? 0.55 : 0.35) : 0;
  Gfx.jsSprite.alpha = t > 1.5 ? Math.max(0, 1 - (t - 1.5) / 0.4) : 1;
}

/* --- Input --- */
function onPointerMove(e) { Input.gx = e.clientX; Input.gy = e.clientY; }
window.addEventListener('mousemove', onPointerMove);
window.addEventListener('mousedown', (e) => {
  if (e.target.closest('button, .panel, a, .night-btn')) return;
  onPointerMove(e);
  if (e.button === 0) Input.mouseL = true;
  if (e.button === 2) Input.mouseR = true;
});
window.addEventListener('mouseup', (e) => { if (e.button === 0) Input.mouseL = false; if (e.button === 2) Input.mouseR = false; });
window.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('blur', () => {
  Input.keys = {}; Input.mouseL = Input.mouseR = Input.touchFlash = Input.holdBtn = false;
  if (G.state === 'playing') pauseGame();
});
document.addEventListener('visibilitychange', () => { if (document.hidden && G.state === 'playing') pauseGame(); });
window.addEventListener('touchstart', (e) => { document.body.classList.add('touch'); if (!e.target.closest('button')) onPointerMove(e.touches[0]); }, { passive: true });
window.addEventListener('touchmove', (e) => { if (!e.target.closest('button')) onPointerMove(e.touches[0]); }, { passive: true });
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

const KEYMAP = { KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', KeyW: 'locker', ArrowUp: 'locker', KeyS: 'back', ArrowDown: 'back' };
window.addEventListener('keydown', (e) => {
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  Input.keys[e.code] = true;
  if (e.repeat) return;
  if (G.state === 'playing') {
    let dir = KEYMAP[e.code];
    if (dir === 'back' && G.view === 'center') dir = 'desks';
    if (dir) go(dir);
    if (e.code === 'KeyH') { G.showHints = !G.showHints; updateHUD(true); }
  }
  if (e.code === 'KeyM') Sound.toggleMute();
  if (e.code === 'Escape') { if (G.state === 'playing') pauseGame(); else if (G.state === 'paused') resumeGame(); }
  if (G.state === 'intro' && (e.code === 'Space' || e.code === 'Enter')) beginPlay();
});
window.addEventListener('keyup', (e) => { Input.keys[e.code] = false; });
function pauseGame() { G.state = 'paused'; Sound.suspend(); showScreen('pause'); }
function resumeGame() { G.state = 'playing'; Sound.resume(); showScreen(null); }

/* ==========================================================================
 * 12. UI & BOOT
 * ========================================================================== */
const SCREENS = ['loading', 'menu', 'howto', 'lore', 'guide', 'intro', 'pause', 'gameover', 'win', 'error'];
function showScreen(name) { SCREENS.forEach((s) => $('#screen-' + s).classList.toggle('hidden', s !== name)); }

let lastHudKey = '';
function updateHUD(force) {
  $('#hud-clock').innerHTML = `${G.hour === 0 ? '12' : G.hour} <span>AM</span>`;
  $('#hud-night').textContent = G.night === 6 ? 'Nightmare' : `Night ${G.night}`;
  $('#hud-battery .fill').style.width = `${G.battery}%`;
  $('#hud-battery .pct').textContent = `${Math.ceil(G.battery)}%`;
  $('#hud-battery').classList.toggle('low', G.battery < 20);
  const key = `${G.view}|${G.showHints}`;
  if (!force && key === lastHudKey) return;
  lastHudKey = key;
  const v = G.view, center = v === 'center';
  ['left', 'right', 'locker', 'desks'].forEach((n) => $('#nav-' + n).classList.toggle('hidden', !center));
  $('#nav-back').classList.toggle('hidden', center);
  $('#hold-btn').classList.toggle('show', v in VIEW_DOOR);
  $('#flash-btn').classList.add('show');
  const door = 'hold <kbd>MOUSE</kbd> beam (far only!) · hold <kbd>SPACE</kbd>/<kbd>R-CLICK</kbd> door · light off = listen · <kbd>S</kbd> back';
  const hints = {
    center: '<kbd>A</kbd> hall door · <kbd>D</kbd> storage door · <kbd>W</kbd> supply locker · <kbd>S</kbd> turn around · hold <kbd>MOUSE</kbd> flashlight',
    left: door, right: door,
    locker: 'hold <kbd>MOUSE</kbd> look · hold <kbd>SPACE</kbd>/<kbd>R-CLICK</kbd> hold the locker shut · <kbd>S</kbd> back',
    desks: 'hold <kbd>MOUSE</kbd> flash the desks · <kbd>S</kbd> back',
  };
  $('#hint').innerHTML = G.showHints ? hints[v] + ' · <kbd>H</kbd> hide' : '';
}

/* On-screen text is only used for explicit system messages — monster cues are
 * sound-only (no subtitles, no warnings). */
function addAlert(text, cls = 'sound', force = false) {
  if (!text || !force) return;
  const box = $('#alerts'), el = document.createElement('div');
  el.className = 'alert ' + cls; el.textContent = text;
  box.appendChild(el);
  while (box.children.length > 3) box.removeChild(box.firstChild);
  setTimeout(() => el.remove(), 4700);
}

function drawRaoul(canvas) {
  const c = canvas.getContext('2d'), w = canvas.width, h = canvas.height, img = Assets.img('player/raoul');
  c.clearRect(0, 0, w, h); c.save(); c.beginPath(); c.arc(w / 2, h / 2, w / 2 - 4, 0, 7); c.clip();
  c.fillStyle = '#0a0406'; c.fillRect(0, 0, w, h);
  if (img) c.drawImage(gradePhoto(img, { w, h, feather: 0, vignette: 0.7 }), 0, 0);
  else { c.fillStyle = '#2a3550'; c.beginPath(); c.ellipse(w / 2, h, w * 0.4, h * 0.3, 0, 0, 7); c.fill();
    c.fillStyle = '#c9a487'; c.beginPath(); c.ellipse(w / 2, h * 0.48, w * 0.2, h * 0.24, 0, 0, 7); c.fill();
    c.fillStyle = '#fff'; c.beginPath(); c.arc(w * 0.43, h * 0.46, 6, 0, 7); c.arc(w * 0.57, h * 0.46, 6, 0, 7); c.fill(); }
  c.restore(); c.strokeStyle = 'rgba(160,0,20,0.6)'; c.lineWidth = 3; c.beginPath(); c.arc(w / 2, h / 2, w / 2 - 4, 0, 7); c.stroke();
}

function buildNightRow() {
  const done = loadProgress(), row = $('#night-row');
  row.innerHTML = '';
  NIGHTS.forEach((n, i) => {
    const num = i + 1, nm = num === 6;
    const b = document.createElement('button');
    b.className = 'night-btn' + (nm ? ' nightmare' : '') + (nm && done < 5 ? ' locked' : '');
    b.innerHTML = `${nm ? '☠' : 'Night ' + num}<small>${done >= num ? '★' : ''}</small>`;
    b.title = nm ? 'Nightmare (beat Night 5)' : `Night ${num}`;
    b.addEventListener('click', () => { Sound.unlock(); startNight(num); });
    row.appendChild(b);
  });
}
function buildAssetStatus() {
  const box = $('#asset-status'); box.innerHTML = '';
  const row = (label, ok, txt) => { const a = document.createElement('span'); a.textContent = label; const b = document.createElement('span'); b.className = ok ? 'ok' : 'miss'; b.textContent = txt; box.append(a, b); };
  Assets.manifest.filter((e) => !/_normal|_depth/.test(e.key)).forEach((e) => {
    const s = Assets.store[e.key] || {};
    row(e.label, s.found, s.found ? `✔ ${s.path}` : '✖ built-in 3D render');
  });
  for (const id of VILLAIN_IDS) {
    const n = Assets.jumpscares[id] ? Assets.jumpscares[id].length : 0;
    row(`${VILLAINS[id].name} — jumpscare frames`, n > 0, n ? `✔ ${n} frame(s)` : '✖ built-in 3D frames');
  }
  AUDIO_FILES.forEach((n) => row(`Audio — ${n}`, !!Sound.buffers[n], Sound.buffers[n] ? '✔ file' : '✖ synthesized'));
}
function showMenu() {
  G.state = 'menu';
  Sound.stopLoops();
  $('#hud').classList.add('hidden');
  Gfx.content.visible = true; Gfx.jsBox.visible = false;
  Gfx.setRed('center');
  buildNightRow();
  showScreen('menu');
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-action]');
  if (!b) return;
  Sound.unlock();
  switch (b.dataset.action) {
    case 'new': startNight(1); break;
    case 'howto': showScreen('howto'); break;
    case 'lore': showScreen('lore'); break;
    case 'guide': buildAssetStatus(); showScreen('guide'); break;
    case 'menu': showMenu(); break;
    case 'resume': resumeGame(); break;
    case 'restart': Sound.resume(); startNight(G.night); break;
    case 'quit': Sound.resume(); showMenu(); break;
    case 'next': startNight(Math.min(G.night + 1, 6)); break;
  }
});
$('#screen-intro').addEventListener('click', () => { Sound.unlock(); beginPlay(); });

/* --- Pre-render every view & pose --- */
async function prerender(setStatus) {
  const T = makeTextures();
  setStatus('Building the classroom…', 0.12); await nextFrame();
  const W = buildWorld(T);
  Baker.init();
  Baker.scene.add(W.world);
  // face photos → graded textures wrapped on the 3D skulls
  const faces = {}, altFaces = {};
  const faceJobs = [];
  for (const id of VILLAIN_IDS) faceJobs.push([id, 'face', faces], [id, 'face_2', altFaces]);
  for (const [id, slot, into] of faceJobs) {
    const img = Assets.img(`${id}/${slot}`);
    if (!img) continue;
    try {
      const c = coverCanvas(img, 512, 512), x = c.getContext('2d');
      x.globalCompositeOperation = 'destination-in';
      x.save(); x.translate(256, 256); x.scale(250, 250);
      const f = x.createRadialGradient(0, 0, 0, 0, 0, 1);
      f.addColorStop(0, '#000'); f.addColorStop(0.95, '#000'); f.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = f; x.beginPath(); x.arc(0, 0, 1, 0, Math.PI * 2); x.fill(); x.restore();
      const map = new THREE.CanvasTexture(c); map.colorSpace = THREE.SRGBColorSpace;
      into[id] = { map, bump: new THREE.CanvasTexture(c) };
    } catch (e) { console.warn('face skipped', e); }
  }
  for (const id of Object.keys(altFaces)) if (!faces[id]) { faces[id] = altFaces[id]; delete altFaces[id]; }
  const actors = {};
  for (const id of VILLAIN_IDS) {
    actors[id] = buildHuman(id, T, faces[id] && faces[id].map);
    actors[id].visible = false; Baker.scene.add(actors[id]);
  }
  const minis = [1, 2, 3].map(() => {   // Little Xaviers: knee-high copies of him standing on the desks
    const m = buildHuman('xavier', T, faces.xavier && faces.xavier.map);
    m.scale.setScalar(0.26); pose(m, 'stand'); m.visible = false; Baker.scene.add(m); return m;
  });
  const camPos = (v) => new THREE.Vector3(...WORLD.cams[v].pos);
  const place = (a, x, y, z, view, poseName, jaw = 0, scale = 1, faceOffset = 0) => {
    a.visible = true; a.scale.setScalar(scale); a.position.set(x, y, z);
    const c = camPos(view); a.lookAt(c.x, y, c.z); a.rotation.y += faceOffset;
    if (a.userData.rig) pose(a, poseName, jaw);
    a.updateMatrixWorld(true);
  };
  const hideActors = () => { Object.values(actors).forEach((a) => { a.visible = false; }); minis.forEach((m) => { m.visible = false; }); };

  const jobs = [];
  const job = (label, fn) => jobs.push({ label, fn });
  const bg = (view, key, prep) => job(`${view} background`, () => { prep(); hideActors(); Gfx.addLayer(view, `bg_${view}`, overrideBackground(Baker.bake(view), key), 1); });
  const doorsOpen = () => {
    setClassDoor(W.doorL, -1, 100); setClassDoor(W.doorR, 1, 100); setLockerDoors(W.locker, 14);
    W.doorL.visible = W.doorR.visible = true; W.locker.doors.forEach((d) => { d.visible = true; });
  };

  bg('center', 'center', doorsOpen);
  bg('left', 'door_left', () => { doorsOpen(); W.doorL.visible = false; });
  bg('right', 'door_right', () => { doorsOpen(); W.doorR.visible = false; });
  bg('locker', 'locker', () => { doorsOpen(); W.locker.doors.forEach((d) => { d.visible = false; }); });
  bg('desks', 'desks', doorsOpen);
  // door frames: open / mid / closed
  const doorFrames = (view, key, obj, setter, angles) => ['open', 'mid', 'closed'].forEach((st, i) => job(`${key} ${st}`, () => {
    doorsOpen(); hideActors();
    setter(angles[i]);
    let L = Baker.bake(view, { subjects: Array.isArray(obj) ? obj : [obj] });
    const ov = st === 'closed' && Assets.img(`classroom/${key}_closed`);
    if (ov) L = overrideLayer(L, ov, 1.2, true);
    Gfx.addLayer(view, `${key}_${st}`, L);
  }));
  doorFrames('left', 'door_left', W.doorL, (a) => setClassDoor(W.doorL, -1, a), [100, 42, 0]);
  doorFrames('right', 'door_right', W.doorR, (a) => setClassDoor(W.doorR, 1, a), [100, 42, 0]);
  doorFrames('locker', 'locker', W.locker.doors, (a) => setLockerDoors(W.locker, a), [80, 35, 0]);

  // villain poses
  const villain = (view, key, actor, x, z, poseName, jaw, opts = {}) => job(key, () => {
    doorsOpen(); hideActors();
    if (opts.prep) opts.prep();
    const id = actor.userData.id, plate = actor.userData.facePlate;
    if (plate) plate.material.map = (opts.face === 2 && altFaces[id] ? altFaces[id] : faces[id]).map;
    place(actor, x, opts.y || 0, z, view, poseName, jaw, opts.scale || 1, opts.turn || 0);
    if (opts.turn && actor.userData.rig) { actor.userData.rig.torso.rotation.y = -opts.turn * 0.8; actor.updateMatrixWorld(true); }
    let L = Baker.bake(view, { subjects: [actor], catcherAt: opts.catcher ? [x, z] : null });
    const ov = opts.override && Assets.img(opts.override);
    if (L && ov) L = overrideLayer(L, ov, opts.depth || 4);
    Gfx.addLayer(view, key, L);
    actor.visible = false;
  });
  const hidePanels = () => { W.doorL.visible = W.doorR.visible = false; };
  villain('left', 'steven_far', actors.steven, -17.5, -3.05, 'stand', 0.1, { catcher: true, override: 'steven/hallway_far', depth: 14, prep: hidePanels });
  villain('left', 'steven_near', actors.steven, -5.7, -3.15, 'lean', 0.35, { catcher: true, override: 'steven/hallway_near', depth: 2.4, prep: hidePanels });
  villain('right', 'xavier_far', actors.xavier, 7.9, -3.45, 'stand', 0.1, { catcher: true, override: 'xavier/hallway_far', depth: 4.6, prep: hidePanels });
  villain('right', 'xavier_near', actors.xavier, 5.2, -3.0, 'lean', 0.4, { catcher: true, override: 'xavier/hallway_near', depth: 1.9, prep: hidePanels });
  villain('left', 'harry_left_far', actors.harry, -15.5, -2.8, 'ride', 0, { turn: 0.6, catcher: true, override: 'harry/hallway_far', depth: 12, prep: hidePanels });
  villain('left', 'harry_left_near', actors.harry, -6.4, -3.4, 'ride', 0, { turn: 0.5, catcher: true, override: 'harry/hallway_near', depth: 3, prep: hidePanels });
  villain('right', 'harry_right_far', actors.harry, 7.6, -2.45, 'ride', 0, { turn: -0.15, catcher: true, override: 'harry/hallway_far', depth: 4.3, prep: hidePanels });
  villain('right', 'harry_right_near', actors.harry, 5.75, -3.5, 'ride', 0, { turn: 0.5, catcher: true, override: 'harry/hallway_near', depth: 2.4, prep: hidePanels });
  const lockerOcc = () => { W.locker.doors.forEach((d) => { d.visible = false; }); };
  villain('locker', 'zyn_1', actors.zynovan, 0, -4.75, 'crouch', 0, { y: -0.18, scale: 0.92, override: 'zynovan/locker_stage_1', depth: 1.7, prep: lockerOcc });
  villain('locker', 'zyn_2', actors.zynovan, 0.05, -4.68, 'peek', 0.3, { y: -0.08, scale: 0.94, override: 'zynovan/locker_stage_2', depth: 1.6, prep: lockerOcc });
  villain('locker', 'zyn_3', actors.zynovan, 0, -4.45, 'lean', 0.45, { face: 2, scale: 0.96, override: 'zynovan/locker_stage_3', depth: 1.4, prep: lockerOcc });
  villain('locker', 'zyn_4', actors.zynovan, 0, -4.25, 'reach', 0.85, { face: 2, y: -0.38, scale: 1.0, override: 'zynovan/locker_stage_4', depth: 0.9, prep: lockerOcc });
  villain('center', 'center_zyn', actors.zynovan, 0, -4.68, 'peek', 0.3, { y: -0.08, scale: 0.94 });
  villain('center', 'kirk_1', actors.kirk, -1.3, -4.2, 'stand', 0, { catcher: true, override: 'kirk/room_far', depth: 6.6 });
  villain('center', 'kirk_2', actors.kirk, 0.6, -1.6, 'lean', 0, { catcher: true, override: 'kirk/room_mid', depth: 3.8 });
  villain('center', 'kirk_3', actors.kirk, 0.05, 0.75, 'reach', 0, { catcher: true, override: 'kirk/room_near', depth: 1.4 });
  villain('desks', 'xavier_podium', actors.xavier, 0, 4.82, 'loom', 0.55, { scale: 1.15, override: 'xavier/podium', depth: 4.4 });
  villain('center', 'menu_xavier', actors.xavier, 1.25, -3.9, 'stand', 0.15, { catcher: true });
  [[-1.6, 2.4], [1.6, 2.4], [0.0, 3.5]].forEach(([x, z], i) => job(`mini ${i + 1}`, () => {
    doorsOpen(); hideActors();
    const m = minis[i]; m.visible = true; m.position.set(x + (i - 1) * 0.08, 0.755, z); m.lookAt(0, 0.755, 0.2); m.rotation.y += (i - 1) * 0.3;
    m.updateMatrixWorld(true);
    Gfx.addLayer('desks', `mini_${i + 1}`, Baker.bake('desks', { subjects: [m] }));
    m.visible = false;
  }));
  // jumpscares (or user frame sequences)
  const jsViews = { steven: 'left', xavier: 'right', zynovan: 'locker', harry: 'left', kirk: 'center' };
  for (const id of ['steven', 'xavier', 'zynovan']) job(`${id} jumpscare`, () => {
    hideActors(); doorsOpen();
    if (id === 'zynovan') setLockerDoors(W.locker, 85);
    const user = Assets.jumpscares[id];
    if (user && user.length) {
      Gfx.jsFrames[id] = user.map((r) => PIXI.Texture.from(gradePhoto(r.img, { w: 1280, h: 720, feather: 0, vignette: 0.75 })));
    } else {
      actors[id].scale.setScalar(1);
      Gfx.jsFrames[id] = id === 'zynovan' ? Baker.bakeJumpscare(actors[id], 'locker', 10, 1.35, 0.85) : Baker.bakeJumpscare(actors[id], jsViews[id]);
    }
  });

  for (let i = 0; i < jobs.length; i++) {
    setStatus(`Pre-rendering ${jobs[i].label}…`, 0.15 + 0.85 * (i / jobs.length));
    await nextFrame();
    jobs[i].fn();
  }
  setStatus('Done.', 1);
}

/* --- main loop --- */
function frame() {
  const dt = Math.min(0.05, Gfx.app.ticker.deltaMS / 1000);
  try { update(dt); syncGraphics(dt); if (DEBUG && G.ai) renderDebug(); }
  catch (err) { console.error(err); }
}
function renderDebug() {
  let el = $('#debug');
  if (!el) { el = document.createElement('pre'); el.id = 'debug'; el.style.cssText = 'position:fixed;left:8px;bottom:8px;color:#0f0;font:12px monospace;z-index:9;background:rgba(0,0,0,.6);margin:0;padding:6px;pointer-events:none'; document.body.appendChild(el); }
  const a = G.ai;
  el.textContent = `view ${G.view} t ${G.time.toFixed(1)} batt ${G.battery.toFixed(0)} beam ${G.flashOn}\n` +
    `steven L${a.steven.level} st${a.steven.stage} pat ${a.steven.patience.toFixed(1)}\n` +
    `xavier L${a.xavier.level} st${a.xavier.stage} pat ${a.xavier.patience.toFixed(1)}\n` +
    `zyn L${a.zynovan.level} st${a.zynovan.stage} pat ${a.zynovan.patience.toFixed(1)}\n` +
    `minis L${a.minis.level} n${a.minis.count} nm ${a.minis.nightmare.toFixed(1)}`;
}

async function boot() {
  const fill = $('.progress-fill'), status = $('.loading-status');
  const setStatus = (txt, p) => { status.textContent = txt; fill.style.width = `${Math.round(p * 100)}%`; };
  try {
    if (typeof PIXI === 'undefined' || typeof THREE === 'undefined') throw new Error('Engine scripts failed to load (lib/ folder missing?).');
    Gfx.init();
  } catch (e) {
    console.error(e); $('#error-msg').textContent = String(e.message || e); showScreen('error'); return;
  }
  setStatus('Looking for your photos & sounds in /assets/…', 0.02);
  await Promise.all([Assets.loadAll((p) => setStatus('Looking for your photos & sounds in /assets/…', p * 0.08)), Sound.preload()]);
  try {
    await prerender(setStatus);
  } catch (e) {
    console.error(e); $('#error-msg').textContent = 'Pre-render failed: ' + (e.message || e); showScreen('error'); return;
  }
  Gfx.app.ticker.add(frame);
  const n = Assets.count();
  status.textContent = n ? `${n} custom asset${n === 1 ? '' : 's'} blended into the scene.` : 'No custom photos found — using built-in 3D renders. (See Asset Guide.)';
  const enter = $('#enter-btn');
  enter.classList.remove('hidden');
  enter.addEventListener('click', () => { Sound.unlock(); showMenu(); }, { once: true });
}

window.FNAX = { G, Gfx, Assets, Sound, Baker, startNight, breach, go, NIGHTS, CONFIG };
boot();
