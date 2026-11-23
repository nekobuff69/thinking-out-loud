import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isCjkCharacter,
  segmentWords,
  wordIndexForProgress,
} from "../ui/word-segmenter.js";

describe("segmentWords", () => {
  it("splits whitespace-delimited Latin words", () => {
    assert.deepEqual(segmentWords("Hello world."), ["Hello", "world."]);
  });

  it("treats each CJK character as one karaoke unit", () => {
    assert.deepEqual(segmentWords("这是一个测试"), [
      "这", "是", "一", "个", "测", "试",
    ]);
  });

  it("handles mixed CJK and Latin text", () => {
    assert.deepEqual(segmentWords("Hello世界 test"), [
      "Hello", "世", "界", "test",
    ]);
  });

  it("discards stray whitespace", () => {
    assert.deepEqual(segmentWords("  a   b  "), ["a", "b"]);
  });

  it("keeps punctuation attached to the preceding Latin word", () => {
    assert.deepEqual(segmentWords("wait, now!"), ["wait,", "now!"]);
  });

  it("attaches CJK punctuation to the preceding character", () => {
    assert.deepEqual(segmentWords("你好。世界！"), ["你", "好。", "世", "界！"]);
  });

  it("returns no words for blank input", () => {
    assert.deepEqual(segmentWords("   "), []);
  });

  it("identifies CJK characters", () => {
    assert.equal(isCjkCharacter("世"), true);
    assert.equal(isCjkCharacter("あ"), true);
    assert.equal(isCjkCharacter("한"), true);
    assert.equal(isCjkCharacter("a"), false);
    assert.equal(isCjkCharacter(","), false);
  });
});

describe("wordIndexForProgress", () => {
  it("maps progress 0 to the first word and 1 to the last", () => {
    assert.equal(wordIndexForProgress([1, 1, 1], 0), 0);
    assert.equal(wordIndexForProgress([1, 1, 1], 1), 2);
  });

  it("distributes time by character weight, not evenly", () => {
    // Word 0 owns 4/5 of the timeline.
    assert.equal(wordIndexForProgress([4, 1], 0.79), 0);
    assert.equal(wordIndexForProgress([4, 1], 0.81), 1);
  });

  it("clamps progress into 0..1", () => {
    assert.equal(wordIndexForProgress([1, 1], -5), 0);
    assert.equal(wordIndexForProgress([1, 1], 5), 1);
  });

  it("handles an empty weight list", () => {
    assert.equal(wordIndexForProgress([], 0.5), 0);
  });
});
