(() => {
  "use strict";

  const STORAGE_KEY = "sayslate-dictation-settings";
  const SCHEMA_VERSION = 1;
  const DEFAULT_ENDPOINT = "http://127.0.0.1:8178";
  const MIN_PREVIEW_MS = 1500;
  const MAX_PREVIEW_MS = 3000;
  const DEFAULT_PREVIEW_MS = 2000;

  const PROVIDERS = Object.freeze({
    BROWSER: "browser",
    LOCAL_WHISPER: "local-whisper"
  });
  const PROVIDER_VALUES = new Set(Object.values(PROVIDERS));

  const AVAILABILITY = Object.freeze({
    CHECKING: "checking",
    AVAILABLE: "available",
    UNAVAILABLE: "unavailable",
    UNAUTHORIZED: "unauthorized",
    ACTIVE: "active"
  });
  const AVAILABILITY_VALUES = new Set(Object.values(AVAILABILITY));

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

  function storageSet(key, value) {
    if (globalThis.chrome?.storage?.local) {
      return new Promise((resolve, reject) => {
        chrome.storage.local.set({ [key]: value }, () => {
          const error = chrome.runtime?.lastError;
          if (error) reject(new Error(error.message));
          else resolve();
        });
      });
    }

    try {
      globalThis.localStorage?.setItem(key, JSON.stringify(value));
    } catch {
      // Settings remain available for the current page if storage fails.
    }
    return Promise.resolve();
  }

  function clampPreviewMs(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return DEFAULT_PREVIEW_MS;
    return Math.min(MAX_PREVIEW_MS, Math.max(MIN_PREVIEW_MS, Math.round(number)));
  }

  function normalizeRaw(value = {}) {
    const provider = PROVIDER_VALUES.has(value?.provider) ? value.provider : PROVIDERS.BROWSER;
    const bearerToken = typeof value?.bearerToken === "string" ? value.bearerToken : "";
    return {
      provider,
      endpoint: DEFAULT_ENDPOINT,
      bearerToken,
      previewMs: clampPreviewMs(value?.previewMs ?? DEFAULT_PREVIEW_MS),
      schemaVersion: SCHEMA_VERSION
    };
  }

  function toSnapshot(raw) {
    return {
      provider: raw.provider,
      endpoint: raw.endpoint,
      previewMs: raw.previewMs,
      hasToken: Boolean(raw.bearerToken),
      schemaVersion: raw.schemaVersion
    };
  }

  let currentRaw = normalizeRaw();
  let availability = AVAILABILITY.CHECKING;
  let availabilityDetail = "";
  let active = false;
  const listeners = new Set();

  function getAvailability() {
    return { state: availability, detail: availabilityDetail };
  }

  function notify(type) {
    const detail = { type, settings: toSnapshot(currentRaw), availability: getAvailability(), active };
    for (const listener of listeners) {
      try {
        listener(detail);
      } catch {
        // A subscriber's failure must not break settings persistence for others.
      }
    }
  }

  async function load() {
    try {
      const stored = await storageGet(STORAGE_KEY);
      currentRaw = normalizeRaw(stored);
      if (!stored || stored.schemaVersion !== SCHEMA_VERSION) {
        await storageSet(STORAGE_KEY, currentRaw);
      }
    } catch {
      currentRaw = normalizeRaw();
    }
    notify("settings");
    return toSnapshot(currentRaw);
  }

  function ensureUnlocked() {
    if (active) throw new Error("Dictation is active. Stop dictation before changing provider settings.");
  }

  async function saveProvider(provider) {
    ensureUnlocked();
    if (!PROVIDER_VALUES.has(provider)) throw new Error("Unknown dictation provider.");
    const nextRaw = { ...currentRaw, provider, schemaVersion: SCHEMA_VERSION };
    await storageSet(STORAGE_KEY, nextRaw);
    currentRaw = nextRaw;
    notify("settings");
    return toSnapshot(currentRaw);
  }

  async function saveConfig({ previewMs, token } = {}) {
    ensureUnlocked();
    const nextRaw = {
      ...currentRaw,
      previewMs: clampPreviewMs(previewMs ?? currentRaw.previewMs),
      bearerToken: typeof token === "string" && token.length > 0 ? token : currentRaw.bearerToken,
      schemaVersion: SCHEMA_VERSION
    };
    await storageSet(STORAGE_KEY, nextRaw);
    currentRaw = nextRaw;
    notify("settings");
    return toSnapshot(currentRaw);
  }

  function getSnapshot() {
    return toSnapshot(currentRaw);
  }

  function setAvailability(state, detail = "") {
    if (!AVAILABILITY_VALUES.has(state)) throw new Error("Unknown dictation availability state.");
    availability = state;
    availabilityDetail = String(detail || "");
    notify("availability");
  }

  function setActive(isActive) {
    active = Boolean(isActive);
    notify("active");
  }

  function isActive() {
    return active;
  }

  function onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  globalThis.SaySlateDictationSettings = Object.freeze({
    PROVIDERS,
    AVAILABILITY,
    DEFAULT_ENDPOINT,
    MIN_PREVIEW_MS,
    MAX_PREVIEW_MS,
    DEFAULT_PREVIEW_MS,
    load,
    saveProvider,
    saveConfig,
    getSnapshot,
    setAvailability,
    getAvailability,
    setActive,
    isActive,
    onChange
  });
})();
