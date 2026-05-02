/**
 * Accumulates reasoning tokens and flushes complete sentences.
 * Fires onSentence(text) when a sentence boundary is detected
 * or the timeout token threshold is reached.
 */
export class SentenceBuffer {
  #buffer = "";
  #tokenCount = 0;
  #maxTokens;
  #timeoutTokens;
  #totalTokensFlushed = 0;
  #capped = false;
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

  /** Feed a single token from the stream. */
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

  /** Flush any remaining buffered text (called when stream ends). */
  flush() {
    const text = this.#buffer.trim();
    if (text) this.#onSentence(text);
    this.#buffer = "";
    this.#tokenCount = 0;
  }

  /** Whether the token cap has been reached. */
  get isCapped() {
    return this.#capped;
  }

  #findSentenceBoundary(text) {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "." || ch === "!" || ch === "?" || ch === ";" || ch === "\n") {
        return i;
      }
    }
    return -1;
  }
}
