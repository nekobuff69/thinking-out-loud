import { TTSEngine } from "./tts-engine.js";

/**
 * @typedef {import("../session/event-bus.js").SimpleEventBus} SimpleEventBus
 */

/**
 * Kyutai DSM TTS WebSocket client.
 * Implements the streaming TTSEngine interface connecting to a local Python+MLX server.
 *
 * Protocol (all JSON text frames over WebSocket):
 *   Client → Server: {"type": "synthesize", "text": "...", "voice": "..."}
 *   Server → Client: {"type": "pcm", "data": [float32_values]}
 *   Server → Client: {"type": "done"}
 *   Server → Client: {"type": "error", "message": "..."}
 *
 * The WebSocket connection is persistent; multiple startStream() calls reuse it.
 * PCM frames are decoded from JSON arrays into Float32Array and dispatched via
 * the onAudioChunk callback.
 *
 * Auto-reconnect with exponential backoff on unexpected WebSocket drops.
 * Emits tts-first-chunk and tts-chunk events on the optional event bus.
 */
export class KyutaiBackend extends TTSEngine {
  /** @type {string} */
  #wsUrl;
  /** @type {WebSocket | null} */
  #ws = null;
  /** @type {boolean} */
  #stopped = false;
  /** @type {number} */
  #sampleRate;
  /** @type {boolean} */
  #loaded = false;

  // Reconnect state
  /** @type {boolean} */
  #destroyed = false;
  /** @type {number} */
  #reconnectAttempt = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  #reconnectTimer = null;
  /** @type {number} */
  #reconnectBaseDelay = 1000;
  /** @type {number} */
  #maxReconnectDelay = 30000;
  /** @type {(() => void) | null} */
  #onReconnect = null;

  // Active stream state for re-subscribe after reconnect
  /** @type {{ text: string, voice: string } | null} */
  #activeStreamState = null;

  // Event bus
  /** @type {SimpleEventBus | undefined} */
  #eventBus;
  /** @type {string} */
  #modelName;

  // TTS event tracking
  /** @type {number} */
  #streamStartTime = 0;
  /** @type {boolean} */
  #firstChunkEmitted = false;

  /** Callbacks for the current active stream. Cleared on stop() or new startStream(). */
  /** @type {((pcm: Float32Array, sampleRate: number) => void) | null} */
  #currentOnChunk = null;
  /** @type {(() => void) | null} */
  #currentOnDone = null;
  /** @type {((msg: string) => void) | null} */
  #currentOnError = null;

  /**
   * @param {{ wsUrl?: string, sampleRate?: number, eventBus?: SimpleEventBus, modelName?: string, onReconnect?: () => void, reconnectBaseDelay?: number }} [opts]
   */
  constructor(opts = {}) {
    super();
    this.#wsUrl = opts.wsUrl || "ws://localhost:8765";
    this.#sampleRate = opts.sampleRate || 24000;
    this.#eventBus = opts.eventBus;
    this.#modelName = opts.modelName || "";
    this.#onReconnect = opts.onReconnect || null;
    this.#reconnectBaseDelay = opts.reconnectBaseDelay ?? 1000;
  }

  // Expose for tests
  get _testWs() { return this.#ws; }
  get _testDestroyed() { return this.#destroyed; }

  /**
   * Open WebSocket connection to the TTS server.
   * Resolves when connection is established.
   * Idempotent — subsequent calls are no-ops if already connected.
   * @returns {Promise<void>}
   */
  async load() {
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) return;

    // Clean up any stale connection
    if (this.#ws) {
      this.#ws.onopen = null;
      this.#ws.onmessage = null;
      this.#ws.onerror = null;
      this.#ws.onclose = null;
      try { this.#ws.close(); } catch {}
      this.#ws = null;
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.#wsUrl);
      this.#ws = ws;

      ws.onopen = () => {
        this.#loaded = true;
        this.#reconnectAttempt = 0;

        // Re-send active stream if one was in progress
        if (this.#activeStreamState) {
          const msg = JSON.stringify({
            type: "synthesize",
            text: this.#activeStreamState.text,
            voice: this.#activeStreamState.voice,
          });
          ws.send(msg);
          this.#firstChunkEmitted = false;
          this.#streamStartTime = Date.now();
        }

        this.#onReconnect?.();
        resolve();
      };

      ws.onerror = (ev) => {
        // Only reject if we haven't connected yet
        if (!this.#loaded) {
          reject(new Error("TTS server unreachable"));
        }
      };

      ws.onmessage = (ev) => {
        if (this.#stopped) return;

        let data;
        try {
          data = JSON.parse(/** @type {string} */ (ev.data));
        } catch {
          // Ignore non-JSON messages
          return;
        }

        const msgType = data.type;

        if (msgType === "pcm") {
          const pcmArray = new Float32Array(data.data);
          // Emit TTS events
          if (this.#eventBus && this.#modelName) {
            if (!this.#firstChunkEmitted) {
              this.#firstChunkEmitted = true;
              const latencyMs = this.#streamStartTime ? Date.now() - this.#streamStartTime : 0;
              this.#eventBus.emit("tts-first-chunk", {
                modelName: this.#modelName,
                latencyMs,
              });
            }
            this.#eventBus.emit("tts-chunk", {
              modelName: this.#modelName,
              bytesReceived: pcmArray.byteLength,
            });
          }
          this.#currentOnChunk?.(pcmArray, this.#sampleRate);
        } else if (msgType === "done") {
          const done = this.#currentOnDone;
          this.#clearCurrentStream();
          done?.();
        } else if (msgType === "error") {
          const msg = data.message || "Unknown TTS error";
          const err = this.#currentOnError;
          this.#clearCurrentStream();
          err?.(msg);
        }
      };

      ws.onclose = () => {
        this.#loaded = false;
        this.#ws = null;

        // If not intentionally destroyed, schedule reconnect
        if (!this.#destroyed) {
          this.#scheduleReconnect();
        }
      };
    });
  }

  /**
   * Schedule a reconnect attempt with exponential backoff.
   */
  #scheduleReconnect() {
    if (this.#destroyed) return;
    if (this.#reconnectTimer) return; // already scheduled

    const delay = Math.min(
      this.#reconnectBaseDelay * Math.pow(2, this.#reconnectAttempt),
      this.#maxReconnectDelay
    );
    this.#reconnectAttempt++;

    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#doReconnect();
    }, delay);
  }

  /**
   * Attempt to reconnect.
   */
  async #doReconnect() {
    if (this.#destroyed) return;
    try {
      await this.load();
    } catch {
      // load() failed — schedule another attempt
      this.#scheduleReconnect();
    }
  }

  /**
   * Begin streaming TTS synthesis for the given text.
   * If a previous stream is active, it is replaced.
   *
   * @param {string} text
   * @param {string} voice
   * @param {(pcm: Float32Array, sampleRate: number) => void} onAudioChunk
   * @param {{ onDone?: () => void, onError?: (message: string) => void }} [callbacks]
   */
  startStream(text, voice, onAudioChunk, callbacks) {
    this.#clearCurrentStream();
    this.#stopped = false;
    this.#firstChunkEmitted = false;
    this.#streamStartTime = Date.now();

    this.#currentOnChunk = onAudioChunk;
    this.#currentOnDone = callbacks?.onDone || null;
    this.#currentOnError = callbacks?.onError || null;

    // Save stream state for re-subscribe after reconnect
    this.#activeStreamState = { text, voice };

    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
      // Not connected — fire error and return
      this.#currentOnError?.("TTS server not connected");
      this.#clearCurrentStream();
      return;
    }

    const message = JSON.stringify({
      type: "synthesize",
      text,
      voice,
    });

    this.#ws.send(message);
  }

  /**
   * Abort the current stream.
   * Stops delivering PCM chunks. The WebSocket connection stays open.
   */
  stop() {
    this.#stopped = true;
    this.#clearCurrentStream();
  }

  /**
   * Close the WebSocket connection and release resources.
   * Prevents auto-reconnect.
   */
  destroy() {
    this.#destroyed = true;
    this.#stopped = true;
    this.#clearCurrentStream();

    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }

    if (this.#ws) {
      this.#ws.onopen = null;
      this.#ws.onmessage = null;
      this.#ws.onerror = null;
      this.#ws.onclose = null;
      try { this.#ws.close(); } catch {}
      this.#ws = null;
    }
    this.#loaded = false;
    this.#activeStreamState = null;
  }

  /** Clear active stream callbacks without closing WebSocket. */
  #clearCurrentStream() {
    this.#currentOnChunk = null;
    this.#currentOnDone = null;
    this.#currentOnError = null;
    // Note: #activeStreamState is NOT cleared here so reconnect can re-send
  }
}
