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
      }),
    };

    const mockTtsEngine = {
      load: async () => {},
      synthesize: async (/** @type {string} */ text, /** @type {string} */ voice) => {
        return {};
      },
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
      model: { name: "testModel", url: "http://localhost", model: "test", voice: "af", color: "#fff", pan: 0, provider: "test" },
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
});
