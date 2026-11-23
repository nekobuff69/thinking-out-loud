/**
 * Applies per-Column Waveform variants to the Column objects. Pure wiring:
 * it never touches the DOM and never emits a notification.
 *
 * @param {Array<{ setWaveformVariant?: (variant: string) => void }>} columns
 * @param {string[]} variants
 * @returns {void}
 */
export function applyVariants(columns, variants) {
  columns.forEach((column, index) => {
    const variant = variants[index];
    if (variant && typeof column.setWaveformVariant === "function") {
      column.setWaveformVariant(variant);
    }
  });
}
