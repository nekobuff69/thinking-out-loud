import { LLMProvider } from "./llm-provider.js";

/**
 * @typedef {Object} StreamCallbacks
 * @property {(token: string) => void} [onReasoningToken]
 * @property {() => void} [onContentStart]
 * @property {() => void} [onDone]
 */

/**
 * Parses <think>...</think> tags from streaming delta.content chunks.
 * Handles tags split across SSE chunks by buffering partial tag sequences.
 */
class TaggedParser {
  /** @type {boolean} */
  #inThink = false;
  /** @type {string} */
  #buffer = "";

  /**
   * @param {string} chunk
   * @param {(text: string) => void} onReasoning
   * @param {(text: string) => void} onContent
   */
  process(chunk, onReasoning, onContent) {
    let text = this.#buffer + chunk;
    this.#buffer = "";

    while (text.length > 0) {
      if (this.#inThink) {
        const endIdx = text.indexOf("</think>");
        if (endIdx >= 0) {
          const reasoning = text.slice(0, endIdx);
          if (reasoning) onReasoning(reasoning);
          text = text.slice(endIdx + "</think>".length);
          this.#inThink = false;
        } else {
          const partialLen = this.#partialEndTagLen(text);
          if (partialLen > 0) {
            onReasoning(text.slice(0, -partialLen));
            this.#buffer = text.slice(-partialLen);
            text = "";
          } else {
            onReasoning(text);
            text = "";
          }
        }
      } else {
        const startIdx = text.indexOf("<think>");
        if (startIdx >= 0) {
          const content = text.slice(0, startIdx);
          if (content) onContent(content);
          text = text.slice(startIdx + "<think>".length);
          this.#inThink = true;
        } else {
          const partialLen = this.#partialStartTagLen(text);
          if (partialLen > 0) {
            if (text.length > partialLen) {
              onContent(text.slice(0, -partialLen));
            }
            this.#buffer = text.slice(-partialLen);
            text = "";
          } else {
            if (text) onContent(text);
            text = "";
          }
        }
      }
    }
  }

  /**
   * @param {(text: string) => void} onReasoning
   * @param {(text: string) => void} onContent
   */
  flush(onReasoning, onContent) {
    if (this.#buffer) {
      if (this.#inThink) {
        onReasoning(this.#buffer);
      } else {
        onContent(this.#buffer);
      }
      this.#buffer = "";
    }
  }

  /**
   * @param {string} text
   * @returns {number}
   */
  #partialStartTagLen(text) {
    const tag = "<think>";
    for (let i = tag.length - 1; i >= 1; i--) {
      if (text.endsWith(tag.slice(0, i))) return i;
    }
    return 0;
  }

  /**
   * @param {string} text
   * @returns {number}
   */
  #partialEndTagLen(text) {
    const tag = "</think>";
    for (let i = tag.length - 1; i >= 1; i--) {
      if (text.endsWith(tag.slice(0, i))) return i;
    }
    return 0;
  }
}

/**
 * OpenAI-compatible provider implementation.
 * Supports "separate", "tagged", and "none" reasoning formats.
 */
export class OpenAICompatibleProvider extends LLMProvider {
  /** @type {string} */
  #url;
  /** @type {string} */
  #model;
  /** @type {"separate" | "tagged" | "none"} */
  #reasoningFormat;

  /**
   * @param {Object} opts
   * @param {string} opts.url - Provider base URL
   * @param {string} opts.model - Model identifier
   * @param {"separate" | "tagged" | "none"} [opts.reasoningFormat]
   */
  constructor({ url, model, reasoningFormat = "separate" }) {
    super();
    this.#url = url;
    this.#model = model;
    this.#reasoningFormat = reasoningFormat;
  }

  /**
   * @param {string} question
   * @param {string} systemPrompt
   * @param {StreamCallbacks} callbacks
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   */
  async streamReasoning(question, systemPrompt, callbacks, signal) {
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    const normalized = this.#url.replace(/\/+$/g, "");
    const endpoint = normalized.endsWith("/chat/completions")
      ? normalized
      : `${normalized}/chat/completions`;

    const attempt = async (/** @type {AbortSignal | undefined} */ abortSignal) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortSignal,
        body: JSON.stringify({
          model: this.#model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: question },
          ],
          stream: true,
        }),
      });

      if (!response.ok) {
        throw new Error(`LLM request failed: ${response.status} ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error("Response body is null — streaming not supported");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const state = { contentStarted: false };
      const taggedParser = new TaggedParser();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";

          for (const part of parts) {
            if (this.#processSsePart(part, callbacks, state, taggedParser)) {
              reader.releaseLock();
              return;
            }
          }
        }

        if (buffer.trim()) {
          if (this.#processSsePart(buffer, callbacks, state, taggedParser)) {
            reader.releaseLock();
            return;
          }
        }

        if (this.#reasoningFormat === "tagged") {
          taggedParser.flush(
            (text) => callbacks.onReasoningToken?.(text),
            () => {
              if (!state.contentStarted) {
                state.contentStarted = true;
                callbacks.onContentStart?.();
              }
            }
          );
        }

        callbacks.onDone?.();
      } catch (err) {
        if (err instanceof Error && err.name !== "AbortError") {
          console.error("LLM stream error:", err);
        }
        callbacks.onDone?.();
        throw err;
      } finally {
        reader.releaseLock();
      }
    };

    try {
      await attempt(signal);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      await attempt(signal);
    }
  }

  /**
   * @param {string} part
   * @param {StreamCallbacks} callbacks
   * @param {{ contentStarted: boolean }} state
   * @param {TaggedParser} taggedParser
   * @returns {boolean}
   */
  #processSsePart(part, callbacks, state, taggedParser) {
    const lines = part.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;

      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") {
        callbacks.onDone?.();
        return true;
      }

      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }

      const delta = parsed.choices?.[0]?.delta;
      if (!delta) continue;

      switch (this.#reasoningFormat) {
        case "separate": {
          if (delta.content && delta.content.length > 0) {
            if (!state.contentStarted) {
              state.contentStarted = true;
              callbacks.onContentStart?.();
            }
            continue;
          }
          const token = delta.reasoning_content ?? delta.reasoning;
          if (token) {
            callbacks.onReasoningToken?.(token);
          }
          break;
        }
        case "none": {
          if (delta.content && delta.content.length > 0) {
            callbacks.onReasoningToken?.(delta.content);
          }
          break;
        }
        case "tagged": {
          if (delta.content && delta.content.length > 0) {
            taggedParser.process(
              delta.content,
              (text) => callbacks.onReasoningToken?.(text),
              (text) => {
                if (!state.contentStarted) {
                  state.contentStarted = true;
                  callbacks.onContentStart?.();
                }
              }
            );
          }
          break;
        }
      }
    }
    return false;
  }
}
