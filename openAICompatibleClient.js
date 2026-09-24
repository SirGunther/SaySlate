(() => {
  "use strict";

  // EV-020/EV-014: shared OpenAI-compatible /v1/chat/completions transport for OpenAI,
  // LM Studio, and any other custom endpoint the registry maps to this transport kind
  // (LD-024). No provider-specific branching lives here - every profile using this
  // transport is handled identically.
  const DEFAULT_TIMEOUT_MS = 90_000;
  const SCHEMA_NAME = "sayslate_result";

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

  function buildMessages(systemPrompt, userPrompt) {
    const messages = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: userPrompt });
    return messages;
  }

  async function parseJsonBody(response) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  function extractMessage(body) {
    const choice = Array.isArray(body?.choices) ? body.choices[0] : null;
    return choice?.message || null;
  }

  // LD-022: validates the canonical { text: string } result before unwrapping it.
  function validateCanonicalText(rawContent) {
    if (typeof rawContent !== "string") return null;
    let parsed;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || typeof parsed.text !== "string") return null;
    const trimmed = parsed.text.trim();
    return trimmed ? trimmed : null;
  }

  async function postChatCompletions({ endpoint, credential, body, fetchImpl, timeoutSignal }) {
    const doFetch = fetchImpl || fetch;
    // LD-035 (3): Authorization is sent only when the credential is non-empty, so an
    // unauthenticated LM Studio endpoint (EV-014) never sends a blank Bearer header.
    const headers = { "Content-Type": "application/json" };
    if (credential) headers.Authorization = `Bearer ${credential}`;
    return doFetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: timeoutSignal
    });
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
    signal,
    reasoningEffort
  }) {
    const timeoutController = new AbortController();
    const timeout = window.setTimeout(() => timeoutController.abort(), timeoutMs);
    const abortFromCaller = () => timeoutController.abort();
    signal?.addEventListener("abort", abortFromCaller, { once: true });

    try {
      const messages = buildMessages(systemPrompt, userPrompt);
      // LD-035 (3): json_schema strict output, no sampling or token-limit parameters.
      const schemaBody = {
        model: modelId,
        messages,
        response_format: {
          type: "json_schema",
          json_schema: { name: SCHEMA_NAME, strict: true, schema }
        }
      };
      // LD-041: sent only when the dispatcher asks for it, and only on this request; the
      // schema-free retry below stays the plain request for servers that reject the field.
      if (reasoningEffort) schemaBody.reasoning_effort = reasoningEffort;

      let response;
      try {
        response = await postChatCompletions({
          endpoint,
          credential,
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
          const retryBody = { model: modelId, messages };
          let retryResponse;
          try {
            retryResponse = await postChatCompletions({
              endpoint,
              credential,
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
          const retryMessage = extractMessage(retryBodyJson);
          if (retryMessage?.refusal) throw boundedError("provider_error", "The AI provider refused the request.");
          const retryText = typeof retryMessage?.content === "string" ? retryMessage.content.trim() : "";
          if (!retryText) throw boundedError("malformed_response", "The AI provider returned an empty result.");
          return retryText;
        }

        throw boundedError(mapStatusToCode(response.status), `The AI provider request failed with status ${response.status}.`);
      }

      const bodyJson = await parseJsonBody(response);
      if (!bodyJson) throw boundedError("malformed_response", "The AI provider returned a non-JSON response.");
      const message = extractMessage(bodyJson);
      if (message?.refusal) throw boundedError("provider_error", "The AI provider refused the request.");
      const text = validateCanonicalText(message?.content);
      if (!text) {
        throw boundedError("malformed_response", "The AI provider returned a result that did not match the expected schema.");
      }
      return text;
    } finally {
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  globalThis.SaySlateOpenAICompatibleClient = Object.freeze({ generate });
})();
