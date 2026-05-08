/**
 * @typedef {Object} StreamCallbacks
 * @property {(token: string) => void} [onReasoningToken]
 * @property {() => void} [onContentStart]
 * @property {() => void} [onDone]
 */

import { OpenAICompatibleProvider } from "./providers/openai-compatible-provider.js";

/**
 * Streams reasoning tokens from an OpenAI-compatible chat completion endpoint.
 * Hides the full fetch → SSE parse → callback pipeline internally.
 * Retries once on any non-abort failure.
 *
 * Backward-compatible wrapper around OpenAICompatibleProvider.
 *
 * @param {string} url - Provider URL (e.g. http://localhost:1234/v1 or http://localhost:1234/v1/chat/completions)
 * @param {string} model - Model identifier
 * @param {string} systemPrompt - System message content
 * @param {string} question - User question
 * @param {StreamCallbacks} callbacks
 * @param {Record<string, unknown> | AbortSignal} [options] - Extra fields merged into the request body
 * @param {AbortSignal} [signal] - Optional abort signal
 */
export async function streamReasoning(url, model, systemPrompt, question, callbacks, options = {}, signal) {
  // Backward compat: callers may pass signal as the 6th argument
  if (options && typeof options.aborted === "boolean") {
    signal = /** @type {AbortSignal} */ (options);
    options = {};
  }

  const provider = new OpenAICompatibleProvider({ url, model, reasoningFormat: "separate" });
  // Options are no longer passed through to the provider (unused in the app).
  // If needed in the future, extend OpenAICompatibleProvider constructor.
  void options;
  return provider.streamReasoning(question, systemPrompt, callbacks, signal);
}
