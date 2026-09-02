import { analyzeSamples, analyzeRecording, FFT_SIZE, WELCH_OVERLAP, DEFAULT_FIT_RANGE } from "./analysis-engine.js?v=0.6.8-recovery.3";
import { normalizePcm } from "./pcm-input.js?v=0.6.8-recovery.3";
import { pcmMetrics } from "./pcm-diagnostics.js?v=0.6.8-recovery.3";

export const PRIMARY_ANALYSIS_CONFIG = Object.freeze({ fftSize: FFT_SIZE, overlap: WELCH_OVERLAP, fitRange: Object.freeze([...DEFAULT_FIT_RANGE]), maxWelchSegments: 48 });
const PATHS = { live: "live", recording: "recorded-microphone", upload: "uploaded-file" };

// Every acquisition route reaches this boundary with decoded float PCM.
// Identical PCM + configuration + context produces identical core science.
export function analyzePcm({ samples: input, sampleRate, path, options = {} }) {
  if (!PATHS[path]) throw new Error("Unknown PCM acquisition path.");
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error("Invalid PCM sample rate.");
  const samples = normalizePcm(input);
  const config = { ...PRIMARY_ANALYSIS_CONFIG, ...options, sourceType: PATHS[path] };
  if (!Array.isArray(config.fitRange) || config.fitRange.length !== 2 || !config.fitRange.every(Number.isFinite) || config.fitRange[0] <= 0 || config.fitRange[1] <= config.fitRange[0]) throw new Error("Invalid fit range.");
  if (!Number.isFinite(config.fftSize) || config.fftSize < 256 || !Number.isFinite(config.overlap) || config.overlap < 0 || config.overlap >= 1 || !(config.maxWelchSegments > 0)) throw new Error("Invalid Welch configuration.");
  const result = path === "live" ? analyzeSamples(samples, sampleRate, config) : analyzeRecording(samples, sampleRate, config);
  const startSample = Number.isSafeInteger(options.analysisStartSample) ? options.analysisStartSample : Math.round(result.analysisStartSeconds * sampleRate);
  result.acquisition = { ...options.acquisition, path, representation: "mono-float32", fullScale: 1, normalization: "representation-only; no gain or resampling" };
  result.measurementWindow = { startSample, endSample: startSample + samples.length, sampleCount: samples.length, timeBasis: "captured-PCM-samples", job: options.job || "primary", requestId: options.requestId ?? null };
  result.captureEvents = structuredClone(options.captureEvents || []);
  if (path === "live") result.qualityContext = { ...result.qualityContext,
    observationTimeBasis: "captured-PCM-session-origin", temporalWindowSeconds: result.durationSeconds, activityFrameSeconds: 0.5 };
  result.pcmDiagnostics = { ...options.pcmDiagnostics, ...result.pcmDiagnostics, workerInput: pcmMetrics(samples), analyzerInput: result.pcm };
  return result;
}
