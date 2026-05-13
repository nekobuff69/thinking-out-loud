/**
 * Lightweight optional word accumulator for tuning TTS prosody.
 *
 * Inserted between the LLM token stream and the TTS backend. Accumulates
 * tokens and flushes on three triggers:
 *   1. Punctuation (., !, ?, ;, newline) — default
 *   2. Max word count (~8) — configurable
 *   3. Timeout (~150ms since last feed) — configurable
 *
 * When no TextChunker is active, tokens flush directly to TTS via the
 * ChannelPipeline's built-in debounce. TextChunker provides an alternative
 * segmentation strategy when raw streaming produces choppy prosody.
 */
export class TextChunker {
  /** @type {(text: string) => void} */
  #onFlush;
  /** @type {number} */
  #maxWords;
  /** @type {number} */
  #timeoutMs;
  /** @type {number} */
  #minWordsForTimeout;
  /** @type {boolean} */
  #flushOnPunctuation;
  /** @type {string} */
  #punctuation;
  /** @type {string} */
  #buffer = "";
  /** @type {number} */
  #wordCount = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  #timer = null;

  /**
   * @param {Object} opts
   * @param {(text: string) => void} opts.onFlush - Called with accumulated text when a flush trigger fires
   * @param {number} [opts.maxWords=8] - Max words before forcing a flush
   * @param {number} [opts.timeoutMs=150] - Max ms since last feed before flushing
   * @param {number} [opts.minWordsForTimeout=3] - Min words in buffer before timeout can trigger
   * @param {string} [opts.punctuation=".!?;,"] - Characters that trigger a flush
   * @param {boolean} [opts.flushOnPunctuation=true] - Whether to flush on punctuation marks
   */
  constructor({ onFlush, maxWords = 8, timeoutMs = 150, minWordsForTimeout = 3, punctuation = ".!?;,", flushOnPunctuation = true }) {
    this.#onFlush = onFlush;
    this.#maxWords = maxWords;
    this.#timeoutMs = timeoutMs;
    this.#minWordsForTimeout = minWordsForTimeout;
    this.#punctuation = punctuation;
    this.#flushOnPunctuation = flushOnPunctuation;
  }

  /**
   * Feed text into the accumulator.
   * May trigger a flush if any trigger condition is met.
   * @param {string} text
   * @returns {void}
   */
  feed(text) {
    const trimmed = text.trim();
    if (!trimmed) return;

    this.#buffer += text;

    // Count words in the full buffer
    this.#wordCount = this.#buffer.trim().split(/\s+/).length;

    // Check punctuation trigger — flush up to first punctuation, keep rest
    if (this.#flushOnPunctuation) {
      const punctIndex = this.#findPunctuation(this.#buffer);
      if (punctIndex >= 0) {
        const splitIndex = punctIndex + 1; // include the punctuation
        const flushText = this.#buffer.slice(0, splitIndex).trimEnd();
        const remainder = this.#buffer.slice(splitIndex).trimStart();
        if (flushText.length > 0) {
          this.#onFlush(flushText);
        }
        this.#buffer = remainder;
        this.#wordCount = this.#buffer.trim() ? this.#buffer.trim().split(/\s+/).length : 0;
        this.#clearTimer();
        // If there's still content, restart timeout
        if (this.#buffer.trim().length > 0) {
          this.#resetTimer();
        }
        return;
      }
    }

    // Check max words trigger
    if (this.#wordCount >= this.#maxWords) {
      this.#flush();
      return;
    }

    // Start/reset timeout
    this.#resetTimer();
  }

  /**
   * Force-flush the current buffer.
   * @returns {void}
   */
  flush() {
    this.#clearTimer();
    const text = this.#buffer.trim();
    this.#buffer = "";
    this.#wordCount = 0;
    if (text.length > 0) {
      this.#onFlush(text);
    }
  }

  /**
   * Clear the buffer without flushing.
   * @returns {void}
   */
  reset() {
    this.#clearTimer();
    this.#buffer = "";
    this.#wordCount = 0;
  }

  /**
   * Whether the chunker has pending text.
   * @returns {boolean}
   */
  get hasPending() {
    return this.#buffer.trim().length > 0;
  }

  /** @returns {void} */
  #flush() {
    this.#clearTimer();
    const text = this.#buffer.trim();
    this.#buffer = "";
    this.#wordCount = 0;
    if (text.length > 0) {
      this.#onFlush(text);
    }
  }

  /** @returns {void} */
  #resetTimer() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#wordCount >= this.#minWordsForTimeout) this.#flush();
    }, this.#timeoutMs);
  }

  /** @returns {void} */
  #clearTimer() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Find the index of the first punctuation character.
   * @param {string} text
   * @returns {number} -1 if none found
   */
  #findPunctuation(text) {
    for (let i = 0; i < text.length; i++) {
      if (this.#punctuation.includes(text[i])) {
        return i;
      }
    }
    return -1;
  }
}
