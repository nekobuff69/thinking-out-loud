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

  /** Stop gracefully: finish current sentence, discard remaining. */
  stop() {
    this.#stopped = true;
    this.#queue = [];
    if (this.#sentenceTimeout) {
      clearTimeout(this.#sentenceTimeout);
      this.#sentenceTimeout = null;
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
      if (!this.#paused) this.#onIdle?.();
      return;
    }

    this.#playing = true;
    const text = this.#queue.shift();

    if (this.#stopped || this.#paused) {
      // Re-enqueue if paused mid-flight
      if (this.#paused && !this.#stopped) {
        this.#queue.unshift(text);
      }
      this.#playing = false;
      if (!this.#paused) this.#onIdle?.();
      return;
    }

    // Synthesize
    const buffer = await this.#ttsEngine.synthesize(text, this.#voice);

    if (this.#stopped || this.#paused) {
      if (this.#paused && !this.#stopped) {
        this.#queue.unshift(text);
      }
      this.#playing = false;
      if (!this.#paused) this.#onIdle?.();
      return;
    }

    // Play through the channel
    await this.#playBuffer(buffer);

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
