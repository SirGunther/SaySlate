(() => {
  "use strict";

  const PROCESSOR_NAME = "sayslate-mic-capture-processor";
  const DEFAULT_WORKLET_FILES = ["pcmAudioProcessor.js", "micCaptureWorklet.js"];
  const DEFAULT_STOP_TIMEOUT_MS = 2_000; // bounds stop() if the worklet never replies (e.g. context already lost)

  const ERROR_CODES = Object.freeze({
    PERMISSION_DENIED: "permission-denied",
    DEVICE_MISSING: "device-missing",
    AUDIO_CONTEXT_FAILED: "audio-context-failed",
    INVALID_AUDIO_DATA: "invalid-audio-data"
  });

  function resolveWorkletUrls(options) {
    if (Array.isArray(options.workletModuleUrls) && options.workletModuleUrls.length) {
      return options.workletModuleUrls;
    }
    const getURL = globalThis.chrome?.runtime?.getURL;
    if (!getURL) {
      throw new Error("No worklet module URLs were provided and chrome.runtime.getURL is unavailable.");
    }
    return DEFAULT_WORKLET_FILES.map((file) => getURL(file));
  }

  function mapGetUserMediaError(error) {
    const name = error?.name || "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
      return { code: ERROR_CODES.PERMISSION_DENIED, message: "Microphone permission was denied." };
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
      return { code: ERROR_CODES.DEVICE_MISSING, message: "No usable microphone device was found." };
    }
    return { code: ERROR_CODES.AUDIO_CONTEXT_FAILED, message: "Microphone capture could not be started." };
  }

  // Tears down a not-yet-committed attempt's own local resources. Used when an attempt is
  // abandoned (stop/cancel arrived mid-flight) so it never touches the shared, currently-owned
  // stream/context/nodes of whatever attempt (if any) holds them now.
  function teardownLocal({ stream, audioContext, sourceNode, workletNode }) {
    if (workletNode) {
      workletNode.port.onmessage = null;
      try {
        workletNode.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    if (sourceNode) {
      try {
        sourceNode.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
    }
    if (audioContext && audioContext.state !== "closed") {
      void audioContext.close().catch(() => {});
    }
  }

  function create(options = {}) {
    const mediaDevices = options.mediaDevices || globalThis.navigator?.mediaDevices;
    const AudioContextImpl = options.AudioContextImpl || globalThis.AudioContext || globalThis.webkitAudioContext;
    const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;

    let state = "idle"; // idle -> starting -> active -> stopping -> idle
    let generation = 0; // bumped to invalidate an in-flight attemptStart() when stop/cancel arrives mid-flight
    let waiters = []; // resolvers for whoever is awaiting the current stop() settlement
    let startInFlight = null; // the pending start() promise, shared with any repeat caller
    let stream = null;
    let audioContext = null;
    let sourceNode = null;
    let workletNode = null;
    let stopTimer = null;

    function emit(name, ...args) {
      options[name]?.(...args);
    }

    function resolveWaiters() {
      clearStopTimer();
      const pending = waiters;
      waiters = [];
      pending.forEach((resolve) => resolve());
    }

    function clearStopTimer() {
      if (stopTimer === null) return;
      globalThis.clearTimeout(stopTimer);
      stopTimer = null;
    }

    // Tears down the currently-committed (active) capture. Only ever called while this instance
    // owns stream/audioContext/nodes outright (i.e. after attemptStart() has committed them).
    function teardown() {
      clearStopTimer();
      teardownLocal({ stream, audioContext, sourceNode, workletNode });
      workletNode = null;
      sourceNode = null;
      stream = null;
      audioContext = null;
      state = "idle";
    }

    function handleWorkletMessage(message) {
      if (message?.type === "pcm") {
        if (state === "active" || state === "stopping") emit("onChunk", message.bytes);
        return;
      }
      if (message?.type === "stopped") {
        teardown();
        resolveWaiters();
        return;
      }
      if (message?.type === "cancelled") {
        return;
      }
      if (message?.type === "error") {
        emit("onError", { code: ERROR_CODES.INVALID_AUDIO_DATA, message: message.message || "Invalid audio data." });
      }
    }

    function start() {
      if (state === "active") return Promise.resolve(true);
      if (state === "starting") return startInFlight; // repeat caller awaits the real outcome, not a guess
      if (state === "stopping") return Promise.resolve(false);
      if (!mediaDevices?.getUserMedia) {
        emit("onError", { code: ERROR_CODES.DEVICE_MISSING, message: "No microphone input is available." });
        return Promise.resolve(false);
      }
      if (!AudioContextImpl) {
        emit("onError", { code: ERROR_CODES.AUDIO_CONTEXT_FAILED, message: "The Web Audio API is unavailable." });
        return Promise.resolve(false);
      }

      let wrapped;
      wrapped = attemptStart().finally(() => {
        // Only clear the slot if it still points at this attempt: stop() during "starting"
        // abandons the attempt without clearing startInFlight, so a later, legitimate start()
        // may already have registered its own promise here by the time this one settles.
        if (startInFlight === wrapped) startInFlight = null;
      });
      startInFlight = wrapped;
      return wrapped;
    }

    // Every resource acquired here stays local until the very end, where it is committed to the
    // shared stream/audioContext/*Node variables only if this attempt is still current. That way
    // an attempt abandoned by stop()/cancel() (see below) can clean up strictly its own resources
    // without ever touching a different, still-active attempt's state.
    async function attemptStart() {
      const myGeneration = ++generation;
      state = "starting";

      let localStream;
      try {
        localStream = await mediaDevices.getUserMedia({
          audio: { channelCount: { ideal: 1 }, echoCancellation: true, noiseSuppression: true },
          video: false
        });
      } catch (error) {
        if (myGeneration === generation) {
          state = "idle";
          emit("onError", mapGetUserMediaError(error));
        }
        return false;
      }

      if (myGeneration !== generation) {
        teardownLocal({ stream: localStream });
        return false;
      }

      let localAudioContext;
      let localSourceNode;
      let localWorkletNode;
      try {
        localAudioContext = new AudioContextImpl();
        const workletUrls = resolveWorkletUrls(options);
        for (const url of workletUrls) {
          await localAudioContext.audioWorklet.addModule(url);
          if (myGeneration !== generation) throw new Error("start aborted");
        }

        localSourceNode = localAudioContext.createMediaStreamSource(localStream);
        const WorkletNodeImpl = options.AudioWorkletNodeImpl || globalThis.AudioWorkletNode;
        localWorkletNode = new WorkletNodeImpl(localAudioContext, PROCESSOR_NAME, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
          processorOptions: options.chunkBytes ? { chunkBytes: options.chunkBytes } : {}
        });

        localSourceNode.connect(localWorkletNode);
        // The worklet writes no output samples (silence); connecting to the destination
        // keeps the node in the active render graph without producing an audible echo.
        localWorkletNode.connect(localAudioContext.destination);
      } catch {
        const aborted = myGeneration !== generation;
        teardownLocal({
          stream: localStream,
          audioContext: localAudioContext,
          sourceNode: localSourceNode,
          workletNode: localWorkletNode
        });
        if (!aborted) {
          state = "idle";
          emit("onError", { code: ERROR_CODES.AUDIO_CONTEXT_FAILED, message: "Microphone capture could not be started." });
        }
        return false;
      }

      if (myGeneration !== generation) {
        teardownLocal({
          stream: localStream,
          audioContext: localAudioContext,
          sourceNode: localSourceNode,
          workletNode: localWorkletNode
        });
        return false;
      }

      stream = localStream;
      audioContext = localAudioContext;
      sourceNode = localSourceNode;
      workletNode = localWorkletNode;
      workletNode.port.onmessage = (event) => handleWorkletMessage(event.data);
      state = "active";
      return true;
    }

    function stop() {
      if (state === "idle") return Promise.resolve();
      if (state === "starting") {
        // getUserMedia has no abort mechanism, so the in-flight attemptStart() cannot be
        // interrupted. It is simply abandoned: bumping generation makes it clean up only its
        // own local resources (see attemptStart) whenever it eventually settles, and never touch
        // shared state again. Nothing has been committed yet, so there is nothing to await here
        // and stop() can resolve immediately instead of risking an indefinite hang.
        generation += 1;
        state = "idle";
        return Promise.resolve();
      }
      if (state === "stopping") {
        return new Promise((resolve) => waiters.push(resolve));
      }

      state = "stopping";
      return new Promise((resolve) => {
        waiters.push(resolve);
        if (!workletNode) {
          teardown();
          resolveWaiters();
          return;
        }
        stopTimer = globalThis.setTimeout(() => {
          teardown();
          resolveWaiters();
        }, stopTimeoutMs);
        try {
          workletNode.port.postMessage({ type: "stop" });
        } catch {
          teardown();
          resolveWaiters();
        }
      });
    }

    function cancel() {
      if (state === "idle") return;
      if (state === "starting") {
        generation += 1; // see stop(): the in-flight attemptStart() cleans up its own resources
        state = "idle";
        return;
      }
      if (workletNode) {
        try {
          workletNode.port.postMessage({ type: "cancel" });
        } catch {
          // Node is already gone; teardown below still cleans up.
        }
      }
      teardown();
      resolveWaiters();
    }

    return {
      start,
      stop,
      cancel,
      get active() {
        return state === "active";
      }
    };
  }

  globalThis.SaySlateMicCapture = {
    create,
    errorCodes: ERROR_CODES
  };
})();
