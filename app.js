import { UfoTw, Motor } from "./ufo-tw.js";
import { AudioReactive } from "./audio-reactive.js";
import { AudioPlayer } from "./audio-player.js";
import { MotorVisualizer } from "./motor-vis.js";
import { POLICIES, DEFAULT_POLICY_ID } from "./mapping.js";

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

// ---- DOM refs ----

const $status = document.getElementById("status");
const $btnConnect = document.getElementById("btnConnect");
const $meterFill = document.getElementById("meterFill");
const $meterGate = document.getElementById("meterGate");
const $gateLabel = document.getElementById("gateLabel");
const $sensitivity = document.getElementById("sensitivity");
const $smoothing = document.getElementById("smoothing");
const $sustain = document.getElementById("sustain");
const $beatCooldown = document.getElementById("beatCooldown");
const $policySelect = document.getElementById("policySelect");
const $policyControls = document.getElementById("policyControls");

// ---- Policy management ----

let currentPolicy = null;
let policyParams = {};

function setPolicy(id) {
  const factory = POLICIES.get(id);
  if (!factory) return;
  currentPolicy = factory();
  policyParams = {};
  renderPolicyControls(currentPolicy.params);
  updateGateMeter();
}

function renderPolicyControls(paramDefs) {
  $policyControls.innerHTML = "";
  for (const def of paramDefs) {
    const label = document.createElement("label");
    const text = document.createTextNode(def.label + " ");
    label.appendChild(text);

    if (def.type === "range") {
      const input = document.createElement("input");
      input.type = "range";
      input.min = def.min;
      input.max = def.max;
      input.step = def.step;
      input.value = def.value;
      policyParams[def.id] = def.value;
      input.addEventListener("input", () => {
        policyParams[def.id] = parseFloat(input.value);
        updateGateMeter();
      });
      label.appendChild(input);
    } else if (def.type === "select") {
      const sel = document.createElement("select");
      for (const opt of def.options) {
        const option = document.createElement("option");
        option.value = opt.value;
        option.textContent = opt.label;
        sel.appendChild(option);
      }
      sel.value = def.value;
      policyParams[def.id] = def.value;
      sel.addEventListener("change", () => {
        policyParams[def.id] = sel.value;
      });
      label.appendChild(sel);
    }

    $policyControls.appendChild(label);
  }
}

function updateGateMeter() {
  const gate = policyParams.gateThreshold;
  if (gate != null) {
    $meterGate.style.left = gate + "%";
    $meterGate.hidden = false;
    $gateLabel.textContent = `ゲート: ${gate}%`;
  } else {
    $meterGate.hidden = true;
    $gateLabel.textContent = "";
  }
}

// Populate policy selector from registry
for (const [id, factory] of POLICIES) {
  const opt = document.createElement("option");
  opt.value = id;
  opt.textContent = factory().name;
  $policySelect.appendChild(opt);
}

$policySelect.addEventListener("change", () => {
  setPolicy($policySelect.value);
});

// ---- Audio state ----

let reactive = null;
let animId = null;

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

// ---- Analysis loop ----

function startLoop() {
  if (!reactive) {
    reactive = new AudioReactive(player.analyser, {
      left: player.analyserL,
      right: player.analyserR,
    });
  }
  reactive.reset();
  currentPolicy?.reset();

  function tick() {
    animId = requestAnimationFrame(tick);

    const features = reactive.update({
      sensitivity: parseFloat($sensitivity.value),
      smoothing: parseFloat($smoothing.value),
      sustain: parseFloat($sustain.value),
      beatCooldown: parseInt($beatCooldown.value),
    });

    $meterFill.style.width = features.level.toFixed(1) + "%";

    if (!currentPolicy) return;
    const cmd = currentPolicy.map(features, policyParams);

    motorVis.update(cmd.parentDir, cmd.parentSpeed, cmd.childDir, cmd.childSpeed);

    if (!ufo.connected) return;
    if (cmd.parentSpeed === 0 && cmd.childSpeed === 0) {
      ufo.stop();
    } else {
      ufo.setSpeed(Motor.PARENT, cmd.parentDir, cmd.parentSpeed);
      ufo.setSpeed(Motor.CHILD, cmd.childDir, cmd.childSpeed);
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
  currentPolicy?.reset();
  $meterFill.style.width = "0%";
  motorVis.reset();
}

// ---- Initialize ----

setPolicy(DEFAULT_POLICY_ID);
