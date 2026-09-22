import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(extensionRoot, "shortcutProtocol.js"), "utf8");
const context = vm.createContext({});
vm.runInContext(source, context);
const shortcuts = context.SaySlateFloatingShortcuts;
const plain = (value) => JSON.parse(JSON.stringify(value));

assert.deepEqual(plain(shortcuts.ACTION_KEYS), ["d", "c", "x", "g", "e", "r", "f", "s"]);

for (const key of shortcuts.ACTION_KEYS) {
  assert.equal(shortcuts.actionKeyFromEvent({ key: key.toUpperCase(), ctrlKey: true, altKey: true }), key);
}

assert.equal(shortcuts.actionKeyFromEvent({ key: "d", ctrlKey: false, altKey: true }), "");
assert.equal(shortcuts.actionKeyFromEvent({ key: "d", ctrlKey: true, altKey: true, shiftKey: true }), "");
assert.equal(shortcuts.actionKeyFromEvent({ key: "d", ctrlKey: true, altKey: true, metaKey: true }), "");
assert.equal(shortcuts.actionKeyFromEvent({ key: "d", ctrlKey: true, altKey: true, repeat: true }), "");
assert.equal(shortcuts.actionKeyFromEvent({ key: "o", ctrlKey: true, altKey: true }), "");
assert.equal(shortcuts.isEscapeEvent({ key: "Escape" }), true);
assert.equal(shortcuts.isEscapeEvent({ key: "Esc" }), false);

const message = shortcuts.createMessage("session-1", "G");
assert.deepEqual(plain(message), {
  type: "sayslate-floating-shortcut",
  sessionId: "session-1",
  key: "g"
});
assert.equal(shortcuts.messageKey(message, "session-1"), "g");
assert.equal(shortcuts.messageKey(message, "another-session"), "");
assert.equal(shortcuts.messageKey({ ...message, key: "o" }, "session-1"), "");
assert.equal(shortcuts.createMessage("", "d"), null);

console.log("Shared floating shortcut recognition and session validation verified.");
