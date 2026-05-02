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
      model: "qwen_qwen3-30b",
      voice: "af_bella",
      color: "#00ff88",
      pan: -0.7,
    },
    {
      name: "Nemotron",
      provider: "lm-studio",
      url: "http://localhost:1234/v1",
      model: "nvidia-nemotron-mini",
      voice: "af_heart",
      color: "#ff6644",
      pan: 0.0,
    },
    {
      name: "Mistral",
      provider: "lm-studio",
      url: "http://localhost:1234/v1",
      model: "mistral-small-24b",
      voice: "bm_lewis",
      color: "#44aaff",
      pan: 0.7,
    },
  ],

  tts: {
    model: "onnx-community/Kokoro-82M-ONNX",
    maxTokens: 200,
    sentenceTimeoutTokens: 30,
  },

  systemPrompt:
    "You are a critical thinker exploring deep questions. Think through the problem step by step, considering multiple perspectives. Show your reasoning process honestly.",

  maxHistorySessions: 20,
};
