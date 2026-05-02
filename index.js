import { config } from "./config.js";
import { createPromptSelector } from "./ui/prompt-selector.js";
import { createModeToggle } from "./ui/mode-toggle.js";
import { createColumn } from "./ui/column.js";
import { KokoroBackend } from "./tts/kokoro-backend.js";
import { AudioGraph } from "./audio/audio-graph.js";
import { createWaveform } from "./audio/waveform.js";
import { Orchestrator } from "./session/orchestrator.js";

// --- UI setup ---
const topBar = document.getElementById("top-bar");
const columnsContainer = document.getElementById("columns");

// Create columns for all 3 models
const columns = new Map();
for (const model of config.models) {
  const column = createColumn(columnsContainer, model);
  columns.set(model.name, column);
}

// Prompt selector
const promptSelector = createPromptSelector(topBar, config.curatedPrompts);

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

// --- Audio + TTS ---
const audioGraph = new AudioGraph();
const ttsEngine = new KokoroBackend(config.tts.model);

// --- Orchestrator ---
const orchestrator = new Orchestrator({
  models: config.models,
  systemPrompt: config.systemPrompt,
  ttsConfig: config.tts,
  audioGraph,
  columns,
  ttsEngine,
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

  if (state === "Loading" || state === "Thinking" || state === "Speaking") {
    promptSelector.setEnabled(false);
    modeToggle.setEnabled(false);
    stopBtn.style.display = "inline-block";
  }

  if (state === "Done") {
    promptSelector.setEnabled(true);
    modeToggle.setEnabled(true);
    stopBtn.style.display = "none";
  }
});

stopBtn.addEventListener("click", () => {
  orchestrator.stop();
});

promptSelector.onAsk(async (question) => {
  await orchestrator.start(question, modeToggle.getMode());
});
