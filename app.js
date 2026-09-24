(() => {
  "use strict";

  const STORAGE_KEY = "sayslate-transcript";
  const THEME_KEY = "sayslate-theme";
  const PROCESSING_CONFIG_KEY = "sayslate-grammar-config";
  const RESULT_TEXT_KEY = "sayslate-corrected-transcript";
  const RESULT_SOURCE_KEY = "sayslate-corrected-source";
  const RESULT_STAGE_KEY = "sayslate-corrected-stage";
  const PROMPT_SCHEMA_VERSION = 3;
  // LD-038(1): sayslate-grammar-config carries only prompt fields from here on - no
  // renderer reads, defaults, or writes apiKey/model into it any longer.
  const DEFAULT_PROCESSING_CONFIG = Object.freeze({
    firstPassPrompt: "",
    secondPassPrompt: "",
    secondPassEnabled: true,
    firstPassReasoning: false,
    secondPassReasoning: false,
    promptSchemaVersion: PROMPT_SCHEMA_VERSION
  });
  // LD-038(6): the one literal default this ticket keeps - a new Gemini profile's starting
  // model, not a processingConfig default.
  const GEMINI_DEFAULT_MODEL = "gemini-3.1-flash-lite";
  const PROVIDER_LABELS = Object.freeze({ gemini: "Gemini", openai: "OpenAI", anthropic: "Claude", custom: "Custom" });
  const transcript = document.querySelector("#transcript");
  const startButton = document.querySelector("#startButton");
  const startButtonLabel = document.querySelector("#startButtonLabel");
  const finishWorkflowButton = document.querySelector("#finishWorkflowButton");
  const finishWorkflowLabel = document.querySelector("#finishWorkflowLabel");
  const copyButton = document.querySelector("#copyButton");
  const clearButton = document.querySelector("#clearButton");
  const copyLabel = document.querySelector("#copyLabel");
  const wordCount = document.querySelector("#wordCount");
  const statusPill = document.querySelector("#statusPill");
  const statusText = document.querySelector("#statusText");
  const listeningMeter = document.querySelector("#listeningMeter");
  const notice = document.querySelector("#notice");
  const toast = document.querySelector("#toast");
  const toastMessage = document.querySelector("#toastMessage");
  const themeToggle = document.querySelector("#themeToggle");
  const themeColor = document.querySelector('meta[name="theme-color"]');
  const apiSettingsToggle = document.querySelector("#apiSettingsToggle");
  const apiSettings = document.querySelector("#apiSettings");
  const closeApiSettingsButton = document.querySelector("#closeApiSettingsButton");
  const apiSettingsForm = document.querySelector("#apiSettingsForm");
  const promptToggle = document.querySelector("#promptToggle");
  const promptSettings = document.querySelector("#promptSettings");
  const closePromptSettingsButton = document.querySelector("#closePromptSettingsButton");
  const promptSettingsForm = document.querySelector("#promptSettingsForm");
  const promptStatusDot = document.querySelector("#promptStatusDot");
  const profileSelect = document.querySelector("#profileSelect");
  const providerKindGemini = document.querySelector("#providerKindGemini");
  const providerKindOpenAI = document.querySelector("#providerKindOpenAI");
  const providerKindAnthropic = document.querySelector("#providerKindAnthropic");
  const providerKindCustom = document.querySelector("#providerKindCustom");
  const endpointInput = document.querySelector("#endpointInput");
  const apiKeyInput = document.querySelector("#apiKeyInput");
  const revealKeyButton = document.querySelector("#revealKeyButton");
  const modelInput = document.querySelector("#modelInput");
  const connectionTestStatus = document.querySelector("#connectionTestStatus");
  const connectionTestStatusText = document.querySelector("#connectionTestStatusText");
  const testConnectionButton = document.querySelector("#testConnectionButton");
  const clearCredentialButton = document.querySelector("#clearCredentialButton");
  const deleteProfileButton = document.querySelector("#deleteProfileButton");
  const firstPassPromptInput = document.querySelector("#firstPassPromptInput");
  const secondPassPromptInput = document.querySelector("#secondPassPromptInput");
  const secondPassEnabledInput = document.querySelector("#secondPassEnabledInput");
  const secondPassToggleState = document.querySelector("#secondPassToggleState");
  const firstPassReasoningInput = document.querySelector("#firstPassReasoningInput");
  const firstPassReasoningState = document.querySelector("#firstPassReasoningState");
  const secondPassReasoningInput = document.querySelector("#secondPassReasoningInput");
  const secondPassReasoningState = document.querySelector("#secondPassReasoningState");
  const promptConfigurationStatus = document.querySelector("#promptConfigurationStatus");
  const apiSettingsError = document.querySelector("#apiSettingsError");
  const promptSettingsError = document.querySelector("#promptSettingsError");
  const configurationStatus = document.querySelector("#configurationStatus");
  const apiStatusDot = document.querySelector("#apiStatusDot");
  const firstPassButton = document.querySelector("#firstPassButton");
  const firstPassLabel = document.querySelector("#firstPassLabel");
  const resultSection = document.querySelector("#resultSection");
  const resultTranscript = document.querySelector("#resultTranscript");
  const resultMeta = document.querySelector("#resultMeta");
  const secondPassButton = document.querySelector("#secondPassButton");
  const secondPassLabel = document.querySelector("#secondPassLabel");
  const copyResultButton = document.querySelector("#copyResultButton");
  const discardResultButton = document.querySelector("#discardResultButton");

  const dictationSettingsApi = globalThis.SaySlateDictationSettings || null;
  const LOCAL_WHISPER_PROVIDER = dictationSettingsApi ? dictationSettingsApi.PROVIDERS.LOCAL_WHISPER : "local-whisper";
  const LOCAL_WHISPER_ORIGIN = "full-page";

  let speechController = null;
  let isListening = false;
  let baseText = "";
  let finalText = "";
  let interimText = "";
  let copyResetTimer = null;
  let copyWhenStopped = false;
  let processingConfig = { ...DEFAULT_PROCESSING_CONFIG };
  // LD-023/LD-038: the in-memory mirror of SaySlateAIProviderSettings.load()'s last result.
  // Refreshed on every mutation (activate/upsert/delete/clearCredential) and again from
  // storage at the start of every AI pass (LD-038(2)) - never used as a cached source for a
  // request itself.
  let providerState = { version: 1, activeProfileId: null, profiles: [] };
  let selectedProfileId = "";
  let firstPassRunning = false;
  let secondPassRunning = false;
  let finishWorkflowRunning = false;
  // LD-006/LD-007: "Phase 1", "Phase 2", or "" - the pass whose provider request is
  // currently in flight, so the badge can be restored to it over a discard, clear, or a
  // dictation stop that happened while that request was still running.
  let activePassLabel = "";
  let resultSource = "";
  let resultStage = "first";
  let recognitionFatalError = false;
  let activeProvider = null;
  let localWhisperSessionId = null;
  let localWhisperLastError = null;

  function setStatus(state, label) {
    statusPill.dataset.state = state;
    statusText.textContent = label;
  }

  function shortcutTooltip(intent, shortcut) {
    return `${intent}\n${shortcut}`;
  }

  function renderDictationToggle(listening) {
    const label = listening ? "Stop and copy" : "Start dictating";
    startButton.classList.toggle("is-listening", listening);
    startButton.setAttribute("aria-pressed", String(listening));
    startButton.setAttribute("aria-label", label);
    startButton.dataset.tooltip = shortcutTooltip(label, "Ctrl + Alt + D");
    startButtonLabel.textContent = label;
  }

  function showNotice(message, type = "info") {
    notice.textContent = message;
    notice.className = type === "error" ? "notice error" : "notice";
    notice.hidden = false;
  }

  function hideNotice() {
    notice.hidden = true;
  }

  function showToast(message) {
    toastMessage.textContent = message;
    globalThis.SaySlateAnimations.showToast(toast);
  }

  function applyTheme(theme, persist = true) {
    const isDark = theme === "dark";
    document.documentElement.dataset.theme = isDark ? "dark" : "light";
    themeColor.content = isDark ? "#181818" : "#f7f7f5";
    themeToggle.setAttribute(
      "aria-label",
      isDark ? "Dark mode; switch to light mode" : "Light mode; switch to dark mode"
    );
    themeToggle.dataset.tooltip = isDark ? "Dark mode · Switch to light" : "Light mode · Switch to dark";

    if (persist) {
      try {
        localStorage.setItem(THEME_KEY, isDark ? "dark" : "light");
      } catch {
        // Theme switching still works for the current page without storage.
      }
    }
  }

  async function toggleTheme() {
    const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    await globalThis.SaySlateAnimations.transitionTheme(() => applyTheme(nextTheme));
    showToast(nextTheme === "dark" ? "Dark mode on" : "Light mode on");
  }

  function storageGet(key) {
    if (globalThis.chrome?.storage?.local) {
      return new Promise((resolve, reject) => {
        chrome.storage.local.get(key, (result) => {
          const error = chrome.runtime?.lastError;
          if (error) reject(new Error(error.message));
          else resolve(result?.[key]);
        });
      });
    }

    try {
      const value = localStorage.getItem(key);
      return Promise.resolve(value ? JSON.parse(value) : undefined);
    } catch {
      return Promise.resolve(undefined);
    }
  }

  function storageSet(key, value) {
    if (globalThis.chrome?.storage?.local) {
      return new Promise((resolve, reject) => {
        chrome.storage.local.set({ [key]: value }, () => {
          const error = chrome.runtime?.lastError;
          if (error) reject(new Error(error.message));
          else resolve();
        });
      });
    }

    localStorage.setItem(key, JSON.stringify(value));
    return Promise.resolve();
  }

  function normalizeProcessingConfig(value = {}) {
    return {
      firstPassPrompt: String(value.firstPassPrompt ?? value.grammarPrompt ?? "").trim(),
      secondPassPrompt: String(value.secondPassPrompt ?? value.refinement ?? "").trim(),
      secondPassEnabled: value.secondPassEnabled !== false,
      firstPassReasoning: value.firstPassReasoning === true,
      secondPassReasoning: value.secondPassReasoning === true,
      promptSchemaVersion: Number(value.promptSchemaVersion || 0)
    };
  }

  function normalizePromptForComparison(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  function looksLikeMisplacedFirstPassPrompt(secondPassPrompt, firstPassPrompt) {
    const secondPassText = normalizePromptForComparison(secondPassPrompt);
    const firstPassText = normalizePromptForComparison(firstPassPrompt);
    if (!secondPassText) return false;
    if (secondPassText === firstPassText) return true;

    const asksForGrammar =
      secondPassText.includes("grammatical error") || secondPassText.includes("correct grammar");
    const mentionsPunctuation = secondPassText.includes("punctuation");
    const mentionsIntent = secondPassText.includes("intent") || secondPassText.includes("original message");
    return asksForGrammar && mentionsPunctuation && mentionsIntent;
  }

  function wasLegacyAutomaticFirstPassPrompt(value) {
    const text = normalizePromptForComparison(value);
    return text.includes("correct grammar, spelling, capitalization, and punctuation only") &&
      text.includes("preserve filler words and verbal hesitations");
  }

  function wasLegacyAutomaticSecondPassPrompt(value) {
    const text = normalizePromptForComparison(value);
    return text.includes("improve coherence, clarity, and flow while preserving my intended meaning") &&
      text.includes("without adding unsupported information");
  }

  // LD-038(2): whether an active, still-present provider profile exists right now. Never
  // cached beyond providerState, which is itself refreshed from storage on every mutation
  // and again immediately before each AI pass.
  function hasActiveProfile() {
    return Boolean(
      providerState.activeProfileId &&
      providerState.profiles.some((profile) => profile.id === providerState.activeProfileId)
    );
  }

  function findProfileById(id) {
    return providerState.profiles.find((profile) => profile.id === id) || null;
  }

  function getSelectedProviderKind() {
    if (providerKindOpenAI.checked) return "openai";
    if (providerKindAnthropic.checked) return "anthropic";
    if (providerKindCustom.checked) return "custom";
    return "gemini";
  }

  function setSelectedProviderKind(kind) {
    providerKindGemini.checked = kind === "gemini";
    providerKindOpenAI.checked = kind === "openai";
    providerKindAnthropic.checked = kind === "anthropic";
    providerKindCustom.checked = kind === "custom";
  }

  // LD-017/LD-024: preset endpoints are only editable starting values for a new profile -
  // never applied over an existing saved profile's endpoint.
  function applyProviderPreset(kind) {
    const preset = globalThis.SaySlateAIProviderRegistry.presetFor(kind);
    endpointInput.value = preset ? preset.defaultEndpoint : "";
    modelInput.value = kind === "gemini" ? GEMINI_DEFAULT_MODEL : "";
  }

  function handleProviderKindChange() {
    // Only a new/unsaved profile's preset follows the radio choice; switching an existing
    // saved profile's providerKind must not silently overwrite its saved endpoint/model.
    if (!selectedProfileId) applyProviderPreset(getSelectedProviderKind());
  }

  function renderProfileSelect() {
    const options = ['<option value="">New profile…</option>'];
    for (const profile of providerState.profiles) {
      const label = (profile.name || profile.providerKind).replace(/[&<>"]/g, (char) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]
      ));
      options.push(`<option value="${profile.id}">${label}</option>`);
    }
    profileSelect.innerHTML = options.join("");
    profileSelect.value = providerState.profiles.some((profile) => profile.id === selectedProfileId)
      ? selectedProfileId
      : "";
  }

  function renderProfileForm() {
    const profile = findProfileById(selectedProfileId);
    if (profile) {
      setSelectedProviderKind(profile.providerKind);
      endpointInput.value = profile.endpoint;
      modelInput.value = profile.modelId;
    } else {
      applyProviderPreset(getSelectedProviderKind());
    }
    apiKeyInput.value = "";
    apiKeyInput.placeholder = profile && profile.credential ? "Blank keeps the saved key" : "Paste your key";
    connectionTestStatus.hidden = true;
  }

  function permissionResultMessage(code) {
    if (code === "invalid_configuration") return "That endpoint is not a valid HTTPS URL.";
    return "Permission for that endpoint was not granted.";
  }

  async function handleProfileSelectChange() {
    selectedProfileId = profileSelect.value;
    apiSettingsError.hidden = true;
    if (selectedProfileId) {
      try {
        // LD-038(3): selecting a saved profile activates it immediately.
        providerState = await globalThis.SaySlateAIProviderSettings.activateProfile(selectedProfileId);
      } catch (error) {
        apiSettingsError.textContent = error?.message || "Could not activate the selected profile.";
        apiSettingsError.hidden = false;
      }
    }
    renderProfileForm();
    renderConfigurationStatus();
  }

  async function saveApiSettings(event) {
    event.preventDefault();
    apiSettingsError.hidden = true;

    const providerKind = getSelectedProviderKind();
    const rawEndpoint = endpointInput.value.trim();
    const modelId = modelInput.value.trim();
    const credentialInput = apiKeyInput.value;

    if (!rawEndpoint) {
      apiSettingsError.textContent = "Enter an endpoint for this provider.";
      apiSettingsError.hidden = false;
      return;
    }
    if (!modelId) {
      apiSettingsError.textContent = "Enter a model ID for this provider.";
      apiSettingsError.hidden = false;
      return;
    }

    // LD-038(4): the permission check is the first awaited operation in this handler.
    const permissionResult = await globalThis.SaySlateAIProviderPermissions.ensureForEndpoint(rawEndpoint);
    if (!permissionResult.ok) {
      apiSettingsError.textContent = permissionResultMessage(permissionResult.code);
      apiSettingsError.hidden = false;
      return;
    }

    // LD-038(5): Save stores normalizeEndpoint's output; an invalid endpoint blocks Save.
    const normalized = globalThis.SaySlateAIProviderRegistry.normalizeEndpoint(rawEndpoint);
    if (!normalized.ok) {
      apiSettingsError.textContent = "That endpoint is not a valid HTTPS URL.";
      apiSettingsError.hidden = false;
      return;
    }

    // LD-038(6): the derived name - no separate name control.
    const name = `${PROVIDER_LABELS[providerKind] || "Custom"} · ${modelId}`;
    const credentialAction = credentialInput.trim()
      ? globalThis.SaySlateAIProviderSettings.CREDENTIAL_ACTIONS.REPLACE
      : globalThis.SaySlateAIProviderSettings.CREDENTIAL_ACTIONS.RETAIN;

    try {
      const savedProfile = await globalThis.SaySlateAIProviderSettings.upsertProfile({
        id: selectedProfileId || undefined,
        name,
        providerKind,
        endpoint: normalized.endpoint,
        modelId,
        credential: credentialInput,
        credentialAction
      });
      // LD-038(3): Save upserts, then activates.
      providerState = await globalThis.SaySlateAIProviderSettings.activateProfile(savedProfile.id);
      selectedProfileId = savedProfile.id;
      renderProfileSelect();
      renderProfileForm();
      renderConfigurationStatus();
      closeApiSettings();
      showToast("Provider profile saved and activated");
    } catch (error) {
      apiSettingsError.textContent = error?.message || "The browser could not save this profile.";
      apiSettingsError.hidden = false;
    }
  }

  function showConnectionTestResult(code, message) {
    connectionTestStatus.hidden = false;
    connectionTestStatus.dataset.state = code === "available" ? "available" : "unavailable";
    connectionTestStatusText.textContent = message;
  }

  async function testConnection() {
    apiSettingsError.hidden = true;
    const providerKind = getSelectedProviderKind();
    const rawEndpoint = endpointInput.value.trim();
    const modelId = modelInput.value.trim();
    const existingProfile = findProfileById(selectedProfileId);
    // LD-038(5): the saved credential is used only when the credential input is blank; Test
    // never writes storage.
    const credential = apiKeyInput.value.trim() || existingProfile?.credential || "";

    // LD-038(4): the permission check is the first awaited operation in this handler too.
    const permissionResult = await globalThis.SaySlateAIProviderPermissions.ensureForEndpoint(rawEndpoint);
    if (!permissionResult.ok) {
      showConnectionTestResult(permissionResult.code, permissionResultMessage(permissionResult.code));
      return;
    }

    testConnectionButton.disabled = true;
    testConnectionButton.textContent = "Testing…";
    try {
      const result = await globalThis.SaySlateAIProviderConnectionTest.test({
        profile: { providerKind, endpoint: rawEndpoint, modelId, credential }
      });
      showConnectionTestResult(result.code, result.message);
      showToast(result.ok ? "Connection test succeeded" : "Connection test failed");
    } finally {
      testConnectionButton.disabled = false;
      testConnectionButton.textContent = "Test connection";
    }
  }

  async function clearCredentialHandler() {
    if (!selectedProfileId) return;
    try {
      // F1: clearCredential resolves to the updated PROFILE (per LD-023), not the
      // { version, activeProfileId, profiles } state - reload the real state afterward
      // instead of assigning the profile in its place.
      await globalThis.SaySlateAIProviderSettings.clearCredential(selectedProfileId);
      providerState = await globalThis.SaySlateAIProviderSettings.load();
      apiKeyInput.value = "";
      renderProfileForm();
      renderConfigurationStatus();
      showToast("Credential cleared");
    } catch (error) {
      apiSettingsError.textContent = error?.message || "The credential could not be cleared.";
      apiSettingsError.hidden = false;
    }
  }

  async function deleteProfileHandler() {
    if (!selectedProfileId) return;
    try {
      providerState = await globalThis.SaySlateAIProviderSettings.deleteProfile(selectedProfileId);
      selectedProfileId = "";
      renderProfileSelect();
      renderProfileForm();
      renderConfigurationStatus();
      showToast("Provider profile deleted");
    } catch (error) {
      apiSettingsError.textContent = error?.message || "The profile could not be deleted.";
      apiSettingsError.hidden = false;
    }
  }

  // LD-038(2): resolves the active profile from storage at the start of every AI pass. No
  // cached profile is ever used for a request.
  async function resolveActiveProfile() {
    providerState = await globalThis.SaySlateAIProviderSettings.load();
    if (!providerState.activeProfileId) return null;
    return findProfileById(providerState.activeProfileId);
  }

  function friendlyProcessingError(error, passLabel) {
    const messages = {
      invalid_configuration: "The selected provider profile is incomplete. Check connection settings.",
      authentication_failed: "The provider rejected the configured credential. Check connection settings.",
      model_unavailable: "That model was not found for this provider. Check connection settings.",
      structured_output_unsupported: "The provider does not support structured output for this request.",
      malformed_response: "The provider returned a response that did not match the expected shape.",
      request_timeout: `${passLabel} timed out. Please try again.`,
      network_error: "SaySlate could not reach the provider. Check your connection.",
      // LD-039: carry the adapter's bounded detail (status and the provider's own reason).
      provider_error: `${error?.message || "The provider request failed."} The existing text was preserved.`
    };
    return messages[error?.code] || error?.message || `${passLabel} failed. The existing text was preserved.`;
  }

  function renderConfigurationStatus() {
    const apiConfigured = hasActiveProfile();
    const promptsConfigured = Boolean(
      processingConfig.firstPassPrompt &&
      (!processingConfig.secondPassEnabled || processingConfig.secondPassPrompt)
    );
    const secondPassEnabled = processingConfig.secondPassEnabled;
    configurationStatus.textContent = apiConfigured ? "Configured" : "Not configured";
    configurationStatus.classList.toggle("configured", apiConfigured);
    apiStatusDot.classList.toggle("configured", apiConfigured);
    promptStatusDot.classList.toggle("configured", promptsConfigured);
    apiSettingsToggle.dataset.tooltip = apiConfigured ? "Provider profile active" : "Choose an AI provider";
    promptToggle.dataset.tooltip = promptsConfigured
      ? (secondPassEnabled ? "Both passes configured" : "First pass configured · Second pass off")
      : "Set up AI processing prompts";
    secondPassButton.setAttribute("aria-label", secondPassEnabled ? "Run second pass" : "Second pass disabled");
    secondPassButton.dataset.tooltip = secondPassEnabled
      ? shortcutTooltip("Run second pass", "Ctrl + Alt + E")
      : "Second pass disabled\nEnable it in AI prompts";
    const finishIntent = secondPassEnabled
      ? "Stop → pass 1 → pass 2 → copy final → clear"
      : "Stop → pass 1 → copy final → clear";
    finishWorkflowButton.setAttribute("aria-label", finishIntent);
    finishWorkflowButton.dataset.tooltip = shortcutTooltip(finishIntent, "Ctrl + Alt + F");
    promptConfigurationStatus.textContent = secondPassEnabled ? "Second pass enabled" : "Second pass disabled";
  }

  async function loadProcessingConfig() {
    try {
      processingConfig = normalizeProcessingConfig(await storageGet(PROCESSING_CONFIG_KEY));
      if (processingConfig.promptSchemaVersion < PROMPT_SCHEMA_VERSION) {
        if (wasLegacyAutomaticFirstPassPrompt(processingConfig.firstPassPrompt)) {
          processingConfig.firstPassPrompt = "";
        }
        if (
          looksLikeMisplacedFirstPassPrompt(processingConfig.secondPassPrompt, processingConfig.firstPassPrompt) ||
          wasLegacyAutomaticSecondPassPrompt(processingConfig.secondPassPrompt)
        ) {
          processingConfig.secondPassPrompt = "";
        }
        processingConfig.promptSchemaVersion = PROMPT_SCHEMA_VERSION;
        try {
          await storageSet(PROCESSING_CONFIG_KEY, processingConfig);
        } catch {
          // Keep the migrated configuration for the current page if persistence fails.
        }
      }
    } catch {
      processingConfig = { ...DEFAULT_PROCESSING_CONFIG };
    }
    renderConfigurationStatus();
    updateTextControls();
  }

  function openApiSettings(focusKey = false) {
    closePromptSettings();
    renderProfileSelect();
    renderProfileForm();
    apiSettingsError.hidden = true;
    void globalThis.SaySlateAnimations.showPanel(apiSettings);
    apiSettingsToggle.setAttribute("aria-expanded", "true");
    window.requestAnimationFrame(() => (focusKey ? apiKeyInput : profileSelect).focus());
  }

  function closeApiSettings() {
    void globalThis.SaySlateAnimations.hidePanel(apiSettings);
    apiSettingsToggle.setAttribute("aria-expanded", "false");
    apiKeyInput.type = "password";
    revealKeyButton.dataset.visible = "false";
    revealKeyButton.setAttribute("aria-label", "Show API key");
    apiSettingsError.hidden = true;
  }

  function toggleApiSettings() {
    if (apiSettings.hidden) openApiSettings(!hasActiveProfile());
    else closeApiSettings();
  }

  function openPromptSettings(focusPass = "first") {
    closeApiSettings();
    firstPassPromptInput.value = processingConfig.firstPassPrompt;
    secondPassPromptInput.value = processingConfig.secondPassPrompt;
    secondPassEnabledInput.checked = processingConfig.secondPassEnabled;
    secondPassToggleState.textContent = processingConfig.secondPassEnabled ? "Enabled" : "Disabled";
    firstPassReasoningInput.checked = processingConfig.firstPassReasoning;
    firstPassReasoningState.textContent = processingConfig.firstPassReasoning ? "Reasoning on" : "Reasoning off";
    secondPassReasoningInput.checked = processingConfig.secondPassReasoning;
    secondPassReasoningState.textContent = processingConfig.secondPassReasoning ? "Reasoning on" : "Reasoning off";
    promptSettingsError.hidden = true;
    void globalThis.SaySlateAnimations.showPanel(promptSettings);
    promptToggle.setAttribute("aria-expanded", "true");
    window.requestAnimationFrame(() => {
      const focusTarget = focusPass === "second"
        ? secondPassPromptInput
        : focusPass === "second-toggle" ? secondPassEnabledInput : firstPassPromptInput;
      focusTarget.focus();
    });
  }

  function closePromptSettings() {
    void globalThis.SaySlateAnimations.hidePanel(promptSettings);
    promptToggle.setAttribute("aria-expanded", "false");
    promptSettingsError.hidden = true;
  }

  function togglePromptSettings() {
    if (promptSettings.hidden) openPromptSettings();
    else closePromptSettings();
  }

  function toggleApiKeyVisibility() {
    const showKey = apiKeyInput.type === "password";
    apiKeyInput.type = showKey ? "text" : "password";
    revealKeyButton.dataset.visible = String(showKey);
    revealKeyButton.setAttribute("aria-label", showKey ? "Hide API key" : "Show API key");
    apiKeyInput.focus();
  }

  async function savePromptSettings(event) {
    event.preventDefault();
    const firstPassPrompt = firstPassPromptInput.value.trim();
    const secondPassPrompt = secondPassPromptInput.value.trim();
    const secondPassEnabled = secondPassEnabledInput.checked;
    const firstPassReasoning = firstPassReasoningInput.checked;
    const secondPassReasoning = secondPassReasoningInput.checked;

    if (!firstPassPrompt) {
      promptSettingsError.textContent = "Enter a first-pass prompt.";
      promptSettingsError.hidden = false;
      return;
    }

    if (secondPassEnabled && !secondPassPrompt) {
      promptSettingsError.textContent = "Enter a second-pass prompt or turn the second pass off.";
      promptSettingsError.hidden = false;
      return;
    }

    const nextConfig = normalizeProcessingConfig({
      ...processingConfig,
      firstPassPrompt,
      secondPassPrompt,
      secondPassEnabled,
      firstPassReasoning,
      secondPassReasoning
    });
    try {
      await storageSet(PROCESSING_CONFIG_KEY, nextConfig);
      processingConfig = nextConfig;
      renderConfigurationStatus();
      updateTextControls();
      closePromptSettings();
      showToast(`Prompts saved · Second pass ${secondPassEnabled ? "on" : "off"}`);
    } catch {
      promptSettingsError.textContent = "The browser could not save these prompts.";
      promptSettingsError.hidden = false;
    }
  }

  async function saveSecondPassToggle() {
    const secondPassEnabled = secondPassEnabledInput.checked;
    secondPassToggleState.textContent = secondPassEnabled ? "Enabled" : "Disabled";
    promptSettingsError.hidden = true;
    const previousConfig = processingConfig;
    const nextConfig = normalizeProcessingConfig({ ...processingConfig, secondPassEnabled });

    try {
      await storageSet(PROCESSING_CONFIG_KEY, nextConfig);
      processingConfig = nextConfig;
      renderConfigurationStatus();
      updateTextControls();
      showToast(`Second pass ${secondPassEnabled ? "enabled" : "disabled"}`);
    } catch {
      processingConfig = previousConfig;
      secondPassEnabledInput.checked = previousConfig.secondPassEnabled;
      secondPassToggleState.textContent = previousConfig.secondPassEnabled ? "Enabled" : "Disabled";
      promptSettingsError.textContent = "The browser could not save the second-pass setting.";
      promptSettingsError.hidden = false;
    }
  }

  // LD-004: each reasoning switch saves as soon as it changes, following
  // saveSecondPassToggle's state-word/toast/restore-on-failure shape.
  async function saveFirstPassReasoningToggle() {
    const firstPassReasoning = firstPassReasoningInput.checked;
    firstPassReasoningState.textContent = firstPassReasoning ? "Reasoning on" : "Reasoning off";
    promptSettingsError.hidden = true;
    const previousConfig = processingConfig;
    const nextConfig = normalizeProcessingConfig({ ...processingConfig, firstPassReasoning });

    try {
      await storageSet(PROCESSING_CONFIG_KEY, nextConfig);
      processingConfig = nextConfig;
      showToast(`First-pass reasoning ${firstPassReasoning ? "on" : "off"}`);
    } catch {
      processingConfig = previousConfig;
      firstPassReasoningInput.checked = previousConfig.firstPassReasoning;
      firstPassReasoningState.textContent = previousConfig.firstPassReasoning ? "Reasoning on" : "Reasoning off";
      promptSettingsError.textContent = "The browser could not save the reasoning setting.";
      promptSettingsError.hidden = false;
    }
  }

  async function saveSecondPassReasoningToggle() {
    const secondPassReasoning = secondPassReasoningInput.checked;
    secondPassReasoningState.textContent = secondPassReasoning ? "Reasoning on" : "Reasoning off";
    promptSettingsError.hidden = true;
    const previousConfig = processingConfig;
    const nextConfig = normalizeProcessingConfig({ ...processingConfig, secondPassReasoning });

    try {
      await storageSet(PROCESSING_CONFIG_KEY, nextConfig);
      processingConfig = nextConfig;
      showToast(`Second-pass reasoning ${secondPassReasoning ? "on" : "off"}`);
    } catch {
      processingConfig = previousConfig;
      secondPassReasoningInput.checked = previousConfig.secondPassReasoning;
      secondPassReasoningState.textContent = previousConfig.secondPassReasoning ? "Reasoning on" : "Reasoning off";
      promptSettingsError.textContent = "The browser could not save the reasoning setting.";
      promptSettingsError.hidden = false;
    }
  }

  function persistResultTranscript() {
    try {
      localStorage.setItem(RESULT_TEXT_KEY, resultTranscript.value);
      localStorage.setItem(RESULT_SOURCE_KEY, resultSource);
      localStorage.setItem(RESULT_STAGE_KEY, resultStage);
    } catch {
      // The result remains available for the current page if storage fails.
    }
  }

  function renderResultMeta() {
    const words = resultTranscript.value.trim().match(/\S+/g)?.length || 0;
    const sourceIsCurrent = resultSource === transcript.value;
    const stageLabel = resultStage === "second" ? "Second pass complete" : "First pass complete";
    resultMeta.textContent = sourceIsCurrent
      ? `${words} ${words === 1 ? "word" : "words"} · ${stageLabel} from current transcript`
      : `${words} ${words === 1 ? "word" : "words"} · ${stageLabel}; original has changed`;
    secondPassButton.disabled = !processingConfig.secondPassEnabled || words === 0 || firstPassRunning || secondPassRunning || isListening || finishWorkflowRunning;
    copyResultButton.disabled = words === 0 || secondPassRunning || finishWorkflowRunning;
    discardResultButton.disabled = secondPassRunning || finishWorkflowRunning;
  }

  function showResultTranscript({ scroll = false } = {}) {
    if (!resultTranscript.value.trim()) {
      resultSection.hidden = true;
      return;
    }

    resultSection.hidden = false;
    renderResultMeta();
    if (scroll) {
      resultSection.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function discardResultTranscript({ announce = true } = {}) {
    resultTranscript.value = "";
    resultSource = "";
    resultStage = "first";
    resultSection.hidden = true;
    persistResultTranscript();
    // LD-006: a discard during dictation keeps "Listening"; a discard during a pass request
    // keeps "Phase N" rather than reporting a still-running stage as "Ready".
    if (!isListening && !activePassLabel) setStatus("idle", "Ready");
    if (announce) showToast("Processed result discarded");
  }

  function buildFirstPassPrompt(sourceText) {
    return `${processingConfig.firstPassPrompt}\n\n<transcript>\n${sourceText}\n</transcript>`;
  }

  function buildSecondPassPrompt(sourceText) {
    return `${processingConfig.secondPassPrompt}\n\n<first_pass_result>\n${sourceText}\n</first_pass_result>`;
  }

  function setFirstPassRunning(running) {
    firstPassRunning = running;
    firstPassButton.classList.toggle("is-loading", running);
    firstPassLabel.textContent = running ? "Running first pass…" : "Run first pass";
    updateTextControls();
  }

  function setSecondPassRunning(running) {
    secondPassRunning = running;
    secondPassButton.classList.toggle("is-loading", running);
    secondPassLabel.textContent = running ? "Running second pass…" : "Run second pass";
    updateTextControls();
  }

  function setFinishWorkflowRunning(running) {
    finishWorkflowRunning = running;
    finishWorkflowButton.classList.toggle("is-loading", running);
    finishWorkflowLabel.textContent = running ? "Finishing…" : "Finish, copy & clear";
    updateTextControls();
  }

  async function runFirstPass({ scroll = true, announce = true } = {}) {
    const sourceText = transcript.value.trim();
    if (!sourceText || firstPassRunning || secondPassRunning || isListening) return false;

    if (!processingConfig.firstPassPrompt) {
      showNotice("Add a first-pass prompt before running the first pass.");
      openPromptSettings("first");
      return false;
    }

    // F3: the running state is claimed synchronously, before any await, so a second
    // trigger in the same tick is blocked by the guard above instead of racing past it
    // while this call is still awaiting resolveActiveProfile(). Released on every early
    // return (no profile, error) via finally.
    setFirstPassRunning(true);
    try {
      // LD-038(2): the active profile is resolved from storage at the start of this pass -
      // never from a cached value.
      const profile = await resolveActiveProfile();
      if (!profile) {
        showNotice("Choose a provider in connection settings before running an AI pass.");
        openApiSettings(false);
        return false;
      }

      hideNotice();
      // LD-003/LD-005: the badge tracks this pass's request from here until it settles.
      activePassLabel = "Phase 1";
      setStatus("processing", "Phase 1");
      const processed = await globalThis.SaySlateAIProviderClient.generate({
        profile,
        userPrompt: buildFirstPassPrompt(sourceText),
        reasoning: processingConfig.firstPassReasoning
      });
      resultTranscript.value = processed;
      resultSource = transcript.value;
      resultStage = "first";
      persistResultTranscript();
      showResultTranscript({ scroll });
      // LD-007: dictation that started during the request owns the badge until it stops.
      if (!isListening) setStatus("complete", "Phase 1 ready");
      if (announce) showToast("First pass complete · Original preserved");
      return true;
    } catch (error) {
      if (!isListening) setStatus("error", "Phase 1 failed");
      showNotice(friendlyProcessingError(error, "First pass"), "error");
      return false;
    } finally {
      activePassLabel = "";
      setFirstPassRunning(false);
    }
  }

  async function runSecondPass({ scroll = true, announce = true } = {}) {
    if (!processingConfig.secondPassEnabled) {
      if (announce) showToast("Second pass is disabled");
      openPromptSettings("second-toggle");
      return false;
    }

    const sourceText = resultTranscript.value.trim();
    if (!sourceText) {
      if (announce) showToast("Run the first pass first");
      return false;
    }
    if (secondPassRunning || firstPassRunning || isListening) return false;

    if (!processingConfig.secondPassPrompt) {
      showNotice("Add a second-pass prompt before running the second pass.");
      openPromptSettings("second");
      return false;
    }

    // F3: claimed synchronously, before any await - see runFirstPass.
    setSecondPassRunning(true);
    try {
      // LD-038(2): the active profile is resolved from storage at the start of this pass -
      // never from a cached value.
      const profile = await resolveActiveProfile();
      if (!profile) {
        showNotice("Choose a provider in connection settings before running an AI pass.");
        openApiSettings(false);
        return false;
      }

      hideNotice();
      // LD-003/LD-005: the badge tracks this pass's request from here until it settles.
      activePassLabel = "Phase 2";
      setStatus("processing", "Phase 2");
      const processed = await globalThis.SaySlateAIProviderClient.generate({
        profile,
        userPrompt: buildSecondPassPrompt(sourceText),
        reasoning: processingConfig.secondPassReasoning
      });
      resultTranscript.value = processed;
      resultStage = "second";
      persistResultTranscript();
      showResultTranscript({ scroll });
      // LD-007: dictation that started during the request owns the badge until it stops.
      if (!isListening) setStatus("complete", "Phase 2 ready");
      if (announce) showToast("Second pass complete · Lower result replaced");
      return true;
    } catch (error) {
      if (!isListening) setStatus("error", "Phase 2 failed");
      showNotice(friendlyProcessingError(error, "Second pass"), "error");
      return false;
    } finally {
      activePassLabel = "";
      setSecondPassRunning(false);
    }
  }

  async function copyResultTranscript({ announce = true } = {}) {
    const text = resultTranscript.value.trim();
    if (!text) {
      showToast("No processed result to copy");
      return false;
    }

    try {
      await navigator.clipboard.writeText(resultTranscript.value);
    } catch {
      resultTranscript.select();
      const copied = document.execCommand("copy");
      resultTranscript.setSelectionRange(resultTranscript.value.length, resultTranscript.value.length);
      if (!copied) {
        showNotice("The browser could not access the clipboard. Select the processed text and press Ctrl + C.", "error");
        return false;
      }
    }
    if (announce) showToast("Processed transcript copied");
    return true;
  }

  function joinText(...parts) {
    return parts
      .map((part) => part.trim())
      .filter(Boolean)
      .join(" ");
  }

  function saveTranscript() {
    try {
      localStorage.setItem(STORAGE_KEY, transcript.value);
    } catch {
      // The pad remains fully usable if browser storage is unavailable.
    }
  }

  function updateTextControls() {
    const hasText = transcript.value.trim().length > 0;
    const hasResultText = resultTranscript.value.trim().length > 0;
    const words = transcript.value.trim().match(/\S+/g)?.length || 0;

    startButton.disabled = finishWorkflowRunning || firstPassRunning || secondPassRunning;
    finishWorkflowButton.disabled = finishWorkflowRunning || firstPassRunning || secondPassRunning || (!hasText && !isListening);
    copyButton.disabled = !hasText || finishWorkflowRunning;
    clearButton.disabled = (!hasText && !hasResultText) || finishWorkflowRunning || firstPassRunning || secondPassRunning;
    firstPassButton.disabled = !hasText || firstPassRunning || secondPassRunning || isListening || finishWorkflowRunning;
    transcript.readOnly = isListening || firstPassRunning || finishWorkflowRunning;
    resultTranscript.readOnly = firstPassRunning || secondPassRunning || finishWorkflowRunning;
    wordCount.textContent = `${words} ${words === 1 ? "word" : "words"}`;
    if (!resultSection.hidden) renderResultMeta();
  }

  function renderRecognitionText() {
    transcript.value = joinText(baseText, finalText, interimText);
    transcript.scrollTop = transcript.scrollHeight;
    updateTextControls();
    saveTranscript();
  }

  function commitSession(includeInterim = false) {
    baseText = joinText(baseText, finalText, includeInterim ? interimText : "");
    finalText = "";
    interimText = "";
    transcript.value = baseText;
    updateTextControls();
    saveTranscript();
  }

  function setListeningUI(listening) {
    isListening = listening;
    startButton.disabled = finishWorkflowRunning;
    renderDictationToggle(listening);
    transcript.readOnly = listening || finishWorkflowRunning;
    listeningMeter.classList.toggle("active", listening);
    updateTextControls();

    if (listening) {
      setStatus("listening", "Listening");
    } else if (statusPill.dataset.state !== "error") {
      // LD-007: stopping dictation while a pass request is still in flight reports that
      // pass instead of "Ready", which would show a running stage as finished.
      if (activePassLabel) {
        setStatus("processing", activePassLabel);
      } else {
        setStatus("idle", "Ready");
      }
    }
  }

  function friendlyError(error) {
    const messages = {
      "not-allowed": "Microphone access was blocked. Allow microphone access for SaySlate in your browser settings, then try again.",
      "service-not-allowed": "Speech recognition is disabled by the browser. You can still click in the transcript and press Windows + H.",
      "audio-capture": "No working microphone was found. Check your Windows input device and try again.",
      network: "The browser's speech service could not be reached. Check your connection and try again.",
      "no-speech": "I didn't hear anything. Try again, or check that the correct microphone is selected.",
      aborted: "Dictation stopped."
    };

    return messages[error] || "Dictation stopped unexpectedly. Please try again.";
  }

  function configureRecognition() {
    speechController = globalThis.SaySlateSpeech.create({
      onStart({ recovered }) {
        recognitionFatalError = false;
        hideNotice();
        setListeningUI(true);
        if (recovered) showToast("Transcription resumed");
      },
      onResult(event) {
        const finalized = [];
        const interim = [];

        for (let index = 0; index < event.results.length; index += 1) {
          const phrase = event.results[index][0]?.transcript || "";
          if (event.results[index].isFinal) finalized.push(phrase);
          else interim.push(phrase);
        }

        finalText = finalized.join(" ");
        interimText = interim.join(" ");
        renderRecognitionText();
      },
      onSessionEnd() {
        // Preserve even an unfinished phrase before a browser-service restart.
        commitSession(true);
      },
      onRetry() {
        listeningMeter.classList.remove("active");
        setStatus("retrying", "Retrying…");
        showNotice("Transcription error · Paused · Retrying…");
      },
      onFatalError(error) {
        recognitionFatalError = true;
        copyWhenStopped = false;
        setStatus("error", "Needs attention");
        showNotice(friendlyError(error), "error");
      },
      onStop() {
        const shouldCopy = copyWhenStopped;
        copyWhenStopped = false;
        setListeningUI(false);
        if (recognitionFatalError) setStatus("error", "Needs attention");
        if (shouldCopy) void copyTranscript("Dictation stopped and copied");
      }
    });
  }

  function startDictation() {
    hideNotice();

    if (!globalThis.SaySlateSpeech.isSupported()) {
      setStatus("error", "Unavailable");
      showNotice(
        "This browser does not expose speech recognition here. Click in the transcript and press Windows + H to use Microsoft Voice Typing.",
        "error"
      );
      transcript.focus();
      return;
    }

    if (!speechController) configureRecognition();

    baseText = transcript.value;
    finalText = "";
    interimText = "";
    copyWhenStopped = false;
    recognitionFatalError = false;

    if (!speechController.start()) {
      setStatus("error", "Try again");
      showNotice("The microphone is still getting ready. Wait a moment, then click Start dictating again.", "error");
    }
  }

  function stopDictation(copyAfterStop = true) {
    if (!speechController || !isListening) return Promise.resolve();

    copyWhenStopped = copyAfterStop;
    statusText.textContent = "Finishing…";
    startButton.disabled = true;
    startButton.setAttribute("aria-label", copyAfterStop ? "Stopping and copying" : "Stopping dictation");
    startButton.dataset.tooltip = copyAfterStop ? "Stopping and copying…" : "Stopping dictation…";
    startButtonLabel.textContent = copyAfterStop ? "Stopping and copying" : "Stopping dictation";

    return speechController.stop();
  }

  function stopDictationAndWait() {
    if (activeProvider === LOCAL_WHISPER_PROVIDER) return stopLocalWhisperAndWait();
    if (!speechController || !isListening) return Promise.resolve();
    return Promise.race([
      stopDictation(false),
      new Promise((_, reject) => window.setTimeout(() => reject(new Error("Dictation did not finish stopping in time.")), 10_000))
    ]);
  }

  function isLocalWhisperSelected() {
    return Boolean(dictationSettingsApi) && dictationSettingsApi.getSnapshot().provider === LOCAL_WHISPER_PROVIDER;
  }

  function generateLocalWhisperSessionId() {
    return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function sendLocalWhisperCommand(action, sessionId) {
    return chrome.runtime
      .sendMessage({ type: "sayslate-local-whisper-command", origin: LOCAL_WHISPER_ORIGIN, sessionId, action })
      .catch((error) => ({ ok: false, code: "unavailable", message: error?.message || "Local Whisper could not be reached." }));
  }

  function requestLocalWhisperHealth() {
    return chrome.runtime
      .sendMessage({ type: "sayslate-local-whisper-health-check" })
      .catch((error) => ({ ok: false, code: "unavailable", message: error?.message || "Local Whisper could not be reached." }));
  }

  function mapLocalWhisperErrorToAvailability(code) {
    return code === "unauthorized" ? dictationSettingsApi.AVAILABILITY.UNAUTHORIZED : dictationSettingsApi.AVAILABILITY.UNAVAILABLE;
  }

  async function checkLocalWhisperAvailability() {
    if (!dictationSettingsApi) return;
    dictationSettingsApi.setAvailability(dictationSettingsApi.AVAILABILITY.CHECKING);
    const response = await requestLocalWhisperHealth();
    if (response?.ok && response.ready) {
      dictationSettingsApi.setAvailability(dictationSettingsApi.AVAILABILITY.AVAILABLE);
    } else if (response?.ok) {
      dictationSettingsApi.setAvailability(dictationSettingsApi.AVAILABILITY.UNAVAILABLE, "WhisperService is reachable but not ready yet.");
    } else {
      dictationSettingsApi.setAvailability(mapLocalWhisperErrorToAvailability(response?.code), response?.message || "");
    }
  }

  // Shared teardown for every path that ends a Local Whisper run (stop/cancel/unprompted
  // error). Returns false when this sessionId was already superseded by a race (e.g. an
  // unprompted error event settling the run before the in-flight stop/cancel RPC resolved),
  // so the caller knows not to re-apply its own settlement on top of an already-settled run.
  function settleLocalWhisperSession(sessionId, availabilityState) {
    if (localWhisperSessionId !== sessionId) return false;
    localWhisperSessionId = null;
    activeProvider = null;
    interimText = "";
    setListeningUI(false);
    if (dictationSettingsApi) {
      dictationSettingsApi.setActive(false);
      dictationSettingsApi.setAvailability(availabilityState || dictationSettingsApi.AVAILABILITY.AVAILABLE);
    }
    return true;
  }

  // Only {ok:true} without `inactive` is the real settled outcome of controller.stop() per
  // the WSI-04 contract - a missing/rejected response or {ok:true, inactive:true} (the
  // session was already gone before this stop reached it) means the final transcript was
  // never actually confirmed and must not be treated as a green light for AI processing.
  function isLocalWhisperStopSettled(response) {
    return Boolean(response?.ok) && !response.inactive;
  }

  function friendlyLocalWhisperStopMessage(response) {
    if (response?.message) return response.message;
    if (response?.inactive) {
      return "Local Whisper could not confirm the final transcript before the session ended. The text captured so far was preserved.";
    }
    if (response?.reason) {
      return `Local Whisper could not confirm the final transcript (${response.reason}). The text captured so far was preserved.`;
    }
    return "Local Whisper stop failed. The text captured so far was preserved.";
  }

  function handleLocalWhisperUnpromptedError(payload) {
    const sessionId = localWhisperSessionId;
    const message = payload?.message || "Local Whisper stopped unexpectedly. The text captured so far was preserved.";
    localWhisperLastError = message;
    const state = dictationSettingsApi ? mapLocalWhisperErrorToAvailability(payload?.code) : null;
    const settled = settleLocalWhisperSession(sessionId, state);
    if (settled) {
      setStatus("error", "Needs attention");
      showNotice(message, "error");
    }
  }

  function handleLocalWhisperEvent(message) {
    if (!message || message.type !== "sayslate-offscreen-local-whisper-event") return;
    if (message.target !== LOCAL_WHISPER_ORIGIN) return;
    if (!localWhisperSessionId || message.sessionId !== localWhisperSessionId) return;

    const payload = message.payload || {};
    if (message.event === "partial") {
      interimText = payload.text || "";
      renderRecognitionText();
    } else if (message.event === "final") {
      finalText = joinText(finalText, payload.text || "");
      interimText = "";
      renderRecognitionText();
    } else if (message.event === "empty") {
      interimText = "";
      renderRecognitionText();
    } else if (message.event === "error") {
      handleLocalWhisperUnpromptedError(payload);
    }
  }

  async function startLocalWhisper() {
    hideNotice();
    if (localWhisperSessionId) return;
    if (!dictationSettingsApi || !globalThis.chrome?.runtime?.sendMessage) {
      setStatus("error", "Unavailable");
      showNotice("Local Whisper requires the browser extension messaging API.", "error");
      return;
    }

    const sessionId = generateLocalWhisperSessionId();
    localWhisperSessionId = sessionId;
    activeProvider = LOCAL_WHISPER_PROVIDER;
    localWhisperLastError = null;
    baseText = transcript.value;
    finalText = "";
    interimText = "";
    copyWhenStopped = false;

    const response = await sendLocalWhisperCommand("start", sessionId);

    if (localWhisperSessionId !== sessionId) {
      // Cancelled/cleared while connecting. If the service still completed the start
      // despite that, make sure the now-orphaned live session gets torn down.
      if (response?.ok && !response.inactive) void sendLocalWhisperCommand("cancel", sessionId);
      return;
    }

    if (!response?.ok || response.inactive) {
      localWhisperSessionId = null;
      activeProvider = null;
      const state = mapLocalWhisperErrorToAvailability(response?.code);
      dictationSettingsApi.setAvailability(state, response?.message || "");
      setStatus("error", "Unavailable");
      showNotice(response?.message || "Local Whisper could not start.", "error");
      return;
    }

    dictationSettingsApi.setActive(true);
    dictationSettingsApi.setAvailability(dictationSettingsApi.AVAILABILITY.ACTIVE);
    setListeningUI(true);
  }

  function stopLocalWhisper(copyAfterStop = true) {
    if (!localWhisperSessionId) return Promise.resolve();
    const sessionId = localWhisperSessionId;
    copyWhenStopped = copyAfterStop;
    statusText.textContent = "Finishing…";
    startButton.disabled = true;
    startButton.setAttribute("aria-label", copyAfterStop ? "Stopping and copying" : "Stopping dictation");
    startButton.dataset.tooltip = copyAfterStop ? "Stopping and copying…" : "Stopping dictation…";
    startButtonLabel.textContent = copyAfterStop ? "Stopping and copying" : "Stopping dictation";

    return sendLocalWhisperCommand("stop", sessionId).then((response) => {
      const shouldCopy = copyWhenStopped;
      copyWhenStopped = false;
      const settled = settleLocalWhisperSession(sessionId);
      if (!settled) return;
      if (!isLocalWhisperStopSettled(response)) {
        setStatus("error", "Needs attention");
        showNotice(friendlyLocalWhisperStopMessage(response), "error");
      } else if (shouldCopy) {
        void copyTranscript("Dictation stopped and copied");
      }
    });
  }

  function stopLocalWhisperAndWait() {
    if (!localWhisperSessionId) return Promise.resolve();
    const sessionId = localWhisperSessionId;
    statusText.textContent = "Finishing…";
    startButton.disabled = true;

    return sendLocalWhisperCommand("stop", sessionId).then((response) => {
      const settled = settleLocalWhisperSession(sessionId);
      if (!settled) {
        throw new Error(localWhisperLastError || "Local Whisper stopped unexpectedly. The text captured so far was preserved.");
      }
      if (!isLocalWhisperStopSettled(response)) {
        throw new Error(friendlyLocalWhisperStopMessage(response));
      }
    });
  }

  function cancelLocalWhisper() {
    if (!localWhisperSessionId) return;
    const sessionId = localWhisperSessionId;
    localWhisperSessionId = null;
    activeProvider = null;
    copyWhenStopped = false;
    if (dictationSettingsApi) {
      dictationSettingsApi.setActive(false);
      dictationSettingsApi.setAvailability(dictationSettingsApi.AVAILABILITY.AVAILABLE);
    }
    void sendLocalWhisperCommand("cancel", sessionId);
  }

  async function copyTranscript(successMessage = "Copied to clipboard") {
    if (!transcript.value.trim()) {
      showToast("Nothing to copy yet");
      return false;
    }

    try {
      await navigator.clipboard.writeText(transcript.value);
    } catch {
      transcript.select();
      const copied = document.execCommand("copy");
      transcript.setSelectionRange(transcript.value.length, transcript.value.length);
      if (!copied) {
        showNotice("The browser could not access the clipboard. Select the text and press Ctrl + C.", "error");
        return false;
      }
    }

    window.clearTimeout(copyResetTimer);
    copyLabel.textContent = "Copied";
    copyButton.classList.add("copied");
    copyResetTimer = window.setTimeout(() => {
      copyLabel.textContent = "Copy";
      copyButton.classList.remove("copied");
    }, 1600);
    showToast(successMessage);
    return true;
  }

  function clearTranscript({ announce = true } = {}) {
    if (activeProvider === LOCAL_WHISPER_PROVIDER) {
      cancelLocalWhisper();
      setListeningUI(false);
    } else if (speechController && isListening) {
      copyWhenStopped = false;
      finalText = "";
      interimText = "";
      speechController.cancel();
      setListeningUI(false);
    }
    baseText = "";
    finalText = "";
    interimText = "";
    transcript.value = "";
    discardResultTranscript({ announce: false });
    saveTranscript();
    updateTextControls();
    transcript.focus();
    if (announce) showToast("Everything cleared");
  }

  async function finishWorkflow() {
    if (finishWorkflowRunning) return;
    if (firstPassRunning || secondPassRunning) {
      showToast("AI processing is already running");
      return;
    }

    setFinishWorkflowRunning(true);
    hideNotice();
    transcript.readOnly = true;

    try {
      await stopDictationAndWait();

      if (!transcript.value.trim()) {
        showNotice("There is no transcript to finish yet.");
        return;
      }

      const firstPassComplete = await runFirstPass({ scroll: false, announce: false });
      if (!firstPassComplete) return;

      if (processingConfig.secondPassEnabled) {
        const secondPassComplete = await runSecondPass({ scroll: false, announce: false });
        if (!secondPassComplete) return;
      }

      const copied = await copyResultTranscript({ announce: false });
      if (!copied) return;

      clearTranscript({ announce: false });
      showToast("Finished · Final result copied · Everything cleared");
    } catch (error) {
      showNotice(error?.message || "The finish workflow stopped before clearing anything.", "error");
    } finally {
      transcript.readOnly = isListening;
      setFinishWorkflowRunning(false);
    }
  }

  function toggleDictation() {
    if (isListening) {
      if (activeProvider === LOCAL_WHISPER_PROVIDER) stopLocalWhisper(true);
      else stopDictation(true);
    } else if (isLocalWhisperSelected()) {
      void startLocalWhisper();
    } else {
      startDictation();
    }
  }

  function handleShortcut(event) {
    if (!event.ctrlKey || !event.altKey || event.shiftKey || event.metaKey || event.repeat) return;
    if (
      (!apiSettings.hidden && apiSettings.contains(event.target)) ||
      (!promptSettings.hidden && promptSettings.contains(event.target))
    ) return;

    const key = event.key.toLowerCase();
    if (!new Set(["d", "c", "x", "g", "e", "r", "f"]).has(key)) return;

    event.preventDefault();
    if (finishWorkflowRunning) {
      showToast("Finish workflow is still running");
      return;
    }
    if (key === "d") {
      toggleDictation();
    } else if (key === "c") {
      void copyTranscript();
    } else if (key === "x") {
      clearTranscript();
    } else if (key === "g") {
      void runFirstPass();
    } else if (key === "e") {
      void runSecondPass();
    } else if (key === "r") {
      void copyResultTranscript();
    } else {
      void finishWorkflow();
    }
  }

  startButton.addEventListener("click", toggleDictation);
  finishWorkflowButton.addEventListener("click", () => void finishWorkflow());
  copyButton.addEventListener("click", () => void copyTranscript());
  clearButton.addEventListener("click", () => clearTranscript());
  themeToggle.addEventListener("click", toggleTheme);
  apiSettingsToggle.addEventListener("click", toggleApiSettings);
  promptToggle.addEventListener("click", togglePromptSettings);
  closeApiSettingsButton.addEventListener("click", closeApiSettings);
  closePromptSettingsButton.addEventListener("click", closePromptSettings);
  revealKeyButton.addEventListener("click", toggleApiKeyVisibility);
  apiSettingsForm.addEventListener("submit", saveApiSettings);
  profileSelect.addEventListener("change", () => void handleProfileSelectChange());
  providerKindGemini.addEventListener("change", handleProviderKindChange);
  providerKindOpenAI.addEventListener("change", handleProviderKindChange);
  providerKindAnthropic.addEventListener("change", handleProviderKindChange);
  providerKindCustom.addEventListener("change", handleProviderKindChange);
  testConnectionButton.addEventListener("click", () => void testConnection());
  clearCredentialButton.addEventListener("click", () => void clearCredentialHandler());
  deleteProfileButton.addEventListener("click", () => void deleteProfileHandler());
  promptSettingsForm.addEventListener("submit", savePromptSettings);
  secondPassEnabledInput.addEventListener("change", () => void saveSecondPassToggle());
  firstPassReasoningInput.addEventListener("change", () => void saveFirstPassReasoningToggle());
  secondPassReasoningInput.addEventListener("change", () => void saveSecondPassReasoningToggle());
  firstPassButton.addEventListener("click", () => void runFirstPass());
  secondPassButton.addEventListener("click", () => void runSecondPass());
  copyResultButton.addEventListener("click", () => void copyResultTranscript());
  discardResultButton.addEventListener("click", () => discardResultTranscript());
  if (globalThis.chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener(handleLocalWhisperEvent);
  }
  document.addEventListener("keydown", handleShortcut);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !apiSettings.hidden) {
      closeApiSettings();
      apiSettingsToggle.focus();
    } else if (event.key === "Escape" && !promptSettings.hidden) {
      closePromptSettings();
      promptToggle.focus();
    }
  });
  document.addEventListener("click", (event) => {
    if (
      !apiSettings.hidden &&
      !apiSettings.contains(event.target) &&
      !apiSettingsToggle.contains(event.target)
    ) {
      closeApiSettings();
    }
    if (
      !promptSettings.hidden &&
      !promptSettings.contains(event.target) &&
      !promptToggle.contains(event.target)
    ) {
      closePromptSettings();
    }
  });
  transcript.addEventListener("input", () => {
    if (!isListening) baseText = transcript.value;
    saveTranscript();
    updateTextControls();
  });
  resultTranscript.addEventListener("input", () => {
    persistResultTranscript();
    renderResultMeta();
    updateTextControls();
  });

  window.addEventListener("beforeunload", () => {
    if (activeProvider === LOCAL_WHISPER_PROVIDER) cancelLocalWhisper();
    else if (speechController && isListening) speechController.cancel();
  });

  try {
    transcript.value = localStorage.getItem(STORAGE_KEY) || "";
    resultTranscript.value = localStorage.getItem(RESULT_TEXT_KEY) || "";
    resultSource = localStorage.getItem(RESULT_SOURCE_KEY) || "";
    resultStage = ["second", "refined"].includes(localStorage.getItem(RESULT_STAGE_KEY)) ? "second" : "first";
  } catch {
    transcript.value = "";
    resultTranscript.value = "";
    resultSource = "";
    resultStage = "first";
  }

  baseText = transcript.value;
  applyTheme(document.documentElement.dataset.theme, false);
  updateTextControls();
  showResultTranscript();
  // F2/LD-038(1): migration must fully complete - including its own read of the legacy
  // record - before loadProcessingConfig ever reads sayslate-grammar-config. The two used
  // to run concurrently: when the stored promptSchemaVersion was already behind,
  // loadProcessingConfig's own migration write raced ahead of migrateLegacyConfig's read and
  // stripped apiKey/model from the legacy record before it was ever copied into a profile,
  // silently losing the key. Sequencing this in one async IIFE - migrate, then load prompts -
  // makes the order explicit rather than relying on relative Promise timing.
  void (async () => {
    providerState = await globalThis.SaySlateAIProviderSettings.load();
    await globalThis.SaySlateAIProviderSettings.migrateLegacyConfig();
    providerState = await globalThis.SaySlateAIProviderSettings.load();
    selectedProfileId = providerState.activeProfileId || "";
    renderProfileSelect();
    renderConfigurationStatus();
    await loadProcessingConfig();
  })();
  if (dictationSettingsApi) {
    // load() always notifies "settings" - including on this very first call - so subscribing
    // before calling it covers both the initial page-load probe and every later save (a saved
    // token, preview cadence, or provider change can flip real availability, e.g.
    // unauthorized -> available once a token is saved) with the same single code path.
    dictationSettingsApi.onChange(({ type }) => {
      if (type === "settings") void checkLocalWhisperAvailability();
    });
    void dictationSettingsApi.load();
  }

  if (!globalThis.SaySlateSpeech.isSupported()) {
    showNotice("Tip: click in the transcript and press Windows + H to use Microsoft Voice Typing.");
  }
})();
