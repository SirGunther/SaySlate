(() => {
  "use strict";

  // EV-021/EV-033: Anthropic Messages transport. API-key requests authenticate with
  // x-api-key (not Bearer - EV-033 corrects EV-021's original clause), and sampling
  // parameters are omitted entirely because current Claude models return HTTP 400 for
  // temperature/top_p/top_k (EV-033).
  const DEFAULT_TIMEOUT_MS = 90_000;
  const ANTHROPIC_VERSION = "2023-06-01";
  const MAX_TOKENS = 16000;

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

  function extractBlocksText(body) {
    const blocks = Array.isArray(body?.content) ? body.content : [];
    return blocks
      .filter((block) => block?.type === "text")
      .map((block) => (typeof block?.text === "string" ? block.text : ""))
      .join("")
      .trim();
  }

  async function parseJsonBody(response) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  // LD-022: validates the canonical { text: string } result before unwrapping it.
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

  function buildHeaders(credential) {
    // LD-035 (2): x-api-key + anthropic-version, and the explicit dangerous-direct-browser
    // acknowledgement because SaySlate intentionally performs browser-direct calls.
    return {
      "Content-Type": "application/json",
      "x-api-key": credential,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-dangerous-direct-browser-access": "true"
    };
  }

  async function postMessages({ endpoint, credential, body, fetchImpl, timeoutSignal }) {
    const doFetch = fetchImpl || fetch;
    return doFetch(`${endpoint}/messages`, {
      method: "POST",
      headers: buildHeaders(credential),
      body: JSON.stringify(body),
      signal: timeoutSignal
    });
  }

  // LD-035 (2): stop_reason "refusal" maps to provider_error; "max_tokens" maps to
  // malformed_response. Applies to both the schema request and the LD-031 retry.
  function stopReasonError(body) {
    if (body?.stop_reason === "refusal") return boundedError("provider_error", "The AI provider refused the request.");
    if (body?.stop_reason === "max_tokens") {
      return boundedError("malformed_response", "The AI provider result was truncated before completion.");
    }
    return null;
  }

  async function generate({
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
      const messages = [{ role: "user", content: userPrompt }];
      // LD-035 (2): max_tokens 16000, output_config.format json_schema, no sampling params.
      const schemaBody = { model: modelId, max_tokens: MAX_TOKENS, messages, output_config: { format: { type: "json_schema", schema } } };
      if (systemPrompt) schemaBody.system = systemPrompt;

      let response;
      try {
        response = await postMessages({ endpoint, credential, body: schemaBody, fetchImpl, timeoutSignal: timeoutController.signal });
      } catch (error) {
        if (error?.name === "AbortError") throw boundedError("request_timeout", "The AI request timed out.");
        throw boundedError("network_error", "The AI request failed to reach the provider.");
      }

      if (!response.ok) {
        if (response.status === 400 || response.status === 422) {
          // LD-031: exactly one schema-free retry; only a trimmed, non-empty text reply
          // is accepted. The retry's outcome is final.
          const retryBody = { model: modelId, max_tokens: MAX_TOKENS, messages };
          if (systemPrompt) retryBody.system = systemPrompt;

          let retryResponse;
          try {
            retryResponse = await postMessages({ endpoint, credential, body: retryBody, fetchImpl, timeoutSignal: timeoutController.signal });
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
          if (!retryBodyJson) throw boundedError("malformed_response", "The AI provider returned a non-JSON response.");
          const retryStopError = stopReasonError(retryBodyJson);
          if (retryStopError) throw retryStopError;
          const retryText = extractBlocksText(retryBodyJson);
          if (!retryText) throw boundedError("malformed_response", "The AI provider returned an empty result.");
          return retryText;
        }

        throw boundedError(mapStatusToCode(response.status), `The AI provider request failed with status ${response.status}.`);
      }

      const bodyJson = await parseJsonBody(response);
      if (!bodyJson) throw boundedError("malformed_response", "The AI provider returned a non-JSON response.");
      const stopError = stopReasonError(bodyJson);
      if (stopError) throw stopError;
      const rawText = extractBlocksText(bodyJson);
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

  globalThis.SaySlateAnthropicClient = Object.freeze({ generate });
})();
