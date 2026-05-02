import { streamReasoning } from "../llm/llm-stream.js";
import { SentenceBuffer } from "../tts/sentence-buffer.js";
import { TTSPlaybackQueue } from "../tts/playback-queue.js";

/**
 * Owns one model's full pipeline:
 * SentenceBuffer → TTSPlaybackQueue → Column → Channel.
 * The Orchestrator becomes a thin Session state coordinator.
 */
export class ChannelPipeline {
  #model;
  #ttsConfig;
  #column;
  #ttsEngine;
  #audioGraph;
  #onIdle;
  #channel = null;
  #queue = null;
  #buffer = null;
  #streamActive = false;
  #contentHit = false;
  #reasoningText = "";
  #abortController = null;

  constructor({ model, ttsConfig, column, ttsEngine, audioGraph, onIdle }) {
    this.#model = model;
    this.#ttsConfig = ttsConfig;
    this.#column = column;
    this.#ttsEngine = ttsEngine;
    this.#audioGraph = audioGraph;
    this.#onIdle = onIdle;
  }

  /** Create audio channel and attach waveform to column. */
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
   */
  startStream(systemPrompt, question, signal) {
    this.#streamActive = true;
    this.#contentHit = false;
    this.#abortController = new AbortController();

    const combinedSignal = this.#combineAbortSignals(
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
        },
      },
      combinedSignal
    )
      .catch((err) => {
        if (err.name === "AbortError") return;
        this.setError(`Error: ${err.message}`);
        this.#streamActive = false;
        throw err;
      })
      .finally(() => {
        this.#streamActive = false;
      });
  }

  /**
   * Replay: feed stored text in chunks visually, then flush to TTS.
   * @param {string} text
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

  /** Append token to column and buffer (if not capped). */
  feedToken(token) {
    this.#column.appendToken(token);
    this.#reasoningText += token;
    if (!this.#contentHit && this.#buffer && !this.#buffer.isCapped) {
      this.#buffer.feed(token);
    }
  }

  /** Soft stop: abort stream, finish current TTS sentence, then silence. */
  softStop() {
    this.#abortController?.abort();
    this.#queue?.stop();
  }

  /** Flush any remaining buffer content. */
  flush() {
    this.#buffer?.flush();
  }

  /** Pause the playback queue. */
  pause() {
    this.#queue?.pause();
  }

  /** Resume the playback queue. */
  resume() {
    this.#queue?.resume();
  }

  /** Whether stream or TTS is still active. */
  get isActive() {
    return this.#streamActive || (this.#queue?.isActive ?? false);
  }

  /** Whether the token cap has been reached. */
  get isCapped() {
    return this.#buffer?.isCapped ?? false;
  }

  /** Accumulated reasoning text. */
  get reasoningText() {
    return this.#reasoningText;
  }

  /** Model name for orchestrator identification. */
  get modelName() {
    return this.#model.name;
  }

  /** Mark content boundary reached. */
  setContentHit() {
    this.#contentHit = true;
    this.#buffer?.flush();
  }

  /** Set error on column. */
  setError(message) {
    this.#column.setError(message);
  }

  #combineAbortSignals(...signals) {
    const controller = new AbortController();
    for (const signal of signals) {
      if (!signal) continue;
      if (signal.aborted) {
        controller.abort();
        return controller.signal;
      }
      signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    return controller.signal;
  }
}
