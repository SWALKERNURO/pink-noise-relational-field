import { fitPowerLaw, spectralFlatness, tonalityDiagnostics, modelAdequacyDiagnostics } from "./analysis-engine.js?v=0.6.8-recovery.1";
import { sanitizeAudioSettings, sanitizeMetadata } from "./privacy.js?v=0.6.8-recovery.1";

export const DIAGNOSTIC_SCHEMA = "noisecolor-diagnostic/1";
const scalar = (value) => value == null || ["number", "boolean", "string"].includes(typeof value);
const pick = (value, keys) => Object.fromEntries(keys.split(" ").map((key) => [key, scalar(value?.[key]) ? value?.[key] ?? null : null]));
const numbers = (value) => Array.isArray(value) ? value.map((v) => typeof v === "number" ? v : null) : [];
const pcmKeys = "sampleCount finiteCount peak rms dbfs nonzeroRatio blocks totalSampleCount";
const fitKeys = "beta slope intercept r2 rmseDb maeDb pointsUsed basis weighting";
const toneKeys = "slopeNormalizedFlatness maxPeakProminenceDb tonalPowerRatio prominentPeakCount persistentPeakCount harmonicPeakCount harmonicEvidence broadbandOccupancy";
const modelKeys = "logBinCount logBinnedBeta logBinnedRmseDb lowBandBeta highBandBeta segmentedSlopeDelta maxBreakpointSlopeDelta strongestBreakpointFrequency piecewiseRmseDb piecewiseImprovementDb piecewiseRelativeImprovement breakpointEvidence breakpointSupportBins smoothCurvatureMagnitudeDb smoothCurvatureRmseDb smoothResidualRmseDb smoothResidualMadDb abruptBreakpointSlopeDelta abruptBreakpointFrequency abruptBreakpointRmseDb abruptBreakpointImprovementDb abruptBreakpointRelativeImprovement abruptBreakpointEvidence abruptBreakpointSupportBins abruptBreakpointSupportOctaves abruptBreakpointEffectiveSupportBins abruptBreakpointMinimumNovelty";
const observationKeys = "timeSeconds startSeconds endSeconds beta state classification reliable rmseDb r2 spectralFlatness";

// No full user-agent string, platform, URL, track label or device identifiers.
export function browserDiagnosticInfo(navigatorLike, context = {}) {
  const ua = String(navigatorLike?.userAgent || "");
  const match = ua.match(/(Edg|Firefox|Chrome|Version)\/(\d+(?:\.\d+)*)/);
  return { family: match ? ({ Edg: "Edge", Version: "Safari" }[match[1]] || match[1]) : "unknown",
    version: match?.[2] || null, secureContext: Boolean(context.secureContext),
    standalone: Boolean(context.standalone) };
}

export function canExportDiagnostic(result) {
  return Boolean(result?.measurement && result?.welchConfiguration && result?.psd && !result.historyCompacted);
}

// Closed schema: never spread a result, options, track, calibration profile,
// session or browser object into the export. This is statistics + PSD, not PCM.
export function createDiagnosticBundle(result, { observations, session, interruptionEvents = [] } = {}) {
  if (!canExportDiagnostic(result)) throw new Error("Exact measurement PSD/configuration unavailable. Analyze again; compact history and session means cannot reconstruct it.");
  const core = result.measurement;
  const model = core.modelAdequacy;
  const temporal = observations ?? result.temporalBeta ?? [];
  const stages = {};
  for (const name of ["captureInput", "workletOutput", "scriptProcessorOutput", "captureSamples", "rollingBuffer", "recordingBuffer", "sessionAccumulator", "activityTimeline", "lastActivityFrame", "workerInput", "analyzerInput"]) {
    if (result.pcmDiagnostics?.[name]) stages[name] = pick(result.pcmDiagnostics[name], pcmKeys);
  }
  const bundle = {
    schema: DIAGNOSTIC_SCHEMA, appVersion: result.appVersion, engineVersion: result.analysisEngineVersion,
    measurementTimestamp: result.timestamp,
    privacy: { localOnly: true, rawAudioIncluded: false, identifiersIncluded: false, filenamesIncluded: false,
      note: "Contains spectrum and measurement metadata; review before sharing. Audio download is separate and opt-in." },
    acquisition: { ...pick(result.acquisition, "path decoder representation fullScale normalization channelCount channelMix declaredSampleRate decodedSampleRate resampled"),
      sampleRate: result.sampleRate, durationSeconds: result.durationSeconds,
      sourceDurationSeconds: result.sourceDurationSeconds, analysisStartSeconds: result.analysisStartSeconds,
      analysisTruncated: result.analysisTruncated,
      window: pick(result.measurementWindow, "startSample endSample sampleCount timeBasis job requestId"),
      browser: pick(result.acquisition?.browser, "family version secureContext standalone"),
      audioContext: pick(result.acquisition?.audioContext, "sampleRate baseLatency outputLatency state"),
      track: pick(result.acquisition?.track, "readyState muted enabled"),
      audioTrackSettings: sanitizeAudioSettings(result.microphoneSettings) },
    configuration: { analysisMode: result.analysisMode, requestedFitRangeHz: numbers(result.requestedFitRange),
      effectiveFitRangeHz: numbers(result.fitRange),
      welch: { ...pick(result.welchConfiguration, "requestedFftSize fftSize overlap hopSamples maxSegments segments availableSegments window windowEnergy detrend scaling selection"),
        segmentStarts: numbers(result.welchConfiguration.segmentStarts), segmentOffsetBasis: "relative-to-measurement-window" } },
    rawMeasurement: { ...pick(result.rawMeasurement, fitKeys), rawMeasuredBeta: result.rawMeasuredBeta,
      rawFlatness: core.rawFlatness, pcm: pick(result.pcm, pcmKeys),
      inputQuality: pick(core.input, "rms dbfs peak clippingRatio nearClipRatio plateauRatio crestFactor amplitudeKurtosis edgeDensityRatio limitingSuspected nonFiniteRatio") },
    diagnostics: {
      tonality: { ...pick(core.tonality, toneKeys), persistentPeakCount: result.persistentPeakCount,
        prominentPeakFrequencies: numbers(core.tonality.prominentPeakFrequencies) },
      smoothAcousticCurvature: pick(result.smoothAcousticCurvature, "magnitudeDb residualRmseDb basis"),
      modelAdequacy: { ...pick(model, modelKeys), status: result.modelAdequacyStatus, detail: result.modelAdequacyDetail,
        rejectedAdjustedBreakpoints: (model?.rejectedAdjustedBreakpoints || []).map((item) => pick(item, "frequency slopeDelta originalSlopeDelta supportBins effectiveSupportBins supportOctaves minimumNovelty reason")),
        originalEvidence: "unadjusted log-balanced hinge; not rawMeasuredBeta",
        conditionedEvidence: "robust smooth-plus-hinge with QR, bandwidth and amplification safeguards" },
    },
    classification: { ...pick(result, "state classification confidence reliable qualityDetail canonicalColor canonicalBeta canonicalDistance"),
      coreWindowDecision: pick(result.coreDecision, "state label confidence reliable detail modelAdequacyStatus modelAdequacyDetail"),
      displaySmoothingApplied: false },
    calibration: { rawMeasurementCorrected: false, auxiliaryEstimateAvailable: Boolean(result.correctedEstimate),
      routeMatched: Boolean(result.calibrationRouteMatched), scalarGainDb: result.scalarGainDb,
      appliedTo: "auxiliary-estimate-only", correctionHash: result.calibration?.correctionHash ?? null,
      points: (result.calibration?.points || []).map((point) => pick(point, "frequency correctionDb")),
      auxiliaryEstimate: result.correctedEstimate ? pick(result.correctedEstimate, fitKeys) : null },
    temporal: { ...pick(result.qualityContext, "temporalSd temporalObservationCount temporalSelection missingTemporalPolicy temporalWindowSeconds temporalStepSeconds temporalMaxWelchSegments observationTimeBasis activityFrameSeconds"),
      historyAvailable: temporal.length > 0, retainedObservationCount: temporal.length,
      previousProminentPeakFrequencies: numbers(result.qualityContext?.previousProminentPeakFrequencies),
      observations: temporal.map((item) => pick(item, observationKeys)),
      sessionAggregates: session ? pick(session, "sessionDurationSeconds observationCount reliableObservationCount betaMean betaSd betaMedian fitRmseMeanDb fitR2Mean reliablePercentage rejectedPercentage") : null },
    psd: { frequenciesHz: numbers(result.psd.frequencies), powersPerHz: numbers(result.psd.power),
      basis: "original-continuous-PSD; no calibration or curvature correction", oneSided: true },
    pcmStages: stages,
    pcmStageSemantics: { captureInput: "cumulative browser-delivered input, not access to physical/pre-browser PCM",
      workletOutput: "last complete worklet packet", scriptProcessorOutput: "last callback",
      captureSamples: "last captured packet", rollingBuffer: "dispatched window",
      recordingBuffer: "dispatched recording", sessionAccumulator: "cumulative captured PCM",
      activityTimeline: "completed 500 ms frames", lastActivityFrame: "last completed activity frame",
      workerInput: "exact dispatched PCM", analyzerInput: "same PCM passed to common analyzer",
      amplitude: "float PCM full scale 1; dBFS = 20 log10(RMS), display floor -240 dBFS; null means non-finite/unavailable" },
    capture: { interruptions: interruptionEvents.map((item) => pick(item, "kind sampleOffset elapsedSeconds recovered")),
      limitation: "A PSD replays spectral measurements, not waveform, physical acoustics or browser processing before capture." },
  };
  return sanitizeMetadata(bundle);
}

// Re-fit an exported PSD without reconstructing or modifying audio. Quality
// decisions still require the exported input/temporal evidence, not PSD alone.
export function replayDiagnosticSpectrum(bundle) {
  if (bundle?.schema !== DIAGNOSTIC_SCHEMA) throw new Error("Unsupported diagnostic schema.");
  const frequencies = bundle.psd?.frequenciesHz;
  const powers = bundle.psd?.powersPerHz;
  const range = bundle.configuration?.effectiveFitRangeHz;
  if (!Array.isArray(frequencies) || frequencies.length < 2 || !Array.isArray(powers) || powers.length !== frequencies.length ||
      !frequencies.every((v, i) => Number.isFinite(v) && v >= 0 && (!i || v > frequencies[i - 1])) ||
      !powers.every((v) => Number.isFinite(v) && v > 0) ||
      !Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite) || range[0] <= 0 || range[1] <= range[0]) throw new Error("Diagnostic PSD is incomplete or non-finite; cannot replay.");
  const fit = fitPowerLaw(frequencies, powers, ...range);
  return { rawFit: fit, rawFlatness: spectralFlatness(frequencies, powers, ...range),
    tonality: tonalityDiagnostics(frequencies, powers, ...range, fit, bundle.temporal.previousProminentPeakFrequencies || []),
    modelAdequacy: modelAdequacyDiagnostics(frequencies, powers, ...range) };
}
