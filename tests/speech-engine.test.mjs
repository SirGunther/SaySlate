import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(extensionRoot, "speechEngine.js"), "utf8");

function createHarness() {
  const timers = new Map();
  let nextTimer = 1;
  const instances = [];

  class FakeRecognition {
    constructor() {
      this.startCalls = 0;
      this.stopCalls = 0;
      this.abortCalls = 0;
      instances.push(this);
    }
    start() { this.startCalls += 1; }
    stop() { this.stopCalls += 1; this.onend?.(); }
    abort() { this.abortCalls += 1; this.onend?.(); }
  }

  const context = vm.createContext({
    console,
    navigator: { language: "en-US" },
    setTimeout(callback) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    SpeechRecognition: FakeRecognition
  });
  context.globalThis = context;
  vm.runInContext(source, context);

  return {
    api: context.SaySlateSpeech,
    instances,
    runTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach((callback) => callback());
    },
    get timerCount() { return timers.size; }
  };
}

{
  const harness = createHarness();
  const states = [];
  const controller = harness.api.create({
    onStart: (detail) => states.push(["start", detail.recovered]),
    onRetry: (detail) => states.push(["retry", detail.error]),
    onSessionEnd: () => states.push(["end"])
  });
  assert.equal(controller.start(), true);
  const recognition = harness.instances[0];
  recognition.onstart();
  recognition.onerror({ error: "network" });
  recognition.onend();
  assert.equal(harness.timerCount, 1);
  assert.deepEqual(states.slice(-2), [["end"], ["retry", "network"]]);
  harness.runTimers();
  assert.equal(recognition.startCalls, 2);
  recognition.onstart();
  assert.deepEqual(states.at(-1), ["start", true]);
}

{
  const harness = createHarness();
  let fatal = "";
  const controller = harness.api.create({ onFatalError: (error) => { fatal = error; } });
  controller.start();
  const recognition = harness.instances[0];
  recognition.onstart();
  recognition.onerror({ error: "not-allowed" });
  recognition.onend();
  assert.equal(fatal, "not-allowed");
  assert.equal(harness.timerCount, 0);
  assert.equal(controller.listening, false);
}

{
  const harness = createHarness();
  const controller = harness.api.create();
  controller.start();
  const recognition = harness.instances[0];
  recognition.onstart();
  recognition.onerror({ error: "network" });
  recognition.onend();
  assert.equal(harness.timerCount, 1);
  await controller.stop();
  assert.equal(harness.timerCount, 0);
  harness.runTimers();
  assert.equal(recognition.startCalls, 1);
}

console.log("Recoverable speech recognition restart, fatal error, and explicit stop paths verified.");
