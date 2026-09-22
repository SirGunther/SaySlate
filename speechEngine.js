(() => {
  "use strict";

  const RETRYABLE_ERRORS = new Set(["network", "no-speech", "aborted"]);
  const BASE_RETRY_DELAY_MS = 450;
  const MAX_RETRY_DELAY_MS = 5_000;

  function getRecognitionConstructor() {
    return globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null;
  }

  function create(options = {}) {
    const Recognition = options.Recognition || getRecognitionConstructor();
    let recognition = null;
    let wantsListening = false;
    let active = false;
    let stopRequested = false;
    let retryTimer = null;
    let retryAttempts = 0;
    let pendingRetryError = "";
    let stopPromise = null;
    let resolveStop = null;

    function emit(name, ...args) {
      options[name]?.(...args);
    }

    function clearRetryTimer() {
      if (retryTimer === null) return;
      globalThis.clearTimeout(retryTimer);
      retryTimer = null;
    }

    function settleStop() {
      if (!resolveStop) return;
      const settle = resolveStop;
      resolveStop = null;
      stopPromise = null;
      settle();
    }

    function retryDelay() {
      return Math.min(BASE_RETRY_DELAY_MS * 2 ** Math.min(retryAttempts, 4), MAX_RETRY_DELAY_MS);
    }

    function attemptStart() {
      if (!recognition || !wantsListening || stopRequested) return;
      clearRetryTimer();
      try {
        recognition.start();
      } catch (error) {
        scheduleRestart(error?.name === "InvalidStateError" ? "busy" : "start-failed");
      }
    }

    function scheduleRestart(error = "") {
      if (!wantsListening || stopRequested) return;
      clearRetryTimer();
      const delay = error ? retryDelay() : BASE_RETRY_DELAY_MS;
      retryAttempts += 1;
      emit("onRetry", { error, attempt: retryAttempts, delay });
      retryTimer = globalThis.setTimeout(() => {
        retryTimer = null;
        attemptStart();
      }, delay);
    }

    function configure() {
      recognition = new Recognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = options.lang || globalThis.navigator?.language || "en-US";

      recognition.onstart = () => {
        const recovered = retryAttempts > 0;
        active = true;
        retryAttempts = 0;
        pendingRetryError = "";
        emit("onStart", { recovered });
      };

      recognition.onresult = (event) => emit("onResult", event);

      recognition.onerror = (event) => {
        const error = event?.error || "unknown";
        if (error === "aborted" && stopRequested) return;

        if (RETRYABLE_ERRORS.has(error) && wantsListening && !stopRequested) {
          pendingRetryError = error;
          return;
        }

        wantsListening = false;
        stopRequested = true;
        clearRetryTimer();
        emit("onFatalError", error);
      };

      recognition.onend = () => {
        active = false;
        emit("onSessionEnd", { explicit: stopRequested, retrying: wantsListening && !stopRequested });

        if (wantsListening && !stopRequested) {
          const retryError = pendingRetryError;
          pendingRetryError = "";
          scheduleRestart(retryError);
          return;
        }

        wantsListening = false;
        stopRequested = false;
        clearRetryTimer();
        emit("onStop");
        settleStop();
      };
    }

    function start() {
      if (!Recognition) return false;
      if (wantsListening) return true;
      if (!recognition) configure();
      wantsListening = true;
      stopRequested = false;
      retryAttempts = 0;
      pendingRetryError = "";
      attemptStart();
      return true;
    }

    function stop() {
      if (!recognition || (!wantsListening && !active)) return Promise.resolve();
      if (stopPromise) return stopPromise;

      wantsListening = false;
      stopRequested = true;
      pendingRetryError = "";
      clearRetryTimer();
      stopPromise = new Promise((resolve) => {
        resolveStop = resolve;
      });

      try {
        recognition.stop();
      } catch {
        active = false;
        emit("onSessionEnd", { explicit: true, retrying: false });
        stopRequested = false;
        emit("onStop");
        settleStop();
      }

      return stopPromise || Promise.resolve();
    }

    function cancel() {
      wantsListening = false;
      stopRequested = true;
      pendingRetryError = "";
      clearRetryTimer();
      try {
        recognition?.abort();
      } catch {
        settleStop();
      }
    }

    return {
      start,
      stop,
      cancel,
      get supported() {
        return Boolean(Recognition);
      },
      get listening() {
        return wantsListening;
      },
      get active() {
        return active;
      }
    };
  }

  globalThis.SaySlateSpeech = {
    create,
    isSupported: () => Boolean(getRecognitionConstructor()),
    retryableErrors: Object.freeze([...RETRYABLE_ERRORS])
  };
})();
