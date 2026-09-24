(() => {
  "use strict";

  // LD-022: the immutable canonical structured-result schema every adapter requests when
  // the provider/model supports schema enforcement, and validates before unwrapping to
  // the existing plain-string SaySlate boundary. Frozen so no consumer can mutate the one
  // shape every transport requests.
  const CANONICAL_RESULT_SCHEMA = Object.freeze({
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false
  });

  // LD-025: the dispatcher's bounded failure codes. STRUCTURED_OUTPUT_UNSUPPORTED stays
  // part of the bounded set (callers may still switch on it) but this implementation never
  // throws it for a schema-rejecting 400/422 response - LD-031 supersedes that trigger with
  // a single schema-free retry instead of an immediate failure, per LD-025's own evidence
  // note ("superseded in part by LD-031").
  const ERROR_CODES = Object.freeze({
    INVALID_CONFIGURATION: "invalid_configuration",
    AUTHENTICATION_FAILED: "authentication_failed",
    MODEL_UNAVAILABLE: "model_unavailable",
    STRUCTURED_OUTPUT_UNSUPPORTED: "structured_output_unsupported",
    MALFORMED_RESPONSE: "malformed_response",
    REQUEST_TIMEOUT: "request_timeout",
    NETWORK_ERROR: "network_error",
    PROVIDER_ERROR: "provider_error"
  });

  function boundedError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function registry() {
    if (!globalThis.SaySlateAIProviderRegistry) {
      throw new Error("SaySlateAIProviderRegistry must load before SaySlateAIProviderClient.");
    }
    return globalThis.SaySlateAIProviderRegistry;
  }

  function requireAdapter(name) {
    const adapter = globalThis[name];
    if (!adapter) throw new Error(`${name} must load before SaySlateAIProviderClient.`);
    return adapter;
  }

  // LD-025: the only renderer-facing generation contract. Resolves to a plain string or
  // rejects with a bounded-code Error; never a provider-native response object.
  async function generate({ profile, systemPrompt, userPrompt, fetchImpl, timeoutMs, signal } = {}) {
    if (!profile || typeof profile !== "object") {
      throw boundedError(ERROR_CODES.INVALID_CONFIGURATION, "A provider profile is required.");
    }

    const preset = registry().presetFor(profile.providerKind);
    if (!preset) {
      throw boundedError(ERROR_CODES.INVALID_CONFIGURATION, "The provider profile has an unrecognized providerKind.");
    }

    const endpoint = String(profile.endpoint || "").trim();
    const modelId = String(profile.modelId || "").trim();
    const credential = String(profile.credential || "").trim();
    if (!endpoint) {
      throw boundedError(ERROR_CODES.INVALID_CONFIGURATION, "The provider profile is missing an endpoint.");
    }
    if (!modelId) {
      throw boundedError(ERROR_CODES.INVALID_CONFIGURATION, "The provider profile is missing a model ID.");
    }

    // LD-035 (1): renderers pass one already-built prompt as userPrompt and omit
    // systemPrompt; every adapter omits its system field/message when it is empty.
    const normalizedSystemPrompt = String(systemPrompt || "").trim();
    const normalizedUserPrompt = String(userPrompt || "");

    const transportKinds = registry().TRANSPORT_KINDS;
    const adapterArgs = {
      endpoint,
      credential,
      modelId,
      systemPrompt: normalizedSystemPrompt,
      userPrompt: normalizedUserPrompt,
      schema: CANONICAL_RESULT_SCHEMA,
      fetchImpl,
      timeoutMs,
      signal
    };

    switch (preset.transportKind) {
      case transportKinds.GEMINI_NATIVE: {
        if (!credential) {
          throw boundedError(ERROR_CODES.INVALID_CONFIGURATION, "The Gemini provider profile is missing a credential.");
        }
        return requireAdapter("SaySlateAIClient").generateStructured(adapterArgs);
      }
      case transportKinds.OPENAI_CHAT_COMPLETIONS: {
        // EV-014: LM Studio/custom endpoints may run without authentication, so the
        // credential is not required here - the adapter omits Bearer auth when blank.
        // LD-041: custom (LM Studio) profiles ask for no reasoning pass (EV-035). OpenAI
        // profiles never send it: OpenAI rejects reasoning_effort on non-reasoning models.
        const reasoningEffort = profile.providerKind === registry().PROVIDER_KINDS.CUSTOM ? "none" : undefined;
        return requireAdapter("SaySlateOpenAICompatibleClient").generate({ ...adapterArgs, reasoningEffort });
      }
      case transportKinds.ANTHROPIC_MESSAGES: {
        if (!credential) {
          throw boundedError(ERROR_CODES.INVALID_CONFIGURATION, "The Anthropic provider profile is missing a credential.");
        }
        return requireAdapter("SaySlateAnthropicClient").generate(adapterArgs);
      }
      default:
        throw boundedError(ERROR_CODES.INVALID_CONFIGURATION, "The provider profile resolved to an unsupported transport.");
    }
  }

  globalThis.SaySlateAIProviderClient = Object.freeze({
    ERROR_CODES,
    CANONICAL_RESULT_SCHEMA,
    generate
  });
})();
