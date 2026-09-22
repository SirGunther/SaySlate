(() => {
  "use strict";

  const PROCESSING_CONFIG_KEY = "sayslate-grammar-config";
  const DEFAULT_CONFIG = Object.freeze({
    apiKey: "",
    model: "gemini-3.1-flash-lite",
    firstPassPrompt: "",
    secondPassPrompt: "",
    secondPassEnabled: true
  });
  const searchParams = new URLSearchParams(location.search);
  const sessionId = searchParams.get("session") || "";
  const chatGPTSurface = searchParams.get("surface") === "chatgpt";
  const shortcuts = globalThis.SaySlateFloatingShortcuts;

  const transcript = document.querySelector("#transcript");
  const wordCount = document.querySelector("#wordCount");
  const status = document.querySelector("#status");
  const statusText = document.querySelector("#statusText");
  const notice = document.querySelector("#notice");
  const closeButton = document.querySelector("#closeButton");
  const dictateButton = document.querySelector("#dictateButton");
  const finishButton = document.querySelector("#finishButton");
  const chatGPTSubmitButton = document.querySelector("#chatGPTSubmitButton");
  const firstPassButton = document.querySelector("#firstPassButton");
  const secondPassButton = document.querySelector("#secondPassButton");
  const copyButton = document.querySelector("#copyButton");
  const clearButton = document.querySelector("#clearButton");

  let config = { ...DEFAULT_CONFIG };
  let speech = null;
  let listening = false;
  let processing = false;
  let baseText = "";
  let finalText = "";
  let interimText = "";
  let stage = "raw";
  let copyAfterStop = false;

  function joinText(...parts) {
    return parts.map((part) => String(part || "").trim()).filter(Boolean).join(" ");
  }

  function normalizeConfig(value = {}) {
    return {
      apiKey: String(value.apiKey || "").trim(),
      model: String(value.model || DEFAULT_CONFIG.model).trim(),
      firstPassPrompt: String(value.firstPassPrompt ?? value.grammarPrompt ?? "").trim(),
      secondPassPrompt: String(value.secondPassPrompt ?? value.refinement ?? "").trim(),
      secondPassEnabled: value.secondPassEnabled !== false
    };
  }

  async function loadConfig() {
    const stored = await chrome.storage.local.get(PROCESSING_CONFIG_KEY);
    config = normalizeConfig(stored?.[PROCESSING_CONFIG_KEY]);
    renderControls();
  }

  function setStatus(state, label) {
    status.dataset.state = state;
    statusText.textContent = label;
  }

  function showNotice(message, type = "info") {
    notice.textContent = message;
    notice.className = type === "error" ? "notice error" : "notice";
    notice.hidden = false;
  }

  function hideNotice() {
    notice.hidden = true;
  }

  function renderControls() {
    const hasText = Boolean(transcript.value.trim());
    const locked = processing;
    const words = transcript.value.trim().match(/\S+/g)?.length || 0;
    wordCount.textContent = `${words} ${words === 1 ? "word" : "words"}`;
    dictateButton.classList.toggle("is-listening", listening);
    dictateButton.setAttribute("aria-pressed", String(listening));
    dictateButton.setAttribute("aria-label", listening ? "Stop dictating" : "Start dictating");
    dictateButton.dataset.tooltip = `${listening ? "Stop dictation" : "Start dictation"}\nCtrl + Alt + D`;
    dictateButton.disabled = locked;
    finishButton.disabled = locked || (!hasText && !listening);
    chatGPTSubmitButton.hidden = !chatGPTSurface;
    chatGPTSubmitButton.disabled = !chatGPTSurface || locked || (!hasText && !listening);
    firstPassButton.disabled = locked || listening || !hasText;
    secondPassButton.disabled = locked || listening || !hasText || !config.secondPassEnabled;
    copyButton.disabled = locked || !hasText;
    clearButton.disabled = locked || (!hasText && !listening);
    transcript.readOnly = locked || listening;
  }

  function renderRecognitionText() {
    transcript.value = joinText(baseText, finalText, interimText);
    transcript.scrollTop = transcript.scrollHeight;
    stage = "raw";
    renderControls();
  }

  function commitRecognitionSession() {
    baseText = joinText(baseText, finalText, interimText);
    finalText = "";
    interimText = "";
    transcript.value = baseText;
    stage = "raw";
    renderControls();
  }

  function friendlyError(error) {
    // Local Whisper failures arrive as {code, message} with a real, already-redacted
    // message from whisperServiceClient.js/background.js; show it directly instead of
    // collapsing every provider's failure into the generic code lookup below.
    if (error && typeof error === "object") return error.message || "Dictation stopped unexpectedly.";
    const messages = {
      "not-allowed": "Microphone access was blocked. Allow it for SaySlate, then try again.",
      "service-not-allowed": "Speech recognition is disabled by this browser.",
      "audio-capture": "No working microphone was found.",
      network: "The browser speech service could not be reached.",
      aborted: "Dictation stopped unexpectedly.",
      "offscreen-unavailable": "The extension speech service could not start. Reload SaySlate and try again."
    };
    return messages[error] || "Dictation stopped unexpectedly.";
  }

  function configureSpeech() {
    speech = globalThis.SaySlateFloatingSpeech.create({
      sessionId,
      onStart({ recovered }) {
        listening = true;
        hideNotice();
        setStatus("listening", recovered ? "Resumed" : "Listening");
        renderControls();
      },
      onResult(result) {
        finalText = result.finalText || "";
        interimText = result.interimText || "";
        renderRecognitionText();
      },
      onSessionEnd() {
        commitRecognitionSession();
      },
      onRetry() {
        setStatus("retrying", "Retrying");
        showNotice("Transcription error · Paused · Retrying…");
      },
      onFatalError(error) {
        // A fatal error always means dictation has definitively stopped - including a start
        // that never got off the ground, which no onStop ever follows - so this must release
        // the UI itself rather than leaving the transcript locked read-only indefinitely.
        copyAfterStop = false;
        listening = false;
        setStatus("error", "Needs attention");
        showNotice(friendlyError(error), "error");
        renderControls();
      },
      onStop() {
        listening = false;
        if (status.dataset.state !== "error") setStatus("idle", "Ready");
        renderControls();
        if (copyAfterStop) {
          copyAfterStop = false;
          void copyCurrentText("Dictation stopped and copied");
        }
      }
    });
  }

  function startDictation() {
    hideNotice();
    if (!speech) configureSpeech();
    if (!speech.supported) {
      setStatus("error", "Unavailable");
      showNotice("This browser does not expose speech recognition inside Floating SaySlate.", "error");
      return;
    }
    baseText = transcript.value;
    finalText = "";
    interimText = "";
    copyAfterStop = false;
    listening = true;
    setStatus("listening", "Starting");
    renderControls();
    speech.start();
  }

  function stopDictation(copy = true) {
    if (!speech || !listening) return Promise.resolve({ ok: true });
    copyAfterStop = copy;
    setStatus("processing", "Finishing");
    return speech.stop();
  }

  function toggleDictation() {
    if (listening) void stopDictation(true);
    else startDictation();
  }

  function validatePass(prompt, label) {
    if (!config.apiKey) {
      showNotice("Add your Google AI API key on the full SaySlate page first.", "error");
      return false;
    }
    if (!prompt) {
      showNotice(`Add a ${label.toLowerCase()} prompt on the full SaySlate page first.`, "error");
      return false;
    }
    return true;
  }

  async function runFirstPass() {
    const source = transcript.value.trim();
    if (!source || !validatePass(config.firstPassPrompt, "First-pass")) return false;
    processing = true;
    setStatus("processing", "Phase 1");
    showNotice("Running first pass…");
    renderControls();
    try {
      const result = await globalThis.SaySlateAIClient.generate({
        apiKey: config.apiKey,
        model: config.model,
        prompt: `${config.firstPassPrompt}\n\n<transcript>\n${source}\n</transcript>`
      });
      transcript.value = result;
      baseText = result;
      stage = "first";
      hideNotice();
      setStatus("complete", "Phase 1 ready");
      return true;
    } catch (error) {
      setStatus("error", "Phase 1 failed");
      showNotice(error?.message || "The first pass failed. Your text is unchanged.", "error");
      return false;
    } finally {
      processing = false;
      renderControls();
    }
  }

  async function runSecondPass() {
    const source = transcript.value.trim();
    if (!config.secondPassEnabled) {
      showNotice("The second pass is disabled on the full SaySlate page.");
      return false;
    }
    if (!source || !validatePass(config.secondPassPrompt, "Second-pass")) return false;
    processing = true;
    setStatus("processing", "Phase 2");
    showNotice("Running second pass…");
    renderControls();
    try {
      const result = await globalThis.SaySlateAIClient.generate({
        apiKey: config.apiKey,
        model: config.model,
        prompt: `${config.secondPassPrompt}\n\n<first_pass_result>\n${source}\n</first_pass_result>`
      });
      transcript.value = result;
      baseText = result;
      stage = "second";
      hideNotice();
      setStatus("complete", "Phase 2 ready");
      return true;
    } catch (error) {
      setStatus("error", "Phase 2 failed");
      showNotice(error?.message || "The second pass failed. The previous text is preserved.", "error");
      return false;
    } finally {
      processing = false;
      renderControls();
    }
  }

  async function copyCurrentText(message = "Copied") {
    if (!transcript.value.trim()) return false;
    try {
      await navigator.clipboard.writeText(transcript.value);
      setStatus("complete", message);
      return true;
    } catch {
      transcript.focus();
      transcript.select();
      const copied = document.execCommand("copy");
      transcript.setSelectionRange(transcript.value.length, transcript.value.length);
      if (copied) setStatus("complete", message);
      else showNotice("The text could not be copied. It remains in Floating SaySlate.", "error");
      return copied;
    }
  }

  function clearTranscript() {
    if (speech?.listening) speech.cancel();
    listening = false;
    copyAfterStop = false;
    baseText = "";
    finalText = "";
    interimText = "";
    transcript.value = "";
    stage = "raw";
    hideNotice();
    setStatus("idle", "Ready");
    renderControls();
    transcript.focus();
  }

  async function requestHost(action, text = "") {
    return chrome.runtime.sendMessage({ type: "sayslate-floating-command", sessionId, action, text });
  }

  async function closeFloating() {
    speech?.cancel();
    await requestHost("close");
  }

  async function finishWorkflow(submitToChatGPT = false) {
    if (processing) return;
    processing = true;
    renderControls();
    try {
      if (listening) {
        setStatus("processing", "Stopping");
        const stopResult = await stopDictation(false);
        // A stop that never settled cleanly must not be treated as a green light to
        // process/insert an uncertain transcript - onFatalError already reported the
        // specific problem and the captured text is preserved on screen for the user.
        if (!stopResult?.ok) return;
      }
      if (!transcript.value.trim()) {
        showNotice("There is no transcript to insert.");
        return;
      }
      processing = false;
      renderControls();

      if (stage === "raw") {
        const firstComplete = await runFirstPass();
        if (!firstComplete) return;
      }
      if (config.secondPassEnabled && stage !== "second") {
        const secondComplete = await runSecondPass();
        if (!secondComplete) return;
      }

      processing = true;
      setStatus("processing", submitToChatGPT ? "Preparing send" : "Inserting");
      renderControls();
      const result = await requestHost(submitToChatGPT ? "insert-submit" : "insert", transcript.value);
      if (!result?.ok) {
        setStatus("error", submitToChatGPT ? "Send stopped" : "Insert failed");
        showNotice(result?.message || "The result could not be inserted. It remains here.", "error");
        return;
      }
      setStatus("complete", result.mode === "submitted" ? "Submitted" : result.mode === "inserted" ? "Inserted" : "Copied instead");
      showNotice(result.message);
      globalThis.setTimeout(() => void requestHost("close"), 700);
    } finally {
      processing = false;
      renderControls();
    }
  }

  function runShortcut(key) {
    if (key === "d") toggleDictation();
    else if (key === "c" || key === "r") void copyCurrentText();
    else if (key === "x") clearTranscript();
    else if (key === "g") void runFirstPass();
    else if (key === "e") void runSecondPass();
    else if (key === "f") void finishWorkflow();
    else if (key === "s") void finishWorkflow(true);
  }

  function handleShortcut(event) {
    if (shortcuts?.isEscapeEvent(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void closeFloating();
      return;
    }
    const key = shortcuts?.actionKeyFromEvent(event) || "";
    if (!key) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    runShortcut(key);
  }

  closeButton.addEventListener("click", () => void closeFloating());
  dictateButton.addEventListener("click", toggleDictation);
  finishButton.addEventListener("click", () => void finishWorkflow());
  chatGPTSubmitButton.addEventListener("click", () => void finishWorkflow(true));
  firstPassButton.addEventListener("click", () => void runFirstPass());
  secondPassButton.addEventListener("click", () => void runSecondPass());
  copyButton.addEventListener("click", () => void copyCurrentText());
  clearButton.addEventListener("click", clearTranscript);
  transcript.addEventListener("input", () => {
    if (!listening) {
      baseText = transcript.value;
      stage = "raw";
    }
    renderControls();
  });
  document.addEventListener("keydown", handleShortcut);
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const key = shortcuts?.messageKey(message, sessionId) || "";
    if (!key) return;
    runShortcut(key);
    sendResponse({ ok: true, key });
  });
  addEventListener("beforeunload", () => {
    speech?.cancel();
    speech?.destroy?.();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[PROCESSING_CONFIG_KEY]) {
      config = normalizeConfig(changes[PROCESSING_CONFIG_KEY].newValue);
      renderControls();
    }
  });

  renderControls();
  transcript.focus();
  void loadConfig().catch(() => showNotice("SaySlate settings could not be loaded.", "error"));
  // Warms the persisted dictation-provider snapshot floatingSpeechClient.js reads on every
  // start(); without this, the in-memory default ("browser") would never be replaced by the
  // actually-saved choice, since nothing else in this document ever calls load().
  void globalThis.SaySlateDictationSettings?.load?.();
})();
