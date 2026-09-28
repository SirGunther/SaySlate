// The logged-out ChatGPT composer, built with the test element model from a Playwright capture
// of chatgpt.com (no login) taken on 2026-09-28 with an empty composer and again with text
// typed. Attributes are copied from the capture's empty-composer state. The three buttons are
// the form's visible buttons in captured DOM order: add files, dictation, then Send.
import { element } from "./elementModel.mjs";

export const FORM_ATTRIBUTES = {
  action: "/unauth-mweb/conversation",
  autocomplete: "off",
  "data-announcement-thinking": "Thinking",
  "data-announcement-complete": "Response complete",
  "data-announcement-stopped": "Response stopped",
  "data-landing": "",
  "data-logged-out": "",
  "data-mobile-composer": "",
  method: "post"
};

export const TEXTAREA_ATTRIBUTES = {
  "aria-label": "Chat with ChatGPT",
  autocapitalize: "sentences",
  autocomplete: "off",
  autocorrect: "on",
  "data-mobile-composer-prompt": "",
  enterkeyhint: "enter",
  id: "mobile-composer-prompt",
  inputmode: "text",
  name: "prompt",
  placeholder: "Ask ChatGPT",
  required: "",
  rows: "1",
  spellcheck: "true"
};

export const ADD_FILES_ATTRIBUTES = {
  "aria-label": "Add files and more",
  "data-composer-action": "",
  "data-icon-only": "",
  "data-icon-position": "start",
  "data-icon-shape": "non-circular",
  "data-oai-tooltip": "",
  "data-oai-tooltip-side": "bottom",
  "data-radius": "full",
  "data-size": "medium",
  "data-variant": "ghost",
  "data-w-component": "button",
  popovertarget: "octane-mobile-composer-actions-popover",
  popovertargetaction: "toggle",
  type: "button"
};

export const DICTATION_ATTRIBUTES = {
  "aria-label": "Start dictation",
  "data-icon-only": "",
  "data-icon-position": "start",
  "data-icon-shape": "non-circular",
  "data-oai-tooltip": "",
  "data-oai-tooltip-side": "bottom",
  "data-radius": "full",
  "data-size": "medium",
  "data-start-dictation": "",
  "data-variant": "ghost",
  "data-w-component": "button",
  "data-idle-home": "",
  type: "button"
};

// With an empty composer Send is not ready: aria-disabled="true" and data-visually-disabled,
// while its disabled property stays false.
export const SEND_ATTRIBUTES = {
  "aria-disabled": "true",
  "aria-label": "Send message",
  "data-composer-submit": "",
  "data-icon-only": "",
  "data-icon-position": "start",
  "data-icon-shape": "non-circular",
  "data-oai-tooltip": "",
  "data-oai-tooltip-side": "bottom",
  "data-radius": "full",
  "data-send-label": "Send message",
  "data-size": "medium",
  "data-stop-label": "Stop generating",
  "data-variant": "primary",
  "data-visually-disabled": "",
  "data-w-component": "button",
  type: "submit"
};

export function loggedOutComposer() {
  const textarea = element("textarea", TEXTAREA_ATTRIBUTES);
  const addFiles = element("button", ADD_FILES_ATTRIBUTES);
  const dictation = element("button", DICTATION_ATTRIBUTES);
  const send = element("button", SEND_ATTRIBUTES);
  const form = element("form", FORM_ATTRIBUTES, [element("div", {}, [textarea]), addFiles, dictation, send]);
  return { form, textarea, addFiles, dictation, send };
}

// The changes the capture recorded once text was typed. Send's two not-ready attributes are
// removed, not set to "false".
export function showTypedState({ form, dictation, send }) {
  form.setAttribute("data-has-text", "");
  dictation.removeAttribute("data-idle-home");
  send.removeAttribute("aria-disabled");
  send.removeAttribute("data-visually-disabled");
}

// Presses of each button, in DOM order: add files, dictation, Send.
export const pressCounts = ({ addFiles, dictation, send }) => [addFiles.clicks, dictation.clicks, send.clicks];
