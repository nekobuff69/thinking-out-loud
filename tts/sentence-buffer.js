/**
 * Accumulates reasoning tokens and flushes complete sentences.
 * Bundles two sentences before flushing to amortize TTS synthesis overhead.
 * Fires onSentence(text) when two sentences are ready, on timeout,
 * or when the total token cap is reached.
 */
export class SentenceBuffer {
  /** @type {string} */
  #buffer = "";
  /** @type {number} */
  #tokenCount = 0;
  /** @type {string[]} */
  #pendingSentences = [];
  /** @type {number} */
  #pendingTokenCount = 0;
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
  /** @type {string | undefined} */
  #modelName;
  /** @type {import("../session/event-bus.js").SimpleEventBus | undefined} */
  #eventBus;

  /**
   * @param {object} opts
   * @param {number} opts.maxTokens - Total token cap before stopping new sentences
   * @param {number} opts.timeoutTokens - Tokens without boundary before forced flush
   * @param {(text: string) => void} opts.onSentence - Called with each flushed sentence bundle
   * @param {string} [opts.modelName]
   * @param {import("../session/event-bus.js").SimpleEventBus} [opts.eventBus]
   */
  constructor({ maxTokens, timeoutTokens, onSentence, modelName, eventBus }) {
    this.#maxTokens = maxTokens;
    this.#timeoutTokens = timeoutTokens;
    this.#onSentence = onSentence;
    this.#modelName = modelName;
    this.#eventBus = eventBus;
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
    if (this.#totalTokensFlushed + this.#pendingTokenCount + this.#tokenCount >= this.#maxTokens) {
      this.#cap();
      this.#emitState();
      return;
    }

    // Check for sentence boundary
    const boundaryIndex = this.#findSentenceBoundary(this.#buffer);
    if (boundaryIndex >= 0) {
      const sentence = this.#buffer.slice(0, boundaryIndex + 1).trim();
      if (sentence) {
        this.#pendingSentences.push(sentence);
        this.#pendingTokenCount += this.#tokenCount;
      }
      this.#buffer = this.#buffer.slice(boundaryIndex + 1);
      this.#tokenCount = 0;

      if (this.#pendingSentences.length >= 2) {
        this.#flushPending();
      } else {
        this.#emitState();
      }
      return;
    }

    // Timeout: force-flush if current buffer exceeds threshold without boundary
    if (this.#tokenCount >= this.#timeoutTokens) {
      if (this.#pendingSentences.length > 0) {
        // Flush only completed sentences, keep the current incomplete buffer
        this.#flushPending();
      } else {
        // No completed sentence held, flush the current buffer
        const text = this.#buffer.trim();
        if (text) this.#onSentence(text);
        this.#totalTokensFlushed += this.#tokenCount;
        this.#buffer = "";
        this.#tokenCount = 0;
        this.#emitState();
      }
    }
  }

  /** Flush any remaining buffered text (called when stream ends).
   * @returns {void}
   */
  flush() {
    if (this.#pendingSentences.length > 0) {
      this.#flushPending();
    }
    const text = this.#buffer.trim();
    if (text) {
      this.#onSentence(text);
      this.#totalTokensFlushed += this.#tokenCount;
    }
    this.#buffer = "";
    this.#tokenCount = 0;
    this.#emitState();
  }

  /** Whether the token cap has been reached.
   * @returns {boolean}
   */
  get isCapped() {
    return this.#capped;
  }

  /** @returns {string[]} */
  get pendingSentences() {
    return [...this.#pendingSentences];
  }

  /** @returns {number} */
  get pendingTokenCount() {
    return this.#pendingTokenCount;
  }

  /** @returns {number} */
  get currentTokenCount() {
    return this.#tokenCount;
  }

  #flushPending() {
    const text = this.#pendingSentences.join(" ");
    if (text) this.#onSentence(text);
    this.#totalTokensFlushed += this.#pendingTokenCount;
    this.#pendingSentences = [];
    this.#pendingTokenCount = 0;
    this.#emitState();
  }

  #emitState() {
    if (!this.#eventBus) return;
    const wordCount = this.#buffer.trim().split(/\s+/).filter(Boolean).length
      + this.#pendingSentences.join(" ").split(/\s+/).filter(Boolean).length;
    this.#eventBus.emit("buffer-state", {
      modelName: this.#modelName,
      tokenCount: this.#totalTokensFlushed + this.#pendingTokenCount + this.#tokenCount,
      wordCount,
      sentencesHeld: this.#pendingSentences.length,
      capped: this.#capped,
    });
  }

  #cap() {
    const boundaryIndex = this.#findSentenceBoundary(this.#buffer);
    if (boundaryIndex >= 0) {
      const sentence = this.#buffer.slice(0, boundaryIndex + 1).trim();
      if (sentence) {
        this.#pendingSentences.push(sentence);
        this.#pendingTokenCount += this.#tokenCount;
      }
      this.#buffer = this.#buffer.slice(boundaryIndex + 1);
      this.#tokenCount = 0;
    }
    if (this.#pendingSentences.length > 0) {
      this.#flushPending();
    }
    this.#capped = true;
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
