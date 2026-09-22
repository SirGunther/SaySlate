import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(extensionRoot, "background.js"), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
// Mirrors DICTATION_SETTINGS_STORAGE_KEY in background.js / dictationSettings.js.
const DICTATION_SETTINGS_STORAGE_KEY = "sayslate-dictation-settings";

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) { listeners.push(listener); }
  };
}

class FakeWhisperClientError extends Error {
  constructor(category, code, message) {
    super(message);
    this.category = category;
    this.code = code;
  }
}

// A minimal stand-in for the real WSI-01 SaySlateWhisperClient global. Production
// background.js only ever calls health()/createSessionDescriptor()/cancelSession() on it
// (connectSession/WebSocket handling belongs to the offscreen host, not the background
// worker), so this fake only needs to cover that HTTP-only surface.
function createFakeWhisperClient(overrides = {}) {
  const calls = { create: [], createSessionDescriptor: [], cancelSession: [], health: 0 };
  let nextCreateSessionDescriptorGate = null;
  const client = {
    async health() {
      calls.health += 1;
      if (overrides.healthError) throw overrides.healthError;
      return overrides.health || { ready: true, activeSessions: 0 };
    },
    async createSessionDescriptor(options) {
      calls.createSessionDescriptor.push(options);
      if (nextCreateSessionDescriptorGate) {
        const gate = nextCreateSessionDescriptorGate;
        nextCreateSessionDescriptorGate = null;
        await gate;
      }
      if (overrides.createSessionDescriptorError) throw overrides.createSessionDescriptorError;
      return overrides.descriptorFactory
        ? overrides.descriptorFactory(calls.createSessionDescriptor.length)
        : { version: "1.0.0", sessionId: `session-${calls.createSessionDescriptor.length}`, streamUrl: "ws://stub" };
    },
    async cancelSession(sessionId) {
      calls.cancelSession.push(sessionId);
    }
  };
  return {
    // Records the options background.js hands to create() on every call, so a test can
    // prove the resulting baseUrl stays the fixed loopback endpoint regardless of what a
    // caller's persisted settings contain (see the WSI-08 fixed-endpoint regression below).
    create: (options) => {
      calls.create.push(options);
      return client;
    },
    __calls: calls,
    // Holds the NEXT createSessionDescriptor() call pending until `gatePromise` resolves,
    // so a test can dispatch a start and inspect state while its HTTP call is still in flight.
    __blockNextCreateSessionDescriptor(gatePromise) {
      nextCreateSessionDescriptorGate = gatePromise;
    }
  };
}

function createHarness({ whisperClient, offscreenResponse, localStorageGetError } = {}) {
  const actionClicked = createEvent();
  const commandReceived = createEvent();
  const runtimeMessage = createEvent();
  const tabRemoved = createEvent();
  const sentMessages = [];
  const sentRuntimeMessages = [];
  const injectedScripts = [];
  const offscreenDocuments = [];
  const sessionValues = {};
  const localValues = {};
  let failNextTabMessage = false;
  const fakeWhisperClient = whisperClient || createFakeWhisperClient();

  const chrome = {
    action: { onClicked: actionClicked },
    commands: { onCommand: commandReceived },
    runtime: {
      lastError: null,
      onMessage: runtimeMessage,
      getURL: (file) => `chrome-extension://test/${file}`,
      async getContexts() {
        return offscreenDocuments.length ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : [];
      },
      async sendMessage(message) {
        sentRuntimeMessages.push(message);
        // Only the offscreen-bound Local Whisper control messages are configurable per
        // test (e.g. to simulate offscreen answering "busy"); every other relay this
        // harness already covers keeps its original unconditional { ok: true } stub.
        if (offscreenResponse && message.type === "sayslate-offscreen-local-whisper-control") {
          return typeof offscreenResponse === "function" ? offscreenResponse(message) : offscreenResponse;
        }
        return { ok: true };
      }
    },
    offscreen: {
      async createDocument(details) { offscreenDocuments.push(details); }
    },
    scripting: {
      async executeScript(details) { injectedScripts.push(details); }
    },
    storage: {
      session: {
        async set(values) { Object.assign(sessionValues, values); },
        async get(key) { return { [key]: sessionValues[key] }; },
        async remove(key) { delete sessionValues[key]; }
      },
      local: {
        async get(key) {
          if (localStorageGetError) throw localStorageGetError;
          return { [key]: localValues[key] };
        },
        async set(values) { Object.assign(localValues, values); }
      }
    },
    tabs: {
      onRemoved: tabRemoved,
      create() {},
      async query() { return [{ id: 42 }]; },
      sendMessage(tabId, message, options, callback) {
        sentMessages.push({ tabId, message, options });
        if (failNextTabMessage) {
          failNextTabMessage = false;
          chrome.runtime.lastError = { message: "Receiving end does not exist." };
          callback();
          chrome.runtime.lastError = null;
          return;
        }
        callback(message.type === "sayslate-host-command"
          ? { ok: true, mode: "inserted" }
          : { ok: true, open: true });
      }
    }
  };

  vm.runInContext(
    source,
    vm.createContext({
      chrome,
      console,
      Error,
      Map,
      Promise,
      // background.js pulls in the WSI-01 client via importScripts, which the real
      // service worker runtime provides but a vm sandbox does not; the fake client is
      // seeded directly into the sandbox instead of actually loading the source file,
      // matching how offscreen-speech.test.mjs stubs its own dependencies.
      importScripts() {},
      SaySlateWhisperClient: fakeWhisperClient
    })
  );

  function dispatchRuntime(message, sender = {}) {
    return new Promise((resolve, reject) => {
      const listener = runtimeMessage.listeners[0];
      const keepChannelOpen = listener(message, sender, resolve);
      if (keepChannelOpen !== true) reject(new Error(`Message was not handled: ${message.type}`));
    });
  }

  async function dispatchCommand(command) {
    commandReceived.listeners[0](command);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return {
    dispatchCommand,
    dispatchRuntime,
    injectedScripts,
    offscreenDocuments,
    sentRuntimeMessages,
    whisperClientCalls: fakeWhisperClient.__calls,
    setDictationSettings(value) { localValues[DICTATION_SETTINGS_STORAGE_KEY] = value; },
    sentMessages,
    setFailNextTabMessage() { failNextTabMessage = true; }
  };
}

{
  const harness = createHarness();
  assert.deepEqual(
    plain(await harness.dispatchRuntime({
      type: "sayslate-floating-speech-command",
      sessionId: "speech-session-1",
      action: "start"
    })),
    { ok: true }
  );
  assert.equal(harness.offscreenDocuments.length, 1);
  assert.deepEqual(plain(harness.offscreenDocuments[0]), {
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Run Floating Slate speech recognition outside host-page microphone restrictions."
  });
  assert.deepEqual(plain(harness.sentRuntimeMessages.at(-1)), {
    type: "sayslate-offscreen-speech-control",
    target: "offscreen",
    sessionId: "speech-session-1",
    action: "start"
  });
}

{
  const harness = createHarness();
  await harness.dispatchCommand("toggle-floating-slate");
  assert.equal(harness.sentMessages.at(-1).message.type, "sayslate-toggle-floating");
  assert.equal(harness.injectedScripts.length, 0);
}

{
  const harness = createHarness();
  harness.setFailNextTabMessage();
  await harness.dispatchCommand("toggle-floating-slate");
  assert.equal(harness.injectedScripts.length, 1);
  assert.deepEqual(plain(harness.injectedScripts[0].target), { tabId: 42, frameIds: [0] });
  assert.deepEqual(plain(harness.injectedScripts[0].files), ["chatGPTAdapter.js", "shortcutProtocol.js", "floatingHost.js"]);
  assert.equal(harness.sentMessages.at(-1).message.type, "sayslate-toggle-floating");
}

{
  const harness = createHarness();
  assert.deepEqual(
    plain(await harness.dispatchRuntime(
      { type: "sayslate-host-register", sessionId: "session-1" },
      { tab: { id: 42 }, frameId: 0 }
    )),
    { ok: true }
  );
  assert.deepEqual(
    plain(await harness.dispatchRuntime({
      type: "sayslate-floating-command",
      sessionId: "session-1",
      action: "insert",
      text: "Finished text"
    })),
    { ok: true, mode: "inserted" }
  );
  const routed = harness.sentMessages.at(-1);
  assert.equal(routed.tabId, 42);
  assert.equal(routed.options.frameId, 0);
  assert.deepEqual(plain(routed.message), {
    type: "sayslate-host-command",
    sessionId: "session-1",
    action: "insert",
    text: "Finished text"
  });
}

// ---- WSI-04: Local Whisper health check ----

{
  const harness = createHarness();
  harness.setDictationSettings({ bearerToken: "secret-token", endpoint: "http://127.0.0.1:8178", previewMs: 2000 });
  assert.deepEqual(
    plain(await harness.dispatchRuntime({ type: "sayslate-local-whisper-health-check" })),
    { ok: true, ready: true, activeSessions: 0 }
  );
}

{
  const harness = createHarness();
  assert.deepEqual(
    plain(await harness.dispatchRuntime({ type: "sayslate-local-whisper-health-check" })),
    { ok: false, code: "unauthorized", message: "Local Whisper has no saved token." }
  );
}

{
  const whisperClient = createFakeWhisperClient({ healthError: new FakeWhisperClientError("unavailable", "OFFLINE", "WhisperService is offline or unreachable.") });
  const harness = createHarness({ whisperClient });
  harness.setDictationSettings({ bearerToken: "secret-token", endpoint: "http://127.0.0.1:8178", previewMs: 2000 });
  assert.deepEqual(
    plain(await harness.dispatchRuntime({ type: "sayslate-local-whisper-health-check" })),
    { ok: false, code: "unavailable", message: "WhisperService is offline or unreachable." }
  );
}

// ---- WSI-04: Local Whisper start/stop/cancel routing ----

{
  const harness = createHarness();
  harness.setDictationSettings({ bearerToken: "secret-token", endpoint: "http://127.0.0.1:8178", previewMs: 2500 });
  const response = await harness.dispatchRuntime({
    type: "sayslate-local-whisper-command",
    origin: "full-page",
    sessionId: "run-1",
    action: "start"
  });
  assert.deepEqual(plain(response), { ok: true });
  assert.equal(harness.offscreenDocuments.length, 1);
  assert.deepEqual(plain(harness.whisperClientCalls.createSessionDescriptor), [{ previewMs: 2500 }]);
  assert.deepEqual(plain(harness.sentRuntimeMessages.at(-1)), {
    type: "sayslate-offscreen-local-whisper-control",
    target: "offscreen",
    origin: "full-page",
    sessionId: "run-1",
    action: "start",
    sessionDescriptor: { version: "1.0.0", sessionId: "session-1", streamUrl: "ws://stub" }
  });
  // The bearer token must never appear on the relayed message to the offscreen host.
  assert.equal(JSON.stringify(harness.sentRuntimeMessages.at(-1)).includes("secret-token"), false);

  // A second, later start creates a brand-new session descriptor rather than reusing one.
  await harness.dispatchRuntime({ type: "sayslate-local-whisper-command", origin: "floating", sessionId: "run-2", action: "start" });
  assert.equal(harness.whisperClientCalls.createSessionDescriptor.length, 2);
  assert.equal(harness.sentRuntimeMessages.at(-1).sessionDescriptor.sessionId, "session-2");
}

{
  // A busy/failed response from the offscreen host means that HTTP-reserved WhisperService
  // session was never actually used - background must release it rather than leak the slot.
  const whisperClient = createFakeWhisperClient();
  const harness = createHarness({ whisperClient, offscreenResponse: { ok: false, code: "busy", message: "Local Whisper is already active for another dictation run." } });
  harness.setDictationSettings({ bearerToken: "secret-token", endpoint: "http://127.0.0.1:8178", previewMs: 2000 });
  const response = await harness.dispatchRuntime({ type: "sayslate-local-whisper-command", origin: "full-page", sessionId: "run-1", action: "start" });
  assert.deepEqual(plain(response), { ok: false, code: "busy", message: "Local Whisper is already active for another dictation run." });
  assert.deepEqual(harness.whisperClientCalls.cancelSession, ["session-1"]);
}

{
  // Overlapping starts are serialized at background.js itself, before a second HTTP session
  // descriptor is ever created - not just rejected downstream at the offscreen host.
  const whisperClient = createFakeWhisperClient();
  const harness = createHarness({ whisperClient });
  harness.setDictationSettings({ bearerToken: "secret-token", endpoint: "http://127.0.0.1:8178", previewMs: 2000 });
  let releaseFirstDescriptor;
  whisperClient.__blockNextCreateSessionDescriptor(new Promise((resolve) => { releaseFirstDescriptor = resolve; }));
  const first = harness.dispatchRuntime({ type: "sayslate-local-whisper-command", origin: "full-page", sessionId: "run-1", action: "start" });
  await new Promise((resolve) => setTimeout(resolve, 0)); // let `first` run up to its blocked createSessionDescriptor() call
  const second = await harness.dispatchRuntime({ type: "sayslate-local-whisper-command", origin: "floating", sessionId: "run-2", action: "start" });
  assert.deepEqual(plain(second), { ok: false, code: "busy", message: "Local Whisper is already starting another dictation run." });
  assert.equal(whisperClient.__calls.createSessionDescriptor.length, 1, "the second start must not create its own descriptor while the first is still in flight");
  releaseFirstDescriptor();
  await first;
}

{
  // No token saved: rejected before any offscreen document is created.
  const harness = createHarness();
  const response = await harness.dispatchRuntime({ type: "sayslate-local-whisper-command", origin: "full-page", sessionId: "run-1", action: "start" });
  assert.deepEqual(plain(response), { ok: false, code: "unauthorized", message: "Local Whisper has no saved token." });
  assert.equal(harness.offscreenDocuments.length, 0);
}

{
  // Session-descriptor creation failing (e.g. an invalid token) must not spin up the offscreen host.
  const whisperClient = createFakeWhisperClient({ createSessionDescriptorError: new FakeWhisperClientError("auth", "AUTH_INVALID_TOKEN", "The saved token was rejected.") });
  const harness = createHarness({ whisperClient });
  harness.setDictationSettings({ bearerToken: "bad-token", endpoint: "http://127.0.0.1:8178", previewMs: 2000 });
  const response = await harness.dispatchRuntime({ type: "sayslate-local-whisper-command", origin: "full-page", sessionId: "run-1", action: "start" });
  assert.deepEqual(plain(response), { ok: false, code: "auth", message: "The saved token was rejected." });
  assert.equal(harness.offscreenDocuments.length, 0);
}

{
  // Stop/cancel with no offscreen host running is reported inactive rather than spinning one up.
  const harness = createHarness();
  assert.deepEqual(
    plain(await harness.dispatchRuntime({ type: "sayslate-local-whisper-command", origin: "full-page", sessionId: "run-1", action: "stop" })),
    { ok: true, inactive: true }
  );
  assert.equal(harness.offscreenDocuments.length, 0);
}

{
  // The offscreen host asks background to release the HTTP session on a failed connect;
  // background performs that DELETE itself since only it holds the bearer token.
  const whisperClient = createFakeWhisperClient();
  const harness = createHarness({ whisperClient });
  harness.setDictationSettings({ bearerToken: "secret-token", endpoint: "http://127.0.0.1:8178", previewMs: 2000 });
  assert.deepEqual(
    plain(await harness.dispatchRuntime({ type: "sayslate-local-whisper-cancel-session-http", sessionId: "session-9" })),
    { ok: true }
  );
  assert.deepEqual(harness.whisperClientCalls.cancelSession, ["session-9"]);
}

// ---- WSI-08: routing hardening regression coverage ----

{
  // Background must target the fixed WhisperService loopback endpoint even when persisted
  // storage contains a different value - a mutable storage record must never redirect the
  // authenticated token to somewhere other than the loopback service.
  const whisperClient = createFakeWhisperClient();
  const harness = createHarness({ whisperClient });
  harness.setDictationSettings({ bearerToken: "secret-token", endpoint: "http://evil.example.com:9999", previewMs: 2000 });

  await harness.dispatchRuntime({ type: "sayslate-local-whisper-health-check" });
  await harness.dispatchRuntime({ type: "sayslate-local-whisper-command", origin: "full-page", sessionId: "run-1", action: "start" });

  assert.equal(whisperClient.__calls.create.length, 2);
  for (const options of whisperClient.__calls.create) {
    assert.deepEqual(plain(options), { token: "secret-token", baseUrl: "http://127.0.0.1:8178" });
  }
}

{
  // A storage failure while reading saved settings must still settle the message channel
  // with a bounded, stable unavailable response instead of leaving the caller waiting
  // forever on a health check that never resolves or rejects.
  const harness = createHarness({ localStorageGetError: new Error("storage backend unavailable") });
  assert.deepEqual(
    plain(await harness.dispatchRuntime({ type: "sayslate-local-whisper-health-check" })),
    { ok: false, code: "unavailable", message: "storage backend unavailable" }
  );
}

console.log("Native shortcut initialization, injection fallback, and private routing verified.");
console.log("Local Whisper health check, session-descriptor routing, and token isolation verified.");
console.log("Fixed-endpoint routing and storage-failure health-check regression coverage verified.");
