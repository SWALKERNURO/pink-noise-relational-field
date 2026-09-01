import {
  APP_VERSION,
  ENGINE_VERSION,
  CANONICAL_COLORS,
  DEFAULT_FIT_RANGE,
  FFT_SIZE,
  WELCH_OVERLAP,
  summarize,
  summarizeSession,
} from "./analysis-engine.js?v=0.5.3";
import { ColorStateMachine, createStatusState } from "./live-state.js?v=0.5.3";
import { clearMeasurements, deleteMeasurement, listMeasurements, saveMeasurement } from "./history.js?v=0.5.3";
import { isStandalone, platformInstallHint, setupPwa } from "./pwa.js?v=0.5.3";
import { MODE_CONFIG, ROLLING_SECONDS, RollingBuffer, selectBoundedAnalysisWindow } from "./live-runtime.js?v=0.5.3";

const MAX_FILE_BYTES = 100 * 1024 * 1024;

const elements = Object.fromEntries([
  "appShell", "installButton", "updateBanner", "reloadButton", "liveView", "analysisMode", "classification",
  "liveStateLabel", "stableBeta", "confidence", "qualityDetail", "startLiveButton", "stopLiveButton", "currentColor",
  "instantBeta", "stability", "fitResidual", "signalLevel", "windowValue", "betaCanvas", "liveSummary", "summaryMetrics",
  "saveSummaryButton", "exportSummaryButton", "exportSummaryCsvButton", "recordTimer", "recordFormat", "recordButton", "stopRecordButton",
  "downloadAudioButton", "recordStatus", "recordResult", "fileDrop", "audioFile", "fileName", "uploadStatus",
  "uploadResult", "clearHistoryButton", "historyList", "spectrumCanvas", "spectrumNote", "spectrogramCanvas",
  "diagnosticGrid", "measuredCopy", "interpretationCopy", "calibrationFile", "calibrationProfile", "calibrationState",
  "scalarGain", "railMeasured", "railInterpretation", "railStatus", "versionLabel", "installSheet", "closeInstallSheet",
  "installInstructions", "privacyChip", "summaryTimeline",
].map((id) => [id, document.getElementById(id)]));

const stateMachine = new ColorStateMachine();
const state = {
  worker: null,
  workerRequests: new Map(),
  workerId: 0,
  stream: null,
  audioContext: null,
  sourceNode: null,
  captureNode: null,
  silentGain: null,
  rolling: null,
  listening: false,
  recording: false,
  sampleRate: null,
  inputRoute: null,
  constraintSettings: null,
  startedAt: null,
  fastTimer: null,
  stableTimer: null,
  spectrogramTimer: null,
  recordTimer: null,
  fastBusy: false,
  stableBusy: false,
  wakeLock: null,
  observations: [],
  betaHistory: [],
  latestResult: null,
  latestSpectrogram: null,
  lastSummary: null,
  recorder: null,
  recordingChunks: [],
  recordingBlob: null,
  recordingUrl: null,
  calibrationProfiles: [],
  activeCalibration: null,
  activeSpectrum: "psd",
  installPromptReady: false,
  stopping: false,
  finalizingRecording: false,
  captureGeneration: 0,
};

function modeConfig() {
  return MODE_CONFIG[elements.analysisMode.value] || MODE_CONFIG.balanced;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function formatNumber(value, digits = 2, suffix = "") {
  return Number.isFinite(value) ? `${value.toFixed(digits)}${suffix}` : "—";
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.round(seconds || 0));
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function currentOptions(sourceType = "live", sourceFilename = null, extra = {}) {
  const profile = state.activeCalibration && state.inputRoute && state.activeCalibration.routeId === state.inputRoute
    ? state.activeCalibration
    : null;
  return {
    fftSize: FFT_SIZE,
    overlap: WELCH_OVERLAP,
    fitRange: DEFAULT_FIT_RANGE,
    analysisMode: elements.analysisMode.value,
    sourceType,
    sourceFilename,
    calibrationProfile: profile,
    temporalSd: sourceType === "live" ? summarize(state.observations.slice(-10).filter((item) => item.reliable).map((item) => item.beta)).sd || 0 : 0,
    maxWelchSegments: sourceType === "live" ? 48 : 96,
    scalarGainDb: Number(elements.scalarGain.value) || 0,
    inputRouteId: state.inputRoute,
    microphoneSettings: sourceType === "live" || sourceType === "recorded-microphone" ? state.constraintSettings : null,
    ...extra,
  };
}

function ensureWorker() {
  if (state.worker) return state.worker;
  state.worker = new Worker(new URL("./analysis-worker.js?v=0.5.3", import.meta.url), { type: "module" });
  state.worker.addEventListener("message", (event) => {
    const request = state.workerRequests.get(event.data.id);
    if (!request) return;
    state.workerRequests.delete(event.data.id);
    if (event.data.error) request.reject(new Error(event.data.error));
    else request.resolve(event.data.result);
  });
  state.worker.addEventListener("error", (error) => {
    for (const request of state.workerRequests.values()) request.reject(error);
    state.workerRequests.clear();
  });
  return state.worker;
}

function requestAnalysis(type, samples, sampleRate, options = {}) {
  const worker = ensureWorker();
  const id = ++state.workerId;
  return new Promise((resolve, reject) => {
    state.workerRequests.set(id, { resolve, reject });
    worker.postMessage({ id, type, samples, sampleRate, options }, [samples.buffer]);
  });
}

function setView(view) {
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    const active = panel.dataset.viewPanel === view;
    panel.hidden = !active;
    panel.classList.toggle("active", active);
  });
  document.querySelectorAll("[data-view]").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    if (button.matches(".mode-button")) active ? button.setAttribute("aria-current", "page") : button.removeAttribute("aria-current");
  });
  if (view === "history") refreshHistory();
  if (view === "advanced") renderAdvanced(state.latestResult);
}

function displayLiveState(display, measurement = null) {
  elements.appShell.dataset.state = display.state;
  elements.liveStateLabel.textContent = display.state.replaceAll("-", " ").toUpperCase();
  elements.classification.textContent = display.label;
  elements.stableBeta.textContent = display.reliable && Number.isFinite(display.displayBeta) ? `β ${display.displayBeta.toFixed(2)}` : "β —";
  elements.confidence.textContent = display.reliable
    ? `${display.confidence} confidence`
    : display.state === "listening" ? "No stable estimate yet" : "No reliable color reported";
  elements.qualityDetail.textContent = display.detail || measurement?.qualityDetail || "The stable estimator is the primary result.";
  elements.currentColor.textContent = display.reliable ? display.label : display.label;
  if (!display.reliable) elements.stability.textContent = "—";
  elements.railMeasured.innerHTML = display.reliable
    ? `<strong>${escapeHtml(display.label)}</strong><br>β ${formatNumber(display.displayBeta)}<br>${escapeHtml(display.confidence)} confidence`
    : `<strong>${escapeHtml(display.label)}</strong><br>No reliable color is being reported.`;
  elements.railInterpretation.textContent = display.detail || "The stable classification is quality-gated.";
}

function clearStaleMeasurement(label = "Analysis paused", stateName = "paused", detail = "Live values were cleared because the microphone is not active.") {
  state.latestResult = null;
  state.latestSpectrogram = null;
  elements.instantBeta.textContent = "—";
  elements.fitResidual.textContent = "—";
  elements.signalLevel.textContent = "—";
  displayLiveState(stateMachine.block(stateName, label), { qualityDetail: detail });
  elements.qualityDetail.textContent = detail;
  drawEmpty(elements.spectrumCanvas, "No spectrum available");
  drawEmpty(elements.spectrogramCanvas, "No spectrogram available");
}

function inputRouteFromTrack(track) {
  const settings = track.getSettings?.() || {};
  return settings.deviceId || track.label || "default-microphone";
}

async function acquireWakeLock() {
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => { state.wakeLock = null; });
  } catch {
    state.wakeLock = null;
  }
}

async function releaseWakeLock() {
  try { await state.wakeLock?.release(); } catch { /* already released */ }
  state.wakeLock = null;
}

async function startMicrophone({ recording = false } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone access is not supported in this browser.");
  if (state.recording && !recording) throw new Error("Stop the current recording before starting Live Analysis.");
  if (state.stream) await stopMicrophone({ preserveSummary: false, silent: true });
  const constraints = {
    audio: { channelCount: { ideal: 1 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    video: false,
  };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  state.stream = stream;
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error("No microphone audio track is available.");
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AudioContextClass({ latencyHint: "interactive" });
  state.audioContext = audioContext;
  await audioContext.resume();
  const sourceNode = audioContext.createMediaStreamSource(stream);
  const silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  silentGain.connect(audioContext.destination);

  let captureNode;
  if (audioContext.audioWorklet) {
    await audioContext.audioWorklet.addModule("./audio-worklet.js?v=0.5.3");
    captureNode = new AudioWorkletNode(audioContext, "noisecolor-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    captureNode.port.onmessage = (event) => state.rolling?.push(event.data);
  } else {
    captureNode = audioContext.createScriptProcessor(2048, 1, 1);
    captureNode.onaudioprocess = (event) => state.rolling?.push(new Float32Array(event.inputBuffer.getChannelData(0)));
  }
  sourceNode.connect(captureNode);
  captureNode.connect(silentGain);

  state.sourceNode = sourceNode;
  state.captureNode = captureNode;
  state.silentGain = silentGain;
  state.sampleRate = audioContext.sampleRate;
  state.rolling = new RollingBuffer(Math.round(audioContext.sampleRate * ROLLING_SECONDS));
  state.listening = true;
  state.startedAt = performance.now();
  state.inputRoute = inputRouteFromTrack(track);
  state.constraintSettings = track.getSettings?.() || {};
  state.observations = [];
  state.betaHistory = [];
  state.latestResult = null;
  state.latestSpectrogram = null;
  state.captureGeneration += 1;
  stateMachine.reset();
  if (!recording) elements.liveSummary.hidden = true;
  drawEmpty(elements.betaCanvas, "Listening for a stable estimate…");
  drawEmpty(elements.spectrumCanvas, "Waiting for a stable spectrum…");
  drawEmpty(elements.spectrogramCanvas, "Waiting for spectrogram data…");
  track.addEventListener("ended", () => interruptActiveCapture("Microphone unavailable", "unavailable"));
  track.addEventListener("mute", () => interruptActiveCapture("Microphone interrupted", "unavailable"));
  audioContext.addEventListener("statechange", () => {
    if (state.listening && audioContext.state !== "running" && !state.stopping) interruptActiveCapture(`Audio processing ${audioContext.state}`, "paused");
  });
  await acquireWakeLock();
  if (!recording) startSchedulers();
  elements.startLiveButton.hidden = recording;
  elements.stopLiveButton.hidden = recording;
  if (!recording) {
    elements.startLiveButton.hidden = true;
    elements.stopLiveButton.hidden = false;
  }
  elements.railStatus.innerHTML = `<i></i> ${recording ? "RECORDING" : "LIVE"}`;
  elements.privacyChip.textContent = recording ? "Recording locally" : "Listening locally";
  const config = modeConfig();
  elements.windowValue.textContent = `${config.stableSeconds} sec`;
  displayLiveState(stateMachine.reset(), null);
  elements.qualityDetail.textContent = constraintSummary();
  return stream;
}

function constraintSummary() {
  const settings = state.constraintSettings || {};
  const stateFor = (key) => settings[key] === false ? "off" : settings[key] === true ? "on" : "not reported";
  return `Actual ${state.sampleRate || "—"} Hz input. Echo cancellation ${stateFor("echoCancellation")}; noise suppression ${stateFor("noiseSuppression")}; auto gain ${stateFor("autoGainControl")}.`;
}

function startSchedulers() {
  const config = modeConfig();
  stopSchedulers();
  state.fastTimer = window.setInterval(runFastAnalysis, config.fastEveryMs);
  state.stableTimer = window.setInterval(runStableAnalysis, config.stableEveryMs);
  state.spectrogramTimer = window.setInterval(runSpectrogram, 3500);
}

function stopSchedulers() {
  for (const key of ["fastTimer", "stableTimer", "spectrogramTimer"]) {
    window.clearInterval(state[key]);
    state[key] = null;
  }
  state.fastBusy = false;
  state.stableBusy = false;
}

async function runFastAnalysis() {
  if (!state.listening || state.fastBusy || !state.rolling) return;
  const config = modeConfig();
  if (state.rolling.length < state.sampleRate * Math.min(1.5, config.fastSeconds)) return;
  state.fastBusy = true;
  const generation = state.captureGeneration;
  try {
    const samples = state.rolling.latest(Math.round(state.sampleRate * config.fastSeconds));
    const result = await requestAnalysis("analyze-fast", samples, state.sampleRate, currentOptions("live", null, { maxWelchSegments: 24 }));
    if (!state.listening || generation !== state.captureGeneration) return;
    elements.instantBeta.textContent = result.reliable ? formatNumber(result.beta, 2) : "—";
    elements.signalLevel.textContent = formatNumber(result.dbfs, 1, " dBFS");
    if (["silence", "tonal", "clipping"].includes(result.state)) displayLiveState(stateMachine.block(result.state, result.classification, result), result);
  } catch (error) {
    console.error(error);
  } finally {
    state.fastBusy = false;
  }
}

async function runStableAnalysis() {
  if (!state.listening || state.stableBusy || !state.rolling) return;
  const config = modeConfig();
  if (state.rolling.length < state.sampleRate * config.stableSeconds) return;
  state.stableBusy = true;
  const generation = state.captureGeneration;
  try {
    const samples = state.rolling.latest(Math.round(state.sampleRate * config.stableSeconds));
    const result = await requestAnalysis("analyze-live", samples, state.sampleRate, currentOptions("live"));
    if (!state.listening || generation !== state.captureGeneration) return;
    const timeSeconds = (performance.now() - state.startedAt) / 1000;
    const observation = { timeSeconds, beta: result.beta, state: result.state, classification: result.classification, reliable: result.reliable, rmseDb: result.rmseDb, r2: result.r2, spectralFlatness: result.spectralFlatness };
    state.observations.push(observation);
    if (state.observations.length > 3600) state.observations.splice(0, state.observations.length - 3600);
    state.betaHistory.push(observation);
    state.betaHistory = state.betaHistory.filter((item) => timeSeconds - item.timeSeconds <= 30);
    state.latestResult = result;
    const display = stateMachine.update(result);
    displayLiveState(display, result);
    const stableValues = state.observations.slice(-10).filter((item) => item.reliable).map((item) => item.beta);
    const stableSummary = summarize(stableValues);
    elements.stability.textContent = Number.isFinite(stableSummary.sd) ? `±${stableSummary.sd.toFixed(2)}` : "—";
    elements.fitResidual.textContent = formatNumber(result.rmseDb, 2, " dB");
    elements.signalLevel.textContent = formatNumber(result.dbfs, 1, " dBFS");
    drawBetaHistory();
    renderAdvanced(result);
  } catch (error) {
    console.error(error);
    clearStaleMeasurement("Analysis unavailable", "unavailable", error.message);
  } finally {
    state.stableBusy = false;
  }
}

async function runSpectrogram() {
  if (!state.listening || !state.rolling || state.rolling.length < state.sampleRate * 2) return;
  try {
    const generation = state.captureGeneration;
    const samples = state.rolling.latest(Math.round(state.sampleRate * Math.min(12, modeConfig().stableSeconds)));
    const spectrogram = await requestAnalysis("spectrogram", samples, state.sampleRate, { maxFrames: 64 });
    if (!state.listening || generation !== state.captureGeneration) return;
    state.latestSpectrogram = spectrogram;
    drawSpectrogram(state.latestSpectrogram);
  } catch (error) {
    console.error(error);
  }
}

async function stopMicrophone({ reason = "Analysis paused", stateName = "paused", preserveSummary = false, silent = false } = {}) {
  if (state.stopping || (!state.stream && !state.audioContext)) return;
  state.stopping = true;
  state.listening = false;
  state.captureGeneration += 1;
  stopSchedulers();
  const durationSeconds = state.startedAt ? (performance.now() - state.startedAt) / 1000 : 0;
  if (!preserveSummary && state.observations.length) {
    const session = summarizeSession(state.observations, durationSeconds);
    state.lastSummary = {
      ...session,
      id: undefined,
      appVersion: APP_VERSION,
      analysisEngineVersion: ENGINE_VERSION,
      timestamp: new Date().toISOString(),
      sourceType: "live-session",
      sampleRate: state.sampleRate,
      durationSeconds,
      analysisMode: elements.analysisMode.value,
      analysisWindowSeconds: modeConfig().stableSeconds,
      fitRange: DEFAULT_FIT_RANGE,
      fftSize: FFT_SIZE,
      welchOverlap: WELCH_OVERLAP,
      calibrationProfile: state.activeCalibration?.name || null,
      scalarGainDb: Number(elements.scalarGain.value) || 0,
      classification: session.dominantReliableColor || "No reliable dominant color",
      beta: session.betaMean,
      temporalBetaMean: session.betaMean,
      temporalBetaSd: session.betaSd,
      temporalBetaMedian: session.betaMedian,
      rmseDb: session.fitRmseMeanDb,
      r2: session.fitR2Mean,
      spectralFlatness: session.spectralFlatnessMean,
      confidence: "Session summary",
      reliable: Boolean(session.dominantReliableColor),
    };
    renderSessionSummary(state.lastSummary);
  }
  try {
    state.stream?.getTracks().forEach((track) => track.stop());
    try { state.captureNode?.disconnect(); } catch { /* disconnected */ }
    try { state.sourceNode?.disconnect(); } catch { /* disconnected */ }
    try { state.silentGain?.disconnect(); } catch { /* disconnected */ }
    try { await state.audioContext?.close(); } catch { /* closed */ }
    await releaseWakeLock();
    state.stream = null;
    state.audioContext = null;
    state.sourceNode = null;
    state.captureNode = null;
    state.silentGain = null;
    state.rolling = null;
    elements.startLiveButton.hidden = false;
    elements.stopLiveButton.hidden = true;
    elements.railStatus.innerHTML = "<i></i> LOCAL";
    elements.privacyChip.textContent = "Local analysis";
    if (!silent) clearStaleMeasurement(reason, stateName, `${reason}. Restart the microphone when ready.`);
  } finally {
    state.stopping = false;
  }
}

async function interruptActiveCapture(reason, stateName = "paused") {
  if (state.finalizingRecording || state.stopping) return;
  if (state.recording) await stopRecording({ interrupted: true, reason });
  else await stopMicrophone({ reason, stateName });
}

function renderSessionSummary(summary) {
  elements.liveSummary.hidden = false;
  const percent = summary.percentages || {};
  elements.summaryMetrics.innerHTML = [
    ["Duration", formatDuration(summary.sessionDurationSeconds)],
    ["Dominant", summary.dominantReliableColor || "None"],
    ["Mean β", formatNumber(summary.betaMean)],
    ["SD β", formatNumber(summary.betaSd)],
    ["Violet-like", formatNumber(percent.violet, 0, "%")],
    ["Blue-like", formatNumber(percent.blue, 0, "%")],
    ["White-like", formatNumber(percent.white, 0, "%")],
    ["Pink-like", formatNumber(percent.pink, 0, "%")],
    ["Brown/red-like", formatNumber(percent.brown, 0, "%")],
    ["Mixed", formatNumber(percent.mixed, 0, "%")],
    ["Tonal", formatNumber(percent.tonal, 0, "%")],
    ["Low signal", formatNumber((percent.silence || 0) + (percent.insufficient || 0), 0, "%")],
    ["Mean fit residual", formatNumber(summary.fitRmseMeanDb, 2, " dB")],
  ].map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
  const duration = Math.max(summary.sessionDurationSeconds || 0, Number.EPSILON);
  elements.summaryTimeline.innerHTML = (summary.colorTimeline || []).map((segment) => {
    const width = (Math.max(0, segment.endSeconds - segment.startSeconds) / duration) * 100;
    return `<span class="${escapeHtml(segment.state)}" style="width:${width.toFixed(3)}%" title="${escapeHtml(segment.label)} · ${formatDuration(segment.startSeconds)}–${formatDuration(segment.endSeconds)}"></span>`;
  }).join("");
}

function chooseRecordingMimeType() {
  const types = ["audio/webm;codecs=opus", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"];
  return types.find((type) => window.MediaRecorder?.isTypeSupported?.(type)) || "";
}

async function startRecording() {
  try {
    if (state.finalizingRecording) throw new Error("The previous recording is still being finalized.");
    if (!("MediaRecorder" in window)) throw new Error("Audio recording is not supported by this browser.");
    const stream = await startMicrophone({ recording: true });
    const mimeType = chooseRecordingMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    state.recording = true;
    state.recordingChunks = [];
    state.recorder = recorder;
    recorder.ondataavailable = (event) => { if (event.data.size) state.recordingChunks.push(event.data); };
    recorder.addEventListener("error", (event) => {
      elements.recordStatus.textContent = event.error?.message || "Recording failed.";
      interruptActiveCapture("Recording interrupted", "unavailable");
    });
    recorder.addEventListener("stop", () => {
      if (state.recording && !state.finalizingRecording) stopRecording({ interrupted: true, reason: "Recording stopped by the browser" });
    });
    recorder.start(1000);
    elements.recordButton.hidden = true;
    elements.stopRecordButton.hidden = false;
    elements.downloadAudioButton.hidden = true;
    elements.recordFormat.textContent = recorder.mimeType || "Browser default audio format";
    elements.recordStatus.textContent = "Recording locally. Stop when ready to analyze.";
    state.recordTimer = window.setInterval(() => { elements.recordTimer.textContent = formatDuration((performance.now() - state.startedAt) / 1000); }, 250);
  } catch (error) {
    elements.recordStatus.textContent = error.message;
    state.recording = false;
    state.recorder = null;
    await stopMicrophone({ reason: "Microphone unavailable", stateName: "unavailable", preserveSummary: true, silent: true });
  }
}

async function stopRecording({ interrupted = false, reason = "" } = {}) {
  if (!state.recorder || state.finalizingRecording) return;
  state.finalizingRecording = true;
  elements.stopRecordButton.disabled = true;
  elements.recordStatus.textContent = interrupted ? "The recording was interrupted. Finalizing available audio locally…" : "Finalizing and analyzing the recording locally…";
  window.clearInterval(state.recordTimer);
  const recorder = state.recorder;
  const capturedDurationSeconds = state.startedAt ? (performance.now() - state.startedAt) / 1000 : 0;
  const fallback = state.rolling?.latest() || new Float32Array();
  const fallbackRate = state.sampleRate;
  try {
    if (recorder.state !== "inactive") {
      const stopped = new Promise((resolve) => recorder.addEventListener("stop", resolve, { once: true }));
      recorder.stop();
      await stopped;
    }
    state.recording = false;
    state.recorder = null;
    state.recordingBlob = new Blob(state.recordingChunks, { type: recorder.mimeType || "audio/webm" });
    if (state.recordingUrl) URL.revokeObjectURL(state.recordingUrl);
    state.recordingUrl = URL.createObjectURL(state.recordingBlob);
    elements.downloadAudioButton.hidden = false;
    elements.recordButton.hidden = false;
    elements.stopRecordButton.hidden = true;
    await stopMicrophone({ preserveSummary: true, silent: true });
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    let samples;
    let sampleRate;
    let decodedFullRecording = true;
    try {
      const decoded = await audioContext.decodeAudioData(await state.recordingBlob.arrayBuffer());
      samples = mixToMono(decoded);
      sampleRate = decoded.sampleRate;
    } catch {
      samples = fallback;
      sampleRate = fallbackRate;
      decodedFullRecording = false;
    }
    if (!sampleRate || !samples.length) throw new Error("No decodable audio samples were captured.");
    const bounded = selectBoundedAnalysisWindow(samples, sampleRate);
    const sourceDurationSeconds = decodedFullRecording ? bounded.sourceDurationSeconds : Math.max(capturedDurationSeconds, bounded.sourceDurationSeconds);
    const analysisStartSeconds = decodedFullRecording ? bounded.analysisStartSeconds : Math.max(0, sourceDurationSeconds - bounded.samples.length / sampleRate);
    const result = await requestAnalysis("analyze-recording", bounded.samples, sampleRate, currentOptions("recorded-microphone", null, {
      sourceDurationSeconds,
      analysisStartSeconds,
      analysisTruncated: bounded.analysisTruncated || !decodedFullRecording || sourceDurationSeconds > bounded.samples.length / sampleRate + 0.01,
    }));
    state.latestResult = result;
    renderResult(elements.recordResult, result);
    renderAdvanced(result);
    const windowNote = result.analysisTruncated ? ` The final ${formatDuration(result.durationSeconds)} of ${formatDuration(result.sourceDurationSeconds)} was analyzed.` : "";
    elements.recordStatus.textContent = `${interrupted ? `${reason || "Recording interrupted"}. ` : ""}Recording analyzed locally.${windowNote} Raw audio remains available only in this page until you leave or download it.`;
    await audioContext.close();
  } catch (error) {
    elements.recordStatus.textContent = `Recording could not be analyzed: ${error.message}`;
    state.recording = false;
    state.recorder = null;
    await stopMicrophone({ preserveSummary: true, silent: true });
  } finally {
    elements.recordButton.hidden = false;
    elements.stopRecordButton.hidden = true;
    elements.stopRecordButton.disabled = false;
    state.finalizingRecording = false;
  }
}

function mixToMono(audioBuffer) {
  const length = audioBuffer.length;
  const mono = new Float32Array(length);
  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    const data = audioBuffer.getChannelData(channel);
    for (let index = 0; index < length; index += 1) mono[index] += data[index] / audioBuffer.numberOfChannels;
  }
  return mono;
}

async function loadAudioFile(file) {
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) {
    elements.uploadStatus.textContent = "This file is larger than the 100 MB local-analysis limit.";
    return;
  }
  elements.fileName.textContent = file.name;
  elements.uploadStatus.textContent = "Decoding and analyzing locally…";
  try {
    const encoded = await file.arrayBuffer();
    const declaredWavRate = readWavSampleRate(encoded);
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    let audioContext;
    try { audioContext = declaredWavRate ? new AudioContextClass({ sampleRate: declaredWavRate }) : new AudioContextClass(); }
    catch { audioContext = new AudioContextClass(); }
    const decoded = await audioContext.decodeAudioData(encoded);
    const samples = mixToMono(decoded);
    state.inputRoute = `file:${file.name}`;
    const bounded = selectBoundedAnalysisWindow(samples, decoded.sampleRate);
    const result = await requestAnalysis("analyze-recording", bounded.samples, decoded.sampleRate, currentOptions("uploaded-file", file.name, bounded));
    state.latestResult = result;
    renderResult(elements.uploadResult, result);
    renderAdvanced(result);
    const windowNote = result.analysisTruncated ? ` Analyzed the final ${formatDuration(result.durationSeconds)} of ${formatDuration(result.sourceDurationSeconds)}.` : ` Analyzed ${formatDuration(result.durationSeconds)}.`;
    elements.uploadStatus.textContent = `${windowNote} ${result.sampleRate} Hz. No audio left this device.`;
    await audioContext.close();
  } catch (error) {
    elements.uploadStatus.textContent = `Unsupported or failed audio decode: ${error.message}`;
  }
}

function readWavSampleRate(arrayBuffer) {
  if (arrayBuffer.byteLength < 28) return null;
  const bytes = new Uint8Array(arrayBuffer, 0, 12);
  const text = String.fromCharCode(...bytes);
  if (!text.startsWith("RIFF") || !text.includes("WAVE")) return null;
  const rate = new DataView(arrayBuffer).getUint32(24, true);
  return rate >= 4000 && rate <= 384000 ? rate : null;
}

function resultMarkup(result) {
  const quality = result.reliable ? `${result.confidence} confidence` : result.qualityDetail;
  return `
    <div class="result-heading"><strong>${escapeHtml(result.classification)}</strong><span>β ${formatNumber(result.beta)}</span></div>
    <p class="view-lede">${escapeHtml(quality)}</p>
    <div class="result-grid">
      <div><span>β mean ± SD</span><strong>${formatNumber(result.temporalBetaMean ?? result.beta)} ± ${formatNumber(result.temporalBetaSd)}</strong></div>
      <div><span>Fit residual</span><strong>${formatNumber(result.rmseDb, 2, " dB")}</strong></div>
      <div><span>R²</span><strong>${formatNumber(result.r2, 3)}</strong></div>
      <div><span>Flatness</span><strong>${formatNumber(result.spectralFlatness, 3)}</strong></div>
      <div><span>Duration</span><strong>${formatDuration(result.durationSeconds)}</strong></div>
      ${result.analysisTruncated ? `<div><span>Source duration</span><strong>${formatDuration(result.sourceDurationSeconds)} · final window</strong></div>` : ""}
      <div><span>Sample rate</span><strong>${escapeHtml(result.sampleRate)} Hz</strong></div>
      <div><span>Calibration</span><strong>${escapeHtml(result.calibrationProfile || "Uncorrected")}</strong></div>
      <div><span>Engine</span><strong>v${escapeHtml(result.analysisEngineVersion)}</strong></div>
    </div>
    <div class="result-actions"><button type="button" data-action="save">Save to History</button><button type="button" data-action="json">Export JSON</button><button type="button" data-action="csv">Export CSV</button><button type="button" data-action="advanced">View scientific details</button></div>`;
}

function renderResult(container, result) {
  container.hidden = false;
  container.innerHTML = resultMarkup(result);
  container.querySelector('[data-action="save"]').addEventListener("click", async () => {
    await saveMeasurement(result);
    container.querySelector('[data-action="save"]').textContent = "Saved locally";
  });
  container.querySelector('[data-action="json"]').addEventListener("click", () => exportJson(result));
  container.querySelector('[data-action="csv"]').addEventListener("click", () => exportCsv(result));
  container.querySelector('[data-action="advanced"]').addEventListener("click", () => setView("advanced"));
}

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportJson(result) {
  download(`noisecolor-${Date.now()}.json`, JSON.stringify(result, null, 2), "application/json");
}

function exportCsv(result) {
  const metadata = [
    ["NoiseColor version", result.appVersion], ["analysis engine", result.analysisEngineVersion], ["timestamp", result.timestamp],
    ["source type", result.sourceType], ["source filename", result.sourceFilename], ["sample rate", result.sampleRate],
    ["duration seconds", result.durationSeconds], ["source duration seconds", result.sourceDurationSeconds], ["analysis start seconds", result.analysisStartSeconds],
    ["analysis truncated", result.analysisTruncated], ["FFT size", result.fftSize], ["Welch overlap", result.welchOverlap],
    ["Welch segments used", result.welchSegments], ["Welch segments available", result.welchAvailableSegments],
    ["fit min Hz", result.fitRange?.[0]], ["fit max Hz", result.fitRange?.[1]], ["analysis mode", result.analysisMode],
    ["analysis window seconds", result.analysisWindowSeconds], ["beta", result.beta], ["raw slope", result.rawSlope],
    ["R squared", result.r2], ["RMSE dB", result.rmseDb], ["MAE dB", result.maeDb], ["spectral flatness", result.spectralFlatness],
    ["temporal beta mean", result.temporalBetaMean], ["temporal beta SD", result.temporalBetaSd], ["canonical color", result.canonicalColor],
    ["canonical distance", result.canonicalDistance], ["classification", result.classification], ["confidence", result.confidence],
    ["reliable", result.reliable], ["calibration profile", result.calibrationProfile || "uncorrected"], ["scalar gain context dB", result.scalarGainDb],
    ["input route id", result.inputRouteId], ["microphone settings", result.microphoneSettings ? JSON.stringify(result.microphoneSettings) : ""],
  ];
  const rows = metadata.map(([key, value]) => `# ${key},${JSON.stringify(value ?? "")}`);
  rows.push("", "time_seconds,beta,state,classification,reliable,rmse_db,r_squared,spectral_flatness");
  for (const item of result.temporalBeta || []) rows.push([item.timeSeconds, item.beta, item.state, JSON.stringify(item.classification), item.reliable, item.rmseDb, item.r2, item.spectralFlatness].join(","));
  rows.push("", "timeline_start_seconds,timeline_end_seconds,state,classification");
  for (const item of result.colorTimeline || []) rows.push([item.startSeconds, item.endSeconds, item.state, JSON.stringify(item.label || "")].join(","));
  download(`noisecolor-${Date.now()}.csv`, rows.join("\n"), "text/csv");
}

async function refreshHistory() {
  try {
    const records = await listMeasurements();
    if (!records.length) {
      elements.historyList.innerHTML = '<p class="empty-state">No saved measurements yet. Live summaries and recording results are saved only when you ask.</p>';
      return;
    }
    elements.historyList.innerHTML = records.map((record) => `
      <article class="history-item" data-history-id="${escapeHtml(record.id)}">
        <header><div><strong>${escapeHtml(record.classification || record.dominantReliableColor || "Measurement")}</strong><small>${escapeHtml(new Date(record.timestamp).toLocaleString())} · ${escapeHtml(record.sourceType || "unknown source")}</small></div><span class="history-beta">β ${formatNumber(record.beta ?? record.betaMean)}</span></header>
        <div class="history-actions"><button type="button" data-action="view">View result</button><button type="button" data-action="export">Export JSON</button><button type="button" data-action="delete">Delete</button></div>
      </article>`).join("");
    for (const article of elements.historyList.querySelectorAll(".history-item")) {
      const record = records.find((item) => item.id === article.dataset.historyId);
      article.querySelector('[data-action="view"]').addEventListener("click", () => { state.latestResult = record; renderAdvanced(record); setView("advanced"); });
      article.querySelector('[data-action="export"]').addEventListener("click", () => exportJson(record));
      article.querySelector('[data-action="delete"]').addEventListener("click", async () => { await deleteMeasurement(record.id); refreshHistory(); });
    }
  } catch (error) {
    elements.historyList.innerHTML = `<p class="empty-state">${escapeHtml(error.message)}</p>`;
  }
}

function resizeCanvas(canvas) {
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const cssWidth = Math.max(280, rect.width || canvas.width);
  const cssHeight = cssWidth * (Number(canvas.getAttribute("height")) / Number(canvas.getAttribute("width")));
  const width = Math.round(cssWidth * ratio);
  const height = Math.round(cssHeight * ratio);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  return { context: canvas.getContext("2d"), width, height, ratio };
}

function drawEmpty(canvas, text) {
  const { context, width, height, ratio } = resizeCanvas(canvas);
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#6f7c8f";
  context.font = `${11 * ratio}px Inter, sans-serif`;
  context.textAlign = "center";
  context.fillText(text, width / 2, height / 2);
}

function drawBetaHistory() {
  const { context, width, height, ratio } = resizeCanvas(elements.betaCanvas);
  context.clearRect(0, 0, width, height);
  const pad = { left: 38 * ratio, right: 14 * ratio, top: 16 * ratio, bottom: 27 * ratio };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const maxTime = state.betaHistory.at(-1)?.timeSeconds || 30;
  const minTime = Math.max(0, maxTime - 30);
  const x = (time) => pad.left + ((time - minTime) / 30) * plotWidth;
  const y = (beta) => pad.top + ((2.6 - beta) / 5.2) * plotHeight;
  context.lineWidth = ratio;
  context.font = `${9 * ratio}px ui-monospace, monospace`;
  for (const color of CANONICAL_COLORS) {
    const row = y(color.beta);
    context.strokeStyle = color.color + "35";
    context.beginPath(); context.moveTo(pad.left, row); context.lineTo(width - pad.right, row); context.stroke();
    context.fillStyle = color.color;
    context.textAlign = "right";
    context.fillText(String(color.beta), pad.left - 7 * ratio, row + 3 * ratio);
  }
  const reliable = state.betaHistory.filter((item) => item.reliable && Number.isFinite(item.beta));
  if (reliable.length) {
    context.strokeStyle = "#c6ff5c";
    context.lineWidth = 2 * ratio;
    context.beginPath();
    reliable.forEach((item, index) => index ? context.lineTo(x(item.timeSeconds), y(item.beta)) : context.moveTo(x(item.timeSeconds), y(item.beta)));
    context.stroke();
  }
  context.fillStyle = "#718096";
  context.textAlign = "left"; context.fillText("30 sec ago", pad.left, height - 8 * ratio);
  context.textAlign = "right"; context.fillText("now", width - pad.right, height - 8 * ratio);
}

function drawSpectrum(result) {
  if (!result?.psd?.frequencies?.length) { drawEmpty(elements.spectrumCanvas, "No spectrum available"); return; }
  if (state.activeSpectrum === "third") { drawThirdOctave(result); return; }
  const { context, width, height, ratio } = resizeCanvas(elements.spectrumCanvas);
  context.clearRect(0, 0, width, height);
  const frequencies = result.psd.frequencies;
  const power = result.psd.power;
  const pad = { left: 53 * ratio, right: 14 * ratio, top: 18 * ratio, bottom: 34 * ratio };
  const maxFrequency = Math.min(result.fitRange?.[1] || 8000, result.sampleRate * 0.48);
  const minLog = Math.log10(40);
  const maxLog = Math.log10(maxFrequency);
  const values = power.map((value) => 10 * Math.log10(Math.max(value, Number.MIN_VALUE))).filter(Number.isFinite);
  let minDb = Math.min(...values);
  let maxDb = Math.max(...values);
  const margin = Math.max(4, (maxDb - minDb) * 0.08); minDb -= margin; maxDb += margin;
  const x = (frequency) => pad.left + ((Math.log10(frequency) - minLog) / (maxLog - minLog)) * (width - pad.left - pad.right);
  const y = (db) => pad.top + ((maxDb - db) / (maxDb - minDb)) * (height - pad.top - pad.bottom);
  context.strokeStyle = "#1e2c40"; context.lineWidth = ratio; context.font = `${9 * ratio}px ui-monospace, monospace`; context.fillStyle = "#728096";
  for (const frequency of [50, 100, 200, 500, 1000, 2000, 5000, 8000].filter((value) => value <= maxFrequency)) {
    const lineX = x(frequency); context.beginPath(); context.moveTo(lineX, pad.top); context.lineTo(lineX, height - pad.bottom); context.stroke();
    context.textAlign = "center"; context.fillText(frequency >= 1000 ? `${frequency / 1000}k` : frequency, lineX, height - 12 * ratio);
  }
  context.strokeStyle = "#91a0b5"; context.lineWidth = 1.2 * ratio; context.beginPath(); let started = false;
  for (let index = 1; index < frequencies.length; index += 1) {
    if (frequencies[index] < 40 || frequencies[index] > maxFrequency) continue;
    const pointX = x(frequencies[index]); const pointY = y(10 * Math.log10(Math.max(power[index], Number.MIN_VALUE)));
    if (!started) { context.moveTo(pointX, pointY); started = true; } else context.lineTo(pointX, pointY);
  }
  context.stroke();
  if (Number.isFinite(result.rawSlope)) {
    const [minFit, maxFit] = result.fitRange;
    const db1 = 10 * (result.intercept + result.rawSlope * Math.log10(minFit));
    const db2 = 10 * (result.intercept + result.rawSlope * Math.log10(maxFit));
    context.strokeStyle = "#c6ff5c"; context.lineWidth = 2.5 * ratio; context.beginPath(); context.moveTo(x(minFit), y(db1)); context.lineTo(x(maxFit), y(db2)); context.stroke();
  }
}

function drawThirdOctave(result) {
  const bands = result.thirdOctave || [];
  if (!bands.length) { drawEmpty(elements.spectrumCanvas, "No third-octave bands available"); return; }
  const { context, width, height, ratio } = resizeCanvas(elements.spectrumCanvas);
  context.clearRect(0, 0, width, height);
  const pad = { left: 48 * ratio, right: 12 * ratio, top: 18 * ratio, bottom: 38 * ratio };
  const min = Math.min(...bands.map((band) => band.db));
  const max = Math.max(...bands.map((band) => band.db));
  const range = Math.max(12, max - min);
  const barWidth = (width - pad.left - pad.right) / bands.length;
  bands.forEach((band, index) => {
    const barHeight = ((band.db - min) / range) * (height - pad.top - pad.bottom);
    context.fillStyle = "#67e8f9";
    context.fillRect(pad.left + index * barWidth + ratio, height - pad.bottom - barHeight, Math.max(ratio, barWidth - 2 * ratio), barHeight);
    if (index % 3 === 0) { context.save(); context.translate(pad.left + index * barWidth + barWidth / 2, height - 9 * ratio); context.rotate(-0.6); context.fillStyle = "#728096"; context.font = `${8 * ratio}px ui-monospace, monospace`; context.textAlign = "right"; context.fillText(band.center >= 1000 ? `${band.center / 1000}k` : band.center, 0, 0); context.restore(); }
  });
}

function drawSpectrogram(spectrogram) {
  if (!spectrogram?.values?.length) { drawEmpty(elements.spectrogramCanvas, "No spectrogram available"); return; }
  const { context, width, height } = resizeCanvas(elements.spectrogramCanvas);
  context.clearRect(0, 0, width, height);
  const values = spectrogram.values.flat();
  const sorted = [...values].sort((a, b) => a - b);
  const low = sorted[Math.floor(sorted.length * 0.08)] ?? -120;
  const high = sorted[Math.floor(sorted.length * 0.96)] ?? -20;
  const columns = spectrogram.values.length;
  const rows = spectrogram.frequencies.length;
  const cellWidth = width / columns;
  const cellHeight = height / rows;
  for (let column = 0; column < columns; column += 1) {
    for (let row = 0; row < rows; row += 1) {
      const amount = Math.max(0, Math.min(1, (spectrogram.values[column][row] - low) / Math.max(1, high - low)));
      const red = Math.round(18 + amount * 180);
      const green = Math.round(32 + amount * 220);
      const blue = Math.round(55 + (1 - amount) * 90);
      context.fillStyle = `rgb(${red},${green},${blue})`;
      context.fillRect(column * cellWidth, height - (row + 1) * cellHeight, Math.ceil(cellWidth), Math.ceil(cellHeight));
    }
  }
}

function renderAdvanced(result) {
  drawSpectrum(result);
  drawSpectrogram(result?.spectrogram || state.latestSpectrogram);
  if (!result) {
    elements.diagnosticGrid.innerHTML = '<div><span>Status</span><strong>No measurement</strong></div>';
    return;
  }
  const diagnostics = [
    ["β", formatNumber(result.beta)], ["R²", formatNumber(result.r2, 3)], ["RMSE", formatNumber(result.rmseDb, 2, " dB")], ["MAE", formatNumber(result.maeDb, 2, " dB")],
    ["Flatness", formatNumber(result.spectralFlatness, 3)], ["Level", formatNumber(result.dbfs, 1, " dBFS")], ["Clipping", formatNumber(result.clippingRatio * 100, 3, "%")], ["Fit range", `${result.fitRange?.[0]}–${Math.round(result.fitRange?.[1] || 0)} Hz`],
    ["Sample rate", `${result.sampleRate} Hz`], ["Welch", `${result.fftSize} FFT · ${result.welchOverlap * 100}% overlap`], ["Correction", result.calibrationProfile || "Uncorrected"], ["Engine", `v${result.analysisEngineVersion}`],
  ];
  elements.diagnosticGrid.innerHTML = diagnostics.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
  elements.measuredCopy.textContent = `β ${formatNumber(result.beta)}, residual ${formatNumber(result.rmseDb, 2, " dB")}, R² ${formatNumber(result.r2, 3)}, flatness ${formatNumber(result.spectralFlatness, 3)}.`;
  elements.interpretationCopy.textContent = result.qualityDetail;
  elements.spectrumNote.textContent = `${result.corrected ? `Corrected with ${result.calibrationProfile}` : "Uncorrected continuous PSD"}. β is fitted from ${result.fitRange[0]}–${Math.round(result.fitRange[1])} Hz without A weighting or third-octave aggregation.`;
}

function loadCalibrationProfiles() {
  try { state.calibrationProfiles = JSON.parse(localStorage.getItem("noisecolor-calibration-profiles") || "[]"); } catch { state.calibrationProfiles = []; }
  elements.calibrationProfile.innerHTML = '<option value="">None · uncorrected</option>' + state.calibrationProfiles.map((profile, index) => `<option value="${index}">${escapeHtml(profile.name)} · ${escapeHtml(profile.routeId)}</option>`).join("");
}

async function importCalibration(file) {
  try {
    const profile = JSON.parse(await file.text());
    if (!profile.name || !profile.routeId || !Array.isArray(profile.points) || profile.points.length < 2) throw new Error("Profile requires name, routeId, and at least two frequency/correction points.");
    for (const point of profile.points) if (!Number.isFinite(Number(point.frequency)) || Number(point.frequency) <= 0 || !Number.isFinite(Number(point.correctionDb))) throw new Error("Every point needs a positive frequency and numeric correctionDb value.");
    if (new Set(profile.points.map((point) => Number(point.frequency))).size !== profile.points.length) throw new Error("Calibration frequencies must be unique.");
    state.calibrationProfiles.push(profile);
    localStorage.setItem("noisecolor-calibration-profiles", JSON.stringify(state.calibrationProfiles));
    loadCalibrationProfiles();
    elements.calibrationProfile.value = String(state.calibrationProfiles.length - 1);
    selectCalibration();
  } catch (error) {
    elements.calibrationState.textContent = `Profile not imported: ${error.message}`;
  }
}

function selectCalibration() {
  const index = elements.calibrationProfile.value;
  state.activeCalibration = index === "" ? null : state.calibrationProfiles[Number(index)];
  if (!state.activeCalibration) elements.calibrationState.textContent = "Uncorrected";
  else if (!state.inputRoute) elements.calibrationState.textContent = `Available for ${state.activeCalibration.routeId}; not applied until the input route matches`;
  else if (state.activeCalibration.routeId !== state.inputRoute) elements.calibrationState.textContent = `Not applied: profile route does not match ${state.inputRoute}`;
  else elements.calibrationState.textContent = `Corrected with ${state.activeCalibration.name}`;
}

function showInstallSheet(platform = platformInstallHint()) {
  elements.installSheet.hidden = false;
  elements.appShell.inert = true;
  if (platform === "ios") {
    elements.installInstructions.innerHTML = "<p>The installed PWA is the iPhone/iPad app experience; it is not an App Store download.</p><ol><li>Open this page in Safari.</li><li>Tap Safari’s Share button.</li><li>Choose <strong>Add to Home Screen</strong>.</li><li>Enable or open as a web app where offered, then tap <strong>Add</strong>.</li></ol>";
  } else if (state.installPromptReady) {
    elements.installInstructions.innerHTML = '<p>Install NoiseColor as a standalone app on this device.</p><button class="sheet-install-native" type="button">Continue to install</button>';
    elements.installInstructions.querySelector("button").addEventListener("click", async () => {
      await pwa.promptInstall();
      hideInstallSheet();
    });
  } else if (platform === "android") {
    elements.installInstructions.innerHTML = "<p>In Chrome or your browser’s menu, choose <strong>Install app</strong> or <strong>Add to Home screen</strong>. If the option is missing, reload after visiting once while online.</p>";
  } else {
    elements.installInstructions.innerHTML = "<p>Use your browser menu and choose <strong>Install NoiseColor</strong>, <strong>Install app</strong>, or <strong>Add to Home screen</strong>. Installation support varies by browser.</p>";
  }
  elements.closeInstallSheet.focus();
}

function hideInstallSheet() {
  elements.installSheet.hidden = true;
  elements.appShell.inert = false;
  elements.installButton.focus();
}

const pwa = setupPwa({
  onInstallReady: (ready) => { state.installPromptReady = ready; },
  onInstalled: () => { elements.installButton.textContent = "Installed"; elements.installButton.disabled = true; },
  onUpdateAvailable: (activate) => { elements.updateBanner.hidden = false; elements.reloadButton.onclick = activate; },
  onError: (error) => console.warn("Service worker registration failed", error),
});

document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
document.querySelectorAll("[data-advanced]").forEach((button) => button.addEventListener("click", () => {
  const view = button.dataset.advanced;
  document.querySelectorAll("[data-advanced]").forEach((tab) => { const active = tab.dataset.advanced === view; tab.classList.toggle("active", active); tab.setAttribute("aria-selected", String(active)); });
  document.querySelectorAll("[data-advanced-panel]").forEach((panel) => { const active = panel.dataset.advancedPanel === view; panel.hidden = !active; panel.classList.toggle("active", active); });
}));
document.querySelectorAll("[data-spectrum]").forEach((button) => button.addEventListener("click", () => {
  state.activeSpectrum = button.dataset.spectrum;
  document.querySelectorAll("[data-spectrum]").forEach((item) => item.classList.toggle("active", item === button));
  drawSpectrum(state.latestResult);
}));

elements.startLiveButton.addEventListener("click", async () => {
  try { await startMicrophone(); } catch (error) {
    await stopMicrophone({ preserveSummary: true, silent: true });
    clearStaleMeasurement("Microphone unavailable", "unavailable", error.message);
  }
});
elements.stopLiveButton.addEventListener("click", () => stopMicrophone());
elements.analysisMode.addEventListener("change", () => {
  elements.windowValue.textContent = `${modeConfig().stableSeconds} sec`;
  if (state.listening && !state.recording) startSchedulers();
});
elements.recordButton.addEventListener("click", startRecording);
elements.stopRecordButton.addEventListener("click", stopRecording);
elements.downloadAudioButton.addEventListener("click", () => {
  if (!state.recordingUrl) return;
  const link = document.createElement("a"); link.href = state.recordingUrl; link.download = `noisecolor-recording-${Date.now()}.${state.recordingBlob.type.includes("mp4") ? "m4a" : state.recordingBlob.type.includes("ogg") ? "ogg" : "webm"}`; link.click();
});
elements.audioFile.addEventListener("change", (event) => loadAudioFile(event.target.files?.[0]));
for (const name of ["dragenter", "dragover"]) elements.fileDrop.addEventListener(name, (event) => { event.preventDefault(); elements.fileDrop.classList.add("dragging"); });
for (const name of ["dragleave", "drop"]) elements.fileDrop.addEventListener(name, (event) => { event.preventDefault(); elements.fileDrop.classList.remove("dragging"); });
elements.fileDrop.addEventListener("drop", (event) => loadAudioFile(event.dataTransfer?.files?.[0]));
elements.clearHistoryButton.addEventListener("click", async () => { if (window.confirm("Delete all locally saved NoiseColor results?")) { await clearMeasurements(); refreshHistory(); } });
elements.saveSummaryButton.addEventListener("click", async () => { if (state.lastSummary) { await saveMeasurement(state.lastSummary); elements.saveSummaryButton.textContent = "Saved locally"; } });
elements.exportSummaryButton.addEventListener("click", () => state.lastSummary && exportJson(state.lastSummary));
elements.exportSummaryCsvButton.addEventListener("click", () => state.lastSummary && exportCsv(state.lastSummary));
elements.calibrationFile.addEventListener("change", (event) => importCalibration(event.target.files?.[0]));
elements.calibrationProfile.addEventListener("change", selectCalibration);
elements.installButton.addEventListener("click", async () => {
  const platform = platformInstallHint();
  if (state.installPromptReady && platform !== "ios") await pwa.promptInstall();
  else showInstallSheet(platform);
});
elements.closeInstallSheet.addEventListener("click", hideInstallSheet);
elements.installSheet.addEventListener("click", (event) => { if (event.target === elements.installSheet) hideInstallSheet(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !elements.installSheet.hidden) hideInstallSheet(); });
window.addEventListener("resize", () => { drawBetaHistory(); renderAdvanced(state.latestResult); });
document.addEventListener("visibilitychange", () => {
  if (document.hidden && state.listening) interruptActiveCapture("Analysis paused while the app was in the background", "paused");
});
navigator.mediaDevices?.addEventListener?.("devicechange", () => {
  if (state.listening) interruptActiveCapture("Microphone device changed", "paused");
});
window.addEventListener("pagehide", () => interruptActiveCapture("Page closed", "paused"));

elements.versionLabel.textContent = `NoiseColor v${APP_VERSION} · engine v${ENGINE_VERSION}`;
loadCalibrationProfiles();
drawEmpty(elements.betaCanvas, "Start Live Analysis to see β history");
drawEmpty(elements.spectrumCanvas, "No spectrum available");
drawEmpty(elements.spectrogramCanvas, "No spectrogram available");
displayLiveState(createStatusState("listening", "Listening…", "Start Live Analysis to estimate the current spectral color."));
if (isStandalone()) { elements.installButton.textContent = "Installed"; elements.installButton.disabled = true; }
else if (new URLSearchParams(location.search).has("install")) showInstallSheet(platformInstallHint());
if (new URLSearchParams(location.search).get("action") === "upload") setView("upload");
if (new URLSearchParams(location.search).get("action") === "live") setView("live");
pwa.register();
