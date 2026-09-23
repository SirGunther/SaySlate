// WSI-06 integration coverage: floating.js and floatingSpeechClient.js loaded together
// (plus the real dictationSettings.js so the persisted provider is genuinely read from
// storage, exactly as floating.html now wires it), driven through the same DOM entry
// points a user would use (button clicks, offscreen push events) rather than calling
// floatingSpeechClient.js's API directly. tests/floating-speech-client.test.mjs already
// covers floatingSpeechClient.js's own routing/aggregation/settlement logic in isolation;
// this file proves floating.js's Finish/Clear/close orchestration keeps working unchanged
// for both providers once wired to it for real.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dictationSettingsSource = fs.readFileSync(path.join(extensionRoot, "dictationSettings.js"), "utf8");
const floatingSpeechClientSource = fs.readFileSync(path.join(extensionRoot, "floatingSpeechClient.js"), "utf8");
const floatingSource = fs.readFileSync(path.join(extensionRoot, "floating.js"), "utf8");
// SAYAI-05: floating.js now resolves the active profile via the real LD-023/LD-024/LD-025
// provider modules (loaded here exactly as floating.html now orders them) and calls the
// shared dispatcher instead of a fake SaySlateAIClient.generate call.
const aiProviderRegistrySource = fs.readFileSync(path.join(extensionRoot, "aiProviderRegistry.js"), "utf8");
const aiProviderPermissionsSource = fs.readFileSync(path.join(extensionRoot, "aiProviderPermissions.js"), "utf8");
const aiProviderSettingsSource = fs.readFileSync(path.join(extensionRoot, "aiProviderSettings.js"), "utf8");
const aiProviderClientSource = fs.readFileSync(path.join(extensionRoot, "aiProviderClient.js"), "utf8");

function createElement(id) {
  const listeners = {};
  const el = {
    id,
    dataset: {},
    disabled: false,
    hidden: false,
    readOnly: false,
    value: "",
    textContent: "",
    className: "",
    scrollTop: 0,
    scrollHeight: 0,
    classList: {
      names: new Set(),
      toggle(name, on) {
        if (on) this.names.add(name);
        else this.names.delete(name);
      },
      contains(name) {
        return this.names.has(name);
      }
    },
    addEventListener(type, handler) {
      (listeners[type] ||= []).push(handler);
    },
    setAttribute(name, value) {
      el[`attr_${name}`] = String(value);
    },
    focus() {},
    select() {},
    setSelectionRange() {},
    dispatch(type, event = {}) {
      for (const handler of (listeners[type] || [])) handler(event);
    }
  };
  return el;
}

function buildFakeDom() {
  const registry = new Map();
  const documentListeners = {};

  function register(id) {
    const el = createElement(id);
    registry.set(`#${id}`, el);
    return el;
  }

  const elements = {
    transcript: register("transcript"),
    wordCount: register("wordCount"),
    status: register("status"),
    statusText: register("statusText"),
    notice: register("notice"),
    closeButton: register("closeButton"),
    dictateButton: register("dictateButton"),
    finishButton: register("finishButton"),
    chatGPTSubmitButton: register("chatGPTSubmitButton"),
    firstPassButton: register("firstPassButton"),
    secondPassButton: register("secondPassButton"),
    copyButton: register("copyButton"),
    clearButton: register("clearButton")
  };
  elements.notice.hidden = true;

  const document = {
    querySelector(selector) {
      return registry.get(selector) || null;
    },
    addEventListener(type, handler) {
      (documentListeners[type] ||= []).push(handler);
    },
    dispatch(type, event = {}) {
      for (const handler of (documentListeners[type] || [])) handler(event);
    }
  };

  return { document, elements };
}

function buildFakeChrome(initialLocalStore = {}) {
  const localStore = { ...initialLocalStore };
  const sentMessages = [];
  const insertCalls = [];
  const listeners = [];
  let nextLocalWhisperStart = { ok: true };
  let nextLocalWhisperStop = { ok: true, reason: "session-closed" };
  let nextInsertResponse = { ok: true, mode: "inserted", message: "Inserted" };

  async function sendMessage(message) {
    sentMessages.push(message);
    if (message.type === "sayslate-local-whisper-command") {
      if (message.action === "start") return nextLocalWhisperStart;
      if (message.action === "stop") return nextLocalWhisperStop;
      return { ok: true };
    }
    if (message.type === "sayslate-floating-speech-command") {
      if (message.action === "start") return { ok: true };
      if (message.action === "stop") return { ok: true, sessionEnd: { explicit: true, retrying: false } };
      return { ok: true };
    }
    if (message.type === "sayslate-floating-command") {
      if (message.action === "close") return { ok: true };
      insertCalls.push(message);
      return nextInsertResponse;
    }
    return { ok: true };
  }

  const chrome = {
    runtime: {
      onMessage: {
        addListener(listener) { listeners.push(listener); },
        removeListener(listener) {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        }
      },
      sendMessage
    },
    storage: {
      local: {
        get(key, callback) {
          const result = { [key]: localStore[key] };
          if (callback) {
            callback(result);
            return undefined;
          }
          return Promise.resolve(result);
        },
        set(entries, callback) {
          Object.assign(localStore, entries);
          if (callback) {
            callback();
            return undefined;
          }
          return Promise.resolve();
        }
      },
      onChanged: { addListener() {} }
    },
    // LD-034: auto-grant - permission-prompt behavior is ai-provider-permissions.test.mjs's
    // boundary, not this file's.
    permissions: {
      contains(_query, callback) { callback(true); },
      request(_query, callback) { callback(true); }
    }
  };

  return {
    chrome,
    listeners,
    sentMessages,
    insertCalls,
    localStore,
    dispatchToAllListeners(message) {
      for (const listener of listeners) listener(message, {}, () => {});
    },
    setNextLocalWhisperStart(response) { nextLocalWhisperStart = response; },
    setNextLocalWhisperStop(response) { nextLocalWhisperStop = response; },
    setNextInsertResponse(response) { nextInsertResponse = response; }
  };
}

// SAYAI-05: seeds the LD-023 provider-profile record directly, the same shape
// aiProviderSettings.js itself persists, so a scenario can start with an active profile
// without driving the full-page Save form.
function seedProviderProfile(fakeChrome, {
  id = "profile-1",
  providerKind = "gemini",
  endpoint = "https://generativelanguage.googleapis.com/v1beta",
  modelId = "model",
  credential = "key"
} = {}) {
  fakeChrome.localStore["sayslate-ai-provider-profiles"] = {
    version: 1,
    activeProfileId: id,
    profiles: [{ id, name: `${providerKind} · ${modelId}`, providerKind, endpoint, modelId, credential }]
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const DEFAULT_GRAMMAR_CONFIG = Object.freeze({
  firstPassPrompt: "Clean this up", secondPassPrompt: "", secondPassEnabled: false
});

function buildEnvironment({ session = "int-session-1", grammarConfig = DEFAULT_GRAMMAR_CONFIG, providerProfile = {} } = {}) {
  const { document, elements } = buildFakeDom();
  const fakeChrome = buildFakeChrome({ "sayslate-grammar-config": grammarConfig });
  seedProviderProfile(fakeChrome, providerProfile);
  const aiCalls = [];
  const windowListeners = {};

  const context = vm.createContext({
    chrome: fakeChrome.chrome,
    document,
    location: { search: `?session=${session}&surface=other` },
    URLSearchParams,
    URL,
    console,
    setTimeout,
    clearTimeout,
    crypto: { randomUUID: () => `uuid-${Math.random().toString(16).slice(2)}` },
    navigator: { clipboard: { writeText: async () => {} } },
    // SAYAI-05: floating.js's gemini-native pass calls
    // globalThis.SaySlateAIClient.generateStructured({ ..., userPrompt, ... }) through the
    // real aiProviderClient.js dispatcher loaded below - this fake stands in for the adapter
    // boundary so these scenarios stay focused on floating.js's own wiring.
    SaySlateAIClient: {
      async generateStructured({ userPrompt }) {
        aiCalls.push(userPrompt);
        return "PROCESSED TEXT";
      }
    },
    // Minimal stand-in for shortcutProtocol.js - only isEscapeEvent is needed since these
    // scenarios drive dictate/finish/clear via direct button clicks rather than key chords.
    SaySlateFloatingShortcuts: {
      isEscapeEvent: (event) => event?.key === "Escape",
      actionKeyFromEvent: () => "",
      messageKey: () => ""
    },
    addEventListener(type, listener) {
      (windowListeners[type] ||= []).push(listener);
    }
  });

  // SAYAI-05: real LD-023/LD-024/LD-025 provider modules, loaded in the same producer-
  // before-consumer order floating.html now uses, ahead of floating.js itself.
  vm.runInContext(aiProviderRegistrySource, context);
  vm.runInContext(aiProviderPermissionsSource, context);
  vm.runInContext(aiProviderSettingsSource, context);
  vm.runInContext(aiProviderClientSource, context);

  vm.runInContext(dictationSettingsSource, context);
  vm.runInContext(floatingSpeechClientSource, context);
  vm.runInContext(floatingSource, context);

  return { context, document, elements, fakeChrome, aiCalls, windowListeners, settingsApi: context.SaySlateDictationSettings };
}

// ---- Browser Dictation regression: unchanged end-to-end through the real floating.js ----

{
  const env = buildEnvironment({ session: "int-session-1" });
  await flush();
  await flush();

  assert.equal(env.settingsApi.getSnapshot().provider, env.settingsApi.PROVIDERS.BROWSER);

  env.elements.dictateButton.dispatch("click");
  await flush();
  assert.equal(env.fakeChrome.sentMessages.at(-1).type, "sayslate-floating-speech-command");
  assert.equal(env.fakeChrome.sentMessages.at(-1).action, "start");

  env.fakeChrome.dispatchToAllListeners({
    type: "sayslate-offscreen-speech-event", target: "floating", sessionId: "int-session-1",
    event: "start", payload: { recovered: false }
  });
  env.fakeChrome.dispatchToAllListeners({
    type: "sayslate-offscreen-speech-event", target: "floating", sessionId: "int-session-1",
    event: "result", payload: { finalText: "hello world", interimText: "" }
  });
  assert.equal(env.elements.transcript.value, "hello world");

  env.elements.finishButton.dispatch("click");
  await flush();
  await flush();
  await flush();
  assert.equal(env.fakeChrome.sentMessages.some((message) => message.type === "sayslate-floating-speech-command" && message.action === "stop"), true);
  assert.equal(env.aiCalls.length, 1, "the single enabled AI pass must run once");
  assert.match(env.aiCalls[0], /hello world/);
  const insertMessage = env.fakeChrome.insertCalls.at(-1);
  assert.equal(insertMessage.type, "sayslate-floating-command");
  assert.equal(insertMessage.action, "insert");
  assert.equal(insertMessage.text, "PROCESSED TEXT");
}

// ---- Local Whisper: end-to-end through the real floating.js, including Finish ordering ----

{
  const env = buildEnvironment({ session: "int-session-2" });
  await env.settingsApi.load();
  await env.settingsApi.saveProvider(env.settingsApi.PROVIDERS.LOCAL_WHISPER);
  await flush();
  await flush();
  assert.equal(env.settingsApi.getSnapshot().provider, env.settingsApi.PROVIDERS.LOCAL_WHISPER);

  env.elements.dictateButton.dispatch("click");
  await flush();
  const startMessage = env.fakeChrome.sentMessages.at(-1);
  assert.equal(startMessage.type, "sayslate-local-whisper-command");
  assert.equal(startMessage.origin, "floating");
  // The wire-level run id is generated fresh per run inside floatingSpeechClient.js and is
  // never the floating window's own fixed session id - captured here rather than assumed.
  const runId = startMessage.sessionId;
  assert.equal(typeof runId, "string");
  assert.ok(runId.length > 0);
  assert.equal(env.elements.transcript.readOnly, true, "the transcript must be locked while Local Whisper is listening");

  env.fakeChrome.dispatchToAllListeners({
    type: "sayslate-offscreen-local-whisper-event", target: "floating", sessionId: runId,
    event: "partial", payload: { utteranceId: "u1", revision: 1, text: "hel" }
  });
  assert.equal(env.elements.transcript.value, "hel");

  env.fakeChrome.dispatchToAllListeners({
    type: "sayslate-offscreen-local-whisper-event", target: "floating", sessionId: runId,
    event: "final", payload: { utteranceId: "u1", text: "hello there" }
  });
  assert.equal(env.elements.transcript.value, "hello there");

  // Finish must await the definitive Local Whisper stop settlement before AI processing or
  // insertion begins - simulate a slow stop response and confirm nothing downstream fires
  // until it resolves.
  let releaseStop;
  const originalSendMessage = env.fakeChrome.chrome.runtime.sendMessage;
  env.fakeChrome.chrome.runtime.sendMessage = async (message) => {
    if (message.type === "sayslate-local-whisper-command" && message.action === "stop") {
      env.fakeChrome.sentMessages.push(message);
      await new Promise((resolve) => { releaseStop = resolve; });
      return { ok: true, reason: "session-closed" };
    }
    return originalSendMessage(message);
  };

  env.elements.finishButton.dispatch("click");
  await flush();
  await flush();
  assert.equal(env.aiCalls.length, 0, "AI processing must not start before the stop settles");
  assert.equal(env.fakeChrome.insertCalls.length, 0, "insertion must not happen before the stop settles");

  releaseStop();
  await flush();
  await flush();
  await flush();
  assert.equal(env.aiCalls.length, 1, "AI processing must start once the stop has settled");
  assert.match(env.aiCalls[0], /hello there/);
  const insertMessage = env.fakeChrome.insertCalls.at(-1);
  assert.equal(insertMessage.type, "sayslate-floating-command");
  assert.equal(insertMessage.text, "PROCESSED TEXT");
  assert.equal(env.elements.transcript.readOnly, false, "the transcript must unlock once dictation has stopped");
}

// ---- Local Whisper start failure: explicit error, never a silent fallback ----

{
  const env = buildEnvironment({ session: "int-session-3" });
  await env.settingsApi.load();
  await env.settingsApi.saveProvider(env.settingsApi.PROVIDERS.LOCAL_WHISPER);
  await flush();
  await flush();

  env.fakeChrome.setNextLocalWhisperStart({ ok: false, code: "unauthorized", message: "Local Whisper has no saved token." });
  env.elements.dictateButton.dispatch("click");
  await flush();
  await flush();

  assert.equal(env.elements.status.dataset.state, "error");
  assert.equal(env.elements.notice.textContent, "Local Whisper has no saved token.");
  assert.equal(
    env.fakeChrome.sentMessages.some((message) => message.type === "sayslate-floating-speech-command"),
    false,
    "a failed Local Whisper start must never fall back to Browser Dictation"
  );
}

// ---- Clear cancels Local Whisper and erases the transcript without inserting anything ----

{
  const env = buildEnvironment({ session: "int-session-4" });
  await env.settingsApi.load();
  await env.settingsApi.saveProvider(env.settingsApi.PROVIDERS.LOCAL_WHISPER);
  await flush();
  await flush();

  env.elements.dictateButton.dispatch("click");
  await flush();
  const runId = env.fakeChrome.sentMessages.at(-1).sessionId;
  env.fakeChrome.dispatchToAllListeners({
    type: "sayslate-offscreen-local-whisper-event", target: "floating", sessionId: runId,
    event: "partial", payload: { utteranceId: "u1", revision: 1, text: "should not survive" }
  });
  assert.equal(env.elements.transcript.value, "should not survive");

  env.elements.clearButton.dispatch("click");
  assert.equal(env.elements.transcript.value, "");
  const cancelMessage = env.fakeChrome.sentMessages.at(-1);
  assert.equal(cancelMessage.type, "sayslate-local-whisper-command");
  assert.equal(cancelMessage.action, "cancel");
  assert.equal(cancelMessage.sessionId, runId);
  await flush();

  // A late event for the cancelled run must not resurrect any text.
  env.fakeChrome.dispatchToAllListeners({
    type: "sayslate-offscreen-local-whisper-event", target: "floating", sessionId: runId,
    event: "final", payload: { utteranceId: "u1", text: "should not survive" }
  });
  assert.equal(env.elements.transcript.value, "");
  assert.equal(env.fakeChrome.insertCalls.length, 0);
}

// ---- Local Whisper offline/unavailable start failure: explicit error, never a silent fallback ----

{
  const env = buildEnvironment({ session: "int-session-5" });
  await env.settingsApi.load();
  await env.settingsApi.saveProvider(env.settingsApi.PROVIDERS.LOCAL_WHISPER);
  await flush();
  await flush();

  env.fakeChrome.setNextLocalWhisperStart({ ok: false, code: "unavailable", message: "WhisperService is offline or unreachable." });
  env.elements.dictateButton.dispatch("click");
  await flush();
  await flush();

  assert.equal(env.elements.status.dataset.state, "error");
  assert.equal(env.elements.notice.textContent, "WhisperService is offline or unreachable.");
  assert.equal(env.elements.transcript.readOnly, false, "the transcript must not be left locked after an offline start failure");
  assert.equal(
    env.fakeChrome.sentMessages.some((message) => message.type === "sayslate-floating-speech-command"),
    false,
    "an offline Local Whisper start must never fall back to Browser Dictation"
  );
}

// ---- Failed Stop must block Finish from processing/inserting an unconfirmed transcript ----

{
  const env = buildEnvironment({ session: "int-session-6" });
  await env.settingsApi.load();
  await env.settingsApi.saveProvider(env.settingsApi.PROVIDERS.LOCAL_WHISPER);
  await flush();
  await flush();

  env.elements.dictateButton.dispatch("click");
  await flush();
  const runId = env.fakeChrome.sentMessages.at(-1).sessionId;
  env.fakeChrome.dispatchToAllListeners({
    type: "sayslate-offscreen-local-whisper-event", target: "floating", sessionId: runId,
    event: "final", payload: { utteranceId: "u1", text: "uncertain text" }
  });

  env.fakeChrome.setNextLocalWhisperStop({ ok: false, reason: "timeout" });
  env.elements.finishButton.dispatch("click");
  await flush();
  await flush();
  await flush();

  assert.equal(env.aiCalls.length, 0, "a failed stop settlement must never let Finish start AI processing");
  assert.equal(env.fakeChrome.insertCalls.length, 0, "a failed stop settlement must never let Finish insert/submit");
  assert.equal(env.elements.transcript.value, "uncertain text", "the captured text must be preserved, not cleared, after a failed stop");
  assert.equal(env.elements.status.dataset.state, "error");
  assert.match(env.elements.notice.textContent, /kept/i);
}

// ---- Escape cancels Local Whisper and closes the floating window without inserting ----

{
  const env = buildEnvironment({ session: "int-session-7" });
  await env.settingsApi.load();
  await env.settingsApi.saveProvider(env.settingsApi.PROVIDERS.LOCAL_WHISPER);
  await flush();
  await flush();

  env.elements.dictateButton.dispatch("click");
  await flush();
  const runId = env.fakeChrome.sentMessages.at(-1).sessionId;
  env.fakeChrome.dispatchToAllListeners({
    type: "sayslate-offscreen-local-whisper-event", target: "floating", sessionId: runId,
    event: "partial", payload: { utteranceId: "u1", revision: 1, text: "should not be inserted" }
  });

  env.document.dispatch("keydown", { key: "Escape", preventDefault() {}, stopImmediatePropagation() {} });
  await flush();

  const cancelMessage = env.fakeChrome.sentMessages.find((message) => message.type === "sayslate-local-whisper-command" && message.action === "cancel");
  assert.ok(cancelMessage, "Escape must cancel the active Local Whisper run");
  assert.equal(cancelMessage.sessionId, runId);
  const closeMessage = env.fakeChrome.sentMessages.find((message) => message.type === "sayslate-floating-command" && message.action === "close");
  assert.ok(closeMessage, "Escape must ask the host to close the floating window");
  assert.equal(env.fakeChrome.insertCalls.length, 0, "Escape must never insert or submit anything");
}

// ---- beforeunload cancels an active Local Whisper run and tears the client down ----

{
  const env = buildEnvironment({ session: "int-session-8" });
  await env.settingsApi.load();
  await env.settingsApi.saveProvider(env.settingsApi.PROVIDERS.LOCAL_WHISPER);
  await flush();
  await flush();

  env.elements.dictateButton.dispatch("click");
  await flush();
  const runId = env.fakeChrome.sentMessages.at(-1).sessionId;
  env.fakeChrome.dispatchToAllListeners({
    type: "sayslate-offscreen-local-whisper-event", target: "floating", sessionId: runId,
    event: "partial", payload: { utteranceId: "u1", revision: 1, text: "should not survive" }
  });

  const beforeunloadListeners = env.windowListeners.beforeunload || [];
  assert.equal(beforeunloadListeners.length, 1, "floating.js must register exactly one beforeunload listener");
  beforeunloadListeners[0]();

  const cancelMessage = env.fakeChrome.sentMessages.at(-1);
  assert.equal(cancelMessage.type, "sayslate-local-whisper-command");
  assert.equal(cancelMessage.action, "cancel");
  assert.equal(cancelMessage.sessionId, runId, "beforeunload's cancel must target the run that was actually active");
  await flush();

  // destroy() removes floatingSpeechClient.js's own message listener, so a further event for
  // the same run must have no observable effect at all - not even a late transcript update.
  const messageCountBefore = env.fakeChrome.sentMessages.length;
  env.fakeChrome.dispatchToAllListeners({
    type: "sayslate-offscreen-local-whisper-event", target: "floating", sessionId: runId,
    event: "final", payload: { utteranceId: "u1", text: "should not survive" }
  });
  assert.equal(env.elements.transcript.value, "should not survive", "the document is unloading - nothing further should change the transcript");
  assert.equal(env.fakeChrome.sentMessages.length, messageCountBefore, "no further commands should be sent once destroy() has run");
}

// ---- F3 regression: a synchronous double trigger on the floating surface must issue exactly one generation request ----
// runFirstPass used to await resolveActiveProfile() before claiming the `processing` guard,
// so a second trigger arriving in that window passed the reentry guard and issued a second
// real request.

{
  const env = buildEnvironment({ session: "int-session-f3" });
  await flush();
  await flush();

  env.elements.transcript.value = "double trigger source text";
  env.elements.transcript.dispatch("input");

  const before = env.aiCalls.length;
  // Two synchronous dispatches, deliberately with no await between them.
  env.elements.firstPassButton.dispatch("click");
  env.elements.firstPassButton.dispatch("click");
  await flush();
  await flush();
  await flush();
  assert.equal(env.aiCalls.length - before, 1, "F3: a synchronous double trigger on the floating surface must produce exactly one generation request");
}

console.log("Floating dictation integration (both providers, Finish ordering, failed-stop blocking, Escape/Clear cancellation, beforeunload teardown, and no-fallback errors) verified.");
