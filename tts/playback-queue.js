/**
 * @typedef {Object} TTSPlaybackQueueDeps
 * @property {import("./tts-engine.js").TTSEngine} ttsEngine
 * @property {import("../audio/audio-graph.js").AudioGraphChannel} channel
 * @property {string} voice
 * @property {number} [sentenceGapMs]
 * @property {() => void} [onIdle]
 * @property {string} [modelName]
 * @property {import("../session/event-bus.js").SimpleEventBus} [eventBus]
 */

/**
 * Manages a playback queue for TTS sentence chunks.
 * Uses pre-synthesis: while sentence N plays, sentence N+1 is synthesized
 * on the main thread so it can start immediately after.
 *
 * Fires `onIdle` when the queue is empty and nothing is playing.
 */
const State = Object.freeze({
  Idle: "Idle",
  Synthesizing: "Synthesizing",
  Playing: "Playing",
  Gapping: "Gapping",
  Paused: "Paused",
  Stopped: "Stopped",
});

export class TTSPlaybackQueue {
  /** @type {import("./tts-engine.js").TTSEngine} */
  #ttsEngine;
  /** @type {import("../audio/audio-graph.js").AudioGraphChannel} */
  #channel;
  /** @type {string} */
  #voice;
  /** @type {number} */
  #sentenceGapMs;
  /** @type {(() => void) | undefined} */
  #onIdle;
  /** @type {string | undefined} */
  #modelName;
  /** @type {import("../session/event-bus.js").SimpleEventBus | undefined} */
  #eventBus;
  /** @type {string[]} */
  #queue = [];
  /** @type {string} */
  #state = State.Idle;
  /** @type {string | null} */
  #previousState = null;
  /** @type {boolean} */
  #softStopRequested = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  #sentenceTimeout = null;
  /** @type {boolean} */
  #processing = false;
  /** @type {AudioBuffer | null} */
  #nextBuffer = null;
  /** @type {Promise<void> | null} */
  #synthPromise = null;

  /**
   * @param {TTSPlaybackQueueDeps} deps
   */
  constructor({ ttsEngine, channel, voice, sentenceGapMs = 50, onIdle, modelName, eventBus }) {
    this.#ttsEngine = ttsEngine;
    this.#channel = channel;
    this.#voice = voice;
    this.#sentenceGapMs = sentenceGapMs;
    this.#onIdle = onIdle;
    this.#modelName = modelName;
    this.#eventBus = eventBus;
  }

  /** Enqueue a sentence for synthesis and playback.
   * @param {string} text
   * @returns {void}
   */
  enqueue(text) {
    if (this.#state === State.Stopped) return;
    this.#queue.push(text);
    this.#ensurePreSynthesis();
    if (this.#state === State.Idle) {
      this.#playNext();
    }
  }

  /** Pause: stop processing new sentences (queued items are held).
   * Pre-synthesis continues in the background.
   * @returns {void}
   */
  pause() {
    if (this.#state === State.Stopped || this.#state === State.Paused) return;
    this.#previousState = this.#state;
    if (this.#sentenceTimeout) {
      clearTimeout(this.#sentenceTimeout);
      this.#sentenceTimeout = null;
    }
    this.#state = State.Paused;
    this.#emitState();
  }

  /** Resume: start processing the queue if items are waiting.
   * @returns {void}
   */
  resume() {
    if (this.#state !== State.Paused) return;
    const prev = this.#previousState;
    this.#previousState = null;

    if (this.#queue.length === 0 && !this.#nextBuffer && prev !== State.Gapping) {
      this.#state = State.Idle;
      this.#emitState();
      return;
    }

    if (prev === State.Gapping) {
      this.#state = State.Gapping;
      this.#emitState();
      this.#sentenceTimeout = setTimeout(() => {
        this.#sentenceTimeout = null;
        if (this.#state === State.Gapping) {
          this.#playNext();
        }
      }, this.#sentenceGapMs);
      return;
    }

    this.#state = State.Synthesizing;
    this.#emitState();
    this.#playNext();
  }

  /** Stop gracefully: let current sentence finish playing, discard the rest.
   * @returns {void}
   */
  stop() {
    if (this.#state === State.Stopped) return;
    this.#softStopRequested = true;
    this.#queue = [];
    if (this.#sentenceTimeout) {
      clearTimeout(this.#sentenceTimeout);
      this.#sentenceTimeout = null;
    }
    if (this.#state === State.Playing || this.#state === State.Synthesizing) {
      // Let the in-flight sentence finish playing, then Stopped.
      return;
    }
    this.#state = State.Stopped;
    this.#emitState();
    this.#onIdle?.();
  }

  /** Whether the queue has any pending or in-flight work.
   * @returns {boolean}
   */
  get isActive() {
    return (
      this.#state === State.Synthesizing ||
      this.#state === State.Playing ||
      this.#state === State.Gapping ||
      this.#queue.length > 0 ||
      this.#nextBuffer !== null
    );
  }

  /** Whether the queue is currently paused.
   * @returns {boolean}
   */
  get isPaused() {
    return this.#state === State.Paused;
  }

  /** @returns {string} */
  get state() {
    return this.#state;
  }

  /** @returns {number} */
  get depth() {
    return this.#queue.length + (this.#nextBuffer ? 1 : 0);
  }

  #emitState() {
    if (!this.#eventBus) return;
    this.#eventBus.emit("queue-state", {
      modelName: this.#modelName,
      depth: this.depth,
      state: this.#state,
    });
  }

  /**
   * @param {number} timingMs
   */
  #emitSynthTiming(timingMs) {
    if (!this.#eventBus) return;
    this.#eventBus.emit("synth-timing", {
      modelName: this.#modelName,
      timingMs,
    });
  }

  /** Kick off synthesis of the next queued sentence if nothing is in flight.
   * @returns {void}
   */
  #ensurePreSynthesis() {
    if (this.#nextBuffer || this.#synthPromise || this.#queue.length === 0) return;
    if (this.#softStopRequested) return;

    const text = /** @type {string} */ (this.#queue.shift());
    const start = Date.now();
    this.#synthPromise = this.#ttsEngine
      .synthesize(text, this.#voice)
      .then((buffer) => {
        this.#emitSynthTiming(Date.now() - start);
        this.#nextBuffer = buffer;
        // If we were gapping waiting for this buffer, start playing immediately
        if (this.#state === State.Gapping) {
          if (this.#sentenceTimeout) {
            clearTimeout(this.#sentenceTimeout);
            this.#sentenceTimeout = null;
          }
          this.#playNext();
        }
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`TTS pre-synthesis failed: ${message}`);
      })
      .finally(() => {
        this.#synthPromise = null;
      });
  }

  async #playNext() {
    if (this.#processing) return;
    this.#processing = true;

    try {
      while (true) {
        if (this.#state === State.Stopped) {
          this.#onIdle?.();
          return;
        }

        if (this.#state === State.Paused && !this.#softStopRequested) {
          return;
        }

        if (this.#softStopRequested) {
          this.#state = State.Stopped;
          this.#emitState();
          this.#onIdle?.();
          return;
        }

        // Determine buffer to play
        let buffer = this.#nextBuffer;
        if (buffer) {
          this.#nextBuffer = null;
        } else if (this.#synthPromise) {
          this.#state = State.Synthesizing;
          this.#emitState();
          await this.#synthPromise;
          buffer = this.#nextBuffer;
          this.#nextBuffer = null;
          if (!buffer) {
            // Pre-synthesis failed — loop to try next
            continue;
          }
        } else if (this.#queue.length > 0) {
          const text = /** @type {string} */ (this.#queue.shift());
          try {
            this.#state = State.Synthesizing;
            this.#emitState();
            const start = Date.now();
            buffer = await this.#ttsEngine.synthesize(text, this.#voice);
            this.#emitSynthTiming(Date.now() - start);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`TTS synthesis failed: ${message}`);
            if (this.#state === State.Paused && !this.#softStopRequested) {
              this.#queue.unshift(text);
              return;
            }
            continue;
          }
        } else {
          this.#state = State.Idle;
          this.#emitState();
          this.#onIdle?.();
          return;
        }

        if (!buffer) continue;

        if (this.#softStopRequested) {
          this.#state = State.Stopped;
          this.#emitState();
          this.#onIdle?.();
          return;
        }

        if (this.#state === State.Paused && !this.#softStopRequested) {
          this.#nextBuffer = buffer;
          return;
        }

        // Start pre-synthesis of the NEXT sentence before playing
        this.#ensurePreSynthesis();

        // Play through the channel
        this.#state = State.Playing;
        this.#emitState();
        await this.#playBuffer(buffer);

        if (this.#softStopRequested) {
          this.#state = State.Stopped;
          this.#emitState();
          this.#onIdle?.();
          return;
        }

        if (this.#state === State.Paused && !this.#softStopRequested) {
          return;
        }

        // After playback, decide what to do next
        if (this.#queue.length === 0 && !this.#nextBuffer && !this.#synthPromise) {
          this.#state = State.Idle;
          this.#emitState();
          this.#onIdle?.();
          return;
        }

        if (!this.#nextBuffer) {
          this.#state = State.Gapping;
          this.#emitState();
          this.#sentenceTimeout = setTimeout(() => {
            this.#sentenceTimeout = null;
            if (this.#state === State.Gapping) {
              this.#playNext();
            }
          }, this.#sentenceGapMs);
          return;
        }

        // #nextBuffer is ready — loop immediately for gap-free playback
      }
    } finally {
      this.#processing = false;
    }
  }

  /**
   * @param {AudioBuffer} buffer
   * @returns {Promise<void>}
   */
  #playBuffer(buffer) {
    return new Promise((/** @type {(value: void) => void} */ resolve) => {
      this.#channel.play(buffer, () => resolve());
    });
  }
}
