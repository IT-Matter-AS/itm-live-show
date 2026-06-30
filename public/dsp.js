// Shared signal-processing core. Pure functions + small stateful helpers, no DOM
// — so it runs identically in the browser and under Node for tests.

export const SPEED_OF_SOUND = 343; // m/s
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Estimated end-to-end detection latency (analyser window + processing). We
// timestamp beats this much EARLIER so the predicted beat grid lands on the true
// audio beat instead of trailing it — the single biggest "tightness" lever.
export const DETECT_LATENCY_MS = 25;

// Audio parameters shared by emitters (beacons) and listeners (phones).
export const AUDIO = {
  // Near-ultrasonic chirp band: mostly inaudible to adults, within phone
  // speaker+mic range, and well above where music/voice energy lives.
  f0: 17000,
  f1: 20000,
  chirpMs: 12,
  // TDMA schedule for positioning beacons: one cycle = frameMs, each beacon owns
  // a slot. slotMs must exceed chirp + propagation + clock-sync slack so a slot's
  // chirp can't be confused with its neighbour's (≈5 beacons fit per cycle here).
  frameMs: 600,
  slotMs: 120,
};

// ---------------------------------------------------------------------------
// Matched-filter chirp tools (used by the optional beacon positioning layer).
// ---------------------------------------------------------------------------

// A Hann-windowed linear chirp, normalized to unit energy so cross-correlation
// scores are comparable across signals.
export function makeChirp(sampleRate, f0 = AUDIO.f0, f1 = AUDIO.f1, durSec = AUDIO.chirpMs / 1000) {
  const n = Math.round(sampleRate * durSec);
  const out = new Float32Array(n);
  const k = (f1 - f0) / durSec;
  let energy = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const phase = 2 * Math.PI * (f0 * t + 0.5 * k * t * t);
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)); // Hann
    const s = w * Math.cos(phase);
    out[i] = s;
    energy += s * s;
  }
  const norm = 1 / Math.sqrt(energy || 1);
  for (let i = 0; i < n; i++) out[i] *= norm;
  return out;
}

// A *complex* (analytic) matched-filter template: in-phase (cos) and quadrature
// (sin) copies of the chirp. Correlating against both and taking the magnitude
// yields the smooth correlation ENVELOPE — free of the carrier oscillation a
// real template produces — so peak timing and sub-sample interpolation are
// well-posed. Use this for detection; use makeChirp() for the emitted signal.
export function makeChirpTemplate(sampleRate, f0 = AUDIO.f0, f1 = AUDIO.f1, durSec = AUDIO.chirpMs / 1000) {
  const n = Math.round(sampleRate * durSec);
  const I = new Float32Array(n), Q = new Float32Array(n);
  const k = (f1 - f0) / durSec;
  let energy = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const phase = 2 * Math.PI * (f0 * t + 0.5 * k * t * t);
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const ci = w * Math.cos(phase), cq = w * Math.sin(phase);
    I[i] = ci; Q[i] = cq;
    energy += ci * ci + cq * cq;
  }
  const norm = 1 / Math.sqrt(energy || 1);
  for (let i = 0; i < n; i++) { I[i] *= norm; Q[i] *= norm; }
  return { I, Q, length: n };
}

// Slide the analytic `tpl` across signal[from..to] and return the DIRECT-PATH
// arrival: { index (sub-sample), score (envelope peak), snr }. We take the first
// envelope peak above half the global max — reverberation arrives later and must
// not win, even when noise briefly makes a reflection the global maximum.
export function findChirp(signal, tpl, from = 0, to = signal.length) {
  const m = tpl.length;
  from = Math.max(0, from | 0);
  to = Math.min(signal.length - m, to | 0);
  if (to < from) return { index: -1, score: 0, snr: 0 };

  const env = new Float32Array(to - from + 1);
  let gMax = 0, gK = 0;
  for (let i = from; i <= to; i++) {
    let di = 0, dq = 0;
    for (let j = 0; j < m; j++) { const s = signal[i + j]; di += s * tpl.I[j]; dq += s * tpl.Q[j]; }
    const mag = Math.sqrt(di * di + dq * dq);
    env[i - from] = mag;
    if (mag > gMax) { gMax = mag; gK = i - from; }
  }

  // Noise floor: RMS of the envelope away from the global peak's main lobe.
  let sq = 0, cnt = 0;
  for (let k = 0; k < env.length; k++) { if (Math.abs(k - gK) <= m) continue; sq += env[k] * env[k]; cnt++; }
  const floor = Math.sqrt(sq / Math.max(1, cnt)) || 1e-12;
  const snr = gMax / floor;

  // Direct path = earliest envelope crest >= 0.6*gMax at or before the global
  // peak. Anchoring on the global max stops noise from triggering an early false
  // peak; walking back from it recovers the leading edge when a later reflection
  // happens to be the strongest return.
  const thr = 0.6 * gMax;
  let pk = gK;
  for (let k = 0; k <= gK; k++) {
    if (env[k] >= thr) { let kk = k; while (kk < gK && env[kk + 1] >= env[kk]) kk++; pk = kk; break; }
  }

  // Parabolic sub-sample refinement on the smooth envelope.
  let index = from + pk;
  if (pk > 0 && pk < env.length - 1) {
    const yl = env[pk - 1], yc = env[pk], yr = env[pk + 1];
    const denom = yl - 2 * yc + yr;
    if (denom !== 0) index = from + pk + (0.5 * (yl - yr)) / denom;
  }
  return { index, score: gMax, snr };
}

// Next emit time (server ms) for a beacon's TDMA slot, aligned to a global grid
// derived purely from the shared clock — so beacons need no explicit "start".
export function nextSlotEmit(slot, serverNowMs, frameMs = AUDIO.frameMs, slotMs = AUDIO.slotMs) {
  const off = slot * slotMs;
  const k = Math.ceil((serverNowMs - off) / frameMs);
  return k * frameMs + off;
}

// Solve a 2D position from TDOA relative to speaker[0] via Gauss-Newton least
// squares. tdoa[i] = arrival(speaker i) - arrival(speaker 0), seconds.
// Residual r_i = (|p - s_i| - |p - s_0|) / c - tdoa[i], minimized over p.
export function solveTDOA(speakers, tdoa, guess) {
  let p = { ...guess };
  for (let iter = 0; iter < 40; iter++) {
    const d0 = dist(p, speakers[0]) || 1e-6;
    const g0 = { x: (p.x - speakers[0].x) / d0, y: (p.y - speakers[0].y) / d0 };
    const JtJ = [[0, 0], [0, 0]];
    const Jtr = [0, 0];
    for (let i = 1; i < speakers.length; i++) {
      const di = dist(p, speakers[i]) || 1e-6;
      const gi = { x: (p.x - speakers[i].x) / di, y: (p.y - speakers[i].y) / di };
      const J = { x: (gi.x - g0.x) / SPEED_OF_SOUND, y: (gi.y - g0.y) / SPEED_OF_SOUND };
      const r = (di - d0) / SPEED_OF_SOUND - tdoa[i];
      JtJ[0][0] += J.x * J.x; JtJ[0][1] += J.x * J.y;
      JtJ[1][0] += J.y * J.x; JtJ[1][1] += J.y * J.y;
      Jtr[0] += J.x * r;      Jtr[1] += J.y * r;
    }
    const det = JtJ[0][0] * JtJ[1][1] - JtJ[0][1] * JtJ[1][0];
    if (Math.abs(det) < 1e-12) break;
    const b0 = -Jtr[0], b1 = -Jtr[1]; // solve JtJ * delta = -Jtr
    const dx = (b0 * JtJ[1][1] - JtJ[0][1] * b1) / det;
    const dy = (JtJ[0][0] * b1 - JtJ[1][0] * b0) / det;
    p = { x: p.x + dx, y: p.y + dy };
    if (Math.hypot(dx, dy) < 1e-3) break;
  }
  return p;
}

// Locate the phone from one TDMA frame of captured audio. The buffer holds the
// recent mic signal; `frameStartSample` is where slot 0's emission is expected
// (from the synced clock — only approximate). We find the reference beacon
// (slot 0) in a wide window to absorb clock-sync error, then find the others in
// tight windows RELATIVE to it (their slot spacing is exact and clock-free), so
// only the reference placement is sensitive to the absolute clock. TDOA of the
// arrivals -> position. Returns { pos, conf, used }.
export function locateFromFrame(buf, sr, tpl, frameStartSample, anchors, slotMs, opts = {}) {
  const off = opts.offsets || {};            // per-beacon emit-latency correction (s)
  const minSnr = opts.minSnr ?? 5;
  const maxPropM = opts.maxPropM ?? 60;
  const slotSamp = (slotMs / 1000) * sr;
  const maxProp = (maxPropM / SPEED_OF_SOUND) * sr;
  const wide = 0.06 * sr, tight = 0.03 * sr;
  if (!anchors || anchors.length < 3) return { pos: null, conf: 0, used: [] };

  // Group beacons by slot. In a big venue a slot is REUSED by far-apart beacons
  // (cellular-style frequency reuse); a phone only hears the nearest one per slot.
  const bySlot = new Map();
  for (const a of anchors) { if (!bySlot.has(a.slot)) bySlot.set(a.slot, []); bySlot.get(a.slot).push(a); }
  const slots = [...bySlot.keys()].sort((x, y) => x - y);
  if (slots.length < 3) return { pos: null, conf: 0, used: [] };
  const refSlot = slots[0];

  // One arrival per slot: reference in a wide window (absorbs clock-sync error),
  // the rest in tight windows relative to it (slot spacing is exact and clock-free).
  const c0 = frameStartSample + refSlot * slotSamp;
  const r0 = findChirp(buf, tpl, c0 - wide, c0 + maxProp + wide);
  if (r0.snr < minSnr) return { pos: null, conf: 0, used: [] };
  const arrAt = new Map([[refSlot, { idx: r0.index, snr: r0.snr }]]);
  for (const s of slots) {
    if (s === refSlot) continue;
    const ci = r0.index + (s - refSlot) * slotSamp;
    const ri = findChirp(buf, tpl, ci - tight, ci + maxProp + tight);
    if (ri.snr >= minSnr) arrAt.set(s, { idx: ri.index, snr: ri.snr });
  }
  const det = [...arrAt.keys()].sort((x, y) => x - y);
  if (det.length < 3) return { pos: null, conf: 0, used: det };

  // Candidate beacon per detected slot. When slots are reused, choose the
  // assignment (one beacon per slot) with the lowest TDOA residual — mixing
  // far-apart clusters yields a big residual, so the correct local cluster wins.
  const hint = opts.hint || {
    x: anchors.reduce((s, a) => s + a.x, 0) / anchors.length,
    y: anchors.reduce((s, a) => s + a.y, 0) / anchors.length,
  };
  const cands = det.map((s) => bySlot.get(s).slice().sort((a, b) => dist(hint, a) - dist(hint, b)).slice(0, 2));

  const refIdx = arrAt.get(refSlot).idx;
  const td = det.map((s) => (arrAt.get(s).idx - refIdx) / sr - ((s - refSlot) * slotMs) / 1000 - ((off[s] || 0) - (off[refSlot] || 0)));
  const solveFor = (pick) => {
    const spk = pick.map((b) => ({ x: b.x, y: b.y }));
    const est = solveTDOA(spk, td, { x: spk.reduce((s, p) => s + p.x, 0) / spk.length, y: spk.reduce((s, p) => s + p.y, 0) / spk.length });
    let resid = 0;
    for (let i = 1; i < spk.length; i++) resid += Math.abs((dist(est, spk[i]) - dist(est, spk[0])) / SPEED_OF_SOUND - td[i]);
    return { est, resid: resid / Math.max(1, spk.length - 1) };
  };

  // Search the (capped) cartesian product of candidates for the best assignment.
  let best = null, bestPick = null;
  const idx = new Array(cands.length).fill(0);
  const total = cands.reduce((n, c) => n * c.length, 1);
  for (let k = 0; k < total && k < 256; k++) {
    const pick = cands.map((c, i) => c[idx[i]]);
    const r = solveFor(pick);
    if (!best || r.resid < best.resid) { best = r; bestPick = pick; }
    for (let i = 0; i < idx.length; i++) { if (++idx[i] < cands[i].length) break; idx[i] = 0; }
  }

  const minSnrVal = Math.min(...det.map((s) => arrAt.get(s).snr));
  const conf = Math.max(0, Math.min(1, 1 - best.resid / 0.002)) * Math.min(1, minSnrVal / 10);
  return {
    pos: best.est, conf, used: det, residual: best.resid,
    arrivals: det.map((s) => ({ slot: s, idx: arrAt.get(s).idx, snr: arrAt.get(s).snr })),
    beacons: bestPick.map((b, i) => ({ slot: det[i], x: b.x, y: b.y })),
  };
}

// Calibrate per-beacon emit latency: stand at a KNOWN position, measure arrivals,
// and the leftover (measured TDOA − geometric TDOA) is each beacon's device delay
// relative to the reference. Feed the result back as locateFromFrame opts.offsets.
export function calibrateOffsets(arrivals, knownPos, anchorsBySlot, sr, slotMs) {
  if (!arrivals || arrivals.length < 2) return {};
  const ref = arrivals[0];
  const refA = anchorsBySlot[ref.slot];
  const out = {};
  for (const a of arrivals) {
    const spk = anchorsBySlot[a.slot];
    if (!spk) continue;
    const measured = (a.idx - ref.idx) / sr - ((a.slot - ref.slot) * slotMs) / 1000;
    const geom = (dist(knownPos, spk) - dist(knownPos, refA)) / SPEED_OF_SOUND;
    out[a.slot] = measured - geom; // ref ends up ~0 by construction
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ambient audio reactivity — the primary sync path. Phones listen through the
// mic to whatever music is playing (Spotify, a live band, anything). We control
// no source: coordination comes from everyone hearing the same song.
//
// Frame-based: driven from an AnalyserNode once per animation frame, wall-clock
// timed. No AudioWorklet, so it's robust across browsers. It outputs:
//   level — smoothed loudness; a glow that tracks the music's energy
//   pulse — a transient pop on each onset/beat; the flash
//   bpm   — estimated tempo
// `level` guarantees the display visibly reacts to ANY sound, even when discrete
// beat tracking is uncertain — which is what makes "it just responds" hold up.
// ---------------------------------------------------------------------------

export class AudioReactor {
  constructor(opts = {}) {
    this.level = 0;          // 0..1 smoothed loudness
    this.pulse = 0;          // 0..1 transient, decays between onsets
    this.flux = 0;           // latest spectral-flux value
    this.energy = 0;         // 0..1 slow energy envelope (verse vs chorus)
    this.active = 0;         // 0..1 "is there real sound above the room's quiet?"
    this._floor = 0.02;      // adaptive noise-floor estimate (raw RMS)
    this.drop = 0;           // 0..1 decaying burst after a detected drop
    this.bands = { bass: 0, mid: 0, treble: 0 };
    this.section = 'calm';   // 'calm' | 'build' | 'peak' | 'drop' (song structure)
    this.downbeatSlot = 0;   // which beat-of-4 carries the most bass (the "1")
    this._eTrend = 0; this._beatCount = 0; this._bassSlots = [0, 0, 0, 0];
    this.beats = 0;
    this.bpm = null;
    this.bpmConfidence = 0;  // 0..1 how steady/dominant the tempo is (low = complex music)
    this.lastBeatMs = -1e9;
    this.sens = opts.sens ?? 1.6;            // flux peak must exceed adaptive floor * this
    this.refractoryMs = opts.refractoryMs ?? 140;
    this.peakDecay = opts.peakDecay ?? 0.997; // auto-gain peak-follower decay
    this._peak = 0.08;
    this.bandFrac = opts.bandFrac ?? 0.22;   // analysis band: bottom ~22% of bins (<~5kHz)
    this.fluxFloor = opts.fluxFloor ?? 0.004;
    this._lastT = null;
    this._prev = null;       // previous magnitude spectrum
    this._fluxAvg = 0;
    this._fluxPrev = 0;
    // dynamics / drop
    this._eShort = 0; this._eLong = 0; this._lastDrop = -1e9;
    // tempogram: flux history + per-sample timestamps (rate derived from those)
    this._fh = []; this._fht = []; this._fluxWin = 0; this._lastPush = 0; this._lastAc = 0;
  }

  // rms: broadband loudness (~0..1). freq: magnitude spectrum (Uint8Array 0..255,
  // from AnalyserNode.getByteFrequencyData). nowMs: wall clock.
  update(rms, freq, nowMs) {
    const dt = this._lastT == null ? 16 : Math.min(100, nowMs - this._lastT);
    this._lastT = nowMs;

    // Loudness with auto-gain -> calm 0..1 glow (the sharp flash is `pulse`).
    this._peak = Math.max(rms, this._peak * this.peakDecay);
    const norm = this._peak > 1e-3 ? Math.min(1, rms / this._peak) : 0;
    this.level += (norm - this.level) * 0.1;
    this.pulse *= Math.exp(-dt / 90);

    // Presence via an ADAPTIVE NOISE FLOOR (absolute, not auto-gained): the floor
    // drops instantly to any new quiet minimum and creeps up slowly, so steady
    // room noise sits AT the floor (not "music"). Real sound rises well above it.
    // This is the silence gate — auto-gained `level` can't tell quiet from loud.
    this._floor = rms < this._floor ? rms : this._floor + (rms - this._floor) * 0.0003;
    const present = rms > this._floor * 4 + 0.004;
    this.active += ((present ? 1 : 0) - this.active) * 0.08;

    // Frequency bands (bass / mid / treble), each auto-gained to 0..1, so color
    // can mirror the actual sound. Bands stop well below the ultrasonic beacons.
    const N = freq.length;
    const band = (a, b) => { let s = 0; for (let k = a; k < b; k++) s += freq[k]; return s / ((b - a) * 255 || 1); };
    const bassN = Math.max(2, Math.floor(N * 0.016)), midN = Math.floor(N * 0.08), treN = Math.floor(N * 0.22);
    const rb = band(1, bassN), rm = band(bassN, midN), rt = band(midN, treN), tot = rb + rm + rt + 1e-6;
    this.bands.bass += (rb / tot - this.bands.bass) * 0.35;   // relative spectral balance
    this.bands.mid += (rm / tot - this.bands.mid) * 0.35;     // (proportions, sum ~1) -> drives hue
    this.bands.treble += (rt / tot - this.bands.treble) * 0.35;

    // Spectral flux: positive bin-to-bin increases across the band — a musical
    // onset cue (drums, stabs, vocals), not just bass energy.
    const hi = Math.max(4, treN);
    let flux = 0;
    if (this._prev && this._prev.length === N) {
      for (let k = 1; k < hi; k++) { const d = freq[k] - this._prev[k]; if (d > 0) flux += d; }
    }
    flux /= hi * 255;
    if (!this._prev || this._prev.length !== N) this._prev = new Uint8Array(N);
    this._prev.set(freq);
    this.flux = flux;

    // Onset = rising flux peak above an adaptive floor; level-gated for silence.
    this._fluxAvg += (flux - this._fluxAvg) * 0.05;
    if (present && flux > this._fluxAvg * this.sens + this.fluxFloor && flux > this._fluxPrev && nowMs - this.lastBeatMs > this.refractoryMs) {
      // Downbeat: the beat-of-4 with the most bass is the "1". Track a per-slot
      // bass average, then accent the downbeat (slightly stronger flash).
      const slot = this._beatCount % 4;
      this._bassSlots[slot] = this._bassSlots[slot] * 0.9 + this.bands.bass * 0.1;
      let mx = 0; for (let i = 1; i < 4; i++) if (this._bassSlots[i] > this._bassSlots[mx]) mx = i;
      this.downbeatSlot = mx;
      this.lastBeatMs = nowMs; this.beats++; this._beatCount++;
      this.pulse = slot === mx ? 1 : 0.82; // accent the 1
    }
    this._fluxPrev = flux;

    // Dynamics: slow energy envelope + drop detection (a sharp surge of loudness
    // above the recent baseline — the moment the bass slams back in).
    this.energy += (this.level - this.energy) * 0.02;
    this._eShort += (this.level - this._eShort) * 0.15;
    this._eLong += (this.level - this._eLong) * 0.01;
    if (this._eShort - this._eLong > 0.35 && this._eShort > 0.5 && nowMs - this._lastDrop > 3500) this._lastDrop = nowMs;
    this.drop = nowMs - this._lastDrop < 2000 ? Math.exp(-(nowMs - this._lastDrop) / 450) : 0;

    // Song section from the energy envelope + its slow trend (drives the director).
    this._eTrend += (this.energy - this._eTrend) * 0.004;
    const rising = this.energy - this._eTrend > 0.04;
    this.section = this.drop > 0.4 ? 'drop' : this.energy > 0.62 ? 'peak' : rising ? 'build' : 'calm';

    // Tempogram beat lock: push flux onto a fixed ~50 Hz time grid, autocorrelate
    // a few times a second, and take the strongest lag in 60–180 BPM. Robust on
    // busy music where inter-onset medians wobble.
    this._fluxWin = Math.max(this._fluxWin, flux);
    if (nowMs - this._lastPush >= 20) {
      this._lastPush = nowMs;
      this._fh.push(this._fluxWin); this._fht.push(nowMs); this._fluxWin = 0;
      if (this._fh.length > 256) { this._fh.shift(); this._fht.shift(); }
    }
    if (nowMs - this._lastAc >= 500) { this._lastAc = nowMs; this._estTempo(); }
    return this;
  }

  _estTempo() {
    const h = this._fh, ts = this._fht, n = h.length;
    if (n < 100) return;
    const pm = (ts[n - 1] - ts[0]) / (n - 1); // true average sample interval (ms)
    if (!(pm > 0)) return;
    const minLag = Math.max(4, Math.round(60000 / 180 / pm)); // 180 BPM
    const maxLag = Math.min(n >> 1, Math.round(60000 / 60 / pm)); // 60 BPM
    let bestLag = 0, best = 0, sum = 0, cnt = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0; for (let i = lag; i < n; i++) s += h[i] * h[i - lag];
      s /= n - lag; // normalize so longer lags aren't penalized
      sum += s; cnt++;
      if (s > best) { best = s; bestLag = lag; }
    }
    if (!bestLag) return;
    // Confidence = how dominant the peak is vs the average lag. Steady 4/4 -> sharp
    // peak (high); odd-meter / dense music (Tool) -> flat field (low) -> go reactive.
    const mean = sum / Math.max(1, cnt);
    const conf = mean > 1e-9 ? Math.max(0, Math.min(1, (best / mean - 1) / 2)) : 0;
    this.bpmConfidence += (conf - this.bpmConfidence) * 0.3;
    let v = 60000 / (bestLag * pm); // lag * measured push interval = beat period
    while (v < 60) v *= 2; while (v > 180) v /= 2;
    this.bpm = this.bpm ? Math.round(this.bpm * 0.7 + v * 0.3) : Math.round(v);
  }
}

// ---------------------------------------------------------------------------
// Synchronization & calibration. Everything below tightens cross-device timing
// — the single biggest lever on how "together" the crowd feels.
// ---------------------------------------------------------------------------

// Drift-corrected clock sync. Beyond a single offset, it fits offset = a + skew*t
// over the low-jitter (low-RTT) samples, so the phone's clock RATE error is
// tracked and extrapolated between pings — no sawtooth drift between syncs.
export class ClockFilter {
  constructor(opts = {}) { this.s = []; this.maxAge = opts.maxAge ?? 90000; this.maxN = opts.maxN ?? 48; }
  add(t0, ts, t1) {
    const m = (t0 + t1) / 2, off = ts - m, rtt = t1 - t0;
    if (rtt < 0 || rtt > 2000) return;
    this.s.push({ m, off, rtt });
    if (this.s.length > this.maxN) this.s.shift();
  }
  _good(nowLocal) {
    const fresh = this.s.filter((x) => nowLocal - x.m < this.maxAge);
    if (!fresh.length) return [];
    const minRtt = Math.min(...fresh.map((x) => x.rtt));
    return fresh.filter((x) => x.rtt <= minRtt * 1.5 + 8); // keep least-jittered samples
  }
  offsetAt(nowLocal) {
    const g = this._good(nowLocal);
    if (!g.length) return this.s.length ? this.s[this.s.length - 1].off : 0;
    if (g.length < 3) return g.reduce((a, b) => a + b.off, 0) / g.length;
    const m0 = g[g.length - 1].m;
    let Sw = 0, Sx = 0, Sy = 0, Sxx = 0, Sxy = 0;
    for (const x of g) {
      const w = 1 / (x.rtt + 5), dx = x.m - m0;
      Sw += w; Sx += w * dx; Sy += w * x.off; Sxx += w * dx * dx; Sxy += w * dx * x.off;
    }
    const den = Sw * Sxx - Sx * Sx;
    let skew = Math.abs(den) > 1e-9 ? (Sw * Sxy - Sx * Sy) / den : 0;
    skew = Math.max(-1e-3, Math.min(1e-3, skew)); // clamp to ±1000 ppm
    const a = (Sy - skew * Sx) / Sw;
    return a + skew * (nowLocal - m0);
  }
  quality(nowLocal) { const g = this._good(nowLocal); return g.length ? Math.min(...g.map((x) => x.rtt)) / 2 : Infinity; }
}

// Median tempo across many devices (server-side). Each phone reports its own
// local BPM estimate; the crowd median is robust and drift-free, and becomes the
// single shared tempo everyone phase-locks to.
export class TempoEstimator {
  constructor(opts = {}) { this.v = []; this.maxAge = opts.maxAge ?? 8000; }
  add(bpm, nowMs) { if (bpm >= 40 && bpm <= 220) this.v.push({ bpm, t: nowMs }); }
  bpm(nowMs) {
    this.v = this.v.filter((x) => nowMs - x.t < this.maxAge);
    if (!this.v.length) return null;
    const s = this.v.map((x) => x.bpm).sort((a, b) => a - b);
    return s[s.length >> 1];
  }
}

// Per-phone phase-locked loop. Given the shared tempo and the onsets THIS phone
// hears, it tracks the beat phase — so nearby phones (same sound) stay tight and
// the flash matches the music each person actually hears, with no tempo drift.
export class PhaseLock {
  constructor(opts = {}) { this.period = 0.5; this.nextBeat = null; this.alpha = opts.alpha ?? 0.12; }
  setBpm(bpm) { if (bpm >= 40 && bpm <= 220) this.period = 60 / bpm; }
  onset(tSec) {
    if (this.nextBeat == null) { this.nextBeat = tSec; return; }
    let nb = this.nextBeat;
    while (nb < tSec - this.period / 2) nb += this.period;
    while (nb > tSec + this.period / 2) nb -= this.period;
    this.nextBeat = nb + this.alpha * (tSec - nb); // nudge phase toward the onset
  }
  // Seconds since the most recent beat at server-time tSec (null if no lock yet).
  sinceBeat(tSec) {
    if (this.nextBeat == null) return null;
    return (((tSec - this.nextBeat) % this.period) + this.period) % this.period;
  }
}

// 1€ filter (2D): adaptive low-pass that gives low jitter when still and low lag
// when moving — ideal for continuously recalibrating people who walk around.
// Also rejects gross outliers (teleport-fast jumps).
class LowPass { filter(x, a) { this.s = this.init ? a * x + (1 - a) * this.s : x; this.init = true; return this.s; } }
export class OneEuro {
  constructor(opts = {}) {
    this.minCut = opts.minCutoff ?? 0.9; this.beta = opts.beta ?? 0.02; this.dCut = opts.dCutoff ?? 1.0;
    this.vmax = opts.vmax ?? 4; // m/s; reject jumps faster than ~4x this
    this.xp = new LowPass(); this.yp = new LowPass(); this.dxp = new LowPass(); this.dyp = new LowPass();
    this.last = null; this.lastT = null;
  }
  _alpha(cut, dt) { const tau = 1 / (2 * Math.PI * cut); return 1 / (1 + tau / dt); }
  update(p, tSec) {
    if (!this.last || this.lastT == null) { this.last = { x: p.x, y: p.y }; this.lastT = tSec; return this.last; }
    const dt = Math.max(1e-3, tSec - this.lastT);
    if (Math.hypot(p.x - this.last.x, p.y - this.last.y) / dt > this.vmax * 4) return this.last; // outlier
    const ad = this._alpha(this.dCut, dt);
    const edx = this.dxp.filter((p.x - this.last.x) / dt, ad);
    const edy = this.dyp.filter((p.y - this.last.y) / dt, ad);
    const cut = this.minCut + this.beta * Math.hypot(edx, edy);
    const a = this._alpha(cut, dt);
    this.last = { x: this.xp.filter(p.x, a), y: this.yp.filter(p.y, a) };
    this.lastT = tSec;
    return this.last;
  }
}

// ---------------------------------------------------------------------------
// Co-location from shared audio — zero-setup "depth". Phones near each other
// hear the same song at the same instant; a phone's beat-onset phase vs the
// crowd's reveals how far it is from the sound source (front .. back). No
// beacons, no extra emission — works best at large venues (big distance spread).
// ---------------------------------------------------------------------------

export const foldPhase = (tMs, periodMs) => ((tMs % periodMs) + periodMs) % periodMs;

// Circular mean of phases (ms within periodMs) — robust center of one phone's
// own recent onsets.
export function circMean(phases, periodMs) {
  if (!phases.length) return 0;
  let x = 0, y = 0;
  for (const p of phases) { const a = (p / periodMs) * 2 * Math.PI; x += Math.cos(a); y += Math.sin(a); }
  let a = Math.atan2(y, x);
  if (a < 0) a += 2 * Math.PI;
  return (a / (2 * Math.PI)) * periodMs;
}

// Crowd lead phase (front, nearest the source) + spread, from many phones'
// phases, handling circular wrap by cutting at the largest empty arc.
export function phaseStats(phases, periodMs) {
  const n = phases.length;
  if (n < 4) return { lead: 0, spread: 0, n };
  const s = [...phases].sort((a, b) => a - b);
  let gapAt = 0, gap = s[0] + periodMs - s[n - 1];
  for (let i = 1; i < n; i++) { const g = s[i] - s[i - 1]; if (g > gap) { gap = g; gapAt = i; } }
  const u = s.map((p) => ((p - s[gapAt]) % periodMs + periodMs) % periodMs).sort((a, b) => a - b);
  const at = (q) => u[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))];
  const u10 = at(0.1), u90 = at(0.9);
  return { lead: (s[gapAt] + u10) % periodMs, spread: Math.max(0, u90 - u10), n };
}

// Front(0)..back(1) for this phone given the crowd lead phase + spread.
export function depthOf(myPhaseMs, leadMs, spreadMs, periodMs) {
  if (spreadMs <= 1) return 0.5;
  let d = ((myPhaseMs - leadMs) % periodMs + periodMs) % periodMs;
  if (d > periodMs / 2) d -= periodMs; // a hair ahead of the lead is still "front"
  return Math.max(0, Math.min(1, d / spreadMs));
}
