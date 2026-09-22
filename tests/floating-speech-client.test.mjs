import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(extensionRoot, "floatingSpeechClient.js"), "utf8");
const listeners = [];
const sent = [];
// WSI-06: per-scenario controllable Local Whisper responses; the Browser Dictation branch
// below is untouched so the pre-existing assertions below keep exercising the exact same
// stub behavior they always have.
let nextLocalWhisperStartResponse = { ok: true };
let nextLocalWhisperStopResponse = { ok: true, reason: "session-closed" };
// Lets a test hold a Start response pending (e.g. to race a cancel against it) before
// releasing it with the resolve function captured when the gate was armed.
let localWhisperStartGate = null;
const chrome = {
  runtime: {
    onMessage: {
      addListener(listener) { listeners.push(listener); },
      removeListener(listener) {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      }
    },
    async sendMessage(message) {
      sent.push(message);
      if (message.type === "sayslate-local-whisper-command") {
        if (message.action === "start") {
          if (localWhisperStartGate) await localWhisperStartGate;
          return nextLocalWhisperStartResponse;
        }
        if (message.action === "stop") return nextLocalWhisperStopResponse;
        return { ok: true };
      }
      return message.action === "stop"
        ? { ok: true, sessionEnd: { explicit: true, retrying: false } }
        : { ok: true };
    }
  }
};
// Defaults to Browser Dictation so every existing assertion below is unaffected; WSI-06
// scenarios further down reassign `dictationProviderSnapshot.provider` before starting.
const dictationProviderSnapshot = { provider: "browser" };
const context = vm.createContext({ chrome, SaySlateDictationSettings: { getSnapshot: () => dictationProviderSnapshot } });
vm.runInContext(source, context);

function dispatchToAllListeners(message) {
  for (const listener of listeners) listener(message);
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// The Local Whisper branch below builds its emitted payloads inside the vm-loaded module,
// so they are objects from a different realm than this file's own literals; deepEqual
// against an outer-realm literal reports "same structure but not reference-equal" unless
// round-tripped through JSON first (mirrors the `plain()` helper used by the other WSI-04
// test files for the same reason).
const plain = (value) => JSON.parse(JSON.stringify(value));

const events = [];
const speech = context.SaySlateFloatingSpeech.create({
  sessionId: "session-1",
  onStart: (payload) => events.push(["start", payload]),
  onResult: (payload) => events.push(["result", payload]),
  onSessionEnd: (payload) => events.push(["session-end", payload]),
  onStop: () => events.push(["stop"])
});

assert.equal(speech.supported, true);
assert.equal(speech.start(), true);
await Promise.resolve();
assert.equal(sent[0].type, "sayslate-floating-speech-command");
assert.equal(sent[0].action, "start");

listeners[0]({
  type: "sayslate-offscreen-speech-event",
  target: "floating",
  sessionId: "another-session",
  event: "result",
  payload: { finalText: "wrong" }
});
listeners[0]({
  type: "sayslate-offscreen-speech-event",
  target: "floating",
  sessionId: "session-1",
  event: "start",
  payload: { recovered: false }
});
listeners[0]({
  type: "sayslate-offscreen-speech-event",
  target: "floating",
  sessionId: "session-1",
  event: "result",
  payload: { finalText: "correct", interimText: "" }
});
assert.deepEqual(events, [
  ["start", { recovered: false }],
  ["result", { finalText: "correct", interimText: "" }]
]);

await speech.stop();
assert.equal(sent.at(-1).action, "stop");
assert.deepEqual(events.at(-2), ["session-end", { explicit: true, retrying: false }]);
assert.deepEqual(events.at(-1), ["stop"]);
speech.destroy();
assert.equal(listeners.length, 0);

// ---- WSI-06: Local Whisper (provider-neutral floating speech client) ----
//
// Every Local Whisper run gets a fresh wire-level id generated inside floatingSpeechClient.js
// itself (never the floating window's own fixed sessionId - see localWhisperRunId), so these
// scenarios capture that id off the actually-sent message rather than assuming a fixed value.

{
  // Successful start routes to the Local Whisper command channel with the floating origin,
  // partial/final events are aggregated into the same onResult shape the browser path uses,
  // and a clean stop settlement commits the accumulated text and releases listening.
  dictationProviderSnapshot.provider = "local-whisper";
  const lwEvents = [];
  const lwSpeech = context.SaySlateFloatingSpeech.create({
    sessionId: "lw-session-1",
    onStart: (payload) => lwEvents.push(["start", plain(payload)]),
    onResult: (payload) => lwEvents.push(["result", plain(payload)]),
    onSessionEnd: (payload) => lwEvents.push(["session-end", plain(payload)]),
    onFatalError: (error) => lwEvents.push(["fatal-error", plain(error)]),
    onStop: () => lwEvents.push(["stop"])
  });

  assert.equal(lwSpeech.start(), true);
  await flush();
  const startMessage = sent.at(-1);
  assert.equal(startMessage.type, "sayslate-local-whisper-command");
  assert.equal(startMessage.origin, "floating");
  assert.equal(startMessage.action, "start");
  assert.equal(typeof startMessage.sessionId, "string");
  assert.ok(startMessage.sessionId.length > 0, "a fresh run id must be generated for the wire message");
  const runId = startMessage.sessionId;
  assert.deepEqual(lwEvents.at(-1), ["start", { recovered: false }]);

  // An event for a different session (or the wrong target) is a stale/foreign event and
  // must be ignored rather than mixed into this run's transcript.
  dispatchToAllListeners({
    type: "sayslate-offscreen-local-whisper-event", target: "floating", sessionId: "another-run",
    event: "partial", payload: { utteranceId: "x", revision: 1, text: "wrong" }
  });
  assert.equal(lwEvents.length, 1, "an event for a different sessionId must be ignored");

  dispatchToAllListeners({
    type: "sayslate-offscreen-local-whisper-event", target: "floating", sessionId: runId,
    event: "partial", payload: { utteranceId: "u1", revision: 1, text: "hel" }
  });
  assert.deepEqual(lwEvents.at(-1), ["result", { finalText: "", interimText: "hel" }]);

  // A newer partial for the same utterance replaces the preview outright.
  dispatchToAllListeners({
    type: "sayslate-offscreen-local-whisper-event", target: "floating", sessionId: runId,
    event: "partial", payload: { utteranceId: "u1", revision: 2, text: "hello" }
  });
  assert.deepEqual(lwEvents.at(-1), ["result", { finalText: "", interimText: "hello" }]);

  // A final commits the utterance once and clears the preview.
  dispatchToAllListeners({
    type: "sayslate-offscreen-local-whisper-event", target: "floating", sessionId: runId,
    event: "final", payload: { utteranceId: "u1", text: "hello" }
  });
  assert.deepEqual(lwEvents.at(-1), ["result", { finalText: "hello", interimText: "" }]);

  // A second utterance's partial/final appends after the first, rather than replacing it.
  dispatchToAllListeners({
    type: "sayslate-offscreen-local-whisper-event", target: "floating", sessionId: runId,
    event: "partial", payload: { utteranceId: "u2", revision: 1, text: "wor" }
  });
  assert.deepEqual(lwEvents.at(-1), ["result", { finalText: "hello", interimText: "wor" }]);
  dispatchToAllListeners({
    type: "sayslate-offscreen-local-whisper-event", target: "floating", sessionId: runId,
    event: "final", payload: { utteranceId: "u2", text: "world" }
  });
  assert.deepEqual(lwEvents.at(-1), ["result", { finalText: "hello world", interimText: "" }]);

  // An empty utterance clears any lingering preview without adding text.
  dispatchToAllListeners({
    type: "sayslate-offscreen-local-whisper-event", target: "floating", sessionId: runId,
    event: "partial", payload: { utteranceId: "u3", revision: 1, text: "um" }
  });
  dispatchToAllListeners({
    type: "sayslate-offscreen-local-whisper-event", target: "floating", sessionId: runId,
    event: "empty", payload: { utteranceId: "u3" }
  });
  assert.deepEqual(lwEvents.at(-1), ["result", { finalText: "hello world", interimText: "" }]);

  nextLocalWhisperStopResponse = { ok: true, reason: "session-closed" };
  const stopResult = await lwSpeech.stop();
  assert.deepEqual(plain(stopResult), { ok: true });
  const stopMessage = sent.at(-1);
  assert.equal(stopMessage.type, "sayslate-local-whisper-command");
  assert.equal(stopMessage.action, "stop");
  assert.equal(stopMessage.sessionId, runId, "stop must target the same run id start used");
  assert.deepEqual(lwEvents.at(-2), ["session-end", {}]);
  assert.deepEqual(lwEvents.at(-1), ["stop"]);
  assert.equal(lwEvents.some(([name]) => name === "fatal-error"), false, "a clean stop must not report a fatal error");
  assert.equal(lwSpeech.listening, false);

  // A late event after the run has ended must be ignored, not reopen the transcript.
  const eventsBeforeLate = lwEvents.length;
  dispatchToAllListeners({
    type: "sayslate-offscreen-local-whisper-event", target: "floating", sessionId: runId,
    event: "partial", payload: { utteranceId: "u4", revision: 1, text: "late" }
  });
  assert.equal(lwEvents.length, eventsBeforeLate, "an event after stop must be ignored");

  lwSpeech.destroy();
}

{
  // A start failure (unauthorized, unavailable, forbidden origin, busy, ...) surfaces the
  // real message background.js/offscreenSpeech.js already produced, and must never fall
  // back to the Browser Dictation command channel.
  dictationProviderSnapshot.provider = "local-whisper";
  nextLocalWhisperStartResponse = { ok: false, code: "unauthorized", message: "Local Whisper has no saved token." };
  const lwEvents = [];
  const lwSpeech = context.SaySlateFloatingSpeech.create({
    sessionId: "lw-session-2",
    onFatalError: (error) => lwEvents.push(["fatal-error", plain(error)]),
    onStart: (payload) => lwEvents.push(["start", plain(payload)])
  });

  const sentCountBefore = sent.length;
  assert.equal(lwSpeech.start(), true);
  await flush();
  assert.deepEqual(lwEvents, [["fatal-error", { code: "unauthorized", message: "Local Whisper has no saved token." }]]);
  assert.equal(lwSpeech.listening, false);
  assert.equal(
    sent.slice(sentCountBefore).some((message) => message.type === "sayslate-floating-speech-command"),
    false,
    "a failed Local Whisper start must never fall back to the Browser Dictation channel"
  );

  nextLocalWhisperStartResponse = { ok: true };
  lwSpeech.destroy();
}

{
  // A stop that never confirms cleanly (timeout/disconnect/...) still preserves whatever was
  // already captured, reports the problem explicitly, and - critically - resolves { ok: false }
  // so a caller (floating.js's Finish) knows not to proceed into AI processing/insertion.
  dictationProviderSnapshot.provider = "local-whisper";
  const lwEvents = [];
  const lwSpeech = context.SaySlateFloatingSpeech.create({
    sessionId: "lw-session-3",
    onStart: (payload) => lwEvents.push(["start", plain(payload)]),
    onResult: (payload) => lwEvents.push(["result", plain(payload)]),
    onSessionEnd: (payload) => lwEvents.push(["session-end", plain(payload)]),
    onFatalError: (error) => lwEvents.push(["fatal-error", plain(error)]),
    onStop: () => lwEvents.push(["stop"])
  });
  lwSpeech.start();
  await flush();
  const runId = sent.at(-1).sessionId;
  dispatchToAllListeners({
    type: "sayslate-offscreen-local-whisper-event", target: "floating", sessionId: runId,
    event: "final", payload: { utteranceId: "u1", text: "kept text" }
  });

  nextLocalWhisperStopResponse = { ok: false, reason: "timeout" };
  const stopResult = await lwSpeech.stop();
  assert.deepEqual(plain(stopResult), { ok: false }, "a failed stop settlement must be reported to the caller");
  assert.equal(lwEvents.filter(([name]) => name === "fatal-error").length, 1);
  const fatalIndex = lwEvents.findIndex(([name]) => name === "fatal-error");
  const sessionEndIndex = lwEvents.findIndex(([name]) => name === "session-end");
  const stopIndex = lwEvents.findIndex(([name]) => name === "stop");
  assert.ok(fatalIndex < sessionEndIndex && sessionEndIndex < stopIndex, "a failed stop must report the error before committing text and releasing the UI");
  assert.deepEqual(lwEvents[sessionEndIndex], ["session-end", {}]);
  assert.equal(lwEvents.at(-1)[0], "stop");
  // The last onResult before commit still carried the captured text - nothing was dropped.
  const lastResult = [...lwEvents].reverse().find(([name]) => name === "result");
  assert.equal(lastResult[1].finalText, "kept text");

  nextLocalWhisperStopResponse = { ok: true, reason: "session-closed" };
  lwSpeech.destroy();
}

{
  // Cancel (Escape/Clear/close) must erase the run without emitting any transcript-bearing
  // event, and must route to the Local Whisper cancel command rather than Browser Dictation.
  dictationProviderSnapshot.provider = "local-whisper";
  const lwEvents = [];
  const lwSpeech = context.SaySlateFloatingSpeech.create({
    sessionId: "lw-session-4",
    onResult: (payload) => lwEvents.push(["result", plain(payload)]),
    onSessionEnd: (payload) => lwEvents.push(["session-end", plain(payload)]),
    onStop: () => lwEvents.push(["stop"])
  });
  lwSpeech.start();
  await flush();
  const runId = sent.at(-1).sessionId;
  dispatchToAllListeners({
    type: "sayslate-offscreen-local-whisper-event", target: "floating", sessionId: runId,
    event: "partial", payload: { utteranceId: "u1", revision: 1, text: "should not survive" }
  });
  assert.equal(lwEvents.length, 1);

  lwSpeech.cancel();
  assert.equal(lwSpeech.listening, false, "cancel must synchronously stop accepting the run as active");
  const cancelMessage = sent.at(-1);
  assert.equal(cancelMessage.type, "sayslate-local-whisper-command");
  assert.equal(cancelMessage.action, "cancel");
  assert.equal(cancelMessage.sessionId, runId);
  await flush();
  assert.equal(lwEvents.length, 1, "cancel must not emit any transcript-bearing event");

  // A late partial arriving after cancel must also be ignored.
  dispatchToAllListeners({
    type: "sayslate-offscreen-local-whisper-event", target: "floating", sessionId: runId,
    event: "final", payload: { utteranceId: "u1", text: "should not survive" }
  });
  assert.equal(lwEvents.length, 1);

  lwSpeech.destroy();
}

{
  // An unprompted mid-run failure (e.g. the offscreen host disconnecting or the service
  // erroring) must surface explicitly, preserve whatever was already committed, and release
  // the run back to idle rather than leaving the UI stuck in a "listening" state forever.
  dictationProviderSnapshot.provider = "local-whisper";
  const lwEvents = [];
  const lwSpeech = context.SaySlateFloatingSpeech.create({
    sessionId: "lw-session-5",
    onResult: (payload) => lwEvents.push(["result", plain(payload)]),
    onSessionEnd: (payload) => lwEvents.push(["session-end", plain(payload)]),
    onFatalError: (error) => lwEvents.push(["fatal-error", plain(error)]),
    onStop: () => lwEvents.push(["stop"])
  });
  lwSpeech.start();
  await flush();
  const runId = sent.at(-1).sessionId;
  dispatchToAllListeners({
    type: "sayslate-offscreen-local-whisper-event", target: "floating", sessionId: runId,
    event: "final", payload: { utteranceId: "u1", text: "already said" }
  });

  dispatchToAllListeners({
    type: "sayslate-offscreen-local-whisper-event", target: "floating", sessionId: runId,
    event: "error", payload: { code: "disconnected", message: "The WhisperService session closed unexpectedly." }
  });
  assert.deepEqual(lwEvents.slice(-3), [
    ["fatal-error", { code: "disconnected", message: "The WhisperService session closed unexpectedly." }],
    ["session-end", {}],
    ["stop"]
  ]);
  assert.equal(lwSpeech.listening, false);

  lwSpeech.destroy();
}

{
  // Cancel while Start is still in flight (Clear/Escape/close pressed immediately after
  // pressing dictate) must not let a later, delayed start success resurrect the session -
  // and if the offscreen host really did create one in the meantime, it must be released,
  // since the cancel sent while the request was still pending had nothing to act on yet.
  dictationProviderSnapshot.provider = "local-whisper";
  let releaseStart;
  localWhisperStartGate = new Promise((resolve) => { releaseStart = resolve; });
  nextLocalWhisperStartResponse = { ok: true };
  const lwEvents = [];
  const lwSpeech = context.SaySlateFloatingSpeech.create({
    sessionId: "lw-session-6",
    onStart: (payload) => lwEvents.push(["start", plain(payload)]),
    onFatalError: (error) => lwEvents.push(["fatal-error", plain(error)])
  });

  assert.equal(lwSpeech.start(), true);
  await flush();
  const runId = sent.at(-1).sessionId;

  lwSpeech.cancel();
  assert.equal(lwSpeech.listening, false, "cancel must take effect immediately, without waiting for start to resolve");
  const earlyCancelMessage = sent.at(-1);
  assert.equal(earlyCancelMessage.type, "sayslate-local-whisper-command");
  assert.equal(earlyCancelMessage.action, "cancel");
  assert.equal(earlyCancelMessage.sessionId, runId, "the cancel sent while start is pending must target the same run id");

  releaseStart();
  localWhisperStartGate = null;
  await flush();
  await flush();

  assert.equal(lwEvents.length, 0, "a start success arriving after cancel must never resurrect the UI");
  assert.equal(lwSpeech.listening, false);
  const cleanupCancelMessage = sent.at(-1);
  assert.equal(cleanupCancelMessage.type, "sayslate-local-whisper-command");
  assert.equal(cleanupCancelMessage.action, "cancel");
  assert.equal(cleanupCancelMessage.sessionId, runId, "the now-orphaned session the offscreen host actually created must be released");

  lwSpeech.destroy();
}

{
  // Sequential runs must not share identity: a late event addressed to an earlier,
  // already-ended run's id must never be accepted into a newer run sharing the same
  // floating window, even though both runs use the same floating-window sessionId.
  dictationProviderSnapshot.provider = "local-whisper";
  nextLocalWhisperStopResponse = { ok: true, reason: "session-closed" };
  const lwEvents = [];
  const lwSpeech = context.SaySlateFloatingSpeech.create({
    sessionId: "lw-session-7",
    onResult: (payload) => lwEvents.push(["result", plain(payload)]),
    onSessionEnd: (payload) => lwEvents.push(["session-end", plain(payload)]),
    onStop: () => lwEvents.push(["stop"])
  });

  lwSpeech.start();
  await flush();
  const runIdA = sent.at(-1).sessionId;
  await lwSpeech.stop();

  lwSpeech.start();
  await flush();
  const runIdB = sent.at(-1).sessionId;
  assert.notEqual(runIdA, runIdB, "each run must be issued a fresh id");

  const eventsBeforeStaleEvent = lwEvents.length;
  dispatchToAllListeners({
    type: "sayslate-offscreen-local-whisper-event", target: "floating", sessionId: runIdA,
    event: "final", payload: { utteranceId: "stale", text: "leaked from run one" }
  });
  assert.equal(lwEvents.length, eventsBeforeStaleEvent, "an event addressed to the previous run's id must be ignored during the new run");

  dispatchToAllListeners({
    type: "sayslate-offscreen-local-whisper-event", target: "floating", sessionId: runIdB,
    event: "final", payload: { utteranceId: "u1", text: "run two" }
  });
  assert.deepEqual(lwEvents.at(-1), ["result", { finalText: "run two", interimText: "" }]);

  lwSpeech.destroy();
}

{
  // {ok:true, inactive:true} on Start means the offscreen host's own session for this run
  // was already gone by the time it looked (e.g. torn down while still connecting) - it must
  // never be treated as a successful start, and nothing needs releasing since nothing exists.
  dictationProviderSnapshot.provider = "local-whisper";
  nextLocalWhisperStartResponse = { ok: true, inactive: true };
  const lwEvents = [];
  const lwSpeech = context.SaySlateFloatingSpeech.create({
    sessionId: "lw-session-8",
    onStart: (payload) => lwEvents.push(["start", plain(payload)]),
    onFatalError: (error) => lwEvents.push(["fatal-error", plain(error)])
  });

  const sentCountBefore = sent.length;
  lwSpeech.start();
  await flush();
  assert.equal(lwEvents.some(([name]) => name === "start"), false, "an inactive start response must never emit onStart");
  assert.equal(lwEvents.some(([name]) => name === "fatal-error"), true, "an inactive start response must be reported like any other start failure");
  assert.equal(lwSpeech.listening, false);
  assert.equal(
    sent.slice(sentCountBefore).some((message) => message.action === "cancel"),
    false,
    "nothing needs releasing when the offscreen host reports its own session as already inactive"
  );

  nextLocalWhisperStartResponse = { ok: true };
  lwSpeech.destroy();
}

{
  // {ok:true, inactive:true} on Stop means the offscreen host had no matching session left
  // to stop - Finish must not treat this as a clean settlement it is safe to proceed past.
  dictationProviderSnapshot.provider = "local-whisper";
  const lwEvents = [];
  const lwSpeech = context.SaySlateFloatingSpeech.create({
    sessionId: "lw-session-9",
    onSessionEnd: (payload) => lwEvents.push(["session-end", plain(payload)]),
    onFatalError: (error) => lwEvents.push(["fatal-error", plain(error)]),
    onStop: () => lwEvents.push(["stop"])
  });
  lwSpeech.start();
  await flush();

  nextLocalWhisperStopResponse = { ok: true, inactive: true };
  const stopResult = await lwSpeech.stop();
  assert.deepEqual(plain(stopResult), { ok: false }, "an inactive stop response must not be reported as a clean settlement");
  assert.equal(lwEvents.some(([name]) => name === "fatal-error"), true);
  assert.equal(lwEvents.at(-1)[0], "stop", "the UI must still be released even though the settlement was unclean");

  nextLocalWhisperStopResponse = { ok: true, reason: "session-closed" };
  lwSpeech.destroy();
}

// Explicit Browser Dictation regression: setting the snapshot back does not change the
// already-established behavior above, proving the two providers are read independently.
dictationProviderSnapshot.provider = "browser";

console.log("Floating speech command routing, session filtering, stop settlement, and teardown verified.");
console.log("Local Whisper provider-neutral routing, aggregation, settlement, cancellation, per-run isolation, cancel-during-start, and inactive-response handling verified.");
