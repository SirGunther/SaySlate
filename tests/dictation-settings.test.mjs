import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(extensionRoot, "dictationSettings.js"), "utf8");

function createChromeStorage(initial = {}) {
  let store = { ...initial };
  return {
    chrome: {
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
    },
    peek: () => store
  };
}

function loadModule(chrome) {
  const context = vm.createContext({ chrome, console });
  vm.runInContext(source, context);
  return context.SaySlateDictationSettings;
}

// Default migration: no stored value yields Browser Dictation and persists the schema.
{
  const { chrome, peek } = createChromeStorage();
  const settings = loadModule(chrome);
  const snapshot = await settings.load();
  assert.equal(snapshot.provider, settings.PROVIDERS.BROWSER);
  assert.equal(snapshot.hasToken, false);
  assert.equal(snapshot.previewMs, settings.DEFAULT_PREVIEW_MS);
  assert.equal(peek()["sayslate-dictation-settings"].schemaVersion, 1);
}

// Load/save round-trip: saved provider and config persist and are readable on next load.
{
  const { chrome } = createChromeStorage();
  const settings = loadModule(chrome);
  await settings.load();
  await settings.saveProvider(settings.PROVIDERS.LOCAL_WHISPER);
  await settings.saveConfig({ previewMs: 2500, token: "secret-token" });
  const snapshot = settings.getSnapshot();
  assert.equal(snapshot.provider, settings.PROVIDERS.LOCAL_WHISPER);
  assert.equal(snapshot.previewMs, 2500);
  assert.equal(snapshot.hasToken, true);
  assert.equal(Object.hasOwn(snapshot, "bearerToken"), false, "Snapshot must never expose the token field.");
  assert.equal(JSON.stringify(snapshot).includes("secret-token"), false, "Serialized status must never include the token value.");
}

// Invalid stored provider values fall back to Browser Dictation.
{
  const { chrome } = createChromeStorage({
    "sayslate-dictation-settings": { provider: "not-a-real-provider", previewMs: 2000, schemaVersion: 1 }
  });
  const settings = loadModule(chrome);
  const snapshot = await settings.load();
  assert.equal(snapshot.provider, settings.PROVIDERS.BROWSER);
}

// saveProvider rejects unknown provider values.
{
  const { chrome } = createChromeStorage();
  const settings = loadModule(chrome);
  await settings.load();
  await assert.rejects(() => settings.saveProvider("carrier-pigeon"));
}

// Preview cadence is clamped to the 1,500-3,000ms bounds.
{
  const { chrome } = createChromeStorage();
  const settings = loadModule(chrome);
  await settings.load();
  const tooLow = await settings.saveConfig({ previewMs: 500 });
  assert.equal(tooLow.previewMs, settings.MIN_PREVIEW_MS);
  const tooHigh = await settings.saveConfig({ previewMs: 9000 });
  assert.equal(tooHigh.previewMs, settings.MAX_PREVIEW_MS);
  const notANumber = await settings.saveConfig({ previewMs: "not-a-number" });
  assert.equal(notANumber.previewMs, settings.DEFAULT_PREVIEW_MS);
}

// Token masking: omitting a token on save preserves the previously saved token.
{
  const { chrome } = createChromeStorage();
  const settings = loadModule(chrome);
  await settings.load();
  await settings.saveConfig({ previewMs: 2000, token: "first-token" });
  const afterBlankSave = await settings.saveConfig({ previewMs: 2200, token: "" });
  assert.equal(afterBlankSave.hasToken, true, "An empty token on save must not clear a previously saved token.");
  assert.equal(afterBlankSave.previewMs, 2200);
}

// Provider changes notify subscribers without the token, and fire a change event.
{
  const { chrome } = createChromeStorage();
  const settings = loadModule(chrome);
  await settings.load();
  const events = [];
  const unsubscribe = settings.onChange((detail) => events.push(detail));
  await settings.saveProvider(settings.PROVIDERS.LOCAL_WHISPER);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "settings");
  assert.equal(events[0].settings.provider, settings.PROVIDERS.LOCAL_WHISPER);
  assert.equal(Object.hasOwn(events[0].settings, "bearerToken"), false);
  unsubscribe();
  await settings.saveProvider(settings.PROVIDERS.BROWSER);
  assert.equal(events.length, 1, "Unsubscribed listeners must not keep receiving events.");
}

// Active-state locking rejects provider and config mutation while dictation is active.
{
  const { chrome } = createChromeStorage();
  const settings = loadModule(chrome);
  await settings.load();
  settings.setActive(true);
  assert.equal(settings.isActive(), true);
  await assert.rejects(() => settings.saveProvider(settings.PROVIDERS.LOCAL_WHISPER));
  await assert.rejects(() => settings.saveConfig({ previewMs: 2000, token: "x" }));
  settings.setActive(false);
  await settings.saveProvider(settings.PROVIDERS.LOCAL_WHISPER);
  assert.equal(settings.getSnapshot().provider, settings.PROVIDERS.LOCAL_WHISPER);
}

// Every documented availability state can be set and read back.
{
  const { chrome } = createChromeStorage();
  const settings = loadModule(chrome);
  await settings.load();
  for (const state of Object.values(settings.AVAILABILITY)) {
    settings.setAvailability(state, "detail");
    assert.equal(settings.getAvailability().state, state);
  }
  assert.throws(() => settings.setAvailability("not-a-real-state"));
}

console.log("Dictation settings schema, persistence, locking, and availability states verified.");
