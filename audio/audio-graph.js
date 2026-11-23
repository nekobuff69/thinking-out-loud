/**
 * @typedef {Object} AudioGraphChannel
 * @property {(buffer: AudioBuffer, onEnd?: () => void) => AudioBufferSourceNode} play
 * @property {(streamFn: (onChunk: (pcm: Float32Array, sampleRate: number) => void) => (() => void)) => { stop: () => void }} playStream
 * @property {() => { feed: (pcm: Float32Array, sampleRate: number) => { scheduledTime: number }, getPlaybackPosition: () => { samples: number, sampleRate: number }, end: () => void, stop: () => void }} openStream
 * @property {AudioContext} ctx
 * @property {AnalyserNode} analyser
 * @property {GainNode} gain
 * @property {GainNode} muteGain
 * @property {(audible: boolean) => void} setAudible
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

		const muteGain = ctx.createGain();
		muteGain.gain.value = 1.0;
		gain.connect(muteGain);
		muteGain.connect(panner);
		panner.connect(analyser);
		analyser.connect(ctx.destination);

		const activeSources = new Set();
		const chEntry = { gain, activeSources, audible: true };
		this.#channels.push(chEntry);

		/**
		 * Play an AudioBuffer through this channel.
		 * @param {AudioBuffer} buffer
		 * @param {() => void} [onEnd]
		 * @returns {AudioBufferSourceNode}
		 */
		const play = (buffer, onEnd) => {
			if (chEntry.audible) {
				this.#activeCount++;
				this.#updateDucking();
			}

			const source = ctx.createBufferSource();
			source.buffer = buffer;
			source.connect(gain);
			source.start();
			activeSources.add(source);

			source.onended = () => {
				activeSources.delete(source);
				if (chEntry.audible) {
					this.#activeCount = Math.max(0, this.#activeCount - 1);
					this.#updateDucking();
				}
				onEnd?.();
			};

			return source;
		};

		/** Stop all currently-playing sources on this channel. */
		const stopAll = () => {
			for (const source of activeSources) {
				try {
					source.stop();
				} catch {}
				activeSources.delete(source);
			}
		};

		/**
		 * Stream PCM chunks for continuous playback via a ring-buffer approach.
		 *
		 * @param {(onChunk: (pcm: Float32Array, sampleRate: number) => void) => (() => void)} streamFn
		 * @returns {{ stop: () => void }}
		 */
		const playStream = (streamFn) => {
			if (chEntry.audible) {
				this.#activeCount++;
				this.#updateDucking();
			}

			const sources = new Set();
			let stopped = false;
			/** @type {(() => void) | null} */
			let cleanupFn = null;

			// Gapless scheduling for replay path
			let nextStartTime = 0;

			/**
			 * @param {Float32Array} pcm
			 * @param {number} sampleRate
			 */
			const onChunk = (pcm, sampleRate) => {
				if (stopped) return;

				const buffer = ctx.createBuffer(1, pcm.length, sampleRate);
				buffer.getChannelData(0).set(pcm);

				const source = ctx.createBufferSource();
				source.buffer = buffer;
				source.connect(gain);

				// Schedule gaplessly
				const now = ctx.currentTime;
				if (nextStartTime < now) {
					nextStartTime = now;
				}
				source.start(nextStartTime);
				nextStartTime += buffer.duration;

				sources.add(source);

				source.onended = () => {
					sources.delete(source);
					if (chEntry.audible && sources.size === 0 && stopped) {
						this.#activeCount = Math.max(0, this.#activeCount - 1);
						this.#updateDucking();
					}
				};
			};

			cleanupFn = streamFn(onChunk);

			return {
				stop: () => {
					stopped = true;
					if (cleanupFn) {
						try {
							cleanupFn();
						} catch {}
						cleanupFn = null;
					}
					for (const source of sources) {
						try {
							source.stop();
						} catch {}
						sources.delete(source);
					}
					if (chEntry.audible && sources.size === 0) {
						this.#activeCount = Math.max(0, this.#activeCount - 1);
						this.#updateDucking();
					}
				},
			};
		};

		/**
		 * Number of PCM frames to buffer before starting playback.
		 * Minimal pre-buffer for HTTP-based Pocket TTS — sentences arrive
		 * as few large chunks rather than many small WebSocket frames.
		 * At 24kHz, 1 frame ≈ one sentence worth of audio.
		 */
		const PRE_BUFFER_FRAMES = 1;

		/**
		 * Live streaming PCM feed.
		 *
		 * Designed for streaming TTS: PCM frames arrive from the TTS backend.
		 * Each `feed()` call creates and schedules an AudioBufferSourceNode.
		 * @returns {{ feed: (pcm: Float32Array, sampleRate: number) => { scheduledTime: number }, getPlaybackPosition: () => { samples: number, sampleRate: number }, end: () => void, stop: () => void }}
		 */
		const openStream = () => {
			if (chEntry.audible) {
				this.#activeCount++;
				this.#updateDucking();
			}

			const sources = new Set();
			let ended = false;
			let stopped = false;

			// Gapless scheduling: track the next play time so buffers
			// play back-to-back without overlap or gaps.
			let nextStartTime = 0;

			// Playback head. Every scheduled buffer is recorded with its
			// AudioContext time span so we can report how many samples have
			// actually been heard. Gaps caused by underruns are NOT counted:
			// this keeps the highlight from running ahead of the audio.
			/** @type {Array<{startTime: number, endTime: number, samples: number, sampleRate: number}>} */
			const scheduledSegments = [];
			let playedSamplesBase = 0;
			let lastSampleRate = 24000;

			// Pre-buffer: accumulate frames before scheduling playback.
			// This creates a time cushion that absorbs delivery jitter.
			// Once PRE_BUFFER_FRAMES are collected, all buffered frames
			// are scheduled starting at ctx.currentTime, and subsequent
			// frames are scheduled gaplessly from there.
			/** @type {Array<{pcm: Float32Array, sampleRate: number}>} */
			let preBuffer = [];
			let preBufferingDone = false;

			/**
			 * Schedule a single buffer for gapless playback.
			 * @param {Float32Array} pcm
			 * @param {number} sampleRate
			 * @returns {number} The AudioContext time when this buffer will start playing.
			 */
			const scheduleBuffer = (pcm, sampleRate) => {
				const buffer = ctx.createBuffer(1, pcm.length, sampleRate);
				buffer.getChannelData(0).set(pcm);

				const source = ctx.createBufferSource();
				source.buffer = buffer;
				source.connect(gain);

				// Schedule gaplessly: start at nextStartTime, never overlap
				const now = ctx.currentTime;
				if (nextStartTime < now) {
					nextStartTime = now;
				}
				const scheduledTime = nextStartTime;
				source.start(scheduledTime);
				nextStartTime += buffer.duration;

				sources.add(source);
				scheduledSegments.push({
					startTime: scheduledTime,
					endTime: scheduledTime + buffer.duration,
					samples: pcm.length,
					sampleRate,
				});

				source.onended = () => {
					sources.delete(source);
				};

				return scheduledTime;
			};

			/**
			 * Flush all pre-buffered frames, scheduling them for gapless playback.
			 * @returns {number} The scheduled start time of the first flushed frame,
			 *   or 0 if the pre-buffer was empty.
			 */
			const flushPreBuffer = () => {
				if (preBuffer.length === 0) return 0;
				// Start playback at current time — pre-buffer provides cushion
				const now = ctx.currentTime;
				if (nextStartTime < now) {
					nextStartTime = now;
				}
				let firstScheduledTime = 0;
				for (const item of preBuffer) {
					const st = scheduleBuffer(item.pcm, item.sampleRate);
					if (firstScheduledTime === 0) firstScheduledTime = st;
				}
				preBuffer = [];
				preBufferingDone = true;
				return firstScheduledTime;
			};

			/**
			 * Feed a PCM frame for playback.
			 * Pre-buffers the first PRE_BUFFER_FRAMES frames before scheduling.
			 * @param {Float32Array} pcm - Float32 PCM samples
			 * @param {number} sampleRate - Sample rate of the PCM data
			 * @returns {{ scheduledTime: number }} The AudioContext time when this
			 *   buffer will start playing. Returns 0 when stopped/ended or when the
			 *   buffer is still in the pre-buffer (not yet scheduled).
			 */
			const feed = (pcm, sampleRate) => {
				if (stopped || ended) return { scheduledTime: 0 };

				if (!preBufferingDone) {
					preBuffer.push({ pcm, sampleRate });
					if (preBuffer.length >= PRE_BUFFER_FRAMES) {
						const scheduledTime = flushPreBuffer();
						return { scheduledTime };
					}
					return { scheduledTime: 0 };
				}

				return { scheduledTime: scheduleBuffer(pcm, sampleRate) };
			};

			/**
			 * Cumulative PCM samples actually played at the current audio
			 * clock position. Fully played segments are folded into a base
			 * counter; only the segment under the playhead is interpolated.
			 * A scheduling gap advances the clock but adds no samples, so
			 * the reported position never overtakes audible audio.
			 *
			 * @returns {{ samples: number, sampleRate: number }}
			 */
			const getPlaybackPosition = () => {
				const now = ctx.currentTime || 0;
				while (scheduledSegments.length > 0 && now >= scheduledSegments[0].endTime) {
					const seg = /** @type {{startTime: number, endTime: number, samples: number, sampleRate: number}} */ (
						scheduledSegments.shift()
					);
					playedSamplesBase += seg.samples;
					lastSampleRate = seg.sampleRate;
				}

				let played = playedSamplesBase;
				if (scheduledSegments.length > 0) {
					const seg = scheduledSegments[0];
					if (now > seg.startTime && seg.endTime > seg.startTime) {
						const fraction = Math.min(
							1,
							(now - seg.startTime) / (seg.endTime - seg.startTime),
						);
						played += seg.samples * fraction;
						lastSampleRate = seg.sampleRate;
					}
				}

				return { samples: played, sampleRate: lastSampleRate };
			};

			/**
			 * Signal no more frames. Flushes any remaining pre-buffered frames
			 * and decrements activeCount.
			 */
			const end = () => {
				if (ended || stopped) return;
				// Flush any remaining pre-buffered frames before ending
				if (!preBufferingDone && preBuffer.length > 0) {
					flushPreBuffer();
				}
				ended = true;
				if (chEntry.audible) {
					this.#activeCount = Math.max(0, this.#activeCount - 1);
					this.#updateDucking();
				}
			};

			/**
			 * Immediate kill — stop all sources, clear pre-buffer, decrement activeCount.
			 */
			const stop = () => {
				if (stopped) return;
				stopped = true;
				preBuffer = [];
				preBufferingDone = true;
				for (const source of sources) {
					try {
						source.stop();
					} catch {}
					sources.delete(source);
				}
				if (chEntry.audible && !ended) {
					this.#activeCount = Math.max(0, this.#activeCount - 1);
					this.#updateDucking();
				}
			};

			return { feed, getPlaybackPosition, end, stop };
		};

		/**
		 * @param {boolean} value
		 */
		const setAudible = (value) => {
			chEntry.audible = value;
		};

		return {
			play,
			playStream,
			openStream,
			ctx,
			analyser,
			gain,
			muteGain,
			setAudible,
			stopAll,
		};
	}

	get activeCount() {
		return this.#activeCount;
	}

	/** Remove all channels, disconnect nodes, stop audio. */
	clearChannels() {
		for (const ch of this.#channels) {
			ch.stopAll?.();
			try {
				ch.gain.disconnect();
			} catch {}
		}
		this.#channels.length = 0;
		this.#activeCount = 0;
	}

	/** Close AudioContext and release resources. */
	destroy() {
		this.clearChannels();
		if (this.#ctx) {
			this.#ctx.close();
			this.#ctx = null;
		}
		if (this.#visibilityHandler) {
			document.removeEventListener("visibilitychange", this.#visibilityHandler);
		}
	}

	/** Handle tab visibility for AudioContext resume. */
	enableTabResume() {
		this.#visibilityHandler = () => {
			if (
				document.visibilityState === "visible" &&
				this.#ctx?.state === "suspended"
			) {
				this.#ctx.resume();
			}
		};
		document.addEventListener("visibilitychange", this.#visibilityHandler);
	}
}
