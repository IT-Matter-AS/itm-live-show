import { DEMO_BPM } from '/show.js';

const $ = (id) => document.getElementById(id);
const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';

let offset = 0;                 // serverTime ≈ Date.now() + offset
let bestRtt = Infinity;
const serverNow = () => Date.now() + offset;

// --- QR + join URL ---------------------------------------------------------
(async () => {
  let joinUrl = location.origin + '/';
  try {
    const info = await fetch('/info').then((r) => r.json());
    if (info?.joinUrl) joinUrl = info.joinUrl;
  } catch {}
  $('qr').src = '/qr.svg?data=' + encodeURIComponent(joinUrl);
  $('url').textContent = joinUrl;
})();

// --- WebSocket: clock sync, head count, show triggers ----------------------
const ws = new WebSocket(`${wsProto}://${location.host}`);
ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ type: 'host' }));
  syncClock();
});
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'pong') {
    const t1 = Date.now(), rtt = t1 - msg.t0;
    if (rtt < bestRtt) { bestRtt = rtt; offset = msg.ts - (msg.t0 + t1) / 2; }
  } else if (msg.type === 'count') {
    $('count').textContent = msg.n;
  } else if (msg.type === 'show') {
    startAudio(msg.startAt, msg.bpm || DEMO_BPM);   // optional demo beat for testing
  } else if (msg.type === 'stop') {
    stopAudio();
  }
});
function syncClock(samples = 12) {
  let i = 0;
  const tick = () => {
    if (ws.readyState !== WebSocket.OPEN || i++ >= samples) return;
    ws.send(JSON.stringify({ type: 'ping', t0: Date.now() }));
    setTimeout(tick, 120);
  };
  tick();
}

// --- Controls --------------------------------------------------------------
$('start').onclick = () => { ensureAudio(); ws.send(JSON.stringify({ type: 'start', name: 'wave' })); };
$('stop').onclick = () => ws.send(JSON.stringify({ type: 'stop' }));

// --- Web Audio beat engine -------------------------------------------------
// The host plays a beat locked to the SAME server clock the phones use, so the
// crowd's lights flash exactly on the beat they hear. Beats are scheduled in
// the AudioContext timeline via a short look-ahead window.
let audioCtx = null, noiseBuf = null;
let scheduler = null, showStartServer = null, bpm = DEMO_BPM, nextBeat = 0;

function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const len = Math.floor(audioCtx.sampleRate * 0.2);
    noiseBuf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  audioCtx.resume?.();
}

function kick(t, gain) {
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.frequency.setValueAtTime(160, t);
  o.frequency.exponentialRampToValueAtTime(55, t + 0.12);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
  o.connect(g).connect(audioCtx.destination);
  o.start(t); o.stop(t + 0.2);
}
function hat(t, gain) {
  const s = audioCtx.createBufferSource(), hp = audioCtx.createBiquadFilter(), g = audioCtx.createGain();
  s.buffer = noiseBuf; hp.type = 'highpass'; hp.frequency.value = 7000;
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
  s.connect(hp).connect(g).connect(audioCtx.destination);
  s.start(t); s.stop(t + 0.05);
}
function bass(t, gain) {
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = 'triangle'; o.frequency.value = 110;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
  o.connect(g).connect(audioCtx.destination);
  o.start(t); o.stop(t + 0.25);
}

function startAudio(startAtServer, theBpm) {
  ensureAudio();
  showStartServer = startAtServer;
  bpm = theBpm;
  const beatLen = 60 / bpm;
  const elapsed = (serverNow() - showStartServer) / 1000;
  nextBeat = Math.max(0, Math.ceil(elapsed / beatLen)); // don't replay past beats
  if (scheduler) clearInterval(scheduler);
  scheduler = setInterval(tickScheduler, 80);
}
function stopAudio() {
  if (scheduler) { clearInterval(scheduler); scheduler = null; }
  showStartServer = null;
}
function tickScheduler() {
  if (showStartServer == null || !audioCtx) return;
  const beatLen = 60 / bpm;
  const lookahead = 0.25;                      // seconds of audio scheduled ahead
  const cNow = audioCtx.currentTime, sNow = serverNow();
  while (true) {
    const beatServerMs = showStartServer + nextBeat * beatLen * 1000;
    const audioTime = cNow + (beatServerMs - sNow) / 1000; // server ms -> audio sec
    if (audioTime > cNow + lookahead) break;
    if (audioTime >= cNow - 0.05) {            // skip beats already missed
      const inBar = nextBeat % 4;
      kick(audioTime, inBar === 0 ? 0.9 : 0.6);
      hat(audioTime + beatLen / 2, 0.18);      // off-beat hat for groove
      if (inBar === 0) bass(audioTime, 0.5);
    }
    nextBeat++;
  }
}
