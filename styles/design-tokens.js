/**
 * B-2 duotone design tokens — the single source of truth shared by CSS and
 * Canvas. Values are transcribed verbatim from the visual source of truth
 * `docs/ui-refactor-b2-detail.html` (`.screen` block, lines 35-124).
 *
 * `styles/global.css` mirrors these as CSS custom properties; the contract
 * test in `test/design-tokens.test.js` keeps the two in sync.
 *
 * @typedef {Object} WaveformPalette
 * @property {string} fg - Primary signal (acid green).
 * @property {string} ac - Active / highlighted signal (lighter green).
 * @property {string} dim - Grid, baseline and unlit marks.
 */

/** @type {string} */
export const BG = "#080b08";
/** @type {string} */
export const SURFACE = "#0b100b";
/** @type {string} */
export const INPUT_BG = "#060906";
/** @type {string} */
export const FG = "#b6ff1f";
/** @type {string} */
export const AC = "#d6ff6b";
/** @type {string} */
export const LN = "rgba(182,255,31,.5)";
/** @type {string} */
export const SF = "rgba(182,255,31,.08)";
/** @type {string} */
export const DIM = "rgba(182,255,31,.28)";
/** @type {string} */
export const FRAME_GLOW = "0 0 0 5px rgba(182,255,31,.06)";
/** @type {string} */
export const TYPE_BASE = "11px";
/** @type {string} */
export const FONT_MONO = '"Courier New",ui-monospace,Consolas,monospace';

/** @type {WaveformPalette} */
export const WAVEFORM_PALETTE = { fg: FG, ac: AC, dim: DIM };
