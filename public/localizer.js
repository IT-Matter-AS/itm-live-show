// Acoustic localizer.
//
// Phase 0 = SIMULATION. We pretend the venue PA emits time-synchronized chirps
// from known speaker positions; this module fakes the time-difference-of-arrival
// (TDOA) a real phone mic + matched filter would report, then solves for the
// phone's position with the *real* solver. Going live (Phase 1) replaces only
// `_measureTDOA()` with real audio — `solveTDOA()` below stays exactly as is.

import { SPEED_OF_SOUND, dist, solveTDOA } from '/dsp.js';

// Example venue: a 110 x 75 m field with a speaker cluster in each corner.
export const VENUE = {
  width: 110,
  height: 75,
  speakers: [
    { x: 0,   y: 0  },
    { x: 110, y: 0  },
    { x: 110, y: 75 },
    { x: 0,   y: 75 },
  ],
};

export class Localizer {
  constructor(venue = VENUE) {
    this.venue = venue;
    // SIM ONLY: a hidden "true" position. In Phase 1 this is unknown — the
    // whole point is to recover it from sound.
    this.truth = { x: Math.random() * venue.width, y: Math.random() * venue.height };
    this.estimate = null;
    this.confidence = 0;
  }

  // SIM: synthesize the TDOA vector a real mic + matched filter would produce.
  _measureTDOA() {
    const sp = this.venue.speakers;
    const t = sp.map((s) => dist(this.truth, s) / SPEED_OF_SOUND);
    const jitter = () => (Math.random() - 0.5) * 0.0006; // ~0.3 ms ≈ 10 cm noise
    return sp.map((_, i) => (t[i] - t[0]) + jitter());
  }

  // Run one localization pass. Returns { x, y, confidence }.
  fix() {
    const tdoa = this._measureTDOA();
    const guess = { x: this.venue.width / 2, y: this.venue.height / 2 };
    this.estimate = solveTDOA(this.venue.speakers, tdoa, guess);
    const err = dist(this.estimate, this.truth);
    this.confidence = Math.max(0, 1 - err / 5); // usable within ~5 m
    return { ...this.estimate, confidence: this.confidence };
  }

  // Position normalized to [0..1] for the renderer.
  normalized() {
    if (!this.estimate) return null;
    return { nx: this.estimate.x / this.venue.width, ny: this.estimate.y / this.venue.height };
  }
}
