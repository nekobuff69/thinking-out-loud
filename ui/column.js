import { createWaveform } from "../audio/waveform.js";
import {
	isCjkCharacter,
	isKaraokePunctuation,
	wordIndexForProgress,
} from "./word-segmenter.js";
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
 * @property {() => void} finalizeWord
 * @property {(startWordIndex: number, wordCount: number, getTiming: () => { progress: number, final: boolean }) => void} startKaraoke
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

	// Header with model label in model's color
	const header = document.createElement("div");
	header.className = "column-header";
	header.style.color = model.color;

	// Display label (falls back to internal name for backward compat)
	header.appendChild(document.createTextNode(model.label ?? model.name));

	const muteBtn = document.createElement("button");
	muteBtn.className = "mute-btn";
	muteBtn.textContent = "M";
	muteBtn.style.marginLeft = "12px";
	muteBtn.setAttribute("aria-label", "Mute " + (model.label ?? model.name));
	const soloBtn = document.createElement("button");
	soloBtn.className = "solo-btn";
	soloBtn.textContent = "S";
	soloBtn.setAttribute("aria-label", "Solo " + (model.label ?? model.name));
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

	reasoningEl.addEventListener("scroll", () => {
		const { scrollTop, scrollHeight, clientHeight } = reasoningEl;
		const atBottom = scrollHeight - scrollTop - clientHeight < 10;
		if (atBottom) {
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
	/** @type {HTMLSpanElement | null} Most recent CJK span, for trailing punctuation. */
	let lastCjkSpan = null;

	// Karaoke state. The highlight position is never driven by wall-clock
	// time: it is derived from playback progress supplied by the pipeline.
	/** @type {number | null} */
	let karaokeRafId = null;
	/** @type {number} */
	let karaokeSentenceStart = -1;
	/** @type {number} */
	let karaokeSentenceCount = 0;
	/** @type {number} */
	let karaokeActiveIndex = -1;
	/** @type {number[]} */
	let karaokeWeights = [];


	/**
	 * Push the in-progress word into wordSpans. Called on whitespace/CJK
	 * boundaries and explicitly by the pipeline before a sentence is voiced,
	 * so a sentence ending in punctuation still has its final span indexed.
	 * @returns {void}
	 */
	function finalizeWord() {
		lastCjkSpan = null;
		if (!currentWordSpan) return;
		currentWordSpan.textContent = currentWordBuffer;
		wordSpans.push(currentWordSpan);
		currentWordSpan = null;
		currentWordBuffer = "";
	}

	/**
	 * @param {string} token
	 * @returns {void}
	 */
	function appendToken(token) {
		reasoningText += token;

		for (let i = 0; i < token.length; i++) {
			const c = token[i];

			if (/\s/.test(c)) {
				finalizeWord();
				reasoningEl.appendChild(document.createTextNode(c));
			} else if (isCjkCharacter(c)) {
				// CJK characters are individual karaoke units. Flush any
				// pending Latin word first so span indices match segmentWords().
				finalizeWord();
				const span = document.createElement("span");
				span.className = "karaoke-word";
				span.textContent = c;
				reasoningEl.appendChild(span);
				wordSpans.push(span);
				lastCjkSpan = span;
			} else if (lastCjkSpan && isKaraokePunctuation(c)) {
				// Punctuation after a CJK word shares its beat, matching
				// segmentWords() and avoiding a highlighted comma.
				lastCjkSpan.textContent += c;
			} else {
				lastCjkSpan = null;
				currentWordBuffer += c;
				if (currentWordSpan) {
					currentWordSpan.textContent = currentWordBuffer;
				} else {
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
			scrollIndicator.style.display = "block";
		}
	}

	/**
	 * Start karaoke for one sentence. The highlight is a *view* of playback
	 * state, not an independent animation: getTiming() is polled every frame
	 * and must report progress derived from the audio clock. When progress is
	 * negative the sentence has been scheduled but has not started playing
	 * yet, so no word is highlighted.
	 *
	 * @param {number} startWordIndex
	 * @param {number} wordCount
	 * @param {() => { progress: number, final: boolean }} getTiming
	 * @returns {void}
	 */
	function startKaraoke(startWordIndex, wordCount, getTiming) {
		if (karaokeRafId !== null) {
			cancelAnimationFrame(karaokeRafId);
			karaokeRafId = null;
		}

		// Everything before this sentence has been spoken.
		const playedEnd = Math.min(startWordIndex, wordSpans.length);
		for (let i = 0; i < playedEnd; i++) {
			wordSpans[i].classList.add("past");
		}

		karaokeSentenceStart = startWordIndex;
		karaokeSentenceCount = wordCount;
		karaokeActiveIndex = -1;

		if (wordCount <= 0 || startWordIndex >= wordSpans.length) return;

		// Weight words by length so time is distributed like real speech.
		const sentenceEnd = Math.min(startWordIndex + wordCount, wordSpans.length);
		karaokeWeights = [];
		for (let i = startWordIndex; i < sentenceEnd; i++) {
			karaokeWeights.push(
				Math.max(1, (wordSpans[i].textContent ?? "").trim().length),
			);
		}

		/**
		 * @param {number} from
		 * @param {number} to
		 * @returns {void}
		 */
		const markPast = (from, to) => {
			for (let i = Math.max(startWordIndex, from); i < to; i++) {
				if (i >= 0 && i < wordSpans.length) {
					wordSpans[i].classList.remove("active");
					wordSpans[i].classList.add("past");
				}
			}
		};

		function karaokeStep() {
			const timing = getTiming();

			// Scheduled for the future — keep the current word state untouched.
			if (timing.progress < 0) {
				karaokeRafId = requestAnimationFrame(karaokeStep);
				return;
			}

			const progress = Math.min(1, timing.progress);
			const offset = wordIndexForProgress(karaokeWeights, progress);
			const targetIndex = Math.min(startWordIndex + offset, sentenceEnd - 1);

			if (targetIndex !== karaokeActiveIndex) {
				// Clear every active marker in the sentence first. Even if a
				// caller supplies non-monotonic progress, two words can never
				// be active at the same time.
				for (let i = startWordIndex; i < sentenceEnd; i++) {
					wordSpans[i].classList.remove("active");
					wordSpans[i].style.removeProperty("--karaoke-fill");
				}
				markPast(startWordIndex, targetIndex);
				karaokeActiveIndex = targetIndex;
				wordSpans[targetIndex].classList.add("active");
				wordSpans[targetIndex].scrollIntoView({
					block: "nearest",
					behavior: "smooth",
				});
			}

			// Word-internal fill gives a continuous visual cursor inside the
			// active word, so the highlight tracks the voice between word
			// boundaries instead of snapping once per word.
			let totalWeight = 0;
			for (const weight of karaokeWeights) totalWeight += weight;
			if (totalWeight > 0) {
				let before = 0;
				for (let i = 0; i < offset; i++) before += karaokeWeights[i];
				const share = karaokeWeights[offset] / totalWeight;
				const fill =
					share > 0 ? (progress - before / totalWeight) / share : 1;
				wordSpans[targetIndex].style.setProperty(
					"--karaoke-fill",
					`${Math.max(0, Math.min(1, fill)) * 100}%`,
				);
			}

			// Only finish once the audio is fully generated AND fully played.
			if (progress >= 1 && timing.final) {
				markPast(karaokeActiveIndex + 1, sentenceEnd);
				wordSpans[karaokeActiveIndex]?.classList.remove("active");
				wordSpans[karaokeActiveIndex]?.classList.add("past");
				wordSpans[karaokeActiveIndex]?.style.removeProperty("--karaoke-fill");
				karaokeRafId = null;
				return;
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
			const end = Math.min(
				karaokeSentenceStart + karaokeSentenceCount,
				wordSpans.length,
			);
			for (let i = karaokeSentenceStart; i < end; i++) {
				wordSpans[i].classList.remove("active");
				wordSpans[i].classList.add("past");
				wordSpans[i].style.removeProperty("--karaoke-fill");
			}
		}

		// Reset sentence tracking
		karaokeSentenceStart = -1;
		karaokeSentenceCount = 0;
		karaokeActiveIndex = -1;
		karaokeWeights = [];
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
		karaokeWeights = [];
		col.classList.remove("has-error");
		reasoningText = "";
		reasoningEl.textContent = "";
		wordSpans = [];
		currentWordBuffer = "";
		currentWordSpan = null;
		lastCjkSpan = null;
		scrollIndicator.style.display = "none";
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

	muteBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		onMuteToggleCallback?.();
	});
	soloBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		onSoloToggleCallback?.();
	});

	/**
	 * @param {boolean} active
	 */
	function setMuted(active) {
		muteBtn.classList.toggle("active", active);
	}

	/**
	 * @param {boolean} active
	 */
	function setSoloed(active) {
		soloBtn.classList.toggle("active", active);
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
		finalizeWord,
		clear,
		setError,
		attachWaveform,
		stopWaveform,
		startKaraoke,
		stopKaraoke,
		setMuted,
		setSoloed,
		onMuteToggle,
		onSoloToggle,
	};
}
