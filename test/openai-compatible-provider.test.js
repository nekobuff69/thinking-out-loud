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

  it("sends Authorization header when apiKey is provided", async () => {
    /** @type {Record<string, unknown> | undefined} */
    let capturedHeaders;
    globalThis.fetch = /** @type {typeof fetch} */ (async (url, init) => {
      capturedHeaders = /** @type {Record<string, unknown>} */ (init?.headers);
      return new Response(sseStream("data: [DONE]\n\n"), { status: 200 });
    });

    const provider = new OpenAICompatibleProvider({
      url: "https://openrouter.ai/api/v1",
      model: "openai/gpt-oss-20b",
      apiKey: "sk-or-test",
    });

    await provider.streamReasoning("q", "sys", { onDone: () => {} });
    assert.strictEqual(capturedHeaders?.["Authorization"], "Bearer sk-or-test");
    assert.strictEqual(capturedHeaders?.["Content-Type"], "application/json");
  });

  it("omits Authorization header when apiKey is absent (local providers)", async () => {
    /** @type {Record<string, unknown> | undefined} */
    let capturedHeaders;
    globalThis.fetch = /** @type {typeof fetch} */ (async (url, init) => {
      capturedHeaders = /** @type {Record<string, unknown>} */ (init?.headers);
      return new Response(sseStream("data: [DONE]\n\n"), { status: 200 });
    });

    const provider = new OpenAICompatibleProvider({
      url: "http://localhost:1234/v1",
      model: "test-model",
    });

    await provider.streamReasoning("q", "sys", { onDone: () => {} });
    assert.strictEqual(capturedHeaders?.["Authorization"], undefined);
  });

  it("includes max_tokens in the request body when configured", async () => {
    let capturedBody = null;
    globalThis.fetch = /** @type {typeof fetch} */ (async (url, init) => {
      capturedBody = /** @type {string} */ (init?.body);
      return new Response(sseStream("data: [DONE]\n\n"), { status: 200 });
    });

    const provider = new OpenAICompatibleProvider({
      url: "https://openrouter.ai/api/v1",
      model: "openai/gpt-oss-20b",
      maxTokens: 200,
    });

    await provider.streamReasoning("q", "sys", { onDone: () => {} });
    const body = JSON.parse(/** @type {string} */ (capturedBody));
    assert.strictEqual(body.max_tokens, 200);
    assert.strictEqual(body.stream, true);
    assert.strictEqual(body.model, "openai/gpt-oss-20b");
  });

  it("collects usage from a choices-less terminal chunk and answer content", async () => {
    globalThis.fetch = /** @type {typeof fetch} */ (async () => {
      return new Response(
        sseStream(
          'data: {"choices":[{"delta":{"reasoning":"thinking"}}],"model":"openai/gpt-oss-20b"}\n\n' +
          'data: {"choices":[{"delta":{"content":"The answer "},"finish_reason":null}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"is 42."},"finish_reason":"stop"}]}\n\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"cost":0.0001,"completion_tokens_details":{"reasoning_tokens":3}}}\n\n' +
          "data: [DONE]\n\n"
        ),
        { status: 200 }
      );
    });

    const provider = new OpenAICompatibleProvider({
      url: "https://openrouter.ai/api/v1", model: "openai/gpt-oss-20b",
      reasoningFormat: "separate",
    });

    /** @type {any} */
    let usage = null;
    /** @type {string[]} */
    const answer = [];
    await provider.streamReasoning("q", "sys", {
      onUsage: (u) => { usage = u; },
      onAnswer: (t) => answer.push(t),
      onDone: () => {},
    });

    assert.deepStrictEqual(usage, {
      prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
      reasoning_tokens: 3, cost: 0.0001,
    });
    assert.strictEqual(answer.join(""), "The answer is 42.");
  });

  it("reports truncation when finish_reason is length", async () => {
    globalThis.fetch = /** @type {typeof fetch} */ (async () => {
      return new Response(
        sseStream(
          'data: {"choices":[{"delta":{"reasoning":"partial thought "},"finish_reason":null}]}\n\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n' +
          "data: [DONE]\n\n"
        ),
        { status: 200 }
      );
    });

    const provider = new OpenAICompatibleProvider({
      url: "https://openrouter.ai/api/v1", model: "openai/gpt-oss-20b",
    });

    let truncatedCalled = false;
    let doneCalled = false;
    await provider.streamReasoning("q", "sys", {
      onTruncated: () => { truncatedCalled = true; },
      onDone: () => { doneCalled = true; },
    });

    assert.strictEqual(truncatedCalled, true, "onTruncated must fire on finish_reason=length");
    assert.strictEqual(doneCalled, true, "onDone must still fire");
  });

  it("does not report truncation on a natural stop", async () => {
    globalThis.fetch = /** @type {typeof fetch} */ (async () => {
      return new Response(
        sseStream(
          'data: {"choices":[{"delta":{"reasoning":"complete thought"},"finish_reason":"stop"}]}\n\n' +
          "data: [DONE]\n\n"
        ),
        { status: 200 }
      );
    });

    const provider = new OpenAICompatibleProvider({
      url: "https://openrouter.ai/api/v1", model: "openai/gpt-oss-20b",
    });

    let truncatedCalled = false;
    await provider.streamReasoning("q", "sys", {
      onTruncated: () => { truncatedCalled = true; },
      onDone: () => {},
    });

    assert.strictEqual(truncatedCalled, false, "onTruncated must not fire on natural stop");
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
