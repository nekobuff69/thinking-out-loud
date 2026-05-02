/**
 * Accumulates reasoning tokens and flushes complete sentences.
 * Fires onSentence(text) when a sentence boundary is detected
 * or the timeout token threshold is reached.
 */
export class SentenceBuffer {
  /** @type {string} */
  #buffer = "";
  /** @type {number} */
  #tokenCount = 0;
  /** @type {number} */
  #maxTokens;
  /** @type {number} */
  #timeoutTokens;
  /** @type {number} */
  #totalTokensFlushed = 0;
  /** @type {boolean} */
  #capped = false;
  /** @type {(text: string) => void} */
  #onSentence;

  /**
   * @param {object} opts
   * @param {number} opts.maxTokens - Total token cap before stopping new sentences
   * @param {number} opts.timeoutTokens - Tokens without boundary before forced flush
   * @param {(text: string) => void} opts.onSentence - Called with each flushed sentence
   */
  constructor({ maxTokens, timeoutTokens, onSentence }) {
    this.#maxTokens = maxTokens;
    this.#timeoutTokens = timeoutTokens;
    this.#onSentence = onSentence;
  }

  /** Feed a single token from the stream.
   * @param {string} token
   * @returns {void}
   */
  feed(token) {
    if (this.#capped) return;

    this.#buffer += token;
    this.#tokenCount++;

    // Check if we hit the token cap
    if (this.#totalTokensFlushed + this.#tokenCount >= this.#maxTokens) {
      // Finish the current sentence (look for boundary to finish naturally)
      // but mark as capped — no new sentences will start
      const boundaryIndex = this.#findSentenceBoundary(this.#buffer);
      if (boundaryIndex >= 0) {
        const sentence = this.#buffer.slice(0, boundaryIndex + 1).trim();
        if (sentence) this.#onSentence(sentence);
        this.#buffer = "";
        this.#tokenCount = 0;
      }
      this.#capped = true;
      return;
    }

    // Check for sentence boundary
    const boundaryIndex = this.#findSentenceBoundary(this.#buffer);
    if (boundaryIndex >= 0) {
      const sentence = this.#buffer.slice(0, boundaryIndex + 1).trim();
      if (sentence) this.#onSentence(sentence);
      this.#buffer = this.#buffer.slice(boundaryIndex + 1);
      this.#tokenCount = 0;
      return;
    }

    // Timeout: force-flush if buffer exceeds threshold without boundary
    if (this.#tokenCount >= this.#timeoutTokens) {
      const text = this.#buffer.trim();
      if (text) this.#onSentence(text);
      this.#buffer = "";
      this.#tokenCount = 0;
    }
  }

  /** Flush any remaining buffered text (called when stream ends).
   * @returns {void}
   */
  flush() {
    const text = this.#buffer.trim();
    if (text) this.#onSentence(text);
    this.#buffer = "";
    this.#tokenCount = 0;
  }

  /** Whether the token cap has been reached.
   * @returns {boolean}
   */
  get isCapped() {
    return this.#capped;
  }

  // Common English abbreviations that end with '.' but aren't sentence boundaries
  static #ABBREVIATIONS = new Set([
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st",
    "etc", "vs", "ie", "eg",
    "inc", "ltd", "co", "corp",
    "approx", "apt", "dept", "est",
    "govt", "assn", "bldg", "div",
  ]);

  /**
   * @param {string} text
   * @returns {number}
   */
  #findSentenceBoundary(text) {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "!" || ch === "?" || ch === ";" || ch === "\n") {
        return i;
      }
      // For '.', check if it's an abbreviation rather than a sentence end
      if (ch === ".") {
        // Skip if followed by a digit (decimal number like 3.14)
        if (i + 1 < text.length && /\d/.test(text[i + 1])) continue;
        // Skip if preceded by a single letter (initials like "A. ")
        if (i >= 1 && text[i - 1].length === 1 && /[a-zA-Z]/.test(text[i - 1])) {
          // But only if it looks like an initial (single uppercase letter + dot)
          if (i === 1 || /\s/.test(text[i - 2])) continue;
        }
        // Check for multi-letter abbreviations (e.g., "Dr.", "etc.")
        let wordStart = i - 1;
        while (wordStart >= 0 && /[a-zA-Z]/.test(text[wordStart])) {
          wordStart--;
        }
        const word = text.slice(wordStart + 1, i).toLowerCase();
        if (SentenceBuffer.#ABBREVIATIONS.has(word)) continue;
        // It's a real sentence boundary
        return i;
      }
    }
    return -1;
  }
}
