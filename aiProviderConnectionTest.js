(() => {
  "use strict";

  // LD-018/LD-026/LD-037: non-generative provider diagnostics. This module performs only
  // provider-specific model discovery (never a generation call), sends no user transcript
  // or prompt, and never returns a credential, raw provider response body, or unbounded
  // provider text in its result.
  const DEFAULT_TIMEOUT_MS = 15_000;
  const ANTHROPIC_VERSION = "2023-06-01";
  const ANTHROPIC_MAX_PAGES = 10;

  // LD-026: the fixed diagnostic codes. AVAILABLE is the only code whose ok is true.
  const CODES = Object.freeze({
    AVAILABLE: "available",
    INVALID_CONFIGURATION: "invalid_configuration",
    PERMISSION_DENIED: "permission_denied",
    NETWORK_ERROR: "network_error",
    AUTHENTICATION_FAILED: "authentication_failed",
    MODEL_UNAVAILABLE: "model_unavailable",
    PROVIDER_ERROR: "provider_error",
    MALFORMED_RESPONSE: "malformed_response",
    REQUEST_TIMEOUT: "request_timeout"
  });

  function registry() {
    if (!globalThis.SaySlateAIProviderRegistry) {
      throw new Error("SaySlateAIProviderRegistry must load before SaySlateAIProviderConnectionTest.");
    }
    return globalThis.SaySlateAIProviderRegistry;
  }

  function permissionsModule() {
    if (!globalThis.SaySlateAIProviderPermissions) {
      throw new Error("SaySlateAIProviderPermissions must load before SaySlateAIProviderConnectionTest.");
    }
    return globalThis.SaySlateAIProviderPermissions;
  }

  // LD-026: the fixed { ok, code, message, modelId } shape. message is always one of the
  // fixed strings below - never a raw provider body, credential, or unbounded text.
  function outcome(code, message, modelId) {
    return { ok: code === CODES.AVAILABLE, code, message, modelId: modelId || null };
  }

  async function parseJsonBody(response) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  // LD-036(2)/EV-034: Gemini reports an invalid API key as HTTP 400 INVALID_ARGUMENT with
  // a structured reason, not as 401/403.
  function isGeminiApiKeyInvalid(body) {
    const details = Array.isArray(body?.error?.details) ? body.error.details : [];
    return details.some((detail) => detail?.reason === "API_KEY_INVALID");
  }

  // Shared fetch wrapper: maps an aborted request to request_timeout and every other
  // fetch rejection to network_error, before any status/body interpretation runs.
  async function runFetch(fetchImpl, url, options, modelId) {
    const doFetch = fetchImpl || fetch;
    try {
      const response = await doFetch(url, options);
      return { response };
    } catch (error) {
      if (error?.name === "AbortError") {
        return { failure: outcome(CODES.REQUEST_TIMEOUT, "The connection test timed out.", modelId) };
      }
      return { failure: outcome(CODES.NETWORK_ERROR, "The connection test failed to reach the provider.", modelId) };
    }
  }

  // LD-037: Gemini exact-model retrieval - GET <endpoint>/models/<modelId>?key=<credential>.
  async function testGemini({ endpoint, modelId, credential, fetchImpl, signal }) {
    const url = `${endpoint}/models/${encodeURIComponent(modelId)}?key=${encodeURIComponent(credential)}`;
    const fetched = await runFetch(fetchImpl, url, { method: "GET", signal }, modelId);
    if (fetched.failure) return fetched.failure;
    const { response } = fetched;

    if (response.status === 404) {
      return outcome(CODES.MODEL_UNAVAILABLE, "The configured model was not found for this provider.", modelId);
    }
    if (response.status === 401 || response.status === 403) {
      return outcome(CODES.AUTHENTICATION_FAILED, "The provider rejected the configured credential.", modelId);
    }
    if (response.status === 400) {
      const body = await parseJsonBody(response);
      if (isGeminiApiKeyInvalid(body)) {
        return outcome(CODES.AUTHENTICATION_FAILED, "The provider rejected the configured credential.", modelId);
      }
      return outcome(CODES.PROVIDER_ERROR, `The provider request failed with status ${response.status}.`, modelId);
    }
    if (!response.ok) {
      return outcome(CODES.PROVIDER_ERROR, `The provider request failed with status ${response.status}.`, modelId);
    }

    const body = await parseJsonBody(response);
    if (!body || typeof body.name !== "string") {
      return outcome(CODES.MALFORMED_RESPONSE, "The provider response did not match the expected shape.", modelId);
    }
    if (body.name === `models/${modelId}`) {
      return outcome(CODES.AVAILABLE, "The configured model is available.", modelId);
    }
    return outcome(CODES.MALFORMED_RESPONSE, "The provider response did not match the expected shape.", modelId);
  }

  // LD-037: exact-ID match against an OpenAI-compatible model list - GET <endpoint>/models,
  // Authorization: Bearer only when the credential is non-empty (EV-014).
  async function testOpenAICompatible({ endpoint, modelId, credential, fetchImpl, signal }) {
    const headers = {};
    if (credential) headers.Authorization = `Bearer ${credential}`;
    const fetched = await runFetch(fetchImpl, `${endpoint}/models`, { method: "GET", headers, signal }, modelId);
    if (fetched.failure) return fetched.failure;
    const { response } = fetched;

    if (response.status === 401 || response.status === 403) {
      return outcome(CODES.AUTHENTICATION_FAILED, "The provider rejected the configured credential.", modelId);
    }
    if (!response.ok) {
      return outcome(CODES.PROVIDER_ERROR, `The provider request failed with status ${response.status}.`, modelId);
    }

    const body = await parseJsonBody(response);
    const list = Array.isArray(body?.data) ? body.data : null;
    if (!list) return outcome(CODES.MALFORMED_RESPONSE, "The provider response did not match the expected shape.", modelId);
    const found = list.some((item) => item?.id === modelId);
    return found
      ? outcome(CODES.AVAILABLE, "The configured model is available.", modelId)
      : outcome(CODES.MODEL_UNAVAILABLE, "The configured model was not found for this provider.", modelId);
  }

  function anthropicHeaders(credential) {
    // LD-035(2): the three headers SaySlate's Anthropic transport already uses for
    // browser-direct requests; no Content-Type is needed for this GET.
    return {
      "x-api-key": credential,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-dangerous-direct-browser-access": "true"
    };
  }

  // LD-037: exact-ID match against a paginated Anthropic model list - GET
  // <endpoint>/models?limit=1000, following after_id=<last_id> while has_more is true,
  // capped at 10 pages.
  async function testAnthropic({ endpoint, modelId, credential, fetchImpl, signal }) {
    let afterId = null;

    for (let page = 0; page < ANTHROPIC_MAX_PAGES; page += 1) {
      const url = new URL(`${endpoint}/models`);
      url.searchParams.set("limit", "1000");
      if (afterId) url.searchParams.set("after_id", afterId);

      const fetched = await runFetch(
        fetchImpl,
        url.toString(),
        { method: "GET", headers: anthropicHeaders(credential), signal },
        modelId
      );
      if (fetched.failure) return fetched.failure;
      const { response } = fetched;

      if (response.status === 401 || response.status === 403) {
        return outcome(CODES.AUTHENTICATION_FAILED, "The provider rejected the configured credential.", modelId);
      }
      if (!response.ok) {
        return outcome(CODES.PROVIDER_ERROR, `The provider request failed with status ${response.status}.`, modelId);
      }

      const body = await parseJsonBody(response);
      const list = Array.isArray(body?.data) ? body.data : null;
      if (!list) return outcome(CODES.MALFORMED_RESPONSE, "The provider response did not match the expected shape.", modelId);
      if (list.some((item) => item?.id === modelId)) {
        return outcome(CODES.AVAILABLE, "The configured model is available.", modelId);
      }
      if (!body.has_more) {
        return outcome(CODES.MODEL_UNAVAILABLE, "The configured model was not found for this provider.", modelId);
      }
      if (typeof body.last_id !== "string" || !body.last_id) {
        return outcome(CODES.MALFORMED_RESPONSE, "The provider response did not match the expected shape.", modelId);
      }
      afterId = body.last_id;
    }

    // The 10-page cap was reached without finding the model and without has_more
    // reporting false; treated the same as a valid list that never contained the ID.
    return outcome(CODES.MODEL_UNAVAILABLE, "The configured model was not found for this provider.", modelId);
  }

  // LD-026/LD-037: the only callable boundary. Runs LD-037's pre-network checks in
  // order - endpoint, model ID, credential (by providerKind), then permission - and only
  // performs a network request once every check has passed.
  async function test({ profile, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!profile || typeof profile !== "object") {
      return outcome(CODES.INVALID_CONFIGURATION, "A provider profile is required.", null);
    }

    const preset = registry().presetFor(profile.providerKind);
    if (!preset) {
      return outcome(CODES.INVALID_CONFIGURATION, "The provider profile has an unrecognized providerKind.", null);
    }

    const modelId = String(profile.modelId || "").trim();

    const normalized = registry().normalizeEndpoint(profile.endpoint);
    if (!normalized.ok) {
      return outcome(CODES.INVALID_CONFIGURATION, "The provider profile endpoint is invalid.", modelId || null);
    }

    if (!modelId) {
      return outcome(CODES.INVALID_CONFIGURATION, "The provider profile is missing a model ID.", null);
    }

    const credential = String(profile.credential || "").trim();
    const providerKinds = registry().PROVIDER_KINDS;
    if (profile.providerKind !== providerKinds.CUSTOM && !credential) {
      return outcome(CODES.INVALID_CONFIGURATION, "The provider profile is missing a credential.", modelId);
    }

    // LD-034/LD-037: a read-only permission check that never requests. Its
    // permission_denied or invalid_configuration code passes through unchanged.
    const permissionResult = await permissionsModule().hasForEndpoint(normalized.endpoint);
    if (!permissionResult.ok) {
      const message =
        permissionResult.code === CODES.INVALID_CONFIGURATION
          ? "The provider profile endpoint is invalid."
          : "Host permission for the configured endpoint is not granted.";
      return outcome(permissionResult.code, message, modelId);
    }

    const timeoutController = new AbortController();
    const timeout = window.setTimeout(() => timeoutController.abort(), timeoutMs);

    try {
      const args = { endpoint: normalized.endpoint, modelId, credential, fetchImpl, signal: timeoutController.signal };
      const transportKinds = registry().TRANSPORT_KINDS;
      switch (preset.transportKind) {
        case transportKinds.GEMINI_NATIVE:
          return await testGemini(args);
        case transportKinds.ANTHROPIC_MESSAGES:
          return await testAnthropic(args);
        case transportKinds.OPENAI_CHAT_COMPLETIONS:
          return await testOpenAICompatible(args);
        default:
          return outcome(CODES.INVALID_CONFIGURATION, "The provider profile resolved to an unsupported transport.", modelId);
      }
    } finally {
      window.clearTimeout(timeout);
    }
  }

  globalThis.SaySlateAIProviderConnectionTest = Object.freeze({ CODES, test });
})();
