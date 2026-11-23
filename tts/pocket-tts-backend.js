import { TTSEngine } from "./tts-engine.js";

/** Samples per emitted PCM chunk (~170ms @ 24kHz mono). */
const CHUNK_SIZE = 4096;

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
   * The response is a streaming WAV.  We parse the WAV header as soon as it
   * arrives, then decode and deliver PCM incrementally as bytes come in —
   * playback can start before the server finishes synthesising the sentence.
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

    // Incremental decode state
    /** @type {Uint8Array[]} */
    const pending = [];
    let bufferedLength = 0;
    /** @type {{ sampleRate: number, numChannels: number, audioFormat: number, bitsPerSample: number, dataOffset: number, dataSize: number } | null} */
    let header = null;
    let bytesPerSample = 4;
    /** @type {DataView | null} */
    let view = null;
    let emittedSamples = 0;
    let done = false;

    /**
     * Concatenate pending byte chunks into one contiguous buffer.
     * @returns {Uint8Array}
     */
    const coalesce = () => {
      const buffer = new Uint8Array(bufferedLength);
      let offset = 0;
      for (const chunk of pending) {
        buffer.set(chunk, offset);
        offset += chunk.length;
      }
      pending.length = 0;
      pending.push(buffer);
      return buffer;
    };

    /**
     * Emit all complete samples that arrived since the last emission.
     * @param {Uint8Array} buffer
     * @param {(pcm: Float32Array, sampleRate: number) => void} cb
     */
    const emitAvailable = (buffer, cb) => {
      if (!header || !view) return;
      const data = header.dataSize < 0xFFFFFF00
        ? Math.min(header.dataSize, buffer.length - header.dataOffset)
        : buffer.length - header.dataOffset;
      if (data <= 0) return;
      const totalSamples = Math.floor(data / bytesPerSample);
      if (totalSamples <= emittedSamples) return;

      for (let i = emittedSamples; i < totalSamples; i += CHUNK_SIZE) {
        const end = Math.min(i + CHUNK_SIZE, totalSamples);
        const pcm = new Float32Array(end - i);
        for (let s = i; s < end; s++) {
          const byteOffset = header.dataOffset + s * bytesPerSample;
          if (header.audioFormat === 3 && header.bitsPerSample === 32) {
            pcm[s - i] = view.getFloat32(byteOffset, true);
          } else if (header.audioFormat === 1 && header.bitsPerSample === 16) {
            pcm[s - i] = view.getInt16(byteOffset, true) / 32768.0;
          } else {
            pcm[s - i] = 0;
          }
        }
        if (this.#stopped) return;
        cb(pcm, header.sampleRate);
      }
      emittedSamples = totalSamples;
    };

    try {
      while (true) {
        let readResult;
        try {
          readResult = await reader.read();
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") return;
          throw err;
        }

        const { done: streamDone, value } = readResult;
        if (value) {
          pending.push(value);
          bufferedLength += value.length;
        }
        if (streamDone) done = true;

        // Coalesce into one contiguous buffer, then try to parse the WAV
        // header once enough bytes have arrived.
        const buffer = coalesce();

        if (!header && bufferedLength >= 12) {
          header = this.#parseWavHeader(buffer);
          if (header) {
            if (header.numChannels !== 1) {
              if (this.#stopped) return;
              onError?.("TTS response is not mono — unsupported");
              return;
            }
            bytesPerSample = header.bitsPerSample / 8;
          } else if (done) {
            if (this.#stopped) return;
            onError?.("Failed to decode WAV response");
            return;
          }
        }

        if (header) {
          // The buffer is re-coalesced each iteration, so rebuild the view
          view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
          emitAvailable(buffer, onAudioChunk);
        }

        if (done) break;
      }

      if (!header) {
        if (this.#stopped) return;
        onError?.("Failed to decode WAV response");
        return;
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
   * Parse a WAV header from the beginning of *buffer*.
   * Handles float32 (format 3) and int16 PCM (format 1).
   * Returns null if the buffer does not (yet) contain a full header.
   *
   * Note: streaming responses carry a placeholder data size (0xFFFFFFFF);
   * consumers must use available byte counts instead of dataSize.
   *
   * @param {Uint8Array} buffer
   * @returns {{ sampleRate: number, numChannels: number, audioFormat: number, bitsPerSample: number, dataOffset: number, dataSize: number } | null}
   */
  #parseWavHeader(buffer) {
    if (buffer.length < 12) return null;

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

    // Scan chunks until "data" or the buffer runs out (incomplete header)
    let off = 12;
    while (off + 8 <= buffer.length) {
      const chunkId = String.fromCharCode(
        buffer[off], buffer[off + 1], buffer[off + 2], buffer[off + 3]
      );
      const chunkSize = view.getUint32(off + 4, true);

      if (chunkId === "fmt ") {
        if (off + 8 + 16 > buffer.length) return null; // fmt body not fully arrived
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

    if (dataOffset === 0) return null;

    return { sampleRate, numChannels, audioFormat, bitsPerSample, dataOffset, dataSize };
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
