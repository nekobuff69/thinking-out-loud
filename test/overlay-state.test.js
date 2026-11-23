import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOverlayState } from "../ui/overlay-state.js";

describe("Overlay mutual exclusion", () => {
  it("opening one overlay closes any other that was open", () => {
    const overlays = createOverlayState();
    overlays.open("palette");
    overlays.open("history");
    assert.equal(overlays.current(), "history");
    assert.equal(overlays.isOpen("palette"), false);
  });

  it("toggle closes the overlay when it is already open", () => {
    const overlays = createOverlayState();
    overlays.toggle("picker");
    assert.equal(overlays.current(), "picker");
    overlays.toggle("picker");
    assert.equal(overlays.current(), null);
  });

  it("Escape targets the currently open overlay only", () => {
    const overlays = createOverlayState();
    overlays.open("palette");
    assert.equal(overlays.escapeTarget(), "palette");
    overlays.close("palette");
    assert.equal(overlays.escapeTarget(), null);
  });

  it("closing a non-current overlay leaves the current one alone", () => {
    const overlays = createOverlayState();
    overlays.open("picker");
    overlays.close("history");
    assert.equal(overlays.current(), "picker");
  });

  it("rejects an unknown overlay name", () => {
    const overlays = createOverlayState();
    overlays.open("unknown");
    assert.equal(overlays.current(), null);
  });
});
