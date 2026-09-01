import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  APP_VERSION,
  ENGINE_VERSION,
  analyzeRecording,
  analyzeSamples,
  buildColorTimeline,
  fftInPlace,
  summarizeSession,
  thirdOctaveBands,
  welchPSD,
} from "../public/noisecolor/analysis-engine.js";
import { ColorStateMachine } from "../public/noisecolor/live-state.js";
import { MODE_CONFIG, RollingBuffer, selectBoundedAnalysisWindow } from "../public/noisecolor/live-runtime.js";

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
    { state: "white", startSeconds: 0, endSeconds: 4 },
    { state: "pink", startSeconds: 4, endSeconds: 10 },
  ]);
  const summary = summarizeSession(observations, 10);
  assert.equal(summary.percentages.white, 40);
  assert.equal(summary.percentages.pink, 60);
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
  const pink = machine.update(measurement(0.95, "pink", "Pink-like"));
  assert.equal(pink.state, "pink");
  const silence = machine.update({ beta: 0.95, state: "silence", classification: "Signal too low", reliable: false, qualityDetail: "Quiet." });
  assert.equal(silence.state, "silence");
  assert.equal(silence.displayBeta, null);
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
  const result = analyzeSamples(coloredNoise(1, { seed: 77 }), 16000, { ...analysisOptions, scalarGainDb: 3.5, inputRouteId: "test-mic" });
  assert.equal(result.scalarGainDb, 3.5);
  assert.equal(result.inputRouteId, "test-mic");
  assert.equal(result.corrected, false);
});
