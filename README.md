# SaySlate — Voice to Text

SaySlate is a small Chrome/Edge extension with a focused voice-to-text writing page and a compact Floating Slate that can open over ordinary websites. It includes voice capture plus two fully user-defined AI processing passes, with no chat features or accounts.

Project tracking is split between [`ROADMAP.md`](ROADMAP.md), which records feature scope and status, and [`CHANGELOG.md`](CHANGELOG.md), which records verified chronological changes.

## Keyboard shortcuts

- **Alt + Shift + S** - open or close Floating Slate in the active ordinary website

- **Ctrl + Alt + D** — start dictating; press it again to stop and automatically copy the transcript
- **Ctrl + Alt + C** — copy the current transcript without stopping dictation
- **Ctrl + Alt + X** — clear the original and processed transcripts together
- **Ctrl + Alt + G** — run the user-defined first pass
- **Ctrl + Alt + E** — run the user-defined second pass on the lower result
- **Ctrl + Alt + R** — copy the processed result
- **Ctrl + Alt + F** — finish the full workflow: stop, run pass one, optionally run pass two when enabled, copy the final result, then clear everything
- **Ctrl + Alt + S** — on ChatGPT only, finish the floating workflow, insert the final result, and submit it

Inside Floating Slate, **Ctrl + Alt + F** runs the same enabled processing passes in order, inserts the final result at the saved caret, and closes the overlay. If the original field is no longer safe to edit, SaySlate copies the result instead.

On `chatgpt.com`, Floating Slate also shows a dedicated send icon. **Ctrl + Alt + S** or that icon runs the same guarded stages as **Ctrl + Alt + F**, but submits only after the final text is confirmed in the ChatGPT composer and the send button becomes enabled. It waits up to 20 seconds and never submits after a clipboard fallback, changed target, failed processing pass, or unsupported page.

The same guarded sequence is available from the dedicated Finish control, whose tooltip spells out every step for new users.

All action shortcuts are designed to be comfortably operated with the left hand. While Floating Slate is open, they control that overlay even after focus returns to the underlying website. When no overlay is open, SaySlate does not consume those website keystrokes.

The main action bar uses clean icon-only controls. The idle microphone uses the same subdued utility styling as the rest of the toolbar, then changes to a clearly red stop state while listening. Hover over any icon to see its action and keyboard shortcut on separate lines. Tooltips have a viewport-safe maximum width and align inward near screen edges. Stopping by click or shortcut immediately copies the transcript.

## Two user-defined passes

1. Click the key icon in the top-right corner.
2. Enter the Google AI API key already used by OtterCopy.
3. Keep `gemini-3.1-flash-lite`, the fast Gemini 3.1 default, or enter another Google model ID.
4. Click **Save API**.
5. Click the separate prompt/document icon and enter a **First-pass prompt** and **Second-pass prompt**.
6. Dictate or paste a transcript, then choose the first-pass icon.
7. Choose the second-pass wand icon to process the lower result again.

The second pass has its own persistent on/off toggle in the prompt panel. Turning it off preserves the saved second-pass prompt, disables the standalone second-pass action, and makes **Ctrl + Alt + F** finish with the first-pass result: stop, run pass one, copy, then clear.

The first AI call uses only the first-pass prompt and the original transcript. Its output appears in the lower editable card while the original remains unchanged.

When enabled, the second AI call uses only the second-pass prompt and the current lower-card text. Its output replaces the lower-card text; it never replaces the original transcript or creates another panel. Either pass can perform any task the user defines.

SaySlate provides no behavioral prompt defaults and appends no hidden output rules. Each saved prompt is sent as written, followed only by the applicable text inside a delimiter.

API credentials and writing prompts live behind different top-right icons. Each panel is one click deep, and opening one closes the other.

The full finish control waits for each enabled stage to succeed before continuing. If dictation cannot stop cleanly, an enabled AI call fails, or clipboard copying fails, SaySlate keeps the transcripts and does not clear them.

The API key and both user-entered prompts are stored in SaySlate's private `chrome.storage.local` area. Choosing an AI action sends the applicable prompt and text to Google's Generative Language API; ordinary dictation does not.

## Floating Slate

1. Focus an editable field on a normal `http://` or `https://` page and place the caret where the result belongs.
2. Press **Alt + Shift + S** to open Floating Slate near that location.
3. Press **Ctrl + Alt + D** to start dictating and press it again to stop.
4. Press **Ctrl + Alt + F** to run pass one, optionally run pass two, insert the finished text, and close the overlay.

On ChatGPT, use **Ctrl + Alt + S** instead when the finished message should be submitted immediately after successful insertion. The ChatGPT-specific button is hidden on other websites.

The floating toolbar also provides individual controls for dictation, finishing, either AI pass, copying, and clearing. Its status indicator shows listening, retrying, first-pass, second-pass, and insertion progress. Press **Escape** to cancel and close it without inserting. Escape closes Floating Slate first whether keyboard focus is inside the overlay or back on the website.

Floating Slate uses the API key, model, prompts, second-pass setting, and theme saved on the full SaySlate page. It preserves the field and caret that were active when opened. For a selected range, insertion replaces the selection. If the target was removed or changed while processing, SaySlate protects the page content and copies the finished result to the clipboard instead. It submits a message only when the user explicitly invokes the ChatGPT-specific **Ctrl + Alt + S** action or its matching button.

Unexpected recoverable speech-recognition interruptions are retried with a short backoff while the user still intends to dictate. Explicit Stop, Clear, Escape, and Finish actions cancel pending retries.

Floating dictation runs in an extension-owned offscreen speech service rather than inside each website. This keeps microphone ownership with SaySlate and prevents host-page microphone restrictions from making an otherwise visible overlay unusable. The first use may request microphone access for the extension; subsequent websites reuse that extension-owned speech context.

Browser-owned pages such as `edge://`, `chrome://`, and extension-store pages do not allow this overlay. Some canvas-based or highly specialized editors may require the clipboard fallback. Editors inside cross-origin frames are not currently supported.

## Appearance

Use the sun/moon control in the top-right corner to switch between the original light theme and a Cursor-inspired dark theme using `#181818` for the page and `#1d1f1d` for cards and menus. The selected theme is remembered locally.

Theme changes crossfade, settings panels ease in and out, and toast messages slide into view. Motion orchestration lives in `animations.js`, while keyframes and reduced-motion behavior live in `animations.css`.

## Local Whisper dictation

SaySlate can dictate through **Local Whisper**, a manually started, private WhisperService transcription server running on your own machine, instead of the browser's built-in speech recognition. Choose it from the dictation provider control next to the theme toggle. Browser Dictation remains the default and Local Whisper is never selected automatically.

SaySlate never starts, stops, or manages WhisperService. Start it yourself before choosing Local Whisper:

```powershell
cd C:\WhisperService
npm start
```

WhisperService listens only on `127.0.0.1:8178` and must already be running and correctly configured before Local Whisper reports itself available.

### One-time WhisperService setup

1. From the `WhisperService` folder, show or rotate its bearer token:

   ```powershell
   npm run token:show
   npm run token:rotate
   ```

   Normal WhisperService startup never prints the token.

2. Find SaySlate's installed extension ID from `edge://extensions` or `chrome://extensions` (turn on **Developer mode** to see it), then register that exact origin with WhisperService:

   ```powershell
   node src/cli.mjs configure origin add chrome-extension://EXTENSION_ID
   node src/cli.mjs configure origin list
   ```

   **Restart WhisperService** after adding, removing, or changing a registered origin; it only reads its allowed-origin configuration at startup.

3. Open SaySlate's dictation provider panel, choose **Local Whisper**, paste the token into **Bearer token**, and click **Save**. The field clears immediately after saving; SaySlate never redisplays a saved token, only whether one is saved.

The partial-preview cadence can be adjusted from 1,500–3,000 ms (2,000 ms default) in the same panel and takes effect on the next dictation session.

### Provider and status meanings

- **Browser Dictation** uses the browser/operating system speech recognition already described above; it has no networked availability to report.
- **Local Whisper** shows one of: **Checking…**, **Available**, **Unavailable**, **Unauthorized**, or **Active**, next to the provider control.
- Provider and configuration controls lock while dictation is active; stop dictation first to change them.
- If Local Whisper is selected but unavailable, unauthorized, or the stream fails, SaySlate stops with an explicit error. It never silently switches back to Browser Dictation.

### Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Status stays **Unavailable** | WhisperService is not running, or is running on a different address | Start it with `npm start` from `C:\WhisperService`; confirm it is bound to `127.0.0.1:8178` |
| Status shows **Unauthorized** | No token saved, or the saved token does not match WhisperService's current token | Re-run `npm run token:show` in WhisperService and re-save it in SaySlate's dictation panel |
| Dictation fails immediately with a forbidden-origin error | SaySlate's extension ID is not registered with WhisperService, or WhisperService was not restarted after registering it | Run `node src/cli.mjs configure origin list` in WhisperService to confirm the exact `chrome-extension://` origin is present, then restart WhisperService |
| Dictation fails to start at all | Microphone permission was denied, or no microphone is available | Allow microphone access for SaySlate when prompted, and confirm a working input device is selected in the OS |
| Dictation fails with a capacity or worker error | WhisperService has reached its session limit or its transcription worker failed | Wait and retry, or restart WhisperService if the error persists |

Every Local Whisper failure state above is explicit in SaySlate's UI; none of them fall back to Browser Dictation.

## Install in Microsoft Edge

1. Open `edge://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this `SaySlate` folder.
5. Pin SaySlate from the Extensions menu if you want it on the toolbar.

## Install in Google Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this `SaySlate` folder.

On first use, allow microphone access when the browser asks. If browser speech recognition is unavailable, click in the transcript and press **Windows + H** to use Microsoft Voice Typing directly.

The original and processed transcripts are stored in the extension's local browser storage so they remain available when the page is reopened.

After installing or updating version 1.11.5, reload the extension. **Alt + Shift + S** is the native extension command and can inject the Floating Slate host into the active ordinary website on demand, including a tab that was already open. The former page-level **Ctrl + Alt + O** initializer was retired after it failed live validation and was determined unnecessary. Chromium does not permit `Ctrl+Alt` combinations in manifest commands because they can conflict with the `AltGr` key. The browser may show a site-access notice because the overlay must interact with the active page when you invoke it.

If **Alt + Shift + S** is not assigned because another extension already uses it, open `edge://extensions/shortcuts` or `chrome://extensions/shortcuts` and assign a valid shortcut to **Open or close Floating Slate**.

SaySlate does not send dictation to a SaySlate-owned server. With Browser Dictation selected, speech recognition is handled by the browser or operating system. With Local Whisper selected, audio streams only to the WhisperService instance you started yourself at `http://127.0.0.1:8178` on the same machine. When an AI pass is requested, the applicable prompt and text are sent directly to Google's Generative Language API.
