(() => {
  "use strict";

  class SaySlateMicCaptureProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      const chunkBytes = options?.processorOptions?.chunkBytes;
      this.pipeline = globalThis.SaySlatePcmAudio.createPipeline(
        chunkBytes ? { chunkBytes } : {}
      );
      this.stopped = false;
      this.port.onmessage = (event) => this.handleControl(event.data);
    }

    handleControl(message) {
      if (this.stopped) return;
      if (message?.type === "stop") {
        this.emitRemainder();
        this.stopped = true;
        this.port.postMessage({ type: "stopped" });
      } else if (message?.type === "cancel") {
        this.pipeline.reset();
        this.stopped = true;
        this.port.postMessage({ type: "cancelled" });
      }
    }

    emitRemainder() {
      const remainder = this.pipeline.flush();
      if (remainder && remainder.length > 0) {
        this.port.postMessage({ type: "pcm", bytes: remainder }, [remainder.buffer]);
      }
    }

    process(inputs) {
      if (this.stopped) return false;

      const channelData = inputs[0] || [];
      if (channelData.length === 0) return true;

      let chunks;
      try {
        chunks = this.pipeline.process(channelData, sampleRate);
      } catch (error) {
        this.port.postMessage({ type: "error", message: error?.message || "Audio processing failed." });
        return true;
      }

      for (const chunk of chunks) {
        this.port.postMessage({ type: "pcm", bytes: chunk }, [chunk.buffer]);
      }
      return true;
    }
  }

  registerProcessor("sayslate-mic-capture-processor", SaySlateMicCaptureProcessor);
})();
