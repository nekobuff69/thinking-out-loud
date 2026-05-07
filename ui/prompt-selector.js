/**
 * Renders the PromptSelector: curated prompt cards + free-text input + Ask button.
 * Returns an object with methods to manage the UI state.
 */
import "./prompt-selector.css";

/**
 * @typedef {Object} PromptSelectorAPI
 * @property {(fn: (question: string) => void) => void} onAsk
 * @property {(questions: string[]) => void} updateRecentQuestions
 * @property {() => string | null} getSelectedQuestion
 * @property {(value: boolean) => void} setEnabled
 */

/**
 * @param {HTMLElement} container
 * @param {string[]} curatedPrompts
 * @param {string[]} [recentQuestions]
 * @returns {PromptSelectorAPI}
 */
export function createPromptSelector(container, curatedPrompts, recentQuestions = []) {
  /** @type {string | null} */
  let selectedPrompt = null;
  /** @type {boolean} */
  let enabled = true;

  const wrapper = document.createElement("div");
  wrapper.className = "prompt-selector";

  // Prompt cards
  const cardsContainer = document.createElement("div");
  cardsContainer.className = "prompt-cards";

  curatedPrompts.forEach((prompt) => {
    const card = document.createElement("button");
    card.className = "prompt-card";
    card.type = "button";
    card.textContent = prompt;
    card.addEventListener("click", () => {
      if (!enabled) return;
      // Deselect other cards
      cardsContainer.querySelectorAll(".prompt-card").forEach((c) =>
        c.classList.remove("selected")
      );
      card.classList.add("selected");
      selectedPrompt = prompt;
      // Clear free-text input
      textInput.value = "";
      onSelectionChange?.();
    });
    cardsContainer.appendChild(card);
  });

  // Free-text input
  const textInput = document.createElement("textarea");
  textInput.className = "prompt-input";
  textInput.placeholder = "Or type your own question…";
  textInput.rows = 2;
  textInput.addEventListener("input", () => {
    if (!enabled) return;
    // Deselect cards when typing
    cardsContainer.querySelectorAll(".prompt-card").forEach((c) =>
      c.classList.remove("selected")
    );
    selectedPrompt = null;
    onSelectionChange?.();
  });

  // Ask button
  const askBtn = document.createElement("button");
  askBtn.className = "ask-btn";
  askBtn.type = "button";
  askBtn.textContent = "Ask";
  askBtn.disabled = true;
  askBtn.addEventListener("click", () => {
    const question = getSelectedQuestion();
    if (question) {
      onAsk?.(question);
    }
  });

  // Recent questions section
  const recentContainer = document.createElement("div");
  recentContainer.className = "recent-questions";
  recentContainer.style.display = "none";

  const recentLabel = document.createElement("div");
  recentLabel.className = "recent-label";
  recentLabel.textContent = "Recent";
  recentContainer.appendChild(recentLabel);

  const recentList = document.createElement("div");
  recentList.className = "recent-list";
  recentContainer.appendChild(recentList);

  /**
   * @param {string[]} questions
   * @returns {void}
   */
  function renderRecentQuestions(questions) {
    recentList.innerHTML = "";
    if (!questions || questions.length === 0) {
      recentContainer.style.display = "none";
      return;
    }
    recentContainer.style.display = "block";
    for (const q of questions) {
      const item = document.createElement("button");
      item.className = "recent-item";
      item.type = "button";
      item.textContent = q;
      item.addEventListener("click", () => {
        if (!enabled) return;
        textInput.value = q;
        // Deselect cards
        cardsContainer.querySelectorAll(".prompt-card").forEach((c) =>
          c.classList.remove("selected")
        );
        selectedPrompt = null;
        onSelectionChange?.();
      });
      recentList.appendChild(item);
    }
  }

  /**
   * @param {string[]} questions
   * @returns {void}
   */
  function updateRecentQuestions(questions) {
    renderRecentQuestions(questions);
  }

  // Initial render
  renderRecentQuestions(recentQuestions);

  wrapper.appendChild(recentContainer);
  wrapper.appendChild(cardsContainer);
  wrapper.appendChild(textInput);
  wrapper.appendChild(askBtn);
  container.appendChild(wrapper);

  /** @type {((question: string) => void) | null} */
  let onAsk = null;
  /** @type {(() => void) | null} */
  let onSelectionChange = null;

  /** @returns {string | null} */
  function getSelectedQuestion() {
    if (selectedPrompt) return selectedPrompt;
    const text = textInput.value.trim();
    return text || null;
  }

  function updateAskButton() {
    askBtn.disabled = !enabled || !getSelectedQuestion();
  }

  /**
   * @param {boolean} value
   * @returns {void}
   */
  function setEnabled(value) {
    enabled = value;
    textInput.disabled = !value;
    cardsContainer.querySelectorAll(".prompt-card").forEach((/** @type {Element} */ c) => {
      /** @type {HTMLButtonElement} */ (c).disabled = !value;
    });
    updateAskButton();
  }

  // Hook up selection change to update ask button
  onSelectionChange = updateAskButton;

  return {
    onAsk(fn) { onAsk = fn; },
    updateRecentQuestions,
    getSelectedQuestion,
    setEnabled,
  };
}
