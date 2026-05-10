/**
 * @typedef {Object} ModelConfig
 * @property {string} name
 * @property {string} provider
 * @property {string} url
 * @property {string} model
 * @property {string} voice
 * @property {string} color
 * @property {number} pan
 * @property {string} reasoningFormat
 */

/**
 * @typedef {Object} TTSConfig
 * @property {string} wsUrl - WebSocket URL for Kyutai TTS server
 * @property {number} maxTokens - Soft token cap for reasoning text
 * @property {number} sentenceTimeoutTokens - Force-flush threshold per sentence (default: 60)
 * @property {boolean} useTextChunker - Enable optional TextChunker for prosody tuning (default: false)
 */

/**
 * @typedef {Object} Config
 * @property {string} defaultMode
 * @property {string[]} curatedPrompts
 * @property {ModelConfig[]} models
 * @property {TTSConfig} tts
 * @property {string} systemPrompt
 * @property {number} maxHistorySessions
 */

/** @type {Config} */
export const config = {
	defaultMode: "chorus",

	curatedPrompts: [
		"If a machine could dream, would its dreams be about us — or about something we cannot imagine?",
		"When you answer a question, do you understand it, or merely predict what understanding sounds like?",
		"Is consciousness the ability to feel, or simply the ability to reflect on what you feel?",
		"If two models give the same answer but arrived there through different reasoning, did they think the same thought?",
		"Does silence mean absence of thought, or presence of something that cannot be spoken?",
	],

	models: [
		{
			name: "Qwen",
			provider: "lm-studio",
			url: "http://localhost:1234/v1",
			model: "gemma-4-26b-a4b-it",
			voice: "alba-mackenna/casual.wav",
			color: "#00ff88",
			pan: -0.7,
			reasoningFormat: "separate",
		},
		{
			name: "Gemma",
			provider: "lm-studio",
			url: "http://localhost:1234/v1",
			model: "gemma-4-26b-a4b-it",
			voice: "alba-mackenna/merchant.wav",
			color: "#ff6644",
			pan: 0.0,
			reasoningFormat: "separate",
		},
		{
			name: "GPT-OSS",
			provider: "lm-studio",
			url: "http://localhost:1234/v1",
			model: "gpt-oss-20b",
			voice: "alba-mackenna/announcer.wav",
			color: "#44aaff",
			pan: 0.7,
			reasoningFormat: "separate",
		},
	],

	tts: {
		wsUrl: "ws://localhost:8765",
		maxTokens: 200,
		sentenceTimeoutTokens: 60,
		useTextChunker: false,
	},

	systemPrompt:
		"You are a critical thinker exploring deep questions. Think through the problem step by step, considering multiple perspectives. Show your reasoning process honestly. 500 tokens max",

	maxHistorySessions: 20,
};
