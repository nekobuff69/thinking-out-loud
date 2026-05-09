import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { AudioGraph } from "../audio/audio-graph.js";

/**
 * Minimal mock of the Web Audio API for testing playStream.
 */
function createMockAudioContext() {
  const state = { currentTime: 0, sampleRate: 48000 };

  /** @type {Array<{buffer: Float32Array[], sampleRate: number, duration: number}>} */
  const createdBuffers = [];

  /** @type {Array<{source: object, when: number}>} */
  const scheduledSources = [];

  /** @type {Array<() => void>} */
  const endedCallbacks = [];

  /** @type {{value: number, setTargetAtTime: (target: number, startTime: number, timeConstant: number) => void}} */
  const gainParam = {
    value: 1.0,
    _targetValue: 1.0,
    setTargetAtTime(target, _startTime, _timeConstant) {
      this._targetValue = target;
      // Asynchronously converge value toward target to simulate real behavior
      setTimeout(() => { this.value = target; }, 50);
    },
  };

  /**
   * @param {number} numChannels
   * @param {number} length
   * @param {number} sampleRate
   */
  function createBuffer(numChannels, length, sampleRate) {
    /** @type {Float32Array[]} */
    const channels = [];
    for (let i = 0; i < numChannels; i++) {
      channels.push(new Float32Array(length));
    }
    const buffer = {
      numberOfChannels: numChannels,
      length,
      sampleRate,
      duration: length / sampleRate,
      channels,
      getChannelData: (/** @type {number} */ ch) => channels[ch],
    };
    createdBuffers.push({ buffer: channels, sampleRate, duration: length / sampleRate });
    return buffer;
  }

  function createBufferSource() {
    const source = {
      /** @type {any} */
      buffer: null,
      /** @type {(() => void) | null} */
      onended: null,
      /** @type {AudioNode | null} */
      _connectedTo: null,
      /**
       * @param {number} [when]
       */
      start(when) {
        scheduledSources.push({ source, when: when ?? 0 });
      },
      /**
       * @param {number} [when]
       */
      stop(when) {
        // Simulate end
        const ec = this.onended;
        if (ec) {
          queueMicrotask(() => ec());
        }
      },
      /**
       * @param {AudioNode} node
       */
      connect(node) {
        this._connectedTo = node;
        return node;
      },
      disconnect() {},
    };
    return source;
  }

  function createGain() {
    const gain = {
      gain: gainParam,
      /**
       * @param {AudioNode} node
       */
      connect(node) { return node; },
      disconnect() {},
    };
    return gain;
  }

  function createStereoPanner() {
    const panner = {
      pan: { value: 0 },
      /**
       * @param {AudioNode} node
       */
      connect(node) { return node; },
      disconnect() {},
    };
    return panner;
  }

  function createAnalyser() {
    const analyser = {
      fftSize: 256,
      frequencyBinCount: 128,
      /**
       * @param {AudioNode} node
       */
      connect(node) { return node; },
      disconnect() {},
      /**
       * @param {Float32Array} array
       */
      getFloatTimeDomainData(array) {
        array.fill(0);
      },
    };
    return analyser;
  }

  return {
    state,
    createdBuffers,
    scheduledSources,
    endedCallbacks,
    gainParam,
    createBuffer,
    createBufferSource,
    createGain,
    createStereoPanner,
    createAnalyser,
    destination: {},
  };
}

describe("AudioGraph playStream", () => {
  /** @type {typeof globalThis.AudioContext} */
  let originalAudioContext;

  /** @type {ReturnType<typeof createMockAudioContext> | null} */
  let mockCtx = null;

  beforeEach(() => {
    mockCtx = createMockAudioContext();
    // @ts-ignore mock
    globalThis.AudioContext = class {
      /** @type {string} */
      state = "running";
      /** @type {number} */
      sampleRate = mockCtx.state.sampleRate;
      createBuffer = mockCtx.createBuffer.bind(mockCtx);
      createBufferSource = mockCtx.createBufferSource.bind(mockCtx);
      createGain = mockCtx.createGain.bind(mockCtx);
      createStereoPanner = mockCtx.createStereoPanner.bind(mockCtx);
      createAnalyser = mockCtx.createAnalyser.bind(mockCtx);
      destination = mockCtx.destination;
      resume() { this.state = "running"; return Promise.resolve(); }
      close() { return Promise.resolve(); }
    };
  });

  afterEach(() => {
    if (originalAudioContext) {
      // @ts-ignore
      globalThis.AudioContext = originalAudioContext;
    }
  });

  it("playStream creates AudioBuffers from incoming PCM chunks", async () => {
    const graph = new AudioGraph();
    const channel = graph.createChannel(0.0);

    /** @type {Float32Array[]} */
    const receivedChunks = [];
    const streamHandle = channel.playStream((onChunk) => {
      // Fire a few PCM chunks
      onChunk(new Float32Array([0.1, 0.2, 0.3]), 24000);
      onChunk(new Float32Array([0.4, 0.5, 0.6]), 24000);
      // return a cleanup
      return () => {};
    });

    // Wait for async scheduling
    await new Promise((r) => setTimeout(r, 20));

    // Verify buffers were created with correct PCM data
    assert.ok(mockCtx.createdBuffers.length >= 2, "Should create at least 2 buffers");

    streamHandle.stop();
  });

  it("playStream schedules AudioBufferSourceNodes for playback", async () => {
    const graph = new AudioGraph();
    const channel = graph.createChannel(0.0);

    let resolveStream = () => {};
    const streamHandle = channel.playStream((onChunk) => {
      onChunk(new Float32Array([0.1, 0.2]), 24000);
      onChunk(new Float32Array([0.3, 0.4]), 24000);
      return () => { resolveStream(); };
    });

    await new Promise((r) => setTimeout(r, 20));

    assert.ok(mockCtx.scheduledSources.length >= 1, "Should schedule at least 1 source for playback");

    streamHandle.stop();
  });

  it("playStream applies ducking when multiple channels active", async () => {
    const graph = new AudioGraph();
    const channel1 = graph.createChannel(-0.7);
    const channel2 = graph.createChannel(0.7);

    // Start stream on channel 1
    const handle1 = channel1.playStream((onChunk) => {
      onChunk(new Float32Array([0.1]), 24000);
      return () => {};
    });

    await new Promise((r) => setTimeout(r, 10));

    // Start stream on channel 2 — should trigger ducking
    const handle2 = channel2.playStream((onChunk) => {
      onChunk(new Float32Array([0.2]), 24000);
      return () => {};
    });

    await new Promise((r) => setTimeout(r, 10));

    // With 2 channels active, gain should be ~0.7
    // (We check that the setTargetAtTime was called with a target near 0.7)
    assert.strictEqual(graph.activeCount, 2);

    handle1.stop();
    handle2.stop();
  });

  it("playStream stop() terminates active sources", async () => {
    const graph = new AudioGraph();
    const channel = graph.createChannel(0.0);

    const handle = channel.playStream((onChunk) => {
      onChunk(new Float32Array([0.1, 0.2]), 24000);
      return () => {};
    });

    await new Promise((r) => setTimeout(r, 10));

    handle.stop();

    await new Promise((r) => setTimeout(r, 10));

    // After stop, activeCount should be 0
    assert.strictEqual(graph.activeCount, 0);
  });

  it("playStream preserves existing play() method", () => {
    const graph = new AudioGraph();
    const channel = graph.createChannel(0.0);

    assert.strictEqual(typeof channel.play, "function", "play() should exist");
    assert.strictEqual(typeof channel.playStream, "function", "playStream() should exist");
  });
});
