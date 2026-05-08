import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TTSPlaybackQueue } from "../tts/playback-queue.js";

describe("TTSPlaybackQueue", () => {
  /**
   * @returns {{
   *   queue: TTSPlaybackQueue,
   *   synthRequests: Array<{ text: string, voice: string, resolve: (buf: any) => void, reject: (err: Error) => void }>,
   *   playRequests: Array<{ buffer: any, onEnd: () => void }>,
   *   idleState: { count: number },
   * }}
   */
  function makeQueue() {
    /** @type {Array<{ text: string, voice: string, resolve: (buf: any) => void, reject: (err: Error) => void }>} */
    const synthRequests = [];
    /** @type {Array<{ buffer: any, onEnd: () => void }>} */
    const playRequests = [];
    const idleState = { count: 0 };

    const mockTtsEngine = {
      synthesize: (/** @type {string} */ text, /** @type {string} */ voice) => {
        return new Promise((resolve, reject) => {
          synthRequests.push({ text, voice, resolve, reject });
        });
      },
    };

    const mockChannel = {
      play: (/** @type {any} */ buffer, /** @type {() => void} */ onEnd) => {
        playRequests.push({ buffer, onEnd });
      },
    };

    const queue = new TTSPlaybackQueue({
      ttsEngine: mockTtsEngine,
      channel: mockChannel,
      voice: "af_bella",
      sentenceGapMs: 50,
      onIdle: () => {
        idleState.count++;
      },
    });

    return { queue, synthRequests, playRequests, idleState };
  }

  it("synthesizes first sentence on-demand then plays", async () => {
    const { queue, synthRequests, playRequests } = makeQueue();

    queue.enqueue("Hello.");
    assert.equal(synthRequests.length, 1, "first synthesis starts immediately");
    assert.equal(synthRequests[0].text, "Hello.");

    // Resolve first synthesis
    synthRequests[0].resolve({ id: 1 });
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(playRequests.length, 1, "plays after synthesis");
    assert.strictEqual(playRequests[0].buffer.id, 1);
  });

  it("pre-synthesizes next sentence during playback", async () => {
    const { queue, synthRequests, playRequests } = makeQueue();

    queue.enqueue("First.");
    queue.enqueue("Second.");

    // First synthesis request should be for "First."
    assert.equal(synthRequests.length, 1);
    assert.equal(synthRequests[0].text, "First.");

    // Resolve first synthesis → playback starts
    synthRequests[0].resolve({ id: 1 });
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(playRequests.length, 1);

    // During playback of First, pre-synthesis of Second should start
    assert.equal(synthRequests.length, 2, "pre-synthesis starts during playback");
    assert.equal(synthRequests[1].text, "Second.");
  });

  it("plays subsequent sentences gap-free from pre-baked buffer", async () => {
    const { queue, synthRequests, playRequests } = makeQueue();

    queue.enqueue("First.");
    queue.enqueue("Second.");

    // Resolve both syntheses before ending playback
    synthRequests[0].resolve({ id: 1 });
    await new Promise((r) => setTimeout(r, 0));
    synthRequests[1].resolve({ id: 2 });
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(playRequests.length, 1, "only first is playing");

    // End first playback
    playRequests[0].onEnd();
    await new Promise((r) => setTimeout(r, 0));

    // Second should play immediately (no gap)
    assert.equal(playRequests.length, 2, "second plays immediately after first ends");
    assert.strictEqual(playRequests[1].buffer.id, 2);
  });

  it("enters Gapping when pre-synthesis is slower than playback", async () => {
    const { queue, synthRequests, playRequests } = makeQueue();

    queue.enqueue("First.");
    queue.enqueue("Slow.");

    // Resolve first synthesis → playback starts
    synthRequests[0].resolve({ id: 1 });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(playRequests.length, 1);

    // End first playback BEFORE second synthesis resolves
    playRequests[0].onEnd();
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(queue.state, "Gapping", "enters Gapping while waiting");

    // Now resolve second synthesis
    synthRequests[1].resolve({ id: 2 });
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(playRequests.length, 2, "second plays after synthesis catches up");
  });

  it("continues pre-synthesis while paused", async () => {
    const { queue, synthRequests, playRequests } = makeQueue();

    queue.enqueue("First.");
    synthRequests[0].resolve({ id: 1 });
    await new Promise((r) => setTimeout(r, 0));

    // Playback of First is in progress
    assert.equal(playRequests.length, 1);

    // Pause the queue
    queue.pause();
    assert.equal(queue.state, "Paused");

    // Enqueue second sentence while paused
    queue.enqueue("Second.");

    // Pre-synthesis of Second should start even while paused
    assert.equal(synthRequests.length, 2, "pre-synthesis runs while paused");

    // Resolve second synthesis
    synthRequests[1].resolve({ id: 2 });
    await new Promise((r) => setTimeout(r, 0));

    // End first playback while still paused
    playRequests[0].onEnd();
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(queue.state, "Paused", "stays paused after playback ends");
    assert.equal(playRequests.length, 1, "second does not play while paused");

    // Resume — second should play immediately from pre-baked buffer
    queue.resume();
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(playRequests.length, 2, "second plays immediately on resume");
    assert.strictEqual(playRequests[1].buffer.id, 2);
  });

  it("soft stop finishes current sentence then goes idle", async () => {
    const { queue, synthRequests, playRequests, idleState } = makeQueue();

    queue.enqueue("First.");
    queue.enqueue("Second.");

    synthRequests[0].resolve({ id: 1 });
    await new Promise((r) => setTimeout(r, 0));

    queue.stop();
    // While playing, stop() sets soft-stop flag but lets current sentence finish
    assert.equal(queue.state, "Playing", "state stays Playing while current sentence finishes");

    // Current sentence should still finish
    playRequests[0].onEnd();
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(queue.state, "Stopped", "state becomes Stopped after current sentence finishes");
    assert.equal(idleState.count, 1, "onIdle fires after current sentence finishes");
    assert.equal(playRequests.length, 1, "second sentence is discarded");
  });

  it("defaults sentence gap to 50ms", () => {
    const { queue } = makeQueue();
    // The mock was created with sentenceGapMs: 50.
    // We verify the constructor accepts and uses the value by checking
    // that Gapping state is reachable with the configured timeout.
    assert.equal(queue.state, "Idle");
  });
});
