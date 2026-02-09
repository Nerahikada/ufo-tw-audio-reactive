/**
 * Audio analysis for reactive motor control.
 *
 * Wraps an AnalyserNode and exposes per-frame analysis results:
 * overall level, bass/treble energy, beat detection, and spectral centroid.
 */
export class AudioReactive {
  #analyser;
  #freqData;

  // Smoothed values
  #level = 0;
  #bass = 0;
  #treble = 0;
  #centroid = 0.5;

  // Stereo (optional)
  #analyserL;
  #analyserR;
  #left = 0;
  #right = 0;

  // Beat detection (mono)
  #energyHistory = [];
  #beatCooldown = 0;
  // Beat detection (per-channel)
  #energyHistoryL = [];
  #energyHistoryR = [];
  #beatCooldownL = 0;
  #beatCooldownR = 0;

  /**
   * @param {AnalyserNode} analyser  Main (mono-mix) analyser
   * @param {{ left?: AnalyserNode, right?: AnalyserNode }} [stereo]
   *   Optional per-channel analysers fed via ChannelSplitterNode.
   */
  constructor(analyser, { left, right } = {}) {
    this.#analyser = analyser;
    this.#analyserL = left ?? null;
    this.#analyserR = right ?? null;
    this.#freqData = new Uint8Array(analyser.frequencyBinCount);
  }

  /** Reset all internal smoothing / history state. */
  reset() {
    this.#level = 0;
    this.#bass = 0;
    this.#treble = 0;
    this.#centroid = 0.5;
    this.#left = 0;
    this.#right = 0;
    this.#energyHistory = [];
    this.#beatCooldown = 0;
    this.#energyHistoryL = [];
    this.#energyHistoryR = [];
    this.#beatCooldownL = 0;
    this.#beatCooldownR = 0;
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
    // Release alpha: when signal drops, decay slower based on sustain
    const releaseAlpha = alpha * (1 - sustain);

    // ---- RMS from time-domain data ----
    const timeBuf = new Float32Array(this.#analyser.fftSize);
    this.#analyser.getFloatTimeDomainData(timeBuf);
    let sum = 0;
    for (let i = 0; i < timeBuf.length; i++) sum += timeBuf[i] * timeBuf[i];
    const rms = Math.sqrt(sum / timeBuf.length);

    const rawLevel = Math.min(rms * sensitivity * 200, 100);
    this.#level +=
      (rawLevel - this.#level) *
      (rawLevel >= this.#level ? alpha : releaseAlpha);

    // ---- Frequency-domain data ----
    this.#analyser.getByteFrequencyData(this.#freqData);
    const n = this.#freqData.length;

    // ---- Frequency bands ----
    //  Bass  : first ~3 % of bins  (~0 – 650 Hz at 44.1 kHz / fftSize 1024)
    //  Treble: 10 %–50 % of bins   (~2 kHz – 11 kHz)
    const bassEnd = Math.max(Math.floor(n * 0.03), 2);
    const trebleStart = Math.floor(n * 0.1);
    const trebleEnd = Math.floor(n * 0.5);

    let bassSum = 0;
    for (let i = 1; i < bassEnd; i++) bassSum += this.#freqData[i];

    let trebleSum = 0;
    for (let i = trebleStart; i < trebleEnd; i++)
      trebleSum += this.#freqData[i];

    const rawBass = Math.min(
      (bassSum / (bassEnd - 1) / 255) * sensitivity * 300,
      100,
    );
    const rawTreble = Math.min(
      (trebleSum / (trebleEnd - trebleStart) / 255) * sensitivity * 400,
      100,
    );
    this.#bass += (rawBass - this.#bass) * alpha;
    this.#treble += (rawTreble - this.#treble) * alpha;

    // ---- Beat detection (energy-flux, mono) ----
    let beat;
    [beat, this.#beatCooldown] = AudioReactive.#detectBeat(
      rawLevel,
      this.#energyHistory,
      this.#beatCooldown,
      beatCooldown,
    );

    // ---- Spectral centroid ----
    let weightedSum = 0;
    let totalMag = 0;
    for (let i = 1; i < n; i++) {
      weightedSum += i * this.#freqData[i];
      totalMag += this.#freqData[i];
    }
    const rawCentroid = totalMag === 0 ? 0.5 : weightedSum / totalMag / n;
    this.#centroid += (rawCentroid - this.#centroid) * 0.15;

    // ---- Stereo channel levels + per-channel beats ----
    let beatL = false,
      beatR = false;
    if (this.#analyserL && this.#analyserR) {
      const rmsL = this.#channelRMS(this.#analyserL);
      const rmsR = this.#channelRMS(this.#analyserR);
      const rawL = Math.min(rmsL * sensitivity * 200, 100);
      const rawR = Math.min(rmsR * sensitivity * 200, 100);
      this.#left +=
        (rawL - this.#left) * (rawL >= this.#left ? alpha : releaseAlpha);
      this.#right +=
        (rawR - this.#right) * (rawR >= this.#right ? alpha : releaseAlpha);

      [beatL, this.#beatCooldownL] = AudioReactive.#detectBeat(
        rawL,
        this.#energyHistoryL,
        this.#beatCooldownL,
        beatCooldown,
      );
      [beatR, this.#beatCooldownR] = AudioReactive.#detectBeat(
        rawR,
        this.#energyHistoryR,
        this.#beatCooldownR,
        beatCooldown,
      );
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
    };
  }

  /**
   * Energy-flux beat detection on a single stream.
   * Mutates history in place; returns [detected, newCooldown].
   */
  static #detectBeat(raw, history, cooldown, cooldownFrames) {
    history.push(raw);
    if (history.length > 30) history.shift();
    if (cooldown > 0) return [false, cooldown - 1];
    if (history.length < 10) return [false, 0];
    const avg = history.reduce((a, b) => a + b) / history.length;
    if (raw > avg * 1.5 && raw > 5) return [true, cooldownFrames];
    return [false, 0];
  }

  /** Compute RMS of a single-channel AnalyserNode. */
  #channelRMS(node) {
    const buf = new Float32Array(node.fftSize);
    node.getFloatTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / buf.length);
  }
}
