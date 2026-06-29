// Mic capture worklet for the positioning path: forwards contiguous, non-
// overlapping sample blocks tagged with their absolute sample index (`base`).
// Contiguity + the index let the main thread place chirp-search windows on the
// exact sample, which is what makes time-difference-of-arrival accurate.
class MicCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1024);
    this.n = 0;
    this.base = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true; // keep alive on silent input
    for (let i = 0; i < ch.length; i++) {
      if (this.n === 0) this.base = currentFrame + i; // sample index of buf[0]
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) {
        this.port.postMessage({ base: this.base, samples: this.buf });
        this.buf = new Float32Array(1024);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('mic-capture', MicCapture);
