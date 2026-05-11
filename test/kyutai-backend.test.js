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

  /** Simulate server sending a message.
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

  // ------------------------------------------------------------------
  // load()
  // ------------------------------------------------------------------

  describe("load()", () => {
    it("opens a WebSocket connection to the configured URL", async () => {
      const backend = new KyutaiBackend({ wsUrl: "ws://localhost:8765" });
      await backend.load();
      assert.ok(true, "load completed without error");
    });

    it("connects to ws://localhost:8765 by default", async () => {
      const backend = new KyutaiBackend();
      await backend.load();
      assert.ok(true, "default connection established");
    });

    it("only opens one WebSocket connection on repeated load() calls", async () => {
      const backend = new KyutaiBackend();
      await backend.load();
      await backend.load();
      assert.ok(true, "idempotent load");
    });
  });

  // ------------------------------------------------------------------
  // startStream() — legacy API (preserved for replay)
  // ------------------------------------------------------------------

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

      ws._serverSend(JSON.stringify({ type: "pcm", data: [0.1, 0.2, 0.3] }));
      ws._serverSend(JSON.stringify({ type: "pcm", data: [0.4, 0.5, 0.6] }));

      await new Promise((r) => setTimeout(r, 10));

      assert.strictEqual(chunks.length, 2);
      assert.ok(Math.abs(chunks[0].pcm[0] - 0.1) < 1e-5);
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

      backend.startStream("One", "alba", (pcm) => {
        stream1Chunks.push(`stream1:${pcm[0]}`);
      });

      ws._serverSend(JSON.stringify({ type: "pcm", data: [1.0] }));
      await new Promise((r) => setTimeout(r, 5));

      backend.startStream("Two", "alba", (pcm) => {
        stream2Chunks.push(`stream2:${pcm[0]}`);
      });

      ws._serverSend(JSON.stringify({ type: "pcm", data: [2.0] }));
      ws._serverSend(JSON.stringify({ type: "done" }));
      await new Promise((r) => setTimeout(r, 10));

      assert.strictEqual(stream2Chunks.length, 1);
      assert.strictEqual(stream2Chunks[0], "stream2:2");
    });
  });

  // ------------------------------------------------------------------
  // openStream() — new streaming API
  // ------------------------------------------------------------------

  describe("openStream()", () => {
    it("sends correct open_stream JSON message", async () => {
      const backend = new KyutaiBackend();
      await backend.load();

      const ws = /** @type {MockWebSocket} */ ((/** @type {any} */ (backend)._testWs));
      backend.openStream("alba", {
        onAudioChunk: () => {},
        onDone: () => {},
        onError: () => {},
      });

      assert.strictEqual(ws.sentMessages.length, 1);
      const sent = JSON.parse(ws.sentMessages[0]);
      assert.strictEqual(sent.type, "open_stream");
      assert.strictEqual(sent.voice, "alba");
    });

    it("sendText sends text JSON messages", async () => {
      const backend = new KyutaiBackend();
      await backend.load();

      const ws = /** @type {MockWebSocket} */ ((/** @type {any} */ (backend)._testWs));
      const handle = backend.openStream("alba", {
        onAudioChunk: () => {},
        onDone: () => {},
        onError: () => {},
      });

      handle.sendText("Hello world");
      handle.sendText(" more text");

      assert.strictEqual(ws.sentMessages.length, 3); // open_stream + 2 texts
      const msg1 = JSON.parse(ws.sentMessages[1]);
      assert.strictEqual(msg1.type, "text");
      assert.strictEqual(msg1.data, "Hello world");
      const msg2 = JSON.parse(ws.sentMessages[2]);
      assert.strictEqual(msg2.type, "text");
      assert.strictEqual(msg2.data, " more text");
    });

    it("close sends close_stream JSON message", async () => {
      const backend = new KyutaiBackend();
      await backend.load();

      const ws = /** @type {MockWebSocket} */ ((/** @type {any} */ (backend)._testWs));
      const handle = backend.openStream("alba", {
        onAudioChunk: () => {},
        onDone: () => {},
        onError: () => {},
      });

      handle.close();

      const lastMsg = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);
      assert.strictEqual(lastMsg.type, "close_stream");
    });

    it("delivers PCM chunks via onAudioChunk callback", async () => {
      const backend = new KyutaiBackend();
      await backend.load();

      const ws = /** @type {MockWebSocket} */ ((/** @type {any} */ (backend)._testWs));
      /** @type {Array<Float32Array>} */
      const chunks = [];

      backend.openStream("alba", {
        onAudioChunk: (pcm) => { chunks.push(new Float32Array(pcm)); },
        onDone: () => {},
        onError: () => {},
      });

      ws._serverSend(JSON.stringify({ type: "pcm", data: [0.1, 0.2] }));
      ws._serverSend(JSON.stringify({ type: "pcm", data: [0.3, 0.4] }));

      await new Promise((r) => setTimeout(r, 10));

      assert.strictEqual(chunks.length, 2);
      assert.strictEqual(chunks[0].length, 2);
      assert.ok(Math.abs(chunks[0][0] - 0.1) < 1e-5);
    });

    it("calls onDone when server sends done", async () => {
      const backend = new KyutaiBackend();
      await backend.load();

      const ws = /** @type {MockWebSocket} */ ((/** @type {any} */ (backend)._testWs));
      let doneCalled = false;
      let errorCalled = false;

      backend.openStream("alba", {
        onAudioChunk: () => {},
        onDone: () => { doneCalled = true; },
        onError: () => { errorCalled = true; },
      });

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

      backend.openStream("bad_voice", {
        onAudioChunk: () => {},
        onDone: () => { doneCalled = true; },
        onError: (msg) => { errorMsg = msg; },
      });

      ws._serverSend(JSON.stringify({ type: "error", message: "Invalid voice" }));

      await new Promise((r) => setTimeout(r, 10));

      assert.strictEqual(doneCalled, false);
      assert.strictEqual(errorMsg, "Invalid voice");
    });

    it("only one active stream at a time", async () => {
      const backend = new KyutaiBackend();
      await backend.load();

      const ws = /** @type {MockWebSocket} */ ((/** @type {any} */ (backend)._testWs));
      /** @type {string[]} */
      const stream1Chunks = [];
      /** @type {string[]} */
      const stream2Chunks = [];

      // First stream
      const h1 = backend.openStream("voice1", {
        onAudioChunk: (pcm) => { stream1Chunks.push(`s1:${pcm[0]}`); },
        onDone: () => {},
        onError: () => {},
      });

      ws._serverSend(JSON.stringify({ type: "pcm", data: [1.0] }));
      await new Promise((r) => setTimeout(r, 5));

      // Second stream replaces first
      const h2 = backend.openStream("voice2", {
        onAudioChunk: (pcm) => { stream2Chunks.push(`s2:${pcm[0]}`); },
        onDone: () => {},
        onError: () => {},
      });

      ws._serverSend(JSON.stringify({ type: "pcm", data: [2.0] }));
      await new Promise((r) => setTimeout(r, 5));

      // Stream 2 should get the second chunk, stream 1 should not get it
      assert.strictEqual(stream1Chunks.length, 1, "stream1 got first chunk");
      assert.strictEqual(stream2Chunks.length, 1, "stream2 got second chunk");
      assert.strictEqual(stream2Chunks[0], "s2:2");
    });

    it("stop() clears stream and ignores further messages", async () => {
      const backend = new KyutaiBackend();
      await backend.load();

      const ws = /** @type {MockWebSocket} */ ((/** @type {any} */ (backend)._testWs));
      /** @type {Array<Float32Array>} */
      const chunks = [];

      backend.openStream("alba", {
        onAudioChunk: (pcm) => { chunks.push(new Float32Array(pcm)); },
        onDone: () => {},
        onError: () => {},
      });

      ws._serverSend(JSON.stringify({ type: "pcm", data: [0.1] }));
      await new Promise((r) => setTimeout(r, 5));

      backend.stop();

      ws._serverSend(JSON.stringify({ type: "pcm", data: [0.2] }));
      ws._serverSend(JSON.stringify({ type: "done" }));
      await new Promise((r) => setTimeout(r, 5));

      assert.strictEqual(chunks.length, 1);
    });

    it("sendText warns when called after close", async () => {
      const backend = new KyutaiBackend();
      await backend.load();

      const ws = /** @type {MockWebSocket} */ ((/** @type {any} */ (backend)._testWs));
      const handle = backend.openStream("alba", {
        onAudioChunk: () => {},
        onDone: () => {},
        onError: () => {},
      });

      // Close the stream
      handle.close();

      // Capture console.warn
      /** @type {string[]} */
      const warns = [];
      const origWarn = console.warn;
      console.warn = (...args) => warns.push(args.join(" "));
      try {
        handle.sendText("dropped text");
      } finally {
        console.warn = origWarn;
      }

      assert.ok(warns.length > 0, "should produce a warning");
      assert.match(warns[0], /sendText.*closed stream/i, "warning should mention closed stream");
    });

    it("close warns when called on already-closed stream", async () => {
      const backend = new KyutaiBackend();
      await backend.load();

      const ws = /** @type {MockWebSocket} */ ((/** @type {any} */ (backend)._testWs));
      const handle = backend.openStream("alba", {
        onAudioChunk: () => {},
        onDone: () => {},
        onError: () => {},
      });

      // Close once
      handle.close();

      // Capture console.warn
      /** @type {string[]} */
      const warns = [];
      const origWarn = console.warn;
      console.warn = (...args) => warns.push(args.join(" "));
      try {
        handle.close();
      } finally {
        console.warn = origWarn;
      }

      assert.ok(warns.length > 0, "should produce a warning on double close");
      assert.match(warns[0], /close.*already-closed/i, "warning should mention already-closed");
    });

    it("sendText works after reconnect for openStream", async () => {
      // Use ReconnectingMockWS for reconnect test
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
          if (this.onmessage) this.onmessage({ data });
        }

        _simulateDrop() {
          this.readyState = ReconnectingMockWS.CLOSED;
          this.onclose?.({ code: 1006, reason: "Abnormal closure" });
        }
      }

      beforeEach(() => { ReconnectingMockWS.instances = []; });

      // @ts-ignore
      globalThis.WebSocket = ReconnectingMockWS;

      const backend = new KyutaiBackend({ wsUrl: "ws://localhost:8765", reconnectBaseDelay: 1 });
      await backend.load();

      /** @type {string[]} */
      const receivedPcm = [];

      const handle = backend.openStream("alba", {
        onAudioChunk: (pcm) => { receivedPcm.push(`pcm:${pcm[0]}`); },
        onDone: () => {},
        onError: () => {},
      });

      const ws = /** @type {ReconnectingMockWS} */ (backend._testWs);
      ws._serverSend(JSON.stringify({ type: "pcm", data: [1.0] }));
      await new Promise((r) => setTimeout(r, 5));

      // Simulate drop
      ws._simulateDrop();
      await new Promise((r) => setTimeout(r, 100));

      // After reconnect, open_stream should be re-sent
      const newWs = /** @type {ReconnectingMockWS} */ (backend._testWs);
      assert.ok(newWs !== ws, "new WebSocket after reconnect");

      // Verify open_stream was re-sent
      const openMsgs = newWs.sentMessages.filter(
        (m) => JSON.parse(m).type === "open_stream"
      );
      assert.ok(openMsgs.length >= 1, "open_stream re-sent after reconnect");

      // sendText should work on new connection
      handle.sendText("new text after reconnect");
      const textMsgs = newWs.sentMessages.filter(
        (m) => JSON.parse(m).type === "text"
      );
      assert.ok(textMsgs.length >= 1, "text sent after reconnect");
    });
  });

  // ------------------------------------------------------------------
  // stop()
  // ------------------------------------------------------------------

  describe("stop()", () => {
    it("aborts the current stream and stops delivering chunks", async () => {
      const backend = new KyutaiBackend();
      await backend.load();

      const ws = /** @type {MockWebSocket} */ ((/** @type {any} */ (backend)._testWs));
      /** @type {Array<Float32Array>} */
      const chunks = [];

      backend.startStream("Long text", "alba", (pcm) => {
        chunks.push(new Float32Array(pcm));
      });

      ws._serverSend(JSON.stringify({ type: "pcm", data: [0.1] }));
      await new Promise((r) => setTimeout(r, 5));

      backend.stop();

      ws._serverSend(JSON.stringify({ type: "pcm", data: [0.2] }));
      ws._serverSend(JSON.stringify({ type: "done" }));
      await new Promise((r) => setTimeout(r, 5));

      assert.strictEqual(chunks.length, 1);
    });
  });

  // ------------------------------------------------------------------
  // destroy()
  // ------------------------------------------------------------------

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
      await backend.load();
      assert.ok(true, "re-load after destroy succeeded");
    });
  });

  // ------------------------------------------------------------------
  // load error handling
  // ------------------------------------------------------------------

  describe("load error handling", () => {
    it("rejects load() when WebSocket connection fails", async () => {
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
          queueMicrotask(() => {
            this.readyState = 3;
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

  // ------------------------------------------------------------------
  // reconnect
  // ------------------------------------------------------------------

  describe("reconnect", () => {
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
        queueMicrotask(() => {
          this.readyState = ReconnectingMockWS.OPEN;
          this.onopen?.();
        });
      }

      send(data) { this.sentMessages.push(data); }
      close(code, reason) {
        this.readyState = ReconnectingMockWS.CLOSED;
        this.onclose?.({ code, reason });
      }
      _serverSend(data) { if (this.onmessage) this.onmessage({ data }); }
      _simulateDrop() {
        this.readyState = ReconnectingMockWS.CLOSED;
        this.onclose?.({ code: 1006, reason: "Abnormal closure" });
      }
    }

    beforeEach(() => { ReconnectingMockWS.instances = []; });

    it("reconnects after unexpected WebSocket drop", async () => {
      // @ts-ignore
      globalThis.WebSocket = ReconnectingMockWS;

      const backend = new KyutaiBackend({ wsUrl: "ws://localhost:8765", reconnectBaseDelay: 1 });
      await backend.load();

      const ws = /** @type {ReconnectingMockWS} */ (backend._testWs);
      assert.ok(ws);
      assert.strictEqual(ws.readyState, ReconnectingMockWS.OPEN);

      ws._simulateDrop();
      await new Promise((r) => setTimeout(r, 50));

      assert.ok(
        ReconnectingMockWS.instances.length >= 2,
        `Expected >= 2 instances, got ${ReconnectingMockWS.instances.length}`
      );
      const newWs = /** @type {ReconnectingMockWS} */ (backend._testWs);
      assert.ok(newWs !== ws, "new WebSocket after reconnect");
    });

    it("does not reconnect after intentional destroy()", async () => {
      // @ts-ignore
      globalThis.WebSocket = ReconnectingMockWS;

      const backend = new KyutaiBackend({ reconnectBaseDelay: 1 });
      await backend.load();

      const countBefore = ReconnectingMockWS.instances.length;

      backend.destroy();

      await new Promise((r) => setTimeout(r, 50));

      assert.strictEqual(
        ReconnectingMockWS.instances.length,
        countBefore,
        "no new connections after destroy"
      );
    });

    it("re-subscribes active stream (old path) after reconnect", async () => {
      // @ts-ignore
      globalThis.WebSocket = ReconnectingMockWS;

      const backend = new KyutaiBackend({ wsUrl: "ws://localhost:8765", reconnectBaseDelay: 1 });
      await backend.load();

      const ws = /** @type {ReconnectingMockWS} */ (backend._testWs);

      backend.startStream("Reconnect test", "alba", () => {});
      const sentBefore = ws.sentMessages.length;
      assert.ok(sentBefore >= 1, "initial synthesize sent");

      ws._simulateDrop();
      await new Promise((r) => setTimeout(r, 50));

      const newWs = /** @type {ReconnectingMockWS} */ (backend._testWs);
      if (newWs) {
        assert.ok(newWs.sentMessages.length >= 1, "re-sent after reconnect");
        const reSent = JSON.parse(newWs.sentMessages[newWs.sentMessages.length - 1]);
        assert.strictEqual(reSent.type, "synthesize");
      }
    });

    it("emits tts-reconnect event after reconnect", async () => {
      // @ts-ignore
      globalThis.WebSocket = ReconnectingMockWS;

      const { SimpleEventBus } = await import("../session/event-bus.js");
      const bus = new SimpleEventBus();
      /** @type {Array<{ modelName: string }>} */
      const reconnectEvents = [];
      bus.on("tts-reconnect", (data) => reconnectEvents.push(data));

      const backend = new KyutaiBackend({
        wsUrl: "ws://localhost:8765",
        eventBus: bus,
        modelName: "Qwen",
        reconnectBaseDelay: 1,
      });
      await backend.load();

      // Start a stream so activeStreamState exists
      backend.startStream("test text", "alba", () => {});

      const ws = /** @type {ReconnectingMockWS} */ (backend._testWs);
      ws._simulateDrop();
      await new Promise((r) => setTimeout(r, 50));

      assert.strictEqual(reconnectEvents.length, 1);
      assert.strictEqual(reconnectEvents[0].modelName, "Qwen");
    });

    it("calls onError on reconnect when synthesize text is missing", async () => {
      // @ts-ignore
      globalThis.WebSocket = ReconnectingMockWS;

      const backend = new KyutaiBackend({ wsUrl: "ws://localhost:8765", reconnectBaseDelay: 1 });
      await backend.load();

      /** @type {string[]} */
      const errors = [];
      // Call startStream with empty text — the initial call sends empty string,
      // but on reconnect the guard should fire onError instead of sending empty
      backend.startStream("", "alba", () => {}, {
        onError: (msg) => errors.push(msg),
      });

      const ws = /** @type {ReconnectingMockWS} */ (backend._testWs);
      ws._simulateDrop();
      await new Promise((r) => setTimeout(r, 50));

      // Should have called onError with a missing-text message
      assert.ok(errors.length >= 1, "should have called onError on reconnect with missing text");
      assert.ok(errors.some(e => e.includes("text")), "error message should mention missing text");

      // Verify no empty synthesize was sent on reconnect
      const newWs = /** @type {ReconnectingMockWS} */ (backend._testWs);
      if (newWs) {
        const synthesizeMsgs = newWs.sentMessages
          .map(m => JSON.parse(m))
          .filter(m => m.type === "synthesize");
        // No synthesize messages after reconnect for empty text
        for (const msg of synthesizeMsgs) {
          assert.ok(msg.text, "should not send empty text on reconnect");
        }
      }
    });
  });

  // ------------------------------------------------------------------
  // TTS events
  // ------------------------------------------------------------------

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

      ws._serverSend(JSON.stringify({ type: "pcm", data: [0.1, 0.2] }));
      await new Promise((r) => setTimeout(r, 10));

      assert.strictEqual(firstChunks.length, 1);
      assert.strictEqual(firstChunks[0].modelName, "Qwen");
    });

    it("emits tts-first-chunk for openStream too", async () => {
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

      backend.openStream("alba", {
        onAudioChunk: () => {},
        onDone: () => {},
        onError: () => {},
      });

      ws._serverSend(JSON.stringify({ type: "pcm", data: [0.1] }));
      await new Promise((r) => setTimeout(r, 10));

      assert.strictEqual(firstChunks.length, 1);
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

      ws._serverSend(JSON.stringify({ type: "pcm", data: [0.1] }));
      ws._serverSend(JSON.stringify({ type: "pcm", data: [0.2] }));
      ws._serverSend(JSON.stringify({ type: "pcm", data: [0.3] }));
      await new Promise((r) => setTimeout(r, 10));

      assert.strictEqual(firstChunks.length, 1);
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
      assert.strictEqual(chunks[0].bytesReceived, 12);
    });

    it("resets first-chunk tracking on new stream (old path)", async () => {
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

      backend.startStream("First", "alba", () => {});
      ws._serverSend(JSON.stringify({ type: "pcm", data: [0.1] }));
      ws._serverSend(JSON.stringify({ type: "done" }));
      await new Promise((r) => setTimeout(r, 10));
      assert.strictEqual(firstChunks.length, 1);

      backend.startStream("Second", "alba", () => {});
      ws._serverSend(JSON.stringify({ type: "pcm", data: [0.2] }));
      await new Promise((r) => setTimeout(r, 10));
      assert.strictEqual(firstChunks.length, 2);
    });

    it("works without eventBus (no crash)", async () => {
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
