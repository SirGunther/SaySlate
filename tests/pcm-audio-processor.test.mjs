import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(extensionRoot, "pcmAudioProcessor.js"), "utf8");

function createHarness() {
  const context = vm.createContext({ console });
  context.globalThis = context;
  vm.runInContext(source, context);
  return context.SaySlatePcmAudio;
}

function readInt16LE(bytes, index) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt16(index * 2, true);
}

function assertCloseArrays(actual, expected, tolerance = 1e-6) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => {
    assert.ok(Math.abs(value - expected[index]) < tolerance, `index ${index}: ${value} !~= ${expected[index]}`);
  });
}

// downmixToMono
{
  const api = createHarness();

  const mono = api.downmixToMono([Float32Array.from([0.1, -0.2, 0.3])]);
  assertCloseArrays([...mono], [0.1, -0.2, 0.3]);

  const stereo = api.downmixToMono([
    Float32Array.from([1, 0, -1]),
    Float32Array.from([0, 1, -1])
  ]);
  assertCloseArrays([...stereo], [0.5, 0.5, -1]);

  const three = api.downmixToMono([
    Float32Array.from([1, 1]),
    Float32Array.from([0, 1]),
    Float32Array.from([-1, 1])
  ]);
  assertCloseArrays([...three], [0, 1]);

  const empty = api.downmixToMono([]);
  assert.equal(empty.length, 0);
}

// floatTo16BitPcm — clipping and little-endian byte order
{
  const api = createHarness();
  const bytes = api.floatTo16BitPcm(Float32Array.from([0, 1, -1, 2, -2, 0.5, -0.5]));
  assert.equal(bytes.length, 14);
  assert.equal(readInt16LE(bytes, 0), 0);
  assert.equal(readInt16LE(bytes, 1), 32767); // +1.0 clamps to max positive int16
  assert.equal(readInt16LE(bytes, 2), -32768); // -1.0 maps to min negative int16
  assert.equal(readInt16LE(bytes, 3), 32767); // overshoot clips, does not wrap
  assert.equal(readInt16LE(bytes, 4), -32768); // undershoot clips, does not wrap
  assert.equal(readInt16LE(bytes, 5), 16384); // 0.5 * 32768 rounded
  assert.equal(readInt16LE(bytes, 6), -16384);

  // Explicit endianness check: +1.0 -> 0x7FFF stored little-endian as [0xFF, 0x7F]
  assert.equal(bytes[2], 0xff);
  assert.equal(bytes[3], 0x7f);

  const empty = api.floatTo16BitPcm(new Float32Array(0));
  assert.equal(empty.length, 0);
}

// createResampler — exact decimation (downsampling by an integer factor)
{
  const api = createHarness();
  const resampler = api.createResampler(16000);
  const input = Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
  const output = resampler.process(input, 32000); // step = 2
  assertCloseArrays([...output], [0, 2, 4, 6]);
}

// createResampler — linear-interpolation upsampling
{
  const api = createHarness();
  const resampler = api.createResampler(16000);
  const input = Float32Array.from([0, 1, 0, -1]);
  const output = resampler.process(input, 8000); // step = 0.5
  const expected = [0, 0.5, 1, 0.5, 0, -0.5, -1];
  assert.equal(output.length, expected.length);
  output.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-9, `index ${index}`));
}

// createResampler — same-rate passthrough
{
  const api = createHarness();
  const resampler = api.createResampler(16000);
  const input = Float32Array.from([0.1, 0.2, 0.3, 0.4]);
  const output = resampler.process(input, 16000);
  assertCloseArrays([...output], [...input]);
}

// createResampler — continuity across two calls matches one call on the concatenated signal
{
  const api = createHarness();
  const full = Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const wholeResampler = api.createResampler(16000);
  const wholeOutput = wholeResampler.process(full, 24000); // step = 1.5, non-integer

  const splitResampler = api.createResampler(16000);
  const firstHalf = splitResampler.process(full.slice(0, 4), 24000);
  const secondHalf = splitResampler.process(full.slice(4), 24000);
  const splitOutput = Float32Array.from([...firstHalf, ...secondHalf]);

  assert.equal(splitOutput.length, wholeOutput.length);
  splitOutput.forEach((value, index) => assert.ok(Math.abs(value - wholeOutput[index]) < 1e-9, `index ${index}`));
}

// createChunker — bounds emission, buffers remainder, validates chunkBytes
{
  const api = createHarness();
  const chunker = api.createChunker(4);
  const first = chunker.append(Uint8Array.from([1, 2, 3]));
  assert.deepEqual([...first], []);
  const second = chunker.append(Uint8Array.from([4, 5, 6]));
  assert.equal(second.length, 1);
  assert.deepEqual([...second[0]], [1, 2, 3, 4]);
  const remainder = chunker.flush();
  assert.deepEqual([...remainder], [5, 6]);
  assert.equal(chunker.flush(), null);

  chunker.append(Uint8Array.from([9, 9]));
  chunker.reset();
  assert.equal(chunker.flush(), null);

  const isRangeError = (error) => error.name === "RangeError";
  assert.throws(() => api.createChunker(3), isRangeError); // odd
  assert.throws(() => api.createChunker(0), isRangeError); // non-positive
  assert.doesNotThrow(() => api.createChunker(api.MAX_CHUNK_BYTES)); // exactly at the WhisperService bound is allowed
  assert.throws(() => api.createChunker(api.MAX_CHUNK_BYTES + 2), isRangeError); // above the bound is rejected
  assert.ok(api.DEFAULT_CHUNK_BYTES < api.MAX_CHUNK_BYTES);

  // Regression: WhisperService's real limit (DEFAULTS.maxFrameBytes) is 64,000 bytes, not the
  // 64 KiB (65,536) previously assumed. Configurations between the two must now be rejected.
  assert.equal(api.MAX_CHUNK_BYTES, 64_000);
  assert.throws(() => api.createChunker(64_002), isRangeError);
  assert.throws(() => api.createChunker(65_534), isRangeError);
}

// createPipeline — end-to-end bounded chunk emission and reset isolation
{
  const api = createHarness();
  const pipeline = api.createPipeline({ chunkBytes: 8 });
  const channelData = [Float32Array.from(new Array(20).fill(0.25)), Float32Array.from(new Array(20).fill(-0.25))];
  const chunks = pipeline.process(channelData, 32000);
  for (const chunk of chunks) assert.ok(chunk.length <= 8);
  const remainder = pipeline.flush();
  if (remainder) assert.ok(remainder.length < 8);

  pipeline.reset();
  const freshPipeline = api.createPipeline({ chunkBytes: 8 });
  const afterReset = pipeline.process(channelData, 32000);
  const fresh = freshPipeline.process(channelData, 32000);
  assert.equal(afterReset.length, fresh.length);
  afterReset.forEach((chunk, index) => assert.deepEqual([...chunk], [...fresh[index]]));

  const silentMono = api.createPipeline({ chunkBytes: 8 });
  assert.deepEqual([...silentMono.process([], 16000)], []);
}

console.log("PCM downmix, encoding, resampling, chunk bounds, and pipeline reset verified.");
