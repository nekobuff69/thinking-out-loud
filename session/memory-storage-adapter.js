/** In-memory storage adapter for tests. */
export class MemoryStorageAdapter {
  /** @type {Map<string, string>} */
  #store = new Map();

  /**
   * @param {string} key
   * @returns {string | null}
   */
  getItem(key) {
    return this.#store.get(key) ?? null;
  }

  /**
   * @param {string} key
   * @param {string} value
   * @returns {void}
   */
  setItem(key, value) {
    this.#store.set(key, String(value));
  }

  /**
   * @param {string} key
   * @returns {void}
   */
  removeItem(key) {
    this.#store.delete(key);
  }
}
