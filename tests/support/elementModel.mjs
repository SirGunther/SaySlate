// A small element model for tests that load SaySlate content scripts in node:vm. It implements
// matches/closest/querySelector/querySelectorAll for the selector forms those scripts use (tag
// names, ids, [attr] and [attr='value'], comma lists). Any other selector form throws, so a
// changed selector fails its test instead of silently matching nothing. getClientRects follows
// Chrome: no boxes for an element outside a document or inside a `hidden` element (the hidden
// attribute is display:none in the user-agent stylesheet), otherwise one box.

function matchesCompound(node, selector) {
  const parts = selector.match(/^([a-z]+)?(#[\w-]+)?((?:\[[^\]]+\])*)$/i);
  if (!parts) throw new Error(`The test element model cannot evaluate selector: ${selector}`);
  const [, tag, id, attributes] = parts;
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  if (id && node.getAttribute("id") !== id.slice(1)) return false;
  for (const [, name, value] of attributes.matchAll(/\[([\w-]+)(?:='([^']*)')?\]/g)) {
    const actual = node.getAttribute(name);
    if (actual === null || (value !== undefined && actual !== value)) return false;
  }
  return true;
}

export class FakeElement {
  constructor(tag, attributes = {}, children = [], text = "") {
    this.tagName = tag.toUpperCase();
    this.attributes = { ...attributes };
    this.parentElement = null;
    this.children = [];
    this.text = text;
    this.style = {};
    this.events = [];
    this.listeners = {};
    this.clicks = 0;
    this.isRoot = false;
    this.documentRef = null;
    for (const child of children) this.append(child);
  }

  get id() { return this.attributes.id ?? ""; }
  set id(value) { this.attributes.id = String(value); }
  get disabled() { return "disabled" in this.attributes; }
  get isConnected() {
    let node = this;
    while (node.parentElement) node = node.parentElement;
    return node.isRoot;
  }
  get isContentEditable() {
    const value = this.attributes.contenteditable;
    if (value === "true" || value === "" || value === "plaintext-only") return true;
    if (value === "false") return false;
    return Boolean(this.parentElement?.isContentEditable);
  }
  get ownerDocument() {
    let node = this;
    while (node.parentElement) node = node.parentElement;
    return node.documentRef;
  }
  get textContent() { return this.text + this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this.text = String(value); this.children = []; }
  get innerText() { return this.textContent; }

  getAttribute(name) { return name in this.attributes ? String(this.attributes[name]) : null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  matches(selectorList) { return selectorList.split(",").some((selector) => matchesCompound(this, selector.trim())); }
  closest(selectorList) {
    for (let node = this; node; node = node.parentElement) {
      if (node.matches(selectorList)) return node;
    }
    return null;
  }
  querySelector(selectorList) {
    for (const child of this.children) {
      if (child.matches(selectorList)) return child;
      const nested = child.querySelector(selectorList);
      if (nested) return nested;
    }
    return null;
  }
  // Every matching descendant once, in document order.
  querySelectorAll(selectorList) {
    const found = [];
    for (const child of this.children) {
      if (child.matches(selectorList)) found.push(child);
      found.push(...child.querySelectorAll(selectorList));
    }
    return found;
  }
  contains(node) {
    for (let current = node; current; current = current.parentElement) {
      if (current === this) return true;
    }
    return false;
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parentElement?.children.splice(node.parentElement.children.indexOf(node), 1);
      node.parentElement = this;
      this.children.push(node);
    }
  }
  prepend(...nodes) {
    for (const node of [...nodes].reverse()) {
      node.parentElement?.children.splice(node.parentElement.children.indexOf(node), 1);
      node.parentElement = this;
      this.children.unshift(node);
    }
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  focus() {
    const documentRef = this.ownerDocument;
    if (documentRef) documentRef.activeElement = this;
  }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  removeEventListener(type, handler) {
    this.listeners[type] = (this.listeners[type] || []).filter((candidate) => candidate !== handler);
  }
  dispatchEvent(event) {
    this.events.push(event);
    for (const handler of this.listeners[event.type] || []) handler(event);
    return true;
  }
  click() { this.clicks += 1; }
  getBoundingClientRect() { return { left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20 }; }
  getClientRects() {
    if (!this.isConnected) return [];
    for (let node = this; node; node = node.parentElement) {
      if (node.getAttribute("hidden") !== null) return [];
    }
    return [this.getBoundingClientRect()];
  }
  attachShadow() { return { append() {} }; }
}

export class FakeTextArea extends FakeElement {
  constructor(attributes = {}, children = []) {
    super("textarea", attributes, children);
    this.storedValue = "";
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.readOnly = false;
  }
  get value() { return this.storedValue; }
  set value(next) { this.storedValue = String(next); }
  select() {}
  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
}

// Not a FakeTextArea subclass: floatingHost.js tells the two apart with instanceof and reads
// each prototype's own "value" setter, as it does for HTMLInputElement and HTMLTextAreaElement.
export class FakeInput extends FakeElement {
  constructor(attributes = {}, children = []) {
    super("input", attributes, children);
    this.storedValue = "";
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.readOnly = false;
  }
  get type() { return this.attributes.type ?? "text"; }
  get value() { return this.storedValue; }
  set value(next) { this.storedValue = String(next); }
  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
}

export function element(tag, attributes = {}, children = [], text = "") {
  if (tag === "textarea") return new FakeTextArea(attributes, children);
  if (tag === "input") return new FakeInput(attributes, children);
  return new FakeElement(tag, attributes, children, text);
}

export function rootElement(documentRef = null, children = []) {
  const root = new FakeElement("html", {}, children);
  root.isRoot = true;
  root.documentRef = documentRef;
  return root;
}
