import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createWaveformSelector } from "../audio/waveform-variant-selector.js";

const VARIANTS = ["bars", "scope", "dots", "radial"];

describe("Waveform variant selector", () => {
  it("exposes one variant per Column, index-aligned, starting at the default", () => {
    const selector = createWaveformSelector(3, "scope", VARIANTS);
    assert.deepEqual(selector.getVariants(), ["scope", "scope", "scope"]);
  });

  it("setting one Column changes only that index", () => {
    const selector = createWaveformSelector(3, "scope", VARIANTS);
    selector.setColumnVariant(1, "dots");
    assert.deepEqual(selector.getVariants(), ["scope", "dots", "scope"]);
  });

  it("rejects an unknown variant id and an out-of-range Column", () => {
    const selector = createWaveformSelector(3, "scope", VARIANTS);
    assert.equal(selector.setColumnVariant(0, "unknown"), false);
    assert.equal(selector.setColumnVariant(3, "bars"), false);
    assert.deepEqual(selector.getVariants(), ["scope", "scope", "scope"]);
  });

  it("shuffle assigns three distinct variants", () => {
    const selector = createWaveformSelector(3, "scope", VARIANTS, { random: () => 0.42 });
    selector.shuffle();
    const variants = selector.getVariants();
    assert.equal(variants.length, 3);
    assert.equal(new Set(variants).size, 3, "each Column must get a distinct animation");
    for (const id of variants) assert.ok(VARIANTS.includes(id));
  });

  it("shuffle produces a combination different from the current one", () => {
    const selector = createWaveformSelector(3, "scope", VARIANTS, { random: () => 0.42 });
    const before = selector.getVariants();
    selector.shuffle();
    assert.notDeepEqual(selector.getVariants(), before);
  });

  it("shuffle keeps retrying until it differs from the current combination", () => {
    // First draw reproduces the current combination; subsequent draws must differ.
    const draws = [0, 0.11, 0.73];
    let call = 0;
    const random = () => draws[Math.min(call++, draws.length - 1)];
    const selector = createWaveformSelector(3, "scope", VARIANTS, { random });
    selector.shuffle();
    assert.notDeepEqual(selector.getVariants(), ["scope", "scope", "scope"]);
  });

  it("reset restores the default on every Column", () => {
    const selector = createWaveformSelector(3, "scope", VARIANTS, { random: () => 0.42 });
    selector.shuffle();
    selector.reset();
    assert.deepEqual(selector.getVariants(), ["scope", "scope", "scope"]);
  });

  it("never emits a notification for any change", () => {
    let notifications = 0;
    const selector = createWaveformSelector(3, "scope", VARIANTS, {
      random: () => 0.42,
      notify: () => { notifications += 1; },
    });
    selector.setColumnVariant(0, "bars");
    selector.shuffle();
    selector.reset();
    assert.equal(notifications, 0);
  });
});
