# SaySlate roadmap

This file tracks feature scope, completed work, product decisions, and future considerations. See `CHANGELOG.md` for chronological release history.

## Completed

- [x] Focused voice-to-text workspace
- [x] One start/stop-and-copy toggle plus copy and clear controls
- [x] Left-hand keyboard shortcuts
- [x] Minimal shortcut tooltips
- [x] Two-line, viewport-safe shortcut tooltips with edge-aware alignment
- [x] Compact, accessible icon-only main action bar
- [x] Subdued idle microphone styling with a distinct active stop state
- [x] Matching icon-only actions for copying or discarding the processed result
- [x] Separate icon-driven second pass that replaces only the lower result
- [x] Separate API configuration and prompt-editing icons/panels
- [x] Persistent light and Cursor-inspired dark themes
- [x] Exact dark palette using `#181818` page and `#1d1f1d` card/menu surfaces
- [x] Dedicated animation module for theme fades, settings-panel transitions, toast slides, and reduced-motion handling
- [x] Floating Slate overlay for ordinary websites without opening another tab or window
- [x] Viewport-safe caret/pointer anchoring for the floating overlay
- [x] Valid native **Alt + Shift + S** browser initializer for on-demand injection
- [x] Manifest regression check that rejects forbidden native `Ctrl+Alt` command combinations
- [x] On-demand active-tab host injection when an existing page has no content-script receiver
- [x] Duplicate-host and duplicate-toggle protection across declared and on-demand host loading
- [x] Focus-independent floating action shortcuts while the overlay is open
- [x] Shared, session-scoped shortcut protocol across the page host and floating iframe
- [x] Overlay-first Escape handling from either the website or iframe focus boundary
- [x] Shared API, model, prompt, second-pass, and theme settings between the full page and overlay
- [x] Input, textarea, selection, and contenteditable insertion with clipboard fallback
- [x] Stage indicators for listening, retrying, both processing passes, and insertion
- [x] Recoverable speech-recognition retry controller shared by the full page and overlay
- [x] Explicit Stop, Clear, Escape, and Finish cancellation of pending speech retries
- [x] Private extension message routing that keeps transcript payloads out of page messaging
- [x] ChatGPT-only process, insert, and submit button with **Ctrl + Alt + S**
- [x] Guarded ChatGPT composer and send-button readiness checks with a bounded wait
- [x] Submission blocked after clipboard fallback, changed target, unsupported surface, or failed processing
- [x] Dedicated ChatGPT integration adapter kept separate from the floating host and workflow controller
- [x] Extension-owned offscreen speech service for website-independent floating dictation
- [x] Session-scoped speech commands and transcript events between the overlay and offscreen controller
- [x] Preserve shared recovery, stop, cancel, interim text, and workflow sequencing outside host-page permission boundaries
- [x] Add a user-selectable Local Whisper dictation provider backed by the manually started WhisperService server, alongside the existing Browser Dictation path
- [x] Persist provider, WhisperService token, and preview cadence through `chrome.storage.local`, with the token never redisplayed after saving
- [x] Isolate every Local Whisper dictation run to its own service session and microphone pipeline, with no state carried into the next run
- [x] Report Local Whisper availability explicitly and never fall back to Browser Dictation silently
- [x] Grant only the least-privilege `http://127.0.0.1:8178/*` host permission for Local Whisper

## User-defined AI processing

- [x] Add a one-click first-pass action.
- [x] Preserve the original transcript unchanged in the existing upper editor.
- [x] Reveal a second editor below it only after processing, containing the first-pass result.
- [x] Let the user review, edit, and copy either version independently.
- [x] Never replace or discard the original transcript automatically.
- [x] Reuse OtterCopy's Google provider request pattern while keeping SaySlate small.
- [x] Use the stable, low-latency Gemini 3.1 model ID: `gemini-3.1-flash-lite`.
- [x] Keep API configuration one layer deep using one compact key icon and panel.
- [x] Keep both pass-specific prompts one layer deep behind a separate prompt icon.
- [x] Store the user-provided key in private extension storage instead of source code.
- [x] Show concise loading, success, and error states without adding chat features.
- [x] Retain both original and processed transcripts locally.
- [x] Add **Ctrl + Alt + G** as the all-left-hand first-pass shortcut.
- [x] Add **Ctrl + Alt + R** to copy the processed result.
- [x] Add **Ctrl + Alt + E** for the separate second pass.
- [x] Add guarded **Ctrl + Alt + F** workflow: stop, run pass one, optionally run pass two, copy result, then clear.
- [x] Add a dedicated **Finish, copy & clear** button that exposes the guarded workflow.
- [x] Add separate free-form first-pass and second-pass prompts without templates or word caps.
- [x] Provide no behavioral defaults or hidden appended output rules.
- [x] Keep each user-defined prompt isolated to its matching pass.
- [x] Add a persistent second-pass toggle that preserves its prompt and lets the finish workflow skip directly from pass one to copy and clear.
- [x] Clarify that **Ctrl + Alt + X** clears the original and processed transcripts together.

### Decisions resolved

- [x] Both processing passes are purpose-agnostic and entirely user-defined.
- [x] Stopping dictation continues to copy the original transcript; the processed result has its own Copy button.
- [x] Retire the failed page-level **Ctrl + Alt + O** initializer; **Alt + Shift + S** remains the supported open/close command.
- [x] Keep **Ctrl + Alt + F** insertion-only; automatic submission requires the distinct ChatGPT-only **Ctrl + Alt + S** action.

## Optional future hardening

- [ ] Use a protected server-side proxy before distributing SaySlate to anyone who should not possess the Google API key.
- [ ] Add dedicated adapters for specialized canvas-based editors when clipboard fallback is insufficient.
- [ ] Add opt-in support for editors inside cross-origin frames.
