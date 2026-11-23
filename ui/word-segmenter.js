/**
 * Single source of truth for karaoke word segmentation.
 *
 * The column builds highlight spans from a *token stream*, while the channel
 * pipeline counts words in a *complete sentence* before sending it to TTS.
 * If the two disagree on what a "word" is, the highlight index drifts from
 * the span index. Both call segmentWords() / isCjkCharacter() here so the
 * counts and indices are guaranteed to match.
 *
 * Rules:
 *  - Whitespace terminates the current word.
 *  - A CJK character is a word on its own (TTS reads it as one syllable).
 *  - Every other character (including punctuation) accumulates into the
 *    current word. Punctuation therefore never creates a standalone span.
 */

/** CJK ideographs (incl. extensions/compatibility), kana and Hangul. */
const CJK_RE =
	/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/;

/**
 * @param {string} ch
 * @returns {boolean}
 */
export function isCjkCharacter(ch) {
	return CJK_RE.test(ch);
}

/** Punctuation that should attach to a preceding CJK word, not get its own beat. */
const PUNCTUATION_RE = /[.,!?;:。，、；：！？]/;

/**
 * @param {string} ch
 * @returns {boolean}
 */
export function isKaraokePunctuation(ch) {
	return PUNCTUATION_RE.test(ch);
}

/**
 * Split *text* into karaoke words using the same rule the column uses when
 * it turns an incoming token stream into spans.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function segmentWords(text) {
	/** @type {string[]} */
	const words = [];
	let buffer = "";
	let trailingCjkWord = false;

	const flush = () => {
		if (buffer.length > 0) {
			words.push(buffer);
			buffer = "";
		}
	};

	for (const ch of text) {
		if (/\s/.test(ch)) {
			flush();
			trailingCjkWord = false;
		} else if (CJK_RE.test(ch)) {
			flush();
			words.push(ch);
			trailingCjkWord = true;
		} else if (trailingCjkWord && PUNCTUATION_RE.test(ch)) {
			// A punctuation mark after a CJK word belongs to that word's beat.
			words[words.length - 1] += ch;
		} else {
			buffer += ch;
			trailingCjkWord = false;
		}
	}
	flush();

	return words;
}

/**
 * Map a 0..1 playback progress onto a word index, distributing time by
 * character weight instead of splitting it evenly across words. A word with
 * more characters therefore stays highlighted longer, which tracks real
 * speech duration far better than `duration / wordCount`.
 *
 * @param {number[]} weights - one weight per word (character count)
 * @param {number} progress - 0..1 playback progress within the sentence
 * @returns {number} index into *weights*
 */
export function wordIndexForProgress(weights, progress) {
	if (weights.length === 0) return 0;

	let total = 0;
	for (const w of weights) total += w;
	if (total <= 0) return 0;

	const target = Math.max(0, Math.min(1, progress)) * total;
	let accumulated = 0;
	for (let i = 0; i < weights.length; i++) {
		accumulated += weights[i];
		if (target < accumulated) return i;
	}
	return weights.length - 1;
}
