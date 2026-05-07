import { describe, it } from "node:test";
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

    const orchestrator = new Orchestrator({
      models: [{ name: "testModel", url: "http://localhost:1234", model: "test", voice: "af", color: "#fff", pan: 0, provider: "test" }],
      systemPrompt: "test",
      ttsConfig: { model: "test", maxTokens: 200, sentenceTimeoutTokens: 30 },
      audioGraph: mockAudioGraph,
      columns,
      ttsEngine: mockTtsEngine,
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
});
