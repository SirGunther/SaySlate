import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { element, rootElement } from "./support/elementModel.mjs";
import { loggedOutComposer, pressCounts, showTypedState } from "./support/chatGPTLoggedOutComposer.mjs";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(extensionRoot, "chatGPTAdapter.js"), "utf8");
const context = vm.createContext({ setTimeout, Date, Promise });
vm.runInContext(source, context);
const adapter = context.SaySlateChatGPT;

assert.equal(adapter.isChatGPTLocation({ hostname: "chatgpt.com" }), true);
assert.equal(adapter.isChatGPTLocation({ hostname: "beta.chatgpt.com" }), true);
assert.equal(adapter.isChatGPTLocation({ hostname: "example.com" }), false);
assert.equal(adapter.isChatGPTLocation({ hostname: "chatgpt.com.example.com" }), false);

// Composer variants that must be accepted.
// The ProseMirror composer captured from chatgpt.com on 2026-09-28
// (tests/fixtures/chatgpt-composer-2026-09-28.html): no id, marked by data-composer-markdown.
const currentEditor = element("div", {
  contenteditable: "true",
  class: "ProseMirror",
  "data-composer-markdown": "",
  "aria-label": "Ask ChatGPT",
  role: "textbox"
});
element("div", { "data-composer-layout": "single-line" }, [element("div", { "data-composer-input-layout": "single-line" }, [currentEditor])]);
assert.equal(adapter.isChatGPTComposer(currentEditor), true, "the id-less ProseMirror composer must be accepted");

// The ProseMirror composer validated live in v1.11.4.
const legacyEditor = element("div", { id: "prompt-textarea", contenteditable: "true", class: "ProseMirror" });
assert.equal(adapter.isChatGPTComposer(legacyEditor), true, "the #prompt-textarea composer must stay accepted");

// The logged-out composer captured from chatgpt.com on 2026-09-28: a textarea whose form holds
// add-files, dictation, and data-composer-submit send buttons and no #composer-submit-button.
const { textarea: loggedOutTextarea } = loggedOutComposer();
assert.equal(adapter.isChatGPTComposer(loggedOutTextarea), true, "the logged-out textarea composer must be accepted");

// A textarea composer whose form holds the #composer-submit-button send button.
const legacyTextarea = element("textarea", {});
element("form", {}, [legacyTextarea, element("button", { id: "composer-submit-button" })]);
assert.equal(adapter.isChatGPTComposer(legacyTextarea), true, "a textarea beside #composer-submit-button must stay accepted");

// Fields on chatgpt.com that must be refused, because submitting from them would send the
// wrong text or press a send button that does not belong to them.
const canvasEditor = element("div", { contenteditable: "true", class: "ProseMirror" });
assert.equal(adapter.isChatGPTComposer(canvasEditor), false, "a ProseMirror editor without composer markers must be refused");
const renderedMarkdown = element("div", { contenteditable: "false", "data-composer-markdown": "" });
assert.equal(adapter.isChatGPTComposer(renderedMarkdown), false, "non-editable composer markdown must be refused");
const settingsTextarea = element("textarea", { name: "about-you" });
element("form", {}, [settingsTextarea, element("button", { type: "submit" })]);
assert.equal(adapter.isChatGPTComposer(settingsTextarea), false, "a textarea whose form has no composer send button must be refused");
const looseTextarea = element("textarea", {});
assert.equal(adapter.isChatGPTComposer(looseTextarea), false, "a textarea outside any form must be refused");
const nonButtonMarker = element("textarea", {});
element("form", {}, [nonButtonMarker, element("div", { "data-composer-submit": "" })]);
assert.equal(adapter.isChatGPTComposer(nonButtonMarker), false, "a data-composer-submit marker that is not a button does not identify a composer");
for (const invalid of [null, undefined, {}, "div"]) {
  assert.equal(adapter.isChatGPTComposer(invalid), false, `non-element ${String(invalid)} must be refused`);
}

const composer = element("div", { id: "prompt-textarea", contenteditable: "true" }, [], "A finished\nSaySlate message");
rootElement(null, [composer]);
assert.equal(adapter.composerContains(composer, "finished   SaySlate message"), true);
assert.equal(adapter.composerContains(composer, "a different message"), false);
assert.equal(adapter.composerContains(composer, ""), false);
assert.equal(adapter.composerContains({ value: "typed into a textarea" }, "typed into a textarea"), true);

function documentWith(...buttons) {
  return rootElement(null, [element("body", {}, buttons)]);
}

async function submit(options) {
  return adapter.waitForComposerAndSubmit({ composer, expectedText: "A finished SaySlate message", timeoutMs: 20, pollMs: 1, ...options });
}

// Send buttons that must be pressed once the composer holds the text.
const idButton = element("button", { id: "composer-submit-button" });
const idResult = await submit({ documentRef: documentWith(idButton) });
assert.equal(idResult.ok, true);
assert.equal(idButton.clicks, 1, "the #composer-submit-button send button must be pressed once");

const attributeButton = element("button", { "data-composer-submit": "", type: "submit" });
const attributeResult = await submit({ documentRef: documentWith(attributeButton) });
assert.equal(attributeResult.ok, true);
assert.equal(attributeButton.clicks, 1, "the data-composer-submit send button must be pressed once");

// The captured logged-out composer, attached to a document, with the text already inserted.
// Its add-files and dictation buttons sit before Send in the form.
function loggedOutDocument() {
  const parts = loggedOutComposer();
  parts.textarea.value = "A finished SaySlate message";
  return { ...parts, documentRef: rootElement(null, [element("body", {}, [parts.form])]) };
}

// ChatGPT readies its send button only after it registers the inserted text. As captured, the
// page then removes aria-disabled and data-visually-disabled from Send.
const late = loggedOutDocument();
let pressesBeforeReady = null;
setTimeout(() => {
  pressesBeforeReady = pressCounts(late);
  showTypedState(late);
}, 5);
const lateResult = await submit({ composer: late.textarea, documentRef: late.documentRef, timeoutMs: 500 });
assert.equal(lateResult.ok, true);
assert.deepEqual(pressesBeforeReady, [0, 0, 0], "no button may be pressed before the send button is ready");
assert.deepEqual(pressCounts(late), [0, 0, 1], "only the send button may be pressed, once, after it becomes ready");

// Conditions under which nothing may be pressed.
const notReady = loggedOutDocument();
const notReadyResult = await submit({ composer: notReady.textarea, documentRef: notReady.documentRef });
assert.equal(notReadyResult.ok, false);
assert.match(notReadyResult.message, /did not become ready/);
assert.deepEqual(pressCounts(notReady), [0, 0, 0], "no button may be pressed while the send button is aria-disabled and visually disabled");

const disabled = element("button", { id: "composer-submit-button", disabled: "" });
const disabledResult = await submit({ documentRef: documentWith(disabled) });
assert.equal(disabledResult.ok, false);
assert.equal(disabled.clicks, 0, "a disabled send button must not be pressed");

const unrelatedSubmit = element("button", { type: "submit", "aria-label": "Dismiss" });
const unrelatedResult = await submit({ documentRef: documentWith(unrelatedSubmit) });
assert.equal(unrelatedResult.ok, false);
assert.equal(unrelatedSubmit.clicks, 0, "a submit button that is not the composer send button must not be pressed");

const mismatchButton = element("button", { "data-composer-submit": "" });
const mismatchResult = await submit({ documentRef: documentWith(mismatchButton), expectedText: "text that never arrived" });
assert.equal(mismatchResult.ok, false);
assert.equal(mismatchButton.clicks, 0, "the send button must not be pressed before the composer holds the text");

// Never attached to a document, so it reads as disconnected, like a composer ChatGPT replaced.
const replacedComposer = element("div", { "data-composer-markdown": "", contenteditable: "true" }, [], "A finished SaySlate message");
const replacedButton = element("button", { "data-composer-submit": "" });
const replacedResult = await submit({ composer: replacedComposer, documentRef: documentWith(replacedButton) });
assert.equal(replacedResult.ok, false);
assert.match(replacedResult.message, /replaced before submission/);
assert.equal(replacedButton.clicks, 0, "a replaced composer must not be submitted");

const timedOut = await submit({ documentRef: { querySelector() { return null; } }, timeoutMs: 2 });
assert.equal(timedOut.ok, false);
assert.match(timedOut.message, /did not become ready/);

console.log("ChatGPT surface, composer variants, readiness, and bounded submission behavior verified.");
