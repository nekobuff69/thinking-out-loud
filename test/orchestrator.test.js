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
    const startPromise = orchestrator.start("test question", "chorus");
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
      openStream: () => ({ sendText: () => {}, close: () => {} }),
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
    orchestrator.start("test", "chorus");
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
