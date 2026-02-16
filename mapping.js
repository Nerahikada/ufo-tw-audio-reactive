/**
 * Mapping policies — convert AudioFeatures into MotorCommands.
 *
 * A MappingPolicy is any object that satisfies:
 *   name:   string              — display name for the UI
 *   params: ParamDef[]          — declarative parameter definitions
 *   reset(): void               — reset internal state
 *   map(features, params): MotorCommand
 *
 * ParamDef: { id, label, type:"range", min, max, step, value }
 * MotorCommand: { parentDir, parentSpeed, childDir, childSpeed }
 */

import { Direction } from "./ufo-tw.js";

// ---- Helpers ----

function gateToSpeed(level, gateThreshold) {
  if (level < gateThreshold) return 0;
  return Math.min(
    Math.round(((level - gateThreshold) / (100 - gateThreshold)) * 100),
    100,
  );
}

// ---- BasicMapping ----

/**
 * Default mapping: linear gate-to-speed with stereo blend and
 * beat-driven direction toggle. Reproduces the original hardcoded
 * behaviour from app.js.
 */
export class BasicMapping {
  name = "ベーシック";

  #beatDirL = false;
  #beatDirR = false;

  params = [
    {
      id: "gateThreshold",
      label: "ノイズゲート",
      type: "range",
      min: 0,
      max: 30,
      step: 1,
      value: 0,
    },
    {
      id: "separation",
      label: "LR分離度",
      type: "range",
      min: 0,
      max: 1,
      step: 0.05,
      value: 1,
    },
  ];

  reset() {
    this.#beatDirL = false;
    this.#beatDirR = false;
  }

  /**
   * @param {object} f  AudioFeatures from AudioReactive.update()
   * @param {object} p  Current parameter values keyed by ParamDef.id
   * @returns {{ parentDir: string, parentSpeed: number, childDir: string, childSpeed: number }}
   */
  map(f, p) {
    const sep = p.separation;
    const gate = p.gateThreshold;

    // Stereo blend (0 = mono, 1 = full stereo)
    const mono = (f.left + f.right) / 2;
    const effectiveL = mono + (f.left - mono) * sep;
    const effectiveR = mono + (f.right - mono) * sep;

    const parentSpeed = gateToSpeed(effectiveL, gate);
    const childSpeed = gateToSpeed(effectiveR, gate);

    // Beat-driven direction toggle
    if (sep < 0.5) {
      if (f.beatL || f.beatR) {
        this.#beatDirL = !this.#beatDirL;
        this.#beatDirR = !this.#beatDirR;
      }
    } else {
      if (f.beatL) this.#beatDirL = !this.#beatDirL;
      if (f.beatR) this.#beatDirR = !this.#beatDirR;
    }

    return {
      parentDir: this.#beatDirL ? Direction.CW : Direction.CCW,
      parentSpeed,
      childDir: this.#beatDirR ? Direction.CW : Direction.CCW,
      childSpeed,
    };
  }
}

// ---- TeasingMapping ----

const TEASING_HISTORY_LEN = 90; // ~1.5 s at 60 fps
const TEASING_RECENT_LEN = 15; // ~0.25 s window for trend
const TEASING_TREND_THRESHOLD = 2; // minimum rising trend to enter buildup
const TEASING_RELEASE_FRAMES = 25; // ~0.4 s of boosted release

/**
 * Teasing mapping: suppress stimulation during audio buildups,
 * then release with a boost when an onset is detected.
 *
 * Phases:
 *   normal  — standard level-to-speed mapping
 *   buildup — energy is rising; speed is suppressed to build anticipation
 *   release — onset detected during buildup; speed is boosted
 */
export class TeasingMapping {
  name = "じらし";

  #beatDirL = false;
  #beatDirR = false;
  #energyHistory = [];
  #releaseTimer = 0;

  params = [
    {
      id: "gateThreshold",
      label: "ノイズゲート",
      type: "range",
      min: 0,
      max: 30,
      step: 1,
      value: 0,
    },
    {
      id: "separation",
      label: "LR分離度",
      type: "range",
      min: 0,
      max: 1,
      step: 0.05,
      value: 1,
    },
    {
      id: "suppress",
      label: "抑制度",
      type: "range",
      min: 0.1,
      max: 0.9,
      step: 0.05,
      value: 0.5,
    },
    {
      id: "releaseBoost",
      label: "解放ブースト",
      type: "range",
      min: 1,
      max: 2,
      step: 0.1,
      value: 1.5,
    },
  ];

  reset() {
    this.#beatDirL = false;
    this.#beatDirR = false;
    this.#energyHistory = [];
    this.#releaseTimer = 0;
  }

  map(f, p) {
    // Track energy trend
    this.#energyHistory.push(f.level);
    if (this.#energyHistory.length > TEASING_HISTORY_LEN) {
      this.#energyHistory.shift();
    }

    const avg = arrayAvg(this.#energyHistory);
    const recentAvg = arrayAvg(
      this.#energyHistory.slice(-TEASING_RECENT_LEN),
    );
    const trend = recentAvg - avg;

    // Phase detection
    let speedMod = 1;
    if (this.#releaseTimer > 0) {
      this.#releaseTimer--;
      speedMod = p.releaseBoost;
    } else if (trend > TEASING_TREND_THRESHOLD && f.level > avg) {
      // Buildup: energy is rising → suppress
      speedMod = 1 - p.suppress;
      // Onset during buildup → trigger release
      if (f.onset) {
        this.#releaseTimer = TEASING_RELEASE_FRAMES;
        speedMod = p.releaseBoost;
      }
    }

    // Stereo blend + gate (same as BasicMapping)
    const sep = p.separation;
    const gate = p.gateThreshold;
    const mono = (f.left + f.right) / 2;
    const effectiveL = mono + (f.left - mono) * sep;
    const effectiveR = mono + (f.right - mono) * sep;

    const parentSpeed = clamp(
      Math.round(gateToSpeed(effectiveL, gate) * speedMod),
      0,
      100,
    );
    const childSpeed = clamp(
      Math.round(gateToSpeed(effectiveR, gate) * speedMod),
      0,
      100,
    );

    // Direction
    if (sep < 0.5) {
      if (f.beatL || f.beatR) {
        this.#beatDirL = !this.#beatDirL;
        this.#beatDirR = !this.#beatDirR;
      }
    } else {
      if (f.beatL) this.#beatDirL = !this.#beatDirL;
      if (f.beatR) this.#beatDirR = !this.#beatDirR;
    }

    return {
      parentDir: this.#beatDirL ? Direction.CW : Direction.CCW,
      parentSpeed,
      childDir: this.#beatDirR ? Direction.CW : Direction.CCW,
      childSpeed,
    };
  }
}

// ---- Shared helpers ----

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

function arrayAvg(arr) {
  if (arr.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i];
  return sum / arr.length;
}

// ---- PatternMapping ----

/**
 * Pattern mapping: generates oscillating motor patterns modulated
 * by the audio level. The audio controls the amplitude of the
 * pattern, not the speed directly.
 *
 * Patterns:
 *   wave  — sinusoidal oscillation
 *   pulse — short periodic bursts
 *   climb — sawtooth ramp that resets on onset
 *   chaos — random speed variation per channel
 */
export class PatternMapping {
  name = "パターン";

  #phase = 0;
  #beatDirL = false;
  #beatDirR = false;
  #chaosL = 0;
  #chaosR = 0;
  #chaosTimer = 0;

  params = [
    {
      id: "gateThreshold",
      label: "ノイズゲート",
      type: "range",
      min: 0,
      max: 30,
      step: 1,
      value: 0,
    },
    {
      id: "separation",
      label: "LR分離度",
      type: "range",
      min: 0,
      max: 1,
      step: 0.05,
      value: 1,
    },
    {
      id: "pattern",
      label: "パターン",
      type: "select",
      options: [
        { value: "wave", label: "ウェーブ" },
        { value: "pulse", label: "パルス" },
        { value: "climb", label: "クライム" },
        { value: "chaos", label: "カオス" },
      ],
      value: "wave",
    },
    {
      id: "rate",
      label: "パターン速度",
      type: "range",
      min: 0.5,
      max: 5,
      step: 0.1,
      value: 1,
    },
    {
      id: "depth",
      label: "変調深度",
      type: "range",
      min: 0,
      max: 1,
      step: 0.05,
      value: 0.5,
    },
  ];

  reset() {
    this.#phase = 0;
    this.#beatDirL = false;
    this.#beatDirR = false;
    this.#chaosL = 0;
    this.#chaosR = 0;
    this.#chaosTimer = 0;
  }

  map(f, p) {
    this.#phase += p.rate / 60;

    // Reset climb on onset
    if (p.pattern === "climb" && f.onset) {
      this.#phase = 0;
    }

    // Update chaos values periodically
    if (p.pattern === "chaos") {
      this.#chaosTimer++;
      if (this.#chaosTimer >= 6) {
        this.#chaosL = Math.random();
        this.#chaosR = Math.random();
        this.#chaosTimer = 0;
      }
    }

    // Base audio level with stereo blend + gate
    const sep = p.separation;
    const gate = p.gateThreshold;
    const mono = (f.left + f.right) / 2;
    const effectiveL = mono + (f.left - mono) * sep;
    const effectiveR = mono + (f.right - mono) * sep;
    const baseL = gateToSpeed(effectiveL, gate);
    const baseR = gateToSpeed(effectiveR, gate);

    // Pattern modulation: depth controls how much the pattern
    // shapes the output. At depth=0, output equals base level.
    // At depth=1, output is fully pattern-shaped.
    const modL = this.#patternValue(p.pattern, this.#phase, false);
    const modR = this.#patternValue(p.pattern, this.#phase, true);
    const d = p.depth;
    const parentSpeed = clamp(Math.round(baseL * (1 - d + d * modL)), 0, 100);
    const childSpeed = clamp(Math.round(baseR * (1 - d + d * modR)), 0, 100);

    // Direction
    if (f.beatL) this.#beatDirL = !this.#beatDirL;
    if (f.beatR) this.#beatDirR = !this.#beatDirR;

    return {
      parentDir: this.#beatDirL ? Direction.CW : Direction.CCW,
      parentSpeed,
      childDir: this.#beatDirR ? Direction.CW : Direction.CCW,
      childSpeed,
    };
  }

  /** Returns 0–1 modulation value for the given pattern. */
  #patternValue(pattern, phase, isRight) {
    switch (pattern) {
      case "wave":
        return (Math.sin(phase * Math.PI * 2) + 1) / 2;
      case "pulse":
        return (phase % 1) < 0.3 ? 1 : 0;
      case "climb":
        return Math.min(phase, 1);
      case "chaos":
        return isRight ? this.#chaosR : this.#chaosL;
      default:
        return 1;
    }
  }
}

// ---- BinauralMapping ----

/**
 * Binaural mapping: uses the pan value from AudioReactive to create
 * asymmetric motor speeds that follow the spatial position of sound.
 *
 * When sound moves to the left ear, the parent (L) motor intensifies
 * while the child (R) motor eases off, and vice versa.
 */
export class BinauralMapping {
  name = "バイノーラル";

  #beatDirL = false;
  #beatDirR = false;

  params = [
    {
      id: "gateThreshold",
      label: "ノイズゲート",
      type: "range",
      min: 0,
      max: 30,
      step: 1,
      value: 0,
    },
    {
      id: "panInfluence",
      label: "空間追従",
      type: "range",
      min: 0,
      max: 1,
      step: 0.05,
      value: 0.7,
    },
    {
      id: "panBoost",
      label: "集中ブースト",
      type: "range",
      min: 1,
      max: 1.5,
      step: 0.05,
      value: 1.2,
    },
  ];

  reset() {
    this.#beatDirL = false;
    this.#beatDirR = false;
  }

  map(f, p) {
    const gate = p.gateThreshold;
    const pan = f.pan || 0; // -1 (left) to +1 (right)
    const influence = p.panInfluence;
    const boost = p.panBoost;

    const baseSpeed = gateToSpeed(f.level, gate);

    // Pan → asymmetric motor speeds
    // pan=-1 (full left): parentMul=boost, childMul=1-influence
    // pan= 0 (center):    both=1
    // pan=+1 (full right): parentMul=1-influence, childMul=boost
    const leftBoost = clamp(1 + Math.max(0, -pan) * (boost - 1), 0, boost);
    const rightBoost = clamp(1 + Math.max(0, pan) * (boost - 1), 0, boost);
    const leftAtten = 1 - Math.max(0, pan) * influence;
    const rightAtten = 1 - Math.max(0, -pan) * influence;

    const parentSpeed = clamp(
      Math.round(baseSpeed * leftAtten * leftBoost),
      0,
      100,
    );
    const childSpeed = clamp(
      Math.round(baseSpeed * rightAtten * rightBoost),
      0,
      100,
    );

    // Direction from per-channel beats
    if (f.beatL) this.#beatDirL = !this.#beatDirL;
    if (f.beatR) this.#beatDirR = !this.#beatDirR;

    return {
      parentDir: this.#beatDirL ? Direction.CW : Direction.CCW,
      parentSpeed,
      childDir: this.#beatDirR ? Direction.CW : Direction.CCW,
      childSpeed,
    };
  }
}

// ---- Policy registry ----

/** All available mapping policies. Values are factory functions. */
export const POLICIES = new Map([
  ["basic", () => new BasicMapping()],
  ["teasing", () => new TeasingMapping()],
  ["pattern", () => new PatternMapping()],
  ["binaural", () => new BinauralMapping()],
]);

export const DEFAULT_POLICY_ID = "basic";
