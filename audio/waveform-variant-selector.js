/**
 * Pure, DOM-free state for per-Column Waveform variants.
 *
 * One entry per Column, index-aligned with the models. There is no global
 * variant: applying an animation to one Column never changes the others.
 * Nothing here touches the DOM, a canvas, an AnalyserNode, or notifications.
 *
 * @typedef {"bars" | "scope" | "dots" | "radial"} WaveformVariantId
 */

/**
 * @typedef {Object} WaveformSelector
 * @property {() => string[]} getVariants
 * @property {(index: number, id: string) => boolean} setColumnVariant
 * @property {() => void} shuffle
 * @property {() => void} reset
 */

/**
 * @param {number} columnCount
 * @param {string} defaultVariant
 * @param {string[]} variantIds
 * @param {{ random?: () => number }} [options]
 * @returns {WaveformSelector}
 */
export function createWaveformSelector(columnCount, defaultVariant, variantIds, options = {}) {
  const random = options.random ?? Math.random;
  const ids = [...variantIds];
  /** @type {string[]} */
  let variants = Array.from({ length: columnCount }, () => defaultVariant);

  /** @returns {string[]} */
  function getVariants() {
    return [...variants];
  }

  /**
   * @param {number} index
   * @param {string} id
   * @returns {boolean}
   */
  function setColumnVariant(index, id) {
    if (!Number.isInteger(index) || index < 0 || index >= columnCount) return false;
    if (!ids.includes(id)) return false;
    variants[index] = id;
    return true;
  }

  /** @returns {string[]} */
  function draw() {
    const pool = ids.slice();
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      const tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }
    return pool.slice(0, Math.min(columnCount, pool.length));
  }

  /** @returns {void} */
  function shuffle() {
    const before = variants.join("|");
    let next = draw();
    for (let attempt = 0; attempt < 30 && next.join("|") === before; attempt += 1) {
      next = draw();
    }
    if (next.join("|") === before) {
      // Deterministic fallback when the injected random source is degenerate:
      // rotate the current combination by one so the result still changes.
      next = variants.slice(1).concat(variants.slice(0, 1));
      if (next.join("|") === before && ids.length > 1) {
        next[0] = ids.find((id) => id !== next[0]) ?? next[0];
      }
    }
    variants = next;
  }

  /** @returns {void} */
  function reset() {
    variants = Array.from({ length: columnCount }, () => defaultVariant);
  }

  return { getVariants, setColumnVariant, shuffle, reset };
}
