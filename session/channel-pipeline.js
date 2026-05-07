import { streamReasoning } from "../llm/llm-stream.js";
import { SentenceBuffer } from "../tts/sentence-buffer.js";
import { TTSPlaybackQueue } from "../tts/playback-queue.js";

/**
 * @typedef {import("../config.js").ModelConfig} ModelConfig
 * @typedef {import("../config.js").TTSConfig} TTSConfig
 * @typedef {import("../ui/column.js").ColumnAPI} ColumnAPI
 * @typedef {import("../audio/audio-graph.js").AudioGraph} AudioGraph
 * @typedef {import("../tts/kokoro-backend.js").KokoroBackend} KokoroBackend
 */

/**
 * @typedef {Object} ChannelPipelineDeps
 * @property {ModelConfig} model
 * @property {TTSConfig} ttsConfig
 * @property {ColumnAPI} column
 * @property {KokoroBackend} ttsEngine
 * @property {AudioGraph} audioGraph
 * @property {() => void} [onIdle]
 */

/**
 * Owns one model's full pipeline:
 * SentenceBuffer → TTSPlaybackQueue → Column → Channel.
 * The Orchestrator becomes a thin Session state coordinator.
 */
export class ChannelPipeline {
  /** @type {ModelConfig} */
  #model;
  /** @type {TTSConfig} */
  #ttsConfig;
  /** @type {ColumnAPI} */
  #column;
  /** @type {KokoroBackend} */
  #ttsEngine;
  /** @type {AudioGraph} */
  #audioGraph;
  /** @type {(() => void) | undefined} */
  #onIdle;
  /** @type {import("../audio/audio-graph.js").AudioGraphChannel | null} */
  #channel = null;
  /** @type {TTSPlaybackQueue | null} */
  #queue = null;
  /** @type {SentenceBuffer | null} */
  #buffer = null;
  /** @type {boolean} */
  #streamActive = false;
  /** @type {boolean} */
  #contentHit = false;
  /** @type {string} */
  #reasoningText = "";
  /** @type {AbortController | null} */
  #abortController = null;

  /**
   * @param {ChannelPipelineDeps} deps
   */
  constructor({ model, ttsConfig, column, ttsEngine, audioGraph, onIdle }) {
    this.#model = model;
    this.#ttsConfig = ttsConfig;
    this.#column = column;
    this.#ttsEngine = ttsEngine;
    this.#audioGraph = audioGraph;
    this.#onIdle = onIdle;
  }

  /** Create audio channel and attach waveform to column.
   * @returns {void}
   */
  createChannel() {
    if (this.#channel) return;
    this.#channel = this.#audioGraph.createChannel(this.#model.pan);
    this.#column.attachWaveform(this.#channel.analyser, this.#model.color);

    this.#queue = new TTSPlaybackQueue({
      ttsEngine: this.#ttsEngine,
      channel: this.#channel,
      voice: this.#model.voice,
      sentenceGapMs: 200,
      onIdle: () => {
        this.#onIdle?.();
      },
    });
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
    this.#abortController = new AbortController();

    const { signal: combinedSignal, cleanup: cleanupSignals } = this.#combineAbortSignals(
      signal,
      this.#abortController.signal
    );

    this.#buffer = new SentenceBuffer({
      maxTokens: this.#ttsConfig.maxTokens,
      timeoutTokens: this.#ttsConfig.sentenceTimeoutTokens,
      onSentence: (text) => {
        this.#queue?.enqueue(text);
      },
    });

    return streamReasoning(
      this.#model.url,
      this.#model.model,
      systemPrompt,
      question,
      {
        onReasoningToken: (token) => {
          this.feedToken(token);
        },
        onContentStart: () => {
          this.setContentHit();
        },
        onDone: () => {
          this.#streamActive = false;
          if (!this.#contentHit) {
            this.#buffer?.flush();
          }
          if (this.#reasoningText.length === 0) {
            this.setError("No reasoning received");
          }
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
   * Replay: feed stored text in chunks visually, then flush to TTS.
   * @param {string} text
   * @returns {Promise<void>}
   */
  async drainText(text) {
    this.#streamActive = true;
    this.#reasoningText = text;

    this.#buffer = new SentenceBuffer({
      maxTokens: this.#ttsConfig.maxTokens,
      timeoutTokens: this.#ttsConfig.sentenceTimeoutTokens,
      onSentence: (text) => {
        this.#queue?.enqueue(text);
      },
    });

    const chunkSize = 3;
    for (let i = 0; i < text.length; i += chunkSize) {
      const chunk = text.slice(i, i + chunkSize);
      this.#column.appendToken(chunk);
      if (!this.#buffer.isCapped) {
        this.#buffer.feed(chunk);
      }
      if (i % 30 === 0) {
        await new Promise((r) => setTimeout(r, 16));
      }
    }

    this.#buffer.flush();
    this.#streamActive = false;
  }

  /** Append token to column and buffer (if not capped).
   * @param {string} token
   * @returns {void}
   */
  feedToken(token) {
    this.#column.appendToken(token);
    this.#reasoningText += token;
    if (!this.#contentHit && this.#buffer && !this.#buffer.isCapped) {
      this.#buffer.feed(token);
    }
  }

  /** Soft stop: abort stream, finish current TTS sentence, then silence.
   * @returns {void}
   */
  softStop() {
    this.#abortController?.abort();
    this.#queue?.stop();
  }

  /** Flush any remaining buffer content.
   * @returns {void}
   */
  flush() {
    this.#buffer?.flush();
  }

  /** Pause the playback queue.
   * @returns {void}
   */
  pause() {
    this.#queue?.pause();
  }

  /** Resume the playback queue.
   * @returns {void}
   */
  resume() {
    this.#queue?.resume();
  }

  /** Whether stream or TTS is still active.
   * @returns {boolean}
   */
  get isActive() {
    return this.#streamActive || (this.#queue?.isActive ?? false);
  }

  /** Whether the token cap has been reached.
   * @returns {boolean}
   */
  get isCapped() {
    return this.#buffer?.isCapped ?? false;
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

  /** Mark content boundary reached.
   * @returns {void}
   */
  setContentHit() {
    this.#contentHit = true;
    this.#buffer?.flush();
  }

  /** Set error on column.
   * @param {string} message
   * @returns {void}
   */
  setError(message) {
    this.#column.setError(message);
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
