// show.js — the visual scene engine.
//
// Every phone and the /preview grid render the SAME pure functions of
// (position, shared time, music drive, director directive). The host controls
// everything by broadcasting one small directive: { scene, palette, react,
// image, epoch }. No pixels are streamed — each phone renders locally.
//   palette : a name, an inline {stops:[[h,s,l]...]} (custom colors), or 'auto'
//   react   : { brightness, beat, speed } knobs (1 = default) shaping the music response
//   image   : { w, h, cells:[0..1] } low-res grid for the crowd-as-screen 'image' scene

export const DEMO_BPM = 120;

// --- Palettes: [h, s, l] stops, sampled by p in [0..1] ----------------------
export const PALETTES = {
  sunset:  [[14, 92, 55], [330, 82, 55], [275, 72, 48]],
  ocean:   [[185, 85, 52], [205, 88, 50], [250, 72, 42]],
  fire:    [[2, 95, 52], [22, 96, 54], [46, 97, 56]],
  neon:    [[305, 96, 60], [185, 96, 56], [260, 92, 62]],
  rainbow: [[0, 90, 55], [60, 92, 53], [120, 85, 48], [200, 90, 54], [280, 86, 56], [330, 92, 55]],
  white:   [[210, 25, 100]],
};
export const PALETTE_NAMES = Object.keys(PALETTES);

const lerp = (a, b, t) => a + (b - a) * t;
function paletteStops(palette) {
  if (palette && typeof palette === 'object' && Array.isArray(palette.stops) && palette.stops.length) return palette.stops;
  return PALETTES[palette] || PALETTES.sunset;
}
function samplePalette(palette, p) {
  const stops = paletteStops(palette);
  if (stops.length === 1) return stops[0];
  p = ((p % 1) + 1) % 1;
  const x = p * (stops.length - 1);
  const i = Math.floor(x), f = x - i;
  const a = stops[i], b = stops[Math.min(stops.length - 1, i + 1)];
  return [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)];
}
const css = (h, s, l) => `hsl(${h.toFixed(0)} ${Math.max(0, Math.min(100, s)).toFixed(0)}% ${Math.max(3, Math.min(98, l)).toFixed(0)}%)`;

// Blend two hsl() strings in RGB (for smooth scene crossfades). f: 0=a .. 1=b.
function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [255 * f(0), 255 * f(8), 255 * f(4)];
}
function parseHsl(str) { const m = /hsl\((-?\d+) (\d+)% (\d+)%\)/.exec(str); return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0]; }
export function mix(a, b, f) {
  const A = hslToRgb(...parseHsl(a)), B = hslToRgb(...parseHsl(b)), L = (x, y) => Math.round(x + (y - x) * f);
  return `rgb(${L(A[0], B[0])} ${L(A[1], B[1])} ${L(A[2], B[2])})`;
}

function hash01(nx, ny) {
  const s = Math.sin(nx * 127.1 + ny * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
const beatsAt = (t, bpm, speed) => t * ((bpm || DEMO_BPM) / 60) * (speed || 1);

// --- Scenes: ctx {nx, ny, t, pulse, level, bpm, palette, speed, image} ------
const SCENE_FNS = {
  aurora(c) {
    const p = 0.5 + 0.35 * Math.sin(c.nx * 3.1 + c.t * 0.5 * c.speed) + 0.35 * Math.cos(c.ny * 2.3 - c.t * 0.37 * c.speed);
    const [h, s, l] = samplePalette(c.palette, p);
    return [h, s, l * (0.55 + 0.45 * c.level) + c.pulse * 12];
  },
  gradient(c) {
    const [h, s, l] = samplePalette(c.palette, c.nx * 0.75 + c.ny * 0.25 + c.t * 0.02 * c.speed);
    return [h, s, 12 + l * 0.5 + c.pulse * 55];
  },
  wave(c) {
    const b = beatsAt(c.t, c.bpm, c.speed);
    const sweep = (b * 0.25) % 1;
    const band = Math.max(0, 1 - Math.abs(c.nx - sweep) * 4);
    const [h, s] = samplePalette(c.palette, (c.ny + b * 0.05) % 1);
    return [h, s, 8 + band * 72 + c.pulse * 18];
  },
  strobe(c) {
    const beat = Math.floor(beatsAt(c.t, c.bpm, c.speed));
    const [h, s] = samplePalette(c.palette, (beat * 0.137) % 1);
    return [h, s, 5 + c.pulse * 90];
  },
  ripple(c) {
    const d = Math.hypot(c.nx - 0.5, c.ny - 0.5) / 0.7071;
    const r = beatsAt(c.t, c.bpm, c.speed) % 1;
    const ring = Math.max(0, 1 - Math.abs(d - r) * 6);
    const [h, s, l] = samplePalette(c.palette, d);
    return [h, s, 8 + ring * 80 + l * 0.05];
  },
  sections(c) {
    const N = 6;
    const idx = Math.min(N - 1, Math.floor(c.nx * N));
    const beat = Math.floor(beatsAt(c.t, c.bpm, c.speed));
    const [h, s, l] = samplePalette(c.palette, ((idx + beat) % N) / N);
    return [h, s, 18 + l * 0.25 + c.level * 25 + c.pulse * 35];
  },
  twinkle(c) {
    const seed = hash01(c.nx, c.ny);
    const phase = (seed * 13.0 + c.t * (1.2 + c.level * 2) * c.speed) % 1;
    const on = phase < 0.06 + c.level * 0.12 ? 1 : 0;
    const [h, s] = samplePalette(c.palette, seed);
    return [h, s, 6 + on * 88];
  },
  pulse(c) {
    const [h, s, l] = samplePalette(c.palette, (c.t * 0.05 * c.speed) % 1);
    return [h, s, 12 + l * 0.2 + c.level * 38 + c.pulse * 45];
  },
  // A luminous wave rolling front-to-back through the crowd (along the depth
  // axis), on tempo. Pairs with shared-audio depth — no beacons needed.
  tide(c) {
    const b = beatsAt(c.t, c.bpm, c.speed);
    const sweep = (b * 0.2) % 1;
    const band = Math.max(0, 1 - Math.abs(c.ny - sweep) * 3.5);
    const [h, s] = samplePalette(c.palette, c.ny);
    return [h, s, 8 + band * 78 + c.pulse * 14];
  },
  // Depth bands (front / mid / back) that recolor on the beat.
  depthrows(c) {
    const N = 5;
    const idx = Math.min(N - 1, Math.floor(c.ny * N));
    const beat = Math.floor(beatsAt(c.t, c.bpm, c.speed));
    const [h, s, l] = samplePalette(c.palette, ((idx + beat) % N) / N);
    return [h, s, 16 + l * 0.25 + c.level * 24 + c.pulse * 38];
  },
  // Spectrum: the crowd's color mirrors the sound — bass → red, treble → blue,
  // brightness rides the loudness, flash on the beat.
  spectrum(c) {
    const b = c.bands || { mid: 0.33, treble: 0.33 };
    const hue = (b.mid * 120 + b.treble * 235 + c.nx * 15) % 360;
    return [hue, 92, 10 + c.level * 35 + c.pulse * 45];
  },
  // Crowd-as-screen: each phone lights the cell of a low-res image at its
  // position, so the whole crowd spells text / shows a logo. Needs real
  // positions to read on a live crowd; perfect in /preview today.
  image(c) {
    const img = c.image;
    if (!img || !img.cells) return samplePalette(c.palette, c.nx);
    const cx = Math.min(img.w - 1, Math.max(0, Math.floor(c.nx * img.w)));
    const cy = Math.min(img.h - 1, Math.max(0, Math.floor(c.ny * img.h)));
    const v = img.cells[cy * img.w + cx] || 0; // 0..1 intensity
    const [h, s] = samplePalette(c.palette, c.nx); // colorize across the width
    return [h, s, 5 + v * (72 + c.pulse * 18)];
  },
};

// Scenes the auto-director cycles through (image is excluded — it needs content).
export const SCENES = ['aurora', 'gradient', 'wave', 'tide', 'spectrum', 'strobe', 'ripple', 'sections', 'depthrows', 'twinkle', 'pulse'];
export const ALL_SCENES = [...SCENES, 'image']; // everything selectable in the console

export function render(scene, palette, ctx) {
  const fn = SCENE_FNS[scene] || SCENE_FNS.pulse;
  const R = ctx.react || {};
  // Build a local frame so render() is pure — safe to call twice (for crossfades).
  const c = {
    nx: ctx.nx, ny: ctx.ny, t: ctx.t, level: ctx.level || 0, bands: ctx.bands, image: ctx.image,
    bpm: ctx.bpm, palette: palette ?? 'sunset', speed: R.speed ?? 1,
    pulse: Math.min(1.5, (ctx.pulse || 0) * (R.beat ?? 1)), // beat-punch knob
  };
  let [h, s, l] = fn(c);
  l *= R.brightness ?? 1;                                       // brightness knob
  // Dynamics: swell with the song's energy, and a synchronized white burst on a drop.
  const E = ctx.energy ?? 1, D = ctx.drop ?? 0;
  l = l * (0.45 + 0.55 * E) + D * 55;
  s = s * (1 - D * 0.85);
  return css(h, s, l);
}

// Director: directive + shared clock -> the active scene/palette. 'auto' values
// cycle on the clock so every phone agrees with no per-frame messaging.
const PHRASE_BARS = 8; // auto scenes change on a musical phrase, not a fixed timer
export function resolveScene(state, tSec, bpm) {
  if (!state) return { scene: 'aurora', palette: 'sunset' };
  const e = (state.epoch || 0) / 1000;
  const elapsed = Math.max(0, tSec - e);
  const phrase = PHRASE_BARS * 4 * (60 / (bpm || DEMO_BPM)); // seconds per phrase (tempo-relative)
  const scene = state.scene && state.scene !== 'auto'
    ? state.scene
    : SCENES[Math.floor(elapsed / phrase) % SCENES.length];
  const palette = state.palette && state.palette !== 'auto'
    ? state.palette
    : PALETTE_NAMES[Math.floor(elapsed / (phrase * 2)) % PALETTE_NAMES.length];
  return { scene, palette };
}

// Beat/idle helpers for the host demo-beat fallback drive.
export function beatEnvelope(dt, period) {
  if (dt < 0) return 0;
  const tau = Math.max(0.05, (period || 0.5) * 0.18); // snappier = reads as tighter
  return Math.exp(-dt / tau);
}
export function idleEnvelope(t) { return 0.22 + 0.16 * Math.sin(t * 1.6); }
