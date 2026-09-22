import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const settingsSource = fs.readFileSync(path.join(extensionRoot, "dictationSettings.js"), "utf8");
const panelSource = fs.readFileSync(path.join(extensionRoot, "dictationProviderPanel.js"), "utf8");

function createElement(id) {
  const listeners = {};
  return {
    id,
    dataset: {},
    disabled: false,
    hidden: false,
    value: "",
    textContent: "",
    checked: false,
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
    dispatch(type, event = {}) {
      for (const handler of (listeners[type] || [])) handler(event);
    }
  };
}

function buildFakeDom() {
  const registry = new Map();
  const documentListeners = {};

  function register(id) {
    const el = createElement(id);
    registry.set(`#${id}`, el);
    return el;
  }

  const toggle = register("dictationProviderToggle");
  const panel = register("dictationProviderSettings");
  panel.hidden = true;
  const statusDot = register("dictationProviderStatusDot");
  const closeButton = register("closeDictationProviderSettingsButton");
  const browserRadio = register("dictationProviderBrowser");
  const localWhisperRadio = register("dictationProviderLocalWhisper");
  const availabilityRow = register("dictationAvailability");
  availabilityRow.hidden = true;
  const availabilityText = register("dictationAvailabilityText");
  const form = register("dictationSettingsForm");
  const tokenInput = register("dictationTokenInput");
  const tokenStatus = register("dictationTokenStatus");
  const previewInput = register("dictationPreviewInput");
  const previewValue = register("dictationPreviewValue");
  const errorBox = register("dictationSettingsError");
  const lockNotice = register("dictationLockNotice");
  const configurationStatus = register("dictationConfigurationStatus");
  const saveButton = register("saveDictationSettingsButton");
  register("toast");
  register("toastMessage");

  panel.childIds = [
    "closeDictationProviderSettingsButton", "dictationProviderBrowser", "dictationProviderLocalWhisper",
    "dictationAvailability", "dictationAvailabilityText", "dictationSettingsForm", "dictationTokenInput",
    "dictationTokenStatus", "dictationPreviewInput", "dictationPreviewValue", "dictationSettingsError",
    "dictationLockNotice", "dictationConfigurationStatus", "saveDictationSettingsButton"
  ];

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

  return {
    document,
    elements: {
      toggle, panel, statusDot, closeButton, browserRadio, localWhisperRadio, availabilityRow,
      availabilityText, form, tokenInput, tokenStatus, previewInput, previewValue, errorBox,
      lockNotice, configurationStatus, saveButton
    }
  };
}

function createChromeStorage() {
  let store = {};
  return {
    runtime: {},
    storage: {
      local: {
        get(key, callback) {
          callback({ [key]: store[key] });
        },
        set(entries, callback) {
          store = { ...store, ...entries };
          callback();
        }
      }
    }
  };
}

const panelCalls = { showPanel: 0, hidePanel: 0 };
const animations = {
  showPanel(panel) {
    panel.hidden = false;
    panelCalls.showPanel += 1;
    return Promise.resolve();
  },
  hidePanel(panel) {
    panel.hidden = true;
    panelCalls.hidePanel += 1;
    return Promise.resolve();
  },
  showToast() {}
};

const { document, elements } = buildFakeDom();
const context = vm.createContext({ chrome: createChromeStorage(), document, SaySlateAnimations: animations, console });
vm.runInContext(settingsSource, context);
vm.runInContext(panelSource, context);
const settingsApi = context.SaySlateDictationSettings;

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

await flush();

// Default render: Browser Dictation selected, Local Whisper controls unlocked, availability row hidden.
// The toolbar dot itself is reserved for Local Whisper, so Browser Dictation is
// distinguished by its absence rather than colliding with an "available" green dot.
assert.equal(elements.browserRadio.checked, true);
assert.equal(elements.localWhisperRadio.checked, false);
assert.equal(elements.availabilityRow.hidden, true);
assert.equal(elements.configurationStatus.textContent, "Browser Dictation selected");
assert.equal(elements.statusDot.hidden, true, "The status dot must be hidden while Browser Dictation is selected.");
assert.match(elements.toggle["attr_aria-label"], /Browser Dictation selected/);

// Opening and closing the panel routes through the shared animation controller.
elements.toggle.dispatch("click");
assert.equal(elements.panel.hidden, false);
assert.equal(panelCalls.showPanel, 1);
elements.closeButton.dispatch("click");
await flush();
assert.equal(elements.panel.hidden, true);
assert.equal(panelCalls.hidePanel, 1);

// Selecting Local Whisper persists the provider and reveals the availability row.
elements.localWhisperRadio.checked = true;
elements.localWhisperRadio.dispatch("change");
await flush();
assert.equal(settingsApi.getSnapshot().provider, settingsApi.PROVIDERS.LOCAL_WHISPER);
assert.equal(elements.availabilityRow.hidden, false);
assert.equal(elements.statusDot.hidden, false, "The status dot must appear once Local Whisper is selected.");
assert.equal(elements.statusDot.dataset.state, settingsApi.AVAILABILITY.CHECKING);
assert.match(elements.toggle["attr_aria-label"], /Local Whisper/);

// Every documented availability state renders distinctly, and available vs. active
// (previously identical green dots) are now visually distinguished by the active ring.
for (const state of Object.values(settingsApi.AVAILABILITY)) {
  settingsApi.setAvailability(state);
  assert.equal(elements.availabilityRow.dataset.state, state);
  assert.equal(elements.statusDot.hidden, false);
  assert.equal(elements.statusDot.dataset.state, state);
  assert.match(elements.toggle["attr_aria-label"], new RegExp(state, "i"));
}

// Saving the form persists the preview cadence and masks the token afterward.
elements.previewInput.value = "2600";
elements.tokenInput.value = "a-real-secret";
elements.form.dispatch("submit", { preventDefault() {} });
await flush();
assert.equal(settingsApi.getSnapshot().previewMs, 2600);
assert.equal(settingsApi.getSnapshot().hasToken, true);
assert.equal(elements.tokenInput.value, "", "The token field must be cleared after saving.");
assert.equal(elements.tokenStatus.textContent, "Token saved.");

// Re-opening the panel never repopulates the token field with the saved secret.
elements.toggle.dispatch("click");
assert.equal(elements.tokenInput.value, "");

// Active-state locking disables mutation controls and surfaces the lock notice.
settingsApi.setActive(true);
await flush();
assert.equal(elements.browserRadio.disabled, true);
assert.equal(elements.localWhisperRadio.disabled, true);
assert.equal(elements.tokenInput.disabled, true);
assert.equal(elements.previewInput.disabled, true);
assert.equal(elements.saveButton.disabled, true);
assert.equal(elements.lockNotice.hidden, false);
settingsApi.setActive(false);
await flush();
assert.equal(elements.saveButton.disabled, false);
assert.equal(elements.lockNotice.hidden, true);

// Escape closes the open panel (already open from the re-opening check above).
assert.equal(elements.panel.hidden, false);
document.dispatch("keydown", { key: "Escape" });
await flush();
assert.equal(elements.panel.hidden, true);

// A click outside the panel and its toggle closes it; a click inside does not.
elements.toggle.dispatch("click");
assert.equal(elements.panel.hidden, false);
document.dispatch("click", { target: elements.tokenInput });
await flush();
assert.equal(elements.panel.hidden, false, "A click on a control inside the panel must not close it.");
document.dispatch("click", { target: { id: "outside-the-panel" } });
await flush();
assert.equal(elements.panel.hidden, true, "A click outside the panel and its toggle must close it.");

// While this panel is open, Ctrl+Alt shortcut combinations aimed at controls inside it
// must be stopped before they can reach app.js's global shortcut handler (which only
// excludes app.js's own two settings panels and cannot be edited under this ticket).
function fakeKeydown(overrides) {
  let stopped = false;
  return { ctrlKey: false, altKey: false, key: "a", stopPropagation: () => { stopped = true; }, wasStopped: () => stopped, ...overrides };
}

elements.toggle.dispatch("click");
assert.equal(elements.panel.hidden, false);

const ctrlAltInsidePanel = fakeKeydown({ ctrlKey: true, altKey: true, key: "d", target: elements.tokenInput });
document.dispatch("keydown", ctrlAltInsidePanel);
assert.equal(ctrlAltInsidePanel.wasStopped(), true, "A Ctrl+Alt combo aimed at a control inside the open panel must be stopped.");

const plainTypingInsidePanel = fakeKeydown({ ctrlKey: false, altKey: false, key: "d", target: elements.tokenInput });
document.dispatch("keydown", plainTypingInsidePanel);
assert.equal(plainTypingInsidePanel.wasStopped(), false, "Ordinary typing inside the panel must not be intercepted.");

const ctrlAltOutsidePanel = fakeKeydown({ ctrlKey: true, altKey: true, key: "d", target: { id: "outside-the-panel" } });
document.dispatch("keydown", ctrlAltOutsidePanel);
assert.equal(ctrlAltOutsidePanel.wasStopped(), false, "A Ctrl+Alt combo outside the panel must reach the app's own shortcut handler.");

elements.closeButton.dispatch("click");
await flush();
const ctrlAltWhileClosed = fakeKeydown({ ctrlKey: true, altKey: true, key: "d", target: elements.tokenInput });
document.dispatch("keydown", ctrlAltWhileClosed);
assert.equal(ctrlAltWhileClosed.wasStopped(), false, "A closed panel must not intercept shortcuts even if its controls remain in the DOM.");

console.log("Dictation provider panel rendering, persistence, locking, and dismissal verified.");
