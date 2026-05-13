import { TTSEngine } from "./tts-engine.js";

/**
 * Pocket TTS HTTP client.
 *
 * Talks to the Pocket TTS server over HTTP (not WebSocket):
 *   GET  /health          → 200 OK
 *   POST /v1/tts          → streaming audio/wav (24kHz mono float32)
 *   Body: {"text": "...", "voice": "default"}
 *
 * One active request at a time.  startStream() sends the full text and
 * delivers decoded PCM chunks via the onAudioChunk callback.
 */
export class PocketTtsBackend extends TTSEngine {
  /** @type {string} */
  #serverUrl;
  /** @type {string} */
  #modelName;
  /** @type {AbortController | null} */
  #abortController = null;
  /** @type {boolean} */
  #stopped = false;
  /** @type {boolean} */
  #loaded = false;

  /**
   * @param {{ serverUrl?: string, modelName?: string }} [opts]
   */
  constructor(opts = {}) {
    super();
    this.#serverUrl = opts.serverUrl || "http://localhost:8765";
    this.#modelName = opts.modelName || "";
  }

  // ------------------------------------------------------------------
  // TTSEngine interface
  // ------------------------------------------------------------------

  /**
   * Health-check the Pocket TTS server.
   * @returns {Promise<void>}
   */
  async load() {
    const response = await fetch(`${this.#serverUrl}/health`);
    if (!response.ok) {
      throw new Error(`TTS server health check failed: ${response.status}`);
    }
    this.#loaded = true;
  }

  /**
   * Synthesise text to speech via a single HTTP POST.
   *
   * The response is a streaming WAV.  We read the whole body, decode the
   * WAV into Float32 PCM, and deliver it (possibly in multiple chunks) via
   * onAudioChunk.
   *
   * @param {string} text
   * @param {string} voice
   * @param {(pcm: Float32Array, sampleRate: number) => void} onAudioChunk
   * @param {{ onDone?: () => void, onError?: (message: string) => void }} [callbacks]
   */
  startStream(text, voice, onAudioChunk, callbacks) {
    // Abort any in-flight request
    this.#abortController?.abort();
    this.#abortController = new AbortController();
    this.#stopped = false;

    const { onDone, onError } = callbacks || {};

    this.#doStream(text, voice, onAudioChunk, onDone, onError);
  }

  /**
   * Abort the in-flight HTTP request (if any).
   */
  stop() {
    this.#stopped = true;
    this.#abortController?.abort();
    this.#abortController = null;
  }

  /**
   * Tear down: abort + release.
   */
  destroy() {
    this.stop();
    this.#loaded = false;
  }

  // ------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------

  /**
   * @param {string} text
   * @param {string} voice
   * @param {(pcm: Float32Array, sampleRate: number) => void} onAudioChunk
   * @param {(() => void) | undefined} onDone
   * @param {((message: string) => void) | undefined} onError
   */
  async #doStream(text, voice, onAudioChunk, onDone, onError) {
    const signal = this.#abortController?.signal;

    let response;
    try {
      response = await fetch(`${this.#serverUrl}/v1/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice }),
        signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (this.#stopped) return;
      onError?.(err instanceof Error ? err.message : "TTS request failed");
      return;
    }

    if (!response.ok) {
      if (this.#stopped) return;
      onError?.(`TTS server error: ${response.status}`);
      return;
    }

    // Read the streaming WAV body
    const reader = response.body?.getReader();
    if (!reader) {
      if (this.#stopped) return;
      onError?.("TTS response has no readable body");
      return;
    }

    try {
      /** @type {Uint8Array[]} */
      const chunks = [];
      let totalLength = 0;

      while (true) {
        let readResult;
        try {
          readResult = await reader.read();
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") return;
          throw err;
        }

        const { done, value } = readResult;
        if (done) break;
        chunks.push(value);
        totalLength += value.length;
      }

      // Concatenate all chunks
      const buffer = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.length;
      }

      // Decode WAV
      const decoded = this.#decodeWav(buffer);
      if (!decoded) {
        if (this.#stopped) return;
        onError?.("Failed to decode WAV response");
        return;
      }

      const { pcm, sampleRate } = decoded;
      if (pcm.length > 0) {
        // Deliver in reasonable-sized chunks
        const CHUNK_SIZE = 4096;
        for (let i = 0; i < pcm.length; i += CHUNK_SIZE) {
          if (this.#stopped) return;
          const slice = pcm.subarray(i, Math.min(i + CHUNK_SIZE, pcm.length));
          onAudioChunk(slice, sampleRate);
        }
      }

      if (this.#stopped) return;
      onDone?.();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (this.#stopped) return;
      onError?.(err instanceof Error ? err.message : "TTS stream error");
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  }

  /**
   * Decode a WAV buffer into { pcm: Float32Array, sampleRate: number }.
   * Handles float32 (format 3) and int16 PCM (format 1).
   * Returns null if the WAV cannot be decoded.
   *
   * @param {Uint8Array} buffer
   * @returns {{ pcm: Float32Array, sampleRate: number } | null}
   */
  #decodeWav(buffer) {
    if (buffer.length < 44) return null;

    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

    // Verify RIFF header
    if (!this.#bytesMatch(buffer, 0, "RIFF")) return null;
    if (!this.#bytesMatch(buffer, 8, "WAVE")) return null;

    let sampleRate = 24000;
    let numChannels = 1;
    let bitsPerSample = 32;
    let audioFormat = 0;
    let dataOffset = 0;
    let dataSize = 0;

    // Scan chunks
    let off = 12;
    while (off <= buffer.length - 8) {
      const chunkId = String.fromCharCode(
        buffer[off], buffer[off + 1], buffer[off + 2], buffer[off + 3]
      );
      const chunkSize = view.getUint32(off + 4, true);

      if (chunkId === "fmt ") {
        audioFormat = view.getUint16(off + 8, true);
        numChannels = view.getUint16(off + 10, true);
        sampleRate = view.getUint32(off + 12, true);
        bitsPerSample = view.getUint16(off + 22, true);
      } else if (chunkId === "data") {
        dataOffset = off + 8;
        dataSize = chunkSize;
        break;
      }

      off += 8 + chunkSize;
    }

    if (dataOffset === 0 || dataSize === 0) return null;

    // Only mono is supported for this client
    if (numChannels !== 1) {
      // Could downmix, but for tracer bullet just reject
      return null;
    }

    // Extract PCM
    let pcm;
    if (audioFormat === 3 && bitsPerSample === 32) {
      // IEEE float32 — direct copy
      const floatCount = Math.min(dataSize / 4, Math.floor((buffer.length - dataOffset) / 4));
      if (floatCount <= 0) return null;
      pcm = new Float32Array(floatCount);
      for (let i = 0; i < floatCount; i++) {
        pcm[i] = view.getFloat32(dataOffset + i * 4, true);
      }
    } else if (audioFormat === 1 && bitsPerSample === 16) {
      // int16 PCM — convert to float
      const sampleCount = Math.min(dataSize / 2, Math.floor((buffer.length - dataOffset) / 2));
      if (sampleCount <= 0) return null;
      pcm = new Float32Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        pcm[i] = view.getInt16(dataOffset + i * 2, true) / 32768.0;
      }
    } else {
      // Unsupported format — return empty (no crash)
      return { pcm: new Float32Array(0), sampleRate };
    }

    return { pcm, sampleRate };
  }

  /**
   * Check if buffer bytes at offset match an ASCII string.
   * @param {Uint8Array} buffer
   * @param {number} offset
   * @param {string} str
   * @returns {boolean}
   */
  #bytesMatch(buffer, offset, str) {
    for (let i = 0; i < str.length; i++) {
      if (buffer[offset + i] !== str.charCodeAt(i)) return false;
    }
    return true;
  }
}
