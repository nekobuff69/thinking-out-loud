/**
 * Applies per-Column Waveform variants to the Column objects. Pure wiring:
 * it never touches the DOM and never emits a notification.
 *
 * @param {Array<{ setWaveformVariant?: (variant: string) => void }>} columns
 * @param {string[]} variants
 * @param {{ notify?: (message: string) => void }} [options]
 * @returns {void}
 */
export function applyVariants(columns, variants, options = {}) {
  columns.forEach((column, index) => {
    const variant = variants[index];
    if (variant && typeof column.setWaveformVariant === "function") {
      column.setWaveformVariant(variant);
    }
  });
  // Deliberately no notification: the animation changing is the feedback.
  void options;
}
