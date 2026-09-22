(() => {
  "use strict";

  const SEND_BUTTON_SELECTOR = "#composer-submit-button";
  const DEFAULT_TIMEOUT_MS = 20000;
  const DEFAULT_POLL_MS = 150;

  function isChatGPTLocation(candidate = globalThis.location) {
    const hostname = String(candidate?.hostname || "").toLowerCase();
    return hostname === "chatgpt.com" || hostname.endsWith(".chatgpt.com");
  }

  function isChatGPTComposer(element) {
    if (!element?.matches) return false;
    if (element.matches("#prompt-textarea")) return true;
    if (!element.matches("textarea")) return false;
    return Boolean(element.closest?.("form")?.querySelector?.(SEND_BUTTON_SELECTOR));
  }

  function normalizedText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function composerContains(composer, expectedText) {
    const currentText = normalizedText(
      "value" in composer ? composer.value : (composer.innerText || composer.textContent)
    );
    const expected = normalizedText(expectedText);
    return Boolean(currentText && expected && currentText.includes(expected));
  }

  function readySendButton(documentRef) {
    const button = documentRef?.querySelector?.(SEND_BUTTON_SELECTOR);
    if (!button || button.disabled || button.getAttribute?.("aria-disabled") === "true") return null;
    return button;
  }

  function waitForComposerAndSubmit({
    composer,
    expectedText,
    documentRef = globalThis.document,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollMs = DEFAULT_POLL_MS
  }) {
    return new Promise((resolve) => {
      const startedAt = Date.now();

      function inspect() {
        if (composer?.isConnected === false) {
          resolve({ ok: false, message: "The ChatGPT composer was replaced before submission." });
          return;
        }

        const sendButton = readySendButton(documentRef);
        if (sendButton && composerContains(composer, expectedText)) {
          try {
            sendButton.click();
            resolve({ ok: true, message: "Inserted and submitted to ChatGPT" });
          } catch {
            resolve({ ok: false, message: "ChatGPT was ready, but its submit button could not be activated." });
          }
          return;
        }

        if (Date.now() - startedAt >= timeoutMs) {
          resolve({ ok: false, message: "The text was inserted, but ChatGPT did not become ready to submit within 20 seconds." });
          return;
        }
        globalThis.setTimeout(inspect, pollMs);
      }

      inspect();
    });
  }

  globalThis.SaySlateChatGPT = Object.freeze({
    SEND_BUTTON_SELECTOR,
    isChatGPTLocation,
    isChatGPTComposer,
    composerContains,
    waitForComposerAndSubmit
  });
})();
