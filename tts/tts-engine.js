/**
 * Abstract TTSEngine interface — streaming contract.
 *
 * Push-based: text is sent to the backend, PCM audio chunks arrive via callback.
 *
 * Concrete backends (PocketTtsBackend) extend this class.
 */
export class TTSEngine {
  /**
   * Initialize the TTS backend. Establishes connection, verifies health.
   * Called once before any startStream() call.
   * @returns {Promise<void>}
   */
  async load() {
    throw new Error("TTSEngine.load() must be implemented");
  }

  /**
   * Begin streaming TTS synthesis.
   * Sends text to the server and delivers PCM audio chunks as they are generated.
   *
   * @param {string} text - Text to synthesize
   * @param {string} voice - Voice identifier (WAV path or .safetensors voice state name for Pocket TTS)
   * @param {(pcm: Float32Array, sampleRate: number) => void} onAudioChunk - Called for each PCM frame
   * @param {{ onDone?: () => void, onError?: (message: string) => void }} [callbacks] - Stream lifecycle callbacks
   * @returns {void}
   */
  startStream(text, voice, onAudioChunk, callbacks) {
    throw new Error("TTSEngine.startStream() must be implemented");
  }

  /**
   * Abort the current stream. No more PCM chunks will be delivered.
   * The backend connection remains open for future streams.
   * @returns {void}
   */
  stop() {
    throw new Error("TTSEngine.stop() must be implemented");
  }

  /**
   * Tear down the backend. Closes connection, releases resources.
   * @returns {void}
   */
  destroy() {
    throw new Error("TTSEngine.destroy() must be implemented");
  }
}
