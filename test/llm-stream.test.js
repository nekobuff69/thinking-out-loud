import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { streamReasoning } from "../llm/llm-stream.js";

/**
 * Creates a minimal ReadableStream that emits SSE data and [DONE].
 * @param {string} data
 * @returns {ReadableStream<Uint8Array>}
 */
function sseStream(data) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(data));
      controller.close();
    },
  });
}

describe("streamReasoning URL construction", () => {
  /** @type {typeof fetch} */
  let originalFetch;
  /** @type {string | null} */
  let capturedUrl = null;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    capturedUrl = null;
    globalThis.fetch = /** @type {typeof fetch} */ (async (url, init) => {
      capturedUrl = /** @type {string} */ (url);
      return new Response(sseStream("data: [DONE]\n\n"), { status: 200 });
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /**
   * Helper to extract just the path from a full URL for assertion clarity.
   * @param {string} fullUrl
   * @returns {string}
   */
  function urlPath(fullUrl) {
    return new URL(fullUrl).pathname;
  }

  it("constructs endpoint without double-slash when url has trailing slash", async () => {
    await streamReasoning(
      "http://localhost:1234/v1/",
      "test-model",
      "system",
      "question",
      { onDone: () => {} }
    );
    assert.strictEqual(urlPath(/** @type {string} */ (capturedUrl)), "/v1/chat/completions");
  });

  it("constructs endpoint correctly when url has no trailing slash", async () => {
    await streamReasoning(
      "http://localhost:1234/v1",
      "test-model",
      "system",
      "question",
      { onDone: () => {} }
    );
    assert.strictEqual(urlPath(/** @type {string} */ (capturedUrl)), "/v1/chat/completions");
  });

  it("handles url that already ends with /chat/completions", async () => {
    await streamReasoning(
      "http://localhost:1234/v1/chat/completions",
      "test-model",
      "system",
      "question",
      { onDone: () => {} }
    );
    assert.strictEqual(urlPath(/** @type {string} */ (capturedUrl)), "/v1/chat/completions");
  });

  it("handles url with /chat/completions and trailing slash", async () => {
    await streamReasoning(
      "http://localhost:1234/v1/chat/completions/",
      "test-model",
      "system",
      "question",
      { onDone: () => {} }
    );
    // Trailing slash is normalized away — valid endpoint
    assert.strictEqual(urlPath(/** @type {string} */ (capturedUrl)), "/v1/chat/completions");
  });
});
