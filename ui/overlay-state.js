/**
 * Pure state for the three on-demand overlays. At most one is open at a time.
 * DOM-free so the mutual-exclusion rule can be tested without a browser.
 *
 * @typedef {"picker" | "palette" | "history"} OverlayName
 */

/** @type {OverlayName[]} */
const NAMES = ["picker", "palette", "history"];

/**
 * @typedef {Object} OverlayState
 * @property {(name: string) => void} open
 * @property {(name: string) => void} close
 * @property {(name: string) => void} toggle
 * @property {(name: string) => boolean} isOpen
 * @property {() => OverlayName | null} current
 * @property {() => OverlayName | null} escapeTarget
 */

/** @returns {OverlayState} */
export function createOverlayState() {
  /** @type {OverlayName | null} */
  let active = null;

  /** @param {string} name @returns {boolean} */
  function valid(name) {
    return NAMES.includes(/** @type {OverlayName} */ (name));
  }

  return {
    open(name) {
      if (!valid(name)) return;
      active = /** @type {OverlayName} */ (name);
    },
    close(name) {
      if (active === name) active = null;
    },
    toggle(name) {
      if (!valid(name)) return;
      active = active === name ? null : /** @type {OverlayName} */ (name);
    },
    isOpen(name) {
      return active === name;
    },
    current() {
      return active;
    },
    escapeTarget() {
      return active;
    },
  };
}
