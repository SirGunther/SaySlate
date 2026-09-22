(() => {
  "use strict";

  const ENDPOINT_ROOT = "https://generativelanguage.googleapis.com/v1beta/models";
  const DEFAULT_TIMEOUT_MS = 90_000;

  function providerError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
  }

  function extractText(body) {
    const candidates = body && Array.isArray(body.candidates) ? body.candidates : [];
    return candidates
      .flatMap((candidate) => candidate?.content?.parts || [])
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("")
      .trim();
  }

  async function generate({ apiKey, model, prompt, signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const normalizedKey = String(apiKey || "").trim();
    const normalizedModel = String(model || "").trim();
    if (!normalizedKey) throw providerError(503, "Add a Google AI API key in settings first.");
    if (!normalizedModel) throw providerError(400, "Add a Google model ID in settings first.");

    const timeoutController = new AbortController();
    const timeout = window.setTimeout(() => timeoutController.abort(), timeoutMs);
    const abortFromCaller = () => timeoutController.abort();
    signal?.addEventListener("abort", abortFromCaller, { once: true });

    try {
      const endpoint = `${ENDPOINT_ROOT}/${encodeURIComponent(normalizedModel)}:generateContent?key=${encodeURIComponent(normalizedKey)}`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: String(prompt || "") }] }],
          generationConfig: { temperature: 0.1 }
        }),
        signal: timeoutController.signal
      });

      let body = null;
      try {
        body = await response.json();
      } catch {
        // Status-based errors below still explain non-JSON responses.
      }

      if (!response.ok) {
        throw providerError(
          response.status,
          body?.error?.message || `Google model request failed with status ${response.status}.`
        );
      }

      const text = extractText(body);
      if (!text) throw providerError(502, "The model returned an empty result.");
      return text;
    } catch (error) {
      if (error?.name === "AbortError") {
        throw providerError(504, "The AI request timed out. Please try again.");
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  globalThis.SaySlateAIClient = { generate };
})();
