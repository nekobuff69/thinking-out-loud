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
