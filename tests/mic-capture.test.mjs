import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(extensionRoot, "micCapture.js"), "utf8");

class FakeTrack {
  constructor() {
    this.stopped = false;
  }
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  constructor(trackCount = 1) {
    this.tracks = Array.from({ length: trackCount }, () => new FakeTrack());
  }
  getTracks() {
    return this.tracks;
  }
}

class FakePort {
  constructor() {
    this.onmessage = null;
    this.posted = [];
  }
  postMessage(data) {
    this.posted.push(data);
  }
  receive(data) {
    this.onmessage?.({ data });
  }
}

function createHarness({ getUserMediaImpl, addModuleImpl } = {}) {
  const events = [];
  let lastWorkletNode = null;
  let lastAudioContext = null;

  class FakeAudioWorkletNode {
    constructor(context, name, options) {
      events.push(["createNode", name, options]);
      this.port = new FakePort();
      this.connections = [];
      this.disconnected = false;
      lastWorkletNode = this;
    }
    connect(target) {
      this.connections.push(target);
    }
    disconnect() {
      this.disconnected = true;
    }
  }

  class FakeSourceNode {
    constructor() {
      this.connections = [];
      this.disconnected = false;
    }
    connect(target) {
      this.connections.push(target);
    }
    disconnect() {
      this.disconnected = true;
    }
  }

  class FakeAudioContext {
    constructor() {
      this.state = "running";
      this.destination = { kind: "destination" };
      this.closeCalls = 0;
      this.audioWorklet = {
        addModule: addModuleImpl || (async (url) => { events.push(["addModule", url]); })
      };
      lastAudioContext = this;
    }
    createMediaStreamSource() {
      return new FakeSourceNode();
    }
    async close() {
      this.closeCalls += 1;
      this.state = "closed";
    }
  }

  const mediaDevices = {
    getUserMedia: getUserMediaImpl || (async () => new FakeStream())
  };

  const timers = new Map();
  let nextTimer = 1;

  const context = vm.createContext({
    console,
    chrome: { runtime: { getURL: (file) => `chrome-extension://fake-id/${file}` } },
    setTimeout(callback, delay) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    }
  });
  context.globalThis = context;
  vm.runInContext(source, context);

  return {
    api: context.SaySlateMicCapture,
    mediaDevices,
    AudioContextImpl: FakeAudioContext,
    AudioWorkletNodeImpl: FakeAudioWorkletNode,
    events,
    get lastWorkletNode() { return lastWorkletNode; },
    get lastAudioContext() { return lastAudioContext; },
    runTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach((callback) => callback());
    },
    get timerCount() { return timers.size; }
  };
}

// Objects created inside the vm-sandboxed source have a different realm's Object.prototype,
// which fails assert.deepEqual's prototype check even when the data is identical. Normalizing
// through JSON strips the realm-specific prototype for these plain-data comparisons.
function toPlain(value) {
  return JSON.parse(JSON.stringify(value));
}

function createController(harness, overrides = {}) {
  return harness.api.create({
    mediaDevices: harness.mediaDevices,
    AudioContextImpl: harness.AudioContextImpl,
    AudioWorkletNodeImpl: harness.AudioWorkletNodeImpl,
    ...overrides
  });
}

// Successful start wires source -> worklet -> destination and delivers pcm chunks
{
  const harness = createHarness();
  const chunks = [];
  const controller = createController(harness, { onChunk: (bytes) => chunks.push(bytes) });

  const started = await controller.start();
  assert.equal(started, true);
  assert.equal(controller.active, true);
  assert.equal(harness.events.length, 3);
  assert.deepEqual(harness.events[0], ["addModule", "chrome-extension://fake-id/pcmAudioProcessor.js"]);
  assert.deepEqual(harness.events[1], ["addModule", "chrome-extension://fake-id/micCaptureWorklet.js"]);
  const [kind, processorName, nodeOptions] = harness.events[2];
  assert.equal(kind, "createNode");
  assert.equal(processorName, "sayslate-mic-capture-processor");
  assert.equal(nodeOptions.numberOfInputs, 1);
  assert.equal(nodeOptions.numberOfOutputs, 1);
  assert.equal(nodeOptions.channelCount, 1);
  assert.deepEqual({ ...nodeOptions.processorOptions }, {});

  const node = harness.lastWorkletNode;
  assert.equal(node.connections[0], harness.lastAudioContext.destination);

  node.port.receive({ type: "pcm", bytes: new Uint8Array([1, 2, 3]) });
  assert.equal(chunks.length, 1);
  assert.deepEqual([...chunks[0]], [1, 2, 3]);
}

// Repeated start() while already active is a harmless no-op
{
  const harness = createHarness();
  const controller = createController(harness);
  await controller.start();
  const nodeCountBefore = harness.events.filter(([kind]) => kind === "createNode").length;
  const secondStart = await controller.start();
  assert.equal(secondStart, true);
  assert.equal(harness.events.filter(([kind]) => kind === "createNode").length, nodeCountBefore);
}

// Permission denied is surfaced distinctly and never falls back
{
  const harness = createHarness({
    getUserMediaImpl: async () => { const error = new Error("denied"); error.name = "NotAllowedError"; throw error; }
  });
  const errors = [];
  const controller = createController(harness, { onError: (error) => errors.push(error) });
  const started = await controller.start();
  assert.equal(started, false);
  assert.equal(controller.active, false);
  assert.deepEqual(toPlain(errors), [{ code: "permission-denied", message: "Microphone permission was denied." }]);
}

// Missing device is surfaced distinctly
{
  const harness = createHarness({
    getUserMediaImpl: async () => { const error = new Error("none"); error.name = "NotFoundError"; throw error; }
  });
  const errors = [];
  const controller = createController(harness, { onError: (error) => errors.push(error) });
  await controller.start();
  assert.equal(errors[0].code, "device-missing");
}

// AudioContext/worklet failure tears down the already-acquired stream (cleanup on a failure exit path)
{
  let capturedStream = null;
  const harness = createHarness({
    getUserMediaImpl: async () => { capturedStream = new FakeStream(2); return capturedStream; },
    addModuleImpl: async () => { throw new Error("worklet failed to load"); }
  });
  const errors = [];
  const controller = createController(harness, { onError: (error) => errors.push(error) });
  const started = await controller.start();
  assert.equal(started, false);
  assert.deepEqual(toPlain(errors), [{ code: "audio-context-failed", message: "Microphone capture could not be started." }]);
  assert.ok(capturedStream.getTracks().every((track) => track.stopped));
}

// stop() sends the stop control, waits for "stopped", then tears down tracks/nodes/context
{
  const harness = createHarness();
  const controller = createController(harness);
  await controller.start();
  const node = harness.lastWorkletNode;
  const context = harness.lastAudioContext;

  const stopPromise = controller.stop();
  assert.deepEqual(toPlain(node.port.posted.at(-1)), { type: "stop" });
  assert.equal(context.closeCalls, 0); // not torn down until settlement arrives

  node.port.receive({ type: "stopped" });
  await stopPromise;

  assert.equal(controller.active, false);
  assert.equal(node.disconnected, true);
  assert.equal(context.closeCalls, 1);
}

// stop() is bounded by a timeout when the worklet never replies
{
  const harness = createHarness();
  const controller = createController(harness, { stopTimeoutMs: 50 });
  await controller.start();
  const context = harness.lastAudioContext;

  const stopPromise = controller.stop();
  assert.equal(harness.timerCount, 1);
  harness.runTimers();
  await stopPromise;
  assert.equal(context.closeCalls, 1);
}

// Concurrent stop() callers both resolve exactly once settlement occurs
{
  const harness = createHarness();
  const controller = createController(harness);
  await controller.start();
  const node = harness.lastWorkletNode;

  let firstResolved = false;
  let secondResolved = false;
  const first = controller.stop().then(() => { firstResolved = true; });
  const second = controller.stop().then(() => { secondResolved = true; });
  node.port.receive({ type: "stopped" });
  await Promise.all([first, second]);
  assert.equal(firstResolved, true);
  assert.equal(secondResolved, true);
}

// cancel() tears down immediately and a subsequent stray pcm message is ignored by the caller
{
  const harness = createHarness();
  const chunks = [];
  const controller = createController(harness, { onChunk: (bytes) => chunks.push(bytes) });
  await controller.start();
  const node = harness.lastWorkletNode;
  const context = harness.lastAudioContext;

  controller.cancel();
  assert.deepEqual(toPlain(node.port.posted.at(-1)), { type: "cancel" });
  assert.equal(controller.active, false);
  assert.equal(context.closeCalls, 1);

  // A stray pcm message racing in after cancel must not reach the caller.
  node.port.onmessage?.({ data: { type: "pcm", bytes: new Uint8Array([9]) } });
  assert.equal(chunks.length, 0);
}

// cancel()/stop() tolerate being called when already idle
{
  const harness = createHarness();
  const controller = createController(harness);
  controller.cancel();
  await controller.stop();
  assert.equal(controller.active, false);
}

// stop()/cancel() called while start() is still in-flight abort the start instead of racing it
{
  let resolveGetUserMedia;
  const harness = createHarness({
    getUserMediaImpl: () => new Promise((resolve) => { resolveGetUserMedia = resolve; })
  });
  const controller = createController(harness);
  const startPromise = controller.start();
  const stopPromise = controller.stop();
  resolveGetUserMedia(new FakeStream(1));
  const [started] = await Promise.all([startPromise, stopPromise]);
  assert.equal(started, false);
  assert.equal(controller.active, false);
  assert.equal(harness.events.filter(([kind]) => kind === "createNode").length, 0);
}

// stop() during "starting" resolves immediately (no indefinite wait on a stuck permission
// prompt). A subsequent, legitimate start() must be fully unaffected when the abandoned
// attempt's getUserMedia call eventually resolves in the background.
{
  const pendingResolvers = [];
  const harness = createHarness({
    getUserMediaImpl: () => new Promise((resolve) => { pendingResolvers.push(resolve); })
  });
  const controller = createController(harness);

  const firstStart = controller.start();
  const stopStart = Date.now();
  await controller.stop();
  assert.ok(Date.now() - stopStart < 500); // resolves immediately, not bounded by a multi-second timer
  assert.equal(controller.active, false);

  const secondStart = controller.start();
  pendingResolvers[1](new FakeStream(1)); // the second, legitimate attempt's getUserMedia
  const started = await secondStart;
  assert.equal(started, true);
  assert.equal(controller.active, true);
  const activeNode = harness.lastWorkletNode;
  const activeContext = harness.lastAudioContext;

  // The first attempt's getUserMedia finally resolves, long after it was abandoned.
  const orphanedStream = new FakeStream(1);
  pendingResolvers[0](orphanedStream);
  await firstStart;

  // The still-active second attempt must be untouched: its own stream/context/node survive.
  assert.equal(controller.active, true);
  assert.equal(activeContext.closeCalls, 0);
  assert.equal(activeNode.disconnected, false);
  // Only the orphaned first attempt's own stream was released.
  assert.ok(orphanedStream.getTracks().every((track) => track.stopped));
}

// Regression: start 1 -> stop -> start 2 -> start 1's orphaned finally() must not clobber
// start 2's still-pending promise with null while a caller is relying on it.
{
  const pendingResolvers = [];
  const harness = createHarness({
    getUserMediaImpl: () => new Promise((resolve) => { pendingResolvers.push(resolve); })
  });
  const controller = createController(harness);

  const firstStart = controller.start();
  await controller.stop();

  const secondStart = controller.start(); // still pending: its getUserMedia has not resolved yet

  // Start 1's abandoned getUserMedia call finally resolves and its attempt settles.
  pendingResolvers[0](new FakeStream(1));
  await firstStart;

  // A repeated start() while start 2 is still in flight must return start 2's real promise,
  // not null (which a caller could only await as undefined).
  const repeatedStart = controller.start();
  assert.ok(repeatedStart !== null && typeof repeatedStart.then === "function");
  assert.equal(repeatedStart, secondStart);

  pendingResolvers[1](new FakeStream(1)); // start 2's own getUserMedia
  const [secondResult, repeatedResult] = await Promise.all([secondStart, repeatedStart]);
  assert.equal(secondResult, true);
  assert.equal(repeatedResult, true);
  assert.equal(controller.active, true);
  assert.equal(harness.events.filter(([kind]) => kind === "createNode").length, 1);
}

// A worklet-reported invalid-audio-data error is surfaced distinctly, without leaking bytes
{
  const harness = createHarness();
  const errors = [];
  const controller = createController(harness, { onError: (error) => errors.push(error) });
  await controller.start();
  const node = harness.lastWorkletNode;
  node.port.receive({ type: "error", message: "bad frame" });
  assert.deepEqual(toPlain(errors), [{ code: "invalid-audio-data", message: "bad frame" }]);
}

console.log("Mic capture lifecycle, error mapping, stop/cancel settlement, and cleanup verified.");
