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

  // Waveform canvas placeholder (for later issues)
  const waveform = document.createElement("canvas");
  waveform.className = "column-waveform";

  col.appendChild(header);
  col.appendChild(reasoningEl);
  col.appendChild(scrollIndicator);
  col.appendChild(waveform);
  container.appendChild(col);

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

  function clear() {
    reasoningText = "";
    reasoningEl.textContent = "";
    scrollIndicator.style.display = "none";
    userScrolledUp = false;
    hasNewContentBelow = false;
  }

  function setError(message) {
    reasoningEl.textContent = message;
    reasoningEl.style.color = "#ff4444";
  }

  return {
    element: col,
    appendToken,
    clear,
    setError,
    waveform,
  };
}
