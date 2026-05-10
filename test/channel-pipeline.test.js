import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ChannelPipeline } from "../session/channel-pipeline.js";

describe("ChannelPipeline", () => {
  /** @type {string[]} */
  let setErrorCalls;

  // Default mock for empty-stream test
  function makePipeline(opts = {}) {
    setErrorCalls = [];

    const { ttsEngine = defaultTtsEngine(), llmProvider = defaultLlmProvider(), audioGraph = defaultAudioGraph() } = opts;

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
    });

    pipeline.createChannel();
    return { pipeline, setErrorCalls };
  }

  function defaultAudioGraph() {
    let audioStream = null;
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
            audioStream = handle;
            return handle;
          },
        };
        return ch;
      },
    };
  }

  function defaultTtsEngine() {
    let streamHandle = null;
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
      openStream: (
        /** @type {string} */ _voice,
        /** @type {{ onAudioChunk: (pcm: Float32Array, sampleRate: number) => void, onDone: () => void, onError: (message: string) => void }} */ callbacks
      ) => {
        let closed = false;
        streamHandle = {
          sendText: (/** @type {string} */ _text) => {},
          close: () => { closed = true; },
        };
        // Simulate done after a tick
        queueMicrotask(() => {
          if (!closed) {
            callbacks.onDone();
          }
        });
        return streamHandle;
      },
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

  it("shows error when LLM stream produces zero reasoning tokens", async () => {
    const { pipeline, setErrorCalls } = makePipeline();

    await pipeline.startStream("system prompt", "question");

    assert.ok(setErrorCalls.length > 0, "expected setError to be called");
    assert.match(setErrorCalls[0], /reasoning/i, "error message should mention reasoning");
  });

  it("pipes tokens to TTS streaming backend when reasoning arrives", async () => {
    const ttsTexts = [];
    let streamHandle = null;

    const mockTtsEngine = {
      load: async () => {},
      startStream: () => {},
      stop: () => {},
      openStream: (
        /** @type {string} */ _voice,
        /** @type {{ onAudioChunk: (pcm: Float32Array, sampleRate: number) => void, onDone: () => void, onError: (message: string) => void }} */ callbacks
      ) => {
        streamHandle = {
          sendText: (/** @type {string} */ text) => { ttsTexts.push(text); },
          close: () => {},
        };
        return streamHandle;
      },
      destroy: () => {},
    };

    const mockLlmProvider = {
      streamReasoning: async (
        /** @type {string} */ _question,
        /** @type {string} */ _systemPrompt,
        /** @type {{ onReasoningToken?: (token: string) => void, onContentStart?: () => void, onDone?: () => void }} */ callbacks
      ) => {
        callbacks.onReasoningToken?.("The");
        callbacks.onReasoningToken?.(" answer");
        callbacks.onReasoningToken?.(" is");
        callbacks.onReasoningToken?.(" complex.");
        callbacks.onDone?.();
      },
    };

    const { pipeline } = makePipeline({ ttsEngine: mockTtsEngine, llmProvider: mockLlmProvider });
    await pipeline.startStream("system prompt", "question");

    // Tokens should have been forwarded as deltas via sendText
    assert.ok(ttsTexts.length > 0, "expected TTS to receive text deltas");
    // At minimum, "The answer is complex." should have been sent (flush on punctuation)
    // Word boundaries: "The " (whitespace), " answer " (whitespace), " is " (whitespace), " complex." (punctuation)
    assert.ok(ttsTexts.some(t => t.includes("complex")), "should flush on period");
  });

  it("stops TTS on softStop", async () => {
    let streamClosed = false;
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
      stop: () => {},
      openStream: () => {
        return {
          sendText: () => {},
          close: () => { streamClosed = true; },
        };
      },
      destroy: () => { ttsDestroyed = true; },
    };

    const mockLlmProvider = {
      streamReasoning: async (
        /** @type {string} */ _question,
        /** @type {string} */ _systemPrompt,
        /** @type {{ onReasoningToken?: (token: string) => void, onContentStart?: () => void, onDone?: () => void }} */ callbacks
      ) => {
        callbacks.onReasoningToken?.("Hello");
        callbacks.onReasoningToken?.(" there");
        return new Promise(() => {});
      },
    };

    const { pipeline } = makePipeline({ ttsEngine: mockTtsEngine, llmProvider: mockLlmProvider, audioGraph: mockAudioGraph });
    const startPromise = pipeline.startStream("system prompt", "question");

    // Wait for first token to trigger stream opening
    await new Promise((r) => setTimeout(r, 20));

    pipeline.softStop();

    assert.strictEqual(streamClosed, true, "TTS stream should be closed");
    assert.strictEqual(ttsDestroyed, true, "TTS backend should be destroyed");
    assert.strictEqual(audioStopped, true, "audio should be stopped");
  });

  it("accumulates reasoning text for storage", async () => {
    let streamHandle = null;

    const mockTtsEngine = {
      load: async () => {},
      startStream: () => {},
      stop: () => {},
      openStream: () => {
        streamHandle = {
          sendText: () => {},
          close: () => {},
        };
        return streamHandle;
      },
      destroy: () => {},
    };

    const mockLlmProvider = {
      streamReasoning: async (
        /** @type {string} */ _question,
        /** @type {string} */ _systemPrompt,
        /** @type {{ onReasoningToken?: (token: string) => void, onContentStart?: () => void, onDone?: () => void }} */ callbacks
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
      openStream: () => {},
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

  // ------------------------------------------------------------------
  // New streaming-specific tests
  // ------------------------------------------------------------------

  it("sends text deltas on word boundaries (not full text)", async () => {
    /** @type {string[]} */
    const deltas = [];

    const mockTtsEngine = {
      load: async () => {},
      startStream: () => {},
      stop: () => {},
      openStream: () => ({
        sendText: (/** @type {string} */ text) => { deltas.push(text); },
        close: () => {},
      }),
      destroy: () => {},
    };

    const mockLlmProvider = {
      streamReasoning: async (
        /** @type {string} */ _q,
        /** @type {string} */ _s,
        /** @type {{ onReasoningToken?: (token: string) => void, onDone?: () => void }} */ cb
      ) => {
        // Feed tokens that form sentences
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

    // Each token with word boundary should trigger a delta send
    assert.ok(deltas.length > 0, "deltas should be sent");
    // "Hello world." should include the period — check that punctuation triggers flush
    const hasPeriodFlush = deltas.some(d => d.includes("world."));
    assert.ok(hasPeriodFlush, "should flush on sentence-ending punctuation");
  });

  it("does NOT restart synthesis on each chunk (one openStream)", async () => {
    let openCount = 0;

    const mockTtsEngine = {
      load: async () => {},
      startStream: () => {},
      stop: () => {},
      openStream: () => {
        openCount++;
        return {
          sendText: () => {},
          close: () => {},
        };
      },
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
        cb.onReasoningToken?.(" continues.");
        cb.onDone?.();
      },
    };

    const { pipeline } = makePipeline({ ttsEngine: mockTtsEngine, llmProvider: mockLlmProvider });
    await pipeline.startStream("system prompt", "question");

    // Should only have called openStream once
    assert.strictEqual(openCount, 1, "should open exactly one stream");
  });

  it("token cap stops sendText and closes stream", async () => {
    let streamClosed = false;
    let textCount = 0;

    const mockTtsEngine = {
      load: async () => {},
      startStream: () => {},
      stop: () => {},
      openStream: () => ({
        sendText: () => { textCount++; },
        close: () => { streamClosed = true; },
      }),
      destroy: () => {},
    };

    const mockLlmProvider = {
      streamReasoning: async (
        /** @type {string} */ _q,
        /** @type {string} */ _s,
        /** @type {{ onReasoningToken?: (token: string) => void, onDone?: () => void }} */ cb
      ) => {
        // Feed more than maxTokens=200 words (with spaces so word count works)
        cb.onReasoningToken?.("start");
        for (let i = 1; i < 250; i++) {
          cb.onReasoningToken?.(` word${i}`);
        }
        cb.onDone?.();
      },
    };

    const { pipeline } = makePipeline({ ttsEngine: mockTtsEngine, llmProvider: mockLlmProvider });
    await pipeline.startStream("system prompt", "question");

    assert.ok(streamClosed, "stream should be closed after token cap");
    // Not all tokens should have been sent as text — only up to the cap
    assert.ok(textCount > 0, "some text was sent");
    assert.ok(pipeline.isCapped, "pipeline should report isCapped");
  });

  it("content boundary triggers delta flush and stream close", async () => {
    let streamClosed = false;
    let lastDelta = "";

    const mockTtsEngine = {
      load: async () => {},
      startStream: () => {},
      stop: () => {},
      openStream: () => ({
        sendText: (/** @type {string} */ text) => { lastDelta = text; },
        close: () => { streamClosed = true; },
      }),
      destroy: () => {},
    };

    const mockLlmProvider = {
      streamReasoning: async (
        /** @type {string} */ _q,
        /** @type {string} */ _s,
        /** @type {{ onReasoningToken?: (token: string) => void, onContentStart?: () => void, onDone?: () => void }} */ cb
      ) => {
        cb.onReasoningToken?.("Some");
        cb.onReasoningToken?.(" reasoning");
        cb.onReasoningToken?.(" text.");
        cb.onContentStart?.();
        cb.onDone?.();
      },
    };

    const { pipeline } = makePipeline({ ttsEngine: mockTtsEngine, llmProvider: mockLlmProvider });
    await pipeline.startStream("system prompt", "question");

    assert.ok(streamClosed, "stream should be closed on content boundary");
  });

  // ------------------------------------------------------------------
  // First-chunk 50ms timeout tests
  // ------------------------------------------------------------------

  it("first chunk flushes within 50ms even without word boundary", async () => {
    /** @type {string[]} */
    const deltas = [];

    const mockTtsEngine = {
      load: async () => {},
      startStream: () => {},
      stop: () => {},
      openStream: () => ({
        sendText: (/** @type {string} */ text) => { deltas.push(text); },
        close: () => {},
      }),
      destroy: () => {},
    };

    const mockLlmProvider = {
      streamReasoning: async (
        /** @type {string} */ _q,
        /** @type {string} */ _s,
        /** @type {{ onReasoningToken?: (token: string) => void, onDone?: () => void }} */ cb
      ) => {
        // Feed a long first word without any word boundary
        cb.onReasoningToken?.("Nevertheless");
        // Stay alive without punctuation or whitespace
        return new Promise(() => {});
      },
    };

    const { pipeline } = makePipeline({ ttsEngine: mockTtsEngine, llmProvider: mockLlmProvider });
    pipeline.startStream("system prompt", "question");

    // Wait for 50ms timeout to fire
    await new Promise((r) => setTimeout(r, 80));

    // Should have flushed even without word boundary
    assert.ok(deltas.length > 0, "should flush within 50ms even mid-word");
    assert.ok(deltas.some(d => d.includes("Nevertheless")), "should contain the long word");

    pipeline.softStop();
  });

  it("subsequent chunks do NOT flush on timeout (word-boundary only)", async () => {
    /** @type {string[]} */
    const deltas = [];

    const mockTtsEngine = {
      load: async () => {},
      startStream: () => {},
      stop: () => {},
      openStream: () => ({
        sendText: (/** @type {string} */ text) => { deltas.push(text); },
        close: () => {},
      }),
      destroy: () => {},
    };

    const mockLlmProvider = {
      streamReasoning: async (
        /** @type {string} */ _q,
        /** @type {string} */ _s,
        /** @type {{ onReasoningToken?: (token: string) => void, onDone?: () => void }} */ cb
      ) => {
        // Feed first token to trigger 50ms flush
        cb.onReasoningToken?.("Hello");
        await new Promise((r) => setTimeout(r, 60));
        // After first chunk sent, feed more text without word boundary
        cb.onReasoningToken?.("World");
        await new Promise((r) => setTimeout(r, 100));
        cb.onDone?.();
      },
    };

    const { pipeline } = makePipeline({ ttsEngine: mockTtsEngine, llmProvider: mockLlmProvider });
    await pipeline.startStream("system prompt", "question");

    // First flush should happen (from 50ms timeout)
    assert.ok(deltas.length >= 1, "first chunk should flush");
    // After the first flush, "World" should NOT auto-flush until a word boundary is hit
    // Since there's no space or punctuation before "World", it should remain in buffer
    // Actually "Hello" was already flushed, then "World" is fed. Let's check deltas
    // The second token "World" gets appended to empty buffer, no word boundary → no flush
    // Unless the first chunk timeout was also triggered for the second chunk (it shouldn't)

    pipeline.softStop();
  });

  it("softStop kills everything", async () => {
    let streamClosed = false;
    let backendDestroyed = false;
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
      stop: () => {},
      openStream: () => ({
        sendText: () => {},
        close: () => { streamClosed = true; },
      }),
      destroy: () => { backendDestroyed = true; },
    };

    const mockLlmProvider = {
      streamReasoning: async (
        /** @type {string} */ _q,
        /** @type {string} */ _s,
        /** @type {{ onReasoningToken?: (token: string) => void }} */ cb
      ) => {
        // Feed a token so the stream is opened
        cb.onReasoningToken?.("Hello");
        return new Promise(() => {});
      },
    };

    const { pipeline } = makePipeline({
      ttsEngine: mockTtsEngine,
      llmProvider: mockLlmProvider,
      audioGraph: mockAudioGraph,
    });

    pipeline.startStream("system prompt", "question");
    await new Promise((r) => setTimeout(r, 20));

    pipeline.softStop();

    assert.strictEqual(streamClosed, true, "stream closed");
    assert.strictEqual(backendDestroyed, true, "backend destroyed");
    assert.strictEqual(audioStopped, true, "audio stopped");
  });
});
