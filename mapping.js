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

// ---- Policy registry ----

/** All available mapping policies. Values are factory functions. */
export const POLICIES = new Map([
  ["basic", () => new BasicMapping()],
]);

export const DEFAULT_POLICY_ID = "basic";
