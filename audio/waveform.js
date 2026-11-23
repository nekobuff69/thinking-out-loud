import { normaliseVariant } from "./waveform-variants.js";

/**
 * Renders a live Waveform on a canvas element.
 *
 * Four named animations share one AnalyserNode and can be hot-swapped in place:
 *   bars   — mirrored log-scaled frequency bars with peak hold (legacy)
 *   scope  — true time-domain Oscilloscope trace
 *   dots   — LED / VFD dot matrix driven by frequency energy
 *   radial — closed ring whose radius tracks frequency energy
 *
 * Every branch falls back to a gentle Idle waveform while its Channel is
 * silent. Under a reduced-motion preference a single static frame is drawn.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {AnalyserNode} analyser
 * @param {string} color
 * @param {{ variant?: string, fftSize?: number, reducedMotion?: boolean }} [options]
 * @returns {{ stop: () => void, setVariant: (variant: string) => void, getVariant: () => string }}
 */
export function createWaveform(canvas, analyser, color, options = {}) {
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  if (!ctx) throw new Error("Canvas 2D context not supported");

  const reducedMotion = options.reducedMotion ??
    (typeof window !== "undefined" && typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  let variant = normaliseVariant(options.variant);
  if (options.fftSize && analyser.fftSize !== options.fftSize) {
    analyser.fftSize = options.fftSize;
  }

  const barCount = 48;
  /** @type {Float32Array} */
  let peaks = new Float32Array(barCount);
  let idlePhase = 0;
  /** @type {number | null} */
  let animationId = null;
  let stopped = false;

  /** @returns {{w: number, h: number}} */
  function size() {
    const rect = canvas.getBoundingClientRect();
    return { w: rect.width, h: rect.height };
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);

  /** @returns {{freq: Uint8Array, time: Uint8Array, energy: number}} */
  function readSignal() {
    const freq = new Uint8Array(analyser.frequencyBinCount);
    const time = new Uint8Array(analyser.fftSize);
    analyser.getByteFrequencyData(freq);
    let energy = 0;
    for (let i = 0; i < freq.length; i += 1) energy += freq[i] / 255;
    return { freq, time, energy };
  }

  /** @returns {Float32Array} */
  /** @param {Uint8Array} freq */
  function barHeights(freq) {
    const heights = new Float32Array(barCount);
    const nyquistBin = freq.length - 1;
    for (let i = 0; i < barCount; i += 1) {
      const t = i / (barCount - 1);
      const center = Math.round(Math.pow(t, 2) * nyquistBin);
      const radius = Math.max(1, Math.round((i + 1) * 0.3));
      let sum = 0;
      let count = 0;
      for (let j = Math.max(0, center - radius); j <= Math.min(freq.length - 1, center + radius); j += 1) {
        sum += freq[j];
        count += 1;
      }
      heights[i] = sum / count / 255;
    }
    return heights;
  }

  /** @param {number} w @param {number} h */
  function drawIdleBars(w, h) {
    const bw = w / (barCount * 2);
    const gap = bw * 0.15;
    for (let i = 0; i < barCount; i += 1) {
      const phase = idlePhase + (i / barCount) * Math.PI * 1.5;
      const n = 0.08 + 0.06 * Math.sin(phase);
      const barH = n * h;
      const x = i * bw + gap;
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.2 + n * 0.5;
      ctx.fillRect(x, (h - barH) / 2, bw - gap * 2, Math.max(barH, 1));
      ctx.fillRect(w - x - bw + gap, (h - barH) / 2, bw - gap * 2, Math.max(barH, 1));
    }
    ctx.globalAlpha = 1;
  }

  /** @param {number} w @param {number} h @param {Float32Array} heights */
  function drawBars(w, h, heights) {
    const bw = w / (barCount * 2);
    const gap = bw * 0.15;
    for (let i = 0; i < barCount; i += 1) {
      if (heights[i] > peaks[i]) peaks[i] = heights[i];
      else peaks[i] *= 0.92;
      const barH = Math.max(1, heights[i] * h * 0.9);
      const peakH = peaks[i] * h * 0.9;
      const x = i * bw + gap;
      const mx = w - x - bw;
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.5 + heights[i] * 0.5;
      ctx.fillRect(x, h - barH, bw - gap * 2, barH);
      ctx.fillRect(mx, h - barH, bw - gap * 2, barH);
      if (peakH > 1) {
        ctx.globalAlpha = 1;
        ctx.fillRect(x, h - peakH - 1, bw - gap * 2, 2);
        ctx.fillRect(mx, h - peakH - 1, bw - gap * 2, 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** @param {number} w @param {number} h @param {number} step */
  function grid(w, h, step) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.16;
    ctx.lineWidth = 0.5;
    for (let x = 0; x < w; x += step) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = 0; y < h; y += step) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** @param {number} w @param {number} h @param {Uint8Array} time @param {boolean} silent */
  function drawScope(w, h, time, silent) {
    grid(w, h, 28);
    analyser.getByteTimeDomainData(/** @type {Uint8Array<ArrayBuffer>} */ (time));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.3;
    ctx.globalAlpha = 1;
    ctx.beginPath();
    for (let i = 0; i < time.length; i += 1) {
      const x = (i / (time.length - 1)) * w;
      const amp = silent ? 0.045 * Math.sin(i * 0.08 + idlePhase) : (time[i] - 128) / 128;
      const y = h / 2 - amp * h * 0.42;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  /** @param {number} w @param {number} h @param {Float32Array} heights @param {boolean} silent */
  function drawDots(w, h, heights, silent) {
    const cols = 40;
    const rows = 7;
    const gx = w / cols;
    const gy = h / rows;
    for (let c = 0; c < cols; c += 1) {
      const level = silent
        ? 1 + Math.round(Math.sin(idlePhase + c * 0.2))
        : Math.round(heights[Math.round((c / cols) * (barCount - 1))] * rows);
      for (let r = 0; r < rows; r += 1) {
        const lit = r >= rows - level;
        ctx.globalAlpha = lit ? 0.9 : 0.22;
        ctx.fillStyle = color;
        ctx.fillRect(c * gx + gx * 0.28, r * gy + gy * 0.22, gx * 0.44, gy * 0.5);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** @param {number} w @param {number} h @param {Float32Array} heights @param {boolean} silent */
  function drawRadial(w, h, heights, silent) {
    const cx = w / 2;
    const cy = h / 2;
    const base = Math.min(w, h) * 0.24;
    const span = Math.min(w, h) * 0.24;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.2;
    ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.arc(cx, cy, base, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    const steps = 96;
    for (let i = 0; i <= steps; i += 1) {
      const a = (i / steps) * Math.PI * 2;
      const value = silent
        ? 0.06 + 0.04 * Math.sin(idlePhase + a * 3)
        : heights[i % barCount];
      const r = base + value * span;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  }

  function drawFrame() {
    if (stopped) return;
    const { w, h } = size();
    if (w === 0 || h === 0) return;
    const { freq, time, energy } = readSignal();
    const silent = energy < 0.5;
    const heights = barHeights(freq);
    ctx.clearRect(0, 0, w, h);

    if (silent && variant === "bars") drawIdleBars(w, h);
    else if (variant === "bars") drawBars(w, h, heights);
    else if (variant === "scope") drawScope(w, h, time, silent);
    else if (variant === "dots") drawDots(w, h, heights, silent);
    else drawRadial(w, h, heights, silent);

    idlePhase += 0.03;
  }

  function draw() {
    drawFrame();
    if (!reducedMotion && !stopped) animationId = requestAnimationFrame(draw);
  }

  draw();

  return {
    stop() {
      stopped = true;
      if (animationId !== null) cancelAnimationFrame(animationId);
      animationId = null;
      resizeObserver.disconnect();
    },
    /** @param {string} next */
    setVariant(next) {
      variant = normaliseVariant(next);
      peaks = new Float32Array(barCount);
      drawFrame();
    },
    getVariant() {
      return variant;
    },
  };
}
