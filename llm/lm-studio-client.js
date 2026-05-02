/**
 * Sends a streaming chat completion request to an OpenAI-compatible endpoint.
 * Returns the response ReadableStream for consumption by StreamParser.
 * Retries once on network failure before giving up.
 * @param {AbortSignal} [signal] - optional abort signal for cancellation
 */
export async function streamCompletion(baseUrl, model, systemPrompt, question, signal) {
  const attempt = async (abortSignal) => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
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
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM request failed: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error("Response body is null — streaming not supported");
    }

    return response.body;
  };

  try {
    return await attempt(signal);
  } catch (err) {
    // Don't retry if the user aborted
    if (err.name === "AbortError") throw err;
    // Single retry for network errors
    return attempt(signal);
  }
}
