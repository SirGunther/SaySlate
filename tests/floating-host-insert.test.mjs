// Floating Slate's page-side insertion (floatingHost.js) loaded with the real ChatGPT adapter
// and shortcut protocol, driven through the same runtime messages background.js relays:
// open the overlay on a focused field, then "insert" or "insert-submit". Covers the ChatGPT
// composer variants, the manual contenteditable fallback, and the conditions that must stop
// a submission or fall back to the clipboard.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { FakeElement, FakeInput, FakeTextArea, element, rootElement } from "./support/elementModel.mjs";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sources = ["chatGPTAdapter.js", "shortcutProtocol.js", "floatingHost.js"]
  .map((file) => fs.readFileSync(path.join(extensionRoot, file), "utf8"));
const SESSION_ID = "session-1";
const TEXT = "Hello from SaySlate";

// Mirrors the DOM constructor: the first argument is the event type, converted to a string.
class FakeInputEvent {
  constructor(type, init = {}) {
    this.type = String(type);
    this.bubbles = Boolean(init.bubbles);
    this.composed = Boolean(init.composed);
    this.inputType = init.inputType ?? "";
    this.data = init.data ?? null;
  }
}

class FakeRange {
  constructor(container = null) { this.startContainer = container; }
  get commonAncestorContainer() { return this.startContainer; }
  selectNodeContents(node) { this.startContainer = node; }
  collapse() {}
  cloneRange() { return new FakeRange(this.startContainer); }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  deleteContents() {}
  insertNode(node) { this.startContainer.text += node.data; }
  setStartAfter() {}
}

function createSelection() {
  const ranges = [];
  return {
    get rangeCount() { return ranges.length; },
    get anchorNode() { return ranges[0]?.startContainer ?? null; },
    getRangeAt(index) { return ranges[index]; },
    removeAllRanges() { ranges.length = 0; },
    addRange(range) { ranges.push(range); }
  };
}

function createPage({ hostname = "chatgpt.com", execInsertText = true, clipboardWrites = true, execCopy = false } = {}) {
  const selection = createSelection();
  const clipboard = [];
  const listeners = [];
  const documentRef = {
    activeElement: null,
    documentElement: null,
    createRange: () => new FakeRange(),
    createElement: (tag) => element(tag),
    createTextNode: (data) => ({ data }),
    querySelector: (selector) => documentRef.documentElement.querySelector(selector),
    // Chrome's insertText edits the node holding the caret, then fires one input event on
    // the editing host. It returns false when the command is unavailable.
    execCommand(command, _showUi, value) {
      if (command === "copy") return execCopy;
      if (command !== "insertText" || !execInsertText || !selection.rangeCount) return false;
      const container = selection.getRangeAt(0).startContainer;
      container.text += value;
      container.closest("[contenteditable='true']")
        ?.dispatchEvent(new FakeInputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      return true;
    }
  };
  const body = element("body");
  documentRef.body = body;
  documentRef.documentElement = rootElement(documentRef, [body]);

  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    document: documentRef,
    getSelection: () => selection,
    getComputedStyle: () => ({}),
    Element: FakeElement,
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: FakeTextArea,
    InputEvent: FakeInputEvent,
    innerWidth: 1280,
    innerHeight: 900,
    location: { hostname },
    crypto: { randomUUID: () => SESSION_ID },
    navigator: {
      clipboard: {
        async writeText(text) {
          if (!clipboardWrites) throw new Error("Document is not focused.");
          clipboard.push(text);
        }
      }
    },
    chrome: {
      runtime: {
        getURL: (file) => `chrome-extension://sayslate/${file}`,
        onMessage: { addListener: (listener) => listeners.push(listener) },
        sendMessage: async () => ({ ok: true })
      }
    },
    addEventListener() {},
    removeEventListener() {}
  });
  vm.runInContext("globalThis.top = globalThis;", context);
  for (const source of sources) vm.runInContext(source, context);

  function send(message) {
    return new Promise((resolve) => {
      let responded = false;
      const keepOpen = listeners[0](message, {}, (response) => {
        responded = true;
        resolve(response);
      });
      if (keepOpen !== true && !responded) resolve(undefined);
    });
  }

  return {
    body,
    clipboard,
    // Focus the field with the caret in `caretNode`, open Floating Slate on it, then move focus
    // to the overlay the way floating.js does when its transcript takes focus.
    async openOn(field, caretNode = field) {
      field.focus();
      if (field.isContentEditable) selection.addRange(new FakeRange(caretNode));
      const opened = await send({ type: "sayslate-toggle-floating" });
      assert.deepEqual({ ...opened }, { ok: true, open: true });
      documentRef.activeElement = null;
      selection.removeAllRanges();
    },
    command(action, text = TEXT) {
      return send({ type: "sayslate-host-command", sessionId: SESSION_ID, action, text });
    }
  };
}

// The composer from tests/fixtures/chatgpt-composer-2026-09-28.html: a ProseMirror editor with
// no id, holding an empty placeholder paragraph where the caret sits.
function currentComposer(page) {
  const paragraph = element("p", { "data-empty-paragraph": "true", class: "placeholder" });
  const editor = element("div", {
    contenteditable: "true",
    role: "textbox",
    class: "ProseMirror",
    "data-composer-markdown": "",
    "aria-label": "Ask ChatGPT"
  }, [paragraph]);
  page.body.append(element("div", { "data-composer-layout": "single-line" }, [
    element("div", { "data-composer-input-layout": "single-line" }, [editor])
  ]));
  return { editor, paragraph };
}

function sendButton(page, attributes = { id: "composer-submit-button" }) {
  const button = element("button", attributes);
  page.body.append(button);
  return button;
}

const inputEvents = (node) => node.events.filter((event) => event.type === "input");

// Positive: the id-less ProseMirror composer is accepted, filled, and submitted once.
{
  const page = createPage();
  const { editor, paragraph } = currentComposer(page);
  const send = sendButton(page);
  await page.openOn(editor, paragraph);
  const result = await page.command("insert-submit");
  assert.equal(result.ok, true, result.message);
  assert.equal(result.mode, "submitted");
  assert.equal(editor.textContent, TEXT);
  assert.equal(send.clicks, 1);
  assert.equal(inputEvents(editor).length, 1, "the insertion must reach the editor as one input event");
}

// Positive: the logged-out textarea composer (form with a data-composer-submit button).
{
  const page = createPage();
  const textarea = element("textarea", { id: "mobile-composer-prompt", name: "prompt", "data-mobile-composer-prompt": "" });
  const send = element("button", { type: "submit", "aria-label": "Send message", "data-composer-submit": "" });
  page.body.append(element("form", { "data-mobile-composer": "" }, [element("div", {}, [textarea]), send]));
  await page.openOn(textarea);
  const result = await page.command("insert-submit");
  assert.equal(result.ok, true, result.message);
  assert.equal(result.mode, "submitted");
  assert.equal(textarea.value, TEXT);
  assert.equal(send.clicks, 1);
  const [event] = inputEvents(textarea);
  assert.equal(event?.bubbles, true);
  assert.equal(event?.inputType, "insertText");
}

// Positive: when insertText is unavailable, the manual fallback inserts the text and dispatches
// a real bubbling input event, so frameworks listening for "input" register the change.
{
  const page = createPage({ execInsertText: false });
  const { editor, paragraph } = currentComposer(page);
  await page.openOn(editor, paragraph);
  const result = await page.command("insert");
  assert.equal(result.ok, true, result.message);
  assert.equal(result.mode, "inserted");
  assert.equal(editor.textContent, TEXT);
  const events = editor.events.map((event) => event.type);
  assert.deepEqual(events, ["input"], `the fallback must dispatch exactly one "input" event, dispatched: ${JSON.stringify(events)}`);
  const [event] = editor.events;
  assert.equal(event.bubbles, true);
  assert.equal(event.composed, true);
  assert.equal(event.inputType, "insertText");
  assert.equal(event.data, TEXT);
}

// Negative: ChatGPT replaced the composer while Floating Slate was open. Nothing is submitted,
// the new composer is untouched, and the result is copied instead.
{
  const page = createPage();
  const { editor, paragraph } = currentComposer(page);
  const send = sendButton(page);
  await page.openOn(editor, paragraph);
  const layout = editor.parentElement;
  editor.remove();
  const replacement = element("div", { contenteditable: "true", "data-composer-markdown": "" });
  layout.append(replacement);
  const result = await page.command("insert-submit");
  assert.equal(result.ok, false);
  assert.equal(result.mode, "copied");
  assert.match(result.message, /copied and was not submitted/);
  assert.deepEqual(page.clipboard, [TEXT]);
  assert.equal(replacement.textContent, "");
  assert.equal(send.clicks, 0);
}

// Negative: the saved target on chatgpt.com is not the composer. Nothing is inserted, copied,
// or submitted.
{
  const page = createPage();
  currentComposer(page);
  const send = sendButton(page);
  const search = element("textarea", { name: "search" });
  page.body.append(search);
  await page.openOn(search);
  const result = await page.command("insert-submit");
  assert.equal(result.ok, false);
  assert.equal(result.mode, "wrong-target");
  assert.equal(search.value, "");
  assert.deepEqual(page.clipboard, []);
  assert.equal(send.clicks, 0);
}

// Negative: a ProseMirror editor without composer markers, such as a document editor.
{
  const page = createPage();
  const documentEditor = element("div", { contenteditable: "true", class: "ProseMirror" });
  page.body.append(documentEditor);
  const send = sendButton(page);
  await page.openOn(documentEditor);
  const result = await page.command("insert-submit");
  assert.equal(result.mode, "wrong-target");
  assert.equal(documentEditor.textContent, "");
  assert.equal(send.clicks, 0);
}

// Negative: submission is refused off ChatGPT, while plain insertion still works there.
{
  const page = createPage({ hostname: "example.com" });
  const { editor, paragraph } = currentComposer(page);
  const send = sendButton(page);
  await page.openOn(editor, paragraph);
  const refused = await page.command("insert-submit");
  assert.equal(refused.ok, false);
  assert.equal(refused.mode, "unsupported");
  assert.equal(editor.textContent, "");
  const inserted = await page.command("insert");
  assert.equal(inserted.mode, "inserted");
  assert.equal(editor.textContent, TEXT);
  assert.equal(send.clicks, 0);
}

// Negative: the target is gone and both clipboard paths fail. The result reports failure so
// Floating Slate keeps the transcript open.
{
  const page = createPage({ clipboardWrites: false, execCopy: false });
  const { editor, paragraph } = currentComposer(page);
  await page.openOn(editor, paragraph);
  editor.remove();
  const result = await page.command("insert");
  assert.equal(result.ok, false);
  assert.equal(result.mode, "failed");
  assert.match(result.message, /remains open in SaySlate/);
}

console.log("Floating Slate insertion, ChatGPT composer submission, and fallback behavior verified.");
