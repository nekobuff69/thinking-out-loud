import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { healthCheck } from "../llm/health-check.js";

describe("healthCheck URL construction", () => {
  /** @type {typeof fetch} */
  let originalFetch;
  /** @type {string | null} */
  let capturedUrl = null;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    capturedUrl = null;
    globalThis.fetch = /** @type {typeof fetch} */ (async (url, init) => {
      capturedUrl = /** @type {string} */ (url);
      // Return a mock ok response so the retry doesn't trigger a second fetch
      // (the second call would overwrite capturedUrl, but we clear the timeout
      // so only the first request matters for URL inspection)
      // Actually, healthCheck has its own AbortController. Let's just return ok
      // and the timeout is cleared. We don't need to worry about AbortController.
      return new Response("{}", { status: 200 });
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("constructs URL without double-slash when baseUrl has trailing slash", async () => {
    await healthCheck("http://localhost:1234/v1/");
    assert.strictEqual(capturedUrl, "http://localhost:1234/v1/models");
  });

  it("constructs URL correctly when baseUrl has no trailing slash", async () => {
    await healthCheck("http://localhost:1234/v1");
    assert.strictEqual(capturedUrl, "http://localhost:1234/v1/models");
  });

  it("strips multiple trailing slashes", async () => {
    await healthCheck("http://localhost:1234/v1///");
    assert.strictEqual(capturedUrl, "http://localhost:1234/v1/models");
  });

  it("returns false when fetch throws", async () => {
    globalThis.fetch = /** @type {typeof fetch} */ (async () => {
      throw new Error("connection refused");
    });
    const result = await healthCheck("http://localhost:1234/v1");
    assert.strictEqual(result, false);
  });
});
