import { streamCompletion } from "../llm/lm-studio-client.js";
import { parseStream } from "../llm/stream-parser.js";
import { SentenceBuffer } from "../tts/sentence-buffer.js";
import { TTSPlaybackQueue } from "../tts/playback-queue.js";

/**
 * Manages a full Session lifecycle: Idle → Loading → Thinking → Speaking → Done.
 * Runs all configured models concurrently, each with its own pipeline.
 */
export class Orchestrator {
  #models;
  #systemPrompt;
  #ttsConfig;
  #audioGraph;
  #columns;
  #ttsEngine;
  #onStateChange;
  #state = "Idle";
  #activeSessions = new Map();
  #onChannelCreated;
  #mode = "chorus";
  #monologueIndex = 0;
  #allStreamsDone = false;

  constructor({ models, systemPrompt, ttsConfig, audioGraph, columns, ttsEngine, onChannelCreated }) {
    this.#models = models;
    this.#systemPrompt = systemPrompt;
    this.#ttsConfig = ttsConfig;
    this.#audioGraph = audioGraph;
    this.#columns = columns;
    this.#ttsEngine = ttsEngine;
    this.#onChannelCreated = onChannelCreated;
  }

  onStateChange(fn) {
    this.#onStateChange = fn;
  }

  get state() {
    return this.#state;
  }

  async start(question, mode) {
    if (this.#state !== "Idle") return;
    this.#mode = mode || "chorus";
    this.#monologueIndex = 0;
    this.#allStreamsDone = false;
    this.#setState("Loading");

    await this.#ttsEngine.load();
    this.#activeSessions.clear();

    // Build per-model pipelines
    for (const model of this.#models) {
      const column = this.#columns.get(model.name);
      if (!column) continue;
      column.clear();

      const channel = this.#audioGraph.createChannel(model.pan);
      this.#onChannelCreated?.(model.name, channel);

      const session = {
        model,
        column,
        channel,
        streamActive: false,
        ttsActive: false,
        contentHit: false,
      };

      session.queue = new TTSPlaybackQueue({
        ttsEngine: this.#ttsEngine,
        channel,
        voice: model.voice,
        sentenceGapMs: 200,
        onIdle: () => {
          session.ttsActive = false;
          if (this.#mode === "monologue") {
            this.#advanceMonologue();
          }
          this.#checkAllDone();
        },
      });

      // In Monologue mode, pause all queues except the first
      if (this.#mode === "monologue") {
        const sessionIndex = [...this.#activeSessions.keys()].indexOf(model.name);
        if (sessionIndex > 0) {
          session.queue.pause();
        }
      }

      session.buffer = new SentenceBuffer({
        maxTokens: this.#ttsConfig.maxTokens,
        timeoutTokens: this.#ttsConfig.sentenceTimeoutTokens,
        onSentence: (text) => {
          session.ttsActive = true;
          session.queue.enqueue(text);
        },
      });

      this.#activeSessions.set(model.name, session);
    }

    // Fire all 3 LLM streams concurrently
    this.#setState("Thinking");
    const fetches = [];

    for (const session of this.#activeSessions.values()) {
      session.streamActive = true;
      fetches.push(this.#runStream(session, question).catch((err) => err));
    }

    await Promise.all(fetches);
    this.#allStreamsDone = true;

    // All streams done — check if TTS is still playing
    if (this.#anyTtsActive()) {
      this.#setState("Speaking");
    } else {
      this.#finishSession();
    }
  }

  #advanceMonologue() {
    if (this.#mode !== "monologue") return;
    const sessionKeys = [...this.#activeSessions.keys()];
    this.#monologueIndex++;
    if (this.#monologueIndex < sessionKeys.length) {
      const nextSession = this.#activeSessions.get(sessionKeys[this.#monologueIndex]);
      if (nextSession) {
        nextSession.ttsActive = true;
        nextSession.queue.resume();
      }
    }
  }

  async #runStream(session, question) {
    const { model, column, buffer } = session;

    try {
      const stream = await streamCompletion(
        model.url,
        model.model,
        this.#systemPrompt,
        question
      );

      await parseStream(stream, {
        onReasoningToken: (token) => {
          column.appendToken(token);
          if (!session.contentHit && !buffer.isCapped) {
            buffer.feed(token);
          }
        },
        onContentStart: () => {
          session.contentHit = true;
          buffer.flush();
        },
        onDone: () => {
          session.streamActive = false;
          if (!session.contentHit) {
            buffer.flush();
          }
          this.#checkAllDone();
        },
      });
    } catch (err) {
      column.setError(`Error: ${err.message}`);
      session.streamActive = false;
      this.#checkAllDone();
    }
  }

  #anyTtsActive() {
    return [...this.#activeSessions.values()].some((s) => s.ttsActive);
  }

  #checkAllDone() {
    if (this.#state === "Done") return;

    // In Monologue mode, only consider done when the last model's TTS finishes
    if (this.#mode === "monologue") {
      const sessionKeys = [...this.#activeSessions.keys()];
      const lastModel = sessionKeys[sessionKeys.length - 1];
      const lastSession = this.#activeSessions.get(lastModel);
      if (this.#allStreamsDone && lastSession && !lastSession.ttsActive) {
        this.#finishSession();
      }
      return;
    }

    // Chorus mode: done when all streams done and all TTS idle
    const allStreamsDone = [...this.#activeSessions.values()].every(
      (s) => !s.streamActive
    );

    if (allStreamsDone && !this.#anyTtsActive()) {
      if (this.#state === "Thinking" || this.#state === "Speaking") {
        this.#finishSession();
      }
    }
  }

  #finishSession() {
    this.#setState("Done");
  }

  #setState(newState) {
    this.#state = newState;
    this.#onStateChange?.(newState);
  }

  /** Soft stop: finish current TTS sentences, then abort. */
  stop() {
    for (const session of this.#activeSessions.values()) {
      session.queue.stop();
    }
    this.#setState("Done");
  }
}
