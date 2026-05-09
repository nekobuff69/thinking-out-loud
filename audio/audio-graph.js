/**
 * @typedef {Object} AudioGraphChannel
 * @property {(buffer: AudioBuffer, onEnd?: () => void) => AudioBufferSourceNode} play
 * @property {(streamFn: (onChunk: (pcm: Float32Array, sampleRate: number) => void) => (() => void)) => { stop: () => void }} playStream
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

    /**
     * Stream PCM chunks for continuous playback via a ring-buffer approach.
     *
     * @param {(onChunk: (pcm: Float32Array, sampleRate: number) => void) => (() => void)} streamFn
     *   - Receives onChunk callback to deliver Float32Array PCM frames
     *   - Returns a cleanup function called on stop
     * @returns {{ stop: () => void }}
     */
    const playStream = (streamFn) => {
      this.#activeCount++;
      this.#updateDucking();

      const sources = new Set();
      let stopped = false;
      /** @type {(() => void) | null} */
      let cleanupFn = null;

      /**
       * Deliver a PCM chunk for playback.
       * Creates an AudioBuffer and schedules an AudioBufferSourceNode.
       * @param {Float32Array} pcm - Float32 PCM samples
       * @param {number} sampleRate - Sample rate of the PCM data
       */
      const onChunk = (pcm, sampleRate) => {
        if (stopped) return;

        // Create an AudioBuffer from PCM data
        let buffer;
        if (sampleRate === ctx.sampleRate) {
          buffer = ctx.createBuffer(1, pcm.length, sampleRate);
          buffer.getChannelData(0).set(pcm);
        } else {
          // Resample by creating at source rate then letting the context handle it?
          // For simplicity, create at source rate — the AudioContext will resample.
          buffer = ctx.createBuffer(1, pcm.length, sampleRate);
          buffer.getChannelData(0).set(pcm);
        }

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(gain);
        source.start();
        sources.add(source);

        source.onended = () => {
          sources.delete(source);
          if (sources.size === 0 && stopped) {
            this.#activeCount = Math.max(0, this.#activeCount - 1);
            this.#updateDucking();
          }
        };
      };

      // Start the stream by calling the stream function with our onChunk callback
      cleanupFn = streamFn(onChunk);

      return {
        stop: () => {
          stopped = true;
          // Call the cleanup function from the stream
          if (cleanupFn) {
            try { cleanupFn(); } catch {}
            cleanupFn = null;
          }
          // Stop all active sources
          for (const source of sources) {
            try { source.stop(); } catch {}
            sources.delete(source);
          }
          if (sources.size === 0) {
            this.#activeCount = Math.max(0, this.#activeCount - 1);
            this.#updateDucking();
          }
        },
      };
    };

    return { play, playStream, analyser, gain, stopAll };
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
