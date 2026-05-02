import { TTSEngine } from "./tts-engine.js";
import { pipeline } from "@huggingface/transformers";

/**
 * Kokoro TTS backend via Transformers.js.
 * Lazy-loads the model on first use; browser caches it in IndexedDB.
 */
export class KokoroBackend extends TTSEngine {
  #modelId;
  #pipeline = null;
  #loading = false;

  constructor(modelId = "onnx-community/Kokoro-82M-ONNX") {
    super();
    this.#modelId = modelId;
  }

  async load() {
    if (this.#pipeline) return;
    if (this.#loading) {
      // Wait for the in-flight load
      while (this.#loading) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return;
    }

    this.#loading = true;
    try {
      this.#pipeline = await pipeline("text-to-speech", this.#modelId, {
        dtype: "q8", // quantized for faster load
      });
    } finally {
      this.#loading = false;
    }
  }

  async synthesize(text, voice) {
    if (!this.#pipeline) {
      await this.load();
    }

    const result = await this.#pipeline(text, {
      speaker: voice,
    });

    // result is { audio: Float32Array, sampling_rate: number }
    return this.#toAudioBuffer(result.audio, result.sampling_rate);
  }

  #toAudioBuffer(float32Array, sampleRate) {
    const audioCtx = new AudioContext({ sampleRate });
    const buffer = audioCtx.createBuffer(1, float32Array.length, sampleRate);
    buffer.getChannelData(0).set(float32Array);
    // Don't close the AudioContext — we reuse the browser's default
    // The audio-graph module owns the AudioContext lifecycle
    return buffer;
  }

  destroy() {
    this.#pipeline = null;
  }
}
