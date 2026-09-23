(() => {
  "use strict";

  // LD-023: version-1 provider-profile record and public globalThis boundary.
  const STORAGE_KEY = "sayslate-ai-provider-profiles";
  // EV-002: the pre-existing combined Gemini record this module migrates away from.
  const LEGACY_CONFIG_KEY = "sayslate-grammar-config";
  const SCHEMA_VERSION = 1;
  // LD-024/LD-033: the Gemini preset base URL a migrated profile must carry.
  const GEMINI_PRESET_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";

  const CREDENTIAL_ACTIONS = Object.freeze({
    RETAIN: "retain",
    REPLACE: "replace",
    CLEAR: "clear"
  });
  const CREDENTIAL_ACTION_VALUES = new Set(Object.values(CREDENTIAL_ACTIONS));

  // F5: credentials must live only in chrome.storage.local. There is no other browser
  // storage fallback here - when the extension storage API is unavailable, every
  // operation rejects instead of silently persisting (and possibly losing, since it
  // swallowed write errors) a second, unauthorized credential store.
  function storageGet(key) {
    if (!globalThis.chrome?.storage?.local) {
      return Promise.reject(new Error("chrome.storage.local is required for AI provider profile storage."));
    }
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(key, (result) => {
        const error = chrome.runtime?.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result?.[key]);
      });
    });
  }

  // LD-030: the migration writes the new profile and rewrites the legacy record in one
  // chrome.storage.local.set call, so partial-write states never expose a copied credential.
  function storageSetEntries(entries) {
    if (!globalThis.chrome?.storage?.local) {
      return Promise.reject(new Error("chrome.storage.local is required for AI provider profile storage."));
    }
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(entries, () => {
        const error = chrome.runtime?.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
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

  function findProfile(state, id) {
    return state.profiles.find((profile) => profile.id === id) || null;
  }

  let loaded = false;

  function ensureLoaded() {
    if (!loaded) throw new Error("Call load() before reading or changing AI provider profiles.");
  }

  // F4: this is the single read path every mutator uses immediately before it computes
  // its write. Nothing here is served from a module-level cache, so a second module
  // instance (a second open SaySlate tab/page - background.js opens a new tab per
  // action click) can never overwrite profiles or the active selection that a
  // concurrently-running instance already persisted, because every mutation starts
  // from what is actually in storage right now, not from what this instance last saw.
  // An absent record is a legitimate "nothing persisted yet" state (first run, or a
  // mutation racing ahead of load()'s own first write) and resolves to the default
  // state rather than being treated as malformed; an unsupported/malformed *present*
  // record still rejects without writing, per LD-023.
  async function fetchValidatedState() {
    const stored = await storageGet(STORAGE_KEY);
    if (stored === undefined) return defaultState();
    if (!isValidState(stored)) {
      throw new Error("Stored AI provider profile data is an unsupported or malformed version.");
    }
    return stored;
  }

  async function persistState(nextState) {
    await storageSetEntries({ [STORAGE_KEY]: nextState });
    return nextState;
  }

  async function load() {
    const stored = await storageGet(STORAGE_KEY);
    let state;
    if (stored === undefined) {
      state = await persistState(defaultState());
    } else if (!isValidState(stored)) {
      throw new Error("Stored AI provider profile data is an unsupported or malformed version.");
    } else {
      state = stored;
    }
    loaded = true;
    return cloneState(state);
  }

  // LD-023: create-or-update. F3: the credential action is never inferred - a missing
  // or unknown action, or a `replace` with a blank credential, is rejected before any
  // read-for-write or storage.set happens, so a blank field can never implicitly erase
  // a saved key. Only `clear` (directly, or via clearCredential) blanks a credential.
  async function upsertProfile({ id, name, providerKind, endpoint, modelId, credential, credentialAction } = {}) {
    ensureLoaded();

    if (!CREDENTIAL_ACTION_VALUES.has(credentialAction)) {
      throw new Error("upsertProfile requires an explicit credentialAction of retain, replace, or clear.");
    }

    let resolvedCredential;
    if (credentialAction === CREDENTIAL_ACTIONS.CLEAR) {
      resolvedCredential = "";
    } else if (credentialAction === CREDENTIAL_ACTIONS.REPLACE) {
      resolvedCredential = String(credential ?? "").trim();
      if (!resolvedCredential) {
        throw new Error("A replace credential action requires a non-empty credential.");
      }
    }
    // RETAIN resolves below, once the existing stored credential (if any) is known.

    const state = await fetchValidatedState();
    const existing = id ? findProfile(state, id) : null;

    if (credentialAction === CREDENTIAL_ACTIONS.RETAIN) {
      resolvedCredential = existing ? existing.credential : "";
    }

    const resolvedId = existing ? existing.id : generateId();
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
      ? state.profiles.map((profile) => (profile.id === resolvedId ? nextProfile : profile))
      : [...state.profiles, nextProfile];

    await persistState({
      version: SCHEMA_VERSION,
      activeProfileId: state.activeProfileId,
      profiles: nextProfiles
    });

    return cloneProfile(nextProfile);
  }

  async function activateProfile(id) {
    ensureLoaded();
    const state = await fetchValidatedState();
    if (!findProfile(state, id)) throw new Error("Cannot activate an unknown provider profile.");

    const nextState = { version: SCHEMA_VERSION, activeProfileId: id, profiles: state.profiles };
    await persistState(nextState);
    return cloneState(nextState);
  }

  // LD-023: deleting the active profile leaves no active profile rather than reassigning one.
  async function deleteProfile(id) {
    ensureLoaded();
    const state = await fetchValidatedState();
    const nextProfiles = state.profiles.filter((profile) => profile.id !== id);
    const nextActiveProfileId = state.activeProfileId === id ? null : state.activeProfileId;

    const nextState = { version: SCHEMA_VERSION, activeProfileId: nextActiveProfileId, profiles: nextProfiles };
    await persistState(nextState);
    return cloneState(nextState);
  }

  async function clearCredential(id) {
    ensureLoaded();
    const state = await fetchValidatedState();
    if (!findProfile(state, id)) throw new Error("Cannot clear the credential of an unknown provider profile.");
    return upsertProfile({ id, credentialAction: CREDENTIAL_ACTIONS.CLEAR });
  }

  // LD-030/LD-033: move (not copy) the legacy Gemini key/model into one profile carrying
  // the Gemini preset endpoint, in the same write that strips them from the legacy
  // record - so an already-migrated legacy record (neither field present) is itself the
  // idempotency signal, and a deleted/credential-cleared migrated profile is never
  // recreated by running this again. When no profile is active, the migrated profile
  // becomes active in that same write; an existing active selection is left alone.
  async function migrateLegacyConfig() {
    ensureLoaded();

    const legacy = await storageGet(LEGACY_CONFIG_KEY);
    const legacyApiKey = String(legacy?.apiKey || "").trim();
    const legacyModel = String(legacy?.model || "").trim();
    if (!legacyApiKey && !legacyModel) return null;

    const state = await fetchValidatedState();

    const newProfile = {
      id: generateId(),
      name: "Gemini",
      providerKind: "gemini",
      endpoint: GEMINI_PRESET_ENDPOINT,
      modelId: legacyModel,
      credential: legacyApiKey
    };

    const nextState = {
      version: SCHEMA_VERSION,
      activeProfileId: state.activeProfileId || newProfile.id,
      profiles: [...state.profiles, newProfile]
    };

    const nextLegacy = { ...legacy };
    delete nextLegacy.apiKey;
    delete nextLegacy.model;

    await storageSetEntries({ [STORAGE_KEY]: nextState, [LEGACY_CONFIG_KEY]: nextLegacy });

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
