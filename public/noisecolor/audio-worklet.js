import { PcmMeter, pcmMetrics } from "./pcm-diagnostics.js?v=0.6.8-diagnostic.1";

class NoiseColorCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.offset = 0;
    this.inputMeter = new PcmMeter();
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    this.inputMeter.add(input);
    let sourceOffset = 0;
    while (sourceOffset < input.length) {
      const count = Math.min(input.length - sourceOffset, this.buffer.length - this.offset);
      this.buffer.set(input.subarray(sourceOffset, sourceOffset + count), this.offset);
      this.offset += count;
      sourceOffset += count;
      if (this.offset === this.buffer.length) {
        this.port.postMessage({ samples: this.buffer, input: this.inputMeter.snapshot(), output: pcmMetrics(this.buffer), channelCount: inputs[0].length }, [this.buffer.buffer]);
        this.buffer = new Float32Array(2048);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("noisecolor-capture", NoiseColorCaptureProcessor);
