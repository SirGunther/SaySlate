(() => {
  "use strict";

  const PROTOCOL_VERSION = "1.0.0";
  const DEFAULT_BASE_URL = "http://127.0.0.1:8178";

  // Bounded so a hung health/session-create request cannot block a caller indefinitely.
  const HTTP_REQUEST_TIMEOUT_MS = 8_000;
  // Must resolve well inside the server's 15-second single-use websocket ticket window.
  const CONNECT_TIMEOUT_MS = 6_000;
  // Bounded so Finish/Clear/Escape settlement never hangs on a silent or wedged service.
  const SETTLEMENT_TIMEOUT_MS = 4_000;
  // Matches WhisperService's own maxFrameBytes (see C:\WhisperService\src\constants.mjs);
  // a frame over this limit would be rejected by the service, so reject it here first.
  const MAX_PCM_FRAME_BYTES = 64_000;

  const ErrorCode = Object.freeze({
    AUTH: "auth",
    ORIGIN: "origin",
    CAPACITY: "capacity",
    TIMEOUT: "timeout",
    WORKER: "worker",
    MALFORMED_RESPONSE: "malformed-response",
    NETWORK: "network",
    UNAVAILABLE: "unavailable",
    // Caller misuse (e.g. sending audio on a closed session) - never produced by the service itself.
    CLIENT: "client"
  });

  class WhisperClientError extends Error {
    constructor(category, code, message) {
      super(message);
      this.name = "WhisperClientError";
      this.category = category;
      this.code = code;
    }
  }

  function redactToken(token, text) {
    if (typeof text !== "string" || !token) return text;
    return text.split(token).join("[redacted]");
  }

  function categorizeHttpStatus(status) {
    if (status === 401) return ErrorCode.AUTH;
    if (status === 403) return ErrorCode.ORIGIN;
    if (status === 429) return ErrorCode.CAPACITY;
    return ErrorCode.UNAVAILABLE;
  }

  // The service does not publish a fixed error-code catalog (only the generic
  // {code, message, details} envelope), so unknown codes are classified by keyword
  // and otherwise fall back to UNAVAILABLE rather than being dropped.
  function categorizeServiceCode(rawCode) {
    const code = String(rawCode || "").toUpperCase();
    if (code.includes("AUTH") || code.includes("TOKEN") || code.includes("UNAUTHORIZED")) return ErrorCode.AUTH;
    if (code.includes("ORIGIN") || code.includes("FORBIDDEN")) return ErrorCode.ORIGIN;
    if (code.includes("CAPACITY") || code.includes("BUSY") || code.includes("LIMIT")) return ErrorCode.CAPACITY;
    if (code.includes("TIMEOUT")) return ErrorCode.TIMEOUT;
    if (code.includes("WORKER") || code.includes("MODEL") || code.includes("INFERENCE")) return ErrorCode.WORKER;
    if (code.includes("MALFORMED") || code.includes("INVALID") || code.includes("SCHEMA")) return ErrorCode.MALFORMED_RESPONSE;
    if (code.includes("NETWORK") || code.includes("OFFLINE")) return ErrorCode.NETWORK;
    return ErrorCode.UNAVAILABLE;
  }

  async function parseJsonBody(response) {
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch {
      throw new WhisperClientError(ErrorCode.MALFORMED_RESPONSE, "MALFORMED_RESPONSE", "WhisperService returned a response that could not be parsed.");
    }
  }

  async function authorizedRequest({ baseUrl, token, path, method, body, timeoutMs }) {
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await globalThis.fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new WhisperClientError(ErrorCode.TIMEOUT, "TIMEOUT", "WhisperService request timed out.");
      }
      throw new WhisperClientError(ErrorCode.NETWORK, "NETWORK", "WhisperService is offline or unreachable.");
    } finally {
      globalThis.clearTimeout(timer);
    }

    if (response.ok) return parseJsonBody(response);

    let parsedError = null;
    try {
      parsedError = await response.json();
    } catch {
      // Non-JSON error body; fall back to a status-based category and message below.
    }
    const rawCode = parsedError?.error?.code;
    const category = rawCode ? categorizeServiceCode(rawCode) : categorizeHttpStatus(response.status);
    const message = redactToken(token, parsedError?.error?.message) || `WhisperService returned HTTP ${response.status}.`;
    throw new WhisperClientError(category, rawCode || `HTTP_${response.status}`, message);
  }

  const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  const FINALIZATION_REASONS = new Set(["pause", "flush", "stop", "rollover"]);

  function isUuid(value) {
    return typeof value === "string" && UUID_PATTERN.test(value);
  }

  function validateHealth(body) {
    const valid =
      body &&
      body.version === PROTOCOL_VERSION &&
      typeof body.ready === "boolean" &&
      body.serviceVersion === PROTOCOL_VERSION &&
      body.protocolVersion === PROTOCOL_VERSION &&
      typeof body.model === "string" &&
      body.model.length > 0 &&
      body.language === "en" &&
      Number.isInteger(body.activeSessions) &&
      body.activeSessions >= 0 &&
      body.activeSessions <= 4 &&
      typeof body.capabilities === "object" &&
      body.capabilities !== null;
    if (!valid) throw new WhisperClientError(ErrorCode.MALFORMED_RESPONSE, "MALFORMED_RESPONSE", "WhisperService returned an unexpected health payload.");
    return body;
  }

  // Parses (rather than prefix-matches) the stream URL so a descriptor crossing an
  // extension-message boundary cannot smuggle a different session id, an unexpected
  // path/port, or extra query/fragment/credential data past a merely-prefixed check.
  function isValidStreamUrl(streamUrl, sessionId) {
    let parsed;
    try {
      parsed = new URL(streamUrl);
    } catch {
      return false;
    }
    return (
      parsed.protocol === "ws:" &&
      parsed.hostname === "127.0.0.1" &&
      parsed.port === "8178" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.pathname === `/v1/sessions/${sessionId}/stream`
    );
  }

  function validateSessionDescriptor(descriptor) {
    const valid =
      descriptor &&
      descriptor.version === PROTOCOL_VERSION &&
      isUuid(descriptor.sessionId) &&
      typeof descriptor.websocketTicket === "string" &&
      descriptor.websocketTicket.length >= 43 &&
      typeof descriptor.ticketExpiresAt === "string" &&
      !Number.isNaN(Date.parse(descriptor.ticketExpiresAt)) &&
      typeof descriptor.streamUrl === "string" &&
      isValidStreamUrl(descriptor.streamUrl, descriptor.sessionId) &&
      Number.isInteger(descriptor.previewMs) &&
      descriptor.previewMs >= 1500 &&
      descriptor.previewMs <= 3000;
    if (!valid) throw new WhisperClientError(ErrorCode.MALFORMED_RESPONSE, "MALFORMED_RESPONSE", "WhisperService returned an unexpected session descriptor.");
    return descriptor;
  }

  function isValidSegment(segment) {
    return (
      segment !== null &&
      typeof segment === "object" &&
      typeof segment.startMs === "number" &&
      segment.startMs >= 0 &&
      typeof segment.endMs === "number" &&
      segment.endMs >= 0 &&
      typeof segment.text === "string"
    );
  }

  const KNOWN_EVENT_TYPES = new Set(["session.ready", "transcript.partial", "transcript.final", "transcript.empty", "error", "session.closed"]);

  function isValidEnvelope(payload) {
    switch (payload.type) {
      case "session.ready":
        return isUuid(payload.sessionId) && payload.audio !== null && typeof payload.audio === "object" && Number.isInteger(payload.previewMs);
      case "transcript.partial":
        return isUuid(payload.sessionId) && isUuid(payload.utteranceId) && Number.isInteger(payload.revision) && payload.revision >= 1 && typeof payload.text === "string";
      case "transcript.final":
        return (
          isUuid(payload.sessionId) &&
          isUuid(payload.utteranceId) &&
          typeof payload.text === "string" &&
          Array.isArray(payload.segments) &&
          payload.segments.every(isValidSegment) &&
          FINALIZATION_REASONS.has(payload.finalizationReason)
        );
      case "transcript.empty":
        return isUuid(payload.sessionId) && isUuid(payload.utteranceId) && FINALIZATION_REASONS.has(payload.finalizationReason);
      case "error":
        return typeof payload.code === "string" && payload.code.length > 0 && typeof payload.message === "string";
      case "session.closed":
        return isUuid(payload.sessionId) && typeof payload.reason === "string";
      default:
        return false;
    }
  }

  // Runs entirely on the descriptor's ticket; never touches the bearer token. This is
  // deliberate: the offscreen document that owns microphone capture and this socket must
  // never hold the token (only the background context that fetched the descriptor does),
  // so this layer cannot depend on it even for defensive redaction of server-sent text.
  function createSessionController({ descriptor, cancelHttp, onEvent, onClientError }) {
    let state = "connecting"; // connecting -> ready -> stopping | cancelling -> closed
    let suppressFutureTranscripts = false;
    let settlePromise = null;
    let readyResolve = null;
    let readyReject = null;
    let terminalOutcome = null; // set once: how/why the session ended, for stop()/cancel() to report honestly
    let stoppingConfirmed = false; // saw a transcript.final/empty with finalizationReason "stop" while stopping
    let lastServiceError = null; // most recent stream-level `error` event, for outcome attribution
    const utteranceRevisions = new Map();
    const listeners = new Set(onEvent ? [onEvent] : []);
    let controllerRef = null;

    const ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });

    function emit(event) {
      for (const listener of listeners) listener(event);
    }

    function diagnose(reason) {
      onClientError?.({ reason, sessionId: descriptor.sessionId });
    }

    function recordTerminalOutcome(outcome) {
      if (!terminalOutcome) terminalOutcome = outcome;
    }

    const url = new URL(descriptor.streamUrl);
    url.searchParams.set("ticket", descriptor.websocketTicket);
    const socket = new globalThis.WebSocket(url.toString());
    socket.binaryType = "arraybuffer";

    const connectTimer = globalThis.setTimeout(() => {
      if (state === "connecting") failConnect(new WhisperClientError(ErrorCode.TIMEOUT, "CONNECT_TIMEOUT", "WhisperService session did not become ready in time."));
    }, CONNECT_TIMEOUT_MS);

    function failConnect(error) {
      globalThis.clearTimeout(connectTimer);
      state = "closed";
      recordTerminalOutcome({ ok: false, reason: "connect-failed" });
      try {
        socket.close();
      } catch {
        // Socket may already be closing; nothing further to release locally.
      }
      void cancelHttp().catch(() => {
        // Best-effort release of the server-side session slot; the connect error already reported.
      });
      readyReject(error);
    }

    let resolveSettle = null;

    function settleNow() {
      if (!resolveSettle) return;
      const resolve = resolveSettle;
      resolveSettle = null;
      resolve();
    }

    socket.addEventListener("error", () => {
      if (state === "connecting") {
        failConnect(new WhisperClientError(ErrorCode.NETWORK, "OFFLINE", "WhisperService WebSocket could not connect."));
        return;
      }
      if (state === "closed") return;
      emit({ type: "error", code: "OFFLINE", message: "WhisperService WebSocket connection failed.", category: ErrorCode.NETWORK });
    });

    socket.addEventListener("close", () => {
      globalThis.clearTimeout(connectTimer);
      const wasConnecting = state === "connecting";
      state = "closed";
      // A transport close that was not already attributed (an explicit session.closed
      // message, or our own bounded settlement timeout) is an unexpected disconnect -
      // never treat it as a quiet success.
      recordTerminalOutcome({ ok: false, reason: "disconnected" });
      settleNow();
      if (wasConnecting) readyReject(new WhisperClientError(ErrorCode.NETWORK, "OFFLINE", "WhisperService WebSocket closed before the session became ready."));
    });

    socket.addEventListener("message", (incoming) => {
      if (state === "closed") return;
      if (typeof incoming.data !== "string") return; // binary server->client frames are not part of the contract

      let payload;
      try {
        payload = JSON.parse(incoming.data);
      } catch {
        diagnose("malformed-envelope");
        return;
      }
      if (!payload || typeof payload !== "object") {
        diagnose("malformed-envelope");
        return;
      }
      if (payload.version !== PROTOCOL_VERSION) {
        diagnose("unknown-protocol-version");
        return;
      }
      if (!KNOWN_EVENT_TYPES.has(payload.type)) {
        diagnose("unknown-event-type");
        return;
      }
      if (!isValidEnvelope(payload)) {
        diagnose("malformed-envelope");
        return;
      }
      if (payload.sessionId && payload.sessionId !== descriptor.sessionId) {
        diagnose("wrong-session");
        return;
      }

      if (payload.type === "transcript.partial") {
        const previousRevision = utteranceRevisions.get(payload.utteranceId) || 0;
        if (payload.revision <= previousRevision) {
          diagnose("stale-partial-revision");
          return;
        }
        utteranceRevisions.set(payload.utteranceId, payload.revision);
        if (suppressFutureTranscripts) return;
        emit({ type: payload.type, sessionId: payload.sessionId, utteranceId: payload.utteranceId, revision: payload.revision, text: payload.text });
        return;
      }

      if (payload.type === "transcript.final" || payload.type === "transcript.empty") {
        // Final/empty settles the utterance; any later partial for the same utteranceId is stale by definition.
        utteranceRevisions.set(payload.utteranceId, Number.POSITIVE_INFINITY);
        // A stop() only counts as confirmed once the utterance that was active when it was
        // requested has actually been finalized "because of" that stop - not merely because
        // the session later closed for some other or unexplained reason.
        if (state === "stopping" && payload.finalizationReason === "stop") stoppingConfirmed = true;
        if (suppressFutureTranscripts) return;
        emit(
          payload.type === "transcript.final"
            ? { type: payload.type, sessionId: payload.sessionId, utteranceId: payload.utteranceId, text: payload.text, segments: payload.segments, finalizationReason: payload.finalizationReason }
            : { type: payload.type, sessionId: payload.sessionId, utteranceId: payload.utteranceId, finalizationReason: payload.finalizationReason }
        );
        return;
      }

      if (payload.type === "session.ready") {
        if (state === "connecting") {
          globalThis.clearTimeout(connectTimer);
          state = "ready";
          readyResolve(controllerRef);
        }
        emit({ type: payload.type, sessionId: payload.sessionId, previewMs: payload.previewMs });
        return;
      }

      if (payload.type === "error") {
        lastServiceError = { code: payload.code, message: payload.message, category: categorizeServiceCode(payload.code) };
        emit({ type: payload.type, code: payload.code, message: payload.message, category: lastServiceError.category });
        return;
      }

      // session.closed: an explicit protocol-level confirmation. For a stop specifically,
      // that confirmation is only trustworthy when NOTHING went wrong during the wait - the
      // service waits for every pending utterance (including an earlier rollover/pause one
      // still finishing inference) before closing, so an error can arrive for a DIFFERENT,
      // already-lost utterance even after this stop's own final was confirmed. An error seen
      // during the stop window is therefore checked first, ahead of stoppingConfirmed, and a
      // matching session.closed must itself report reason "stop" to count as a clean stop.
      if (state === "stopping") {
        if (lastServiceError) {
          recordTerminalOutcome({ ok: false, reason: "service-error", code: lastServiceError.code, category: lastServiceError.category, message: lastServiceError.message });
        } else if (stoppingConfirmed && payload.reason === "stop") {
          recordTerminalOutcome({ ok: true, reason: "session-closed", serverReason: payload.reason });
        } else {
          recordTerminalOutcome({ ok: false, reason: "missing-final" });
        }
      } else {
        // Not stop-driven (cancelling, or the server closed unprompted): cancel never
        // produces a final/empty by protocol design, so an explicit session.closed is
        // itself the only confirmation there is to require.
        recordTerminalOutcome({ ok: true, reason: "session-closed", serverReason: payload.reason });
      }
      state = "closed";
      emit({ type: payload.type, sessionId: payload.sessionId, reason: payload.reason });
      settleNow();
    });

    function ensureOpen() {
      if (socket.readyState !== 1) throw new WhisperClientError(ErrorCode.UNAVAILABLE, "UNAVAILABLE", "The WhisperService session is not connected.");
    }

    function sendControl(type) {
      ensureOpen();
      socket.send(JSON.stringify({ version: PROTOCOL_VERSION, type }));
    }

    // Resolves to an explicit { ok, reason } outcome rather than bare success, so a caller
    // (e.g. a Finish workflow) can distinguish a server-confirmed close from an unexpected
    // disconnect or a settlement that had to be forced by the bounded timeout.
    function settle(targetState) {
      if (state === "closed") return Promise.resolve(terminalOutcome || { ok: false, reason: "unknown" });
      if (settlePromise) return settlePromise;
      state = targetState;
      settlePromise = new Promise((resolve) => {
        const settlementTimer = globalThis.setTimeout(() => {
          diagnose(`${targetState}-settlement-timeout`);
          recordTerminalOutcome({ ok: false, reason: "timeout" });
          // The server never confirmed closure; force the transport shut so the
          // caller's bounded wait cannot outlive an unresponsive service.
          try {
            socket.close();
          } catch {
            // Nothing further to release locally.
          }
          settleNow();
        }, SETTLEMENT_TIMEOUT_MS);
        resolveSettle = () => {
          globalThis.clearTimeout(settlementTimer);
          resolve(terminalOutcome || { ok: false, reason: "unknown" });
        };
      });
      return settlePromise;
    }

    function sendPcm16(data) {
      ensureOpen();
      const byteLength = data instanceof ArrayBuffer ? data.byteLength : data?.byteLength;
      if (!byteLength || byteLength % 2 !== 0) {
        throw new WhisperClientError(ErrorCode.CLIENT, "INVALID_AUDIO", "PCM16 frames must contain a positive, even number of bytes.");
      }
      if (byteLength > MAX_PCM_FRAME_BYTES) {
        throw new WhisperClientError(ErrorCode.CLIENT, "INVALID_AUDIO", `PCM16 frames must not exceed ${MAX_PCM_FRAME_BYTES} bytes.`);
      }
      socket.send(data);
    }

    function flush() {
      sendControl("flush");
    }

    function stop() {
      // Only the transition that actually moves the session out of "ready" sends the
      // control frame; a repeated or racing call just joins the same settlement instead
      // of resending stop/cancel or reporting a second, possibly different, outcome.
      if (state === "ready") {
        // A stale error from earlier in the (still-healthy) dictation session must not
        // fail a clean stop that happens later; only errors seen during this stop's own
        // settlement window should count.
        lastServiceError = null;
        try {
          sendControl("stop");
        } catch {
          recordTerminalOutcome({ ok: false, reason: "disconnected" });
        }
      }
      return settle("stopping");
    }

    function cancel() {
      if (state === "ready") {
        suppressFutureTranscripts = true;
        try {
          sendControl("cancel");
        } catch {
          recordTerminalOutcome({ ok: false, reason: "disconnected" });
        }
      } else {
        suppressFutureTranscripts = true; // guarantee no transcript leaks even if cancel races a prior stop
      }
      return settle("cancelling");
    }

    function close() {
      globalThis.clearTimeout(connectTimer);
      if (state === "closed") return;
      state = "closed";
      recordTerminalOutcome({ ok: false, reason: "closed-locally" });
      try {
        socket.close();
      } catch {
        // Nothing further to release locally.
      }
      settleNow();
    }

    controllerRef = {
      get sessionId() {
        return descriptor.sessionId;
      },
      get previewMs() {
        return descriptor.previewMs;
      },
      get state() {
        return state;
      },
      ready,
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      sendPcm16,
      flush,
      stop,
      cancel,
      close
    };
    return controllerRef;
  }

  const NOOP_CANCEL_HTTP = () => Promise.resolve();

  // Token-free: connects to an already-created session using only its descriptor. This is
  // the half of session setup an offscreen document (or any context without the bearer
  // token) can call directly, after receiving the descriptor from whichever context called
  // createSessionDescriptor(). The descriptor is re-validated here because it may have
  // crossed an extension-message boundary since it was first produced.
  async function connectSession(descriptor, { onEvent, onClientError, cancelHttp = NOOP_CANCEL_HTTP } = {}) {
    const controller = createSessionController({ descriptor: validateSessionDescriptor(descriptor), cancelHttp, onEvent, onClientError });
    await controller.ready;
    return controller;
  }

  function create({ token, baseUrl = DEFAULT_BASE_URL } = {}) {
    if (!token) throw new TypeError("A WhisperService bearer token is required.");
    const normalizedBaseUrl = baseUrl.replace(/\/$/, "");

    async function health() {
      const body = await authorizedRequest({ baseUrl: normalizedBaseUrl, token, path: "/v1/health", method: "GET", timeoutMs: HTTP_REQUEST_TIMEOUT_MS });
      return validateHealth(body);
    }

    async function cancelSession(sessionId) {
      await authorizedRequest({ baseUrl: normalizedBaseUrl, token, path: `/v1/sessions/${encodeURIComponent(sessionId)}`, method: "DELETE", timeoutMs: HTTP_REQUEST_TIMEOUT_MS });
    }

    // HTTP-only half of session setup: this is the call a token-holding context (the
    // background service worker) makes on its own, before handing just the resulting
    // descriptor - never the token - to whichever context will call connectSession().
    async function createSessionDescriptor({ previewMs } = {}) {
      const requestBody = previewMs === undefined ? { version: PROTOCOL_VERSION } : { version: PROTOCOL_VERSION, previewMs };
      return validateSessionDescriptor(
        await authorizedRequest({ baseUrl: normalizedBaseUrl, token, path: "/v1/sessions", method: "POST", body: requestBody, timeoutMs: HTTP_REQUEST_TIMEOUT_MS })
      );
    }

    // Convenience for a single-context caller (e.g. a same-process smoke test): combines
    // both halves. Cross-context callers should call createSessionDescriptor() and
    // connectSession() separately instead of this.
    async function createSession({ previewMs, onEvent, onClientError } = {}) {
      const descriptor = await createSessionDescriptor({ previewMs });
      return connectSession(descriptor, { onEvent, onClientError, cancelHttp: () => cancelSession(descriptor.sessionId) });
    }

    return { health, createSessionDescriptor, createSession, cancelSession };
  }

  globalThis.SaySlateWhisperClient = { create, connectSession, ErrorCode, WhisperClientError };
})();
