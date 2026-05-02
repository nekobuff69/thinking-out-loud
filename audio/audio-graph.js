/**
 * @typedef {Object} AudioGraphChannel
 * @property {(buffer: AudioBuffer, onEnd?: () => void) => AudioBufferSourceNode} play
 * @property {AnalyserNode} analyser
 * @property {GainNode} gain
 * @property {() => void} stopAll
 */

/**
 * Manages a single shared AudioContext.
 * Creates per-model audio channels: gain → stereo panner → analyser → destination.
 * Implements ducking: when multiple channels play simultaneously, gain attenuates.
 */
export class AudioGraph {
  /** @type {AudioContext | null} */
  #ctx = null;
  /** @type {Array<{gain: GainNode, activeSources: Set<AudioBufferSourceNode>, stopAll?: () => void}>} */
  #channels = [];
  /** @type {number} */
  #activeCount = 0;
  /** @type {(() => void) | null} */
  #visibilityHandler = null;

  /** Lazily create or return the existing AudioContext.
   * @returns {AudioContext}
   */
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
   * @returns {AudioGraphChannel}
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

    const activeSources = new Set();
    this.#channels.push({ gain, activeSources });

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
      activeSources.add(source);

      source.onended = () => {
        activeSources.delete(source);
        this.#activeCount = Math.max(0, this.#activeCount - 1);
        this.#updateDucking();
        onEnd?.();
      };

      return source;
    };

    /** Stop all currently-playing sources on this channel. */
    const stopAll = () => {
      for (const source of activeSources) {
        try { source.stop(); } catch {} // already stopped is fine
        activeSources.delete(source);
      }
    };

    return { play, analyser, gain, stopAll };
  }

  get activeCount() {
    return this.#activeCount;
  }

  /** Remove all channels and disconnect their nodes. Stops any playing audio. */
  clearChannels() {
    for (const ch of this.#channels) {
      ch.stopAll?.();
      try { ch.gain.disconnect(); } catch {} // already disconnected is fine
    }
    this.#channels.length = 0;
    this.#activeCount = 0;
  }

  /** Close the AudioContext and release resources. */
  destroy() {
    // Tear down channels before closing context
    this.clearChannels();
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
