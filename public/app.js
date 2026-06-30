import { Localizer } from '/localizer.js';
import { render, resolveScene, beatEnvelope, idleEnvelope, mix, DEMO_BPM } from '/show.js';
import { AudioReactor, AUDIO, DETECT_LATENCY_MS, makeChirpTemplate, locateFromFrame, calibrateOffsets, ClockFilter, PhaseLock, OneEuro, foldPhase, circMean, depthOf } from '/dsp.js';

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
let lastOnsetMs = 0;   // performance.now() of the last detected onset
// crossfade between looks
let curScene = null, curPalette = null, curLookKey = null, prevScene = null, prevPalette = null, lookChangeAt = 0, hadPrev = false;
// photosensitivity safety: slew-limited flash
let dispPulse = 0, dispDrop = 0, lastFrameMs = 0;
// battery-aware power save (Android; no-op where the Battery API is absent)
let powerSave = false, psToggle = false;

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
  else if (m.type === 'music') musicFeed = { beatAt: m.beatAt, period: m.period, level: m.level, energy: m.energy, drop: m.drop, bands: m.bands, section: m.section, at: Date.now() };
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
// On low battery (and not charging), drop to power-save (half frame rate, dimmer).
// Battery API is Android-only; elsewhere this stays off.
navigator.getBattery?.().then((b) => {
  const upd = () => { powerSave = b.level < 0.2 && !b.charging; };
  b.addEventListener('levelchange', upd); b.addEventListener('chargingchange', upd); upd();
}).catch(() => {});

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
  lastOnsetMs = performance.now();
  const trueMs = serverNow() - DETECT_LATENCY_MS; // align to the true audio beat
  let t = trueMs / 1000;
  if (realFresh() && speakers.length) {
    let d = Infinity;
    for (const sp of speakers) d = Math.min(d, Math.hypot(realPos.x - sp.x, realPos.y - sp.y));
    if (Number.isFinite(d)) t -= d / 343;
  }
  phase.onset(t);

  // Shared-audio depth: record this onset's phase against the global beat grid.
  const period = depthInfo?.period || 60000 / (sharedBpm || DEMO_BPM);
  onsetPhases.push(foldPhase(trueMs, period));
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
// Analyse audio on a fixed fast clock, independent of the render frame rate — so
// beat timing stays tight even if rendering hitches.
setInterval(() => { if (analyser) sampleAudio(); }, 11);

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
  if (powerSave) { psToggle = !psToggle; if (psToggle) return; } // ~30fps to save battery
  const t = serverNow() / 1000;

  const musicFresh = musicFeed && Date.now() - musicFeed.at < 3000 && (musicFeed.active ?? 0) > 0.3;
  const hearingMusic = micState === 'listening' && reactor.active > 0.3;
  const silent = !musicFresh && !hearingMusic && !hostBeat; // no music anywhere
  if (meterFill) meterFill.style.width = `${Math.round(reactor.level * 100)}%`;

  // When the music stops, drop to a calm idle: dim, slow breath, NO scene motion
  // (scene sweeps/rotations are clock-driven, so we must not run them when quiet).
  if (silent) {
    curFeed = 'idle';
    const b = 7 + 5 * (0.5 + 0.5 * Math.sin(t * 0.7));
    stage.style.backgroundColor = `hsl(258 45% ${b.toFixed(1)}%)`;
    if (glowEl) glowEl.style.opacity = '0';
    if (diagOn && diagEl) diagEl.textContent = diagText();
    const q0 = clock.quality(Date.now());
    const m0 = micState === 'listening' ? 'mic ' + (audioCtx?.state || '?') : (micState === 'denied' ? 'mic FAILED' : 'mic —');
    statusEl.textContent = `${m0}  lvl ${(reactor.level * 100) | 0}%\nidle · quiet — waiting for music\n${wakeLabel()}   clk ±${Number.isFinite(q0) ? (q0 | 0) : '?'}ms   (tap for details)`;
    return;
  }

  // Position priority: a fresh beacon fix, else shared-audio depth, else simulated.
  myDepth = (depthInfo?.ok && myPhase != null) ? depthOf(myPhase, depthInfo.lead, depthInfo.spread, depthInfo.period) : null;
  const rf = realFresh();
  let norm, posSrc;
  if (rf) { norm = { nx: clamp01(realPos.x / venue.width), ny: clamp01(realPos.y / venue.height) }; posSrc = 'ACOUSTIC'; }
  else if (myDepth != null) { norm = { nx: myX, ny: myDepth }; posSrc = 'DEPTH'; }
  else { norm = localizer?.normalized(); posSrc = 'sim'; }
  if (!norm) return;

  // Drive: central capture (predictive, unison) > own mic (predictive when a
  // confident tempo lock exists — anticipates the beat with no detection lag —
  // else reactive) > host demo beat.
  let pulse, level, energy = 1, drop = 0, bands = null;
  if (musicFresh) {
    const ph = ((serverNow() - musicFeed.beatAt) % musicFeed.period + musicFeed.period) % musicFeed.period;
    pulse = beatEnvelope(ph / 1000, musicFeed.period / 1000); level = musicFeed.level;
    energy = musicFeed.energy ?? 1; drop = musicFeed.drop ?? 0; bands = musicFeed.bands; curFeed = 'central';
  } else if (hearingMusic) {
    const sb = phase.sinceBeat(t);
    const locked = reactor.bpm && performance.now() - lastOnsetMs < 1500 && sb != null;
    pulse = locked ? beatEnvelope(sb, phase.period) : reactor.pulse;
    level = reactor.level; energy = reactor.energy; drop = reactor.drop; bands = reactor.bands;
    curFeed = locked ? 'mic·lock' : 'mic';
  } else {
    const dt = (serverNow() - hostBeat.startAt) / 1000;
    const ph = ((dt % hostBeat.period) + hostBeat.period) % hostBeat.period;
    pulse = dt >= 0 ? beatEnvelope(ph, hostBeat.period) : 0; level = 0.45; energy = 0.85; curFeed = 'host';
  }

  // Photosensitivity safety: slew-limit the flash so it can't exceed ~3/sec or
  // hard-cut to white, and cap the drop burst. Default on; director can set 'full'.
  const nowP = performance.now();
  const fdt = Math.min(100, nowP - (lastFrameMs || nowP)); lastFrameMs = nowP;
  const safe = (sceneState?.safety ?? 'safe') === 'safe';
  const rise = safe ? fdt / 130 : 1;                 // a flash takes >=130ms to rise in safe mode
  const tgtDrop = safe ? Math.min(drop, 0.35) : drop;
  dispPulse += pulse > dispPulse ? Math.min(pulse - dispPulse, rise) : pulse - dispPulse;
  dispDrop += tgtDrop > dispDrop ? Math.min(tgtDrop - dispDrop, rise) : tgtDrop - dispDrop;

  const bpmNow = sharedBpm || reactor.bpm || DEMO_BPM;
  const section = musicFresh ? musicFeed.section : reactor.section; // song structure -> director
  const { scene, palette } = resolveScene(sceneState, t, bpmNow, section);
  // Smooth crossfade when the look changes (musical transitions).
  const lookKey = scene + '|' + (typeof palette === 'string' ? palette : 'custom');
  if (lookKey !== curLookKey) {
    prevScene = curScene; prevPalette = curPalette; hadPrev = curLookKey != null;
    lookChangeAt = performance.now(); curScene = scene; curPalette = palette; curLookKey = lookKey;
  }
  const ctx = { nx: norm.nx, ny: norm.ny, t, pulse: dispPulse, level, bpm: bpmNow, react: sceneState?.react, image: sceneState?.image, energy: powerSave ? energy * 0.7 : energy, drop: dispDrop, bands };
  let color = render(curScene, curPalette, ctx);
  const fade = (performance.now() - lookChangeAt) / 700;
  if (hadPrev && fade < 1) color = mix(render(prevScene, prevPalette, ctx), color, fade);
  stage.style.backgroundColor = color;
  if (glowEl) glowEl.style.opacity = String(Math.min(0.6, dispPulse * 0.5 + dispDrop * 0.5)); // bloom
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
  L.push(`audio  : level ${(reactor.level * 100) | 0}%  pulse ${(reactor.pulse * 100) | 0}%  active ${(reactor.active * 100) | 0}%`);
  L.push(`feel   : energy ${(reactor.energy * 100) | 0}%  drop ${(reactor.drop * 100) | 0}%  b/m/t ${(reactor.bands.bass * 100) | 0}/${(reactor.bands.mid * 100) | 0}/${(reactor.bands.treble * 100) | 0}`);
  L.push(`struct : ${reactor.section}  downbeat=slot${reactor.downbeatSlot}${powerSave ? '  [power-save]' : ''}`);
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
