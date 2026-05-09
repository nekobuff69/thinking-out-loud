/**
 * @typedef {import("../config.js").ModelConfig} ModelConfig
 * @typedef {import("../config.js").TTSConfig} TTSConfig
 * @typedef {import("../ui/column.js").ColumnAPI} ColumnAPI
 * @typedef {import("../audio/audio-graph.js").AudioGraph} AudioGraph
 * @typedef {import("../tts/tts-engine.js").TTSEngine} TTSEngine
 * @typedef {import("../llm/providers/llm-provider.js").LLMProvider} LLMProvider
 * @typedef {import("./event-bus.js").SimpleEventBus} SimpleEventBus
 */

/**
 * @typedef {Object} ChannelPipelineDeps
 * @property {ModelConfig} model
 * @property {TTSConfig} ttsConfig
 * @property {ColumnAPI} column
 * @property {TTSEngine} ttsEngine
 * @property {LLMProvider} llmProvider
 * @property {AudioGraph} audioGraph
 * @property {() => void} [onIdle]
 * @property {SimpleEventBus} [eventBus]
 * @property {import("../tts/text-chunker.js").TextChunker} [textChunker]
 */

/**
 * Owns one model's full pipeline:
 * LLM token → column text → TTS backend → audio channel.
 * Tokens stream directly to the Kyutai TTS backend via WebSocket
 * with debounced incremental flushes (no sentence buffering).
 *
 * Token cap: after maxTokens words, stop sending to TTS but continue
 * accumulating reasoning text for storage/replay.
 */
export class ChannelPipeline {
  /** @type {ModelConfig} */
  #model;
  /** @type {TTSConfig} */
  #ttsConfig;
  /** @type {ColumnAPI} */
  #column;
  /** @type {TTSEngine} */
  #ttsEngine;
  /** @type {LLMProvider} */
  #llmProvider;
  /** @type {AudioGraph} */
  #audioGraph;
  /** @type {(() => void) | undefined} */
  #onIdle;
  /** @type {import("../audio/audio-graph.js").AudioGraphChannel | null} */
  #channel = null;
  /** @type {boolean} */
  #streamActive = false;
  /** @type {boolean} */
  #ttsActive = false;
  /** @type {boolean} */
  #contentHit = false;
  /** @type {string} */
  #reasoningText = "";
  /** @type {SimpleEventBus | undefined} */
  #eventBus;
  /** @type {AbortController | null} */
  #abortController = null;

  // TTS incremental flush state
  /** @type {number} */
  #ttsLastFlush = 0;
  /** @type {number} */
  #ttsCharsPending = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  #ttsFlushTimer = null;
  /** @type {{ stop: () => void } | null} */
  #audioHandle = null;
  /** @type {number} */
  #wordCount = 0;
  /** @type {boolean} */
  #isCapped = false;
  /** @type {boolean} */
  #firstBatchSent = false;
  /** @type {import("../tts/text-chunker.js").TextChunker | undefined} */
  #textChunker;

  /**
   * @param {ChannelPipelineDeps} deps
   */
  constructor({ model, ttsConfig, column, ttsEngine, llmProvider, audioGraph, onIdle, eventBus, textChunker }) {
    this.#model = model;
    this.#ttsConfig = ttsConfig;
    this.#column = column;
    this.#ttsEngine = ttsEngine;
    this.#llmProvider = llmProvider;
    this.#audioGraph = audioGraph;
    this.#onIdle = onIdle;
    this.#eventBus = eventBus;
    this.#textChunker = textChunker;
  }

  /** Create audio channel and attach waveform to column.
   * @returns {void}
   */
  createChannel() {
    if (this.#channel) return;
    this.#channel = this.#audioGraph.createChannel(this.#model.pan);
    this.#column.attachWaveform(this.#channel.analyser, this.#model.color);
    this.#emitProgress("loaded");
  }

  /**
   * Fire off LLM stream.
   * @param {string} systemPrompt
   * @param {string} question
   * @param {AbortSignal} [signal]
   * @returns {Promise<void | Error>}
   */
  startStream(systemPrompt, question, signal) {
    this.#streamActive = true;
    this.#contentHit = false;
    this.#isCapped = false;
    this.#firstBatchSent = false;
    this.#ttsLastFlush = 0;
    this.#ttsCharsPending = 0;
    this.#wordCount = 0;
    this.#abortController = new AbortController();

    const { signal: combinedSignal, cleanup: cleanupSignals } = this.#combineAbortSignals(
      signal,
      this.#abortController.signal
    );

    this.#emitProgress("streaming");

    return this.#llmProvider.streamReasoning(
      question,
      systemPrompt,
      {
        onReasoningToken: (token) => {
          this.feedToken(token);
        },
        onContentStart: () => {
          this.setContentHit();
        },
        onDone: () => {
          this.#streamActive = false;
          // Final TTS flush
          this.#flushTts();
          if (this.#reasoningText.length === 0) {
            this.setError("No reasoning received");
          }
          this.#emitProgress("finished");
        },
      },
      combinedSignal
    )
      .catch((err) => {
        if (err.name === "AbortError") return;
        this.setError(`Error: ${err.message}`);
        throw err;
      })
      .finally(() => {
        this.#streamActive = false;
        cleanupSignals?.();
      });
  }

  /**
   * Replay: feed stored text in chunks visually, then stream to TTS.
   * @param {string} text
   * @returns {Promise<void>}
   */
  async drainText(text) {
    this.#streamActive = true;
    this.#reasoningText = text;
    this.#isCapped = false;
    this.#firstBatchSent = false;
    this.#ttsLastFlush = 0;
    this.#ttsCharsPending = 0;
    this.#wordCount = 0;

    // Feed text token-by-token with visual delay, same TTS path as live
    const chunkSize = 3;
    for (let i = 0; i < text.length; i += chunkSize) {
      const chunk = text.slice(i, i + chunkSize);
      this.#column.appendToken(chunk);
      if (!this.#isCapped) {
        this.#feedTts(chunk);
      }
      if (i % 30 === 0) {
        await new Promise((r) => setTimeout(r, 16));
      }
    }

    this.#flushTts();
    this.#emitProgress("finished");
  }

  /** Append token to column and feed to TTS (if not capped).
   * @param {string} token
   * @returns {void}
   */
  feedToken(token) {
    this.#column.appendToken(token);
    this.#reasoningText += token;
    if (!this.#contentHit && !this.#isCapped) {
      this.#feedTts(token);
    }
    this.#eventBus?.emit("token", { modelName: this.#model.name, token });
  }

  /**
   * Feed text into the TTS incremental buffer.
   * When TextChunker is active, delegates to chunker.
   * Otherwise, uses built-in debounced flushing.
   * @param {string} text
   */
  #feedTts(text) {
    // Track word count for token cap
    this.#wordCount = this.#reasoningText.split(/\s+/).length;

    // Token cap check
    if (this.#wordCount >= this.#ttsConfig.maxTokens) {
      this.#isCapped = true;
      if (this.#textChunker) {
        this.#textChunker.flush();
      } else {
        this.#flushTts();
      }
      return;
    }

    // Use TextChunker if available
    if (this.#textChunker) {
      this.#textChunker.feed(text);
      return;
    }

    this.#ttsCharsPending += text.length;

    const now = Date.now();
    const timeSinceLastFlush = now - this.#ttsLastFlush;

    // First batch: flush immediately after ~3 tokens (fast first audio)
    if (!this.#firstBatchSent && this.#ttsCharsPending >= 15) {
      this.#firstBatchSent = true;
      this.#flushTts();
      return;
    }

    // Subsequent: debounce flush every 100ms
    if (this.#firstBatchSent) {
      if (this.#ttsFlushTimer) {
        clearTimeout(this.#ttsFlushTimer);
      }
      if (timeSinceLastFlush >= 100) {
        this.#flushTts();
      } else {
        this.#ttsFlushTimer = setTimeout(() => {
          this.#flushTts();
        }, 100 - timeSinceLastFlush);
      }
    }
  }

  /**
   * Flush pending text to the TTS backend.
   * Replaces any active TTS stream with the full accumulated text.
   */
  #flushTts() {
    if (this.#ttsFlushTimer) {
      clearTimeout(this.#ttsFlushTimer);
      this.#ttsFlushTimer = null;
    }
    if (this.#ttsCharsPending === 0 && this.#firstBatchSent) return;
    this.#ttsCharsPending = 0;
    this.#ttsLastFlush = Date.now();

    // Stop any active audio stream
    if (this.#audioHandle) {
      this.#audioHandle.stop();
      this.#audioHandle = null;
    }

    if (!this.#channel || !this.#reasoningText) return;

    const voice = this.#model.voice;
    // Capture reference for closure lifetime
    const channel = this.#channel;

    this.#audioHandle = channel.playStream((onChunk) => {
      this.#ttsActive = true;
      this.#ttsEngine.startStream(
        this.#reasoningText,
        voice,
        onChunk,
        {
          onDone: () => {
            this.#ttsActive = false;
            this.#emitProgress("done");
            this.#onIdle?.();
          },
          onError: (msg) => {
            this.#ttsActive = false;
            this.setError(msg);
          },
        }
      );
      // Cleanup: stop TTS when audio ends
      return () => {
        this.#ttsEngine.stop();
      };
    });
  }

  /** Soft stop: abort stream, stop TTS immediately, silence audio.
   * @returns {void}
   */
  softStop() {
    this.#abortController?.abort();
    this.#ttsEngine.stop();
    if (this.#audioHandle) {
      this.#audioHandle.stop();
      this.#audioHandle = null;
    }
    this.#ttsActive = false;
    if (this.#ttsFlushTimer) {
      clearTimeout(this.#ttsFlushTimer);
      this.#ttsFlushTimer = null;
    }
  }

  /** Pause: stop sending new text to TTS (current generation continues).
   * Used for monologue mode sequencing.
   * @returns {void}
   */
  pause() {
    this.#isCapped = true; // Prevent new text from reaching TTS
  }

  /** Resume: allow text to reach TTS again.
   * Flushes any text accumulated while paused.
   * @returns {void}
   */
  resume() {
    this.#isCapped = false;
    // Flush all accumulated text to TTS
    if (this.#reasoningText.length > 0) {
      this.#firstBatchSent = false;
      this.#ttsCharsPending = this.#reasoningText.length;
      this.#flushTts();
    }
  }

  /** Whether stream or TTS is still active.
   * @returns {boolean}
   */
  get isActive() {
    return this.#streamActive || this.#ttsActive;
  }

  /** Whether the token cap has been reached.
   * @returns {boolean}
   */
  get isCapped() {
    return this.#isCapped;
  }

  /** Accumulated reasoning text.
   * @returns {string}
   */
  get reasoningText() {
    return this.#reasoningText;
  }

  /** Model name for orchestrator identification.
   * @returns {string}
   */
  get modelName() {
    return this.#model.name;
  }

  /** Mark content boundary reached. Flush remaining TTS buffer.
   * @returns {void}
   */
  setContentHit() {
    this.#contentHit = true;
    this.#flushTts();
  }

  /** Set error on column.
   * @param {string} message
   * @returns {void}
   */
  setError(message) {
    this.#column.setError(message);
    this.#eventBus?.emit("pipeline-error", { modelName: this.#model.name, message, timestamp: Date.now() });
  }

  /**
   * Set a TextChunker for this pipeline.
   * When set, tokens are routed through the chunker instead of the built-in debounce.
   * @param {import("../tts/text-chunker.js").TextChunker} chunker
   * @returns {void}
   */
  setTextChunker(chunker) {
    this.#textChunker = chunker;
  }

  /**
   * Public flush method callable by TextChunker's onFlush callback.
   * @returns {void}
   */
  flushTts() {
    this.#flushTts();
  }

  /**
   * @param {string} stage
   */
  #emitProgress(stage) {
    this.#eventBus?.emit("pipeline-progress", { modelName: this.#model.name, stage });
  }

  #combineAbortSignals(/** @type {(AbortSignal | undefined)[]} */ ...signals) {
    const controller = new AbortController();
    /** @type {Array<{signal: AbortSignal, handler: () => void}>} */
    const listeners = [];
    for (const signal of signals) {
      if (!signal) continue;
      if (signal.aborted) {
        controller.abort();
        return { signal: controller.signal, cleanup: () => {} };
      }
      const handler = () => controller.abort();
      signal.addEventListener("abort", handler, { once: true });
      listeners.push({ signal, handler });
    }
    const cleanup = () => {
      for (const { signal, handler } of listeners) {
        signal.removeEventListener("abort", handler);
      }
    };
    return { signal: controller.signal, cleanup };
  }
}
