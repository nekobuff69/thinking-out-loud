import { config } from "./config.js";
import { createPromptSelector } from "./ui/prompt-selector.js";
import { createModeToggle } from "./ui/mode-toggle.js";
import { createHistory } from "./ui/history.js";
import { createColumn } from "./ui/column.js";
import { KokoroBackend } from "./tts/kokoro-backend.js";
import { AudioGraph } from "./audio/audio-graph.js";
import { createWaveform } from "./audio/waveform.js";
import { Orchestrator } from "./session/orchestrator.js";
import { SessionStore } from "./session/storage.js";

// --- Storage ---
const store = new SessionStore(config.maxHistorySessions);

// --- UI setup ---
const topBar = document.getElementById("top-bar");
const columnsContainer = document.getElementById("columns");

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

// Mode toggle
const modeToggle = createModeToggle(topBar, config.defaultMode);

// Stop button
const stopBtn = document.createElement("button");
stopBtn.className = "ask-btn";
stopBtn.textContent = "Stop";
stopBtn.style.display = "none";
topBar.appendChild(stopBtn);

// Session state label
const stateLabel = document.createElement("span");
stateLabel.style.cssText = "color:#555;font-size:0.8rem;margin-left:1rem;";
topBar.appendChild(stateLabel);

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
const ttsEngine = new KokoroBackend(config.tts.model);

// --- Orchestrator ---
const orchestrator = new Orchestrator({
  models: config.models,
  systemPrompt: config.systemPrompt,
  ttsConfig: config.tts,
  audioGraph,
  columns,
  ttsEngine,
  storage: store,
  onChannelCreated: (modelName, channel) => {
    const model = config.models.find((m) => m.name === modelName);
    const column = columns.get(modelName);
    if (model && column) {
      createWaveform(column.waveform, channel.analyser, model.color);
    }
  },
});

orchestrator.onStateChange((state) => {
  stateLabel.textContent = state;
  stateLabel.style.color = state.startsWith("Error") ? "#ff4444" : "#555";

  if (state === "Loading" || state === "Checking" || state === "Thinking" || state === "Speaking") {
    promptSelector.setEnabled(false);
    modeToggle.setEnabled(false);
    historyBtn.disabled = true;
    stopBtn.style.display = (state === "Thinking" || state === "Speaking") ? "inline-block" : "none";
  }

  if (state === "Done" || state.startsWith("Error")) {
    promptSelector.setEnabled(true);
    modeToggle.setEnabled(true);
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

promptSelector.onAsk(async (question) => {
  await orchestrator.start(question, modeToggle.getMode());
});
