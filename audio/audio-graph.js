/**
 * Manages a single shared AudioContext.
 * Creates per-model audio channels: gain → stereo panner → analyser → destination.
 * Implements ducking: when multiple channels play simultaneously, gain attenuates.
 */
export class AudioGraph {
  #ctx = null;
  #channels = [];
  #activeCount = 0;
  #visibilityHandler = null;

  /** Lazily create or return the existing AudioContext. */
  getContext() {
    if (!this.#ctx) {
      this.#ctx = new AudioContext();
    }
    if (this.#ctx.state === "suspended") {
      this.#ctx.resume();
    }
    return this.#ctx;
  }

  #updateDucking() {
    if (!this.#ctx) return;
    const gainValue = this.#activeCount > 1 ? 0.7 : 1.0;
    for (const ch of this.#channels) {
      ch.gain.gain.setTargetAtTime(gainValue, this.#ctx.currentTime, 0.05);
    }
  }

  /**
   * Create a per-model audio channel.
   * @param {number} pan - Stereo position (-1 to 1)
   * @returns {{ play: (buffer: AudioBuffer, onEnd?: () => void) => AudioBufferSourceNode, analyser: AnalyserNode, gain: GainNode }}
   */
  createChannel(pan) {
    const ctx = this.getContext();

    const gain = ctx.createGain();
    gain.gain.value = 1.0;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;

    gain.connect(panner);
    panner.connect(analyser);
    analyser.connect(ctx.destination);

    this.#channels.push({ gain });

    /**
     * Play an AudioBuffer through this channel.
     * @param {AudioBuffer} buffer
     * @param {() => void} [onEnd] - called when playback finishes
     */
    const play = (buffer, onEnd) => {
      this.#activeCount++;
      this.#updateDucking();

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.start();

      source.onended = () => {
        this.#activeCount = Math.max(0, this.#activeCount - 1);
        this.#updateDucking();
        onEnd?.();
      };

      return source;
    };

    return { play, analyser, gain };
  }

  get activeCount() {
    return this.#activeCount;
  }

  /** Close the AudioContext and release resources. */
  destroy() {
    if (this.#ctx) {
      this.#ctx.close();
      this.#ctx = null;
    }
    if (this.#visibilityHandler) {
      document.removeEventListener("visibilitychange", this.#visibilityHandler);
    }
  }

  /** Set up tab visibility handling to keep AudioContext alive. */
  enableTabResume() {
    this.#visibilityHandler = () => {
      if (document.visibilityState === "visible" && this.#ctx?.state === "suspended") {
        this.#ctx.resume();
      }
    };
    document.addEventListener("visibilitychange", this.#visibilityHandler);
  }
}
