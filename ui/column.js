import { createWaveform } from "../audio/waveform.js";

/**
 * Renders a single model Column: display name, monospaced reasoning text,
 * auto-scroll with manual scroll-back, and "new content below" indicator.
 */
export function createColumn(container, model) {
  const col = document.createElement("div");
  col.className = "column";

  // Header with model name in model's color
  const header = document.createElement("div");
  header.className = "column-header";
  header.style.color = model.color;
  header.textContent = model.name;

  // Reasoning text container
  const reasoningEl = document.createElement("div");
  reasoningEl.className = "column-reasoning";
  reasoningEl.style.color = model.color;

  // "New content below" indicator
  const scrollIndicator = document.createElement("div");
  scrollIndicator.className = "scroll-indicator";
  scrollIndicator.textContent = "↓ new content";
  scrollIndicator.style.color = model.color;
  scrollIndicator.style.display = "none";

  const waveform = document.createElement("canvas");
  waveform.className = "column-waveform";

  col.appendChild(header);
  col.appendChild(reasoningEl);
  col.appendChild(scrollIndicator);
  col.appendChild(waveform);
  container.appendChild(col);

  let waveformController = null;

  // Scroll tracking
  let userScrolledUp = false;
  let hasNewContentBelow = false;

  reasoningEl.addEventListener("scroll", () => {
    const { scrollTop, scrollHeight, clientHeight } = reasoningEl;
    const atBottom = scrollHeight - scrollTop - clientHeight < 10;
    userScrolledUp = !atBottom;
    if (atBottom) {
      hasNewContentBelow = false;
      scrollIndicator.style.display = "none";
    }
  });

  let reasoningText = "";

  function appendToken(token) {
    reasoningText += token;
    reasoningEl.textContent = reasoningText;

    // Check if we're at the bottom
    const { scrollTop, scrollHeight, clientHeight } = reasoningEl;
    const atBottom = scrollHeight - scrollTop - clientHeight < 10;

    if (atBottom) {
      // Auto-scroll to bottom
      reasoningEl.scrollTop = reasoningEl.scrollHeight;
    } else {
      // User scrolled up — show indicator
      hasNewContentBelow = true;
      scrollIndicator.style.display = "block";
    }
  }

  function attachWaveform(analyserNode, color) {
    stopWaveform();
    waveformController = createWaveform(waveform, analyserNode, color);
  }

  function stopWaveform() {
    waveformController?.stop();
    waveformController = null;
  }

  function clear() {
    col.classList.remove("has-error");
    reasoningText = "";
    reasoningEl.textContent = "";
    scrollIndicator.style.display = "none";
    userScrolledUp = false;
    hasNewContentBelow = false;
    stopWaveform();
  }

  function setError(message) {
    col.classList.add("has-error");
    const span = document.createElement("span");
    span.className = "error-msg";
    span.textContent = message;
    reasoningEl.textContent = "";
    reasoningEl.appendChild(span);
    reasoningEl.style.color = "";
  }

  return {
    element: col,
    appendToken,
    clear,
    setError,
    attachWaveform,
    stopWaveform,
  };
}
