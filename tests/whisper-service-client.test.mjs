import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(extensionRoot, "whisperServiceClient.js"), "utf8");

const HTTP_REQUEST_TIMEOUT_MS = 8_000;
const CONNECT_TIMEOUT_MS = 6_000;
const SETTLEMENT_TIMEOUT_MS = 4_000;

// Flushes every already-queued microtask (fetch/json resolution chains inside the client)
// using a real macrotask boundary, independent of the harness's faked setTimeout.
function tick() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

// Event payloads are assembled inside the vm sandbox realm; deep-equal them as plain
// data rather than by cross-realm prototype identity.
const plain = (value) => JSON.parse(JSON.stringify(value));

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    }
  };
}

function createHarness() {
  const timers = new Map();
  let nextTimer = 1;
  const fetchCalls = [];
  let fetchImpl = async () => {
    throw new Error("fetch not stubbed for this test");
  };

  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.binaryType = "";
      this._listeners = { open: [], message: [], close: [], error: [] };
      FakeSocket.instances.push(this);
    }
    addEventListener(type, fn) {
      this._listeners[type].push(fn);
    }
    removeEventListener(type, fn) {
      this._listeners[type] = this._listeners[type].filter((listener) => listener !== fn);
    }
    send(data) {
      this.sent.push(data);
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this._dispatch("close", {});
    }
    _dispatch(type, detail) {
      [...this._listeners[type]].forEach((fn) => fn(detail));
    }
    open() {
      this.readyState = 1;
      this._dispatch("open", {});
    }
    receive(payload) {
      this._dispatch("message", { data: JSON.stringify(payload) });
    }
    receiveRaw(data) {
      this._dispatch("message", { data });
    }
    triggerError() {
      this._dispatch("error", {});
    }
  }
  FakeSocket.instances = [];

  const context = vm.createContext({
    console,
    AbortController,
    URL,
    WebSocket: FakeSocket,
    fetch(...args) {
      fetchCalls.push(args);
      return fetchImpl(...args);
    },
    setTimeout(callback, delay) {
      const id = nextTimer++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    }
  });
  context.globalThis = context;
  vm.runInContext(source, context);

  return {
    api: context.SaySlateWhisperClient,
    FakeSocket,
    fetchCalls,
    setFetchImpl(fn) {
      fetchImpl = fn;
    },
    fireTimersWithDelay(delay) {
      const matches = [...timers].filter(([, timer]) => timer.delay === delay);
      for (const [id, timer] of matches) {
        timers.delete(id);
        timer.callback();
      }
      return matches.length;
    },
    get timerCount() {
      return timers.size;
    }
  };
}

const TOKEN = "wsi-01-test-token-secret";

function validHealthBody(overrides = {}) {
  return {
    version: "1.0.0",
    ready: true,
    serviceVersion: "1.0.0",
    protocolVersion: "1.0.0",
    model: "ggml-base.en",
    language: "en",
    activeSessions: 0,
    capabilities: {},
    ...overrides
  };
}

function validSessionDescriptor(overrides = {}) {
  return {
    version: "1.0.0",
    sessionId: "11111111-1111-1111-1111-111111111111",
    websocketTicket: "t".repeat(48),
    ticketExpiresAt: new Date(Date.now() + 15_000).toISOString(),
    streamUrl: "ws://127.0.0.1:8178/v1/sessions/11111111-1111-1111-1111-111111111111/stream",
    previewMs: 2000,
    ...overrides
  };
}

// health(): success path validates the payload and sends the bearer header only over HTTP.
{
  const harness = createHarness();
  harness.setFetchImpl(async (url, options) => {
    assert.equal(url, "http://127.0.0.1:8178/v1/health");
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    return jsonResponse(200, validHealthBody());
  });
  const client = harness.api.create({ token: TOKEN });
  const health = await client.health();
  assert.equal(health.ready, true);
  assert.equal(harness.timerCount, 0);
}

// health(): a payload missing required fields is rejected as malformed, not passed through.
{
  const harness = createHarness();
  harness.setFetchImpl(async () => jsonResponse(200, { version: "1.0.0" }));
  const client = harness.api.create({ token: TOKEN });
  await assert.rejects(client.health(), (error) => error.category === harness.api.ErrorCode.MALFORMED_RESPONSE);
}

// health(): 401 maps to the auth category using the service-provided code.
{
  const harness = createHarness();
  harness.setFetchImpl(async () => jsonResponse(401, { version: "1.0.0", error: { code: "INVALID_TOKEN", message: "Bad token" } }));
  const client = harness.api.create({ token: TOKEN });
  await assert.rejects(client.health(), (error) => error.category === harness.api.ErrorCode.AUTH && error.code === "INVALID_TOKEN");
}

// health(): the bearer token is redacted if an error body ever echoed it back.
{
  const harness = createHarness();
  harness.setFetchImpl(async () => jsonResponse(401, { version: "1.0.0", error: { code: "INVALID_TOKEN", message: `Rejected bearer ${TOKEN}` } }));
  const client = harness.api.create({ token: TOKEN });
  await assert.rejects(client.health(), (error) => !error.message.includes(TOKEN) && error.message.includes("[redacted]"));
}

// health(): a network-level fetch failure maps to the network category.
{
  const harness = createHarness();
  harness.setFetchImpl(async () => {
    throw new Error("ECONNREFUSED");
  });
  const client = harness.api.create({ token: TOKEN });
  await assert.rejects(client.health(), (error) => error.category === harness.api.ErrorCode.NETWORK);
}

// health(): a hung request is bounded by the client's own timeout, not left open forever.
{
  const harness = createHarness();
  harness.setFetchImpl(
    (url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })
  );
  const client = harness.api.create({ token: TOKEN });
  const pending = client.health();
  assert.equal(harness.fireTimersWithDelay(HTTP_REQUEST_TIMEOUT_MS), 1);
  await assert.rejects(pending, (error) => error.category === harness.api.ErrorCode.TIMEOUT);
}

// createSession(): success connects using only the ticket, never the bearer token, in the WebSocket URL.
{
  const harness = createHarness();
  harness.setFetchImpl(async (url, options) => {
    assert.equal(url, "http://127.0.0.1:8178/v1/sessions");
    assert.equal(options.method, "POST");
    assert.equal(JSON.parse(options.body).version, "1.0.0");
    return jsonResponse(201, validSessionDescriptor());
  });
  const client = harness.api.create({ token: TOKEN });
  const events = [];
  const sessionPromise = client.createSession({ onEvent: (event) => events.push(event) });
  await tick();
  const socket = harness.FakeSocket.instances[0];
  assert.ok(socket, "expected a WebSocket connection to be opened");
  assert.ok(!socket.url.includes(TOKEN), "bearer token must never appear in the WebSocket URL");
  assert.ok(socket.url.includes("ticket="), "the ticket query parameter is required to authenticate the upgrade");
  socket.open();
  socket.receive({ version: "1.0.0", type: "session.ready", sessionId: validSessionDescriptor().sessionId, audio: {}, previewMs: 2000 });
  const session = await sessionPromise;
  assert.equal(session.sessionId, validSessionDescriptor().sessionId);
  assert.equal(session.state, "ready");
  assert.deepEqual(plain(events[0]), { type: "session.ready", sessionId: session.sessionId, previewMs: 2000 });
}

// createSession(): a malformed descriptor is rejected before ever opening a socket.
{
  const harness = createHarness();
  harness.setFetchImpl(async () => jsonResponse(201, validSessionDescriptor({ streamUrl: "ws://evil.example/stream" })));
  const client = harness.api.create({ token: TOKEN });
  await assert.rejects(client.createSession(), (error) => error.category === harness.api.ErrorCode.MALFORMED_RESPONSE);
  assert.equal(harness.FakeSocket.instances.length, 0);
}

// validateSessionDescriptor(): the stream URL is parsed, not merely prefix-matched - a
// descriptor crossing an extension-message boundary cannot smuggle a mismatched session id,
// extra path, foreign port, credentials, or a stray query/fragment past validation.
{
  const otherSessionId = "22222222-2222-2222-2222-222222222222";
  const badDescriptors = {
    "session id in the path does not match descriptor.sessionId": validSessionDescriptor({
      streamUrl: `ws://127.0.0.1:8178/v1/sessions/${otherSessionId}/stream`
    }),
    "extra path beyond /stream": validSessionDescriptor({ streamUrl: "ws://127.0.0.1:8178/v1/sessions/11111111-1111-1111-1111-111111111111/stream/extra" }),
    "stray query string": validSessionDescriptor({ streamUrl: "ws://127.0.0.1:8178/v1/sessions/11111111-1111-1111-1111-111111111111/stream?x=1" }),
    "stray fragment": validSessionDescriptor({ streamUrl: "ws://127.0.0.1:8178/v1/sessions/11111111-1111-1111-1111-111111111111/stream#frag" }),
    "embedded credentials": validSessionDescriptor({ streamUrl: "ws://user:pass@127.0.0.1:8178/v1/sessions/11111111-1111-1111-1111-111111111111/stream" }),
    "wrong port": validSessionDescriptor({ streamUrl: "ws://127.0.0.1:9999/v1/sessions/11111111-1111-1111-1111-111111111111/stream" })
  };
  for (const [label, descriptor] of Object.entries(badDescriptors)) {
    const harness = createHarness();
    harness.setFetchImpl(async () => jsonResponse(201, descriptor));
    const client = harness.api.create({ token: TOKEN });
    await assert.rejects(client.createSession(), (error) => error.category === harness.api.ErrorCode.MALFORMED_RESPONSE, `expected rejection for: ${label}`);
    assert.equal(harness.FakeSocket.instances.length, 0, `expected no socket for: ${label}`);
  }
}

// createSessionDescriptor(): the HTTP half alone never opens a socket - this is what a
// token-holding background context calls before handing only the descriptor onward.
{
  const harness = createHarness();
  const descriptor = validSessionDescriptor();
  harness.setFetchImpl(async () => jsonResponse(201, descriptor));
  const client = harness.api.create({ token: TOKEN });
  const result = await client.createSessionDescriptor({ previewMs: 2000 });
  assert.equal(result.sessionId, descriptor.sessionId);
  assert.equal(harness.FakeSocket.instances.length, 0);
}

// connectSession(): the WebSocket half is token-free and works standalone from a bare
// descriptor - exactly what an offscreen document (which must never hold the bearer
// token) needs to call after receiving the descriptor from the background context.
{
  const harness = createHarness();
  const descriptor = validSessionDescriptor();
  const events = [];
  const sessionPromise = harness.api.connectSession(descriptor, { onEvent: (event) => events.push(event) });
  await tick();
  const socket = harness.FakeSocket.instances[0];
  assert.ok(socket, "connectSession must open a socket from the descriptor alone, with no client/token involved");
  assert.equal(harness.fetchCalls.length, 0, "connectSession must never make an HTTP call itself");
  socket.open();
  socket.receive({ version: "1.0.0", type: "session.ready", sessionId: descriptor.sessionId, audio: {}, previewMs: 2000 });
  const session = await sessionPromise;
  assert.equal(session.sessionId, descriptor.sessionId);
  session.close();
}

// connectSession(): re-validates the descriptor defensively, since it may have crossed an
// extension-message boundary since createSessionDescriptor() first produced it.
{
  const harness = createHarness();
  await assert.rejects(
    harness.api.connectSession(validSessionDescriptor({ previewMs: 999 })),
    (error) => error.category === harness.api.ErrorCode.MALFORMED_RESPONSE
  );
  assert.equal(harness.FakeSocket.instances.length, 0);
}

// createSession(): 429 maps to the capacity category.
{
  const harness = createHarness();
  harness.setFetchImpl(async () => jsonResponse(429, { version: "1.0.0", error: { code: "CAPACITY_EXCEEDED", message: "Busy" } }));
  const client = harness.api.create({ token: TOKEN });
  await assert.rejects(client.createSession(), (error) => error.category === harness.api.ErrorCode.CAPACITY);
}

// createSession(): a connection that never becomes ready times out and releases the server-side slot.
{
  const harness = createHarness();
  const descriptor = validSessionDescriptor();
  harness.setFetchImpl(async (url, options) => {
    if (options.method === "DELETE") return jsonResponse(204, null);
    return jsonResponse(201, descriptor);
  });
  const client = harness.api.create({ token: TOKEN });
  const sessionPromise = client.createSession();
  await tick();
  assert.equal(harness.fireTimersWithDelay(CONNECT_TIMEOUT_MS), 1);
  await assert.rejects(sessionPromise, (error) => error.category === harness.api.ErrorCode.TIMEOUT);
  await Promise.resolve();
  await Promise.resolve();
  const cleanupCall = harness.fetchCalls.find(([, options]) => options.method === "DELETE");
  assert.ok(cleanupCall, "expected a best-effort DELETE to release the abandoned session");
  assert.ok(cleanupCall[0].endsWith(`/v1/sessions/${descriptor.sessionId}`));
}

// createSession(): a socket error before readiness rejects with a network category.
{
  const harness = createHarness();
  harness.setFetchImpl(async () => jsonResponse(201, validSessionDescriptor()));
  const client = harness.api.create({ token: TOKEN });
  const sessionPromise = client.createSession();
  await tick();
  const socket = harness.FakeSocket.instances[0];
  socket.triggerError();
  await assert.rejects(sessionPromise, (error) => error.category === harness.api.ErrorCode.NETWORK);
}

// createSession(): a socket close before readiness (no error event) also rejects with a network category.
{
  const harness = createHarness();
  harness.setFetchImpl(async () => jsonResponse(201, validSessionDescriptor()));
  const client = harness.api.create({ token: TOKEN });
  const sessionPromise = client.createSession();
  await tick();
  const socket = harness.FakeSocket.instances[0];
  socket.close();
  await assert.rejects(sessionPromise, (error) => error.category === harness.api.ErrorCode.NETWORK);
}

async function openSession(harness, { onEvent, onClientError } = {}) {
  const descriptor = validSessionDescriptor();
  harness.setFetchImpl(async (url, options) => {
    if (options.method === "DELETE") return jsonResponse(204, null);
    return jsonResponse(201, descriptor);
  });
  const client = harness.api.create({ token: TOKEN });
  const events = [];
  const clientErrors = [];
  const sessionPromise = client.createSession({
    onEvent: (event) => {
      events.push(event);
      onEvent?.(event);
    },
    onClientError: (detail) => {
      clientErrors.push(detail);
      onClientError?.(detail);
    }
  });
  await tick();
  const socket = harness.FakeSocket.instances[0];
  socket.open();
  socket.receive({ version: "1.0.0", type: "session.ready", sessionId: descriptor.sessionId, audio: {}, previewMs: 2000 });
  const session = await sessionPromise;
  return { session, socket, descriptor, events, clientErrors };
}

// transcript.partial: replaced only on a strictly increasing revision; a stale revision is suppressed with a diagnostic.
{
  const harness = createHarness();
  const { session, socket, descriptor, events, clientErrors } = await openSession(harness);
  const utteranceId = "22222222-2222-2222-2222-222222222222";
  socket.receive({ version: "1.0.0", type: "transcript.partial", sessionId: descriptor.sessionId, utteranceId, revision: 1, text: "hello" });
  socket.receive({ version: "1.0.0", type: "transcript.partial", sessionId: descriptor.sessionId, utteranceId, revision: 1, text: "hello duplicate" });
  socket.receive({ version: "1.0.0", type: "transcript.partial", sessionId: descriptor.sessionId, utteranceId, revision: 2, text: "hello there" });
  const partials = events.filter((event) => event.type === "transcript.partial");
  assert.equal(partials.length, 2);
  assert.equal(partials[1].text, "hello there");
  assert.ok(clientErrors.some((detail) => detail.reason === "stale-partial-revision"));
  session.close();
}

// transcript.final commits the utterance once; a later partial for that utteranceId is stale.
{
  const harness = createHarness();
  const { session, socket, descriptor, events, clientErrors } = await openSession(harness);
  const utteranceId = "33333333-3333-3333-3333-333333333333";
  socket.receive({ version: "1.0.0", type: "transcript.partial", sessionId: descriptor.sessionId, utteranceId, revision: 1, text: "final words" });
  socket.receive({
    version: "1.0.0",
    type: "transcript.final",
    sessionId: descriptor.sessionId,
    utteranceId,
    text: "final words",
    segments: [{ startMs: 0, endMs: 500, text: "final words" }],
    finalizationReason: "pause"
  });
  socket.receive({ version: "1.0.0", type: "transcript.partial", sessionId: descriptor.sessionId, utteranceId, revision: 2, text: "stale after final" });
  const finals = events.filter((event) => event.type === "transcript.final");
  assert.equal(finals.length, 1);
  assert.equal(finals[0].text, "final words");
  const lateClientErrors = clientErrors.filter((detail) => detail.reason === "stale-partial-revision");
  assert.equal(lateClientErrors.length, 1);
  session.close();
}

// transcript.empty is forwarded distinctly from final.
{
  const harness = createHarness();
  const { session, socket, descriptor, events } = await openSession(harness);
  socket.receive({ version: "1.0.0", type: "transcript.empty", sessionId: descriptor.sessionId, utteranceId: "44444444-4444-4444-4444-444444444444", finalizationReason: "pause" });
  assert.ok(events.some((event) => event.type === "transcript.empty"));
  session.close();
}

// error events are categorized by keyword. This layer never holds the bearer token (see the
// createSessionDescriptor/connectSession split below), so there is nothing here to redact -
// token secrecy is guaranteed structurally instead, by never handing this layer the token.
{
  const harness = createHarness();
  const { session, socket, events } = await openSession(harness);
  socket.receive({ version: "1.0.0", type: "error", code: "WORKER_CRASHED", message: "worker failed" });
  socket.receive({ version: "1.0.0", type: "error", code: "SOMETHING_NEW", message: "unrecognized failure" });
  const errors = events.filter((event) => event.type === "error");
  assert.equal(errors[0].category, harness.api.ErrorCode.WORKER);
  assert.equal(errors[1].category, harness.api.ErrorCode.UNAVAILABLE);
  session.close();
}

// stop(): success requires BOTH a transcript.final/empty finalized "because of" the stop
// AND a matching session.closed - the happy path where the service actually confirms it.
{
  const harness = createHarness();
  const { session, socket, descriptor, events } = await openSession(harness);
  const stopSettled = session.stop();
  socket.receive({ version: "1.0.0", type: "transcript.empty", sessionId: descriptor.sessionId, utteranceId: "88888888-8888-8888-8888-888888888888", finalizationReason: "stop" });
  socket.receive({ version: "1.0.0", type: "session.closed", sessionId: descriptor.sessionId, reason: "stop" });
  const outcome = await stopSettled;
  assert.deepEqual(plain(outcome), { ok: true, reason: "session-closed", serverReason: "stop" });
  assert.equal(session.state, "closed");
  assert.ok(events.some((event) => event.type === "session.closed"));
  assert.deepEqual(plain(await session.stop()), plain(outcome)); // idempotent: same recorded outcome, no re-send
}

// stop(): session.closed WITHOUT a preceding stop-finalized transcript is not success -
// this is the "missing final" case a caller must be able to tell apart from a real settle.
{
  const harness = createHarness();
  const { session, socket, descriptor } = await openSession(harness);
  const stopSettled = session.stop();
  socket.receive({ version: "1.0.0", type: "session.closed", sessionId: descriptor.sessionId, reason: "stop" });
  const outcome = await stopSettled;
  assert.deepEqual(plain(outcome), { ok: false, reason: "missing-final" });
}

// stop(): the exact regression this fix targets - WhisperService can emit an `error` when
// final inference fails and then still close normally (error -> session.closed). That must
// surface as a failed, service-attributed outcome, never as { ok: true }.
{
  const harness = createHarness();
  const { session, socket, descriptor } = await openSession(harness);
  const stopSettled = session.stop();
  socket.receive({ version: "1.0.0", type: "error", code: "WORKER_INFERENCE_FAILED", message: "final inference failed" });
  socket.receive({ version: "1.0.0", type: "session.closed", sessionId: descriptor.sessionId, reason: "stop" });
  const outcome = await stopSettled;
  assert.deepEqual(plain(outcome), {
    ok: false,
    reason: "service-error",
    code: "WORKER_INFERENCE_FAILED",
    category: harness.api.ErrorCode.WORKER,
    message: "final inference failed"
  });
}

// stop(): an error for a DIFFERENT, still-pending utterance (e.g. an earlier rollover/pause
// inference) arriving AFTER this stop's own final was already confirmed must still fail the
// outcome - WhisperService waits for every pending utterance before closing, so a later
// stoppingConfirmed must never mask an earlier lost one. Sequence: final(stop) -> error -> closed.
{
  const harness = createHarness();
  const { session, socket, descriptor } = await openSession(harness);
  const stopSettled = session.stop();
  socket.receive({
    version: "1.0.0",
    type: "transcript.empty",
    sessionId: descriptor.sessionId,
    utteranceId: "88888888-8888-8888-8888-888888888888",
    finalizationReason: "stop"
  });
  socket.receive({ version: "1.0.0", type: "error", code: "WORKER_INFERENCE_FAILED", message: "an earlier pending utterance failed" });
  socket.receive({ version: "1.0.0", type: "session.closed", sessionId: descriptor.sessionId, reason: "stop" });
  const outcome = await stopSettled;
  assert.deepEqual(plain(outcome), {
    ok: false,
    reason: "service-error",
    code: "WORKER_INFERENCE_FAILED",
    category: harness.api.ErrorCode.WORKER,
    message: "an earlier pending utterance failed"
  });
}

// stop(): a stale error from earlier in an otherwise-healthy session (already recovered from,
// long before stop() was ever called) must not fail a later, genuinely clean stop.
{
  const harness = createHarness();
  const { session, socket, descriptor } = await openSession(harness);
  socket.receive({ version: "1.0.0", type: "error", code: "TRANSIENT_HICCUP", message: "recovered mid-session" });
  const stopSettled = session.stop();
  socket.receive({
    version: "1.0.0",
    type: "transcript.final",
    sessionId: descriptor.sessionId,
    utteranceId: "99999999-8888-8888-8888-888888888888",
    text: "clean stop",
    segments: [],
    finalizationReason: "stop"
  });
  socket.receive({ version: "1.0.0", type: "session.closed", sessionId: descriptor.sessionId, reason: "stop" });
  const outcome = await stopSettled;
  assert.deepEqual(plain(outcome), { ok: true, reason: "session-closed", serverReason: "stop" });
}

// stop(): stoppingConfirmed alone is not enough - the closing session.closed must itself
// report reason "stop" to count as a clean, stop-driven settlement.
{
  const harness = createHarness();
  const { session, socket, descriptor } = await openSession(harness);
  const stopSettled = session.stop();
  socket.receive({
    version: "1.0.0",
    type: "transcript.empty",
    sessionId: descriptor.sessionId,
    utteranceId: "aaaaaaaa-8888-8888-8888-888888888888",
    finalizationReason: "stop"
  });
  socket.receive({ version: "1.0.0", type: "session.closed", sessionId: descriptor.sessionId, reason: "idle" });
  const outcome = await stopSettled;
  assert.deepEqual(plain(outcome), { ok: false, reason: "missing-final" });
}

// malformed/unknown envelopes are suppressed with explicit, non-secret diagnostics rather than silently accepted.
{
  const harness = createHarness();
  const { session, socket, events, clientErrors } = await openSession(harness);
  events.length = 0; // openSession's own session.ready event is not under test here
  socket.receiveRaw("not json");
  socket.receive({ version: "2.0.0", type: "transcript.final" });
  socket.receive({ version: "1.0.0", type: "not-a-real-event" });
  socket.receive({
    version: "1.0.0",
    type: "transcript.final",
    sessionId: "99999999-9999-9999-9999-999999999999", // well-formed but not this session's id
    utteranceId: "66666666-6666-6666-6666-666666666666",
    text: "x",
    segments: [],
    finalizationReason: "pause"
  });
  socket.receive({ version: "1.0.0", type: "transcript.final" }); // missing required fields
  assert.equal(events.length, 0);
  const reasons = clientErrors.map((detail) => detail.reason);
  assert.ok(reasons.includes("malformed-envelope"));
  assert.ok(reasons.includes("unknown-protocol-version"));
  assert.ok(reasons.includes("unknown-event-type"));
  assert.ok(reasons.includes("wrong-session"));
  session.close();
}

// stop(): sends the stop control; a bare transport close with no session.closed confirmation
// is treated as an unexpected disconnect, not a quiet success - and repeated calls are idempotent.
{
  const harness = createHarness();
  const { session, socket } = await openSession(harness);
  const settled = session.stop();
  assert.deepEqual(JSON.parse(socket.sent[0]), { version: "1.0.0", type: "stop" });
  socket.close();
  const outcome = await settled;
  assert.deepEqual(plain(outcome), { ok: false, reason: "disconnected" });
  assert.equal(session.state, "closed");
  assert.deepEqual(plain(await session.stop()), plain(outcome));
}

// stop(): if the server never confirms, the bounded settlement timeout forces closure and
// reports failure explicitly - Finish must never read a timed-out stop as success.
{
  const harness = createHarness();
  const { session, socket, clientErrors } = await openSession(harness);
  const settled = session.stop();
  assert.equal(harness.fireTimersWithDelay(SETTLEMENT_TIMEOUT_MS), 1);
  const outcome = await settled;
  assert.deepEqual(plain(outcome), { ok: false, reason: "timeout" });
  assert.equal(socket.readyState, 3);
  assert.ok(clientErrors.some((detail) => detail.reason === "stopping-settlement-timeout"));
}

// stop(): a session that already died unexpectedly *before* stop() was ever called must
// report that failure honestly, not resolve as if the stop itself had succeeded.
{
  const harness = createHarness();
  const { session, socket } = await openSession(harness);
  socket.close(); // simulates the connection dropping while dictation was still active
  assert.equal(session.state, "closed");
  const outcome = await session.stop();
  assert.deepEqual(plain(outcome), { ok: false, reason: "disconnected" });
}

// cancel(): suppresses any transcript arriving after cancellation and settles deterministically.
{
  const harness = createHarness();
  const { session, socket, descriptor, events } = await openSession(harness);
  const settled = session.cancel();
  assert.deepEqual(JSON.parse(socket.sent[0]), { version: "1.0.0", type: "cancel" });
  socket.receive({
    version: "1.0.0",
    type: "transcript.final",
    sessionId: descriptor.sessionId,
    utteranceId: "77777777-7777-7777-7777-777777777777",
    text: "should not appear",
    segments: [],
    finalizationReason: "flush"
  });
  socket.close();
  const outcome = await settled;
  assert.deepEqual(plain(outcome), { ok: false, reason: "disconnected" });
  assert.ok(!events.some((event) => event.type === "transcript.final"), "cancel must never emit a transcript");
}

// sendPcm16: rejects invalid frame sizes and unavailable sockets without ever transforming valid audio.
{
  const harness = createHarness();
  const { session, socket } = await openSession(harness);
  const frame = new Uint8Array([1, 2, 3, 4]).buffer;
  session.sendPcm16(frame);
  assert.equal(socket.sent.at(-1), frame);
  assert.throws(() => session.sendPcm16(new Uint8Array([1]).buffer), (error) => error.category === harness.api.ErrorCode.CLIENT);
  // WhisperService's own maxFrameBytes is 64,000 (constants.mjs); a frame over that would
  // be rejected by the service, so the client must reject it first rather than send it.
  assert.throws(() => session.sendPcm16(new ArrayBuffer(64_002)), (error) => error.category === harness.api.ErrorCode.CLIENT);
  session.sendPcm16(new ArrayBuffer(64_000)); // exactly at the limit is still valid
  assert.equal(socket.sent.at(-1).byteLength, 64_000);
  session.close();
  assert.throws(() => session.sendPcm16(frame), (error) => error.category === harness.api.ErrorCode.UNAVAILABLE);
}

// flush(): sends the flush control while connected and fails explicitly once the session is closed.
{
  const harness = createHarness();
  const { session, socket } = await openSession(harness);
  session.flush();
  assert.deepEqual(JSON.parse(socket.sent.at(-1)), { version: "1.0.0", type: "flush" });
  session.close();
  assert.throws(() => session.flush(), (error) => error.category === harness.api.ErrorCode.UNAVAILABLE);
}

console.log("WhisperService protocol client health, session lifecycle, event parsing, and redaction paths verified.");
