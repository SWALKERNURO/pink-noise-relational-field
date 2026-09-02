import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  APP_VERSION,
  ENGINE_VERSION,
  MAX_SESSION_TIMELINE_SEGMENTS,
  SessionAccumulator,
  analyzeRecording,
  analyzeSamples,
  buildActivityTimeline,
  buildColorTimeline,
  fftInPlace,
  summarizeSession,
  thirdOctaveBands,
  welchPSD,
} from "../public/noisecolor/analysis-engine.js";
import { ColorStateMachine } from "../public/noisecolor/live-state.js";
import { MODE_CONFIG, RollingBuffer, selectBoundedAnalysisWindow } from "../public/noisecolor/live-runtime.js";
import { compactMeasurement, historyPaginationState, HISTORY_PAGE_SIZE, HISTORY_RETENTION_LIMIT } from "../public/noisecolor/history.js";
import { MAX_DECODE_WORKING_BYTES, assessCompressedUploadSafety, estimateCompressedDecodePeakBytes, inspectCompressedLayout, preflightCompressedUpload } from "../public/noisecolor/upload-safety.js";
import { MicrophoneStartupLock, isMicrophoneStartupCancellation } from "../public/noisecolor/microphone-startup.js";

function randomGenerator(seed = 123456789) {
  let value = seed >>> 0;
  return () => {
    value = (1664525 * value + 1013904223) >>> 0;
    return value / 2 ** 32;
  };
}

function coloredNoise(beta, { sampleRate = 16000, size = 65536, seed = 1, rms = 0.18 } = {}) {
  const random = randomGenerator(seed);
  const real = new Float64Array(size);
  const imaginary = new Float64Array(size);
  for (let bin = 1; bin < size / 2; bin += 1) {
    const frequency = (bin * sampleRate) / size;
    const magnitude = frequency ** (-beta / 2);
    const phase = random() * 2 * Math.PI;
    const re = magnitude * Math.cos(phase);
    const im = magnitude * Math.sin(phase);
    real[bin] = re;
    imaginary[bin] = im;
    real[size - bin] = re;
    imaginary[size - bin] = -im;
  }
  fftInPlace(real, imaginary, true);
  const currentRms = Math.sqrt(real.reduce((sum, sample) => sum + sample * sample, 0) / size);
  return Float32Array.from(real, (sample) => (sample / currentRms) * rms);
}

function sineWave(frequency, { sampleRate = 16000, seconds = 4, amplitude = 0.3 } = {}) {
  return Float32Array.from({ length: Math.round(sampleRate * seconds) }, (_, index) => amplitude * Math.sin((2 * Math.PI * frequency * index) / sampleRate));
}

function piecewiseNoise({ sampleRate = 16000, size = 65536, seed = 19 } = {}) {
  const random = randomGenerator(seed);
  const real = new Float64Array(size);
  const imaginary = new Float64Array(size);
  for (let bin = 1; bin < size / 2; bin += 1) {
    const frequency = (bin * sampleRate) / size;
    // A broadband shelf is intentionally not describable by one log-log slope.
    const magnitude = frequency < 1200 ? 1 : 20;
    const phase = random() * 2 * Math.PI;
    real[bin] = magnitude * Math.cos(phase);
    imaginary[bin] = magnitude * Math.sin(phase);
    real[size - bin] = real[bin];
    imaginary[size - bin] = -imaginary[bin];
  }
  fftInPlace(real, imaginary, true);
  const currentRms = Math.sqrt(real.reduce((sum, sample) => sum + sample * sample, 0) / size);
  return Float32Array.from(real, (sample) => (sample / currentRms) * 0.18);
}

function twoRegimeNoise({ sampleRate = 16000, size = 65536, seed = 73, breakpoint = 1000, lowBeta = 0, highBeta = 2 } = {}) {
  const random = randomGenerator(seed);
  const real = new Float64Array(size);
  const imaginary = new Float64Array(size);
  for (let bin = 1; bin < size / 2; bin += 1) {
    const frequency = (bin * sampleRate) / size;
    const beta = frequency < breakpoint ? lowBeta : highBeta;
    const magnitude = (frequency / breakpoint) ** (-beta / 2);
    const phase = random() * 2 * Math.PI;
    real[bin] = magnitude * Math.cos(phase);
    imaginary[bin] = magnitude * Math.sin(phase);
    real[size - bin] = real[bin];
    imaginary[size - bin] = -imaginary[bin];
  }
  fftInPlace(real, imaginary, true);
  const currentRms = Math.sqrt(real.reduce((sum, sample) => sum + sample * sample, 0) / size);
  return Float32Array.from(real, (sample) => (sample / currentRms) * 0.16);
}

const analysisOptions = { fitRange: [100, 7000], analysisMode: "test" };

test("FFT agrees with an independent direct DFT and round-trips", () => {
  const input = Float64Array.from({ length: 32 }, (_, index) => Math.sin(index * 0.37) + 0.2 * Math.cos(index * 1.13));
  const expected = Array.from({ length: input.length }, (_, frequencyIndex) => {
    let real = 0;
    let imaginary = 0;
    for (let sampleIndex = 0; sampleIndex < input.length; sampleIndex += 1) {
      const angle = (-2 * Math.PI * frequencyIndex * sampleIndex) / input.length;
      real += input[sampleIndex] * Math.cos(angle);
      imaginary += input[sampleIndex] * Math.sin(angle);
    }
    return { real, imaginary };
  });
  const real = Float64Array.from(input);
  const imaginary = new Float64Array(input.length);
  fftInPlace(real, imaginary);
  for (let index = 0; index < input.length; index += 1) {
    assert.ok(Math.abs(real[index] - expected[index].real) < 1e-9);
    assert.ok(Math.abs(imaginary[index] - expected[index].imaginary) < 1e-9);
  }
  fftInPlace(real, imaginary, true);
  for (let index = 0; index < input.length; index += 1) assert.ok(Math.abs(real[index] - input[index]) < 1e-9);
});

test("scientific estimator recovers canonical broadband colored-noise exponents", () => {
  const targets = [
    ["violet", -2],
    ["blue", -1],
    ["white", 0],
    ["pink", 1],
    ["brown", 2],
  ];
  for (const [name, beta] of targets) {
    const result = analyzeSamples(coloredNoise(beta, { seed: 100 + beta * 7 }), 16000, analysisOptions);
    assert.ok(Math.abs(result.beta - beta) <= 0.2, `${name}: expected β ${beta}, received ${result.beta}`);
    assert.equal(result.state, name, `${name}: expected ${name}, received ${result.state} (${result.qualityDetail})`);
  }
});

test("white-noise classification does not require a large R squared", () => {
  const result = analyzeSamples(coloredNoise(0, { seed: 44 }), 16000, analysisOptions);
  assert.ok(Math.abs(result.beta) <= 0.2);
  assert.equal(result.classification, "White-like");
  assert.equal(result.reliable, true);
  assert.ok(result.r2 < 0.25, `white-noise R² should naturally be low, received ${result.r2}`);
});

test("strong tonal mixtures cannot receive a confident broadband color label", () => {
  const broadband = coloredNoise(0, { seed: 145, rms: 0.1 });
  const mixed = Float32Array.from(broadband, (sample, index) => sample + 0.16 * Math.sin((2 * Math.PI * 1000 * index) / 16000));
  const result = analyzeSamples(mixed, 16000, analysisOptions);
  assert.equal(result.state, "tonal");
  assert.equal(result.reliable, false);
  assert.ok(result.maxPeakProminenceDb >= 15);
  assert.ok(result.tonalPowerRatio >= 0.06);
});

test("two-regime spectra fail the single-power-law adequacy gate", () => {
  const result = analyzeSamples(twoRegimeNoise(), 16000, analysisOptions);
  assert.equal(result.state, "mixed");
  assert.equal(result.reliable, false);
  assert.ok(result.segmentedSlopeDelta > 0.75);
});

test("log-balanced breakpoint matrix rejects detectable two-regime spectra across the fit range", () => {
  const betaPairs = [[0, 1], [1, 0], [0, 1.5], [1.5, 0], [0, 2], [2, 0]];
  for (const breakpoint of [250, 500, 1000, 2000, 4000, 6000]) {
    for (const [lowBeta, highBeta] of betaPairs) {
      const seed = 730 + breakpoint + Math.round(lowBeta * 31 + highBeta * 47);
      const result = analyzeSamples(twoRegimeNoise({ breakpoint, lowBeta, highBeta, seed }), 16000, analysisOptions);
      const fixture = `${lowBeta}→${highBeta} at ${breakpoint} Hz`;
      assert.notEqual(result.confidence, "High", `${fixture} received a High-confidence ${result.classification} label (Δβ ${result.maxBreakpointSlopeDelta}, improvement ${result.piecewiseImprovementDb} dB)`);
      assert.equal(result.reliable, false, `${fixture} was incorrectly reliable (β ${result.beta}, Δβ ${result.maxBreakpointSlopeDelta}, relative improvement ${result.piecewiseRelativeImprovement})`);
      assert.equal(result.state, "mixed", `${fixture} should fail the single-power-law gate`);
      assert.ok(result.piecewiseRelativeImprovement > 0, `${fixture} did not improve over a single slope`);
    }
  }
});

test("microphone startup lock prevents duplicate acquisition and releases partial resources on cancellation", async () => {
  const lock = new MicrophoneStartupLock();
  let resolveAcquisition;
  const acquisition = new Promise((resolve) => { resolveAcquisition = resolve; });
  let streamAcquisitions = 0;
  let contextAcquisitions = 0;
  let stoppedTracks = 0;
  let closedContexts = 0;
  const start = () => lock.run(async (startup) => {
    streamAcquisitions += 1;
    const stream = await acquisition;
    await startup.track(stream, (resource) => { resource.stopped = true; stoppedTracks += 1; });
    contextAcquisitions += 1;
    const context = { closed: false };
    await startup.track(context, (resource) => { resource.closed = true; closedContexts += 1; });
    startup.commit();
    return { stream, context };
  });
  const first = start();
  await assert.rejects(start(), /already in progress/);
  resolveAcquisition({ stopped: false });
  const live = await first;
  assert.deepEqual([streamAcquisitions, contextAcquisitions], [1, 1]);
  assert.deepEqual([live.stream.stopped, live.context.closed], [false, false]);

  const cancellationLock = new MicrophoneStartupLock();
  let continueStartup;
  const pause = new Promise((resolve) => { continueStartup = resolve; });
  const partialStream = { stopped: false };
  const partialContext = { closed: false };
  const cancelled = cancellationLock.run(async (startup) => {
    await startup.track(partialStream, (resource) => { resource.stopped = true; stoppedTracks += 1; });
    await startup.track(partialContext, (resource) => { resource.closed = true; closedContexts += 1; });
    await pause;
    startup.checkpoint();
    startup.commit();
  });
  assert.equal(await cancellationLock.cancel(), true);
  continueStartup();
  await assert.rejects(cancelled, (error) => isMicrophoneStartupCancellation(error));
  assert.deepEqual([partialStream.stopped, partialContext.closed], [true, true]);
  assert.deepEqual([stoppedTracks, closedContexts], [1, 1]);
  assert.equal(cancellationLock.pending, false);

  const lateAcquisitionLock = new MicrophoneStartupLock();
  let resolveLateStream;
  const lateStreamPromise = new Promise((resolve) => { resolveLateStream = resolve; });
  const lateStream = { stopped: false };
  const lateStart = lateAcquisitionLock.run(async (startup) => {
    const stream = await lateStreamPromise;
    await startup.track(stream, (resource) => { resource.stopped = true; });
    throw new Error("context construction must not be reached after cancellation");
  });
  assert.equal(await lateAcquisitionLock.cancel(), true);
  resolveLateStream(lateStream);
  await assert.rejects(lateStart, (error) => isMicrophoneStartupCancellation(error));
  assert.equal(lateStream.stopped, true);
});

test("quality gates reject tonal input, silence, clipping, and short input", () => {
  const tonal = analyzeSamples(sineWave(1000), 16000, analysisOptions);
  assert.equal(tonal.state, "tonal");
  assert.equal(tonal.reliable, false);

  const silence = analyzeSamples(new Float32Array(16000 * 4), 16000, analysisOptions);
  assert.equal(silence.state, "silence");

  const clippedSource = coloredNoise(0, { seed: 12 });
  const clipped = Float32Array.from(clippedSource, (sample) => Math.max(-1, Math.min(1, sample * 12)));
  const clipping = analyzeSamples(clipped, 16000, analysisOptions);
  assert.equal(clipping.state, "clipping");

  const short = analyzeSamples(coloredNoise(1, { size: 16384, seed: 8 }).subarray(0, 8000), 16000, analysisOptions);
  assert.equal(short.state, "insufficient");
});

test("mobile-style limiting below full scale is reported conservatively", () => {
  const source = coloredNoise(0, { seed: 602, rms: 0.2 });
  const limited = Float32Array.from(source, (sample) => Math.max(-0.8, Math.min(0.8, sample * 12)));
  const result = analyzeSamples(limited, 16000, analysisOptions);
  assert.equal(result.clippingRatio, 0);
  assert.equal(result.limitingSuspected, true);
  assert.equal(result.state, "clipping");
  assert.match(result.qualityDetail, /clipped or aggressively limited/i);
});

test("smooth aggressive tanh limiting cannot receive high-confidence broadband classification", () => {
  const source = coloredNoise(0, { seed: 1602, rms: 0.18 });
  const limited = Float32Array.from(source, (sample) => 0.98 * Math.tanh(8 * sample));
  const result = analyzeSamples(limited, 16000, analysisOptions);
  assert.equal(result.limitingSuspected, true);
  assert.equal(result.state, "clipping");
  assert.equal(result.reliable, false);
  assert.ok(result.amplitudeKurtosis < 1.9 || result.edgeDensityRatio > 0.08);
});

test("quality gates reject non-finite and poor single-power-law signals", () => {
  const invalidSamples = coloredNoise(0, { seed: 31 });
  invalidSamples[120] = Number.NaN;
  const invalid = analyzeSamples(invalidSamples, 16000, analysisOptions);
  assert.equal(invalid.state, "invalid");
  assert.equal(invalid.reliable, false);

  const mixed = analyzeSamples(piecewiseNoise(), 16000, analysisOptions);
  assert.equal(mixed.state, "mixed", `expected a poor single-slope fit, received ${mixed.state} with RMSE ${mixed.rmseDb}`);
  assert.equal(mixed.reliable, false);
});

test("temporal analysis flags a changing exponent as unstable", () => {
  const pink = coloredNoise(1, { size: 65536, seed: 4 });
  const blue = coloredNoise(-1, { size: 65536, seed: 5 });
  const samples = new Float32Array(pink.length + blue.length);
  samples.set(pink);
  samples.set(blue, pink.length);
  const result = analyzeRecording(samples, 16000, { ...analysisOptions, temporalWindowSeconds: 2, temporalStepSeconds: 1 });
  assert.ok(result.temporalBeta.length >= 6);
  assert.ok(result.temporalBetaSd > 0.55, `expected unstable β, received SD ${result.temporalBetaSd}`);
  assert.equal(result.state, "unstable");
});

test("intermittent silence is represented by actual analyzed time", () => {
  const sampleRate = 16384;
  const silence = new Float32Array(sampleRate * 4);
  const pink = coloredNoise(1, { sampleRate, size: 65536, seed: 222, rms: 0.18 });
  const samples = new Float32Array(silence.length + pink.length);
  samples.set(silence);
  samples.set(pink, silence.length);
  const result = analyzeRecording(samples, sampleRate, { ...analysisOptions, temporalWindowSeconds: 2, temporalStepSeconds: 2 });
  assert.ok(Math.abs(result.sessionSummary.percentages.silence - 50) < 2, `expected about 50% silence, received ${result.sessionSummary.percentages.silence}`);
  assert.ok(Math.abs(result.sessionSummary.rejectedPercentage - 50) < 2);
  assert.equal(result.reliable, false);
  assert.equal(result.state, "silence");
  assert.ok(result.temporalBeta.every((item) => Number.isFinite(item.rmseDb) && Number.isFinite(item.r2) && Number.isFinite(item.spectralFlatness)));
});

test("short-frame activity accounting preserves 50% silence across 2/3/4/6/8-second blocks", () => {
  const sampleRate = 8192;
  const source = coloredNoise(1, { sampleRate, size: 262144, seed: 1222, rms: 0.16 });
  for (const blockSeconds of [2, 3, 4, 6, 8]) {
    const blockSize = blockSeconds * sampleRate;
    const samples = new Float32Array(blockSize * 4);
    samples.set(source.subarray(0, blockSize), 0);
    samples.set(source.subarray(blockSize, blockSize * 2), blockSize * 2);
    const result = analyzeRecording(samples, sampleRate, { ...analysisOptions, temporalWindowSeconds: 6, temporalStepSeconds: 2, activityFrameSeconds: 0.5 });
    assert.ok(Math.abs(result.sessionSummary.percentages.silence - 50) <= 0.5, `${blockSeconds}s blocks reported ${result.sessionSummary.percentages.silence}% silence`);
    const activity = buildActivityTimeline(samples, sampleRate, result.temporalBeta, 0.5);
    const silenceSeconds = activity.filter((segment) => segment.state === "silence").reduce((sum, segment) => sum + segment.endSeconds - segment.startSeconds, 0);
    assert.ok(Math.abs(silenceSeconds - blockSeconds * 2) <= 0.05);
  }
});

test("low sample-rate analysis caps the fit range below Nyquist", () => {
  const result = analyzeSamples(coloredNoise(1, { sampleRate: 8000, size: 32768, seed: 15 }), 8000, analysisOptions);
  assert.equal(result.fitRange[1], 3840);
  assert.ok(result.psd.frequencies.at(-1) <= 4000);
  assert.ok(Math.abs(result.beta - 1) <= 0.25);
});

test("scalar gain context leaves beta unchanged while frequency-response correction can change it", () => {
  const samples = coloredNoise(1, { seed: 91 });
  const baseline = analyzeSamples(samples, 16000, analysisOptions);
  const scalar = analyzeSamples(samples, 16000, { ...analysisOptions, scalarGainDb: 12 });
  const corrected = analyzeSamples(samples, 16000, {
    ...analysisOptions,
    calibrationProfile: {
      name: "Test response correction",
      routeId: "test-mic",
      points: [{ frequency: 100, correctionDb: 12 }, { frequency: 7000, correctionDb: 0 }],
    },
    inputRouteId: "test-mic",
  });
  assert.ok(Math.abs(baseline.beta - scalar.beta) < 1e-9);
  assert.ok(corrected.beta - baseline.beta > 0.35, `expected correction to steepen β, received ${baseline.beta} → ${corrected.beta}`);
  assert.equal(corrected.corrected, true);
  assert.equal(corrected.calibrationProfile, "Test response correction");

  const mismatch = analyzeSamples(samples, 16000, {
    ...analysisOptions,
    inputRouteId: "other-mic",
    calibrationProfile: { name: "Wrong route", routeId: "test-mic", points: [{ frequency: 100, correctionDb: 12 }, { frequency: 7000, correctionDb: 0 }] },
  });
  assert.equal(mismatch.corrected, false);
  assert.equal(mismatch.calibrationRouteMatched, false);
  assert.match(mismatch.calibrationNotAppliedReason, /did not match/);
});

test("Welch work is bounded while sampling the full available recording", () => {
  const samples = coloredNoise(1, { size: 131072, seed: 12 });
  const psd = welchPSD(samples, 16000, 4096, 0.5, 5);
  assert.equal(psd.segments, 5);
  assert.ok(psd.availableSegments > psd.segments);
  assert.ok(psd.power.every(Number.isFinite));
});

test("Welch normalizes arbitrary requested FFT sizes to a supported power of two", () => {
  const samples = coloredNoise(1, { size: 65536, seed: 22 });
  const psd = welchPSD(samples, 16000, 3000, 0.5, 4);
  assert.equal(psd.fftSize, 2048);
  assert.equal(psd.frequencies.length, 1025);
  assert.ok(psd.power.every(Number.isFinite));
});

test("third-octave values integrate PSD density over frequency", () => {
  const frequencies = Float64Array.from({ length: 101 }, (_, index) => index * 10);
  const power = new Float64Array(101).fill(2);
  const bands = thirdOctaveBands({ frequencies, power });
  const band = bands.find((item) => item.center === 500);
  const bins = frequencies.filter((frequency) => frequency >= 500 / 2 ** (1 / 6) && frequency < 500 * 2 ** (1 / 6)).length;
  assert.equal(band.power, bins * 2 * 10);
});

test("rolling capture wraps by chunk and file analysis is bounded to the final 120 seconds", () => {
  const rolling = new RollingBuffer(5);
  rolling.push(Float32Array.of(1, 2, 3));
  rolling.push(Float32Array.of(4, 5, 6, 7));
  assert.deepEqual(Array.from(rolling.latest()), [3, 4, 5, 6, 7]);
  rolling.push(Float32Array.of(8, 9, 10, 11, 12, 13));
  assert.deepEqual(Array.from(rolling.latest(3)), [11, 12, 13]);

  const bounded = selectBoundedAnalysisWindow(Float32Array.from({ length: 1500 }, (_, index) => index), 10);
  assert.equal(bounded.samples.length, 1200);
  assert.equal(bounded.sourceDurationSeconds, 150);
  assert.equal(bounded.analysisStartSeconds, 30);
  assert.equal(bounded.analysisTruncated, true);
  assert.equal(bounded.samples[0], 300);
  assert.ok(MODE_CONFIG.balanced.fastSeconds < MODE_CONFIG.balanced.stableSeconds);
  assert.ok(MODE_CONFIG.balanced.fastEveryMs < MODE_CONFIG.balanced.stableEveryMs);
});

test("compressed uploads require verified bounded decoded-memory preflight", async () => {
  const mp3Frame = new Uint8Array(417);
  mp3Frame.set([0xff, 0xfb, 0x90, 0x00]);
  const layout = inspectCompressedLayout(mp3Frame.buffer);
  assert.deepEqual(layout, { container: "mp3", sampleRate: 44100, channels: 2, metadataVerified: true });
  const m4a = new Uint8Array(52);
  m4a.set([0x66, 0x74, 0x79, 0x70], 4);
  m4a.set([0x6d, 0x70, 0x34, 0x61], 20);
  const m4aView = new DataView(m4a.buffer);
  m4aView.setUint16(40, 2, false);
  m4aView.setUint32(48, 48000 << 16, false);
  assert.deepEqual(inspectCompressedLayout(m4a.buffer), { container: "mp4-audio", sampleRate: 48000, channels: 2, metadataVerified: true });
  const safe = assessCompressedUploadSafety({ encodedBytes: 1024 * 1024, durationSeconds: 60, ...layout });
  assert.equal(safe.safe, true);
  assert.equal(assessCompressedUploadSafety({ encodedBytes: 1024 * 1024, durationSeconds: 121, ...layout }).safe, false);
  assert.equal(assessCompressedUploadSafety({ encodedBytes: 1024 * 1024, durationSeconds: 60, sampleRate: null, channels: null, metadataVerified: false }).safe, false);
  assert.equal(assessCompressedUploadSafety({ encodedBytes: 1024 * 1024, durationSeconds: 120, sampleRate: 192000, channels: 8, metadataVerified: true }).safe, false);
  const adversarial = assessCompressedUploadSafety({ encodedBytes: 12 * 1024 * 1024, durationSeconds: 120, sampleRate: 88200, channels: 2, metadataVerified: true });
  assert.equal(adversarial.safe, false);
  assert.ok(adversarial.encodedArrayBufferBytes + adversarial.decodedChannelPcmBytes + adversarial.monoOutputBytes + adversarial.decoderOverheadBytes > MAX_DECODE_WORKING_BYTES);

  const encodedBytes = 1024 * 1024;
  const sampleRate = 96000;
  const channels = 2;
  const bytesPerFrameAtBoundary = channels * 4 + 4 + channels * 4 * 0.5;
  const boundaryFrames = Math.floor((MAX_DECODE_WORKING_BYTES - encodedBytes) / bytesPerFrameAtBoundary);
  const below = assessCompressedUploadSafety({ encodedBytes, durationSeconds: (boundaryFrames - 1) / sampleRate, sampleRate, channels, metadataVerified: true });
  const above = assessCompressedUploadSafety({ encodedBytes, durationSeconds: (boundaryFrames + 1) / sampleRate, sampleRate, channels, metadataVerified: true });
  assert.equal(below.safe, true, `below-boundary estimate was ${below.estimatedPeakBytes}`);
  assert.equal(above.safe, false, `above-boundary estimate was ${above.estimatedPeakBytes}`);
  assert.ok(estimateCompressedDecodePeakBytes({ encodedBytes, durationSeconds: (boundaryFrames - 1) / sampleRate, sampleRate, channels }).estimatedPeakBytes <= MAX_DECODE_WORKING_BYTES);
  const preflight = await preflightCompressedUpload({ size: 1024 * 1024 }, mp3Frame.buffer, async () => 60);
  assert.equal(preflight.durationSeconds, 60);
  await assert.rejects(() => preflightCompressedUpload({ size: 1024 * 1024 }, new Uint8Array(32).buffer, async () => 1), /cannot be safely inspected/);
});

test("the primary live estimator waits for the full selected stable window", async () => {
  const app = await readFile(new URL("../public/noisecolor/app.js", import.meta.url), "utf8");
  assert.match(app, /state\.rolling\.length < state\.sampleRate \* config\.stableSeconds/);
  assert.match(app, /requestAnalysis\("analyze-fast"/);
  assert.match(app, /requestAnalysis\("analyze-live"/);
});

test("session timelines end at the session duration and percentages are time-weighted", () => {
  const observations = [
    { timeSeconds: 2, state: "white", classification: "White-like", reliable: true, beta: 0, rmseDb: 2 },
    { timeSeconds: 4, state: "pink", classification: "Pink-like", reliable: true, beta: 1, rmseDb: 2 },
    { timeSeconds: 9, state: "pink", classification: "Pink-like", reliable: true, beta: 1.1, rmseDb: 2 },
  ];
  const timeline = buildColorTimeline(observations, 10);
  assert.deepEqual(timeline.map(({ state, startSeconds, endSeconds }) => ({ state, startSeconds, endSeconds })), [
    { state: "white", startSeconds: 0, endSeconds: 3 },
    { state: "pink", startSeconds: 3, endSeconds: 10 },
  ]);
  const summary = summarizeSession(observations, 10);
  assert.equal(summary.percentages.white, 30);
  assert.equal(summary.percentages.pink, 70);
  assert.equal(summary.dominantReliableColor, "Pink-like");
});

test("recorded and uploaded sources use the same analysis implementation with distinct provenance", () => {
  const samples = coloredNoise(1, { seed: 411 });
  const recorded = analyzeRecording(samples, 16000, { ...analysisOptions, sourceType: "recorded-microphone", maxWelchSegments: 12 });
  const uploaded = analyzeRecording(samples, 16000, { ...analysisOptions, sourceType: "uploaded-file", sourceFilename: "sample.wav", maxWelchSegments: 12 });
  assert.equal(recorded.beta, uploaded.beta);
  assert.equal(recorded.classification, uploaded.classification);
  assert.equal(recorded.sourceType, "recorded-microphone");
  assert.equal(uploaded.sourceType, "uploaded-file");
  assert.equal(uploaded.sourceFilename, "sample.wav");
});

test("live color state machine uses consecutive observations and clears stale color on a gate", () => {
  const machine = new ColorStateMachine({ alpha: 1, requiredObservations: 2 });
  const measurement = (beta, stateName, classification) => ({ beta, state: stateName, classification, reliable: true, confidence: "High", qualityDetail: "Reliable." });
  machine.update(measurement(0.05, "white", "White-like"));
  const white = machine.update(measurement(0.05, "white", "White-like"));
  assert.equal(white.state, "white");
  const firstPink = machine.update(measurement(0.95, "pink", "Pink-like"));
  assert.equal(firstPink.state, "white");
  assert.equal(firstPink.label, "White-like");
  assert.equal(firstPink.confidence, "Provisional");
  assert.match(firstPink.detail, /Smoothed stable β/);
  assert.match(firstPink.detail, /White-like/);
  const pink = machine.update(measurement(0.95, "pink", "Pink-like"));
  assert.equal(pink.state, "pink");
  const silence = machine.update({ beta: 0.95, state: "silence", classification: "Signal too low", reliable: false, qualityDetail: "Quiet." });
  assert.equal(silence.state, "silence");
  assert.equal(silence.displayBeta, null);
});

test("pink to white to blue transitions keep stable label, beta, and confidence coherent", () => {
  const machine = new ColorStateMachine({ alpha: 1, hysteresis: 0, requiredObservations: 2 });
  const measurement = (beta, state, classification) => ({ beta, state, classification, reliable: true, confidence: "High", rmseDb: 1, qualityDetail: "Reliable." });
  machine.update(measurement(1, "pink", "Pink-like"));
  const pink = machine.update(measurement(1, "pink", "Pink-like"));
  assert.deepEqual([pink.state, pink.label, pink.displayBeta, pink.confidence], ["pink", "Pink-like", 1, "High"]);
  const pendingWhite = machine.update(measurement(0, "white", "White-like"));
  assert.deepEqual([pendingWhite.state, pendingWhite.label, pendingWhite.displayBeta, pendingWhite.confidence], ["pink", "Pink-like", 1, "Provisional"]);
  const white = machine.update(measurement(0, "white", "White-like"));
  assert.deepEqual([white.state, white.label, white.displayBeta, white.confidence], ["white", "White-like", 0, "High"]);
  const pendingBlue = machine.update(measurement(-1, "blue", "Blue-like"));
  assert.deepEqual([pendingBlue.state, pendingBlue.label, pendingBlue.displayBeta, pendingBlue.confidence], ["white", "White-like", 0, "Provisional"]);
  const blue = machine.update(measurement(-1, "blue", "Blue-like"));
  assert.deepEqual([blue.state, blue.label, blue.displayBeta, blue.confidence], ["blue", "Blue-like", -1, "High"]);
  const noisyConfidence = machine.update({ ...measurement(-1, "blue", "Blue-like"), temporalSd: 0.4 });
  assert.equal(noisyConfidence.confidence, "Low");
});

test("full-session timeline and aggregates survive visualization retention truncation", () => {
  const sampleRate = 100;
  const accumulator = new SessionAccumulator(sampleRate, 0.5);
  const frame = Float32Array.from({ length: 50 }, (_, index) => 0.1 * Math.sin(index * 0.71) + 0.03 * Math.sin(index * 1.37));
  const retained = [];
  for (let index = 0; index < 4001; index += 1) {
    const state = index < 200 ? "blue" : index < 500 ? "white" : "pink";
    const beta = state === "blue" ? -1 : state === "white" ? 0 : 1;
    const observation = { timeSeconds: index * 0.5, beta, state, classification: `${state[0].toUpperCase()}${state.slice(1)}-like`, reliable: true, rmseDb: 1, r2: 0.8, spectralFlatness: 0.7 };
    accumulator.addAudio(frame, observation);
    accumulator.addObservation(observation);
    retained.push(observation);
    if (retained.length > 3600) retained.shift();
  }
  const summary = accumulator.summary(retained);
  assert.equal(retained.length, 3600);
  assert.equal(summary.aggregateObservationCount, 4001);
  assert.equal(summary.sessionDurationSeconds, 2000.5);
  assert.ok(Math.abs(summary.percentages.blue - (200 / 4001) * 100) < 0.01);
  assert.ok(Math.abs(summary.percentages.white - (300 / 4001) * 100) < 0.01);
  assert.ok(Math.abs(summary.percentages.pink - (3501 / 4001) * 100) < 0.01);
  assert.ok(Math.abs(summary.betaMean - (3501 - 200) / 4001) < 1e-9);
  assert.deepEqual(summary.colorTimeline.map(({ state, startSeconds, endSeconds }) => ({ state, startSeconds, endSeconds })), [
    { state: "blue", startSeconds: 0, endSeconds: 100 },
    { state: "white", startSeconds: 100, endSeconds: 250 },
    { state: "pink", startSeconds: 250, endSeconds: 2000.5 },
  ]);
  assert.equal(summary.statisticsCoverFullSession, true);
  assert.equal(summary.timelineCoversFullSession, true);
  assert.equal(summary.timelineMatchesAggregates, true);
  assert.deepEqual([summary.timelineStateDurations.blue, summary.timelineStateDurations.white, summary.timelineStateDurations.pink], [100, 150, 1750.5]);
});

test("full-session run timeline remains bounded while preserving state-duration composition", () => {
  const accumulator = new SessionAccumulator(10, 0.5);
  const frame = Float32Array.from({ length: 5 }, (_, index) => 0.12 * Math.sin(index + 0.4));
  for (let index = 0; index < MAX_SESSION_TIMELINE_SEGMENTS + 100; index += 1) {
    const state = index % 2 ? "blue" : "pink";
    accumulator.addAudio(frame, { state, classification: `${state}-like`, reliable: true });
  }
  const summary = accumulator.summary();
  assert.ok(summary.colorTimeline.length <= MAX_SESSION_TIMELINE_SEGMENTS);
  assert.equal(summary.timelineCompressed, true);
  assert.equal(summary.timelineCoversFullSession, true);
  assert.equal(summary.timelineMatchesAggregates, true);
});

test("NoiseColor PWA paths and mobile lifecycle contracts stay scoped", async () => {
  const [manifestText, serviceWorker, html, styles, pwa, app, worker, liveState] = await Promise.all([
    readFile(new URL("../public/noisecolor/manifest.webmanifest", import.meta.url), "utf8"),
    readFile(new URL("../public/noisecolor/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../public/noisecolor/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/noisecolor/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../public/noisecolor/pwa.js", import.meta.url), "utf8"),
    readFile(new URL("../public/noisecolor/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/noisecolor/analysis-worker.js", import.meta.url), "utf8"),
    readFile(new URL("../public/noisecolor/live-state.js", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192" && icon.purpose === "any"));
  assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512" && icon.purpose === "any"));
  assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512" && icon.purpose === "maskable"));
  assert.match(serviceWorker, /noisecolor-shell-\$\{VERSION\}/);
  assert.match(serviceWorker, /startsWith\(new URL\("\.\/", self\.location\)\.pathname\)/);
  assert.match(serviceWorker, /await cache\.put/);
  assert.match(html, /rel="manifest" href="\.\/manifest\.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon"/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(styles, /env\(safe-area-inset-top/);
  assert.match(styles, /env\(safe-area-inset-bottom/);
  assert.match(styles, /100dvh/);
  assert.match(html, new RegExp(`app\\.js\\?v=${APP_VERSION}`));
  assert.match(html, new RegExp(`styles\\.css\\?v=${APP_VERSION}`));
  assert.match(pwa, /register\("\.\/sw\.js", \{ scope: "\.\/"/);
  assert.match(pwa, /beforeinstallprompt/);
  assert.match(pwa, /appinstalled/);
  assert.match(pwa, /display-mode: standalone/);
  assert.match(pwa, /navigator\.standalone === true/);
  assert.match(app, /state\.installPromptReady && platform !== "ios"/);
  assert.match(app, /await pwa\.promptInstall\(\)/);
  assert.match(app, /await audioContext\.resume\(\)/);
  assert.match(app, /audioContext\.addEventListener\("statechange"/);
  assert.match(app, /track\.addEventListener\("ended"/);
  assert.match(app, /track\.addEventListener\("mute"/);
  assert.match(app, /document\.addEventListener\("visibilitychange"/);
  assert.match(app, /addEventListener\?\.\("devicechange"/);
  assert.match(app, /window\.addEventListener\("pagehide"/);
  assert.match(app, /AUDIO_CONTEXT_START_TIMEOUT_MS/);
  assert.match(app, /Promise\.race/);
  assert.match(app, /audioContext\.state !== "running"/);
  assert.match(app, /await closeAudioContext\(audioContext\)/);
  assert.match(app, /new MicrophoneStartupLock\(\)/);
  assert.match(app, /await cancelMicrophoneStartup\(\)/);
  assert.match(app, /microphoneStartup\.pending/);
  assert.match(app, /MAX_RECORDING_SECONDS/);
  assert.match(app, /MAX_RECORDING_BYTES/);
  assert.match(app, /decodePcmWavTail/);
  assert.match(app, /preflightCompressedUpload/);
  assert.match(serviceWorker, /upload-safety\.js/);
  assert.match(serviceWorker, /microphone-startup\.js/);
  assert.match(html, /id="historyPageStatus" role="status" aria-live="polite"/);
  assert.match(app, /state\.workerBusy/);
  assert.match(html, /id="clearButton"/);
  assert.match(html, /role="tabpanel"/);
  assert.match(html, /aria-controls="panelSpectrum"/);
  assert.match(html, /aria-describedby="betaDataSummary"/);
  assert.match(styles, /\.file-drop:focus-within/);
  assert.match(serviceWorker, new RegExp(`const VERSION = ["']${APP_VERSION}["']`));
  assert.match(app, new RegExp(`analysis-engine\\.js\\?v=${APP_VERSION}`));
  assert.match(app, new RegExp(`analysis-worker\\.js\\?v=${APP_VERSION}`));
  assert.match(worker, new RegExp(`analysis-engine\\.js\\?v=${APP_VERSION}`));
  assert.match(liveState, new RegExp(`analysis-engine\\.js\\?v=${APP_VERSION}`));
  const elementsBlock = app.match(/const elements = Object\.fromEntries\(\[(.*?)\]\.map/s)?.[1] || "";
  const referencedIds = [...elementsBlock.matchAll(/"([A-Za-z][A-Za-z0-9]+)"/g)].map((match) => match[1]);
  for (const id of referencedIds) assert.match(html, new RegExp(`id=["']${id}["']`), `Missing DOM element #${id}`);
});

test("exports and privacy metadata are versioned and local-first", async () => {
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+$/);
  assert.match(ENGINE_VERSION, /^\d+\.\d+\.\d+$/);
  const [html, readme] = await Promise.all([
    readFile(new URL("../public/noisecolor/index.html", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
  ]);
  assert.match(html, /Audio is analyzed locally and is not uploaded to a server\./);
  assert.match(readme, /Audio is analyzed locally and is not uploaded to a server\./);
  const result = analyzeSamples(coloredNoise(1, { seed: 77 }), 16000, {
    ...analysisOptions,
    scalarGainDb: 3.5,
    inputRouteId: "persistent-device-id",
    inputRouteLabel: "Microphone · current session",
    microphoneSettings: { deviceId: "persistent-device-id", groupId: "persistent-group-id", sampleRate: 16000, channelCount: 1 },
  });
  assert.equal(result.scalarGainDb, 3.5);
  assert.equal(result.inputRouteId, undefined);
  assert.equal(result.inputRouteLabel, "Microphone · current session");
  assert.equal(result.microphoneSettings.deviceId, undefined);
  assert.equal(result.microphoneSettings.groupId, undefined);
  assert.equal(result.microphoneSettings.sampleRate, 16000);
  assert.equal(result.corrected, false);
});

test("calibration exports include deterministic correction data without route identifiers", () => {
  const profile = { name: "Reference mic", routeId: "persistent-device-id", points: [{ frequency: 100, correctionDb: 2 }, { frequency: 7000, correctionDb: -1 }] };
  const result = analyzeSamples(coloredNoise(1, { seed: 902 }), 16000, { ...analysisOptions, calibrationProfile: profile, inputRouteId: profile.routeId });
  assert.equal(result.corrected, true);
  assert.equal(result.calibration.applied, true);
  assert.deepEqual(result.calibration.points, profile.points);
  assert.match(result.calibration.correctionHash, /^fnv1a32-[0-9a-f]{8}$/);
  assert.equal(result.calibration.routeId, undefined);
});

test("history compaction bounds detail arrays and removes persistent identifiers", () => {
  const record = compactMeasurement({
    timestamp: "2026-09-01T00:00:00.000Z",
    sourceType: "live-session",
    inputRouteId: "persistent-device-id",
    microphoneSettings: { deviceId: "persistent-device-id", groupId: "persistent-group-id", sampleRate: 48000 },
    psd: { frequencies: [1, 2], power: [3, 4] },
    spectrogram: { values: [[1]] },
    thirdOctave: [{ center: 100, power: 1 }],
    temporalBeta: Array.from({ length: 1000 }, (_, index) => ({ timeSeconds: index, beta: 1 })),
  });
  assert.equal(record.psd, undefined);
  assert.equal(record.spectrogram, undefined);
  assert.equal(record.thirdOctave, undefined);
  assert.equal(record.inputRouteId, undefined);
  assert.equal(record.microphoneSettings.deviceId, undefined);
  assert.equal(record.microphoneSettings.groupId, undefined);
  assert.equal(record.temporalBeta.length, 600);
  assert.equal(record.historyCompacted, true);
  assert.equal(HISTORY_PAGE_SIZE, 25);
  assert.equal(HISTORY_RETENTION_LIMIT, 100);
});

test("history pagination exposes records 26 through 100 without unbounded reads", async () => {
  const first = historyPaginationState(0, 25, true);
  const second = historyPaginationState(first.nextOffset, 25, true);
  const fourth = historyPaginationState(75, 25, false);
  assert.deepEqual([first.pageNumber, first.hasPrevious, first.hasNext, first.firstRecord, first.lastRecord], [1, false, true, 1, 25]);
  assert.deepEqual([second.pageNumber, second.previousOffset, second.nextOffset, second.firstRecord, second.lastRecord], [2, 0, 50, 26, 50]);
  assert.deepEqual([fourth.pageNumber, fourth.hasNext, fourth.firstRecord, fourth.lastRecord], [4, false, 76, 100]);
  const [app, history, html] = await Promise.all([
    readFile(new URL("../public/noisecolor/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/noisecolor/history.js", import.meta.url), "utf8"),
    readFile(new URL("../public/noisecolor/index.html", import.meta.url), "utf8"),
  ]);
  assert.match(app, /listMeasurementPage\(\{ offset: state\.historyOffset \}\)/);
  assert.match(app, /historyNext\.addEventListener/);
  assert.match(app, /historyPrevious\.addEventListener/);
  assert.doesNotMatch(history, /getAll\s*\(/);
  assert.match(html, /id="historyPrevious"/);
  assert.match(html, /id="historyNext"/);
});

test("small and dim text colors meet AA contrast and calibration changes are announced", async () => {
  const [styles, html] = await Promise.all([
    readFile(new URL("../public/noisecolor/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../public/noisecolor/index.html", import.meta.url), "utf8"),
  ]);
  const color = (name) => styles.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1];
  const luminance = (hex) => {
    const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const contrast = (foreground, background) => {
    const [light, dark] = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
    return (light + 0.05) / (dark + 0.05);
  };
  for (const foreground of [color("muted"), color("dim")]) {
    assert.ok(contrast(foreground, color("surface")) >= 4.5, `${foreground} does not meet AA on ${color("surface")}`);
    assert.ok(contrast(foreground, color("bg")) >= 4.5, `${foreground} does not meet AA on ${color("bg")}`);
  }
  assert.match(html, /id="calibrationState" role="status" aria-live="polite" aria-atomic="true"/);
});

test("upload rejection and Clear reset stale result surfaces before reporting failure", async () => {
  const app = await readFile(new URL("../public/noisecolor/app.js", import.meta.url), "utf8");
  const upload = app.slice(app.indexOf("async function loadAudioFile"), app.indexOf("function readWavSampleRate"));
  assert.ok(upload.indexOf("clearAnalysisResults") < upload.indexOf("file.size > MAX_FILE_BYTES"));
  assert.match(upload, /catch \(error\) \{\s*if \(analysisGeneration !== state\.analysisGeneration\) return;\s*clearAnalysisResults/);
  assert.ok(upload.indexOf("preflightCompressedUpload") < upload.indexOf("decodeAudioData"));
  assert.match(app, /async function resetApplication\(\)/);
  assert.match(app, /releaseRecordingObject\(\)/);
  assert.match(app, /elements\.clearButton\.addEventListener\("click", resetApplication\)/);
});
