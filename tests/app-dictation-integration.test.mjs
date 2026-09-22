import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(extensionRoot, file), "utf8");
const settingsSource = read("dictationSettings.js");
const appSource = read("app.js");

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
  "secondPassButton", "secondPassLabel", "copyResultButton", "discardResultButton"
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

function createFakeAiClient(responder) {
  const calls = [];
  return {
    calls,
    generate(options) {
      calls.push(options);
      return Promise.resolve(responder ? responder(options) : "processed result");
    }
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function buildContext({ provider = "browser", aiResponder, processingConfig } = {}) {
  const { document, elements } = buildFakeDom();
  const chrome = createFakeChrome();
  const speech = createFakeSpeech();
  const aiClient = createFakeAiClient(aiResponder);
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

  const context = vm.createContext({
    chrome,
    console,
    Error,
    Map,
    Promise,
    document,
    window: windowStub,
    localStorage,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    crypto: { randomUUID: () => `uuid-${uuidCounter += 1}` },
    SaySlateAnimations: animations,
    SaySlateSpeech: speech,
    SaySlateAIClient: aiClient
  });

  vm.runInContext(settingsSource, context);
  if (provider === "local-whisper") {
    chrome.__setLocalWhisperSettings({ provider: "local-whisper", bearerToken: "unused-in-this-harness", previewMs: 2000 });
  }
  if (processingConfig) {
    chrome.storage.local.set({ "sayslate-grammar-config": processingConfig }, () => {});
  }
  vm.runInContext(appSource, context);

  return { context, document, elements, chrome, speech, aiClient, windowStub };
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
      apiKey: "key", model: "model", firstPassPrompt: "First pass prompt", secondPassPrompt: "", secondPassEnabled: false, promptSchemaVersion: 3
    }
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
    aiClient.calls[0].prompt,
    "First pass prompt\n\n<transcript>\ndictated content\n</transcript>",
    "the exact first-pass prompt construction must be unchanged for Local Whisper transcripts"
  );
}

// ---- Local Whisper: a stop settlement failure preserves the transcript and shows an explicit error ----

{
  const { elements, chrome, aiClient } = buildContext({
    provider: "local-whisper",
    processingConfig: {
      apiKey: "key", model: "model", firstPassPrompt: "First pass prompt", secondPassPrompt: "", secondPassEnabled: false, promptSchemaVersion: 3
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
      apiKey: "key", model: "model", firstPassPrompt: "First pass prompt", secondPassPrompt: "", secondPassEnabled: false, promptSchemaVersion: 3
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
      apiKey: "key", model: "model", firstPassPrompt: "First pass prompt", secondPassPrompt: "Second pass prompt",
      secondPassEnabled: true, promptSchemaVersion: 3
    },
    aiResponder: (options) => (options.prompt.includes("<transcript>") ? "first pass output" : "second pass output")
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
    aiClient.calls[0].prompt,
    "First pass prompt\n\n<transcript>\ndictated content\n</transcript>",
    "first-pass prompt construction is unchanged"
  );
  assert.equal(
    aiClient.calls[1].prompt,
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

console.log("Full-page Local Whisper dictation integration, Browser Dictation regression, and ordering guarantees verified.");
