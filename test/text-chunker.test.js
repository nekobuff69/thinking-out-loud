import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TextChunker } from "../tts/text-chunker.js";

describe("TextChunker", () => {
  /** @type {string[]} */
  let flushes;
  /** @type {TextChunker | null} */
  let chunker;

  /**
   * @param {Object} [opts]
   * @returns {TextChunker}
   */
  function createChunker(opts = {}) {
    flushes = [];
    chunker = new TextChunker({
      onFlush: (text) => flushes.push(text),
      maxWords: opts.maxWords ?? 8,
      timeoutMs: opts.timeoutMs ?? 150,
      flushOnPunctuation: opts.flushOnPunctuation ?? true,
    });
    return chunker;
  }

  it("flushes on punctuation (period)", () => {
    const c = createChunker();
    c.feed("Hello world.");
    assert.strictEqual(flushes.length, 1);
    assert.strictEqual(flushes[0], "Hello world.");
  });

  it("flushes on question mark", () => {
    const c = createChunker();
    c.feed("Is this real?");
    assert.strictEqual(flushes.length, 1);
    assert.strictEqual(flushes[0], "Is this real?");
  });

  it("flushes on exclamation mark", () => {
    const c = createChunker();
    c.feed("Wow!");
    assert.strictEqual(flushes.length, 1);
    assert.strictEqual(flushes[0], "Wow!");
  });

  it("flushes on semicolon", () => {
    const c = createChunker();
    c.feed("think; act");
    assert.strictEqual(flushes.length, 1);
    assert.strictEqual(flushes[0], "think;");
  });

  it("flushes on comma", () => {
    const c = createChunker();
    c.feed("hello, world");
    assert.strictEqual(flushes.length, 1);
    assert.strictEqual(flushes[0], "hello,");
  });

  it("flushes on max word count reached", () => {
    const c = createChunker({ maxWords: 3 });
    // Feed up to 3 words
    c.feed("one two three");
    assert.strictEqual(flushes.length, 1);
    assert.ok(flushes[0].includes("one two three"), "flushed text contains first 3 words");
  });

  it("flushes on timeout", async () => {
    const c = createChunker({ maxWords: 20, timeoutMs: 20 });
    c.feed("hello world again");
    // Wait for timeout
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(flushes.length, 1);
    assert.strictEqual(flushes[0], "hello world again");
  });

  it("timeout does not flush when fewer than 3 words", async () => {
    const c = createChunker({ maxWords: 20, timeoutMs: 20 });
    c.feed("hello world");
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(flushes.length, 0);

    // Adding a third word triggers flush on next timeout
    c.feed(" again");
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(flushes.length, 1);
    assert.strictEqual(flushes[0], "hello world again");
  });

  it("does not flush before any trigger", () => {
    const c = createChunker({ maxWords: 20, timeoutMs: 500 });
    c.feed("hello");
    c.feed(" world");
    assert.strictEqual(flushes.length, 0);
  });

  it("manual flush() empties buffer", () => {
    const c = createChunker({ maxWords: 20, timeoutMs: 500 });
    c.feed("some text without punctuation");
    c.flush();
    assert.strictEqual(flushes.length, 1);
    assert.strictEqual(flushes[0], "some text without punctuation");
  });

  it("reset() clears buffer without flushing", () => {
    const c = createChunker({ maxWords: 20, timeoutMs: 500 });
    c.feed("forgotten");
    c.reset();
    assert.strictEqual(flushes.length, 0);
    // Feed again — should not include the reset text
    c.feed("new text.");
    assert.strictEqual(flushes.length, 1);
    assert.strictEqual(flushes[0], "new text.");
  });

  it("multiple feeds before trigger accumulate correctly", () => {
    const c = createChunker({ maxWords: 20, timeoutMs: 500 });
    c.feed("one ");
    c.feed("two ");
    c.feed("three.");
    assert.strictEqual(flushes.length, 1);
    assert.strictEqual(flushes[0], "one two three.");
  });

  it("empty feed does nothing", () => {
    const c = createChunker();
    c.feed("");
    c.feed("   ");
    assert.strictEqual(flushes.length, 0);
  });

  it("flush on punctuation can be disabled", () => {
    const c = createChunker({ flushOnPunctuation: false, maxWords: 20, timeoutMs: 500 });
    c.feed("hello world.");
    assert.strictEqual(flushes.length, 0);
  });

  it("disabling punctuation flush still allows manual flush", () => {
    const c = createChunker({ flushOnPunctuation: false, maxWords: 20, timeoutMs: 500 });
    c.feed("hello world.");
    c.flush();
    assert.strictEqual(flushes.length, 1);
    assert.strictEqual(flushes[0], "hello world.");
  });

  it("hasPending returns false on empty buffer", () => {
    const c = createChunker();
    assert.strictEqual(c.hasPending, false);
  });

  it("hasPending returns true when buffer has text", () => {
    const c = createChunker({ maxWords: 20, timeoutMs: 500 });
    c.feed("hello");
    assert.strictEqual(c.hasPending, true);
  });

  it("feed with multiple sentences flushes each one", () => {
    const c = createChunker({ maxWords: 20, timeoutMs: 500 });
    c.feed("hello world.");
    assert.strictEqual(flushes.length, 1);
    assert.strictEqual(flushes[0], "hello world.");
    c.feed("this is great!");
    assert.strictEqual(flushes.length, 2);
    assert.strictEqual(flushes[1], "this is great!");
  });
});
