import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ChannelPipeline } from "../session/channel-pipeline.js";

describe("ChannelPipeline", () => {
  /** @type {string[]} */
  let setErrorCalls;

  /**
   * @returns {{
   *   pipeline: ChannelPipeline,
   *   setErrorCalls: string[]
   * }}
   */
  function makePipeline() {
    setErrorCalls = [];

    const mockColumn = {
      appendToken: () => {},
      clear: () => {},
      setError: (/** @type {string} */ msg) => { setErrorCalls.push(msg); },
      attachWaveform: () => {},
      stopWaveform: () => {},
    };

    const mockAudioGraph = {
      createChannel: () => ({
        analyser: {},
        play: () => ({}),
        gain: { gain: { value: 1, setTargetAtTime: () => {} } },
        stopAll: () => {},
        playStream: (/** @type {(onChunk: (pcm: Float32Array, sampleRate: number) => void) => (() => void)} */ streamFn) => {
          // Call streamFn immediately with a no-op onChunk, return cleanup handle
          const cleanup = streamFn(() => {});
          return { stop: () => { if (cleanup) cleanup(); } };
        },
      }),
    };

    const mockTtsEngine = {
      load: async () => {},
      startStream: (
        /** @type {string} */ _text,
        /** @type {string} */ _voice,
        /** @type {(pcm: Float32Array, sampleRate: number) => void} */ _onAudioChunk,
        /** @type {{ onDone?: () => void, onError?: (message: string) => void }} */ callbacks
      ) => {
        // Immediately signal done (simulating instant TTS generation)
        if (callbacks?.onDone) {
          queueMicrotask(() => callbacks.onDone?.());
        }
      },
      stop: () => {},
    };

    const mockLlmProvider = {
      streamReasoning: async (
        /** @type {string} */ _question,
        /** @type {string} */ _systemPrompt,
        /** @type {{ onReasoningToken?: (token: string) => void, onContentStart?: () => void, onDone?: () => void }} */ callbacks
      ) => {
        // Simulate: stream ends without any reasoning tokens
        callbacks.onDone?.();
      },
    };

    const pipeline = new ChannelPipeline({
      model: { name: "testModel", url: "http://localhost", model: "test", voice: "alba", color: "#fff", pan: 0, provider: "test" },
      ttsConfig: { maxTokens: 200, sentenceTimeoutTokens: 30 },
      column: mockColumn,
      ttsEngine: mockTtsEngine,
      llmProvider: mockLlmProvider,
      audioGraph: mockAudioGraph,
    });

    pipeline.createChannel();

    return { pipeline, setErrorCalls };
  }

  it("shows error when LLM stream produces zero reasoning tokens", async () => {
    const { pipeline, setErrorCalls } = makePipeline();

    // Start the stream — the mock fires onDone immediately with zero tokens
    await pipeline.startStream("system prompt", "question");

    // Column should have received an error about no reasoning
    assert.ok(setErrorCalls.length > 0, "expected setError to be called");
    assert.match(setErrorCalls[0], /reasoning/i, "error message should mention reasoning");
  });

  it("pipes tokens to TTS backend when reasoning arrives", async () => {
    const setErrorCallsLocal = [];
    /** @type {string[]} */
    const ttsTexts = [];

    const mockColumn = {
      appendToken: () => {},
      clear: () => {},
      setError: (/** @type {string} */ msg) => { setErrorCallsLocal.push(msg); },
      attachWaveform: () => {},
      stopWaveform: () => {},
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
      }),
    };

    const mockTtsEngine = {
      load: async () => {},
      startStream: (
        /** @type {string} */ text,
        /** @type {string} */ _voice,
        /** @type {(pcm: Float32Array, sampleRate: number) => void} */ _onAudioChunk,
        /** @type {{ onDone?: () => void, onError?: (message: string) => void }} */ _callbacks
      ) => {
        ttsTexts.push(text);
      },
      stop: () => {},
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

    const pipeline = new ChannelPipeline({
      model: { name: "testModel", url: "http://localhost", model: "test", voice: "alba", color: "#fff", pan: 0, provider: "test" },
      ttsConfig: { maxTokens: 200, sentenceTimeoutTokens: 30 },
      column: mockColumn,
      ttsEngine: mockTtsEngine,
      llmProvider: mockLlmProvider,
      audioGraph: mockAudioGraph,
    });

    pipeline.createChannel();
    await pipeline.startStream("system prompt", "question");

    // Tokens should have been forwarded to TTS (at least the first batch)
    assert.ok(ttsTexts.length > 0, "expected TTS to receive text");
  });

  it("stops TTS on softStop", async () => {
    let ttsStopped = false;
    let audioStopped = false;

    const mockColumn = {
      appendToken: () => {},
      clear: () => {},
      setError: () => {},
      attachWaveform: () => {},
      stopWaveform: () => {},
    };

    const mockAudioGraph = {
      createChannel: () => ({
        analyser: {},
        play: () => ({}),
        gain: { gain: { value: 1, setTargetAtTime: () => {} } },
        stopAll: () => {},
        playStream: () => ({ stop: () => { audioStopped = true; } }),
      }),
    };

    const mockTtsEngine = {
      load: async () => {},
      startStream: () => {},
      stop: () => { ttsStopped = true; },
    };

    const mockLlmProvider = {
      streamReasoning: async (
        /** @type {string} */ _question,
        /** @type {string} */ _systemPrompt,
        /** @type {{ onReasoningToken?: (token: string) => void, onContentStart?: () => void, onDone?: () => void }} */ callbacks
      ) => {
        // Send enough tokens to trigger TTS flush (>15 chars for first batch)
        callbacks.onReasoningToken?.("Hello");
        callbacks.onReasoningToken?.(" there");
        callbacks.onReasoningToken?.(" world");
        // Don't fire onDone — keep stream active
        return new Promise(() => {}); // never resolves
      },
    };

    const pipeline = new ChannelPipeline({
      model: { name: "testModel", url: "http://localhost", model: "test", voice: "alba", color: "#fff", pan: 0, provider: "test" },
      ttsConfig: { maxTokens: 200, sentenceTimeoutTokens: 30 },
      column: mockColumn,
      ttsEngine: mockTtsEngine,
      llmProvider: mockLlmProvider,
      audioGraph: mockAudioGraph,
    });

    pipeline.createChannel();
    const startPromise = pipeline.startStream("system prompt", "question");

    // Wait for first token to flush to TTS
    await new Promise((r) => setTimeout(r, 50));

    pipeline.softStop();

    assert.strictEqual(ttsStopped, true, "TTS should be stopped");
    assert.strictEqual(audioStopped, true, "audio should be stopped");
  });

  it("accumulates reasoning text for storage", async () => {
    const mockColumn = {
      appendToken: () => {},
      clear: () => {},
      setError: () => {},
      attachWaveform: () => {},
      stopWaveform: () => {},
    };

    const mockAudioGraph = {
      createChannel: () => ({
        analyser: {},
        play: () => ({}),
        gain: { gain: { value: 1, setTargetAtTime: () => {} } },
        stopAll: () => {},
        playStream: () => ({ stop: () => {} }),
      }),
    };

    const mockTtsEngine = {
      load: async () => {},
      startStream: () => {},
      stop: () => {},
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

    const pipeline = new ChannelPipeline({
      model: { name: "testModel", url: "http://localhost", model: "test", voice: "alba", color: "#fff", pan: 0, provider: "test" },
      ttsConfig: { maxTokens: 200, sentenceTimeoutTokens: 30 },
      column: mockColumn,
      ttsEngine: mockTtsEngine,
      llmProvider: mockLlmProvider,
      audioGraph: mockAudioGraph,
    });

    pipeline.createChannel();
    await pipeline.startStream("system prompt", "question");

    assert.strictEqual(pipeline.reasoningText, "I think therefore I am.");
  });

  it("replay drainText feeds text through TTS", async () => {
    const ttsTexts = [];
    const mockColumn = {
      appendToken: () => {},
      clear: () => {},
      setError: () => {},
      attachWaveform: () => {},
      stopWaveform: () => {},
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
      }),
    };

    const mockTtsEngine = {
      load: async () => {},
      startStream: (/** @type {string} */ text) => {
        ttsTexts.push(text);
      },
      stop: () => {},
    };

    const pipeline = new ChannelPipeline({
      model: { name: "testModel", url: "http://localhost", model: "test", voice: "alba", color: "#fff", pan: 0, provider: "test" },
      ttsConfig: { maxTokens: 200, sentenceTimeoutTokens: 30 },
      column: mockColumn,
      ttsEngine: mockTtsEngine,
      llmProvider: /** @type {any} */ (null),
      audioGraph: mockAudioGraph,
    });

    pipeline.createChannel();
    await pipeline.drainText("Replayed reasoning text.");

    assert.ok(ttsTexts.length > 0, "drainText should feed text to TTS");
    assert.strictEqual(pipeline.reasoningText, "Replayed reasoning text.");
  });
});
