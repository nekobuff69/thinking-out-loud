import { TTSEngine } from "./tts-engine.js";
import { pipeline } from "@huggingface/transformers";

/**
 * Kokoro TTS backend via Transformers.js.
 * Lazy-loads the model on first use; browser caches it in IndexedDB.
 */
export class KokoroBackend extends TTSEngine {
  #modelId;
  #pipeline = null;
  #loadPromise = null;
  #audioGraph = null;

  constructor(modelId = "onnx-community/Kokoro-82M-ONNX", audioGraph = null) {
    super();
    this.#modelId = modelId;
    this.#audioGraph = audioGraph;
  }

  async load() {
    if (this.#pipeline) return;
    // Coalesce concurrent load() calls into a single pipeline initialization
    if (!this.#loadPromise) {
      this.#loadPromise = this.#doLoad();
    }
    await this.#loadPromise;
  }

  async #doLoad() {
    try {
      this.#pipeline = await pipeline("text-to-speech", this.#modelId, {
        dtype: "q8", // quantized for faster load
      });
    } catch (err) {
      this.#loadPromise = null; // allow retry on failure
      throw err;
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
    return await this.#toAudioBuffer(result.audio, result.sampling_rate);
  }

  #toAudioBuffer(float32Array, sourceSampleRate) {
    // Use the shared AudioContext so buffers match its sample rate.
    // If the model outputs at a different rate, we resample by creating
    // an OfflineAudioContext at the source rate, rendering there, then
    // re-rendering at the target rate.
    const ctx = this.#audioGraph?.getContext();
    if (!ctx) {
      // Fallback: create buffer at source rate (no resampling)
      const offline = new OfflineAudioContext(1, float32Array.length, sourceSampleRate);
      const buffer = offline.createBuffer(1, float32Array.length, sourceSampleRate);
      buffer.getChannelData(0).set(float32Array);
      return buffer;
    }

    const targetRate = ctx.sampleRate;
    if (targetRate === sourceSampleRate) {
      // No resampling needed — create directly on the shared context
      const buffer = ctx.createBuffer(1, float32Array.length, sourceSampleRate);
      buffer.getChannelData(0).set(float32Array);
      return buffer;
    }

    // Resample: render at source rate via OfflineAudioContext, then
    // decode into the target rate using startRendering()
    const frameCount = Math.ceil(float32Array.length * targetRate / sourceSampleRate);
    const offline = new OfflineAudioContext(1, frameCount, targetRate);
    const srcBuffer = offline.createBuffer(1, float32Array.length, sourceSampleRate);
    srcBuffer.getChannelData(0).set(float32Array);
    const src = offline.createBufferSource();
    src.buffer = srcBuffer;
    src.connect(offline.destination);
    src.start();
    // This is async but synthesize() is already async so that's fine
    return offline.startRendering();
  }

  destroy() {
    this.#pipeline = null;
  }
}
