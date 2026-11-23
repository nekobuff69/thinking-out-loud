import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BG, SURFACE, INPUT_BG, FG, AC, LN, SF, DIM, FRAME_GLOW,
  TYPE_BASE, FONT_MONO, WAVEFORM_PALETTE,
} from "../styles/design-tokens.js";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(fileURLToPath(new URL(path, root)), "utf8");
const norm = (value) => String(value).replace(/\s+/g, "").replace(/0\.(\d)/g, ".$1").toLowerCase();

/** @param {string} css @param {string} name */
function cssVar(css, name) {
  const match = css.match(new RegExp("--" + name + "\\s*:\\s*([^;]+);"));
  return match ? match[1].trim() : null;
}

const globalCss = read("styles/global.css");
const mockup = read("docs/ui-refactor-b2-detail.html");
const componentCss = [
  ...readdirSync(fileURLToPath(new URL("ui/", root))).filter((f) => f.endsWith(".css")).map((f) => read("ui/" + f)),
  read("styles/shell.css"),
].join("\n");

describe("B-2 visual contract", () => {
  it("keeps the exact duotone transcribed from the mockup", () => {
    assert.equal(BG, "#080b08");
    assert.equal(SURFACE, "#0b100b");
    assert.equal(INPUT_BG, "#060906");
    assert.equal(FG, "#b6ff1f");
    assert.equal(AC, "#d6ff6b");
    assert.equal(LN, "rgba(182,255,31,.5)");
    assert.equal(SF, "rgba(182,255,31,.08)");
    assert.equal(DIM, "rgba(182,255,31,.28)");
    assert.deepEqual(WAVEFORM_PALETTE, { fg: FG, ac: AC, dim: DIM });
  });

  it("mirrors every JS token as a CSS custom property", () => {
    const expected = {
      bg: BG, surface: SURFACE, "input-bg": INPUT_BG, fg: FG, ac: AC,
      ln: LN, sf: SF, dim: DIM, "frame-glow": FRAME_GLOW,
      "font-mono": FONT_MONO, "type-base": TYPE_BASE,
    };
    for (const [name, value] of Object.entries(expected)) {
      assert.equal(norm(cssVar(globalCss, name)), norm(value), "--" + name + " drifted");
    }
  });

  it("uses the same duotone as the visual source of truth", () => {
    const screen = mockup.slice(mockup.indexOf(".screen{"), mockup.indexOf(".qblock{"));
    assert.equal(norm(cssVar(screen, "bg")), norm(BG));
    assert.equal(norm(cssVar(screen, "fg")), norm(FG));
    assert.equal(norm(cssVar(screen, "ac")), norm(AC));
    assert.equal(norm(cssVar(screen, "ln")), norm(LN));
    assert.equal(norm(cssVar(screen, "sf")), norm(SF));
  });

  it("eliminates the three neon hues and rounded card frames", () => {
    const runtime = componentCss + read("config.js") + read("audio/waveform.js") + read("ui/waveform-picker.js");
    for (const neon of ["#00ff88", "#ff6644", "#44aaff"]) {
      assert.equal(runtime.includes(neon), false, neon + " is still in use");
    }
    assert.equal((read("config.js").match(/color: FG/g) || []).length, 3);
    assert.equal(/border-radius:\s*(?:[3-9]|1[0-9])px/.test(componentCss.replace(/border-radius:\s*2px/g, "")), false);
  });

  it("keeps the mockup's 11px monospace base and 9px corner registration marks", () => {
    assert.match(globalCss, /font:\s*11px\s*"Courier New",ui-monospace,Consolas,monospace/);
    const shell = read("styles/shell.css");
    assert.match(shell, /#columns \.column::before/);
    assert.match(shell, /#columns \.column::after/);
    assert.match(shell, /width:\s*9px/);
    assert.match(shell, /height:\s*9px/);
  });
});
