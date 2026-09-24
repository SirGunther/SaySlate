import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(extensionRoot, file), "utf8");
const settingsSource = read("dictationSettings.js");
const appSource = read("app.js");
// SAYAI-05: app.js now drives the real LD-023/LD-024/LD-025 provider modules (loaded here
// exactly as app.html now orders them) instead of a fake SaySlateAIClient.generate call, so
// this integration proves the real renderer-to-dispatcher-to-adapter-boundary wiring, not
// just a mocked call shape.
const aiProviderRegistrySource = read("aiProviderRegistry.js");
const aiProviderPermissionsSource = read("aiProviderPermissions.js");
const aiProviderSettingsSource = read("aiProviderSettings.js");
const aiProviderClientSource = read("aiProviderClient.js");

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
  // SAYAI-05: LD-027's provider-profile management controls.
  "profileSelect", "providerKindGemini", "providerKindOpenAI", "providerKindAnthropic",
  "providerKindCustom", "endpointInput", "connectionTestStatus", "connectionTestStatusText",
  "testConnectionButton", "clearCredentialButton", "deleteProfileButton",
  // SAYREASON-02: per-pass reasoning-effort switches and their state labels.
  "firstPassReasoningInput", "firstPassReasoningState", "secondPassReasoningInput", "secondPassReasoningState"
];

function createElement(id) {
  const listeners = {};
  return {
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
  // SAYSTAT-01: mirrors app.html's real starting markup (EV-001) - #statusPill starts
  // data-state="idle" with "Ready" text - so a scenario that expects no badge change (e.g.
  // no active profile) has a real starting value to assert against.
  elements.statusPill.dataset.state = "idle";
  elements.statusText.textContent = "Ready";

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

function createFakeChrome() {
  const runtimeMessageListeners = [];
  const sentMessages = [];
  let localStore = {};
  let sendMessageResponder = async () => ({ ok: true, ready: true });

  return {
    __sentMessages: sentMessages,
    __setLocalWhisperSettings(value) { localStore["sayslate-dictation-settings"] = value; },
    // SAYAI-05: seeds the LD-023 provider-profile record directly, the same shape
    // aiProviderSettings.js itself persists, so a test can start with an active profile
    // without driving the Save form first.
    __setProviderProfiles(value) { localStore["sayslate-ai-provider-profiles"] = value; },
    __setSendMessageResponder(fn) { sendMessageResponder = fn; },
    __dispatchRuntimeMessage(message) {
      for (const fn of runtimeMessageListeners) fn(message, {}, () => {});
    },
    storage: {
      local: {
        get(key, callback) { callback({ [key]: localStore[key] }); },
        set(entries, callback) { localStore = { ...localStore, ...entries }; callback(); }
      }
    },
    // LD-034: auto-grant so Save/Test in these dictation-focused scenarios are not blocked
    // on a permission prompt this file does not exercise (that boundary is
    // ai-provider-permissions.test.mjs's job).
    permissions: {
      contains(_query, callback) { callback(true); },
      request(_query, callback) { callback(true); }
    },
    runtime: {
      lastError: null,
      onMessage: { addListener(fn) { runtimeMessageListeners.push(fn); } },
      sendMessage(message) {
        sentMessages.push(message);
        return Promise.resolve().then(() => sendMessageResponder(message));
      }
    }
  };
}

function seedProviderProfile(chrome, {
  id = "profile-1",
  providerKind = "gemini",
  endpoint = "https://generativelanguage.googleapis.com/v1beta",
  modelId = "model",
  credential = "key"
} = {}) {
  chrome.__setProviderProfiles({
    version: 1,
    activeProfileId: id,
    profiles: [{ id, name: `${providerKind} · ${modelId}`, providerKind, endpoint, modelId, credential }]
  });
}

function createFakeSpeech() {
  let handlers = null;
  let listening = false;
  const calls = { start: 0, stop: 0, cancel: 0 };
  return {
    __calls: calls,
    __handlers() { return handlers; },
    __isSupported: true,
    create(passedHandlers) {
      handlers = passedHandlers;
      return {
        get listening() { return listening; },
        start() {
          calls.start += 1;
          listening = true;
          handlers.onStart({ recovered: false });
          return true;
        },
        stop() {
          calls.stop += 1;
          listening = false;
          handlers.onStop();
          return Promise.resolve();
        },
        cancel() { calls.cancel += 1; listening = false; }
      };
    },
    isSupported() { return this.__isSupported; }
  };
}

// SAYAI-05: aiProviderClient.js's gemini-native transport calls
// globalThis.SaySlateAIClient.generateStructured({ ..., userPrompt, ... }) - this fake
// stands in for that adapter boundary so these scenarios stay focused on app.js's own
// wiring (profile resolution, pass ordering) rather than re-testing aiClient.js itself.
function createFakeAiClient(responder) {
  const calls = [];
  return {
    calls,
    generateStructured(options) {
      calls.push(options);
      return Promise.resolve(responder ? responder(options) : "processed result");
    }
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function buildContext({ provider = "browser", aiResponder, processingConfig, providerProfile } = {}) {
  const { document, elements } = buildFakeDom();
  const chrome = createFakeChrome();
  const speech = createFakeSpeech();
  const aiClient = createFakeAiClient(aiResponder);
  if (providerProfile) seedProviderProfile(chrome, providerProfile);
  const animations = {
    showToast() {},
    showPanel(panel) { panel.hidden = false; return Promise.resolve(); },
    hidePanel(panel) { panel.hidden = true; return Promise.resolve(); },
    transitionTheme(fn) { fn(); return Promise.resolve(); }
  };
  let uuidCounter = 0;
  let localStorageStore = {};
  const localStorage = {
    getItem(key) { return Object.prototype.hasOwnProperty.call(localStorageStore, key) ? localStorageStore[key] : null; },
    setItem(key, value) { localStorageStore[key] = String(value); },
    removeItem(key) { delete localStorageStore[key]; }
  };
  const windowStub = {
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (...args) => clearTimeout(...args),
    requestAnimationFrame(cb) { cb(); },
    addEventListener(type, handler) { (windowStub.__listeners[type] ||= []).push(handler); },
    __listeners: {}
  };

  // SAYSTAT-01A: counts real clipboard writes so a scenario can assert Ctrl+Alt+R copied
  // exactly once, without calling copyResultTranscript directly.
  const clipboard = { writeCalls: 0 };
  const context = vm.createContext({
    chrome,
    console,
    Error,
    Map,
    Promise,
    URL,
    document,
    window: windowStub,
    localStorage,
    navigator: { clipboard: { writeText: () => { clipboard.writeCalls += 1; return Promise.resolve(); } } },
    crypto: { randomUUID: () => `uuid-${uuidCounter += 1}` },
    SaySlateAnimations: animations,
    SaySlateSpeech: speech,
    SaySlateAIClient: aiClient
  });

  // SAYAI-05: real LD-023/LD-024/LD-025 provider modules, loaded in the same producer-
  // before-consumer order app.html now uses, ahead of app.js itself.
  vm.runInContext(aiProviderRegistrySource, context);
  vm.runInContext(aiProviderPermissionsSource, context);
  vm.runInContext(aiProviderSettingsSource, context);
  vm.runInContext(aiProviderClientSource, context);

  vm.runInContext(settingsSource, context);
  if (provider === "local-whisper") {
    chrome.__setLocalWhisperSettings({ provider: "local-whisper", bearerToken: "unused-in-this-harness", previewMs: 2000 });
  }
  if (processingConfig) {
    chrome.storage.local.set({ "sayslate-grammar-config": processingConfig }, () => {});
  }
  vm.runInContext(appSource, context);

  return { context, document, elements, chrome, speech, aiClient, windowStub, clipboard };
}

// ---- Browser Dictation regression: unchanged path still drives SaySlateSpeech directly ----

{
  const { elements, speech } = buildContext({ provider: "browser" });
  await flush();

  elements.startButton.dispatch("click");
  assert.equal(speech.__calls.start, 1, "clicking start with Browser Dictation selected must call SaySlateSpeech.start()");
  assert.equal(elements.startButtonLabel.textContent, "Stop and copy");

  speech.__handlers().onResult({
    results: [
      Object.assign([{ transcript: "hello " }], { isFinal: true }),
      Object.assign([{ transcript: "world" }], { isFinal: false })
    ]
  });
  assert.equal(elements.transcript.value, "hello world");

  elements.startButton.dispatch("click");
  assert.equal(speech.__calls.stop, 1, "clicking stop with Browser Dictation selected must call SaySlateSpeech.stop()");
}

// ---- Local Whisper: start routes through the WSI-04 background message contract ----

{
  const { elements, chrome } = buildContext({ provider: "local-whisper" });
  await flush();

  elements.startButton.dispatch("click");
  await flush();

  const startMessage = chrome.__sentMessages.find((m) => m.type === "sayslate-local-whisper-command" && m.action === "start");
  assert.ok(startMessage, "starting Local Whisper must send a sayslate-local-whisper-command start message");
  assert.equal(startMessage.origin, "full-page");
  assert.equal(typeof startMessage.sessionId, "string");
  assert.ok(startMessage.sessionId.length > 0);
  assert.equal(elements.startButtonLabel.textContent, "Stop and copy", "a successful start must reflect listening UI");
}

// ---- Local Whisper: partial events replace the preview; final events accumulate ----

{
  const { elements, chrome } = buildContext({ provider: "local-whisper" });
  await flush();
  elements.startButton.dispatch("click");
  await flush();
  const sessionId = chrome.__sentMessages.at(-1).sessionId;

  chrome.__dispatchRuntimeMessage({
    type: "sayslate-offscreen-local-whisper-event", target: "full-page", sessionId,
    event: "partial", payload: { utteranceId: "u1", revision: 1, text: "hello" }
  });
  assert.equal(elements.transcript.value, "hello");

  chrome.__dispatchRuntimeMessage({
    type: "sayslate-offscreen-local-whisper-event", target: "full-page", sessionId,
    event: "partial", payload: { utteranceId: "u1", revision: 2, text: "hello there" }
  });
  assert.equal(elements.transcript.value, "hello there", "a newer partial must replace the preview, not append");

  chrome.__dispatchRuntimeMessage({
    type: "sayslate-offscreen-local-whisper-event", target: "full-page", sessionId,
    event: "final", payload: { utteranceId: "u1", text: "hello there", finalizationReason: "endpoint" }
  });
  assert.equal(elements.transcript.value, "hello there", "a final commits exactly its own text, not a duplicate");

  chrome.__dispatchRuntimeMessage({
    type: "sayslate-offscreen-local-whisper-event", target: "full-page", sessionId,
    event: "partial", payload: { utteranceId: "u2", revision: 1, text: "second utterance" }
  });
  assert.equal(elements.transcript.value, "hello there second utterance");

  chrome.__dispatchRuntimeMessage({
    type: "sayslate-offscreen-local-whisper-event", target: "full-page", sessionId,
    event: "final", payload: { utteranceId: "u2", text: "second utterance", finalizationReason: "endpoint" }
  });
  assert.equal(elements.transcript.value, "hello there second utterance", "multiple finalized utterances accumulate in order");

  chrome.__dispatchRuntimeMessage({
    type: "sayslate-offscreen-local-whisper-event", target: "full-page", sessionId,
    event: "empty", payload: { utteranceId: "u3", finalizationReason: "no-speech" }
  });
  assert.equal(elements.transcript.value, "hello there second utterance", "an empty result adds no text");
}

// ---- Local Whisper: events for a different target or a superseded session are ignored ----

{
  const { elements, chrome } = buildContext({ provider: "local-whisper" });
  await flush();
  elements.startButton.dispatch("click");
  await flush();
  const sessionId = chrome.__sentMessages.at(-1).sessionId;

  chrome.__dispatchRuntimeMessage({
    type: "sayslate-offscreen-local-whisper-event", target: "floating", sessionId,
    event: "final", payload: { utteranceId: "x", text: "not for this page" }
  });
  assert.equal(elements.transcript.value, "", "an event targeted at the floating surface must not affect the full page");

  chrome.__dispatchRuntimeMessage({
    type: "sayslate-offscreen-local-whisper-event", target: "full-page", sessionId: "some-other-session",
    event: "final", payload: { utteranceId: "y", text: "stale run" }
  });
  assert.equal(elements.transcript.value, "", "an event for a non-matching sessionId must be dropped");
}

// ---- Local Whisper: Clear cancels the active session and erases without emitting a transcript ----

{
  const { elements, chrome } = buildContext({ provider: "local-whisper" });
  await flush();
  elements.startButton.dispatch("click");
  await flush();
  const sessionId = chrome.__sentMessages.at(-1).sessionId;

  chrome.__dispatchRuntimeMessage({
    type: "sayslate-offscreen-local-whisper-event", target: "full-page", sessionId,
    event: "partial", payload: { utteranceId: "u1", revision: 1, text: "in progress" }
  });
  assert.equal(elements.transcript.value, "in progress");

  elements.clearButton.dispatch("click");
  await flush();

  assert.equal(elements.transcript.value, "", "Clear must erase the transcript");
  const cancelMessage = chrome.__sentMessages.find((m) => m.type === "sayslate-local-whisper-command" && m.action === "cancel");
  assert.ok(cancelMessage, "Clear must cancel the active Local Whisper session");
  assert.equal(cancelMessage.sessionId, sessionId);

  // A late event from the just-cancelled session must not resurrect any transcript text.
  chrome.__dispatchRuntimeMessage({
    type: "sayslate-offscreen-local-whisper-event", target: "full-page", sessionId,
    event: "final", payload: { utteranceId: "u1", text: "in progress" }
  });
  assert.equal(elements.transcript.value, "", "a late final for a cancelled session must not reappear");
}

// ---- Local Whisper: explicit unauthorized failure on start - no silent browser fallback ----

{
  const { elements, chrome, speech, context } = buildContext({ provider: "local-whisper" });
  chrome.__setSendMessageResponder((message) => {
    if (message.type === "sayslate-local-whisper-command" && message.action === "start") {
      return { ok: false, code: "unauthorized", message: "Local Whisper has no saved token." };
    }
    return { ok: true };
  });
  await flush();

  elements.startButton.dispatch("click");
  await flush();

  assert.equal(speech.__calls.start, 0, "an explicit Local Whisper failure must never fall back to Browser Dictation");
  assert.equal(elements.notice.hidden, false);
  assert.equal(elements.notice.textContent, "Local Whisper has no saved token.");
  assert.equal(context.SaySlateDictationSettings.getAvailability().state, "unauthorized");
}

// ---- Local Whisper: explicit offline failure on start - no silent browser fallback ----

{
  const { elements, chrome, speech, context } = buildContext({ provider: "local-whisper" });
  chrome.__setSendMessageResponder((message) => {
    if (message.type === "sayslate-local-whisper-command" && message.action === "start") {
      return { ok: false, code: "unavailable", message: "WhisperService is offline or unreachable." };
    }
    return { ok: true, ready: true };
  });
  await flush();

  elements.startButton.dispatch("click");
  await flush();

  assert.equal(speech.__calls.start, 0, "an offline Local Whisper service must never fall back to Browser Dictation");
  assert.equal(elements.notice.hidden, false);
  assert.equal(elements.notice.textContent, "WhisperService is offline or unreachable.");
  assert.equal(context.SaySlateDictationSettings.getAvailability().state, "unavailable");
}

// ---- Local Whisper: availability must reflect response.ready, not just response.ok ----

{
  const { chrome, context } = buildContext({ provider: "browser" });
  chrome.__setSendMessageResponder((message) => {
    if (message.type === "sayslate-local-whisper-health-check") return { ok: true, ready: false };
    return { ok: true, ready: true };
  });
  await flush();

  assert.equal(
    context.SaySlateDictationSettings.getAvailability().state,
    "unavailable",
    "a reachable-but-not-ready health response must not be reported as available"
  );
}

// ---- Local Whisper: availability re-probes after a settings save, not just at page load ----

{
  const { chrome, context } = buildContext({ provider: "browser" });
  await flush();
  assert.equal(context.SaySlateDictationSettings.getAvailability().state, "available");
  const checksAtLoad = chrome.__sentMessages.filter((m) => m.type === "sayslate-local-whisper-health-check").length;
  assert.equal(checksAtLoad, 1);

  chrome.__setSendMessageResponder((message) => {
    if (message.type === "sayslate-local-whisper-health-check") {
      return { ok: false, code: "unauthorized", message: "Local Whisper has no saved token." };
    }
    return { ok: true, ready: true };
  });
  await context.SaySlateDictationSettings.saveConfig({ token: "rotated-token" });
  await flush();

  const checksAfterSave = chrome.__sentMessages.filter((m) => m.type === "sayslate-local-whisper-health-check").length;
  assert.equal(checksAfterSave, 2, "saving Local Whisper settings must trigger a fresh availability probe");
  assert.equal(context.SaySlateDictationSettings.getAvailability().state, "unauthorized");
}

// ---- Local Whisper: Finish awaits stop settlement before the first AI pass runs ----

{
  const { elements, chrome, aiClient } = buildContext({
    provider: "local-whisper",
    processingConfig: {
      firstPassPrompt: "First pass prompt", secondPassPrompt: "", secondPassEnabled: false, promptSchemaVersion: 3
    },
    providerProfile: { modelId: "model", credential: "key" }
  });
  await flush();

  elements.startButton.dispatch("click");
  await flush();
  const sessionId = chrome.__sentMessages.at(-1).sessionId;

  chrome.__dispatchRuntimeMessage({
    type: "sayslate-offscreen-local-whisper-event", target: "full-page", sessionId,
    event: "final", payload: { utteranceId: "u1", text: "dictated content" }
  });
  assert.equal(elements.transcript.value, "dictated content");

  let resolveStop;
  chrome.__setSendMessageResponder((message) => {
    if (message.type === "sayslate-local-whisper-command" && message.action === "stop") {
      return new Promise((resolve) => { resolveStop = () => resolve({ ok: true, reason: "endpoint" }); });
    }
    return { ok: true };
  });

  // finishWorkflow is not exported; drive it via the Finish button instead.
  elements.finishWorkflowButton.dispatch("click");
  await flush();

  assert.equal(aiClient.calls.length, 0, "the AI pass must not start before stop settles");
  const stopMessage = chrome.__sentMessages.find((m) => m.type === "sayslate-local-whisper-command" && m.action === "stop");
  assert.ok(stopMessage, "Finish must send a stop command for the active Local Whisper session");

  resolveStop();
  await flush();
  await flush();

  assert.equal(aiClient.calls.length, 1, "the first AI pass must run only after stop settles");
  assert.equal(
    aiClient.calls[0].userPrompt,
    "First pass prompt\n\n<transcript>\ndictated content\n</transcript>",
    "the exact first-pass prompt construction must be unchanged for Local Whisper transcripts"
  );
  assert.equal(aiClient.calls[0].modelId, "model");
}

// ---- Local Whisper: a stop settlement failure preserves the transcript and shows an explicit error ----

{
  const { elements, chrome, aiClient } = buildContext({
    provider: "local-whisper",
    processingConfig: {
      firstPassPrompt: "First pass prompt", secondPassPrompt: "", secondPassEnabled: false, promptSchemaVersion: 3
    }
  });
  await flush();

  elements.startButton.dispatch("click");
  await flush();
  const sessionId = chrome.__sentMessages.at(-1).sessionId;

  chrome.__dispatchRuntimeMessage({
    type: "sayslate-offscreen-local-whisper-event", target: "full-page", sessionId,
    event: "final", payload: { utteranceId: "u1", text: "captured before failure" }
  });

  chrome.__setSendMessageResponder((message) => {
    if (message.type === "sayslate-local-whisper-command" && message.action === "stop") {
      return { ok: false, reason: "worker-timeout" };
    }
    return { ok: true };
  });

  elements.finishWorkflowButton.dispatch("click");
  await flush();
  await flush();

  assert.equal(aiClient.calls.length, 0, "the AI pass must not run when stop settlement fails");
  assert.equal(elements.transcript.value, "captured before failure", "the transcript must be preserved on stop failure");
  assert.equal(elements.notice.hidden, false);
  assert.match(elements.notice.textContent, /worker-timeout/);
}

// ---- Local Whisper: an {ok:true, inactive:true} stop is not a definitive settlement ----
// The session was already gone before this stop reached it - offscreen never ran the real
// mic-flush + controller.stop() sequence, so no final transcript was actually confirmed.

{
  const { elements, chrome, aiClient } = buildContext({
    provider: "local-whisper",
    processingConfig: {
      firstPassPrompt: "First pass prompt", secondPassPrompt: "", secondPassEnabled: false, promptSchemaVersion: 3
    }
  });
  await flush();

  elements.startButton.dispatch("click");
  await flush();
  const sessionId = chrome.__sentMessages.at(-1).sessionId;

  chrome.__dispatchRuntimeMessage({
    type: "sayslate-offscreen-local-whisper-event", target: "full-page", sessionId,
    event: "final", payload: { utteranceId: "u1", text: "content before ambiguous stop" }
  });

  chrome.__setSendMessageResponder((message) => {
    if (message.type === "sayslate-local-whisper-command" && message.action === "stop") {
      return { ok: true, inactive: true };
    }
    return { ok: true };
  });

  elements.finishWorkflowButton.dispatch("click");
  await flush();
  await flush();

  assert.equal(
    aiClient.calls.length, 0,
    "an {ok:true, inactive:true} stop response must not be treated as a definitive settlement that unblocks AI processing"
  );
  assert.equal(elements.transcript.value, "content before ambiguous stop", "the transcript must be preserved when settlement cannot be confirmed");
  assert.equal(elements.notice.hidden, false);
}

// ---- Regression: both AI passes run in order, with unchanged prompt construction, for a Local Whisper transcript ----

{
  const { elements, chrome, aiClient } = buildContext({
    provider: "local-whisper",
    processingConfig: {
      firstPassPrompt: "First pass prompt", secondPassPrompt: "Second pass prompt",
      secondPassEnabled: true, promptSchemaVersion: 3
    },
    providerProfile: { modelId: "model", credential: "key" },
    aiResponder: (options) => (options.userPrompt.includes("<transcript>") ? "first pass output" : "second pass output")
  });
  await flush();

  elements.startButton.dispatch("click");
  await flush();
  const sessionId = chrome.__sentMessages.at(-1).sessionId;

  chrome.__dispatchRuntimeMessage({
    type: "sayslate-offscreen-local-whisper-event", target: "full-page", sessionId,
    event: "final", payload: { utteranceId: "u1", text: "dictated content" }
  });

  elements.finishWorkflowButton.dispatch("click");
  await flush();
  await flush();
  await flush();

  assert.equal(aiClient.calls.length, 2, "both passes must run, in order, when the second pass is enabled");
  assert.equal(
    aiClient.calls[0].userPrompt,
    "First pass prompt\n\n<transcript>\ndictated content\n</transcript>",
    "first-pass prompt construction is unchanged"
  );
  assert.equal(
    aiClient.calls[1].userPrompt,
    "Second pass prompt\n\n<first_pass_result>\nfirst pass output\n</first_pass_result>",
    "second-pass prompt construction is unchanged and reads the first pass's own output as source text"
  );
  assert.equal(elements.transcript.value, "", "Finish clears the transcript only after both passes and the final copy succeed");
}

// ---- Page teardown: beforeunload cancels an active Local Whisper session ----

{
  const { elements, chrome, windowStub } = buildContext({ provider: "local-whisper" });
  await flush();

  elements.startButton.dispatch("click");
  await flush();
  const sessionId = chrome.__sentMessages.at(-1).sessionId;

  for (const handler of windowStub.__listeners.beforeunload || []) handler();

  const cancelMessage = chrome.__sentMessages.find((m) => m.type === "sayslate-local-whisper-command" && m.action === "cancel");
  assert.ok(cancelMessage, "beforeunload must cancel an active Local Whisper session");
  assert.equal(cancelMessage.sessionId, sessionId);
}

// ---- SAYSTAT-01: full-page status badge tracks each AI pass, matching Floating Slate ----
// Every scenario below drives the real click handlers (or a README-shortcut keydown) through
// buildContext's real app.js/aiProviderClient.js wiring (EV-018); none calls setStatus or a
// pass function directly. A deferred aiResponder lets a scenario observe the badge while a
// pass's provider request is still in flight, then settle it and observe the result state.

function typeTranscript(elements, text) {
  elements.transcript.value = text;
  elements.transcript.dispatch("input");
}

const FIRST_PASS_ONLY_CONFIG = Object.freeze({
  firstPassPrompt: "First pass prompt", secondPassPrompt: "", secondPassEnabled: false, promptSchemaVersion: 3
});
const BOTH_PASSES_CONFIG = Object.freeze({
  firstPassPrompt: "First pass prompt", secondPassPrompt: "Second pass prompt", secondPassEnabled: true, promptSchemaVersion: 3
});
const PROVIDER_PROFILE = Object.freeze({ modelId: "model", credential: "key" });

// ---- First pass: processing / "Phase 1" while in flight, then complete / "Phase 1 ready" ----

{
  let resolveFirstPass;
  const { elements } = buildContext({
    providerProfile: PROVIDER_PROFILE,
    processingConfig: FIRST_PASS_ONLY_CONFIG,
    aiResponder: () => new Promise((resolve) => { resolveFirstPass = resolve; })
  });
  await flush();
  typeTranscript(elements, "hello world");
  assert.equal(elements.firstPassButton.disabled, false, "the first-pass button must be enabled for this dispatched click");

  elements.firstPassButton.dispatch("click");
  await flush();
  assert.equal(elements.statusPill.dataset.state, "processing");
  assert.equal(elements.statusText.textContent, "Phase 1");

  resolveFirstPass("first pass output");
  await flush();
  assert.equal(elements.statusPill.dataset.state, "complete");
  assert.equal(elements.statusText.textContent, "Phase 1 ready");
}

// ---- Second pass: processing / "Phase 2" while in flight, then complete / "Phase 2 ready" ----

{
  let resolveSecondPass;
  const { elements } = buildContext({
    providerProfile: PROVIDER_PROFILE,
    processingConfig: BOTH_PASSES_CONFIG,
    aiResponder: (options) => (options.userPrompt.includes("<transcript>")
      ? "first pass output"
      : new Promise((resolve) => { resolveSecondPass = resolve; }))
  });
  await flush();
  typeTranscript(elements, "hello world");

  elements.firstPassButton.dispatch("click");
  await flush();
  assert.equal(elements.statusText.textContent, "Phase 1 ready");

  assert.equal(elements.secondPassButton.disabled, false, "the second-pass button must be enabled for this dispatched click");
  elements.secondPassButton.dispatch("click");
  await flush();
  assert.equal(elements.statusPill.dataset.state, "processing");
  assert.equal(elements.statusText.textContent, "Phase 2");

  resolveSecondPass("second pass output");
  await flush();
  assert.equal(elements.statusPill.dataset.state, "complete");
  assert.equal(elements.statusText.textContent, "Phase 2 ready");
}

// ---- Failure: a rejected pass ends at error / "Phase 1 failed"; transcript and any prior result are preserved ----

{
  let callCount = 0;
  const { elements } = buildContext({
    providerProfile: PROVIDER_PROFILE,
    processingConfig: FIRST_PASS_ONLY_CONFIG,
    aiResponder: () => {
      callCount += 1;
      return callCount === 1 ? "first pass output" : Promise.reject(new Error("provider rejected the request"));
    }
  });
  await flush();
  typeTranscript(elements, "hello world");

  elements.firstPassButton.dispatch("click");
  await flush();
  assert.equal(elements.resultTranscript.value, "first pass output", "a prior result must already be showing before the failing run");

  elements.firstPassButton.dispatch("click");
  await flush();
  assert.equal(elements.statusPill.dataset.state, "error");
  assert.equal(elements.statusText.textContent, "Phase 1 failed");
  assert.equal(elements.transcript.value, "hello world", "the transcript must be preserved on failure");
  assert.equal(elements.resultTranscript.value, "first pass output", "the prior result must be preserved on failure");
}

// ---- No active profile: the badge still reads "Ready" and no provider request is sent (EV-005) ----

{
  const { elements, aiClient } = buildContext({
    processingConfig: FIRST_PASS_ONLY_CONFIG
    // No providerProfile seeded, so hasActiveProfile() is false.
  });
  await flush();
  typeTranscript(elements, "hello world");

  elements.firstPassButton.dispatch("click");
  await flush();
  assert.equal(aiClient.calls.length, 0, "no provider request must be sent without an active profile");
  assert.equal(elements.statusPill.dataset.state, "idle");
  assert.equal(elements.statusText.textContent, "Ready");
}

// ---- Finish, second pass enabled: "Phase 1", then "Phase 2", each observed in flight, then idle / "Ready" after the final clear ----

{
  let resolveFirstPass;
  let resolveSecondPass;
  const { elements } = buildContext({
    providerProfile: PROVIDER_PROFILE,
    processingConfig: BOTH_PASSES_CONFIG,
    aiResponder: (options) => (options.userPrompt.includes("<transcript>")
      ? new Promise((resolve) => { resolveFirstPass = resolve; })
      : new Promise((resolve) => { resolveSecondPass = resolve; }))
  });
  await flush();
  typeTranscript(elements, "hello world");

  assert.equal(elements.finishWorkflowButton.disabled, false, "Finish must be enabled for this dispatched click");
  elements.finishWorkflowButton.dispatch("click");
  await flush();
  assert.equal(elements.statusPill.dataset.state, "processing");
  assert.equal(elements.statusText.textContent, "Phase 1");

  resolveFirstPass("first pass output");
  await flush();
  assert.equal(elements.statusPill.dataset.state, "processing");
  assert.equal(elements.statusText.textContent, "Phase 2");

  resolveSecondPass("second pass output");
  await flush();
  await flush();
  assert.equal(elements.statusPill.dataset.state, "idle");
  assert.equal(elements.statusText.textContent, "Ready");
  assert.equal(elements.transcript.value, "", "Finish clears the transcript only after both passes and the final copy succeed");
}

// ---- Finish, second pass fails: ends at error / "Phase 2 failed"; the transcript is not cleared ----

{
  let resolveFirstPass;
  const { elements } = buildContext({
    providerProfile: PROVIDER_PROFILE,
    processingConfig: BOTH_PASSES_CONFIG,
    aiResponder: (options) => (options.userPrompt.includes("<transcript>")
      ? new Promise((resolve) => { resolveFirstPass = resolve; })
      : Promise.reject(new Error("second pass rejected")))
  });
  await flush();
  typeTranscript(elements, "hello world");

  elements.finishWorkflowButton.dispatch("click");
  await flush();

  resolveFirstPass("first pass output");
  await flush();
  await flush();
  assert.equal(elements.statusPill.dataset.state, "error");
  assert.equal(elements.statusText.textContent, "Phase 2 failed");
  assert.equal(elements.transcript.value, "hello world", "Finish must not clear the transcript when the second pass fails");
}

// ---- Discard: discarding after "Phase 2 ready" gives "Ready"; discarding while dictating keeps "Listening" ----

{
  const { elements } = buildContext({
    providerProfile: PROVIDER_PROFILE,
    processingConfig: BOTH_PASSES_CONFIG,
    aiResponder: (options) => (options.userPrompt.includes("<transcript>") ? "first pass output" : "second pass output")
  });
  await flush();
  typeTranscript(elements, "hello world");

  elements.firstPassButton.dispatch("click");
  await flush();
  elements.secondPassButton.dispatch("click");
  await flush();
  assert.equal(elements.statusText.textContent, "Phase 2 ready");

  assert.equal(elements.discardResultButton.disabled, false, "discard must be enabled for this dispatched click");
  elements.discardResultButton.dispatch("click");
  assert.equal(elements.statusPill.dataset.state, "idle");
  assert.equal(elements.statusText.textContent, "Ready");
}

{
  const { elements } = buildContext({
    providerProfile: PROVIDER_PROFILE,
    processingConfig: FIRST_PASS_ONLY_CONFIG,
    aiResponder: () => "first pass output"
  });
  await flush();
  typeTranscript(elements, "hello world");

  elements.firstPassButton.dispatch("click");
  await flush();
  assert.equal(elements.statusText.textContent, "Phase 1 ready");

  assert.equal(elements.startButton.disabled, false, "start dictating must be enabled for this dispatched click");
  elements.startButton.dispatch("click");
  assert.equal(elements.statusText.textContent, "Listening");

  elements.discardResultButton.dispatch("click");
  assert.equal(elements.statusPill.dataset.state, "listening", "a discard while dictating must not override Listening (LD-005/EV-003)");
  assert.equal(elements.statusText.textContent, "Listening");
}

// ---- Discard during a pass: discarding while "Phase 1" is in flight keeps processing / "Phase 1"; complete / "Phase 1 ready" when it settles (EV-025, LD-006) ----

{
  let callCount = 0;
  let resolveSecondRun;
  const { elements } = buildContext({
    providerProfile: PROVIDER_PROFILE,
    processingConfig: FIRST_PASS_ONLY_CONFIG,
    aiResponder: () => {
      callCount += 1;
      if (callCount === 1) return "first pass output";
      return new Promise((resolve) => { resolveSecondRun = resolve; });
    }
  });
  await flush();
  typeTranscript(elements, "hello world");

  elements.firstPassButton.dispatch("click");
  await flush();
  assert.equal(elements.statusText.textContent, "Phase 1 ready", "a prior result must already be showing");

  elements.firstPassButton.dispatch("click");
  await flush();
  assert.equal(elements.statusPill.dataset.state, "processing");
  assert.equal(elements.statusText.textContent, "Phase 1");
  assert.equal(elements.discardResultButton.disabled, false, "discard must stay enabled while the first pass runs (EV-025)");

  elements.discardResultButton.dispatch("click");
  assert.equal(elements.statusPill.dataset.state, "processing", "a discard during a pass request must not report Ready while it is still running (LD-006)");
  assert.equal(elements.statusText.textContent, "Phase 1");

  resolveSecondRun("second run output");
  await flush();
  assert.equal(elements.statusPill.dataset.state, "complete");
  assert.equal(elements.statusText.textContent, "Phase 1 ready");
}

// ---- Shortcuts during a pass: Ctrl+Alt+D does nothing while "Phase 1" is in flight (LD-008, LD-009) ----

{
  let resolveFirstPass;
  const { elements, document, speech } = buildContext({
    providerProfile: PROVIDER_PROFILE,
    processingConfig: FIRST_PASS_ONLY_CONFIG,
    aiResponder: () => new Promise((resolve) => { resolveFirstPass = resolve; })
  });
  await flush();
  typeTranscript(elements, "hello world");

  elements.firstPassButton.dispatch("click");
  await flush();
  assert.equal(elements.statusText.textContent, "Phase 1");

  const startCallsBefore = speech.__calls.start;
  // README shortcut: Ctrl + Alt + D, the same action as the disabled start button, while
  // the first pass is in flight (EV-026, LD-008).
  document.dispatch("keydown", { ctrlKey: true, altKey: true, key: "d", preventDefault() {}, target: null });
  assert.equal(speech.__calls.start, startCallsBefore, "Ctrl+Alt+D must not start dictation while a pass runs (LD-008)");
  assert.equal(elements.statusPill.dataset.state, "processing", "the badge must keep showing the running pass (LD-009)");
  assert.equal(elements.statusText.textContent, "Phase 1");
  assert.equal(elements.toastMessage.textContent, "AI processing is already running");

  resolveFirstPass("first pass output");
  await flush();
  assert.equal(elements.statusPill.dataset.state, "complete");
  assert.equal(elements.statusText.textContent, "Phase 1 ready");

  // Once the pass has settled, the same shortcut starts dictation normally.
  assert.equal(elements.startButton.disabled, false, "start dictating must be enabled for this dispatched keydown");
  document.dispatch("keydown", { ctrlKey: true, altKey: true, key: "d", preventDefault() {}, target: null });
  assert.equal(elements.statusPill.dataset.state, "listening");
  assert.equal(elements.statusText.textContent, "Listening");
}

// ---- Shortcuts during a pass: Ctrl+Alt+X does nothing while "Phase 1" is in flight (LD-008, LD-009) ----

{
  let callCount = 0;
  let resolveSecondRun;
  const { elements, document } = buildContext({
    providerProfile: PROVIDER_PROFILE,
    processingConfig: FIRST_PASS_ONLY_CONFIG,
    aiResponder: () => {
      callCount += 1;
      if (callCount === 1) return "first pass output";
      return new Promise((resolve) => { resolveSecondRun = resolve; });
    }
  });
  await flush();
  typeTranscript(elements, "hello world");

  elements.firstPassButton.dispatch("click");
  await flush();
  assert.equal(elements.statusText.textContent, "Phase 1 ready", "a prior result must already be showing");

  elements.firstPassButton.dispatch("click");
  await flush();
  assert.equal(elements.statusPill.dataset.state, "processing");
  assert.equal(elements.statusText.textContent, "Phase 1");

  const transcriptBefore = elements.transcript.value;
  const resultBefore = elements.resultTranscript.value;
  // README shortcut: Ctrl + Alt + X, the same action as the disabled clear button, while
  // the first pass is in flight (EV-025, LD-008).
  document.dispatch("keydown", { ctrlKey: true, altKey: true, key: "x", preventDefault() {}, target: null });
  assert.equal(elements.transcript.value, transcriptBefore, "the transcript must be unchanged (LD-008)");
  assert.equal(elements.resultTranscript.value, resultBefore, "the processed result must be unchanged (LD-008)");
  assert.equal(elements.statusPill.dataset.state, "processing", "the badge must keep showing the running pass (LD-009)");
  assert.equal(elements.statusText.textContent, "Phase 1");
  assert.equal(elements.toastMessage.textContent, "AI processing is already running");

  resolveSecondRun("second run output");
  await flush();
}

// ---- Shortcuts during a pass: Ctrl+Alt+D and Ctrl+Alt+R do nothing while "Phase 2" is in flight (LD-008, LD-009) ----

{
  let resolveSecondPass;
  const { elements, document, speech, clipboard } = buildContext({
    providerProfile: PROVIDER_PROFILE,
    processingConfig: BOTH_PASSES_CONFIG,
    aiResponder: (options) => (options.userPrompt.includes("<transcript>")
      ? "first pass output"
      : new Promise((resolve) => { resolveSecondPass = resolve; }))
  });
  await flush();
  typeTranscript(elements, "hello world");

  elements.firstPassButton.dispatch("click");
  await flush();
  elements.secondPassButton.dispatch("click");
  await flush();
  assert.equal(elements.statusPill.dataset.state, "processing");
  assert.equal(elements.statusText.textContent, "Phase 2");

  const startCallsBefore = speech.__calls.start;
  const clipboardCallsBefore = clipboard.writeCalls;
  document.dispatch("keydown", { ctrlKey: true, altKey: true, key: "d", preventDefault() {}, target: null });
  assert.equal(speech.__calls.start, startCallsBefore, "Ctrl+Alt+D must not start dictation while the second pass runs (LD-008)");
  assert.equal(elements.statusPill.dataset.state, "processing", "the badge must keep showing the running pass (LD-009)");
  assert.equal(elements.statusText.textContent, "Phase 2");
  assert.equal(elements.toastMessage.textContent, "AI processing is already running");

  // F1: clear the fake DOM's observation point so the assertion below can only pass if
  // the Ctrl+Alt+R keydown itself set the toast, not the Ctrl+Alt+D keydown above it.
  elements.toastMessage.textContent = "";
  document.dispatch("keydown", { ctrlKey: true, altKey: true, key: "r", preventDefault() {}, target: null });
  assert.equal(clipboard.writeCalls, clipboardCallsBefore, "Ctrl+Alt+R must not copy while the second pass runs (LD-008)");
  assert.equal(elements.statusPill.dataset.state, "processing");
  assert.equal(elements.statusText.textContent, "Phase 2");
  assert.equal(elements.toastMessage.textContent, "AI processing is already running");

  resolveSecondPass("second pass output");
  await flush();
  assert.equal(elements.statusPill.dataset.state, "complete");
  assert.equal(elements.statusText.textContent, "Phase 2 ready");

  assert.equal(elements.copyResultButton.disabled, false, "copy result must be enabled for this dispatched keydown");
  document.dispatch("keydown", { ctrlKey: true, altKey: true, key: "r", preventDefault() {}, target: null });
  await flush();
  assert.equal(clipboard.writeCalls, clipboardCallsBefore + 1, "Ctrl+Alt+R must copy exactly once once the pass has settled");
}

console.log("Full-page Local Whisper dictation integration, Browser Dictation regression, ordering guarantees, and AI-pass status badge verified.");
