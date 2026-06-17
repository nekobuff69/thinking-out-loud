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
 * LLM token → column text → TTS streaming backend → audio channel.
 *
 * Live path (sentence-by-sentence streaming):
 *   Tokens flow through TextChunker (or word-boundary detection).
 *   Each sentence is queued and sent as a separate startStream call.
 *   Sentences play sequentially — next starts after current onDone.
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
  /** @type {{ feed: (pcm: Float32Array, sampleRate: number) => void, end: () => void, stop: () => void } | null} */
  #audioStream = null;
  /** @type {boolean} */
  #ttsStreamOpened = false;
  /** @type {number} */
  #wordCount = 0;
  /** @type {boolean} */
  #isCapped = false;
  /** @type {number} */
  #ttsWordOffset = 0;
  /** @type {number} */
  #msPerWord = 200; // adaptive, default ~5 words/sec
  /** @type {number} */
  #lastSentenceStartTime = 0;
  /** @type {number} */
  #lastSentenceWordCount = 0;
  /** @type {number} */
  #karaokeSentenceWordCount = 0;
  /** @type {number} */
  #karaokeSentenceStartIndex = 0;
  /** @type {boolean} */
  #karaokeStartedForSentence = false;
  /** @type {number} */
  #sentenceTotalPcmSamples = 0;
  /** @type {number} */
  #sentenceSampleRate = 24000;


  /** @type {string} */
  #liveBuffer = "";
  // Sentence queue for sentence-by-sentence TTS streaming
  /** @type {string[]} */
  #sentenceQueue = [];
  /** @type {boolean} */
  #currentSentenceActive = false;


  // Pause/resume for monologue
  /** @type {boolean} */
  #paused = false;

  // Replay synthesis guard — prevents double invocation of #synthesizeReplay
  /** @type {boolean} */
  #replaySynthesisActive = false;
  /** @type {(() => void) | null} */
  #reconnectUnsub = null;

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

  /** Expose the underlying AudioGraph channel for gain control.
   * @returns {import("../audio/audio-graph.js").AudioGraphChannel | null}
   */
  get channel() {
    return this.#channel;
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
    this.#audioStream = null;
    this.#ttsStreamOpened = false;
    this.#sentenceQueue = [];
    this.#currentSentenceActive = false;
    this.#ttsWordOffset = 0;
    this.#msPerWord = 200;
    this.#lastSentenceStartTime = 0;
    this.#lastSentenceWordCount = 0;
    this.#karaokeSentenceWordCount = 0;
    this.#karaokeSentenceStartIndex = 0;
    this.#karaokeStartedForSentence = false;
    this.#sentenceTotalPcmSamples = 0;
    this.#sentenceSampleRate = 24000;
    // Preserve #paused state — orchestrator may have paused this pipeline
    // before startStream is called (monologue mode). Resetting to false
    // would un-pause pipelines that should stay silent until resumed.
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
          // Flush remaining text and finalize TTS
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
        // Token cap check
        this.#wordCount = this.#reasoningText.split(/\s+/).filter(Boolean).length;
        if (this.#wordCount >= this.#ttsConfig.maxTokens) {
          this.#isCapped = true;
          this.#flushAndClose();
        } else {
          this.#textChunker.feed(token);
        }
      } else {
        this.#feedTts(token);
      }
    }
    this.#eventBus?.emit("token", { modelName: this.#model.name, token });
  }

  /**
   * Feed text into the TTS pipeline (non-TextChunker path).
   * Accumulates in #liveBuffer, flushes on sentence-ending punctuation.
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

    // Accumulate in live buffer (not #unsentBuffer, which is for replay)
    this.#liveBuffer += text;

    // Flush on sentence-ending punctuation
    if (this.#isSentenceBoundary(this.#liveBuffer)) {
      const sentence = this.#liveBuffer.trim();
      this.#liveBuffer = "";
      if (sentence.length > 0) {
        this.#sentenceQueue.push(sentence);
        this.#sendNextSentence();
      }
    }
  }

  /**
   * Open audio channel for TTS playback.
   * TextChunker handles chunk timing (150ms timeout, punctuation, max words).
   */
  #ensureTtsStream() {
    if (this.#ttsStreamOpened) return;
    if (!this.#channel) return;

    this.#ttsStreamOpened = true;

    // Open audio stream channel
    this.#audioStream = this.#channel.openStream();

    // Listen for backend reconnect to re-initialize audio stream
    if (this.#eventBus && !this.#reconnectUnsub) {
      this.#reconnectUnsub = this.#eventBus.on("tts-reconnect", () => {
        if (this.#audioStream && this.#channel) {
          this.#audioStream = this.#channel.openStream();
        }
      });
    }


    this.#ttsActive = true;
    this.#emitProgress("tts-streaming");
  }

  /**
   * Send the next sentence from the queue to the TTS engine.
   * Ensures sequential playback: next sentence starts only after current finishes.
   * @returns {void}
   */
  #sendNextSentence() {
    if (this.#currentSentenceActive) return;
    if (this.#sentenceQueue.length === 0) {
      // Queue empty. If LLM stream is done and TTS is still active, end audio.
      if (!this.#streamActive && this.#ttsActive) {
        this.#audioStream?.end();
        this.#ttsActive = false;
        this.#emitProgress("done");
        this.#onIdle?.();
      }
      return;
    }

    const sentenceText = /** @type {string} */ (this.#sentenceQueue.shift());
    // Karaoke: calculate word position and store for delayed start
    const sentenceWordCount = sentenceText.split(/\s+/).filter(Boolean).length;
    const startWordIndex = this.#ttsWordOffset;
    this.#ttsWordOffset += sentenceWordCount;
    this.#karaokeSentenceWordCount = sentenceWordCount;
    this.#karaokeSentenceStartIndex = startWordIndex;
    this.#karaokeStartedForSentence = false;
    this.#sentenceTotalPcmSamples = 0;
    this.#currentSentenceActive = true;
    this.#ensureTtsStream();

    this.#ttsEngine.startStream(
      sentenceText,
      this.#model.voice,
      (pcm, sampleRate) => {
        // Track PCM samples for duration calculation
        this.#sentenceTotalPcmSamples += pcm.length;
        this.#sentenceSampleRate = sampleRate;

        // Start karaoke on first audio chunk (when audio actually begins)
        if (!this.#karaokeStartedForSentence) {
          this.#karaokeStartedForSentence = true;
          const estimatedDuration = this.#karaokeSentenceWordCount * this.#msPerWord;
          this.#column.startKaraoke?.(
            this.#karaokeSentenceStartIndex,
            this.#karaokeSentenceWordCount,
            estimatedDuration
          );
        }

        this.#audioStream?.feed(pcm, sampleRate);
      },
      {
        onDone: () => {
          // Compute actual audio duration from PCM samples
          const actualAudioDurationMs = (this.#sentenceTotalPcmSamples / this.#sentenceSampleRate) * 1000;

          // Update karaoke timing with actual duration
          if (actualAudioDurationMs > 0 && this.#karaokeSentenceWordCount > 0) {
            this.#column.updateKaraokeDuration?.(actualAudioDurationMs);
            // Update adaptive timing for next sentence
            this.#msPerWord = actualAudioDurationMs / this.#karaokeSentenceWordCount;
          }

          // Karaoke will stop naturally when RAF loop reaches end of sentence
          this.#currentSentenceActive = false;
          this.#sendNextSentence();
        },
        onError: (msg) => {
          this.#column.stopKaraoke?.();
          this.#currentSentenceActive = false;
          this.setError(msg);
          this.#sendNextSentence();
        },
      }
    );
  }

  /**
   * Flush remaining buffer and prepare for stream close.
   * TextChunker path: flushes any pending text (triggers onFlush → queue).
   * Non-chunker path: pushes accumulated live buffer to sentence queue.
   * Always calls #sendNextSentence to handle finalization when queue is empty.
   */

  #flushAndClose() {
    if (this.#textChunker) {
      // TextChunker handles its own buffering — flush any pending text
      this.#textChunker.flush();
    } else {
      // Non-chunker path: push any remaining live buffer to sentence queue
      if (this.#liveBuffer && this.#liveBuffer.trim().length > 0) {
        this.#sentenceQueue.push(this.#liveBuffer.trim());
        this.#liveBuffer = "";
      }
    }
    // Check if queue is empty → finalize audio (end stream, emit done, call onIdle)
    this.#sendNextSentence();
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

  /**
   * Check whether the buffered text ends at a sentence boundary (punctuation).
   * @param {string} text
   * @returns {boolean}
   */
  #isSentenceBoundary(text) {
    const trimmed = text.trimEnd();
    if (trimmed.length === 0) return false;
    const last = trimmed[trimmed.length - 1];
    return (
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
    this.#audioStream = null;
    this.#ttsStreamOpened = false;
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

    this.#synthesizeReplay();
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
   * Replay path: terminal synthesis. Sends accumulated text to legacy TTS
   * via single-shot `startStream(fullText)`. Guarded against double invocation.
   * @throws {Error} if called while replay synthesis is already active
   */
  #synthesizeReplay() {
    if (this.#replaySynthesisActive) {
      throw new Error("synthesizeReplay already active — double invocation prevented");
    }
    if (this.#unsentBuffer.length === 0) return;
    if (!this.#channel) return;

    this.#replaySynthesisActive = true;

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
            this.#replaySynthesisActive = false;
            this.#ttsActive = false;
            this.#emitProgress("done");
            this.#onIdle?.();
          },
          onError: (msg) => {
            this.#replaySynthesisActive = false;
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
   * Soft stop: abort LLM stream, stop TTS, clear sentence queue, stop audio.
   */
  softStop() {
    this.#abortController?.abort();

    // Stop in-flight TTS and clear sentence queue
    this.#ttsEngine.stop();
    this.#sentenceQueue.length = 0;
    this.#currentSentenceActive = false;
    this.#audioStream?.stop();
    this.#column.stopKaraoke?.();
    this.#ttsWordOffset = 0;
    this.#karaokeSentenceWordCount = 0;
    this.#karaokeSentenceStartIndex = 0;
    this.#karaokeStartedForSentence = false;
    this.#sentenceTotalPcmSamples = 0;

    this.#cleanupReconnectListener();
    this.#ttsActive = false;
    this.#audioStream = null;
    this.#ttsStreamOpened = false;
    this.#unsentBuffer = "";
    this.#liveBuffer = "";
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
   * Re-feeds all accumulated reasoning text through the pipeline.
   * Clears any in-flight TTS and sentence queue, then re-chunks
   * the full reasoning text through TextChunker (or sends as one chunk
   * in non-chunker path).
   */

  resume() {
    this.#paused = false;
    this.#contentHit = false;
    this.#ttsStreamOpened = false;

    // Stop any in-flight TTS and clear sentence queue
    this.#ttsEngine.stop();
    this.#sentenceQueue.length = 0;
    this.#currentSentenceActive = false;
    this.#column.stopKaraoke?.();
    this.#karaokeSentenceWordCount = 0;
    this.#karaokeSentenceStartIndex = 0;
    this.#karaokeStartedForSentence = false;
    this.#sentenceTotalPcmSamples = 0;

    this.#ensureTtsStream();

    if (this.#reasoningText.length > 0 && !this.#isCapped) {
      if (this.#textChunker) {
        // Re-feed full reasoning text through TextChunker for sentence segmentation
        this.#textChunker.reset();
        this.#textChunker.feed(this.#reasoningText);
        this.#textChunker.flush();
      } else {
        // Non-chunker path: send full reasoning text as one chunk
        this.#sentenceQueue.push(this.#reasoningText);
        this.#sendNextSentence();
      }
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

  /** Mark content boundary reached. Flush pending text and stop feeding TTS. */
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
   * Receives the flushed sentence text and queues it for TTS.
   * @param {string} text
   */
  flushTts(text) {
    if (text && text.trim().length > 0) {
      this.#sentenceQueue.push(text.trim());
      this.#sendNextSentence();
    }
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

  /** Clean up tts-reconnect listener. */
  #cleanupReconnectListener() {
    if (this.#reconnectUnsub) {
      this.#reconnectUnsub();
      this.#reconnectUnsub = null;
    }
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
