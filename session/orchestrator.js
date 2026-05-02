import { streamCompletion } from "../llm/lm-studio-client.js";
import { parseStream } from "../llm/stream-parser.js";
import { healthCheck } from "../llm/health-check.js";
import { SentenceBuffer } from "../tts/sentence-buffer.js";
import { TTSPlaybackQueue } from "../tts/playback-queue.js";

/**
 * Manages a full Session lifecycle: Idle → Loading → Thinking → Speaking → Done.
 * Runs all configured models concurrently, each with its own pipeline.
 * Supports replay of stored sessions.
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
  #storage;
  #sessionData = null;
  #questionText = "";
  #abortControllers = new Map();

  constructor({ models, systemPrompt, ttsConfig, audioGraph, columns, ttsEngine, onChannelCreated, storage }) {
    this.#models = models;
    this.#systemPrompt = systemPrompt;
    this.#ttsConfig = ttsConfig;
    this.#audioGraph = audioGraph;
    this.#columns = columns;
    this.#ttsEngine = ttsEngine;
    this.#onChannelCreated = onChannelCreated;
    this.#storage = storage;
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
    this.#questionText = question;
    this.#monologueIndex = 0;
    this.#allStreamsDone = false;
    this.#abortControllers.clear();
    this.#audioGraph.clearChannels();
    this.#setState("Loading");

    this.#setState("Loading: downloading TTS model…");
    await this.#ttsEngine.load();
    this.#activeSessions.clear();
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

  async replay(sessionData) {
    if (this.#state !== "Idle") return;
    this.#mode = sessionData.mode || "chorus";
    this.#questionText = sessionData.question;
    this.#monologueIndex = 0;
    this.#allStreamsDone = false;
    this.#audioGraph.clearChannels();
    this.#setState("Loading");

    this.#setState("Loading: downloading TTS model…");
    await this.#ttsEngine.load();
    this.#activeSessions.clear();
    this.#sessionData = { ...sessionData, id: crypto.randomUUID(), timestamp: new Date().toISOString() };

    // Use stored model data (preserving original voices/pan) for replay
    this.#setupPipelines(sessionData.models);

    // Feed stored reasoning text into each model's pipeline concurrently
    this.#setState("Thinking");

    const textFeeds = [];
    for (const modelData of sessionData.models) {
      const session = this.#activeSessions.get(modelData.name);
      if (!session) continue;
      const fullText = modelData.reasoningText || "";
      textFeeds.push(this.#replayText(session, fullText).then(() => {
        session.streamActive = false;
      }));
    }

    await Promise.all(textFeeds);

    this.#allStreamsDone = true;

    // Check if TTS is still playing
    if (this.#anyTtsActive()) {
      this.#setState("Speaking");
    } else {
      this.#finishSession();
    }
  }

  #setupPipelines(modelsToUse) {
    const models = modelsToUse || this.#models;
    for (const model of models) {
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
        reasoningText: "",
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
    }
  }

  async #runStream(session, question) {
    const { model, column, buffer } = session;
    const abortController = new AbortController();
    this.#abortControllers.set(model.name, abortController);

    try {
      const stream = await streamCompletion(
        model.url,
        model.model,
        this.#systemPrompt,
        question,
        abortController.signal
      );

      await parseStream(stream, {
        onReasoningToken: (token) => {
          column.appendToken(token);
          session.reasoningText += token;
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
      if (err.name === "AbortError") return;
      column.setError(`Error: ${err.message}`);
      session.streamActive = false;
      this.#checkAllDone();
    } finally {
      this.#abortControllers.delete(model.name);
    }
  }

  async #replayText(session, text) {
    const { column, buffer } = session;
    session.reasoningText = text;

    // Feed text character by character with small delay for visual effect
    const chunkSize = 3;
    for (let i = 0; i < text.length; i += chunkSize) {
      const chunk = text.slice(i, i + chunkSize);
      column.appendToken(chunk);
      if (!buffer.isCapped) {
        buffer.feed(chunk);
      }
      // Small delay for visual streaming effect
      if (i % 30 === 0) {
        await new Promise((r) => setTimeout(r, 16));
      }
    }

    // Flush any remaining buffer content
    buffer.flush();
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
    // Update stored reasoning text from session state
    for (const [name, session] of this.#activeSessions) {
      const modelData = this.#sessionData.models.find((m) => m.name === name);
      if (modelData) {
        modelData.reasoningText = session.reasoningText;
      }
    }

    // Save to storage
    this.#storage?.save(this.#sessionData);
    this.#storage?.saveQuestion(this.#questionText);

    this.#setState("Done");
    // Reset to Idle so a new session can start
    this.#state = "Idle";
  }

  #setState(newState) {
    this.#state = newState;
    this.#onStateChange?.(newState);
  }

  /** Soft stop: abort LLM streams, finish current TTS sentence, then silence. */
  stop() {
    for (const controller of this.#abortControllers.values()) {
      controller.abort();
    }
    this.#abortControllers.clear();
    for (const session of this.#activeSessions.values()) {
      session.queue.stop();
    }
    this.#setState("Done");
  }
}
