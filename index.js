/**
 * @typedef {import("./config.js").ModelConfig} ModelConfig
 * @typedef {import("./session/storage.js").SessionData} SessionData
 */

import { config } from "./config.js";
import { createPromptSelector } from "./ui/prompt-selector.js";
import { createHistory } from "./ui/history.js";
import { createColumn } from "./ui/column.js";
import { KyutaiBackend } from "./tts/kyutai-backend.js";
import { AudioGraph } from "./audio/audio-graph.js";

import { Orchestrator } from "./session/orchestrator.js";
import { SessionStore } from "./session/storage.js";
import { DebugOverlay } from "./ui/debug-overlay.js";

import "./styles/global.css";
import "./styles/top-bar.css";
import "./ui/debug-overlay.css";

// --- Storage ---
const store = new SessionStore(config.maxHistorySessions);

// --- UI setup ---
const topBar = document.getElementById("top-bar");
const columnsContainer = document.getElementById("columns");
if (!topBar || !columnsContainer) throw new Error("Required DOM elements missing");

// Create columns for all 3 models
const columns = new Map();
for (const model of config.models) {
  const column = createColumn(columnsContainer, model);
  columns.set(model.name, column);
}

// History button
const historyBtn = document.createElement("button");
historyBtn.className = "ask-btn";
historyBtn.textContent = "History";
historyBtn.style.cssText = "margin-left:auto;margin-right:0.5rem;";
topBar.appendChild(historyBtn);

// Prompt selector (with recent questions)
const recentQuestions = store.getQuestions();
const promptSelector = createPromptSelector(topBar, config.curatedPrompts, recentQuestions);

// Stop button
const stopBtn = document.createElement("button");
stopBtn.className = "ask-btn";
stopBtn.textContent = "Stop";
stopBtn.style.display = "none";
topBar.appendChild(stopBtn);

// Session state label
const stateLabel = document.createElement("span");
stateLabel.className = "state-label";
stateLabel.style.cssText = "color:#555;font-size:0.8rem;margin-left:1rem;";
topBar.appendChild(stateLabel);

// Loading spinner (injected into HTML statically; get reference)
const loadingSpinner = document.getElementById("loading-spinner");

// History panel
const historyPanel = createHistory(document.body, store, (session) => {
  orchestrator.replay(session);
});

historyBtn.addEventListener("click", () => {
  historyPanel.show();
});

// --- Audio + TTS ---
const audioGraph = new AudioGraph();
audioGraph.enableTabResume();

// Per-model KyutaiBackend instances (3 WebSocket connections)
const ttsEngines = new Map();
for (const model of config.models) {
  ttsEngines.set(
    model.name,
    new KyutaiBackend({ wsUrl: config.tts.wsUrl, modelName: model.name })
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

orchestrator.onStateChange((state) => {
  stateLabel.textContent = state;
  if (state.startsWith("Error")) {
    stateLabel.style.color = "#ff4444";
  } else if (state.startsWith("Loading") || state === "Checking") {
    stateLabel.style.color = "#ffaa00";
  } else {
    stateLabel.style.color = "#555";
  }

  // Show spinner during loading phases, hide otherwise
  if (loadingSpinner) {
    loadingSpinner.classList.toggle("visible", state.startsWith("Loading"));
  }

  if (state === "Loading" || state.startsWith("Loading:") || state === "Checking" || state === "Thinking" || state === "Speaking") {
    promptSelector.setEnabled(false);
    historyBtn.disabled = true;
    stopBtn.style.display = (state === "Thinking" || state === "Speaking") ? "inline-block" : "none";
  }

  if (state === "Done" || state.startsWith("Error")) {
    promptSelector.setEnabled(true);
    historyBtn.disabled = false;
    stopBtn.style.display = "none";
    if (state.startsWith("Error")) {
      // Reset to idle via stop() so user can try again
      setTimeout(() => orchestrator.stop(), 3000);
    }
    // Refresh recent questions
    promptSelector.updateRecentQuestions(store.getQuestions());
  }
});

stopBtn.addEventListener("click", () => {
  orchestrator.stop();
});

// Debug overlay
const debugOverlay = new DebugOverlay({ orchestrator });
if (window.location.search.includes("debug")) {
  debugOverlay.toggle();
}

promptSelector.onAsk(async (question) => {
  try {
    await orchestrator.start(question);
  } catch (err) {
    console.error("Session start failed:", err);
    // orchestrator.onStateChange handles Error state via stop() path
  }
});
