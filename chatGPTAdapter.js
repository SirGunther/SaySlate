(() => {
  "use strict";

  // Every piece of ChatGPT page markup SaySlate relies on is declared here, once per role.
  // ProseMirror composer: the older `#prompt-textarea` id, and the current id-less editor marked `data-composer-markdown`.
  const COMPOSER_EDITOR_SELECTOR = "#prompt-textarea, [contenteditable='true'][data-composer-markdown]";
  // Textarea composer (logged-out `#mobile-composer-prompt`): a composer only when its form holds a send marker.
  const TEXTAREA_COMPOSER_SELECTOR = "textarea";
  // Send markers: the `#composer-submit-button` id, and `data-composer-submit` on the logged-out textarea composer's Send.
  const SEND_BUTTON_SELECTOR = "#composer-submit-button, button[data-composer-submit]";
  // Plain submit button: the logged-in Send (captured 2026-09-28) has no marker; trusted only inside the composer's own form.
  const SUBMIT_BUTTON_SELECTOR = "button[type='submit']";
  // The composer's own form: holds the textarea composer's send marker, and bounds the plain submit button search.
  const FORM_SELECTOR = "form";
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
    return Boolean(element.closest?.(FORM_SELECTOR)?.querySelector?.(SEND_BUTTON_SELECTOR));
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

  // The composer's send button, ready or not: in the composer's own form, a marked send button,
  // else its first plain submit button; otherwise a marked send button anywhere in the document.
  function findSendButton(composer, documentRef = globalThis.document) {
    // A type=submit button only submits its own form, so a plain one counts only in the composer's form.
    const form = composer?.closest?.(FORM_SELECTOR);
    const own = form ? form.querySelector(SEND_BUTTON_SELECTOR) || form.querySelector(SUBMIT_BUTTON_SELECTOR) : null;
    return own || documentRef?.querySelector?.(SEND_BUTTON_SELECTOR) || null;
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
