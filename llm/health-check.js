/**
 * Lightweight health check for OpenAI-compatible providers.
 * Pings the `/models` endpoint to verify the provider is reachable.
 */
export async function healthCheck(baseUrl, timeoutMs = 5000) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`${baseUrl}/models`, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}
