/**
 * Streams reasoning tokens from an OpenAI-compatible chat completion endpoint.
 * Hides the full fetch → SSE parse → callback pipeline internally.
 * Retries once on any non-abort failure.
 *
 * @param {string} url - Provider URL (e.g. http://localhost:1234/v1 or http://localhost:1234/v1/chat/completions)
 * @param {string} model - Model identifier
 * @param {string} systemPrompt - System message content
 * @param {string} question - User question
 * @param {{onReasoningToken?: (token: string) => void, onContentStart?: () => void, onDone?: () => void}} callbacks
 * @param {object} [options] - Extra fields merged into the request body
 * @param {AbortSignal} [signal] - Optional abort signal
 */
export async function streamReasoning(url, model, systemPrompt, question, callbacks, options = {}, signal) {
  // Backward compat: callers may pass signal as the 6th argument
  if (options && typeof options.aborted === "boolean") {
    signal = options;
    options = {};
  }

  const endpoint = url.endsWith("/chat/completions") ? url : `${url}/chat/completions`;

  const attempt = async (abortSignal) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abortSignal,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: question },
        ],
        stream: true,
        ...options,
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

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";

        for (const part of parts) {
          if (processSsePart(part, callbacks, state)) return;
        }
      }

      if (buffer.trim()) {
        if (processSsePart(buffer, callbacks, state)) return;
      }

      callbacks.onDone?.();
    } catch (err) {
      if (err.name !== "AbortError") {
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
    if (err.name === "AbortError") throw err;
    await attempt(signal);
  }
}

function processSsePart(part, callbacks, state) {
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
  }
  return false;
}
