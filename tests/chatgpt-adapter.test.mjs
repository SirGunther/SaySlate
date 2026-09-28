import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { element, rootElement } from "./support/elementModel.mjs";
import { loggedOutComposer, pressCounts, showTypedState } from "./support/chatGPTLoggedOutComposer.mjs";
import { dismissDialog, loggedInComposer } from "./support/chatGPTLoggedInComposer.mjs";

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

// The captured logged-in composer and send button, attached to a document with the text
// already inserted. `before` holds page elements placed ahead of the composer in the document.
function loggedInDocument({ arrangement, before = [] }) {
  const parts = loggedInComposer({ arrangement });
  parts.editor.textContent = "A finished SaySlate message";
  return { ...parts, documentRef: rootElement(null, [element("body", {}, [...before, parts.container])]) };
}

// The logged-in send button has neither send marker. It must be pressed once whether it shares
// a form with the composer or only a wrapper with no form.
for (const arrangement of ["form", "wrapper"]) {
  const page = loggedInDocument({ arrangement });
  const result = await submit({ composer: page.editor, documentRef: page.documentRef });
  assert.equal(result.ok, true, `logged-in send button (${arrangement}): ${result.message}`);
  assert.equal(page.send.clicks, 1, `the logged-in send button must be pressed once (${arrangement})`);
}

// A submit button outside the composer's ancestors, placed first in the document, is never
// pressed: not when the composer has its own send button, and not when it is the only submit
// button on the page.
{
  const dialog = dismissDialog();
  const page = loggedInDocument({ arrangement: "wrapper", before: [dialog.container] });
  const result = await submit({ composer: page.editor, documentRef: page.documentRef });
  assert.equal(result.ok, true, result.message);
  assert.equal(page.send.clicks, 1, "the composer's own send button must be pressed once");
  assert.equal(dialog.button.clicks, 0, "a submit button outside the composer must not be pressed");
}
{
  const dialog = dismissDialog();
  const editor = element("div", { contenteditable: "true", "data-composer-markdown": "" }, [], "A finished SaySlate message");
  const documentRef = rootElement(null, [element("body", {}, [dialog.container, element("div", {}, [element("div", {}, [editor])])])]);
  const result = await submit({ composer: editor, documentRef });
  assert.equal(result.ok, false);
  assert.match(result.message, /did not become ready/);
  assert.equal(dialog.button.clicks, 0, "the only submit button on the page must not be pressed when it is outside the composer");
}

// Within the nearest ancestor holding buttons, a marked send button is preferred over a plain
// submit button that comes first.
{
  const editor = element("div", { contenteditable: "true", "data-composer-markdown": "" }, [], "A finished SaySlate message");
  const plain = element("button", { type: "submit", "aria-label": "Other" });
  const marked = element("button", { "data-composer-submit": "", type: "submit" });
  const documentRef = rootElement(null, [element("body", {}, [element("form", {}, [element("div", {}, [editor]), plain, marked])])]);
  const result = await submit({ composer: editor, documentRef });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual([plain.clicks, marked.clicks], [0, 1], "the marked send button must be pressed, not the plain submit button");
}

// The composer's own button wins over a marked send button elsewhere in the document.
{
  const elsewhere = element("button", { id: "composer-submit-button" });
  const page = loggedInDocument({ arrangement: "form", before: [element("div", {}, [elsewhere])] });
  const result = await submit({ composer: page.editor, documentRef: page.documentRef });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual([page.send.clicks, elsewhere.clicks], [1, 0], "only the composer's own send button may be pressed");
}

// Conditions under which the logged-in send button must not be pressed.
for (const [condition, prepare, expectedMessage] of [
  ["disabled", (page) => page.send.setAttribute("disabled", ""), /did not become ready/],
  ["aria-disabled", (page) => page.send.setAttribute("aria-disabled", "true"), /did not become ready/],
  ["text missing", (page) => { page.editor.textContent = ""; }, /did not become ready/],
  ["composer replaced", (page) => page.editor.remove(), /replaced before submission/]
]) {
  for (const arrangement of ["form", "wrapper"]) {
    const page = loggedInDocument({ arrangement });
    prepare(page);
    const result = await submit({ composer: page.editor, documentRef: page.documentRef });
    assert.equal(result.ok, false, `${condition} (${arrangement})`);
    assert.match(result.message, expectedMessage, `${condition} (${arrangement})`);
    assert.equal(page.send.clicks, 0, `the logged-in send button must not be pressed when ${condition} (${arrangement})`);
  }
}

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

// findSendButton: the composer's own send button, ready or not, or null.
const pageWith = (...children) => rootElement(null, [element("body", {}, children)]);
for (const arrangement of ["form", "wrapper"]) {
  const { container, editor, send } = loggedInComposer({ arrangement });
  const documentRef = pageWith(dismissDialog().container, container);
  assert.equal(adapter.findSendButton(editor, documentRef), send, `the logged-in send button must be found (${arrangement})`);
  send.setAttribute("disabled", "");
  assert.equal(adapter.findSendButton(editor, documentRef), send, `a disabled send button is still the composer's own (${arrangement})`);
}
{
  const dialog = dismissDialog();
  const editor = element("div", { contenteditable: "true", "data-composer-markdown": "" });
  const documentRef = pageWith(dialog.container, element("div", {}, [editor]));
  assert.equal(adapter.findSendButton(editor, documentRef), null, "a submit button outside the composer's ancestors must not be found");
}
{
  // The walk stops before body, so a plain submit button that only shares body is not found.
  const editor = element("div", { contenteditable: "true", "data-composer-markdown": "" });
  const bodySibling = element("button", { type: "submit", "aria-label": "Send" });
  assert.equal(adapter.findSendButton(editor, pageWith(editor, bodySibling)), null, "a plain submit button reachable only through body must not be found");
}
{
  const editor = element("div", { contenteditable: "true", "data-composer-markdown": "" });
  const plain = element("button", { type: "submit" });
  const marked = element("button", { "data-composer-submit": "", type: "submit" });
  assert.equal(adapter.findSendButton(editor, pageWith(element("form", {}, [element("div", {}, [editor]), plain, marked]))), marked, "a marked send button is preferred within the same ancestor");
}
{
  const elsewhere = element("button", { id: "composer-submit-button" });
  const { container, editor, send } = loggedInComposer({ arrangement: "wrapper" });
  assert.equal(adapter.findSendButton(editor, pageWith(elsewhere, container)), send, "the nearest ancestor's button wins over a marked button elsewhere");
}
{
  // The captured logged-in composer markup with a marked send button outside it (browser B1).
  const editor = element("div", { contenteditable: "true", "data-composer-markdown": "" });
  const marked = element("button", { id: "composer-submit-button" });
  const documentRef = pageWith(element("div", {}, [element("div", {}, [editor])]), marked);
  assert.equal(adapter.findSendButton(editor, documentRef), marked, "a marked send button anywhere in the document is the fallback");
  assert.equal(adapter.findSendButton(null, documentRef), marked, "without a composer, only the document-wide marked fallback applies");
  assert.equal(adapter.findSendButton(null, pageWith(element("button", { type: "submit" }))), null, "the fallback never takes a plain submit button");
}

// findComposer: the page's one visible composer, or null.
{
  const loggedIn = loggedInComposer({ arrangement: "wrapper" });
  const search = element("textarea", { name: "search" });
  assert.equal(adapter.findComposer(pageWith(search, loggedIn.container)), loggedIn.editor, "the one visible logged-in composer must be found");
  const loggedOut = loggedOutComposer();
  assert.equal(adapter.findComposer(pageWith(element("textarea", { name: "search" }), loggedOut.form)), loggedOut.textarea, "the one visible logged-out composer must be found");
}
{
  const visible = loggedInComposer({ arrangement: "form" });
  const hidden = loggedInComposer({ arrangement: "form" });
  hidden.container.setAttribute("hidden", "");
  assert.equal(adapter.findComposer(pageWith(hidden.container, visible.container)), visible.editor, "a hidden composer must be ignored");
  const onlyHidden = loggedInComposer({ arrangement: "form" });
  onlyHidden.container.setAttribute("hidden", "");
  assert.equal(adapter.findComposer(pageWith(onlyHidden.container)), null, "a hidden composer alone must not be found");
}
assert.equal(adapter.findComposer(pageWith(element("div", {}, [element("button", { type: "submit" })]))), null, "a page with no composer yields null");
{
  const first = loggedInComposer({ arrangement: "wrapper" });
  const second = loggedInComposer({ arrangement: "wrapper" });
  assert.equal(adapter.findComposer(pageWith(first.container, second.container)), null, "two visible composers yield null");
  const legacy = element("div", { id: "prompt-textarea", contenteditable: "true" });
  assert.equal(adapter.findComposer(pageWith(legacy, loggedOutComposer().form)), null, "two visible composers of different kinds yield null");
}
{
  const settings = element("textarea", { name: "about-you" });
  const fields = pageWith(
    element("textarea", { name: "search" }),
    element("form", {}, [settings, element("button", { type: "submit" })]),
    element("div", { contenteditable: "true", class: "ProseMirror" }),
    element("div", { contenteditable: "false", "data-composer-markdown": "" }),
    element("input", { type: "text" })
  );
  assert.equal(adapter.findComposer(fields), null, "a page with only non-composer fields yields null");
}

console.log("ChatGPT surface, composer variants, composer location, send button ownership, readiness, and bounded submission behavior verified.");
