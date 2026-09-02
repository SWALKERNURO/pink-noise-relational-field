// Float PCM: full scale = 1, RMS dBFS = 20 log10(RMS). No gain or
// normalization is performed here. Diagnostics retain statistics, not audio.
export class PcmMeter {
  constructor() {
    this.sampleCount = 0;
    this.finiteCount = 0;
    this.nonzeroCount = 0;
    this.sumSquares = 0;
    this.peak = 0;
  }

  add(samples) {
    for (const value of samples) {
      this.sampleCount += 1;
      if (!Number.isFinite(value)) continue;
      this.finiteCount += 1;
      if (value !== 0) this.nonzeroCount += 1;
      this.sumSquares += value * value;
      this.peak = Math.max(this.peak, Math.abs(value));
    }
    return this.snapshot();
  }

  snapshot() {
    const rms = this.finiteCount ? Math.sqrt(this.sumSquares / this.finiteCount) : 0;
    return { sampleCount: this.sampleCount, finiteCount: this.finiteCount, peak: this.peak, rms,
      dbfs: this.sampleCount ? 20 * Math.log10(Math.max(rms, 1e-12)) : null,
      nonzeroRatio: this.sampleCount ? this.nonzeroCount / this.sampleCount : 0 };
  }
}

export function pcmMetrics(samples) { return new PcmMeter().add(samples); }

export class PcmTrace {
  constructor() { this.stages = {}; }
  record(stage, samples) {
    const previous = this.stages[stage];
    this.stages[stage] = { ...pcmMetrics(samples), blocks: (previous?.blocks || 0) + 1,
      totalSampleCount: (previous?.totalSampleCount || 0) + samples.length };
  }
  snapshot() { return structuredClone(this.stages); }
}
