import { render, resolveScene, beatEnvelope, ALL_SCENES, PALETTE_NAMES } from '/show.js';
import { AudioReactor } from '/dsp.js';

// A grid of virtual phones running the EXACT scene code real phones run — the
// design studio. Every control here broadcasts a directive, so this is also the
// live director: scene, palette (presets OR custom colors), reactivity knobs,
// and crowd-images (text / shapes mapped onto the crowd by position).

const canvas = document.getElementById('grid');
const g = canvas.getContext('2d');
const label = document.getElementById('label');

const cols = 48, rows = 27;
let offset = 0, bestRtt = Infinity;
const serverNow = () => Date.now() + offset;
let state = { scene: 'auto', palette: 'auto', react: { brightness: 1, beat: 1, speed: 1 }, image: null, epoch: Date.now() };

// --- Realtime (reflect + control) ------------------------------------------
let ws = null;
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.addEventListener('open', () => { ws.send(JSON.stringify({ type: 'host' })); sync(); });
  ws.addEventListener('message', (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'pong') { const t1 = Date.now(), r = t1 - m.t0; if (r < bestRtt) { bestRtt = r; offset = m.ts - (m.t0 + t1) / 2; } }
    else if (m.type === 'scene') { state = { react: { brightness: 1, beat: 1, speed: 1 }, ...m }; syncControls(); }
  });
  ws.addEventListener('close', () => setTimeout(connect, 1500));
  ws.addEventListener('error', () => { try { ws.close(); } catch {} });
}
function sync(n = 10) {
  let i = 0;
  const tick = () => { if (!ws || ws.readyState !== 1 || i++ >= n) return; ws.send(JSON.stringify({ type: 'ping', t0: Date.now() })); setTimeout(tick, 120); };
  tick();
}
connect();

function setLook(patch) {
  state = { ...state, ...patch, epoch: Date.now() };
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'scene', scene: state.scene, palette: state.palette, react: state.react, image: state.image, epoch: state.epoch }));
  }
  syncControls();
}

// --- Build controls ---------------------------------------------------------
const sceneBtns = {}, palBtns = {};
const sceneBox = document.getElementById('scenes');
for (const s of ['auto', ...ALL_SCENES]) {
  const b = document.createElement('button'); b.textContent = s; b.onclick = () => setLook({ scene: s });
  sceneBox.appendChild(b); sceneBtns[s] = b;
}
const palBox = document.getElementById('palettes');
for (const p of ['auto', ...PALETTE_NAMES]) {
  const b = document.createElement('button'); b.textContent = p; b.onclick = () => setLook({ palette: p });
  palBox.appendChild(b); palBtns[p] = b;
}

// Custom palette from the three color pickers.
function hexToHsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255, gg = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, gg, b), min = Math.min(r, gg, b), d = max - min;
  let h = 0; const l = (max + min) / 2; const s = d ? (l > 0.5 ? d / (2 - max - min) : d / (max + min)) : 0;
  if (d) { h = max === r ? (gg - b) / d + (gg < b ? 6 : 0) : max === gg ? (b - r) / d + 2 : (r - gg) / d + 4; h *= 60; }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}
document.getElementById('useColors').onclick = () => {
  const stops = ['c1', 'c2', 'c3'].map((id) => hexToHsl(document.getElementById(id).value));
  setLook({ palette: { stops } });
};

// Reactivity knobs.
const rB = document.getElementById('rBright'), rb = document.getElementById('rBeat'), rs = document.getElementById('rSpeed');
const pushReact = () => setLook({ react: { brightness: rB.value / 100, beat: rb.value / 100, speed: rs.value / 100 } });
[rB, rb, rs].forEach((el) => el.addEventListener('input', pushReact));

// Crowd image: rasterize text / an emoji shape to a low-res intensity grid.
function rasterize(text, w = 40, h = 20) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const x = cv.getContext('2d');
  x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
  x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle';
  let fs = h; x.font = `bold ${fs}px sans-serif`;
  while (fs > 4 && x.measureText(text).width > w - 2) { fs--; x.font = `bold ${fs}px sans-serif`; }
  x.fillText(text, w / 2, h / 2 + 1);
  const d = x.getImageData(0, 0, w, h).data;
  const cells = new Array(w * h);
  for (let i = 0; i < w * h; i++) cells[i] = +(d[i * 4] / 255).toFixed(2); // red channel as intensity
  return { w, h, cells };
}
document.getElementById('showText').onclick = () => {
  const txt = (document.getElementById('imgText').value || '').trim() || 'HELLO';
  setLook({ scene: 'image', image: rasterize(txt) });
};
const presetBox = document.getElementById('presets');
for (const sym of ['❤', '★', '➤', '▲', '☺']) {
  const b = document.createElement('button'); b.textContent = sym;
  b.onclick = () => setLook({ scene: 'image', image: rasterize(sym) });
  presetBox.appendChild(b);
}

// --- Drive the crowd from the live music -----------------------------------
// Three ways, all broadcast the SAME beat feed to every phone:
//   • tap tempo      — tap the button on the beat. No permissions, works anywhere.
//   • tab/system audio — grab the music playing on this computer (clean digital
//                        feed; a "share audio" picker, not a mic grant).
//   • mic            — when this device is near the speakers.
const reactor = new AudioReactor();
let audioCtx = null, analyser = null, byteTime = null, freqData = null;
let listening = false, lastBeats = 0, lastBeatServer = 0;
let tapMode = false, tapBeat = 0, tapPeriod = 500, tapBpm = 120;
const tapTimes = [];
const capEl = document.getElementById('cap');
capEl.textContent = 'pick a source below to drive the crowd  →  tap tempo is easiest';

const markCap = (id) => ['capTab', 'capTap', 'capMic'].forEach((x) => document.getElementById(x).classList.toggle('on', x === id));
function ensureCtx() { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume?.(); return audioCtx; }

// Audio capture (tab/system or mic). The stream request is started inside the
// click (gesture), then we wire it to the analyser.
function beginCapture(streamPromise, label, id) {
  if (!streamPromise) { capEl.textContent = 'not available here — use “tap tempo”, or open at http://localhost:3000/preview'; return; }
  capEl.textContent = 'starting ' + label + '…';
  streamPromise.then((stream) => {
    if (!stream.getAudioTracks().length) { stream.getTracks().forEach((t) => t.stop()); capEl.textContent = 'no audio in that share — re-pick and tick “Share tab/system audio”'; return; }
    stream.getVideoTracks().forEach((t) => t.stop()); // display capture: ignore video
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0;
    byteTime = new Uint8Array(analyser.fftSize); freqData = new Uint8Array(analyser.frequencyBinCount);
    const mute = audioCtx.createGain(); mute.gain.value = 0;
    src.connect(analyser); analyser.connect(mute).connect(audioCtx.destination);
    listening = true; tapMode = false; markCap(id);
  }).catch((e) => {
    const n = e?.name || String(e);
    capEl.textContent = n === 'NotAllowedError' ? 'permission denied — just use “tap tempo” (no permission needed)' : 'capture error: ' + n;
  });
}
document.getElementById('capTab').onclick = () => { ensureCtx(); beginCapture(navigator.mediaDevices?.getDisplayMedia?.({ video: true, audio: true }), 'tab/system audio', 'capTab'); };
document.getElementById('capMic').onclick = () => { ensureCtx(); beginCapture(navigator.mediaDevices?.getUserMedia?.({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }), 'mic', 'capMic'); };

// Tap tempo — the no-permission path. Each tap is a beat; we median the gaps.
document.getElementById('capTap').onclick = () => {
  const now = serverNow();
  tapTimes.push(now); if (tapTimes.length > 6) tapTimes.shift();
  tapBeat = now; tapMode = true; listening = false; markCap('capTap');
  if (tapTimes.length >= 2) {
    const ivs = []; for (let i = 1; i < tapTimes.length; i++) ivs.push(tapTimes[i] - tapTimes[i - 1]);
    ivs.sort((a, b) => a - b); const med = ivs[ivs.length >> 1];
    if (med > 250 && med < 1500) { tapPeriod = med; tapBpm = Math.round(60000 / med); }
  }
};

function sampleMusic() {
  if (!analyser) return;
  analyser.getByteTimeDomainData(byteTime);
  let s = 0; for (let i = 0; i < byteTime.length; i++) { const v = (byteTime[i] - 128) / 128; s += v * v; }
  const rms = Math.sqrt(s / byteTime.length);
  analyser.getByteFrequencyData(freqData);
  reactor.update(rms, freqData, performance.now()); // spectral-flux onset detection
  if (reactor.beats > lastBeats) { lastBeats = reactor.beats; lastBeatServer = serverNow(); }
}

// Broadcast the beat feed (~5 Hz) — from audio capture or from taps.
setInterval(() => {
  if (!ws || ws.readyState !== 1) return;
  if (listening) ws.send(JSON.stringify({ type: 'music', beatAt: lastBeatServer, period: 60000 / (reactor.bpm || 120), level: reactor.level, bpm: reactor.bpm || 0 }));
  else if (tapMode) ws.send(JSON.stringify({ type: 'music', beatAt: tapBeat, period: tapPeriod, level: 0.7, bpm: tapBpm }));
}, 200);

function syncControls() {
  for (const s in sceneBtns) sceneBtns[s].classList.toggle('on', s === state.scene);
  for (const p in palBtns) palBtns[p].classList.toggle('on', p === state.palette);
  const R = state.react || {};
  if (document.activeElement !== rB) rB.value = Math.round((R.brightness ?? 1) * 100);
  if (document.activeElement !== rb) rb.value = Math.round((R.beat ?? 1) * 100);
  if (document.activeElement !== rs) rs.value = Math.round((R.speed ?? 1) * 100);
}
syncControls();

// --- Canvas render ----------------------------------------------------------
function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
}
window.addEventListener('resize', resize);
setTimeout(resize, 0);

function frame() {
  requestAnimationFrame(frame);
  if (canvas.width < 2) resize();
  const t = serverNow() / 1000;
  let pulse, level;
  if (listening) {
    sampleMusic();
    pulse = reactor.pulse; level = reactor.level;             // real captured audio
    capEl.textContent = `🎵 capturing · level ${(reactor.level * 100) | 0}% · ${reactor.bpm ? '~' + reactor.bpm + ' BPM' : '…'} → broadcasting`;
  } else if (tapMode) {
    const ph = ((serverNow() - tapBeat) % tapPeriod + tapPeriod) % tapPeriod;
    pulse = beatEnvelope(ph / 1000, tapPeriod / 1000); level = 0.7;
    capEl.textContent = `👆 tap tempo · ${tapBpm} BPM → broadcasting (tap again to re-sync)`;
  } else {
    pulse = beatEnvelope(t % 0.5, 0.5);                       // synth preview beat
    level = 0.4 + 0.3 * (0.5 + 0.5 * Math.sin(t * 0.55));
    // don't touch capEl here — it carries the idle prompt or an error message
  }

  const { scene, palette } = resolveScene(state, t);
  label.textContent = `${scene} · ${typeof palette === 'string' ? palette : 'custom'}`;

  const W = canvas.width, H = canvas.height;
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  const cw = W / cols, ch = H / rows, rad = Math.min(cw, ch) * 0.36;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const nx = (c + 0.5) / cols, ny = (r + 0.5) / rows;
      g.fillStyle = render(scene, palette, { nx, ny, t, pulse, level, bpm: 120, react: state.react, image: state.image });
      g.beginPath();
      g.arc(c * cw + cw / 2, r * ch + ch / 2, rad, 0, 6.2832);
      g.fill();
    }
  }
}
frame();
