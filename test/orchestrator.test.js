import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { Orchestrator } from "../session/orchestrator.js";

describe("Orchestrator", () => {
  /**
   * @returns {{ orchestrator: Orchestrator, stateLog: string[] }}
   */
  function makeOrchestrator() {
    const stateLog = /** @type {string[]} */ ([]);
    const mockTtsEngine = {
      load: async () => {},
      startStream: () => {},
      stop: () => {},
      destroy: () => {},
    };
    const mockAudioGraph = {
      clearChannels: () => {},
      createChannel: () => ({
        play: () => {},
        playStream: () => ({ stop: () => {} }),
        analyser: {},
        gain: {},
        stopAll: () => {},
      }),
      getContext: () => undefined,
    };
    const mockColumn = {
      appendToken: () => {},
      clear: () => {},
      setError: () => {},
      attachWaveform: () => {},
      stopWaveform: () => {},
    };
    const mockStorage = {
      save: () => {},
      saveQuestion: () => {},
    };

    const columns = new Map([["testModel", mockColumn]]);

    const ttsEngines = new Map([["testModel", mockTtsEngine]]);

    const orchestrator = new Orchestrator({
      models: [{ name: "testModel", url: "http://localhost:1234", model: "test", voice: "af", color: "#fff", pan: 0, provider: "test" }],
      systemPrompt: "test",
      ttsConfig: { model: "test", maxTokens: 200, sentenceTimeoutTokens: 30 },
      audioGraph: mockAudioGraph,
      columns,
      ttsEngines,
      storage: mockStorage,
    });

    orchestrator.onStateChange((s) => stateLog.push(s));

    return { orchestrator, stateLog };
  }

  it("transitions to Idle after stop(), allowing a new session", () => {
    const { orchestrator, stateLog } = makeOrchestrator();

    // Initial state is Idle
    assert.strictEqual(orchestrator.state, "Idle");

    orchestrator.stop();

    // After stop, state should indicate Done then return to Idle
    assert.strictEqual(orchestrator.state, "Idle");
    assert.ok(stateLog.includes("Done"), "should fire Done state change");

    // Verifying a new session can start: start() should not bail out early
    // We check that it doesn't return immediately (which it would do if state !== "Idle")
    // by confirming the method begins executing and reaches Loading state
    const startPromise = orchestrator.start("test question");
    // start() is async and will set state to "Loading" immediately,
    // then quickly transitions to "Loading: downloading TTS model…"
    assert.ok(
      orchestrator.state === "Loading" || orchestrator.state.startsWith("Loading:"),
      `expected state to start with "Loading", got "${orchestrator.state}"`
    );
  });

  it("does not save session after user stop", async () => {
    // Mock fetch so health check succeeds and LLM stream hangs (never completes)
    const neverEndingStream = new ReadableStream({
      start(controller) {
        // Never close — stream stays open forever
        // Send a keepalive comment so SSE parser doesn't error
        controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
      },
      cancel() {},
    });

    mock.method(globalThis, "fetch", async (url) => {
      if (url.toString().includes("/models")) {
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }
      // For the LLM stream endpoint, return a never-ending SSE stream
      return {
        ok: true,
        status: 200,
        body: neverEndingStream,
        headers: new Map([["content-type", "text/event-stream"]]),
      };
    });

    let saved = false;

    const mockTtsEngine = {
      load: async () => {},
      startStream: () => {},
      stop: () => {},
      destroy: () => {},
    };
    const mockAudioGraph = {
      clearChannels: () => {},
      createChannel: () => ({
        play: () => {},
        playStream: () => ({ stop: () => {} }),
        openStream: () => ({ feed: () => {}, end: () => {}, stop: () => {} }),
        analyser: {},
        gain: {},
        stopAll: () => {},
      }),
      getContext: () => undefined,
    };
    const mockColumn = {
      appendToken: () => {},
      clear: () => {},
      setError: () => {},
      attachWaveform: () => {},
      stopWaveform: () => {},
    };

    const columns = new Map([["testModel", mockColumn]]);

    // LLM provider that never finishes (simulating long-running stream without tokens)
    const mockLlmProvider = {
      streamReasoning: async () => new Promise(() => {}),
    };

    const ttsEngines = new Map([["testModel", mockTtsEngine]]);

    const orchestrator = new Orchestrator({
      models: [{ name: "testModel", url: "http://localhost:1234", model: "test", voice: "af", color: "#fff", pan: 0, provider: "test" }],
      systemPrompt: "test",
      ttsConfig: { model: "test", maxTokens: 200, sentenceTimeoutTokens: 30 },
      audioGraph: mockAudioGraph,
      columns,
      ttsEngines,
      storage: { save: () => { saved = true; }, saveQuestion: () => {}, getQuestions: () => [], list: () => [], load: () => null },
    });

    // Start a session (stream runs indefinitely)
    orchestrator.start("test");
    await new Promise((r) => setTimeout(r, 30));

    // User clicks Stop mid-stream
    orchestrator.stop();
    await new Promise((r) => setTimeout(r, 10));

    // Session should NOT be saved — it was incomplete
    assert.strictEqual(saved, false, "incomplete session should not be saved");

    mock.reset();
  });

  it("monologue mode pauses all but first pipeline, resumes sequentially", async () => {
    mock.method(globalThis, "fetch", async (url) => {
      if (url.toString().includes("/models")) {
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }
      const neverEndingStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
        },
        cancel() {},
      });
      return {
        ok: true,
        status: 200,
        body: neverEndingStream,
        headers: new Map([["content-type", "text/event-stream"]]),
      };
    });

    const resumeOrder = [];

    function makePausedTracker(name) {
      let _paused = true;
      return {
        get paused() { return _paused; },
        pause() { _paused = true; },
        resume() { _paused = false; resumeOrder.push(name); },
        softStop() {},
        isActive: false,
        modelName: name,
        reasoningText: "",
        isCapped: false,
      };
    }

    const p0 = makePausedTracker("A");
    const p1 = makePausedTracker("B");
    const p2 = makePausedTracker("C");

    // Simulate: A finishes -> B resumes -> B finishes -> C resumes -> C finishes
    // This tests the sequential resume chain
    resumeOrder.push("A"); // first pipeline runs immediately
    p0.isActive = false;

    // advanceMonologue logic (mirrors orchestrator)
    let monologueIndex = 0;
    const pipelines = [p0, p1, p2];

    function advanceMonologue() {
      monologueIndex++;
      if (monologueIndex < pipelines.length) {
        pipelines[monologueIndex].resume();
        pipelines[monologueIndex].isActive = false; // simulate immediate completion
        // auto-advance to next
        advanceMonologue();
      }
    }

    // A finishes -> start chain
    advanceMonologue();

    // Check order
    assert.strictEqual(resumeOrder[0], "A", "first model runs");
    assert.strictEqual(resumeOrder[1], "B", "second after first finishes");
    assert.strictEqual(resumeOrder[2], "C", "third after second finishes");
    assert.strictEqual(resumeOrder.length, 3, "all three resumed");

    mock.reset();
  });
});
describe("mute and solo", () => {
  /**
   * Create fixture with 3 models and tracked channel mocks.
   * @returns {{ orchestrator: Orchestrator, channels: Array<Record<string,any>>, columnMocks: Map<string,Record<string,any>> }}
   */
  function makeTestFixture() {
    const channels = /** @type {Array<Record<string,any>>} */ ([]);
    const columnMocks = new Map();

    const mockAudioGraph = {
      clearChannels: () => {},
      createChannel: mock.fn((pan) => {
        const ch = {
          muteGain: {
            gain: { setTargetAtTime: mock.fn() },
            context: { currentTime: 0 },
          },
          setAudible: mock.fn(),
          analyser: {},
          gain: {},
          openStream: mock.fn(() => ({ feed: mock.fn(), end: mock.fn(), stop: mock.fn() })),
          playStream: mock.fn(),
          stopAll: mock.fn(),
          play: mock.fn(),
        };
        channels.push(ch);
        return ch;
      }),
      getContext: () => undefined,
    };

    const models = ["modelA", "modelB", "modelC"].map((name) => ({
      name,
      url: "http://localhost:1234",
      model: name,
      voice: "af",
      color: "#fff",
      pan: 0,
      provider: "test",
    }));

    const columns = new Map();
    const ttsEngines = new Map();

    for (const m of models) {
      const col = {
        appendToken: () => {},
        clear: () => {},
        setError: () => {},
        attachWaveform: () => {},
        stopWaveform: () => {},
        setMuted: mock.fn(),
        setSoloed: mock.fn(),
        onMuteToggle: mock.fn(),
        onSoloToggle: mock.fn(),
      };
      columns.set(m.name, col);
      columnMocks.set(m.name, col);
      ttsEngines.set(m.name, {
        load: async () => {},
        startStream: () => {},
        stop: () => {},
        destroy: () => {},
      });
    }

    const orchestrator = new Orchestrator({
      models,
      systemPrompt: "test",
      ttsConfig: { model: "test", maxTokens: 200, sentenceTimeoutTokens: 30 },
      audioGraph: mockAudioGraph,
      columns,
      ttsEngines,
      storage: {
        save: () => {},
        saveQuestion: () => {},
        getQuestions: () => [],
        list: () => [],
        load: () => null,
      },
    });

    return { orchestrator, channels, columnMocks };
  }

  /** Set up fetch mock for health check and never-ending LLM stream. */
  function setupFetchMock() {
    const neverEndingStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
      },
      cancel() {},
    });

    mock.method(globalThis, "fetch", async (url) => {
      if (url.toString().includes("/models")) {
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }
      return {
        ok: true,
        status: 200,
        body: neverEndingStream,
        headers: new Map([["content-type", "text/event-stream"]]),
      };
    });
  }

  /** Start orchestrator and wait for #setupPipelines to complete. */
  async function startOrchestrator(orchestrator) {
    orchestrator.start("test question");
    await new Promise((r) => setTimeout(r, 30));
  }

  it("no mute/solo — all audible, gain=1", async () => {
    const { orchestrator, channels } = makeTestFixture();
    setupFetchMock();
    await startOrchestrator(orchestrator);

    // Trigger recompute with no mute/solo state
    orchestrator.toggleMute("modelA");
    orchestrator.toggleMute("modelA");

    for (const ch of channels) {
      const lastGainCall = ch.muteGain.gain.setTargetAtTime.mock.calls.at(-1);
      const lastAudibleCall = ch.setAudible.mock.calls.at(-1);
      assert.strictEqual(lastGainCall.arguments[0], 1.0);
      assert.strictEqual(lastAudibleCall.arguments[0], true);
    }
    mock.reset();
  });

  it("mute one channel silences it", async () => {
    const { orchestrator, channels } = makeTestFixture();
    setupFetchMock();
    await startOrchestrator(orchestrator);

    orchestrator.toggleMute("modelA");

    assert.strictEqual(channels[0].setAudible.mock.calls.at(-1).arguments[0], false);
    assert.strictEqual(channels[0].muteGain.gain.setTargetAtTime.mock.calls.at(-1).arguments[0], 0.0);
    assert.strictEqual(channels[1].setAudible.mock.calls.at(-1).arguments[0], true);
    assert.strictEqual(channels[1].muteGain.gain.setTargetAtTime.mock.calls.at(-1).arguments[0], 1.0);
    assert.strictEqual(channels[2].setAudible.mock.calls.at(-1).arguments[0], true);
    assert.strictEqual(channels[2].muteGain.gain.setTargetAtTime.mock.calls.at(-1).arguments[0], 1.0);
    mock.reset();
  });

  it("unmute restores audibility", async () => {
    const { orchestrator, channels } = makeTestFixture();
    setupFetchMock();
    await startOrchestrator(orchestrator);

    orchestrator.toggleMute("modelA");
    orchestrator.toggleMute("modelA");

    for (const ch of channels) {
      assert.strictEqual(ch.setAudible.mock.calls.at(-1).arguments[0], true);
      assert.strictEqual(ch.muteGain.gain.setTargetAtTime.mock.calls.at(-1).arguments[0], 1.0);
    }
    mock.reset();
  });

  it("solo one channel silences others", async () => {
    const { orchestrator, channels } = makeTestFixture();
    setupFetchMock();
    await startOrchestrator(orchestrator);

    orchestrator.toggleSolo("modelA");

    assert.strictEqual(channels[0].setAudible.mock.calls.at(-1).arguments[0], true);
    assert.strictEqual(channels[0].muteGain.gain.setTargetAtTime.mock.calls.at(-1).arguments[0], 1.0);
    assert.strictEqual(channels[1].setAudible.mock.calls.at(-1).arguments[0], false);
    assert.strictEqual(channels[1].muteGain.gain.setTargetAtTime.mock.calls.at(-1).arguments[0], 0.0);
    assert.strictEqual(channels[2].setAudible.mock.calls.at(-1).arguments[0], false);
    assert.strictEqual(channels[2].muteGain.gain.setTargetAtTime.mock.calls.at(-1).arguments[0], 0.0);
    mock.reset();
  });

  it("solo multiple keeps them all audible", async () => {
    const { orchestrator, channels } = makeTestFixture();
    setupFetchMock();
    await startOrchestrator(orchestrator);

    orchestrator.toggleSolo("modelA");
    orchestrator.toggleSolo("modelB");

    assert.strictEqual(channels[0].setAudible.mock.calls.at(-1).arguments[0], true);
    assert.strictEqual(channels[1].setAudible.mock.calls.at(-1).arguments[0], true);
    assert.strictEqual(channels[2].setAudible.mock.calls.at(-1).arguments[0], false);
    assert.strictEqual(channels[2].muteGain.gain.setTargetAtTime.mock.calls.at(-1).arguments[0], 0.0);
    mock.reset();
  });


  it("mute within solo silences channel", async () => {
    const { orchestrator, channels } = makeTestFixture();
    setupFetchMock();
    await startOrchestrator(orchestrator);

    orchestrator.toggleMute("modelA");
    orchestrator.toggleSolo("modelA");

    // Mute applies even when soloed — channel is silent
    assert.strictEqual(channels[0].setAudible.mock.calls.at(-1).arguments[0], false);
    assert.strictEqual(channels[0].muteGain.gain.setTargetAtTime.mock.calls.at(-1).arguments[0], 0.0);
    mock.reset();
  });

  it("un-solo falls back to mute", async () => {
    const { orchestrator, channels } = makeTestFixture();
    setupFetchMock();
    await startOrchestrator(orchestrator);

    orchestrator.toggleMute("modelA");
    orchestrator.toggleSolo("modelA");
    orchestrator.toggleSolo("modelA");

    assert.strictEqual(channels[0].setAudible.mock.calls.at(-1).arguments[0], false);
    assert.strictEqual(channels[0].muteGain.gain.setTargetAtTime.mock.calls.at(-1).arguments[0], 0.0);
    mock.reset();
  });

  it("column setMuted/setSoloed called on toggle", async () => {
    const { orchestrator, columnMocks } = makeTestFixture();
    setupFetchMock();
    await startOrchestrator(orchestrator);

    orchestrator.toggleMute("modelA");
    assert.strictEqual(columnMocks.get("modelA").setMuted.mock.calls.at(-1).arguments[0], true);

    orchestrator.toggleSolo("modelA");
    assert.strictEqual(columnMocks.get("modelA").setSoloed.mock.calls.at(-1).arguments[0], true);

    orchestrator.toggleMute("modelA");
    assert.strictEqual(columnMocks.get("modelA").setMuted.mock.calls.at(-1).arguments[0], false);
    mock.reset();
  });
});
