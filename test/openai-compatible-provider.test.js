import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { OpenAICompatibleProvider } from "../llm/providers/openai-compatible-provider.js";

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

describe("OpenAICompatibleProvider", () => {
  /** @type {typeof fetch} */
  let originalFetch;
  /** @type {string | null} */
  let capturedUrl = null;
  /** @type {string | null} */
  let capturedBody = null;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    capturedUrl = null;
    capturedBody = null;
    globalThis.fetch = /** @type {typeof fetch} */ (async (url, init) => {
      capturedUrl = /** @type {string} */ (url);
      if (init && typeof init.body === "string") {
        capturedBody = init.body;
      }
      return new Response(sseStream("data: [DONE]\n\n"), { status: 200 });
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function urlPath(fullUrl) {
    return new URL(fullUrl).pathname;
  }

  it("streams reasoning tokens with 'separate' format (delta.reasoning_content)", async () => {
    globalThis.fetch = /** @type {typeof fetch} */ (async () => {
      return new Response(
        sseStream(
          'data: {"choices":[{"delta":{"reasoning_content":"Hello"}}]}\n\n' +
          'data: {"choices":[{"delta":{"reasoning_content":" world"}}]}\n\n' +
          "data: [DONE]\n\n"
        ),
        { status: 200 }
      );
    });

    const provider = new OpenAICompatibleProvider({
      url: "http://localhost:1234/v1",
      model: "test-model",
      reasoningFormat: "separate",
    });

    const tokens = [];
    await provider.streamReasoning(
      "What is life?",
      "Think deeply",
      {
        onReasoningToken: (token) => tokens.push(token),
        onDone: () => {},
      }
    );

    assert.deepStrictEqual(tokens, ["Hello", " world"]);
  });

  it("streams reasoning tokens with 'separate' format (delta.reasoning fallback)", async () => {
    globalThis.fetch = /** @type {typeof fetch} */ (async () => {
      return new Response(
        sseStream(
          'data: {"choices":[{"delta":{"reasoning":"First"}}]}\n\n' +
          'data: {"choices":[{"delta":{"reasoning":" second"}}]}\n\n' +
          "data: [DONE]\n\n"
        ),
        { status: 200 }
      );
    });

    const provider = new OpenAICompatibleProvider({
      url: "http://localhost:1234/v1",
      model: "test-model",
      reasoningFormat: "separate",
    });

    const tokens = [];
    await provider.streamReasoning(
      "What is life?",
      "Think deeply",
      {
        onReasoningToken: (token) => tokens.push(token),
        onDone: () => {},
      }
    );

    assert.deepStrictEqual(tokens, ["First", " second"]);
  });

  it("fires onContentStart when content tokens arrive in 'separate' format", async () => {
    globalThis.fetch = /** @type {typeof fetch} */ (async () => {
      return new Response(
        sseStream(
          'data: {"choices":[{"delta":{"reasoning_content":"Reason"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"Answer"}}]}\n\n' +
          "data: [DONE]\n\n"
        ),
        { status: 200 }
      );
    });

    const provider = new OpenAICompatibleProvider({
      url: "http://localhost:1234/v1",
      model: "test-model",
      reasoningFormat: "separate",
    });

    let contentStarted = false;
    await provider.streamReasoning(
      "What is life?",
      "Think deeply",
      {
        onReasoningToken: () => {},
        onContentStart: () => {
          contentStarted = true;
        },
        onDone: () => {},
      }
    );

    assert.ok(contentStarted, "onContentStart should fire when content arrives");
  });

  it("extracts reasoning from <think> tags in 'tagged' format", async () => {
    globalThis.fetch = /** @type {typeof fetch} */ (async () => {
      return new Response(
        sseStream(
          'data: {"choices":[{"delta":{"content":"<think>"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"Let me think"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":" about this"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"</think>"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"The answer is 42"}}]}\n\n' +
          "data: [DONE]\n\n"
        ),
        { status: 200 }
      );
    });

    const provider = new OpenAICompatibleProvider({
      url: "http://localhost:1234/v1",
      model: "test-model",
      reasoningFormat: "tagged",
    });

    const tokens = [];
    let contentStarted = false;
    await provider.streamReasoning(
      "What is life?",
      "Think deeply",
      {
        onReasoningToken: (token) => tokens.push(token),
        onContentStart: () => {
          contentStarted = true;
        },
        onDone: () => {},
      }
    );

    assert.deepStrictEqual(tokens, ["Let me think", " about this"]);
    assert.ok(contentStarted, "onContentStart should fire when content outside tags arrives");
  });

  it("treats all content as reasoning in 'none' format", async () => {
    globalThis.fetch = /** @type {typeof fetch} */ (async () => {
      return new Response(
        sseStream(
          'data: {"choices":[{"delta":{"content":"All"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":" content"}}]}\n\n' +
          "data: [DONE]\n\n"
        ),
        { status: 200 }
      );
    });

    const provider = new OpenAICompatibleProvider({
      url: "http://localhost:1234/v1",
      model: "test-model",
      reasoningFormat: "none",
    });

    const tokens = [];
    await provider.streamReasoning(
      "What is life?",
      "Think deeply",
      {
        onReasoningToken: (token) => tokens.push(token),
        onDone: () => {},
      }
    );

    assert.deepStrictEqual(tokens, ["All", " content"]);
  });

  it("defaults to 'separate' when reasoningFormat is omitted", async () => {
    globalThis.fetch = /** @type {typeof fetch} */ (async () => {
      return new Response(
        sseStream(
          'data: {"choices":[{"delta":{"reasoning_content":"ok"}}]}\n\n' +
          "data: [DONE]\n\n"
        ),
        { status: 200 }
      );
    });

    const provider = new OpenAICompatibleProvider({
      url: "http://localhost:1234/v1",
      model: "test-model",
    });

    const tokens = [];
    await provider.streamReasoning(
      "What is life?",
      "Think deeply",
      {
        onReasoningToken: (token) => tokens.push(token),
        onDone: () => {},
      }
    );

    assert.deepStrictEqual(tokens, ["ok"]);
  });

  it("constructs endpoint correctly from base URL", async () => {
    const provider = new OpenAICompatibleProvider({
      url: "http://localhost:1234/v1",
      model: "test-model",
      reasoningFormat: "separate",
    });

    await provider.streamReasoning("q", "sys", { onDone: () => {} });
    assert.strictEqual(urlPath(/** @type {string} */ (capturedUrl)), "/v1/chat/completions");
  });

  it("retries once on non-abort failure", async () => {
    let attempts = 0;
    globalThis.fetch = /** @type {typeof fetch} */ (async () => {
      attempts++;
      if (attempts === 1) {
        return new Response(null, { status: 500, statusText: "Internal Server Error" });
      }
      return new Response(sseStream("data: [DONE]\n\n"), { status: 200 });
    });

    const provider = new OpenAICompatibleProvider({
      url: "http://localhost:1234/v1",
      model: "test-model",
      reasoningFormat: "separate",
    });

    await provider.streamReasoning("q", "sys", { onDone: () => {} });
    assert.strictEqual(attempts, 2, "should retry once");
  });

  it("throws AbortError on abort signal", async () => {
    const controller = new AbortController();
    controller.abort();

    globalThis.fetch = /** @type {typeof fetch} */ (async (url, init) => {
      if (init?.signal?.aborted) {
        const err = new Error("Aborted");
        err.name = "AbortError";
        throw err;
      }
      return new Response(sseStream("data: [DONE]\n\n"), { status: 200 });
    });

    const provider = new OpenAICompatibleProvider({
      url: "http://localhost:1234/v1",
      model: "test-model",
      reasoningFormat: "separate",
    });

    await assert.rejects(
      () => provider.streamReasoning("q", "sys", { onDone: () => {} }, controller.signal),
      (err) => err instanceof Error && err.name === "AbortError"
    );
  });
});
