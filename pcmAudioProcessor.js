(() => {
  "use strict";

  const OUTPUT_SAMPLE_RATE = 16000;
  const MAX_CHUNK_BYTES = 64_000; // WhisperService DEFAULTS.maxFrameBytes (src/constants.mjs); frames over this are rejected by the WebSocket server's maxPayload and session-manager validation
  const DEFAULT_CHUNK_BYTES = 4096; // ~128ms of 16kHz mono PCM16 audio; well under MAX_CHUNK_BYTES

  function downmixToMono(channelData) {
    const channelCount = channelData.length;
    if (channelCount === 0) return new Float32Array(0);
    if (channelCount === 1) return channelData[0];
    const frameCount = channelData[0].length;
    const mono = new Float32Array(frameCount);
    for (let frame = 0; frame < frameCount; frame += 1) {
      let sum = 0;
      for (let channel = 0; channel < channelCount; channel += 1) sum += channelData[channel][frame] || 0;
      mono[frame] = sum / channelCount;
    }
    return mono;
  }

  function floatTo16BitPcm(monoFloat32) {
    const buffer = new ArrayBuffer(monoFloat32.length * 2);
    const view = new DataView(buffer);
    for (let index = 0; index < monoFloat32.length; index += 1) {
      const clamped = Math.max(-1, Math.min(1, monoFloat32[index]));
      const scaled = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      view.setInt16(index * 2, Math.round(scaled), true);
    }
    return new Uint8Array(buffer);
  }

  // Streaming linear resampler. Carries one boundary sample ("carry") and a fractional
  // cursor ("position") across calls so consecutive process() calls on chunks of a
  // continuous stream interpolate seamlessly at the block boundary instead of clicking.
  function createResampler(outputSampleRate = OUTPUT_SAMPLE_RATE) {
    let carry = 0;
    let position = 0;

    function sampleAt(input, index) {
      if (index < 0) return carry;
      if (index >= input.length) return input[input.length - 1];
      return input[index];
    }

    function process(inputMono, inputSampleRate) {
      if (inputMono.length === 0) return new Float32Array(0);
      const step = inputSampleRate / outputSampleRate;
      const output = [];
      let cursor = position;
      const maxIndex = inputMono.length - 1;
      while (cursor <= maxIndex) {
        const index = Math.floor(cursor);
        const fraction = cursor - index;
        const before = sampleAt(inputMono, index);
        const after = sampleAt(inputMono, index + 1);
        output.push(before + (after - before) * fraction);
        cursor += step;
      }
      carry = inputMono[inputMono.length - 1];
      position = cursor - inputMono.length;
      return Float32Array.from(output);
    }

    function reset() {
      carry = 0;
      position = 0;
    }

    return { process, reset };
  }

  function createChunker(chunkBytes = DEFAULT_CHUNK_BYTES) {
    if (!Number.isInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes % 2 !== 0) {
      throw new RangeError("chunkBytes must be a positive even integer.");
    }
    if (chunkBytes > MAX_CHUNK_BYTES) {
      throw new RangeError(`chunkBytes must not exceed the ${MAX_CHUNK_BYTES}-byte WhisperService frame limit.`);
    }

    let buffered = new Uint8Array(0);

    function append(bytes) {
      if (bytes.length === 0) return [];
      const merged = new Uint8Array(buffered.length + bytes.length);
      merged.set(buffered, 0);
      merged.set(bytes, buffered.length);
      buffered = merged;

      const chunks = [];
      while (buffered.length >= chunkBytes) {
        chunks.push(buffered.slice(0, chunkBytes));
        buffered = buffered.slice(chunkBytes);
      }
      return chunks;
    }

    function flush() {
      if (buffered.length === 0) return null;
      const remainder = buffered;
      buffered = new Uint8Array(0);
      return remainder;
    }

    function reset() {
      buffered = new Uint8Array(0);
    }

    return { append, flush, reset };
  }

  function createPipeline({ chunkBytes = DEFAULT_CHUNK_BYTES, outputSampleRate = OUTPUT_SAMPLE_RATE } = {}) {
    const resampler = createResampler(outputSampleRate);
    const chunker = createChunker(chunkBytes);

    function process(channelData, inputSampleRate) {
      const mono = downmixToMono(channelData);
      if (mono.length === 0) return [];
      const resampled = resampler.process(mono, inputSampleRate);
      if (resampled.length === 0) return [];
      return chunker.append(floatTo16BitPcm(resampled));
    }

    function flush() {
      return chunker.flush();
    }

    function reset() {
      resampler.reset();
      chunker.reset();
    }

    return { process, flush, reset };
  }

  globalThis.SaySlatePcmAudio = {
    OUTPUT_SAMPLE_RATE,
    MAX_CHUNK_BYTES,
    DEFAULT_CHUNK_BYTES,
    downmixToMono,
    floatTo16BitPcm,
    createResampler,
    createChunker,
    createPipeline
  };
})();
