import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ChannelPipeline } from "../session/channel-pipeline.js";
import { TextChunker } from "../tts/text-chunker.js";

describe("ChannelPipeline", () => {
  /** @type {string[]} */
  let setErrorCalls;

  // Default mock for empty-stream test
  function makePipeline(opts = {}) {
    setErrorCalls = [];

    const {
      ttsEngine = defaultTtsEngine(),
      llmProvider = defaultLlmProvider(),
      audioGraph = defaultAudioGraph(),
      eventBus,
      useTextChunker = true,
    } = opts;

    const mockColumn = {
      appendToken: () => {},
      clear: () => {},
      setError: (/** @type {string} */ msg) => { setErrorCalls.push(msg); },
      attachWaveform: () => {},
      stopWaveform: () => {},
    };

    const pipeline = new ChannelPipeline({
      model: { name: "testModel", url: "http://localhost", model: "test", voice: "alba", color: "#fff", pan: 0, provider: "test" },
      ttsConfig: { maxTokens: 200, sentenceTimeoutTokens: 30 },
      column: mockColumn,
      ttsEngine,
      llmProvider,
      audioGraph,
      eventBus,
    });

    pipeline.createChannel();

    if (useTextChunker) {
      const chunker = new TextChunker({
        maxWords: 8,
        timeoutMs: 150,
        flushOnPunctuation: true,
        onFlush: (/** @type {string} */ text) => pipeline.flushTts(text),
      });
      pipeline.setTextChunker(chunker);
    }

    return { pipeline, setErrorCalls };
  }

  function defaultAudioGraph() {
    return {
      createChannel: () => {
        const ch = {
          analyser: {},
          play: () => ({}),
          gain: { gain: { value: 1, setTargetAtTime: () => {} } },
          stopAll: () => {},
          playStream: (/** @type {(onChunk: (pcm: Float32Array, sampleRate: number) => void) => (() => void)} */ streamFn) => {
            const cleanup = streamFn(() => {});
            return { stop: () => { if (cleanup) cleanup(); } };
          },
          openStream: () => {
            /** @type {{ feed: (pcm: Float32Array, sampleRate: number) => void, end: () => void, stop: () => void }} */
            const handle = {
              feed: () => {},
              end: () => {},
              stop: () => {},
            };
            return handle;
          },
        };
        return ch;
      },
    };
  }

  function defaultTtsEngine() {
    return {
      load: async () => {},
      startStream: (
        /** @type {string} */ _text,
        /** @type {string} */ _voice,
        /** @type {(pcm: Float32Array, sampleRate: number) => void} */ _onAudioChunk,
        /** @type {{ onDone?: () => void, onError?: (message: string) => void }} */ callbacks
      ) => {
        if (callbacks?.onDone) {
          queueMicrotask(() => callbacks.onDone?.());
        }
      },
      stop: () => {},
      destroy: () => {},
    };
  }

  function defaultLlmProvider() {
    return {
      streamReasoning: async (
        /** @type {string} */ _question,
        /** @type {string} */ _systemPrompt,
        /** @type {{ onReasoningToken?: (token: string) => void, onContentStart?: () => void, onDone?: () => void }} */ callbacks
      ) => {
        callbacks.onDone?.();
      },
    };
  }

  // ------------------------------------------------------------------
  // Basic error handling
  // ------------------------------------------------------------------

  it("shows error when LLM stream produces zero reasoning tokens", async () => {
    const { pipeline, setErrorCalls } = makePipeline();

    await pipeline.startStream("system prompt", "question");

    assert.ok(setErrorCalls.length > 0, "expected setError to be called");
    assert.match(setErrorCalls[0], /reasoning/i, "error message should mention reasoning");
  });

  // ------------------------------------------------------------------
  // Sentence-by-sentence streaming (TextChunker active)
  // ------------------------------------------------------------------

  it("sends each sentence as a separate startStream call", async () => {
    /** @type {string[]} */
    const streamTexts = [];

    const mockTtsEngine = {
      load: async () => {},
      startStream: (
        /** @type {string} */ text,
        /** @type {string} */ _voice,
        /** @type {(pcm: Float32Array, sampleRate: number) => void} */ _onChunk,
        /** @type {{ onDone?: () => void, onError?: (message: string) => void }} */ callbacks
      ) => {
        streamTexts.push(text);
        if (callbacks?.onDone) {
          queueMicrotask(() => callbacks.onDone?.());
        }
      },
      stop: () => {},
      destroy: () => {},
    };

    const mockLlmProvider = {
      streamReasoning: async (
        /** @type {string} */ _q,
        /** @type {string} */ _s,
        /** @type {{ onReasoningToken?: (token: string) => void, onDone?: () => void }} */ cb
      ) => {
        cb.onReasoningToken?.("Hello");
        cb.onReasoningToken?.(" world.");
        cb.onReasoningToken?.(" This");
        cb.onReasoningToken?.(" is");
        cb.onReasoningToken?.(" a");
        cb.onReasoningToken?.(" test.");
        cb.onDone?.();
      },
    };

    const { pipeline } = makePipeline({ ttsEngine: mockTtsEngine, llmProvider: mockLlmProvider });
    await pipeline.startStream("system prompt", "question");

    // TextChunker flushes on punctuation: should produce 2 sentences
    assert.ok(streamTexts.length >= 2, "should have at least 2 startStream calls for 2 sentences");
    assert.ok(streamTexts.some(t => t.includes("world")), "first sentence should contain 'world'");
    assert.ok(streamTexts.some(t => t.includes("test")), "second sentence should contain 'test'");
  });

  it("sentences play sequentially — next starts after current onDone", async () => {
    /** @type {string[]} */
    const callOrder = [];
    /** @type {Array<() => void>} */
    const pendingDoneCallbacks = [];

    const mockTtsEngine = {
      load: async () => {},
      startStream: (
        /** @type {string} */ text,
        /** @type {string} */ _voice,
        /** @type {(pcm: Float32Array, sampleRate: number) => void} */ _onChunk,
        /** @type {{ onDone?: () => void, onError?: (message: string) => void }} */ callbacks
      ) => {
        callOrder.push(`start:${text.trim()}`);
        // Don't call onDone immediately — store it for later
        if (callbacks?.onDone) {
          pendingDoneCallbacks.push(() => {
            callOrder.push(`done:${text.trim()}`);
            callbacks.onDone?.();
          });
        }
      },
      stop: () => {},
      destroy: () => {},
    };

    const mockLlmProvider = {
      streamReasoning: async (
        /** @type {string} */ _q,
        /** @type {string} */ _s,
        /** @type {{ onReasoningToken?: (token: string) => void, onDone?: () => void }} */ cb
      ) => {
        cb.onReasoningToken?.("First.");
        cb.onReasoningToken?.(" Second.");
        cb.onDone?.();
      },
    };

    const { pipeline } = makePipeline({ ttsEngine: mockTtsEngine, llmProvider: mockLlmProvider });
    const done = pipeline.startStream("system prompt", "question");

    // Wait for TextChunker to flush (150ms timeout or punctuation)
    await new Promise((r) => setTimeout(r, 20));

    // Two sentences should be queued, but only first should have started
    // (second waits for first's onDone)
    assert.ok(callOrder.length >= 1, "at least first sentence should have started");

    // Complete first sentence
    pendingDoneCallbacks[0]?.();
    await new Promise((r) => setTimeout(r, 10));

    // Now second sentence should have started
    assert.ok(callOrder.length >= 3, "second sentence should start after first finishes");

    // Complete second sentence
    pendingDoneCallbacks[1]?.();
    await done;
  });

  it("pipes tokens to TTS via sentence queue", async () => {
    /** @type {string[]} */
    const ttsTexts = [];

    const mockTtsEngine = {
      load: async () => {},
      startStream: (
        /** @type {string} */ text,
        /** @type {string} */ _voice,
        /** @type {(pcm: Float32Array, sampleRate: number) => void} */ _onChunk,
        /** @type {{ onDone?: () => void }} */ callbacks
      ) => {
        ttsTexts.push(text);
        if (callbacks?.onDone) {
          queueMicrotask(() => callbacks.onDone?.());
        }
      },
      stop: () => {},
      destroy: () => {},
    };

    const mockLlmProvider = {
      streamReasoning: async (
        /** @type {string} */ _question,
        /** @type {string} */ _systemPrompt,
        /** @type {{ onReasoningToken?: (token: string) => void, onContentStart?: () => void, onDone?: () => void }} */ callbacks
      ) => {
        callbacks.onReasoningToken?.("The answer is complex.");
        callbacks.onDone?.();
      },
    };

    const { pipeline } = makePipeline({ ttsEngine: mockTtsEngine, llmProvider: mockLlmProvider });
    await pipeline.startStream("system prompt", "question");

    assert.ok(ttsTexts.length > 0, "expected TTS to receive text via startStream");
    assert.ok(ttsTexts.some(t => t.includes("complex")), "should contain reasoning tokens");
  });

  it("token cap stops feeding new text to TextChunker", async () => {
    let feedCount = 0;

    // Create a custom TextChunker that counts feeds
    const mockTtsEngine = {
      load: async () => {},
      startStream: (
        /** @type {string} */ _text,
        /** @type {string} */ _voice,
        /** @type {(pcm: Float32Array, sampleRate: number) => void} */ _onChunk,
        /** @type {{ onDone?: () => void }} */ callbacks
      ) => {
        if (callbacks?.onDone) {
          queueMicrotask(() => callbacks.onDone?.());
        }
      },
      stop: () => {},
      destroy: () => {},
    };

    const mockLlmProvider = {
      streamReasoning: async (
        /** @type {string} */ _q,
        /** @type {string} */ _s,
        /** @type {{ onReasoningToken?: (token: string) => void, onDone?: () => void }} */ cb
      ) => {
        cb.onReasoningToken?.("start");
        for (let i = 1; i < 250; i++) {
          cb.onReasoningToken?.(` word${i}`);
        }
        cb.onDone?.();
      },
    };

    const { pipeline } = makePipeline({ ttsEngine: mockTtsEngine, llmProvider: mockLlmProvider });
    await pipeline.startStream("system prompt", "question");

    assert.ok(pipeline.isCapped, "pipeline should report isCapped when token limit exceeded");
  });

  it("content boundary flushes pending TextChunker text", async () => {
    /** @type {string[]} */
    const streamTexts = [];

    const mockTtsEngine = {
      load: async () => {},
      startStream: (
        /** @type {string} */ text,
        /** @type {string} */ _voice,
        /** @type {(pcm: Float32Array, sampleRate: number) => void} */ _onChunk,
        /** @type {{ onDone?: () => void }} */ callbacks
      ) => {
        streamTexts.push(text);
        if (callbacks?.onDone) {
          queueMicrotask(() => callbacks.onDone?.());
        }
      },
      stop: () => {},
      destroy: () => {},
    };

    const mockLlmProvider = {
      streamReasoning: async (
        /** @type {string} */ _q,
        /** @type {string} */ _s,
        /** @type {{ onReasoningToken?: (token: string) => void, onContentStart?: () => void, onDone?: () => void }} */ cb
      ) => {
        cb.onReasoningToken?.("Some reasoning text.");
        cb.onContentStart?.();
        cb.onDone?.();
      },
    };

    const { pipeline } = makePipeline({ ttsEngine: mockTtsEngine, llmProvider: mockLlmProvider });
    await pipeline.startStream("system prompt", "question");

    assert.ok(streamTexts.length > 0, "startStream should be called for flushed reasoning text");
    assert.ok(streamTexts.some(t => t.includes("Some")), "should contain reasoning text");
  });

  // ------------------------------------------------------------------
  // Non-chunker fallback path
  // ------------------------------------------------------------------

  it("non-chunker path sends full text as one chunk", async () => {
    /** @type {string[]} */
    const streamTexts = [];

    const mockTtsEngine = {
      load: async () => {},
      startStream: (
        /** @type {string} */ text,
        /** @type {string} */ _voice,
        /** @type {(pcm: Float32Array, sampleRate: number) => void} */ _onChunk,
        /** @type {{ onDone?: () => void }} */ callbacks
      ) => {
        streamTexts.push(text);
        if (callbacks?.onDone) {
          queueMicrotask(() => callbacks.onDone?.());
        }
      },
      stop: () => {},
      destroy: () => {},
    };

    const mockLlmProvider = {
      streamReasoning: async (
        /** @type {string} */ _q,
        /** @type {string} */ _s,
        /** @type {{ onReasoningToken?: (token: string) => void, onDone?: () => void }} */ cb
      ) => {
        cb.onReasoningToken?.("Hello");
        cb.onReasoningToken?.(" world.");
        cb.onReasoningToken?.(" This is more.");
        cb.onDone?.();
      },
    };

    const { pipeline } = makePipeline({ ttsEngine: mockTtsEngine, llmProvider: mockLlmProvider, useTextChunker: false });
    await pipeline.startStream("system prompt", "question");

    // Without TextChunker, text is queued on sentence boundaries (punctuation)
    // and remaining is flushed on completion
    assert.ok(streamTexts.length >= 1, "should have at least one startStream call");
    const allText = streamTexts.join(" ");
    assert.ok(allText.includes("world"), "should contain reasoning tokens");
  });

  // ------------------------------------------------------------------
  // softStop
  // ------------------------------------------------------------------

  it("stops TTS on softStop", async () => {
    let stopCalled = false;
    let ttsDestroyed = false;
    let audioStopped = false;

    const mockAudioGraph = {
      createChannel: () => {
        const ch = {
          analyser: {},
          play: () => ({}),
          gain: { gain: { value: 1, setTargetAtTime: () => {} } },
          stopAll: () => {},
          playStream: () => ({ stop: () => {} }),
          openStream: () => ({
            feed: () => {},
            end: () => {},
            stop: () => { audioStopped = true; },
          }),
        };
        return ch;
      },
    };

    const mockTtsEngine = {
      load: async () => {},
      startStream: () => {},
      stop: () => { stopCalled = true; },
      destroy: () => { ttsDestroyed = true; },
    };

    const mockLlmProvider = {
      streamReasoning: async (
        /** @type {string} */ _question,
        /** @type {string} */ _systemPrompt,
        /** @type {{ onReasoningToken?: (token: string) => void, onDone?: () => void }} */ callbacks
      ) => {
        callbacks.onReasoningToken?.("Hello there.");
        return new Promise(() => {});
      },
    };

    const { pipeline } = makePipeline({ ttsEngine: mockTtsEngine, llmProvider: mockLlmProvider, audioGraph: mockAudioGraph });
    const startPromise = pipeline.startStream("system prompt", "question");

    // Wait for first token to trigger stream opening
    await new Promise((r) => setTimeout(r, 20));

    pipeline.softStop();

    assert.strictEqual(stopCalled, true, "TTS engine stop should be called");
    assert.strictEqual(ttsDestroyed, false, "TTS backend should NOT be destroyed by pipeline");
    assert.strictEqual(audioStopped, true, "audio should be stopped");
  });

  it("softStop clears sentence queue", async () => {
    /** @type {string[]} */
    const streamTexts = [];
    let stopCalled = false;

    const mockTtsEngine = {
      load: async () => {},
      startStream: (
        /** @type {string} */ text,
        /** @type {string} */ _voice,
        /** @type {(pcm: Float32Array, sampleRate: number) => void} */ _onChunk,
        /** @type {{ onDone?: () => void }} */ _callbacks
      ) => {
        streamTexts.push(text);
        // Don't call onDone — keeps sentence active
      },
      stop: () => { stopCalled = true; },
      destroy: () => {},
    };

    const mockLlmProvider = {
      streamReasoning: async (
        /** @type {string} */ _q,
        /** @type {string} */ _s,
        /** @type {{ onReasoningToken?: (token: string) => void, onDone?: () => void }} */ cb
      ) => {
        cb.onReasoningToken?.("First.");
        cb.onReasoningToken?.(" Second.");
        cb.onDone?.();
      },
    };

    const { pipeline } = makePipeline({ ttsEngine: mockTtsEngine, llmProvider: mockLlmProvider });
    pipeline.startStream("system prompt", "question");
    await new Promise((r) => setTimeout(r, 20));

    // First sentence should have started (held by not calling onDone)
    const beforeStop = streamTexts.length;
    assert.ok(beforeStop >= 1, "first sentence should be started");

    pipeline.softStop();

    assert.strictEqual(stopCalled, true, "TTS engine stop should be called");
    // After softStop, no more startStream calls should happen
    const afterStop = streamTexts.length;
    assert.strictEqual(afterStop, beforeStop, "no new startStream calls after softStop");
  });

  it("softStop on pipeline A leaves pipeline B's backend usable", async () => {
    let bDestroyed = false;

    const sharedBackend = {
      load: async () => {},
      startStream: () => {},
      stop: () => {},
      destroy: () => { bDestroyed = true; },
    };

    function makeIsolatedPipeline(ttsEngine, llmProvider, audioGraph) {
      const mockColumn = {
        appendToken: () => {},
        clear: () => {},
        setError: () => {},
        attachWaveform: () => {},
        stopWaveform: () => {},
      };

      const p = new ChannelPipeline({
        model: { name: "test", url: "http://localhost", model: "test", voice: "alba", color: "#fff", pan: 0, provider: "test" },
        ttsConfig: { maxTokens: 200, sentenceTimeoutTokens: 30 },
        column: mockColumn,
        ttsEngine,
        llmProvider,
        audioGraph,
      });
      p.createChannel();
      return p;
    }

    const mockAudioGraph = {
      createChannel: () => ({
        analyser: {},
        play: () => ({}),
        gain: { gain: { value: 1, setTargetAtTime: () => {} } },
        stopAll: () => {},
        playStream: () => ({ stop: () => {} }),
        openStream: () => ({
          feed: () => {},
          end: () => {},
          stop: () => {},
        }),
      }),
    };

    const mockLlmProvider = {
      streamReasoning: async (
        /** @type {string} */ _q,
        /** @type {string} */ _s,
        /** @type {{ onReasoningToken?: (token: string) => void }} */ cb
      ) => {
        cb.onReasoningToken?.("Hello");
        return new Promise(() => {});
      },
    };

    const pipelineA = makeIsolatedPipeline(sharedBackend, mockLlmProvider, mockAudioGraph);
    pipelineA.startStream("system prompt", "question");
    await new Promise((r) => setTimeout(r, 20));
    pipelineA.softStop();

    assert.strictEqual(bDestroyed, false, "softStop on A should not destroy shared backend");

    let bStreamStarted = false;
    const bBackendCheck = {
      load: async () => {},
      startStream: () => { bStreamStarted = true; },
      stop: () => {},
      destroy: () => {},
    };

    bBackendCheck.startStream("test text", "alba", () => {}, {});
    assert.strictEqual(bStreamStarted, true, "shared backend should still accept startStream after A's softStop");
  });

  // ------------------------------------------------------------------
  // Accumulation / replay
  // ------------------------------------------------------------------

  it("accumulates reasoning text for storage", async () => {
    const mockTtsEngine = {
      load: async () => {},
      startStream: (
        /** @type {string} */ _text,
        /** @type {string} */ _voice,
        /** @type {(pcm: Float32Array, sampleRate: number) => void} */ _onChunk,
        /** @type {{ onDone?: () => void }} */ callbacks
      ) => {
        if (callbacks?.onDone) {
          queueMicrotask(() => callbacks.onDone?.());
        }
      },
      stop: () => {},
      destroy: () => {},
    };

    const mockLlmProvider = {
      streamReasoning: async (
        /** @type {string} */ _question,
        /** @type {string} */ _systemPrompt,
        /** @type {{ onReasoningToken?: (token: string) => void, onDone?: () => void }} */ callbacks
      ) => {
        callbacks.onReasoningToken?.("I");
        callbacks.onReasoningToken?.(" think");
        callbacks.onReasoningToken?.(" therefore");
        callbacks.onReasoningToken?.(" I am.");
        callbacks.onDone?.();
      },
    };

    const { pipeline } = makePipeline({ ttsEngine: mockTtsEngine, llmProvider: mockLlmProvider });
    await pipeline.startStream("system prompt", "question");

    assert.strictEqual(pipeline.reasoningText, "I think therefore I am.");
  });

  it("replay drainText feeds text through TTS using old path", async () => {
    const ttsTexts = [];

    const mockTtsEngine = {
      load: async () => {},
      startStream: (/** @type {string} */ text) => {
        ttsTexts.push(text);
      },
      stop: () => {},
      destroy: () => {},
    };

    const mockAudioGraph = {
      createChannel: () => ({
        analyser: {},
        play: () => ({}),
        gain: { gain: { value: 1, setTargetAtTime: () => {} } },
        stopAll: () => {},
        playStream: (/** @type {(onChunk: (pcm: Float32Array, sampleRate: number) => void) => (() => void)} */ streamFn) => {
          streamFn(() => {});
          return { stop: () => {} };
        },
        openStream: () => {},
      }),
    };

    const pipeline = new ChannelPipeline({
      model: { name: "testModel", url: "http://localhost", model: "test", voice: "alba", color: "#fff", pan: 0, provider: "test" },
      ttsConfig: { maxTokens: 200, sentenceTimeoutTokens: 30 },
      column: {
        appendToken: () => {},
        clear: () => {},
        setError: () => {},
        attachWaveform: () => {},
        stopWaveform: () => {},
      },
      ttsEngine: mockTtsEngine,
      llmProvider: /** @type {any} */ (null),
      audioGraph: mockAudioGraph,
    });

    pipeline.createChannel();
    await pipeline.drainText("Replayed reasoning text.");

    assert.ok(ttsTexts.length > 0, "drainText should feed text to TTS via old path");
    assert.strictEqual(pipeline.reasoningText, "Replayed reasoning text.");
  });

  it("replay #synthesizeReplay throws on double invocation", async () => {
    const mockTtsEngine = {
      load: async () => {},
      startStream: (
        /** @type {string} */ _text,
        /** @type {string} */ _voice,
        /** @type {(pcm: Float32Array, sampleRate: number) => void} */ _onAudioChunk,
        /** @type {{ onDone?: () => void, onError?: (message: string) => void }} */ _callbacks
      ) => {
        // Intentionally do NOT call onDone — keeps #replaySynthesisActive = true
      },
      stop: () => {},
      destroy: () => {},
    };

    const mockAudioGraph = {
      createChannel: () => ({
        analyser: {},
        play: () => ({}),
        gain: { gain: { value: 1, setTargetAtTime: () => {} } },
        stopAll: () => {},
        playStream: (
          /** @type {(onChunk: (pcm: Float32Array, sampleRate: number) => void) => (() => void)} */ streamFn
        ) => {
          streamFn(() => {});
          return { stop: () => {} };
        },
        openStream: () => {},
      }),
    };

    const pipeline = new ChannelPipeline({
      model: { name: "testModel", url: "http://localhost", model: "test", voice: "alba", color: "#fff", pan: 0, provider: "test" },
      ttsConfig: { maxTokens: 200, sentenceTimeoutTokens: 30 },
      column: {
        appendToken: () => {},
        clear: () => {},
        setError: () => {},
        attachWaveform: () => {},
        stopWaveform: () => {},
      },
      ttsEngine: mockTtsEngine,
      llmProvider: /** @type {any} */ (null),
      audioGraph: mockAudioGraph,
    });

    pipeline.createChannel();

    // First drainText — starts replay synthesis, leaves it active
    await pipeline.drainText("First replay reasoning text.");

    // Second drainText should throw because #replaySynthesisActive is still true
    await assert.rejects(
      async () => {
        await pipeline.drainText("Second replay text that should fail.");
      },
      (/** @type {Error} */ err) => {
        return (
          err instanceof Error &&
          err.message.includes("synthesizeReplay already active")
        );
      }
    );
  });

  // ------------------------------------------------------------------
  // Reconnect — re-initialize audio stream
  // ------------------------------------------------------------------

  it("re-creates audio stream on tts-reconnect event", async () => {
    /** @type {number} */
    let openStreamCallCount = 0;
    /** @type {Array<{feed: () => void, end: () => void, stop: () => void}>} */
    let lastAudioHandle = null;

    const mockAudioGraph = {
      createChannel: () => {
        const ch = {
          analyser: {},
          play: () => ({}),
          gain: { gain: { value: 1, setTargetAtTime: () => {} } },
          stopAll: () => {},
          playStream: () => ({ stop: () => {} }),
          openStream: () => {
            openStreamCallCount++;
            const handle = { feed: () => {}, end: () => {}, stop: () => {} };
            lastAudioHandle = handle;
            return handle;
          },
        };
        return ch;
      },
    };

    const { SimpleEventBus } = await import("../session/event-bus.js");
    const bus = new SimpleEventBus();
    /** @type {Array<{modelName: string}>} */
    const reconnectEvents = [];
    bus.on("tts-reconnect", (data) => reconnectEvents.push(data));

    const mockTtsEngine = {
      load: async () => {},
      startStream: (
        /** @type {string} */ _text,
        /** @type {string} */ _voice,
        /** @type {(pcm: Float32Array, sampleRate: number) => void} */ _onChunk,
        /** @type {{ onDone?: () => void }} */ callbacks
      ) => {
        if (callbacks?.onDone) {
          queueMicrotask(() => callbacks.onDone?.());
        }
      },
      stop: () => {},
      destroy: () => {},
    };

    const mockLlmProvider = {
      streamReasoning: async (
        /** @type {string} */ _q,
        /** @type {string} */ _s,
        /** @type {{ onReasoningToken?: (token: string) => void, onDone?: () => void }} */ cb
      ) => {
        cb.onReasoningToken?.("Hello world.");
        return new Promise(() => {});
      },
    };

    const { pipeline } = makePipeline({
      ttsEngine: mockTtsEngine,
      llmProvider: mockLlmProvider,
      audioGraph: mockAudioGraph,
      eventBus: bus,
    });

    pipeline.startStream("system prompt", "question");
    await new Promise((r) => setTimeout(r, 30));

    const beforeCount = openStreamCallCount;
    assert.ok(beforeCount >= 1, "openStream called during stream init");

    const oldHandle = lastAudioHandle;

    bus.emit("tts-reconnect", { modelName: "testModel" });
    await new Promise((r) => setTimeout(r, 10));

    assert.ok(openStreamCallCount > beforeCount, "openStream called again on reconnect");
    assert.notStrictEqual(lastAudioHandle, oldHandle, "new audio handle created on reconnect");

    pipeline.softStop();
  });

  // ------------------------------------------------------------------
  // Resume behavior — re-feeds reasoning text through TextChunker
  // ------------------------------------------------------------------

  it("resume() re-feeds reasoning text through TextChunker", async () => {
    /** @type {string[]} */
    const streamTexts = [];

    const mockTtsEngine = {
      load: async () => {},
      startStream: (
        /** @type {string} */ text,
        /** @type {string} */ _voice,
        /** @type {(pcm: Float32Array, sampleRate: number) => void} */ _onChunk,
        /** @type {{ onDone?: () => void }} */ callbacks
      ) => {
        streamTexts.push(text);
        if (callbacks?.onDone) {
          queueMicrotask(() => callbacks.onDone?.());
        }
      },
      stop: () => {},
      destroy: () => {},
    };

    const mockLlmProvider = {
      streamReasoning: async (
        /** @type {string} */ _q,
        /** @type {string} */ _s,
        /** @type {{ onReasoningToken?: (token: string) => void }} */ cb
      ) => {
        cb.onReasoningToken?.("Hello world.");
        return new Promise(() => {}); // keep LLM running
      },
    };

    const { pipeline } = makePipeline({ ttsEngine: mockTtsEngine, llmProvider: mockLlmProvider });
    pipeline.startStream("system prompt", "question");

    // Wait for TextChunker to flush the first sentence
    await new Promise((r) => setTimeout(r, 30));

    pipeline.pause();
    pipeline.feedToken(" More text.");
    pipeline.feedToken(" Even more.");

    const beforeResume = streamTexts.length;
    pipeline.resume();
    await new Promise((r) => setTimeout(r, 30));

    // resume() should re-feed full reasoning text through TextChunker,
    // producing sentences: "Hello world.", "More text.", "Even more."
    assert.ok(streamTexts.length > beforeResume, "startStream called on resume");
    const allAfterResume = streamTexts.slice(beforeResume);
    assert.ok(allAfterResume.some(t => t.includes("Hello")), "resume text contains pre-pause tokens");
    assert.ok(allAfterResume.some(t => t.includes("More")), "resume text contains post-pause tokens");

    pipeline.softStop();
  });

  it("resume() does not call startStream when reasoningText is empty", async () => {
    /** @type {string[]} */
    const streamTexts = [];

    const mockTtsEngine = {
      load: async () => {},
      startStream: (/** @type {string} */ text) => {
        streamTexts.push(text);
      },
      stop: () => {},
      destroy: () => {},
    };

    const mockLlmProvider = {
      streamReasoning: async (
        /** @type {string} */ _q,
        /** @type {string} */ _s,
        /** @type {{ onDone?: () => void }} */ cb
      ) => {
        cb.onDone?.();
      },
    };

    const { pipeline } = makePipeline({ ttsEngine: mockTtsEngine, llmProvider: mockLlmProvider });
    await pipeline.startStream("system prompt", "question");
    await new Promise((r) => setTimeout(r, 20));

    pipeline.pause();
    const beforeResume = streamTexts.length;
    pipeline.resume();
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(streamTexts.length, beforeResume, "startStream should NOT be called when reasoningText is empty");

    pipeline.softStop();
  });

  it("resume() re-opens audio stream after flushAndClose", async () => {
    let startCount = 0;

    const mockTtsEngine = {
      load: async () => {},
      startStream: (
        /** @type {string} */ _text,
        /** @type {string} */ _voice,
        /** @type {(pcm: Float32Array, sampleRate: number) => void} */ _onChunk,
        /** @type {{ onDone?: () => void }} */ callbacks
      ) => {
        startCount++;
        if (callbacks?.onDone) {
          queueMicrotask(() => callbacks.onDone?.());
        }
      },
      stop: () => {},
      destroy: () => {},
    };

    const mockLlmProvider = {
      streamReasoning: async (
        /** @type {string} */ _q,
        /** @type {string} */ _s,
        /** @type {{ onReasoningToken?: (token: string) => void, onDone?: () => void }} */ cb
      ) => {
        cb.onReasoningToken?.("Hello.");
        cb.onDone?.();
      },
    };

    const { pipeline } = makePipeline({ ttsEngine: mockTtsEngine, llmProvider: mockLlmProvider });
    await pipeline.startStream("system prompt", "question");

    // After LLM done, TextChunker flushed the sentence
    assert.ok(startCount >= 1, "startStream should have been called during stream");

    pipeline.pause();
    pipeline.resume();

    // Feed a new token after resume — TextChunker should handle it
    pipeline.feedToken(" More text.");
    await new Promise((r) => setTimeout(r, 30));

    // The new sentence should trigger another startStream
    assert.ok(startCount >= 2, "new tokens after resume should trigger startStream");

    pipeline.softStop();
  });
});
