/**
 * Sends a streaming chat completion request to an OpenAI-compatible endpoint.
 * Returns the response ReadableStream for consumption by StreamParser.
 * @param {AbortSignal} [signal] - optional abort signal for cancellation
 */
export async function streamCompletion(baseUrl, model, systemPrompt, question, signal) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
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
}
