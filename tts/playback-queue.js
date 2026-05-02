/**
 * Manages a playback queue for TTS sentence chunks.
 * Handles synthesis, playback ordering, 200ms gaps, and graceful stop.
 *
 * Fires `onIdle` when the queue is empty and nothing is playing.
 */
export class TTSPlaybackQueue {
  #ttsEngine;
  #channel;
  #voice;
  #sentenceGapMs;
  #onIdle;
  #queue = [];
  #playing = false;
  #stopped = false;
  #softStopping = false;
  #paused = false;
  #sentenceTimeout = null;

  constructor({ ttsEngine, channel, voice, sentenceGapMs = 200, onIdle }) {
    this.#ttsEngine = ttsEngine;
    this.#channel = channel;
    this.#voice = voice;
    this.#sentenceGapMs = sentenceGapMs;
    this.#onIdle = onIdle;
  }

  /** Enqueue a sentence for synthesis and playback. */
  enqueue(text) {
    if (this.#stopped) return;
    this.#queue.push(text);
    // Only autoplay if not paused
    if (!this.#playing && !this.#paused) {
      this.#playNext();
    }
  }

  /** Pause: stop processing new sentences (queued items are held). */
  pause() {
    this.#paused = true;
    if (this.#sentenceTimeout) {
      clearTimeout(this.#sentenceTimeout);
      this.#sentenceTimeout = null;
    }
  }

  /** Resume: start processing the queue if items are waiting. */
  resume() {
    this.#paused = false;
    if (!this.#playing && this.#queue.length > 0 && !this.#stopped) {
      this.#playNext();
    }
  }

  /** Stop gracefully: let current sentence finish playing, discard the rest. */
  stop() {
    this.#softStopping = true;
    this.#queue = [];
    // Cancel the inter-sentence gap timeout so we don't start the next one
    if (this.#sentenceTimeout) {
      clearTimeout(this.#sentenceTimeout);
      this.#sentenceTimeout = null;
    }
    // If nothing is currently playing, resolve immediately
    if (!this.#playing) {
      this.#stopped = true;
      this.#onIdle?.();
    }
  }

  /** Whether the queue has any pending or in-flight work. */
  get isActive() {
    return this.#playing || this.#queue.length > 0;
  }

  /** Whether the queue is currently paused. */
  get isPaused() {
    return this.#paused;
  }

  async #playNext() {
    if (this.#queue.length === 0) {
      this.#playing = false;
      // If soft-stopping and queue is empty, we're done
      if (this.#softStopping) {
        this.#stopped = true;
        this.#onIdle?.();
        return;
      }
      if (!this.#paused) this.#onIdle?.();
      return;
    }

    this.#playing = true;
    const text = this.#queue.shift();

    if (this.#stopped || this.#paused) {
      if (this.#paused && !this.#stopped) {
        this.#queue.unshift(text);
      }
      this.#playing = false;
      if (!this.#paused) this.#onIdle?.();
      return;
    }

    // If soft-stopping, don't start new sentences —
    // but if we're mid-synthesis let it finish playing
    if (this.#softStopping) {
      this.#queue = [];
      this.#playing = false;
      this.#stopped = true;
      this.#onIdle?.();
      return;
    }

    // Synthesize
    let buffer;
    try {
      buffer = await this.#ttsEngine.synthesize(text, this.#voice);
    } catch (err) {
      console.error(`TTS synthesis failed: ${err.message}`);
      // Skip this sentence and move on — don't deadlock the session
      this.#playing = false;
      if (!this.#paused && !this.#stopped) {
        this.#playNext();
      } else if (!this.#paused) {
        this.#onIdle?.();
      }
      return;
    }

    // If soft-stopped or hard-stopped during synthesis, play the buffer anyway
    // (soft-stop lets the current sentence finish), then stop.
    if (this.#stopped) {
      this.#playing = false;
      this.#onIdle?.();
      return;
    }
    if (this.#paused && !this.#softStopping) {
      this.#queue.unshift(text);
      this.#playing = false;
      return;
    }

    // Play through the channel (always plays even if softStopping)
    await this.#playBuffer(buffer);

    // After playback, if soft-stopping, transition to fully stopped
    if (this.#softStopping) {
      this.#playing = false;
      this.#stopped = true;
      this.#onIdle?.();
      return;
    }
    if (this.#stopped || this.#paused) {
      if (this.#paused && !this.#stopped) {
        this.#queue.unshift(text);
      }
      this.#playing = false;
      if (!this.#paused) this.#onIdle?.();
      return;
    }

    // 200ms gap before next sentence
    this.#sentenceTimeout = setTimeout(() => {
      this.#sentenceTimeout = null;
      this.#playNext();
    }, this.#sentenceGapMs);
  }

  #playBuffer(buffer) {
    return new Promise((resolve) => {
      this.#channel.play(buffer, () => resolve());
    });
  }
}
