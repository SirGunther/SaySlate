(() => {
  "use strict";

  const settingsApi = globalThis.SaySlateDictationSettings;
  const toggle = document.querySelector("#dictationProviderToggle");
  const panel = document.querySelector("#dictationProviderSettings");
  if (!settingsApi || !toggle || !panel) return;

  const statusDot = document.querySelector("#dictationProviderStatusDot");
  const closeButton = document.querySelector("#closeDictationProviderSettingsButton");
  const browserRadio = document.querySelector("#dictationProviderBrowser");
  const localWhisperRadio = document.querySelector("#dictationProviderLocalWhisper");
  const availabilityRow = document.querySelector("#dictationAvailability");
  const availabilityText = document.querySelector("#dictationAvailabilityText");
  const form = document.querySelector("#dictationSettingsForm");
  const tokenInput = document.querySelector("#dictationTokenInput");
  const tokenStatus = document.querySelector("#dictationTokenStatus");
  const previewInput = document.querySelector("#dictationPreviewInput");
  const previewValue = document.querySelector("#dictationPreviewValue");
  const errorBox = document.querySelector("#dictationSettingsError");
  const lockNotice = document.querySelector("#dictationLockNotice");
  const configurationStatus = document.querySelector("#dictationConfigurationStatus");
  const saveButton = document.querySelector("#saveDictationSettingsButton");

  const PROVIDER_LABELS = {
    [settingsApi.PROVIDERS.BROWSER]: "Browser Dictation",
    [settingsApi.PROVIDERS.LOCAL_WHISPER]: "Local Whisper"
  };

  const AVAILABILITY_LABELS = {
    [settingsApi.AVAILABILITY.CHECKING]: "Checking…",
    [settingsApi.AVAILABILITY.AVAILABLE]: "Available",
    [settingsApi.AVAILABILITY.UNAVAILABLE]: "Unavailable",
    [settingsApi.AVAILABILITY.UNAUTHORIZED]: "Unauthorized",
    [settingsApi.AVAILABILITY.ACTIVE]: "Active"
  };

  let latestSnapshot = settingsApi.getSnapshot();
  let latestAvailability = settingsApi.getAvailability();
  let latestActive = settingsApi.isActive();

  function showToast(message) {
    const toast = document.querySelector("#toast");
    const toastMessage = document.querySelector("#toastMessage");
    if (!toast || !toastMessage || !globalThis.SaySlateAnimations) return;
    toastMessage.textContent = message;
    globalThis.SaySlateAnimations.showToast(toast);
  }

  function showError(message) {
    if (!errorBox) return;
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function hideError() {
    if (errorBox) errorBox.hidden = true;
  }

  function render() {
    const provider = latestSnapshot.provider;
    const isLocalWhisper = provider === settingsApi.PROVIDERS.LOCAL_WHISPER;

    browserRadio.checked = provider === settingsApi.PROVIDERS.BROWSER;
    localWhisperRadio.checked = isLocalWhisper;

    // Browser Dictation has no networked availability to report, so the dot is reserved
    // for Local Whisper: its presence alone already distinguishes the selected provider,
    // and its color/state distinguishes checking/available/active/unavailable/unauthorized.
    if (statusDot) {
      statusDot.hidden = !isLocalWhisper;
      if (isLocalWhisper) statusDot.dataset.state = latestAvailability.state;
    }
    const availabilityLabel = AVAILABILITY_LABELS[latestAvailability.state] || latestAvailability.state;
    toggle.dataset.tooltip = isLocalWhisper
      ? `Local Whisper · ${availabilityLabel}`
      : "Browser Dictation selected";
    toggle.setAttribute(
      "aria-label",
      isLocalWhisper
        ? `Dictation provider settings · Local Whisper · ${availabilityLabel}`
        : "Dictation provider settings · Browser Dictation selected"
    );

    if (availabilityRow) {
      availabilityRow.hidden = !isLocalWhisper;
      availabilityRow.dataset.state = latestAvailability.state;
    }
    if (availabilityText) {
      availabilityText.textContent = AVAILABILITY_LABELS[latestAvailability.state] || latestAvailability.state;
    }

    if (tokenStatus) tokenStatus.textContent = latestSnapshot.hasToken ? "Token saved." : "No token saved.";
    if (previewInput) previewInput.value = String(latestSnapshot.previewMs);
    if (previewValue) previewValue.textContent = String(latestSnapshot.previewMs);
    if (configurationStatus) {
      configurationStatus.textContent = `${PROVIDER_LABELS[provider] || provider} selected`;
    }

    const locked = latestActive;
    browserRadio.disabled = locked;
    localWhisperRadio.disabled = locked;
    if (tokenInput) tokenInput.disabled = locked;
    if (previewInput) previewInput.disabled = locked;
    if (saveButton) saveButton.disabled = locked;
    if (lockNotice) lockNotice.hidden = !locked;
  }

  function openPanel() {
    hideError();
    if (tokenInput) tokenInput.value = "";
    void globalThis.SaySlateAnimations?.showPanel(panel);
    toggle.setAttribute("aria-expanded", "true");
  }

  function closePanel() {
    void globalThis.SaySlateAnimations?.hidePanel(panel);
    toggle.setAttribute("aria-expanded", "false");
    if (tokenInput) tokenInput.value = "";
    hideError();
  }

  function togglePanel() {
    if (panel.hidden) openPanel();
    else closePanel();
  }

  async function changeProvider(provider) {
    hideError();
    try {
      latestSnapshot = await settingsApi.saveProvider(provider);
      render();
      showToast(`${PROVIDER_LABELS[provider] || provider} selected`);
    } catch (error) {
      render();
      showError(error?.message || "Could not change the dictation provider.");
    }
  }

  browserRadio.addEventListener("change", () => {
    if (browserRadio.checked) void changeProvider(settingsApi.PROVIDERS.BROWSER);
  });
  localWhisperRadio.addEventListener("change", () => {
    if (localWhisperRadio.checked) void changeProvider(settingsApi.PROVIDERS.LOCAL_WHISPER);
  });

  if (previewInput && previewValue) {
    previewInput.addEventListener("input", () => {
      previewValue.textContent = previewInput.value;
    });
  }

  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      hideError();
      const tokenValue = tokenInput ? tokenInput.value : "";
      try {
        latestSnapshot = await settingsApi.saveConfig({
          previewMs: previewInput ? previewInput.value : undefined,
          token: tokenValue
        });
        if (tokenInput) tokenInput.value = "";
        render();
        showToast("Local Whisper settings saved");
      } catch (error) {
        showError(error?.message || "The browser could not save these settings.");
      }
    });
  }

  toggle.addEventListener("click", togglePanel);
  closeButton?.addEventListener("click", closePanel);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) {
      closePanel();
      toggle.focus();
    }
  });

  document.addEventListener("click", (event) => {
    if (!panel.hidden && !panel.contains(event.target) && !toggle.contains(event.target)) {
      closePanel();
    }
  });

  // app.js's global Ctrl+Alt shortcut handler only excludes its own two settings panels
  // (it cannot be edited under this ticket's file ownership), so intercept those
  // combinations here, in the capture phase, before they reach app.js's bubble-phase
  // listener, whenever focus is inside this panel while it is open.
  document.addEventListener("keydown", (event) => {
    if (!panel.hidden && panel.contains(event.target) && event.ctrlKey && event.altKey) {
      event.stopPropagation();
    }
  }, true);

  settingsApi.onChange(({ settings, availability, active }) => {
    latestSnapshot = settings;
    latestAvailability = availability;
    latestActive = active;
    render();
  });

  render();
  void settingsApi.load().then((settings) => {
    latestSnapshot = settings;
    latestAvailability = settingsApi.getAvailability();
    latestActive = settingsApi.isActive();
    render();
  });
})();
