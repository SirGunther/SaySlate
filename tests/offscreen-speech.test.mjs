import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(extensionRoot, "offscreenSpeech.js"), "utf8");
const listeners = [];
const sent = [];
let speechOptions = null;
const controller = {
  supported: true,
  start() { return true; },
  async stop() {
    speechOptions.onSessionEnd({ explicit: true, retrying: false });
    speechOptions.onStop();
  },
  cancel() {}
};
const chrome = {
  runtime: {
    onMessage: { addListener(listener) { listeners.push(listener); } },
    async sendMessage(message) {
      sent.push(message);
      return { ok: true };
    }
  }
};
// Minimal stand-ins for the WSI-01/WSI-02 globals offscreenSpeech.js's Local Whisper path
// consumes. Each `record`/`instance` exposes test-side hooks (onEvent, emitChunk, ...) to
// drive the fake exactly the way the real dependency's own async lifecycle would.
function createFakeWhisperClient() {
  const sessions = [];
  let nextConnectError = null;
  return {
    async connectSession(descriptor, { onEvent, onClientError, cancelHttp }) {
      if (nextConnectError) {
        const error = nextConnectError;
        nextConnectError = null;
        // Mirrors whisperServiceClient.js's real failConnect(): release the HTTP session
        // before rejecting, so the glue that lets only background.js (the token holder)
        // perform that release is actually exercised end-to-end, not just unit-tested.
        await cancelHttp().catch(() => {});
        throw error;
      }
      const record = { descriptor, onEvent, onClientError, cancelHttp, state: "ready" };
      const whisperController = {
        sessionId: descriptor.sessionId,
        get state() {
          return record.state;
        },
        sentPcm: [],
        sendPcm16(bytes) {
          whisperController.sentPcm.push(bytes);
        },
        flush() {},
        stop() {
          if (record.state === "closed") return Promise.resolve({ ok: true, reason: "already-closed" });
          if (!record.stopPromise) {
            record.state = "stopping";
            record.stopPromise = new Promise((resolve) => {
              record.resolveStop = (outcome) => {
                record.state = "closed";
                resolve(outcome);
              };
            });
          }
          return record.stopPromise;
        },
        cancel() {
          if (record.state === "closed") return Promise.resolve({ ok: true, reason: "already-closed" });
          if (!record.cancelPromise) {
            record.state = "cancelling";
            record.cancelPromise = new Promise((resolve) => {
              record.resolveCancel = (outcome) => {
                record.state = "closed";
                resolve(outcome);
              };
            });
          }
          return record.cancelPromise;
        },
        close() {
          record.state = "closed";
        }
      };
      record.controller = whisperController;
      sessions.push(record);
      return whisperController;
    },
    __sessions: sessions,
    __failNextConnect(error) {
      nextConnectError = error;
    }
  };
}

function createFakeMicCapture() {
  const instances = [];
  let nextStartResult = true;
  return {
    create(options) {
      const instance = {
        options,
        cancelled: false,
        stopped: false,
        emitChunk: (bytes) => options.onChunk(bytes),
        emitError: (error) => options.onError(error),
        async start() {
          return nextStartResult;
        },
        // Mirrors micCapture.js's real stop(): asynchronous, gated on an external
        // acknowledgment (there, the worklet's "stopped" message) rather than resolving on
        // the next microtask regardless of anything else - so a test can actually prove a
        // caller awaited this rather than firing-and-forgetting it.
        stop() {
          instance.stopped = true;
          if (!instance._stopPromise) {
            instance._stopPromise = new Promise((resolve) => {
              instance._resolveStop = resolve;
            });
          }
          return instance._stopPromise;
        },
        cancel() {
          instance.cancelled = true;
        }
      };
      instances.push(instance);
      return instance;
    },
    __instances: instances,
    __setNextStartResult(value) {
      nextStartResult = value;
    }
  };
}

const whisperClient = createFakeWhisperClient();
const micCapture = createFakeMicCapture();

const pageLifecycleListeners = [];
const fakeSelf = {
  addEventListener(type, listener) {
    if (type === "pagehide") pageLifecycleListeners.push(listener);
  }
};

const context = vm.createContext({
  chrome,
  setInterval,
  clearInterval,
  self: fakeSelf,
  SaySlateSpeech: {
    create(options) {
      speechOptions = options;
      return controller;
    }
  },
  SaySlateWhisperClient: whisperClient,
  SaySlateMicCapture: micCapture
});
vm.runInContext(source, context);
const plain = (value) => JSON.parse(JSON.stringify(value));

function dispatch(message) {
  return new Promise((resolve, reject) => {
    const handled = listeners[0](message, {}, resolve);
    if (handled !== true) reject(new Error("Offscreen speech control was not handled."));
  });
}

// offscreenSpeech.js registers a second, independent onMessage listener for Local Whisper
// control, so every listener is tried (mirroring how Chrome dispatches to all of them) and
// only the one that actually calls sendResponse is expected to report itself handled.
function dispatchLocalWhisper(message) {
  return new Promise((resolve, reject) => {
    const handled = listeners.some((listener) => listener(message, {}, resolve) === true);
    if (!handled) reject(new Error("Local Whisper control was not handled."));
  });
}

function lastWhisperSession() {
  return whisperClient.__sessions.at(-1);
}

function lastMicCapture() {
  return micCapture.__instances.at(-1);
}

assert.deepEqual(
  plain(await dispatch({
    type: "sayslate-offscreen-speech-control",
    target: "offscreen",
    sessionId: "session-1",
    action: "start"
  })),
  { ok: true }
);

const finalResult = [{ transcript: "final words" }];
finalResult.isFinal = true;
const interimResult = [{ transcript: "still speaking" }];
interimResult.isFinal = false;
speechOptions.onResult({ results: [finalResult, interimResult] });
await Promise.resolve();
const resultEvent = sent.find((message) => message.event === "result");
assert.equal(resultEvent.sessionId, "session-1");
assert.deepEqual(plain(resultEvent.payload), { finalText: "final words", interimText: "still speaking" });

assert.deepEqual(
  plain(await dispatch({
    type: "sayslate-offscreen-speech-control",
    target: "offscreen",
    sessionId: "session-1",
    action: "stop"
  })),
  { ok: true, sessionEnd: { explicit: true, retrying: false } }
);
assert.equal(sent.some((message) => message.event === "stop"), false);

// ---- WSI-04: Local Whisper shared offscreen host ----

{
  // Successful start connects the service session, starts the microphone, and streams
  // captured PCM into the session as soon as it arrives.
  const response = await dispatchLocalWhisper({
    type: "sayslate-offscreen-local-whisper-control",
    target: "offscreen",
    origin: "full-page",
    sessionId: "run-1",
    action: "start",
    sessionDescriptor: { version: "1.0.0", sessionId: "service-session-1" }
  });
  assert.deepEqual(plain(response), { ok: true });
  lastMicCapture().emitChunk(new Uint8Array([1, 2]));
  assert.deepEqual(Array.from(lastWhisperSession().controller.sentPcm[0]), [1, 2]);
}

{
  // A second start while one run is active is rejected as busy, and the original keeps working.
  const response = await dispatchLocalWhisper({
    type: "sayslate-offscreen-local-whisper-control",
    target: "offscreen",
    origin: "floating",
    sessionId: "run-2",
    action: "start",
    sessionDescriptor: { version: "1.0.0", sessionId: "service-session-2" }
  });
  assert.deepEqual(plain(response), { ok: false, code: "busy", message: "Local Whisper is already active for another dictation run." });
  assert.equal(whisperClient.__sessions.length, 1);
  lastMicCapture().emitChunk(new Uint8Array([3]));
  assert.equal(lastWhisperSession().controller.sentPcm.length, 2);
}

{
  // Partial/final/empty events are normalized and routed back to the requesting origin;
  // a rollover final is forwarded like any other final and the run keeps going afterward.
  lastWhisperSession().onEvent({ type: "transcript.partial", sessionId: "service-session-1", utteranceId: "u1", revision: 1, text: "hel" });
  const partialEvent = sent.at(-1);
  assert.equal(partialEvent.type, "sayslate-offscreen-local-whisper-event");
  assert.equal(partialEvent.target, "full-page");
  assert.equal(partialEvent.sessionId, "run-1");
  assert.equal(partialEvent.event, "partial");
  assert.deepEqual(plain(partialEvent.payload), { utteranceId: "u1", revision: 1, text: "hel" });

  lastWhisperSession().onEvent({ type: "transcript.final", sessionId: "service-session-1", utteranceId: "u1", text: "hello", segments: [], finalizationReason: "rollover" });
  const finalEvent = sent.at(-1);
  assert.equal(finalEvent.event, "final");
  assert.deepEqual(plain(finalEvent.payload), { utteranceId: "u1", text: "hello", segments: [], finalizationReason: "rollover" });

  lastWhisperSession().onEvent({ type: "transcript.empty", sessionId: "service-session-1", utteranceId: "u2", finalizationReason: "pause" });
  const emptyEvent = sent.at(-1);
  assert.equal(emptyEvent.event, "empty");
  assert.deepEqual(plain(emptyEvent.payload), { utteranceId: "u2", finalizationReason: "pause" });

  lastMicCapture().emitChunk(new Uint8Array([9]));
  assert.equal(lastWhisperSession().controller.sentPcm.length, 3, "a rollover final must not end the run");
}

{
  // Stop waits for the microphone/worklet to flush its final PCM remainder before the
  // service stop control is even sent, and only resolves once that service session also
  // settles - not just whichever of the two settles first - then frees the shared slot.
  const stopPromise = dispatchLocalWhisper({
    type: "sayslate-offscreen-local-whisper-control",
    target: "offscreen",
    origin: "full-page",
    sessionId: "run-1",
    action: "stop"
  });
  let stopSettled = false;
  void stopPromise.then(() => {
    stopSettled = true;
  });
  await Promise.resolve();
  assert.equal(lastMicCapture().stopped, true);
  assert.equal(lastWhisperSession().state, "ready", "the service stop control must wait for the microphone to flush first");

  lastMicCapture()._resolveStop();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(lastWhisperSession().state, "stopping", "the microphone flush must complete before the service stop control is sent");
  assert.equal(stopSettled, false, "stop must not resolve until the service session also settles");

  lastWhisperSession().resolveStop({ ok: true, reason: "session-closed" });
  assert.deepEqual(plain(await stopPromise), { ok: true, reason: "session-closed" });
  assert.equal(stopSettled, true);

  const response = await dispatchLocalWhisper({
    type: "sayslate-offscreen-local-whisper-control",
    target: "offscreen",
    origin: "floating",
    sessionId: "run-3",
    action: "start",
    sessionDescriptor: { version: "1.0.0", sessionId: "service-session-3" }
  });
  assert.deepEqual(plain(response), { ok: true });
}

{
  // Cancel cancels both the microphone and the service session and settles cleanly; no
  // additional transcript event is emitted beyond what the earlier run already produced.
  const cancelPromise = dispatchLocalWhisper({
    type: "sayslate-offscreen-local-whisper-control",
    target: "offscreen",
    origin: "floating",
    sessionId: "run-3",
    action: "cancel"
  });
  await Promise.resolve();
  assert.equal(lastMicCapture().cancelled, true);
  assert.equal(lastWhisperSession().state, "cancelling");
  lastWhisperSession().resolveCancel({ ok: true, reason: "session-closed" });
  assert.deepEqual(plain(await cancelPromise), { ok: true });
  assert.equal(sent.filter((message) => message.event === "final" || message.event === "partial").length, 2, "cancel must not emit a transcript");
}

{
  // Duplicate/overlapping stop commands for the same run: only the first ever touches the
  // controller/mic capture and resolves with the real outcome; a second, racing stop (or a
  // cancel racing the same stop) is a no-op reporting inactive instead of a second concurrent
  // call corrupting the same in-flight settlement.
  await dispatchLocalWhisper({
    type: "sayslate-offscreen-local-whisper-control",
    target: "offscreen",
    origin: "full-page",
    sessionId: "run-4",
    action: "start",
    sessionDescriptor: { version: "1.0.0", sessionId: "service-session-4" }
  });
  const first = dispatchLocalWhisper({ type: "sayslate-offscreen-local-whisper-control", target: "offscreen", origin: "full-page", sessionId: "run-4", action: "stop" });
  const second = dispatchLocalWhisper({ type: "sayslate-offscreen-local-whisper-control", target: "offscreen", origin: "full-page", sessionId: "run-4", action: "stop" });
  const third = dispatchLocalWhisper({ type: "sayslate-offscreen-local-whisper-control", target: "offscreen", origin: "full-page", sessionId: "run-4", action: "cancel" });
  assert.deepEqual(plain(await second), { ok: true, inactive: true });
  assert.deepEqual(plain(await third), { ok: true, inactive: true });
  lastMicCapture()._resolveStop();
  await Promise.resolve();
  await Promise.resolve();
  lastWhisperSession().resolveStop({ ok: true, reason: "session-closed" });
  assert.deepEqual(plain(await first), { ok: true, reason: "session-closed" });
}

{
  // An unprompted session.closed (e.g. an idle timeout on the service side, with no stop
  // or cancel ever requested) tears the run down and reports failure explicitly, and
  // frees the slot so a following start is accepted rather than rejected as busy.
  await dispatchLocalWhisper({
    type: "sayslate-offscreen-local-whisper-control",
    target: "offscreen",
    origin: "full-page",
    sessionId: "run-5",
    action: "start",
    sessionDescriptor: { version: "1.0.0", sessionId: "service-session-5" }
  });
  lastWhisperSession().onEvent({ type: "session.closed", sessionId: "service-session-5", reason: "idle-timeout" });
  const errorEvent = sent.at(-1);
  assert.equal(errorEvent.event, "error");
  assert.equal(errorEvent.sessionId, "run-5");

  const response = await dispatchLocalWhisper({
    type: "sayslate-offscreen-local-whisper-control",
    target: "offscreen",
    origin: "full-page",
    sessionId: "run-6",
    action: "start",
    sessionDescriptor: { version: "1.0.0", sessionId: "service-session-6" }
  });
  assert.deepEqual(plain(response), { ok: true }, "the slot must be free after an unprompted close");
}

{
  // A microphone error tears the run down the same way and never leaks into a later run.
  lastMicCapture().emitError({ code: "permission-denied", message: "Microphone permission was denied." });
  const errorEvent = sent.at(-1);
  assert.equal(errorEvent.event, "error");
  assert.deepEqual(plain(errorEvent.payload), { code: "permission-denied", message: "Microphone permission was denied." });
  assert.equal(lastWhisperSession().state, "closed");
}

{
  // A live stream-level "error" with nothing already stopping/cancelling is fatal on its
  // own - this is the WSI-04 "provider error" cleanup trigger - and must tear the run down
  // and report explicitly, exactly like the disconnect/mic-error paths above.
  await dispatchLocalWhisper({
    type: "sayslate-offscreen-local-whisper-control",
    target: "offscreen",
    origin: "full-page",
    sessionId: "run-6-provider-error",
    action: "start",
    sessionDescriptor: { version: "1.0.0", sessionId: "service-session-6-provider-error" }
  });
  lastWhisperSession().onEvent({ type: "error", code: "WORKER_CRASHED", message: "the inference worker crashed", category: "worker" });
  const errorEvent = sent.at(-1);
  assert.equal(errorEvent.event, "error");
  assert.equal(errorEvent.sessionId, "run-6-provider-error");
  assert.deepEqual(plain(errorEvent.payload), { code: "worker", message: "the inference worker crashed" });
  assert.equal(lastWhisperSession().state, "closed");
}

{
  // If the microphone itself fails to start, the just-created service session is released
  // instead of being left connected with nothing ever feeding it audio.
  micCapture.__setNextStartResult(false);
  const response = await dispatchLocalWhisper({
    type: "sayslate-offscreen-local-whisper-control",
    target: "offscreen",
    origin: "full-page",
    sessionId: "run-7",
    action: "start",
    sessionDescriptor: { version: "1.0.0", sessionId: "service-session-7" }
  });
  assert.deepEqual(plain(response), { ok: false, code: "client", message: "The microphone could not be started for Local Whisper." });
  assert.equal(lastWhisperSession().state, "closed");
  micCapture.__setNextStartResult(true);
}

{
  // A connect failure (e.g. an invalid or expired ticket) never starts the microphone, and
  // asks background.js (the only holder of the bearer token) to release the now-orphaned
  // HTTP session - proving the actual glue closure inside startLocalWhisper fires, not just
  // that a connect failure is reported.
  whisperClient.__failNextConnect(new Error("WhisperService returned HTTP 401."));
  const micInstancesBefore = micCapture.__instances.length;
  const sentBefore = sent.length;
  const response = await dispatchLocalWhisper({
    type: "sayslate-offscreen-local-whisper-control",
    target: "offscreen",
    origin: "full-page",
    sessionId: "run-8",
    action: "start",
    sessionDescriptor: { version: "1.0.0", sessionId: "service-session-8" }
  });
  assert.equal(response.ok, false);
  assert.equal(response.message, "WhisperService returned HTTP 401.");
  assert.equal(micCapture.__instances.length, micInstancesBefore);
  assert.deepEqual(plain(sent[sentBefore]), { type: "sayslate-local-whisper-cancel-session-http", sessionId: "service-session-8" });
}

{
  // An abrupt disconnect (the transport closing with no preceding session.closed message,
  // e.g. the service process dying) is still noticed - through the bounded watchdog - and
  // reported, rather than leaving the caller waiting forever.
  await dispatchLocalWhisper({
    type: "sayslate-offscreen-local-whisper-control",
    target: "offscreen",
    origin: "full-page",
    sessionId: "run-9",
    action: "start",
    sessionDescriptor: { version: "1.0.0", sessionId: "service-session-9" }
  });
  lastWhisperSession().state = "closed";
  await new Promise((resolve) => setTimeout(resolve, 400));
  const errorEvent = sent.at(-1);
  assert.equal(errorEvent.event, "error");
  assert.equal(errorEvent.sessionId, "run-9");
  assert.equal(errorEvent.payload.code, "disconnected");
}

{
  // A stream-level "error" arriving while a deliberate stop is already settling must not
  // pre-empt that settlement (force-closing the session and dropping whatever final/empty
  // was still pending) - it is only fatal when nothing is already stopping/cancelling.
  await dispatchLocalWhisper({
    type: "sayslate-offscreen-local-whisper-control",
    target: "offscreen",
    origin: "full-page",
    sessionId: "run-10",
    action: "start",
    sessionDescriptor: { version: "1.0.0", sessionId: "service-session-10" }
  });
  const stopPromise = dispatchLocalWhisper({
    type: "sayslate-offscreen-local-whisper-control",
    target: "offscreen",
    origin: "full-page",
    sessionId: "run-10",
    action: "stop"
  });
  await Promise.resolve();
  // An error for an unrelated/already-lost utterance, exactly as whisperServiceClient.js's
  // own comments describe can happen during a stop's settlement window.
  lastWhisperSession().onEvent({ type: "error", code: "WORKER_TIMEOUT", message: "an unrelated utterance failed", category: "worker" });
  assert.notEqual(lastWhisperSession().state, "closed", "an error during an in-flight stop must not force-close the session");

  // The final that was actually pending when stop was requested must still be delivered.
  lastWhisperSession().onEvent({ type: "transcript.final", sessionId: "service-session-10", utteranceId: "u10", text: "done", segments: [], finalizationReason: "stop" });
  assert.equal(sent.at(-1).event, "final", "a transcript.final during the stop's settlement window must not be dropped");

  // The stop settles through its own real outcome, not a forced "closed-locally" outcome.
  lastMicCapture()._resolveStop();
  await Promise.resolve();
  await Promise.resolve();
  lastWhisperSession().resolveStop({ ok: true, reason: "session-closed" });
  assert.deepEqual(plain(await stopPromise), { ok: true, reason: "session-closed" });
}

{
  // A benign client diagnostic (a stale partial revision, already suppressed and handled
  // safely inside WSI-01) must not tear the run down; a genuinely fatal protocol violation
  // (e.g. an envelope for the wrong session) must.
  await dispatchLocalWhisper({
    type: "sayslate-offscreen-local-whisper-control",
    target: "offscreen",
    origin: "full-page",
    sessionId: "run-11",
    action: "start",
    sessionDescriptor: { version: "1.0.0", sessionId: "service-session-11" }
  });
  lastWhisperSession().onClientError({ reason: "stale-partial-revision", sessionId: "service-session-11" });
  assert.notEqual(lastWhisperSession().state, "closed", "a benign diagnostic must not tear the run down");

  lastWhisperSession().onClientError({ reason: "wrong-session", sessionId: "service-session-11" });
  assert.equal(lastWhisperSession().state, "closed");
  const errorEvent = sent.at(-1);
  assert.equal(errorEvent.event, "error");
  assert.equal(errorEvent.sessionId, "run-11");
  assert.equal(errorEvent.payload.code, "malformed-response");
}

{
  // An offscreen-document teardown or extension shutdown (both fire "pagehide" on this
  // document) cleans up whatever Local Whisper run is currently active rather than leaving
  // the microphone/session dangling with no failure ever reported.
  await dispatchLocalWhisper({
    type: "sayslate-offscreen-local-whisper-control",
    target: "offscreen",
    origin: "full-page",
    sessionId: "run-12",
    action: "start",
    sessionDescriptor: { version: "1.0.0", sessionId: "service-session-12" }
  });
  assert.equal(pageLifecycleListeners.length, 1);
  pageLifecycleListeners.forEach((listener) => listener());
  const errorEvent = sent.at(-1);
  assert.equal(errorEvent.event, "error");
  assert.equal(errorEvent.sessionId, "run-12");
  assert.equal(lastWhisperSession().state, "closed");
  assert.equal(lastMicCapture().cancelled, true);
}

{
  // WSI-08: duplicate transcript.final/transcript.empty events for the same utterance ID
  // must be committed at most once, and a partial arriving late for an already-finalized
  // utterance must remain suppressed (the finalizedUtteranceIds guard in
  // handleLocalWhisperControllerEvent).
  await dispatchLocalWhisper({
    type: "sayslate-offscreen-local-whisper-control",
    target: "offscreen",
    origin: "full-page",
    sessionId: "run-13",
    action: "start",
    sessionDescriptor: { version: "1.0.0", sessionId: "service-session-13" }
  });

  lastWhisperSession().onEvent({ type: "transcript.final", sessionId: "service-session-13", utteranceId: "u13", text: "first pass", segments: [], finalizationReason: "pause" });
  assert.equal(sent.at(-1).event, "final");
  assert.equal(sent.at(-1).payload.text, "first pass");
  const sentCountAfterFirstFinal = sent.length;

  // A duplicate final for the same utterance ID must not be committed a second time.
  lastWhisperSession().onEvent({ type: "transcript.final", sessionId: "service-session-13", utteranceId: "u13", text: "duplicate", segments: [], finalizationReason: "pause" });
  assert.equal(sent.length, sentCountAfterFirstFinal, "a duplicate transcript.final for the same utterance must not be committed again");

  // A partial arriving late for an already-finalized utterance stays suppressed.
  lastWhisperSession().onEvent({ type: "transcript.partial", sessionId: "service-session-13", utteranceId: "u13", revision: 99, text: "late partial" });
  assert.equal(sent.length, sentCountAfterFirstFinal, "a partial for an already-finalized utterance must remain suppressed");

  // A transcript.empty for that same finalized utterance is likewise suppressed.
  lastWhisperSession().onEvent({ type: "transcript.empty", sessionId: "service-session-13", utteranceId: "u13", finalizationReason: "pause" });
  assert.equal(sent.length, sentCountAfterFirstFinal, "a transcript.empty for an already-finalized utterance must remain suppressed");

  // A different utterance's own empty commits once...
  lastWhisperSession().onEvent({ type: "transcript.empty", sessionId: "service-session-13", utteranceId: "u13-empty", finalizationReason: "pause" });
  assert.equal(sent.at(-1).event, "empty");
  const sentCountAfterEmpty = sent.length;

  // ...and a duplicate transcript.empty for that same utterance is likewise not committed twice.
  lastWhisperSession().onEvent({ type: "transcript.empty", sessionId: "service-session-13", utteranceId: "u13-empty", finalizationReason: "pause" });
  assert.equal(sent.length, sentCountAfterEmpty, "a duplicate transcript.empty for the same utterance must not be committed again");

  const cancelPromise = dispatchLocalWhisper({
    type: "sayslate-offscreen-local-whisper-control",
    target: "offscreen",
    origin: "full-page",
    sessionId: "run-13",
    action: "cancel"
  });
  await Promise.resolve();
  lastWhisperSession().resolveCancel({ ok: true, reason: "session-closed" });
  await cancelPromise;
}

{
  // WSI-08: an event delivered through an OLD, already-torn-down session's own onEvent
  // callback (a stale message arriving after that session's controller was closed) must
  // never leak into a newer run. Each session's onEvent is bound by closure to the specific
  // session object it was created for in startLocalWhisper, so this proves that isolation
  // actually holds at runtime rather than only being true by construction.
  const staleSession = lastWhisperSession(); // run-13, already torn down by the cancel above
  assert.equal(staleSession.controller.sessionId, "service-session-13");

  await dispatchLocalWhisper({
    type: "sayslate-offscreen-local-whisper-control",
    target: "offscreen",
    origin: "full-page",
    sessionId: "run-14",
    action: "start",
    sessionDescriptor: { version: "1.0.0", sessionId: "service-session-14" }
  });
  const sentCountAfterRun14Start = sent.length;

  // A transcript.final delivered through the stale run-13 session's own callback must be
  // dropped outright by its `torndown` guard, not attributed to the now-active run-14.
  staleSession.onEvent({ type: "transcript.final", sessionId: "service-session-13", utteranceId: "u13-stale", text: "should never appear", segments: [], finalizationReason: "pause" });
  assert.equal(sent.length, sentCountAfterRun14Start, "an event from a torn-down prior session must never be delivered to any origin");

  // run-14's own, live session still works normally afterward - the stale delivery above
  // did not corrupt or short-circuit it.
  lastWhisperSession().onEvent({ type: "transcript.final", sessionId: "service-session-14", utteranceId: "u14", text: "run 14 words", segments: [], finalizationReason: "pause" });
  const liveEvent = sent.at(-1);
  assert.equal(liveEvent.sessionId, "run-14");
  assert.equal(liveEvent.event, "final");
  assert.equal(liveEvent.payload.text, "run 14 words");

  const cancelPromise = dispatchLocalWhisper({
    type: "sayslate-offscreen-local-whisper-control",
    target: "offscreen",
    origin: "full-page",
    sessionId: "run-14",
    action: "cancel"
  });
  await Promise.resolve();
  lastWhisperSession().resolveCancel({ ok: true, reason: "session-closed" });
  await cancelPromise;
}

console.log("Local Whisper start/stop/cancel routing, event normalization, and cleanup verified.");
console.log("Offscreen speech control, transcript serialization, event routing, and explicit stop verified.");
console.log("Duplicate transcript.final/transcript.empty suppression regression coverage verified.");
console.log("Stale prior-session event isolation regression coverage verified.");
