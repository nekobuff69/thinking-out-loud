/**
 * Abstract TTSEngine interface.
 * Concrete backends (e.g. Kokoro) extend this class.
 */
export class TTSEngine {
  /**
   * Load the TTS model. Called once before first synthesis.
   * Implementations should handle lazy loading and caching.
   * @returns {Promise<void>}
   */
  async load() {
    throw new Error("TTSEngine.load() must be implemented");
  }

  /**
   * Synthesize text to audio using the specified voice.
   * @param {string} text - Text to synthesize
   * @param {string} voice - Voice identifier
   * @returns {Promise<AudioBuffer>}
   */
  async synthesize(text, voice) {
    throw new Error("TTSEngine.synthesize() must be implemented");
  }

  /**
   * Clean up runtime resources.
   * @returns {void}
   */
  destroy() {
    throw new Error("TTSEngine.destroy() must be implemented");
  }
}
