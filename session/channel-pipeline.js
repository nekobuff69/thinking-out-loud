/**
 * @typedef {import("../config.js").ModelConfig} ModelConfig
 * @typedef {import("../config.js").TTSConfig} TTSConfig
 * @typedef {import("../ui/column.js").ColumnAPI} ColumnAPI
 * @typedef {import("../audio/audio-graph.js").AudioGraph} AudioGraph
 * @typedef {import("../tts/tts-engine.js").TTSEngine} TTSEngine
 * @typedef {import("../llm/providers/llm-provider.js").LLMProvider} LLMProvider
 * @typedef {import("./event-bus.js").SimpleEventBus} SimpleEventBus
 * @typedef {import("../tts/kyutai-backend.js").StreamHandle} StreamHandle
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
 * LLM token → column text → TTS streaming backend → audio channel.
 *
 * Live path (new streaming protocol):
 *   Tokens accumulate in #unsentBuffer. On word boundary, buffer is sent
 *   to the TTS server as incremental delta (drain-on-send). One openStream
 *   call, many sendText calls. No synthesis restart.
 *
 * Replay path (preserved):
 *   drainText() uses old startStream(fullText) + playStream(streamFn).
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

  // Streaming TTS state
  /** @type {string} */
  #unsentBuffer = "";
  /** @type {StreamHandle | null} */
  #ttsStream = null;
  /** @type {{ feed: (pcm: Float32Array, sampleRate: number) => void, end: () => void, stop: () => void } | null} */
  #audioStream = null;
  /** @type {boolean} */
  #ttsStreamOpened = false;
  /** @type {number} */
  #wordCount = 0;
  /** @type {boolean} */
  #isCapped = false;

  // First-chunk 50ms timeout for fast first audio
  /** @type {ReturnType<typeof setTimeout> | null} */
  #firstChunkTimer = null;
  /** @type {boolean} */
  #firstChunkSent = false;

  // Pause/resume for monologue
  /** @type {boolean} */
  #paused = false;

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

  /** Create audio channel and attach waveform.
   * @returns {void}
   */
  createChannel() {
    if (this.#channel) return;
    this.#channel = this.#audioGraph.createChannel(this.#model.pan);
    this.#column.attachWaveform(this.#channel.analyser, this.#model.color);
    this.#emitProgress("loaded");
  }

  // ------------------------------------------------------------------
  // Live streaming path
  // ------------------------------------------------------------------

  /**
   * Fire off LLM stream. Uses new streaming protocol for TTS.
   * @param {string} systemPrompt
   * @param {string} question
   * @param {AbortSignal} [signal]
   * @returns {Promise<void | Error>}
   */
  startStream(systemPrompt, question, signal) {
    this.#streamActive = true;
    this.#contentHit = false;
    this.#isCapped = false;
    this.#wordCount = 0;
    this.#unsentBuffer = "";
    this.#ttsStream = null;
    this.#audioStream = null;
    this.#ttsStreamOpened = false;
    this.#firstChunkTimer = null;
    this.#firstChunkSent = false;
    this.#paused = false;
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
          // Send remaining delta + close stream
          this.#flushAndClose();
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
   * Append token to column and feed to streaming TTS.
   * @param {string} token
   * @returns {void}
   */
  feedToken(token) {
    this.#column.appendToken(token);
    this.#reasoningText += token;

    if (!this.#contentHit && !this.#isCapped && !this.#paused) {
      if (this.#textChunker) {
        this.#textChunker.feed(token);
      } else {
        this.#feedTts(token);
      }
    }
    this.#eventBus?.emit("token", { modelName: this.#model.name, token });
  }

  /**
   * Feed text into the streaming TTS buffer.
   * Accumulates in #unsentBuffer, flushes on word boundary.
   * @param {string} text
   */
  #feedTts(text) {
    // Update word count for token cap
    this.#wordCount = this.#reasoningText.split(/\s+/).filter(Boolean).length;

    // Token cap check
    if (this.#wordCount >= this.#ttsConfig.maxTokens) {
      this.#isCapped = true;
      this.#flushAndClose();
      return;
    }

    // Ensure stream is opened
    this.#ensureTtsStream();

    // Accumulate
    this.#unsentBuffer += text;

    // Flush on word boundary (whitespace or sentence-ending punctuation)
    if (this.#hasWordBoundary(this.#unsentBuffer)) {
      this.#flushBuffer();
    }
  }

  /**
   * Open the TTS streaming session on first text.
   */
  #ensureTtsStream() {
    if (this.#ttsStreamOpened) return;
    if (!this.#channel) return;

    this.#ttsStreamOpened = true;

    // Start 50ms first-chunk timeout for fast first audio
    this.#firstChunkTimer = setTimeout(() => {
      this.#firstChunkTimer = null;
      if (!this.#firstChunkSent && this.#unsentBuffer.length > 0) {
        this.#flushBuffer();
      }
    }, 50);

    // Open audio stream channel
    this.#audioStream = this.#channel.openStream();

    // Open TTS backend stream
    const handle = /** @type {import("../tts/kyutai-backend.js").KyutaiBackend} */ (this.#ttsEngine)
      .openStream(this.#model.voice, {
        onAudioChunk: (pcm, sampleRate) => {
          this.#audioStream?.feed(pcm, sampleRate);
        },
        onDone: () => {
          this.#audioStream?.end();
          this.#ttsActive = false;
          this.#emitProgress("done");
          this.#onIdle?.();
        },
        onError: (msg) => {
          this.setError(msg);
        },
      });

    this.#ttsStream = handle;
    this.#ttsActive = true;
    this.#emitProgress("tts-streaming");
  }

  /**
   * Flush unsent buffer to TTS server as incremental delta.
   */
  #flushBuffer() {
    if (this.#unsentBuffer.length === 0) return;
    this.#ensureTtsStream();

    // Cancel first-chunk timeout when we flush
    if (this.#firstChunkTimer) {
      clearTimeout(this.#firstChunkTimer);
      this.#firstChunkTimer = null;
    }
    this.#firstChunkSent = true;

    const delta = this.#unsentBuffer;
    this.#unsentBuffer = "";
    this.#ttsStream?.sendText(delta);
    this.#eventBus?.emit("tts-text-sent", {
      modelName: this.#model.name,
      chars: delta.length,
      words: delta.split(/\s+/).filter(Boolean).length,
    });
  }

  /**
   * Flush remaining buffer and close the stream.
   */
  #flushAndClose() {
    this.#flushBuffer();
    this.#ttsStream?.close();
  }

  /**
   * Check whether the buffered text ends at a word boundary.
   * @param {string} text
   * @returns {boolean}
   */
  #hasWordBoundary(text) {
    const trimmed = text.trimEnd();
    if (trimmed.length === 0) return false;
    const last = trimmed[trimmed.length - 1];
    return (
      last === " " ||
      last === "\n" ||
      last === "." ||
      last === "!" ||
      last === "?" ||
      last === ";"
    );
  }

  // ------------------------------------------------------------------
  // Replay path (preserved old protocol)
  // ------------------------------------------------------------------

  /**
   * Replay stored reasoning text using old single-shot protocol.
   * Uses startStream(fullText) + playStream(streamFn) — no change.
   * @param {string} text
   * @returns {Promise<void>}
   */
  async drainText(text) {
    this.#streamActive = true;
    this.#reasoningText = text;
    this.#isCapped = false;
    this.#wordCount = 0;
    this.#unsentBuffer = "";
    this.#ttsStream = null;
    this.#audioStream = null;
    this.#ttsStreamOpened = false;
    this.#firstChunkTimer = null;
    this.#firstChunkSent = false;
    this.#paused = false;

    // Feed text token-by-token with visual delay, same TTS path as live
    const chunkSize = 3;
    for (let i = 0; i < text.length; i += chunkSize) {
      const chunk = text.slice(i, i + chunkSize);
      this.#column.appendToken(chunk);
      if (!this.#isCapped) {
        this.#feedTtsReplay(chunk);
      }
      if (i % 30 === 0) {
        await new Promise((r) => setTimeout(r, 16));
      }
    }

    this.#flushTtsReplay();
    this.#emitProgress("finished");
  }

  /**
   * Replay path: feed text to legacy TTS (uses old startStream).
   * @param {string} text
   */
  #feedTtsReplay(text) {
    this.#unsentBuffer += text;
  }

  /**
   * Replay path: flush unsent buffer to legacy TTS.
   */
  #flushTtsReplay() {
    if (this.#unsentBuffer.length === 0) return;
    if (!this.#channel) return;

    const fullText = this.#reasoningText;
    const voice = this.#model.voice;
    const channel = this.#channel;

    /** @type {{ stop: () => void } | null} */
    let audioHandle = null;

    audioHandle = channel.playStream((onChunk) => {
      this.#ttsActive = true;
      this.#ttsEngine.startStream(
        fullText,
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
      return () => {
        this.#ttsEngine.stop();
      };
    });
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  /**
   * Soft stop: abort LLM stream, close TTS stream, destroy backend, stop audio.
   */
  softStop() {
    this.#abortController?.abort();

    // Close streaming TTS session
    this.#ttsStream?.close();
    this.#audioStream?.stop();

    // Destroy backend (closes WebSocket)
    this.#ttsEngine.destroy();

    this.#ttsActive = false;
    this.#ttsStream = null;
    this.#audioStream = null;
    this.#ttsStreamOpened = false;
    this.#unsentBuffer = "";
  }

  /**
   * Pause sending text to TTS (for monologue mode).
   * Current TTS generation continues; new tokens accumulate silently.
   */
  pause() {
    this.#paused = true;
  }

  /**
   * Resume sending text to TTS.
   * Flushes accumulated unsent buffer.
   */
  resume() {
    this.#paused = false;
    // Flush accumulated text
    if (this.#unsentBuffer.length > 0) {
      // Ensure stream is open (was paused before first text sent)
      this.#ensureTtsStream();
      this.#flushBuffer();
    }
  }

  /** Whether stream or TTS is still active.
   * @returns {boolean}
   */
  get isActive() {
    return this.#streamActive || this.#ttsActive;
  }

  /** Whether token cap has been reached.
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

  /** Mark content boundary reached. Flush buffer and close stream. */
  setContentHit() {
    this.#contentHit = true;
    this.#flushAndClose();
  }

  /** Set error on column.
   * @param {string} message
   */
  setError(message) {
    this.#column.setError(message);
    this.#eventBus?.emit("pipeline-error", {
      modelName: this.#model.name,
      message,
      timestamp: Date.now(),
    });
  }

  /**
   * Set a TextChunker for this pipeline.
   * When set, tokens are routed through the chunker instead of built-in word-boundary flush.
   * @param {import("../tts/text-chunker.js").TextChunker} chunker
   */
  setTextChunker(chunker) {
    this.#textChunker = chunker;
  }

  /**
   * Public flush callable by TextChunker's onFlush callback.
   */
  flushTts() {
    this.#flushBuffer();
  }

  // ------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------

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
