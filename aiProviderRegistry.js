(() => {
  "use strict";

  // LD-024: the exact provider kinds, transport kinds, and preset defaults every
  // transport/permission/UI ticket consumes. This module is a side-effect-free global -
  // it reads no storage and touches no chrome API.
  const PROVIDER_KINDS = Object.freeze({
    GEMINI: "gemini",
    OPENAI: "openai",
    ANTHROPIC: "anthropic",
    CUSTOM: "custom"
  });

  // LD-015: Gemini keeps its native adapter. Custom/LM Studio endpoints map to the
  // OpenAI-compatible transport (EV-014) instead of inventing a fourth wire format.
  const TRANSPORT_KINDS = Object.freeze({
    GEMINI_NATIVE: "gemini-native",
    OPENAI_CHAT_COMPLETIONS: "openai-chat-completions",
    ANTHROPIC_MESSAGES: "anthropic-messages"
  });

  // LD-024: Gemini uses exact-model retrieval; OpenAI-compatible and Anthropic transports
  // match an exact model ID in their list response. SAYAI-04 performs the actual request;
  // this registry only names which strategy each provider kind uses.
  const DISCOVERY_STRATEGIES = Object.freeze({
    GEMINI_EXACT_MODEL_RETRIEVAL: "gemini-exact-model-retrieval",
    EXACT_ID_MODEL_LIST_MATCH: "exact-id-model-list-match"
  });

  // Preset base URLs are editable starting values, not fixed endpoints (LD-017, LD-024).
  // No credential field lives here - the registry never stores or sees a credential.
  const PRESETS = Object.freeze({
    [PROVIDER_KINDS.GEMINI]: Object.freeze({
      providerKind: PROVIDER_KINDS.GEMINI,
      transportKind: TRANSPORT_KINDS.GEMINI_NATIVE,
      defaultEndpoint: "https://generativelanguage.googleapis.com/v1beta",
      discoveryStrategy: DISCOVERY_STRATEGIES.GEMINI_EXACT_MODEL_RETRIEVAL
    }),
    [PROVIDER_KINDS.OPENAI]: Object.freeze({
      providerKind: PROVIDER_KINDS.OPENAI,
      transportKind: TRANSPORT_KINDS.OPENAI_CHAT_COMPLETIONS,
      defaultEndpoint: "https://api.openai.com/v1",
      discoveryStrategy: DISCOVERY_STRATEGIES.EXACT_ID_MODEL_LIST_MATCH
    }),
    [PROVIDER_KINDS.ANTHROPIC]: Object.freeze({
      providerKind: PROVIDER_KINDS.ANTHROPIC,
      transportKind: TRANSPORT_KINDS.ANTHROPIC_MESSAGES,
      defaultEndpoint: "https://api.anthropic.com/v1",
      discoveryStrategy: DISCOVERY_STRATEGIES.EXACT_ID_MODEL_LIST_MATCH
    }),
    [PROVIDER_KINDS.CUSTOM]: Object.freeze({
      providerKind: PROVIDER_KINDS.CUSTOM,
      transportKind: TRANSPORT_KINDS.OPENAI_CHAT_COMPLETIONS,
      defaultEndpoint: "",
      discoveryStrategy: DISCOVERY_STRATEGIES.EXACT_ID_MODEL_LIST_MATCH
    })
  });

  function presetFor(providerKind) {
    return PRESETS[providerKind] || null;
  }

  // LD-024: accepts only an absolute HTTPS URL, strips one trailing slash, and rejects
  // embedded credentials, query strings, fragments, non-HTTPS schemes, and invalid
  // origins (unparsable input, or a missing hostname). Never accepts anything this list
  // rejects - there is no lenient fallback path.
  function normalizeEndpoint(rawEndpoint) {
    const invalid = Object.freeze({ ok: false, code: "invalid_configuration", endpoint: null });
    const value = typeof rawEndpoint === "string" ? rawEndpoint.trim() : "";
    if (!value) return invalid;

    let url;
    try {
      url = new URL(value);
    } catch {
      return invalid;
    }

    if (url.protocol !== "https:") return invalid;
    if (url.username || url.password) return invalid;
    if (url.search) return invalid;
    if (url.hash) return invalid;
    if (!url.hostname) return invalid;

    let pathname = url.pathname || "/";
    if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);

    const normalizedEndpoint = pathname === "/" ? url.origin : `${url.origin}${pathname}`;
    return { ok: true, code: "ok", endpoint: normalizedEndpoint };
  }

  // EV-023: the extension requests only this exact origin pattern at runtime - never a
  // broader wildcard host - so the derived pattern always matches the normalized origin.
  function originPatternForEndpoint(rawEndpoint) {
    const normalized = normalizeEndpoint(rawEndpoint);
    if (!normalized.ok) return null;
    return `${new URL(normalized.endpoint).origin}/*`;
  }

  globalThis.SaySlateAIProviderRegistry = Object.freeze({
    PROVIDER_KINDS,
    TRANSPORT_KINDS,
    DISCOVERY_STRATEGIES,
    presetFor,
    normalizeEndpoint,
    originPatternForEndpoint
  });
})();
