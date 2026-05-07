/**
 * Lightweight health check for OpenAI-compatible providers.
 * Pings the `/models` endpoint to verify the provider is reachable.
 * Retries once on failure before falling back to error state.
 *
 * @param {string} baseUrl
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function healthCheck(baseUrl, timeoutMs = 5000) {
  const attempt = async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const base = baseUrl.replace(/\/+$/g, "");
      const response = await fetch(`${base}/models`, {
        method: "GET",
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return response.ok;
    } catch {
      return false;
    }
  };

  const first = await attempt();
  if (first) return true;
  // Single retry
  return attempt();
}
