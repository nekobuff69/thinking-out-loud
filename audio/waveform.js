import { normaliseVariant } from "./waveform-variants.js";
import { WAVEFORM_PALETTE } from "../styles/design-tokens.js";

/**
 * Renders a live Waveform on a canvas element.
 *
 * Four named animations share one AnalyserNode and can be hot-swapped in place.
 * Drawing geometry and colours are transcribed from the B-2 visual source of
 * truth (`docs/ui-refactor-b2-detail.html`, `draw()`): a dim horizontal
 * baseline, 24 mirrored bars, a 12/32 oscilloscope grid, a 40x7 VFD matrix
 * and a ring voiceprint, all in the B-2 duotone (fg / ac / dim).
 *
 * Every branch falls back to a gentle Idle waveform while its Channel is
 * silent. Under a reduced-motion preference a single static frame is drawn.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {AnalyserNode} analyser
 * @param {string} color - Legacy per-Model colour. Retained for API
 *   compatibility but deliberately ignored: B-2 uses one duotone for all
 *   Columns, never three neon hues.
 * @param {{ variant?: string, fftSize?: number, reducedMotion?: boolean, palette?: import("../styles/design-tokens.js").WaveformPalette }} [options]
 * @returns {{ stop: () => void, setVariant: (variant: string) => void, getVariant: () => string }}
 */
export function createWaveform(canvas, analyser, color, options = {}) {
  void color;
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  if (!ctx) throw new Error("Canvas 2D context not supported");

  const palette = options.palette ?? WAVEFORM_PALETTE;
  const { fg, ac, dim } = palette;

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
  function baseline(w, h) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = dim;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
  }

  /** @param {number} w @param {number} h */
  function drawIdleBars(w, h) {
    const n = 24;
    const bw = w / (n * 2);
    for (let i = 0; i < n; i += 1) {
      const phase = idlePhase + (i / n) * Math.PI * 1.5;
      const bh = Math.max(1, (0.04 + 0.05 * Math.sin(phase)) * h * 0.86);
      ctx.fillStyle = fg;
      ctx.globalAlpha = 0.28 + 0.12 * Math.sin(phase);
      ctx.fillRect(i * bw + 1, h - bh, bw - 2, bh);
      ctx.fillRect(w - (i + 1) * bw + 1, h - bh, bw - 2, bh);
    }
    ctx.globalAlpha = 1;
  }

  /** @param {number} w @param {number} h @param {Float32Array} heights */
  function drawBars(w, h, heights) {
    const n = 24;
    const bw = w / (n * 2);
    for (let i = 0; i < n; i += 1) {
      const value = heights[Math.round((i / n) * 47)] ?? 0;
      const bh = Math.max(1, value * h * 0.86);
      ctx.fillStyle = fg;
      ctx.globalAlpha = 0.55 + (heights[i % 48] ?? 0) * 0.45;
      ctx.fillRect(i * bw + 1, h - bh, bw - 2, bh);
      ctx.fillRect(w - (i + 1) * bw + 1, h - bh, bw - 2, bh);
    }
    ctx.globalAlpha = 1;
  }

  /** @param {number} w @param {number} h */
  function scopeGrid(w, h) {
    ctx.strokeStyle = dim;
    ctx.lineWidth = 0.5;
    for (let y = 12; y < h; y += 12) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    for (let x = 0; x < w; x += 32) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
  }

  /** @param {number} w @param {number} h @param {Uint8Array} time @param {boolean} silent */
  function drawScope(w, h, time, silent) {
    scopeGrid(w, h);
    analyser.getByteTimeDomainData(/** @type {Uint8Array<ArrayBuffer>} */ (time));
    ctx.strokeStyle = fg;
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
        : Math.round((heights[Math.round((c / cols) * 47)] ?? 0) * rows);
      for (let r = 0; r < rows; r += 1) {
        const lit = r >= rows - level;
        ctx.fillStyle = lit ? ac : dim;
        ctx.globalAlpha = lit ? 0.9 : 0.35;
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
    ctx.strokeStyle = dim;
    ctx.lineWidth = 0.6;
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(cx, cy, base, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = fg;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    const steps = 96;
    for (let i = 0; i <= steps; i += 1) {
      const a = (i / steps) * Math.PI * 2;
      const value = silent
        ? 0.06 + 0.04 * Math.sin(idlePhase + a * 3)
        : (heights[i % barCount] ?? 0);
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
    baseline(w, h);

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
