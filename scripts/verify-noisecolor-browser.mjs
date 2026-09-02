// Local-only browser regression. Requires Playwright (or PLAYWRIGHT_MODULE URL)
// and a production preview at NOISECOLOR_URL. No real microphone is opened.
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fftInPlace, fitPowerLaw, welchPSD } from "../tests/fixtures/noisecolor-v067-beta-reference.mjs";
import { APP_VERSION } from "../public/noisecolor/analysis-engine.js";
import { replayDiagnosticSpectrum } from "../public/noisecolor/diagnostic-bundle.js";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const url = process.env.NOISECOLOR_URL || "http://127.0.0.1:43817/noisecolor/";
const evidence = await mkdtemp(join(tmpdir(), "noisecolor-browser-"));
const rate = 48000;
const real = new Float64Array(262144);
const imaginary = new Float64Array(real.length);
let seed = 6909;
for (let i = 1; i < real.length / 2; i += 1) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const phase = seed / 2 ** 32 * 2 * Math.PI;
  const amplitude = (i * rate / real.length) ** -0.5;
  real[i] = amplitude * Math.cos(phase);
  imaginary[i] = amplitude * Math.sin(phase);
  real[real.length - i] = real[i];
  imaginary[real.length - i] = -imaginary[i];
}
fftInPlace(real, imaginary, true);
const rms = Math.sqrt(real.reduce((sum, v) => sum + v * v, 0) / real.length);
const fixture = Float32Array.from(real, (v) => v / rms * 10 ** (-18 / 20));
const wav = Buffer.alloc(44 + fixture.length * 4);
wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(3, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 4, 28); wav.writeUInt16LE(4, 32); wav.writeUInt16LE(32, 34);
wav.write("data", 36); wav.writeUInt32LE(fixture.length * 4, 40);
fixture.forEach((v, i) => wav.writeFloatLE(v, 44 + i * 4));
const browser = await chromium.launch({ headless: true, channel: process.env.NOISECOLOR_BROWSER_CHANNEL || undefined, args: ["--autoplay-policy=no-user-gesture-required"] });
const report = { version: APP_VERSION, synthetic: true, evidence };
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  await context.addInitScript(({ pcm, rate }) => {
    const NativeContext = window.AudioContext;
    window.AudioContext = class extends NativeContext {
      constructor(options) { super(options); if (options?.latencyHint === "interactive") window.__qaAppContext = this; }
    };
    const NativeRecorder = window.MediaRecorder;
    window.MediaRecorder = class extends NativeRecorder {
      constructor(...args) { super(...args); window.__qaRecorder = this; }
    };
    window.__qaResults = [];
    const WorkerClass = window.Worker;
    window.Worker = class extends WorkerClass {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", ({ data }) => {
          if (data.result?.rawMeasuredBeta !== undefined) {
            window.__qaResults.push({ type: data.type, result: data.result });
            if (window.__qaResults.length > 40) window.__qaResults.shift();
          }
        });
      }
    };
    // Only the source is synthetic. Native MediaStream -> AudioWorklet (or
    // ScriptProcessor), capture callbacks, worker, and rendering remain intact.
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      window.__qaConstraints = constraints;
      const sourceContext = new AudioContext({ sampleRate: rate });
      await sourceContext.resume();
      const buffer = sourceContext.createBuffer(1, pcm.length, rate);
      buffer.copyToChannel(new Float32Array(pcm), 0);
      const source = sourceContext.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const destination = sourceContext.createMediaStreamDestination();
      source.connect(destination);
      source.start();
      window.__qaCaptureStream = destination.stream;
      return destination.stream;
    };
  }, { pcm: Array.from(fixture), rate });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  const diagnosticDownload = async (selector, path, name = path) => {
    const pending = page.waitForEvent("download");
    await page.locator(selector).click();
    const download = await pending;
    const destination = join(evidence, `${name}-diagnostic.json`);
    await download.saveAs(destination);
    const text = await readFile(destination, "utf8");
    const bundle = JSON.parse(text);
    assert.equal(bundle.acquisition.path, path);
    assert.equal(bundle.appVersion, APP_VERSION);
    assert.equal(bundle.engineVersion, APP_VERSION);
    assert.equal(bundle.privacy.rawAudioIncluded, false);
    assert.doesNotMatch(text, /deviceId|groupId|rawSamples|audioBuffer|synthetic-pink-float32\.wav/);
    const replay = replayDiagnosticSpectrum(bundle);
    assert.ok(Math.abs(replay.rawFit.beta - bundle.rawMeasurement.rawMeasuredBeta) < 1e-12, "cross-runtime PSD beta replay within numerical precision");
    assert.ok(Math.abs(replay.rawFit.rmseDb - bundle.rawMeasurement.rmseDb) < 1e-12, "cross-runtime RMSE replay within numerical precision");
    assert.equal(bundle.acquisition.window.endSample - bundle.acquisition.window.startSample, bundle.rawMeasurement.pcm.sampleCount);
    assert.equal(bundle.pcmStages.workerInput.dbfs, bundle.rawMeasurement.pcm.dbfs);
    assert.equal(bundle.configuration.welch.segmentStarts.length, bundle.configuration.welch.segments);
    return bundle;
  };
  await page.goto(url);
  await page.locator("#versionLabel").filter({ hasText: APP_VERSION }).waitFor({ state: "attached" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator("#startLiveButton").click();
  await page.waitForFunction(() => document.getElementById("privacyChip").textContent === "Listening locally", null, { timeout: 10000 });
  console.log("Synthetic live capture started (28 seconds).");
  await page.waitForTimeout(28000);
  const liveResults = await page.evaluate(() => window.__qaResults.filter((x) => x.type === "analyze-live"));
  if (!liveResults.length) console.error(JSON.stringify({ evidence, errors, page: await page.locator("body").innerText(), capture: await page.evaluate(() => ({ contextState: window.__qaAppContext?.state, track: window.__qaCaptureStream?.getAudioTracks()[0]?.readyState, muted: window.__qaCaptureStream?.getAudioTracks()[0]?.muted, messages: window.__qaResults })) }));
  assert.ok(liveResults.length >= 8, `stable results ${liveResults.length}`);
  const live = liveResults.at(-1).result;
  assert.equal(live.state, "pink");
  assert.ok(Math.abs(live.dbfs + 18) < 0.3);
  assert.ok(Math.abs(live.pcmDiagnostics.workerInput.dbfs - live.dbfs) < 1e-10);
  assert.ok(Math.abs(live.pcmDiagnostics.lastActivityFrame.dbfs + 18) < 1);
  assert.equal(live.pcmDiagnostics.lastActivityFrame.sampleCount, rate / 2);
  assert.ok(live.measurementWindow.startSample > 0, "capture sample clock advances independently of worker completion");
  assert.equal(live.measurementWindow.endSample, live.pcmDiagnostics.sessionAccumulator.sampleCount);
  await page.locator("#stopLiveButton").click();
  const summary = await page.locator("#summaryMetrics").innerText();
  assert.match(summary, /Low signal\s+0%/i);
  assert.doesNotMatch(summary, /Reliable time\s+0%/i);
  const liveBundle = await diagnosticDownload("#exportLiveDiagnosticButton", "live");
  assert.ok(liveBundle.temporal.observations.length >= 8);
  assert.equal(liveBundle.acquisition.window.job, "primary");
  assert.ok(liveBundle.temporal.sessionAggregates.sessionDurationSeconds > liveBundle.acquisition.durationSeconds);
  assert.equal(liveBundle.rawMeasurement.rawMeasuredBeta, live.rawMeasuredBeta);
  await page.screenshot({ path: join(evidence, "mobile-live-summary.png"), fullPage: true });
  report.live = { stableResults: liveResults.length, beta: live.rawMeasuredBeta, dbfs: live.dbfs, summary };
  console.log(JSON.stringify({ live: report.live }));

  await page.locator('[data-view="record"]:visible').click();
  await page.locator("#recordButton").click();
  await page.waitForTimeout(8500);
  await page.locator("#stopRecordButton").click();
  await page.locator("#recordResult:not([hidden])").waitFor();
  const recorded = await page.evaluate(() => window.__qaResults.findLast((x) => x.type === "analyze-recording").result);
  assert.equal(recorded.state, "pink");
  assert.ok(Math.abs(recorded.dbfs - live.dbfs) < 0.3);
  assert.equal(recorded.pcmDiagnostics.recordingBuffer.dbfs, recorded.pcmDiagnostics.workerInput.dbfs);
  assert.equal(recorded.pcmDiagnostics.workerInput.dbfs, recorded.dbfs);
  const recordedBundle = await diagnosticDownload('#recordResult [data-action="diagnostic"]', "recording");
  assert.equal(recordedBundle.rawMeasurement.rawMeasuredBeta, recorded.rawMeasuredBeta);
  report.recorded = { beta: recorded.rawMeasuredBeta, dbfs: recorded.dbfs, identicalBufferWorkerDbfs: true };

  // Suspend the real AudioContext. The live track can be resumed explicitly.
  await page.locator("#recordButton").click();
  await page.waitForTimeout(4000);
  await page.evaluate(() => window.__qaAppContext.suspend());
  await page.locator("#captureInterruption:not([hidden])").waitFor();
  assert.equal(await page.evaluate(() => window.__qaCaptureStream.getAudioTracks()[0].readyState), "live");
  assert.equal(await page.evaluate(() => window.__qaRecorder.state), "paused");
  await page.waitForTimeout(1200);
  await page.locator("#resumeCaptureButton").click();
  await page.locator("#captureInterruption").waitFor({ state: "hidden" });
  await page.waitForTimeout(8500);
  await page.locator("#stopRecordButton").click();
  await page.locator("#recordResult:not([hidden])").waitFor();
  const resumed = await diagnosticDownload('#recordResult [data-action="diagnostic"]', "recording", "resumed-recording");
  assert.ok(resumed.acquisition.window.startSample > 0);
  assert.ok(resumed.acquisition.durationSeconds < resumed.acquisition.sourceDurationSeconds);
  assert.ok(resumed.capture.interruptions.some((event) => event.recovered && event.gapSeconds >= 1));
  assert.equal(resumed.classification.state, "pink");
  assert.ok(Math.abs(resumed.rawMeasurement.pcm.dbfs + 18) < 0.3);
  report.recoverableInterruption = { recorded: true, finalContiguousSegment: true, gapExcludedFromPcm: true };

  await page.locator('[data-view="upload"]:visible').click();
  await page.locator("#audioFile").setInputFiles({ name: "synthetic-pink-float32.wav", mimeType: "audio/wav", buffer: wav });
  await page.locator("#uploadResult:not([hidden])").waitFor();
  const uploaded = await page.evaluate(() => window.__qaResults.findLast((x) => x.type === "analyze-recording").result);
  const psd = welchPSD(fixture, rate, 4096, 0.5, 48);
  const expectedBeta = fitPowerLaw(psd.frequencies, psd.power, 100, 8000).beta;
  assert.ok(Math.abs(uploaded.rawMeasuredBeta - expectedBeta) < 1e-12);
  assert.equal(uploaded.state, "pink");
  const uploadBundle = await diagnosticDownload('#uploadResult [data-action="diagnostic"]', "upload");
  assert.ok(Math.abs(uploadBundle.rawMeasurement.rawMeasuredBeta - expectedBeta) < 1e-12);
  assert.equal(uploadBundle.acquisition.decoder, "direct-PCM-WAV");
  report.uploaded = { beta: uploaded.rawMeasuredBeta, frozenReferenceBeta: expectedBeta };
  await page.locator('[data-view="advanced"]:visible').click();
  await page.getByRole("tab", { name: "Diagnostics", exact: true }).click();
  assert.match(await page.locator("#diagnosticGrid").innerText(), /PCM workerInput/i);
  await diagnosticDownload("#exportDiagnosticButton", "upload", "advanced-upload");
  await page.screenshot({ path: join(evidence, "mobile-diagnostics.png"), fullPage: true });

  await page.reload();
  await page.evaluate(() => Object.defineProperty(AudioContext.prototype, "audioWorklet", { configurable: true, get: () => undefined }));
  await page.locator("#analysisMode").selectOption("instant");
  await page.locator("#startLiveButton").click();
  await page.waitForFunction(() => window.__qaResults.filter((x) => x.type === "analyze-live").length >= 3, null, { timeout: 15000 });
  const fallback = await page.evaluate(() => window.__qaResults.findLast((x) => x.type === "analyze-live").result);
  assert.equal(fallback.state, "pink");
  assert.ok(Math.abs(fallback.dbfs + 18) < 0.3);
  assert.match(fallback.pcmDiagnostics.source.transport, /ScriptProcessor/);
  await page.evaluate(() => window.__qaAppContext.suspend());
  await page.locator("#captureInterruption:not([hidden])").waitFor();
  await page.locator("#resumeCaptureButton").click();
  await page.waitForFunction(() => window.__qaResults.findLast((x) => x.type === "analyze-live")?.result.captureEvents?.some((event) => event.recovered), null, { timeout: 15000 });
  const recoveredLive = await page.evaluate(() => window.__qaResults.findLast((x) => x.type === "analyze-live").result);
  assert.equal(recoveredLive.state, "pink");
  assert.ok(recoveredLive.measurementWindow.startSample >= recoveredLive.captureEvents[0].resumeSampleOffset);
  await page.evaluate(() => { const track = window.__qaCaptureStream.getAudioTracks()[0]; track.stop(); track.dispatchEvent(new Event("ended")); });
  await page.locator("#startLiveButton").waitFor({ state: "visible" });
  const endedBundle = await diagnosticDownload("#exportLiveDiagnosticButton", "live", "ended-live");
  assert.ok(endedBundle.capture.interruptions.some((event) => event.kind === "Microphone unavailable"));
  report.recoverableInterruption.liveScriptProcessor = true;
  report.recoverableInterruption.endedTrackFinalized = true;
  report.scriptProcessor = { beta: fallback.rawMeasuredBeta, dbfs: fallback.dbfs };
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  assert.equal(scope, new URL("./", url).href);
  await context.setOffline(true);
  await page.reload();
  assert.match(await page.locator("#versionLabel").innerText(), new RegExp(APP_VERSION));
  assert.equal(await page.locator("#startLiveButton").isVisible(), true);
  const caches = await page.evaluate(() => window.caches.keys());
  assert.ok(caches.includes(`noisecolor-shell-${APP_VERSION}`));
  report.pwa = { scope, offline: true, caches };
  await page.locator('[data-view="upload"]:visible').click();
  await page.locator("#audioFile").setInputFiles({ name: "synthetic-pink-float32.wav", mimeType: "audio/wav", buffer: wav });
  await page.locator("#uploadResult:not([hidden])").waitFor();
  const offlineBundle = await diagnosticDownload('#uploadResult [data-action="diagnostic"]', "upload", "offline-upload");
  assert.ok(Math.abs(offlineBundle.rawMeasurement.rawMeasuredBeta - expectedBeta) < 1e-12);
  await page.locator("#clearButton").click();
  assert.equal(await page.locator("#exportLiveDiagnosticButton").isDisabled(), true);
  report.diagnosticBundles = { live: true, recording: true, upload: true, advanced: true, offline: true, exactPsdReplay: true, rawAudioExcluded: true, identifiersExcluded: true };
  await context.setOffline(false);
  await page.goto(`${url}?install=ios`);
  await page.locator("#installSheet").waitFor();
  assert.match(await page.locator("#installInstructions").innerText(), /Add to Home Screen/);
  await page.locator("#closeInstallSheet").click();
  await page.goto(url);
  await page.evaluate(() => {
    const event = new Event("beforeinstallprompt", { cancelable: true });
    event.prompt = () => { window.__qaPrompted = true; };
    event.userChoice = Promise.resolve({ outcome: "accepted" });
    window.dispatchEvent(event);
  });
  await page.locator("#installButton").click();
  assert.equal(await page.evaluate(() => window.__qaPrompted), true);
  await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
  assert.equal(await page.locator("#installButton").isDisabled(), true);
  report.pwa.installGuidanceAndEvents = true;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(url);
  await page.screenshot({ path: join(evidence, "desktop.png"), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  report.pageErrors = errors;
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
