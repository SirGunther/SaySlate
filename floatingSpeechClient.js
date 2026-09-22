(() => {
  "use strict";

  // Mirrors dictationSettings.js's PROVIDERS values (WSI-03, out of this block's file
  // ownership). Only the raw string is needed here - reading the persisted provider choice,
  // never mutating it - so no direct dependency on that module's shape is required.
  const LOCAL_WHISPER_PROVIDER = "local-whisper";

  function currentProvider() {
    const snapshot = globalThis.SaySlateDictationSettings?.getSnapshot?.();
    return snapshot?.provider === LOCAL_WHISPER_PROVIDER ? LOCAL_WHISPER_PROVIDER : "browser";
  }

  function joinFinal(left, right) {
    const a = String(left || "").trim();
    const b = String(right || "").trim();
    if (!a) return b;
    if (!b) return a;
    return `${a} ${b}`;
  }

  // Local Whisper stop() only ever returns a bare {ok, reason} (see offscreenSpeech.js's
  // stopLocalWhisper) - never a message - so a failed settlement is mapped to friendly text
  // here rather than left as a raw protocol reason string.
  function localWhisperStopFailureMessage(reason) {
    const messages = {
      timeout: "Local Whisper did not confirm the dictation stopped in time. The captured text was kept.",
      disconnected: "The Local Whisper connection was lost while stopping. The captured text was kept.",
      "missing-final": "Local Whisper closed before confirming the last words. The captured text was kept.",
      "service-error": "Local Whisper reported an error while stopping. The captured text was kept.",
      "connect-failed": "Local Whisper could not finish connecting. The captured text was kept.",
      "closed-locally": "Local Whisper was closed before it confirmed stopping. The captured text was kept."
    };
    return messages[reason] || "Local Whisper did not confirm the dictation stopped cleanly. The captured text was kept.";
  }

  // Mirrors app.js's own isLocalWhisperStopSettled: {ok:true, inactive:true} means the
  // offscreen host had nothing to act on (its session was already gone/never existed) - it
  // is never a genuine settlement, whether the response came back from a start or a stop.
  function isLocalWhisperResponseSettled(response) {
    return response?.ok === true && !response.inactive;
  }

  function create(options = {}) {
    const sessionId = options.sessionId || "";
    let listening = false;
    let destroyed = false;
    // Captured once per run (at start()) so a provider changed mid-run in another tab can
    // never make this run's own stop()/cancel() address the wrong command channel.
    let activeProvider = "browser";
    // A fresh id per Local Whisper run (never the floating window's own fixed sessionId):
    // offscreenSpeech.js's single-slot session is keyed by whatever id is sent here, so
    // reusing the floating window's id across sequential runs would let a late event from
    // an earlier, already-ended run be accepted as if it belonged to the current one. A new
    // id per start() makes offscreenSpeech.js's own sessionId match already reject that.
    let localWhisperRunId = "";
    // Local Whisper only: partial is a replaceable preview keyed by utteranceId/revision
    // (already de-staled by whisperServiceClient.js/offscreenSpeech.js before it reaches
    // here); final is committed text, appended once per utterance.
    let localWhisperFinalText = "";
    let localWhisperInterimText = "";

    function emit(name, payload) {
      if (!destroyed) options[name]?.(payload);
    }

    function resetLocalWhisperAccumulation() {
      localWhisperFinalText = "";
      localWhisperInterimText = "";
    }

    function emitLocalWhisperResult() {
      emit("onResult", { finalText: localWhisperFinalText, interimText: localWhisperInterimText });
    }

    function handleLocalWhisperEvent(event, payload) {
      // A run that already ended (stopped, cancelled, or already fatally errored) must
      // never accept a further push event meant for a prior/superseded session.
      if (!listening) return;
      if (event === "partial") {
        localWhisperInterimText = payload.text || "";
        emitLocalWhisperResult();
        return;
      }
      if (event === "final") {
        localWhisperFinalText = joinFinal(localWhisperFinalText, payload.text);
        localWhisperInterimText = "";
        emitLocalWhisperResult();
        return;
      }
      if (event === "empty") {
        localWhisperInterimText = "";
        emitLocalWhisperResult();
        return;
      }
      if (event === "error") {
        // Unprompted (no stop/cancel was requested) - offscreenSpeech.js guarantees this
        // never fires while a stop/cancel is already in flight. Nothing will follow this
        // event on its own, so this settles the run itself: surface the failure, then
        // commit whatever was already captured and release the UI back to idle - in that
        // order, so onFatalError's copyAfterStop reset happens before onStop reads it.
        listening = false;
        emit("onFatalError", { code: payload.code || "unavailable", message: payload.message || "Local Whisper stopped unexpectedly." });
        emit("onSessionEnd", {});
        emit("onStop");
      }
    }

    function onMessage(message) {
      if (message?.type === "sayslate-offscreen-speech-event" && message.target === "floating" && message.sessionId === sessionId) {
        const payload = message.payload || {};
        if (message.event === "start") {
          listening = true;
          emit("onStart", payload);
        } else if (message.event === "result") emit("onResult", payload);
        else if (message.event === "session-end") emit("onSessionEnd", payload);
        else if (message.event === "retry") emit("onRetry", payload);
        else if (message.event === "fatal-error") {
          listening = false;
          emit("onFatalError", payload.error || "unknown");
        } else if (message.event === "stop") {
          const wasListening = listening;
          listening = false;
          if (wasListening) emit("onStop");
        }
        return;
      }
      if (
        message?.type === "sayslate-offscreen-local-whisper-event" && message.target === "floating" &&
        localWhisperRunId && message.sessionId === localWhisperRunId
      ) {
        handleLocalWhisperEvent(message.event, message.payload || {});
      }
    }

    chrome.runtime.onMessage.addListener(onMessage);

    async function command(action) {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "sayslate-floating-speech-command",
          sessionId,
          action
        });
        if (!response?.ok && action === "start") {
          listening = false;
          emit("onFatalError", "offscreen-unavailable");
        }
        return response;
      } catch {
        if (action === "start") {
          listening = false;
          emit("onFatalError", "offscreen-unavailable");
        }
        return { ok: false };
      }
    }

    async function sendLocalWhisperCommand(action, runId = localWhisperRunId) {
      try {
        return await chrome.runtime.sendMessage({
          type: "sayslate-local-whisper-command",
          origin: "floating",
          sessionId: runId,
          action
        });
      } catch {
        return { ok: false, code: "unavailable", message: "Local Whisper could not be reached." };
      }
    }

    async function startLocalWhisper(runId) {
      const response = await sendLocalWhisperCommand("start", runId);
      // {ok:true, inactive:true} means the offscreen host's own session for this run was
      // already gone by the time it looked (e.g. cancelled while still connecting) - never
      // a genuine start, so it must never resurrect the UI any more than a hard failure would.
      const started = isLocalWhisperResponseSettled(response);
      if (destroyed || !listening || runId !== localWhisperRunId) {
        // This start was cancelled/destroyed while in flight, or superseded by a newer
        // start() - either way the UI must not be resurrected by a late success. If the
        // offscreen host actually created a session for it, release it explicitly: an
        // earlier cancel() sent while this start was still pending had nothing to cancel
        // yet (offscreenSpeech.js had no session for this id), so without this the session
        // it just created would otherwise run unattended with nothing left to stop it.
        if (started) void sendLocalWhisperCommand("cancel", runId);
        return;
      }
      if (!started) {
        listening = false;
        // background.js/offscreenSpeech.js already carry a real, pre-redacted message for
        // every start failure (unauthorized, unavailable, forbidden origin, busy, ...) -
        // surface it directly rather than collapsing it to a generic code.
        emit("onFatalError", { code: response?.code || "unavailable", message: response?.message || "Local Whisper could not be started." });
        return;
      }
      emit("onStart", { recovered: false });
    }

    function start() {
      if (destroyed || !sessionId) return false;
      activeProvider = currentProvider();
      resetLocalWhisperAccumulation();
      listening = true;
      if (activeProvider === LOCAL_WHISPER_PROVIDER) {
        localWhisperRunId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        void startLocalWhisper(localWhisperRunId);
      } else {
        void command("start");
      }
      return true;
    }

    // Resolves { ok } so a caller (floating.js's Finish) can tell a settled stop from one
    // that never confirmed cleanly, and must not treat the latter as safe to proceed past -
    // see the non-negotiable "Finish waits for the definitive stop" rule this enforces.
    async function stop() {
      if (destroyed || !listening) return { ok: true };
      if (activeProvider === LOCAL_WHISPER_PROVIDER) {
        const response = await sendLocalWhisperCommand("stop");
        // {ok:true, inactive:true} means the offscreen host had no matching session left to
        // stop - it must never be treated as a clean settlement Finish is safe to proceed
        // past, the same as any other unclean outcome.
        const ok = isLocalWhisperResponseSettled(response);
        if (listening) {
          listening = false;
          // Never fall back to a generic message here: an unclean stop settlement still
          // means whatever was already transcribed must be preserved and reported, not lost
          // silently - matching the fatal-error-before-onStop ordering used above.
          if (!ok) emit("onFatalError", { code: "unavailable", message: localWhisperStopFailureMessage(response?.reason) });
          emit("onSessionEnd", {});
          emit("onStop");
        }
        return { ok };
      }
      const response = await command("stop");
      if (response?.sessionEnd) emit("onSessionEnd", response.sessionEnd);
      if (listening) {
        listening = false;
        emit("onStop");
      }
      return { ok: true };
    }

    function cancel() {
      if (destroyed) return;
      listening = false;
      if (activeProvider === LOCAL_WHISPER_PROVIDER) void sendLocalWhisperCommand("cancel");
      else void command("cancel");
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      chrome.runtime.onMessage.removeListener(onMessage);
    }

    return {
      start,
      stop,
      cancel,
      destroy,
      get supported() {
        return Boolean(sessionId && chrome.runtime?.sendMessage);
      },
      get listening() {
        return listening;
      }
    };
  }

  globalThis.SaySlateFloatingSpeech = Object.freeze({ create });
})();
