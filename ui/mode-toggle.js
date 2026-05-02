/**
 * Renders a segmented Chorus / Monologue mode toggle.
 */
import "./mode-toggle.css";

/**
 * @typedef {Object} ModeToggleAPI
 * @property {() => string} getMode
 * @property {(fn: (mode: string) => void) => void} onChange
 * @property {(value: boolean) => void} setEnabled
 */

/**
 * @param {HTMLElement} container
 * @param {string} defaultMode
 * @returns {ModeToggleAPI}
 */
export function createModeToggle(container, defaultMode) {
  /** @type {string} */
  let currentMode = defaultMode;
  /** @type {boolean} */
  let enabled = true;
  /** @type {((mode: string) => void) | null} */
  let onChange = null;

  const wrapper = document.createElement("div");
  wrapper.className = "mode-toggle";

  const label = document.createElement("span");
  label.textContent = "Mode:";
  label.style.cssText = "color:#555;font-size:0.8rem;margin-right:0.5rem;";

  const group = document.createElement("div");
  group.className = "mode-toggle-group";

  const chorusBtn = document.createElement("button");
  chorusBtn.type = "button";
  chorusBtn.textContent = "Chorus";
  chorusBtn.className = `mode-btn${currentMode === "chorus" ? " active" : ""}`;

  const monologueBtn = document.createElement("button");
  monologueBtn.type = "button";
  monologueBtn.textContent = "Monologue";
  monologueBtn.className = `mode-btn${currentMode === "monologue" ? " active" : ""}`;

  chorusBtn.addEventListener("click", () => {
    if (!enabled) return;
    currentMode = "chorus";
    chorusBtn.classList.add("active");
    monologueBtn.classList.remove("active");
    onChange?.(currentMode);
  });

  monologueBtn.addEventListener("click", () => {
    if (!enabled) return;
    currentMode = "monologue";
    monologueBtn.classList.add("active");
    chorusBtn.classList.remove("active");
    onChange?.(currentMode);
  });

  group.appendChild(chorusBtn);
  group.appendChild(monologueBtn);
  wrapper.appendChild(label);
  wrapper.appendChild(group);
  container.insertBefore(wrapper, container.firstChild);

  /**
   * @param {boolean} value
   * @returns {void}
   */
  function setEnabled(value) {
    enabled = value;
    chorusBtn.disabled = !value;
    monologueBtn.disabled = !value;
  }

  return {
    /** @returns {string} */
    getMode() { return currentMode; },
    /** @param {(mode: string) => void} fn */
    onChange(fn) { onChange = fn; },
    setEnabled,
  };
}
