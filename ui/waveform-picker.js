/**
 * Waveform picker: a small popover anchored above the Column whose Waveform
 * was clicked. Shows four live previews and the animation names only — no
 * variant codes, no labels on the Waveform panel itself.
 */
import { WAVEFORM_NAMES } from "../audio/waveform-variants.js";
import { WAVEFORM_PALETTE } from "../styles/design-tokens.js";
import "./waveform-picker.css";

/**
 * @typedef {Object} WaveformPickerAPI
 * @property {(columnIndex: number, anchorRect: DOMRect) => void} open
 * @property {() => void} close
 * @property {(variants: string[]) => void} setCurrent
 * @property {() => number | null} getTarget
 */

/**
 * @param {HTMLElement} host
 * @param {string[]} variantIds
 * @param {(columnIndex: number, variant: string) => void} onSelect
 * @returns {WaveformPickerAPI}
 */
export function createWaveformPicker(host, variantIds, onSelect) {
  /** @type {number | null} */
  let target = null;
  /** @type {string[]} */
  let current = [];

  const panel = document.createElement("div");
  panel.className = "waveform-picker-panel";

  const head = document.createElement("div");
  head.className = "waveform-picker-head";
  const title = document.createElement("span");
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "× esc";
  close.addEventListener("click", () => closePicker());
  head.appendChild(title);
  head.appendChild(close);

  const grid = document.createElement("div");
  grid.className = "waveform-picker-grid";

  const foot = document.createElement("div");
  foot.className = "waveform-picker-foot";
  foot.textContent = "Applies to this column only · esc to close";

  /** @type {Array<{ id: string, el: HTMLButtonElement, canvas: HTMLCanvasElement, phase: number }>} */
  const options = variantIds.map((id) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "waveform-picker-option";
    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 34;
    const name = document.createElement("span");
    name.textContent = WAVEFORM_NAMES[id] ?? id;
    el.appendChild(canvas);
    el.appendChild(name);
    el.addEventListener("click", () => {
      if (target === null) return;
      onSelect(target, id);
      closePicker();
    });
    grid.appendChild(el);
    return { id, el, canvas, phase: Math.random() * Math.PI * 2 };
  });

  panel.appendChild(head);
  panel.appendChild(grid);
  panel.appendChild(foot);
  host.appendChild(panel);

  /** @returns {void} */
  function closePicker() {
    target = null;
    panel.hidden = true;
  }

  const { fg, ac, dim } = WAVEFORM_PALETTE;

  /** @param {CanvasRenderingContext2D} ctx @param {number} w @param {number} h @param {string} id @param {number} t */
  function preview(ctx, w, h, id, t) {
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 1;
    ctx.strokeStyle = dim;
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    ctx.globalAlpha = 1;

    if (id === "bars") {
      ctx.fillStyle = fg;
      for (let i = 0; i < 12; i += 1) {
        const n = 0.3 + 0.7 * Math.abs(Math.sin(t + i * 0.5));
        ctx.globalAlpha = 0.55 + n * 0.45;
        ctx.fillRect(i * (w / 12) + 1, h - n * h, w / 12 - 2, n * h);
      }
    } else if (id === "scope") {
      ctx.strokeStyle = dim;
      ctx.lineWidth = 0.5;
      for (let y = 12; y < h; y += 12) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }
      for (let x = 0; x < w; x += 32) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
      ctx.strokeStyle = fg;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 2) {
        const y = h / 2 + Math.sin(x * 0.16 + t) * h * 0.3;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    } else if (id === "dots") {
      for (let c = 0; c < 16; c += 1) {
        const level = 1 + Math.round(3 * Math.abs(Math.sin(t + c * 0.4)));
        for (let r = 0; r < 5; r += 1) {
          const lit = r >= 5 - level;
          ctx.fillStyle = lit ? ac : dim;
          ctx.globalAlpha = lit ? 0.9 : 0.35;
          ctx.fillRect(c * (w / 16) + 1, r * (h / 5) + 1, w / 16 - 2, h / 5 - 2);
        }
      }
    } else {
      const base = Math.min(w, h) * 0.28;
      ctx.strokeStyle = dim;
      ctx.lineWidth = 0.6;
      ctx.beginPath(); ctx.arc(w / 2, h / 2, base, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = fg;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let i = 0; i <= 48; i += 1) {
        const a = (i / 48) * Math.PI * 2;
        const r = Math.min(w, h) * (0.28 + 0.08 * Math.sin(a * 6 + t));
        const x = w / 2 + Math.cos(a) * r;
        const y = h / 2 + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  const reduced = typeof window !== "undefined" && typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let start = performance.now();
  /** @returns {void} */
  function animate() {
    const t = (performance.now() - start) / 1000;
    for (const option of options) {
      const ctx = option.canvas.getContext("2d");
      if (ctx) preview(ctx, option.canvas.width, option.canvas.height, option.id, t + option.phase);
    }
    if (!reduced) requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);

  /** @param {string[]} variants */
  function setCurrent(variants) {
    current = [...variants];
    options.forEach((option) => {
      option.el.classList.toggle("on", target !== null && current[target] === option.id);
    });
  }

  return {
    open(columnIndex, anchorRect) {
      target = columnIndex;
      title.textContent = "CH 0" + (columnIndex + 1) + " / waveform · v to shuffle";
      const parent = host.getBoundingClientRect();
      const hostWidth = parent.width;
      const width = Math.min(520, hostWidth * 0.86);
      const center = anchorRect.left - parent.left + anchorRect.width / 2;
      const left = Math.max(12, Math.min(center - width / 2, hostWidth - width - 12));
      panel.style.width = width + "px";
      panel.style.left = left + "px";
      panel.style.setProperty("--anchor-x", (center - left) + "px");
      panel.hidden = false;
      setCurrent(current);
    },
    close: closePicker,
    setCurrent,
    getTarget() { return target; },
  };
}
