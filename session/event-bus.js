/**
 * Lightweight event bus for cross-module observable state.
 * Pipelines emit events; the debug overlay (or any listener) subscribes.
 * No module knows about its consumers.
 */
export class SimpleEventBus {
  /** @type {Map<string, Set<(data: any) => void>>} */
  #listeners = new Map();

  /**
   * Subscribe to an event.
   * @param {string} event
   * @param {(data: any) => void} handler
   * @returns {() => void} unsubscribe function
   */
  on(event, handler) {
    if (!this.#listeners.has(event)) {
      this.#listeners.set(event, new Set());
    }
    const set = /** @type {Set<(data: any) => void>} */ (this.#listeners.get(event));
    set.add(handler);
    return () => set.delete(handler);
  }

  /**
   * Emit an event to all subscribers.
   * @param {string} event
   * @param {any} [data]
   * @returns {void}
   */
  emit(event, data) {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(data);
      } catch (err) {
        console.error("Event bus handler error:", err);
      }
    }
  }
}

/** Global singleton event bus for the application. */
export const eventBus = new SimpleEventBus();
