import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ChannelPipeline } from "../session/channel-pipeline.js";

/**
 * Build a pipeline whose audio playhead is a plain counter we can move at
 * will. This makes it possible to assert that karaoke timing follows the
 * audio clock rather than elapsed wall-clock time.
 */
function makePipeline({
  tokens = ["Hello world."],
  scheduledTime = 0,
  currentTime = 0,
  completeGeneration = true,
  captureDone,
} = {}) {
  /** @type {Array<{start: number, count: number, timing: Function}>} */
  const startCalls = [];
  let playedSamples = 0;
  const ctx = { currentTime };

  const column = {
    appendToken() {},
    clear() {},
    setError() {},
    attachWaveform() {},
    stopWaveform() {},
    finalizeWord() {},
    startKaraoke(start, count, timing) {
      startCalls.push({ start, count, timing });
    },
    stopKaraoke() {},
  };

  const audioGraph = {
    createChannel() {
      return {
        analyser: {},
        ctx,
        gain: { gain: { value: 1, setTargetAtTime() {} } },
        openStream() {
          return {
            feed() {
              return { scheduledTime };
            },
            getPlaybackPosition() {
              return { samples: playedSamples, sampleRate: 24000 };
            },
            end() {},
            stop() {},
          };
        },
        play() {},
        playStream() {
          return { stop() {} };
        },
        stopAll() {},
      };
    },
  };

  const ttsEngine = {
    load: async () => {},
    stop() {},
    destroy() {},
    startStream(_text, _voice, onChunk, callbacks) {
      // One second of audio for every sentence.
      onChunk(new Float32Array(24000), 24000);
      if (completeGeneration) callbacks.onDone?.();
      else captureDone?.(() => callbacks.onDone?.());
    },
  };

  const llmProvider = {
    streamReasoning: async (_q, _s, cb) => {
      for (const token of tokens) cb.onReasoningToken?.(token);
      cb.onDone?.();
    },
  };

  const pipeline = new ChannelPipeline({
    model: {
      name: "test",
      url: "http://localhost",
      model: "test",
      voice: "alba",
      color: "#fff",
      pan: 0,
      provider: "test",
    },
    ttsConfig: { maxTokens: 200, sentenceTimeoutTokens: 30 },
    column,
    ttsEngine,
    llmProvider,
    audioGraph,
  });
  pipeline.createChannel();

  return {
    pipeline,
    ctx,
    startCalls,
    setPlayedSamples(value) {
      playedSamples = value;
    },
  };
}

describe("ChannelPipeline karaoke timing", () => {
  it("derives progress from played audio samples once generation completes", async () => {
    const h = makePipeline();
    await h.pipeline.startStream("system", "question");

    assert.equal(h.startCalls.length, 1);
    const timing = h.startCalls[0].timing;

    h.setPlayedSamples(0);
    assert.equal(timing().progress, 0);

    h.setPlayedSamples(12000);
    const half = timing();
    assert.equal(half.progress, 0.5);
    assert.equal(half.final, true, "onDone marks the exact duration available");

    h.setPlayedSamples(24000);
    assert.equal(timing().progress, 1);
  });

  it("reports negative progress until the scheduled audio actually starts", async () => {
    // Audio scheduled 5 s in the future while the context clock is at 0.
    const h = makePipeline({ scheduledTime: 5, currentTime: 0 });
    await h.pipeline.startStream("system", "question");

    const timing = h.startCalls[0].timing;
    assert.equal(timing().progress, -1);
  });

  it("uses shared CJK segmentation for word counts and start indices", async () => {
    const h = makePipeline({ tokens: ["你好。", "世界。"] });
    await h.pipeline.startStream("system", "question");

    // "你好。" -> ["你", "好。"] (2 words), then "世界。" -> (2 words).
    assert.deepEqual(
      h.startCalls.map(({ start, count }) => [start, count]),
      [
        [0, 2],
        [2, 2],
      ],
    );
  });

  it("hands off from estimate to exact duration without snapping", async () => {
    /** @type {(() => void) | undefined} */
    let finish;
    const h = makePipeline({
      completeGeneration: false,
      captureDone: (fn) => {
        finish = fn;
      },
    });
    await h.pipeline.startStream("system", "question");

    const timing = h.startCalls[0].timing;
    h.setPlayedSamples(4800);
    const before = timing().progress;

    finish?.();
    const after = timing();
    assert.ok(Math.abs(after.progress - before) < 0.01, "progress must stay continuous");
    assert.equal(after.final, true);

    h.setPlayedSamples(24000);
    assert.equal(timing().progress, 1, "reaches 1 exactly at audio end");
  });

  it("keeps final false while generation is open so karaoke cannot end early", async () => {
    // TTS response is still streaming: the exact sample count is unknown.
    const h = makePipeline({ completeGeneration: false });
    await h.pipeline.startStream("system", "question");

    const timing = h.startCalls[0].timing;
    h.setPlayedSamples(24000);
    const value = timing();

    assert.equal(value.final, false);
    assert.ok(value.progress <= 1, "progress must stay bounded before onDone");
  });
});
