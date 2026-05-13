import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal valid WAV buffer (24kHz mono float32 PCM).
 * @param {Float32Array} samples
 * @param {number} [sampleRate=24000]
 * @returns {Uint8Array}
 */
function createWavBuffer(samples, sampleRate = 24000) {
  const numChannels = 1;
  const bitsPerSample = 32;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const fileSize = 36 + dataSize;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  let off = 0;

  const enc = new TextEncoder();
  const write4cc = (s) => { const b = enc.encode(s); for (let i = 0; i < 4; i++) view.setUint8(off++, b[i]); };

  // RIFF
  write4cc("RIFF");
  view.setUint32(off, fileSize, true); off += 4;
  write4cc("WAVE");

  // fmt
  write4cc("fmt ");
  view.setUint32(off, 16, true); off += 4;       // chunk size
  view.setUint16(off, 3, true); off += 2;         // IEEE float
  view.setUint16(off, numChannels, true); off += 2;
  view.setUint32(off, sampleRate, true); off += 4;
  view.setUint32(off, byteRate, true); off += 4;
  view.setUint16(off, blockAlign, true); off += 2;
  view.setUint16(off, bitsPerSample, true); off += 2;

  // data
  write4cc("data");
  view.setUint32(off, dataSize, true); off += 4;
  for (let i = 0; i < samples.length; i++) {
    view.setFloat32(off, samples[i], true);
    off += 4;
  }

  return new Uint8Array(buffer);
}

/**
 * Create a Response whose body streams chunks of a Uint8Array.
 * @param {Uint8Array} data
 * @param {{ status?: number, headers?: Record<string,string> }} [opts]
 * @returns {Response}
 */
function streamingResponse(data, opts = {}) {
  const { status = 200, headers = { "Content-Type": "audio/wav" } } = opts;
  const stream = new ReadableStream({
    start(controller) {
      const chunkSize = 64;
      for (let i = 0; i < data.length; i += chunkSize) {
        controller.enqueue(data.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
  return new Response(stream, { status, headers });
}

/**
 * Create a Response that errors after a delay (simulates network failure).
 * @param {number} delayMs
 * @returns {Response}
 */
function errorAfterStream(delayMs) {
  const stream = new ReadableStream({
    start(controller) {
      const chunk = new Uint8Array(8);
      controller.enqueue(chunk);
      setTimeout(() => controller.error(new Error("Network error")), delayMs);
    },
  });
  return new Response(stream, { status: 200 });
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

/** @type {Array<{url: string, init?: RequestInit}>} */
let fetchCalls;
/** @type {typeof globalThis.fetch} */
let originalFetch;

// Import (after mocks are set up conceptually — JS hoists imports)
import { PocketTtsBackend } from "../tts/pocket-tts-backend.js";

describe("PocketTtsBackend", () => {
  beforeEach(() => {
    fetchCalls = [];
    originalFetch = globalThis.fetch;
    // Default fetch: health returns 200, TTS returns empty WAV with one zero sample
    globalThis.fetch = /** @type {typeof fetch} */ (async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      const urlStr = String(url);
      if (urlStr.endsWith("/health")) {
        return new Response(null, { status: 200 });
      }
      if (urlStr.endsWith("/v1/tts")) {
        const samples = new Float32Array([0.0]);
        const wav = createWavBuffer(samples);
        return streamingResponse(wav);
      }
      return new Response(null, { status: 404 });
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ------------------------------------------------------------------
  // load()
  // ------------------------------------------------------------------

  describe("load()", () => {
    it("fetches GET /health and resolves on 200", async () => {
      const backend = new PocketTtsBackend({ serverUrl: "http://localhost:8765" });
      await backend.load();

      assert.strictEqual(fetchCalls.length, 1);
      assert.strictEqual(fetchCalls[0].url, "http://localhost:8765/health");
      assert.strictEqual(fetchCalls[0].init?.method, undefined); // GET is default
    });

    it("uses default serverUrl http://localhost:8765", async () => {
      const backend = new PocketTtsBackend();
      await backend.load();
      assert.strictEqual(fetchCalls[0].url, "http://localhost:8765/health");
    });

    it("throws when server is unreachable (fetch rejects)", async () => {
      globalThis.fetch = /** @type {typeof fetch} */ (async () => {
        throw new Error("Connection refused");
      });

      const backend = new PocketTtsBackend();
      await assert.rejects(
        () => backend.load(),
        /Connection refused/
      );
    });

    it("throws on non-200 health response", async () => {
      globalThis.fetch = /** @type {typeof fetch} */ (async () => {
        return new Response(null, { status: 503 });
      });

      const backend = new PocketTtsBackend();
      await assert.rejects(
        () => backend.load(),
        /health check failed.*503/
      );
    });
  });

  // ------------------------------------------------------------------
  // startStream()
  // ------------------------------------------------------------------

  describe("startStream()", () => {
    it("sends correct POST body with {text, voice}", async () => {
      const backend = new PocketTtsBackend();
      await backend.load();

      const samples = new Float32Array([0.1, 0.2, 0.3]);
      const wav = createWavBuffer(samples);

      globalThis.fetch = /** @type {typeof fetch} */ (async (url, init) => {
        const urlStr = String(url);
        if (urlStr.endsWith("/health")) {
          return new Response(null, { status: 200 });
        }
        fetchCalls.push({ url: urlStr, init });
        return streamingResponse(wav);
      });

      /** @type {Array<{pcm: Float32Array, sampleRate: number}>} */
      const chunks = [];

      let doneCalled = false;
      backend.startStream("Hello world", "default", (pcm, sr) => {
        chunks.push({ pcm: new Float32Array(pcm), sampleRate: sr });
      }, { onDone: () => { doneCalled = true; } });

      // Wait for async stream processing
      await new Promise((r) => setTimeout(r, 100));

      const ttsCall = fetchCalls.find((c) => c.url.endsWith("/v1/tts"));
      assert.ok(ttsCall, "should have called /v1/tts");
      assert.strictEqual(ttsCall.init?.method, "POST");
      assert.strictEqual(
        ttsCall.init?.headers?.["Content-Type"] || ttsCall.init?.headers?.get?.("Content-Type"),
        "application/json"
      );

      const body = JSON.parse(/** @type {string} */ (ttsCall.init?.body));
      assert.strictEqual(body.text, "Hello world");
      assert.strictEqual(body.voice, "default");

      assert.ok(chunks.length > 0, "should have received PCM chunks");
      assert.ok(doneCalled, "onDone should have been called");
    });

    it("delivers PCM chunks parsed from streaming WAV", async () => {
      const backend = new PocketTtsBackend();
      await backend.load();

      const sourceSamples = new Float32Array([0.1, -0.2, 0.3, -0.4, 0.5]);
      const wav = createWavBuffer(sourceSamples, 24000);

      globalThis.fetch = /** @type {typeof fetch} */ (async (url, init) => {
        const urlStr = String(url);
        if (urlStr.endsWith("/health")) return new Response(null, { status: 200 });
        return streamingResponse(wav);
      });

      /** @type {Array<Float32Array>} */
      const chunks = [];
      let doneCalled = false;

      backend.startStream("test", "default", (pcm) => {
        chunks.push(new Float32Array(pcm));
      }, { onDone: () => { doneCalled = true; } });

      await new Promise((r) => setTimeout(r, 150));

      assert.ok(chunks.length >= 1, "should have at least one chunk");
      // All chunks combined should have the right sample count
      const totalSamples = chunks.reduce((s, c) => s + c.length, 0);
      assert.strictEqual(totalSamples, sourceSamples.length);
      // Verify first few samples
      const combined = new Float32Array(totalSamples);
      let off = 0;
      for (const c of chunks) { combined.set(c, off); off += c.length; }
      assert.ok(Math.abs(combined[0] - 0.1) < 1e-5);
      assert.ok(Math.abs(combined[1] - (-0.2)) < 1e-5);
      assert.ok(doneCalled);
    });

    it("calls onDone after stream completes", async () => {
      const backend = new PocketTtsBackend();
      await backend.load();

      const samples = new Float32Array([0.1, 0.2]);
      const wav = createWavBuffer(samples);

      globalThis.fetch = /** @type {typeof fetch} */ (async (url, init) => {
        const urlStr = String(url);
        if (urlStr.endsWith("/health")) return new Response(null, { status: 200 });
        return streamingResponse(wav);
      });

      let doneCalled = false;
      let errorCalled = false;

      backend.startStream("hello", "default", () => {}, {
        onDone: () => { doneCalled = true; },
        onError: () => { errorCalled = true; },
      });

      await new Promise((r) => setTimeout(r, 100));

      assert.strictEqual(doneCalled, true);
      assert.strictEqual(errorCalled, false);
    });

    it("calls onError on non-200 server response", async () => {
      const backend = new PocketTtsBackend();
      await backend.load();

      globalThis.fetch = /** @type {typeof fetch} */ (async (url, init) => {
        const urlStr = String(url);
        if (urlStr.endsWith("/health")) return new Response(null, { status: 200 });
        return new Response(null, { status: 500 });
      });

      let doneCalled = false;
      let errorMsg = "";

      backend.startStream("hello", "default", () => {}, {
        onDone: () => { doneCalled = true; },
        onError: (msg) => { errorMsg = msg; },
      });

      await new Promise((r) => setTimeout(r, 50));

      assert.strictEqual(doneCalled, false);
      assert.match(errorMsg, /500/);
    });

    it("calls onError on network error mid-stream", async () => {
      const backend = new PocketTtsBackend();
      await backend.load();

      globalThis.fetch = /** @type {typeof fetch} */ (async (url, init) => {
        const urlStr = String(url);
        if (urlStr.endsWith("/health")) return new Response(null, { status: 200 });
        return errorAfterStream(5);
      });

      let doneCalled = false;
      let errorMsg = "";

      backend.startStream("hello", "default", () => {}, {
        onDone: () => { doneCalled = true; },
        onError: (msg) => { errorMsg = msg; },
      });

      await new Promise((r) => setTimeout(r, 100));

      assert.strictEqual(doneCalled, false);
      assert.ok(errorMsg.length > 0, "should have error message");
    });

    it("handles 16-bit PCM WAV by converting to float32", async () => {
      const backend = new PocketTtsBackend();
      await backend.load();

      // Create a 16-bit PCM WAV instead of float32
      function create16bitWav(samples, sampleRate = 24000) {
        const numChannels = 1;
        const bitsPerSample = 16;
        const bytesPerSample = bitsPerSample / 8;
        const blockAlign = numChannels * bytesPerSample;
        const byteRate = sampleRate * blockAlign;
        const dataSize = samples.length * bytesPerSample;
        const fileSize = 36 + dataSize;

        const buffer = new ArrayBuffer(44 + dataSize);
        const view = new DataView(buffer);
        let off = 0;
        const enc = new TextEncoder();
        const w4 = (s) => { const b = enc.encode(s); for (let i = 0; i < 4; i++) view.setUint8(off++, b[i]); };

        w4("RIFF");
        view.setUint32(off, fileSize, true); off += 4;
        w4("WAVE");
        w4("fmt ");
        view.setUint32(off, 16, true); off += 4;
        view.setUint16(off, 1, true); off += 2;  // PCM (not float)
        view.setUint16(off, numChannels, true); off += 2;
        view.setUint32(off, sampleRate, true); off += 4;
        view.setUint32(off, byteRate, true); off += 4;
        view.setUint16(off, blockAlign, true); off += 2;
        view.setUint16(off, bitsPerSample, true); off += 2;
        w4("data");
        view.setUint32(off, dataSize, true); off += 4;
        for (let i = 0; i < samples.length; i++) {
          view.setInt16(off, Math.round(samples[i] * 32767), true);
          off += 2;
        }
        return new Uint8Array(buffer);
      }

      const sourceSamples = new Float32Array([0.5, -0.25, 0.75]);
      const wav = create16bitWav(sourceSamples);

      globalThis.fetch = /** @type {typeof fetch} */ (async (url, init) => {
        const urlStr = String(url);
        if (urlStr.endsWith("/health")) return new Response(null, { status: 200 });
        return streamingResponse(wav);
      });

      /** @type {Array<Float32Array>} */
      const chunks = [];
      let doneCalled = false;

      backend.startStream("test", "default", (pcm) => {
        chunks.push(new Float32Array(pcm));
      }, { onDone: () => { doneCalled = true; } });

      await new Promise((r) => setTimeout(r, 100));

      assert.ok(doneCalled, "onDone should have been called");
      assert.ok(chunks.length >= 1, "should have at least one chunk");
      const totalSamples = chunks.reduce((s, c) => s + c.length, 0);
      assert.strictEqual(totalSamples, sourceSamples.length);

      // Verify conversion (int16 → float32, allowing ~0.001 tolerance)
      const combined = new Float32Array(totalSamples);
      let off = 0;
      for (const c of chunks) { combined.set(c, off); off += c.length; }
      assert.ok(Math.abs(combined[0] - 0.5) < 0.001, `expected ~0.5, got ${combined[0]}`);
      assert.ok(Math.abs(combined[1] - (-0.25)) < 0.001, `expected ~-0.25, got ${combined[1]}`);
    });
  });

  // ------------------------------------------------------------------
  // stop()
  // ------------------------------------------------------------------

  describe("stop()", () => {
    it("aborts in-flight fetch and prevents callbacks", async () => {
      const backend = new PocketTtsBackend();
      await backend.load();

      // Simulate a slow response that never completes
      globalThis.fetch = /** @type {typeof fetch} */ (async (url, init) => {
        const urlStr = String(url);
        if (urlStr.endsWith("/health")) return new Response(null, { status: 200 });
        // Return a promise that hangs
        return new Promise(() => {}); // never resolves
      });

      let doneCalled = false;
      let errorCalled = false;

      backend.startStream("hello", "default", () => {}, {
        onDone: () => { doneCalled = true; },
        onError: () => { errorCalled = true; },
      });

      // Give it a moment to start
      await new Promise((r) => setTimeout(r, 10));
      backend.stop();

      // Wait to verify no callbacks fire
      await new Promise((r) => setTimeout(r, 50));

      assert.strictEqual(doneCalled, false);
      // AbortError is caught internally and not forwarded to onError
      assert.strictEqual(errorCalled, false);
    });

    it("stop() before startStream is a no-op", () => {
      const backend = new PocketTtsBackend();
      // Should not throw
      backend.stop();
      assert.ok(true);
    });

    it("stop() prevents onDone after abort", async () => {
      const backend = new PocketTtsBackend();
      await backend.load();

      let fetchResolve;
      globalThis.fetch = /** @type {typeof fetch} */ (async (url, init) => {
        const urlStr = String(url);
        if (urlStr.endsWith("/health")) return new Response(null, { status: 200 });
        return new Promise((resolve) => { fetchResolve = resolve; });
      });

      let doneCalled = false;
      backend.startStream("hello", "default", () => {}, {
        onDone: () => { doneCalled = true; },
      });

      await new Promise((r) => setTimeout(r, 10));
      backend.stop();

      // Now resolve the fetch — should not trigger callbacks since stop() aborted
      const samples = new Float32Array([0.1]);
      const wav = createWavBuffer(samples);
      fetchResolve?.(streamingResponse(wav));

      await new Promise((r) => setTimeout(r, 50));
      assert.strictEqual(doneCalled, false);
    });
  });

  // ------------------------------------------------------------------
  // destroy()
  // ------------------------------------------------------------------

  describe("destroy()", () => {
    it("aborts in-flight fetch and cleans up", async () => {
      const backend = new PocketTtsBackend();
      await backend.load();

      globalThis.fetch = /** @type {typeof fetch} */ (async (url, init) => {
        const urlStr = String(url);
        if (urlStr.endsWith("/health")) return new Response(null, { status: 200 });
        return new Promise(() => {}); // hang
      });

      let errorCalled = false;
      backend.startStream("hello", "default", () => {}, {
        onError: () => { errorCalled = true; },
      });

      await new Promise((r) => setTimeout(r, 10));
      backend.destroy();

      await new Promise((r) => setTimeout(r, 30));
      assert.strictEqual(errorCalled, false);
    });

    it("destroy() on idle backend does not throw", () => {
      const backend = new PocketTtsBackend();
      backend.destroy();
      assert.ok(true);
    });
  });

  // ------------------------------------------------------------------
  // Multiple startStream calls
  // ------------------------------------------------------------------

  describe("multiple startStream calls", () => {
    it("second startStream aborts first in-flight request", async () => {
      const backend = new PocketTtsBackend();
      await backend.load();

      /** @type {Array<{text: string, aborted: boolean}>} */
      const requestLog = [];
      /** @type {Array<AbortController>} */
      const controllers = [];

      globalThis.fetch = /** @type {typeof fetch} */ (async (url, init) => {
        const urlStr = String(url);
        if (urlStr.endsWith("/health")) return new Response(null, { status: 200 });

        const signal = init?.signal;
        const entry = { text: "", aborted: false };
        if (init?.body) {
          try { entry.text = JSON.parse(String(init.body)).text; } catch {}
        }
        requestLog.push(entry);

        if (signal) {
          signal.addEventListener("abort", () => { entry.aborted = true; });
          // Hang forever unless aborted
          return new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          });
        }
        return new Promise(() => {});
      });

      let stream1Done = false;
      let stream2Done = false;

      backend.startStream("first", "default", () => {}, {
        onDone: () => { stream1Done = true; },
      });

      await new Promise((r) => setTimeout(r, 10));

      // Second call should abort first
      backend.startStream("second", "default", () => {}, {
        onDone: () => { stream2Done = true; },
      });

      await new Promise((r) => setTimeout(r, 30));

      assert.strictEqual(requestLog.length, 2);
      assert.strictEqual(requestLog[0].text, "first");
      assert.strictEqual(requestLog[0].aborted, true);
      assert.strictEqual(requestLog[1].text, "second");
      assert.strictEqual(stream1Done, false);
    });
  });
});
