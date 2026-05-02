/**
 * Consumes a ReadableStream from an OpenAI-compatible streaming response.
 * Parses SSE chunks, extracts reasoning content deltas, and fires callbacks.
 *
 * Callbacks:
 *   onReasoningToken(token) — called for each token of reasoning text
 *   onContentStart()        — called when the model transitions to final answer
 *   onDone()                — called when the stream ends or is aborted
 */
export async function parseStream(readableStream, callbacks) {
  const reader = readableStream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let contentStarted = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Split on double-newline to get individual SSE messages
      const parts = buffer.split("\n\n");
      // Keep the last incomplete part in the buffer
      buffer = parts.pop() || "";

      for (const part of parts) {
        const lines = part.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;

          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") {
            callbacks.onDone?.();
            return;
          }

          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue; // malformed JSON, skip
          }

          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;

          // If content field appears and has text, we've hit the content boundary
          if (delta.content && delta.content.length > 0) {
            if (!contentStarted) {
              contentStarted = true;
              callbacks.onContentStart?.();
            }
            // Discard final answer — don't yield content tokens
            continue;
          }

          // Extract reasoning token from provider-specific field names
          const token = delta.reasoning_content ?? delta.reasoning;
          if (token) {
            callbacks.onReasoningToken?.(token);
          }
        }
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      const lines = buffer.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") {
          callbacks.onDone?.();
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.content && delta.content.length > 0) {
            if (!contentStarted) {
              contentStarted = true;
              callbacks.onContentStart?.();
            }
            continue;
          }
          const token = delta.reasoning_content ?? delta.reasoning;
          if (token) {
            callbacks.onReasoningToken?.(token);
          }
        } catch {
          // skip
        }
      }
    }

    callbacks.onDone?.();
  } catch (err) {
    // Stream was likely aborted — clean up
    reader.releaseLock();
    if (err.name !== "AbortError") {
      console.error("StreamParser error:", err);
    }
    callbacks.onDone?.();
  }
}
