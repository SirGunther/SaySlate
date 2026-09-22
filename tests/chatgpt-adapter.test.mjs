import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(extensionRoot, "chatGPTAdapter.js"), "utf8");
const context = vm.createContext({ setTimeout, Date, Promise });
vm.runInContext(source, context);
const adapter = context.SaySlateChatGPT;

assert.equal(adapter.isChatGPTLocation({ hostname: "chatgpt.com" }), true);
assert.equal(adapter.isChatGPTLocation({ hostname: "beta.chatgpt.com" }), true);
assert.equal(adapter.isChatGPTLocation({ hostname: "example.com" }), false);

const composer = {
  isConnected: true,
  innerText: "A finished\nSaySlate message",
  textContent: "A finished SaySlate message",
  matches(selector) { return selector === "#prompt-textarea"; }
};
assert.equal(adapter.isChatGPTComposer(composer), true);
assert.equal(adapter.composerContains(composer, "finished   SaySlate message"), true);

let submitted = 0;
const enabledButton = {
  disabled: false,
  getAttribute() { return null; },
  click() { submitted += 1; }
};
const successful = await adapter.waitForComposerAndSubmit({
  composer,
  expectedText: "A finished SaySlate message",
  documentRef: { querySelector() { return enabledButton; } },
  timeoutMs: 10,
  pollMs: 1
});
assert.equal(successful.ok, true);
assert.equal(submitted, 1);

const timedOut = await adapter.waitForComposerAndSubmit({
  composer,
  expectedText: "A finished SaySlate message",
  documentRef: { querySelector() { return null; } },
  timeoutMs: 2,
  pollMs: 1
});
assert.equal(timedOut.ok, false);
assert.match(timedOut.message, /did not become ready/);

console.log("ChatGPT surface, composer, readiness, and bounded submission behavior verified.");
