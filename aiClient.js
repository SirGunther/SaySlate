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

  // Generic HTTP status mapping. Gemini itself does not use 401/403 for a bad key
  // (EV-034(b)); those statuses are kept here only for any other status Gemini or a
  // future transport might return, not as Gemini's actual bad-key path (see
  // isApiKeyInvalid below for that).
  function mapStatusToCode(status) {
    if (status === 401 || status === 403) return "authentication_failed";
    if (status === 404) return "model_unavailable";
    return "provider_error";
  }

  // LD-036(2): Gemini reports an invalid API key as HTTP 400 INVALID_ARGUMENT with a
  // structured reason, not as 401/403 (EV-034(b)). Detecting this before the LD-031
  // schema-free retry keeps a bad key from being silently retried and misclassified.
  function isApiKeyInvalid(body) {
    const details = Array.isArray(body?.error?.details) ? body.error.details : [];
    return details.some((detail) => detail?.reason === "API_KEY_INVALID");
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

  // LD-039: a Gemini 5xx (e.g. 503 "model overloaded") on the schema request gets the same
  // single schema-free retry as a 400/422, after this pause.
  const SERVER_ERROR_RETRY_DELAY_MS = 1_000;
  const PROVIDER_DETAIL_MAX_LENGTH = 200;

  function isServerError(status) {
    return status >= 500 && status <= 599;
  }

  function waitBeforeRetry(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(boundedError("request_timeout", "The AI request timed out."));
        return;
      }
      const onAbort = () => {
        window.clearTimeout(timer);
        reject(boundedError("request_timeout", "The AI request timed out."));
      };
      const timer = window.setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  // LD-039: Google's own error text, bounded and with the credential redacted, so a failure
  // explains itself the way the original `generate` path always did (`body.error.message`).
  function failureMessage(status, body, credential) {
    let detail = typeof body?.error?.message === "string" ? body.error.message.replace(/\s+/g, " ").trim() : "";
    if (credential) detail = detail.split(credential).join("[redacted]");
    detail = detail.slice(0, PROVIDER_DETAIL_MAX_LENGTH);
    return `The AI provider request failed with status ${status}${detail ? `: ${detail}` : "."}`;
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
    signal,
    retryDelayMs = SERVER_ERROR_RETRY_DELAY_MS
  }) {
    const timeoutController = new AbortController();
    const timeout = window.setTimeout(() => timeoutController.abort(), timeoutMs);
    const abortFromCaller = () => timeoutController.abort();
    signal?.addEventListener("abort", abortFromCaller, { once: true });

    try {
      const contents = [{ role: "user", parts: [{ text: userPrompt }] }];
      // LD-035 (4): keeps today's key-in-URL request and temperature 0.1 (LD-015),
      // adding only the native JSON-schema generation config. LD-036(1): the canonical
      // schema is sent as responseJsonSchema, never responseSchema - the canonical
      // schema's additionalProperties field makes Gemini reject responseSchema outright
      // (EV-034(a)), which silently fell through to the LD-031 retry on every request.
      const schemaBody = {
        contents,
        generationConfig: { temperature: 0.1, responseMimeType: "application/json", responseJsonSchema: schema }
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
        if (response.status === 400 || response.status === 422 || isServerError(response.status)) {
          // LD-036(2): a 400 carrying reason API_KEY_INVALID is an authentication
          // failure, not a schema rejection - fail here, before any retry, so a bad
          // key is never retried or misclassified as a schema-unsupported model.
          const errorBody = await parseJsonBody(response);
          if (isApiKeyInvalid(errorBody)) {
            throw boundedError("authentication_failed", "The Google AI API key was rejected.");
          }

          // LD-039: pause before retrying a server error, so an overloaded model has a
          // moment to recover; an abort during the pause is still a timeout.
          if (isServerError(response.status)) await waitBeforeRetry(retryDelayMs, timeoutController.signal);

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
              failureMessage(retryResponse.status, await parseJsonBody(retryResponse), credential)
            );
          }

          const retryBodyJson = await parseJsonBody(retryResponse);
          const retryText = extractText(retryBodyJson);
          if (!retryText) throw boundedError("malformed_response", "The AI provider returned an empty result.");
          return retryText;
        }

        throw boundedError(
          mapStatusToCode(response.status),
          failureMessage(response.status, await parseJsonBody(response), credential)
        );
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
