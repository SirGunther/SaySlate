// The logged-in ChatGPT composer, built with the test element model from two captures of the
// logged-in chatgpt.com taken on 2026-09-28: the composer (tests/fixtures/chatgpt-composer-2026-09-28.html)
// and its send button (tests/fixtures/chatgpt-send-button-2026-09-28.html, identical in
// temporary and regular chats). The send button has no id, no data-composer-submit, and no
// data-testid. Where it sits relative to the composer was not captured, so both arrangements
// are built: "form" puts the composer and the button in one <form>, "wrapper" puts them in a
// shared <div> with no form. A type=submit button submits only its own form, so SaySlate
// presses the button in the "form" arrangement and never in the "wrapper" arrangement.
import { element } from "./elementModel.mjs";

export const EDITOR_ATTRIBUTES = {
  contenteditable: "true",
  "aria-multiline": "true",
  dir: "auto",
  role: "textbox",
  spellcheck: "true",
  translate: "no",
  class: "ProseMirror",
  "data-composer-markdown": "",
  "aria-label": "Ask ChatGPT",
  "data-virtualkeyboard": "true"
};

export const PARAGRAPH_ATTRIBUTES = {
  "data-empty-paragraph": "true",
  "data-placeholder": "Ask ChatGPT",
  class: "placeholder"
};

export const SEND_WRAPPER_ATTRIBUTES = { class: "flex items-center" };

export const SEND_ATTRIBUTES = {
  type: "submit",
  class: "cursor-interaction size-token-button-composer flex items-center justify-center rounded-full transition-opacity focus-visible:outline-2 bg-composer-primary p-0.5 focus-visible:outline-background-composer-primary",
  "aria-label": "Send"
};

export function loggedInComposer({ arrangement }) {
  if (arrangement !== "form" && arrangement !== "wrapper") throw new Error(`Unknown arrangement: ${arrangement}`);
  const paragraph = element("p", PARAGRAPH_ATTRIBUTES);
  const editor = element("div", EDITOR_ATTRIBUTES, [paragraph]);
  const send = element("button", SEND_ATTRIBUTES);
  const container = element(arrangement === "form" ? "form" : "div", {}, [
    element("div", { "data-composer-layout": "single-line" }, [
      element("div", { "data-rich-text-layout": "single-line", role: "presentation" }, [editor])
    ]),
    element("div", SEND_WRAPPER_ATTRIBUTES, [send])
  ]);
  return { container, editor, paragraph, send };
}

// App containers around the composer, as on chatgpt.com: `content` sits at div#app > main > div,
// with `siblings` ahead of main inside div#app. The caller appends `app` to body.
export function appShell(content, siblings = []) {
  const slot = element("div", {}, [content]);
  return { app: element("div", { id: "app" }, [...siblings, element("main", {}, [slot])]), slot };
}

// Enabled submit buttons that do not belong to the composer, in subtrees beside it: a
// navigation form's submit and a dialog's Dismiss.
export function unrelatedSubmits() {
  const navSubmit = element("button", { type: "submit", "aria-label": "Search" });
  const dismiss = element("button", { type: "submit", "aria-label": "Dismiss" });
  return {
    nav: element("nav", {}, [element("form", { role: "search" }, [navSubmit])]),
    dialog: element("div", { role: "dialog" }, [dismiss]),
    navSubmit,
    dismiss
  };
}

export const unrelatedPresses = ({ navSubmit, dismiss }) => [navSubmit.clicks, dismiss.clicks];
