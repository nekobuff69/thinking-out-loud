/**
 * @typedef {import("../session/event-bus.js").SimpleEventBus} SimpleEventBus
 * @typedef {import("../session/orchestrator.js").Orchestrator} Orchestrator
 */

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
  /** @type {Map<string, { tokens: number, lastTime: number }>} */
  #tokenMetrics = new Map();
  /** @type {HTMLElement | null} */
  #globalStats = null;
  /** @type {boolean} */
  #visible = false;
  /** @type {(() => void)[]} */
  #unsubs = [];

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

    // Attach to orchestrator eventBus changes
    this.#watchOrchestrator(orchestrator);

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
   * @param {Orchestrator} orchestrator
   */
  #watchOrchestrator(orchestrator) {
    // Poll for eventBus changes since orchestrator creates a new one per session
    let lastBus = orchestrator.eventBus;
    if (lastBus) {
      this.#attachBus(lastBus);
    }

    const interval = setInterval(() => {
      const bus = orchestrator.eventBus;
      if (bus !== lastBus) {
        this.#detachBus();
        if (bus) this.#attachBus(bus);
        lastBus = bus;
      }
      this.#updateGlobal(orchestrator);
    }, 250);

    // Cleanup on page unload
    window.addEventListener("beforeunload", () => clearInterval(interval));
  }

  /**
   * @param {SimpleEventBus} bus
   */
  #attachBus(bus) {
    this.#eventBus = bus;
    this.#unsubs.push(
      bus.on("token", (data) => this.#onToken(data)),
      bus.on("buffer-state", (data) => this.#onBufferState(data)),
      bus.on("queue-state", (data) => this.#onQueueState(data)),
      bus.on("synth-timing", (data) => this.#onSynthTiming(data)),
      bus.on("pipeline-progress", (data) => this.#onProgress(data)),
      bus.on("pipeline-error", (data) => this.#onError(data))
    );
  }

  #detachBus() {
    for (const unsub of this.#unsubs) unsub();
    this.#unsubs = [];
    this.#modelCards.clear();
    this.#tokenMetrics.clear();
    const modelsContainer = this.#panel.querySelector(".debug-models");
    if (modelsContainer) modelsContainer.innerHTML = "";
  }

  /**
   * @param {{ modelName: string, token: string }} data
   */
  #onToken(data) {
    let m = this.#tokenMetrics.get(data.modelName);
    if (!m) {
      m = { tokens: 0, lastTime: Date.now() };
      this.#tokenMetrics.set(data.modelName, m);
    }
    m.tokens++;
  }

  /**
   * @param {{ modelName: string, tokenCount: number, wordCount: number, sentencesHeld: number, capped: boolean }} data
   */
  #onBufferState(data) {
    const card = this.#ensureCard(data.modelName);
    const el = card.querySelector(".debug-buffer");
    if (el) {
      el.textContent = `Buffer: ${data.tokenCount} tok / ~${data.wordCount} words | held: ${data.sentencesHeld} | ${data.capped ? "CAPPED" : "open"}`;
    }
  }

  /**
   * @param {{ modelName: string, depth: number, state: string }} data
   */
  #onQueueState(data) {
    const card = this.#ensureCard(data.modelName);
    const el = card.querySelector(".debug-queue");
    if (el) {
      el.textContent = `Queue: ${data.state} | depth: ${data.depth}`;
    }
  }

  /**
   * @param {{ modelName: string, timingMs: number }} data
   */
  #onSynthTiming(data) {
    const card = this.#ensureCard(data.modelName);
    const el = card.querySelector(".debug-synth");
    if (el) {
      el.textContent = `Synth: ${data.timingMs}ms`;
    }
  }

  /**
   * @param {{ modelName: string, stage: string }} data
   */
  #onProgress(data) {
    const card = this.#ensureCard(data.modelName);
    const el = card.querySelector(".debug-progress");
    if (el) {
      el.textContent = `Progress: ${data.stage}`;
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
    const now = Date.now();
    let tokRates = [];
    for (const [name, m] of this.#tokenMetrics) {
      const elapsed = (now - m.lastTime) / 1000;
      const rate = elapsed > 0 ? (m.tokens / elapsed).toFixed(1) : "0";
      tokRates.push(`${name}: ${rate} tok/s (${m.tokens})`);
    }
    this.#globalStats.textContent = `Session: ${orchestrator.state} | ${tokRates.join(" | ")}`;
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
      <div class="debug-progress">Progress: —</div>
      <div class="debug-buffer">Buffer: —</div>
      <div class="debug-queue">Queue: —</div>
      <div class="debug-synth">Synth: —</div>
      <div class="debug-errors"></div>
    `;
    container?.appendChild(card);
    this.#modelCards.set(modelName, card);
    return card;
  }
}
