export const ROLLING_SECONDS = 30;
export const MAX_ANALYSIS_SECONDS = 120;

export const MODE_CONFIG = Object.freeze({
  instant: Object.freeze({ fastSeconds: 1.5, stableSeconds: 3, fastEveryMs: 250, stableEveryMs: 500 }),
  balanced: Object.freeze({ fastSeconds: 2, stableSeconds: 8, fastEveryMs: 500, stableEveryMs: 1000 }),
  stable: Object.freeze({ fastSeconds: 3, stableSeconds: 12, fastEveryMs: 750, stableEveryMs: 1500 }),
});

// One dispatcher owns the worker. Independent 500/1000 ms timers let the fast
// callback win every collision and indefinitely starve stable observations.
export class LiveAnalysisScheduler {
  constructor(config) {
    this.config = config;
    this.lastFast = -Infinity;
    this.lastStable = -Infinity;
  }

  next(nowMs, availableSeconds, busy = false) {
    if (busy) return null; // A skipped deadline remains due.
    if (availableSeconds >= this.config.stableSeconds && nowMs - this.lastStable >= this.config.stableEveryMs) {
      this.lastStable = nowMs;
      return "stable";
    }
    if (availableSeconds >= Math.min(1.5, this.config.fastSeconds) && nowMs - this.lastFast >= this.config.fastEveryMs) {
      this.lastFast = nowMs;
      return "fast";
    }
    return null;
  }
}

export function sessionSignalPercentages(percentages = {}) {
  return { lowSignal: percentages.silence || 0, awaitingAnalysis: percentages.insufficient || 0 };
}

export function liveWindowProvenance(sampleCount, capturedSampleCount, sampleRate) {
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 0 || !Number.isSafeInteger(capturedSampleCount) || capturedSampleCount < sampleCount || !(sampleRate > 0)) throw new Error("Invalid live sample boundary.");
  const analysisStartSample = capturedSampleCount - sampleCount;
  return { analysisStartSample, analysisStartSeconds: analysisStartSample / sampleRate, sourceDurationSeconds: capturedSampleCount / sampleRate };
}

export function capturePcm(samples, { rolling, sessionAccumulator, recordingBuffer, trace, fallback }) {
  trace.record("captureSamples", samples);
  rolling.push(samples);
  sessionAccumulator.addAudio(samples, fallback);
  recordingBuffer?.push(samples);
}

export class RollingBuffer {
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError("Rolling-buffer capacity must be a positive integer.");
    this.capacity = capacity;
    this.data = new Float32Array(capacity);
    this.writeIndex = 0;
    this.length = 0;
  }

  push(input) {
    if (!input?.length) return;
    const chunk = input.length > this.capacity ? input.subarray(input.length - this.capacity) : input;
    const first = Math.min(chunk.length, this.capacity - this.writeIndex);
    this.data.set(chunk.subarray(0, first), this.writeIndex);
    if (first < chunk.length) this.data.set(chunk.subarray(first), 0);
    this.writeIndex = (this.writeIndex + chunk.length) % this.capacity;
    this.length = Math.min(this.capacity, this.length + chunk.length);
  }

  latest(count = this.length) {
    const requested = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : this.length;
    const size = Math.min(this.length, requested);
    const result = new Float32Array(size);
    const start = (this.writeIndex - size + this.capacity) % this.capacity;
    const first = Math.min(size, this.capacity - start);
    result.set(this.data.subarray(start, start + first));
    if (first < size) result.set(this.data.subarray(0, size - first), first);
    return result;
  }

  clear() {
    this.writeIndex = 0;
    this.length = 0;
    this.data.fill(0);
  }
}

export function selectBoundedAnalysisWindow(samples, sampleRate, maxSeconds = MAX_ANALYSIS_SECONDS) {
  if (!(samples instanceof Float32Array)) throw new TypeError("Analysis samples must be a Float32Array.");
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError("Sample rate must be positive and finite.");
  const sourceDurationSeconds = samples.length / sampleRate;
  const maximumSamples = Math.max(1, Math.floor(sampleRate * maxSeconds));
  if (samples.length <= maximumSamples) {
    return {
      samples,
      sourceDurationSeconds,
      analysisStartSeconds: 0,
      analysisTruncated: false,
    };
  }
  const analysisStartSamples = samples.length - maximumSamples;
  return {
    samples: new Float32Array(samples.subarray(analysisStartSamples)),
    sourceDurationSeconds,
    analysisStartSeconds: analysisStartSamples / sampleRate,
    analysisTruncated: true,
  };
}
