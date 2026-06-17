import { createWaveform } from "../audio/waveform.js";
import "./column.css";


/**
 * @typedef {Object} ColumnAPI
 * @property {HTMLDivElement} element
 * @property {(token: string) => void} appendToken
 * @property {() => void} clear
 * @property {(message: string) => void} setError
 * @property {(analyserNode: AnalyserNode, color: string) => void} attachWaveform
 * @property {() => void} stopWaveform
 * @property {(active: boolean) => void} setMuted
 * @property {(active: boolean) => void} setSoloed
 * @property {(fn: () => void) => void} onMuteToggle
 * @property {(fn: () => void) => void} onSoloToggle
 * @property {(startWordIndex: number, wordCount: number, durationMs: number) => void} startKaraoke
 * @property {(durationMs: number) => void} updateKaraokeDuration
 * @property {() => void} stopKaraoke
 */

/**
 * @typedef {import("../config.js").ModelConfig} ModelConfig
 */

/**
 * Renders a single model Column: display name, monospaced reasoning text,
 * auto-scroll with manual scroll-back, and "new content below" indicator.
 *
 * @param {HTMLElement} container
 * @param {ModelConfig} model
 * @returns {ColumnAPI}
 */
export function createColumn(container, model) {
  const col = document.createElement("div");
  col.className = "column";

  // Header with model name in model's color
  const header = document.createElement("div");
  header.className = "column-header";
  header.style.color = model.color;



  // Model name, then M/S buttons on the right
  header.appendChild(document.createTextNode(model.name));

  const muteBtn = document.createElement('button');
  muteBtn.className = 'mute-btn';
  muteBtn.textContent = 'M';
  muteBtn.style.marginLeft = '12px';
  muteBtn.setAttribute('aria-label', 'Mute ' + model.name);
  const soloBtn = document.createElement('button');
  soloBtn.className = 'solo-btn';
  soloBtn.textContent = 'S';
  soloBtn.setAttribute('aria-label', 'Solo ' + model.name);
  header.appendChild(muteBtn);
  header.appendChild(soloBtn);
  const reasoningEl = document.createElement("div");
  reasoningEl.className = "column-reasoning";
  reasoningEl.style.color = model.color;

  // "New content below" indicator
  const scrollIndicator = document.createElement("div");
  scrollIndicator.className = "scroll-indicator";
  scrollIndicator.textContent = "↓ new content";
  scrollIndicator.style.color = model.color;
  scrollIndicator.style.display = "none";

  const waveform = document.createElement("canvas");
  waveform.className = "column-waveform";

  col.appendChild(header);
  col.appendChild(reasoningEl);
  col.appendChild(scrollIndicator);
  col.appendChild(waveform);
  container.appendChild(col);

  /** @type {ReturnType<typeof import("../audio/waveform.js").createWaveform> | null} */
  let waveformController = null;

  // Scroll tracking
  /** @type {boolean} */
  let userScrolledUp = false;
  /** @type {boolean} */
  let hasNewContentBelow = false;

  reasoningEl.addEventListener("scroll", () => {
    const { scrollTop, scrollHeight, clientHeight } = reasoningEl;
    const atBottom = scrollHeight - scrollTop - clientHeight < 10;
    userScrolledUp = !atBottom;
    if (atBottom) {
      hasNewContentBelow = false;
      scrollIndicator.style.display = "none";
    }
  });

  /** @type {string} */
  let reasoningText = "";

  /** @type {HTMLSpanElement[]} */
  let wordSpans = [];

  /** @type {string} */
  let currentWordBuffer = "";

  /** @type {HTMLSpanElement | null} */
  let currentWordSpan = null;

  // Karaoke state
  /** @type {number | null} */
  let karaokeRafId = null;
  /** @type {number} */
  let karaokeSentenceStart = -1;
  /** @type {number} */
  let karaokeSentenceCount = 0;
  /** @type {number} */
  let karaokeActiveIndex = -1;
  /** @type {number} */
  let karaokeWordDuration = 0;
  /** @type {number} */
  let karaokeWordStartTime = 0;

  /**
   * @param {string} token
   * @returns {void}
   */
  function appendToken(token) {
    reasoningText += token;

    for (let i = 0; i < token.length; i++) {
      const c = token[i];

      if (/\s/.test(c)) {
        // Word boundary — finalize current word if any
        if (currentWordSpan) {
          currentWordSpan.textContent = currentWordBuffer;
          wordSpans.push(currentWordSpan);
          currentWordSpan = null;
          currentWordBuffer = "";
        }
        // Append whitespace as a text node
        reasoningEl.appendChild(document.createTextNode(c));
      } else {
        // Part of a word
        currentWordBuffer += c;
        if (currentWordSpan) {
          // Update in-place span
          currentWordSpan.textContent = currentWordBuffer;
        } else {
          // Create new span for this word
          currentWordSpan = document.createElement("span");
          currentWordSpan.className = "karaoke-word";
          currentWordSpan.textContent = c;
          reasoningEl.appendChild(currentWordSpan);
        }
      }
    }

    // Auto-scroll logic
    const { scrollTop, scrollHeight, clientHeight } = reasoningEl;
    const atBottom = scrollHeight - scrollTop - clientHeight < 10;

    if (atBottom) {
      reasoningEl.scrollTop = reasoningEl.scrollHeight;
    } else {
      hasNewContentBelow = true;
      scrollIndicator.style.display = "block";
    }
  }


  /**
   * @param {number} startWordIndex
   * @param {number} wordCount
   * @param {number} durationMs
   * @returns {void}
   */
  function startKaraoke(startWordIndex, wordCount, durationMs) {
    // Cancel any running karaoke
    if (karaokeRafId !== null) {
      cancelAnimationFrame(karaokeRafId);
      karaokeRafId = null;
    }

    // Mark all already-played words as 'past'
    const playedEnd = Math.min(startWordIndex, wordSpans.length);
    for (let i = 0; i < playedEnd; i++) {
      wordSpans[i].classList.add("past");
    }

    // Set active sentence range
    karaokeSentenceStart = startWordIndex;
    karaokeSentenceCount = wordCount;
    karaokeActiveIndex = -1;

    if (wordCount <= 0 || startWordIndex >= wordSpans.length) return;

    karaokeWordDuration = durationMs / wordCount;
    karaokeWordStartTime = performance.now();

    // Activate first word immediately
    karaokeActiveIndex = startWordIndex;
    wordSpans[startWordIndex].classList.add("active");
    wordSpans[startWordIndex].scrollIntoView({ block: "nearest", behavior: "smooth" });

    function karaokeStep() {
      const now = performance.now();
      const elapsed = now - karaokeWordStartTime;

      if (elapsed >= karaokeWordDuration) {
        const prevIndex = karaokeActiveIndex;
        const nextIndex = karaokeActiveIndex + 1;
        const sentenceEnd = karaokeSentenceStart + karaokeSentenceCount;

        // Mark previous word as past
        if (prevIndex >= 0 && prevIndex < wordSpans.length) {
          wordSpans[prevIndex].classList.remove("active");
          wordSpans[prevIndex].classList.add("past");
        }

        if (nextIndex >= sentenceEnd || nextIndex >= wordSpans.length) {
          // Sentence complete
          karaokeRafId = null;
          return;
        }

        // Activate next word
        karaokeActiveIndex = nextIndex;
        wordSpans[nextIndex].classList.add("active");
        wordSpans[nextIndex].scrollIntoView({ block: "nearest", behavior: "smooth" });

        karaokeWordStartTime = now;
      }

      karaokeRafId = requestAnimationFrame(karaokeStep);
    }

    karaokeRafId = requestAnimationFrame(karaokeStep);
  }

  /**
   * @returns {void}
   */
  function stopKaraoke() {
    if (karaokeRafId !== null) {
      cancelAnimationFrame(karaokeRafId);
      karaokeRafId = null;
    }

    // Mark all words in the sentence as 'past'
    if (karaokeSentenceStart >= 0) {
      const end = Math.min(karaokeSentenceStart + karaokeSentenceCount, wordSpans.length);
      for (let i = karaokeSentenceStart; i < end; i++) {
        wordSpans[i].classList.remove("active");
        wordSpans[i].classList.add("past");
      }
    }

    // Reset sentence tracking
    karaokeSentenceStart = -1;
    karaokeSentenceCount = 0;
    karaokeActiveIndex = -1;
  }

  /**
   * Update the duration of the current karaoke sentence mid-animation.
   * Recalculates per-word timing while preserving current progress.
   * @param {number} durationMs - New total duration for the sentence
   * @returns {void}
   */
  function updateKaraokeDuration(durationMs) {
    if (karaokeRafId === null || karaokeSentenceCount <= 0) return;

    const now = performance.now();
    const elapsedInCurrentWord = now - karaokeWordStartTime;
    const oldWordDuration = karaokeWordDuration;
    const progressInCurrentWord = Math.min(elapsedInCurrentWord / oldWordDuration, 1);

    // Recalculate word duration
    karaokeWordDuration = durationMs / karaokeSentenceCount;

    // Adjust start time so current word's progress is preserved
    karaokeWordStartTime = now - (progressInCurrentWord * karaokeWordDuration);
  }

  /**
   * @param {AnalyserNode} analyserNode
   * @param {string} color
   * @returns {void}
   */
  function attachWaveform(analyserNode, color) {
    stopWaveform();
    waveformController = createWaveform(waveform, analyserNode, color);
  }

  /**
   * @returns {void}
   */
  function stopWaveform() {
    waveformController?.stop();
    waveformController = null;
  }

  /**
   * @returns {void}
   */
  function clear() {
    // Cancel any running karaoke
    if (karaokeRafId !== null) {
      cancelAnimationFrame(karaokeRafId);
      karaokeRafId = null;
    }
    karaokeSentenceStart = -1;
    karaokeSentenceCount = 0;
    karaokeActiveIndex = -1;
    col.classList.remove("has-error");
    reasoningText = "";
    reasoningEl.textContent = "";
    wordSpans = [];
    currentWordBuffer = "";
    currentWordSpan = null;
    scrollIndicator.style.display = "none";
    userScrolledUp = false;
    hasNewContentBelow = false;
    stopWaveform();
  }

  /**
   * @param {string} message
   * @returns {void}
   */
  function setError(message) {
    col.classList.add("has-error");
    const span = document.createElement("span");
    span.className = "error-msg";
    span.textContent = message;
    reasoningEl.textContent = "";
    reasoningEl.appendChild(span);
    reasoningEl.style.color = "";
  }

  /** @type {(() => void) | null} */
  let onMuteToggleCallback = null;
  /** @type {(() => void) | null} */
  let onSoloToggleCallback = null;

  muteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    onMuteToggleCallback?.();
  });
  soloBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    onSoloToggleCallback?.();
  });


  /**
   * @param {boolean} active
   */
  function setMuted(active) {
    muteBtn.classList.toggle('active', active);
  }


  /**
   * @param {boolean} active
   */
  function setSoloed(active) {
    soloBtn.classList.toggle('active', active);
  }


  /**
   * @param {() => void} fn
   */
  function onMuteToggle(fn) {
    onMuteToggleCallback = fn;
  }


  /**
   * @param {() => void} fn
   */
  function onSoloToggle(fn) {
    onSoloToggleCallback = fn;
  }

  return {
    element: col,
    appendToken,
    clear,
    setError,
    attachWaveform,
    stopWaveform,
    startKaraoke,
    updateKaraokeDuration,
    stopKaraoke,
    setMuted,
    setSoloed,
    onMuteToggle,
    onSoloToggle,
  };
}
