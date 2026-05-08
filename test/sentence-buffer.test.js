import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SentenceBuffer } from "../tts/sentence-buffer.js";

describe("SentenceBuffer two-sentence bundling", () => {
  it("flushes after two complete sentences", () => {
    const sentences = [];
    const buf = new SentenceBuffer({
      maxTokens: 200,
      timeoutTokens: 100,
      onSentence: (text) => sentences.push(text),
    });

    buf.feed("H");
    buf.feed("i");
    buf.feed(".");
    buf.feed(" ");
    buf.feed("T");
    buf.feed("h");
    buf.feed("e");
    buf.feed("r");
    buf.feed("e");
    buf.feed(".");

    assert.equal(sentences.length, 1, "flushes once after two sentences");
    assert.equal(sentences[0], "Hi. There.");
  });

  it("holds a single sentence until the second arrives", () => {
    const sentences = [];
    const buf = new SentenceBuffer({
      maxTokens: 200,
      timeoutTokens: 100,
      onSentence: (text) => sentences.push(text),
    });

    buf.feed("H");
    buf.feed("i");
    buf.feed(".");

    assert.equal(sentences.length, 0, "first sentence is held");

    buf.feed(" ");
    buf.feed("B");
    buf.feed("y");
    buf.feed("e");
    buf.feed(".");

    assert.equal(sentences.length, 1, "flushes when second sentence arrives");
    assert.equal(sentences[0], "Hi. Bye.");
  });

  it("force-flushes at 60-token timeout and resets counter per sentence", () => {
    const sentences = [];
    const buf = new SentenceBuffer({
      maxTokens: 200,
      timeoutTokens: 60,
      onSentence: (text) => sentences.push(text),
    });

    // Feed 65 tokens without a boundary — first 60 timeout, last 5 remain
    for (let i = 0; i < 65; i++) {
      buf.feed("x");
    }

    assert.equal(sentences.length, 1, "timeouts after 60 tokens");
    assert.equal(sentences[0].length, 60, "flushes exactly 60 tokens");

    // Feed 60 more — counter should have reset, so another timeout at 60
    for (let i = 0; i < 60; i++) {
      buf.feed("y");
    }

    assert.equal(sentences.length, 2, "second timeout fires after reset");
    assert.equal(sentences[1].length, 60, "flushes next 60 tokens (5 remaining + 55 new)");
  });

  it("timeout flushes only the completed sentence when one is held", () => {
    const sentences = [];
    const buf = new SentenceBuffer({
      maxTokens: 200,
      timeoutTokens: 60,
      onSentence: (text) => sentences.push(text),
    });

    // Complete first sentence
    buf.feed("H");
    buf.feed("i");
    buf.feed(".");

    assert.equal(sentences.length, 0, "first sentence is held");
    assert.deepStrictEqual(buf.pendingSentences, ["Hi."]);

    // Feed 60 tokens of a second sentence without boundary
    for (let i = 0; i < 60; i++) {
      buf.feed("x");
    }

    assert.equal(sentences.length, 1, "timeout flushes only the held sentence");
    assert.equal(sentences[0], "Hi.", "only the completed sentence is flushed");
    assert.equal(buf.currentTokenCount, 60, "incomplete buffer remains with 60 tokens");
  });
});

describe("SentenceBuffer token cap", () => {
  it("enforces total-token cap across sentences — 5 batches of 50, 5th suppressed", () => {
    const sentences = [];
    const buf = new SentenceBuffer({
      maxTokens: 200,
      timeoutTokens: 100, // high enough that boundaries fire first
      onSentence: (text) => sentences.push(text),
    });

    // Feed 250 tokens: each "batch" is 49 'x' chars + 1 '.'
    for (let i = 0; i < 250; i++) {
      const isBoundary = (i + 1) % 50 === 0;
      buf.feed(isBoundary ? "." : "x");
    }

    // With two-sentence bundling: s1+s2 flush, s3+s4 flush, 5th suppressed
    assert.equal(sentences.length, 2, "2 bundles emitted before cap kicks in");
    assert.ok(buf.isCapped, "buffer is capped after 200 tokens");
  });

  it("emits all sentences when under the cap", () => {
    const sentences = [];
    const buf = new SentenceBuffer({
      maxTokens: 200,
      timeoutTokens: 100,
      onSentence: (text) => sentences.push(text),
    });

    // Two sentences of 30 tokens each — well under 200 cap
    for (let i = 0; i < 30; i++) {
      buf.feed(i === 29 ? "." : "x");
    }
    for (let i = 0; i < 30; i++) {
      buf.feed(i === 29 ? "." : "x");
    }

    assert.equal(sentences.length, 1, "one bundle emitted under cap");
    assert.ok(!buf.isCapped, "buffer is not capped");
  });

  it("respects cap with timeout force-flush, stops after cap", () => {
    const sentences = [];
    const buf = new SentenceBuffer({
      maxTokens: 80,
      timeoutTokens: 30,
      onSentence: (text) => sentences.push(text),
    });

    // Feed 100 'x' tokens, no boundary — only force-flush via timeout
    // timeoutTokens=30: first flush at token 30, second at token 60
    // At token 80: totalFlushed(60) + tokenCount(20) = 80 >= 80 → caps
    for (let i = 0; i < 100; i++) {
      buf.feed("x");
    }

    // First flush: tokens 1-30 (30 tokens). Second flush: tokens 31-60 (30 tokens).
    // At token 80: cap triggers. Tokens 61-80 buffered but no boundary found,
    // so capped without emitting. Tokens 81-100: feed() returns immediately (capped).
    assert.equal(sentences.length, 2, "2 timeout flushes before cap");
    assert.ok(buf.isCapped, "buffer is capped");
  });

  it("ignores tokens after cap", () => {
    const sentences = [];
    const buf = new SentenceBuffer({
      maxTokens: 3,
      timeoutTokens: 10,
      onSentence: (text) => sentences.push(text),
    });

    // Feed "x x." — 3 tokens, boundary at 3rd
    buf.feed("x");
    buf.feed(" ");
    buf.feed("."); // caps here (totalFlushed(0) + tokenCount(3) >= 3)

    const countAtCap = sentences.length;

    // Feed more — should be ignored
    buf.feed("y");
    buf.feed(".");
    buf.feed("z");

    assert.equal(sentences.length, countAtCap, "no new sentences after cap");
    assert.ok(buf.isCapped, "buffer is capped");
  });

  it("accumulates totalTokensFlushed correctly over multiple flushes", () => {
    const sentences = [];
    const buf = new SentenceBuffer({
      maxTokens: 100,
      timeoutTokens: 60, // high enough that boundaries fire first
      onSentence: (text) => sentences.push(text),
    });

    // Sentence 1: 40 tokens ending with boundary
    for (let i = 0; i < 40; i++) {
      buf.feed(i === 39 ? "." : "x");
    }
    assert.equal(sentences.length, 0, "first sentence is held");

    // Sentence 2: 40 tokens ending with boundary
    for (let i = 0; i < 40; i++) {
      buf.feed(i === 39 ? "." : "x");
    }
    assert.equal(sentences.length, 1, "first two sentences emitted as one bundle");

    // Sentence 3: only 20 tokens before cap (40+40+20 = 100)
    // At token 20: totalFlushed(80) + tokenCount(20) = 100 >= 100 → cap
    for (let i = 0; i < 20; i++) {
      buf.feed(i === 19 ? "." : "x");
    }
    assert.equal(sentences.length, 2, "third sentence emitted before cap");
    assert.ok(buf.isCapped, "capped after 100 tokens");

    // Try to feed more — ignored
    buf.feed("x");
    buf.feed(".");
    assert.equal(sentences.length, 2, "no new emissions after cap");
  });
});
