// Opt-in real-browser check for Floating Slate insertion and ChatGPT submission.
//
// Not part of `node tests/verify.mjs`: SaySlate has no npm dependencies, and this check needs
// Playwright with the installed Chrome channel. It loads the working tree's
// chatGPTAdapter.js, shortcutProtocol.js, and floatingHost.js into real Chrome pages served at
// https://chatgpt.com/ by request interception (nothing is fetched from chatgpt.com), with a
// stubbed chrome.runtime standing in for background.js. The ProseMirror pages import
// ProseMirror from esm.sh, so they need network access.
//
//   SAYSLATE_PLAYWRIGHT=<path to playwright/index.mjs> node tests/browser/chatgpt-composer.browser.mjs
//     [--source <dir>]  load the three scripts from <dir> instead of this repository
//     [--live]          also run against the live logged-out chatgpt.com in a visible Chrome
//                       window; the send click is intercepted and conversation POSTs are
//                       aborted, so nothing is sent to ChatGPT
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const sourceIndex = args.indexOf("--source");
const sourceRoot = sourceIndex >= 0 ? path.resolve(args[sourceIndex + 1]) : extensionRoot;
const live = args.includes("--live");
const playwrightPath = process.env.SAYSLATE_PLAYWRIGHT;
const { chromium } = await import(playwrightPath ? pathToFileURL(playwrightPath).href : "playwright");

const TEXT = "Hello from SaySlate, dictated and cleaned up.";
const FIXTURE_PATH = "/__sayslate-fixture__/";
const artifact = fs.readFileSync(path.join(extensionRoot, "tests", "fixtures", "chatgpt-composer-2026-09-28.html"), "utf8");
// The logged-in send button, copied verbatim from the logged-in chatgpt.com on 2026-09-28
// (identical in temporary and regular chats): `button type="submit" aria-label="Send"` with no
// id, no data-composer-submit, and no data-testid.
const sendButtonArtifact = fs.readFileSync(path.join(extensionRoot, "tests", "fixtures", "chatgpt-send-button-2026-09-28.html"), "utf8");
const scripts = ["chatGPTAdapter.js", "shortcutProtocol.js", "floatingHost.js"]
  .map((file) => fs.readFileSync(path.join(sourceRoot, file), "utf8"));

// Stands in for background.js: floatingHost.js registers its session through sendMessage and
// receives host commands through onMessage. Every message the host sends is kept in
// __saySlateMessages, in order, for the cases that check what reached Floating Slate.
// getURL gives a data: URL so the overlay iframe loads the way the extension page does: later,
// as a separate origin. Chrome fires no load event for an iframe sent to about:blank#..., so a
// highlight handed over on load would never be sent. The runtime id is what a content script
// loses when the extension reloads under it.
const chromeStub = `(() => {
  const listeners = [];
  globalThis.__saySlateMessages = [];
  Object.defineProperty(globalThis, "chrome", { configurable: true, writable: true, value: { runtime: {
    id: "sayslate-test",
    getURL: (file) => "data:text/html," + file,
    onMessage: { addListener: (listener) => listeners.push(listener) },
    sendMessage: async (message) => {
      globalThis.__saySlateMessages.push(message);
      if (message?.type === "sayslate-host-register") globalThis.__saySlateSession = message.sessionId;
      return { ok: true };
    }
  } } });
  globalThis.__saySlateSend = (message) => new Promise((resolve) => {
    let responded = false;
    const keepOpen = listeners[0](message, {}, (response) => { responded = true; resolve(response); });
    if (keepOpen !== true && !responded) resolve(undefined);
  });
})();`;

// Page instrumentation shared by every fixture: events reaching the composer, send presses,
// and a focus target outside the composer. The send buttons on the artifact and ProseMirror
// pages are harness additions; the logged-in pages use the captured logged-in send button.
const instrumentation = `
<button id="elsewhere" type="button">Focus target outside the composer</button>
<iframe id="overlay-stand-in" title="Stands in for the Floating Slate iframe" src="https://example.org${FIXTURE_PATH}frame"></iframe>
<script>
  window.__events = [];
  window.__sendClicks = 0;
  window.__recordEvents = (node) => {
    for (const type of ["beforeinput", "input", "[object Object]"]) {
      node.addEventListener(type, (event) => window.__events.push({ type: event.type, inputType: event.inputType, data: event.data, bubbles: event.bubbles }));
    }
  };
</script>`;

// ChatGPT's app containers around the composer: `content` sits at body > div#app > main > div,
// with `siblings` ahead of main and `after` behind it, inside div#app.
const appShell = (content, { siblings = "", after = "" } = {}) =>
  `<div id="app">${siblings}<main><div class="composer-slot">${content}</div></main>${after}</div>`;

// Enabled submit buttons that do not belong to the composer, in subtrees ahead of it: a
// navigation form's submit and a dialog's Dismiss.
const unrelatedSubmits = `<nav><form role="search"><button type="submit" aria-label="Search">Search</button></form></nav>
<div role="dialog"><button type="submit" aria-label="Dismiss">Dismiss</button></div>`;

const pmImports = `
  import { EditorState } from "https://esm.sh/prosemirror-state@1.4.4?deps=prosemirror-model@1.25.12";
  import { EditorView } from "https://esm.sh/prosemirror-view@1.42.6?deps=prosemirror-model@1.25.12";
  import { schema } from "https://esm.sh/prosemirror-schema-basic@1.2.5?deps=prosemirror-model@1.25.12";`;

// Mounts a real ProseMirror editor where the captured composer sits, carrying the captured
// editor attributes. The send button is enabled from ProseMirror's own state, the way
// ChatGPT's is, so a press proves ProseMirror registered the inserted text.
function proseMirrorPage({ attributes, sendAttributes }) {
  return `<!doctype html><html><body>${appShell(artifact, { after: `<button ${sendAttributes} data-harness-send="" disabled type="button" onclick="window.__sendClicks += 1">Send</button>` })}
${instrumentation}
<script type="module">${pmImports}
  const mount = document.querySelector("[data-rich-text-layout]");
  mount.querySelector("[contenteditable]").remove();
  const send = document.querySelector("[data-harness-send]");
  let view;
  function create() {
    view = new EditorView(mount, {
      state: EditorState.create({ schema }),
      attributes: ${JSON.stringify(attributes)},
      // Harness addition: ProseMirror has no key bindings of its own and swallows Enter, so
      // Shift+Enter splits the paragraph here, for a draft typed as two paragraphs.
      handleKeyDown(editorView, event) {
        if (event.key !== "Enter" || !event.shiftKey) return false;
        const tr = editorView.state.tr.deleteSelection();
        editorView.dispatch(tr.split(tr.selection.from).scrollIntoView());
        return true;
      },
      dispatchTransaction(transaction) {
        view.updateState(view.state.apply(transaction));
        window.__pmText = view.state.doc.textContent;
        send.disabled = !window.__pmText.trim();
      }
    });
    window.__recordEvents(view.dom);
  }
  create();
  window.__remount = () => { view.destroy(); create(); };
  window.__pmReady = true;
</script></body></html>`;
}

// The captured logged-in composer and send button inside the app containers, with a real
// ProseMirror editor mounted where the captured editor sits. Where the send button sits
// relative to the composer was not captured, so `arrangement` puts both in one <form> ("form")
// or in a shared <div> with no form ("wrapper"); `send: false` leaves the button out.
// Harness additions: the button starts disabled and is enabled from ProseMirror's state, the
// way the existing ProseMirror pages do; every submit button press is recorded by label; form
// submission is blocked; a type="button" stands in for the temporary-chat toggle as a focus
// target that is not editable; `siblings` is markup ahead of main; `__setDraft` puts text in
// the editor through ProseMirror without focusing it, like a draft left in the composer.
function loggedInPage({ arrangement, siblings = "", send = true }) {
  const tag = arrangement === "form" ? "form" : "div";
  const toggle = `<button id="temporary-chat-toggle" type="button" aria-label="Temporary chat">Temporary chat</button>`;
  return `<!doctype html><html><body>
${appShell(`<${tag} id="composer-container">${artifact}${send ? sendButtonArtifact : ""}</${tag}>`, { siblings: `${toggle}\n${siblings}` })}
${instrumentation}
<script type="module">${pmImports}
  const container = document.querySelector("#composer-container");
  const mount = container.querySelector("[data-rich-text-layout]");
  mount.querySelector("[contenteditable]").remove();
  const send = container.querySelector("button[aria-label='Send']");
  if (send) {
    send.disabled = true;
    send.addEventListener("click", () => { window.__sendClicks += 1; });
  }
  window.__presses = [];
  for (const button of document.querySelectorAll("button[type='submit']")) {
    button.addEventListener("click", () => window.__presses.push(button.getAttribute("aria-label")));
  }
  window.__formSubmits = 0;
  document.addEventListener("submit", (event) => { event.preventDefault(); window.__formSubmits += 1; });
  const view = new EditorView(mount, {
    state: EditorState.create({ schema }),
    attributes: { "data-composer-markdown": "", "aria-label": "Ask ChatGPT", role: "textbox", "aria-multiline": "true", translate: "no" },
    dispatchTransaction(transaction) {
      view.updateState(view.state.apply(transaction));
      window.__pmText = view.state.doc.textContent;
      if (send) send.disabled = !window.__pmText.trim();
    }
  });
  window.__recordEvents(view.dom);
  window.__setDraft = (text) => view.dispatch(view.state.tr.insertText(text, 1));
  window.__pmReady = true;
</script></body></html>`;
}

// The logged-out composer captured from chatgpt.com on 2026-09-28 (Playwright, no login, empty
// composer): the form and textarea attributes, and the form's three visible buttons in captured
// order (add files, dictation, Send) as captured, icons reduced to <svg/> by the capture. Every
// button press is recorded with whether the button was ready. With `becomesReady`, the page
// applies the captured typed-composer changes a moment after each input event, as ChatGPT does
// once it registers the text, so Send starts not ready and becomes ready later.
function loggedOutPage({ becomesReady }) {
  const ready = `
  textarea.addEventListener("input", () => setTimeout(() => {
    const typed = Boolean(textarea.value.trim());
    form.toggleAttribute("data-has-text", typed);
    dictation.toggleAttribute("data-idle-home", !typed);
    send.toggleAttribute("data-visually-disabled", !typed);
    if (typed) send.removeAttribute("aria-disabled");
    else send.setAttribute("aria-disabled", "true");
  }, 50));`;
  return `<!doctype html><html><body>
<div id="app">
<nav><textarea id="search" name="search" aria-label="Search chats"></textarea></nav>
<main><div class="composer-slot">
<form action="/unauth-mweb/conversation" autocomplete="off" data-announcement-thinking="Thinking" data-announcement-complete="Response complete" data-announcement-stopped="Response stopped" data-landing="" data-logged-out="" data-mobile-composer="" method="post">
  <div data-composer-editor-host=""><textarea aria-label="Chat with ChatGPT" autocapitalize="sentences" autocomplete="off" autocorrect="on" data-mobile-composer-prompt="" enterkeyhint="enter" id="mobile-composer-prompt" inputmode="text" name="prompt" placeholder="Ask ChatGPT" required="" rows="1" spellcheck="true"></textarea></div>
  <button aria-label="Add files and more" data-composer-action="" data-icon-only="" data-icon-position="start" data-icon-shape="non-circular" data-oai-tooltip="" data-oai-tooltip-side="bottom" data-octane-native-image-menu-trigger="" data-radius="full" data-size="medium" data-variant="ghost" data-w-component="button" popovertarget="octane-mobile-composer-actions-popover" popovertargetaction="toggle" type="button" data-octane-bindings="d:1a27fb8a"><span aria-hidden="true"><svg/></span></button>
  <button aria-label="Start dictation" data-icon-only="" data-icon-position="start" data-icon-shape="non-circular" data-oai-tooltip="" data-oai-tooltip-side="bottom" data-radius="full" data-size="medium" data-start-dictation="" data-variant="ghost" data-w-component="button" data-idle-home="" type="button" data-octane-bindings="d:a5eb6e17"><span aria-hidden="true"><svg/></span><span aria-hidden="true" hidden=""><svg/></span></button>
  <button aria-disabled="true" aria-label="Send message" data-composer-submit="" data-icon-only="" data-icon-position="start" data-icon-shape="non-circular" data-oai-tooltip="" data-oai-tooltip-side="bottom" data-radius="full" data-send-label="Send message" data-size="medium" data-stop-label="Stop generating" data-variant="primary" data-visually-disabled="" data-w-component="button" type="submit"><span data-composer-send-icon=""><svg/></span><span data-composer-loading-icon="" aria-hidden="true" hidden=""><svg/></span><span data-composer-stop-icon="" hidden=""><svg/></span></button>
</form>
</div></main>
</div>
${instrumentation}
<script>
  const form = document.querySelector("form[data-mobile-composer]");
  const textarea = document.querySelector("#mobile-composer-prompt");
  const dictation = form.querySelector("[data-start-dictation]");
  const send = form.querySelector("[data-composer-submit]");
  window.__recordEvents(textarea);
  window.__presses = [];
  for (const button of form.querySelectorAll("button")) {
    button.addEventListener("click", () => window.__presses.push({
      label: button.getAttribute("aria-label"),
      ready: !button.hasAttribute("aria-disabled") && !button.hasAttribute("data-visually-disabled")
    }));
  }${becomesReady ? ready : ""}
  form.addEventListener("submit", (event) => { event.preventDefault(); window.__sendClicks += 1; });
</script></body></html>`;
}

const pages = {
  artifact: `<!doctype html><html><body>${appShell(artifact, { after: `<button id="composer-submit-button" disabled type="button" onclick="window.__sendClicks += 1">Send</button>` })}
${instrumentation}
<script>
  const editor = document.querySelector("[data-composer-markdown]");
  window.__recordEvents(editor);
  editor.addEventListener("input", () => {
    document.querySelector("#composer-submit-button").disabled = !editor.innerText.trim();
  });
</script></body></html>`,
  "prosemirror-current": proseMirrorPage({
    attributes: { "data-composer-markdown": "", "aria-label": "Ask ChatGPT", role: "textbox", "aria-multiline": "true", translate: "no" },
    sendAttributes: 'id="composer-submit-button"'
  }),
  "prosemirror-legacy": proseMirrorPage({
    attributes: { id: "prompt-textarea", "aria-label": "Ask ChatGPT" },
    sendAttributes: 'id="composer-submit-button"'
  }),
  "prosemirror-unmarked": proseMirrorPage({
    attributes: { "aria-label": "Document editor" },
    sendAttributes: 'id="composer-submit-button"'
  }),
  "logged-in-form": loggedInPage({ arrangement: "form" }),
  "logged-in-wrapper": loggedInPage({ arrangement: "wrapper" }),
  "logged-in-unrelated-submit": loggedInPage({ arrangement: "form", siblings: unrelatedSubmits }),
  // The reviewers' layout: no send button of the composer's own, unrelated submit buttons ahead.
  "logged-in-no-send-unrelated-submit": loggedInPage({ arrangement: "wrapper", send: false, siblings: unrelatedSubmits }),
  // A second visible copy of the captured composer ahead of the ProseMirror one.
  "logged-in-two-composers": loggedInPage({ arrangement: "form", siblings: `<div id="second-composer">${artifact}</div>` }),
  // A second copy of the captured composer hidden by a stylesheet (display: none), not by the
  // hidden attribute.
  "logged-in-css-hidden-duplicate": loggedInPage({
    arrangement: "form",
    siblings: `<style>.duplicate-composer { display: none; }</style><div class="duplicate-composer" id="duplicate-composer">${artifact}</div>`
  }),
  "logged-out": loggedOutPage({ becomesReady: true }),
  // The same page ignoring input, so Send never becomes ready.
  "logged-out-never-ready": loggedOutPage({ becomesReady: false }),
  "never-ready": `<!doctype html><html><body>${appShell(artifact, { after: `<button id="composer-submit-button" disabled type="button" onclick="window.__sendClicks += 1">Send</button>` })}
${instrumentation}
<script>window.__recordEvents(document.querySelector("[data-composer-markdown]"));</script></body></html>`,
  frame: `<!doctype html><html><body><textarea aria-label="Floating Slate transcript stand-in"></textarea></body></html>`
};

async function routeFixtures(context) {
  for (const origin of ["https://chatgpt.com", "https://example.com", "https://example.org"]) {
    await context.route(`${origin}${FIXTURE_PATH}**`, (route) => {
      const name = new URL(route.request().url()).pathname.slice(FIXTURE_PATH.length);
      if (!(name in pages)) return route.fulfill({ status: 404, body: "missing fixture" });
      return route.fulfill({ contentType: "text/html", body: pages[name] });
    });
  }
}

async function injectSaySlate(page) {
  await page.addScriptTag({ content: chromeStub });
  for (const content of scripts) await page.addScriptTag({ content });
}

// Focus the composer, open Floating Slate on it, move focus away, then send the command
// Floating Slate sends when its passes finish.
async function runCommand(page, { focus, action, focusAway = "frame", beforeCommand }) {
  await page.click(focus);
  const opened = await page.evaluate(() => globalThis.__saySlateSend({ type: "sayslate-toggle-floating" }));
  if (!opened?.ok) throw new Error(`Floating Slate did not open: ${JSON.stringify(opened)}`);
  // Focus is moved by script: the open overlay covers the page below the composer, so a
  // pointer click on these targets would land on the overlay instead.
  if (focusAway === "frame") await page.frameLocator("#overlay-stand-in").locator("textarea").focus();
  else await page.focus("#elsewhere");
  if (beforeCommand) await beforeCommand();
  return page.evaluate(([commandAction, text]) => globalThis.__saySlateSend({
    type: "sayslate-host-command",
    sessionId: globalThis.__saySlateSession,
    action: commandAction,
    text
  }), [action, TEXT]);
}

const pageState = (page, selector) => page.evaluate((composerSelector) => {
  const composer = document.querySelector(composerSelector);
  return {
    text: composer ? ("value" in composer ? composer.value : composer.innerText).trim() : null,
    pmText: window.__pmText ?? null,
    sendClicks: window.__sendClicks,
    presses: window.__presses ?? null,
    events: window.__events
  };
}, selector);

const results = [];
function record(id, name, expected, checks, detail) {
  const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([label]) => label);
  results.push({ id, name, expected, pass: failed.length === 0, detail: failed.length ? `failed: ${failed.join("; ")} | ${detail}` : detail });
}

async function scenario(browser, { id, name, expected, fixture, host = "https://chatgpt.com", run }) {
  const context = await browser.newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: host });
  await routeFixtures(context);
  const page = await context.newPage();
  try {
    await page.goto(`${host}${FIXTURE_PATH}${fixture}`);
    if (fixture.startsWith("prosemirror") || fixture.startsWith("logged-in")) await page.waitForFunction(() => window.__pmReady === true, null, { timeout: 30000 });
    await injectSaySlate(page);
    const { checks, detail } = await run(page);
    record(id, name, expected, checks, detail);
  } catch (error) {
    record(id, name, expected, { "scenario ran": false }, error.message.split("\n")[0]);
  } finally {
    await context.close();
  }
}

const inputEventTypes = (state) => state.events.filter((event) => event.type !== "beforeinput").map((event) => event.type);
const summary = (result, state) => `mode=${result?.mode}; text=${JSON.stringify(state.text)}; pm=${JSON.stringify(state.pmText)}; clicks=${state.sendClicks}; events=${JSON.stringify(inputEventTypes(state))}`;

const browser = await chromium.launch({ channel: "chrome", headless: true });
const COMPOSER = "[contenteditable='true']";

await scenario(browser, {
  id: "B1", name: "Captured composer markup, process and submit", expected: "positive", fixture: "artifact",
  run: async (page) => {
    const result = await runCommand(page, { focus: COMPOSER, action: "insert-submit" });
    const state = await pageState(page, COMPOSER);
    return { checks: { submitted: result?.mode === "submitted", "text inserted": state.text === TEXT, "pressed once": state.sendClicks === 1 }, detail: summary(result, state) };
  }
});

await scenario(browser, {
  id: "B2", name: "Real ProseMirror composer, process and submit", expected: "positive", fixture: "prosemirror-current",
  run: async (page) => {
    const result = await runCommand(page, { focus: COMPOSER, action: "insert-submit" });
    const state = await pageState(page, COMPOSER);
    return { checks: { submitted: result?.mode === "submitted", "ProseMirror state holds text": state.pmText === TEXT, "pressed once": state.sendClicks === 1 }, detail: summary(result, state) };
  }
});

await scenario(browser, {
  id: "B3", name: "Real ProseMirror, insertText unavailable (manual fallback)", expected: "positive", fixture: "prosemirror-current",
  run: async (page) => {
    await page.evaluate(() => {
      const native = Document.prototype.execCommand;
      document.execCommand = function execCommand(command, ...rest) {
        return command === "insertText" ? false : native.call(this, command, ...rest);
      };
    });
    const result = await runCommand(page, { focus: COMPOSER, action: "insert" });
    const state = await pageState(page, COMPOSER);
    const types = inputEventTypes(state);
    return {
      checks: {
        inserted: result?.mode === "inserted",
        "ProseMirror state holds text": state.pmText === TEXT,
        'one "input" event': types.length === 1 && types[0] === "input"
      },
      detail: summary(result, state)
    };
  }
});

await scenario(browser, {
  id: "B4", name: "#prompt-textarea ProseMirror composer (v1.11.4 markup)", expected: "positive", fixture: "prosemirror-legacy",
  run: async (page) => {
    const result = await runCommand(page, { focus: COMPOSER, action: "insert-submit" });
    const state = await pageState(page, COMPOSER);
    return { checks: { submitted: result?.mode === "submitted", "ProseMirror state holds text": state.pmText === TEXT, "pressed once": state.sendClicks === 1 }, detail: summary(result, state) };
  }
});

await scenario(browser, {
  id: "B5", name: "Logged-out textarea composer, Send ready after input (captured markup)", expected: "positive", fixture: "logged-out",
  run: async (page) => {
    const result = await runCommand(page, { focus: "#mobile-composer-prompt", action: "insert-submit" });
    const state = await pageState(page, "#mobile-composer-prompt");
    return {
      checks: {
        submitted: result?.mode === "submitted",
        "text inserted": state.text === TEXT,
        "only Send pressed, once, when ready": JSON.stringify(state.presses) === JSON.stringify([{ label: "Send message", ready: true }]),
        "form submitted once": state.sendClicks === 1
      },
      detail: `${summary(result, state)}; presses=${JSON.stringify(state.presses)}`
    };
  }
});

await scenario(browser, {
  id: "B6", name: "Composer replaced while Floating Slate is open", expected: "negative", fixture: "prosemirror-current",
  run: async (page) => {
    const result = await runCommand(page, {
      focus: COMPOSER,
      action: "insert-submit",
      focusAway: "button",
      beforeCommand: () => page.evaluate(() => window.__remount())
    });
    const state = await pageState(page, COMPOSER);
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    return {
      checks: {
        "not submitted": state.sendClicks === 0,
        "reported copied": result?.ok === false && result?.mode === "copied",
        "new composer untouched": !state.pmText,
        "clipboard holds text": clipboard === TEXT
      },
      detail: `${summary(result, state)}; clipboard=${JSON.stringify(clipboard)}`
    };
  }
});

await scenario(browser, {
  id: "B7", name: "Saved target is another chatgpt.com field: composer found and submitted", expected: "positive", fixture: "logged-out",
  run: async (page) => {
    const result = await runCommand(page, { focus: "#search", action: "insert-submit" });
    const state = await pageState(page, "#mobile-composer-prompt");
    const search = await pageState(page, "#search");
    return {
      checks: {
        submitted: result?.mode === "submitted",
        "text in composer": state.text === TEXT,
        "other field unchanged": search.text === "",
        "only Send pressed, once, when ready": JSON.stringify(state.presses) === JSON.stringify([{ label: "Send message", ready: true }])
      },
      detail: `${summary(result, state)}; search=${JSON.stringify(search.text)}; presses=${JSON.stringify(state.presses)}`
    };
  }
});

await scenario(browser, {
  id: "B8", name: "ProseMirror editor without composer markers", expected: "negative", fixture: "prosemirror-unmarked",
  run: async (page) => {
    const result = await runCommand(page, { focus: COMPOSER, action: "insert-submit" });
    const state = await pageState(page, COMPOSER);
    return { checks: { "wrong-target": result?.mode === "wrong-target", "editor unchanged": !state.pmText, "not submitted": state.sendClicks === 0 }, detail: summary(result, state) };
  }
});

await scenario(browser, {
  id: "B9", name: "Same composer on a non-ChatGPT host", expected: "negative", fixture: "artifact", host: "https://example.com",
  run: async (page) => {
    const result = await runCommand(page, { focus: COMPOSER, action: "insert-submit" });
    const state = await pageState(page, COMPOSER);
    return { checks: { unsupported: result?.mode === "unsupported", "composer unchanged": state.text === "", "not submitted": state.sendClicks === 0 }, detail: summary(result, state) };
  }
});

await scenario(browser, {
  id: "B10", name: "Send button never becomes enabled (20 s bound)", expected: "negative", fixture: "never-ready",
  run: async (page) => {
    const result = await runCommand(page, { focus: COMPOSER, action: "insert-submit" });
    const state = await pageState(page, COMPOSER);
    return { checks: { "inserted-not-submitted": result?.mode === "inserted-not-submitted", "text kept in composer": state.text === TEXT, "not submitted": state.sendClicks === 0 }, detail: summary(result, state) };
  }
});

await scenario(browser, {
  id: "B11", name: "Logged-out Send button never becomes ready (20 s bound)", expected: "negative", fixture: "logged-out-never-ready",
  run: async (page) => {
    const result = await runCommand(page, { focus: "#mobile-composer-prompt", action: "insert-submit" });
    const state = await pageState(page, "#mobile-composer-prompt");
    return {
      checks: {
        "inserted-not-submitted": result?.mode === "inserted-not-submitted",
        "text kept in composer": state.text === TEXT,
        "no button pressed": state.presses?.length === 0 && state.sendClicks === 0
      },
      detail: `${summary(result, state)}; presses=${JSON.stringify(state.presses)}`
    };
  }
});

const LOGGED_IN_COMPOSER = "#composer-container [contenteditable='true']";
const loggedInChecks = (result, state) => ({
  submitted: result?.mode === "submitted",
  "ProseMirror state holds text": state.pmText === TEXT,
  "only captured Send pressed, once": state.sendClicks === 1 && JSON.stringify(state.presses) === JSON.stringify(["Send"])
});
const notPressedChecks = (result, state) => ({
  "inserted-not-submitted": result?.mode === "inserted-not-submitted",
  "ProseMirror state holds text": state.pmText === TEXT,
  "no submit button pressed": state.sendClicks === 0 && state.presses?.length === 0 && state.formSubmits === 0
});
const loggedInState = async (page) => ({
  ...(await pageState(page, LOGGED_IN_COMPOSER)),
  formSubmits: await page.evaluate(() => window.__formSubmits)
});
const pressDetail = (result, state) => `${summary(result, state)}; presses=${JSON.stringify(state.presses)}; formSubmits=${state.formSubmits}`;

await scenario(browser, {
  id: "B12", name: "Logged-in composer and captured Send in one form, process and submit", expected: "positive", fixture: "logged-in-form",
  run: async (page) => {
    const result = await runCommand(page, { focus: LOGGED_IN_COMPOSER, action: "insert-submit" });
    const state = await loggedInState(page);
    return { checks: loggedInChecks(result, state), detail: pressDetail(result, state) };
  }
});

await scenario(browser, {
  id: "B13", name: "Captured Send shares only a wrapper (no form) with the composer: not pressed (20 s bound)", expected: "negative", fixture: "logged-in-wrapper",
  run: async (page) => {
    const result = await runCommand(page, { focus: LOGGED_IN_COMPOSER, action: "insert-submit" });
    const state = await loggedInState(page);
    return { checks: notPressedChecks(result, state), detail: pressDetail(result, state) };
  }
});

await scenario(browser, {
  id: "B14", name: "Opened while the temporary-chat toggle stand-in has focus: composer found and submitted", expected: "positive", fixture: "logged-in-form",
  run: async (page) => {
    const result = await runCommand(page, { focus: "#temporary-chat-toggle", action: "insert-submit" });
    const state = await loggedInState(page);
    return { checks: loggedInChecks(result, state), detail: pressDetail(result, state) };
  }
});

await scenario(browser, {
  id: "B15", name: "Enabled unrelated submit buttons (nav form, dialog) ahead of the composer are never pressed", expected: "negative", fixture: "logged-in-unrelated-submit",
  run: async (page) => {
    const result = await runCommand(page, { focus: LOGGED_IN_COMPOSER, action: "insert-submit" });
    const state = await loggedInState(page);
    return { checks: loggedInChecks(result, state), detail: pressDetail(result, state) };
  }
});

await scenario(browser, {
  id: "B16", name: "Two visible composers, cursor in neither", expected: "negative", fixture: "logged-in-two-composers",
  run: async (page) => {
    const result = await runCommand(page, { focus: "#temporary-chat-toggle", action: "insert-submit" });
    const state = await pageState(page, LOGGED_IN_COMPOSER);
    const second = await pageState(page, "#second-composer [contenteditable='true']");
    return {
      checks: {
        "wrong-target": result?.mode === "wrong-target",
        "neither composer filled": !state.pmText && state.text === "" && second.text === "",
        "not submitted": state.sendClicks === 0
      },
      detail: `${summary(result, state)}; second=${JSON.stringify(second.text)}`
    };
  }
});

await scenario(browser, {
  id: "B17", name: "No send button of the composer's own, unrelated submit buttons in other subtrees: nothing pressed (20 s bound)", expected: "negative", fixture: "logged-in-no-send-unrelated-submit",
  run: async (page) => {
    const result = await runCommand(page, { focus: LOGGED_IN_COMPOSER, action: "insert-submit" });
    const state = await loggedInState(page);
    return { checks: notPressedChecks(result, state), detail: pressDetail(result, state) };
  }
});

await scenario(browser, {
  id: "B18", name: "Duplicate composer hidden by a stylesheet: the visible one is found and submitted", expected: "positive", fixture: "logged-in-css-hidden-duplicate",
  run: async (page) => {
    const result = await runCommand(page, { focus: "#temporary-chat-toggle", action: "insert-submit" });
    const state = await loggedInState(page);
    const duplicate = await pageState(page, "#duplicate-composer [contenteditable='true']");
    return {
      checks: { ...loggedInChecks(result, state), "hidden duplicate untouched": duplicate.text === "" },
      detail: `${pressDetail(result, state)}; duplicate=${JSON.stringify(duplicate.text)}`
    };
  }
});

// No trailing space: Chrome collapses a trailing space when text is inserted after it.
const DRAFT = "An earlier draft.";
await scenario(browser, {
  id: "B19", name: "Composer holds a draft, opened on the toggle stand-in: text goes after the draft", expected: "positive", fixture: "logged-in-form",
  run: async (page) => {
    await page.evaluate((draft) => window.__setDraft(draft), DRAFT);
    const result = await runCommand(page, { focus: "#temporary-chat-toggle", action: "insert-submit" });
    const state = await loggedInState(page);
    return {
      checks: {
        submitted: result?.mode === "submitted",
        "draft first, then text": state.pmText?.startsWith(DRAFT) && state.pmText.endsWith(TEXT) && state.pmText.length === DRAFT.length + TEXT.length,
        "only captured Send pressed, once": state.sendClicks === 1 && JSON.stringify(state.presses) === JSON.stringify(["Send"])
      },
      detail: pressDetail(result, state)
    };
  }
});

// Ctrl+Alt+P: with Floating Slate closed, text highlighted in the composer is handed to Floating
// Slate, whose result then replaces the highlight and is submitted. The draft is typed and the
// highlight made with real key presses, the way a user highlights from the keyboard.
const KEEP_BEFORE = "Keep this. ";
const KEEP_AFTER = " Keep that.";
const HIGHLIGHT = "rough draft here.";
const POLISHED = "Polished text.";
const REPLACED = `${KEEP_BEFORE}${POLISHED}${KEEP_AFTER}`;
const ONE_PARAGRAPH = { paragraphs: [`${KEEP_BEFORE}${HIGHLIGHT}${KEEP_AFTER}`], after: KEEP_AFTER.length, length: HIGHLIGHT.length };
// "rough start" ends the first paragraph and "rough end." begins the second; one Shift+ArrowLeft
// crosses the break between them.
const TWO_PARAGRAPHS = {
  paragraphs: [`${KEEP_BEFORE}rough start`, `rough end.${KEEP_AFTER}`],
  after: KEEP_AFTER.length,
  length: "rough end.".length + 1 + "rough start".length
};
const PROCESS_SELECTION_KEY = "Control+Alt+KeyP";

// Clicks the field, types `paragraphs` with Shift+Enter between them, moves the caret back over
// the last `after` characters, and highlights the `length` characters before it.
async function typeAndHighlight(page, field, { paragraphs, after, length }) {
  await page.click(field);
  for (const [index, paragraph] of paragraphs.entries()) {
    if (index) await page.keyboard.press("Shift+Enter");
    await page.keyboard.type(paragraph);
  }
  for (let step = 0; step < after; step += 1) await page.keyboard.press("ArrowLeft");
  for (let step = 0; step < length; step += 1) await page.keyboard.press("Shift+ArrowLeft");
}

// Presses Ctrl+Alt+P and reports what it did. A key SaySlate consumes stops in its window
// capture listener, so it never reaches the document listener installed here.
async function pressProcessSelection(page, { expectMessage }) {
  const highlighted = await page.evaluate(() => {
    window.__processKeys = [];
    document.addEventListener("keydown", (event) => {
      if (event.code === "KeyP") {
        window.__processKeys.push({ key: event.key, ctrl: event.ctrlKey, alt: event.altKey, defaultPrevented: event.defaultPrevented, inEditor: event.target?.isContentEditable === true });
      }
    });
    const active = document.activeElement;
    return active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement
      ? active.value.slice(active.selectionStart, active.selectionEnd)
      : getSelection().toString();
  });
  await page.keyboard.press(PROCESS_SELECTION_KEY);
  if (expectMessage) {
    await page.waitForFunction(() => globalThis.__saySlateMessages.some((message) => message.type === "sayslate-floating-selection"), null, { timeout: 5000 })
      .catch(() => {});
  }
  // Time for a duplicate selection message, or for one that should not come at all.
  await page.waitForTimeout(500);
  return page.evaluate((selected) => ({
    highlighted: selected,
    reachedPage: window.__processKeys,
    overlay: Boolean(document.getElementById("sayslate-floating-host")),
    focusInOverlay: document.activeElement?.id === "sayslate-floating-host",
    session: globalThis.__saySlateSession ?? null
  }), highlighted);
}

const selectionMessages = (page) => page.evaluate(() => globalThis.__saySlateMessages.filter((message) => message.type === "sayslate-floating-selection"));
const sendResult = (page, resultText = POLISHED) => page.evaluate((text) => globalThis.__saySlateSend({
  type: "sayslate-host-command", sessionId: globalThis.__saySlateSession, action: "insert-submit", text
}), resultText);

// Highlights in `field` (typing `highlight`, or by `select`), presses Ctrl+Alt+P, runs
// `beforeResult`, then sends `resultText` as Floating Slate does when its passes finish.
// `readState` reads the page before the result (after the key and `beforeResult`) and after it.
async function processSelectionRun(page, {
  field,
  highlight = ONE_PARAGRAPH,
  select = () => typeAndHighlight(page, field, highlight),
  beforeResult,
  resultText = POLISHED,
  readState = (target) => pageState(target, field)
}) {
  await select();
  const pressed = await pressProcessSelection(page, { expectMessage: true });
  if (beforeResult) await beforeResult();
  const before = await readState(page);
  const result = await sendResult(page, resultText);
  const state = await readState(page);
  const selections = await selectionMessages(page);
  return { pressed, before, result, state, selections };
}

const consumedChecks = ({ pressed, selections }, highlight) => ({
  "key consumed (never reached the page)": pressed.reachedPage.length === 0,
  "Floating Slate opened": pressed.overlay,
  "one selection message, the highlighted text, for the session": selections.length === 1 &&
    selections[0].sessionId === pressed.session && (highlight instanceof RegExp ? highlight.test(selections[0].text) : selections[0].text === highlight)
});
const notConsumedChecks = (pressed, selections) => ({
  "key reached the page, not prevented": pressed.reachedPage.length === 1 && !pressed.reachedPage[0].defaultPrevented,
  "no Floating Slate": !pressed.overlay,
  "no selection message": selections.length === 0
});
const processDetail = ({ pressed, before, result, state, selections }) =>
  `mode=${result?.mode}; before=${JSON.stringify(before.pmText ?? before.text)}; text=${JSON.stringify(state.text)}; pm=${JSON.stringify(state.pmText ?? null)}; ` +
  `clicks=${state.sendClicks ?? null}; reachedPage=${JSON.stringify(pressed.reachedPage)}; overlay=${pressed.overlay}; ` +
  `focusInOverlay=${pressed.focusInOverlay}; selections=${JSON.stringify(selections.map((message) => message.text))}`;

for (const { id, fixture, label } of [
  { id: "B20", fixture: "prosemirror-current", label: "data-composer-markdown" },
  { id: "B21", fixture: "prosemirror-legacy", label: "#prompt-textarea (v1.11.4 markup)" }
]) {
  await scenario(browser, {
    id, name: `Ctrl+Alt+P on a phrase highlighted in the ${label} ProseMirror composer: highlight replaced and submitted`, expected: "positive", fixture,
    run: async (page) => {
      const run = await processSelectionRun(page, { field: COMPOSER });
      return {
        checks: {
          ...consumedChecks(run, HIGHLIGHT),
          "draft untouched by the key": run.before.pmText === ONE_PARAGRAPH.paragraphs[0],
          submitted: run.result?.mode === "submitted",
          "highlight replaced in the DOM": run.state.text === REPLACED,
          "highlight replaced in ProseMirror's state": run.state.pmText === REPLACED,
          "pressed once": run.state.sendClicks === 1
        },
        detail: processDetail(run)
      };
    }
  });
}

await scenario(browser, {
  id: "B22", name: "Ctrl+Alt+P on a highlight across two ProseMirror paragraphs: line break handed over, both parts replaced", expected: "positive", fixture: "prosemirror-current",
  run: async (page) => {
    const readState = async (target) => ({
      ...(await pageState(target, COMPOSER)),
      paragraphs: await target.evaluate((selector) => document.querySelectorAll(`${selector} p`).length, COMPOSER)
    });
    const run = await processSelectionRun(page, { field: COMPOSER, highlight: TWO_PARAGRAPHS, readState });
    return {
      checks: {
        ...consumedChecks(run, /^rough start\n+rough end\.$/),
        "two paragraphs before the result": run.before.paragraphs === 2,
        submitted: run.result?.mode === "submitted",
        "both parts replaced, one paragraph left": run.state.text === REPLACED && run.state.paragraphs === 1,
        "ProseMirror's state agrees": run.state.pmText === REPLACED,
        "pressed once": run.state.sendClicks === 1
      },
      detail: `${processDetail(run)}; paragraphs ${run.before.paragraphs}->${run.state.paragraphs}`
    };
  }
});

await scenario(browser, {
  id: "B23", name: "Ctrl+Alt+P in the captured composer markup (plain contenteditable): highlight replaced and submitted", expected: "positive", fixture: "artifact",
  run: async (page) => {
    const run = await processSelectionRun(page, { field: COMPOSER });
    return {
      checks: {
        ...consumedChecks(run, HIGHLIGHT),
        "draft untouched by the key": run.before.text === ONE_PARAGRAPH.paragraphs[0],
        submitted: run.result?.mode === "submitted",
        "highlight replaced": run.state.text === REPLACED,
        "pressed once": run.state.sendClicks === 1
      },
      detail: processDetail(run)
    };
  }
});

await scenario(browser, {
  id: "B24", name: "Ctrl+Alt+P in the logged-out textarea composer: highlight replaced through value and submitted", expected: "positive", fixture: "logged-out",
  run: async (page) => {
    const run = await processSelectionRun(page, { field: "#mobile-composer-prompt" });
    return {
      checks: {
        ...consumedChecks(run, HIGHLIGHT),
        "draft untouched by the key": run.before.text === ONE_PARAGRAPH.paragraphs[0],
        submitted: run.result?.mode === "submitted",
        "highlight replaced": run.state.text === REPLACED,
        "only Send pressed, once, when ready": JSON.stringify(run.state.presses) === JSON.stringify([{ label: "Send message", ready: true }]),
        "form submitted once": run.state.sendClicks === 1
      },
      detail: `${processDetail(run)}; presses=${JSON.stringify(run.state.presses)}`
    };
  }
});

await scenario(browser, {
  id: "B25", name: "Ctrl+Alt+P in the logged-in composer with the captured Send: highlight replaced and submitted", expected: "positive", fixture: "logged-in-form",
  run: async (page) => {
    const run = await processSelectionRun(page, { field: LOGGED_IN_COMPOSER, readState: loggedInState });
    return {
      checks: {
        ...consumedChecks(run, HIGHLIGHT),
        "draft untouched by the key": run.before.pmText === ONE_PARAGRAPH.paragraphs[0],
        submitted: run.result?.mode === "submitted",
        "highlight replaced in the DOM": run.state.text === REPLACED,
        "highlight replaced in ProseMirror's state": run.state.pmText === REPLACED,
        "only captured Send pressed, once": run.state.sendClicks === 1 && JSON.stringify(run.state.presses) === JSON.stringify(["Send"])
      },
      detail: `${processDetail(run)}; presses=${JSON.stringify(run.state.presses)}; formSubmits=${run.state.formSubmits}`
    };
  }
});

await scenario(browser, {
  id: "B26", name: "Ctrl+Alt+P with only a caret in the ProseMirror composer: key left to the page", expected: "negative", fixture: "prosemirror-current",
  run: async (page) => {
    await typeAndHighlight(page, COMPOSER, { ...ONE_PARAGRAPH, length: 0 });
    const pressed = await pressProcessSelection(page, { expectMessage: false });
    const state = await pageState(page, COMPOSER);
    const selections = await selectionMessages(page);
    return {
      checks: { "caret only": pressed.highlighted === "", ...notConsumedChecks(pressed, selections), "draft unchanged": state.pmText === ONE_PARAGRAPH.paragraphs[0] },
      detail: `pm=${JSON.stringify(state.pmText)}; reachedPage=${JSON.stringify(pressed.reachedPage)}; overlay=${pressed.overlay}; selections=${selections.length}`
    };
  }
});

await scenario(browser, {
  id: "B27", name: "Ctrl+Alt+P with page text outside the composer highlighted: key left to the page", expected: "negative", fixture: "prosemirror-current",
  run: async (page) => {
    await typeAndHighlight(page, COMPOSER, { ...ONE_PARAGRAPH, length: 0 });
    // Harness addition: ordinary page text, highlighted by a triple click.
    await page.evaluate(() => document.body.insertAdjacentHTML("afterbegin", '<p id="page-text">Text on the page, outside the composer.</p>'));
    await page.click("#page-text", { clickCount: 3 });
    const pressed = await pressProcessSelection(page, { expectMessage: false });
    const state = await pageState(page, COMPOSER);
    const selections = await selectionMessages(page);
    return {
      checks: {
        "page text highlighted": pressed.highlighted.trim() === "Text on the page, outside the composer.",
        ...notConsumedChecks(pressed, selections),
        "draft unchanged": state.pmText === ONE_PARAGRAPH.paragraphs[0]
      },
      detail: `highlighted=${JSON.stringify(pressed.highlighted)}; pm=${JSON.stringify(state.pmText)}; reachedPage=${JSON.stringify(pressed.reachedPage)}; overlay=${pressed.overlay}; selections=${selections.length}`
    };
  }
});

await scenario(browser, {
  id: "B28", name: "Ctrl+Alt+P with text highlighted in another chatgpt.com field (search textarea): key left to the page", expected: "negative", fixture: "logged-out",
  run: async (page) => {
    await typeAndHighlight(page, "#search", { paragraphs: ["search words"], after: 0, length: "words".length });
    const pressed = await pressProcessSelection(page, { expectMessage: false });
    const search = await pageState(page, "#search");
    const state = await pageState(page, "#mobile-composer-prompt");
    const selections = await selectionMessages(page);
    return {
      checks: {
        "search text highlighted": pressed.highlighted === "words",
        ...notConsumedChecks(pressed, selections),
        "search field unchanged": search.text === "search words",
        "composer untouched": state.text === ""
      },
      detail: `highlighted=${JSON.stringify(pressed.highlighted)}; search=${JSON.stringify(search.text)}; reachedPage=${JSON.stringify(pressed.reachedPage)}; overlay=${pressed.overlay}; selections=${selections.length}`
    };
  }
});

await scenario(browser, {
  id: "B29", name: "Ctrl+Alt+P after an extension reload left the host without a runtime id: key left to ProseMirror", expected: "negative", fixture: "prosemirror-current",
  run: async (page) => {
    const orphaned = await page.evaluate(() => {
      delete chrome.runtime.id;
      return chrome.runtime.id === undefined;
    });
    await typeAndHighlight(page, COMPOSER, ONE_PARAGRAPH);
    const pressed = await pressProcessSelection(page, { expectMessage: false });
    const state = await pageState(page, COMPOSER);
    const selections = await selectionMessages(page);
    return {
      checks: {
        "runtime id gone": orphaned,
        "phrase highlighted": pressed.highlighted === HIGHLIGHT,
        ...notConsumedChecks(pressed, selections),
        "key dispatched at ProseMirror": pressed.reachedPage[0]?.inEditor === true,
        "draft unchanged": state.pmText === ONE_PARAGRAPH.paragraphs[0]
      },
      detail: `highlighted=${JSON.stringify(pressed.highlighted)}; pm=${JSON.stringify(state.pmText)}; reachedPage=${JSON.stringify(pressed.reachedPage)}; overlay=${pressed.overlay}; selections=${selections.length}`
    };
  }
});

// The viewport rect of characters [from, to) of `text` in the field's text, for real mouse input.
async function textRect(page, field, text, from = 0, to = text.length) {
  const rect = await page.evaluate(([selector, needle, start, end]) => {
    const walker = document.createTreeWalker(document.querySelector(selector), NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.data.indexOf(needle);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index + start);
      range.setEnd(node, index + end);
      const { left, top, width, height } = range.getBoundingClientRect();
      return { left, top, width, height };
    }
    return null;
  }, [field, text, from, to]);
  if (!rect) throw new Error(`${JSON.stringify(text)} is not in one text node of ${field}`);
  return rect;
}

const ROUGH = "Rough";
const ROUGH_REPLACED = "Keep this. Rough draft here. Keep that.";

await scenario(browser, {
  id: "B30", name: "Ctrl+Alt+P on a word double-clicked in the ProseMirror composer: the space around it is kept", expected: "positive", fixture: "prosemirror-current",
  run: async (page) => {
    const run = await processSelectionRun(page, {
      field: COMPOSER,
      select: async () => {
        await typeAndHighlight(page, COMPOSER, { ...ONE_PARAGRAPH, length: 0 });
        const word = await textRect(page, COMPOSER, "rough");
        await page.mouse.dblclick(word.left + word.width / 2, word.top + word.height / 2);
      },
      resultText: ROUGH
    });
    return {
      checks: {
        "double-click highlighted the word": /^rough\s?$/.test(run.pressed.highlighted),
        ...consumedChecks(run, run.pressed.highlighted),
        submitted: run.result?.mode === "submitted",
        "word replaced, spaces kept, in the DOM": run.state.text === ROUGH_REPLACED,
        "word replaced, spaces kept, in ProseMirror's state": run.state.pmText === ROUGH_REPLACED,
        "pressed once": run.state.sendClicks === 1
      },
      detail: `highlighted=${JSON.stringify(run.pressed.highlighted)}; ${processDetail(run)}`
    };
  }
});

await scenario(browser, {
  id: "B31", name: "Ctrl+Alt+P on \" rough \" highlighted with both spaces in the logged-out textarea composer: spaces kept", expected: "positive", fixture: "logged-out",
  run: async (page) => {
    const run = await processSelectionRun(page, {
      field: "#mobile-composer-prompt",
      highlight: { paragraphs: ONE_PARAGRAPH.paragraphs, after: "draft here. Keep that.".length, length: " rough ".length },
      resultText: ROUGH
    });
    return {
      checks: {
        ...consumedChecks(run, " rough "),
        "draft untouched by the key": run.before.text === ONE_PARAGRAPH.paragraphs[0],
        submitted: run.result?.mode === "submitted",
        "word replaced, spaces kept": run.state.text === ROUGH_REPLACED,
        "only Send pressed, once, when ready": JSON.stringify(run.state.presses) === JSON.stringify([{ label: "Send message", ready: true }]),
        "form submitted once": run.state.sendClicks === 1
      },
      detail: `${processDetail(run)}; presses=${JSON.stringify(run.state.presses)}`
    };
  }
});

// The draft with one "X" typed somewhere inside the highlighted phrase.
const editedInsideHighlight = (text) => {
  const draft = ONE_PARAGRAPH.paragraphs[0];
  const start = draft.indexOf(HIGHLIGHT);
  const at = text?.indexOf("X") ?? -1;
  return at > start && at < start + HIGHLIGHT.length && text.slice(0, at) + text.slice(at + 1) === draft;
};

await scenario(browser, {
  id: "B32", name: "Highlighted words edited after Ctrl+Alt+P: result copied, not inserted or submitted", expected: "negative", fixture: "prosemirror-current",
  run: async (page) => {
    const run = await processSelectionRun(page, {
      field: COMPOSER,
      // Click at the left edge of the "a" in "draft", then type a character there.
      beforeResult: async () => {
        const letter = await textRect(page, COMPOSER, "draft", 2, 3);
        await page.mouse.click(letter.left + 1, letter.top + letter.height / 2);
        await page.keyboard.type("X");
      }
    });
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    return {
      checks: {
        ...consumedChecks(run, HIGHLIGHT),
        "user's edit inside the highlight": editedInsideHighlight(run.before.pmText),
        "reported copied": run.result?.ok === false && run.result?.mode === "copied",
        "composer keeps the edit, nothing inserted": run.state.pmText === run.before.pmText && run.state.text === run.before.pmText,
        "not submitted": run.state.sendClicks === 0,
        "clipboard holds the result": clipboard === POLISHED
      },
      detail: `${processDetail(run)}; clipboard=${JSON.stringify(clipboard)}`
    };
  }
});

await browser.close();

if (live) {
  const liveBrowser = await chromium.launch({ channel: "chrome", headless: false });
  const LIVE_COMPOSER = "#mobile-composer-prompt, #prompt-textarea, [contenteditable='true'][data-composer-markdown]";
  // Opens the live chatgpt.com in a fresh context with SaySlate injected. Conversation POSTs are
  // aborted and listed in `aborted`; a click on the send button and any form submission are
  // recorded in window.__sendPresses and cancelled, so nothing is sent to ChatGPT.
  async function openLiveChatGPT() {
    const context = await liveBrowser.newContext({ viewport: { width: 1280, height: 900 } });
    const aborted = [];
    await context.route("**/*", (route) => {
      const request = route.request();
      if (request.method() === "POST" && /conversation/i.test(request.url())) {
        aborted.push(request.url());
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    const composer = await page.waitForSelector(LIVE_COMPOSER, { timeout: 45000 });
    const composerId = await composer.evaluate((node) => node.id || node.tagName.toLowerCase());
    await page.evaluate(() => {
      window.__sendPresses = [];
      const intercept = (event) => {
        const button = event.target?.closest?.("#composer-submit-button, button[data-composer-submit]");
        if (!button && event.type === "click") return;
        window.__sendPresses.push({ type: event.type, ariaDisabled: button?.getAttribute("aria-disabled") ?? null, disabled: button?.disabled ?? null });
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      window.addEventListener("click", intercept, true);
      window.addEventListener("submit", intercept, true);
    });
    await injectSaySlate(page);
    return { page, composer, composerId, aborted };
  }

  try {
    const { page, composer, composerId, aborted } = await openLiveChatGPT();
    await composer.click();
    const opened = await page.evaluate(() => globalThis.__saySlateSend({ type: "sayslate-toggle-floating" }));
    if (!opened?.ok) throw new Error(`Floating Slate did not open: ${JSON.stringify(opened)}`);
    const result = await page.evaluate((text) => globalThis.__saySlateSend({
      type: "sayslate-host-command", sessionId: globalThis.__saySlateSession, action: "insert-submit", text
    }), TEXT);
    const state = await page.evaluate((selector) => {
      const node = document.querySelector(selector);
      return { text: ("value" in node ? node.value : node.innerText).trim(), presses: window.__sendPresses };
    }, LIVE_COMPOSER);
    await page.screenshot({ path: path.join(process.env.SAYSLATE_EVIDENCE_DIR || ".", "live-chatgpt-after-insert.png") });
    const clickPress = state.presses.find((press) => press.type === "click");
    record("L1", `Live chatgpt.com (logged out, composer ${composerId}), process and submit`, "positive", {
      submitted: result?.mode === "submitted",
      "text in ChatGPT composer": state.text === TEXT,
      "ChatGPT enabled its send button": clickPress?.ariaDisabled !== "true" && clickPress?.disabled !== true,
      "nothing sent": aborted.length === 0
    }, `mode=${result?.mode}; message=${JSON.stringify(result?.message)}; presses=${JSON.stringify(state.presses)}; abortedPosts=${aborted.length}`);
  } catch (error) {
    record("L1", "Live chatgpt.com (logged out), process and submit", "positive", { "scenario ran": false }, error.message.split("\n")[0]);
  }

  try {
    const { page, composerId, aborted } = await openLiveChatGPT();
    const readState = async (target) => ({
      ...(await target.evaluate((selector) => {
        const node = document.querySelector(selector);
        return { text: ("value" in node ? node.value : node.innerText).trim(), presses: window.__sendPresses.slice() };
      }, LIVE_COMPOSER)),
      aborted: aborted.map((url) => new URL(url).pathname)
    });
    const run = await processSelectionRun(page, { field: LIVE_COMPOSER, readState });
    await page.screenshot({ path: path.join(process.env.SAYSLATE_EVIDENCE_DIR || ".", "live-chatgpt-after-process-selection.png") });
    const clicks = run.state.presses.filter((press) => press.type === "click");
    record("L2", `Live chatgpt.com (logged out, composer ${composerId}), Ctrl+Alt+P on a highlighted phrase: replaced and submitted`, "positive", {
      ...consumedChecks(run, HIGHLIGHT),
      "draft untouched by the key": run.before.text === ONE_PARAGRAPH.paragraphs[0],
      submitted: run.result?.mode === "submitted",
      "highlight replaced in ChatGPT's composer": run.state.text === REPLACED,
      "send pressed once, enabled by ChatGPT": clicks.length === 1 && clicks[0].ariaDisabled !== "true" && clicks[0].disabled !== true,
      // chatgpt.com may POST conversation/prepare on page load, before any key or SaySlate
      // action (seen 2026-10-18); it is aborted like every conversation POST, and is not a send.
      "nothing sent (no conversation POST but prepare)": run.state.aborted.every((pathname) => /\/conversation\/prepare$/.test(pathname))
    }, `${processDetail(run)}; presses=${JSON.stringify(run.state.presses)}; abortedAfterKey=${JSON.stringify(run.before.aborted)}; abortedAtEnd=${JSON.stringify(run.state.aborted)}`);
  } catch (error) {
    record("L2", "Live chatgpt.com (logged out), Ctrl+Alt+P on a highlighted phrase", "positive", { "scenario ran": false }, error.message.split("\n")[0]);
  } finally {
    await liveBrowser.close();
  }
}

console.log(`Source: ${sourceRoot}`);
console.log("| Id | Scenario | Kind | Result | Detail |");
console.log("| -- | -------- | ---- | ------ | ------ |");
for (const result of results) {
  console.log(`| ${result.id} | ${result.name} | ${result.expected} | ${result.pass ? "pass" : "FAIL"} | ${result.detail.replaceAll("|", "\\|")} |`);
}
const failures = results.filter((result) => !result.pass).length;
console.log(failures ? `${failures} of ${results.length} browser scenarios failed.` : `All ${results.length} browser scenarios passed.`);
process.exitCode = failures ? 1 : 0;
