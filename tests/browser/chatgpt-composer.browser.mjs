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
const scripts = ["chatGPTAdapter.js", "shortcutProtocol.js", "floatingHost.js"]
  .map((file) => fs.readFileSync(path.join(sourceRoot, file), "utf8"));

// Stands in for background.js: floatingHost.js registers its session through sendMessage and
// receives host commands through onMessage.
const chromeStub = `(() => {
  const listeners = [];
  Object.defineProperty(globalThis, "chrome", { configurable: true, writable: true, value: { runtime: {
    getURL: (file) => "about:blank#" + file,
    onMessage: { addListener: (listener) => listeners.push(listener) },
    sendMessage: async (message) => {
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
// pages are harness additions; the captured logged-in artifact does not include ChatGPT's send
// button.
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

const pmImports = `
  import { EditorState } from "https://esm.sh/prosemirror-state@1.4.4?deps=prosemirror-model@1.25.12";
  import { EditorView } from "https://esm.sh/prosemirror-view@1.42.6?deps=prosemirror-model@1.25.12";
  import { schema } from "https://esm.sh/prosemirror-schema-basic@1.2.5?deps=prosemirror-model@1.25.12";`;

// Mounts a real ProseMirror editor where the captured composer sits, carrying the captured
// editor attributes. The send button is enabled from ProseMirror's own state, the way
// ChatGPT's is, so a press proves ProseMirror registered the inserted text.
function proseMirrorPage({ attributes, sendAttributes }) {
  return `<!doctype html><html><body>${artifact}
<button ${sendAttributes} disabled type="button" onclick="window.__sendClicks += 1">Send</button>
${instrumentation}
<script type="module">${pmImports}
  const mount = document.querySelector("[data-rich-text-layout]");
  mount.querySelector("[contenteditable]").remove();
  const send = document.querySelector("body > button:not(#elsewhere)");
  let view;
  function create() {
    view = new EditorView(mount, {
      state: EditorState.create({ schema }),
      attributes: ${JSON.stringify(attributes)},
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
<form action="/unauth-mweb/conversation" autocomplete="off" data-announcement-thinking="Thinking" data-announcement-complete="Response complete" data-announcement-stopped="Response stopped" data-landing="" data-logged-out="" data-mobile-composer="" method="post">
  <div data-composer-editor-host=""><textarea aria-label="Chat with ChatGPT" autocapitalize="sentences" autocomplete="off" autocorrect="on" data-mobile-composer-prompt="" enterkeyhint="enter" id="mobile-composer-prompt" inputmode="text" name="prompt" placeholder="Ask ChatGPT" required="" rows="1" spellcheck="true"></textarea></div>
  <button aria-label="Add files and more" data-composer-action="" data-icon-only="" data-icon-position="start" data-icon-shape="non-circular" data-oai-tooltip="" data-oai-tooltip-side="bottom" data-octane-native-image-menu-trigger="" data-radius="full" data-size="medium" data-variant="ghost" data-w-component="button" popovertarget="octane-mobile-composer-actions-popover" popovertargetaction="toggle" type="button" data-octane-bindings="d:1a27fb8a"><span aria-hidden="true"><svg/></span></button>
  <button aria-label="Start dictation" data-icon-only="" data-icon-position="start" data-icon-shape="non-circular" data-oai-tooltip="" data-oai-tooltip-side="bottom" data-radius="full" data-size="medium" data-start-dictation="" data-variant="ghost" data-w-component="button" data-idle-home="" type="button" data-octane-bindings="d:a5eb6e17"><span aria-hidden="true"><svg/></span><span aria-hidden="true" hidden=""><svg/></span></button>
  <button aria-disabled="true" aria-label="Send message" data-composer-submit="" data-icon-only="" data-icon-position="start" data-icon-shape="non-circular" data-oai-tooltip="" data-oai-tooltip-side="bottom" data-radius="full" data-send-label="Send message" data-size="medium" data-stop-label="Stop generating" data-variant="primary" data-visually-disabled="" data-w-component="button" type="submit"><span data-composer-send-icon=""><svg/></span><span data-composer-loading-icon="" aria-hidden="true" hidden=""><svg/></span><span data-composer-stop-icon="" hidden=""><svg/></span></button>
</form>
<textarea id="search" name="search" aria-label="Search chats"></textarea>
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
  artifact: `<!doctype html><html><body>${artifact}
<button id="composer-submit-button" disabled type="button" onclick="window.__sendClicks += 1">Send</button>
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
  "logged-out": loggedOutPage({ becomesReady: true }),
  // The same page ignoring input, so Send never becomes ready.
  "logged-out-never-ready": loggedOutPage({ becomesReady: false }),
  "never-ready": `<!doctype html><html><body>${artifact}
<button id="composer-submit-button" disabled type="button" onclick="window.__sendClicks += 1">Send</button>
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
    if (fixture.startsWith("prosemirror")) await page.waitForFunction(() => window.__pmReady === true, null, { timeout: 30000 });
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
  id: "B7", name: "Saved target is another chatgpt.com field", expected: "negative", fixture: "logged-out",
  run: async (page) => {
    const result = await runCommand(page, { focus: "#search", action: "insert-submit" });
    const state = await pageState(page, "#search");
    return { checks: { "wrong-target": result?.mode === "wrong-target", "field unchanged": state.text === "", "not submitted": state.sendClicks === 0 }, detail: summary(result, state) };
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

await browser.close();

if (live) {
  const liveBrowser = await chromium.launch({ channel: "chrome", headless: false });
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
  try {
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    const composer = await page.waitForSelector("#mobile-composer-prompt, #prompt-textarea, [contenteditable='true'][data-composer-markdown]", { timeout: 45000 });
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
    await composer.click();
    const opened = await page.evaluate(() => globalThis.__saySlateSend({ type: "sayslate-toggle-floating" }));
    if (!opened?.ok) throw new Error(`Floating Slate did not open: ${JSON.stringify(opened)}`);
    const result = await page.evaluate((text) => globalThis.__saySlateSend({
      type: "sayslate-host-command", sessionId: globalThis.__saySlateSession, action: "insert-submit", text
    }), TEXT);
    const state = await page.evaluate(() => {
      const node = document.querySelector("#mobile-composer-prompt, #prompt-textarea, [contenteditable='true'][data-composer-markdown]");
      return { text: ("value" in node ? node.value : node.innerText).trim(), presses: window.__sendPresses };
    });
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
