/**
 * Manages a playback queue for TTS sentence chunks.
 * Handles synthesis, playback ordering, 200ms gaps, and graceful stop.
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
  #ttsEngine;
  #channel;
  #voice;
  #sentenceGapMs;
  #onIdle;
  #queue = [];
  #state = State.Idle;
  #previousState = null;
  #softStopRequested = false;
  #sentenceTimeout = null;
  #processing = false;

  constructor({ ttsEngine, channel, voice, sentenceGapMs = 200, onIdle }) {
    this.#ttsEngine = ttsEngine;
    this.#channel = channel;
    this.#voice = voice;
    this.#sentenceGapMs = sentenceGapMs;
    this.#onIdle = onIdle;
  }

  /** Enqueue a sentence for synthesis and playback. */
  enqueue(text) {
    if (this.#state === State.Stopped) return;
    this.#queue.push(text);
    if (this.#state === State.Idle) {
      this.#playNext();
    }
  }

  /** Pause: stop processing new sentences (queued items are held). */
  pause() {
    if (this.#state === State.Stopped || this.#state === State.Paused) return;
    this.#previousState = this.#state;
    if (this.#sentenceTimeout) {
      clearTimeout(this.#sentenceTimeout);
      this.#sentenceTimeout = null;
    }
    this.#state = State.Paused;
  }

  /** Resume: start processing the queue if items are waiting. */
  resume() {
    if (this.#state !== State.Paused) return;
    const prev = this.#previousState;
    this.#previousState = null;

    if (this.#queue.length === 0 && prev !== State.Gapping) {
      this.#state = State.Idle;
      return;
    }

    if (prev === State.Gapping) {
      this.#state = State.Gapping;
      this.#sentenceTimeout = setTimeout(() => {
        this.#sentenceTimeout = null;
        if (this.#state === State.Gapping) {
          this.#playNext();
        }
      }, this.#sentenceGapMs);
      return;
    }

    this.#state = State.Synthesizing;
    this.#playNext();
  }

  /** Stop gracefully: let current sentence finish playing, discard the rest. */
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
    this.#onIdle?.();
  }

  /** Whether the queue has any pending or in-flight work. */
  get isActive() {
    return (
      this.#state === State.Synthesizing ||
      this.#state === State.Playing ||
      this.#state === State.Gapping ||
      this.#queue.length > 0
    );
  }

  /** Whether the queue is currently paused. */
  get isPaused() {
    return this.#state === State.Paused;
  }

  async #playNext() {
    if (this.#processing) return;
    this.#processing = true;

    try {
      while (true) {
        if (this.#state === State.Stopped || this.#state === State.Paused) {
          return;
        }

        if (this.#queue.length === 0) {
          if (this.#softStopRequested) {
            this.#state = State.Stopped;
            this.#onIdle?.();
            return;
          }
          if (this.#state !== State.Idle) {
            this.#state = State.Idle;
            this.#onIdle?.();
          }
          return;
        }

        if (this.#softStopRequested) {
          this.#state = State.Stopped;
          this.#onIdle?.();
          return;
        }

        const text = this.#queue.shift();

        // Synthesize
        let buffer;
        try {
          this.#state = State.Synthesizing;
          buffer = await this.#ttsEngine.synthesize(text, this.#voice);
        } catch (err) {
          console.error(`TTS synthesis failed: ${err.message}`);
          if (this.#state === State.Paused) {
            this.#queue.unshift(text);
            return;
          }
          continue;
        }

        if (this.#state === State.Paused && !this.#softStopRequested) {
          this.#queue.unshift(text);
          return;
        }

        // Play through the channel (soft-stop lets the current sentence finish)
        this.#state = State.Playing;
        await this.#playBuffer(buffer);

        if (this.#softStopRequested) {
          this.#state = State.Stopped;
          this.#onIdle?.();
          return;
        }

        if (this.#state === State.Paused) {
          this.#queue.unshift(text);
          return;
        }

        // Next sentence or gap
        if (this.#queue.length === 0) {
          this.#state = State.Idle;
          this.#onIdle?.();
          return;
        }

        this.#state = State.Gapping;
        this.#sentenceTimeout = setTimeout(() => {
          this.#sentenceTimeout = null;
          if (this.#state === State.Gapping) {
            this.#playNext();
          }
        }, this.#sentenceGapMs);
        return;
      }
    } finally {
      this.#processing = false;
    }
  }

  #playBuffer(buffer) {
    return new Promise((resolve) => {
      this.#channel.play(buffer, () => resolve());
    });
  }
}
