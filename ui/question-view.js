/**
 * The data shown in the Question proposition layer. Both a fresh Ask and a
 * History replay build their view here, so the question on screen can never
 * drift from the question being spoken.
 *
 * @typedef {Object} QuestionView
 * @property {string} text
 * @property {string} sessionId
 * @property {string} source
 */

/**
 * @param {string} question
 * @param {string} sessionId - Display number, padded to three digits.
 * @param {string[]} curatedPrompts
 * @returns {QuestionView}
 */
export function questionView(question, sessionId, curatedPrompts) {
  const index = curatedPrompts.indexOf(question);
  return {
    text: question,
    sessionId,
    source: index >= 0
      ? "Curated " + String(index + 1).padStart(2, "0")
      : "Free-text question",
  };
}
