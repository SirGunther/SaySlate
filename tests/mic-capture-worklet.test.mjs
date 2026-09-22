import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pcmSource = fs.readFileSync(path.join(extensionRoot, "pcmAudioProcessor.js"), "utf8");
const workletSource = fs.readFileSync(path.join(extensionRoot, "micCaptureWorklet.js"), "utf8");

class FakePort {
  constructor() {
    this.onmessage = null;
    this.posted = [];
  }
  postMessage(data, transfer) {
    this.posted.push({ data, transfer });
  }
  receive(data) {
    this.onmessage?.({ data });
  }
}

function createHarness({ sampleRate = 48000 } = {}) {
  const registry = new Map();

  class FakeAudioWorkletProcessor {
    constructor() {
      this.port = new FakePort();
    }
  }

  const context = vm.createContext({
    console,
    sampleRate,
    AudioWorkletProcessor: FakeAudioWorkletProcessor,
    registerProcessor(name, ctor) {
      registry.set(name, ctor);
    }
  });
  context.globalThis = context;

  // Production load order in offscreen.html: the pure DSP module first, then the processor.
  vm.runInContext(pcmSource, context);
  vm.runInContext(workletSource, context);

  const Processor = registry.get("sayslate-mic-capture-processor");
  return { Processor };
}

function monoBlock(values) {
  return [Float32Array.from(values)];
}

// Emits bounded PCM chunks for real input, respects chunkBytes option
{
  const { Processor } = createHarness({ sampleRate: 16000 });
  const processor = new Processor({ processorOptions: { chunkBytes: 4 } });
  const pcmMessages = () => processor.port.posted.filter((entry) => entry.data.type === "pcm");

  const keepRunning = processor.process([monoBlock([0.1, 0.2, 0.3, 0.4, 0.5])]);
  assert.equal(keepRunning, true);
  const chunks = pcmMessages();
  assert.ok(chunks.length >= 1);
  for (const { data, transfer } of chunks) {
    assert.ok(data.bytes.length <= 4);
    assert.equal(transfer.length, 1);
    assert.ok(transfer[0] === data.bytes.buffer); // posted as a transferable, not structurally cloned
  }
}

// Silent/disconnected input (no channels) does not throw and keeps the node alive
{
  const { Processor } = createHarness();
  const processor = new Processor({});
  const keepRunning = processor.process([[]]);
  assert.equal(keepRunning, true);
  assert.equal(processor.port.posted.length, 0);
}

// stop() flushes the buffered remainder then posts "stopped"; process() afterward is inert
{
  const { Processor } = createHarness({ sampleRate: 16000 });
  const processor = new Processor({ processorOptions: { chunkBytes: 4096 } });
  processor.process([monoBlock([0.1, 0.1, 0.1])]); // well under one chunk, stays buffered

  processor.port.receive({ type: "stop" });
  const posted = processor.port.posted;
  assert.equal(posted.at(-1).data.type, "stopped");
  const flushedPcm = posted.filter((entry) => entry.data.type === "pcm");
  assert.equal(flushedPcm.length, 1);
  assert.ok(flushedPcm[0].data.bytes.length > 0);

  const postedCountBeforeReprocess = processor.port.posted.length;
  const keepRunning = processor.process([monoBlock([0.5, 0.5])]);
  assert.equal(keepRunning, false);
  assert.equal(processor.port.posted.length, postedCountBeforeReprocess);
}

// cancel() discards buffered audio and never emits a trailing pcm message
{
  const { Processor } = createHarness({ sampleRate: 16000 });
  const processor = new Processor({ processorOptions: { chunkBytes: 4096 } });
  processor.process([monoBlock([0.2, 0.2, 0.2])]); // buffered, below chunk size

  processor.port.receive({ type: "cancel" });
  const posted = processor.port.posted;
  assert.deepEqual(posted.map((entry) => entry.data.type), ["cancelled"]);

  const keepRunning = processor.process([monoBlock([0.9, 0.9])]);
  assert.equal(keepRunning, false);
  assert.equal(processor.port.posted.length, 1); // no additional messages after cancel
}

// A duplicate stop/cancel control after settling is a no-op (idempotent)
{
  const { Processor } = createHarness({ sampleRate: 16000 });
  const processor = new Processor({ processorOptions: { chunkBytes: 4096 } });
  processor.port.receive({ type: "stop" });
  const countAfterFirstStop = processor.port.posted.length;
  processor.port.receive({ type: "stop" });
  processor.port.receive({ type: "cancel" });
  assert.equal(processor.port.posted.length, countAfterFirstStop);
}

console.log("Mic capture worklet chunk emission, stop flush, cancel discard, and idempotence verified.");
