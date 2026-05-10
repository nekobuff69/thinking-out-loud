import { TTSEngine } from "./tts-engine.js";

/**
 * @typedef {import("../session/event-bus.js").SimpleEventBus} SimpleEventBus
 */

/**
 * @typedef {Object} StreamHandle
 * @property {(text: string) => void} sendText - Send incremental text chunk
 * @property {() => void} close - Signal end of text (sends close_stream)
 */

/**
 * Kyutai DSM TTS WebSocket client.
 *
 * Implements both the legacy single-shot protocol (for replay) and the new
 * streaming protocol (for live TTS synthesis).
 *
 * New streaming protocol:
 *   Client -> Server: {"type":"open_stream","voice":"..."}
 *   Client -> Server: {"type":"text","data":"..."}
 *   Client -> Server: {"type":"close_stream"}
 *   Server -> Client: {"type":"pcm","data":[...]}
 *   Server -> Client: {"type":"done"}
 *   Server -> Client: {"type":"error","message":"..."}
 *
 * Legacy protocol (preserved for replay):
 *   Client -> Server: {"type":"synthesize","text":"...","voice":"..."}
 *   Server -> Client: {"type":"pcm","data":[...]}
 *   Server -> Client: {"type":"done"}
 *   Server -> Client: {"type":"error","message":"..."}
 *
 * One active stream at a time. Auto-reconnect with exponential backoff.
 * Emits TTS debug events on the optional event bus.
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

  // Active stream mode: 'none' | 'synthesize' (old) | 'stream' (new)
  /** @type {'none' | 'synthesize' | 'stream'} */
  #streamMode = 'none';

  // Old-path callbacks (startStream)
  /** @type {((pcm: Float32Array, sampleRate: number) => void) | null} */
  #currentOnChunk = null;
  /** @type {(() => void) | null} */
  #currentOnDone = null;
  /** @type {((msg: string) => void) | null} */
  #currentOnError = null;

  // New-path callbacks (openStream)
  /** @type {{ onAudioChunk: (pcm: Float32Array, sampleRate: number) => void, onDone: () => void, onError: (msg: string) => void } | null} */
  #streamCallbacks = null;
  /** @type {boolean} */
  #streamHandleClosed = false;

  // Stream state for reconnect re-subscribe
  // For 'synthesize' mode: { text, voice }
  // For 'stream' mode: { voice }
  /** @type {{ text?: string, voice: string } | null} */
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
   * Open WebSocket connection to TTS server.
   * Idempotent — resolves immediately if already connected.
   * @returns {Promise<void>}
   */
  async load() {
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) return;

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
        this.#eventBus?.emit("tts-connect", { modelName: this.#modelName });

        // Re-subscribe active stream state after reconnect
        if (this.#activeStreamState) {
          if (this.#streamMode === 'stream') {
            this.#streamHandleClosed = false;
            ws.send(JSON.stringify({ type: "open_stream", voice: this.#activeStreamState.voice }));
          } else {
            ws.send(JSON.stringify({
              type: "synthesize",
              text: this.#activeStreamState.text || "",
              voice: this.#activeStreamState.voice,
            }));
          }
          this.#firstChunkEmitted = false;
          this.#streamStartTime = Date.now();
        }

        this.#onReconnect?.();
        resolve();
      };

      ws.onerror = () => {
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

          // Route to active stream callbacks
          if (this.#streamMode === 'stream' && this.#streamCallbacks) {
            this.#streamCallbacks.onAudioChunk(pcmArray, this.#sampleRate);
          } else {
            this.#currentOnChunk?.(pcmArray, this.#sampleRate);
          }
        } else if (msgType === "done") {
          if (this.#streamMode === 'stream') {
            const cb = this.#streamCallbacks?.onDone;
            this.#clearCurrentStream();
            cb?.();
            this.#eventBus?.emit("tts-done", { modelName: this.#modelName });
          } else {
            const done = this.#currentOnDone;
            this.#clearCurrentStream();
            done?.();
          }
        } else if (msgType === "error") {
          const msg = data.message || "Unknown TTS error";
          if (this.#streamMode === 'stream') {
            const cb = this.#streamCallbacks?.onError;
            this.#clearCurrentStream();
            cb?.(msg);
          } else {
            const err = this.#currentOnError;
            this.#clearCurrentStream();
            err?.(msg);
          }
          this.#eventBus?.emit("tts-error", { modelName: this.#modelName, message: msg });
        }
      };

      ws.onclose = () => {
        this.#loaded = false;
        this.#ws = null;
        this.#eventBus?.emit("tts-disconnect", { modelName: this.#modelName });

        if (!this.#destroyed) {
          this.#scheduleReconnect();
        }
      };
    });
  }

  /**
   * Schedule reconnect with exponential backoff.
   */
  #scheduleReconnect() {
    if (this.#destroyed) return;
    if (this.#reconnectTimer) return;

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

  async #doReconnect() {
    if (this.#destroyed) return;
    try {
      await this.load();
    } catch {
      this.#scheduleReconnect();
    }
  }

  // ------------------------------------------------------------------
  // Old API (preserved for replay)
  // ------------------------------------------------------------------

  /**
   * Legacy single-shot synthesis. Preserved for replay.
   * Sends full text via `synthesize` message.
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
    this.#streamMode = 'synthesize';

    this.#currentOnChunk = onAudioChunk;
    this.#currentOnDone = callbacks?.onDone || null;
    this.#currentOnError = callbacks?.onError || null;
    this.#activeStreamState = { text, voice };

    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
      this.#currentOnError?.("TTS server not connected");
      this.#clearCurrentStream();
      return;
    }

    this.#ws.send(JSON.stringify({ type: "synthesize", text, voice }));
  }

  /**
   * Abort the current stream (both old and new paths).
   * Stops delivering chunks. WebSocket stays open.
   */
  stop() {
    this.#stopped = true;
    this.#clearCurrentStream();
  }

  // ------------------------------------------------------------------
  // New streaming API
  // ------------------------------------------------------------------

  /**
   * Open a streaming TTS session.
   *
   * Sends `open_stream` message. Returns a handle for incremental text
   * feeding. Only one active stream per backend at a time.
   *
   * @param {string} voice
   * @param {{ onAudioChunk: (pcm: Float32Array, sampleRate: number) => void, onDone: () => void, onError: (message: string) => void }} callbacks
   * @returns {StreamHandle}
   */
  openStream(voice, { onAudioChunk, onDone, onError }) {
    this.#clearCurrentStream();
    this.#stopped = false;
    this.#firstChunkEmitted = false;
    this.#streamStartTime = Date.now();
    this.#streamMode = 'stream';
    this.#streamHandleClosed = false;

    this.#streamCallbacks = { onAudioChunk, onDone, onError };
    this.#activeStreamState = { voice };

    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify({ type: "open_stream", voice }));
    }

    // Return stream handle
    const self = this;
    return {
      sendText(text) {
        if (self.#streamMode !== 'stream' || self.#streamHandleClosed) return;
        if (self.#ws && self.#ws.readyState === WebSocket.OPEN) {
          self.#ws.send(JSON.stringify({ type: "text", data: text }));
        }
      },
      close() {
        if (self.#streamMode !== 'stream' || self.#streamHandleClosed) return;
        self.#streamHandleClosed = true;
        if (self.#ws && self.#ws.readyState === WebSocket.OPEN) {
          self.#ws.send(JSON.stringify({ type: "close_stream" }));
        }
      },
    };
  }

  /**
   * Close the WebSocket connection. Prevents auto-reconnect.
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

  /** Clear active stream callbacks. Does NOT clear #activeStreamState (for reconnect). */
  #clearCurrentStream() {
    this.#streamMode = 'none';
    this.#currentOnChunk = null;
    this.#currentOnDone = null;
    this.#currentOnError = null;
    this.#streamCallbacks = null;
    this.#streamHandleClosed = false;
  }
}
