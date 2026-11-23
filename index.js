/**
 * Bootstrap: four-layer shell (Question block / stage / tool strip / overlays),
 * single-entry Ask, mutually exclusive overlays, and the keyboard map.
 *
 * Presentation layer only. The Orchestrator state machine, ChannelPipeline,
 * AudioGraph, Provider, SessionStore and karaoke highlight are untouched.
 */
import { config } from "./config.js";
import { createPromptSelector } from "./ui/prompt-selector.js";
import { createHistory } from "./ui/history.js";
import { createOverlayState } from "./ui/overlay-state.js";
import { createWaveformSelector } from "./audio/waveform-variant-selector.js";
import { WAVEFORM_SHORT_NAMES } from "./audio/waveform-variants.js";
import { createWaveformPicker } from "./ui/waveform-picker.js";
import { applyVariants } from "./ui/waveform-apply.js";
import { createColumn } from "./ui/column.js";
import { PocketTtsBackend } from "./tts/pocket-tts-backend.js";
import { AudioGraph } from "./audio/audio-graph.js";
import { Orchestrator } from "./session/orchestrator.js";
import { SessionStore } from "./session/storage.js";

import "./styles/global.css";
import "./styles/shell.css";

const store = new SessionStore(config.maxHistorySessions);
const overlays = createOverlayState();
const waveformSelector = createWaveformSelector(
  config.models.length,
  config.waveform.defaultVariant,
  config.waveform.variants
);

// --- DOM lookups ---
/** @param {string} id @returns {HTMLElement} */
function must(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error("Required DOM element missing: " + id);
  return el;
}

const questionBlock = must("question-block");
const qText = must("q-text");
const qSession = must("q-session");
const qSource = must("q-source");
const columnsContainer = must("columns");
const historyDock = must("history-dock");
const paletteHost = must("question-palette");
const pickerHost = must("waveform-picker");
const stopBtn = /** @type {HTMLButtonElement} */ (must("stop-btn"));
const tSession = must("t-session");
const tState = must("t-state");
const tOrder = must("t-order");
const tElapsed = must("t-elapsed");
const tWave = must("t-wave");
const tMessage = must("t-message");

/** @param {string} message @returns {void} */
function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "session-toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 1800);
}

// --- Columns (Column API unchanged) ---
const columns = new Map();
for (const model of config.models) {
  const column = createColumn(columnsContainer, model);
  columns.set(model.name, column);
}

// --- Question palette ---
const promptSelector = createPromptSelector(paletteHost, config.curatedPrompts, store.getQuestions());
promptSelector.onClose(() => closeOverlay("palette"));

// --- History dock (push-style flex sibling, never covers a Column) ---
const historyPanel = createHistory(historyDock, store, (session) => {
  showToast("Replaying session");
  orchestrator.replay(session);
});
historyPanel.onOpen(() => openOverlay("history"));
historyPanel.onClose(() => closeOverlay("history"));

// --- Overlay rendering ---
/** @returns {void} */
function renderOverlays() {
  const current = overlays.current();
  if (current === "palette") promptSelector.show();
  else promptSelector.hide();
  if (current === "history") historyPanel.show();
  else historyPanel.hide();
  paletteHost.classList.toggle("open", current === "palette");
  pickerHost.classList.toggle("open", current === "picker");
  document.body.classList.toggle("overlay-open", current !== null);
}

/** @param {string} name @returns {void} */
function openOverlay(name) {
  overlays.open(name);
  renderOverlays();
}
/** @param {string} name @returns {void} */
function toggleOverlay(name) {
  overlays.toggle(name);
  renderOverlays();
}
/** @param {string} name @returns {void} */
function closeOverlay(name) {
  overlays.close(name);
  renderOverlays();
}

questionBlock.addEventListener("click", () => {
  if (document.body.classList.contains("session-running")) {
    showToast("Running · stop first");
  }
  toggleOverlay("palette");
});
paletteHost.addEventListener("click", (event) => {
  if (event.target === paletteHost) closeOverlay("palette");
});

// --- Audio + TTS ---
const audioGraph = new AudioGraph();
audioGraph.enableTabResume();

const ttsEngines = new Map();
for (const model of config.models) {
  ttsEngines.set(
    model.name,
    new PocketTtsBackend({ serverUrl: config.tts.serverUrl, modelName: model.name })
  );
}

// --- Orchestrator ---
const orchestrator = new Orchestrator({
  models: config.models,
  systemPrompt: config.systemPrompt,
  ttsConfig: config.tts,
  audioGraph,
  columns,
  ttsEngines,
  storage: store,
});

for (const [name, column] of columns) {
  column.onMuteToggle(() => orchestrator.toggleMute(name));
  column.onSoloToggle(() => orchestrator.toggleSolo(name));
}

// --- Session state -> read-only tool strip ---
let sessionCount = 0;
let elapsedSeconds = 0;
/** @type {ReturnType<typeof setInterval> | null} */
let elapsedTimer = null;

/** @returns {void} */
function startClock() {
  stopClock();
  elapsedSeconds = 0;
  tElapsed.textContent = "00:00";
  elapsedTimer = setInterval(() => {
    elapsedSeconds += 1;
    const mm = String(Math.floor(elapsedSeconds / 60)).padStart(2, "0");
    const ss = String(elapsedSeconds % 60).padStart(2, "0");
    tElapsed.textContent = mm + ":" + ss;
  }, 1000);
}
/** @returns {void} */
function stopClock() {
  if (elapsedTimer !== null) clearInterval(elapsedTimer);
  elapsedTimer = null;
}

orchestrator.onStateChange((state) => {
  tState.textContent = state;
  const running = state === "Thinking" || state === "Speaking" ||
    state === "Loading" || state.startsWith("Loading:") || state === "Checking";
  const stoppable = state === "Thinking" || state === "Speaking";

  document.body.classList.toggle("session-running", running);
  stopBtn.style.display = stoppable ? "inline-block" : "none";
  promptSelector.setEnabled(!running);
  tMessage.classList.toggle("error", state.startsWith("Error"));

  if (state.startsWith("Error")) {
    tMessage.textContent = state;
  } else if (state.startsWith("Loading")) {
    tMessage.textContent = "Connecting to the TTS server…";
  } else if (state === "Checking") {
    tMessage.textContent = "Checking LLM providers…";
  } else if (state === "Done") {
    tMessage.textContent = "Session saved";
    showToast("Session saved");
  } else {
    tMessage.textContent = "";
  }

  if (state === "Thinking" || state === "Loading") startClock();
  if (state === "Done" || state.startsWith("Error")) stopClock();

  if (state === "Done" || state.startsWith("Error")) {
    promptSelector.updateRecentQuestions(store.getQuestions());
    if (state.startsWith("Error")) setTimeout(() => orchestrator.stop(), 3000);
  }
});

stopBtn.addEventListener("click", () => {
  showToast("Stopped");
  orchestrator.stop();
});

// --- Ask: one action, no confirmation button ---
/** @param {string} question */
async function ask(question) {
  sessionCount += 1;
  const id = String(sessionCount).padStart(3, "0");
  qText.textContent = question;
  qSession.textContent = id;
  tSession.textContent = id;
  showToast("Session started");
  const curatedIndex = config.curatedPrompts.indexOf(question);
  qSource.textContent = curatedIndex >= 0
    ? "Curated " + String(curatedIndex + 1).padStart(2, "0")
    : "Free-text question";
  tOrder.textContent = config.models.map((_, i) => "0" + (i + 1)).join(" → ");
  closeOverlay("palette");
  try {
    await orchestrator.start(question);
  } catch (err) {
    console.error("Session start failed:", err);
  }
}
promptSelector.onAsk(ask);

// --- Keyboard map ---
document.addEventListener("keydown", (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  const typing = /INPUT|TEXTAREA/.test(target.tagName);

  if (event.key === "Escape") {
    const current = overlays.escapeTarget();
    if (current) closeOverlay(current);
    else if (document.body.classList.contains("session-running")) orchestrator.stop();
    return;
  }

  if (typing) return;

  if (event.key === "/") {
    event.preventDefault();
    toggleOverlay("palette");
    return;
  }
  if (event.key === "h" || event.key === "H") {
    toggleOverlay("history");
    return;
  }
  if (event.key === "v" || event.key === "V") {
    // Ticket 76 wires the shuffle; the key is reserved here so the map is stable.
    document.dispatchEvent(new CustomEvent("waveform:shuffle", { detail: { reset: event.shiftKey } }));
    return;
  }
  if (/^[1-5]$/.test(event.key) && overlays.current() === "palette") {
    promptSelector.selectByKeyboard(Number(event.key) - 1);
    return;
  }
  if (event.altKey && /^[1-3]$/.test(event.key)) {
    const name = config.models[Number(event.key) - 1]?.name;
    if (name) {
      if (event.shiftKey) orchestrator.toggleSolo(name);
      else orchestrator.toggleMute(name);
    }
  }
});

// --- Per-Column Waveform identity ---
/** @returns {void} */
function updateWaveReadout() {
  tWave.textContent = waveformSelector.getVariants()
    .map((id) => (WAVEFORM_SHORT_NAMES[id] ?? id).toUpperCase())
    .join(" / ");
}

const picker = createWaveformPicker(pickerHost, config.waveform.variants, (columnIndex, variant) => {
  waveformSelector.setColumnVariant(columnIndex, variant);
  const column = columns.get(config.models[columnIndex].name);
  column?.setWaveformVariant(variant);
  updateWaveReadout();
  picker.setCurrent(waveformSelector.getVariants());
});

/** @returns {void} */
function applyAllVariants() {
  const ordered = config.models.map((model) => columns.get(model.name));
  applyVariants(ordered, waveformSelector.getVariants());
  picker.setCurrent(waveformSelector.getVariants());
  updateWaveReadout();
}

// Click a Column's Waveform to open the picker anchored to that Column.
for (const [name, column] of columns) {
  const index = config.models.findIndex((model) => model.name === name);
  const wavePanel = column.element.querySelector(".column-waveform");
  wavePanel?.addEventListener("click", (/** @type {Event} */ event) => {
    event.stopPropagation();
    const rect = /** @type {Element} */ (event.currentTarget).getBoundingClientRect();
    window.dispatchEvent(new CustomEvent("waveform:open", { detail: { index, rect } }));
  });
}

/** @param {boolean} reset */
function shuffleOrReset(reset) {
  if (reset) waveformSelector.reset();
  else waveformSelector.shuffle();
  applyAllVariants();
}

document.addEventListener("waveform:shuffle", (/** @type {Event} */ event) => {
  shuffleOrReset(/** @type {CustomEvent} */ (event).detail?.reset === true);
});

window.addEventListener("waveform:open", (event) => {
  const detail = /** @type {CustomEvent} */ (event).detail ?? {};
  openOverlay("picker");
  picker.setCurrent(waveformSelector.getVariants());
  if (detail.rect) picker.open(detail.index ?? 0, detail.rect);
});
window.addEventListener("waveform:close", () => {
  picker.close();
  closeOverlay("picker");
});

pickerHost.addEventListener("click", (event) => {
  if (event.target === pickerHost) {
    picker.close();
    closeOverlay("picker");
  }
});

applyAllVariants();
