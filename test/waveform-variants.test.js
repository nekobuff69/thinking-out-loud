import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WAVEFORM_VARIANTS, normaliseVariant } from "../audio/waveform-variants.js";

describe("Waveform variant contract", () => {
  it("offers exactly the four named animations", () => {
    assert.deepEqual(WAVEFORM_VARIANTS, ["bars", "scope", "dots", "radial"]);
  });

  it("falls back to the mirrored bars for an unknown id", () => {
    assert.equal(normaliseVariant("unknown"), "bars");
    assert.equal(normaliseVariant(undefined), "bars");
  });

  it("accepts every known id unchanged", () => {
    for (const id of WAVEFORM_VARIANTS) assert.equal(normaliseVariant(id), id);
  });

});
