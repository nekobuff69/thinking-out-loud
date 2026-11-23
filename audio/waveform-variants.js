/**
 * The four named Waveform animations. Ids are internal identifiers only —
 * they never appear on screen. Order is not significant.
 *
 * @typedef {"bars" | "scope" | "dots" | "radial"} WaveformVariantId
 */

/** @type {string[]} */
export const WAVEFORM_VARIANTS = ["bars", "scope", "dots", "radial"];

/**
 * @param {string | undefined} id
 * @returns {string}
 */
export function normaliseVariant(id) {
  return WAVEFORM_VARIANTS.includes(/** @type {string} */ (id)) ? /** @type {string} */ (id) : "bars";
}

/** @type {Record<string, string>} */
export const WAVEFORM_NAMES = {
  bars: "Mirrored bars",
  scope: "Oscilloscope",
  dots: "Dot matrix",
  radial: "Radial voiceprint",
};

/** Compact labels for the read-only Tool strip (never used in the picker). */
/** @type {Record<string, string>} */
export const WAVEFORM_SHORT_NAMES = {
  bars: "Bars",
  scope: "Scope",
  dots: "Matrix",
  radial: "Radial",
};
