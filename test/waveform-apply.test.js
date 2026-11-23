import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createWaveformSelector } from "../audio/waveform-variant-selector.js";
import { applyVariants } from "../ui/waveform-apply.js";

const VARIANTS = ["bars", "scope", "dots", "radial"];

/** @returns {{ setWaveformVariant: (v: string) => void, seen: string[] }} */
function makeColumn() {
  const seen = [];
  return { seen, setWaveformVariant(v) { seen.push(v); } };
}

describe("Applying Waveform variants to Columns", () => {
  it("gives each Column its own variant, index-aligned", () => {
    const selector = createWaveformSelector(3, "scope", VARIANTS);
    selector.setColumnVariant(1, "dots");
    const columns = [makeColumn(), makeColumn(), makeColumn()];
    applyVariants(columns, selector.getVariants());
    assert.deepEqual(columns.map((c) => c.seen), [["scope"], ["dots"], ["scope"]]);
  });

  it("after a shuffle every Column receives a distinct variant", () => {
    const selector = createWaveformSelector(3, "scope", VARIANTS, { random: () => 0.42 });
    selector.shuffle();
    const columns = [makeColumn(), makeColumn(), makeColumn()];
    applyVariants(columns, selector.getVariants());
    const applied = columns.map((c) => c.seen[0]);
    assert.equal(new Set(applied).size, 3);
  });

  it("emits no notification when variants change", () => {
    let notifications = 0;
    const selector = createWaveformSelector(3, "scope", VARIANTS, {
      random: () => 0.42,
      notify: () => { notifications += 1; },
    });
    selector.shuffle();
    applyVariants([makeColumn(), makeColumn(), makeColumn()], selector.getVariants(), {
      notify: () => { notifications += 1; },
    });
    assert.equal(notifications, 0);
  });
});
