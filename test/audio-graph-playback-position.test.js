import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { AudioGraph } from "../audio/audio-graph.js";

/**
 * AudioContext mock with a controllable clock, so playback position can be
 * advanced deterministically without real time passing.
 */
function createClock() {
  const state = { currentTime: 0 };
  const ctx = {
    state: "running",
    sampleRate: 24000,
    destination: {},
    get currentTime() {
      return state.currentTime;
    },
    resume() {
      this.state = "running";
      return Promise.resolve();
    },
    close() {
      return Promise.resolve();
    },
    createBuffer(_channels, length, sampleRate) {
      const data = new Float32Array(length);
      return {
        duration: length / sampleRate,
        getChannelData() {
          return data;
        },
      };
    },
    createBufferSource() {
      return {
        buffer: null,
        onended: null,
        start() {},
        stop() {},
        connect(node) {
          return node;
        },
        disconnect() {},
      };
    },
    createGain() {
      return {
        gain: { value: 1, setTargetAtTime() {} },
        connect(node) {
          return node;
        },
        disconnect() {},
      };
    },
    createStereoPanner() {
      return {
        pan: { value: 0 },
        connect(node) {
          return node;
        },
        disconnect() {},
      };
    },
    createAnalyser() {
      return {
        fftSize: 256,
        connect(node) {
          return node;
        },
        disconnect() {},
        getFloatTimeDomainData(array) {
          array.fill(0);
        },
      };
    },
  };
  return { state, ctx };
}

describe("openStream().getPlaybackPosition()", () => {
  /** @type {typeof globalThis.AudioContext | undefined} */
  let originalAudioContext;
  /** @type {ReturnType<typeof createClock> | null} */
  let clock = null;

  beforeEach(() => {
    clock = createClock();
    originalAudioContext = globalThis.AudioContext;
    // @ts-ignore minimal mock
    globalThis.AudioContext = class {
      state = "running";
      get currentTime() {
        return clock.ctx.currentTime;
      }
      sampleRate = 24000;
      createBuffer = clock.ctx.createBuffer.bind(clock.ctx);
      createBufferSource = clock.ctx.createBufferSource.bind(clock.ctx);
      createGain = clock.ctx.createGain.bind(clock.ctx);
      createStereoPanner = clock.ctx.createStereoPanner.bind(clock.ctx);
      createAnalyser = clock.ctx.createAnalyser.bind(clock.ctx);
      destination = clock.ctx.destination;
      resume() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
    };
  });

  afterEach(() => {
    if (originalAudioContext) {
      // @ts-ignore restore
      globalThis.AudioContext = originalAudioContext;
    }
  });

  it("advances only with the audio clock, not wall-clock time", () => {
    const graph = new AudioGraph();
    const channel = graph.createChannel(0);
    const stream = channel.openStream();

    // One second of audio at 24 kHz, scheduled at t=0.
    stream.feed(new Float32Array(24000), 24000);
    assert.equal(stream.getPlaybackPosition().samples, 0);

    clock.state.currentTime = 0.5;
    assert.equal(stream.getPlaybackPosition().samples, 12000);

    clock.state.currentTime = 1;
    assert.equal(stream.getPlaybackPosition().samples, 24000);
  });

  it("does not count a scheduling gap as played audio", () => {
    const graph = new AudioGraph();
    const channel = graph.createChannel(0);
    const stream = channel.openStream();

    stream.feed(new Float32Array(24000), 24000); // 0s..1s
    clock.state.currentTime = 2; // underrun: 1s with nothing scheduled
    assert.equal(
      stream.getPlaybackPosition().samples,
      24000,
      "gap must not advance the playhead past audible audio",
    );

    // The next buffer is scheduled at max(nextStartTime=1s, now=2s) = 2s.
    stream.feed(new Float32Array(24000), 24000);
    clock.state.currentTime = 2.5;
    assert.equal(stream.getPlaybackPosition().samples, 36000);
  });

  it("clamps at the total scheduled samples once audio has ended", () => {
    const graph = new AudioGraph();
    const channel = graph.createChannel(0);
    const stream = channel.openStream();

    stream.feed(new Float32Array(1000), 24000);
    clock.state.currentTime = 10;
    assert.equal(stream.getPlaybackPosition().samples, 1000);
  });

  it("reports zero before the first buffer is scheduled", () => {
    const graph = new AudioGraph();
    const channel = graph.createChannel(0);
    const stream = channel.openStream();

    assert.deepEqual(stream.getPlaybackPosition(), {
      samples: 0,
      sampleRate: 24000,
    });
  });
});
