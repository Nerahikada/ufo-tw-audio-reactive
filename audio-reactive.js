/**
 * Audio analysis for reactive motor control.
 *
 * Wraps an AnalyserNode and exposes per-frame analysis results:
 * overall level, bass/treble energy, beat detection, and spectral centroid.
 */

// Frequency band boundaries (fraction of FFT bins)
// At 44.1 kHz / fftSize 1024:
const BASS_END = 0.03; //   ~0–650 Hz
const TREBLE_START = 0.1; //  ~2 kHz
const TREBLE_END = 0.5; // ~11 kHz

// Per-band sensitivity multipliers
const LEVEL_GAIN = 200;
const BASS_GAIN = 300;
const TREBLE_GAIN = 400;

// Spectral centroid uses its own fixed smoothing
const CENTROID_ALPHA = 0.15;

// Beat detection
const BEAT_HISTORY_LEN = 30;
const BEAT_MIN_HISTORY = 10;
const BEAT_THRESHOLD = 1.5;
const BEAT_MIN_LEVEL = 5;

export class AudioReactive {
  #analyser;
  #analyserL;
  #analyserR;

  // Pre-allocated buffers (avoid per-frame allocation)
  #timeBuf;
  #freqData;
  #timeBufL;
  #timeBufR;

  // Smoothed values
  #level = 0;
  #bass = 0;
  #treble = 0;
  #centroid = 0.5;
  #left = 0;
  #right = 0;

  // Beat detectors
  #beat;
  #beatL;
  #beatR;

  /**
   * @param {AnalyserNode} analyser  Main (mono-mix) analyser
   * @param {{ left?: AnalyserNode, right?: AnalyserNode }} [stereo]
   *   Optional per-channel analysers fed via ChannelSplitterNode.
   */
  constructor(analyser, { left, right } = {}) {
    this.#analyser = analyser;
    this.#analyserL = left ?? null;
    this.#analyserR = right ?? null;

    this.#timeBuf = new Float32Array(analyser.fftSize);
    this.#freqData = new Uint8Array(analyser.frequencyBinCount);
    this.#timeBufL = left ? new Float32Array(left.fftSize) : null;
    this.#timeBufR = right ? new Float32Array(right.fftSize) : null;

    this.#beat = new BeatDetector();
    this.#beatL = new BeatDetector();
    this.#beatR = new BeatDetector();
  }

  /** Reset all internal smoothing / history state. */
  reset() {
    this.#level = 0;
    this.#bass = 0;
    this.#treble = 0;
    this.#centroid = 0.5;
    this.#left = 0;
    this.#right = 0;
    this.#beat.reset();
    this.#beatL.reset();
    this.#beatR.reset();
  }

  /**
   * Run one frame of analysis.  Call once per `requestAnimationFrame`.
   *
   * @param {{ sensitivity: number, smoothing: number }} opts
   *   - sensitivity: multiplier for raw energy (default UI range 0.5–5)
   *   - smoothing: exponential smoothing factor (0 = none, 1 = frozen)
   * @returns {{
   *   level: number,     rawLevel: number,
   *   bass: number,      treble: number,
   *   beat: boolean,     centroid: number,
   * }}
   */
  update({ sensitivity, smoothing, sustain = 0, beatCooldown = 30 }) {
    const alpha = 1 - smoothing;
    const releaseAlpha = alpha * (1 - sustain);

    // ---- Mono level (RMS) ----
    const rawLevel = clamp100(
      this.#rms(this.#analyser, this.#timeBuf) * sensitivity * LEVEL_GAIN,
    );
    this.#level = smooth(this.#level, rawLevel, alpha, releaseAlpha);

    // ---- Frequency bands ----
    this.#analyser.getByteFrequencyData(this.#freqData);

    const rawBass = this.#bandEnergy(0, BASS_END, sensitivity * BASS_GAIN);
    const rawTreble = this.#bandEnergy(
      TREBLE_START,
      TREBLE_END,
      sensitivity * TREBLE_GAIN,
    );
    this.#bass += (rawBass - this.#bass) * alpha;
    this.#treble += (rawTreble - this.#treble) * alpha;

    // ---- Beat detection (mono) ----
    const beat = this.#beat.detect(rawLevel, beatCooldown);

    // ---- Spectral centroid ----
    this.#centroid = this.#updateCentroid();

    // ---- Stereo levels + per-channel beats ----
    let beatL = false,
      beatR = false;
    if (this.#analyserL && this.#analyserR) {
      const rawL = clamp100(
        this.#rms(this.#analyserL, this.#timeBufL) * sensitivity * LEVEL_GAIN,
      );
      const rawR = clamp100(
        this.#rms(this.#analyserR, this.#timeBufR) * sensitivity * LEVEL_GAIN,
      );
      this.#left = smooth(this.#left, rawL, alpha, releaseAlpha);
      this.#right = smooth(this.#right, rawR, alpha, releaseAlpha);

      beatL = this.#beatL.detect(rawL, beatCooldown);
      beatR = this.#beatR.detect(rawR, beatCooldown);
    }

    return {
      level: this.#level,
      rawLevel,
      bass: this.#bass,
      treble: this.#treble,
      beat,
      centroid: this.#centroid,
      left: this.#left,
      right: this.#right,
      beatL,
      beatR,
      freqData: this.#freqData,
      timeBuf: this.#timeBuf,
    };
  }

  /** Compute RMS of an AnalyserNode into a pre-allocated buffer. */
  #rms(node, buf) {
    node.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  /** Average energy in a frequency band (bin fractions), scaled to 0–100. */
  #bandEnergy(startFrac, endFrac, gain) {
    const n = this.#freqData.length;
    const start = Math.max(Math.floor(n * startFrac), 1);
    const end = Math.max(Math.floor(n * endFrac), start + 1);
    let sum = 0;
    for (let i = start; i < end; i++) sum += this.#freqData[i];
    return clamp100((sum / (end - start) / 255) * gain);
  }

  /** Smooth spectral centroid toward the current frame's value. */
  #updateCentroid() {
    const n = this.#freqData.length;
    let weightedSum = 0;
    let totalMag = 0;
    for (let i = 1; i < n; i++) {
      weightedSum += i * this.#freqData[i];
      totalMag += this.#freqData[i];
    }
    const raw = totalMag === 0 ? 0.5 : weightedSum / totalMag / n;
    return this.#centroid + (raw - this.#centroid) * CENTROID_ALPHA;
  }
}

// ---- Helpers ----

/** Attack/release exponential smoothing. */
function smooth(current, target, attackAlpha, releaseAlpha) {
  const a = target >= current ? attackAlpha : releaseAlpha;
  return current + (target - current) * a;
}

function clamp100(v) {
  return Math.min(v, 100);
}

// ---- Beat detection ----

export class BeatDetector {
  #history = [];
  #cooldown = 0;

  reset() {
    this.#history = [];
    this.#cooldown = 0;
  }

  /** Returns true if a beat was detected this frame. */
  detect(level, cooldownFrames) {
    this.#history.push(level);
    if (this.#history.length > BEAT_HISTORY_LEN) this.#history.shift();

    if (this.#cooldown > 0) {
      this.#cooldown--;
      return false;
    }
    if (this.#history.length < BEAT_MIN_HISTORY) return false;

    const avg = this.#history.reduce((a, b) => a + b) / this.#history.length;
    if (level > avg * BEAT_THRESHOLD && level > BEAT_MIN_LEVEL) {
      this.#cooldown = cooldownFrames;
      return true;
    }
    return false;
  }
}
