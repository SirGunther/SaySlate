(() => {
  "use strict";

  const MESSAGE_TYPE = "sayslate-floating-shortcut";
  const SELECTION_MESSAGE_TYPE = "sayslate-floating-selection";
  const ACTION_KEYS = Object.freeze(["d", "c", "x", "g", "e", "r", "f", "s"]);
  const ACTION_KEY_SET = new Set(ACTION_KEYS);
  // Pressed on the website while Floating Slate is closed, so it is not an action key the
  // open overlay relays to its iframe.
  const PROCESS_SELECTION_KEY = "p";

  function ctrlAltKeyFromEvent(event) {
    if (
      !event?.ctrlKey || !event?.altKey || event.shiftKey || event.metaKey || event.repeat ||
      typeof event.key !== "string"
    ) return "";
    return event.key.toLowerCase();
  }

  function actionKeyFromEvent(event) {
    const key = ctrlAltKeyFromEvent(event);
    return ACTION_KEY_SET.has(key) ? key : "";
  }

  function isProcessSelectionEvent(event) {
    return ctrlAltKeyFromEvent(event) === PROCESS_SELECTION_KEY;
  }

  function isEscapeEvent(event) {
    return event?.key === "Escape";
  }

  function createMessage(sessionId, key) {
    const normalizedKey = String(key || "").toLowerCase();
    if (!sessionId || !ACTION_KEY_SET.has(normalizedKey)) return null;
    return { type: MESSAGE_TYPE, sessionId, key: normalizedKey };
  }

  function messageKey(message, sessionId) {
    if (
      message?.type !== MESSAGE_TYPE || !sessionId || message.sessionId !== sessionId ||
      typeof message.key !== "string"
    ) return "";
    const key = message.key.toLowerCase();
    return ACTION_KEY_SET.has(key) ? key : "";
  }

  // Carries the website's highlighted text to the Floating Slate opened for it.
  function createSelectionMessage(sessionId, text) {
    if (!sessionId || typeof text !== "string" || !text.trim()) return null;
    return { type: SELECTION_MESSAGE_TYPE, sessionId, text };
  }

  function selectionText(message, sessionId) {
    if (
      message?.type !== SELECTION_MESSAGE_TYPE || !sessionId || message.sessionId !== sessionId ||
      typeof message.text !== "string" || !message.text.trim()
    ) return "";
    return message.text;
  }

  globalThis.SaySlateFloatingShortcuts = Object.freeze({
    ACTION_KEYS,
    MESSAGE_TYPE,
    SELECTION_MESSAGE_TYPE,
    PROCESS_SELECTION_KEY,
    actionKeyFromEvent,
    isProcessSelectionEvent,
    isEscapeEvent,
    createMessage,
    messageKey,
    createSelectionMessage,
    selectionText
  });
})();
