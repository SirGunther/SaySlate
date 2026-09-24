# SaySlate changelog

This file records verified SaySlate changes. It does not infer missing release numbers or silently assign earlier work to versions that cannot be recovered.

## Record integrity

- Versions 1.6.0, 1.7.0, 1.8.0, and 1.8.1 are confirmed by an attached copy of their original installation summaries.
- Versions 1.8.2 and 1.9.0 are confirmed by the retained development session and installed extension history.
- Version 1.0.0 is recorded as the baseline identified by the user from the original work.
- The user confirmed that all development recorded here took place during the afternoon of August 6, 2026, over the course of a few hours; finer timestamps are intentionally omitted.
- The current source, README, roadmap, and verification checks confirm the implemented behavior described below.
- No Git history, archived manifests, release packages, or other historical SaySlate copies were available when this changelog was created.
- Exact release assignments for the work between 1.0.0 and 1.6.0 remain unavailable and are recorded separately without assigning them to versions 1.1 through 1.5.

## [Unreleased]

The **Local Whisper** dictation provider below is implemented and passes every automated check, but is not yet cut as a numbered release. Per this project's own release rule, the manifest version, this file's version heading, and `ROADMAP.md` are updated only after the pending real-runtime acceptance items in the [v1.12.0 validation review](docs/review/v1.12.0-whisperservice-local-dictation-validation-review.md) (live WhisperService, live microphone, installed-extension reload) pass. The installed manifest remains `1.11.5` until then.

The **AI provider profiles** below (Gemini, OpenAI, Anthropic Claude, and a Custom OpenAI-compatible endpoint for LM Studio over Tailscale) are also unreleased. The Custom LM Studio path has passed a real end-to-end run, but its acceptance record (`docs/review/ai-provider-tailscale-validation-review.md`) has not been written yet, so the manifest stays `1.11.5` for this work too.

### Added

- Added a user-selectable **Local Whisper** dictation provider backed by the manually started WhisperService server at `http://127.0.0.1:8178`, alongside the existing Browser Dictation path.
- Added a dependency-light WhisperService protocol client, a mono/16 kHz/PCM16 microphone capture pipeline, and a versioned dictation-settings module with a compact provider/status/token/preview-cadence panel in the top toolbar.
- Added a shared offscreen Local Whisper host so both the full page and Floating Slate can dictate through the same isolated, single-session-at-a-time service connection.
- Added the least-privilege `http://127.0.0.1:8178/*` host permission; no other host, wildcard, or LAN access was introduced.
- Added AI provider profiles for **Gemini**, **OpenAI**, **Anthropic Claude**, and a **Custom** OpenAI-compatible endpoint (for LM Studio reached over Tailscale). Each profile keeps its own endpoint, model ID, and key; saving, switching, or deleting one never changes another.
- Added **Test Connection**, which checks the endpoint, the key, and the exact model ID through the provider's model list, without running a generation or sending any transcript.
- AI passes now request a structured `{ "text": ... }` result and validate it before use. If the provider rejects the structured request (HTTP 400 or 422), SaySlate retries once as a plain request.
- Each pass now has its own reasoning switch in the AI prompts panel, off by default. Custom (LM Studio) profiles send `reasoning_effort: "medium"` for a pass with reasoning on and `"none"` otherwise; other providers are unaffected. On the LM Studio host, thinking had taken a pass from about 2 s to about 12 s.
- Custom (LM Studio) passes now stream, and a pass times out only after 90 s with nothing received, so a long reasoning pass (or any long answer) is no longer cut off partway through; other providers are unaffected.
- The existing Gemini key and model migrate once into a Gemini profile; a deleted or cleared profile is never re-created by that migration.
- Custom endpoints must be HTTPS. Access is requested for the exact configured origin only, and only when you click Save or Test Connection (`optional_host_permissions: https://*/*`); Gemini and Local Whisper keep their fixed grants.
- The full-page status badge now shows each AI pass as it runs ("Phase 1", "Phase 2"), then its result, matching Floating Slate.

### Fixed

- AI provider failures on the full page and Floating Slate now show the HTTP status and, for Gemini, Google's own reason (for example, HTTP 503 "This model is currently experiencing high demand"), instead of only "The provider request failed."

### Safety

- Kept Browser Dictation as the default for existing users; Local Whisper is never selected automatically and availability never triggers a silent provider switch.
- The bearer token is persisted only in `chrome.storage.local`. It is read there by `background.js` (to make the authenticated health-check/session-create calls) and, separately, by the dictation-settings module when it loads settings in the full-page or Floating Slate context - solely to know whether a token is saved. In every case it is redacted from the settings snapshot the UI renders, never included in any relayed extension message, and the offscreen document - which owns the microphone and the streaming WebSocket - never reads storage or holds the token at all.
- Kept the WebSocket connection URL limited to the single-use ticket returned by the service; the token never appears in a URL, log, or error message.
- Created a fresh WhisperService session and microphone pipeline for every dictation run; no session id, revision, or partial/final text carries into the next run, and overlapping starts are rejected rather than double-connected.
- Preserved every existing prompt, AI-pass order, copy/insertion action, and the ChatGPT adapter unchanged; this work changes dictation intake only.
- AI provider keys live only in `chrome.storage.local`. A saved key is never written back into an input or shown, and provider failure messages redact it.

### Verification

- Added command-line tests for the protocol client, microphone pipeline, dictation settings/panel, shared offscreen routing, and full-page/floating dictation integration.
- Added static verification that the manifest grants only the two expected host permissions, that the offscreen document never references the saved token or `chrome.storage`, and that the WebSocket URL construction never embeds it.
- `tests/verify.mjs` is now the single standard verification command: it runs every `tests/*.test.mjs` file itself (not just checking that they exist) before running its own static checks.
- Fixed a stale test assertion in the existing offscreen-speech suite that checked the wrong Stop ordering; the production code already correctly waits for the microphone/worklet to flush before sending the WhisperService stop control.
- Kept browser automation disabled; live validation against a running WhisperService instance, a real microphone, and the installed extension remains pending.
- Added focused tests for AI provider settings, the registry and permissions, each transport, Test Connection, the dispatcher, and the provider UI; `node tests/verify.mjs` passes.
- Live, 2026-09-23: from the Chrome machine, a Custom profile reached LM Studio (`google/gemma-4-12b-qat`) through Tailscale Serve, and both Test Connection and a first pass succeeded. Against a local LM Studio, the real client sending `reasoning_effort: "none"` returned 0 reasoning tokens, and on the LM Studio host, whose saved Enable Thinking setting is on, a SaySlate pass also returned 0 reasoning tokens.
- Live, 2026-09-23: Gemini requests reached Google and the key was accepted, but `gemini-3.1-flash-lite` answered HTTP 503 (high demand), so a successful Gemini generation on this build has not been observed yet. OpenAI and Claude profiles have not been run live.

### Documentation

- Added this changelog to establish a permanent release-history record.
- Clarified that `ROADMAP.md` tracks feature scope and status, while this file tracks chronological changes.
- Recovered exact 1.6.0, 1.7.0, 1.8.0, and 1.8.1 release details from an attached copy of the original chat history.
- Added the user-identified 1.0.0 baseline and narrowed the unresolved version interval to 1.1 through 1.5.
- Added sequential `D1`, `D2`, and later objective identifiers to the 1.11.0, 1.11.1, and 1.11.2 review artifacts.
- Replaced the duplicated generic validation checklist with version-specific primary items that map one-to-one to body objectives and categorized sub-checks.
- Added static verification that rejects missing, nonsequential, or mismatched review objective mappings.
- Replaced the 1.11.0 binary checklist with a one-to-one objective status table using `Passed`, `Failed`, `Blocked`, and `N/A`, plus an explicit next step for every objective.
- Applied the separate `Id`, `Item`, `Status`, and `Next step` table structure to the 1.11.1 and 1.11.2 review artifacts.
- Added `Pending` to distinguish applicable, ready-to-test objectives from failures, dependency blocks, and non-applicable work.
- Documented manual WhisperService startup, token retrieval/rotation, extension-origin registration, the restart required after an origin-configuration change, provider/status meanings, the preview-cadence range, and troubleshooting for offline service, invalid token, forbidden origin, microphone permission, and capacity/worker failures.
- Added the [v1.12.0 WhisperService Local Dictation validation review](docs/review/v1.12.0-whisperservice-local-dictation-validation-review.md), documenting this as the pending version once acceptance passes.

## [1.11.5] - 2026-08-20

### Fixed

- Moved Floating Slate speech recognition out of the website-embedded iframe and into an extension-owned offscreen document.
- Removed the host website's microphone-permission boundary from floating dictation after live testing found that the overlay could open but remain unusable on an unapproved site.

### Added

- Added the scoped `offscreen` permission and a `USER_MEDIA` offscreen lifecycle managed by the service worker.
- Added session-scoped speech commands and serialized start, result, retry, fatal-error, session-end, and stop events.
- Added a floating speech client that preserves the visible controller's existing start, stop, cancel, recovery, and teardown contract.

### Verification

- Added command-line tests for offscreen creation, `USER_MEDIA` declaration, session filtering, transcript serialization, explicit stop settlement, and listener teardown.
- Kept browser automation disabled; cross-site microphone behavior remains pending live user validation.

### Documentation

- Corrected the v1.11.4 review's noncanonical partial statuses and separated the cross-site microphone defect from the ChatGPT composer-target objective.
- Added the [v1.11.5 Extension-Owned Speech Service validation review](docs/review/v1.11.5-extension-owned-speech-service-validation-review.md).

## [1.11.4] - 2026-08-20

### Added

- Added a ChatGPT-only floating toolbar action and **Ctrl + Alt + S** shortcut for processing, inserting, and submitting a finished message.
- Added a dedicated ChatGPT adapter based on the neighboring ChatGPT Dictate extension's readiness pattern.
- Added a bounded 20-second wait for the composer to contain the inserted text and `#composer-submit-button` to become available and enabled.

### Safety

- Restricted automatic submission to `chatgpt.com` and its subdomains.
- Required the saved target to be the ChatGPT message composer before insertion begins.
- Blocked submission after clipboard fallback, target replacement, insertion failure, AI failure, disabled send controls, or readiness timeout.
- Preserved the finished transcript and left the overlay open when insertion or submission does not complete.
- Kept **Ctrl + Alt + F** unchanged as the general process-and-insert action.

### Verification

- Added command-line tests for ChatGPT hostname detection, composer identification, text confirmation, enabled send controls, successful clicking, and timeout behavior.
- Extended manifest, shortcut, host-routing, UI, and on-demand injection assertions without launching Edge.

### Documentation

- Added the [1.11.4 ChatGPT Process and Submit validation review](docs/review/v1.11.4-chatgpt-process-submit-validation-review.md).

## [1.11.3] - 2026-08-20

### Added

- Added a shared shortcut protocol used by the ordinary-page host and the Floating Slate iframe.
- Added session-scoped relay of **Ctrl + Alt + D**, **C**, **X**, **G**, **E**, **R**, and **F** from the focused website to its open Floating Slate.
- Added overlay-first Escape handling so the active Floating Slate closes before the underlying website receives Escape.
- Added a short startup queue so an action pressed while the floating iframe is still loading is delivered once it is ready.

### Changed

- Centralized floating shortcut actions through one dispatcher so local iframe events and relayed website events perform the same behavior.
- Limited website shortcut capture to the lifetime of an open Floating Slate; the host does not consume these keys while the overlay is closed.
- Retired the unsuccessful page-level **Ctrl + Alt + O** initializer. **Alt + Shift + S** remains the supported native open/close command.
- Updated on-demand injection to install the shared shortcut protocol before the Floating Slate host.

### Verification

- Added command-line coverage for every floating action key, invalid modifiers, repeated events, Escape recognition, message session validation, and injection order.
- Revalidated the implementation without launching Edge or requesting microphone access; live website and microphone checks remain pending.

### Documentation

- Recorded the failed and intentionally retired 1.11.2 initializer objective without treating it as planned corrective work.
- Added the [1.11.3 Floating Shortcut Routing validation review](docs/review/v1.11.3-floating-shortcut-routing-validation-review.md).

## [1.11.2] - 2026-08-20

### Fixed

- Restored extension loadability after Edge rejected the 1.11.1 manifest.
- Replaced the forbidden native `Ctrl+Alt+O` declaration with the valid, mnemonic **Alt + Shift + S** native initializer.
- Retained **Ctrl + Alt + O** as the page-level toggle on ordinary websites after the host is attached.

### Verification

- Added a regression assertion that fails if a native manifest command uses Chromium's forbidden `Ctrl+Alt` combination.
- Revalidated the parsed manifest and all four command-line test suites without launching Edge.

### Documentation

- Corrected the README, roadmap, and both earlier review records without rewriting the failed 1.11.1 attempt as a success.
- Added the [1.11.2 manifest shortcut repair](docs/1.11.2-manifest-shortcut-repair.md).

### Validation outcome

- The page-level **Ctrl + Alt + O** objective failed live validation. The user determined it was unnecessary, so it was retired in 1.11.3 with no corrective work planned.

## [1.11.1] - 2026-08-20

### Attempted

- Registered **Ctrl + Alt + O** as a native browser extension command instead of relying exclusively on a page-level key listener.
- Added on-demand active-tab injection when the native command finds that an already-open page has no Floating Slate host.
- Added a headless background-routing test for native initialization, injection fallback, session registration, and private tab/frame message delivery.

### Regression

- Edge rejected the complete extension because Chromium does not permit `Ctrl+Alt` combinations in native manifest commands.
- Version 1.11.1 was therefore never loadable or live-validated and was superseded by 1.11.2.
- The toggle, duplicate-host protection, injection fallback, and routing code continued into 1.11.2 after the manifest correction.

### Testing

- Kept all automated verification command-line only; this repair does not launch Edge or request microphone access.
- The four Node suites passed but did not validate Chromium's manifest shortcut-combination rule; 1.11.2 adds that missing regression assertion.
- Left the visible iframe, microphone permission, caret placement, and website insertion marked for live user validation.

### Documentation

- Added live-validation checkboxes to the [1.11.0 Floating Slate change review](docs/1.11.0-floating-slate-change-review.md).
- Added the [1.11.1 Floating Slate initializer repair review](docs/1.11.1-floating-slate-initializer-fix.md).

## [1.11.0] - 2026-08-20

### Added

- Added Floating Slate, a compact voice-to-text overlay that opens over ordinary websites with **Ctrl + Alt + O**.
- Added viewport-safe placement near the saved caret or pointer, with automatic above/below positioning and edge clamping.
- Added floating controls and shortcuts for dictation, the complete workflow, either user-defined AI pass, copying, clearing, and closing.
- Added visible listening, retrying, first-pass, second-pass, insertion, completion, and error states.
- Added insertion support for inputs, textareas, selected text, and contenteditable fields, with a safe clipboard fallback when the original target changes or disappears.
- Added a shared speech-recognition controller with bounded retry backoff for recoverable interruptions.

### Changed

- Shared the saved API key, model, prompts, second-pass toggle, and theme between the full SaySlate page and Floating Slate.
- Changed **Ctrl + Alt + F** inside Floating Slate to stop dictation, run each enabled processing pass in order, insert the final result, and close only after the preceding stage succeeds.
- Routed overlay messages privately through the extension service worker and retained active routes in extension session storage.
- Made explicit Stop, Clear, Escape, and Finish actions cancel pending automatic speech retries.

### Fixed

- Recovered automatically when browser speech recognition ends or reports a retryable error without an explicit user stop.
- Prevented the overlay from being positioned beyond the visible page edges and restored the original field focus and caret on close.

### Limitations

- Browser-owned pages, extension-store pages, and editors inside cross-origin frames cannot host Floating Slate.
- Highly specialized or canvas-based editors may use the clipboard fallback instead of direct insertion.

### Testing

- Removed the temporary Edge-launching browser smoke test and its fixture after it produced unwanted browser-opening notifications.
- Kept durable automated verification command-line only: static integration checks plus Node tests for AI, animations, and speech recovery.

### Documentation

- Added the [1.11.0 Floating Slate change review](docs/1.11.0-floating-slate-change-review.md), which records the problem, requirements, and solution for every file added, modified, or removed in this update.

## [1.10.2] - 2026-08-07

### Fixed

- Made the main workspace adapt to shorter laptop-height browser viewports so the header, transcript editor, and complete action toolbar remain visible.
- Reduced editor height, card padding, and introductory spacing progressively at viewport heights below 820px and 680px while retaining the roomier desktop layout on taller screens.
- Allowed transcript action groups to wrap safely instead of clipping when horizontal room is constrained.
- Switched settings-panel height calculations to the dynamic viewport so browser chrome does not hide the bottom of a menu.

## [1.10.1] - 2026-08-06

### Fixed

- Prevented reduced-motion detection from making theme, panel, and toast transitions completely instant.
- Kept reduced-motion behavior shorter and gentler while preserving visible feedback.
- Increased the normal theme, panel, and toast transition distances and durations so the requested effects are clearly perceptible.

## [1.10.0] - 2026-08-06

### Added

- Added `animations.js` as a dedicated motion controller with cancellation guards for repeated interactions.
- Added `animations.css` for keyframes, motion-specific presentation, and reduced-motion behavior.
- Added a crossfade for light and dark theme changes.
- Added eased open and close transitions for the API and prompt settings panels.
- Added slide-in and slide-out motion for toast messages.

### Changed

- Moved existing listening, loading, and result-entry keyframes out of the main stylesheet.
- Centralized reduced-motion handling in the animation stylesheet.

## [1.9.4] - 2026-08-06

### Fixed

- Removed higher-specificity legacy editor backgrounds that overrode the shared `text-surface` class.
- Made the shared class the single background source for editable text fields in both themes.

## [1.9.3] - 2026-08-06

### Fixed

- Added a shared `text-surface` class for every editable text field.
- Standardized the API key, model, both prompt editors, original transcript, and refined-result editor on `#232323` in dark mode, including their focused states.

## [1.9.2] - 2026-08-06

### Fixed

- Set the dark original-transcript editor to `#232323` in both normal and focused states.

## [1.9.1] - 2026-08-06

### Changed

- Matched the tested dark palette exactly with a `#181818` page background beneath the existing blue-gray radial glow.
- Changed cards, settings menus, and toast surfaces to `#1d1f1d`.
- Aligned the translucent top bar and browser theme color with the updated palette.

## [1.9.0] - 2026-08-06

### Added

- Added a persistent on/off toggle beside the second-pass prompt.
- Made the toggle save immediately without requiring the prompt form to be submitted.

### Changed

- Preserved the saved second-pass prompt when the pass is disabled.
- Disabled the standalone second-pass action while the pass is off.
- Updated the second-pass and finish-workflow tooltips to reflect the active workflow.
- Changed the finish workflow to skip directly from pass one to copy and clear when pass two is disabled.
- Retained the guarded two-pass sequence when pass two is enabled.

### Verification

- Added checks for toggle persistence, prompt preservation, disabled-action state, and conditional finish-workflow behavior.

## [1.8.2] - 2026-08-06

### Changed

- Softened the idle microphone button in both light and dark themes so it matches the subdued toolbar controls.
- Removed the stark black idle treatment and its primary-action shadow.
- Preserved the distinct red stop state while dictation is active.

### Verification

- Added checks for the dedicated idle-record styling and active listening state.

## [1.8.1] - 2026-08-06

### Changed

- Separated tooltip intent from its keyboard shortcut with a line break.
- Added viewport-safe tooltip widths and inward alignment near screen edges.
- Kept tooltips available for controls whose actions may be disabled.

## [1.8.0] - 2026-08-06

### Changed

- Removed all behavioral prompt defaults and hidden prompt output rules.
- Renamed the processing stages from grammar and coherence to **First pass** and **Second pass**.
- Made either pass capable of performing any user-defined task.
- Preserved the user's saved first-pass prompt while clearing a clearly duplicated legacy second-pass prompt.
- Limited each AI request to the applicable saved prompt followed by its tagged source text.
- Replaced the legacy grammar-specific client with a generic AI client.
- Kept **Ctrl + Alt + F** running both passes sequentially before copying and clearing.
- Marked prompt setup incomplete until both prompt fields were filled and saved.

## [1.7.0] - 2026-08-06

### Added

- Added a separate document/prompt icon and writing-settings panel.
- Added two independent prompt editors, labeled **First pass - Grammar cleanup** and **Second pass - Coherence refinement** at this release.

### Changed

- Limited the key-icon panel to the API key and model.
- Made opening one settings panel close the other.
- Made saving either panel preserve the other panel's configuration.
- Retained existing API credentials and the existing refinement prompt during the settings migration.

## [1.6.0] - 2026-08-06

### Added

- Added a distinct coherence-refinement wand icon for the second AI call.
- Added **Ctrl + Alt + E** to run the second pass.

### Changed

- Kept the first pass grammar-only at this release.
- Applied refinement to the current lower-box result and replaced only that lower text.
- Preserved the original transcript throughout both passes.
- Used the existing settings field exclusively for the second-pass refinement prompt.
- Expanded **Ctrl + Alt + F** to run stop, grammar, coherence, copy final, and clear in sequence.
- Awaited and failure-gated every stage of the full workflow.

## Intermediate development - 2026-08-06, versions 1.1 through 1.5 not assigned

The following changes are confirmed by the ordered development requests and current implementation, but the available record does not establish which individual release from 1.1 through 1.5 introduced each item.

### Keyboard and clipboard workflow

- Added **Ctrl + Alt + D** to start dictation and to stop with automatic copying.
- Added **Ctrl + Alt + C** to copy the original transcript.
- Added **Ctrl + Alt + X** to clear the original and processed transcripts together.
- Added **Ctrl + Alt + G** to run the first AI processing pass.
- Added **Ctrl + Alt + R** to copy the processed result.
- Added the initial **Ctrl + Alt + F** finish sequence for stopping, processing, copying, and clearing.
- Added clipboard confirmation toasts and global-clear feedback.

### Appearance and interaction

- Replaced visible shortcut clutter with hover tooltips and accessible labels.
- Added persistent light and Cursor-inspired dark themes.
- Increased dark-theme contrast for the background, editors, and controls.
- Consolidated dictation start and stop into one changing microphone control.
- Replaced the main text actions and processed-result actions with compact icons.
- Added a dedicated finish button exposing the full automated sequence.

### Initial AI processing

- Added Google Generative Language API configuration with a user-provided key and editable model ID.
- Set `gemini-3.1-flash-lite` as the configured default model ID.
- Added the initial grammar-processing pass and editable processed-result area.
- Preserved the original transcript while showing AI output in the lower editor.
- Added independent copying and discarding controls for the processed result.
- Added an editable processing instruction and provider-specific loading, success, and error feedback.
- Sequenced the initial finish workflow so clearing occurred only after the preceding operations succeeded.

## [1.0.0] - 2026-08-06, user-identified baseline

### Added

- Created the distinct **SaySlate** Chrome/Edge extension in the Browser Extensions directory.
- Made the browser-toolbar action open a standalone voice-to-text page.
- Added start and stop dictation controls with an editable transcript.
- Added copy and clear controls for the local transcript.
- Persisted transcript text locally between page openings.
- Added a clean, ChatGPT-inspired interface without chat, accounts, or unrelated features.
- Added the Microsoft Voice Typing fallback using **Windows + H** when browser speech recognition is unavailable.

## Future entries

Every future release should receive its own version heading when it is installed. Entries should describe only changes supported by the source, tests, or an explicit development record.
