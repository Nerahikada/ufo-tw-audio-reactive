import { Direction } from "./ufo-tw.js";

/**
 * Motor visualization — updates DOM elements to reflect
 * current direction and speed of the two motor units.
 */
export class MotorVisualizer {
  #$parentDir;
  #$parentSpeed;
  #$childDir;
  #$childSpeed;

  /**
   * @param {{
   *   parentDir: HTMLElement,
   *   parentSpeed: HTMLElement,
   *   childDir: HTMLElement,
   *   childSpeed: HTMLElement,
   * }} els
   */
  constructor(els) {
    this.#$parentDir = els.parentDir;
    this.#$parentSpeed = els.parentSpeed;
    this.#$childDir = els.childDir;
    this.#$childSpeed = els.childSpeed;
  }

  update(pDir, pSpd, cDir, cSpd) {
    this.#$parentSpeed.textContent = pSpd;
    this.#$childSpeed.textContent = cSpd;

    this.#$parentDir.textContent =
      pSpd === 0 ? "■" : pDir === Direction.CW ? "⟳" : "⟲";
    this.#$childDir.textContent =
      cSpd === 0 ? "■" : cDir === Direction.CW ? "⟳" : "⟲";

    this.#$parentDir.className =
      "motor-dir " + (pSpd === 0 ? "" : pDir === Direction.CW ? "cw" : "ccw");
    this.#$childDir.className =
      "motor-dir " + (cSpd === 0 ? "" : cDir === Direction.CW ? "cw" : "ccw");
  }

  reset() {
    this.update(Direction.CW, 0, Direction.CW, 0);
  }
}
