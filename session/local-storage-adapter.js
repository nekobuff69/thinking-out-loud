/** Default storage adapter: wraps localStorage. */
export class LocalStorageAdapter {
  /**
   * @param {string} key
   * @returns {string | null}
   */
  getItem(key) {
    return localStorage.getItem(key);
  }

  /**
   * @param {string} key
   * @param {string} value
   * @returns {void}
   */
  setItem(key, value) {
    localStorage.setItem(key, value);
  }

  /**
   * @param {string} key
   * @returns {void}
   */
  removeItem(key) {
    localStorage.removeItem(key);
  }
}
