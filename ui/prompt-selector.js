/**
 * Question palette: the on-demand overlay that holds Curated prompts and the
 * Free-text question. Clicking a Curated prompt starts a Session immediately —
 * there is no Ask confirmation button anywhere in the interface.
 */
import "./prompt-selector.css";

/**
 * @typedef {Object} PromptSelectorAPI
 * @property {(fn: (question: string) => void) => void} onAsk
 * @property {(questions: string[]) => void} updateRecentQuestions
 * @property {() => string | null} getSelectedQuestion
 * @property {(value: boolean) => void} setEnabled
 * @property {(index: number) => void} selectByKeyboard
 * @property {(fn: () => void) => void} onClose
 * @property {() => void} show
 * @property {() => void} hide
 * @property {() => boolean} isOpen
 * @property {HTMLDivElement} panel
 */

/**
 * @param {HTMLElement} container
 * @param {string[]} curatedPrompts
 * @param {string[]} [recentQuestions]
 * @returns {PromptSelectorAPI}
 */
export function createPromptSelector(container, curatedPrompts, recentQuestions = []) {
  /** @type {string | null} */
  let selectedPrompt = curatedPrompts[0] ?? null;
  let enabled = true;
  /** @type {((question: string) => void) | null} */
  let onAsk = null;
  /** @type {(() => void) | null} */
  let onClose = null;

  const panel = document.createElement("div");
  panel.className = "palette-panel";
  panel.hidden = true;

  const header = document.createElement("div");
  header.className = "palette-header";
  const title = document.createElement("span");
  title.textContent = "Select question";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "palette-close";
  close.textContent = "× esc";
  close.addEventListener("click", () => { if (onClose) onClose(); else hide(); });
  header.appendChild(title);
  header.appendChild(close);

  const body = document.createElement("div");
  body.className = "palette-body";

  const curatedLabel = document.createElement("div");
  curatedLabel.className = "palette-label";
  curatedLabel.textContent = "Curated prompts · click to ask · 1–5";

  const cardsContainer = document.createElement("div");
  cardsContainer.className = "prompt-cards";

  const recentContainer = document.createElement("div");
  recentContainer.className = "recent-questions";
  recentContainer.style.display = "none";
  const recentLabel = document.createElement("div");
  recentLabel.className = "recent-label";
  recentLabel.textContent = "Recent";
  const recentList = document.createElement("div");
  recentList.className = "recent-list";
  recentContainer.appendChild(recentLabel);
  recentContainer.appendChild(recentList);

  const freeLabel = document.createElement("div");
  freeLabel.className = "palette-label";
  freeLabel.textContent = "Or type your own · enter to ask";

  const textInput = document.createElement("textarea");
  textInput.className = "prompt-input";
  textInput.placeholder = "Ask anything…";
  textInput.rows = 2;

  const runningHint = document.createElement("div");
  runningHint.className = "run-hint";
  runningHint.textContent = "Running · stop first to ask again";
  runningHint.style.display = "none";

  const foot = document.createElement("div");
  foot.className = "palette-foot";
  foot.textContent = "/ open · esc close · h history · v shuffle · 1–5 ask";

  /** @param {string} question */
  function ask(question) {
    if (!enabled || !question) return;
    if (onClose) onClose();
    onAsk?.(question);
  }

  curatedPrompts.forEach((prompt, index) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "prompt-card" + (index === 0 ? " selected" : "");
    card.innerHTML = "<i>" + (index + 1) + "</i>";
    card.appendChild(document.createTextNode(prompt));
    card.addEventListener("click", () => {
      if (!enabled) return;
      selectCard(index);
      selectedPrompt = prompt;
      textInput.value = "";
      ask(prompt);
    });
    cardsContainer.appendChild(card);
  });

  /** @param {number} index */
  function selectCard(index) {
    cardsContainer.querySelectorAll(".prompt-card").forEach((c, i) => {
      c.classList.toggle("selected", i === index);
    });
  }

  /** @param {number} index */
  function selectByKeyboard(index) {
    if (index < 0 || index >= curatedPrompts.length) return;
    selectCard(index);
    selectedPrompt = curatedPrompts[index];
    textInput.value = "";
    ask(selectedPrompt);
  }

  textInput.addEventListener("input", () => {
    if (!enabled) return;
    cardsContainer.querySelectorAll(".prompt-card").forEach((c) => c.classList.remove("selected"));
    selectedPrompt = null;
  });

  textInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const value = textInput.value.trim();
      if (value) ask(value);
    }
  });

  body.appendChild(curatedLabel);
  body.appendChild(cardsContainer);
  body.appendChild(recentContainer);
  body.appendChild(freeLabel);
  body.appendChild(textInput);
  body.appendChild(runningHint);

  panel.appendChild(header);
  panel.appendChild(body);
  panel.appendChild(foot);
  container.appendChild(panel);

  /** @param {string[]} questions */
  function renderRecentQuestions(questions) {
    recentList.innerHTML = "";
    if (!questions || questions.length === 0) {
      recentContainer.style.display = "none";
      return;
    }
    recentContainer.style.display = "block";
    for (const q of questions) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "recent-item";
      item.textContent = q;
      item.addEventListener("click", () => {
        if (!enabled) return;
        textInput.value = q;
        cardsContainer.querySelectorAll(".prompt-card").forEach((c) => c.classList.remove("selected"));
        selectedPrompt = null;
      });
      recentList.appendChild(item);
    }
  }
  renderRecentQuestions(recentQuestions);

  function show() {
    if (!enabled) {
      // Still allow the palette to open while running so its state is visible,
      // but the input area stays disabled.
    }
    panel.hidden = false;
    if (enabled) textInput.focus();
  }

  function hide() {
    panel.hidden = true;
  }

  return {
    onAsk(fn) { onAsk = fn; },
    onClose(fn) { onClose = fn; },
    updateRecentQuestions: renderRecentQuestions,
    getSelectedQuestion() {
      if (selectedPrompt) return selectedPrompt;
      const text = textInput.value.trim();
      return text || null;
    },
    setEnabled(value) {
      enabled = value;
      textInput.disabled = !value;
      runningHint.style.display = value ? "none" : "block";
      body.classList.toggle("disabled", !value);
      cardsContainer.querySelectorAll(".prompt-card").forEach((/** @type {Element} */ c) => {
        /** @type {HTMLButtonElement} */ (c).disabled = !value;
      });
      recentList.querySelectorAll(".recent-item").forEach((/** @type {Element} */ c) => {
        /** @type {HTMLButtonElement} */ (c).disabled = !value;
      });
    },
    selectByKeyboard,
    show,
    hide,
    isOpen() { return !panel.hidden; },
    panel,
  };
}
