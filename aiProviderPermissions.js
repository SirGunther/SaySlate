(() => {
  "use strict";

  // LD-034: the only two operations this module exposes. Both resolve to LD-024's
  // { ok, code, originPattern } shape; neither throws and neither ever requests a
  // broader origin than the one the registry derives from the given endpoint.
  const PERMISSION_CODES = Object.freeze({
    ALREADY_GRANTED: "already_granted",
    GRANTED: "granted",
    PERMISSION_DENIED: "permission_denied",
    INVALID_CONFIGURATION: "invalid_configuration"
  });

  function registry() {
    if (!globalThis.SaySlateAIProviderRegistry) {
      throw new Error("SaySlateAIProviderRegistry must load before SaySlateAIProviderPermissions.");
    }
    return globalThis.SaySlateAIProviderRegistry;
  }

  function invalidConfigurationResult() {
    return { ok: false, code: PERMISSION_CODES.INVALID_CONFIGURATION, originPattern: null };
  }

  function deniedResult(originPattern) {
    return { ok: false, code: PERMISSION_CODES.PERMISSION_DENIED, originPattern };
  }

  function containsOrigin(originPattern) {
    if (!globalThis.chrome?.permissions?.contains) {
      return Promise.reject(new Error("chrome.permissions.contains is required to check AI provider origin access."));
    }
    return new Promise((resolve, reject) => {
      chrome.permissions.contains({ origins: [originPattern] }, (result) => {
        const error = chrome.runtime?.lastError;
        if (error) reject(new Error(error.message));
        else resolve(Boolean(result));
      });
    });
  }

  function requestOrigin(originPattern) {
    if (!globalThis.chrome?.permissions?.request) {
      return Promise.reject(new Error("chrome.permissions.request is required to grant AI provider origin access."));
    }
    return new Promise((resolve, reject) => {
      chrome.permissions.request({ origins: [originPattern] }, (result) => {
        const error = chrome.runtime?.lastError;
        if (error) reject(new Error(error.message));
        else resolve(Boolean(result));
      });
    });
  }

  // LD-034: read-only check. Never calls chrome.permissions.request, so loading,
  // migrating, switching, or merely displaying a profile never prompts the user.
  async function hasForEndpoint(endpoint) {
    const originPattern = registry().originPatternForEndpoint(endpoint);
    if (!originPattern) return invalidConfigurationResult();

    try {
      const granted = await containsOrigin(originPattern);
      return granted ? { ok: true, code: PERMISSION_CODES.ALREADY_GRANTED, originPattern } : deniedResult(originPattern);
    } catch {
      return deniedResult(originPattern);
    }
  }

  // LD-034: called only from a user-triggered Save or Test (SAYAI-04/SAYAI-05 call
  // boundary). Requests the exact origin only when chrome.permissions.contains reports
  // it is not already granted; a decline or a rejected request API call both resolve to
  // permission_denied rather than throwing or broadening the requested origin.
  async function ensureForEndpoint(endpoint) {
    const originPattern = registry().originPatternForEndpoint(endpoint);
    if (!originPattern) return invalidConfigurationResult();

    let alreadyGranted;
    try {
      alreadyGranted = await containsOrigin(originPattern);
    } catch {
      return deniedResult(originPattern);
    }
    if (alreadyGranted) return { ok: true, code: PERMISSION_CODES.ALREADY_GRANTED, originPattern };

    try {
      const granted = await requestOrigin(originPattern);
      return granted ? { ok: true, code: PERMISSION_CODES.GRANTED, originPattern } : deniedResult(originPattern);
    } catch {
      return deniedResult(originPattern);
    }
  }

  globalThis.SaySlateAIProviderPermissions = Object.freeze({
    PERMISSION_CODES,
    hasForEndpoint,
    ensureForEndpoint
  });
})();
