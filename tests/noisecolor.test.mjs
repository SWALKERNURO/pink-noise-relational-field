import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import * as reference067 from "./fixtures/noisecolor-v067-beta-reference.mjs";
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
  fitPowerLaw,
  modelAdequacyDiagnostics,
  summarizeSession,
  thirdOctaveBands,
  welchPSD,
} from "../public/noisecolor/analysis-engine.js";
import { ColorStateMachine } from "../public/noisecolor/live-state.js";
import { analyzePcm } from "../public/noisecolor/analysis-pipeline.js";
import { normalizePcm, mixToMono, decodePcmWavTail } from "../public/noisecolor/pcm-input.js";
import { CaptureContinuity, liveWindowProvenance } from "../public/noisecolor/live-runtime.js";
import { canExportDiagnostic, createDiagnosticBundle, replayDiagnosticSpectrum, browserDiagnosticInfo } from "../public/noisecolor/diagnostic-bundle.js";
import { sanitizeMetadata, sanitizeAudioSettings } from "../public/noisecolor/privacy.js";
import { capturePcm, LiveAnalysisScheduler, MODE_CONFIG, RollingBuffer, selectBoundedAnalysisWindow, sessionSignalPercentages } from "../public/noisecolor/live-runtime.js";
import { PcmMeter, PcmTrace, pcmMetrics } from "../public/noisecolor/pcm-diagnostics.js";
import { compactMeasurement, historyPaginationState, HISTORY_PAGE_SIZE, HISTORY_RETENTION_LIMIT } from "../public/noisecolor/history.js";
import { MAX_DECODE_WORKING_BYTES, assessCompressedUploadSafety, estimateCompressedDecodePeakBytes, inspectCompressedLayout, preflightCompressedUpload } from "../public/noisecolor/upload-safety.js";
import { MicrophoneStartupLock, isMicrophoneStartupCancellation } from "../public/noisecolor/microphone-startup.js";
import { isIosDevice } from "../public/noisecolor/pwa.js";
import { canonicalAppUrl, isIosStandaloneDenial, microphoneEnvironment, microphoneStartupFailure, openSafariFromGesture, sanitizeStartupFailure } from "../public/noisecolor/microphone-compatibility.js";

test("iOS compatibility: device and standalone detection remain independent of browser brand", () => {
  for (const userAgent of ["iPhone AppleWebKit Safari", "iPad AppleWebKit", "iPhone CriOS AppleWebKit"]) assert.equal(isIosDevice({ userAgent }), true);
  assert.equal(isIosDevice({ userAgent: "Macintosh", platform: "MacIntel", maxTouchPoints: 5 }), true);
  assert.equal(isIosDevice({ userAgent: "Macintosh", platform: "MacIntel", maxTouchPoints: 0 }), false);
  assert.equal(isIosDevice({ userAgent: "Android Chrome" }), false);
  const context = (standalone, display) => microphoneEnvironment({ isSecureContext: true, matchMedia: (query) => ({ matches: query === `(display-mode: ${display})` }) },
    { userAgent: "iPhone AppleWebKit", standalone, mediaDevices: { getUserMedia() {} } });
  assert.deepEqual(context(true, "browser"), { standalone: true, displayMode: "browser", ios: true, secureContext: true, mediaDevicesAvailable: true, getUserMediaAvailable: true });
  assert.equal(context(false, "standalone").standalone, true);
  assert.equal(context(false, "browser").standalone, false);
});

test("iOS compatibility: only actual standalone acquisition permission denials trigger Safari recovery", () => {
  const context = { ios: true, standalone: true, acquisitionMode: "live", stage: "get-user-media" };
  for (const error of [{ name: "NotAllowedError" }, { name: "PermissionDeniedError" }, { name: "SecurityError" },
    { name: "Error", message: "The request is not allowed by the user agent or the platform in the current context" }]) {
    const failure = microphoneStartupFailure(error, context);
    assert.equal(isIosStandaloneDenial(failure), true);
    assert.deepEqual(sanitizeStartupFailure(failure), failure);
    assert.equal(isIosStandaloneDenial({ ...failure, ios: false }), false);
    assert.equal(isIosStandaloneDenial({ ...failure, standalone: false }), false);
    assert.equal(isIosStandaloneDenial({ ...failure, stage: "audio-setup" }), false);
  }
  assert.equal(isIosStandaloneDenial(microphoneStartupFailure({ name: "NotReadableError" }, context)), false);
  assert.equal(isIosStandaloneDenial(null), false);
});

test("iOS compatibility: startup diagnostic bundle has no fabricated science or private error/track data", () => {
  for (const acquisitionMode of ["live", "recording"]) {
    const failure = microphoneStartupFailure({ name: "NotAllowedError", message: "permission denied deviceId SECRET groupId SECRET https://private.example/path" },
      { acquisitionMode, stage: "get-user-media", ios: true, standalone: true, displayMode: "standalone", secureContext: true, mediaDevicesAvailable: true, getUserMediaAvailable: true,
        trackObtained: false, audioTrackSettings: { deviceId: "SECRET", groupId: "SECRET", sampleRate: 48000 } });
    const bundle = createDiagnosticBundle(null, { startupFailure: failure });
    assert.equal(bundle.kind, "microphone-startup-failure");
    assert.equal(bundle.acquisition.path, acquisitionMode);
    assert.equal(bundle.appVersion, APP_VERSION);
    assert.equal(bundle.engineVersion, ENGINE_VERSION);
    assert.equal(bundle.psd, null);
    assert.equal(bundle.rawMeasurement, null);
    assert.equal(bundle.acquisition.audioTrackSettings, null);
    assert.equal(bundle.privacy.rawAudioIncluded, false);
    assert.doesNotMatch(JSON.stringify(bundle), /SECRET|deviceId|groupId|private\.example/);
    assert.throws(() => replayDiagnosticSpectrum(bundle), /incomplete/);
    const withTrack = sanitizeStartupFailure({ ...failure, trackObtained: true, audioTrackSettings: { sampleRate: 48000, deviceId: "SECRET", groupId: "SECRET", label: "SECRET" } });
    assert.deepEqual(withTrack.audioTrackSettings, { sampleRate: 48000 });
  }
});

test("iOS compatibility: Safari handoff is one same-site gesture with no redirect parameters or automatic retry", () => {
  const input = "https://example.org/project/noisecolor/index.html?action=live&install=ios#fragment";
  const expected = "https://example.org/project/noisecolor/";
  assert.equal(canonicalAppUrl(input), expected);
  assert.throws(() => canonicalAppUrl("file:///private/noisecolor/index.html"));
  for (const blocked of [true, false]) {
    const calls = [];
    const mockWindow = { open(...args) { calls.push(args); if (blocked) throw new Error("blocked"); return null; } };
    assert.equal(openSafariFromGesture(mockWindow, input), expected);
    assert.deepEqual(calls, [[expected, "_blank", "noopener,noreferrer"]]);
  }
});

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

function frequencyShapedColoredNoise(beta, { sampleRate = 16000, size = 65536, seed = 1, rms = 0.16, responseDb = () => 0 } = {}) {
  const random = randomGenerator(seed);
  const real = new Float64Array(size);
  const imaginary = new Float64Array(size);
  for (let bin = 1; bin < size / 2; bin += 1) {
    const frequency = (bin * sampleRate) / size;
    const magnitude = frequency ** (-beta / 2) * 10 ** (responseDb(frequency) / 20);
    const phase = random() * 2 * Math.PI;
    real[bin] = magnitude * Math.cos(phase);
    imaginary[bin] = magnitude * Math.sin(phase);
    real[size - bin] = real[bin];
    imaginary[size - bin] = -imaginary[bin];
  }
  fftInPlace(real, imaginary, true);
  const currentRms = Math.sqrt(real.reduce((sum, sample) => sum + sample * sample, 0) / size);
  return Float32Array.from(real, (sample) => (sample / currentRms) * rms);
}

function addSinusoids(samples, tones, sampleRate = 16000) {
  return Float32Array.from(samples, (sample, index) => sample + tones.reduce((sum, [frequency, amplitude, phase = 0]) => sum + amplitude * Math.sin((2 * Math.PI * frequency * index) / sampleRate + phase), 0));
}

function acousticResonanceResponse(frequency) {
  return [[240, 18, 0.025], [780, 18, 0.025], [2100, 18, 0.025]].reduce((sum, [center, gainDb, widthOctaves]) => (
    sum + gainDb * Math.exp(-0.5 * (Math.log2(frequency / center) / widthOctaves) ** 2)
  ), 0);
}

function plausibleTransducerEq(frequency) {
  return 0.6 * Math.log2(frequency / 1000);
}

function normalizedAcousticFrequency(frequency, minimum = 100, maximum = 8000) {
  const clamped = Math.min(maximum, Math.max(minimum, frequency));
  return (Math.log10(clamped) - Math.log10(minimum)) / (Math.log10(maximum) - Math.log10(minimum));
}

function smoothSpeakerEq(frequency) {
  const position = normalizedAcousticFrequency(frequency);
  return 4 * Math.sin(2 * Math.PI * position) + 1.4 * Math.cos(Math.PI * position);
}

function smoothMicrophoneEq(frequency) {
  const position = normalizedAcousticFrequency(frequency);
  return 3 * Math.cos(2 * Math.PI * position + 0.4)
    - 0.8 * Math.log10(Math.max(frequency, 100) / 1000);
}

function broadRoomCrossoverEq(frequency) {
  const position = normalizedAcousticFrequency(frequency);
  return 5.5 * Math.sin(2 * Math.PI * position + 0.6) + 2 * Math.cos(Math.PI * position);
}

function combinedAcousticEq(frequency) {
  const position = normalizedAcousticFrequency(frequency);
  const clamped = Math.min(8000, Math.max(100, frequency));
  return 6 * Math.sin(2 * Math.PI * position) + 0.6 * Math.log10(clamped / 1000);
}

function reportedMeasurementEq(frequency) {
  const position = normalizedAcousticFrequency(frequency);
  const clamped = Math.min(8000, Math.max(100, frequency));
  return 8.8 * Math.sin(2 * Math.PI * position) + 0.8 * Math.log10(clamped / 1000);
}

function extremeSmoothCurvature(frequency) {
  return 14 * Math.sin(2 * Math.PI * normalizedAcousticFrequency(frequency));
}

function reportedAcousticFixture() {
  const sampleRate = 44100;
  const seconds = 30;
  const sampleCount = sampleRate * seconds;
  const fftSize = 2 ** 21;
  const low = frequencyShapedColoredNoise(0.97, { sampleRate, size: fftSize, seed: 6808, rms: 0.08, responseDb: reportedMeasurementEq });
  const high = frequencyShapedColoredNoise(1.05, { sampleRate, size: fftSize, seed: 7808, rms: 0.08, responseDb: reportedMeasurementEq });
  const prefixRms = (samples) => Math.sqrt(samples.subarray(0, sampleCount).reduce((sum, sample) => sum + sample * sample, 0) / sampleCount);
  const lowScale = 0.08 / prefixRms(low);
  const highScale = 0.08 / prefixRms(high);
  return Float32Array.from({ length: sampleCount }, (_, index) => {
    const phase = Math.PI / 4 + 0.65 * Math.sin((2 * Math.PI * index) / (15 * sampleRate));
    return Math.cos(phase) * low[index] * lowScale + Math.sin(phase) * high[index] * highScale;
  });
}

function legacyTonalityDecision(result) {
  const frequencies = result.psd.frequencies;
  const power = result.psd.power;
  const indices = frequencies.map((frequency, index) => ({ frequency, index })).filter(({ frequency, index }) => frequency >= result.fitRange[0] && frequency <= result.fitRange[1] && power[index] > 0).map(({ index }) => index);
  let totalPower = 0;
  let tonalExcess = 0;
  let maximumProminenceDb = 0;
  const first = indices[0];
  const last = indices.at(-1);
  for (const index of indices) {
    totalPower += power[index];
    const neighborhood = [];
    for (let neighbor = Math.max(first, index - 12); neighbor <= Math.min(last, index + 12); neighbor += 1) {
      if (Math.abs(neighbor - index) > 2) neighborhood.push(power[neighbor]);
    }
    neighborhood.sort((left, right) => left - right);
    const middle = Math.floor(neighborhood.length / 2);
    const floor = neighborhood.length % 2 ? neighborhood[middle] : (neighborhood[middle - 1] + neighborhood[middle]) / 2;
    const prominenceDb = 10 * Math.log10(power[index] / floor);
    maximumProminenceDb = Math.max(maximumProminenceDb, prominenceDb);
    if (prominenceDb >= 8) tonalExcess += Math.max(0, power[index] - floor * 10 ** 0.8);
  }
  const tonalPowerRatio = tonalExcess / totalPower;
  return result.spectralFlatness < 0.055 || (maximumProminenceDb >= 15 && tonalPowerRatio >= 0.06) || (maximumProminenceDb >= 24 && tonalPowerRatio >= 0.015);
}

function legacyModelAdequacyDecision(result) {
  const fixedHalfMismatch = result.segmentedSlopeDelta > 0.75 && result.logBinnedRmseDb > 0.85;
  const rollingBreakpointMismatch = result.maxBreakpointSlopeDelta >= 0.55
    && result.piecewiseImprovementDb >= 0.012
    && result.piecewiseRelativeImprovement >= 0.18
    && result.breakpointEvidence >= 0.2;
  return result.rmseDb > 5.2 || fixedHalfMismatch || rollingBreakpointMismatch;
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

test("recovery: interruptions preserve boundaries and never splice pre/post-pause PCM into a fit", () => {
  const continuity = new CaptureContinuity();
  const recorded = new RollingBuffer(160000);
  const before = coloredNoise(2);
  const after = coloredNoise(0);
  recorded.push(before);
  assert.equal(continuity.pause("context-suspended", before.length, 4.1), true);
  assert.equal(continuity.pause("track-muted", before.length, 4.2), false);
  assert.equal(continuity.finalSegmentLength(before.length, recorded.length), before.length);
  assert.equal(continuity.resume(before.length, 10.1), true);
  recorded.push(after);
  const count = before.length + after.length;
  const selected = recorded.latest(continuity.finalSegmentLength(count, recorded.length));
  assert.deepEqual(selected, after);
  assert.equal(continuity.events[0].gapSeconds, 6);
  assert.equal(continuity.events[0].recovered, true);
  const actual = analyzePcm({ samples: selected, sampleRate: 16000, path: "recording", options: liveWindowProvenance(selected.length, count, 16000) });
  const expected = analyzePcm({ samples: after, sampleRate: 16000, path: "upload" });
  assert.deepEqual(actual.measurement, expected.measurement);
  assert.equal(actual.measurementWindow.startSample, before.length);
});

test("recovery: worklet reset acknowledgement discards a partial pre-interruption packet", async () => {
  let Processor;
  const messages = [];
  const source = (await readFile(new URL("../public/noisecolor/audio-worklet.js", import.meta.url), "utf8")).replace(/^import .*;\r?\n/gm, "");
  vm.runInNewContext(source, { Float32Array, PcmMeter, pcmMetrics,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (data) => messages.push(data) }; } },
    registerProcessor: (_, implementation) => { Processor = implementation; } });
  const processor = new Processor();
  processor.process([[new Float32Array(128).fill(0.4)]]);
  processor.port.onmessage({ data: { type: "reset-packet", token: 123 } });
  assert.equal(messages[0].type, "packet-reset");
  assert.equal(messages[0].token, 123);
  processor.process([[new Float32Array(2048).fill(0.1)]]);
  assert.deepEqual(messages[1].samples, new Float32Array(2048).fill(0.1));
});

function floatWav(channels, sampleRate) {
  const samples = channels[0].length;
  const buffer = new ArrayBuffer(44 + samples * channels.length * 4);
  const view = new DataView(buffer);
  const ascii = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  ascii(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, channels.length, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels.length * 4, true);
  view.setUint16(32, channels.length * 4, true); view.setUint16(34, 32, true);
  ascii(36, "data"); view.setUint32(40, samples * channels.length * 4, true);
  for (let i = 0; i < samples; i += 1) channels.forEach((data, c) => view.setFloat32(44 + (i * channels.length + c) * 4, data[i], true));
  return buffer;
}

test("recovery: actual upload/record/live adapters and worker yield exactly identical core science", async () => {
  const fixtures = [
    ...[-2, -1, 0, 1, 2].map((beta) => coloredNoise(beta, { seed: 7000 + beta, rms: 10 ** (-18 / 20) })),
    ...[0, 1, 2].map((beta) => frequencyShapedColoredNoise(beta, { seed: 7100 + beta, responseDb: (f) => combinedAcousticEq(f) + acousticResonanceResponse(f) })),
    twoRegimeNoise({ breakpoint: 3000 }),
    Float32Array.from({ length: 65536 }, (_, i) => 0.18 * Math.sin(2 * Math.PI * 440 * i / 16000)),
    new Float32Array(65536),
  ];
  let receive, response;
  const worker = (await readFile(new URL("../public/noisecolor/analysis-worker.js", import.meta.url), "utf8")).replace(/^import .*;\r?\n/gm, "");
  vm.runInNewContext(worker, { Float32Array, analyzePcm, normalizePcm, buildSpectrogram: () => null,
    self: { addEventListener: (_, fn) => { receive = fn; }, postMessage: (data) => { response = data; } } });
  for (const source of fixtures) {
    const pcm = mixToMono({ length: source.length, numberOfChannels: 1, getChannelData: () => source });
    const rolling = new RollingBuffer(source.length), recordingBuffer = new RollingBuffer(source.length);
    const sessionAccumulator = new SessionAccumulator(16000), trace = new PcmTrace();
    for (let i = 0; i < pcm.length; i += 2048) capturePcm(pcm.subarray(i, i + 2048), { rolling, recordingBuffer, sessionAccumulator, trace });
    const paths = [
      ["uploaded-file", "analyze-recording", decodePcmWavTail(floatWav([source], 16000)).samples],
      ["recorded-microphone", "analyze-recording", recordingBuffer.latest()],
      ["live", "analyze-live", rolling.latest()],
    ];
    const results = paths.map(([sourceType, type, samples], i) => {
      assert.deepEqual(samples, source);
      receive({ data: structuredClone({ id: i, type, samples, sampleRate: 16000, options: { ...analysisOptions, sourceType, maxWelchSegments: 48 } }, { transfer: [samples.buffer] }) });
      assert.equal(response.error, undefined);
      return response.result;
    });
    for (const result of results) {
      assert.deepEqual(result.measurement, results[0].measurement, "input RMS/dBFS, fit, flatness, tonality and ALL model diagnostics");
      assert.deepEqual(result.pcm, results[0].pcm);
      assert.deepEqual(result.psd, results[0].psd);
      assert.deepEqual(result.welchConfiguration, results[0].welchConfiguration);
      assert.deepEqual(result.coreDecision, results[0].coreDecision);
      assert.equal(result.rawMeasuredBeta, results[0].rawMeasuredBeta);
      assert.equal(result.measurementWindow.sampleCount, source.length);
    }
    assert.deepEqual(results.map((r) => r.acquisition.path), ["upload", "recording", "live"]);
    assert.deepEqual(results[0].qualityContext, results[1].qualityContext);
    assert.equal(results[2].qualityContext.temporalSd, null, "missing live history is not asserted to be observed zero SD");
  }
});

test("recovery: multichannel WAV and browser decoder round mono once and preserve sample-rate provenance", () => {
  const channels = Array.from({ length: 3 }, (_, c) => Float32Array.from({ length: 400 }, (_, i) => Math.sin(i * (c + 1)) * (0.31 + c * 0.11)));
  for (const rate of [8000, 16000, 44100, 48000, 96000]) {
    const wav = decodePcmWavTail(floatWav(channels, rate));
    const decoded = mixToMono({ length: 400, numberOfChannels: 3, getChannelData: (c) => channels[c] });
    assert.deepEqual(wav.samples, decoded);
    assert.equal(wav.sampleRate, rate);
    assert.equal(wav.acquisition.resampled, false);
    const result = analyzePcm({ samples: decoded, sampleRate: rate, path: "upload" });
    assert.equal(result.fitRange[1], Math.min(8000, rate * 0.48));
  }
  const malformed = floatWav(channels, 16000);
  new DataView(malformed).setUint16(32, 2, true);
  assert.throws(() => decodePcmWavTail(malformed), /alignment/);
  assert.throws(() => normalizePcm(new Int16Array(20)), /float PCM/);
  assert.throws(() => analyzePcm({ samples: channels[0], sampleRate: NaN, path: "live" }), /sample rate/);
  assert.throws(() => analyzePcm({ samples: channels[0], sampleRate: 16000, path: "live", options: { overlap: 1 } }), /Welch/);
});

test("recovery: window duration, bounded tails and context differences are explicit, never raw-beta corrections", () => {
  const source = coloredNoise(1, { size: 262144, seed: 7310 });
  const live = new RollingBuffer(128000), recorded = new RollingBuffer(source.length);
  live.push(source); recorded.push(source);
  const selected = live.latest();
  const windowOptions = liveWindowProvenance(selected.length, source.length, 16000);
  const liveResult = analyzePcm({ samples: selected, sampleRate: 16000, path: "live", options: windowOptions });
  const tail = decodePcmWavTail(floatWav([source], 16000), 8);
  const upload = analyzePcm({ samples: tail.samples, sampleRate: 16000, path: "upload", options: tail });
  assert.deepEqual(liveResult.psd, upload.psd);
  assert.deepEqual(liveResult.measurement, upload.measurement);
  assert.equal(liveResult.measurementWindow.startSample, source.length - 128000);
  assert.equal(liveResult.measurementWindow.endSample, source.length);
  const full = analyzePcm({ samples: recorded.latest(), sampleRate: 16000, path: "recording" });
  assert.notDeepEqual(full.psd, liveResult.psd, "different PCM intervals are intentionally NOT equivalent");
  assert.equal(full.measurementWindow.startSample, 0);
  const fast = analyzePcm({ samples: selected.slice(-32000), sampleRate: 16000, path: "live", options: { maxWelchSegments: 24, job: "fast-preview" } });
  assert.equal(fast.welchConfiguration.maxSegments, 24);
  assert.equal(fast.measurementWindow.job, "fast-preview");
  assert.notDeepEqual(fast.psd, liveResult.psd);
  const unstable = analyzePcm({ samples: selected, sampleRate: 16000, path: "live", options: { ...windowOptions, temporalSd: 0.8, temporalObservationCount: 10 } });
  assert.deepEqual(unstable.measurement, liveResult.measurement);
  assert.equal(unstable.state, "unstable");
  const replayPsd = reference067.welchPSD(selected, 16000, 4096, 0.5, 48);
  assert.equal(liveResult.rawMeasuredBeta, reference067.fitPowerLaw(replayPsd.frequencies, replayPsd.power, ...liveResult.fitRange).beta);
  assert.deepEqual(liveResult.welchConfiguration.segmentStarts.map((start) => start % liveResult.welchConfiguration.hopSamples), Array(48).fill(0));
});

test("recovery: diagnostic bundle is exact, closed-schema, identifier-free, audio-free and independently replayable", () => {
  const source = frequencyShapedColoredNoise(1, { seed: 7320, responseDb: (f) => combinedAcousticEq(f) + acousticResonanceResponse(f) });
  const result = analyzePcm({ samples: source, sampleRate: 16000, path: "recording", options: {
    microphoneSettings: { sampleRate: 16000, deviceId: "SECRET", groupId: "SECRET", nested: { deviceId: "SECRET" }, noiseSuppression: false },
    calibrationProfile: { name: "PRIVATE PROFILE NAME", routeId: "SECRET", points: [{ frequency: 100, correctionDb: 0 }, { frequency: 8000, correctionDb: 8 }] },
    calibrationRouteKey: "SECRET",
    acquisition: { browser: { family: "Chrome", version: "100", deviceId: "SECRET" }, rawSamples: source, deviceId: "SECRET" },
    pcmDiagnostics: { captureInput: { ...pcmMetrics(source), groupId: "SECRET" }, unexpected: { deviceId: "SECRET" } },
    sourceFilename: "PRIVATE AUDIO NAME",
  } });
  result.rawSamples = source; result.audio = Array.from(source);
  result.deviceId = "SECRET"; result.qualityContext.nested = { groupId: "SECRET" };
  const bundle = createDiagnosticBundle(result, { session: { betaMean: -999, deviceId: "SECRET" } });
  const text = JSON.stringify(bundle);
  assert.doesNotMatch(text, /SECRET|PRIVATE|deviceId|groupId|rawSamples|audioBuffer|sourceFilename/);
  assert.equal(bundle.privacy.rawAudioIncluded, false);
  assert.equal(bundle.rawMeasurement.rawMeasuredBeta, result.rawMeasuredBeta);
  assert.equal(bundle.temporal.sessionAggregates.betaMean, -999, "session mean is distinct from raw measurement");
  assert.deepEqual(bundle.psd.powersPerHz, result.psd.power);
  assert.equal(bundle.acquisition.audioTrackSettings.noiseSuppression, false);
  assert.equal(bundle.calibration.rawMeasurementCorrected, false);
  assert.equal(bundle.calibration.auxiliaryEstimateAvailable, true);
  assert.deepEqual(bundle.calibration.points, result.calibration.points);
  const replay = replayDiagnosticSpectrum(JSON.parse(text));
  assert.deepEqual(replay.rawFit, result.measurement.rawFit);
  assert.equal(replay.rawFlatness, result.spectralFlatness);
  assert.deepEqual(sanitizeMetadata(replay.modelAdequacy), sanitizeMetadata(result.breakpointDiagnostics));
  assert.deepEqual(replay.tonality, result.measurement.tonality);
  result.psd.power[1] = 123;
  assert.notEqual(bundle.psd.powersPerHz[1], 123, "bundle cannot be mutated by a later measurement");
  assert.equal(canExportDiagnostic(compactMeasurement(result)), false);
  assert.throws(() => createDiagnosticBundle(compactMeasurement(result)), /unavailable/);
  assert.throws(() => replayDiagnosticSpectrum({ ...bundle, psd: { frequenciesHz: [0, 1], powersPerHz: [null, 1] } }), /non-finite/);
  assert.deepEqual(sanitizeAudioSettings({ deviceId: "SECRET", sampleRate: { groupId: "SECRET" }, channelCount: 1 }), { channelCount: 1 });
  assert.doesNotMatch(JSON.stringify(compactMeasurement(result)), /SECRET|deviceId|groupId|rawSamples/);
  const browser = browserDiagnosticInfo({ userAgent: "Mozilla/5.0 (PRIVATE DEVICE) Chrome/123.4.5 Safari/123" }, { secureContext: true });
  assert.deepEqual(browser, { family: "Chrome", version: "123.4.5", secureContext: true, standalone: false });
  assert.equal(browserDiagnosticInfo({ userAgent: "Chrome/123.0 Safari/1 Edg/124.0" }).family, "Edge");
  assert.equal(browserDiagnosticInfo({ userAgent: "Mobile CriOS/125.0 Safari/1" }).family, "Chrome");
  assert.equal(browserDiagnosticInfo({ userAgent: "Mobile FxiOS/126.0 Safari/1" }).family, "Firefox");
});

test("recovery: acoustic confidence remains engine-owned and never upgraded by live smoothing", () => {
  const machine = new ColorStateMachine({ requiredObservations: 1 });
  const acoustic = analyzeSamples(frequencyShapedColoredNoise(1, { responseDb: combinedAcousticEq }), 16000, analysisOptions);
  assert.equal(acoustic.confidence, "Moderate");
  assert.equal(machine.update(acoustic).confidence, "Moderate");
  assert.equal(machine.update({ ...acoustic, confidence: "Low" }).confidence, "Low");
  assert.equal(machine.update({ ...acoustic, confidence: "None" }).confidence, "None");
});

test("recovery: insufficient and invalid diagnostics never masquerade as a complete replay", () => {
  for (const samples of [new Float32Array(), Float32Array.of(NaN, Infinity), new Float32Array(100)]) {
    const result = analyzePcm({ samples, sampleRate: 16000, path: "live" });
    assert.equal(result.reliable, false);
    const bundle = createDiagnosticBundle(result);
    assert.equal(bundle.classification.reliable, false);
    assert.throws(() => replayDiagnosticSpectrum(bundle), /incomplete/);
    assert.doesNotThrow(() => JSON.stringify(bundle));
  }
});

test("raw PSD and beta exactly match frozen pre-v0.6.8 estimator across source paths", (t) => {
  const fixtures = [
    ...[0, 1, 2].map((beta) => coloredNoise(beta, { seed: 6900 + beta })),
    frequencyShapedColoredNoise(1, { seed: 6904, responseDb: (f) => combinedAcousticEq(f) + acousticResonanceResponse(f) }),
    frequencyShapedColoredNoise(1, { seed: 6905, responseDb: (f) => -10 * Math.log10(1 + (f / 1010) ** 4) }),
  ];
  for (const samples of fixtures) {
    const options = { ...analysisOptions, maxWelchSegments: 48 };
    const oldPsd = reference067.welchPSD(samples, 16000, 4096, 0.5, 48);
    const oldFit = reference067.fitPowerLaw(oldPsd.frequencies, oldPsd.power, ...options.fitRange);
    t.diagnostic(`Frozen/current raw β: ${oldFit.beta.toFixed(12)}; exact equality checked in all source paths`);
    const psd = welchPSD(samples, 16000, 4096, 0.5, 48);
    assert.deepEqual(psd.power, oldPsd.power, "Welch normalization and segment selection are unchanged");
    assert.equal(fitPowerLaw(psd.frequencies, psd.power, ...options.fitRange).beta, oldFit.beta);
    const before = new Float64Array(psd.power);
    modelAdequacyDiagnostics(psd.frequencies, psd.power, ...options.fitRange);
    assert.deepEqual(psd.power, before, "curvature diagnostics must not mutate the PSD");
    for (const sourceType of ["live", "recorded-microphone", "uploaded-file"]) {
      const result = sourceType === "live" ? analyzeSamples(samples, 16000, { ...options, sourceType })
        : analyzeRecording(samples, 16000, { ...options, sourceType });
      assert.equal(result.rawMeasuredBeta, oldFit.beta, sourceType);
      assert.equal(result.beta, oldFit.beta);
      assert.deepEqual(result.psd.power, Array.from(oldPsd.power));
      assert.equal(result.rawMeasurement.basis, "original-continuous-PSD");
      if (samples === fixtures.at(-1)) {
        assert.ok(Math.abs(result.rawMeasuredBeta - 3.74) < 0.03, "synthetic low-pass coloration can steepen a pink source's measured PSD");
        assert.equal(result.state, "mixed", "do not relabel a truly steep measured trend as pink");
      }
    }
  }
});

test("adjusted hinges require bandwidth, rank, and consistency with original slope evidence", () => {
  const frequencies = Float64Array.from({ length: 2049 }, (_, i) => i * 44100 / 4096);
  const power = Float64Array.from(frequencies, (f) => f > 0 ? f ** -1.36 * 10 ** ((
    8.8 * Math.sin(2 * Math.PI * normalizedAcousticFrequency(f))
    + 7 * Math.exp(-0.5 * (Math.log2(f / 3854) / 0.22) ** 2)
  ) / 10) : 0);
  const result = modelAdequacyDiagnostics(frequencies, power, 100, 8000);
  assert.ok(result.rejectedAdjustedBreakpoints.some((item) => item.reason === "polynomial-hinge-cancellation"));
  assert.ok(result.rejectedAdjustedBreakpoints.some((item) => item.reason === "insufficient-bandwidth"));
  assert.ok(result.abruptBreakpointSupportOctaves >= 0.25);
  assert.ok(result.abruptBreakpointMinimumNovelty >= 0.01);
  assert.ok(result.abruptBreakpointEffectiveSupportBins >= 2.5);
  const rescaled = modelAdequacyDiagnostics(Float64Array.from(frequencies, (f) => f * 2), Float64Array.from(power, (p) => p * 1e-6), 200, 16000);
  assert.ok(Math.abs(rescaled.abruptBreakpointSlopeDelta - result.abruptBreakpointSlopeDelta) < 1e-8);
  assert.ok(Math.abs(rescaled.smoothCurvatureMagnitudeDb - result.smoothCurvatureMagnitudeDb) < 1e-8);
  const narrow = modelAdequacyDiagnostics(frequencies, power, 3800, 3900);
  assert.equal(narrow.abruptBreakpointEvidence, 0, "insufficient logarithmic bandwidth must never produce an accepted hinge");
  for (const item of result.rejectedAdjustedBreakpoints) {
    assert.notEqual(result.abruptBreakpointFrequency, item.frequency, "invalid hinge must not win gate evidence");
  }
});

test("live dispatcher prevents deterministic fast-timer starvation without calling active PCM silence", () => {
  // Reproduce the old fast-first 500/1000 ms collision with a 100 ms worker.
  let busyUntil = 0;
  let legacyStable = 0;
  for (let time = 500; time <= 28000; time += 500) {
    if (time >= busyUntil) busyUntil = time + 100;
    if (time % 1000 === 0 && time >= busyUntil) legacyStable += 1;
  }
  assert.equal(legacyStable, 0);
  for (const config of Object.values(MODE_CONFIG)) {
    const scheduler = new LiveAnalysisScheduler(config);
    let stable = 0;
    busyUntil = 0;
    for (let time = 100; time <= 28000; time += 100) {
      const task = scheduler.next(time, time / 1000, time < busyUntil);
      if (task) busyUntil = time + 300;
      if (task === "stable") stable += 1;
    }
    assert.ok(stable >= 8, `stable observations: ${stable}`);
  }
  assert.deepEqual(sessionSignalPercentages({ insufficient: 100, silence: 0 }), { lowSignal: 0, awaitingAnalysis: 100 });
});

test("injected -18 dBFS PCM survives worklet transfer, live buffers, activity frames, and worker analysis", async () => {
  const samples = coloredNoise(1, { size: 524288, seed: 6909, rms: 10 ** (-18 / 20) }).slice(0, 448000);
  const rolling = new RollingBuffer(samples.length);
  const recordingBuffer = new RollingBuffer(samples.length);
  const sessionAccumulator = new SessionAccumulator(16000);
  const trace = new PcmTrace();
  const messages = [];
  let Processor;
  const worklet = (await readFile(new URL("../public/noisecolor/audio-worklet.js", import.meta.url), "utf8")).replace(/^import .*;\r?\n/gm, "");
  vm.runInNewContext(worklet, { Float32Array, PcmMeter, pcmMetrics,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (message, transfer) => messages.push(structuredClone(message, { transfer })) }; } },
    registerProcessor: (_, implementation) => { Processor = implementation; } });
  const processor = new Processor();
  const fallback = { state: "pink", classification: "Pink-like", reliable: true };
  for (let start = 0; start < samples.length; start += 128) {
    processor.process([[samples.subarray(start, start + 128)]]);
    while (messages.length) {
      const message = messages.shift();
      assert.deepEqual(message.output, pcmMetrics(message.samples));
      trace.record("workletOutput", message.samples);
      capturePcm(message.samples, { rolling, recordingBuffer, sessionAccumulator, trace, fallback });
    }
  }
  // Only complete 2048-sample packets have been delivered (bounded end tail).
  const captured = rolling.latest();
  assert.deepEqual(captured, samples.slice(0, captured.length));
  assert.deepEqual(recordingBuffer.latest(), captured);
  sessionAccumulator.finish(fallback);
  const summary = sessionAccumulator.summary();
  assert.equal(summary.percentages.silence, 0);
  assert.equal(summary.percentages.pink, 100);
  for (const metric of [summary.pcmDiagnostics.sessionAccumulator, summary.pcmDiagnostics.activityTimeline]) {
    assert.equal(metric.sampleCount, captured.length);
    assert.ok(Math.abs(metric.dbfs - pcmMetrics(captured).dbfs) < 1e-10);
    assert.equal(metric.nonzeroRatio, 1);
  }
  assert.ok(Math.abs(pcmMetrics(captured).dbfs + 18) < 0.3);
  let receive;
  let response;
  const worker = (await readFile(new URL("../public/noisecolor/analysis-worker.js", import.meta.url), "utf8")).replace(/^import .*;\r?\n/gm, "");
  vm.runInNewContext(worker, { Float32Array, analyzePcm, normalizePcm, buildSpectrogram: () => null,
    self: { addEventListener: (_, listener) => { receive = listener; }, postMessage: (value) => { response = value; } } });
  const results = [];
  for (const type of ["analyze-live", "analyze-recording"]) {
    const copy = rolling.latest(128000);
    trace.record("rollingBuffer", copy);
    receive({ data: structuredClone({ id: 1, type, samples: copy, sampleRate: 16000, options: { ...analysisOptions, maxWelchSegments: 48, pcmDiagnostics: trace.snapshot() } }, { transfer: [copy.buffer] }) });
    assert.equal(response.error, undefined);
    assert.notEqual(response.result.state, "silence");
    assert.deepEqual(response.result.pcmDiagnostics.workerInput, response.result.pcm);
    results.push(response.result);
  }
  assert.equal(results[0].rawMeasuredBeta, results[1].rawMeasuredBeta);
  assert.equal(results[0].dbfs, results[1].dbfs);
  assert.deepEqual(rolling.latest(), captured, "worker transfer cannot detach the capture ring");
});

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

test("slope-normalized tonality preserves clean and transducer-shaped white, pink, and brown noise", () => {
  const expected = [[0, "white"], [1, "pink"], [2, "brown"]];
  for (const [beta, state] of expected) {
    for (const [fixture, samples] of [
      ["clean", coloredNoise(beta, { seed: 610 + beta })],
      ["speaker/microphone EQ", frequencyShapedColoredNoise(beta, { seed: 620 + beta, responseDb: plausibleTransducerEq })],
    ]) {
      const result = analyzeSamples(samples, 16000, analysisOptions);
      assert.equal(result.state, state, `${fixture} β ${beta} was ${result.classification}: ${result.qualityDetail}`);
      assert.ok(result.slopeNormalizedFlatness > 0.9, `${fixture} β ${beta} normalized flatness ${result.slopeNormalizedFlatness}`);
      assert.equal(result.reliable, true);
    }
  }
});

test("smooth speaker and microphone response curves preserve broadband canonical colors", () => {
  const expected = [[0, "white"], [1, "pink"], [2, "brown"]];
  for (const [beta, state] of expected) {
    for (const [fixture, responseDb] of [["speaker", smoothSpeakerEq], ["microphone", smoothMicrophoneEq]]) {
      const result = analyzeSamples(frequencyShapedColoredNoise(beta, { seed: 640 + beta, responseDb }), 16000, analysisOptions);
      assert.equal(result.state, state, `${fixture} β ${beta} was ${result.classification}: ${result.qualityDetail}`);
      assert.equal(result.reliable, true);
      assert.notEqual(result.modelAdequacyStatus, "failed");
    }
  }
});

test("broad room/crossover and combined acoustic coloration remain broadband but reduce confidence", () => {
  const expected = [[0, "white"], [1, "pink"], [2, "brown"]];
  for (const [beta, state] of expected) {
    const room = analyzeSamples(frequencyShapedColoredNoise(beta, { seed: 660 + beta, responseDb: broadRoomCrossoverEq }), 16000, analysisOptions);
    assert.equal(room.state, state, `room/crossover β ${beta} was ${room.classification}: ${room.qualityDetail}`);
    const combined = analyzeSamples(frequencyShapedColoredNoise(beta, { seed: 670 + beta, responseDb: combinedAcousticEq }), 16000, analysisOptions);
    assert.equal(combined.state, state, `combined acoustic β ${beta} was ${combined.classification}: ${combined.qualityDetail}`);
    assert.equal(combined.confidence, "Moderate");
    assert.equal(combined.modelAdequacyStatus, "smooth-acoustic-coloration");
    assert.ok(combined.smoothCurvatureMagnitudeDb > 8);
    assert.ok(combined.abruptBreakpointImprovementDb < 0.04);
  }
});

test("seeded acoustic coloration stress matrix preserves white, pink, and brown decisions", () => {
  const expected = [[0, "white"], [1, "pink"], [2, "brown"]];
  const responses = [["speaker", smoothSpeakerEq], ["microphone", smoothMicrophoneEq], ["room/crossover", broadRoomCrossoverEq], ["combined", combinedAcousticEq]];
  for (const [beta, state] of expected) {
    for (let seedOffset = 0; seedOffset < 3; seedOffset += 1) {
      for (const [fixture, responseDb] of responses) {
        const result = analyzeSamples(frequencyShapedColoredNoise(beta, { seed: 1000 + beta * 100 + seedOffset, responseDb }), 16000, analysisOptions);
        assert.equal(result.state, state, `${fixture} β ${beta}, seed ${seedOffset}: ${result.classification} (${result.qualityDetail})`);
        assert.equal(result.reliable, true);
      }
    }
  }
});

test("reported 30-second 44.1 kHz acoustic fixture changes from legacy Mixed to Moderate Pink-like", (t) => {
  const samples = reportedAcousticFixture();
  const result = analyzeRecording(samples, 44100, { ...analysisOptions, fitRange: [100, 8000], maxWelchSegments: 96, temporalWindowSeconds: 6, temporalStepSeconds: 2 });
  t.diagnostic(JSON.stringify({ beta: result.rawMeasuredBeta, temporalSd: result.temporalBetaSd, rmseDb: result.rmseDb, classification: result.classification, confidence: result.confidence }));
  assert.equal(legacyModelAdequacyDecision(result), true, "fixture must reproduce the v0.6.7 model-adequacy rejection");
  assert.equal(result.state, "pink", result.qualityDetail);
  assert.equal(result.classification, "Pink-like");
  assert.equal(result.confidence, "Moderate");
  assert.equal(result.modelAdequacyStatus, "smooth-acoustic-coloration");
  assert.ok(Math.abs(result.beta - 1.36) < 0.03, `β ${result.beta}`);
  assert.ok(Math.abs(result.temporalBetaSd - 0.03) < 0.012, `temporal SD ${result.temporalBetaSd}`);
  assert.ok(Math.abs(result.rmseDb - 3.9) < 0.25, `RMSE ${result.rmseDb}`);
  assert.ok(Math.abs(result.r2 - 0.627) < 0.04, `R² ${result.r2}`);
  assert.ok(Math.abs(result.spectralFlatness - 0.118) < 0.025, `flatness ${result.spectralFlatness}`);
  assert.ok(result.smoothCurvatureMagnitudeDb > 10);
  assert.ok(result.smoothResidualRmseDb < 0.5);
  assert.ok(result.abruptBreakpointEvidence < 0.5);
});

test("realistic non-harmonic acoustic resonances no longer trigger the legacy tonal false positive", () => {
  const expected = [[0, "white"], [1, "pink"], [2, "brown"]];
  for (const [beta, state] of expected) {
    const samples = frequencyShapedColoredNoise(beta, { seed: 700 + beta, responseDb: acousticResonanceResponse });
    const first = analyzeSamples(samples, 16000, analysisOptions);
    assert.equal(legacyTonalityDecision(first), true, `fixture β ${beta} did not reproduce the legacy tonal decision`);
    assert.equal(first.state, state, `resonant β ${beta} was ${first.classification}: ${first.qualityDetail}`);
    assert.ok(first.prominentPeakCount >= 2);
    assert.ok(first.slopeNormalizedFlatness > first.spectralFlatness);
    const repeated = analyzeSamples(samples, 16000, { ...analysisOptions, previousProminentPeakFrequencies: first.prominentPeakFrequencies });
    assert.ok(repeated.persistentPeakCount >= 2, `expected persistent room peaks for β ${beta}`);
    assert.equal(repeated.state, state, "persistent non-harmonic room resonances must remain broadband noise");
  }
});

test("weak isolated tones preserve broadband colors while strong isolated tones are rejected", () => {
  const expected = [[0, "white"], [1, "pink"], [2, "brown"]];
  for (const [beta, state] of expected) {
    const weak = analyzeSamples(addSinusoids(coloredNoise(beta, { seed: 800 + beta, rms: 0.16 }), [[1000, 0.003]]), 16000, analysisOptions);
    assert.equal(weak.state, state, `weak tone over β ${beta} was ${weak.classification}`);
    for (const frequency of [220, 1000, 2300]) {
      const strong = analyzeSamples(addSinusoids(coloredNoise(beta, { seed: 810 + beta, rms: 0.1 }), [[frequency, 0.16]]), 16000, analysisOptions);
      assert.equal(strong.state, "tonal", `strong ${frequency} Hz tone over β ${beta} was ${strong.classification}`);
      assert.ok(strong.tonalPowerRatio > 0.15);
    }
  }
});

test("pure, harmonic, and music-like tones retain conservative non-noise classifications", () => {
  const pure = analyzeSamples(sineWave(997, { amplitude: 0.25 }), 16000, analysisOptions);
  const harmonicTones = [[220, 0.14], [440, 0.1], [660, 0.08], [880, 0.06], [1100, 0.05], [1320, 0.04]];
  const harmonic = analyzeSamples(addSinusoids(new Float32Array(65536), harmonicTones), 16000, analysisOptions);
  const musicLike = analyzeSamples(addSinusoids(coloredNoise(0, { seed: 899, rms: 0.025 }), harmonicTones.map(([frequency, amplitude], index) => [frequency, amplitude * 0.75, index * 0.37])), 16000, analysisOptions);
  assert.equal(pure.state, "tonal");
  assert.match(pure.qualityDetail, /Tonal evidence:/);
  assert.equal(harmonic.state, "tonal");
  assert.ok(harmonic.harmonicPeakCount >= 3);
  assert.ok(["tonal", "mixed"].includes(musicLike.state), `music-like fixture was ${musicLike.classification}`);
  assert.equal(musicLike.reliable, false);
});

test("strong tones remain tonal after combined acoustic coloration", () => {
  const broadband = frequencyShapedColoredNoise(1, { seed: 905, rms: 0.1, responseDb: combinedAcousticEq });
  const result = analyzeSamples(addSinusoids(broadband, [[997, 0.16]]), 16000, analysisOptions);
  assert.equal(result.state, "tonal", result.qualityDetail);
  assert.equal(result.reliable, false);
});

test("gradual but extreme curvature remains Mixed rather than receiving a canonical color", () => {
  const result = analyzeSamples(frequencyShapedColoredNoise(1, { seed: 915, responseDb: extremeSmoothCurvature }), 16000, analysisOptions);
  assert.equal(result.state, "mixed", result.qualityDetail);
  assert.equal(result.modelAdequacyStatus, "failed");
  assert.match(result.qualityDetail, /extreme smooth curvature|excessive continuous-PSD residual/);
});

test("two-regime spectra fail the single-power-law adequacy gate", () => {
  const result = analyzeSamples(twoRegimeNoise(), 16000, analysisOptions);
  assert.equal(result.state, "mixed");
  assert.equal(result.reliable, false);
  assert.ok(result.segmentedSlopeDelta > 0.75);
  assert.equal(result.modelAdequacyStatus, "failed");
  assert.match(result.qualityDetail, /abrupt breakpoint evidence/);
  assert.ok(result.abruptBreakpointEvidence > 1);
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

test("raw measured beta never changes with calibration; corrected estimate is separate", () => {
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
  assert.equal(corrected.rawMeasuredBeta, baseline.beta);
  assert.equal(corrected.beta, baseline.beta);
  assert.deepEqual(corrected.psd, baseline.psd);
  assert.ok(corrected.correctedEstimate.beta - baseline.beta > 0.35);
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
  const noisyConfidence = machine.update({ ...measurement(-1, "blue", "Blue-like"), temporalSd: 0.4, confidence: "Low" });
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
  assert.match(app, /Slope-normalized flatness/);
  assert.match(app, /Persistent peaks/);
  assert.match(app, /Harmonic evidence/);
  assert.match(app, /Broadband occupancy/);
  assert.match(app, /Nearest canonical target β/);
  assert.match(app, /Smooth curvature/);
  assert.match(app, /Smooth residual/);
  assert.match(app, /Abrupt breakpoint Δβ/);
  assert.match(app, /Model adequacy/);
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
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?$/);
  assert.match(ENGINE_VERSION, /^\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?$/);
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
