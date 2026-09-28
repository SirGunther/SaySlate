(() => {
  "use strict";

  // Every piece of ChatGPT page markup SaySlate relies on is declared here, once per role.
  // ProseMirror composer: the older `#prompt-textarea` id, and the current id-less editor marked `data-composer-markdown`.
  const COMPOSER_EDITOR_SELECTOR = "#prompt-textarea, [contenteditable='true'][data-composer-markdown]";
  // Textarea composer (logged-out `#mobile-composer-prompt`): a composer only when its form holds a send marker.
  const TEXTAREA_COMPOSER_SELECTOR = "textarea";
  // Send markers: the `#composer-submit-button` id, and `data-composer-submit` on the logged-out textarea composer's Send.
  const SEND_BUTTON_SELECTOR = "#composer-submit-button, button[data-composer-submit]";
  // Plain submit button: the logged-in Send (captured 2026-09-28) has no marker; trusted only inside the composer's ancestors.
  const SUBMIT_BUTTON_SELECTOR = "button[type='submit']";
  // The send button search walks up from the composer and stops before these page roots.
  const PAGE_ROOT_SELECTOR = "body, html";
  const COMPOSER_CANDIDATE_SELECTOR = `${COMPOSER_EDITOR_SELECTOR}, ${TEXTAREA_COMPOSER_SELECTOR}`;
  const DEFAULT_TIMEOUT_MS = 20000;
  const DEFAULT_POLL_MS = 150;

  function isChatGPTLocation(candidate = globalThis.location) {
    const hostname = String(candidate?.hostname || "").toLowerCase();
    return hostname === "chatgpt.com" || hostname.endsWith(".chatgpt.com");
  }

  function isChatGPTComposer(element) {
    if (!element?.matches) return false;
    if (element.matches(COMPOSER_EDITOR_SELECTOR)) return true;
    if (!element.matches(TEXTAREA_COMPOSER_SELECTOR)) return false;
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

  // The composer's own send button, ready or not: the nearest ancestor of the composer that
  // contains a send button decides, preferring a marked send button over a plain submit button
  // inside it. Without one, only a marked send button anywhere in the document qualifies.
  function findSendButton(composer, documentRef = globalThis.document) {
    for (let node = composer?.parentElement; node && !node.matches(PAGE_ROOT_SELECTOR); node = node.parentElement) {
      const button = node.querySelector(SEND_BUTTON_SELECTOR) || node.querySelector(SUBMIT_BUTTON_SELECTOR);
      if (button) return button;
    }
    return documentRef?.querySelector?.(SEND_BUTTON_SELECTOR) || null;
  }

  function readySendButton(composer, documentRef) {
    const button = findSendButton(composer, documentRef);
    if (!button || button.disabled || button.getAttribute?.("aria-disabled") === "true") return null;
    return button;
  }

  // The page's one visible ChatGPT composer, or null when there is none or more than one, so a
  // submission never guesses between composers.
  function findComposer(documentRef = globalThis.document) {
    const composers = Array.from(documentRef?.querySelectorAll?.(COMPOSER_CANDIDATE_SELECTOR) || [])
      .filter((candidate) => isChatGPTComposer(candidate) && candidate.getClientRects().length > 0);
    return composers.length === 1 ? composers[0] : null;
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

        const sendButton = readySendButton(composer, documentRef);
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
    findComposer,
    findSendButton,
    composerContains,
    waitForComposerAndSubmit
  });
})();
