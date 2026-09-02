import { buildSpectrogram } from "./analysis-engine.js?v=0.6.8-recovery.2";
import { analyzePcm } from "./analysis-pipeline.js?v=0.6.8-recovery.2";
import { normalizePcm } from "./pcm-input.js?v=0.6.8-recovery.2";

self.addEventListener("message", (event) => {
  const { id, type, samples: rawSamples, sampleRate, options } = event.data;
  try {
    const samples = normalizePcm(rawSamples);
    if (type === "analyze-live" || type === "analyze-fast") {
      const result = analyzePcm({ samples, sampleRate, path: "live", options: { ...options, requestId: id, job: type === "analyze-fast" ? "fast-preview" : "primary" } });
      self.postMessage({ id, type, result });
      return;
    }
    if (type === "analyze-recording") {
      const result = analyzePcm({ samples, sampleRate, path: options?.sourceType === "uploaded-file" ? "upload" : "recording", options: { ...options, requestId: id } });
      result.spectrogram = buildSpectrogram(samples, sampleRate, { maxFrames: 80 });
      self.postMessage({ id, type, result });
      return;
    }
    if (type === "spectrogram") {
      const result = buildSpectrogram(samples, sampleRate, options);
      self.postMessage({ id, type, result });
      return;
    }
    throw new Error(`Unknown analysis request: ${type}`);
  } catch (error) {
    self.postMessage({ id, type, error: error instanceof Error ? error.message : String(error) });
  }
});
