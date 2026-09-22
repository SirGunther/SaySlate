(() => {
  "use strict";

  let activeSessionId = "";
  let speech = null;
  let stopCommandPending = false;
  let pendingExplicitSessionEnd = null;

  function sendEvent(sessionId, event, payload = {}) {
    void chrome.runtime.sendMessage({
      type: "sayslate-offscreen-speech-event",
      target: "floating",
      sessionId,
      event,
      payload
    }).catch(() => {
      // The floating session may have closed while recognition was stopping.
    });
  }

  function recognitionText(event) {
    const finalized = [];
    const interim = [];
    for (let index = 0; index < event.results.length; index += 1) {
      const phrase = event.results[index][0]?.transcript || "";
      if (event.results[index].isFinal) finalized.push(phrase);
      else interim.push(phrase);
    }
    return { finalText: finalized.join(" "), interimText: interim.join(" ") };
  }

  function configure(sessionId) {
    activeSessionId = sessionId;
    speech = globalThis.SaySlateSpeech.create({
      onStart(payload) {
        sendEvent(sessionId, "start", payload);
      },
      onResult(event) {
        sendEvent(sessionId, "result", recognitionText(event));
      },
      onSessionEnd(payload) {
        if (stopCommandPending && payload?.explicit) pendingExplicitSessionEnd = payload;
        else sendEvent(sessionId, "session-end", payload);
      },
      onRetry(payload) {
        sendEvent(sessionId, "retry", payload);
      },
      onFatalError(error) {
        sendEvent(sessionId, "fatal-error", { error });
      },
      onStop() {
        if (!stopCommandPending) sendEvent(sessionId, "stop");
        if (activeSessionId === sessionId) activeSessionId = "";
      }
    });
  }

  async function handleControl(message) {
    if (!message.sessionId) return { ok: false, message: "A floating speech session is required." };

    if (message.action === "start") {
      if (speech && activeSessionId && activeSessionId !== message.sessionId) speech.cancel();
      if (!speech || activeSessionId !== message.sessionId) configure(message.sessionId);
      if (!speech.supported) return { ok: false, message: "Speech recognition is unavailable in the extension speech service." };
      return { ok: speech.start() !== false };
    }

    if (message.sessionId !== activeSessionId || !speech) return { ok: true, inactive: true };
    if (message.action === "stop") {
      stopCommandPending = true;
      pendingExplicitSessionEnd = null;
      try {
        await speech.stop();
        return { ok: true, sessionEnd: pendingExplicitSessionEnd };
      } finally {
        stopCommandPending = false;
        pendingExplicitSessionEnd = null;
      }
    }
    if (message.action === "cancel") {
      speech.cancel();
      return { ok: true };
    }
    return { ok: false, message: "Unknown speech command." };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "sayslate-offscreen-speech-control" || message.target !== "offscreen") return;
    void handleControl(message)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, message: error?.message || "Speech control failed." }));
    return true;
  });

  // ---- Local Whisper (WSI-04): single shared offscreen host for both SaySlate surfaces ----
  //
  // Only one Local Whisper dictation run exists at a time (one microphone, one offscreen
  // document, shared by the full page and Floating Slate): `localWhisperSession` is a
  // single slot rather than a map, and a start while it is occupied is rejected outright.

  // Bounds how quickly an abrupt disconnect (the transport closing with no preceding
  // session.closed protocol message - e.g. the service process dying) is noticed. The
  // WSI-01 client only pushes an event for a *reported* close, so this is the fallback
  // that still reports failure instead of leaving a caller waiting forever.
  const LOCAL_WHISPER_DISCONNECT_POLL_MS = 250;

  let localWhisperSession = null;

  function sendLocalWhisperEvent(origin, sessionId, event, payload = {}) {
    void chrome.runtime
      .sendMessage({ type: "sayslate-offscreen-local-whisper-event", target: origin, sessionId, event, payload })
      .catch(() => {
        // The requesting page may have closed while an event was in flight.
      });
  }

  function stopLocalWhisperWatchdog(session) {
    if (session.watchdogTimer === null) return;
    clearInterval(session.watchdogTimer);
    session.watchdogTimer = null;
  }

  function startLocalWhisperWatchdog(session) {
    session.watchdogTimer = setInterval(() => {
      if (session.controller?.state === "closed") teardownLocalWhisperSession(session, "disconnected", "The WhisperService connection was lost.");
    }, LOCAL_WHISPER_DISCONNECT_POLL_MS);
  }

  // Releases whatever this session actually acquired and frees the shared slot (only if
  // it still points at this session - a concurrent stop/cancel may already have moved on).
  // A deliberate stop/cancel reports its own outcome through its RPC response, so this only
  // pushes an explicit failure event when neither was requested - an unprompted failure.
  function teardownLocalWhisperSession(session, notifyCode, notifyMessage) {
    if (session.torndown) return;
    session.torndown = true;
    stopLocalWhisperWatchdog(session);
    try {
      session.micCapture?.cancel();
    } catch {
      // Nothing further to release locally.
    }
    try {
      session.controller?.close();
    } catch {
      // Socket may already be closed.
    }
    session.finalizedUtteranceIds?.clear();
    if (localWhisperSession === session) localWhisperSession = null;
    if (notifyCode && !session.stopRequested && !session.cancelRequested) {
      sendLocalWhisperEvent(session.origin, session.sessionId, "error", { code: notifyCode, message: notifyMessage });
    }
  }

  // A stream-level "error" event does not, by itself, end a WhisperService session (the
  // protocol only ends a session via session.closed), and it can legitimately arrive for
  // an already-superseded utterance during a stop's own settlement window (see
  // whisperServiceClient.js's handling of this exact case). So - like the session.closed
  // branch below - this must not pre-empt a deliberate stop/cancel already in flight: that
  // settlement (bounded by its own timeout) is left to finish and report its own outcome,
  // rather than being force-closed here and silently dropping a still-pending final/empty.
  function handleLocalWhisperControllerEvent(session, event) {
    if (session.torndown) return;
    if (event.type === "transcript.partial") {
      if (session.finalizedUtteranceIds.has(event.utteranceId)) return;
      sendLocalWhisperEvent(session.origin, session.sessionId, "partial", { utteranceId: event.utteranceId, revision: event.revision, text: event.text });
    } else if (event.type === "transcript.final") {
      if (session.finalizedUtteranceIds.has(event.utteranceId)) return;
      session.finalizedUtteranceIds.add(event.utteranceId);
      sendLocalWhisperEvent(session.origin, session.sessionId, "final", {
        utteranceId: event.utteranceId,
        text: event.text,
        segments: event.segments,
        finalizationReason: event.finalizationReason
      });
    } else if (event.type === "transcript.empty") {
      if (session.finalizedUtteranceIds.has(event.utteranceId)) return;
      session.finalizedUtteranceIds.add(event.utteranceId);
      sendLocalWhisperEvent(session.origin, session.sessionId, "empty", { utteranceId: event.utteranceId, finalizationReason: event.finalizationReason });
    } else if (event.type === "error" && !session.stopRequested && !session.cancelRequested) {
      teardownLocalWhisperSession(session, event.category || "unavailable", event.message);
    } else if (event.type === "session.closed" && !session.stopRequested && !session.cancelRequested) {
      // An unprompted server-side close (e.g. an idle timeout). A requested stop/cancel
      // settles and reports through its own RPC response instead of this push channel.
      teardownLocalWhisperSession(session, "disconnected", "The WhisperService session closed unexpectedly.");
    }
  }

  // Malformed/unexpected envelopes are mostly already handled safely inside the WSI-01
  // client (e.g. a stale partial revision is expected, benign, and silently suppressed
  // there); only the genuinely fatal protocol violations below - which mean the stream can
  // no longer be trusted - actually tear the run down here, and (like the branches above)
  // never pre-empt a stop/cancel already in flight.
  const FATAL_CLIENT_ERROR_REASONS = new Set(["malformed-envelope", "unknown-protocol-version", "unknown-event-type", "wrong-session"]);

  function handleLocalWhisperClientError(session, diagnostic) {
    if (session.torndown || session.stopRequested || session.cancelRequested) return;
    if (!FATAL_CLIENT_ERROR_REASONS.has(diagnostic?.reason)) return;
    teardownLocalWhisperSession(session, "malformed-response", "The WhisperService connection sent unexpected data.");
  }

  function handleMicCaptureChunk(session, bytes) {
    if (session.torndown || session.controller?.state !== "ready") return;
    try {
      session.controller.sendPcm16(bytes);
    } catch {
      // A frame arriving right at teardown is dropped rather than crashing the pipeline.
    }
  }

  function handleMicCaptureError(session, error) {
    if (session.torndown || session.stopRequested || session.cancelRequested) return;
    teardownLocalWhisperSession(session, error.code, error.message);
  }

  async function startLocalWhisper(origin, sessionId, sessionDescriptor) {
    if (localWhisperSession) return { ok: false, code: "busy", message: "Local Whisper is already active for another dictation run." };

    const session = {
      origin,
      sessionId,
      torndown: false,
      stopRequested: false,
      cancelRequested: false,
      controller: null,
      micCapture: null,
      watchdogTimer: null,
      finalizedUtteranceIds: new Set()
    };
    localWhisperSession = session;

    let controller;
    try {
      controller = await globalThis.SaySlateWhisperClient.connectSession(sessionDescriptor, {
        onEvent: (event) => handleLocalWhisperControllerEvent(session, event),
        onClientError: (diagnostic) => handleLocalWhisperClientError(session, diagnostic),
        cancelHttp: () =>
          chrome.runtime.sendMessage({ type: "sayslate-local-whisper-cancel-session-http", sessionId: sessionDescriptor.sessionId }).catch(() => {})
      });
    } catch (error) {
      if (localWhisperSession === session) localWhisperSession = null;
      return { ok: false, code: error.category || "unavailable", message: error.message };
    }

    if (session.torndown) {
      // Cancelled/stopped while connecting: nothing was ever exposed to a caller, so
      // release the now-ready socket instead of continuing on to microphone capture.
      try {
        controller.close();
      } catch {
        // Already closed.
      }
      return { ok: true, inactive: true };
    }
    session.controller = controller;

    const micCapture = globalThis.SaySlateMicCapture.create({
      onChunk: (bytes) => handleMicCaptureChunk(session, bytes),
      onError: (error) => handleMicCaptureError(session, error)
    });
    session.micCapture = micCapture;

    const micStarted = await micCapture.start();
    if (session.torndown) return { ok: true, inactive: true };
    if (!micStarted) {
      teardownLocalWhisperSession(session, "client", "The microphone could not be started for Local Whisper.");
      return { ok: false, code: "client", message: "The microphone could not be started for Local Whisper." };
    }

    startLocalWhisperWatchdog(session);
    return { ok: true };
  }

  // A run's first stop/cancel is the only one that ever touches its controller/mic capture;
  // any later stop or cancel for the same run - including the OTHER action racing in while
  // the first is still settling - is a no-op that reports inactive rather than a second
  // concurrent call corrupting the same in-flight settlement (see teardownLocalWhisperSession
  // and the controller/mic-capture guards above for the matching half of this rule).
  async function stopLocalWhisper(origin, sessionId) {
    const session = localWhisperSession;
    if (!session || session.sessionId !== sessionId || session.origin !== origin || session.torndown || session.stopRequested || session.cancelRequested) {
      return { ok: true, inactive: true };
    }
    session.stopRequested = true;
    stopLocalWhisperWatchdog(session);
    if (!session.controller || !session.micCapture) {
      // Still connecting/starting the microphone: no utterance has started, so this
      // settles the same as a cancel - see the torndown checks in startLocalWhisper,
      // which release the in-flight controller/mic capture once they resolve.
      session.torndown = true;
      if (localWhisperSession === session) localWhisperSession = null;
      return { ok: true };
    }
    // Wait until the worklet has flushed its final PCM remainder while the controller is
    // still ready to accept audio, then ask the service to finalize the complete utterance.
    await session.micCapture.stop();
    const outcome = await session.controller.stop();
    session.torndown = true;
    if (localWhisperSession === session) localWhisperSession = null;
    return { ok: Boolean(outcome?.ok), reason: outcome?.reason };
  }

  async function cancelLocalWhisper(origin, sessionId) {
    const session = localWhisperSession;
    if (!session || session.sessionId !== sessionId || session.origin !== origin || session.torndown || session.stopRequested || session.cancelRequested) {
      return { ok: true, inactive: true };
    }
    session.cancelRequested = true;
    stopLocalWhisperWatchdog(session);
    if (!session.controller || !session.micCapture) {
      session.torndown = true;
      if (localWhisperSession === session) localWhisperSession = null;
      return { ok: true };
    }
    session.micCapture.cancel();
    await session.controller.cancel();
    session.torndown = true;
    if (localWhisperSession === session) localWhisperSession = null;
    return { ok: true };
  }

  async function handleLocalWhisperControl(message) {
    if (message.action === "start") return startLocalWhisper(message.origin, message.sessionId, message.sessionDescriptor);
    if (message.action === "stop") return stopLocalWhisper(message.origin, message.sessionId);
    if (message.action === "cancel") return cancelLocalWhisper(message.origin, message.sessionId);
    return { ok: false, message: "Unknown Local Whisper command." };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "sayslate-offscreen-local-whisper-control" || message.target !== "offscreen") return;
    void handleLocalWhisperControl(message)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, message: error?.message || "Local Whisper control failed." }));
    return true;
  });

  // Covers both an offscreen-document teardown and an extension shutdown/reload - either
  // one unloads this document the same way. Nothing here can be awaited (the page is
  // already going away), so this is a best-effort synchronous release of the microphone
  // and an explicit failure to whoever requested the run, rather than leaving it hanging.
  self.addEventListener("pagehide", () => {
    if (localWhisperSession) teardownLocalWhisperSession(localWhisperSession, "disconnected", "Local Whisper stopped because the speech service was shut down.");
  });
})();
