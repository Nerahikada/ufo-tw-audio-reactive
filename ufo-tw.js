// U.F.O. TW — a BLE-controlled toy consisting of two independent motor units.
// It has two motors, parent unit and child unit, each independently
// controllable in direction (CW/CCW) and speed (0–100).
//
// Example:
//   import { UfoTw, Motor, Direction } from "./ufo-tw.js";
//
//   await using ufo = new UfoTw();
//   await ufo.connect();
//
//   ufo.setSpeed(Motor.LEFT, Direction.CW, 80);
//   ufo.setSpeed(Motor.RIGHT, Direction.CCW, 50);
//
//   ufo.stop();

/**
 * モーターの回転方向を表す定数。
 * @enum {string}
 * @property {string} CW - 時計回り
 * @property {string} CLOCKWISE - 時計回り（`CW` のエイリアス）
 * @property {string} CCW - 反時計回り
 * @property {string} COUNTERCLOCKWISE - 反時計回り（`CCW` のエイリアス）
 */
export const Direction = Object.freeze({
  CW: "cw",
  CCW: "ccw",
  // user-friendly aliases
  CLOCKWISE: "cw",
  COUNTERCLOCKWISE: "ccw",
});

/**
 * 制御対象のモーターを表す定数。
 * @enum {string}
 * @property {string} PARENT - 親ユニット（先に電源を入れた側）
 * @property {string} CHILD - 子ユニット（後から電源を入れ、親に接続した側）
 * @property {string} LEFT - `PARENT` のエイリアス
 * @property {string} RIGHT - `CHILD` のエイリアス
 */
export const Motor = Object.freeze({
  PARENT: "parent",
  CHILD: "child",
  // user-friendly aliases
  LEFT: "parent",
  RIGHT: "child",
});

/**
 * BLE 経由で U.F.O. TW デバイスを制御するクラス。
 *
 * 親ユニット（左）と子ユニット（右）の 2 つのモーターを独立して操作できる。
 * 内部でポーリングループを持ち、{@link setSpeed} / {@link stop} で設定された
 * 速度・方向を定期的に BLE キャラクタリスティックへ書き込む。
 *
 * `Symbol.asyncDispose` を実装しているため `await using` 構文で自動切断が可能。
 *
 * @extends EventTarget
 * @fires UfoTw#disconnect - BLE 接続が切断されたとき
 *
 * @example
 * await using ufo = new UfoTw();
 * await ufo.connect();
 *
 * ufo.setSpeed(Motor.LEFT, Direction.CW, 80);
 * ufo.setSpeed(Motor.RIGHT, Direction.CCW, 50);
 *
 * ufo.stop();
 */
export class UfoTw extends EventTarget {
  /** @type {string} BLE サービス UUID */
  static SERVICE_UUID = "40ee1111-63ec-4b7f-8ce7-712efd55b90e";
  /** @type {string} BLE キャラクタリスティック UUID */
  static CHARACTERISTIC_UUID = "40ee2222-63ec-4b7f-8ce7-712efd55b90e";
  static #DEVICE_ID = 5;
  static #POLL_MS = 100;
  #characteristic = null;
  #device = null;
  #parentByte = 0;
  #childByte = 0;
  #pending = null;
  #written = null;
  #loopController = null;
  #loopDone = null;

  /**
   * デバイスが BLE 接続中かどうか。
   * @type {boolean}
   */
  get connected() {
    return this.#device?.gatt.connected ?? false;
  }

  /**
   * 接続中のデバイス名。未接続の場合は `null`。
   * @type {string | null}
   */
  get deviceName() {
    return this.#device?.name ?? null;
  }

  /**
   * 接続中の BLE デバイスオブジェクト。未接続の場合は `null`。
   * @type {BluetoothDevice | null}
   */
  get device() {
    return this.#device;
  }

  /**
   * BLE デバイスを検索し接続する。
   * ブラウザのデバイス選択ダイアログが表示される。
   * @returns {Promise<void>}
   * @throws {Error} 既に接続済みの場合、またはデバイス名が取得できない場合
   */
  async connect() {
    if (this.connected) throw new Error("Already connected");

    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [UfoTw.SERVICE_UUID] }],
      optionalServices: [0x1800],
    });

    if (!device.name) throw new Error("Device name unavailable");

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(UfoTw.SERVICE_UUID);
    this.#characteristic = await service.getCharacteristic(
      UfoTw.CHARACTERISTIC_UUID,
    );
    this.#device = device;

    device.addEventListener("gattserverdisconnected", () => {
      this.#reset();
      this.dispatchEvent(new Event("disconnect"));
    });

    this.#startLoop();
  }

  /**
   * 指定モーターの回転方向と速度を設定する。
   * 実際の BLE 書き込みはバックグラウンドのポーリングループで行われる。
   * @param {Motor} motor - 制御対象のモーター
   * @param {Direction} direction - 回転方向
   * @param {number} power - 速度（0–100）
   * @throws {Error} 未接続の場合、または無効なモーターを指定した場合
   */
  setSpeed(motor, direction, power) {
    if (!this.connected) throw new Error("Not connected");

    const byte = encodeByte(direction, power);
    if (motor === Motor.PARENT) this.#parentByte = byte;
    else if (motor === Motor.CHILD) this.#childByte = byte;
    else throw new Error(`Invalid motor: ${motor}`);

    this.#pending = [UfoTw.#DEVICE_ID, this.#parentByte, this.#childByte];
  }

  /**
   * 両モーターを停止する。
   * @throws {Error} 未接続の場合
   */
  stop() {
    if (!this.connected) throw new Error("Not connected");
    this.#parentByte = 0;
    this.#childByte = 0;
    this.#pending = [UfoTw.#DEVICE_ID, 0, 0];
  }

  /**
   * BLE 接続を切断し、内部状態をリセットする。
   * @returns {Promise<void>}
   */
  async disconnect() {
    this.#loopController?.abort();
    await this.#loopDone;
    this.#reset();
    this.#device?.gatt.disconnect();
    this.#device = null;
    this.#characteristic = null;
  }

  /**
   * `await using` 構文で自動的に `disconnect()` を呼ぶための AsyncDisposable 実装。
   * @returns {Promise<void>}
   */
  async [Symbol.asyncDispose]() {
    await this.disconnect();
  }

  #reset() {
    this.#loopController = null;
    this.#loopDone = null;
    this.#parentByte = 0;
    this.#childByte = 0;
    this.#pending = null;
    this.#written = null;
  }

  #startLoop() {
    const controller = new AbortController();
    this.#loopController = controller;

    this.#loopDone = (async () => {
      while (!controller.signal.aborted) {
        await sleep(UfoTw.#POLL_MS);
        if (controller.signal.aborted || !this.connected) continue;
        if (arraysEqual(this.#pending, this.#written)) continue;

        const toWrite = this.#pending;
        try {
          await this.#characteristic.writeValue(new Uint8Array(toWrite));
          this.#written = toWrite;
        } catch (e) {
          console.error("U.F.O. TW write error:", e);
        }
      }
    })().catch((e) => console.error("U.F.O. TW loop error:", e));
  }
}

const DIRECTION_MAP = new Map([
  [Direction.CW, 0],
  [Direction.CCW, 1],
  // legacy numeric values
  [0, 0],
  [1, 1],
]);

function encodeByte(direction, power) {
  const dirValue = DIRECTION_MAP.get(direction);
  if (dirValue === undefined) {
    throw new Error(`Invalid direction: ${direction}`);
  }
  return (dirValue << 7) | clamp(power, 0, 100);
}

function clamp(value, min, max) {
  return Math.min(Math.max(min, value), max);
}

function arraysEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
