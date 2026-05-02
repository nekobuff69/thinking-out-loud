/**
 * Renders the PromptSelector: curated prompt cards + free-text input + Ask button.
 * Returns an object with methods to manage the UI state.
 */
export function createPromptSelector(container, curatedPrompts) {
  let selectedPrompt = null;
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

  wrapper.appendChild(cardsContainer);
  wrapper.appendChild(textInput);
  wrapper.appendChild(askBtn);
  container.appendChild(wrapper);

  let onAsk = null;
  let onSelectionChange = null;

  function getSelectedQuestion() {
    if (selectedPrompt) return selectedPrompt;
    const text = textInput.value.trim();
    return text || null;
  }

  function updateAskButton() {
    askBtn.disabled = !enabled || !getSelectedQuestion();
  }

  function setEnabled(value) {
    enabled = value;
    textInput.disabled = !value;
    cardsContainer.querySelectorAll(".prompt-card").forEach((c) => {
      c.disabled = !value;
    });
    updateAskButton();
  }

  // Hook up selection change to update ask button
  onSelectionChange = updateAskButton;

  return {
    onAsk(fn) { onAsk = fn; },
    getSelectedQuestion,
    setEnabled,
  };
}
