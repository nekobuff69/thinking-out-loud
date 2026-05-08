/**
 * @typedef {Object} StreamCallbacks
 * @property {(token: string) => void} [onReasoningToken]
 * @property {() => void} [onContentStart]
 * @property {() => void} [onDone]
 */

/**
 * Abstract interface for LLM providers.
 * Concrete implementations handle provider-specific streaming and reasoning format parsing.
 */
export class LLMProvider {
  /**
   * Stream reasoning tokens from the provider.
   * @param {string} question - User question
   * @param {string} systemPrompt - System message content
   * @param {StreamCallbacks} callbacks
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   */
  async streamReasoning(question, systemPrompt, callbacks, signal) {
    throw new Error("LLMProvider.streamReasoning() must be implemented");
  }
}
