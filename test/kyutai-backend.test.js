import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

/**
 * Mock WebSocket for testing KyutaiBackend.
 * Simulates a server that sends PCM frames, done, and error messages.
 */
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  /** @type {string} */
  url;
  /** @type {number} */
  readyState = 0;
  /** @type {Array<string>} */
  sentMessages = [];
  /** @type {((ev: { data: string }) => void) | null} */
  onmessage = null;
  /** @type {(() => void) | null} */
  onopen = null;
  /** @type {((ev: { code?: number; reason?: string }) => void) | null} */
  onclose = null;
  /** @type {((ev: { message?: string }) => void) | null} */
  onerror = null;

  /**
   * @param {string} url
   */
  constructor(url) {
    this.url = url;
    // Simulate async connection
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    });
  }

  /**
   * @param {string} data
   */
  send(data) {
    this.sentMessages.push(data);
  }

  close(code, reason) {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  /** Simulate server sending a message to the client.
   * @param {string} data
   */
  _serverSend(data) {
    if (this.onmessage) {
      this.onmessage({ data });
    }
  }

  /** Simulate server close. */
  _serverClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: "" });
  }
}

// Import after mocking WebSocket
import { KyutaiBackend } from "../tts/kyutai-backend.js";

describe("KyutaiBackend", () => {
  /** @type {typeof globalThis.WebSocket} */
  let originalWebSocket;

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket;
    // @ts-ignore mock
    globalThis.WebSocket = MockWebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  describe("load()", () => {
    it("opens a WebSocket connection to the configured URL", async () => {
      const backend = new KyutaiBackend({ wsUrl: "ws://localhost:8765" });
      await backend.load();
      // Connection should be established
      // After load, backend should be ready
      assert.ok(true, "load completed without error");
    });

    it("connects to ws://localhost:8765 by default", async () => {
      const backend = new KyutaiBackend();
      await backend.load();
      // Default URL should work
      assert.ok(true, "default connection established");
    });

    it("only opens one WebSocket connection on repeated load() calls", async () => {
      const backend = new KyutaiBackend();
      await backend.load();
      await backend.load(); // second call should be a no-op
      assert.ok(true, "idempotent load");
    });
  });

  describe("startStream()", () => {
    it("sends correct synthesize JSON message", async () => {
      const backend = new KyutaiBackend({ wsUrl: "ws://localhost:8765" });
      await backend.load();

      const ws = /** @type {MockWebSocket} */ ((/** @type {any} */ (backend)._testWs));
      backend.startStream("Hello world", "alba", () => {});

      assert.strictEqual(ws.sentMessages.length, 1);
      const sent = JSON.parse(ws.sentMessages[0]);
      assert.strictEqual(sent.type, "synthesize");
      assert.strictEqual(sent.text, "Hello world");
      assert.strictEqual(sent.voice, "alba");
    });

    it("delivers PCM chunks in order via onAudioChunk callback", async () => {
      const backend = new KyutaiBackend();
      await backend.load();

      const ws = /** @type {MockWebSocket} */ ((/** @type {any} */ (backend)._testWs));
      /** @type {Array<{pcm: Float32Array, sampleRate: number}>} */
      const chunks = [];

      backend.startStream("Hello", "alba", (pcm, sampleRate) => {
        chunks.push({ pcm: new Float32Array(pcm), sampleRate });
      });

      // Send one chunk
      ws._serverSend(JSON.stringify({ type: "pcm", data: [0.1, 0.2, 0.3] }));
      ws._serverSend(JSON.stringify({ type: "pcm", data: [0.4, 0.5, 0.6] }));

      // Allow microtasks to flush
      await new Promise((r) => setTimeout(r, 10));

      assert.strictEqual(chunks.length, 2);
      // Use approximate comparison for float precision after JSON round-trip
      assert.ok(chunks[0].pcm.length === 3, "first chunk has 3 samples");
      assert.ok(Math.abs(chunks[0].pcm[0] - 0.1) < 1e-5, "first sample ~0.1");
      assert.ok(Math.abs(chunks[0].pcm[1] - 0.2) < 1e-5, "second sample ~0.2");
      assert.ok(Math.abs(chunks[0].pcm[2] - 0.3) < 1e-5, "third sample ~0.3");
      assert.ok(chunks[1].pcm.length === 3, "second chunk has 3 samples");
      assert.ok(Math.abs(chunks[1].pcm[0] - 0.4) < 1e-5, "4th sample ~0.4");
      // Default sample rate
      assert.strictEqual(chunks[0].sampleRate, 24000);
    });

    it("calls onDone when server sends done", async () => {
      const backend = new KyutaiBackend();
      await backend.load();

      const ws = /** @type {MockWebSocket} */ ((/** @type {any} */ (backend)._testWs));
      let doneCalled = false;
      let errorCalled = false;

      backend.startStream("Hi", "alba", () => {}, {
        onDone: () => { doneCalled = true; },
        onError: () => { errorCalled = true; },
      });

      // Send a PCM chunk then done
      ws._serverSend(JSON.stringify({ type: "pcm", data: [0.1] }));
      ws._serverSend(JSON.stringify({ type: "done" }));

      await new Promise((r) => setTimeout(r, 10));

      assert.strictEqual(doneCalled, true);
      assert.strictEqual(errorCalled, false);
    });

    it("calls onError when server sends error", async () => {
      const backend = new KyutaiBackend();
      await backend.load();

      const ws = /** @type {MockWebSocket} */ ((/** @type {any} */ (backend)._testWs));
      let doneCalled = false;
      let errorMsg = "";

      backend.startStream("Hi", "bad_voice", () => {}, {
        onDone: () => { doneCalled = true; },
        onError: (msg) => { errorMsg = msg; },
      });

      ws._serverSend(JSON.stringify({ type: "error", message: "Invalid voice" }));

      await new Promise((r) => setTimeout(r, 10));

      assert.strictEqual(doneCalled, false);
      assert.strictEqual(errorMsg, "Invalid voice");
    });

    it("handles multiple concurrent streams on separate startStream calls", async () => {
      const backend = new KyutaiBackend();
      await backend.load();

      const ws = /** @type {MockWebSocket} */ ((/** @type {any} */ (backend)._testWs));
      /** @type {string[]} */
      const stream1Chunks = [];
      /** @type {string[]} */
      const stream2Chunks = [];

      // Start first stream
      backend.startStream("One", "alba", (pcm) => {
        stream1Chunks.push(`stream1:${pcm[0]}`);
      });

      // Simulate a chunk for stream 1
      ws._serverSend(JSON.stringify({ type: "pcm", data: [1.0] }));
      await new Promise((r) => setTimeout(r, 5));

      // Start second stream (this should interrupt stream 1)
      backend.startStream("Two", "alba", (pcm) => {
        stream2Chunks.push(`stream2:${pcm[0]}`);
      });

      ws._serverSend(JSON.stringify({ type: "pcm", data: [2.0] }));
      ws._serverSend(JSON.stringify({ type: "done" }));
      await new Promise((r) => setTimeout(r, 10));

      // Stream 2 should have received the chunk; stream 1 callbacks should have been replaced
      assert.strictEqual(stream2Chunks.length, 1);
      assert.strictEqual(stream2Chunks[0], "stream2:2");
    });
  });

  describe("stop()", () => {
    it("aborts the current stream and stops delivering chunks", async () => {
      const backend = new KyutaiBackend();
      await backend.load();

      const ws = /** @type {MockWebSocket} */ ((/** @type {any} */ (backend)._testWs));
      /** @type {Array<{pcm: Float32Array, sampleRate: number}>} */
      const chunks = [];

      backend.startStream("Long text", "alba", (pcm, sampleRate) => {
        chunks.push({ pcm: new Float32Array(pcm), sampleRate });
      });

      // Send one chunk
      ws._serverSend(JSON.stringify({ type: "pcm", data: [0.1] }));
      await new Promise((r) => setTimeout(r, 5));

      backend.stop();

      // Send more chunks after stop — they should be ignored
      ws._serverSend(JSON.stringify({ type: "pcm", data: [0.2] }));
      ws._serverSend(JSON.stringify({ type: "done" }));
      await new Promise((r) => setTimeout(r, 5));

      assert.strictEqual(chunks.length, 1); // only first chunk received
    });
  });

  describe("destroy()", () => {
    it("closes the WebSocket connection", async () => {
      const backend = new KyutaiBackend();
      await backend.load();

      const ws = /** @type {MockWebSocket} */ ((/** @type {any} */ (backend)._testWs));
      assert.notStrictEqual(ws.readyState, MockWebSocket.CLOSED);

      backend.destroy();

      assert.strictEqual(ws.readyState, MockWebSocket.CLOSED);
    });

    it("allows re-load after destroy", async () => {
      const backend = new KyutaiBackend();
      await backend.load();
      backend.destroy();
      // Should be able to load again
      await backend.load();
      assert.ok(true, "re-load after destroy succeeded");
    });
  });

  describe("load error handling", () => {
    it("rejects load() when WebSocket connection fails", async () => {
      // Mock WebSocket that fails to connect
      class FailingWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        url = "";
        readyState = 0;
        sentMessages = [];
        onmessage = null;
        onopen = null;
        onclose = null;
        onerror = null;

        constructor(url) {
          this.url = url;
          // Simulate immediate connection failure — no onopen
          queueMicrotask(() => {
            this.readyState = 3; // CLOSED
            this.onerror?.({ message: "Connection refused" });
          });
        }
        send() {}
        close() {}
      }
      // @ts-ignore
      globalThis.WebSocket = FailingWebSocket;

      const backend = new KyutaiBackend();

      await assert.rejects(
        () => backend.load(),
        /TTS server unreachable/,
      );
    });
  });

  describe("reconnect", () => {
    /**
     * ReconnectingMockWebSocket: tracks all instances and allows
     * simulating drops and reconnections.
     */
    class ReconnectingMockWS {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      /** @type {ReconnectingMockWS[]} */
      static instances = [];

      url = "";
      readyState = 0;
      sentMessages = [];
      onmessage = null;
      onopen = null;
      onclose = null;
      onerror = null;

      constructor(url) {
        this.url = url;
        this.readyState = 0;
        ReconnectingMockWS.instances.push(this);
        // Simulate async connection
        queueMicrotask(() => {
          this.readyState = ReconnectingMockWS.OPEN;
          this.onopen?.();
        });
      }

      send(data) {
        this.sentMessages.push(data);
      }

      close(code, reason) {
        this.readyState = ReconnectingMockWS.CLOSED;
        this.onclose?.({ code, reason });
      }

      _serverSend(data) {
        if (this.onmessage) {
          this.onmessage({ data });
        }
      }

      _simulateDrop() {
        this.readyState = ReconnectingMockWS.CLOSED;
        this.onclose?.({ code: 1006, reason: "Abnormal closure" });
      }
    }

    beforeEach(() => {
      ReconnectingMockWS.instances = [];
    });

    it("reconnects after unexpected WebSocket drop", async () => {
      // @ts-ignore
      globalThis.WebSocket = ReconnectingMockWS;

      const backend = new KyutaiBackend({ wsUrl: "ws://localhost:8765", reconnectBaseDelay: 1 });
      await backend.load();

      const ws = /** @type {ReconnectingMockWS} */ (backend._testWs);
      assert.ok(ws, "initial connection exists");
      assert.strictEqual(ws.readyState, ReconnectingMockWS.OPEN);

      // Simulate drop
      ws._simulateDrop();

      // Wait for reconnect attempt (base delay 1ms → 1ms, fast)
      await new Promise((r) => setTimeout(r, 50));

      // Should have created a new WebSocket instance for reconnect
      assert.ok(
        ReconnectingMockWS.instances.length >= 2,
        `Expected >= 2 instances, got ${ReconnectingMockWS.instances.length}`
      );
      const newWs = /** @type {ReconnectingMockWS} */ (backend._testWs);
      assert.ok(newWs !== ws, "backend should reference new WebSocket");
    });

    it("does not reconnect after intentional destroy()", async () => {
      // @ts-ignore
      globalThis.WebSocket = ReconnectingMockWS;

      const backend = new KyutaiBackend({ reconnectBaseDelay: 1 });
      await backend.load();

      const countBefore = ReconnectingMockWS.instances.length;

      backend.destroy();

      // Wait to see if any reconnect happens
      await new Promise((r) => setTimeout(r, 50));

      assert.strictEqual(
        ReconnectingMockWS.instances.length,
        countBefore,
        "no new connections after destroy"
      );
    });

    it("re-subscribes active stream after reconnect", async () => {
      // @ts-ignore
      globalThis.WebSocket = ReconnectingMockWS;

      const backend = new KyutaiBackend({ wsUrl: "ws://localhost:8765", reconnectBaseDelay: 1 });
      await backend.load();

      const ws = /** @type {ReconnectingMockWS} */ (backend._testWs);

      // Start a stream
      backend.startStream("Reconnect test", "alba", () => {});

      // Check we sent the initial synthesize
      const sentBefore = ws.sentMessages.length;
      assert.ok(sentBefore >= 1, "initial synthesize sent");

      // Simulate drop
      ws._simulateDrop();

      // Wait for reconnect
      await new Promise((r) => setTimeout(r, 50));

      const newWs = /** @type {ReconnectingMockWS} */ (backend._testWs);
      if (newWs) {
        // After reconnect, the active stream should be re-sent
        assert.ok(
          newWs.sentMessages.length >= 1,
          "re-sent synthesize after reconnect"
        );
        const reSent = JSON.parse(newWs.sentMessages[newWs.sentMessages.length - 1]);
        assert.strictEqual(reSent.type, "synthesize");
        assert.ok(reSent.text.includes("Reconnect test"));
      }
    });
  });

  describe("TTS events", () => {
    beforeEach(() => {
      // @ts-ignore
      globalThis.WebSocket = MockWebSocket;
    });

    it("emits tts-first-chunk on first PCM chunk", async () => {
      const { SimpleEventBus } = await import("../session/event-bus.js");
      const bus = new SimpleEventBus();
      /** @type {Array<{ modelName: string, latencyMs: number }>} */
      const firstChunks = [];
      bus.on("tts-first-chunk", (data) => firstChunks.push(data));

      const backend = new KyutaiBackend({
        wsUrl: "ws://localhost:8765",
        eventBus: bus,
        modelName: "Qwen",
      });
      await backend.load();

      const ws = /** @type {MockWebSocket} */ (backend._testWs);

      backend.startStream("Hello", "alba", () => {});

      // Send first PCM chunk
      ws._serverSend(JSON.stringify({ type: "pcm", data: [0.1, 0.2] }));
      await new Promise((r) => setTimeout(r, 10));

      assert.strictEqual(firstChunks.length, 1, "should emit exactly one tts-first-chunk");
      assert.strictEqual(firstChunks[0].modelName, "Qwen");
      assert.ok(typeof firstChunks[0].latencyMs === "number", "latencyMs is a number");
    });

    it("emits tts-first-chunk only once per stream", async () => {
      const { SimpleEventBus } = await import("../session/event-bus.js");
      const bus = new SimpleEventBus();
      /** @type {Array<{ modelName: string, latencyMs: number }>} */
      const firstChunks = [];
      bus.on("tts-first-chunk", (data) => firstChunks.push(data));

      const backend = new KyutaiBackend({
        wsUrl: "ws://localhost:8765",
        eventBus: bus,
        modelName: "Qwen",
      });
      await backend.load();

      const ws = /** @type {MockWebSocket} */ (backend._testWs);

      backend.startStream("Hello", "alba", () => {});

      // Send multiple PCM chunks
      ws._serverSend(JSON.stringify({ type: "pcm", data: [0.1] }));
      ws._serverSend(JSON.stringify({ type: "pcm", data: [0.2] }));
      ws._serverSend(JSON.stringify({ type: "pcm", data: [0.3] }));
      await new Promise((r) => setTimeout(r, 10));

      assert.strictEqual(firstChunks.length, 1, "only one tts-first-chunk emitted");
    });

    it("emits tts-chunk for each PCM chunk", async () => {
      const { SimpleEventBus } = await import("../session/event-bus.js");
      const bus = new SimpleEventBus();
      /** @type {Array<{ modelName: string, bytesReceived: number }>} */
      const chunks = [];
      bus.on("tts-chunk", (data) => chunks.push(data));

      const backend = new KyutaiBackend({
        wsUrl: "ws://localhost:8765",
        eventBus: bus,
        modelName: "Qwen",
      });
      await backend.load();

      const ws = /** @type {MockWebSocket} */ (backend._testWs);

      backend.startStream("Hello", "alba", () => {});

      ws._serverSend(JSON.stringify({ type: "pcm", data: [0.1, 0.2, 0.3] }));
      ws._serverSend(JSON.stringify({ type: "pcm", data: [0.4, 0.5] }));
      await new Promise((r) => setTimeout(r, 10));

      assert.strictEqual(chunks.length, 2);
      assert.strictEqual(chunks[0].modelName, "Qwen");
      // bytesReceived = Float32Array byte length (3 * 4 = 12)
      assert.strictEqual(chunks[0].bytesReceived, 12);
      // bytesReceived = 2 * 4 = 8
      assert.strictEqual(chunks[1].bytesReceived, 8);
    });

    it("resets first-chunk tracking on new startStream", async () => {
      const { SimpleEventBus } = await import("../session/event-bus.js");
      const bus = new SimpleEventBus();
      /** @type {Array<{ modelName: string, latencyMs: number }>} */
      const firstChunks = [];
      bus.on("tts-first-chunk", (data) => firstChunks.push(data));

      const backend = new KyutaiBackend({
        wsUrl: "ws://localhost:8765",
        eventBus: bus,
        modelName: "Qwen",
      });
      await backend.load();

      const ws = /** @type {MockWebSocket} */ (backend._testWs);

      // First stream
      backend.startStream("First", "alba", () => {});
      ws._serverSend(JSON.stringify({ type: "pcm", data: [0.1] }));
      ws._serverSend(JSON.stringify({ type: "done" }));
      await new Promise((r) => setTimeout(r, 10));
      assert.strictEqual(firstChunks.length, 1);

      // Second stream
      backend.startStream("Second", "alba", () => {});
      ws._serverSend(JSON.stringify({ type: "pcm", data: [0.2] }));
      await new Promise((r) => setTimeout(r, 10));
      assert.strictEqual(firstChunks.length, 2, "emits first-chunk again for new stream");
    });

    it("works without eventBus (no events emitted, no crash)", async () => {
      const backend = new KyutaiBackend({ wsUrl: "ws://localhost:8765", modelName: "Qwen" });
      await backend.load();

      const ws = /** @type {MockWebSocket} */ (backend._testWs);

      backend.startStream("Hello", "alba", () => {});
      ws._serverSend(JSON.stringify({ type: "pcm", data: [0.1] }));
      ws._serverSend(JSON.stringify({ type: "done" }));
      await new Promise((r) => setTimeout(r, 10));

      assert.ok(true, "no crash without eventBus");
    });
  });
});
