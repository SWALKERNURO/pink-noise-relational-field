// Synthetic source + browser-context emulation, NOT a physical iPhone/WebKit test.
// All microphone requests are intercepted; no hardware is opened.
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_VERSION, ENGINE_VERSION } from "../public/noisecolor/analysis-engine.js";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const url = process.env.NOISECOLOR_URL || "http://127.0.0.1:43819/noisecolor/";
const evidence = await mkdtemp(join(tmpdir(), "noisecolor-ios-"));
const browser = await chromium.launch({ headless: true, channel: process.env.NOISECOLOR_BROWSER_CHANNEL || undefined, args: ["--autoplay-policy=no-user-gesture-required"] });
const iosUA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const cases = [
  { name: "ios-safari-live", ios: true },
  { name: "ios-standalone-live-success", ios: true, standalone: true },
  { name: "ios-standalone-record-success", ios: true, standalone: true, recording: true },
  { name: "ios-standalone-live-denied", ios: true, standalone: true, denied: true },
  { name: "ios-displaymode-record-denied", ios: true, displayStandalone: true, denied: true, recording: true },
  { name: "ipad-desktop-ua-denied", ios: true, ipad: true, standalone: true, denied: true },
  { name: "android-standalone", android: true, displayStandalone: true },
  { name: "android-browser-install", android: true },
  { name: "desktop-live" },
  { name: "desktop-denied", denied: true },
  { name: "ios-safari-denied", ios: true, denied: true },
];
const report = { appVersion: APP_VERSION, engineVersion: ENGINE_VERSION, evidence, emulation: "Chromium with iOS/Android navigator/display-mode; synthetic MediaStream; not physical Safari", cases: [] };
// A local WAV proves Upload and saved History survive permission rejection.
const rate = 16000;
const count = rate * 4;
const wav = Buffer.alloc(44 + count * 2);
wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(count * 2, 40);
for (let i = 0; i < count; i++) wav.writeInt16LE(Math.round(4096 * Math.sin(i * 2 * Math.PI * 440 / rate)), 44 + i * 2);
try {
  for (const scenario of cases) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true, isMobile: Boolean(scenario.ios || scenario.android), hasTouch: Boolean(scenario.ios || scenario.android),
      userAgent: scenario.ipad ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15" : scenario.ios ? iosUA : scenario.android ? "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/135.0 Mobile Safari/537.36" : undefined });
    await context.addInitScript((scenario) => {
      Object.defineProperty(navigator, "standalone", { configurable: true, value: Boolean(scenario.standalone) });
      Object.defineProperty(navigator, "platform", { configurable: true, value: scenario.ipad ? "MacIntel" : scenario.ios ? "iPhone" : "Linux" });
      Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: scenario.ios ? 5 : 0 });
      const nativeMatch = window.matchMedia.bind(window);
      window.matchMedia = (query) => query === "(display-mode: standalone)" ? { matches: Boolean(scenario.displayStandalone), media: query, addEventListener() {}, removeEventListener() {} } : nativeMatch(query);
      window.__qaDenied = Boolean(scenario.denied);
      window.__qaCalls = 0;
      window.__qaOpened = [];
      window.__qaSources = [];
      window.__qaPopupThrows = false;
      window.open = (...args) => { window.__qaOpened.push({ args, gesture: navigator.userActivation.isActive }); if (window.__qaPopupThrows) throw new Error("blocked"); return null; };
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { async writeText(text) { if (window.__qaCopyBlocked) throw new Error("blocked"); window.__qaCopied = text; } } });
      navigator.mediaDevices.getUserMedia = async () => {
        window.__qaCalls++;
        if (window.__qaDenied) throw new DOMException("The request is not allowed by the user agent or the platform in the current context. deviceId SECRET groupId SECRET", "NotAllowedError");
        const audio = new AudioContext({ sampleRate: 48000 });
        await audio.resume();
        const buffer = audio.createBuffer(1, 48000, 48000);
        let seed = 42;
        const pcm = buffer.getChannelData(0);
        for (let i = 0; i < pcm.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pcm[i] = ((seed / 2 ** 32) * 2 - 1) * 0.2; }
        const source = audio.createBufferSource(); source.buffer = buffer; source.loop = true;
        const output = audio.createMediaStreamDestination(); source.connect(output); source.start();
        window.__qaSources.push(audio); window.__qaTrack = output.stream.getAudioTracks()[0];
        return output.stream;
      };
    }, scenario);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(url);
    // Settle the existing first-install controllerchange reload before capture.
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    await page.waitForLoadState("networkidle");
    await page.locator("#versionLabel").filter({ hasText: APP_VERSION }).waitFor({ state: "attached" });
    if (scenario.ios) {
      assert.equal(await page.locator("#installButton").isEnabled(), true);
      await page.locator("#installButton").click();
      const instructions = await page.locator("#installInstructions").innerText();
      assert.match(instructions, /Recommended for Live\/Record/);
      assert.match(instructions, /Home Screen Safari shortcut/);
      assert.match(instructions, /Open as Web App OFF/);
      assert.match(instructions, /Standalone web app/);
      await page.locator("#closeInstallSheet").click();
    }
    if (scenario.android && !scenario.displayStandalone) {
      await page.evaluate(() => {
        const event = new Event("beforeinstallprompt", { cancelable: true });
        event.prompt = () => { window.__qaPrompted = true; }; event.userChoice = Promise.resolve({ outcome: "accepted" });
        window.dispatchEvent(event);
      });
      await page.locator("#installButton").click();
      assert.equal(await page.evaluate(() => window.__qaPrompted), true);
      await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
      assert.equal(await page.locator("#installButton").isDisabled(), true);
    }
    if (scenario.android && scenario.displayStandalone) assert.equal(await page.locator("#installButton").isDisabled(), true);
    if (scenario.recording) await page.locator('[data-view="record"]:visible').click();
    await page.locator(scenario.recording ? "#recordButton" : "#startLiveButton").click();
    const iosBlocked = scenario.ios && (scenario.standalone || scenario.displayStandalone) && scenario.denied;
    if (scenario.denied) {
      await page.locator("#microphoneFailure").waitFor();
      assert.equal(await page.locator("#microphoneFailureTitle").innerText(), iosBlocked ? "MICROPHONE BLOCKED BY iOS" : "Microphone unavailable");
      assert.equal(await page.locator("#iosMicrophoneActions").isVisible(), Boolean(iosBlocked));
      const downloadEvent = page.waitForEvent("download");
      await page.locator("#exportStartupDiagnosticButton").click();
      const download = await downloadEvent;
      const path = join(evidence, `${scenario.name}.json`);
      await download.saveAs(path);
      const text = await readFile(path, "utf8");
      const bundle = JSON.parse(text);
      const failure = bundle.capture.startupFailure;
      assert.equal(bundle.kind, "microphone-startup-failure");
      assert.equal(bundle.appVersion, APP_VERSION); assert.equal(bundle.engineVersion, ENGINE_VERSION);
      assert.equal(failure.acquisitionMode, scenario.recording ? "recording" : "live");
      assert.equal(failure.errorName, "NotAllowedError"); assert.equal(failure.stage, "get-user-media");
      assert.equal(failure.standalone, Boolean(scenario.standalone || scenario.displayStandalone));
      assert.equal(failure.displayMode, scenario.displayStandalone ? "standalone" : "browser");
      assert.equal(failure.ios, Boolean(scenario.ios)); assert.equal(failure.secureContext, true);
      assert.equal(failure.mediaDevicesAvailable, true); assert.equal(failure.getUserMediaAvailable, true);
      assert.equal(failure.trackObtained, false); assert.equal(failure.audioTrackSettings, null);
      assert.equal(bundle.rawMeasurement, null); assert.equal(bundle.psd, null);
      assert.doesNotMatch(text, /SECRET|deviceId|groupId/);
      if (iosBlocked) {
        await page.screenshot({ path: join(evidence, `${scenario.name}.png`), fullPage: true });
        assert.doesNotMatch(await page.locator("body").innerText(), /MICROPHONE UNAVAILABLE/);
        await page.locator("#openSafariButton").click();
        assert.equal(await page.locator("#safariFallback").isVisible(), true);
        assert.deepEqual(await page.evaluate(() => window.__qaOpened), [{ args: [new URL("./", url).href, "_blank", "noopener,noreferrer"], gesture: true }]);
        assert.equal(page.url(), url);
        assert.equal(await page.locator("#safariCanonicalLink").getAttribute("href"), new URL("./", url).href);
        assert.equal(await page.locator("#safariCanonicalLink").getAttribute("target"), "_blank");
        await page.locator("#copySafariLinkButton").click();
        assert.equal(await page.evaluate(() => window.__qaCopied), new URL("./", url).href);
        await page.evaluate(() => { window.__qaCopyBlocked = true; window.__qaPopupThrows = true; });
        await page.locator("#openSafariButton").click();
        await page.locator("#copySafariLinkButton").click();
        assert.match(await page.locator("#safariLinkStatus").innerText(), /Touch and hold/);
        await page.locator("#reinstallMicrophoneButton").click();
        const steps = await page.locator("#installInstructions ol li").allTextContents();
        assert.deepEqual(steps, ["Remove the existing NoiseColor Home Screen web app.", "Open NoiseColor in Safari.", "Confirm Live Analysis works and allow microphone access.", "Safari → Share → Add to Home Screen.", "Turn Open as Web App OFF.", "Tap Add."]);
        await page.screenshot({ path: join(evidence, `${scenario.name}-reinstall.png`), fullPage: true });
        await page.locator("#closeInstallSheet").click();
      }
      assert.equal(await page.evaluate(() => window.__qaCalls), 1, "no automatic retry/redirect loop");
      // Non-microphone capabilities work after denial, including actual persistence.
      await page.locator('[data-view="upload"]:visible').click();
      assert.equal(await page.locator("#microphoneFailure").isVisible(), false);
      await page.locator("#audioFile").setInputFiles({ name: "local-tone.wav", mimeType: "audio/wav", buffer: wav });
      await page.locator("#uploadResult:not([hidden])").waitFor();
      await page.locator('#uploadResult [data-action="save"]').click();
      await page.locator('#uploadResult [data-action="save"]:disabled').waitFor();
      await page.locator('[data-view="history"]:visible').click();
      await page.locator("#historyList .history-item").first().waitFor();
      await page.locator('[data-view="advanced"]:visible').click();
      assert.equal(await page.locator("#advancedView").isVisible(), true);
      assert.equal(await page.locator("#exportDiagnosticButton").isEnabled(), true);
      // Retry is a fresh explicit gesture and returns to the failed mode.
      await page.locator('[data-view="live"]:visible').click();
      await page.evaluate(() => { window.__qaDenied = false; });
      await page.locator("#retryMicrophoneButton").click();
    }
    await page.waitForFunction((recording) => document.getElementById("privacyChip").textContent === (recording ? "Recording locally" : "Listening locally"), Boolean(scenario.recording));
    assert.equal(await page.locator("#microphoneFailure").isVisible(), false);
    assert.equal(await page.evaluate(() => window.__qaCalls), scenario.denied ? 2 : 1);
    if (scenario.recording) {
      await page.waitForTimeout(3500);
      await page.locator("#stopRecordButton").click();
      await page.locator("#recordResult:not([hidden])").waitFor();
    } else {
      await page.waitForFunction(() => document.getElementById("signalLevel").textContent.includes("dBFS"));
      await page.locator("#stopLiveButton").click();
    }
    assert.equal(await page.evaluate(() => window.__qaTrack.readyState), "ended");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.evaluate(() => Promise.all(window.__qaSources.map((source) => source.close())));
    if (scenario.name === "ios-standalone-live-denied") {
      await context.setOffline(true);
      await page.reload();
      await page.locator("#startLiveButton").click();
      await page.locator("#microphoneFailure").waitFor();
      const offlineDownload = page.waitForEvent("download");
      await page.locator("#exportStartupDiagnosticButton").click();
      const offlinePath = join(evidence, "offline-startup-failure.json");
      await (await offlineDownload).saveAs(offlinePath);
      assert.equal(JSON.parse(await readFile(offlinePath, "utf8")).capture.startupFailure.standalone, true);
      await page.locator("#reinstallMicrophoneButton").click();
      assert.match(await page.locator("#installInstructions").innerText(), /Open as Web App OFF/);
      report.offlineStartupExportAndGuidance = true;
    }
    assert.deepEqual(errors, []);
    report.cases.push({ name: scenario.name, passed: true });
    console.log(`PASS ${scenario.name}`);
    await context.close();
  }
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
