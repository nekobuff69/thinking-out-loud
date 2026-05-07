import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

describe("ChannelPipeline", () => {
  /** @type {string[]} */
  let setErrorCalls;

  /**
   * @returns {{
   *   pipeline: import("../session/channel-pipeline.js").ChannelPipeline,
   *   setErrorCalls: string[]
   * }}
   */
  async function makePipeline() {
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

    // Mock streamReasoning to call onDone immediately with zero reasoning tokens
    mock.module("../llm/llm-stream.js", {
      namedExports: {
        streamReasoning: async (
          /** @type {string} */ url,
          /** @type {string} */ model,
          /** @type {string} */ systemPrompt,
          /** @type {string} */ question,
          /** @type {{ onReasoningToken?: (token: string) => void, onContentStart?: () => void, onDone?: () => void }} */ callbacks
        ) => {
          // Simulate: stream ends without any reasoning tokens
          callbacks.onDone?.();
        },
      },
    });

    const { ChannelPipeline } = await import("../session/channel-pipeline.js");

    const pipeline = new ChannelPipeline({
      model: { name: "testModel", url: "http://localhost", model: "test", voice: "af", color: "#fff", pan: 0, provider: "test" },
      ttsConfig: { maxTokens: 200, sentenceTimeoutTokens: 30 },
      column: mockColumn,
      ttsEngine: mockTtsEngine,
      audioGraph: mockAudioGraph,
    });

    pipeline.createChannel();

    return { pipeline, setErrorCalls };
  }

  it("shows error when LLM stream produces zero reasoning tokens", async () => {
    const { pipeline, setErrorCalls } = await makePipeline();

    // Start the stream — the mock fires onDone immediately with zero tokens
    await pipeline.startStream("system prompt", "question");

    // Column should have received an error about no reasoning
    assert.ok(setErrorCalls.length > 0, "expected setError to be called");
    assert.match(setErrorCalls[0], /reasoning/i, "error message should mention reasoning");
  });
});
