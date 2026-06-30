import {
  makeChirp, makeChirpTemplate, findChirp, solveTDOA, locateFromFrame, calibrateOffsets,
  dist, SPEED_OF_SOUND, AudioReactor, ClockFilter, TempoEstimator, PhaseLock, OneEuro,
  foldPhase, phaseStats, depthOf,
} from '../public/dsp.js';

const sr = 48000;
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

// --- Test 1: matched filter is unbiased + precise through noise + echo -------
{
  const chirp = makeChirp(sr);
  const tpl = makeChirpTemplate(sr);
  const trueIdx = 4321, trials = 60;
  let sumErr = 0, sumAbs = 0, sumSnr = 0;
  for (let t = 0; t < trials; t++) {
    const sig = new Float32Array(sr * 0.2);
    for (let i = 0; i < sig.length; i++) sig[i] = (Math.random() - 0.5) * 0.12;       // noise floor
    for (let j = 0; j < chirp.length; j++) sig[trueIdx + j] += chirp[j] * 0.5;        // direct
    for (let j = 0; j < chirp.length; j++) sig[trueIdx + 500 + j] += chirp[j] * 0.25; // reverb echo
    const r = findChirp(sig, tpl, 0, sig.length);
    sumErr += r.index - trueIdx;
    sumAbs += Math.abs(r.index - trueIdx);
    sumSnr += r.snr;
  }
  const meanErr = sumErr / trials, meanAbs = sumAbs / trials, meanSnr = sumSnr / trials;
  ok(Math.abs(meanErr) < 1, `arrival unbiased over ${trials} trials (mean err ${meanErr.toFixed(2)} samples)`);
  ok(meanAbs < 3, `arrival precise (mean |err| ${meanAbs.toFixed(2)} samples ≈ ${(meanAbs / sr * 343 * 100).toFixed(1)} cm)`);
  ok(meanSnr > 6, `mean SNR over noise floor (${meanSnr.toFixed(1)})`);
}

// --- Test 2: full acoustic positioning chain (chirp -> TDOA -> solve) ---------
{
  const chirp = makeChirp(sr);
  const tpl = makeChirpTemplate(sr);
  const speakers = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8 }]; // 3 beacons, room scale
  const truth = { x: 3, y: 2.5 };
  const slot = 0.06; // s between beacon slots (matches AUDIO.slotMs)
  const c = SPEED_OF_SOUND;

  const frame = new Float32Array(Math.round(sr * 0.4));
  for (let i = 0; i < frame.length; i++) frame[i] = (Math.random() - 0.5) * 0.12;
  const phoneClockOffset = Math.round(sr * 0.021); // unknown — must cancel out
  const placed = speakers.map((sp, i) => {
    const arr = phoneClockOffset + Math.round((i * slot + dist(truth, sp) / c) * sr);
    for (let j = 0; j < chirp.length; j++) {
      frame[arr + j] += chirp[j] * 0.5;
      frame[arr + 400 + j] += chirp[j] * 0.2; // echo
    }
    return arr;
  });

  // Detector knows the frame grid only roughly (clock sync error); search a window.
  const guessStart = phoneClockOffset + Math.round(sr * 0.003); // 3 ms alignment error
  const guard = Math.round(sr * 0.006);
  const maxProp = Math.round((Math.hypot(10, 8) / c) * sr);
  const arrivals = speakers.map((_, i) => {
    const center = guessStart + Math.round(i * slot * sr);
    return findChirp(frame, tpl, center - guard, center + maxProp + guard).index;
  });
  const tdoa = arrivals.map((a, i) => (a - arrivals[0]) / sr - i * slot);
  const est = solveTDOA(speakers, tdoa, { x: 5, y: 4 });
  const err = dist(est, truth);
  ok(err < 0.3, `position recovered to ${(err * 100).toFixed(1)} cm  (est ${est.x.toFixed(2)},${est.y.toFixed(2)} vs ${truth.x},${truth.y})`);
  void placed;
}

// --- Test 3: ambient reactor tracks loudness + locks onto a 120 BPM kick ------
{
  const r = new AudioReactor();
  const fps = 60, dur = 6.0, dt = 1000 / fps, period = 0.5, N = 256; // 120 BPM, 256 bins
  let beatsHeard = 0, maxLevel = 0;
  for (let f = 0; f < dur * fps; f++) {
    const t = f * dt;
    const phase = (t / 1000) % period;
    const kick = phase < 0.06 ? 1 - phase / 0.06 : 0;        // a transient at each beat
    const rms = 0.08 + 0.18 * kick;
    const freq = new Uint8Array(N);                          // spectrum that jumps on the beat
    for (let k = 1; k < 18; k++) freq[k] = Math.min(255, 25 + 210 * kick);
    for (let k = 18; k < 56; k++) freq[k] = 18 + 70 * kick;
    const before = r.beats;
    r.update(rms, freq, t);
    if (r.beats > before) beatsHeard++;
    maxLevel = Math.max(maxLevel, r.level);
  }
  ok(beatsHeard >= 10 && beatsHeard <= 13, `flux reactor caught ${beatsHeard} beats (expected ~11-12)`);
  ok(r.bpmConfidence > 0.4, `steady 120 BPM reads as confident (conf ${(r.bpmConfidence * 100) | 0}%)`);
  ok(r.bpm >= 110 && r.bpm <= 130, `tempo estimate ${r.bpm} BPM (~120)`);
  ok(maxLevel > 0.3, `level tracks loudness (peak ${maxLevel.toFixed(2)})`);
}

// --- Test 4: locateFromFrame end-to-end (the live positioning algorithm) ------
{
  const chirp = makeChirp(sr), tpl = makeChirpTemplate(sr);
  const slotMs = 120, slotSamp = (slotMs / 1000) * sr;
  const c = SPEED_OF_SOUND;
  const anchors = [{ slot: 0, x: 0, y: 0 }, { slot: 1, x: 10, y: 0 }, { slot: 2, x: 5, y: 7 }];
  const truth = { x: 3, y: 2.5 };

  const frameStartTrue = Math.round(0.05 * sr);   // where slot 0 actually fires
  const len = frameStartTrue + 3 * slotSamp + Math.round(0.15 * sr);
  const buf = new Float32Array(Math.round(len));
  for (let i = 0; i < buf.length; i++) buf[i] = (Math.random() - 0.5) * 0.12;
  for (const a of anchors) {
    const arr = Math.round(frameStartTrue + a.slot * slotSamp + (dist(truth, a) / c) * sr);
    for (let j = 0; j < chirp.length; j++) {
      buf[arr + j] += chirp[j] * 0.5;
      buf[arr + 380 + j] += chirp[j] * 0.2; // reverb echo
    }
  }
  // The phone only knows the frame start approximately (clock-sync error): +30 ms.
  const frameStartGuess = frameStartTrue + Math.round(0.03 * sr);
  const res = locateFromFrame(buf, sr, tpl, frameStartGuess, anchors, slotMs, { maxPropM: 12.5, minSnr: 5 });
  ok(res.pos != null, `located (used slots ${JSON.stringify(res.used)})`);
  const err = res.pos ? dist(res.pos, truth) : 999;
  ok(err < 0.5, `position from frame within ${(err * 100).toFixed(1)} cm  (conf ${res.conf.toFixed(2)})`);
}

// --- Test 5: ClockFilter recovers offset under skew + asymmetric jitter -------
{
  const O = 1234.5, SK = 30e-6;                 // 30 ppm clock skew
  const trueOff = (tl) => O + SK * tl;
  const cf = new ClockFilter();
  let tl = 0;
  for (let i = 0; i < 40; i++) {
    tl += 1500 + Math.random() * 600;
    const dUp = 2 + Math.random() * Math.random() * 28;   // mostly small, occasional large
    const dDown = 2 + Math.random() * Math.random() * 28;
    const t0 = tl, mid = t0 + dUp;
    cf.add(t0, mid + trueOff(mid), t0 + dUp + dDown);
  }
  const now = tl + 1000;
  const err = Math.abs(cf.offsetAt(now) - trueOff(now));
  ok(err < 6, `clock offset recovered within ${err.toFixed(2)} ms (skew-corrected)`);
}

// --- Test 6: shared tempo + phase-lock to noisy onsets ------------------------
{
  const te = new TempoEstimator();
  for (let i = 0; i < 8; i++) te.add(128 + (Math.random() - 0.5) * 4, i * 100);
  const bpm = te.bpm(800);
  ok(Math.abs(bpm - 128) <= 3, `crowd tempo median ${bpm} (~128)`);

  const pl = new PhaseLock(); pl.setBpm(bpm);
  const period = 60 / 128;
  for (let k = 0; k < 40; k++) pl.onset(k * period + (Math.random() - 0.5) * 0.03);
  let worst = 0;
  for (let k = 35; k < 40; k++) { const ph = pl.sinceBeat(k * period); worst = Math.max(worst, Math.min(ph, period - ph)); }
  ok(worst < 0.03, `phase-lock aligns beats within ${(worst * 1000).toFixed(0)} ms`);
}

// --- Test 7: adaptive 1€ filter tracks a walking path, rejects an outlier ------
{
  const f = new OneEuro({ minCutoff: 1.0, beta: 0.5, vmax: 4 });
  let errSum = 0, n = 0;
  for (let i = 0; i <= 30; i++) {
    const t = i / 3, tx = t * 0.5, ty = 1; // walk 0.5 m/s along x
    let mx = tx + (Math.random() - 0.5) * 0.3, my = ty + (Math.random() - 0.5) * 0.3;
    if (i === 15) { mx += 8; my += 8; }       // gross outlier
    const e = f.update({ x: mx, y: my }, t);
    if (i > 5 && i !== 15) { errSum += Math.hypot(e.x - tx, e.y - ty); n++; }
  }
  ok(errSum / n < 0.35, `moving track followed within ${(errSum / n).toFixed(2)} m mean`);
}

// --- Test 8: beacon emit-latency calibration removes positioning bias ---------
{
  const slotMs = 120, c = SPEED_OF_SOUND;
  const A = [{ slot: 0, x: 0, y: 0 }, { slot: 1, x: 10, y: 0 }, { slot: 2, x: 5, y: 7 }];
  const bySlot = { 0: A[0], 1: A[1], 2: A[2] };
  const L = { 0: 0, 1: 0.002, 2: -0.0015 }; // hidden per-beacon device latencies (s)
  const mkArr = (K, base) => A.map((a) => ({ slot: a.slot, idx: base + Math.round((a.slot * slotMs / 1000 + dist(K, a) / c + L[a.slot]) * sr) }));

  const K1 = { x: 2, y: 1 };
  const offs = calibrateOffsets(mkArr(K1, 5000), K1, bySlot, sr, slotMs);
  ok(Math.abs(offs[1] - 0.002) < 2e-4 && Math.abs(offs[2] + 0.0015) < 2e-4,
    `recovered latencies o1=${(offs[1] * 1000).toFixed(2)}ms o2=${(offs[2] * 1000).toFixed(2)}ms`);

  const K2 = { x: 6, y: 4 }, arr = mkArr(K2, 12000), spk = A.map((a) => ({ x: a.x, y: a.y })), guess = { x: 5, y: 3.5 };
  const tdNo = A.map((a) => (arr[a.slot].idx - arr[0].idx) / sr - a.slot * slotMs / 1000);
  const tdCal = A.map((a) => (arr[a.slot].idx - arr[0].idx) / sr - a.slot * slotMs / 1000 - (offs[a.slot] - offs[0]));
  const errNo = dist(solveTDOA(spk, tdNo, guess), K2), errCal = dist(solveTDOA(spk, tdCal, guess), K2);
  ok(errCal < 0.2 && errCal < errNo * 0.5, `calibration cuts error ${(errNo * 100).toFixed(0)}cm -> ${(errCal * 100).toFixed(0)}cm`);
}

// --- Test 9: slot reuse — pick the right cluster when slots are shared --------
{
  const chirp = makeChirp(sr), tpl = makeChirpTemplate(sr);
  const slotMs = 120, slotSamp = (slotMs / 1000) * sr, c = SPEED_OF_SOUND;
  const A = [{ slot: 0, x: 0, y: 0 }, { slot: 1, x: 10, y: 0 }, { slot: 2, x: 5, y: 8 }];
  const B = [{ slot: 0, x: 100, y: 0 }, { slot: 1, x: 110, y: 0 }, { slot: 2, x: 105, y: 8 }]; // reuses 0,1,2 far away
  const anchors = [...A, ...B];
  const truth = { x: 3, y: 2.5 }; // standing in cluster A

  const frameStartTrue = Math.round(0.05 * sr);
  const len = frameStartTrue + 3 * slotSamp + Math.round(0.15 * sr);
  const buf = new Float32Array(Math.round(len));
  for (let i = 0; i < buf.length; i++) buf[i] = (Math.random() - 0.5) * 0.12;
  for (const a of A) { // only cluster A is audible here
    const arr = Math.round(frameStartTrue + a.slot * slotSamp + (dist(truth, a) / c) * sr);
    for (let j = 0; j < chirp.length; j++) { buf[arr + j] += chirp[j] * 0.5; buf[arr + 380 + j] += chirp[j] * 0.2; }
  }
  const res = locateFromFrame(buf, sr, tpl, frameStartTrue + Math.round(0.03 * sr), anchors, slotMs, { maxPropM: 12.5, minSnr: 5 });
  ok(res.pos != null, `reuse: located`);
  const err = res.pos ? dist(res.pos, truth) : 999;
  ok(err < 0.5, `reuse: picked correct local cluster within ${(err * 100).toFixed(1)} cm`);
}

// --- Test 10: co-location depth from shared-audio onset phase -----------------
{
  const period = 500, c = SPEED_OF_SOUND, base = 120; // 120 BPM, arbitrary source offset
  const ds = [], phases = [];
  for (let i = 0; i < 60; i++) {
    const d = Math.random() * 40;                       // 0..40 m from the source
    ds.push(d);
    phases.push(foldPhase(base + (d / c) * 1000 + (Math.random() - 0.5) * 16, period)); // +-8ms jitter
  }
  const st = phaseStats(phases, period);
  ok(st.spread > 50 && st.spread < 160, `crowd phase spread ${st.spread.toFixed(0)} ms over 0-40 m`);

  const depths = phases.map((p) => depthOf(p, st.lead, st.spread, period));
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const md = mean(ds), mp = mean(depths);
  let num = 0, va = 0, vb = 0;
  for (let i = 0; i < ds.length; i++) { const x = ds[i] - md, y = depths[i] - mp; num += x * y; va += x * x; vb += y * y; }
  const corr = num / Math.sqrt(va * vb);
  ok(corr > 0.8, `depth tracks distance-from-source (r=${corr.toFixed(2)})`);
}

// --- Test 11: dynamics (energy + drop) and frequency bands --------------------
{
  const r = new AudioReactor();
  const N = 256, dt = 1000 / 60;
  let dropCount = 0, prevDrop = 0, sawDropSection = false;
  for (let f = 0; f < 360; f++) {           // 2 s quiet, then a loud bass-heavy "drop"
    const t = f * dt;
    const loud = t > 2000;
    const rms = loud ? 0.3 : 0.02;
    const freq = new Uint8Array(N);
    for (let k = 1; k < 10; k++) freq[k] = loud ? 235 : 18;   // bass
    for (let k = 10; k < 40; k++) freq[k] = loud ? 110 : 12;  // mids
    // treble bins left low -> bass-heavy
    r.update(rms, freq, t);
    if (r.drop > 0.5 && prevDrop <= 0.5) dropCount++;
    prevDrop = r.drop;
    if (r.section === 'drop') sawDropSection = true;
  }
  ok(r.energy > 0.4, `energy envelope rises in the loud section (${r.energy.toFixed(2)})`);
  ok(dropCount === 1, `drop detected once at the jump (${dropCount})`);
  ok(r.bands.bass > r.bands.treble + 0.2, `bands reflect bass-heavy content (bass ${r.bands.bass.toFixed(2)} vs treble ${r.bands.treble.toFixed(2)})`);
  ok(sawDropSection && r.section === 'peak', `section drop->peak (saw drop=${sawDropSection}, final=${r.section})`);
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
