// Shared signal-processing core. Pure functions + small stateful helpers, no DOM
// — so it runs identically in the browser and under Node for tests.

export const SPEED_OF_SOUND = 343; // m/s
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

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
    this.beats = 0;
    this.bpm = null;
    this.lastBeatMs = -1e9;
    this.sens = opts.sens ?? 1.35;        // onset must exceed adaptive floor * this
    this.refractoryMs = opts.refractoryMs ?? 140;
    this.gain = opts.gain ?? 7;           // maps RMS -> 0..1 level
    this._lastT = null;
    this._loAvg = 0;
    this._loPrev = 0;
    this._ivs = [];
  }

  // rms: broadband loudness (~0..1). lo: low-band (kick) energy (0..1). nowMs: wall clock.
  update(rms, lo, nowMs) {
    const dt = this._lastT == null ? 16 : Math.min(100, nowMs - this._lastT);
    this._lastT = nowMs;

    // Loudness: fast attack, slow release -> a glow that follows the music.
    const target = Math.min(1, rms * this.gain);
    this.level += (target - this.level) * (target > this.level ? 0.5 : 0.08);

    // Transient decays between onsets.
    this.pulse *= Math.exp(-dt / 90);

    // Low-band onset against an adaptive floor (rising edge + refractory).
    this._loAvg += (lo - this._loAvg) * 0.05;
    const rising = lo > this._loPrev;
    if (lo > this._loAvg * this.sens + 0.02 && rising && nowMs - this.lastBeatMs > this.refractoryMs) {
      if (this.lastBeatMs > -1e8) {
        const iv = nowMs - this.lastBeatMs;
        if (iv > 250 && iv < 1500) { this._ivs.push(iv); if (this._ivs.length > 8) this._ivs.shift(); }
      }
      this.lastBeatMs = nowMs;
      this.beats++;
      this.pulse = 1;
      if (this._ivs.length >= 3) {
        const s = [...this._ivs].sort((a, b) => a - b);
        const v = 60000 / s[s.length >> 1];
        if (v >= 50 && v <= 200) this.bpm = Math.round(v);
      }
    }
    this._loPrev = lo;
    return this;
  }

  // Combined brightness drive for the show: beat flash over a music-tracking glow.
  energy() { return Math.min(1, this.pulse * 0.85 + this.level * 0.5); }
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
