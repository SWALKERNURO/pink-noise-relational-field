import { analyzeRecording, analyzeSamples, buildSpectrogram } from "./analysis-engine.js?v=0.6.8-diagnostic.1";
import { pcmMetrics } from "./pcm-diagnostics.js?v=0.6.8-diagnostic.1";

self.addEventListener("message", (event) => {
  const { id, type, samples: rawSamples, sampleRate, options } = event.data;
  try {
    const samples = rawSamples instanceof Float32Array ? rawSamples : new Float32Array(rawSamples);
    if (type === "analyze-live" || type === "analyze-fast") {
      const result = analyzeSamples(samples, sampleRate, options);
      result.pcmDiagnostics = { ...options?.pcmDiagnostics, workerInput: pcmMetrics(samples), analyzerInput: result.pcm };
      self.postMessage({ id, type, result });
      return;
    }
    if (type === "analyze-recording") {
      const result = analyzeRecording(samples, sampleRate, options);
      result.pcmDiagnostics = { ...options?.pcmDiagnostics, ...result.pcmDiagnostics, workerInput: pcmMetrics(samples), analyzerInput: result.pcm };
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
