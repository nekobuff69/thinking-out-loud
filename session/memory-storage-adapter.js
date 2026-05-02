/** In-memory storage adapter for tests. */
export class MemoryStorageAdapter {
  #store = new Map();

  getItem(key) {
    return this.#store.get(key) ?? null;
  }

  setItem(key, value) {
    this.#store.set(key, String(value));
  }

  removeItem(key) {
    this.#store.delete(key);
  }
}
