# SaySlate Session Resume

## Objective

Make Floating Slate reliable across ordinary websites while preserving the guarded ChatGPT process, insert, and submit workflow.

## Current State

- SaySlate v1.11.5 is implemented. Floating dictation now uses an extension-owned offscreen speech service instead of speech recognition inside the host-page iframe.
- The v1.11.4 ChatGPT workflow remains implemented: `Ctrl+Alt+F` processes and inserts, while `Ctrl+Alt+S` processes, inserts, and submits only on ChatGPT.
- All nine command-line test suites pass. No automated browser window was launched.
- Live browser validation for v1.11.5 is still pending.

## Key Decisions

- Keep `Ctrl+Alt+F` as the general process-and-insert workflow.
- Keep `Ctrl+Alt+S` ChatGPT-only and submit only after validating the composer, inserted text, and enabled send button.
- Run floating speech recognition from one extension-owned offscreen document so website microphone policies do not control it.
- On an explicit stop, commit the final speech session before beginning either AI pass.

## Open Questions Or Unfinished Work

- Confirm whether Edge reuses the existing SaySlate microphone permission or shows a one-time prompt for the offscreen service.
- Validate dictation on the previously failing non-ChatGPT site and a second ordinary site.
- Validate retry recovery, Escape cancellation, non-ChatGPT `Ctrl+Alt+F`, and ChatGPT `Ctrl+Alt+S` after the architecture change.
- Record results in the v1.11.5 review. The v1.11.4 second-pass ordering and composer-replacement checks also remain pending; its non-ChatGPT insertion check was blocked by the microphone defect.

## Relevant Findings Or Constraints

- Speech recognition inside the embedded iframe inherited host-site microphone restrictions; the Manifest V3 offscreen `USER_MEDIA` service is the corrective architecture.
- Do not launch Edge for automated smoke tests. Browser validation is manual in the user's `PDProjects` profile.
- Do not clear extension storage; saved API and prompt settings must remain intact.

## Resume Point And Next Step

Reload v1.11.5, refresh the previously failing site, focus an editable field, open Floating Slate with `Alt+Shift+S`, and start dictation with `Ctrl+Alt+D`. If it works, repeat on a second site and complete the [v1.11.5 validation review](review/v1.11.5-extension-owned-speech-service-validation-review.md). Use the [v1.11.4 review](review/v1.11.4-chatgpt-process-submit-validation-review.md) for the remaining ChatGPT workflow checks.
