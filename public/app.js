import { Localizer } from '/localizer.js';
import { render, resolveScene, beatEnvelope, idleEnvelope, DEMO_BPM } from '/show.js';
import { AudioReactor, AUDIO, makeChirpTemplate, locateFromFrame, calibrateOffsets, ClockFilter, PhaseLock, OneEuro, foldPhase, circMean, depthOf } from '/dsp.js';

const stage = document.getElementById('stage');
const joinPanel = document.getElementById('join');
const joinBtn = document.getElementById('joinBtn');
const statusEl = document.getElementById('status');
const meterFill = document.getElementById('meterFill');
const glowEl = document.getElementById('glow');
const toastEl = document.getElementById('toast');
const diagEl = document.getElementById('diag');

let detInfo = null, diagOn = false, lastSceneName = '', toastTimer = null;
statusEl.addEventListener('click', () => { diagOn = !diagOn; if (diagEl) diagEl.style.display = diagOn ? 'block' : 'none'; });
function showToast(txt) {
  if (!toastEl) return;
  toastEl.textContent = txt; toastEl.style.opacity = '1';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; }, 1400);
}

// Drift-corrected clock (skew-aware) — the basis of all cross-device sync.
const clock = new ClockFilter();
const serverNow = () => Date.now() + clock.offsetAt(Date.now());

// Rhythm: a shared tempo (from the server) + a per-phone phase lock to the music
// this phone hears. Nearby phones stay tight; tempo never drifts apart.
const reactor = new AudioReactor();
const phase = new PhaseLock();
let sharedBpm = null, lastBeats = 0;
let micState = 'off', micError = '';

let hostBeat = null;   // { startAt(server ms), period } — demo-beat fallback
let sceneState = null; // director directive
let musicFeed = null;  // { beatAt, period, level, at } — live capture from the visualizer
let curFeed = 'idle';  // which drive is active (for diagnostics)

// Positioning + venue.
let anchors = [], speakers = [], venue = { width: 10, height: 7 }, beaconOffsets = {};
const posFilter = new OneEuro({ minCutoff: 0.9, beta: 0.25, vmax: 4 });
let realPos = null, realConf = 0, lastFixMs = 0;
let chirpTpl = null, ring = null, ringLen = 0, headAbs = 0;
let localizer = null;

// Shared-audio co-location: this phone's beat-phase vs the crowd -> a front..back
// "depth" coordinate, used when there's no beacon fix. No setup, no extra emission.
let depthInfo = null, myPhase = null, myDepth = null;
const onsetPhases = [];
const myX = Math.random(); // stable lateral coordinate for depth-only positioning

// Calibration: open the page with ?cal=x,y (your known spot in metres) to measure
// and publish the beacons' device latencies.
const calParam = new URLSearchParams(location.search).get('cal');
let calPos = null, calSamples = 0;
if (calParam) { const [x, y] = calParam.split(',').map(Number); if (Number.isFinite(x) && Number.isFinite(y)) calPos = { x, y }; }

const realFresh = () => realPos && realConf > 0.25 && performance.now() - lastFixMs < 4000;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const wakeLabel = () => (wakeLock ? 'screen ON' : (navigator.wakeLock ? 'screen off' : 'no-wakelock'));

// --- WebSocket -------------------------------------------------------------
let ws = null;
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.addEventListener('open', () => { ws.send(JSON.stringify({ type: 'hello' })); burstPing(); });
  ws.addEventListener('message', onMessage);
  ws.addEventListener('close', () => setTimeout(connect, 1500));
  ws.addEventListener('error', () => { try { ws.close(); } catch {} });
}
function onMessage(e) {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m.type === 'pong') clock.add(m.t0, m.ts, Date.now());
  else if (m.type === 'tempo') { sharedBpm = m.bpm; phase.setBpm(m.bpm); }
  else if (m.type === 'show') hostBeat = { startAt: m.startAt, period: 60 / (m.bpm || DEMO_BPM) };
  else if (m.type === 'stop') hostBeat = null;
  else if (m.type === 'scene') sceneState = m;
  else if (m.type === 'anchors') {
    anchors = m.list || [];
    if (m.venue) venue = m.venue;
    if (m.speakers) speakers = m.speakers;
    if (m.offsets) beaconOffsets = m.offsets;
  } else if (m.type === 'depth') depthInfo = m;
  else if (m.type === 'music') musicFeed = { beatAt: m.beatAt, period: m.period, level: m.level, at: Date.now() };
}
function ping() { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping', t0: Date.now() })); }
function burstPing(n = 12) { let i = 0; const tick = () => { if (i++ >= n) return; ping(); setTimeout(tick, 120); }; tick(); }
setInterval(ping, 3000);  // steady pinging keeps the skew estimate fresh
setInterval(() => { if (reactor.bpm && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'bpm', bpm: reactor.bpm })); }, 2500);
// Report our beat-phase for crowd depth — sampled (server sets the rate) so 80k
// phones don't flood the channel.
setInterval(() => {
  if (micState === 'listening' && myPhase != null && ws && ws.readyState === 1 && Math.random() < (depthInfo?.sample ?? 1)) {
    ws.send(JSON.stringify({ type: 'phase', p: myPhase }));
  }
}, 2000);
connect();

// --- Wake lock -------------------------------------------------------------
let wakeLock = null;
async function keepAwake() {
  try { wakeLock = (await navigator.wakeLock?.request('screen')) || null; wakeLock?.addEventListener?.('release', () => { wakeLock = null; }); }
  catch { wakeLock = null; }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && micState !== 'off' && !wakeLock) keepAwake(); });

// --- Audio (iOS-safe context handling) -------------------------------------
let audioCtx = null, analyser = null, byteTime = null, freqData = null;
function ensureCtx() { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state !== 'running') audioCtx.resume?.(); return audioCtx; }
['touchend', 'pointerdown', 'click'].forEach((ev) => document.addEventListener(ev, () => { if (audioCtx && audioCtx.state !== 'running') audioCtx.resume?.(); }, { passive: true }));

async function startListening() {
  ensureCtx();
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
  catch (e1) { try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e2) { micState = 'denied'; micError = e2?.name || e1?.name || 'error'; return; } }
  try {
    ensureCtx();
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0;
    byteTime = new Uint8Array(analyser.fftSize); freqData = new Uint8Array(analyser.frequencyBinCount);
    const mute = audioCtx.createGain(); mute.gain.value = 0;
    src.connect(analyser); analyser.connect(mute).connect(audioCtx.destination);
    micState = 'listening';
    try { // positioning capture (best-effort)
      await audioCtx.audioWorklet.addModule('/mic-worklet.js');
      const cap = new AudioWorkletNode(audioCtx, 'mic-capture');
      ringLen = Math.ceil(audioCtx.sampleRate * 1.4); ring = new Float32Array(ringLen);
      chirpTpl = makeChirpTemplate(audioCtx.sampleRate);
      cap.port.onmessage = (ev) => appendBlock(ev.data.base, ev.data.samples);
      const sink2 = audioCtx.createGain(); sink2.gain.value = 0;
      src.connect(cap); cap.connect(sink2).connect(audioCtx.destination);
    } catch { /* worklet unavailable; positioning stays simulated */ }
  } catch (e) { micState = 'denied'; micError = e?.name || 'graph'; }
}

function sampleAudio() {
  if (!analyser) return;
  if (audioCtx && audioCtx.state !== 'running') audioCtx.resume?.();
  analyser.getByteTimeDomainData(byteTime);
  let s = 0; for (let i = 0; i < byteTime.length; i++) { const v = (byteTime[i] - 128) / 128; s += v * v; }
  const rms = Math.sqrt(s / byteTime.length);
  analyser.getByteFrequencyData(freqData);
  reactor.update(rms, freqData, performance.now()); // spectral-flux onset detection
  phase.setBpm(sharedBpm || reactor.bpm || DEMO_BPM);
  if (reactor.beats > lastBeats) { lastBeats = reactor.beats; onOnset(); }
}

// Each detected beat feeds the phase lock. If we know our position and the
// speaker layout, subtract the sound's travel time so we lock to the SOURCE beat
// — making the whole crowd flash together regardless of distance to the PA.
function onOnset() {
  let t = serverNow() / 1000;
  if (realFresh() && speakers.length) {
    let d = Infinity;
    for (const sp of speakers) d = Math.min(d, Math.hypot(realPos.x - sp.x, realPos.y - sp.y));
    if (Number.isFinite(d)) t -= d / 343;
  }
  phase.onset(t);

  // Shared-audio depth: record this onset's phase against the global beat grid.
  const period = depthInfo?.period || 60000 / (sharedBpm || DEMO_BPM);
  onsetPhases.push(foldPhase(serverNow(), period));
  if (onsetPhases.length > 6) onsetPhases.shift();
  myPhase = circMean(onsetPhases, period);
}

// Rolling capture buffer for chirp detection.
function appendBlock(base, samples) {
  if (!ring) return;
  const n = samples.length;
  if (n >= ringLen) { ring.set(samples.subarray(n - ringLen)); headAbs = base + n - 1; return; }
  ring.copyWithin(0, n);
  ring.set(samples, ringLen - n);
  headAbs = base + n - 1;
}

function detectPosition() {
  if (!ring || !chirpTpl || !audioCtx || anchors.length < 3) return;
  const sr = audioCtx.sampleRate;
  const frameStartServer = (Math.floor(serverNow() / AUDIO.frameMs) - 1) * AUDIO.frameMs;
  const audioTimeFor = audioCtx.currentTime + ((frameStartServer - clock.offsetAt(Date.now())) - Date.now()) / 1000;
  const frameStartRing = Math.round(audioTimeFor * sr) - headAbs + (ringLen - 1);
  if (frameStartRing < 0 || frameStartRing >= ringLen) return;
  const maxPropM = Math.hypot(venue.width, venue.height) + 1;
  const res = locateFromFrame(ring, sr, chirpTpl, frameStartRing, anchors, AUDIO.slotMs, { maxPropM, minSnr: 5, offsets: beaconOffsets, hint: realPos });
  detInfo = res; // keep for the diagnostics overlay (even low-confidence attempts)
  if (!res.pos || res.conf <= 0.25) return;
  realPos = posFilter.update(res.pos, performance.now() / 1000); // adaptive smoothing for movers
  realConf = res.conf; lastFixMs = performance.now();

  if (calPos && res.conf > 0.45 && res.arrivals.length >= 3 && ++calSamples >= 4) {
    const bySlot = {}; anchors.forEach((a) => { bySlot[a.slot] = { x: a.x, y: a.y }; });
    const offs = calibrateOffsets(res.arrivals, calPos, bySlot, sr, AUDIO.slotMs);
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'calib', offsets: offs }));
    calPos = null;
  }
}
setInterval(detectPosition, 300);

// --- Join ------------------------------------------------------------------
joinBtn.addEventListener('click', () => {
  joinPanel.style.display = 'none';
  ensureCtx();
  keepAwake();
  localizer = new Localizer();
  for (let k = 0; k < 5; k++) localizer.fix();
  startListening();
  requestAnimationFrame(loop);
});

// --- Render loop -----------------------------------------------------------
function loop() {
  requestAnimationFrame(loop);
  sampleAudio();
  const t = serverNow() / 1000;

  // Position priority: a fresh beacon fix, else shared-audio depth, else simulated.
  myDepth = (depthInfo?.ok && myPhase != null) ? depthOf(myPhase, depthInfo.lead, depthInfo.spread, depthInfo.period) : null;
  const rf = realFresh();
  let norm, posSrc;
  if (rf) { norm = { nx: clamp01(realPos.x / venue.width), ny: clamp01(realPos.y / venue.height) }; posSrc = 'ACOUSTIC'; }
  else if (myDepth != null) { norm = { nx: myX, ny: myDepth }; posSrc = 'DEPTH'; }
  else { norm = localizer?.normalized(); posSrc = 'sim'; }
  if (!norm) return;

  // The reactor follows the music's ACTUAL transients — the robust primary
  // driver that tracks the song on every device (iPhone included). The phase
  // lock / shared tempo only inform scene motion speed (bpm), never the flash.
  // When the room goes quiet (level below the gate) we fade to a calm idle
  // breathing instead of flashing on noise.
  // Drive priority: the visualizer's central capture (whole crowd in unison) >
  // this phone's own mic > host demo beat > calm idle. Each is level-gated so a
  // silent room fades to idle instead of flashing.
  const musicFresh = musicFeed && Date.now() - musicFeed.at < 3000 && musicFeed.level > 0.06;
  const hearingMusic = micState === 'listening' && reactor.level > 0.06;
  let pulse, level;
  if (musicFresh) {
    const ph = ((serverNow() - musicFeed.beatAt) % musicFeed.period + musicFeed.period) % musicFeed.period;
    pulse = beatEnvelope(ph / 1000, musicFeed.period / 1000); level = musicFeed.level; curFeed = 'central';
  } else if (hearingMusic) {
    pulse = reactor.pulse; level = reactor.level; curFeed = 'mic';
  } else if (hostBeat) {
    const dt = (serverNow() - hostBeat.startAt) / 1000;
    const ph = ((dt % hostBeat.period) + hostBeat.period) % hostBeat.period;
    pulse = dt >= 0 ? beatEnvelope(ph, hostBeat.period) : 0; level = 0.45; curFeed = 'host';
  } else {
    pulse = 0; level = idleEnvelope(t); curFeed = 'idle'; // silence -> gentle breathing
  }

  const { scene, palette } = resolveScene(sceneState, t);
  stage.style.backgroundColor = render(scene, palette, {
    nx: norm.nx, ny: norm.ny, t, pulse, level,
    bpm: sharedBpm || reactor.bpm || DEMO_BPM, react: sceneState?.react, image: sceneState?.image,
  });
  if (meterFill) meterFill.style.width = `${Math.round(reactor.level * 100)}%`;
  if (glowEl) glowEl.style.opacity = String(Math.min(0.55, pulse * 0.5)); // beat bloom
  if (scene !== lastSceneName) { lastSceneName = scene; showToast(`✨ ${scene}`); }
  if (diagOn && diagEl) diagEl.textContent = diagText();

  const q = clock.quality(Date.now());
  const micTxt = micState === 'listening'
    ? `mic ${audioCtx?.state || '?'} ${(sharedBpm || reactor.bpm) ? '~' + (sharedBpm || reactor.bpm) + 'bpm' : ''}`
    : (micState === 'denied' ? `mic FAILED (${micError})` : 'mic —');
  const palLabel = typeof palette === 'string' ? palette : 'custom';
  const posTxt = calPos ? `CALIBRATING @${calPos.x},${calPos.y}`
    : posSrc === 'ACOUSTIC' ? `pos ACOUSTIC ${(realConf * 100) | 0}%`
    : posSrc === 'DEPTH' ? `pos DEPTH ${(myDepth * 100) | 0}%`
    : `pos sim (${anchors.length}/3 beacons)`;
  statusEl.textContent =
    `${micTxt}  lvl ${(reactor.level * 100) | 0}%\n${scene} · ${palLabel}   ${posTxt}\n${wakeLabel()}   clk ±${Number.isFinite(q) ? (q | 0) : '?'}ms   (tap for details)`;
}

// Detailed diagnostics overlay — toggled by tapping the status line. Makes the
// first real-hardware tuning session easy to read right on the phone.
function diagText() {
  const q = clock.quality(Date.now());
  const rf = realFresh();
  const L = [];
  L.push(`mic    : ${micState}${micState === 'listening' ? ' (' + (audioCtx?.state || '?') + ')' : ''}${micError ? ' [' + micError + ']' : ''}`);
  L.push(`audio  : level ${(reactor.level * 100) | 0}%  pulse ${(reactor.pulse * 100) | 0}%`);
  L.push(`drive  : ${curFeed}${curFeed === 'central' ? ' (visualizer feed)' : ''}`);
  L.push(`tempo  : local ${reactor.bpm || '-'}  shared ${sharedBpm || '-'} bpm`);
  L.push(`clock  : ±${Number.isFinite(q) ? (q | 0) : '?'} ms`);
  L.push(`pos    : ${calPos ? 'CALIBRATING' : (rf ? 'ACOUSTIC' : 'sim')}  conf ${(realConf * 100) | 0}%`);
  if (realPos) L.push(`         (${realPos.x.toFixed(1)}, ${realPos.y.toFixed(1)}) m  in ${venue.width}x${venue.height}`);
  L.push(`field  : ${anchors.length} beacons · ${speakers.length} speakers`);
  L.push(`depth  : ${myDepth != null ? (myDepth * 100 | 0) + '% front..back' : '—'}  crowd ${depthInfo?.ok ? 'spread ' + (depthInfo.spread | 0) + 'ms' : 'n/a'}`);
  if (detInfo && detInfo.arrivals && detInfo.arrivals.length) {
    for (const a of detInfo.arrivals) L.push(`  beacon slot ${a.slot}: SNR ${a.snr.toFixed(1)}`);
  }
  if (!rf) { // explain why there's no acoustic fix, and what to do
    if (anchors.length < 3) L.push(`  -> positioning off: open /anchor on ${3 - anchors.length} more device(s)`);
    else L.push('  -> beacons set up but not heard: raise volume / move closer');
  }
  L.push('(tap to hide)');
  return L.join('\n');
}
