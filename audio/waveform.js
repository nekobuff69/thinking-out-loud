/**
 * Renders a live frequency-domain waveform visualization on a canvas element.
 *
 * Uses AnalyserNode.getByteFrequencyData for immediate response to any signal
 * (no amplitude threshold gating). Bars are log-scaled to emphasize speech
 * formants, mirrored for symmetry, with smooth peak decay.
 *
 * Falls back to a gentle idle breathing animation when the signal is silent.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {AnalyserNode} analyser
 * @param {string} color
 * @returns {{ stop: () => void }}
 */
export function createWaveform(canvas, analyser, color) {
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  if (!ctx) throw new Error("Canvas 2D context not supported");

  const fftBins = analyser.frequencyBinCount; // typically 128 at fftSize=256
  const freqData = new Uint8Array(fftBins);

  // Number of visual bars per side (mirrored → 2 × barCount total)
  const barCount = 48;

  // Precompute a log-scale lookup: maps visual bar index → FFT bin index.
  // Speech formants cluster in 80Hz–8kHz; log scale spreads low frequencies wider.
  const binMap = new Uint8Array(barCount);
  const nyquistBin = fftBins - 1;
  for (let i = 0; i < barCount; i++) {
    // Linear t in [0, 1], then exponential to emphasize lows
    const t = i / (barCount - 1);
    const exp = Math.pow(t, 2.0); // square skew towards low frequencies
    binMap[i] = Math.round(exp * nyquistBin);
  }

  // Peak-hold state — one per visual bar (mirrored, so shared)
  const peaks = new Float32Array(barCount);
  const peakDecay = 0.92; // per-frame decay multiplier (~60fps)

  /** @type {number | null} */
  let animationId = null;
  let idlePhase = 0;
  const idleSpeed = 0.03;

  // Sync canvas drawing buffer to its actual rendered size
  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);

  function draw() {
    animationId = requestAnimationFrame(draw);

    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    analyser.getByteFrequencyData(freqData);

    // Compute bar heights from log-scaled frequency data
    const barHeights = new Float32Array(barCount);
    let totalEnergy = 0;
    for (let i = 0; i < barCount; i++) {
      // Map to a small window of FFT bins around the target bin
      const center = binMap[i];
      const radius = Math.max(1, Math.round((i + 1) * 0.3));
      let sum = 0;
      let count = 0;
      for (let j = Math.max(0, center - radius); j <= Math.min(fftBins - 1, center + radius); j++) {
        sum += freqData[j];
        count++;
      }
      const avg = sum / count / 255; // normalise to 0–1
      barHeights[i] = avg;
      totalEnergy += avg;
    }

    // Peak hold update
    for (let i = 0; i < barCount; i++) {
      if (barHeights[i] > peaks[i]) {
        peaks[i] = barHeights[i];
      } else {
        peaks[i] *= peakDecay;
      }
    }

    const isSilent = totalEnergy < 0.5; // near-zero energy across all bins

    ctx.clearRect(0, 0, w, h);

    const barWidth = w / (barCount * 2); // left + mirrored right
    const gap = barWidth * 0.15;

    if (isSilent) {
      // Idle breathing
      idlePhase += idleSpeed;
      for (let i = 0; i < barCount; i++) {
        const phase = idlePhase + (i / barCount) * Math.PI * 1.5;
        const hNorm = 0.08 + 0.06 * Math.sin(phase);
        const barH = hNorm * h;
        const x = i * barWidth + gap;
        const y = (h - barH) / 2;

        ctx.fillStyle = color;
        ctx.globalAlpha = 0.2 + hNorm * 0.5;
        ctx.fillRect(x, y, barWidth - gap * 2, Math.max(barH, 1));
        // Mirror right
        const mx = w - x - barWidth;
        ctx.fillRect(mx, y, barWidth - gap * 2, Math.max(barH, 1));
      }
    } else {
      // Active: mirrored frequency spectrum with peak dots
      for (let i = 0; i < barCount; i++) {
        const barH = barHeights[i] * h * 0.9;
        const peakH = peaks[i] * h * 0.9;

        const x = i * barWidth + gap;
        const y = h - barH; // bars rise from bottom

        // Bar — left side, rising from bottom
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.5 + barHeights[i] * 0.5;
        ctx.fillRect(x, y, barWidth - gap * 2, Math.max(barH, 1));

        // Mirror — right side
        const mx = w - x - barWidth;
        ctx.fillRect(mx, y, barWidth - gap * 2, Math.max(barH, 1));

        // Peak dot on both sides
        if (peakH > 1) {
          ctx.globalAlpha = 1.0;
          ctx.fillRect(x, h - peakH - 1, barWidth - gap * 2, 2);
          ctx.fillRect(mx, h - peakH - 1, barWidth - gap * 2, 2);
        }
      }
    }

    ctx.globalAlpha = 1;
  }

  draw();

  return {
    stop() {
      if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
      }
      resizeObserver.disconnect();
    },
  };
}
