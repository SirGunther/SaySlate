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
const shortcutProtocolSource = fs.readFileSync(path.join(extensionRoot, "shortcutProtocol.js"), "utf8");
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
    clearButton: register("clearButton"),
    restoreButton: register("restoreButton")
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
  const storageChangeListeners = [];
  const heldGets = new Map();
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
          // A held key answers only once its hold is released, with the value stored then.
          const held = heldGets.get(key);
          if (held) {
            const late = held.then(() => ({ [key]: localStore[key] }));
            if (callback) {
              void late.then(callback);
              return undefined;
            }
            return late;
          }
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
      // SAYREASON-02: a real listener registry (not a no-op) so a scenario can prove
      // floating.js's live storage-change path, the same way dispatchToAllListeners already
      // proves its runtime.onMessage path below.
      onChanged: {
        addListener(listener) { storageChangeListeners.push(listener); },
        removeListener(listener) {
          const index = storageChangeListeners.indexOf(listener);
          if (index >= 0) storageChangeListeners.splice(index, 1);
        }
      }
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
    // Same delivery as dispatchToAllListeners, returning every sendResponse payload.
    deliverMessage(message) {
      const responses = [];
      for (const listener of listeners) listener(message, {}, (response) => responses.push(response));
      return responses;
    },
    holdLocalGet(key) {
      let release;
      heldGets.set(key, new Promise((resolve) => { release = resolve; }));
      return () => {
        heldGets.delete(key);
        release();
      };
    },
    fireStorageChange(changes, area = "local") {
      for (const listener of storageChangeListeners) listener(changes, area);
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

// Stands in for the frame's timers so a scenario can step across the 700 ms close delay
// instead of waiting on the wall clock.
function createManualClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(callback, delay = 0, ...args) {
      const id = nextId++;
      timers.set(id, { at: now + Number(delay || 0), callback, args });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      now += ms;
      const due = [...timers].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.callback(...timer.args);
      }
    }
  };
}

// aiRespond: what each AI pass returns (or throws) for its userPrompt. holdConfigLoad: the
// stored processing config answers only after env.releaseConfigLoad(). clock: a manual clock
// standing in for the frame's setTimeout/clearTimeout.
function buildEnvironment({
  session = "int-session-1",
  grammarConfig = DEFAULT_GRAMMAR_CONFIG,
  providerProfile = {},
  extraStore = {},
  aiRespond = () => "PROCESSED TEXT",
  holdConfigLoad = false,
  clock = null
} = {}) {
  const { document, elements } = buildFakeDom();
  const fakeChrome = buildFakeChrome({ "sayslate-grammar-config": grammarConfig, ...extraStore });
  seedProviderProfile(fakeChrome, providerProfile);
  const releaseConfigLoad = holdConfigLoad ? fakeChrome.holdLocalGet("sayslate-grammar-config") : () => {};
  const aiCalls = [];
  const reasoningCalls = [];
  const windowListeners = {};

  const context = vm.createContext({
    chrome: fakeChrome.chrome,
    document,
    location: { search: `?session=${session}&surface=other` },
    URLSearchParams,
    URL,
    console,
    setTimeout: clock ? clock.setTimeout : setTimeout,
    clearTimeout: clock ? clock.clearTimeout : clearTimeout,
    crypto: { randomUUID: () => `uuid-${Math.random().toString(16).slice(2)}` },
    navigator: { clipboard: { writeText: async () => {} } },
    // SAYAI-05: floating.js's gemini-native pass calls
    // globalThis.SaySlateAIClient.generateStructured({ ..., userPrompt, ... }) through the
    // real aiProviderClient.js dispatcher loaded below - this fake stands in for the adapter
    // boundary so these scenarios stay focused on floating.js's own wiring.
    SaySlateAIClient: {
      async generateStructured({ userPrompt }) {
        aiCalls.push(userPrompt);
        return aiRespond(userPrompt);
      }
    },
    // SAYREASON-02: stands in for the OpenAI-compatible adapter boundary (the same boundary
    // SaySlateAIClient fakes above for Gemini), so a Custom-profile scenario can drive the
    // real aiProviderClient.js dispatcher and observe the reasoningEffort it computed from
    // the saved per-pass switch, without a real /chat/completions transport.
    SaySlateOpenAICompatibleClient: {
      async generate({ userPrompt, reasoningEffort }) {
        aiCalls.push(userPrompt);
        reasoningCalls.push(reasoningEffort);
        return aiRespond(userPrompt);
      }
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
  // The real shortcut protocol, in floating.html's order, so the frame's message listener
  // recognizes shortcut and selection messages exactly as it does in the extension.
  vm.runInContext(shortcutProtocolSource, context);
  vm.runInContext(floatingSource, context);

  return {
    context, document, elements, fakeChrome, aiCalls, reasoningCalls, windowListeners, releaseConfigLoad, clock,
    shortcuts: context.SaySlateFloatingShortcuts,
    settingsApi: context.SaySlateDictationSettings
  };
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

// ---- SAYREASON-02: Finish sends each pass's own saved reasoning setting on a Custom profile ----

{
  const env = buildEnvironment({
    session: "int-session-reasoning-finish",
    grammarConfig: {
      firstPassPrompt: "Clean this up",
      secondPassPrompt: "Polish this",
      secondPassEnabled: true,
      firstPassReasoning: true,
      secondPassReasoning: false
    },
    providerProfile: { providerKind: "custom", endpoint: "https://lmstudio.example-tailnet.ts.net/v1", modelId: "local-model" }
  });
  await flush();
  await flush();

  env.elements.transcript.value = "finish reasoning source text";
  env.elements.transcript.dispatch("input");

  env.elements.finishButton.dispatch("click");
  await flush();
  await flush();
  await flush();

  assert.equal(env.reasoningCalls.length, 2, "Finish must run both passes through the real dispatcher when the second pass is enabled");
  assert.equal(env.reasoningCalls[0], "medium", "the first pass sends \"medium\" when firstPassReasoning is on");
  assert.equal(env.reasoningCalls[1], "none", "the second pass sends \"none\" when secondPassReasoning is off");
  const insertMessage = env.fakeChrome.insertCalls.at(-1);
  assert.equal(insertMessage.action, "insert");
  assert.equal(insertMessage.text, "PROCESSED TEXT");
}

// ---- SAYREASON-02: a live storage change to secondPassReasoning is used by the next second pass ----

{
  const env = buildEnvironment({
    session: "int-session-reasoning-live",
    grammarConfig: {
      firstPassPrompt: "Clean this up",
      secondPassPrompt: "Polish this",
      secondPassEnabled: true,
      firstPassReasoning: false,
      secondPassReasoning: false
    },
    providerProfile: { providerKind: "custom", endpoint: "https://lmstudio.example-tailnet.ts.net/v1", modelId: "local-model" }
  });
  await flush();
  await flush();

  env.elements.transcript.value = "live update source text";
  env.elements.transcript.dispatch("input");
  env.elements.firstPassButton.dispatch("click");
  await flush();
  await flush();
  assert.equal(env.reasoningCalls.at(-1), "none", "the first pass sends \"none\" before the live storage change");

  // The real chrome.storage.onChanged listener floating.js registers (floating.js:450-454)
  // picks this up - the same live-update path the full page's save relies on for
  // prompts/enable to reach an already-open Floating Slate window.
  const nextConfig = {
    firstPassPrompt: "Clean this up",
    secondPassPrompt: "Polish this",
    secondPassEnabled: true,
    firstPassReasoning: false,
    secondPassReasoning: true
  };
  env.fakeChrome.localStore["sayslate-grammar-config"] = nextConfig;
  env.fakeChrome.fireStorageChange({ "sayslate-grammar-config": { newValue: nextConfig } });

  env.elements.secondPassButton.dispatch("click");
  await flush();
  await flush();
  assert.equal(env.reasoningCalls.at(-1), "medium", "a live storage change that turns secondPassReasoning on makes the next second pass send \"medium\"");
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

// ---- LD-044: Finish saves the dictation before the pass replaces it; Restore brings it back ----

{
  const env = buildEnvironment({ session: "int-session-restore" });
  await flush();
  await flush();

  assert.equal(env.elements.restoreButton.disabled, true, "nothing saved yet, so Restore starts disabled");

  env.elements.transcript.value = "my original dictation with every word";
  env.elements.transcript.dispatch("input");
  env.elements.finishButton.dispatch("click");
  await flush();
  await flush();
  await flush();

  assert.equal(env.fakeChrome.insertCalls.at(-1).text, "PROCESSED TEXT");
  assert.equal(env.elements.transcript.value, "PROCESSED TEXT", "the pass result replaces the dictation in the box");
  assert.equal(env.fakeChrome.localStore["sayslate-floating-last-dictation"].text, "my original dictation with every word", "the dictation is saved before the pass replaces it");
  assert.equal(env.elements.restoreButton.disabled, false, "Restore is available once the dictation was replaced");

  env.elements.restoreButton.dispatch("click");
  assert.equal(env.elements.transcript.value, "my original dictation with every word", "Restore puts the original dictation back");
  assert.equal(env.elements.restoreButton.disabled, true, "Restore disables once the box already holds the saved dictation");

  // A restored dictation is raw text again: the next pass runs on it, not on the old result.
  env.elements.firstPassButton.dispatch("click");
  await flush();
  await flush();
  assert.ok(env.aiCalls.at(-1).includes("my original dictation with every word"), "a pass after Restore processes the restored dictation");

  console.log("LD-044 Finish saves the dictation and Restore brings it back verified.");
}

// ---- LD-044: a reopened Floating Slate can restore the dictation saved by the last one; Clear keeps it ----

{
  const env = buildEnvironment({
    session: "int-session-restore-reopen",
    extraStore: { "sayslate-floating-last-dictation": { text: "dictation from before the overlay closed", savedAt: "2026-11-23T16:10:23.000Z" } }
  });
  await flush();
  await flush();

  assert.equal(env.elements.restoreButton.disabled, false, "a saved dictation from an earlier Floating Slate is restorable on open");

  env.elements.transcript.value = "something new";
  env.elements.transcript.dispatch("input");
  env.elements.clearButton.dispatch("click");
  assert.equal(env.elements.restoreButton.disabled, false, "Clear does not remove the saved dictation");

  env.elements.restoreButton.dispatch("click");
  assert.equal(env.elements.transcript.value, "dictation from before the overlay closed");

  console.log("LD-044 reopen-and-restore and Clear-keeps-saved-dictation verified.");
}

// ---- LD-043: a cut-off Custom pass leaves the dictation in place and says it was cut off ----

{
  const env = buildEnvironment({
    session: "int-session-cut-off",
    providerProfile: { providerKind: "custom", endpoint: "https://lmstudio.example-tailnet.ts.net/v1", modelId: "local-model" }
  });
  await flush();
  await flush();

  env.context.SaySlateOpenAICompatibleClient = {
    async generate() {
      const error = new Error("The AI result was cut off before it finished.");
      error.code = "malformed_response";
      error.cutOff = true;
      throw error;
    }
  };

  env.elements.transcript.value = "the status should say something like waiting on Mark";
  env.elements.transcript.dispatch("input");
  env.elements.finishButton.dispatch("click");
  await flush();
  await flush();
  await flush();

  assert.equal(env.elements.transcript.value, "the status should say something like waiting on Mark", "a cut-off pass must not replace the dictation");
  assert.equal(env.fakeChrome.insertCalls.length, 0, "a cut-off pass must stop Finish before anything is inserted");
  assert.match(env.elements.notice.textContent, /cut off mid-sentence/, "the notice says the pass was cut off");
  assert.match(env.elements.notice.textContent, /unchanged/, "the notice says the text is unchanged");

  console.log("LD-043 cut-off pass keeps the dictation and stops Finish verified.");
}

// ---- Ctrl+Alt+P: highlighted text delivered by the host runs the Ctrl+Alt+S workflow ----

const SELECTION_GRAMMAR_CONFIG = Object.freeze({
  firstPassPrompt: "Fix the grammar", secondPassPrompt: "Tighten the wording", secondPassEnabled: true
});
const SUBMITTED_RESPONSE = Object.freeze({ ok: true, mode: "submitted", message: "Sent to ChatGPT." });

function passResponder({ first = "PASS ONE RESULT", second = "PASS TWO RESULT" } = {}) {
  return (userPrompt) => (userPrompt.includes("<first_pass_result>") ? second : first);
}

function providerError(message) {
  const error = new Error(message);
  error.code = "provider_error";
  return error;
}

async function settle() {
  for (let index = 0; index < 4; index += 1) await flush();
}

function closeRequests(env) {
  return env.fakeChrome.sentMessages.filter((message) => message.type === "sayslate-floating-command" && message.action === "close");
}

function sendSelection(env, sessionId, text) {
  return env.fakeChrome.deliverMessage(env.shortcuts.createSelectionMessage(sessionId, text));
}

function recordNoticeHistory(notice) {
  const history = [];
  let current = notice.textContent;
  Object.defineProperty(notice, "textContent", {
    configurable: true,
    get() { return current; },
    set(value) {
      current = value;
      history.push(value);
    }
  });
  return history;
}

{
  const clock = createManualClock();
  const env = buildEnvironment({ session: "sel-happy", grammarConfig: SELECTION_GRAMMAR_CONFIG, aiRespond: passResponder(), clock });
  await settle();
  env.fakeChrome.setNextInsertResponse(SUBMITTED_RESPONSE);

  const responses = sendSelection(env, "sel-happy", "  teh highlighted words  \n");
  assert.equal(JSON.stringify(responses), JSON.stringify([{ ok: true }]), "the frame must acknowledge a selection message for its own session");
  await settle();

  assert.equal(env.aiCalls.length, 2, "a selection must run pass one and then pass two when the second pass is enabled");
  assert.ok(env.aiCalls[0].startsWith(`${SELECTION_GRAMMAR_CONFIG.firstPassPrompt}\n\n`), "pass one must use the configured first-pass prompt");
  assert.ok(env.aiCalls[0].includes("<transcript>\nteh highlighted words\n</transcript>"), "pass one must receive exactly the trimmed highlighted text as its transcript");
  assert.ok(env.aiCalls[1].startsWith(`${SELECTION_GRAMMAR_CONFIG.secondPassPrompt}\n\n`), "pass two must use the configured second-pass prompt");
  assert.ok(env.aiCalls[1].includes("<first_pass_result>\nPASS ONE RESULT\n</first_pass_result>"), "pass two must receive pass one's result");
  assert.equal(env.fakeChrome.insertCalls.length, 1, "a selection run must ask the host to insert exactly once");
  const submit = env.fakeChrome.insertCalls[0];
  assert.equal(submit.type, "sayslate-floating-command", "the result must go to the host as a floating command");
  assert.equal(submit.sessionId, "sel-happy", "the floating command must carry this frame's session");
  assert.equal(submit.action, "insert-submit", "a selection run must replace and submit, like Ctrl+Alt+S");
  assert.equal(submit.text, "PASS TWO RESULT", "insert-submit must carry the pass-two result");
  assert.equal(env.elements.statusText.textContent, "Submitted", "the status must report the submission");
  assert.equal(env.elements.transcript.value, "PASS TWO RESULT", "the transcript must show the final result");

  assert.equal(closeRequests(env).length, 0, "close must not be requested before the 700 ms delay");
  clock.advance(699);
  await settle();
  assert.equal(closeRequests(env).length, 0, "close must not be requested at 699 ms");
  clock.advance(1);
  await settle();
  assert.equal(closeRequests(env).length, 1, "close must be requested once the 700 ms delay elapses");
}

// ---- Ctrl+Alt+P with the second pass disabled: pass one's result is submitted ----

{
  const clock = createManualClock();
  const env = buildEnvironment({
    session: "sel-one-pass",
    grammarConfig: { ...SELECTION_GRAMMAR_CONFIG, secondPassEnabled: false },
    aiRespond: passResponder(),
    clock
  });
  await settle();
  env.fakeChrome.setNextInsertResponse(SUBMITTED_RESPONSE);

  sendSelection(env, "sel-one-pass", "only pass one please");
  await settle();

  assert.equal(env.aiCalls.length, 1, "only pass one may run when the second pass is disabled");
  assert.ok(env.aiCalls[0].includes("<transcript>\nonly pass one please\n</transcript>"), "pass one must receive the highlighted text");
  assert.equal(env.aiCalls.some((prompt) => prompt.includes("<first_pass_result>")), false, "pass two must not run when disabled");
  assert.equal(env.fakeChrome.insertCalls.length, 1, "the pass-one result must be sent to the host once");
  assert.equal(env.fakeChrome.insertCalls[0].action, "insert-submit", "the pass-one result must be inserted and submitted");
  assert.equal(env.fakeChrome.insertCalls[0].text, "PASS ONE RESULT", "insert-submit must carry the pass-one result");
  clock.advance(700);
  await settle();
  assert.equal(closeRequests(env).length, 1, "the frame must close after a successful one-pass submit");
}

// ---- Ctrl+Alt+P settings race: a selection that arrives before the stored prompts waits for them ----

{
  const clock = createManualClock();
  const env = buildEnvironment({
    session: "sel-race",
    grammarConfig: SELECTION_GRAMMAR_CONFIG,
    aiRespond: passResponder(),
    clock,
    holdConfigLoad: true
  });
  const noticeHistory = recordNoticeHistory(env.elements.notice);
  env.fakeChrome.setNextInsertResponse(SUBMITTED_RESPONSE);

  sendSelection(env, "sel-race", "highlighted before settings loaded");
  await settle();
  assert.equal(env.aiCalls.length, 0, "the selection run must not start before the stored settings load");
  assert.equal(env.fakeChrome.insertCalls.length, 0, "nothing may be inserted before the stored settings load");

  env.releaseConfigLoad();
  await settle();
  assert.equal(env.aiCalls.length, 2, "both passes must run once the stored settings load");
  assert.ok(env.aiCalls[0].startsWith(`${SELECTION_GRAMMAR_CONFIG.firstPassPrompt}\n\n`), "pass one must use the stored first-pass prompt, not the empty default");
  assert.ok(env.aiCalls[0].includes("<transcript>\nhighlighted before settings loaded\n</transcript>"), "pass one must receive the highlighted text");
  assert.ok(env.aiCalls[1].startsWith(`${SELECTION_GRAMMAR_CONFIG.secondPassPrompt}\n\n`), "pass two must use the stored second-pass prompt");
  assert.equal(noticeHistory.some((text) => /Add a first-pass prompt/.test(text)), false, "the missing-prompt notice must never appear while settings are still loading");
  assert.equal(env.fakeChrome.insertCalls.length, 1, "the result must be sent to the host once");
  assert.equal(env.fakeChrome.insertCalls[0].action, "insert-submit", "the result must be inserted and submitted");
  assert.equal(env.fakeChrome.insertCalls[0].text, "PASS TWO RESULT", "insert-submit must carry the pass-two result");
}

// ---- Ctrl+Alt+P failure: a pass-one provider error keeps the highlighted text and the overlay open ----

{
  const clock = createManualClock();
  const highlighted = "keep this highlighted text";
  const env = buildEnvironment({
    session: "sel-fail",
    grammarConfig: SELECTION_GRAMMAR_CONFIG,
    aiRespond: () => { throw providerError("Gemini returned 503: the model is overloaded."); },
    clock
  });
  await settle();

  sendSelection(env, "sel-fail", highlighted);
  await settle();

  assert.equal(env.aiCalls.length, 1, "pass one must be attempted once and pass two must not follow a failure");
  assert.equal(env.fakeChrome.insertCalls.length, 0, "a failed pass must never insert or submit");
  assert.equal(env.elements.status.dataset.state, "error", "the status must show an error");
  assert.equal(env.elements.statusText.textContent, "Phase 1 failed", "the status must name the failed pass");
  assert.equal(env.elements.notice.hidden, false, "the error notice must be visible");
  assert.equal(env.elements.notice.className, "notice error", "the notice must be styled as an error");
  assert.equal(env.elements.notice.textContent, "Gemini returned 503: the model is overloaded.", "the notice must carry the provider's reason");
  assert.equal(env.elements.transcript.value, highlighted, "the transcript must keep the original highlighted text");
  clock.advance(1000);
  await settle();
  assert.equal(closeRequests(env).length, 0, "the overlay must stay open after a failed pass");
}

// ---- Ctrl+Alt+P host refusal: insert-submit answered {ok:false} keeps the overlay open ----

{
  const clock = createManualClock();
  const env = buildEnvironment({ session: "sel-refused", grammarConfig: SELECTION_GRAMMAR_CONFIG, aiRespond: passResponder(), clock });
  await settle();
  env.fakeChrome.setNextInsertResponse({ ok: false, message: "The ChatGPT composer could not be found." });

  sendSelection(env, "sel-refused", "the host will refuse this");
  await settle();

  assert.equal(env.fakeChrome.insertCalls.length, 1, "the result must be offered to the host once");
  assert.equal(env.fakeChrome.insertCalls[0].action, "insert-submit", "the offer must be insert-submit");
  assert.equal(env.elements.statusText.textContent, "Send stopped", "the status must report the stopped send");
  assert.equal(env.elements.notice.textContent, "The ChatGPT composer could not be found.", "the notice must carry the host's message");
  assert.equal(env.elements.notice.className, "notice error", "the host refusal must be shown as an error");
  assert.equal(env.elements.transcript.value, "PASS TWO RESULT", "the processed result must remain in the overlay");
  clock.advance(1000);
  await settle();
  assert.equal(closeRequests(env).length, 0, "the overlay must stay open when the host refuses");
}

// ---- Ctrl+Alt+P ignored: another session, blank text, active dictation, or a running pass ----

{
  const env = buildEnvironment({ session: "sel-ignored", grammarConfig: SELECTION_GRAMMAR_CONFIG, aiRespond: passResponder() });
  await settle();
  env.elements.transcript.value = "draft already here";
  env.elements.transcript.dispatch("input");

  const foreign = sendSelection(env, "some-other-session", "not for this frame");
  await settle();
  assert.equal(foreign.length, 0, "a selection for another session must not be acknowledged");
  assert.equal(env.elements.transcript.value, "draft already here", "a selection for another session must not touch the transcript");

  const blank = env.fakeChrome.deliverMessage({ type: env.shortcuts.SELECTION_MESSAGE_TYPE, sessionId: "sel-ignored", text: "  \n\t " });
  await settle();
  assert.equal(blank.length, 0, "a blank selection must not be acknowledged");
  assert.equal(env.elements.transcript.value, "draft already here", "a blank selection must not touch the transcript");
  assert.equal(env.aiCalls.length, 0, "ignored selections must not run any AI pass");
  assert.equal(env.fakeChrome.insertCalls.length, 0, "ignored selections must not insert anything");
}

{
  const env = buildEnvironment({ session: "sel-listening", grammarConfig: SELECTION_GRAMMAR_CONFIG, aiRespond: passResponder() });
  await settle();
  env.elements.dictateButton.dispatch("click");
  await flush();
  env.fakeChrome.dispatchToAllListeners({
    type: "sayslate-offscreen-speech-event", target: "floating", sessionId: "sel-listening",
    event: "start", payload: { recovered: false }
  });
  env.fakeChrome.dispatchToAllListeners({
    type: "sayslate-offscreen-speech-event", target: "floating", sessionId: "sel-listening",
    event: "result", payload: { finalText: "spoken words so far", interimText: "" }
  });

  sendSelection(env, "sel-listening", "highlighted while dictating");
  // Dictation ends in the same tick the selection arrived in: the selection stays dropped.
  env.fakeChrome.dispatchToAllListeners({
    type: "sayslate-offscreen-speech-event", target: "floating", sessionId: "sel-listening",
    event: "stop", payload: {}
  });
  await settle();
  assert.equal(env.elements.transcript.value, "spoken words so far", "a selection received during dictation must be dropped, not run once dictation stops");
  assert.equal(env.aiCalls.length, 0, "a selection must not run AI passes while dictation is listening");
  assert.equal(env.fakeChrome.insertCalls.length, 0, "a selection must not insert while dictation is listening");
  assert.equal(
    env.fakeChrome.sentMessages.some((message) => message.type === "sayslate-floating-speech-command" && message.action === "stop"),
    false,
    "a selection must not stop the active dictation"
  );
}

{
  const env = buildEnvironment({ session: "sel-listening-late", grammarConfig: SELECTION_GRAMMAR_CONFIG, aiRespond: passResponder(), holdConfigLoad: true });
  sendSelection(env, "sel-listening-late", "highlighted before dictation started");
  await settle();
  env.elements.dictateButton.dispatch("click");
  await flush();
  env.releaseConfigLoad();
  await settle();
  assert.equal(env.elements.transcript.value, "", "a selection waiting on settings must not replace text once dictation has started");
  assert.equal(env.aiCalls.length, 0, "a selection waiting on settings must not run once dictation has started");
  assert.equal(env.fakeChrome.insertCalls.length, 0, "a selection waiting on settings must not insert once dictation has started");
}

{
  let releasePass;
  const env = buildEnvironment({
    session: "sel-processing",
    grammarConfig: SELECTION_GRAMMAR_CONFIG,
    aiRespond: () => new Promise((resolve) => { releasePass = () => resolve("TYPED DRAFT RESULT"); })
  });
  await settle();
  env.elements.transcript.value = "typed draft";
  env.elements.transcript.dispatch("input");
  env.elements.firstPassButton.dispatch("click");
  await settle();
  assert.equal(env.aiCalls.length, 1, "the button's first pass must be running");

  sendSelection(env, "sel-processing", "highlighted during a pass");
  await settle();
  releasePass();
  await settle();
  assert.equal(env.aiCalls.length, 1, "a selection must not start a run while a pass is processing");
  assert.equal(env.elements.transcript.value, "TYPED DRAFT RESULT", "the running pass must keep its own text");
  assert.equal(env.fakeChrome.insertCalls.length, 0, "a selection ignored during a pass must not insert anything");
}

// ---- The shortcut-key branch still routes after the selection branch ----

{
  const env = buildEnvironment({ session: "sel-shortcut" });
  await settle();
  env.elements.transcript.value = "clear me";
  env.elements.transcript.dispatch("input");

  const responses = env.fakeChrome.deliverMessage(env.shortcuts.createMessage("sel-shortcut", "x"));
  assert.equal(JSON.stringify(responses), JSON.stringify([{ ok: true, key: "x" }]), "a shortcut message must still be acknowledged with its key");
  assert.equal(env.elements.transcript.value, "", "a routed Ctrl+Alt+X must still clear the transcript");
}

console.log("Floating dictation integration (both providers, Finish ordering, failed-stop blocking, Escape/Clear cancellation, beforeunload teardown, and no-fallback errors) verified.");
console.log("Floating selection processing (Ctrl+Alt+P: both passes, one pass, settings race, pass failure, host refusal, ignored messages, shortcut routing) verified.");
