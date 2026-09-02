import {
  APP_VERSION,
  ENGINE_VERSION,
  CANONICAL_COLORS,
  DEFAULT_FIT_RANGE,
  FFT_SIZE,
  WELCH_OVERLAP,
  SessionAccumulator,
  summarize,
} from "./analysis-engine.js?v=0.6.8-recovery.3";
import { ColorStateMachine, createStatusState } from "./live-state.js?v=0.6.8-recovery.3";
import { HISTORY_PAGE_SIZE, clearMeasurements, deleteMeasurement, listMeasurementPage, sanitizeMicrophoneSettings, saveMeasurement } from "./history.js?v=0.6.8-recovery.3";
import { isIosDevice, isStandalone, platformInstallHint, setupPwa } from "./pwa.js?v=0.6.8-recovery.3";
import { canonicalAppUrl, isIosStandaloneDenial, microphoneEnvironment, microphoneStartupFailure, openSafariFromGesture } from "./microphone-compatibility.js?v=0.6.8-recovery.3";
import { capturePcm, CaptureContinuity, liveWindowProvenance, LiveAnalysisScheduler, MODE_CONFIG, ROLLING_SECONDS, RollingBuffer, selectBoundedAnalysisWindow, sessionSignalPercentages } from "./live-runtime.js?v=0.6.8-recovery.3";
import { PcmTrace, PcmMeter } from "./pcm-diagnostics.js?v=0.6.8-recovery.3";
import { mixToMono, decodePcmWavTail } from "./pcm-input.js?v=0.6.8-recovery.3";
import { PRIMARY_ANALYSIS_CONFIG } from "./analysis-pipeline.js?v=0.6.8-recovery.3";
import { browserDiagnosticInfo, canExportDiagnostic, createDiagnosticBundle } from "./diagnostic-bundle.js?v=0.6.8-recovery.3";
import { sanitizeMetadata } from "./privacy.js?v=0.6.8-recovery.3";
import { MAX_COMPRESSED_FILE_BYTES, preflightCompressedUpload } from "./upload-safety.js?v=0.6.8-recovery.3";
import { MicrophoneStartupError, MicrophoneStartupLock, isMicrophoneStartupCancellation, isMicrophoneStartupConflict } from "./microphone-startup.js?v=0.6.8-recovery.3";

const MAX_FILE_BYTES = 40 * 1024 * 1024;
const MAX_RECORDING_BYTES = 32 * 1024 * 1024;
const MAX_RECORDING_SECONDS = 120;
const AUDIO_CONTEXT_START_TIMEOUT_MS = 6000;

const elements = Object.fromEntries([
  "appShell", "installButton", "clearButton", "updateBanner", "reloadButton", "liveView", "analysisMode", "classification",
  "liveStateLabel", "stableBeta", "confidence", "qualityDetail", "startLiveButton", "stopLiveButton", "currentColor",
  "instantBeta", "stability", "fitResidual", "signalLevel", "windowValue", "betaCanvas", "liveSummary", "summaryMetrics",
  "saveSummaryButton", "exportSummaryButton", "exportSummaryCsvButton", "recordTimer", "recordFormat", "recordButton", "stopRecordButton",
  "downloadAudioButton", "recordStatus", "recordResult", "fileDrop", "audioFile", "fileName", "uploadStatus",
  "uploadResult", "clearHistoryButton", "historyList", "historyPrevious", "historyNext", "historyPageStatus", "spectrumCanvas", "spectrumNote", "spectrogramCanvas",
  "diagnosticGrid", "measuredCopy", "interpretationCopy", "calibrationFile", "calibrationProfile", "calibrationState",
  "scalarGain", "railMeasured", "railInterpretation", "railStatus", "versionLabel", "installSheet", "closeInstallSheet",
  "installInstructions", "privacyChip", "summaryTimeline", "betaDataSummary", "spectrumDataSummary", "spectrogramDataSummary",
  "exportLiveDiagnosticButton", "exportDiagnosticButton", "diagnosticExportStatus",
  "captureInterruption", "captureInterruptionText", "resumeCaptureButton",
  "microphoneFailure", "microphoneFailureTitle", "microphoneFailureText", "iosMicrophoneActions", "openSafariButton", "retryMicrophoneButton",
  "reinstallMicrophoneButton", "safariFallback", "safariCanonicalLink", "copySafariLinkButton", "safariLinkStatus", "exportStartupDiagnosticButton",
].map((id) => [id, document.getElementById(id)]));

const stateMachine = new ColorStateMachine();
const microphoneStartup = new MicrophoneStartupLock();
const state = {
  worker: null,
  workerRequests: new Map(),
  workerId: 0,
  workerBusy: false,
  stream: null,
  audioContext: null,
  sourceNode: null,
  captureNode: null,
  silentGain: null,
  rolling: null,
  recordingPcm: null,
  pcmTrace: null,
  captureInputPcm: null,
  captureTransport: null,
  listening: false,
  recording: false,
  sampleRate: null,
  inputRoute: null,
  inputRouteLabel: null,
  constraintSettings: null,
  startedAt: null,
  fastTimer: null,
  stableTimer: null,
  spectrogramTimer: null,
  recordTimer: null,
  fastBusy: false,
  stableBusy: false,
  spectrogramBusy: false,
  wakeLock: null,
  observations: [],
  sessionAccumulator: null,
  liveDisplay: null,
  betaHistory: [],
  latestResult: null,
  liveDiagnosticResult: null,
  interruptionEvents: [],
  continuity: new CaptureContinuity(),
  resumingCapture: false,
  latestSpectrogram: null,
  lastSummary: null,
  recorder: null,
  recordingChunks: [],
  recordingBytes: 0,
  recordingBlob: null,
  recordingUrl: null,
  calibrationProfiles: [],
  activeCalibration: null,
  activeSpectrum: "psd",
  installPromptReady: false,
  currentView: "live",
  historyOffset: 0,
  stopping: false,
  finalizingRecording: false,
  captureGeneration: 0,
  analysisGeneration: 0,
  recordingAnalysisGeneration: 0,
  microphoneStartupMode: null,
  microphoneFailure: null,
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
  const recent = recentStableObservations().filter((item) => item.reliable);
  const profile = state.activeCalibration && state.inputRoute && state.activeCalibration.routeId === state.inputRoute
    ? state.activeCalibration
    : null;
  return {
    ...PRIMARY_ANALYSIS_CONFIG,
    analysisMode: elements.analysisMode.value,
    sourceType,
    sourceFilename,
    calibrationProfile: profile,
    temporalSd: sourceType === "live" ? summarize(recent.map((item) => item.beta)).sd || 0 : 0,
    temporalObservationCount: sourceType === "live" ? recent.length : 0,
    temporalSelection: sourceType === "live" ? "reliable observations among preceding 10 stable windows in current contiguous segment" : "computed from recording temporal windows",
    previousProminentPeakFrequencies: sourceType === "live" ? state.latestResult?.prominentPeakFrequencies || [] : [],
    scalarGainDb: Number(elements.scalarGain.value) || 0,
    calibrationRouteKey: state.inputRoute,
    inputRouteLabel: state.inputRouteLabel,
    microphoneSettings: sourceType === "live" || sourceType === "recorded-microphone" ? sanitizeMicrophoneSettings(state.constraintSettings) : null,
    captureEvents: sourceType === "live" || sourceType === "recorded-microphone" ? structuredClone(state.interruptionEvents) : [],
    acquisition: {
      decoder: "Web-Audio-capture", channelCount: 1, channelMix: "browser-explicit-mono",
      browser: browserDiagnosticInfo(navigator, { secureContext: window.isSecureContext, standalone: isStandalone() }),
      audioContext: state.audioContext ? { sampleRate: state.audioContext.sampleRate, baseLatency: state.audioContext.baseLatency, outputLatency: state.audioContext.outputLatency, state: state.audioContext.state } : null,
      track: state.stream?.getAudioTracks()[0] ? { readyState: state.stream.getAudioTracks()[0].readyState, muted: state.stream.getAudioTracks()[0].muted, enabled: state.stream.getAudioTracks()[0].enabled } : null,
    },
    ...extra,
  };
}

function recentStableObservations() {
  const segmentStartSeconds = state.sampleRate ? state.continuity.segmentStartSample / state.sampleRate : 0;
  return state.observations.slice(-10).filter((item) => item.startSeconds >= segmentStartSeconds);
}

function ensureWorker() {
  if (state.worker) return state.worker;
  state.worker = new Worker(new URL("./analysis-worker.js?v=0.6.8-recovery.3", import.meta.url), { type: "module" });
  state.worker.addEventListener("message", (event) => {
    const request = state.workerRequests.get(event.data.id);
    if (!request) return;
    state.workerRequests.delete(event.data.id);
    state.workerBusy = false;
    if (event.data.error) request.reject(new Error(event.data.error));
    else request.resolve(event.data.result);
  });
  state.worker.addEventListener("error", (error) => {
    for (const request of state.workerRequests.values()) request.reject(error);
    state.workerRequests.clear();
    state.workerBusy = false;
  });
  return state.worker;
}

function requestAnalysis(type, samples, sampleRate, options = {}) {
  if (state.workerBusy) return Promise.reject(new Error("Analysis is busy; the superseded request was dropped."));
  const worker = ensureWorker();
  const id = ++state.workerId;
  if (type === "analyze-live" || type === "analyze-fast") {
    options = { ...options, ...liveWindowProvenance(samples.length, state.sessionAccumulator?.inputMeter.sampleCount || samples.length, sampleRate) };
  }
  if (type === "analyze-live" || type === "analyze-fast" || options.sourceType === "recorded-microphone") {
    state.pcmTrace?.record(options.sourceType === "recorded-microphone" ? "recordingBuffer" : "rollingBuffer", samples);
    options = { ...options, pcmDiagnostics: { ...captureDiagnostics(), ...options.pcmDiagnostics } };
  }
  state.workerBusy = true;
  return new Promise((resolve, reject) => {
    state.workerRequests.set(id, { resolve, reject });
    try {
      worker.postMessage({ id, type, samples, sampleRate, options }, [samples.buffer]);
    } catch (error) {
      state.workerRequests.delete(id);
      state.workerBusy = false;
      reject(error);
    }
  });
}

function captureDiagnostics() {
  return { ...state.pcmTrace?.snapshot(), captureInput: state.captureInputPcm,
    sessionAccumulator: state.sessionAccumulator?.inputMeter.snapshot(),
    activityTimeline: state.sessionAccumulator?.activityMeter.snapshot(),
    lastActivityFrame: state.sessionAccumulator?.lastActivityPcm,
    source: { transport: state.captureTransport, observationBoundary: "Web Audio input from getUserMedia; no pre-browser PCM access", sampleRate: state.sampleRate, settings: sanitizeMicrophoneSettings(state.constraintSettings) } };
}

function cancelPendingAnalysis() {
  if (!state.worker) return;
  for (const request of state.workerRequests.values()) request.reject(new Error("Analysis superseded by a newer action."));
  state.workerRequests.clear();
  state.worker.terminate();
  state.worker = null;
  state.workerBusy = false;
}

function setView(view) {
  state.currentView = view;
  updateMicrophoneFailureView();
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
  state.liveDisplay = display;
  elements.appShell.dataset.state = display.state;
  elements.liveStateLabel.textContent = display.state.replaceAll("-", " ").toUpperCase();
  elements.classification.textContent = display.label;
  elements.stableBeta.textContent = display.reliable && Number.isFinite(display.displayBeta) ? `Stable β ${display.displayBeta.toFixed(2)}` : "Stable β —";
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
  elements.exportDiagnosticButton.disabled = true;
  elements.diagnosticExportStatus.textContent = "No active measurement. The last live diagnostic remains available in Live until Clear or a new capture.";
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

function clearResultContainer(container) {
  container.hidden = true;
  container.replaceChildren();
}

function releaseRecordingObject() {
  state.recordingPcm = null;
  if (state.recordingUrl) URL.revokeObjectURL(state.recordingUrl);
  state.recordingUrl = null;
  state.recordingBlob = null;
  state.recordingChunks = [];
  state.recordingBytes = 0;
  elements.downloadAudioButton.hidden = true;
}

function clearAnalysisResults({ resetStatuses = true } = {}) {
  state.analysisGeneration += 1;
  cancelPendingAnalysis();
  state.latestResult = null;
  state.latestSpectrogram = null;
  state.lastSummary = null;
  state.liveDiagnosticResult = null;
  state.interruptionEvents = [];
  elements.exportLiveDiagnosticButton.disabled = true;
  elements.exportDiagnosticButton.disabled = true;
  elements.diagnosticExportStatus.textContent = "No exact measurement available.";
  state.observations = [];
  state.betaHistory = [];
  state.sessionAccumulator = null;
  clearResultContainer(elements.recordResult);
  clearResultContainer(elements.uploadResult);
  elements.liveSummary.hidden = true;
  elements.summaryMetrics.replaceChildren();
  elements.summaryTimeline.replaceChildren();
  elements.diagnosticGrid.innerHTML = '<div><span>Status</span><strong>No measurement</strong></div>';
  elements.measuredCopy.textContent = "No measurement yet.";
  elements.interpretationCopy.textContent = "Noise color is only reported when input and model-quality gates pass.";
  elements.spectrumNote.textContent = "Start Live Analysis or analyze a recording to populate the spectrum.";
  elements.betaDataSummary.textContent = "No β history is available.";
  elements.spectrumDataSummary.textContent = "No spectrum data is available.";
  elements.spectrogramDataSummary.textContent = "No spectrogram data is available.";
  elements.saveSummaryButton.textContent = "Save to History";
  elements.saveSummaryButton.disabled = false;
  drawEmpty(elements.betaCanvas, "Start Live Analysis to see β history");
  drawEmpty(elements.spectrumCanvas, "No spectrum available");
  drawEmpty(elements.spectrogramCanvas, "No spectrogram available");
  clearStaleMeasurement("Ready", "listening", "Start Live Analysis or choose a local audio file.");
  if (resetStatuses) {
    elements.fileName.textContent = "PCM WAV up to 40 MB · verified compressed audio up to 12 MB / 2 min";
    elements.uploadStatus.textContent = "Ready for a local audio file.";
    elements.recordStatus.textContent = "No audio is being recorded.";
    elements.recordTimer.textContent = "00:00";
    elements.recordFormat.textContent = "Format selected after browser detection";
  }
}

async function resetApplication() {
  clearMicrophoneFailure();
  if (state.recording) {
    state.recording = false;
    const recorder = state.recorder;
    state.recorder = null;
    window.clearInterval(state.recordTimer);
    try { if (recorder?.state !== "inactive") recorder.stop(); } catch { /* recorder already stopped */ }
  }
  await stopMicrophone({ preserveSummary: true, silent: true });
  releaseRecordingObject();
  state.inputRoute = null;
  state.inputRouteLabel = null;
  state.constraintSettings = null;
  elements.audioFile.value = "";
  clearAnalysisResults();
  selectCalibration();
  setView("live");
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

async function closeAudioContext(audioContext) {
  if (!audioContext || audioContext.state === "closed") return;
  try { await Promise.race([audioContext.close(), new Promise((resolve) => window.setTimeout(resolve, 1500))]); } catch { /* best-effort release */ }
}

function disconnectAudioNode(node) {
  try { node?.disconnect(); } catch { /* already disconnected */ }
}

function setMicrophoneStartupControls(recording, pending, succeeded = false) {
  elements.startLiveButton.disabled = pending;
  elements.recordButton.disabled = pending;
  elements.stopLiveButton.disabled = false;
  elements.stopRecordButton.disabled = false;
  elements.stopLiveButton.textContent = pending && !recording ? "Cancel Startup" : "Stop Listening";
  elements.stopRecordButton.textContent = pending && recording ? "Cancel Startup" : "Stop & Analyze";
  if (pending) {
    elements.startLiveButton.hidden = !recording;
    elements.stopLiveButton.hidden = recording;
    elements.recordButton.hidden = recording;
    elements.stopRecordButton.hidden = !recording;
    return;
  }
  if (succeeded) {
    elements.startLiveButton.hidden = true;
    elements.stopLiveButton.hidden = recording;
    elements.recordButton.hidden = recording;
    elements.stopRecordButton.hidden = !recording;
    return;
  }
  if (!state.listening) {
    elements.startLiveButton.hidden = false;
    elements.stopLiveButton.hidden = true;
    elements.recordButton.hidden = false;
    elements.stopRecordButton.hidden = true;
  }
}

async function cancelMicrophoneStartup() {
  const recording = state.microphoneStartupMode === "recording";
  const cancelled = await microphoneStartup.cancel();
  if (cancelled) {
    state.microphoneStartupMode = null;
    setMicrophoneStartupControls(recording, false, false);
  }
  return cancelled;
}

async function resumeAudioContext(audioContext, timeoutMs = AUDIO_CONTEXT_START_TIMEOUT_MS) {
  let timeoutId;
  try {
    await Promise.race([
      (async () => {
        await audioContext.resume();
        if (audioContext.state === "running") return;
        await new Promise((resolve, reject) => {
          const onStateChange = () => {
            if (audioContext.state === "running") { audioContext.removeEventListener("statechange", onStateChange); resolve(); }
            else if (audioContext.state === "closed") { audioContext.removeEventListener("statechange", onStateChange); reject(new Error("Audio processing closed before startup.")); }
          };
          audioContext.addEventListener("statechange", onStateChange);
        });
      })(),
      new Promise((_, reject) => { timeoutId = window.setTimeout(() => reject(new Error("Audio startup timed out. Tap Start Live Analysis to try again.")), timeoutMs); }),
    ]);
  } finally {
    window.clearTimeout(timeoutId);
  }
  if (audioContext.state !== "running") throw new Error(`Audio processing did not start (state: ${audioContext.state}).`);
}

async function startMicrophone({ recording = false } = {}) {
  if (state.recording && !recording) throw new Error("Stop the current recording before starting Live Analysis.");
  if (microphoneStartup.pending) throw new MicrophoneStartupError("A microphone startup attempt is already in progress.", "MICROPHONE_STARTUP_IN_PROGRESS");
  clearMicrophoneFailure();
  if (state.stream) await stopMicrophone({ preserveSummary: false, silent: true });
  let failureStage = "startup";
  let obtainedTrack = null;
  const constraints = {
    audio: { channelCount: { ideal: 1 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    video: false,
  };
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone access is not supported in this browser.");
    return await microphoneStartup.run(async (startup) => {
      state.microphoneStartupMode = recording ? "recording" : "live";
      setMicrophoneStartupControls(recording, true);
      failureStage = "get-user-media";
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      await startup.track(stream, (resource) => resource.getTracks().forEach((item) => item.stop()));
      startup.checkpoint();
      const track = stream.getAudioTracks()[0];
      obtainedTrack = track || null;
      failureStage = "audio-setup";
      if (!track) throw new Error("No microphone audio track is available.");
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error("Audio processing is not supported in this browser.");
      const audioContext = new AudioContextClass({ latencyHint: "interactive" });
      await startup.track(audioContext, closeAudioContext);
      await resumeAudioContext(audioContext);

      const rolling = new RollingBuffer(Math.round(audioContext.sampleRate * ROLLING_SECONDS));
      const sessionAccumulator = new SessionAccumulator(audioContext.sampleRate);
      const captureSamples = (samples) => {
        if (!state.listening || state.continuity.paused || state.audioContext !== audioContext) return;
        capturePcm(samples, { rolling, sessionAccumulator, recordingBuffer: state.recordingPcm, trace: state.pcmTrace, fallback: state.latestResult });
      };
      state.pcmTrace = new PcmTrace();
      state.captureInputPcm = null;
      state.recordingPcm = recording ? new RollingBuffer(audioContext.sampleRate * MAX_RECORDING_SECONDS) : null;
      const sourceNode = audioContext.createMediaStreamSource(stream);
      await startup.track(sourceNode, disconnectAudioNode);
      const silentGain = audioContext.createGain();
      await startup.track(silentGain, disconnectAudioNode);
      silentGain.gain.value = 0;
      silentGain.connect(audioContext.destination);

      let captureNode;
      if (audioContext.audioWorklet) {
        await audioContext.audioWorklet.addModule("./audio-worklet.js?v=0.6.8-recovery.3");
        startup.checkpoint();
        captureNode = new AudioWorkletNode(audioContext, "noisecolor-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: "explicit", channelInterpretation: "speakers" });
        state.captureTransport = "AudioWorklet / explicit mono input";
        captureNode.port.onmessage = (event) => {
          if (state.audioContext !== audioContext || !state.listening) return;
          if (event.data.type === "packet-reset") return;
          state.captureInputPcm = event.data.input;
          if (state.listening) state.pcmTrace.record("workletOutput", event.data.samples);
          captureSamples(event.data.samples);
        };
      } else {
        captureNode = audioContext.createScriptProcessor(2048, 1, 1);
        state.captureTransport = "ScriptProcessor / mono input";
        const inputMeter = new PcmMeter();
        captureNode.onaudioprocess = (event) => {
          if (state.audioContext !== audioContext || !state.listening) return;
          const samples = new Float32Array(event.inputBuffer.getChannelData(0));
          state.captureInputPcm = inputMeter.add(samples);
          if (state.listening) state.pcmTrace.record("scriptProcessorOutput", samples);
          captureSamples(samples);
        };
      }
      await startup.track(captureNode, disconnectAudioNode);
      sourceNode.connect(captureNode);
      captureNode.connect(silentGain);
      startup.checkpoint();
      await acquireWakeLock();
      if (state.wakeLock) {
        await startup.track(state.wakeLock, async (wakeLock) => {
          try { await wakeLock.release(); } catch { /* already released */ }
          if (state.wakeLock === wakeLock) state.wakeLock = null;
        });
      }
      startup.checkpoint();

      state.stream = stream;
      state.audioContext = audioContext;
      state.sourceNode = sourceNode;
      state.captureNode = captureNode;
      state.silentGain = silentGain;
      state.sampleRate = audioContext.sampleRate;
      state.rolling = rolling;
      state.sessionAccumulator = sessionAccumulator;
      state.listening = true;
      state.startedAt = performance.now();
      state.inputRoute = inputRouteFromTrack(track);
      state.inputRouteLabel = "Microphone · current session";
      state.constraintSettings = track.getSettings?.() || {};
      try {
        selectCalibration();
        state.observations = [];
        state.betaHistory = [];
        state.latestResult = null;
        state.liveDiagnosticResult = null;
        state.lastSummary = null;
        state.interruptionEvents = [];
        state.continuity = new CaptureContinuity();
        state.interruptionEvents = state.continuity.events;
        elements.captureInterruption.hidden = true;
        elements.exportLiveDiagnosticButton.disabled = true;
        state.latestSpectrogram = null;
        state.captureGeneration += 1;
        stateMachine.reset();
        if (!recording) elements.liveSummary.hidden = true;
        drawEmpty(elements.betaCanvas, "Listening for a stable estimate…");
        drawEmpty(elements.spectrumCanvas, "Waiting for a stable spectrum…");
        drawEmpty(elements.spectrogramCanvas, "Waiting for spectrogram data…");
        track.addEventListener("ended", () => { if (state.stream === stream) interruptActiveCapture("Microphone unavailable", "unavailable", { terminal: true }); });
        track.addEventListener("mute", () => { if (state.stream === stream) interruptActiveCapture("Microphone interrupted", "unavailable"); });
        audioContext.addEventListener("statechange", () => {
          if (state.listening && state.audioContext === audioContext && audioContext.state !== "running" && !state.stopping) interruptActiveCapture(`Audio processing ${audioContext.state}`, "paused", { terminal: audioContext.state === "closed" });
        });
        if (!recording) startSchedulers();
        setMicrophoneStartupControls(recording, false, true);
        elements.railStatus.innerHTML = `<i></i> ${recording ? "RECORDING" : "LIVE"}`;
        elements.privacyChip.textContent = recording ? "Recording locally" : "Listening locally";
        const config = modeConfig();
        elements.windowValue.textContent = `${config.stableSeconds} sec`;
        displayLiveState(stateMachine.reset(), null);
        elements.qualityDetail.textContent = constraintSummary();
        startup.commit();
        return stream;
      } catch (error) {
        stopSchedulers();
        state.listening = false;
        state.stream = null;
        state.audioContext = null;
        state.sourceNode = null;
        state.captureNode = null;
        state.silentGain = null;
        state.rolling = null;
        state.sessionAccumulator = null;
        throw error;
      }
    });
  } catch (error) {
    setMicrophoneStartupControls(recording, false, false);
    if (!isMicrophoneStartupCancellation(error) && !isMicrophoneStartupConflict(error)) {
      let settings = null;
      try { settings = obtainedTrack?.getSettings?.() || null; } catch { /* settings are optional diagnostics */ }
      state.microphoneFailure = microphoneStartupFailure(error, {
        ...microphoneEnvironment(window, navigator), acquisitionMode: recording ? "recording" : "live", stage: failureStage,
        trackObtained: Boolean(obtainedTrack), audioTrackSettings: settings,
      });
    }
    throw error;
  } finally {
    state.microphoneStartupMode = null;
  }
}

function constraintSummary() {
  const settings = state.constraintSettings || {};
  const stateFor = (key) => settings[key] === false ? "off" : settings[key] === true ? "on" : "not reported";
  return `Actual ${state.sampleRate || "—"} Hz input. Echo cancellation ${stateFor("echoCancellation")}; noise suppression ${stateFor("noiseSuppression")}; auto gain ${stateFor("autoGainControl")}.`;
}

function startSchedulers() {
  const config = modeConfig();
  stopSchedulers();
  const scheduler = new LiveAnalysisScheduler(config);
  state.fastTimer = window.setInterval(() => {
    if (!state.listening || !state.rolling) return;
    const task = scheduler.next(performance.now(), state.rolling.length / state.sampleRate, state.workerBusy);
    if (task === "stable") void runStableAnalysis();
    else if (task === "fast") void runFastAnalysis();
  }, Math.min(100, config.fastEveryMs));
  state.spectrogramTimer = window.setInterval(runSpectrogram, 7000);
}

function stopSchedulers() {
  for (const key of ["fastTimer", "stableTimer", "spectrogramTimer"]) {
    window.clearInterval(state[key]);
    state[key] = null;
  }
  state.fastBusy = false;
  state.stableBusy = false;
  state.spectrogramBusy = false;
}

async function runFastAnalysis() {
  if (!state.listening || state.continuity.paused || state.fastBusy || state.workerBusy || !state.rolling) return;
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
  if (!state.listening || state.continuity.paused || state.stableBusy || state.workerBusy || !state.rolling) return;
  const config = modeConfig();
  if (state.rolling.length < state.sampleRate * config.stableSeconds) return;
  state.stableBusy = true;
  const generation = state.captureGeneration;
  try {
    const samples = state.rolling.latest(Math.round(state.sampleRate * config.stableSeconds));
    const result = await requestAnalysis("analyze-live", samples, state.sampleRate, currentOptions("live"));
    if (!state.listening || generation !== state.captureGeneration) return;
    const timeSeconds = result.measurementWindow.endSample / result.sampleRate;
    const stableSeconds = result.measurementWindow.sampleCount / result.sampleRate;
    const observation = { timeSeconds: Math.max(0, timeSeconds - stableSeconds / 2), startSeconds: result.measurementWindow.startSample / result.sampleRate, endSeconds: timeSeconds, beta: result.beta, state: result.state, classification: result.classification, reliable: result.reliable, rmseDb: result.rmseDb, r2: result.r2, spectralFlatness: result.spectralFlatness };
    state.observations.push(observation);
    if (state.observations.length > 3600) state.observations.splice(0, state.observations.length - 3600);
    state.betaHistory.push(observation);
    state.betaHistory = state.betaHistory.filter((item) => timeSeconds - item.timeSeconds <= 30);
    state.latestResult = result;
    state.liveDiagnosticResult = result;
    elements.exportLiveDiagnosticButton.disabled = false;
    const display = stateMachine.update(result);
    displayLiveState(display, result);
    // Session science uses the measured decision, never the hysteretic UI label.
    state.sessionAccumulator?.addObservation(observation);
    const stableValues = recentStableObservations().filter((item) => item.reliable).map((item) => item.beta);
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
  const spectrogramVisible = state.currentView === "advanced" && document.querySelector('[data-advanced="spectrogram"]')?.classList.contains("active");
  if (!spectrogramVisible || !state.listening || state.spectrogramBusy || state.workerBusy || !state.rolling || state.rolling.length < state.sampleRate * 2) return;
  state.spectrogramBusy = true;
  try {
    const generation = state.captureGeneration;
    const samples = state.rolling.latest(Math.round(state.sampleRate * Math.min(12, modeConfig().stableSeconds)));
    const spectrogram = await requestAnalysis("spectrogram", samples, state.sampleRate, { maxFrames: 64 });
    if (!state.listening || generation !== state.captureGeneration) return;
    state.latestSpectrogram = spectrogram;
    drawSpectrogram(state.latestSpectrogram);
  } catch (error) {
    console.error(error);
  } finally {
    state.spectrogramBusy = false;
  }
}

async function stopMicrophone({ reason = "Analysis paused", stateName = "paused", preserveSummary = false, silent = false } = {}) {
  const cancelledStartup = await cancelMicrophoneStartup();
  if (state.stopping || (!state.stream && !state.audioContext)) return;
  state.stopping = true;
  elements.captureInterruption.hidden = true;
  state.listening = false;
  state.captureGeneration += 1;
  stopSchedulers();
  const durationSeconds = (state.sessionAccumulator?.inputMeter.sampleCount || 0) / state.sampleRate;
  if (!preserveSummary && state.sessionAccumulator?.durationSeconds > 0) {
    state.sessionAccumulator.finish(state.latestResult);
    const session = state.sessionAccumulator.summary(state.observations);
    const sessionReliable = Boolean(session.dominantReliableColor) && session.rejectedPercentage < 20;
    state.lastSummary = {
      ...session,
      pcmDiagnostics: { ...captureDiagnostics(), ...session.pcmDiagnostics, workerInput: state.latestResult?.pcmDiagnostics?.workerInput },
      id: undefined,
      appVersion: APP_VERSION,
      analysisEngineVersion: ENGINE_VERSION,
      timestamp: new Date().toISOString(),
      sourceType: "live-session",
      sampleRate: state.sampleRate,
      durationSeconds,
      sourceDurationSeconds: durationSeconds,
      analysisStartSeconds: 0,
      analysisTruncated: false,
      analysisMode: elements.analysisMode.value,
      analysisWindowSeconds: modeConfig().stableSeconds,
      fitRange: DEFAULT_FIT_RANGE,
      fftSize: FFT_SIZE,
      welchOverlap: WELCH_OVERLAP,
      calibrationProfile: state.activeCalibration?.name || null,
      calibration: state.latestResult?.calibration || null,
      corrected: Boolean(state.latestResult?.corrected),
      scalarGainDb: Number(elements.scalarGain.value) || 0,
      inputRouteLabel: state.inputRouteLabel,
      microphoneSettings: sanitizeMicrophoneSettings(state.constraintSettings),
      classification: sessionReliable ? session.dominantReliableColor : "Mixed session / rejected intervals",
      beta: session.betaMean,
      temporalBetaMean: session.betaMean,
      temporalBetaSd: session.betaSd,
      temporalBetaMedian: session.betaMedian,
      rmseDb: session.fitRmseMeanDb,
      r2: session.fitR2Mean,
      spectralFlatness: session.spectralFlatnessMean,
      confidence: "Session summary",
      reliable: sessionReliable,
      qualityDetail: sessionReliable ? `${session.reliablePercentage.toFixed(1)}% of session time passed quality gates.` : `${session.rejectedPercentage.toFixed(1)}% of session time was rejected; no single session color is reported.`,
    };
    renderSessionSummary(state.lastSummary);
  }
  try {
    state.stream?.getTracks().forEach((track) => track.stop());
    try { state.captureNode?.disconnect(); } catch { /* disconnected */ }
    try { state.sourceNode?.disconnect(); } catch { /* disconnected */ }
    try { state.silentGain?.disconnect(); } catch { /* disconnected */ }
    await closeAudioContext(state.audioContext);
    await releaseWakeLock();
    state.stream = null;
    state.audioContext = null;
    state.sourceNode = null;
    state.captureNode = null;
    state.silentGain = null;
    state.rolling = null;
    state.sessionAccumulator = null;
    state.recordingPcm = null;
    state.inputRoute = null;
    state.inputRouteLabel = null;
    state.constraintSettings = null;
    selectCalibration();
    elements.startLiveButton.hidden = false;
    elements.stopLiveButton.hidden = true;
    elements.railStatus.innerHTML = "<i></i> LOCAL";
    elements.privacyChip.textContent = "Local analysis";
    if (!silent) clearStaleMeasurement(reason, stateName, `${reason}. Restart the microphone when ready.`);
  } finally {
    state.stopping = false;
    if (cancelledStartup && !state.listening) setMicrophoneStartupControls(false, false, false);
  }
}

async function interruptActiveCapture(reason, stateName = "paused", { terminal = false } = {}) {
  if (state.finalizingRecording || state.stopping) return;
  const track = state.stream?.getAudioTracks()[0];
  if (!state.listening && !microphoneStartup.pending) return;
  if (terminal || !track || track.readyState !== "live") {
    state.interruptionEvents.push({ kind: reason, sampleOffset: state.sessionAccumulator?.inputMeter.sampleCount ?? 0,
      elapsedSeconds: state.startedAt ? (performance.now() - state.startedAt) / 1000 : 0, recovered: false });
    if (state.recording) await stopRecording({ interrupted: true, reason });
    else await stopMicrophone({ reason, stateName });
    return;
  }
  if (!state.continuity.pause(reason, state.sessionAccumulator.inputMeter.sampleCount, (performance.now() - state.startedAt) / 1000)) return;
  state.captureGeneration += 1;
  stopSchedulers();
  state.sessionAccumulator.finish(state.latestResult);
  state.rolling.clear();
  clearStaleMeasurement("Capture paused", "paused", "The microphone remains available. Resume to begin a new contiguous analysis window.");
  elements.captureInterruption.hidden = false;
  elements.captureInterruptionText.textContent = `${reason}. No PCM is being retained during this pause. Resume capture or stop to analyze the last contiguous segment.`;
  elements.resumeCaptureButton.disabled = true;
  if (state.recording) elements.recordStatus.textContent = "Recording paused; available audio is preserved. Resume or Stop & Analyze.";
  try {
    if (state.recorder?.state === "recording") state.recorder.pause();
    await releaseWakeLock();
    if (state.audioContext?.state === "running") await state.audioContext.suspend();
  } catch (error) {
    elements.captureInterruptionText.textContent = `Capture paused: ${error.message}. Stop if this browser cannot resume.`;
  } finally {
    elements.resumeCaptureButton.disabled = false;
  }
}

function resetWorkletPacket(node) {
  if (!node?.port) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const token = ++state.workerId;
    const finish = (error) => {
      window.clearTimeout(timeout);
      node.port.removeEventListener("message", onMessage);
      error ? reject(error) : resolve();
    };
    const onMessage = ({ data }) => { if (data?.type === "packet-reset" && data.token === token) finish(); };
    const timeout = window.setTimeout(() => finish(new Error("Audio packet reset timed out.")), 2000);
    node.port.addEventListener("message", onMessage);
    node.port.postMessage({ type: "reset-packet", token });
  });
}

async function resumeCapture() {
  if (!state.continuity.paused || state.resumingCapture || !state.listening) return;
  const context = state.audioContext;
  const continuity = state.continuity;
  const generation = state.captureGeneration;
  state.resumingCapture = true;
  elements.resumeCaptureButton.disabled = true;
  try {
    const track = state.stream?.getAudioTracks()[0];
    if (document.hidden || track?.readyState !== "live" || track.muted) throw new Error("Keep the app visible and wait for the microphone to become available.");
    await resumeAudioContext(context);
    await resetWorkletPacket(state.captureNode);
    if (!state.listening || state.audioContext !== context || state.continuity !== continuity || generation !== state.captureGeneration) return;
    if (state.recording && state.recorder?.state !== "paused") throw new Error("The browser recorder cannot resume. Stop & Analyze the retained segment.");
    if (track.muted || context.state !== "running" || document.hidden) throw new Error("The microphone is still interrupted.");
    if (state.recording) state.recorder.resume();
    state.constraintSettings = track.getSettings?.() || {};
    state.inputRoute = inputRouteFromTrack(track);
    selectCalibration();
    state.rolling.clear();
    continuity.resume(state.sessionAccumulator.inputMeter.sampleCount, (performance.now() - state.startedAt) / 1000);
    stateMachine.reset();
    elements.captureInterruption.hidden = true;
    displayLiveState(stateMachine.reset());
    if (!state.recording) startSchedulers();
    else elements.recordStatus.textContent = "Recording resumed. Analysis will use the final contiguous segment; the separate audio download retains earlier recorded segments.";
    await acquireWakeLock();
  } catch (error) {
    elements.captureInterruptionText.textContent = `Still paused: ${error.message}`;
  } finally {
    state.resumingCapture = false;
    elements.resumeCaptureButton.disabled = false;
  }
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
    ["Reliable time", formatNumber(summary.reliablePercentage, 0, "%")],
    ["Rejected time", formatNumber(summary.rejectedPercentage, 0, "%")],
    ["Mixed", formatNumber(percent.mixed, 0, "%")],
    ["Tonal", formatNumber(percent.tonal, 0, "%")],
    ["Low signal", formatNumber(sessionSignalPercentages(percent).lowSignal, 0, "%")],
    ["Awaiting analysis", formatNumber(sessionSignalPercentages(percent).awaitingAnalysis, 0, "%")],
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
  if (!microphoneStartup.pending) clearMicrophoneFailure();
  try {
    if (state.finalizingRecording) throw new Error("The previous recording is still being finalized.");
    if (!("MediaRecorder" in window)) throw new Error("Audio recording is not supported by this browser.");
    if (microphoneStartup.pending) {
      elements.recordStatus.textContent = "A microphone startup attempt is already in progress.";
      return;
    }
    clearAnalysisResults({ resetStatuses: false });
    state.recordingAnalysisGeneration = state.analysisGeneration;
    releaseRecordingObject();
    const stream = await startMicrophone({ recording: true });
    const mimeType = chooseRecordingMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    state.recording = true;
    state.recordingChunks = [];
    state.recordingBytes = 0;
    state.recorder = recorder;
    recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      if (state.recordingBytes + event.data.size > MAX_RECORDING_BYTES) {
        stopRecording({ interrupted: true, reason: "Recording memory limit reached" });
        return;
      }
      state.recordingChunks.push(event.data);
      state.recordingBytes += event.data.size;
    };
    recorder.addEventListener("error", (event) => {
      elements.recordStatus.textContent = event.error?.message || "Recording failed.";
      interruptActiveCapture("Recording interrupted", "unavailable", { terminal: true });
    });
    recorder.addEventListener("stop", () => {
      if (state.recording && !state.finalizingRecording) stopRecording({ interrupted: true, reason: "Recording stopped by the browser" });
    });
    recorder.start(1000);
    elements.recordButton.hidden = true;
    elements.stopRecordButton.hidden = false;
    elements.downloadAudioButton.hidden = true;
    elements.recordFormat.textContent = recorder.mimeType || "Browser default audio format";
    elements.recordStatus.textContent = `Recording locally for up to ${formatDuration(MAX_RECORDING_SECONDS)}. Stop when ready to analyze.`;
    state.recordTimer = window.setInterval(() => {
      const elapsed = (performance.now() - state.startedAt) / 1000;
      elements.recordTimer.textContent = formatDuration(elapsed);
      if (elapsed >= MAX_RECORDING_SECONDS) stopRecording({ interrupted: true, reason: "Maximum recording duration reached" });
    }, 250);
  } catch (error) {
    elements.recordStatus.textContent = error.message;
    state.recording = false;
    state.recorder = null;
    if (!isMicrophoneStartupConflict(error) && !isMicrophoneStartupCancellation(error)) {
      state.recordingPcm = null;
      await stopMicrophone({ reason: "Microphone unavailable", stateName: "unavailable", preserveSummary: true, silent: true });
      presentMicrophoneFailure(error, "recording");
    }
  }
}

async function stopRecording({ interrupted = false, reason = "" } = {}) {
  if (!state.recorder || state.finalizingRecording) {
    await cancelMicrophoneStartup();
    return;
  }
  state.finalizingRecording = true;
  elements.stopRecordButton.disabled = true;
  elements.recordStatus.textContent = interrupted ? "The recording was interrupted. Finalizing available audio locally…" : "Finalizing and analyzing the recording locally…";
  window.clearInterval(state.recordTimer);
  const recorder = state.recorder;
  const retainedLength = state.continuity.finalSegmentLength(state.sessionAccumulator?.inputMeter.sampleCount || 0, state.recordingPcm?.length || 0);
  const samples = state.recordingPcm?.latest(retainedLength) || new Float32Array();
  state.recordingPcm = null;
  const sampleRate = state.sampleRate;
  const recordingOptions = currentOptions("recorded-microphone");
  state.pcmTrace?.record("recordingBuffer", samples);
  const pcmDiagnostics = captureDiagnostics();
  try {
    if (recorder.state !== "inactive") {
      const stopped = new Promise((resolve) => recorder.addEventListener("stop", resolve, { once: true }));
      recorder.stop();
      await stopped;
    }
    state.recording = false;
    state.recorder = null;
    state.recordingBlob = new Blob(state.recordingChunks, { type: recorder.mimeType || "audio/webm" });
    state.recordingChunks = [];
    state.recordingBytes = 0;
    if (state.recordingUrl) URL.revokeObjectURL(state.recordingUrl);
    state.recordingUrl = URL.createObjectURL(state.recordingBlob);
    elements.downloadAudioButton.hidden = false;
    elements.recordButton.hidden = false;
    elements.stopRecordButton.hidden = true;
    await stopMicrophone({ preserveSummary: true, silent: true });
    if (!sampleRate || !samples.length) throw new Error("No Web Audio PCM was captured; the encoded download cannot substitute a different measurement path.");
    const bounded = selectBoundedAnalysisWindow(samples, sampleRate);
    const sourceDurationSeconds = (pcmDiagnostics.sessionAccumulator?.sampleCount || samples.length) / sampleRate;
    const analysisStartSeconds = Math.max(0, sourceDurationSeconds - bounded.samples.length / sampleRate);
    const result = await requestAnalysis("analyze-recording", bounded.samples, sampleRate, {
      ...recordingOptions,
      sourceDurationSeconds,
      analysisStartSeconds,
      analysisTruncated: bounded.analysisTruncated || analysisStartSeconds > 0,
      pcmDiagnostics,
    });
    if (state.recordingAnalysisGeneration !== state.analysisGeneration) return;
    state.latestResult = result;
    renderResult(elements.recordResult, result);
    renderAdvanced(result);
    const windowNote = result.analysisTruncated ? ` The final ${formatDuration(result.durationSeconds)} of ${formatDuration(result.sourceDurationSeconds)} was analyzed.` : "";
    elements.recordStatus.textContent = `${interrupted ? `${reason || "Recording interrupted"}. ` : ""}Original captured PCM analyzed locally.${windowNote}${result.captureEvents?.length ? " Only the final contiguous captured segment is analyzed; interruption boundaries are in the diagnostic bundle." : ""} The download is separately encoded by the browser and may differ slightly.`;
  } catch (error) {
    if (state.recordingAnalysisGeneration !== state.analysisGeneration) return;
    elements.recordStatus.textContent = `Recording could not be analyzed: ${error.message}`;
    state.recording = false;
    state.recorder = null;
    await stopMicrophone({ preserveSummary: true, silent: true });
  } finally {
    state.recordingPcm = null;
    elements.recordButton.hidden = false;
    elements.stopRecordButton.hidden = true;
    elements.stopRecordButton.disabled = false;
    state.finalizingRecording = false;
  }
}


async function loadAudioFile(file) {
  if (!file) return;
  if (state.listening) await stopMicrophone({ preserveSummary: true, silent: true });
  releaseRecordingObject();
  clearAnalysisResults({ resetStatuses: false });
  const analysisGeneration = state.analysisGeneration;
  elements.fileName.textContent = file.name;
  state.inputRoute = `file:${file.name}`;
  state.inputRouteLabel = "Uploaded file";
  state.constraintSettings = null;
  selectCalibration();
  if (file.size > MAX_FILE_BYTES) {
    elements.uploadStatus.textContent = "This file is larger than the 40 MB phone-safe local-analysis limit.";
    return;
  }
  const likelyWav = /(?:audio\/(?:wav|wave|x-wav))/.test(file.type || "") || /\.wav$/i.test(file.name || "");
  if (!likelyWav && file.size > MAX_COMPRESSED_FILE_BYTES) {
    elements.uploadStatus.textContent = "Compressed audio is limited to 12 MB before any file buffer or decoder is opened on mobile.";
    return;
  }
  elements.uploadStatus.textContent = "Decoding and analyzing locally…";
  let audioContext = null;
  try {
    const encoded = await file.arrayBuffer();
    const wavTail = decodePcmWavTail(encoded);
    let bounded;
    let sampleRate;
    if (wavTail) {
      bounded = wavTail;
      sampleRate = wavTail.sampleRate;
    } else {
      const preflight = await preflightCompressedUpload(file, encoded, readCompressedDuration);
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      try { audioContext = new AudioContextClass({ sampleRate: preflight.sampleRate }); }
      catch { audioContext = new AudioContextClass(); }
      const decoded = await audioContext.decodeAudioData(encoded);
      if (decoded.duration > preflight.durationSeconds + 1 || decoded.numberOfChannels > preflight.channels || decoded.sampleRate > preflight.sampleRate) throw new Error("Decoded audio exceeded its verified preflight layout and was discarded.");
      bounded = selectBoundedAnalysisWindow(mixToMono(decoded), decoded.sampleRate);
      bounded.acquisition = { decoder: "browser-decodeAudioData", channelCount: decoded.numberOfChannels,
        channelMix: "arithmetic-mean", declaredSampleRate: preflight.sampleRate, decodedSampleRate: decoded.sampleRate,
        resampled: preflight.sampleRate !== decoded.sampleRate };
      sampleRate = decoded.sampleRate;
    }
    const { samples: uploadSamples, ...windowMetadata } = bounded;
    const uploadOptions = currentOptions("uploaded-file", file.name, windowMetadata);
    uploadOptions.acquisition = { ...windowMetadata.acquisition,
      browser: browserDiagnosticInfo(navigator, { secureContext: window.isSecureContext, standalone: isStandalone() }) };
    const result = await requestAnalysis("analyze-recording", uploadSamples, sampleRate, uploadOptions);
    if (analysisGeneration !== state.analysisGeneration) return;
    state.latestResult = result;
    renderResult(elements.uploadResult, result);
    renderAdvanced(result);
    const windowNote = result.analysisTruncated ? ` Analyzed the final ${formatDuration(result.durationSeconds)} of ${formatDuration(result.sourceDurationSeconds)}.` : ` Analyzed ${formatDuration(result.durationSeconds)}.`;
    const decodeNote = wavTail ? "PCM WAV was decoded directly from the bounded analysis tail." : "Compressed duration, sample rate, channels, and peak simultaneous-memory estimate passed preflight before browser decoding.";
    elements.uploadStatus.textContent = `${windowNote} ${result.sampleRate} Hz. ${decodeNote} No audio left this device.`;
  } catch (error) {
    if (analysisGeneration !== state.analysisGeneration) return;
    clearAnalysisResults({ resetStatuses: false });
    elements.fileName.textContent = file.name;
    elements.uploadStatus.textContent = `Unsupported or failed audio decode: ${error.message}`;
  } finally {
    await closeAudioContext(audioContext);
  }
}

function readCompressedDuration(file, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const audio = document.createElement("audio");
    const url = URL.createObjectURL(file);
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(url);
      callback(value);
    };
    const timeoutId = window.setTimeout(() => finish(reject, new Error("Compressed-audio metadata inspection timed out before decoding.")), timeoutMs);
    audio.preload = "metadata";
    audio.addEventListener("loadedmetadata", () => finish(Number.isFinite(audio.duration) && audio.duration > 0 ? resolve : reject, Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : new Error("Compressed-audio duration is unavailable.")), { once: true });
    audio.addEventListener("error", () => finish(reject, new Error("Compressed-audio metadata could not be inspected safely.")), { once: true });
    audio.src = url;
  });
}


function resultMarkup(result) {
  const quality = result.reliable ? `${result.confidence} confidence` : result.qualityDetail;
  return `
    <div class="result-heading"><strong>${escapeHtml(result.classification)}</strong><span>Measured β ${formatNumber(result.beta)}</span></div>
    <p class="view-lede">${escapeHtml(quality)}</p>
    <div class="result-grid">
      <div><span>Measured β mean ± SD</span><strong>${formatNumber(result.temporalBetaMean ?? result.beta)} ± ${formatNumber(result.temporalBetaSd)}</strong></div>
      <div><span>Nearest canonical target β</span><strong>${formatNumber(result.canonicalBeta)}</strong></div>
      ${result.correctedEstimate ? `<div><span>Calibration-derived β (not raw)</span><strong>${formatNumber(result.correctedEstimate.beta)}</strong></div>` : ""}
      <div><span>Fit residual</span><strong>${formatNumber(result.rmseDb, 2, " dB")}</strong></div>
      <div><span>R²</span><strong>${formatNumber(result.r2, 3)}</strong></div>
      <div><span>Raw flatness</span><strong>${formatNumber(result.spectralFlatness, 3)}</strong></div>
      <div><span>Slope-normalized flatness</span><strong>${formatNumber(result.slopeNormalizedFlatness, 3)}</strong></div>
      <div><span>Duration</span><strong>${formatDuration(result.durationSeconds)}</strong></div>
      ${result.analysisTruncated ? `<div><span>Source duration</span><strong>${formatDuration(result.sourceDurationSeconds)} · final window</strong></div>` : ""}
      <div><span>Sample rate</span><strong>${escapeHtml(result.sampleRate)} Hz</strong></div>
      <div><span>Calibration</span><strong>${escapeHtml(result.calibrationProfile || "Uncorrected")}</strong></div>
      <div><span>Engine</span><strong>v${escapeHtml(result.analysisEngineVersion)}</strong></div>
    </div>
    <div class="result-actions"><button type="button" data-action="save">Save to History</button><button type="button" data-action="json">Export JSON</button><button type="button" data-action="diagnostic">Export diagnostic bundle</button><button type="button" data-action="csv">Export CSV</button><button type="button" data-action="advanced">View scientific details</button></div>`;
}

function renderResult(container, result) {
  container.hidden = false;
  container.innerHTML = resultMarkup(result);
  container.querySelector('[data-action="save"]').addEventListener("click", async () => {
    await saveMeasurement(result);
    const button = container.querySelector('[data-action="save"]');
    button.textContent = "Saved locally";
    button.disabled = true;
  });
  container.querySelector('[data-action="json"]').addEventListener("click", () => exportJson(result));
  container.querySelector('[data-action="diagnostic"]').addEventListener("click", () => exportDiagnostic(result));
  container.querySelector('[data-action="csv"]').addEventListener("click", () => exportCsv(result));
  container.querySelector('[data-action="advanced"]').addEventListener("click", () => { state.latestResult = result; setView("advanced"); });
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
  download(`noisecolor-${Date.now()}.json`, JSON.stringify(sanitizeMetadata(result), null, 2), "application/json");
}

function exportDiagnostic(result) {
  const isLive = result?.acquisition?.path === "live";
  const bundle = createDiagnosticBundle(result, {
    observations: isLive ? state.observations : result?.temporalBeta,
    session: isLive ? state.sessionAccumulator?.summary(state.observations) || state.lastSummary : result?.sessionSummary,
    interruptionEvents: isLive ? state.interruptionEvents : result?.captureEvents || [],
    startupFailure: result ? null : state.microphoneFailure,
  });
  download(`noisecolor-diagnostic-${bundle.acquisition.path}-${Date.now()}.json`, JSON.stringify(bundle, null, 2), "application/json");
}

function exportCsv(result) {
  result = sanitizeMetadata(result);
  const metadata = [
    ["NoiseColor version", result.appVersion], ["analysis engine", result.analysisEngineVersion], ["timestamp", result.timestamp],
    ["source type", result.sourceType], ["source filename", result.sourceFilename], ["sample rate", result.sampleRate],
    ["duration seconds", result.durationSeconds], ["source duration seconds", result.sourceDurationSeconds], ["analysis start seconds", result.analysisStartSeconds],
    ["analysis truncated", result.analysisTruncated], ["FFT size", result.fftSize], ["Welch overlap", result.welchOverlap],
    ["Welch segments used", result.welchSegments], ["Welch segments available", result.welchAvailableSegments],
    ["fit min Hz", result.fitRange?.[0]], ["fit max Hz", result.fitRange?.[1]], ["analysis mode", result.analysisMode],
    ["analysis window seconds", result.analysisWindowSeconds], ["beta", result.beta], ["raw slope", result.rawSlope],
    ["raw measured beta", result.rawMeasuredBeta], ["calibration-derived beta", result.correctedEstimate?.beta], ["raw measurement basis", result.rawMeasurement?.basis],
    ["PCM diagnostics", result.pcmDiagnostics ? JSON.stringify(result.pcmDiagnostics) : ""],
    ["adjusted breakpoint support octaves", result.abruptBreakpointSupportOctaves], ["adjusted fit minimum basis novelty", result.abruptBreakpointMinimumNovelty],
    ["discarded adjusted breakpoints", JSON.stringify(result.rejectedAdjustedBreakpoints || [])],
    ["R squared", result.r2], ["RMSE dB", result.rmseDb], ["MAE dB", result.maeDb], ["spectral flatness", result.spectralFlatness], ["slope-normalized flatness", result.slopeNormalizedFlatness],
    ["temporal beta mean", result.temporalBetaMean], ["temporal beta SD", result.temporalBetaSd], ["canonical color", result.canonicalColor], ["canonical beta target", result.canonicalBeta],
    ["canonical distance", result.canonicalDistance], ["classification", result.classification], ["confidence", result.confidence],
    ["reliable", result.reliable], ["calibration profile", result.calibrationProfile || "uncorrected"], ["scalar gain context dB", result.scalarGainDb],
    ["calibration details", result.calibration ? JSON.stringify(result.calibration) : ""], ["input route", result.inputRouteLabel],
    ["microphone settings", result.microphoneSettings ? JSON.stringify(result.microphoneSettings) : ""],
    ["peak prominence dB", result.maxPeakProminenceDb], ["tonal power ratio", result.tonalPowerRatio], ["prominent peak count", result.prominentPeakCount], ["persistent peak count", result.persistentPeakCount],
    ["harmonic peak count", result.harmonicPeakCount], ["harmonic evidence", result.harmonicEvidence], ["broadband occupancy", result.broadbandOccupancy], ["prominent peak frequencies Hz", result.prominentPeakFrequencies?.join(" | ")],
    ["low-band beta", result.lowBandBeta], ["high-band beta", result.highBandBeta], ["segmented slope delta", result.segmentedSlopeDelta],
    ["maximum breakpoint slope delta", result.maxBreakpointSlopeDelta], ["strongest breakpoint Hz", result.strongestBreakpointFrequency], ["piecewise fit improvement dB", result.piecewiseImprovementDb],
    ["model adequacy status", result.modelAdequacyStatus], ["model adequacy detail", result.modelAdequacyDetail], ["smooth curvature magnitude dB", result.smoothCurvatureMagnitudeDb], ["smooth curvature RMSE dB", result.smoothCurvatureRmseDb], ["smooth residual RMSE dB", result.smoothResidualRmseDb], ["smooth residual MAD dB", result.smoothResidualMadDb],
    ["abrupt breakpoint slope delta", result.abruptBreakpointSlopeDelta], ["abrupt breakpoint Hz", result.abruptBreakpointFrequency], ["abrupt breakpoint improvement dB", result.abruptBreakpointImprovementDb], ["abrupt breakpoint relative improvement", result.abruptBreakpointRelativeImprovement], ["abrupt breakpoint evidence", result.abruptBreakpointEvidence],
    ["near-clip ratio", result.nearClipRatio], ["plateau ratio", result.plateauRatio], ["crest factor", result.crestFactor], ["amplitude kurtosis", result.amplitudeKurtosis], ["edge density ratio", result.edgeDensityRatio], ["limiting suspected", result.limitingSuspected],
  ];
  const rows = metadata.map(([key, value]) => `# ${key},${JSON.stringify(value ?? "")}`);
  rows.push("", "time_seconds,start_seconds,end_seconds,beta,state,classification,reliable,rmse_db,r_squared,spectral_flatness");
  for (const item of result.temporalBeta || []) rows.push([item.timeSeconds, item.startSeconds, item.endSeconds, item.beta, item.state, JSON.stringify(item.classification), item.reliable, item.rmseDb, item.r2, item.spectralFlatness].join(","));
  rows.push("", "timeline_start_seconds,timeline_end_seconds,state,classification");
  for (const item of result.colorTimeline || []) rows.push([item.startSeconds, item.endSeconds, item.state, JSON.stringify(item.label || "")].join(","));
  download(`noisecolor-${Date.now()}.csv`, rows.join("\n"), "text/csv");
}

async function refreshHistory() {
  try {
    const page = await listMeasurementPage({ offset: state.historyOffset });
    const records = page.records;
    if (!records.length && state.historyOffset > 0) {
      state.historyOffset = Math.max(0, state.historyOffset - HISTORY_PAGE_SIZE);
      await refreshHistory();
      return;
    }
    elements.historyPrevious.disabled = !page.pagination.hasPrevious;
    elements.historyNext.disabled = !page.pagination.hasNext;
    elements.historyPageStatus.textContent = records.length
      ? `Page ${page.pagination.pageNumber} · results ${page.pagination.firstRecord}–${page.pagination.lastRecord}`
      : "Page 1 · no results";
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
    elements.historyPrevious.disabled = true;
    elements.historyNext.disabled = true;
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
  const states = Object.entries(state.betaHistory.reduce((counts, item) => ({ ...counts, [item.state]: (counts[item.state] || 0) + 1 }), {})).map(([name, count]) => `${name} ${count}`).join(", ");
  const betaValues = reliable.map((item) => item.beta);
  elements.betaDataSummary.textContent = state.betaHistory.length
    ? `${state.betaHistory.length} stable-window observations; ${reliable.length} reliable. ${betaValues.length ? `Reliable β range ${Math.min(...betaValues).toFixed(2)} to ${Math.max(...betaValues).toFixed(2)}.` : "No reliable β values."} States: ${states}.`
    : "No β history is available.";
}

function drawSpectrum(result) {
  if (!result?.psd?.frequencies?.length) { drawEmpty(elements.spectrumCanvas, "No spectrum available"); elements.spectrumDataSummary.textContent = result?.historyCompacted ? "This history entry stores compact metadata; detailed PSD arrays were intentionally not retained." : "No spectrum data is available."; return; }
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
  elements.spectrumDataSummary.textContent = `${frequencies.length} PSD bins from ${frequencies[1]?.toFixed(1) || "0"} to ${frequencies.at(-1)?.toFixed(1) || "0"} Hz. β ${formatNumber(result.beta)}, fit residual ${formatNumber(result.rmseDb, 2, " dB")}, low/high-band β ${formatNumber(result.lowBandBeta)} / ${formatNumber(result.highBandBeta)}.`;
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
  elements.spectrumDataSummary.textContent = `${bands.length} third-octave context bands from ${bands[0].center} to ${bands.at(-1).center} Hz. These bands do not drive β classification.`;
}

function drawSpectrogram(spectrogram) {
  if (!spectrogram?.values?.length) { drawEmpty(elements.spectrogramCanvas, "No spectrogram available"); elements.spectrogramDataSummary.textContent = "No spectrogram data is available."; return; }
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
  elements.spectrogramDataSummary.textContent = `${columns} time frames across ${rows} logarithmically spaced frequencies from ${Math.round(spectrogram.frequencies[0])} to ${Math.round(spectrogram.frequencies.at(-1))} Hz; displayed level range ${low.toFixed(1)} to ${high.toFixed(1)} dB relative.`;
}

function renderAdvanced(result) {
  elements.exportDiagnosticButton.disabled = !canExportDiagnostic(result);
  elements.diagnosticExportStatus.textContent = canExportDiagnostic(result)
    ? "Exports this exact measurement's PSD and diagnostics locally. No raw audio, filenames or device identifiers."
    : "Exact PSD unavailable. Analyze again; compact history cannot recreate a diagnostic bundle.";
  drawSpectrum(result);
  drawSpectrogram(result?.spectrogram || state.latestSpectrogram);
  if (!result) {
    elements.diagnosticGrid.innerHTML = '<div><span>Status</span><strong>No measurement</strong></div>';
    return;
  }
  const diagnostics = [
    ["Acquisition", result.acquisition?.path || result.sourceType],
    ["Captured window", result.measurementWindow ? `${result.measurementWindow.startSample}–${result.measurementWindow.endSample} samples · ${result.measurementWindow.job}` : "Not retained"],
    ["Temporal evidence", `${result.qualityContext?.temporalObservationCount ?? "unknown"} observations · ${result.qualityContext?.temporalSelection || "not retained"}`],
    ["Calibration-derived β (not raw)", formatNumber(result.correctedEstimate?.beta)],
    ["Adjusted support", formatNumber(result.abruptBreakpointSupportOctaves, 2, " oct")],
    ["Adjusted basis novelty", formatNumber(result.abruptBreakpointMinimumNovelty, 4)],
    ["Discarded adjusted fits", `${result.rejectedAdjustedBreakpoints?.length || 0}: ${[...new Set((result.rejectedAdjustedBreakpoints || []).map((item) => item.reason))].join(", ") || "none"}`],
    ["Measured β", formatNumber(result.beta)], ["Nearest canonical target β", formatNumber(result.canonicalBeta)], ["R²", formatNumber(result.r2, 3)], ["RMSE", formatNumber(result.rmseDb, 2, " dB")], ["MAE", formatNumber(result.maeDb, 2, " dB")],
    ["Raw flatness", formatNumber(result.spectralFlatness, 3)], ["Slope-normalized flatness", formatNumber(result.slopeNormalizedFlatness, 3)], ["Broadband occupancy", formatNumber(result.broadbandOccupancy * 100, 0, "%")], ["Level", formatNumber(result.dbfs, 1, " dBFS")], ["Clipping", formatNumber(result.clippingRatio * 100, 3, "%")], ["Near clip", formatNumber(result.nearClipRatio * 100, 2, "%")],
    ["Crest factor", formatNumber(result.crestFactor, 2)], ["Amplitude kurtosis", formatNumber(result.amplitudeKurtosis, 2)], ["Edge density", formatNumber(result.edgeDensityRatio * 100, 1, "%")], ["Peak prominence", formatNumber(result.maxPeakProminenceDb, 1, " dB")], ["Tonal power", formatNumber(result.tonalPowerRatio * 100, 1, "%")], ["Prominent peaks", `${result.prominentPeakCount || 0}`], ["Persistent peaks", `${result.persistentPeakCount || 0}`], ["Harmonic matches", `${result.harmonicPeakCount || 0}`], ["Harmonic evidence", formatNumber(result.harmonicEvidence, 2)],
    ["Model adequacy", result.modelAdequacyStatus || "not evaluated"], ["Smooth curvature", formatNumber(result.smoothCurvatureMagnitudeDb, 1, " dB")], ["Smooth residual", formatNumber(result.smoothResidualRmseDb, 2, " dB")], ["Abrupt breakpoint Δβ", formatNumber(result.abruptBreakpointSlopeDelta, 2)], ["Abrupt breakpoint", formatNumber(result.abruptBreakpointFrequency, 0, " Hz")], ["Abrupt improvement", formatNumber(result.abruptBreakpointImprovementDb, 2, " dB")], ["Abrupt evidence", formatNumber(result.abruptBreakpointEvidence, 2)], ["Unadjusted breakpoint Δβ", formatNumber(result.maxBreakpointSlopeDelta, 2)],
    ["Fit range", `${result.fitRange?.[0]}–${Math.round(result.fitRange?.[1] || 0)} Hz`],
    ["Sample rate", `${result.sampleRate} Hz`], ["Welch", `${result.fftSize} FFT · ${result.welchOverlap * 100}% overlap`], ["Correction", result.calibrationProfile || "Uncorrected"], ["Engine", `v${result.analysisEngineVersion}`],
  ];
  for (const [stage, metric] of Object.entries(result.pcmDiagnostics || {})) {
    if (!metric || !Number.isFinite(metric.sampleCount)) continue;
    diagnostics.push([`PCM ${stage}`, `${formatNumber(metric.dbfs, 2, " dBFS")} · RMS ${formatNumber(metric.rms, 5)} · peak ${formatNumber(metric.peak, 5)} · n=${metric.sampleCount} · nonzero ${formatNumber(metric.nonzeroRatio * 100, 1, "%")}`]);
  }
  elements.diagnosticGrid.innerHTML = diagnostics.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
  elements.measuredCopy.textContent = `Measured β ${formatNumber(result.beta)}; nearest canonical target β ${formatNumber(result.canonicalBeta)}. Residual ${formatNumber(result.rmseDb, 2, " dB")}, R² ${formatNumber(result.r2, 3)}, slope-normalized flatness ${formatNumber(result.slopeNormalizedFlatness, 3)}. ${result.modelAdequacyDetail || ""}`;
  elements.interpretationCopy.textContent = result.qualityDetail;
  elements.spectrumNote.textContent = `Original, uncorrected continuous PSD. Raw β is fitted from ${result.fitRange[0]}–${Math.round(result.fitRange[1])} Hz without A weighting, curvature removal, or third-octave aggregation.${result.correctedEstimate ? ` Calibration-derived β ${formatNumber(result.correctedEstimate.beta)} is a separate diagnostic, not the measured trend or classification input.` : ""}`;
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
  else if (state.activeCalibration.routeId !== state.inputRoute) elements.calibrationState.textContent = `Not applied: profile does not match ${state.inputRouteLabel || "the current source"}`;
  else elements.calibrationState.textContent = `${state.activeCalibration.name}: separate corrected estimate; raw β is unchanged`;
}

function updateMicrophoneFailureView() {
  const failure = state.microphoneFailure;
  elements.microphoneFailure.hidden = !failure || !["live", "record"].includes(state.currentView);
  // The recovery card replaces the giant classification placeholder, not navigation.
  elements.classification.closest(".classification-card").hidden = isIosStandaloneDenial(failure);
}

function clearMicrophoneFailure() {
  state.microphoneFailure = null;
  elements.safariFallback.hidden = true;
  elements.safariLinkStatus.textContent = "";
  updateMicrophoneFailureView();
}

function presentMicrophoneFailure(error, mode) {
  if (isMicrophoneStartupCancellation(error) || isMicrophoneStartupConflict(error)) return;
  state.microphoneFailure ||= microphoneStartupFailure(error, { ...microphoneEnvironment(window, navigator), acquisitionMode: mode, stage: "startup" });
  const iosBlocked = isIosStandaloneDenial(state.microphoneFailure);
  const title = iosBlocked ? "MICROPHONE BLOCKED BY iOS" : "Microphone unavailable";
  const detail = iosBlocked
    ? "NoiseColor can use your microphone in Safari, but iOS is preventing microphone access in this installed web-app session."
    : state.microphoneFailure.errorMessage;
  clearStaleMeasurement(title, "unavailable", detail);
  elements.microphoneFailureTitle.textContent = title;
  elements.microphoneFailureText.textContent = detail;
  elements.iosMicrophoneActions.hidden = !iosBlocked;
  if (mode === "recording") elements.recordStatus.textContent = detail;
  const canonicalUrl = canonicalAppUrl(location.href);
  elements.safariCanonicalLink.href = canonicalUrl;
  elements.safariCanonicalLink.textContent = canonicalUrl;
  updateMicrophoneFailureView();
  elements.microphoneFailureTitle.focus();
}

function showInstallSheet(platform = platformInstallHint(), { reinstall = false } = {}) {
  elements.installSheet.hidden = false;
  elements.appShell.inert = true;
  if (platform === "ios") {
    elements.installInstructions.innerHTML = `<p>For reliable microphone access on iPhone, install NoiseColor as a Safari Home Screen shortcut. Apple’s standalone web-app mode may block microphone access on some iOS versions/devices.</p>
      <h3>Recommended for Live/Record</h3><p><strong>Home Screen Safari shortcut — microphone-compatible.</strong> Use this option on iPhone and iPad.</p>
      <ol>${reinstall ? "<li>Remove the existing NoiseColor Home Screen web app.</li>" : ""}<li>Open NoiseColor in Safari.</li><li>Confirm Live Analysis works and allow microphone access.</li><li>Safari → Share → <strong>Add to Home Screen</strong>.</li><li>Turn <strong>Open as Web App OFF</strong>.</li><li>Tap <strong>Add</strong>.</li></ol>
      ${reinstall ? "<p>Export any results you need before removal. The shortcut opens Safari’s storage, which may differ from the standalone app’s History.</p>" : ""}
      <p>If that switch is not offered on your iOS version, use NoiseColor directly in Safari for microphone capture.</p>
      <h3>Standalone web app</h3><p>More app-like presentation, but microphone capture may fail on affected iOS/WebKit versions. This is not the recommended installation for Live/Record.</p>`;
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
  onInstalled: () => { elements.installButton.textContent = isIosDevice() ? "Install help" : "Installed"; elements.installButton.disabled = !isIosDevice(); },
  onUpdateAvailable: (activate) => { elements.updateBanner.hidden = false; elements.reloadButton.onclick = activate; },
  onError: (error) => console.warn("Service worker registration failed", error),
});

document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
function activateAdvancedTab(button, { focus = false } = {}) {
  const view = button.dataset.advanced;
  document.querySelectorAll("[data-advanced]").forEach((tab) => {
    const active = tab.dataset.advanced === view;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll("[data-advanced-panel]").forEach((panel) => { const active = panel.dataset.advancedPanel === view; panel.hidden = !active; panel.classList.toggle("active", active); });
  if (focus) button.focus();
  if (view === "spectrogram") runSpectrogram();
}
document.querySelectorAll("[data-advanced]").forEach((button) => {
  button.addEventListener("click", () => activateAdvancedTab(button));
  button.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll("[data-advanced]")];
    const current = tabs.indexOf(button);
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    activateAdvancedTab(tabs[next], { focus: true });
  });
});
document.querySelectorAll("[data-spectrum]").forEach((button) => button.addEventListener("click", () => {
  state.activeSpectrum = button.dataset.spectrum;
  document.querySelectorAll("[data-spectrum]").forEach((item) => item.classList.toggle("active", item === button));
  drawSpectrum(state.latestResult);
}));

async function startLiveAnalysis() {
  try { await startMicrophone(); } catch (error) {
    if (isMicrophoneStartupCancellation(error)) return;
    if (!isMicrophoneStartupConflict(error)) await stopMicrophone({ preserveSummary: true, silent: true });
    presentMicrophoneFailure(error, "live");
  }
}
elements.startLiveButton.addEventListener("click", startLiveAnalysis);
elements.retryMicrophoneButton.addEventListener("click", () => {
  const recording = state.microphoneFailure?.acquisitionMode === "recording";
  setView(recording ? "record" : "live");
  if (recording) startRecording(); else startLiveAnalysis();
});
elements.openSafariButton.addEventListener("click", () => {
  openSafariFromGesture(window, location.href);
  elements.safariFallback.hidden = false;
});
elements.copySafariLinkButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(canonicalAppUrl(location.href));
    elements.safariLinkStatus.textContent = "Link copied. Open Safari and paste it into the address bar.";
  } catch {
    elements.safariLinkStatus.textContent = "Copy is unavailable. Touch and hold the link above, choose Copy, then paste it into Safari’s address bar.";
  }
});
elements.reinstallMicrophoneButton.addEventListener("click", () => showInstallSheet("ios", { reinstall: true }));
elements.exportStartupDiagnosticButton.addEventListener("click", () => state.microphoneFailure && exportDiagnostic(null));
elements.clearButton.addEventListener("click", resetApplication);
elements.stopLiveButton.addEventListener("click", () => stopMicrophone());
elements.analysisMode.addEventListener("change", () => {
  elements.windowValue.textContent = `${modeConfig().stableSeconds} sec`;
  if (state.listening && !state.recording) {
    state.captureGeneration += 1; // ignore in-flight results from the prior mode
    stateMachine.reset();
    startSchedulers();
  }
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
elements.clearHistoryButton.addEventListener("click", async () => { if (window.confirm("Delete all locally saved NoiseColor results?")) { await clearMeasurements(); state.historyOffset = 0; refreshHistory(); } });
elements.historyPrevious.addEventListener("click", () => { state.historyOffset = Math.max(0, state.historyOffset - HISTORY_PAGE_SIZE); refreshHistory(); });
elements.historyNext.addEventListener("click", () => { state.historyOffset += HISTORY_PAGE_SIZE; refreshHistory(); });
elements.saveSummaryButton.addEventListener("click", async () => { if (state.lastSummary) { await saveMeasurement(state.lastSummary); elements.saveSummaryButton.textContent = "Saved locally"; elements.saveSummaryButton.disabled = true; } });
elements.exportSummaryButton.addEventListener("click", () => state.lastSummary && exportJson(state.lastSummary));
elements.exportSummaryCsvButton.addEventListener("click", () => state.lastSummary && exportCsv(state.lastSummary));
elements.exportLiveDiagnosticButton.addEventListener("click", () => state.liveDiagnosticResult && exportDiagnostic(state.liveDiagnosticResult));
elements.exportDiagnosticButton.addEventListener("click", () => canExportDiagnostic(state.latestResult) && exportDiagnostic(state.latestResult));
elements.resumeCaptureButton.addEventListener("click", resumeCapture);
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
  if (document.hidden && (state.listening || microphoneStartup.pending)) interruptActiveCapture("Analysis paused while the app was in the background", "paused");
});
navigator.mediaDevices?.addEventListener?.("devicechange", () => {
  if (state.listening || microphoneStartup.pending) interruptActiveCapture("Microphone device changed", "paused");
});
window.addEventListener("pagehide", (event) => interruptActiveCapture("Page closed", "paused", { terminal: !event.persisted }));
window.addEventListener("beforeunload", releaseRecordingObject);

elements.versionLabel.textContent = `NoiseColor v${APP_VERSION} · engine v${ENGINE_VERSION}`;
loadCalibrationProfiles();
drawEmpty(elements.betaCanvas, "Start Live Analysis to see β history");
drawEmpty(elements.spectrumCanvas, "No spectrum available");
drawEmpty(elements.spectrogramCanvas, "No spectrogram available");
displayLiveState(createStatusState("listening", "Listening…", "Start Live Analysis to estimate the current spectral color."));
if (isStandalone()) { elements.installButton.textContent = isIosDevice() ? "Install help" : "Installed"; elements.installButton.disabled = !isIosDevice(); }
else if (new URLSearchParams(location.search).has("install")) showInstallSheet(platformInstallHint());
if (new URLSearchParams(location.search).get("action") === "upload") setView("upload");
if (new URLSearchParams(location.search).get("action") === "live") setView("live");
pwa.register();
