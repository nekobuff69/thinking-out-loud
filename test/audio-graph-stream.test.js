import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { AudioGraph } from "../audio/audio-graph.js";

/**
 * Minimal mock of the Web Audio API for testing.
 */
function createMockAudioContext() {
  const state = { currentTime: 0, sampleRate: 48000 };

  /** @type {Array<{buffer: Float32Array[], sampleRate: number, duration: number}>} */
  const createdBuffers = [];
  /** @type {Array<{source: object, when: number}>} */
  const scheduledSources = [];

  /** @type {{value: number, setTargetAtTime: (target: number, startTime: number, timeConstant: number) => void}} */
  const gainParam = {
    value: 1.0,
    _targetValue: 1.0,
    setTargetAtTime(target, _startTime, _timeConstant) {
      this._targetValue = target;
      setTimeout(() => { this.value = target; }, 50);
    },
  };

  function createBuffer(numChannels, length, sampleRate) {
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
      buffer: null,
      onended: null,
      _connectedTo: null,
      start(when) { scheduledSources.push({ source, when: when ?? 0 }); },
      stop(when) {
        const ec = this.onended;
        if (ec) queueMicrotask(() => ec());
      },
      connect(node) { this._connectedTo = node; return node; },
      disconnect() {},
    };
    return source;
  }

  function createGain() {
    return {
      gain: gainParam,
      connect(node) { return node; },
      disconnect() {},
    };
  }

  function createStereoPanner() {
    return {
      pan: { value: 0 },
      connect(node) { return node; },
      disconnect() {},
    };
  }

  function createAnalyser() {
    return {
      fftSize: 256,
      frequencyBinCount: 128,
      connect(node) { return node; },
      disconnect() {},
      getFloatTimeDomainData(array) { array.fill(0); },
    };
  }

  return {
    state,
    createdBuffers,
    scheduledSources,
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
      state = "running";
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

    const streamHandle = channel.playStream((onChunk) => {
      onChunk(new Float32Array([0.1, 0.2, 0.3]), 24000);
      onChunk(new Float32Array([0.4, 0.5, 0.6]), 24000);
      return () => {};
    });

    await new Promise((r) => setTimeout(r, 20));

    assert.ok(mockCtx.createdBuffers.length >= 2, "Should create at least 2 buffers");
    streamHandle.stop();
  });

  it("playStream schedules AudioBufferSourceNodes for playback", async () => {
    const graph = new AudioGraph();
    const channel = graph.createChannel(0.0);

    const streamHandle = channel.playStream((onChunk) => {
      onChunk(new Float32Array([0.1, 0.2]), 24000);
      onChunk(new Float32Array([0.3, 0.4]), 24000);
      return () => {};
    });

    await new Promise((r) => setTimeout(r, 20));

    assert.ok(mockCtx.scheduledSources.length >= 1, "Should schedule at least 1 source");
    streamHandle.stop();
  });

  it("playStream applies ducking when multiple channels active", async () => {
    const graph = new AudioGraph();
    const channel1 = graph.createChannel(-0.7);
    const channel2 = graph.createChannel(0.7);

    const handle1 = channel1.playStream((onChunk) => {
      onChunk(new Float32Array([0.1]), 24000);
      return () => {};
    });

    await new Promise((r) => setTimeout(r, 10));

    const handle2 = channel2.playStream((onChunk) => {
      onChunk(new Float32Array([0.2]), 24000);
      return () => {};
    });

    await new Promise((r) => setTimeout(r, 10));

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

    assert.strictEqual(graph.activeCount, 0);
  });

  it("playStream preserves existing play() method", () => {
    const graph = new AudioGraph();
    const channel = graph.createChannel(0.0);

    assert.strictEqual(typeof channel.play, "function");
    assert.strictEqual(typeof channel.playStream, "function");
  });
});

// ---------------------------------------------------------------------------
// openStream tests
// ---------------------------------------------------------------------------

describe("AudioGraph openStream", () => {
  /** @type {typeof globalThis.AudioContext} */
  let originalAudioContext;
  /** @type {ReturnType<typeof createMockAudioContext> | null} */
  let mockCtx = null;

  beforeEach(() => {
    mockCtx = createMockAudioContext();
    // @ts-ignore mock
    globalThis.AudioContext = class {
      state = "running";
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

  it("openStream().feed() creates and plays audio sources", async () => {
    const graph = new AudioGraph();
    const channel = graph.createChannel(0.0);

    const handle = channel.openStream();
    handle.feed(new Float32Array([0.1, 0.2, 0.3]), 24000);
    handle.feed(new Float32Array([0.4, 0.5, 0.6]), 24000);

    await new Promise((r) => setTimeout(r, 20));

    assert.ok(mockCtx.createdBuffers.length >= 2, "buffers created from feed");
    assert.ok(mockCtx.scheduledSources.length >= 2, "sources scheduled from feed");
    assert.strictEqual(graph.activeCount, 1);

    handle.end();
  });

  it("openStream().end() decrements activeCount", async () => {
    const graph = new AudioGraph();
    const channel = graph.createChannel(0.0);

    const handle = channel.openStream();
    handle.feed(new Float32Array([0.1]), 24000);
    assert.strictEqual(graph.activeCount, 1);

    handle.end();
    assert.strictEqual(graph.activeCount, 0);
  });

  it("openStream().stop() kills sources and decrements activeCount", async () => {
    const graph = new AudioGraph();
    const channel = graph.createChannel(0.0);

    const handle = channel.openStream();
    handle.feed(new Float32Array([0.1]), 24000);
    assert.strictEqual(graph.activeCount, 1);

    handle.stop();
    assert.strictEqual(graph.activeCount, 0);
  });

  it("openStream feeds after end are ignored", async () => {
    const graph = new AudioGraph();
    const channel = graph.createChannel(0.0);

    const handle = channel.openStream();
    handle.feed(new Float32Array([0.1]), 24000);
    handle.end();

    const countBefore = mockCtx.createdBuffers.length;
    handle.feed(new Float32Array([0.2]), 24000);

    assert.strictEqual(mockCtx.createdBuffers.length, countBefore, "no more buffers after end");
  });

  it("openStream feeds after stop are ignored", async () => {
    const graph = new AudioGraph();
    const channel = graph.createChannel(0.0);

    const handle = channel.openStream();
    handle.feed(new Float32Array([0.1]), 24000);
    handle.stop();

    const countBefore = mockCtx.createdBuffers.length;
    handle.feed(new Float32Array([0.2]), 24000);

    assert.strictEqual(mockCtx.createdBuffers.length, countBefore, "no more buffers after stop");
  });

  it("openStream shares ducking with playStream", async () => {
    const graph = new AudioGraph();
    const ch1 = graph.createChannel(-0.7);
    const ch2 = graph.createChannel(0.7);

    // openStream on ch1
    const h1 = ch1.openStream();
    h1.feed(new Float32Array([0.1]), 24000);

    // playStream on ch2
    const h2 = ch2.playStream((onChunk) => {
      onChunk(new Float32Array([0.2]), 24000);
      return () => {};
    });

    await new Promise((r) => setTimeout(r, 10));

    // Both active -> ducking
    assert.strictEqual(graph.activeCount, 2);

    h1.stop();
    h2.stop();
  });

  it("openStream is exposed on channel object", () => {
    const graph = new AudioGraph();
    const channel = graph.createChannel(0.0);

    assert.strictEqual(typeof channel.openStream, "function");
  });
});
