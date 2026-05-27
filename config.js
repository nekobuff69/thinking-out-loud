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
 * @property {string} serverUrl - HTTP URL for Pocket TTS server
 * @property {number} maxTokens - Soft token cap for reasoning text
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
 * @typedef {Object} Config
 * @property {string[]} curatedPrompts
 * @property {ModelConfig[]} models
 * @property {TTSConfig} tts
 * @property {string} systemPrompt
 * @property {number} maxHistorySessions
 */

/** @type {Config} */
export const config = {
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
      model: "gpt-oss-20b",
      voice: "user_clone",
      color: "#00ff88",
      pan: -0.5,
      reasoningFormat: "separate",
    },
    {
      name: "Gemma",
      provider: "lm-studio",
      url: "http://localhost:1234/v1",
      model: "gpt-oss-20b",
      voice: "eve",
      color: "#ff6644",
      pan: 0.0,
      reasoningFormat: "separate",
    },
    {
      name: "GPT-OSS",
      provider: "lm-studio",
      url: "http://localhost:1234/v1",
      model: "gpt-oss-20b",
      voice: "jane",
      color: "#44aaff",
      pan: 0.5,
      reasoningFormat: "separate",
    },
  ],

  tts: {
    serverUrl: "http://localhost:8080", // Pocket TTS server
    maxTokens: 200, // soft token cap per LLM stream
    sentenceTimeoutTokens: 200, // force-flush threshold per sentence
    useTextChunker: true, // enable chunker for prosody tuning
    chunkerMaxWords: 100, // words in buffer before force-flush
    chunkerTimeoutMs: 4000, // ms of silence before flushing buffer
    chunkerMinWordsForTimeout: 20, // min words needed before timeout fires
    chunkerFlushOnPunctuation: true, // split on punctuation characters
    chunkerPunctuation: ".!?;", // which chars count as punctuation
    randomizePlayback: true, // shuffle which voice speaks first/second/third per session
  },

  systemPrompt: "",

  maxHistorySessions: 20,
};
