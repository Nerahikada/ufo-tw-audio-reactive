// DeviceCountObserver — experimental opt-in observer that detects
// how many physical units are connected to a U.F.O. TW device.
//
// It polls the GAP Device Name characteristic and infers the count
// from the name format: "UFO TW" (space) = 1, "UFO-TW" (hyphen) = 2.
//
// Example:
//   import { UfoTw } from "./ufo-tw.js";
//   import { DeviceCountObserver } from "./ufo-tw-device-count.js";
//
//   const ufo = new UfoTw();
//   await ufo.connect();
//
//   const observer = new DeviceCountObserver(ufo);
//   observer.addEventListener("change", () => {
//     console.log("count:", observer.deviceCount);
//   });
//   await observer.start();

export class DeviceCountObserver extends EventTarget {
  static OPTIONAL_SERVICES = [0x1800];
  static #POLL_MS = 2000;

  #ufo;
  #nameCharacteristic = null;
  #deviceCount = 0;
  #controller = null;
  #loopDone = null;

  /**
   * @param {import("../ufo-tw.js").UfoTw} ufo - 接続済みまたはこれから接続する UfoTw インスタンス
   */
  constructor(ufo) {
    super();
    this.#ufo = ufo;
  }

  /**
   * 現在のデバイス台数（1 = 子ユニットのみ、2 = 親子両方）。
   * 未開始の場合は `0`。
   * @type {number}
   */
  get deviceCount() {
    return this.#deviceCount;
  }

  /**
   * GAP Device Name のポーリングを開始する。
   * UfoTw が接続済みである必要がある。
   * @returns {Promise<void>}
   * @throws {Error} UfoTw が未接続の場合、または GAP サービスにアクセスできない場合
   */
  async start() {
    if (this.#controller) return;
    if (!this.#ufo.connected) throw new Error("UfoTw not connected");

    const server = this.#ufo.device.gatt;
    const gap = await server.getPrimaryService(0x1800);
    this.#nameCharacteristic = await gap.getCharacteristic(0x2a00);

    // Initial read
    const val = await this.#nameCharacteristic.readValue();
    this.#deviceCount = parseDeviceCount(new TextDecoder().decode(val));

    const controller = new AbortController();
    this.#controller = controller;

    this.#loopDone = (async () => {
      while (!controller.signal.aborted) {
        await sleep(DeviceCountObserver.#POLL_MS);
        if (controller.signal.aborted) break;

        try {
          const val = await this.#nameCharacteristic.readValue();
          const count = parseDeviceCount(new TextDecoder().decode(val));
          if (count !== this.#deviceCount) {
            this.#deviceCount = count;
            this.dispatchEvent(new Event("change"));
          }
        } catch {
          // read failed — skip this cycle
        }
      }
    })().catch((e) => console.error("DeviceCountObserver loop error:", e));
  }

  /**
   * ポーリングを停止する。
   * @returns {Promise<void>}
   */
  async stop() {
    this.#controller?.abort();
    await this.#loopDone;
    this.#controller = null;
    this.#loopDone = null;
    this.#nameCharacteristic = null;
    this.#deviceCount = 0;
  }
}

function parseDeviceCount(name) {
  if (!name) return 0;
  // "UFO-TW" (hyphen) = 2 units, "UFO TW" (space) = 1 unit
  return name.includes("-") ? 2 : 1;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
