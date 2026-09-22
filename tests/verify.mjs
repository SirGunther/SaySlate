import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(extensionRoot, file), "utf8");

// This file is the project's one standard verification command: it must actually run
// every focused test, not just confirm the file exists (a missing/renamed test file is
// still a manifest-asset failure below, but a test that exists and fails must fail this
// command too, or a real regression could hide behind a passing `node tests/verify.mjs`).
const testsDir = path.join(extensionRoot, "tests");
const testFiles = fs
  .readdirSync(testsDir)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort();
for (const name of testFiles) {
  const result = spawnSync(process.execPath, [path.join(testsDir, name)], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Test failed: ${name}`);
}
console.log(`${testFiles.length} focused test files passed.`);

const manifest = JSON.parse(read("manifest.json"));
if (manifest.manifest_version !== 3) throw new Error("Expected a Manifest V3 extension.");
if (!manifest.permissions?.includes("clipboardWrite")) throw new Error("Expected clipboardWrite permission.");
if (!manifest.permissions?.includes("storage")) throw new Error("Expected storage permission.");
if (!manifest.permissions?.includes("offscreen")) throw new Error("Expected offscreen speech-service permission.");
if (!manifest.permissions?.includes("activeTab") || !manifest.permissions?.includes("scripting")) {
  throw new Error("Expected on-demand Floating Slate injection permissions.");
}
if (!manifest.host_permissions?.includes("https://generativelanguage.googleapis.com/*")) {
  throw new Error("Expected Google Generative Language host permission.");
}
// Least-privilege gate for the Local Whisper integration: the manifest may grant the
// Google AI host and the fixed WhisperService loopback origin only - no wildcard, LAN,
// public HTTP, or other unrelated host may ever be added alongside them.
const EXPECTED_HOST_PERMISSIONS = ["https://generativelanguage.googleapis.com/*", "http://127.0.0.1:8178/*"];
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(EXPECTED_HOST_PERMISSIONS)) {
  throw new Error("Manifest host permissions must grant only the Google Generative Language API and the fixed WhisperService loopback origin.");
}

const html = read("app.html");
const script = read("app.js");
const styles = read("app.css");
const animationStyles = read("animations.css");
const animationScript = read("animations.js");
const speechEngine = read("speechEngine.js");
const floatingHtml = read("floating.html");
const floatingStyles = read("floating.css");
const floatingScript = read("floating.js");
const floatingHost = read("floatingHost.js");
const shortcutProtocol = read("shortcutProtocol.js");
const chatGPTAdapter = read("chatGPTAdapter.js");
const floatingSpeechClient = read("floatingSpeechClient.js");
const offscreenHtml = read("offscreen.html");
const offscreenSpeech = read("offscreenSpeech.js");
const backgroundScript = read("background.js");
const themeScript = read("theme.js");
const aiClient = read("aiClient.js");
const whisperServiceClient = read("whisperServiceClient.js");
const dictationSettings = read("dictationSettings.js");
const dictationProviderPanel = read("dictationProviderPanel.js");
const referencedIds = [...script.matchAll(/querySelector\("#([^\"]+)"\)/g)].map((match) => match[1]);

for (const id of referencedIds) {
  if (!html.includes(`id="${id}"`)) throw new Error(`Missing DOM element: #${id}`);
}

const requiredFiles = [
  manifest.background.service_worker,
  ...Object.values(manifest.icons),
  "app.html",
  "app.css",
  "animations.css",
  "app.js",
  "animations.js",
  "speechEngine.js",
  "floating.html",
  "floating.css",
  "floating.js",
  "floatingHost.js",
  "shortcutProtocol.js",
  "chatGPTAdapter.js",
  "floatingSpeechClient.js",
  "offscreen.html",
  "offscreenSpeech.js",
  "aiClient.js",
  "theme.js",
  "whisperServiceClient.js",
  "micCapture.js",
  "micCaptureWorklet.js",
  "pcmAudioProcessor.js",
  "dictationSettings.js",
  "dictationProviderPanel.js",
  "tests/animations.test.mjs",
  "tests/ai-client.test.mjs",
  "tests/speech-engine.test.mjs",
  "tests/background-routing.test.mjs",
  "tests/shortcut-protocol.test.mjs",
  "tests/chatgpt-adapter.test.mjs",
  "tests/floating-speech-client.test.mjs",
  "tests/offscreen-speech.test.mjs",
  "tests/whisper-service-client.test.mjs",
  "tests/mic-capture.test.mjs",
  "tests/mic-capture-worklet.test.mjs",
  "tests/pcm-audio-processor.test.mjs",
  "tests/dictation-settings.test.mjs",
  "tests/dictation-provider-panel.test.mjs",
  "tests/app-dictation-integration.test.mjs",
  "tests/floating-dictation-integration.test.mjs",
  "CHANGELOG.md",
  "ROADMAP.md",
  "docs/review/v1.11.0-floating-slate-change-review.md",
  "docs/review/v1.11.1-floating-slate-initializer-fix.md",
  "docs/review/v1.11.2-manifest-shortcut-repair.md",
  "docs/review/v1.11.3-floating-shortcut-routing-validation-review.md",
  "docs/review/v1.11.4-chatgpt-process-submit-validation-review.md",
  "docs/review/v1.11.5-extension-owned-speech-service-validation-review.md",
  "docs/review/v1.12.0-whisperservice-local-dictation-validation-review.md"
];

for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(extensionRoot, file))) throw new Error(`Missing extension asset: ${file}`);
}

for (const reviewFile of [
  "docs/review/v1.11.0-floating-slate-change-review.md",
  "docs/review/v1.11.1-floating-slate-initializer-fix.md",
  "docs/review/v1.11.2-manifest-shortcut-repair.md",
  "docs/review/v1.11.3-floating-shortcut-routing-validation-review.md",
  "docs/review/v1.11.4-chatgpt-process-submit-validation-review.md",
  "docs/review/v1.11.5-extension-owned-speech-service-validation-review.md",
  "docs/review/v1.12.0-whisperservice-local-dictation-validation-review.md"
]) {
  const review = read(reviewFile);
  const normalizedReview = review.replace(/\*\*\[(D\d+)\]\(#[^)]+\)\*\*/g, "**$1**");
  const objectives = [...review.matchAll(/^### (D\d+): (.+)$/gm)]
    .map((match) => ({ id: match[1], title: match[2].trim() }));
  const statusRows = [...normalizedReview.matchAll(/^\|\s+\*\*(D\d+)\*\*\s+\|\s+\*\*([^*]+)\*\*\s+[^|]+\|\s+(Passed|Failed|Blocked|Pending|N\/A)\s+\|\s+([^|]+)\|$/gm)]
    .map((match) => ({ id: match[1], title: match[2].trim(), status: match[3], nextStep: match[4].trim() }));
  const validationItems = statusRows.map(({ id, title }) => ({ id, title }));
  const expectedIds = objectives.map((_, index) => `D${index + 1}`);
  if (!objectives.length || JSON.stringify(objectives.map((item) => item.id)) !== JSON.stringify(expectedIds)) {
    throw new Error(`Review objectives are missing sequential section identifiers: ${reviewFile}`);
  }
  if (JSON.stringify(validationItems) !== JSON.stringify(objectives)) {
    throw new Error(`Primary validation items must map one-to-one to review objectives: ${reviewFile}`);
  }
  if (statusRows.some((row) => !row.nextStep)) {
    throw new Error(`Every validation status row requires a next step: ${reviewFile}`);
  }
  if (/\[D1\]\(#[^)]+\)/.test(review)) {
    for (const { id, title } of objectives) {
      const slug = `${id}-${title}`
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-");
      if (!review.includes(`[${id}](#${slug})`)) {
        throw new Error(`Linked validation objective does not use its complete heading slug: ${reviewFile} ${id}`);
      }
    }
    const returnControls = review.match(/Return to User Validation Status/g)?.length || 0;
    if (returnControls !== objectives.length) {
      throw new Error(`Every linked validation objective requires one return control: ${reviewFile}`);
    }
  }
}

for (const shortcut of ['"d"', '"c"', '"x"', '"g"', '"e"', '"r"', '"f"']) {
  if (!script.includes(shortcut)) throw new Error(`Missing keyboard shortcut: ${shortcut}`);
}

if (!html.includes('id="themeToggle"')) throw new Error("Missing theme toggle.");
if (html.includes('class="shortcut-strip"')) throw new Error("Visible shortcut strip should be removed.");
if (!themeScript.includes("sayslate-theme")) throw new Error("Theme preference is not persisted.");
if (!script.includes("function toggleTheme")) throw new Error("Theme toggle behavior is missing.");
if (!html.includes('href="animations.css"') || !html.includes('src="animations.js"')) {
  throw new Error("Dedicated animation assets are not loaded.");
}
if (!html.includes('src="speechEngine.js"') || html.indexOf('src="speechEngine.js"') > html.indexOf('src="app.js"')) {
  throw new Error("The shared recoverable speech engine must load before the full app.");
}
// The Local Whisper feature below is implemented and fully covered by automated checks,
// but its version bump is deliberately withheld until the pending real-runtime acceptance
// items in the v1.12.0 validation review pass - see CHANGELOG.md's [Unreleased] section.
if (manifest.version !== "1.11.5") throw new Error("Expected SaySlate version 1.11.5 pending v1.12.0 acceptance.");
const floatingContentScript = manifest.content_scripts?.find((entry) => entry.js?.includes("floatingHost.js"));
if (!floatingContentScript) {
  throw new Error("The browser-wide Floating Slate host is not registered.");
}
if (JSON.stringify(floatingContentScript.js) !== JSON.stringify(["chatGPTAdapter.js", "shortcutProtocol.js", "floatingHost.js"])) {
  throw new Error("The ChatGPT adapter and shared shortcut protocol must load before the Floating Slate host.");
}
const floatingNativeShortcut = manifest.commands?.["toggle-floating-slate"]?.suggested_key?.default || "";
if (floatingNativeShortcut !== "Alt+Shift+S") {
  throw new Error("The native Floating Slate shortcut is not registered.");
}
if (/Ctrl\+Alt/i.test(floatingNativeShortcut)) {
  throw new Error("Chromium rejects Ctrl+Alt combinations in manifest commands because they conflict with AltGr.");
}
if (!manifest.web_accessible_resources?.some((entry) => entry.resources?.includes("floating.html"))) {
  throw new Error("The Floating Slate iframe is not web accessible.");
}
if (!floatingHost.includes("toggleOverlay") || !floatingHost.includes("positionOverlay") || !floatingHost.includes("commitText")) {
  throw new Error("Floating Slate initialization, positioning, or insertion behavior is missing.");
}
if (!shortcutProtocol.includes("actionKeyFromEvent") || !shortcutProtocol.includes("messageKey") || !shortcutProtocol.includes("sayslate-floating-shortcut")) {
  throw new Error("The shared floating shortcut protocol is incomplete.");
}
if (!floatingHost.includes("if (!host || !shortcuts) return") || !floatingHost.includes("shortcuts.isEscapeEvent(event)") || !floatingHost.includes("shortcuts?.createMessage(sessionId, key)")) {
  throw new Error("The page host does not give an active Floating Slate first access to shortcuts and Escape.");
}
if (!floatingHost.includes("pendingShortcutKeys") || !floatingHost.includes('frame.addEventListener("load"') || !floatingHost.includes("routeFloatingShortcut(key)")) {
  throw new Error("Floating shortcuts pressed during iframe startup must be queued until it is ready.");
}
if (floatingHost.includes('OPEN_SHORTCUT_KEY = "o"')) {
  throw new Error("The failed Ctrl+Alt+O page initializer should remain retired.");
}
if (!floatingHtml.includes('src="shortcutProtocol.js"') || floatingHtml.indexOf('src="shortcutProtocol.js"') > floatingHtml.indexOf('src="floating.js"')) {
  throw new Error("The shared shortcut protocol must load before floating behavior.");
}
if (!floatingHtml.includes('src="floatingSpeechClient.js"') || floatingHtml.includes('src="speechEngine.js"')) {
  throw new Error("Floating Slate must use the extension-owned speech client instead of a host-bound speech engine.");
}
if (!offscreenHtml.includes('src="speechEngine.js"') || !offscreenHtml.includes('src="offscreenSpeech.js"')) {
  throw new Error("The offscreen speech service does not load the shared recovery engine and message controller.");
}
if (!floatingSpeechClient.includes("sayslate-floating-speech-command") || !floatingSpeechClient.includes("sessionId") || !floatingSpeechClient.includes("removeListener")) {
  throw new Error("The floating speech client is missing command routing, session isolation, or teardown.");
}
if (!offscreenSpeech.includes("SaySlateSpeech.create") || !offscreenSpeech.includes("sayslate-offscreen-speech-event") || !offscreenSpeech.includes("recognitionText")) {
  throw new Error("The offscreen speech service is missing recovery-engine integration or transcript serialization.");
}
if (!floatingScript.includes("function runShortcut") || !floatingScript.includes("shortcuts?.messageKey(message, sessionId)")) {
  throw new Error("Floating Slate does not accept session-scoped shortcuts routed by its host.");
}
for (const key of ["d", "c", "x", "g", "e", "r", "f"]) {
  if (!floatingScript.includes(`"${key}"`)) throw new Error(`Floating Slate shortcut is missing: ${key}`);
}
if (!floatingScript.includes('key === "s"') || !shortcutProtocol.includes('"s"')) {
  throw new Error("The ChatGPT process-and-submit shortcut is missing.");
}
if (!floatingHtml.includes('id="chatGPTSubmitButton"') || !floatingHtml.includes("Ctrl + Alt + S") || !floatingStyles.includes(".tool-button[hidden]")) {
  throw new Error("The ChatGPT-only process-and-submit control is incomplete.");
}
if (!chatGPTAdapter.includes("#composer-submit-button") || !chatGPTAdapter.includes("waitForComposerAndSubmit") || !chatGPTAdapter.includes("DEFAULT_TIMEOUT_MS = 20000")) {
  throw new Error("The guarded ChatGPT submit adapter is incomplete.");
}
if (!floatingHost.includes("commitAndSubmitToChatGPT") || !floatingHost.includes('message.action === "insert-submit"') || !floatingHost.includes('key === "s" && !chatGPT')) {
  throw new Error("The host does not safely restrict ChatGPT submission to its supported surface.");
}
if (!floatingScript.includes('submitToChatGPT ? "insert-submit" : "insert"') || !floatingScript.includes("finishWorkflow(true)")) {
  throw new Error("The ChatGPT action does not reuse the guarded finish workflow.");
}
for (const phase of ["Phase 1", "Phase 2", "Inserting", "Retrying"]) {
  if (!floatingScript.includes(phase)) throw new Error(`Floating Slate status is missing: ${phase}`);
}
if (!floatingHtml.includes('id="transcript"') || !floatingHtml.includes('id="finishButton"') || !floatingStyles.includes("max-width: min(250px")) {
  throw new Error("Floating Slate UI or viewport-safe tooltips are incomplete.");
}
if (!speechEngine.includes("RETRYABLE_ERRORS") || !speechEngine.includes("scheduleRestart") || !speechEngine.includes("MAX_RETRY_DELAY_MS")) {
  throw new Error("Recoverable speech-recognition retry handling is missing.");
}
if (!backgroundScript.includes("sayslate-host-register") || !backgroundScript.includes("sayslate-floating-command") || !backgroundScript.includes("chrome.commands.onCommand") || !backgroundScript.includes("chrome.scripting.executeScript")) {
  throw new Error("The private Floating Slate message router is missing.");
}
if (!backgroundScript.includes("chrome.offscreen.createDocument") || !backgroundScript.includes('reasons: ["USER_MEDIA"]') || !backgroundScript.includes("sayslate-offscreen-speech-control")) {
  throw new Error("The extension-owned offscreen speech lifecycle or command relay is missing.");
}
if (!backgroundScript.includes('files: ["chatGPTAdapter.js", "shortcutProtocol.js", "floatingHost.js"]')) {
  throw new Error("On-demand injection must install the ChatGPT adapter and shortcut protocol before the host.");
}
if (html.indexOf('src="animations.js"') > html.indexOf('src="app.js"')) {
  throw new Error("The animation controller must load before the app behavior.");
}
for (const behavior of ["showPanel", "hidePanel", "transitionTheme", "showToast"]) {
  if (!animationScript.includes(`function ${behavior}`)) throw new Error(`Animation behavior is missing: ${behavior}`);
  if (!script.includes(`SaySlateAnimations.${behavior}`)) throw new Error(`App does not use animation behavior: ${behavior}`);
}
if (!animationScript.includes("prefers-reduced-motion: reduce") || !animationScript.includes("WeakMap")) {
  throw new Error("Animation accessibility or cancellation guards are missing.");
}
if (!animationScript.includes("function motionDuration") || animationScript.includes("if (prefersReducedMotion()) {\n      applyTheme();")) {
  throw new Error("Reduced-motion handling must shorten, not eliminate, requested transition feedback.");
}
if (!animationStyles.includes("::view-transition-old(root)") || !animationStyles.includes(".toast.visible")) {
  throw new Error("Theme or toast animation styles are missing.");
}
if (styles.includes("@keyframes") || styles.includes("animation:")) {
  throw new Error("Keyframes and animation declarations must remain outside the main stylesheet.");
}
if (!styles.includes("--page: #181818") || !styles.includes("--surface: #1d1f1d")) {
  throw new Error("The exact dark page and surface palette is missing.");
}
if (!styles.includes('html[data-theme="dark"] .settings-panel') || !styles.includes("background: #1d1f1d")) {
  throw new Error("Dark menus are not aligned with the card surface palette.");
}
if (!script.includes('isDark ? "#181818"')) throw new Error("The browser dark theme color is not aligned.");
for (const id of ["apiKeyInput", "modelInput", "firstPassPromptInput", "secondPassPromptInput", "transcript", "resultTranscript"]) {
  const field = html.match(new RegExp(`<(?:input|textarea)[^>]*id="${id}"[^>]*>`))?.[0] || "";
  if (!field.includes("text-surface")) throw new Error(`Editable field is missing the shared text surface: #${id}`);
}
if (!styles.includes('html[data-theme="dark"] .text-surface') || !styles.includes("background: #232323")) {
  throw new Error("The shared dark text surface must use #232323.");
}
for (const selector of ["#transcript", "#transcript:focus", "#resultTranscript", "#resultTranscript:focus"]) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = styles.match(new RegExp(`(?:^|\\n)${escapedSelector} \\{([\\s\\S]*?)\\n\\}`))?.[1] || "";
  if (rule.includes("background:")) throw new Error(`Legacy background still overrides the shared text surface: ${selector}`);
}
const shortcutTooltips = [...html.matchAll(/data-tooltip="([^"]*Ctrl \+ Alt \+ [A-Z])"/g)].map((match) => match[1]);
if (shortcutTooltips.length < 6 || shortcutTooltips.some((tooltip) => !tooltip.includes("&#10;"))) {
  throw new Error("Shortcut tooltips must separate intent and key command with a line break.");
}
if (!styles.includes("white-space: pre-line") || !styles.includes("max-width: min(280px")) {
  throw new Error("Tooltip wrapping or viewport-safe width is missing.");
}
if (!styles.includes("@media (max-height: 820px)") || !styles.includes("@media (max-height: 680px)")) {
  throw new Error("Short laptop-height viewport adaptations are missing.");
}
if (!styles.includes("height: clamp(220px, 34dvh, 270px)") || !styles.includes("flex-wrap: wrap")) {
  throw new Error("The transcript editor or toolbar is not protected from viewport clipping.");
}
if (!styles.includes("max-height: calc(100dvh - 92px)")) {
  throw new Error("Settings panels must respect the dynamic viewport height.");
}
if (!script.includes("function shortcutTooltip") || !script.includes('return `${intent}\\n${shortcut}`')) {
  throw new Error("Dynamic dictation tooltip does not preserve the two-line format.");
}
if (!html.includes('id="resultSection"')) throw new Error("Processed transcript editor is missing.");
if (!html.includes('id="apiSettings"')) throw new Error("API settings panel is missing.");
if (!script.includes("Original preserved")) throw new Error("Original-preservation feedback is missing.");
if (script.includes("PROMPT_OUTPUT_RULES")) throw new Error("Hidden prompt output rules must not be appended.");
if (!script.includes('firstPassPrompt: ""') || !script.includes('secondPassPrompt: ""')) {
  throw new Error("Processing prompts must not have behavioral defaults.");
}
if (!aiClient.includes("generateContent")) throw new Error("Google AI client is missing.");
if (/AIza[0-9A-Za-z_-]{20,}/.test(aiClient + script)) throw new Error("A Google API key appears hardcoded.");
if (!script.includes('model: "gemini-3.1-flash-lite"')) throw new Error("Gemini 3.1 Flash-Lite is not the default model.");
if (!html.includes('id="secondPassPromptInput"')) throw new Error("Second-pass prompt field is missing.");
if (!script.includes("processingConfig.secondPassPrompt")) throw new Error("Second-pass prompt is not used.");
if (!html.includes('id="secondPassEnabledInput"') || !html.includes('role="switch"')) {
  throw new Error("The second-pass enable switch is missing.");
}
if (!script.includes("secondPassEnabled: value.secondPassEnabled !== false")) {
  throw new Error("Existing users must retain an enabled second pass unless they turn it off.");
}
if (!script.includes("secondPassEnabledInput.addEventListener") || !script.includes("saveSecondPassToggle")) {
  throw new Error("The second-pass switch is not persisted immediately.");
}
const secondPassToggleFunction = script.match(/async function saveSecondPassToggle\(\) \{([\s\S]*?)\n  \}/)?.[1] || "";
if (!secondPassToggleFunction.includes("{ ...processingConfig, secondPassEnabled }") || secondPassToggleFunction.includes('secondPassPrompt = ""')) {
  throw new Error("Changing the second-pass switch must preserve the saved prompt.");
}
if (!html.includes('id="promptToggle"') || !html.includes('id="promptSettings"')) {
  throw new Error("Separate prompt settings control and panel are required.");
}
if (!html.includes('id="firstPassPromptInput"') || !script.includes("processingConfig.firstPassPrompt")) {
  throw new Error("Editable first-pass prompt is missing.");
}
const apiPanel = html.match(/<aside id="apiSettings"[\s\S]*?<\/aside>/)?.[0] || "";
const promptPanel = html.match(/<aside id="promptSettings"[\s\S]*?<\/aside>/)?.[0] || "";
if (apiPanel.includes('id="firstPassPromptInput"') || apiPanel.includes('id="secondPassPromptInput"')) {
  throw new Error("Prompt editors must not appear in the API key panel.");
}
if (!promptPanel.includes('id="firstPassPromptInput"') || !promptPanel.includes('id="secondPassPromptInput"')) {
  throw new Error("Both pass-specific prompt editors must appear in the prompt panel.");
}
if (!script.includes("function savePromptSettings") || !script.includes("closePromptSettings")) {
  throw new Error("Prompt settings persistence or panel coordination is missing.");
}
if (!html.includes('id="secondPassButton"')) throw new Error("Second-pass control is missing.");
if (!script.includes("async function runSecondPass")) throw new Error("Second-pass behavior is missing.");
if (!html.includes('id="finishWorkflowButton"')) throw new Error("Dedicated finish workflow button is missing.");
if (!script.includes('finishWorkflowButton.addEventListener')) throw new Error("Finish workflow button behavior is missing.");
if (html.includes('id="stopButton"') || script.includes('querySelector("#stopButton")')) {
  throw new Error("The separate stop button should be removed.");
}
if (!html.includes('id="startButtonLabel"') || !script.includes("function toggleDictation")) {
  throw new Error("The shared start/stop dictation control is missing.");
}
if (!script.includes('startButton.addEventListener("click", toggleDictation)')) {
  throw new Error("The dictation toggle is not wired for clicks.");
}
const startControl = html.match(/<button[^>]*id="startButton"[\s\S]*?<\/button>/)?.[0] || "";
if (!startControl.includes("button-record") || !styles.includes(".button-record")) {
  throw new Error("The idle microphone is missing its subdued toolbar styling.");
}
if (!styles.includes(".button-primary.is-listening")) {
  throw new Error("The microphone is missing its distinct listening/stop state.");
}
for (const id of ["startButton", "finishWorkflowButton", "firstPassButton", "copyButton", "clearButton"]) {
  const button = html.match(new RegExp(`<button[^>]*id="${id}"[\\s\\S]*?</button>`))?.[0] || "";
  if (!button.includes("icon-action") || !button.includes("aria-label")) {
    throw new Error(`Main action is not an accessible icon control: #${id}`);
  }
}
for (const id of ["secondPassButton", "copyResultButton", "discardResultButton"]) {
  const button = html.match(new RegExp(`<button[^>]*id="${id}"[\\s\\S]*?</button>`))?.[0] || "";
  if (!button.includes("icon-action") || !button.includes("aria-label") || !button.includes("data-tooltip")) {
    throw new Error(`Processed-result action is not an accessible icon control: #${id}`);
  }
}

const firstPassPrompt = script.match(/function buildFirstPassPrompt\(sourceText\) \{([\s\S]*?)\n  \}/)?.[1] || "";
const secondPassPrompt = script.match(/function buildSecondPassPrompt\(sourceText\) \{([\s\S]*?)\n  \}/)?.[1] || "";
if (firstPassPrompt.includes("processingConfig.secondPassPrompt")) {
  throw new Error("The second-pass prompt must not be conflated with the first pass.");
}
if (!firstPassPrompt.includes("processingConfig.firstPassPrompt") || secondPassPrompt.includes("processingConfig.firstPassPrompt")) {
  throw new Error("The editable first-pass prompt must be isolated to the first pass.");
}
if (!secondPassPrompt.includes("processingConfig.secondPassPrompt") || !secondPassPrompt.includes("<first_pass_result>")) {
  throw new Error("The separate second-pass prompt is not applied to the first-pass result.");
}
const secondPassFunction = script.match(/async function runSecondPass\([^)]*\) \{([\s\S]*?)\n  \}/)?.[1] || "";
if (!secondPassFunction.includes("resultTranscript.value = processed") || secondPassFunction.includes("transcript.value = processed")) {
  throw new Error("The second pass must replace only the lower processed transcript.");
}
if (!script.includes("looksLikeMisplacedFirstPassPrompt") || !script.includes('processingConfig.secondPassPrompt = ""')) {
  throw new Error("Legacy prompt-conflation cleanup is missing.");
}

const finishWorkflow = script.match(/async function finishWorkflow\(\) \{([\s\S]*?)\n  \}/)?.[1] || "";
const finishSteps = ["stopDictationAndWait", "runFirstPass", "runSecondPass", "copyResultTranscript", "clearTranscript"];
let previousStep = -1;
for (const step of finishSteps) {
  const stepIndex = finishWorkflow.indexOf(step);
  if (stepIndex <= previousStep) throw new Error(`Finish workflow step is missing or out of order: ${step}`);
  previousStep = stepIndex;
}
if (!finishWorkflow.includes("if (!firstPassComplete) return") || !finishWorkflow.includes("if (!secondPassComplete) return") || !finishWorkflow.includes("if (!copied) return")) {
  throw new Error("Finish workflow is missing failure gates before clearing.");
}
if (!finishWorkflow.includes("if (processingConfig.secondPassEnabled)")) {
  throw new Error("The finish workflow does not honor the second-pass toggle.");
}
if (!script.includes("!processingConfig.secondPassEnabled || words === 0")) {
  throw new Error("The standalone second-pass control does not reflect the disabled state.");
}

// ---- WSI-07: Local Whisper security, wiring, and least-privilege checks ----

if (!html.includes('id="dictationProviderToggle"') || !html.includes('id="dictationProviderSettings"')) {
  throw new Error("The dictation provider selector or its settings panel is missing.");
}
if (html.indexOf('src="dictationSettings.js"') > html.indexOf('src="dictationProviderPanel.js"') || html.indexOf('src="dictationProviderPanel.js"') > html.indexOf('src="app.js"')) {
  throw new Error("Dictation settings must load before the provider panel, which must load before the full app.");
}
if (floatingHtml.indexOf('src="dictationSettings.js"') > floatingHtml.indexOf('src="floatingSpeechClient.js"')) {
  throw new Error("Floating Slate must load dictation settings before the floating speech client.");
}
if (offscreenHtml.indexOf('src="whisperServiceClient.js"') > offscreenHtml.indexOf('src="offscreenSpeech.js"') || offscreenHtml.indexOf('src="micCapture.js"') > offscreenHtml.indexOf('src="offscreenSpeech.js"')) {
  throw new Error("The offscreen document must load the WhisperService client and mic capture before the speech host that consumes them.");
}
if (!dictationSettings.includes('DEFAULT_ENDPOINT = "http://127.0.0.1:8178"') || dictationSettings.includes("editableEndpoint")) {
  throw new Error("The Local Whisper endpoint must stay fixed to the loopback address with no editable-host escape hatch.");
}
if (!dictationSettings.includes("value.provider : PROVIDERS.BROWSER")) {
  throw new Error("Browser Dictation must remain the migration default when no prior settings exist.");
}
for (const state of ['CHECKING: "checking"', 'AVAILABLE: "available"', 'UNAVAILABLE: "unavailable"', 'UNAUTHORIZED: "unauthorized"', 'ACTIVE: "active"']) {
  if (!dictationSettings.includes(state)) throw new Error(`Local Whisper availability state is missing: ${state}`);
}
if (!dictationSettings.includes("MIN_PREVIEW_MS = 1500") || !dictationSettings.includes("MAX_PREVIEW_MS = 3000") || !dictationSettings.includes("DEFAULT_PREVIEW_MS = 2000")) {
  throw new Error("Preview-cadence bounds or default do not match the 1,500-3,000 ms / 2,000 ms contract.");
}
const settingsSnapshotFunction = dictationSettings.match(/function toSnapshot\(raw\) \{([\s\S]*?)\n  \}/)?.[1] || "";
if (!settingsSnapshotFunction.includes("hasToken: Boolean(raw.bearerToken)") || settingsSnapshotFunction.includes("bearerToken: raw.bearerToken")) {
  throw new Error("The settings snapshot exposed to the UI must report only whether a token is saved, never the token itself.");
}
if (!dictationSettings.includes("function ensureUnlocked") || !dictationSettings.includes("Dictation is active. Stop dictation before changing provider settings.")) {
  throw new Error("Provider/configuration mutation is not locked while dictation is active.");
}
if (!dictationProviderPanel.includes('tokenInput.value = ""')) {
  throw new Error("The token input must be cleared rather than ever redisplaying a saved token.");
}
if (offscreenSpeech.includes("bearerToken") || offscreenSpeech.includes("chrome.storage")) {
  throw new Error("The offscreen document must never read the saved bearer token; only background.js may.");
}
if (!backgroundScript.includes("DICTATION_SETTINGS_STORAGE_KEY") || !backgroundScript.includes("readLocalWhisperSettings") || !backgroundScript.includes("sayslate-local-whisper-health-check") || !backgroundScript.includes("sayslate-local-whisper-command")) {
  throw new Error("Background routing does not own reading the saved Local Whisper token and relaying its commands.");
}
if (!backgroundScript.includes('DEFAULT_WHISPER_SERVICE_ENDPOINT = "http://127.0.0.1:8178"')) {
  throw new Error("Background routing must target the fixed WhisperService loopback endpoint, not a persisted value.");
}
for (const relayedField of ['type: "sayslate-offscreen-local-whisper-control"', "sessionDescriptor: descriptor"]) {
  if (!backgroundScript.includes(relayedField)) throw new Error(`Local Whisper session handoff is missing: ${relayedField}`);
}
if (backgroundScript.match(/sendMessage\(\{[^}]*token/i)) {
  throw new Error("A relayed extension message appears to include the bearer token; only the session descriptor may be forwarded.");
}
if (!whisperServiceClient.includes('url.searchParams.set("ticket", descriptor.websocketTicket)') || /searchParams\.set\(\s*["']token["']/.test(whisperServiceClient)) {
  throw new Error("The WebSocket URL must carry only the single-use ticket, never the bearer token.");
}
if (!whisperServiceClient.includes("function redactToken") || !whisperServiceClient.includes("globalThis.SaySlateWhisperClient")) {
  throw new Error("The WhisperService client is missing token redaction or its narrow global API.");
}

console.log("Manifest, assets, and DOM references verified.");
console.log("Local Whisper least-privilege permission, token isolation, and provider wiring verified.");
