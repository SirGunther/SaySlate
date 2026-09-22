(() => {
  "use strict";

  const MESSAGE_TYPE = "sayslate-floating-shortcut";
  const ACTION_KEYS = Object.freeze(["d", "c", "x", "g", "e", "r", "f", "s"]);
  const ACTION_KEY_SET = new Set(ACTION_KEYS);

  function actionKeyFromEvent(event) {
    if (
      !event?.ctrlKey || !event?.altKey || event.shiftKey || event.metaKey || event.repeat ||
      typeof event.key !== "string"
    ) return "";
    const key = event.key.toLowerCase();
    return ACTION_KEY_SET.has(key) ? key : "";
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

  globalThis.SaySlateFloatingShortcuts = Object.freeze({
    ACTION_KEYS,
    MESSAGE_TYPE,
    actionKeyFromEvent,
    isEscapeEvent,
    createMessage,
    messageKey
  });
})();
