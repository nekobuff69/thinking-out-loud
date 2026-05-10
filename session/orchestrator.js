import { healthCheck } from "../llm/health-check.js";
import { OpenAICompatibleProvider } from "../llm/providers/openai-compatible-provider.js";
import { ChannelPipeline } from "./channel-pipeline.js";
import { SimpleEventBus } from "./event-bus.js";
import { TextChunker } from "../tts/text-chunker.js";

/**
 * @typedef {import("../config.js").ModelConfig} ModelConfig
 * @typedef {import("../config.js").TTSConfig} TTSConfig
 * @typedef {import("../audio/audio-graph.js").AudioGraph} AudioGraph
 * @typedef {import("../ui/column.js").ColumnAPI} ColumnAPI
 * @typedef {import("./storage.js").SessionData} SessionData
 * @typedef {import("./storage.js").SessionStore} SessionStore
 */

/**
 * @typedef {Object} OrchestratorDeps
 * @property {ModelConfig[]} models
 * @property {string} systemPrompt
 * @property {TTSConfig} ttsConfig
 * @property {AudioGraph} audioGraph
 * @property {Map<string, ColumnAPI>} columns
 * @property {Map<string, import("../tts/tts-engine.js").TTSEngine>} ttsEngines
 * @property {SessionStore} storage
 */

/**
 * Manages a full Session lifecycle: Idle → Loading → Thinking → Speaking → Done.
 * Runs all configured models concurrently, each with its own pipeline.
 * Supports replay of stored sessions.
 */
export class Orchestrator {
  /** @type {ModelConfig[]} */
  #models;
  /** @type {string} */
  #systemPrompt;
  /** @type {TTSConfig} */
  #ttsConfig;
  /** @type {AudioGraph} */
  #audioGraph;
  /** @type {Map<string, ColumnAPI>} */
  #columns;
  /** @type {Map<string, import("../tts/tts-engine.js").TTSEngine>} */
  #ttsEngines;
  /** @type {((state: string) => void) | null} */
  #onStateChange = null;
  /** @type {string} */
  #state = "Idle";
  /** @type {Map<string, ChannelPipeline>} */
  #activeSessions = new Map();
  /** @type {string} */
  #mode = "chorus";
  /** @type {number} */
  #monologueIndex = 0;
  /** @type {boolean} */
  #allStreamsDone = false;
  /** @type {SessionStore} */
  #storage;
  /** @type {SessionData | null} */
  #sessionData = null;
  /** @type {string} */
  #questionText = "";
  /** @type {import("./event-bus.js").SimpleEventBus | undefined} */
  #eventBus;
  /** @type {((bus: import("./event-bus.js").SimpleEventBus) => void) | null} */
  #onEventBusReady = null;
  /** @type {Map<string, import("../llm/providers/llm-provider.js").LLMProvider>} */
  #providerCache = new Map();

  /**
   * @param {OrchestratorDeps} deps
   */
  constructor({ models, systemPrompt, ttsConfig, audioGraph, columns, ttsEngines, storage }) {
    this.#models = models;
    this.#systemPrompt = systemPrompt;
    this.#ttsConfig = ttsConfig;
    this.#audioGraph = audioGraph;
    this.#columns = columns;
    this.#ttsEngines = ttsEngines;
    this.#storage = storage;
  }

  /**
   * @param {(state: string) => void} fn
   * @returns {void}
   */
  onStateChange(fn) {
    this.#onStateChange = fn;
  }

  /** @returns {string} */
  get state() {
    return this.#state;
  }

  /** @returns {import("./event-bus.js").SimpleEventBus | undefined} */
  get eventBus() {
    return this.#eventBus;
  }

  /**
   * Register a callback that fires each time a new event bus is created.
   * @param {(bus: import("./event-bus.js").SimpleEventBus) => void} fn
   * @returns {void}
   */
  setOnEventBusReady(fn) {
    this.#onEventBusReady = fn;
    if (this.#eventBus) fn(this.#eventBus);
  }

  /**
   * @param {string} question
   * @param {string} [mode]
   * @returns {Promise<void>}
   */
  async start(question, mode) {
    if (this.#state !== "Idle") return;
    this.#mode = mode || "chorus";
    this.#questionText = question;
    this.#monologueIndex = 0;
    this.#allStreamsDone = false;
    this.#audioGraph.clearChannels();
    this.#setState("Loading");

    this.#setState("Loading: connecting to TTS server…");
    try {
      await Promise.all(
        [...this.#ttsEngines.values()].map((e) => e.load())
      );
    } catch (err) {
      this.#setState(`Error: TTS server unreachable at ${this.#ttsConfig.wsUrl || "ws://localhost:8765"}`);
      return;
    }
    this.#activeSessions.clear();
    this.#eventBus = new SimpleEventBus();
    this.#onEventBusReady?.(this.#eventBus);
    this.#sessionData = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      question,
      mode: this.#mode,
      models: [],
    };

    // Health check all models concurrently
    this.#setState("Checking");
    const healthResults = await Promise.all(
      this.#models.map(async (m) => ({ model: m, ok: await healthCheck(m.url) }))
    );

    const reachableModels = healthResults.filter((r) => r.ok).map((r) => r.model);
    const unreachableModels = healthResults.filter((r) => !r.ok).map((r) => r.model);

    // If all models unreachable — blocking error
    if (reachableModels.length === 0) {
      for (const model of this.#models) {
        const column = this.#columns.get(model.name);
        column?.setError(`${model.name} — unavailable`);
      }
      this.#setState("Error: No LLM providers reachable");
      return;
    }

    // Mark unreachable model columns with error
    for (const model of unreachableModels) {
      const column = this.#columns.get(model.name);
      column?.setError(`${model.name} — unavailable`);
    }

    // Set up pipelines only for reachable models
    this.#setupPipelines(reachableModels);

    // Fire all LLM streams concurrently
    this.#setState("Thinking");
    const fetches = [];

    for (const pipeline of this.#activeSessions.values()) {
      fetches.push(
        pipeline.startStream(this.#systemPrompt, question).catch((err) => {
          if (err instanceof Error && err.name !== "AbortError") {
            console.error(`Stream error for ${pipeline.modelName}:`, err);
          }
          return err;
        })
      );
    }

    await Promise.all(fetches);
    this.#allStreamsDone = true;

    // All streams done — check if TTS is still playing
    if ([...this.#activeSessions.values()].some((p) => p.isActive)) {
      this.#setState("Speaking");
    } else {
      this.#finishSession();
    }
  }

  /**
   * @param {SessionData} sessionData
   * @returns {Promise<void>}
   */
  async replay(sessionData) {
    if (this.#state !== "Idle") return;
    this.#mode = sessionData.mode || "chorus";
    this.#questionText = sessionData.question;
    this.#monologueIndex = 0;
    this.#allStreamsDone = false;
    this.#audioGraph.clearChannels();
    this.#setState("Loading");

    this.#setState("Loading: connecting to TTS server…");
    try {
      await Promise.all(
        [...this.#ttsEngines.values()].map((e) => e.load())
      );
    } catch (err) {
      this.#setState(`Error: TTS server unreachable at ${this.#ttsConfig.wsUrl || "ws://localhost:8765"}`);
      return;
    }
    this.#activeSessions.clear();
    this.#eventBus = new SimpleEventBus();
    this.#onEventBusReady?.(this.#eventBus);
    this.#sessionData = { ...sessionData, id: crypto.randomUUID(), timestamp: new Date().toISOString() };

    // Use stored model data (preserving original voices/pan) for replay,
    // but merge with current config to get url/model/reasoningFormat for provider
    const modelsForReplay = sessionData.models.map((stored) => {
      const configModel = this.#models.find((m) => m.name === stored.name);
      return configModel ? { ...configModel, ...stored } : stored;
    });
    this.#setupPipelines(/** @type {ModelConfig[]} */ (/** @type {unknown} */ (modelsForReplay)));

    // Feed stored reasoning text into each model's pipeline concurrently
    this.#setState("Thinking");

    const textFeeds = [];
    for (const modelData of sessionData.models) {
      const pipeline = this.#activeSessions.get(modelData.name);
      if (!pipeline) continue;
      const fullText = modelData.reasoningText || "";
      textFeeds.push(pipeline.drainText(fullText));
    }

    await Promise.all(textFeeds);

    this.#allStreamsDone = true;

    // Check if TTS is still playing
    if ([...this.#activeSessions.values()].some((p) => p.isActive)) {
      this.#setState("Speaking");
    } else {
      this.#finishSession();
    }
  }

  /**
   * @param {ModelConfig[] | undefined} [modelsToUse]
   * @returns {void}
   */
  #setupPipelines(modelsToUse) {
    if (!this.#sessionData) return;
    const models = modelsToUse || this.#models;
    let index = 0;
    for (const model of /** @type {Array<import("../config.js").ModelConfig>} */ (models)) {
      const column = this.#columns.get(model.name);
      if (!column) continue;
      column.clear();

      const cacheKey = `${model.url}|${model.model}|${model.reasoningFormat ?? "separate"}`;
      let llmProvider = this.#providerCache.get(cacheKey);
      if (!llmProvider) {
        llmProvider = new OpenAICompatibleProvider({
          url: model.url,
          model: model.model,
          reasoningFormat: /** @type {"separate" | "tagged" | "none"} */ (model.reasoningFormat ?? "separate"),
        });
        this.#providerCache.set(cacheKey, llmProvider);
      }

      const ttsEngine = this.#ttsEngines.get(model.name);
      if (!ttsEngine) continue;

      const pipeline = new ChannelPipeline({
        model: /** @type {ModelConfig} */ (model),
        ttsConfig: this.#ttsConfig,
        column,
        ttsEngine,
        llmProvider,
        audioGraph: this.#audioGraph,
        eventBus: this.#eventBus,
        onIdle: () => {
          if (this.#mode === "monologue") {
            this.#advanceMonologue();
          }
          this.#checkAllDone();
        },
      });

      pipeline.createChannel();

      // Wire TextChunker if enabled in config
      if (this.#ttsConfig.useTextChunker) {
        const chunker = new TextChunker({
          maxWords: 8,
          timeoutMs: 150,
          flushOnPunctuation: true,
          onFlush: () => pipeline.flushTts(),
        });
        pipeline.setTextChunker(chunker);
      }

      // In Monologue mode, pause all queues except the first
      if (this.#mode === "monologue" && index > 0) {
        pipeline.pause();
      }

      this.#activeSessions.set(model.name, pipeline);

      // Initialize model data for session storage (skip if already present, e.g. replay)
      if (!this.#sessionData.models.some((m) => m.name === model.name)) {
        this.#sessionData.models.push({
          name: model.name,
          displayName: model.name,
          color: model.color,
          voice: model.voice,
          pan: model.pan,
          reasoningText: "",
        });
      }

      index++;
    }
  }

  #advanceMonologue() {
    if (this.#mode !== "monologue") return;
    const sessionKeys = [...this.#activeSessions.keys()];
    this.#monologueIndex++;
    if (this.#monologueIndex < sessionKeys.length) {
      const nextPipeline = this.#activeSessions.get(sessionKeys[this.#monologueIndex]);
      if (nextPipeline) {
        nextPipeline.resume();
      }
    }
  }

  #checkAllDone() {
    if (this.#state === "Done") return;

    // In Monologue mode, only consider done when the last model's pipeline finishes
    if (this.#mode === "monologue") {
      const sessionKeys = [...this.#activeSessions.keys()];
      const lastModel = sessionKeys[sessionKeys.length - 1];
      const lastPipeline = this.#activeSessions.get(lastModel);
      if (this.#allStreamsDone && lastPipeline && !lastPipeline.isActive) {
        this.#finishSession();
      }
      return;
    }

    // Chorus mode: done when all streams done and all pipelines idle
    const allDone = this.#allStreamsDone &&
      [...this.#activeSessions.values()].every((p) => !p.isActive);

    if (allDone) {
      if (this.#state === "Thinking" || this.#state === "Speaking") {
        this.#finishSession();
      }
    }
  }

  #finishSession() {
    if (!this.#sessionData) return;
    // Update stored reasoning text from pipeline state
    for (const [name, pipeline] of this.#activeSessions) {
      const modelData = this.#sessionData.models.find((m) => m.name === name);
      if (modelData) {
        modelData.reasoningText = pipeline.reasoningText;
      }
    }

    // Save to storage
    this.#storage?.save(this.#sessionData);
    this.#storage?.saveQuestion(this.#questionText);

    this.#setState("Done");
    // Reset to Idle so a new session can start
    this.#state = "Idle";
  }

  /**
   * @param {string} newState
   * @returns {void}
   */
  #setState(newState) {
    this.#state = newState;
    this.#onStateChange?.(newState);
  }

  /** Soft stop: abort LLM streams, finish current TTS sentence, then silence. */
  stop() {
    for (const pipeline of this.#activeSessions.values()) {
      pipeline.softStop();
    }
    this.#setState("Done");
    this.#state = "Idle";
  }
}
