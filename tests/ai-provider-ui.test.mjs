// SAYAI-05: drives app.js's real LD-027 provider-management UI (Save/Activate, Test
// Connection, Clear Credential, Delete) through the same real LD-023-LD-026 provider
// modules app.html now loads, with realistic DOM/storage/fetch/permissions fakes - not a
// mocked SaySlateAIClient.generate call. This is the production seam SAYAI-05 owns: the
// exact click/submit handlers wired to the real dispatcher and connection-test modules.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(extensionRoot, file), "utf8");

const appSource = read("app.js");
const aiProviderRegistrySource = read("aiProviderRegistry.js");
const aiProviderPermissionsSource = read("aiProviderPermissions.js");
const aiProviderSettingsSource = read("aiProviderSettings.js");
const aiProviderClientSource = read("aiProviderClient.js");
const aiProviderConnectionTestSource = read("aiProviderConnectionTest.js");
const openAICompatibleClientSource = read("openAICompatibleClient.js");

const ELEMENT_IDS = [
  "transcript", "startButton", "startButtonLabel", "finishWorkflowButton", "finishWorkflowLabel",
  "copyButton", "clearButton", "copyLabel", "wordCount", "statusPill", "statusText", "listeningMeter",
  "notice", "toast", "toastMessage", "themeToggle", "apiSettingsToggle", "apiSettings",
  "closeApiSettingsButton", "apiSettingsForm", "promptToggle", "promptSettings",
  "closePromptSettingsButton", "promptSettingsForm", "promptStatusDot", "apiKeyInput",
  "revealKeyButton", "modelInput", "firstPassPromptInput", "secondPassPromptInput",
  "secondPassEnabledInput", "secondPassToggleState", "promptConfigurationStatus",
  "apiSettingsError", "promptSettingsError", "configurationStatus", "apiStatusDot",
  "firstPassButton", "firstPassLabel", "resultSection", "resultTranscript", "resultMeta",
  "secondPassButton", "secondPassLabel", "copyResultButton", "discardResultButton",
  "profileSelect", "providerKindGemini", "providerKindOpenAI", "providerKindAnthropic",
  "providerKindCustom", "endpointInput", "connectionTestStatus", "connectionTestStatusText",
  "testConnectionButton", "clearCredentialButton", "deleteProfileButton"
];

function createElement(id) {
  const listeners = {};
  const el = {
    id,
    dataset: {},
    classList: {
      _set: new Set(),
      toggle(name, force) {
        const shouldHave = force === undefined ? !this._set.has(name) : Boolean(force);
        if (shouldHave) this._set.add(name);
        else this._set.delete(name);
      },
      add(name) { this._set.add(name); },
      remove(name) { this._set.delete(name); },
      contains(name) { return this._set.has(name); }
    },
    disabled: false,
    hidden: false,
    readOnly: false,
    value: "",
    textContent: "",
    className: "",
    checked: false,
    type: "text",
    content: "",
    innerHTML: "",
    scrollTop: 0,
    scrollHeight: 0,
    childIds: [],
    addEventListener(type, handler) {
      (listeners[type] ||= []).push(handler);
    },
    setAttribute(name, value) {
      this[`attr_${name}`] = String(value);
    },
    contains(other) {
      return other === this || this.childIds.includes(other?.id);
    },
    focus() {},
    select() {},
    scrollIntoView() {},
    dispatch(type, event = {}) {
      for (const handler of (listeners[type] || [])) handler(event);
    }
  };
  return el;
}

function buildFakeDom() {
  const registry = new Map();
  const documentListeners = {};
  const elements = {};

  for (const id of ELEMENT_IDS) {
    const el = createElement(id);
    registry.set(`#${id}`, el);
    elements[id] = el;
  }
  registry.set('meta[name="theme-color"]', createElement("themeColorMeta"));

  elements.apiSettings.hidden = true;
  elements.promptSettings.hidden = true;
  elements.notice.hidden = true;
  elements.resultSection.hidden = true;
  elements.toast.hidden = true;
  elements.connectionTestStatus.hidden = true;
  elements.providerKindGemini.checked = true;

  const documentElement = { dataset: {} };
  const document = {
    documentElement,
    querySelector(selector) {
      return registry.get(selector) || null;
    },
    execCommand() { return true; },
    addEventListener(type, handler) {
      (documentListeners[type] ||= []).push(handler);
    },
    dispatch(type, event = {}) {
      for (const handler of (documentListeners[type] || [])) handler(event);
    }
  };

  return { document, elements };
}

// Shared, mutable backing store so a "reload" (a second app.js instance built with the
// same chrome handle) observes exactly what the first instance persisted - proving the
// real storage boundary, not two independent in-memory fakes.
function createFakeChrome(localStore = {}) {
  const permissionRequests = [];
  return {
    __localStore: localStore,
    storage: {
      local: {
        get(key, callback) { callback({ [key]: localStore[key] }); },
        set(entries, callback) { Object.assign(localStore, entries); callback(); }
      }
    },
    permissions: {
      contains(_query, callback) { callback(true); },
      request(query, callback) { permissionRequests.push(query); callback(true); }
    },
    __permissionRequests: permissionRequests,
    runtime: { lastError: null, onMessage: { addListener() {} } }
  };
}

// A minimal, deterministic fetch fake covering exactly the two discovery/generation shapes
// this file exercises: Gemini exact-model retrieval/generateContent, and an OpenAI-
// compatible model list/chat-completion (the custom/LM-Studio transport, LD-024).
function createFakeFetch({ geminiModelId, geminiKey, customModelId } = {}) {
  const calls = [];
  async function fetchImpl(url, options = {}) {
    calls.push({ url: String(url), options });
    const parsed = new URL(String(url));

    if (parsed.pathname.endsWith(":generateContent")) {
      // Gemini generation (structured JSON per LD-022).
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ text: "gemini pass result" }) }] } }]
        })
      };
    }

    if (parsed.pathname.endsWith("/chat/completions")) {
      // OpenAI-compatible generation (structured JSON per LD-022).
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ text: "custom pass result" }) } }]
        })
      };
    }

    if (parsed.pathname.endsWith("/models")) {
      // OpenAI-compatible model list (exact-ID match, LD-037).
      return { ok: true, status: 200, json: async () => ({ data: [{ id: customModelId }] }) };
    }

    if (parsed.pathname.includes("/models/")) {
      // Gemini exact-model retrieval (LD-037).
      const key = parsed.searchParams.get("key");
      if (key !== geminiKey) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: { details: [{ reason: "API_KEY_INVALID" }] } })
        };
      }
      return { ok: true, status: 200, json: async () => ({ name: `models/${geminiModelId}` }) };
    }

    throw new Error(`Unhandled fake fetch URL: ${url}`);
  }
  fetchImpl.__calls = calls;
  return fetchImpl;
}

// Module-level (not per-instance) so ids stay unique across the separate buildInstance()
// calls that simulate reopening/reloading the page against the same shared storage.
let sharedUuidCounter = 0;

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function buildInstance({ localStore = {}, fetchImpl } = {}) {
  const { document, elements } = buildFakeDom();
  const chrome = createFakeChrome(localStore);
  const animations = {
    showToast() {},
    showPanel(panel) { panel.hidden = false; return Promise.resolve(); },
    hidePanel(panel) { panel.hidden = true; return Promise.resolve(); },
    transitionTheme(fn) { fn(); return Promise.resolve(); }
  };
  const localStorage = {
    getItem() { return null; },
    setItem() {},
    removeItem() {}
  };
  const windowStub = {
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (...args) => clearTimeout(...args),
    requestAnimationFrame(cb) { cb(); },
    addEventListener(type, handler) { (windowStub.__listeners[type] ||= []).push(handler); },
    __listeners: {}
  };
  const speech = {
    create() { return { start() { return true; }, stop() { return Promise.resolve(); }, cancel() {} }; },
    isSupported() { return true; }
  };

  const context = vm.createContext({
    chrome,
    console,
    Error,
    Map,
    Set,
    Promise,
    URL,
    AbortController,
    JSON,
    document,
    window: windowStub,
    localStorage,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    crypto: { randomUUID: () => `uuid-${sharedUuidCounter += 1}` },
    fetch: fetchImpl || (async () => { throw new Error("fetch was not expected in this scenario"); }),
    SaySlateAnimations: animations,
    SaySlateSpeech: speech,
    // The gemini-native adapter (aiClient.js) is exercised for real through
    // aiProviderClient.js's dispatcher; only the transport's own fetch is faked, so this
    // proves the actual generateStructured/schema/error-mapping path, not a stand-in.
    SaySlateAIClient: (() => {
      const src = read("aiClient.js");
      const sandbox = { fetch: fetchImpl, window: windowStub, console, URL, AbortController, JSON };
      vm.runInNewContext(src, sandbox);
      return sandbox.SaySlateAIClient;
    })()
  });

  vm.runInContext(aiProviderRegistrySource, context);
  vm.runInContext(aiProviderPermissionsSource, context);
  vm.runInContext(aiProviderSettingsSource, context);
  vm.runInContext(openAICompatibleClientSource, context);
  vm.runInContext(aiProviderClientSource, context);
  vm.runInContext(aiProviderConnectionTestSource, context);
  vm.runInContext(appSource, context);

  return { context, document, elements, chrome, windowStub };
}

const GEMINI_KEY = "fake-gemini-key";
const GEMINI_MODEL = "gemini-3.1-flash-lite";
const CUSTOM_ENDPOINT = "https://lmstudio.example-tailnet.ts.net/v1";
const CUSTOM_MODEL = "local-model";

const fetchImpl = createFakeFetch({ geminiModelId: GEMINI_MODEL, geminiKey: GEMINI_KEY, customModelId: CUSTOM_MODEL });
const sharedLocalStore = {};

// ---- Create a Gemini profile via Save: activates it, requests no permission (fixed host) ----

let geminiProfileId;
{
  const { elements, chrome } = buildInstance({ localStore: sharedLocalStore, fetchImpl });
  await flush();

  elements.apiSettingsToggle.dispatch("click");
  assert.equal(elements.providerKindGemini.checked, true, "Gemini is the default provider choice for a new profile");
  assert.equal(elements.endpointInput.value, "https://generativelanguage.googleapis.com/v1beta", "opening a new profile form applies the Gemini preset endpoint");
  elements.apiKeyInput.value = GEMINI_KEY;
  elements.modelInput.value = GEMINI_MODEL;
  elements.apiSettingsForm.dispatch("submit", { preventDefault() {} });
  await flush();

  assert.equal(elements.apiSettingsError.hidden, true, "Save must succeed with a valid Gemini endpoint/model/key");
  const stored = chrome.__localStore["sayslate-ai-provider-profiles"];
  assert.equal(stored.profiles.length, 1, "exactly one profile exists after the first Save");
  assert.equal(stored.profiles[0].providerKind, "gemini");
  assert.equal(stored.profiles[0].credential, GEMINI_KEY);
  assert.equal(stored.activeProfileId, stored.profiles[0].id, "Save activates the profile it just created");
  geminiProfileId = stored.profiles[0].id;
  assert.equal(elements.apiKeyInput.value, "", "the credential input is never rehydrated after Save");
  assert.equal(elements.configurationStatus.textContent, "Configured");
}

// ---- Create a custom (LM Studio) profile via Save: never erases the Gemini profile ----

let customProfileId;
{
  const { elements, chrome } = buildInstance({ localStore: sharedLocalStore, fetchImpl });
  await flush();

  elements.apiSettingsToggle.dispatch("click");
  // Start a new profile rather than editing the reloaded active (Gemini) selection.
  elements.profileSelect.value = "";
  elements.profileSelect.dispatch("change");
  elements.providerKindCustom.checked = true;
  elements.providerKindCustom.dispatch("change");
  assert.equal(elements.endpointInput.value, "", "a custom preset has no fixed default endpoint (LD-024)");

  elements.endpointInput.value = CUSTOM_ENDPOINT;
  elements.modelInput.value = CUSTOM_MODEL;
  elements.apiKeyInput.value = "";
  elements.apiSettingsForm.dispatch("submit", { preventDefault() {} });
  await flush();

  assert.equal(elements.apiSettingsError.hidden, true, "Save must succeed for a valid custom HTTPS endpoint");
  const stored = chrome.__localStore["sayslate-ai-provider-profiles"];
  assert.equal(stored.profiles.length, 2, "creating the custom profile must not remove the Gemini profile");
  const gemini = stored.profiles.find((profile) => profile.id === geminiProfileId);
  const custom = stored.profiles.find((profile) => profile.id !== geminiProfileId);
  assert.ok(gemini, "the Gemini profile survives");
  assert.equal(gemini.credential, GEMINI_KEY, "the Gemini profile's credential is untouched by an unrelated Save");
  assert.equal(gemini.endpoint, "https://generativelanguage.googleapis.com/v1beta");
  assert.equal(custom.providerKind, "custom");
  assert.equal(custom.endpoint, CUSTOM_ENDPOINT);
  assert.equal(stored.activeProfileId, custom.id, "Save activates the newly created custom profile");
  customProfileId = custom.id;
}

// ---- Switching profiles both directions activates immediately and never erases the other ----

{
  const { elements, chrome } = buildInstance({ localStore: sharedLocalStore, fetchImpl });
  await flush();

  elements.apiSettingsToggle.dispatch("click");
  elements.profileSelect.value = geminiProfileId;
  elements.profileSelect.dispatch("change");
  await flush();

  assert.equal(chrome.__localStore["sayslate-ai-provider-profiles"].activeProfileId, geminiProfileId);
  assert.equal(elements.endpointInput.value, "https://generativelanguage.googleapis.com/v1beta");
  assert.equal(elements.modelInput.value, GEMINI_MODEL);
  assert.equal(elements.apiKeyInput.value, "", "switching to a saved profile never reveals its stored credential");

  elements.profileSelect.value = customProfileId;
  elements.profileSelect.dispatch("change");
  await flush();

  assert.equal(chrome.__localStore["sayslate-ai-provider-profiles"].activeProfileId, customProfileId);
  assert.equal(elements.endpointInput.value, CUSTOM_ENDPOINT);
  assert.equal(elements.modelInput.value, CUSTOM_MODEL);
  assert.equal(chrome.__localStore["sayslate-ai-provider-profiles"].profiles.length, 2, "switching never drops a profile");
}

// ---- Reload: a fresh instance resolves the active profile and endpoint/model from storage ----

{
  const { elements } = buildInstance({ localStore: sharedLocalStore, fetchImpl });
  await flush();
  elements.apiSettingsToggle.dispatch("click");

  assert.equal(elements.profileSelect.value, customProfileId, "a reload resolves the previously active profile, not a blank form");
  assert.equal(elements.endpointInput.value, CUSTOM_ENDPOINT);
  assert.equal(elements.modelInput.value, CUSTOM_MODEL);
  assert.equal(elements.apiKeyInput.value, "", "credential inputs stay blank across a reload");
}

// ---- Test Connection: Gemini profile reports available against the real registry/dispatcher ----

{
  const { elements } = buildInstance({ localStore: sharedLocalStore, fetchImpl });
  await flush();
  elements.apiSettingsToggle.dispatch("click");
  elements.profileSelect.value = geminiProfileId;
  elements.profileSelect.dispatch("change");
  await flush();

  elements.testConnectionButton.dispatch("click");
  await flush();
  await flush();

  assert.equal(elements.connectionTestStatus.hidden, false);
  assert.equal(elements.connectionTestStatus.dataset.state, "available");
  assert.equal(elements.connectionTestStatusText.textContent, "The configured model is available.");
}

// ---- Test Connection: custom profile reports available via the OpenAI-compatible list ----

{
  const { elements } = buildInstance({ localStore: sharedLocalStore, fetchImpl });
  await flush();
  elements.apiSettingsToggle.dispatch("click");
  elements.profileSelect.value = customProfileId;
  elements.profileSelect.dispatch("change");
  await flush();

  elements.testConnectionButton.dispatch("click");
  await flush();
  await flush();

  assert.equal(elements.connectionTestStatus.dataset.state, "available");
}

// ---- Both AI passes run through the active profile and the real provider dispatcher ----

{
  const { elements } = buildInstance({ localStore: sharedLocalStore, fetchImpl });
  await flush();
  // The custom profile is active from the prior scenario's last activation.
  elements.transcript.value = "raw dictated text";
  elements.transcript.dispatch("input");

  elements.apiSettingsToggle.dispatch("click");
  elements.profileSelect.value = geminiProfileId;
  elements.profileSelect.dispatch("change");
  await flush();

  elements.firstPassPromptInput.value = "Clean this up";
  elements.secondPassPromptInput.value = "Polish this";
  elements.secondPassEnabledInput.checked = true;
  elements.promptSettingsForm.dispatch("submit", { preventDefault() {} });
  await flush();

  elements.firstPassButton.dispatch("click");
  await flush();
  await flush();
  assert.equal(elements.notice.hidden, true, "the Gemini first pass must succeed against the real dispatcher/adapter");
  assert.equal(elements.resultTranscript.value, "gemini pass result");

  elements.secondPassButton.dispatch("click");
  await flush();
  await flush();
  assert.equal(elements.resultTranscript.value, "gemini pass result", "the second pass re-runs the same Gemini profile end to end");
}

// ---- Clear Credential blanks only the selected profile's own credential ----

{
  const { elements, chrome } = buildInstance({ localStore: sharedLocalStore, fetchImpl });
  await flush();
  elements.apiSettingsToggle.dispatch("click");
  elements.profileSelect.value = customProfileId;
  elements.profileSelect.dispatch("change");
  await flush();

  elements.clearCredentialButton.dispatch("click");
  await flush();

  const stored = chrome.__localStore["sayslate-ai-provider-profiles"];
  const custom = stored.profiles.find((profile) => profile.id === customProfileId);
  const gemini = stored.profiles.find((profile) => profile.id === geminiProfileId);
  assert.equal(custom.credential, "", "Clear Credential blanks the selected profile's credential");
  assert.equal(gemini.credential, GEMINI_KEY, "Clear Credential must never touch another profile's credential");

  // F1 regression: clearCredential resolves to the updated PROFILE, not the
  // { version, activeProfileId, profiles } state - a stale providerState previously made
  // every controller call after Clear Credential throw "Cannot read properties of
  // undefined (reading 'find')". Prove no error, a correct placeholder, and that select,
  // Save, and Test all keep working afterward.
  assert.equal(elements.apiSettingsError.hidden, true, "F1: Clear Credential itself must not surface an error");
  assert.equal(elements.apiKeyInput.placeholder, "Paste your key", "F1: the placeholder must show no saved key after Clear Credential");

  elements.profileSelect.value = geminiProfileId;
  elements.profileSelect.dispatch("change");
  await flush();
  assert.equal(elements.apiSettingsError.hidden, true, "F1: selecting another profile after Clear Credential must not error");
  assert.equal(elements.endpointInput.value, "https://generativelanguage.googleapis.com/v1beta");

  elements.profileSelect.value = customProfileId;
  elements.profileSelect.dispatch("change");
  await flush();
  assert.equal(elements.apiSettingsError.hidden, true, "F1: reselecting the credential-cleared profile must not error");
  assert.equal(elements.apiKeyInput.placeholder, "Paste your key");

  elements.apiKeyInput.value = "new-custom-key";
  elements.apiSettingsForm.dispatch("submit", { preventDefault() {} });
  await flush();
  assert.equal(elements.apiSettingsError.hidden, true, "F1: Save after Clear Credential must still succeed");
  const customAfterSave = chrome.__localStore["sayslate-ai-provider-profiles"].profiles.find((profile) => profile.id === customProfileId);
  assert.equal(customAfterSave.credential, "new-custom-key");

  elements.testConnectionButton.dispatch("click");
  await flush();
  await flush();
  assert.equal(elements.connectionTestStatus.dataset.state, "available", "F1: Test Connection after Clear Credential must still succeed");
}

// ---- Delete removes only the selected profile; the survivor is completely unchanged ----

{
  const { elements, chrome } = buildInstance({ localStore: sharedLocalStore, fetchImpl });
  await flush();
  elements.apiSettingsToggle.dispatch("click");
  elements.profileSelect.value = customProfileId;
  elements.profileSelect.dispatch("change");
  await flush();

  const beforeDelete = JSON.parse(JSON.stringify(chrome.__localStore["sayslate-ai-provider-profiles"]));
  const survivorBefore = beforeDelete.profiles.find((profile) => profile.id === geminiProfileId);

  elements.deleteProfileButton.dispatch("click");
  await flush();

  const stored = chrome.__localStore["sayslate-ai-provider-profiles"];
  assert.equal(stored.profiles.length, 1, "Delete removes exactly the selected profile");
  assert.equal(stored.profiles.some((profile) => profile.id === customProfileId), false);
  const survivorAfter = JSON.parse(JSON.stringify(stored.profiles.find((profile) => profile.id === geminiProfileId)));
  // Normalized through JSON round-tripping on both sides: survivorBefore/survivorAfter are
  // read from two different vm realms (separate buildInstance() contexts), whose plain
  // object literals otherwise fail deepStrictEqual's own-realm prototype check despite
  // identical field values.
  assert.deepEqual(survivorAfter, survivorBefore, "the surviving Gemini profile is byte-for-byte unchanged by deleting the other one");
  assert.equal(elements.profileSelect.value, "", "deleting the active profile leaves no active selection (LD-023)");
}

// ---- F2 regression: migration must complete before loadProcessingConfig strips the key ----
// Startup used to call loadProcessingConfig() before, and concurrently with, the migration
// IIFE. When the stored promptSchemaVersion was already behind PROMPT_SCHEMA_VERSION,
// loadProcessingConfig's own migration write raced ahead of migrateLegacyConfig's read and
// stripped apiKey/model from the legacy record before it was ever copied into a profile -
// silently losing the key. This proves an old-schema legacy record still yields exactly one
// migrated Gemini profile, the prompt-schema upgrade still applies, and the legacy record
// ends with no apiKey/model.

{
  const legacyStore = {
    "sayslate-grammar-config": {
      apiKey: "legacy-key",
      model: "legacy-model",
      firstPassPrompt: "Clean this up",
      secondPassPrompt: "",
      secondPassEnabled: true,
      promptSchemaVersion: 0
    }
  };
  const { chrome } = buildInstance({ localStore: legacyStore, fetchImpl });
  await flush();
  await flush();
  await flush();

  const providerStore = chrome.__localStore["sayslate-ai-provider-profiles"];
  assert.equal(providerStore.profiles.length, 1, "F2: exactly one profile must be migrated from an old-schema legacy record");
  assert.equal(providerStore.profiles[0].providerKind, "gemini");
  assert.equal(providerStore.profiles[0].credential, "legacy-key", "F2: the legacy key must reach the migrated profile, not be stripped first");
  assert.equal(providerStore.profiles[0].modelId, "legacy-model");

  const legacyAfter = chrome.__localStore["sayslate-grammar-config"];
  assert.equal(legacyAfter.apiKey, undefined, "F2: the legacy record must end with no apiKey");
  assert.equal(legacyAfter.model, undefined, "F2: the legacy record must end with no model");
  assert.equal(legacyAfter.promptSchemaVersion, 3, "F2: the prompt-schema upgrade must still apply after migration");
}

// ---- F3 regression: a synchronous double trigger must issue exactly one generation request ----
// runFirstPass/runSecondPass used to await resolveActiveProfile() before claiming the
// firstPassRunning/secondPassRunning guard, so a second trigger arriving in that window
// passed the reentry guard and issued a second real request.

{
  const { elements } = buildInstance({ localStore: sharedLocalStore, fetchImpl });
  await flush();
  elements.apiSettingsToggle.dispatch("click");
  elements.profileSelect.value = geminiProfileId;
  elements.profileSelect.dispatch("change");
  await flush();

  elements.transcript.value = "double trigger source text";
  elements.transcript.dispatch("input");

  const before = fetchImpl.__calls.filter((call) => call.url.includes(":generateContent")).length;
  // Two synchronous dispatches, deliberately with no await between them, simulating a
  // double click landing before the first call's own guard has taken effect.
  elements.firstPassButton.dispatch("click");
  elements.firstPassButton.dispatch("click");
  await flush();
  await flush();
  const after = fetchImpl.__calls.filter((call) => call.url.includes(":generateContent")).length;
  assert.equal(after - before, 1, "F3: a synchronous double trigger on the full page must produce exactly one generation request");
}

console.log("Provider settings UI (LD-027) production-controller integration verified.");
