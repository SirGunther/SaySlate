(() => {
  "use strict";

  const panelRuns = new WeakMap();
  const toastRuns = new WeakMap();
  const toastTimers = new WeakMap();
  let themeRun = 0;
  let themeAnimation = null;

  function prefersReducedMotion() {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  }

  function motionDuration(milliseconds) {
    return Math.round(milliseconds * (prefersReducedMotion() ? 0.65 : 1));
  }

  function cancelRun(store, element) {
    store.get(element)?.animation?.cancel();
    store.delete(element);
  }

  function nextPanelToken(panel) {
    return (panelRuns.get(panel)?.token || 0) + 1;
  }

  function showPanel(panel) {
    const token = nextPanelToken(panel);
    cancelRun(panelRuns, panel);
    panel.hidden = false;
    panel.dataset.motionState = "opening";
    if (typeof panel.animate !== "function") {
      delete panel.dataset.motionState;
      return Promise.resolve();
    }
    const animation = panel.animate(
      [
        { opacity: 0, transform: "translateY(-12px) scale(0.97)" },
        { opacity: 1, transform: "translateY(0) scale(1)" }
      ],
      { duration: motionDuration(260), easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
    );
    panelRuns.set(panel, { token, animation });
    return animation.finished.catch(() => {}).finally(() => {
      if (panelRuns.get(panel)?.token !== token) return;
      panelRuns.delete(panel);
      delete panel.dataset.motionState;
    });
  }

  async function hidePanel(panel) {
    if (panel.hidden) return;
    const token = nextPanelToken(panel);
    cancelRun(panelRuns, panel);
    panel.dataset.motionState = "closing";
    if (typeof panel.animate !== "function") {
      panel.hidden = true;
      delete panel.dataset.motionState;
      return;
    }
    const animation = panel.animate(
      [
        { opacity: 1, transform: "translateY(0) scale(1)" },
        { opacity: 0, transform: "translateY(-9px) scale(0.98)" }
      ],
      { duration: motionDuration(190), easing: "cubic-bezier(0.4, 0, 1, 1)" }
    );
    panelRuns.set(panel, { token, animation });
    await animation.finished.catch(() => {});
    if (panelRuns.get(panel)?.token !== token) return;
    panelRuns.delete(panel);
    panel.hidden = true;
    delete panel.dataset.motionState;
  }

  async function transitionTheme(applyTheme) {
    const token = ++themeRun;
    themeAnimation?.cancel();
    themeAnimation = null;
    const reducedMotion = prefersReducedMotion();
    if (!reducedMotion && typeof document.startViewTransition === "function") {
      document.documentElement.classList.add("theme-transitioning");
      const transition = document.startViewTransition(applyTheme);
      await transition.finished.catch(() => {});
      if (themeRun === token) document.documentElement.classList.remove("theme-transitioning");
      return;
    }
    const root = document.documentElement;
    if (typeof root.animate !== "function") {
      applyTheme();
      return;
    }
    const fadeOut = root.animate([{ opacity: 1 }, { opacity: 0.72 }], {
      duration: motionDuration(150),
      easing: "ease-in",
      fill: "forwards"
    });
    themeAnimation = fadeOut;
    await fadeOut.finished.catch(() => {});
    if (themeRun !== token) {
      fadeOut.cancel();
      return;
    }
    applyTheme();
    fadeOut.cancel();
    const fadeIn = root.animate([{ opacity: 0.72 }, { opacity: 1 }], {
      duration: motionDuration(240),
      easing: "ease-out"
    });
    themeAnimation = fadeIn;
    await fadeIn.finished.catch(() => {});
    if (themeRun === token) themeAnimation = null;
  }

  function showToast(toast, duration = 2200) {
    const token = (toastRuns.get(toast)?.token || 0) + 1;
    const timer = toastTimers.get(toast);
    if (timer) window.clearTimeout(timer);
    cancelRun(toastRuns, toast);
    toast.classList.add("visible");
    let animation = null;
    if (typeof toast.animate === "function") {
      animation = toast.animate(
        [
          { opacity: 0, transform: "translate(-50%, 30px) scale(0.97)" },
          { opacity: 1, transform: "translate(-50%, 0) scale(1)" }
        ],
        { duration: motionDuration(320), easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
      );
    }
    toastRuns.set(toast, { token, animation });
    toastTimers.set(toast, window.setTimeout(() => void hideToast(toast, token), duration));
  }

  async function hideToast(toast, token) {
    if (toastRuns.get(toast)?.token !== token) return;
    cancelRun(toastRuns, toast);
    toastTimers.delete(toast);
    if (typeof toast.animate === "function") {
      const animation = toast.animate(
        [
          { opacity: 1, transform: "translate(-50%, 0) scale(1)" },
          { opacity: 0, transform: "translate(-50%, -10px) scale(0.985)" }
        ],
        { duration: motionDuration(220), easing: "cubic-bezier(0.4, 0, 1, 1)" }
      );
      toastRuns.set(toast, { token, animation });
      await animation.finished.catch(() => {});
      if (toastRuns.get(toast)?.token !== token) return;
    }
    toastRuns.delete(toast);
    toast.classList.remove("visible");
  }

  globalThis.SaySlateAnimations = Object.freeze({ showPanel, hidePanel, transitionTheme, showToast });
})();
