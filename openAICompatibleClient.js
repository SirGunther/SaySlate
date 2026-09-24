(() => {
  "use strict";

  // EV-020/EV-014: shared OpenAI-compatible /v1/chat/completions transport for OpenAI,
  // LM Studio, and any other custom endpoint the registry maps to this transport kind
  // (LD-024). No provider-specific branching lives here - every profile using this
  // transport is handled identically.
  // SAYREASON-01A: for a non-streamed request (`stream` false/omitted) this bounds the
  // request's total time. For a streamed Custom (LM Studio) request (`stream: true`) the
  // abort timer restarts when `fetch` resolves and on every body chunk read (LD-007), so
  // this instead bounds the time with nothing received - a long but steadily-arriving
  // response (reasoning or otherwise, EV-025/EV-029) is never aborted mid-stream.
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

  // SAYREASON-01A: true when `response` answered as a server-sent-event stream rather
  // than a single JSON body (LM Studio's shape for `stream: true`, EV-028).
  function isEventStream(response) {
    const contentType = typeof response.headers?.get === "function" ? response.headers.get("content-type") : null;
    return typeof contentType === "string" && contentType.includes("text/event-stream");
  }

  // SAYREASON-01A: reads LM Studio's SSE body (`data: {...}` lines, `data: [DONE]` end)
  // through the streams reader, restarting the silence timer on every chunk so a request
  // only times out when nothing arrives for `timeoutMs` (LD-007). Concatenates
  // `choices[0].delta.content` only - `delta.reasoning_content` and every other field are
  // ignored - then validates the result exactly as the non-streamed JSON path does.
  async function readEventStream(response, restartTimeout) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let contentText = "";
    let finished = false;

    while (!finished) {
      let step;
      try {
        step = await reader.read();
      } catch (error) {
        if (error?.name === "AbortError") throw boundedError("request_timeout", "The AI request timed out.");
        throw boundedError("network_error", "The AI request failed to reach the provider.");
      }
      restartTimeout();
      if (step.done) break;

      buffer += decoder.decode(step.value, { stream: true });
      let newlineIndex;
      while (!finished && (newlineIndex = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line.startsWith("data:")) continue;

        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          finished = true;
          break;
        }

        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          throw boundedError("malformed_response", "The AI provider returned a non-JSON response.");
        }

        if (parsed?.error) throw boundedError("provider_error", "The AI provider returned an error while streaming the response.");
        const delta = Array.isArray(parsed?.choices) ? parsed.choices[0]?.delta : null;
        if (delta?.refusal) throw boundedError("provider_error", "The AI provider refused the request.");
        if (typeof delta?.content === "string") contentText += delta.content;
      }
    }

    const text = validateCanonicalText(contentText);
    if (!text) {
      throw boundedError("malformed_response", "The AI provider returned a result that did not match the expected schema.");
    }
    return text;
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
    reasoningEffort,
    stream = false
  }) {
    const timeoutController = new AbortController();
    let timeout = window.setTimeout(() => timeoutController.abort(), timeoutMs);
    // SAYREASON-01A: only a streamed request restarts the silence timer (fetch resolving,
    // then each body chunk read); a non-streamed request keeps its single total-time timer,
    // exactly as before.
    const restartTimeout = () => {
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => timeoutController.abort(), timeoutMs);
    };
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
      if (stream) schemaBody.stream = true;

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

      if (stream) restartTimeout();

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

      // SAYREASON-01A: a streamed request whose server actually answered SSE reads the
      // stream; one that answered plain JSON anyway (server ignored `stream`) falls
      // through to the existing JSON path below, unchanged.
      if (stream && isEventStream(response)) {
        return await readEventStream(response, restartTimeout);
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
