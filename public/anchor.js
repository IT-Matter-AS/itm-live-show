import { AUDIO, makeChirp, nextSlotEmit } from '/dsp.js';

// A positioning beacon. Clock-syncs to the server, registers its known position,
// is assigned a TDMA slot, then emits an ultrasonic chirp every cycle exactly on
// the shared clock — converting each slot's server-time emission into its own
// AudioContext timeline (same trick the host beat scheduler uses).

const $ = (id) => document.getElementById(id);
const statusEl = $('status'), slotEl = $('slot');

let offset = 0, bestRtt = Infinity;
const serverNow = () => Date.now() + offset;

const qs = new URLSearchParams(location.search);
if (qs.get('x')) $('x').value = qs.get('x');
if (qs.get('y')) $('y').value = qs.get('y');

let ws = null;
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.addEventListener('open', () => { ws.send(JSON.stringify({ type: 'host', key: qs.get('key') || '' })); syncClock(); });
  ws.addEventListener('message', (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'auth' && !m.ok) { statusEl.textContent = '⚠ locked — open this beacon from the Host link (with ?key=)'; }
    else if (m.type === 'pong') { const t1 = Date.now(), r = t1 - m.t0; if (r < bestRtt) { bestRtt = r; offset = m.ts - (m.t0 + t1) / 2; } }
    else if (m.type === 'anchor-ok') { slot = m.slot; slotEl.textContent = `slot ${slot}`; statusEl.textContent = `emitting · slot ${slot} · ±${(bestRtt / 2) | 0}ms`; statusEl.className = 'live'; }
    else if (m.type === 'anchor-full') { statusEl.textContent = 'no free slot (max beacons reached)'; }
  });
  ws.addEventListener('close', () => setTimeout(connect, 1500));
  ws.addEventListener('error', () => { try { ws.close(); } catch {} });
}
function syncClock(n = 16) {
  let i = 0;
  const tick = () => { if (!ws || ws.readyState !== 1 || i++ >= n) return; ws.send(JSON.stringify({ type: 'ping', t0: Date.now() })); setTimeout(tick, 100); };
  tick();
}
connect();

let audioCtx = null, chirpBuf = null, slot = null, scheduler = null, nextEmit = null;

$('start').addEventListener('click', async () => {
  // Create + resume the context inside the gesture (iOS).
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  await audioCtx.resume?.();

  if (!chirpBuf) {
    const samples = makeChirp(audioCtx.sampleRate);
    chirpBuf = audioCtx.createBuffer(1, samples.length, audioCtx.sampleRate);
    chirpBuf.getChannelData(0).set(samples);
  }
  const x = parseFloat($('x').value) || 0, y = parseFloat($('y').value) || 0;
  ws.send(JSON.stringify({ type: 'anchor', x, y }));
  statusEl.textContent = 'registering…';

  nextEmit = null;
  if (!scheduler) scheduler = setInterval(tickEmit, 50);
});

// Schedule the chirp for each upcoming slot emission, a little ahead of time.
function tickEmit() {
  if (slot == null || !audioCtx) return;
  const lookahead = 0.3;
  while (true) {
    if (nextEmit == null) nextEmit = nextSlotEmit(slot, serverNow());
    const audioTime = audioCtx.currentTime + (nextEmit - serverNow()) / 1000;
    if (audioTime > audioCtx.currentTime + lookahead) break;
    if (audioTime > audioCtx.currentTime + 0.005) {
      const node = audioCtx.createBufferSource();
      node.buffer = chirpBuf;
      const g = audioCtx.createGain(); g.gain.value = 0.9; // loud-ish but ultrasonic
      node.connect(g).connect(audioCtx.destination);
      node.start(audioTime);
    }
    nextEmit += AUDIO.frameMs; // same slot, next cycle
  }
}
