(() => {
  "use strict";

  if (globalThis.top !== globalThis) return;
  if (globalThis.__saySlateFloatingHostLoaded) return;
  globalThis.__saySlateFloatingHostLoaded = true;

  const HOST_ID = "sayslate-floating-host";
  const shortcuts = globalThis.SaySlateFloatingShortcuts;
  const chatGPT = globalThis.SaySlateChatGPT;
  const VIEWPORT_MARGIN = 12;
  const DEFAULT_WIDTH = 440;
  const DEFAULT_HEIGHT = 390;
  const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel"]);

  let host = null;
  let frame = null;
  let sessionId = "";
  let capturedTarget = null;
  let lastPointer = { x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) };
  let anchorRect = null;
  let lastToggleAt = 0;
  let frameReady = false;
  let pendingShortcutKeys = [];

  function isEditable(element) {
    if (!(element instanceof Element)) return false;
    if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
    if (element instanceof HTMLInputElement) {
      return TEXT_INPUT_TYPES.has(element.type) && !element.disabled && !element.readOnly;
    }
    return Boolean(element.isContentEditable);
  }

  function deepActiveElement(root = document) {
    let active = root.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active;
  }

  function activeEditable() {
    const active = deepActiveElement();
    if (isEditable(active)) return active;
    const selectionNode = getSelection()?.anchorNode;
    const selectionElement = selectionNode instanceof Element ? selectionNode : selectionNode?.parentElement;
    return selectionElement?.closest?.("[contenteditable='true'], [contenteditable='plaintext-only']") || null;
  }

  function captureEditable(element) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return {
        kind: "value",
        element,
        start: element.selectionStart ?? element.value.length,
        end: element.selectionEnd ?? element.value.length,
        originalValue: element.value
      };
    }

    if (element?.isContentEditable) {
      const selection = getSelection();
      let range = null;
      if (selection?.rangeCount) {
        const candidate = selection.getRangeAt(0);
        if (element.contains(candidate.commonAncestorContainer)) range = candidate.cloneRange();
      }
      if (!range) {
        range = document.createRange();
        range.selectNodeContents(element);
        range.collapse(false);
      }
      return { kind: "contenteditable", element, range };
    }

    return null;
  }

  function caretRectForValueField(element, offset) {
    const rect = element.getBoundingClientRect();
    const computed = getComputedStyle(element);
    const mirror = document.createElement("div");
    const marker = document.createElement("span");
    const copiedProperties = [
      "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight",
      "textTransform", "textIndent", "textAlign", "whiteSpace", "wordBreak", "overflowWrap",
      "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth",
      "borderRightWidth", "borderBottomWidth", "borderLeftWidth"
    ];

    mirror.setAttribute("aria-hidden", "true");
    Object.assign(mirror.style, {
      position: "fixed",
      visibility: "hidden",
      pointerEvents: "none",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      minHeight: `${rect.height}px`,
      overflow: "hidden",
      whiteSpace: element instanceof HTMLInputElement ? "pre" : "pre-wrap",
      overflowWrap: "break-word"
    });
    for (const property of copiedProperties) mirror.style[property] = computed[property];
    mirror.textContent = element.value.slice(0, offset);
    marker.textContent = "\u200b";
    mirror.append(marker);
    document.documentElement.append(mirror);
    const markerRect = marker.getBoundingClientRect();
    mirror.remove();
    return markerRect.width || markerRect.height ? markerRect : rect;
  }

  function editableAnchorRect(target) {
    if (!target) return null;
    if (target.kind === "value") return caretRectForValueField(target.element, target.start);
    try {
      const rect = target.range.getBoundingClientRect();
      if (rect.width || rect.height) return rect;
    } catch {
      // Fall back to the editable element bounds below.
    }
    return target.element.getBoundingClientRect();
  }

  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
  }

  function positionOverlay() {
    if (!host) return;
    const width = Math.min(DEFAULT_WIDTH, Math.max(0, innerWidth - VIEWPORT_MARGIN * 2));
    const height = Math.min(DEFAULT_HEIGHT, Math.max(0, innerHeight - VIEWPORT_MARGIN * 2));
    const rect = anchorRect || {
      left: lastPointer.x,
      right: lastPointer.x,
      top: lastPointer.y,
      bottom: lastPointer.y,
      width: 0,
      height: 0
    };
    const below = rect.bottom + 10;
    const above = rect.top - height - 10;
    const top = below + height <= innerHeight - VIEWPORT_MARGIN
      ? below
      : above >= VIEWPORT_MARGIN
        ? above
        : clamp(rect.top, VIEWPORT_MARGIN, innerHeight - height - VIEWPORT_MARGIN);
    const left = clamp(rect.left, VIEWPORT_MARGIN, innerWidth - width - VIEWPORT_MARGIN);

    Object.assign(host.style, {
      width: `${width}px`,
      height: `${height}px`,
      left: `${left}px`,
      top: `${top}px`
    });
  }

  function nativeValueSetter(element) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    return Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  }

  function insertIntoValueField(target, text) {
    const { element, start, end, originalValue } = target;
    if (!element.isConnected || element.value !== originalValue) return false;
    const nextValue = `${originalValue.slice(0, start)}${text}${originalValue.slice(end)}`;
    element.focus({ preventScroll: true });
    nativeValueSetter(element)?.call(element, nextValue);
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      composed: true,
      data: text,
      inputType: "insertText"
    }));
    const caret = start + text.length;
    element.setSelectionRange(caret, caret);
    target.start = caret;
    target.end = caret;
    target.originalValue = nextValue;
    return element.value === nextValue;
  }

  function insertIntoContentEditable(target, text) {
    const { element, range } = target;
    if (!element.isConnected || !range.startContainer?.isConnected) return false;
    element.focus({ preventScroll: true });
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    if (document.execCommand("insertText", false, text)) {
      if (selection.rangeCount) target.range = selection.getRangeAt(0).cloneRange();
      return true;
    }

    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    target.range = range.cloneRange();
    element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
    return true;
  }

  function restoreCapturedFocus() {
    try {
      if (capturedTarget?.kind === "value" && capturedTarget.element.isConnected) {
        capturedTarget.element.focus({ preventScroll: true });
        capturedTarget.element.setSelectionRange(capturedTarget.start, capturedTarget.end);
      } else if (capturedTarget?.kind === "contenteditable" && capturedTarget.element.isConnected) {
        capturedTarget.element.focus({ preventScroll: true });
        if (capturedTarget.range.startContainer?.isConnected) {
          const selection = getSelection();
          selection.removeAllRanges();
          selection.addRange(capturedTarget.range);
        }
      }
    } catch {
      // The page may have replaced its editor while the floating Slate was open.
    }
  }

  async function copyFallback(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.cssText = "position:fixed;opacity:0;pointer-events:none";
      document.body.append(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      return copied;
    }
  }

  async function commitText(text) {
    const normalizedText = String(text || "");
    let inserted = false;
    try {
      if (capturedTarget?.kind === "value") inserted = insertIntoValueField(capturedTarget, normalizedText);
      else if (capturedTarget?.kind === "contenteditable") inserted = insertIntoContentEditable(capturedTarget, normalizedText);
    } catch {
      inserted = false;
    }

    if (inserted) return { ok: true, mode: "inserted", message: "Inserted at the saved cursor" };
    const copied = await copyFallback(normalizedText);
    return copied
      ? { ok: true, mode: "copied", message: "The field changed, so the result was copied instead" }
      : { ok: false, mode: "failed", message: "Could not insert or copy the result. It remains open in SaySlate." };
  }

  async function commitAndSubmitToChatGPT(text) {
    if (!chatGPT?.isChatGPTLocation(location)) {
      return { ok: false, mode: "unsupported", message: "Process and submit is available only on ChatGPT." };
    }
    const composer = capturedTarget?.element;
    if (!chatGPT.isChatGPTComposer(composer)) {
      return { ok: false, mode: "wrong-target", message: "Place the cursor in the ChatGPT message composer before opening SaySlate." };
    }

    const insertion = await commitText(text);
    if (!insertion.ok || insertion.mode !== "inserted") {
      return {
        ok: false,
        mode: insertion.mode,
        message: insertion.mode === "copied"
          ? "The ChatGPT composer changed, so the result was copied and was not submitted."
          : insertion.message
      };
    }

    const submission = await chatGPT.waitForComposerAndSubmit({ composer, expectedText: text });
    return submission.ok
      ? { ok: true, mode: "submitted", message: submission.message }
      : { ok: false, mode: "inserted-not-submitted", message: submission.message };
  }

  async function unregisterSession() {
    if (!sessionId) return;
    try {
      await chrome.runtime.sendMessage({ type: "sayslate-host-unregister", sessionId });
    } catch {
      // Closing still succeeds if the service worker has already discarded the session.
    }
  }

  function closeOverlay() {
    const oldHost = host;
    restoreCapturedFocus();
    host = null;
    frame = null;
    capturedTarget = null;
    anchorRect = null;
    frameReady = false;
    pendingShortcutKeys = [];
    oldHost?.remove();
    void unregisterSession();
    sessionId = "";
    removeEventListener("resize", positionOverlay);
    removeEventListener("scroll", positionOverlay, true);
  }

  async function openOverlay() {
    if (host) {
      frame?.contentWindow?.focus();
      return;
    }

    const editable = activeEditable();
    capturedTarget = captureEditable(editable);
    anchorRect = editableAnchorRect(capturedTarget);
    sessionId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    host = document.createElement("div");
    host.id = HOST_ID;
    Object.assign(host.style, {
      all: "initial",
      position: "fixed",
      zIndex: "2147483647",
      display: "block",
      border: "0",
      margin: "0",
      padding: "0",
      colorScheme: "light dark"
    });
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      iframe {
        width: 100%; height: 100%; display: block; border: 0; border-radius: 18px;
        background: transparent; box-shadow: 0 24px 70px rgba(0,0,0,.28);
      }
    `;
    frame = document.createElement("iframe");
    const openingFrame = frame;
    frame.title = "SaySlate floating voice-to-text workspace";
    frame.allow = "microphone";
    frame.addEventListener("load", () => {
      if (!host || frame !== openingFrame) return;
      frameReady = true;
      const queuedKeys = pendingShortcutKeys.splice(0);
      for (const key of queuedKeys) routeFloatingShortcut(key);
    }, { once: true });
    const surface = chatGPT?.isChatGPTLocation(location) ? "chatgpt" : "other";
    frame.src = `${chrome.runtime.getURL("floating.html")}?session=${encodeURIComponent(sessionId)}&surface=${surface}`;
    shadow.append(style, frame);
    document.documentElement.append(host);
    positionOverlay();
    addEventListener("resize", positionOverlay);
    addEventListener("scroll", positionOverlay, true);

    try {
      const registration = await chrome.runtime.sendMessage({ type: "sayslate-host-register", sessionId });
      if (!registration?.ok) throw new Error(registration?.message || "Floating Slate registration failed.");
    } catch (error) {
      closeOverlay();
      throw error;
    }
  }

  async function toggleOverlay() {
    const now = Date.now();
    if (now - lastToggleAt < 250) return { ok: true, open: Boolean(host), deduplicated: true };
    lastToggleAt = now;
    if (host) {
      closeOverlay();
      return { ok: true, open: false };
    }
    await openOverlay();
    return { ok: true, open: true };
  }

  function routeFloatingShortcut(key) {
    if (!host || !sessionId) return;
    if (!frameReady) {
      pendingShortcutKeys.push(key);
      return;
    }
    frame?.contentWindow?.focus();
    const message = shortcuts?.createMessage(sessionId, key);
    if (!message) return;
    void chrome.runtime.sendMessage(message).catch((error) => {
      console.warn("SaySlate could not route a floating shortcut.", error);
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "sayslate-toggle-floating") {
      void toggleOverlay()
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, message: error?.message || "Floating Slate could not open." }));
      return true;
    }
    if (message?.type !== "sayslate-host-command" || message.sessionId !== sessionId) return;
    if (message.action === "close") {
      closeOverlay();
      sendResponse({ ok: true });
      return;
    }
    if (message.action === "insert") {
      void commitText(message.text).then(sendResponse);
      return true;
    }
    if (message.action === "insert-submit") {
      void commitAndSubmitToChatGPT(message.text).then(sendResponse);
      return true;
    }
  });

  addEventListener("pointermove", (event) => {
    lastPointer = { x: event.clientX, y: event.clientY };
  }, { passive: true });

  addEventListener("keydown", (event) => {
    if (!host || !shortcuts) return;

    if (shortcuts.isEscapeEvent(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeOverlay();
      return;
    }

    const key = shortcuts.actionKeyFromEvent(event);
    if (!key) return;
    if (key === "s" && !chatGPT?.isChatGPTLocation(location)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    routeFloatingShortcut(key);
  }, true);
})();
