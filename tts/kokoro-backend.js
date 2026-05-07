import { TTSEngine } from "./tts-engine.js";
import { KokoroTTS } from "kokoro-js";

/**
 * Kokoro TTS backend via the official kokoro-js library.
 * Uses StyleTextToSpeech2Model directly (bypasses the broken
 * transformers.js pipeline auto-detection for this model type).
 * Lazy-loads the model on first use; browser caches it in IndexedDB.
 */
export class KokoroBackend extends TTSEngine {
  /** @type {KokoroTTS | null} */
  #tts = null;
  /** @type {Promise<void> | null} */
  #loadPromise = null;
  /** @type {import("../audio/audio-graph.js").AudioGraph | null} */
  #audioGraph = null;
  /** @type {string} */
  #modelId;

  /**
   * @param {string} [modelId] - HF model repo ID. Defaults to the official v1.0 ONNX build.
   * @param {import("../audio/audio-graph.js").AudioGraph | null} [audioGraph]
   */
  constructor(modelId = "onnx-community/Kokoro-82M-v1.0-ONNX", audioGraph = null) {
    super();
    this.#modelId = modelId;
    this.#audioGraph = audioGraph;
  }

  /**
   * @returns {Promise<void>}
   */
  async load() {
    if (this.#tts) return;
    if (!this.#loadPromise) {
      this.#loadPromise = this.#doLoad();
    }
    await this.#loadPromise;
  }

  async #doLoad() {
    try {
      this.#tts = await KokoroTTS.from_pretrained(this.#modelId, {
        dtype: "q8", // quantized for faster load
      });
    } catch (err) {
      this.#loadPromise = null; // allow retry on failure
      throw err;
    }
  }

  /**
   * @param {string} text
   * @param {string} voice
   * @returns {Promise<AudioBuffer>}
   */
  async synthesize(text, voice) {
    if (!this.#tts) {
      await this.load();
    }

    // KokoroTTS.generate returns RawAudio { audio: Float32Array, sampling_rate: 24000 }
    const raw = await /** @type {import("kokoro-js").KokoroTTS} */ (this.#tts).generate(text, { voice: /** @type {any} */ (voice) });
    return this.#toAudioBuffer(raw.audio, raw.sampling_rate);
  }

  /**
   * @param {Float32Array} float32Array
   * @param {number} sourceSampleRate
   * @returns {AudioBuffer | Promise<AudioBuffer>}
   */
  #toAudioBuffer(float32Array, sourceSampleRate) {
    const ctx = this.#audioGraph?.getContext();
    if (!ctx) {
      const offline = new OfflineAudioContext(1, float32Array.length, sourceSampleRate);
      const buffer = offline.createBuffer(1, float32Array.length, sourceSampleRate);
      buffer.getChannelData(0).set(float32Array);
      return buffer;
    }

    const targetRate = ctx.sampleRate;
    if (targetRate === sourceSampleRate) {
      const buffer = ctx.createBuffer(1, float32Array.length, sourceSampleRate);
      buffer.getChannelData(0).set(float32Array);
      return buffer;
    }

    // Resample via OfflineAudioContext
    const frameCount = Math.ceil(float32Array.length * targetRate / sourceSampleRate);
    const offline = new OfflineAudioContext(1, frameCount, targetRate);
    const srcBuffer = offline.createBuffer(1, float32Array.length, sourceSampleRate);
    srcBuffer.getChannelData(0).set(float32Array);
    const src = offline.createBufferSource();
    src.buffer = srcBuffer;
    src.connect(offline.destination);
    src.start();
    return offline.startRendering();
  }

  /**
   * @returns {void}
   */
  destroy() {
    this.#tts = null;
  }
}
