/**
 * @typedef {Object} TokenUsage
 * @property {number} prompt_tokens
 * @property {number} completion_tokens
 * @property {number} total_tokens
 * @property {number} [reasoning_tokens] - From completion_tokens_details
 * @property {number} [cost] - USD, reported by OpenRouter
 *
 * @typedef {Object} StreamCallbacks
 * @property {(token: string) => void} [onReasoningToken]
 * @property {() => void} [onContentStart]
 * @property {() => void} [onDone]
 * @property {(finishReason: string) => void} [onTruncated] - Fired once when
 *   generation stops with a length-based finish_reason.
 * @property {(usage: TokenUsage) => void} [onUsage] - Token/cost accounting from
 *   the terminal usage chunk (recorded, not displayed).
 * @property {(text: string) => void} [onAnswer] - Final answer (delta.content)
 *   fragments, recorded but deliberately not displayed or spoken.
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
