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

  // LD-015/LD-022/LD-025: structured entry point used by SaySlateAIProviderClient's
  // gemini-native transport. `generate` above stays untouched - app.js/floating.js keep
  // calling it directly until SAYAI-05 switches the renderer boundary.
  function boundedError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function mapStatusToCode(status) {
    if (status === 401 || status === 403) return "authentication_failed";
    if (status === 404) return "model_unavailable";
    return "provider_error";
  }

  function validateCanonicalText(rawText) {
    if (!rawText) return null;
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || typeof parsed.text !== "string") return null;
    const trimmed = parsed.text.trim();
    return trimmed ? trimmed : null;
  }

  async function parseJsonBody(response) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  async function postGenerateContent({ endpoint, credential, model, body, fetchImpl, timeoutSignal }) {
    const doFetch = fetchImpl || fetch;
    const url = `${endpoint}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(credential)}`;
    return doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: timeoutSignal
    });
  }

  async function generateStructured({
    endpoint,
    credential,
    modelId,
    systemPrompt,
    userPrompt,
    schema,
    fetchImpl,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal
  }) {
    const timeoutController = new AbortController();
    const timeout = window.setTimeout(() => timeoutController.abort(), timeoutMs);
    const abortFromCaller = () => timeoutController.abort();
    signal?.addEventListener("abort", abortFromCaller, { once: true });

    try {
      const contents = [{ role: "user", parts: [{ text: userPrompt }] }];
      // LD-035 (4): keeps today's key-in-URL request and temperature 0.1 (LD-015),
      // adding only the native JSON-schema generation config.
      const schemaBody = {
        contents,
        generationConfig: { temperature: 0.1, responseMimeType: "application/json", responseSchema: schema }
      };
      if (systemPrompt) schemaBody.systemInstruction = { parts: [{ text: systemPrompt }] };

      let response;
      try {
        response = await postGenerateContent({
          endpoint,
          credential,
          model: modelId,
          body: schemaBody,
          fetchImpl,
          timeoutSignal: timeoutController.signal
        });
      } catch (error) {
        if (error?.name === "AbortError") throw boundedError("request_timeout", "The AI request timed out.");
        throw boundedError("network_error", "The AI request failed to reach the provider.");
      }

      if (!response.ok) {
        if (response.status === 400 || response.status === 422) {
          // LD-031: exactly one schema-free retry; only a trimmed, non-empty text reply
          // is accepted. The retry's outcome is final.
          const retryBody = { contents, generationConfig: { temperature: 0.1 } };
          if (systemPrompt) retryBody.systemInstruction = { parts: [{ text: systemPrompt }] };

          let retryResponse;
          try {
            retryResponse = await postGenerateContent({
              endpoint,
              credential,
              model: modelId,
              body: retryBody,
              fetchImpl,
              timeoutSignal: timeoutController.signal
            });
          } catch (error) {
            if (error?.name === "AbortError") throw boundedError("request_timeout", "The AI request timed out.");
            throw boundedError("network_error", "The AI request failed to reach the provider.");
          }

          if (!retryResponse.ok) {
            throw boundedError(
              mapStatusToCode(retryResponse.status),
              `The AI provider request failed with status ${retryResponse.status}.`
            );
          }

          const retryBodyJson = await parseJsonBody(retryResponse);
          const retryText = extractText(retryBodyJson);
          if (!retryText) throw boundedError("malformed_response", "The AI provider returned an empty result.");
          return retryText;
        }

        throw boundedError(mapStatusToCode(response.status), `The AI provider request failed with status ${response.status}.`);
      }

      const bodyJson = await parseJsonBody(response);
      if (!bodyJson) throw boundedError("malformed_response", "The AI provider returned a non-JSON response.");
      const rawText = extractText(bodyJson);
      const text = validateCanonicalText(rawText);
      if (!text) {
        throw boundedError("malformed_response", "The AI provider returned a result that did not match the expected schema.");
      }
      return text;
    } finally {
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  globalThis.SaySlateAIClient = { generate, generateStructured };
})();
