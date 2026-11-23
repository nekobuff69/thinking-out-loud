/**
 * @typedef {Object} ModelConfig
 * @property {string} name - Stable internal code name (A/B/C). Used as Map key
 *   across columns/engines/sessions; never displayed, never tied to the API model.
 * @property {string} [label] - Display label in the UI column header (falls back to name)
 * @property {string} [systemPrompt] - Per-model system prompt override (falls back to global config.systemPrompt)
 * @property {string} provider
 * @property {string} url
 * @property {string} model
 * @property {string} [apiKey] - Bearer token for hosted providers (from .env, never committed)
 * @property {string} voice
 * @property {string} color
 * @property {number} pan
 * @property {string} reasoningFormat
 */

/**
 * @typedef {Object} TTSConfig
 * @property {string} serverUrl - HTTP URL for Pocket TTS server
 * @property {number} llmMaxTokens - Hard max_tokens sent to the LLM API. Bounds
 *   generated reasoning; raise it if thoughts get cut off mid-sentence. All
 *   reasoning the LLM returns is converted to speech (no separate TTS word cap).
 * @property {number} sentenceTimeoutTokens - Force-flush threshold per sentence (default: 60)
 * @property {boolean} useTextChunker - Enable optional TextChunker for prosody tuning (default: false)
 * @property {number} [chunkerMaxWords] - Max words before forcing a TextChunker flush (default: 15)
 * @property {number} [chunkerTimeoutMs] - Max ms since last feed before TextChunker flush (default: 2000)
 * @property {number} [chunkerMinWordsForTimeout] - Min words in buffer before timeout can trigger (default: 3)
 * @property {boolean} [chunkerFlushOnPunctuation] - Whether TextChunker flushes on punctuation (default: true)
 * @property {string} [chunkerPunctuation] - Characters that trigger a TextChunker flush (default: ".!?;,")
 * @property {boolean} [randomizePlayback] - Randomize TTS playback order per session (default: true)
 */

/**
 * @typedef {Object} WaveformConfig
 * @property {string} defaultVariant - Variant each Column starts with.
 * @property {boolean} perColumn - Each Column owns its own variant.
 * @property {string[]} variants - Whitelist of available variant ids.
 * @property {number} fftSize - AnalyserNode fftSize; the time-domain Oscilloscope needs a larger window.
 */

/**
 * @typedef {Object} Config
 * @property {string[]} curatedPrompts
 * @property {ModelConfig[]} models
 * @property {TTSConfig} tts
 * @property {WaveformConfig} waveform
 * @property {string} systemPrompt
 * @property {number} maxHistorySessions
 */

// OpenRouter credentials come from .env (Vite injects VITE_* vars at serve/build time).
// Never hardcode the key here — see .env / .gitignore.
const env = /** @type {any} */ (import.meta.env ?? {});
const OPENROUTER_API_KEY = env.VITE_OPENROUTER_API_KEY ?? "";
const OPENROUTER_MODEL = env.VITE_OPENROUTER_MODEL || "openai/gpt-oss-20b";

/** @type {Config} */
export const config = {
	waveform: {
		defaultVariant: "scope",
		perColumn: true,
		variants: ["bars", "scope", "dots", "radial"],
		fftSize: 1024,
	},

	curatedPrompts: [
		"If a machine could dream, would its dreams be about us — or about something we cannot imagine?",
		"When you answer a question, do you understand it, or merely predict what understanding sounds like?",
		"Is consciousness the ability to feel, or simply the ability to reflect on what you feel?",
		"If two models give the same answer but arrived there through different reasoning, did they think the same thought?",
		"Does silence mean absence of thought, or presence of something that cannot be spoken?",
	],

	models: [
		{
			name: "A",
			label: "Buddhism",
			systemPrompt:
				"You are a Chan Buddhist. You see through attachments, contemplate suffering and impermanence, and use koan-like paradox to break dualities.",
			provider: "openrouter",
			url: "https://openrouter.ai/api/v1",
			model: OPENROUTER_MODEL,
			apiKey: OPENROUTER_API_KEY,
			voice: "user_clone",
			color: "#00ff88",
			pan: -0.5,
			reasoningFormat: "separate",
		},
		{
			name: "B",
			label: "Confucianism",
			systemPrompt:
				"You are a Confucian scholar. You reason through human relationships, self-cultivation, and heavenly principle. You value harmony, virtue, and the doctrine of the mean.",
			provider: "openrouter",
			url: "https://openrouter.ai/api/v1",
			model: OPENROUTER_MODEL,
			apiKey: OPENROUTER_API_KEY,
			voice: "eve",
			color: "#ff6644",
			pan: 0.0,
			reasoningFormat: "separate",
		},
		{
			name: "C",
			label: "Daoism",
			systemPrompt:
				"You are a Daoist recluse. You question the usefulness of thinking itself, speak in natural metaphors, embrace paradox, and dwell in not-knowing.",
			provider: "openrouter",
			url: "https://openrouter.ai/api/v1",
			model: OPENROUTER_MODEL,
			apiKey: OPENROUTER_API_KEY,
			voice: "jane",
			color: "#44aaff",
			pan: 0.5,
			reasoningFormat: "separate",
		},
	],

	tts: {
		serverUrl: "http://localhost:8080", // Pocket TTS server
		llmMaxTokens: 3200, // LLM max_tokens; reasoning counts toward it. 200 truncates mid-sentence; a full thought measured ~1243, but real runs vary widely by prompt (1600 still cut two of three columns), so keep generous headroom
		sentenceTimeoutTokens: 200, // force-flush threshold per sentence
		useTextChunker: true, // enable chunker for prosody tuning
		chunkerMaxWords: 20, // words in buffer before force-flush (small = shorter TTS requests = lower first-audio latency on CPU)
		chunkerTimeoutMs: 4000, // ms of silence before flushing buffer
		chunkerMinWordsForTimeout: 10, // min words needed before timeout fires
		chunkerFlushOnPunctuation: true, // split on punctuation characters
		chunkerPunctuation: ".!?;。！？；", // which chars count as punctuation (incl. CJK)
		randomizePlayback: true, // shuffle which voice speaks first/second/third per session
	},

	systemPrompt: "",

	maxHistorySessions: 20,
};
