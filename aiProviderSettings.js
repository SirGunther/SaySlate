(() => {
  "use strict";

  // LD-023: version-1 provider-profile record and public globalThis boundary.
  const STORAGE_KEY = "sayslate-ai-provider-profiles";
  // EV-002: the pre-existing combined Gemini record this module migrates away from.
  const LEGACY_CONFIG_KEY = "sayslate-grammar-config";
  const SCHEMA_VERSION = 1;

  const CREDENTIAL_ACTIONS = Object.freeze({
    RETAIN: "retain",
    REPLACE: "replace",
    CLEAR: "clear"
  });
  const CREDENTIAL_ACTION_VALUES = new Set(Object.values(CREDENTIAL_ACTIONS));

  function storageGet(key) {
    if (globalThis.chrome?.storage?.local) {
      return new Promise((resolve, reject) => {
        chrome.storage.local.get(key, (result) => {
          const error = chrome.runtime?.lastError;
          if (error) reject(new Error(error.message));
          else resolve(result?.[key]);
        });
      });
    }

    try {
      const value = globalThis.localStorage?.getItem(key);
      return Promise.resolve(value ? JSON.parse(value) : undefined);
    } catch {
      return Promise.resolve(undefined);
    }
  }

  // LD-030: the migration writes the new profile and rewrites the legacy record in one
  // chrome.storage.local.set call, so partial-write states never expose a copied credential.
  function storageSetEntries(entries) {
    if (globalThis.chrome?.storage?.local) {
      return new Promise((resolve, reject) => {
        chrome.storage.local.set(entries, () => {
          const error = chrome.runtime?.lastError;
          if (error) reject(new Error(error.message));
          else resolve();
        });
      });
    }

    try {
      for (const [key, value] of Object.entries(entries)) {
        globalThis.localStorage?.setItem(key, JSON.stringify(value));
      }
    } catch {
      // Best-effort persistence outside the extension storage context.
    }
    return Promise.resolve();
  }

  function generateId() {
    return globalThis.crypto?.randomUUID?.() || `profile-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function cloneProfile(profile) {
    return {
      id: profile.id,
      name: profile.name,
      providerKind: profile.providerKind,
      endpoint: profile.endpoint,
      modelId: profile.modelId,
      credential: profile.credential
    };
  }

  function cloneState(state) {
    return {
      version: state.version,
      activeProfileId: state.activeProfileId,
      profiles: state.profiles.map(cloneProfile)
    };
  }

  function isValidProfile(value) {
    return Boolean(
      value &&
      typeof value === "object" &&
      typeof value.id === "string" && value.id &&
      typeof value.name === "string" &&
      typeof value.providerKind === "string" && value.providerKind &&
      typeof value.endpoint === "string" &&
      typeof value.modelId === "string" &&
      typeof value.credential === "string"
    );
  }

  function isValidState(value) {
    return Boolean(
      value &&
      typeof value === "object" &&
      value.version === SCHEMA_VERSION &&
      (value.activeProfileId === null || typeof value.activeProfileId === "string") &&
      Array.isArray(value.profiles) &&
      value.profiles.every(isValidProfile)
    );
  }

  function defaultState() {
    return { version: SCHEMA_VERSION, activeProfileId: null, profiles: [] };
  }

  let currentState = defaultState();
  let loaded = false;

  async function persistState(nextState) {
    await storageSetEntries({ [STORAGE_KEY]: nextState });
    currentState = nextState;
  }

  // LD-023: an unsupported or malformed stored version must fail without overwriting
  // storage - only an absent record (first run) is initialized and persisted here.
  async function load() {
    const stored = await storageGet(STORAGE_KEY);
    if (stored === undefined) {
      await persistState(defaultState());
      loaded = true;
      return cloneState(currentState);
    }

    if (!isValidState(stored)) {
      throw new Error("Stored AI provider profile data is an unsupported or malformed version.");
    }

    currentState = stored;
    loaded = true;
    return cloneState(currentState);
  }

  function ensureLoaded() {
    if (!loaded) throw new Error("Call load() before reading or changing AI provider profiles.");
  }

  function findProfile(id) {
    return currentState.profiles.find((profile) => profile.id === id) || null;
  }

  // LD-023: create-or-update with explicit retain/replace/clear credential actions so a
  // blank field never implicitly deletes a saved credential (REQ-003).
  async function upsertProfile({ id, name, providerKind, endpoint, modelId, credential, credentialAction } = {}) {
    ensureLoaded();

    const action = CREDENTIAL_ACTION_VALUES.has(credentialAction) ? credentialAction : CREDENTIAL_ACTIONS.REPLACE;
    const existing = id ? findProfile(id) : null;
    const resolvedId = existing ? existing.id : generateId();

    let resolvedCredential;
    if (action === CREDENTIAL_ACTIONS.CLEAR) resolvedCredential = "";
    else if (action === CREDENTIAL_ACTIONS.RETAIN) resolvedCredential = existing ? existing.credential : "";
    else resolvedCredential = String(credential ?? "").trim();

    const nextProfile = {
      id: resolvedId,
      name: String(name ?? existing?.name ?? "").trim(),
      providerKind: String(providerKind ?? existing?.providerKind ?? "").trim(),
      endpoint: String(endpoint ?? existing?.endpoint ?? "").trim(),
      modelId: String(modelId ?? existing?.modelId ?? "").trim(),
      credential: resolvedCredential
    };

    if (!nextProfile.providerKind) throw new Error("A provider profile requires a providerKind.");

    const nextProfiles = existing
      ? currentState.profiles.map((profile) => (profile.id === resolvedId ? nextProfile : profile))
      : [...currentState.profiles, nextProfile];

    await persistState({
      version: SCHEMA_VERSION,
      activeProfileId: currentState.activeProfileId,
      profiles: nextProfiles
    });

    return cloneProfile(nextProfile);
  }

  async function activateProfile(id) {
    ensureLoaded();
    if (!findProfile(id)) throw new Error("Cannot activate an unknown provider profile.");

    await persistState({
      version: SCHEMA_VERSION,
      activeProfileId: id,
      profiles: currentState.profiles
    });

    return cloneState(currentState);
  }

  // LD-023: deleting the active profile leaves no active profile rather than reassigning one.
  async function deleteProfile(id) {
    ensureLoaded();
    const nextProfiles = currentState.profiles.filter((profile) => profile.id !== id);
    const nextActiveProfileId = currentState.activeProfileId === id ? null : currentState.activeProfileId;

    await persistState({
      version: SCHEMA_VERSION,
      activeProfileId: nextActiveProfileId,
      profiles: nextProfiles
    });

    return cloneState(currentState);
  }

  async function clearCredential(id) {
    ensureLoaded();
    if (!findProfile(id)) throw new Error("Cannot clear the credential of an unknown provider profile.");
    return upsertProfile({ id, credentialAction: CREDENTIAL_ACTIONS.CLEAR });
  }

  // LD-030: move (not copy) the legacy Gemini key/model into one profile, in the same write
  // that strips them from the legacy record - so an already-migrated legacy record (neither
  // field present) is itself the idempotency signal, and a deleted/credential-cleared
  // migrated profile is never recreated by running this again.
  async function migrateLegacyConfig() {
    ensureLoaded();

    const legacy = await storageGet(LEGACY_CONFIG_KEY);
    const legacyApiKey = String(legacy?.apiKey || "").trim();
    const legacyModel = String(legacy?.model || "").trim();
    if (!legacyApiKey && !legacyModel) return null;

    const newProfile = {
      id: generateId(),
      name: "Gemini",
      providerKind: "gemini",
      endpoint: "",
      modelId: legacyModel,
      credential: legacyApiKey
    };

    const nextState = {
      version: SCHEMA_VERSION,
      activeProfileId: currentState.activeProfileId,
      profiles: [...currentState.profiles, newProfile]
    };

    const nextLegacy = { ...legacy };
    delete nextLegacy.apiKey;
    delete nextLegacy.model;

    await storageSetEntries({ [STORAGE_KEY]: nextState, [LEGACY_CONFIG_KEY]: nextLegacy });
    currentState = nextState;

    return cloneProfile(newProfile);
  }

  globalThis.SaySlateAIProviderSettings = Object.freeze({
    CREDENTIAL_ACTIONS,
    load,
    upsertProfile,
    activateProfile,
    deleteProfile,
    clearCredential,
    migrateLegacyConfig
  });
})();
