/** Default storage adapter: wraps localStorage. */
export class LocalStorageAdapter {
  getItem(key) {
    return localStorage.getItem(key);
  }

  setItem(key, value) {
    localStorage.setItem(key, value);
  }

  removeItem(key) {
    localStorage.removeItem(key);
  }
}
