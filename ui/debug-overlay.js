/**
 * @typedef {import("../session/event-bus.js").SimpleEventBus} SimpleEventBus
 * @typedef {import("../session/orchestrator.js").Orchestrator} Orchestrator
 */

/**
 * Human-readable labels for pipeline progress stages.
 * Maps LLM/TTS internal events to user-facing descriptions.
 */
const PROGRESS_LABELS = Object.freeze({
  loaded: "🚀 Start",
  streaming: "🔤 Thinking",
  finished: "✅ Done thinking",
  done: "🔇 Finished",
});

/**
 * Per-model TTS latency tracking for debug overlay display.
 */
const ttsLatency = new Map();

/**
 * Togglable debug overlay that observes pipeline state via the event bus.
 * Does not import pipeline modules directly — only listens to events.
 */
export class DebugOverlay {
  /** @type {SimpleEventBus | undefined} */
  #eventBus;
  /** @type {HTMLElement} */
  #root;
  /** @type {HTMLElement} */
  #panel;
  /** @type {Map<string, HTMLElement>} */
  #modelCards = new Map();
  /** @type {Map<string, number>} */
  #tokenCounts = new Map();
  /** @type {HTMLElement | null} */
  #globalStats = null;
  /** @type {boolean} */
  #visible = false;
  /** @type {(() => void)[]} */
  #unsubs = [];
  /** @type {ReturnType<typeof setInterval> | null} */
  #globalInterval = null;
  /** @type {Orchestrator} */
  #orchestrator;

  /**
   * @param {Object} opts
   * @param {Orchestrator} opts.orchestrator
   */
  constructor({ orchestrator }) {
    this.#root = document.createElement("div");
    this.#root.className = "debug-overlay";
    this.#root.style.display = "none";

    this.#panel = document.createElement("div");
    this.#panel.className = "debug-panel";
    this.#root.appendChild(this.#panel);

    const header = document.createElement("div");
    header.className = "debug-header";
    header.textContent = "🔧 Debug Overlay";
    this.#panel.appendChild(header);

    this.#globalStats = document.createElement("div");
    this.#globalStats.className = "debug-global";
    this.#panel.appendChild(this.#globalStats);

    const modelsContainer = document.createElement("div");
    modelsContainer.className = "debug-models";
    this.#panel.appendChild(modelsContainer);

    this.#orchestrator = orchestrator;
    // Event-driven bus detection — no polling
    orchestrator.setOnEventBusReady((bus) => {
      this.#detachBus();
      this.#attachBus(bus);
    });
    // Lightweight interval for global stats only
    this.#globalInterval = setInterval(() => {
      this.#updateGlobal(this.#orchestrator);
    }, 250);
    window.addEventListener("beforeunload", () => { if (this.#globalInterval) clearInterval(this.#globalInterval); });

    document.body.appendChild(this.#root);
    this.#setupKeyboard();
  }

  /** Toggle visibility.
   * @returns {void}
   */
  toggle() {
    this.#visible = !this.#visible;
    this.#root.style.display = this.#visible ? "block" : "none";
  }

  /** @returns {boolean} */
  get isVisible() {
    return this.#visible;
  }

  #setupKeyboard() {
    document.addEventListener("keydown", (e) => {
      if (e.key === "`" || (e.ctrlKey && e.shiftKey && e.key === "D")) {
        e.preventDefault();
        this.toggle();
      }
    });
  }

  /**
   * @param {SimpleEventBus} bus
   */
  #attachBus(bus) {
    this.#eventBus = bus;
    this.#unsubs.push(
      bus.on("token", (data) => this.#onToken(data)),
      bus.on("tts-first-chunk", (data) => this.#onTtsFirstChunk(data)),
      bus.on("tts-chunk", (data) => this.#onTtsChunk(data)),
      bus.on("pipeline-progress", (data) => this.#onProgress(data)),
      bus.on("pipeline-error", (data) => this.#onError(data))
    );
  }

  #detachBus() {
    for (const unsub of this.#unsubs) unsub();
    this.#unsubs = [];
    this.#modelCards.clear();
    this.#tokenCounts.clear();
    const modelsContainer = this.#panel.querySelector(".debug-models");
    if (modelsContainer) modelsContainer.innerHTML = "";
  }

  /**
   * @param {{ modelName: string, token: string }} data
   */
  #onToken(data) {
    const count = this.#tokenCounts.get(data.modelName) ?? 0;
    this.#tokenCounts.set(data.modelName, count + 1);
  }

  /**
   * @param {{ modelName: string, latencyMs: number }} data
   */
  #onTtsFirstChunk(data) {
    ttsLatency.set(data.modelName, data.latencyMs);
    const card = this.#ensureCard(data.modelName);
    const el = card.querySelector(".debug-row-value--latency");
    if (el) {
      el.textContent = `${data.latencyMs}ms`;
    }
  }

  /**
   * @param {{ modelName: string, bytesReceived: number }} data
   */
  #onTtsChunk(data) {
    const card = this.#ensureCard(data.modelName);
    const el = card.querySelector(".debug-row-value--chunks");
    if (el) {
      // Count chunks
      const current = parseInt(el.textContent || "0", 10) || 0;
      el.textContent = `${current + 1} chunks · ${((data.bytesReceived / 1024)).toFixed(1)}kB`;
    }
  }

  /**
   * @param {{ modelName: string, stage: keyof typeof PROGRESS_LABELS }} data
   */
  #onProgress(data) {
    const card = this.#ensureCard(data.modelName);
    const el = card.querySelector(".debug-row-value--progress");
    if (el) {
      const label = PROGRESS_LABELS[data.stage] ?? String(data.stage);
      el.textContent = label;
    }
  }

  /**
   * @param {{ modelName: string, message: string, timestamp: number }} data
   */
  #onError(data) {
    const card = this.#ensureCard(data.modelName);
    const el = card.querySelector(".debug-errors");
    if (el) {
      const line = document.createElement("div");
      line.className = "debug-error-line";
      line.textContent = `[${new Date(data.timestamp).toLocaleTimeString()}] ${data.message}`;
      el.appendChild(line);
      // Keep last 5 errors
      while (el.children.length > 5 && el.firstChild) {
        el.removeChild(el.firstChild);
      }
    }
  }

  /**
   * @param {Orchestrator} orchestrator
   */
  #updateGlobal(orchestrator) {
    if (!this.#globalStats) return;
    const lines = [];
    for (const [name, count] of this.#tokenCounts) {
      lines.push(`${name} ${count} tokens`);
    }
    if (lines.length === 0) {
      this.#globalStats.textContent = `Session: ${orchestrator.state}`;
    } else {
      this.#globalStats.textContent = `Session: ${orchestrator.state} · ${lines.join(" · ")}`;
    }
  }

  /**
   * @param {string} modelName
   * @returns {HTMLElement}
   */
  #ensureCard(modelName) {
    let card = this.#modelCards.get(modelName);
    if (card) return card;

    const container = this.#panel.querySelector(".debug-models");
    card = document.createElement("div");
    card.className = "debug-model-card";
    card.innerHTML = `
      <div class="debug-model-name">${modelName}</div>
      <div class="debug-row"><span class="debug-row-label">Progress</span><span class="debug-row-value debug-row-value--progress">—</span></div>
      <div class="debug-row"><span class="debug-row-label">TTS Latency</span><span class="debug-row-value debug-row-value--latency">—</span></div>
      <div class="debug-row"><span class="debug-row-label">Audio</span><span class="debug-row-value debug-row-value--chunks">—</span></div>
      <div class="debug-errors"></div>
    `;
    container?.appendChild(card);
    this.#modelCards.set(modelName, card);
    return card;
  }
}
