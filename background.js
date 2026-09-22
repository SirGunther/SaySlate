// Pulls the WSI-01 protocol client into the service worker's global scope; a classic
// (non-module) service worker can only ship one manifest-declared file, so a dependency
// like this is loaded via importScripts rather than a second <script> tag.
importScripts("whisperServiceClient.js");

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("app.html") });
});

const floatingHosts = new Map();
const FLOATING_HOST_PREFIX = "sayslate-floating-host:";
const FLOATING_TOGGLE_COMMAND = "toggle-floating-slate";
const OFFSCREEN_SPEECH_PATH = "offscreen.html";
let creatingOffscreenSpeechDocument = null;

// Mirrors the storage key owned by dictationSettings.js (WSI-03, out of this block's file
// ownership). Background reads the raw persisted record directly rather than through that
// module's public snapshot API, because the snapshot deliberately never exposes the
// bearer token. dictationSettings.js itself also reads this same raw record when it loads
// settings in the full-page/floating contexts (solely to know whether a token is saved,
// via its snapshot's `hasToken` flag) - background.js is not the only reader of this
// storage key, but it is the only place the token is ever used to make a request.
const DICTATION_SETTINGS_STORAGE_KEY = "sayslate-dictation-settings";
const DEFAULT_WHISPER_SERVICE_ENDPOINT = "http://127.0.0.1:8178";
const LOCAL_WHISPER_ORIGINS = new Set(["full-page", "floating"]);
// Best-effort, in-memory only: rejects an overlapping start before it can create a second
// WhisperService session descriptor for the same single-slot offscreen host. It does not
// survive a service-worker restart, so the descriptor-release path below is still required.
let localWhisperStartInFlight = false;

async function readLocalWhisperSettings() {
  const stored = await chrome.storage.local.get(DICTATION_SETTINGS_STORAGE_KEY);
  return stored?.[DICTATION_SETTINGS_STORAGE_KEY] || null;
}

function createLocalWhisperClient(settings) {
  // The Local Whisper service is intentionally fixed to loopback. Never trust a mutable
  // storage value as an authenticated destination for the saved bearer token.
  return SaySlateWhisperClient.create({ token: settings.bearerToken, baseUrl: DEFAULT_WHISPER_SERVICE_ENDPOINT });
}

async function handleLocalWhisperHealthCheck() {
  try {
    const settings = await readLocalWhisperSettings();
    if (!settings?.bearerToken) return { ok: false, code: "unauthorized", message: "Local Whisper has no saved token." };
    const health = await createLocalWhisperClient(settings).health();
    return { ok: true, ready: health.ready, activeSessions: health.activeSessions };
  } catch (error) {
    return { ok: false, code: error.category || "unavailable", message: error.message };
  }
}

// For every Local Whisper start this creates one fresh HTTP session descriptor (never a
// reused one) and hands only that descriptor - not the bearer token - to the offscreen
// host, which owns the microphone and the streaming WebSocket.
async function relayLocalWhisperCommand(message) {
  if (!LOCAL_WHISPER_ORIGINS.has(message.origin) || !message.sessionId) {
    return { ok: false, code: "client", message: "A Local Whisper origin and session id are required." };
  }

  if (message.action === "start") {
    if (localWhisperStartInFlight) return { ok: false, code: "busy", message: "Local Whisper is already starting another dictation run." };
    localWhisperStartInFlight = true;
    try {
      const settings = await readLocalWhisperSettings();
      if (!settings?.bearerToken) return { ok: false, code: "unauthorized", message: "Local Whisper has no saved token." };
      const client = createLocalWhisperClient(settings);
      let descriptor;
      try {
        descriptor = await client.createSessionDescriptor({ previewMs: settings.previewMs });
      } catch (error) {
        return { ok: false, code: error.category || "unavailable", message: error.message };
      }
      // Once the descriptor exists, any failure to hand it off for a live run (offscreen
      // rejects it as busy, the relay itself fails, ...) must release the WhisperService
      // session it reserved rather than leaving that slot pinned with nothing using it.
      try {
        await ensureOffscreenSpeechDocument();
        const response = await chrome.runtime.sendMessage({
          type: "sayslate-offscreen-local-whisper-control",
          target: "offscreen",
          origin: message.origin,
          sessionId: message.sessionId,
          action: "start",
          sessionDescriptor: descriptor
        });
        if (!response?.ok) void client.cancelSession(descriptor.sessionId).catch(() => {});
        return response;
      } catch (error) {
        void client.cancelSession(descriptor.sessionId).catch(() => {});
        return { ok: false, code: "unavailable", message: error?.message || "Local Whisper could not be reached." };
      }
    } finally {
      localWhisperStartInFlight = false;
    }
  }

  if (!(await hasOffscreenSpeechDocument())) return { ok: true, inactive: true };
  return chrome.runtime.sendMessage({
    type: "sayslate-offscreen-local-whisper-control",
    target: "offscreen",
    origin: message.origin,
    sessionId: message.sessionId,
    action: message.action
  });
}

// Best-effort release of the server-side session slot on behalf of the offscreen host,
// which never holds the bearer token needed to call this itself.
async function relayLocalWhisperHttpCancel(sessionId) {
  try {
    const settings = await readLocalWhisperSettings();
    if (!settings?.bearerToken) return;
    await createLocalWhisperClient(settings).cancelSession(sessionId);
  } catch {
    // The connect-failure path that triggers this already reported its own error.
  }
}

async function hasOffscreenSpeechDocument() {
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_SPEECH_PATH);
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [documentUrl]
    });
    return contexts.length > 0;
  }
  const controlledClients = await globalThis.clients?.matchAll?.();
  return Boolean(controlledClients?.some((client) => client.url === documentUrl));
}

async function ensureOffscreenSpeechDocument() {
  if (await hasOffscreenSpeechDocument()) return;
  if (!creatingOffscreenSpeechDocument) {
    creatingOffscreenSpeechDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_SPEECH_PATH,
      reasons: ["USER_MEDIA"],
      justification: "Run Floating Slate speech recognition outside host-page microphone restrictions."
    }).finally(() => {
      creatingOffscreenSpeechDocument = null;
    });
  }
  await creatingOffscreenSpeechDocument;
}

async function relayFloatingSpeechCommand(message) {
  if (message.action === "start") await ensureOffscreenSpeechDocument();
  else if (!(await hasOffscreenSpeechDocument())) return { ok: true, inactive: true };
  return chrome.runtime.sendMessage({
    type: "sayslate-offscreen-speech-control",
    target: "offscreen",
    sessionId: message.sessionId,
    action: message.action
  });
}

function sendMessageToTopFrame(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

async function toggleFloatingSlateInActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id === undefined) throw new Error("No active browser tab is available.");

  try {
    const response = await sendMessageToTopFrame(tab.id, { type: "sayslate-toggle-floating" });
    if (!response?.ok) throw new Error(response?.message || "Floating Slate did not respond.");
    return response;
  } catch (initialError) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      files: ["chatGPTAdapter.js", "shortcutProtocol.js", "floatingHost.js"]
    });
    const response = await sendMessageToTopFrame(tab.id, { type: "sayslate-toggle-floating" });
    if (!response?.ok) throw new Error(response?.message || initialError.message);
    return response;
  }
}

chrome.commands.onCommand.addListener((command) => {
  if (command !== FLOATING_TOGGLE_COMMAND) return;
  void toggleFloatingSlateInActiveTab().catch((error) => {
    console.warn("SaySlate could not toggle Floating Slate on this page.", error);
  });
});

function floatingHostKey(sessionId) {
  return `${FLOATING_HOST_PREFIX}${sessionId}`;
}

async function rememberFloatingHost(sessionId, host) {
  floatingHosts.set(sessionId, host);
  await chrome.storage.session.set({ [floatingHostKey(sessionId)]: host });
}

async function forgetFloatingHost(sessionId) {
  floatingHosts.delete(sessionId);
  await chrome.storage.session.remove(floatingHostKey(sessionId));
}

async function getFloatingHost(sessionId) {
  const current = floatingHosts.get(sessionId);
  if (current) return current;
  const key = floatingHostKey(sessionId);
  const stored = await chrome.storage.session.get(key);
  const recovered = stored?.[key];
  if (recovered) floatingHosts.set(sessionId, recovered);
  return recovered || null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return;

  if (message.type === "sayslate-floating-speech-command") {
    void relayFloatingSpeechCommand(message)
      .then((response) => sendResponse(response || { ok: false, message: "The speech service did not respond." }))
      .catch((error) => sendResponse({ ok: false, message: error?.message || "The speech service could not start." }));
    return true;
  }

  if (message.type === "sayslate-host-register" && sender.tab?.id !== undefined) {
    void rememberFloatingHost(message.sessionId, { tabId: sender.tab.id, frameId: sender.frameId || 0 })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, message: error.message }));
    return true;
  }

  if (message.type === "sayslate-host-unregister") {
    void forgetFloatingHost(message.sessionId)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "sayslate-local-whisper-health-check") {
    void handleLocalWhisperHealthCheck().then(sendResponse);
    return true;
  }

  if (message.type === "sayslate-local-whisper-command") {
    void relayLocalWhisperCommand(message)
      .then((response) => sendResponse(response || { ok: false, message: "The speech service did not respond." }))
      .catch((error) => sendResponse({ ok: false, code: "unavailable", message: error?.message || "Local Whisper could not be reached." }));
    return true;
  }

  if (message.type === "sayslate-local-whisper-cancel-session-http") {
    void relayLocalWhisperHttpCancel(message.sessionId).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type !== "sayslate-floating-command") return;
  void getFloatingHost(message.sessionId).then((host) => {
    if (!host) {
      sendResponse({ ok: false, message: "The original page is no longer available." });
      return;
    }

    chrome.tabs.sendMessage(
      host.tabId,
      {
        type: "sayslate-host-command",
        sessionId: message.sessionId,
        action: message.action,
        text: message.text
      },
      { frameId: host.frameId },
      (response) => {
        const error = chrome.runtime.lastError;
        if (error) sendResponse({ ok: false, message: error.message });
        else sendResponse(response || { ok: false, message: "The page did not respond." });
      }
    );
  }).catch((error) => sendResponse({ ok: false, message: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [sessionId, host] of floatingHosts) {
    if (host.tabId === tabId) void forgetFloatingHost(sessionId);
  }
});
