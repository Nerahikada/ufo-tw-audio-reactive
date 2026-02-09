import { UfoTw, Motor, Direction } from "./ufo-tw.js";
import { AudioReactive } from "./audio-reactive.js";
import { AudioPlayer } from "./audio-player.js";
import { MotorVisualizer } from "./motor-vis.js";

// ---- Instances ----

const ufo = new UfoTw();

const player = new AudioPlayer({
  fileArea: document.getElementById("fileArea"),
  fileInput: document.getElementById("fileInput"),
  fileName: document.getElementById("fileName"),
  btnPlay: document.getElementById("btnPlay"),
  btnPrev: document.getElementById("btnPrev"),
  btnNext: document.getElementById("btnNext"),
  seekBar: document.getElementById("seekBar"),
  timeLabel: document.getElementById("timeLabel"),
  trackList: document.getElementById("trackList"),
});

const motorVis = new MotorVisualizer({
  parentDir: document.getElementById("parentDirVis"),
  parentSpeed: document.getElementById("parentSpeedVis"),
  childDir: document.getElementById("childDirVis"),
  childSpeed: document.getElementById("childSpeedVis"),
});

// ---- DOM refs (remaining) ----

const $status = document.getElementById("status");
const $btnConnect = document.getElementById("btnConnect");
const $meterFill = document.getElementById("meterFill");
const $meterGate = document.getElementById("meterGate");
const $gateLabel = document.getElementById("gateLabel");
const $sensitivity = document.getElementById("sensitivity");
const $gate = document.getElementById("gate");
const $smoothing = document.getElementById("smoothing");
const $sustain = document.getElementById("sustain");
const $beatCooldown = document.getElementById("beatCooldown");
const $separation = document.getElementById("separation");

// ---- Audio state ----

let reactive = null;
let animId = null;
let beatDirL = false;
let beatDirR = false;

// ---- Player events ----

player.addEventListener("play", () => startLoop());
player.addEventListener("pause", () => stopLoop());
player.addEventListener("ended", () => {
  stopLoop();
  if (ufo.connected) ufo.stop();
});

// ---- BLE ----

$btnConnect.addEventListener("click", async () => {
  if (ufo.connected) {
    await ufo.disconnect();
    return;
  }
  try {
    $status.textContent = "接続中…";
    await ufo.connect();
    $status.textContent = `接続: ${ufo.deviceName}`;
    $status.className = "status connected";
    $btnConnect.textContent = "切断";
    $btnConnect.classList.add("active");
  } catch (e) {
    $status.textContent = `接続失敗: ${e.message}`;
    $status.className = "status";
  }
});

ufo.addEventListener("disconnect", () => {
  $status.textContent = "切断されました";
  $status.className = "status";
  $btnConnect.textContent = "BLE 接続";
  $btnConnect.classList.remove("active");
});

// ---- Gate slider ----

$gate.addEventListener("input", () => {
  const v = $gate.value;
  $meterGate.style.left = v + "%";
  $gateLabel.textContent = `ゲート: ${v}%`;
});

// ---- Helpers ----

function gateToSpeed(level, gateThreshold) {
  if (level < gateThreshold) return 0;
  return Math.min(
    Math.round(((level - gateThreshold) / (100 - gateThreshold)) * 100),
    100,
  );
}

// ---- Analysis loop ----

function startLoop() {
  if (!reactive) {
    reactive = new AudioReactive(player.analyser, {
      left: player.analyserL,
      right: player.analyserR,
    });
  }
  reactive.reset();
  beatDirL = false;
  beatDirR = false;

  function tick() {
    animId = requestAnimationFrame(tick);

    const result = reactive.update({
      sensitivity: parseFloat($sensitivity.value),
      smoothing: parseFloat($smoothing.value),
      sustain: parseFloat($sustain.value),
      beatCooldown: parseInt($beatCooldown.value),
    });

    $meterFill.style.width = result.level.toFixed(1) + "%";

    const gateThreshold = parseFloat($gate.value);
    const sep = parseFloat($separation.value);

    // Blend L/R toward mono based on separation (0 = mono, 1 = full stereo)
    const mono = (result.left + result.right) / 2;
    const effectiveL = mono + (result.left - mono) * sep;
    const effectiveR = mono + (result.right - mono) * sep;

    const pSpd = gateToSpeed(effectiveL, gateThreshold);
    const cSpd = gateToSpeed(effectiveR, gateThreshold);

    // Beat-driven direction toggle
    if (sep < 0.5) {
      if (result.beatL || result.beatR) {
        beatDirL = !beatDirL;
        beatDirR = !beatDirR;
      }
    } else {
      if (result.beatL) beatDirL = !beatDirL;
      if (result.beatR) beatDirR = !beatDirR;
    }

    const pDir = beatDirL ? Direction.CW : Direction.CCW;
    const cDir = beatDirR ? Direction.CW : Direction.CCW;

    motorVis.update(pDir, pSpd, cDir, cSpd);

    // Send to hardware
    if (!ufo.connected) return;
    if (pSpd === 0 && cSpd === 0) {
      ufo.stop();
    } else {
      ufo.setSpeed(Motor.PARENT, pDir, pSpd);
      ufo.setSpeed(Motor.CHILD, cDir, cSpd);
    }
  }

  tick();
}

function stopLoop() {
  if (animId != null) {
    cancelAnimationFrame(animId);
    animId = null;
  }
  reactive?.reset();
  beatDirL = false;
  beatDirR = false;
  $meterFill.style.width = "0%";
  motorVis.reset();
}
