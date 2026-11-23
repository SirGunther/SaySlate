// Floating Slate's page-side insertion (floatingHost.js) loaded with the real ChatGPT adapter
// and shortcut protocol, driven through the same runtime messages background.js relays:
// open the overlay on a focused field, then "insert" or "insert-submit". Covers the ChatGPT
// composer variants, the logged-in send button, finding the composer when the saved target is
// not one, the manual contenteditable fallback, and the conditions that must stop a
// submission or fall back to the clipboard. Also covers Ctrl + Alt + P on the page: opening
// Floating Slate on text highlighted in the composer, handing it that text, and leaving the key
// to the website otherwise.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { FakeElement, FakeInput, FakeTextArea, element, rootElement } from "./support/elementModel.mjs";
import { loggedOutComposer, pressCounts, showTypedState } from "./support/chatGPTLoggedOutComposer.mjs";
import { loggedInComposer, unrelatedPresses, unrelatedSubmits } from "./support/chatGPTLoggedInComposer.mjs";

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

// A range over `container`'s text: `start` and `end` are offsets into its textContent, and a
// range without them is a caret after that text. Its text is read from the container as it is
// now, so an edit inside it shows; unlike a live DOM range, its offsets do not follow edits made
// ahead of it. Range.toString joins text nodes, so it drops
// the line breaks between paragraphs that Selection.toString keeps; `rendered` is the selection
// text Chrome would give for the range, when that differs.
class FakeRange {
  constructor(container = null, { start = null, end = start, rendered = null } = {}) {
    this.startContainer = container;
    this.startOffset = start;
    this.endOffset = end;
    this.rendered = rendered;
  }
  get commonAncestorContainer() { return this.startContainer; }
  get collapsed() { return this.startOffset === this.endOffset; }
  selectNodeContents(node) { this.startContainer = node; }
  collapse(toStart = false) {
    if (this.startOffset === null) return;
    if (toStart) this.endOffset = this.startOffset;
    else this.startOffset = this.endOffset;
  }
  cloneRange() {
    return new FakeRange(this.startContainer, { start: this.startOffset, end: this.endOffset, rendered: this.rendered });
  }
  toString() {
    return this.startOffset === null ? "" : this.startContainer.textContent.slice(this.startOffset, this.endOffset);
  }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  deleteContents() {
    if (this.startOffset === null) return;
    const { text } = this.startContainer;
    this.startContainer.text = `${text.slice(0, this.startOffset)}${text.slice(this.endOffset)}`;
    this.endOffset = this.startOffset;
  }
  // Inserts at the start; the range then spans the inserted text, as a DOM range does.
  insertNode(node) {
    if (this.startOffset === null) {
      this.startContainer.text += node.data;
      return;
    }
    const { text } = this.startContainer;
    this.startContainer.text = `${text.slice(0, this.startOffset)}${node.data}${text.slice(this.startOffset)}`;
    this.endOffset = this.startOffset + node.data.length;
  }
  setStartAfter() {
    if (this.startOffset !== null) this.startOffset = this.endOffset;
  }
}

function createSelection() {
  const ranges = [];
  return {
    get rangeCount() { return ranges.length; },
    get anchorNode() { return ranges[0]?.startContainer ?? null; },
    getRangeAt(index) { return ranges[index]; },
    removeAllRanges() { ranges.length = 0; },
    addRange(range) { ranges.push(range); },
    toString() { return ranges.map((range) => range.rendered ?? range.toString()).join(""); }
  };
}

// Lets the page's pending promises and their follow-up work finish.
const settle = () => new Promise((resolve) => setImmediate(resolve));

// A keydown as the page's capture listener receives it: Ctrl + Alt + P unless `init` says
// otherwise. It records whether the page took it from the website.
function keyEvent(init = {}) {
  return {
    key: "p",
    ctrlKey: true,
    altKey: true,
    shiftKey: false,
    metaKey: false,
    repeat: false,
    ...init,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() { this.propagationStopped = true; }
  };
}

// Lets a check that must wait out SaySlate's 20 s readiness bound finish in moments: each page
// timer fires on the next turn and advances the page's clock by its delay.
function fastClock() {
  let now = Date.now();
  return {
    Date: { now: () => now },
    setTimeout: (callback, delay = 0) => setTimeout(() => {
      now += delay;
      callback();
    }, 0)
  };
}

// `registration` is the service worker's reply to the overlay's registration, or an Error it
// fails with.
function createPage({
  hostname = "chatgpt.com",
  execInsertText = true,
  clipboardWrites = true,
  execCopy = false,
  clock = null,
  registration = { ok: true }
} = {}) {
  const selection = createSelection();
  const clipboard = [];
  const listeners = [];
  const windowListeners = {};
  const runtimeMessages = [];
  const frames = [];
  const warnings = [];
  let sessions = 0;
  const documentRef = {
    activeElement: null,
    documentElement: null,
    createRange: () => new FakeRange(),
    // The overlay's iframe is kept, with a window that counts focus, so a test can load it.
    createElement(tag) {
      const node = element(tag);
      if (tag === "iframe") {
        node.contentWindow = { focusCount: 0, focus() { this.focusCount += 1; } };
        frames.push(node);
      }
      return node;
    },
    createTextNode: (data) => ({ data }),
    querySelector: (selector) => documentRef.documentElement.querySelector(selector),
    querySelectorAll: (selector) => documentRef.documentElement.querySelectorAll(selector),
    // Chrome's insertText replaces the selected text, or inserts at the caret, in the node
    // holding it, leaves the caret after the inserted text, then fires one input event on the
    // editing host. It returns false when the command is unavailable.
    execCommand(command, _showUi, value) {
      if (command === "copy") return execCopy;
      if (command !== "insertText" || !execInsertText || !selection.rangeCount) return false;
      const range = selection.getRangeAt(0);
      const container = range.startContainer;
      const start = range.startOffset ?? container.text.length;
      const end = range.endOffset ?? start;
      container.text = `${container.text.slice(0, start)}${value}${container.text.slice(end)}`;
      range.startOffset = start + value.length;
      range.endOffset = range.startOffset;
      container.closest("[contenteditable='true']")
        ?.dispatchEvent(new FakeInputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      return true;
    }
  };
  // ChatGPT's app containers: composers go in `slot` (body > div#app > main > div), and other
  // page parts go in `app` ahead of main.
  const slot = element("div");
  const app = element("div", { id: "app" }, [element("main", {}, [slot])]);
  const body = element("body", {}, [app]);
  documentRef.body = body;
  documentRef.documentElement = rootElement(documentRef, [body]);

  // The extension's runtime. Its id is removed when the extension reloads, leaving this page's
  // copy of the script orphaned.
  const runtime = {
    id: "sayslate",
    getURL: (file) => `chrome-extension://sayslate/${file}`,
    onMessage: { addListener: (listener) => listeners.push(listener) },
    async sendMessage(message) {
      runtimeMessages.push(JSON.parse(JSON.stringify(message)));
      if (message?.type !== "sayslate-host-register") return { ok: true };
      if (registration instanceof Error) throw registration;
      return registration;
    }
  };

  const context = vm.createContext({
    console: Object.assign(Object.create(console), { warn: (...args) => warnings.push(args) }),
    setTimeout: clock?.setTimeout ?? setTimeout,
    ...(clock ? { Date: clock.Date } : {}),
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
    // Each overlay opened on the page gets the next session: SESSION_ID, then session-2, ...
    crypto: { randomUUID: () => `session-${++sessions}` },
    navigator: {
      clipboard: {
        async writeText(text) {
          if (!clipboardWrites) throw new Error("Document is not focused.");
          clipboard.push(text);
        }
      }
    },
    chrome: { runtime },
    addEventListener(type, handler) { (windowListeners[type] ||= []).push(handler); },
    removeEventListener(type, handler) {
      windowListeners[type] = (windowListeners[type] || []).filter((candidate) => candidate !== handler);
    }
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
    app,
    slot,
    clipboard,
    // Every message the page sent the service worker, as plain copies.
    runtimeMessages,
    frames,
    warnings,
    selectionMessages: () => runtimeMessages.filter((message) => message.type === "sayslate-floating-selection"),
    // The messages that reach the overlay's frame: highlighted text and relayed shortcuts.
    frameMessages: () => runtimeMessages.filter((message) => (
      message.type === "sayslate-floating-selection" || message.type === "sayslate-floating-shortcut"
    )),
    overlays: () => documentRef.documentElement.querySelectorAll("#sayslate-floating-host"),
    overlay: () => documentRef.documentElement.querySelector("#sayslate-floating-host"),
    // Focus `field` and highlight `range` in it: a [start, end] pair for a value field, else a
    // FakeRange for the page's selection.
    highlight(field, range) {
      field.focus();
      if (Array.isArray(range)) field.setSelectionRange(...range);
      else selection.addRange(range);
    },
    // Moves focus to the overlay, as floating.js does when its transcript takes focus.
    leaveField() {
      documentRef.activeElement = null;
      selection.removeAllRanges();
    },
    keydown(init) {
      const event = keyEvent(init);
      for (const handler of windowListeners.keydown || []) handler(event);
      return event;
    },
    loadFrame(frame = frames.at(-1)) {
      frame.dispatchEvent({ type: "load" });
    },
    toggle: () => send({ type: "sayslate-toggle-floating" }),
    reloadExtension() { delete runtime.id; },
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
  page.slot.append(element("div", { "data-composer-layout": "single-line" }, [
    element("div", { "data-composer-input-layout": "single-line" }, [editor])
  ]));
  return { editor, paragraph };
}

function sendButton(page, attributes = { id: "composer-submit-button" }) {
  const button = element("button", attributes);
  page.app.prepend(button);
  return button;
}

const inputEvents = (node) => node.events.filter((event) => event.type === "input");

// The captured logged-in composer and its marker-less send button, added to the page.
function addLoggedInComposer(page, arrangement) {
  const parts = loggedInComposer({ arrangement });
  page.slot.append(parts.container);
  return parts;
}

// Negative (the reviewers' layout): the composer has no send button of its own, and enabled
// submit buttons sit ahead of the app's main area (a navigation form, a dialog's Dismiss).
// Whether the composer is the saved target or is found, the text is inserted and nothing is
// pressed.
for (const opened of ["composer", "nothing"]) {
  const page = createPage({ clock: fastClock() });
  const unrelated = unrelatedSubmits();
  page.app.prepend(unrelated.nav, unrelated.dialog);
  const { editor, paragraph } = currentComposer(page);
  await page.openOn(opened === "composer" ? editor : page.body, paragraph);
  const result = await page.command("insert-submit");
  assert.equal(result.mode, "inserted-not-submitted", `opened on ${opened}: ${result.message}`);
  assert.match(result.message, /did not become ready/);
  assert.equal(editor.textContent, TEXT);
  assert.deepEqual(unrelatedPresses(unrelated), [0, 0], "no submit button outside the composer's form may be pressed");
}

// Positive: Floating Slate opened with nothing editable focused, as in a fresh chat where the
// focused element was not the composer. The page's one composer is found, filled, and
// submitted with the logged-in send button in its form.
{
  const page = createPage();
  const { editor, send } = addLoggedInComposer(page, "form");
  await page.openOn(page.body);
  const result = await page.command("insert-submit");
  assert.equal(result.mode, "submitted", result.message);
  assert.equal(result.ok, true);
  assert.equal(editor.textContent, TEXT);
  assert.equal(send.clicks, 1, "the logged-in send button must be pressed once");
  assert.equal(inputEvents(editor).length, 1, "the insertion must reach the located editor as one input event");
}

// Negative: the logged-in send button shares only a wrapper with the composer, no form, so it is
// not the composer's send button. The text is inserted and nothing is pressed, whether the
// composer was found or saved.
for (const opened of ["nothing", "composer"]) {
  const page = createPage({ clock: fastClock() });
  const { editor, paragraph, send } = addLoggedInComposer(page, "wrapper");
  await page.openOn(opened === "composer" ? editor : page.body, paragraph);
  const result = await page.command("insert-submit");
  assert.equal(result.mode, "inserted-not-submitted", `opened on ${opened}: ${result.message}`);
  assert.equal(editor.textContent, TEXT);
  assert.equal(send.clicks, 0, "a submit button outside the composer's form must not be pressed");
}

// Positive: the saved target is another chatgpt.com field. The composer is found and
// submitted, and the other field is left unchanged.
{
  const page = createPage();
  const { editor, send } = addLoggedInComposer(page, "form");
  const search = element("textarea", { name: "search" });
  page.app.prepend(search);
  await page.openOn(search);
  const result = await page.command("insert-submit");
  assert.equal(result.mode, "submitted", result.message);
  assert.equal(editor.textContent, TEXT);
  assert.equal(send.clicks, 1);
  assert.equal(search.value, "", "the other field must be unchanged");
  assert.deepEqual(inputEvents(search), []);
  assert.deepEqual(page.clipboard, []);
}

// Positive: the saved target is the logged-in composer; the marker-less send button in its form
// is pressed.
{
  const page = createPage();
  const { editor, paragraph, send } = addLoggedInComposer(page, "form");
  await page.openOn(editor, paragraph);
  const result = await page.command("insert-submit");
  assert.equal(result.mode, "submitted", result.message);
  assert.equal(editor.textContent, TEXT);
  assert.equal(send.clicks, 1);
}

// Negative: no composer on the page. Nothing is inserted, copied, or pressed.
{
  const page = createPage();
  const search = element("textarea", { name: "search" });
  const stray = element("button", { type: "submit", "aria-label": "Send" });
  page.app.prepend(search, stray);
  await page.openOn(page.body);
  const result = await page.command("insert-submit");
  assert.equal(result.ok, false);
  assert.equal(result.mode, "wrong-target");
  assert.match(result.message, /Place the cursor in the ChatGPT message composer/);
  assert.equal(search.value, "");
  assert.deepEqual(page.clipboard, []);
  assert.equal(stray.clicks, 0);
}

// Negative: two visible composers. SaySlate does not guess between them.
{
  const page = createPage();
  const first = addLoggedInComposer(page, "wrapper");
  const second = addLoggedInComposer(page, "form");
  await page.openOn(page.body);
  const result = await page.command("insert-submit");
  assert.equal(result.ok, false);
  assert.equal(result.mode, "wrong-target");
  assert.deepEqual([first.editor.textContent, second.editor.textContent], ["", ""], "neither composer may be filled");
  assert.deepEqual([first.send.clicks, second.send.clicks], [0, 0], "neither send button may be pressed");
  assert.deepEqual(page.clipboard, []);
}

// Negative: a hidden composer is not a target, even when it is the only one.
{
  const page = createPage();
  const hidden = addLoggedInComposer(page, "form");
  hidden.container.setAttribute("hidden", "");
  await page.openOn(page.body);
  const result = await page.command("insert-submit");
  assert.equal(result.mode, "wrong-target");
  assert.equal(hidden.editor.textContent, "");
  assert.equal(hidden.send.clicks, 0);
}

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

// Positive: the captured logged-out textarea composer. Send starts not ready, and, like the real
// page, the fixture readies it shortly after the textarea's input event, so the submission
// must wait for it. The add-files and dictation buttons before Send are never pressed.
{
  const page = createPage();
  const composer = loggedOutComposer();
  const { textarea } = composer;
  page.slot.append(composer.form);
  let pressesBeforeReady = null;
  textarea.addEventListener("input", () => setTimeout(() => {
    pressesBeforeReady = pressCounts(composer);
    if (textarea.value.trim()) showTypedState(composer);
  }, 5));
  await page.openOn(textarea);
  const result = await page.command("insert-submit");
  assert.equal(result.ok, true, result.message);
  assert.equal(result.mode, "submitted");
  assert.equal(textarea.value, TEXT);
  assert.deepEqual(pressesBeforeReady, [0, 0, 0], "no button may be pressed before the send button is ready");
  assert.deepEqual(pressCounts(composer), [0, 0, 1], "only the send button may be pressed, once");
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

// Negative: ChatGPT replaced the logged-out textarea composer alone, leaving its form. The
// removed textarea no longer sits in a form, but it is still not swapped for the new composer:
// nothing is inserted there and Send, though ready, is not pressed.
{
  const page = createPage();
  const composer = loggedOutComposer();
  page.slot.append(composer.form);
  await page.openOn(composer.textarea);
  const host = composer.textarea.parentElement;
  composer.textarea.remove();
  const replacement = element("textarea", { id: "mobile-composer-prompt", name: "prompt" });
  host.append(replacement);
  showTypedState(composer);
  const result = await page.command("insert-submit");
  assert.equal(result.ok, false);
  assert.equal(result.mode, "wrong-target");
  assert.equal(replacement.value, "");
  assert.deepEqual(pressCounts(composer), [0, 0, 0]);
}

// Negative: a ProseMirror editor without composer markers, such as a document editor.
{
  const page = createPage();
  const documentEditor = element("div", { contenteditable: "true", class: "ProseMirror" });
  page.slot.append(documentEditor);
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

// Ctrl + Alt + P: a draft in the composer with part of it highlighted, and the processed text
// Floating Slate sends back to replace the highlight.
const DRAFT = "Keep this. rough draft here. Keep that.";
const HIGHLIGHT = "rough draft here.";
const HIGHLIGHT_START = DRAFT.indexOf(HIGHLIGHT);
const HIGHLIGHT_END = HIGHLIGHT_START + HIGHLIGHT.length;
const POLISHED = "Polished text.";
const POLISHED_DRAFT = "Keep this. Polished text. Keep that.";

const selectionMessage = (text, sessionId = SESSION_ID) => ({ type: "sayslate-floating-selection", sessionId, text });
const shortcutMessage = (key) => ({ type: "sayslate-floating-shortcut", sessionId: SESSION_ID, key });
const highlightIn = (paragraph) => new FakeRange(paragraph, { start: HIGHLIGHT_START, end: HIGHLIGHT_END });

// The logged-in composer holding `draft` in its one paragraph.
function draftedComposer(page, draft = DRAFT) {
  const parts = addLoggedInComposer(page, "form");
  parts.paragraph.removeAttribute("data-empty-paragraph");
  parts.paragraph.removeAttribute("class");
  parts.paragraph.text = draft;
  return parts;
}

// The logged-out textarea composer holding `draft`, its Send ready as it is once text is typed.
function draftedTextareaComposer(page, draft = DRAFT) {
  const composer = loggedOutComposer();
  page.slot.append(composer.form);
  composer.textarea.value = draft;
  showTypedState(composer);
  return composer;
}

// A page whose logged-in composer holds DRAFT, focused with HIGHLIGHT highlighted.
function highlightedPage(options) {
  const page = createPage(options);
  const parts = draftedComposer(page);
  page.highlight(parts.editor, highlightIn(parts.paragraph));
  return { page, ...parts };
}

// A page whose composer of `kind` ("contenteditable" or "textarea") holds DRAFT, focused with
// DRAFT.slice(start, end) highlighted. `read` gives the composer's text, `write` replaces it as
// a user's edit would, and `sends` counts Send presses.
function composerPage(kind, [start, end], options) {
  const page = createPage(options);
  if (kind === "textarea") {
    const composer = draftedTextareaComposer(page);
    const { textarea } = composer;
    page.highlight(textarea, [start, end]);
    return {
      page,
      field: textarea,
      read: () => textarea.value,
      write: (text) => { textarea.value = text; },
      sends: () => composer.send.clicks
    };
  }
  const { editor, paragraph, send } = draftedComposer(page);
  page.highlight(editor, new FakeRange(paragraph, { start, end }));
  return {
    page,
    field: editor,
    read: () => editor.textContent,
    write: (text) => { paragraph.text = text; },
    sends: () => send.clicks
  };
}

// Presses Ctrl + Alt + P, then lets Floating Slate register, take focus, and load its frame.
async function processHighlight(page) {
  const event = page.keydown();
  await settle();
  page.leaveField();
  page.loadFrame();
  return event;
}

// Positive: text highlighted in the logged-in ProseMirror composer. Ctrl + Alt + P is taken from
// the website and opens Floating Slate for ChatGPT on the composer. Nothing reaches the frame
// until it loads; then it is focused and handed exactly the highlighted text, once. The
// processed text replaces only the highlight and is submitted once.
{
  const { page, editor, send } = highlightedPage();
  const event = page.keydown();
  assert.equal(event.defaultPrevented, true, "Ctrl + Alt + P on highlighted composer text must be taken from the website");
  assert.equal(event.propagationStopped, true, "the page's own Ctrl + Alt + P handlers must not run");
  assert.ok(page.overlay(), "Floating Slate must open");
  assert.match(page.frames[0].src, /[?&]session=session-1&surface=chatgpt$/, "the overlay must open for ChatGPT");
  await settle();
  assert.deepEqual(
    page.runtimeMessages.filter((message) => message.type === "sayslate-host-register"),
    [{ type: "sayslate-host-register", sessionId: SESSION_ID }],
    "the overlay's session must be registered once"
  );
  assert.deepEqual(page.selectionMessages(), [], "the highlighted text must wait for the frame to load");
  page.leaveField();
  page.loadFrame();
  assert.deepEqual(page.selectionMessages(), [selectionMessage(HIGHLIGHT)], "the frame must be handed exactly the highlighted text, once");
  assert.equal(page.frames[0].contentWindow.focusCount, 1, "the frame must be focused as the text is handed over");
  const result = await page.command("insert-submit", POLISHED);
  assert.equal(result.mode, "submitted", result.message);
  assert.equal(editor.textContent, POLISHED_DRAFT, "only the highlighted text may be replaced");
  assert.equal(send.clicks, 1, "the send button must be pressed once");
  assert.deepEqual(page.warnings, [], "nothing may be logged");
}

// Positive: text highlighted in the logged-out textarea composer is read from its value, and the
// processed text replaces only that span before Send is pressed once.
{
  const page = createPage();
  const composer = draftedTextareaComposer(page);
  page.highlight(composer.textarea, [HIGHLIGHT_START, HIGHLIGHT_END]);
  const event = page.keydown();
  assert.equal(event.defaultPrevented, true, "Ctrl + Alt + P on highlighted textarea text must be taken from the website");
  assert.equal(event.propagationStopped, true, "the page's own Ctrl + Alt + P handlers must not run");
  assert.match(page.frames[0].src, /surface=chatgpt$/, "the overlay must open for ChatGPT");
  await settle();
  page.leaveField();
  page.loadFrame();
  assert.deepEqual(page.selectionMessages(), [selectionMessage(HIGHLIGHT)], "the frame must be handed exactly the highlighted value text, once");
  const result = await page.command("insert-submit", POLISHED);
  assert.equal(result.mode, "submitted", result.message);
  assert.equal(composer.textarea.value, POLISHED_DRAFT, "only the highlighted text may be replaced");
  assert.deepEqual(pressCounts(composer), [0, 0, 1], "only Send may be pressed, once");
}

// Positive: a highlight across two composer paragraphs is handed over as the selection's text,
// which keeps the line break between them that the range's own text drops.
{
  const page = createPage();
  const { editor, paragraph } = draftedComposer(page, "");
  paragraph.remove();
  editor.append(element("p", {}, [], "First line."), element("p", {}, [], "Second line."));
  const range = new FakeRange(editor, { start: 0, end: editor.textContent.length, rendered: "First line.\nSecond line." });
  assert.equal(range.toString(), "First line.Second line.", "the range's own text joins the paragraphs");
  page.highlight(editor, range);
  assert.equal(page.keydown().defaultPrevented, true, "a highlight across paragraphs must be processed");
  await settle();
  page.loadFrame();
  assert.deepEqual(page.selectionMessages(), [selectionMessage("First line.\nSecond line.")], "the paragraph break must be kept");
}

// Positive: the frame loads before the overlay's registration settles. The text is handed over
// once registration settles, exactly once.
{
  const { page } = highlightedPage();
  page.keydown();
  page.loadFrame();
  assert.deepEqual(page.selectionMessages(), [], "the text must wait for registration");
  await settle();
  assert.deepEqual(page.selectionMessages(), [selectionMessage(HIGHLIGHT)], "the loaded frame must be handed the text once registration settles, once");
  assert.equal(page.frames[0].contentWindow.focusCount, 1, "the frame must be focused as the text is handed over");
}

// Positive: a shortcut pressed while the frame is still loading is queued behind the highlighted
// text, so the frame receives the text first.
{
  const { page } = highlightedPage();
  page.keydown();
  await settle();
  page.leaveField();
  assert.equal(page.keydown({ key: "d" }).defaultPrevented, true, "the open overlay must take its own shortcut");
  assert.deepEqual(page.frameMessages(), [], "nothing may reach the frame before it loads");
  page.loadFrame();
  assert.deepEqual(
    page.frameMessages(),
    [selectionMessage(HIGHLIGHT), shortcutMessage("d")],
    "the highlighted text must be handed over once, ahead of the shortcut queued during startup"
  );
}

// Negative: Ctrl + Alt + P is left to the website, and Floating Slate stays closed, unless text
// is highlighted in ChatGPT's composer and the key is exactly Ctrl + Alt + P.
const ignoredPresses = {
  "on another website": () => highlightedPage({ hostname: "example.com" }),
  "with a caret in the composer": () => {
    const page = createPage();
    const { editor, paragraph } = draftedComposer(page);
    page.highlight(editor, new FakeRange(paragraph, { start: HIGHLIGHT_START }));
    return { page };
  },
  "with a caret in the textarea composer": () => {
    const page = createPage();
    const { textarea } = draftedTextareaComposer(page);
    page.highlight(textarea, [HIGHLIGHT_START, HIGHLIGHT_START]);
    return { page };
  },
  "with only spaces highlighted in the composer": () => {
    const page = createPage();
    const { editor, paragraph } = draftedComposer(page, "Keep this.   Keep that.");
    page.highlight(editor, new FakeRange(paragraph, { start: 10, end: 13 }));
    return { page };
  },
  "with only a line break highlighted in the textarea composer": () => {
    const page = createPage();
    const { textarea } = draftedTextareaComposer(page, "Keep this.\n\nKeep that.");
    page.highlight(textarea, [10, 12]);
    return { page };
  },
  "with text highlighted in another chatgpt.com field": () => {
    const page = createPage();
    draftedComposer(page);
    const search = element("textarea", { name: "search" });
    page.app.prepend(search);
    search.value = DRAFT;
    page.highlight(search, [HIGHLIGHT_START, HIGHLIGHT_END]);
    return { page };
  },
  "with text highlighted in a rich-text editor that is not the composer": () => {
    const page = createPage();
    const paragraph = element("p", {}, [], DRAFT);
    const documentEditor = element("div", { contenteditable: "true", class: "ProseMirror" }, [paragraph]);
    page.slot.append(documentEditor);
    page.highlight(documentEditor, highlightIn(paragraph));
    return { page };
  },
  "with conversation text highlighted": () => {
    const page = createPage();
    draftedComposer(page);
    const reply = element("p", {}, [], DRAFT);
    page.slot.prepend(element("article", {}, [reply]));
    page.highlight(page.body, highlightIn(reply));
    return { page };
  },
  "with Shift held": () => ({ ...highlightedPage(), init: { shiftKey: true } }),
  "with Meta held": () => ({ ...highlightedPage(), init: { metaKey: true } }),
  "as a key repeat": () => ({ ...highlightedPage(), init: { repeat: true } }),
  // The copy left running in a page after the extension reloads leaves the key to the copy that
  // replaced it.
  "in a copy orphaned by an extension reload": () => {
    const arranged = highlightedPage();
    arranged.page.reloadExtension();
    return arranged;
  }
};
for (const [situation, arrange] of Object.entries(ignoredPresses)) {
  const { page, init } = arrange();
  const event = page.keydown(init);
  await settle();
  assert.equal(event.defaultPrevented, false, `${situation}: the key must reach the website`);
  assert.equal(event.propagationStopped, false, `${situation}: the page's own handlers must run`);
  assert.equal(page.overlay(), null, `${situation}: Floating Slate must not open`);
  assert.deepEqual(page.runtimeMessages, [], `${situation}: nothing may be sent`);
  assert.deepEqual(page.warnings, [], `${situation}: nothing may be logged`);
}

// Negative: with Floating Slate already open, Ctrl + Alt + P is left to the website even with
// composer text highlighted: it is not relayed to the open overlay and opens no second one.
{
  const { page } = highlightedPage();
  const opened = await page.toggle();
  assert.deepEqual({ ...opened }, { ok: true, open: true });
  page.loadFrame();
  const event = page.keydown();
  await settle();
  assert.equal(event.defaultPrevented, false, "the key must reach the website while Floating Slate is open");
  assert.equal(event.propagationStopped, false, "the page's own handlers must run while Floating Slate is open");
  assert.equal(page.overlays().length, 1, "no second overlay may open");
  assert.equal(page.frames.length, 1, "no second frame may be created");
  assert.deepEqual(page.frameMessages(), [], "neither the text nor a shortcut may reach the open overlay");
}

// Negative: Floating Slate is closed, by Escape or its own close, before its frame loads, either
// before or after its registration settles, and is then opened again. The highlighted text
// reaches neither the closed overlay nor the next one.
for (const closer of ["Escape", "close"]) {
  for (const when of ["before", "after"]) {
    const situation = `closed by ${closer} ${when} registration settled`;
    const { page } = highlightedPage();
    page.keydown();
    if (when === "after") await settle();
    if (closer === "Escape") {
      assert.equal(page.keydown({ key: "Escape", ctrlKey: false, altKey: false }).defaultPrevented, true, `${situation}: Escape must close`);
    } else {
      await page.command("close");
    }
    assert.equal(page.overlay(), null, `${situation}: the overlay must be removed`);
    page.loadFrame(page.frames[0]);
    page.leaveField();
    const reopened = await page.toggle();
    assert.deepEqual({ ...reopened }, { ok: true, open: true }, `${situation}: Floating Slate must open again`);
    await settle();
    page.loadFrame(page.frames[1]);
    assert.deepEqual(page.selectionMessages(), [], `${situation}: the highlighted text must be dropped`);
  }
}

// Negative: the overlay's registration fails, refused by the service worker or unreachable. The
// overlay is removed, nothing is handed over, the failure is logged once, and no rejection goes
// unhandled.
{
  const unhandled = [];
  const recordUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", recordUnhandled);
  const failures = {
    refused: { ok: false, message: "Floating Slate registration failed." },
    unreachable: new Error("Could not establish connection. Receiving end does not exist.")
  };
  for (const [failure, registration] of Object.entries(failures)) {
    const { page, editor, send } = highlightedPage({ registration });
    assert.equal(page.keydown().defaultPrevented, true, `${failure}: the key is taken before registration settles`);
    await settle();
    page.loadFrame();
    assert.equal(page.overlay(), null, `${failure}: the overlay must be removed`);
    assert.deepEqual(page.selectionMessages(), [], `${failure}: nothing may be handed over`);
    assert.equal(page.warnings.length, 1, `${failure}: the failure must be logged once`);
    assert.equal(editor.textContent, DRAFT, `${failure}: the composer must be unchanged`);
    assert.equal(send.clicks, 0, `${failure}: nothing may be submitted`);
  }
  await settle();
  process.off("unhandledRejection", recordUnhandled);
  assert.deepEqual(unhandled, [], "a failed registration must not leave an unhandled rejection");
}

// The highlight's own spacing: a trailing space in the composer, as a Windows double-click takes
// with a word, and a leading and trailing space in the textarea composer.
const paddedHighlights = { contenteditable: "rough ", textarea: " rough " };
const ROUGH_DRAFT = "Keep this. Rough draft here. Keep that.";
const highlightBounds = (highlight) => [DRAFT.indexOf(highlight), DRAFT.indexOf(highlight) + highlight.length];

// Positive: the highlight's surrounding whitespace is kept around the processed text, however
// the model spaces it. The frame is still handed the highlight as it is.
for (const [kind, highlight] of Object.entries(paddedHighlights)) {
  for (const result of ["Rough", "Rough\n", "  Rough "]) {
    const situation = `${kind}, ${JSON.stringify(highlight)} highlighted, ${JSON.stringify(result)} returned`;
    const { page, read, sends } = composerPage(kind, highlightBounds(highlight));
    assert.equal((await processHighlight(page)).defaultPrevented, true, `${situation}: the key must be taken`);
    assert.deepEqual(page.selectionMessages(), [selectionMessage(highlight)], `${situation}: the frame must be handed the highlight as it is`);
    const outcome = await page.command("insert-submit", result);
    assert.equal(outcome.mode, "submitted", `${situation}: ${outcome.message}`);
    assert.equal(read(), ROUGH_DRAFT, `${situation}: the highlight's spacing must surround the trimmed result`);
    assert.equal(sends(), 1, `${situation}: Send must be pressed once`);
  }
}

// Positive: the spacing is kept only for the result that replaces the highlight. A further
// insertion goes in at the caret after it, exactly as given. The composer's manual fallback,
// used when insertText is unavailable, does the same.
for (const [situation, kind, options] of [
  ["contenteditable", "contenteditable", {}],
  ["textarea", "textarea", {}],
  ["contenteditable without insertText", "contenteditable", { execInsertText: false }]
]) {
  const { page, read } = composerPage(kind, highlightBounds(paddedHighlights[kind]), options);
  await processHighlight(page);
  const first = await page.command("insert", "Rough");
  assert.equal(first.mode, "inserted", `${situation}: ${first.message}`);
  assert.equal(read(), ROUGH_DRAFT, `${situation}: the first result must replace the highlight, spacing kept`);
  const second = await page.command("insert", " again ");
  assert.equal(second.mode, "inserted", `${situation}: ${second.message}`);
  // The caret sits after "Rough ", so the second result's own spaces sit beside it unchanged.
  assert.equal(read(), "Keep this. Rough  again draft here. Keep that.", `${situation}: the second result must go in at the caret as given`);
}

// Regression: Floating Slate opened at a caret with Alt + Shift + S has no highlight whose
// spacing to keep. Ctrl + Alt + F ("insert") and Ctrl + Alt + S ("insert-submit") put the result
// in exactly as given, and the caret target keeps accepting insertions after it.
const SPACED_RESULT = "  Spaced result\n";
for (const kind of ["contenteditable", "textarea"]) {
  for (const action of ["insert", "insert-submit"]) {
    const situation = `${kind} caret, ${action}`;
    const page = createPage();
    let read;
    let sends;
    if (kind === "textarea") {
      const composer = loggedOutComposer();
      page.slot.append(composer.form);
      composer.textarea.addEventListener("input", () => showTypedState(composer));
      await page.openOn(composer.textarea);
      read = () => composer.textarea.value;
      sends = () => composer.send.clicks;
    } else {
      const { editor, paragraph, send } = addLoggedInComposer(page, "form");
      await page.openOn(editor, paragraph);
      read = () => editor.textContent;
      sends = () => send.clicks;
    }
    const outcome = await page.command(action, SPACED_RESULT);
    assert.equal(outcome.mode, action === "insert" ? "inserted" : "submitted", `${situation}: ${outcome.message}`);
    assert.equal(read(), SPACED_RESULT, `${situation}: the result must be inserted exactly as given`);
    assert.equal(sends(), action === "insert" ? 0 : 1, `${situation}: Send must be pressed only to submit`);
    const next = await page.command("insert", SPACED_RESULT);
    assert.equal(next.mode, "inserted", `${situation}: the caret target must keep accepting insertions: ${next.message}`);
    assert.equal(read(), SPACED_RESULT.repeat(2), `${situation}: the next result must follow the first, as given`);
  }
}

// Negative: the user edits inside the highlight while Floating Slate processes it. The
// highlight no longer holds the text it was opened on, so SaySlate leaves the composer as the
// user left it, copies the result as the frame sent it, and submits nothing.
const EDITED_DRAFT = DRAFT.replace("rough", "rougher");
for (const kind of ["contenteditable", "textarea"]) {
  for (const [highlight, result] of [[HIGHLIGHT, POLISHED], [paddedHighlights[kind], "Rough\n"]]) {
    const situation = `${kind}, ${JSON.stringify(highlight)} edited`;
    const { page, field, read, write, sends } = composerPage(kind, highlightBounds(highlight));
    await processHighlight(page);
    write(EDITED_DRAFT);
    const outcome = await page.command("insert-submit", result);
    assert.equal(outcome.ok, false, `${situation}: a changed highlight must not be replaced`);
    assert.equal(outcome.mode, "copied", `${situation}: ${outcome.message}`);
    assert.match(outcome.message, /copied and was not submitted/);
    assert.equal(read(), EDITED_DRAFT, `${situation}: the composer must keep the user's edit`);
    assert.deepEqual(inputEvents(field), [], `${situation}: nothing may be inserted`);
    assert.deepEqual(page.clipboard, [result], `${situation}: the result must be copied as the frame sent it`);
    assert.equal(sends(), 0, `${situation}: nothing may be submitted`);
  }
}

console.log("Floating Slate insertion, ChatGPT composer submission, and fallback behavior verified.");
