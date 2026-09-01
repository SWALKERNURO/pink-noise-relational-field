export const APP_VERSION = "0.6.1";
export const ENGINE_VERSION = "0.6.1";
export const FFT_SIZE = 4096;
export const WELCH_OVERLAP = 0.5;
export const DEFAULT_FIT_RANGE = [100, 8000];

export const CANONICAL_COLORS = [
  { key: "violet", label: "Violet-like", beta: -2, color: "#a78bfa" },
  { key: "blue", label: "Blue-like", beta: -1, color: "#67e8f9" },
  { key: "white", label: "White-like", beta: 0, color: "#f1f5f9" },
  { key: "pink", label: "Pink-like", beta: 1, color: "#f9a8d4" },
  { key: "brown", label: "Brown/red-like", beta: 2, color: "#fb923c" },
];

export const THIRD_OCTAVE_CENTERS = [
  100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600,
  2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000,
];

export function highestPowerOfTwo(value) {
  return 2 ** Math.floor(Math.log2(Math.max(1, value)));
}

export function fftInPlace(real, imaginary, inverse = false) {
  const length = real.length;
  let j = 0;
  for (let index = 1; index < length; index += 1) {
    let bit = length >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (index < j) {
      [real[index], real[j]] = [real[j], real[index]];
      [imaginary[index], imaginary[j]] = [imaginary[j], imaginary[index]];
    }
  }
  for (let size = 2; size <= length; size <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / size;
    const stepCos = Math.cos(angle);
    const stepSin = Math.sin(angle);
    for (let offset = 0; offset < length; offset += size) {
      let cos = 1;
      let sin = 0;
      for (let index = 0; index < size / 2; index += 1) {
        const evenReal = real[offset + index];
        const evenImaginary = imaginary[offset + index];
        const oddIndex = offset + index + size / 2;
        const oddReal = real[oddIndex] * cos - imaginary[oddIndex] * sin;
        const oddImaginary = real[oddIndex] * sin + imaginary[oddIndex] * cos;
        real[offset + index] = evenReal + oddReal;
        imaginary[offset + index] = evenImaginary + oddImaginary;
        real[oddIndex] = evenReal - oddReal;
        imaginary[oddIndex] = evenImaginary - oddImaginary;
        const nextCos = cos * stepCos - sin * stepSin;
        sin = cos * stepSin + sin * stepCos;
        cos = nextCos;
      }
    }
  }
  if (inverse) {
    for (let index = 0; index < length; index += 1) {
      real[index] /= length;
      imaginary[index] /= length;
    }
  }
}

function hannWindow(size) {
  const window = new Float64Array(size);
  let energy = 0;
  for (let index = 0; index < size; index += 1) {
    const value = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (size - 1));
    window[index] = value;
    energy += value * value;
  }
  return { window, energy };
}

export function welchPSD(samples, sampleRate, requestedSize = FFT_SIZE, overlap = WELCH_OVERLAP, maxSegments = Infinity) {
  const available = highestPowerOfTwo(samples.length);
  const normalizedRequest = Number.isFinite(requestedSize)
    ? highestPowerOfTwo(Math.floor(requestedSize))
    : FFT_SIZE;
  const size = Math.max(256, Math.min(normalizedRequest, available));
  if (samples.length < 256 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return { frequencies: new Float64Array(), power: new Float64Array(), segments: 0, availableSegments: 0, fftSize: size };
  }
  const step = Math.max(1, Math.round(size * (1 - overlap)));
  const bins = size / 2 + 1;
  const accumulated = new Float64Array(bins);
  const { window, energy } = hannWindow(size);
  const availableSegments = Math.floor((samples.length - size) / step) + 1;
  const segmentLimit = Number.isFinite(maxSegments) ? Math.max(1, Math.floor(maxSegments)) : availableSegments;
  const segments = Math.min(availableSegments, segmentLimit);
  const starts = Array.from({ length: segments }, (_, index) => {
    if (segments === 1) return Math.floor((availableSegments - 1) / 2) * step;
    return Math.round((index * (availableSegments - 1)) / (segments - 1)) * step;
  });

  for (const start of starts) {
    const real = new Float64Array(size);
    const imaginary = new Float64Array(size);
    let mean = 0;
    for (let index = 0; index < size; index += 1) mean += samples[start + index];
    mean /= size;
    for (let index = 0; index < size; index += 1) real[index] = (samples[start + index] - mean) * window[index];
    fftInPlace(real, imaginary);
    for (let bin = 0; bin < bins; bin += 1) {
      let value = (real[bin] ** 2 + imaginary[bin] ** 2) / (sampleRate * energy);
      if (bin > 0 && bin < size / 2) value *= 2;
      accumulated[bin] += value;
    }
  }

  const frequencies = new Float64Array(bins);
  const power = new Float64Array(bins);
  for (let bin = 0; bin < bins; bin += 1) {
    frequencies[bin] = (bin * sampleRate) / size;
    power[bin] = Math.max(accumulated[bin] / Math.max(1, segments), Number.MIN_VALUE);
  }
  return { frequencies, power, segments, availableSegments, fftSize: size };
}

function correctionAt(frequency, profile) {
  const points = profile?.points;
  if (!Array.isArray(points) || points.length === 0) return 0;
  const sorted = points
    .map((point) => ({ frequency: Number(point.frequency), correctionDb: Number(point.correctionDb) }))
    .filter((point) => Number.isFinite(point.frequency) && point.frequency > 0 && Number.isFinite(point.correctionDb))
    .sort((a, b) => a.frequency - b.frequency);
  if (!sorted.length) return 0;
  if (frequency <= sorted[0].frequency) return sorted[0].correctionDb;
  if (frequency >= sorted.at(-1).frequency) return sorted.at(-1).correctionDb;
  for (let index = 1; index < sorted.length; index += 1) {
    if (frequency <= sorted[index].frequency) {
      const left = sorted[index - 1];
      const right = sorted[index];
      const amount = (Math.log(frequency) - Math.log(left.frequency)) / (Math.log(right.frequency) - Math.log(left.frequency));
      return left.correctionDb + amount * (right.correctionDb - left.correctionDb);
    }
  }
  return 0;
}

export function applyFrequencyResponseCorrection(psd, profile) {
  if (!profile?.points?.length) return { ...psd, corrected: false, calibrationProfile: null };
  const power = Float64Array.from(psd.power, (value, index) => (
    value * 10 ** (correctionAt(psd.frequencies[index], profile) / 10)
  ));
  return { ...psd, power, corrected: true, calibrationProfile: profile.name || "Unnamed profile" };
}

export function fitPowerLaw(frequencies, power, minFrequency, maxFrequency) {
  const xs = [];
  const ys = [];
  for (let index = 1; index < frequencies.length; index += 1) {
    const frequency = frequencies[index];
    const value = power[index];
    if (frequency >= minFrequency && frequency <= maxFrequency && value > 0 && Number.isFinite(value)) {
      xs.push(Math.log10(frequency));
      ys.push(Math.log10(value));
    }
  }
  if (xs.length < 8) {
    return { beta: Number.NaN, slope: Number.NaN, intercept: Number.NaN, r2: 0, rmseDb: Infinity, maeDb: Infinity, pointsUsed: xs.length };
  }
  const count = xs.length;
  const meanX = xs.reduce((sum, value) => sum + value, 0) / count;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / count;
  let covariance = 0;
  let varianceX = 0;
  let totalVariance = 0;
  for (let index = 0; index < count; index += 1) {
    const dx = xs[index] - meanX;
    const dy = ys[index] - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    totalVariance += dy * dy;
  }
  const slope = covariance / varianceX;
  const intercept = meanY - slope * meanX;
  let squaredError = 0;
  let absoluteErrorDb = 0;
  for (let index = 0; index < count; index += 1) {
    const residual = ys[index] - (intercept + slope * xs[index]);
    squaredError += residual * residual;
    absoluteErrorDb += Math.abs(10 * residual);
  }
  return {
    beta: -slope,
    slope,
    intercept,
    r2: totalVariance > 0 ? Math.max(0, Math.min(1, 1 - squaredError / totalVariance)) : 0,
    rmseDb: 10 * Math.sqrt(squaredError / count),
    maeDb: absoluteErrorDb / count,
    pointsUsed: count,
  };
}

function median(values) {
  if (!values.length) return Number.NaN;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function regressPoints(xs, ys) {
  if (xs.length < 4 || xs.length !== ys.length) return { beta: Number.NaN, rmseDb: Infinity };
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  let covariance = 0;
  let varianceX = 0;
  for (let index = 0; index < xs.length; index += 1) {
    covariance += (xs[index] - meanX) * (ys[index] - meanY);
    varianceX += (xs[index] - meanX) ** 2;
  }
  if (!varianceX) return { beta: Number.NaN, rmseDb: Infinity };
  const slope = covariance / varianceX;
  const intercept = meanY - slope * meanX;
  const squaredError = ys.reduce((sum, value, index) => sum + (value - (intercept + slope * xs[index])) ** 2, 0);
  return { beta: -slope, slope, intercept, rmseDb: 10 * Math.sqrt(squaredError / xs.length) };
}

export function modelAdequacyDiagnostics(frequencies, power, minFrequency, maxFrequency, binCount = 24) {
  const logMin = Math.log10(minFrequency);
  const logMax = Math.log10(maxFrequency);
  const buckets = Array.from({ length: binCount }, () => []);
  for (let index = 1; index < frequencies.length; index += 1) {
    const frequency = frequencies[index];
    const value = power[index];
    if (frequency < minFrequency || frequency > maxFrequency || !(value > 0) || !Number.isFinite(value)) continue;
    const position = Math.min(binCount - 1, Math.floor(((Math.log10(frequency) - logMin) / (logMax - logMin)) * binCount));
    buckets[position].push(Math.log10(value));
  }
  const points = buckets.flatMap((values, index) => {
    if (!values.length) return [];
    const center = logMin + ((index + 0.5) / binCount) * (logMax - logMin);
    return [{ x: center, y: median(values) }];
  });
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const overall = regressPoints(xs, ys);
  const split = Math.floor(points.length / 2);
  const low = regressPoints(xs.slice(0, split), ys.slice(0, split));
  const high = regressPoints(xs.slice(split), ys.slice(split));
  return {
    logBinCount: points.length,
    logBinnedBeta: overall.beta,
    logBinnedRmseDb: overall.rmseDb,
    lowBandBeta: low.beta,
    highBandBeta: high.beta,
    segmentedSlopeDelta: Number.isFinite(low.beta) && Number.isFinite(high.beta) ? Math.abs(low.beta - high.beta) : Infinity,
  };
}

export function tonalityDiagnostics(frequencies, power, minFrequency, maxFrequency) {
  const indices = [];
  for (let index = 1; index < frequencies.length; index += 1) {
    if (frequencies[index] >= minFrequency && frequencies[index] <= maxFrequency && power[index] > 0 && Number.isFinite(power[index])) indices.push(index);
  }
  if (indices.length < 16) return { maxPeakProminenceDb: 0, tonalPowerRatio: 0, prominentPeakCount: 0 };
  let totalPower = 0;
  let tonalExcess = 0;
  let maxPeakProminenceDb = 0;
  let prominentPeakCount = 0;
  const first = indices[0];
  const last = indices.at(-1);
  for (const index of indices) {
    const value = power[index];
    totalPower += value;
    const neighborhood = [];
    for (let neighbor = Math.max(first, index - 12); neighbor <= Math.min(last, index + 12); neighbor += 1) {
      if (Math.abs(neighbor - index) <= 2) continue;
      neighborhood.push(power[neighbor]);
    }
    const localFloor = median(neighborhood.filter((item) => item > 0 && Number.isFinite(item)));
    if (!(localFloor > 0)) continue;
    const prominenceDb = 10 * Math.log10(value / localFloor);
    maxPeakProminenceDb = Math.max(maxPeakProminenceDb, prominenceDb);
    if (prominenceDb >= 12) prominentPeakCount += 1;
    if (prominenceDb >= 8) tonalExcess += Math.max(0, value - localFloor * 10 ** (8 / 10));
  }
  return {
    maxPeakProminenceDb,
    tonalPowerRatio: totalPower > 0 ? tonalExcess / totalPower : 0,
    prominentPeakCount,
  };
}

export function calculateInputMetrics(samples) {
  if (!samples.length) return { rms: 0, dbfs: -Infinity, peak: 0, clippingRatio: 0, nearClipRatio: 0, plateauRatio: 0, crestFactor: Infinity, limitingSuspected: false, nonFiniteRatio: 0 };
  let sumSquares = 0;
  let peak = 0;
  let clipped = 0;
  let nearClipped = 0;
  let plateauSamples = 0;
  let nonFinite = 0;
  let previous = Number.NaN;
  for (const sample of samples) {
    if (!Number.isFinite(sample)) {
      nonFinite += 1;
      continue;
    }
    const magnitude = Math.abs(sample);
    sumSquares += sample * sample;
    peak = Math.max(peak, magnitude);
    if (magnitude >= 0.99) clipped += 1;
    if (magnitude >= 0.98) nearClipped += 1;
    if (magnitude >= 0.75 && Number.isFinite(previous) && Math.abs(sample - previous) <= 1e-4) plateauSamples += 1;
    previous = sample;
  }
  const finiteCount = samples.length - nonFinite;
  const rms = finiteCount ? Math.sqrt(sumSquares / finiteCount) : Number.NaN;
  const dbfs = 20 * Math.log10(Math.max(rms, 1e-12));
  const crestFactor = rms > 0 ? peak / rms : Infinity;
  const nearClipRatio = finiteCount ? nearClipped / finiteCount : 0;
  const plateauRatio = finiteCount ? plateauSamples / finiteCount : 0;
  return {
    rms,
    dbfs,
    peak,
    clippingRatio: finiteCount ? clipped / finiteCount : 0,
    nearClipRatio,
    plateauRatio,
    crestFactor,
    limitingSuspected: plateauRatio > 0.002 || (dbfs > -4 && crestFactor < 1.35),
    nonFiniteRatio: nonFinite / samples.length,
  };
}

export function spectralFlatness(frequencies, power, minFrequency, maxFrequency) {
  let logSum = 0;
  let linearSum = 0;
  let count = 0;
  for (let index = 1; index < frequencies.length; index += 1) {
    if (frequencies[index] < minFrequency || frequencies[index] > maxFrequency) continue;
    const value = Math.max(power[index], Number.MIN_VALUE);
    logSum += Math.log(value);
    linearSum += value;
    count += 1;
  }
  if (!count || linearSum <= 0) return 0;
  return Math.exp(logSum / count) / (linearSum / count);
}

export function nearestCanonical(beta) {
  if (!Number.isFinite(beta)) return null;
  return CANONICAL_COLORS.reduce((best, candidate) => (
    Math.abs(candidate.beta - beta) < Math.abs(best.beta - beta) ? candidate : best
  ), CANONICAL_COLORS[0]);
}

export function qualityGate({ durationSeconds, input, flatness, fit, tonality = {}, modelAdequacy = {}, temporalSd = 0 }) {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) return { state: "invalid", label: "Invalid audio data", reliable: false, detail: "The sample rate or signal duration is invalid." };
  if (input.nonFiniteRatio > 0 || !Number.isFinite(input.rms)) return { state: "invalid", label: "Invalid audio data", reliable: false, detail: "The decoded signal contains non-finite samples and cannot be analyzed reliably." };
  if (durationSeconds < 1.5) return { state: "insufficient", label: "Keep listening…", reliable: false, detail: "More audio is needed for a stable estimate." };
  if (input.dbfs < -58) return { state: "silence", label: "Signal too low", reliable: false, detail: "Raise the signal level or move closer to the source." };
  if (input.clippingRatio > 0.001 || input.nearClipRatio > 0.01 || input.peak >= 0.9999 || input.limitingSuspected) return { state: "clipping", label: "Clipping / limiting suspected", reliable: false, detail: "The waveform appears clipped or aggressively limited; move farther away or reduce gain if possible." };
  const narrowbandPeak = tonality.maxPeakProminenceDb >= 15 && tonality.tonalPowerRatio >= 0.06;
  const extremePeak = tonality.maxPeakProminenceDb >= 24 && tonality.tonalPowerRatio >= 0.015;
  if (flatness < 0.055 || narrowbandPeak || extremePeak) return { state: "tonal", label: "Tonal / non-noise", reliable: false, detail: "Prominent narrowband energy or harmonics do not behave like broadband colored noise." };
  const inconsistentSlopes = modelAdequacy.segmentedSlopeDelta > 0.75 && modelAdequacy.logBinnedRmseDb > 0.85;
  if (!Number.isFinite(fit.beta) || fit.beta < -2.8 || fit.beta > 2.8 || fit.rmseDb > 5.2 || inconsistentSlopes) {
    return { state: "mixed", label: "Mixed / non-power-law", reliable: false, detail: "One power-law slope does not adequately describe this spectrum." };
  }
  if (temporalSd > 0.55) return { state: "unstable", label: "Spectrally unstable", reliable: false, detail: "The estimated slope is changing too much for one stable color label." };
  const canonical = nearestCanonical(fit.beta);
  const distance = Math.abs(fit.beta - canonical.beta);
  let confidence = "Low";
  if (fit.rmseDb <= 2.2 && distance <= 0.3 && temporalSd <= 0.16) confidence = "High";
  else if (fit.rmseDb <= 3.8 && distance <= 0.55 && temporalSd <= 0.35) confidence = "Moderate";
  return {
    state: canonical.key,
    label: canonical.label,
    canonical,
    distance,
    confidence,
    reliable: true,
    detail: `Nearest canonical slope β = ${canonical.beta}; distance ${distance.toFixed(2)} β.`,
  };
}

export function thirdOctaveBands(psd) {
  const binWidth = psd.frequencies.length > 1 ? psd.frequencies[1] - psd.frequencies[0] : 0;
  return THIRD_OCTAVE_CENTERS.flatMap((center) => {
    const lower = center / 2 ** (1 / 6);
    const upper = center * 2 ** (1 / 6);
    let sum = 0;
    let bins = 0;
    for (let index = 1; index < psd.frequencies.length; index += 1) {
      if (psd.frequencies[index] >= lower && psd.frequencies[index] < upper) {
        sum += psd.power[index] * binWidth;
        bins += 1;
      }
    }
    return bins ? [{ center, power: sum, db: 10 * Math.log10(Math.max(sum, Number.MIN_VALUE)) }] : [];
  });
}

export function summarize(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return { mean: null, sd: null, median: null };
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  const sd = Math.sqrt(finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / finite.length);
  const sorted = [...finite].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { mean, sd, median };
}

function calibrationSnapshot(profile, applied) {
  if (!profile?.points?.length) return null;
  const points = profile.points
    .map((point) => ({ frequency: Number(point.frequency), correctionDb: Number(point.correctionDb) }))
    .filter((point) => Number.isFinite(point.frequency) && point.frequency > 0 && Number.isFinite(point.correctionDb))
    .sort((left, right) => left.frequency - right.frequency);
  const canonical = JSON.stringify(points);
  let hash = 2166136261;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return { name: profile.name || "Unnamed profile", applied, points, correctionHash: `fnv1a32-${(hash >>> 0).toString(16).padStart(8, "0")}` };
}

function sanitizeSettings(settings) {
  if (!settings || typeof settings !== "object") return null;
  return Object.fromEntries(Object.entries(settings).filter(([key]) => !["deviceId", "groupId"].includes(key)));
}

export function analyzeSamples(samples, sampleRate, options = {}) {
  const fitRange = options.fitRange || DEFAULT_FIT_RANGE;
  const maxFrequency = Math.min(fitRange[1], sampleRate * 0.48);
  const rawPsd = welchPSD(samples, sampleRate, options.fftSize || FFT_SIZE, options.overlap ?? WELCH_OVERLAP, options.maxWelchSegments);
  const requestedProfile = options.calibrationProfile;
  const internalRouteKey = options.calibrationRouteKey || options.inputRouteId;
  const calibrationRouteMatched = Boolean(requestedProfile?.routeId && internalRouteKey && requestedProfile.routeId === internalRouteKey);
  const psd = applyFrequencyResponseCorrection(rawPsd, calibrationRouteMatched ? requestedProfile : null);
  const fit = fitPowerLaw(psd.frequencies, psd.power, fitRange[0], maxFrequency);
  const input = calculateInputMetrics(samples);
  const flatness = spectralFlatness(psd.frequencies, psd.power, fitRange[0], maxFrequency);
  const tonality = tonalityDiagnostics(psd.frequencies, psd.power, fitRange[0], maxFrequency);
  const modelAdequacy = modelAdequacyDiagnostics(psd.frequencies, psd.power, fitRange[0], maxFrequency);
  const durationSeconds = samples.length / sampleRate;
  const quality = qualityGate({ durationSeconds, input, flatness, fit, tonality, modelAdequacy, temporalSd: options.temporalSd || 0 });
  return {
    appVersion: APP_VERSION,
    analysisEngineVersion: ENGINE_VERSION,
    timestamp: new Date().toISOString(),
    sourceType: options.sourceType || "live",
    sourceFilename: options.sourceFilename || null,
    sampleRate,
    durationSeconds,
    sourceDurationSeconds: Number.isFinite(options.sourceDurationSeconds) ? options.sourceDurationSeconds : durationSeconds,
    analysisStartSeconds: Number.isFinite(options.analysisStartSeconds) ? options.analysisStartSeconds : 0,
    analysisTruncated: Boolean(options.analysisTruncated),
    fftSize: rawPsd.fftSize,
    welchOverlap: options.overlap ?? WELCH_OVERLAP,
    welchSegments: rawPsd.segments,
    welchAvailableSegments: rawPsd.availableSegments,
    fitRange: [fitRange[0], maxFrequency],
    analysisMode: options.analysisMode || "balanced",
    analysisWindowSeconds: durationSeconds,
    beta: fit.beta,
    rawSlope: fit.slope,
    intercept: fit.intercept,
    r2: fit.r2,
    rmseDb: fit.rmseDb,
    maeDb: fit.maeDb,
    spectralFlatness: flatness,
    rms: input.rms,
    dbfs: input.dbfs,
    peak: input.peak,
    clippingRatio: input.clippingRatio,
    nearClipRatio: input.nearClipRatio,
    plateauRatio: input.plateauRatio,
    crestFactor: input.crestFactor,
    limitingSuspected: input.limitingSuspected,
    nonFiniteRatio: input.nonFiniteRatio,
    maxPeakProminenceDb: tonality.maxPeakProminenceDb,
    tonalPowerRatio: tonality.tonalPowerRatio,
    prominentPeakCount: tonality.prominentPeakCount,
    logBinnedBeta: modelAdequacy.logBinnedBeta,
    logBinnedRmseDb: modelAdequacy.logBinnedRmseDb,
    lowBandBeta: modelAdequacy.lowBandBeta,
    highBandBeta: modelAdequacy.highBandBeta,
    segmentedSlopeDelta: modelAdequacy.segmentedSlopeDelta,
    classification: quality.label,
    state: quality.state,
    confidence: quality.confidence || "None",
    reliable: quality.reliable,
    qualityDetail: quality.detail,
    canonicalColor: quality.canonical?.label || null,
    canonicalBeta: quality.canonical?.beta ?? null,
    canonicalDistance: quality.distance ?? null,
    calibrationProfile: psd.calibrationProfile,
    calibration: calibrationSnapshot(requestedProfile, psd.corrected),
    calibrationRouteMatched,
    calibrationNotAppliedReason: requestedProfile && !calibrationRouteMatched ? "Calibration profile did not match the active input route." : null,
    corrected: psd.corrected,
    scalarGainDb: Number(options.scalarGainDb) || 0,
    inputRouteLabel: options.inputRouteLabel || null,
    microphoneSettings: sanitizeSettings(options.microphoneSettings),
    psd: {
      frequencies: Array.from(psd.frequencies),
      power: Array.from(psd.power),
    },
    thirdOctave: thirdOctaveBands(psd),
  };
}

export function buildColorTimeline(observations, durationSeconds = observations.at(-1)?.timeSeconds || 0) {
  const duration = Math.max(0, Number(durationSeconds) || 0);
  if (!observations.length) return duration ? [{ state: "insufficient", label: "No reliable observation", startSeconds: 0, endSeconds: duration }] : [];
  const ordered = [...observations].filter((item) => Number.isFinite(item.timeSeconds)).sort((a, b) => a.timeSeconds - b.timeSeconds);
  if (!ordered.length) return duration ? [{ state: "insufficient", label: "No reliable observation", startSeconds: 0, endSeconds: duration }] : [];
  const timeline = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const observation = ordered[index];
    const key = observation.state || "mixed";
    const previous = timeline.at(-1);
    const next = ordered[index + 1];
    const endSeconds = next
      ? Math.min(duration, Math.max(0, (observation.timeSeconds + next.timeSeconds) / 2))
      : duration;
    if (!previous || previous.state !== key) {
      timeline.push({ state: key, label: observation.classification, startSeconds: previous?.endSeconds || 0, endSeconds });
    } else {
      previous.endSeconds = endSeconds;
    }
  }
  return timeline;
}

export function summarizeSession(observations, durationSeconds) {
  const durations = Object.fromEntries([...CANONICAL_COLORS.map((color) => color.key), "mixed", "tonal", "silence", "unstable", "clipping", "insufficient", "invalid"].map((key) => [key, 0]));
  const colorTimeline = buildColorTimeline(observations, durationSeconds);
  for (const segment of colorTimeline) durations[segment.state] = (durations[segment.state] || 0) + Math.max(0, segment.endSeconds - segment.startSeconds);
  const total = Math.max(Number(durationSeconds) || 0, Number.EPSILON);
  const reliable = observations.filter((observation) => observation.reliable && Number.isFinite(observation.beta));
  const betaSummary = summarize(reliable.map((observation) => observation.beta));
  const dominant = CANONICAL_COLORS.reduce((best, color) => durations[color.key] > durations[best.key] ? color : best, CANONICAL_COLORS[0]);
  const rmseSummary = summarize(reliable.map((observation) => observation.rmseDb));
  const r2Summary = summarize(reliable.map((observation) => observation.r2));
  const flatnessSummary = summarize(reliable.map((observation) => observation.spectralFlatness));
  return {
    sessionDurationSeconds: durationSeconds,
    dominantReliableColor: reliable.length ? dominant.label : null,
    percentages: Object.fromEntries(Object.entries(durations).map(([key, value]) => [key, (value / total) * 100])),
    betaMean: betaSummary.mean,
    betaSd: betaSummary.sd,
    betaMedian: betaSummary.median,
    fitRmseMeanDb: rmseSummary.mean,
    fitR2Mean: r2Summary.mean,
    spectralFlatnessMean: flatnessSummary.mean,
    reliablePercentage: Object.entries(durations).filter(([state]) => CANONICAL_COLORS.some((color) => color.key === state)).reduce((sum, [, value]) => sum + value, 0) / total * 100,
    rejectedPercentage: Object.entries(durations).filter(([state]) => !CANONICAL_COLORS.some((color) => color.key === state)).reduce((sum, [, value]) => sum + value, 0) / total * 100,
    temporalBeta: observations.map(({ timeSeconds, startSeconds, endSeconds, beta, state, classification, reliable, rmseDb, r2, spectralFlatness }) => ({ timeSeconds, startSeconds, endSeconds, beta, state, classification, reliable, rmseDb, r2, spectralFlatness })),
    colorTimeline,
  };
}

export function analyzeRecording(samples, sampleRate, options = {}) {
  const overall = analyzeSamples(samples, sampleRate, { ...options, temporalSd: 0 });
  const windowSeconds = Math.min(options.temporalWindowSeconds || 6, overall.durationSeconds);
  const stepSeconds = options.temporalStepSeconds || 2;
  const size = Math.max(1, Math.round(windowSeconds * sampleRate));
  const step = Math.max(1, Math.round(stepSeconds * sampleRate));
  const observations = [];
  if (samples.length >= Math.min(size, Math.round(sampleRate * 1.5))) {
    for (let end = size; end <= samples.length; end += step) {
      const result = analyzeSamples(samples.subarray(end - size, end), sampleRate, { ...options, temporalSd: 0, maxWelchSegments: Math.min(options.maxWelchSegments || 24, 24) });
      observations.push({
        timeSeconds: (end - size / 2) / sampleRate,
        startSeconds: (end - size) / sampleRate,
        endSeconds: end / sampleRate,
        beta: result.beta,
        state: result.state,
        classification: result.classification,
        reliable: result.reliable,
        rmseDb: result.rmseDb,
        r2: result.r2,
        spectralFlatness: result.spectralFlatness,
      });
    }
  }
  const reliableSummary = summarize(observations.filter((item) => item.reliable).map((item) => item.beta));
  let gated = qualityGate({
    durationSeconds: overall.durationSeconds,
    input: { rms: overall.rms, dbfs: overall.dbfs, clippingRatio: overall.clippingRatio, nearClipRatio: overall.nearClipRatio, peak: overall.peak, limitingSuspected: overall.limitingSuspected, nonFiniteRatio: overall.nonFiniteRatio },
    flatness: overall.spectralFlatness,
    fit: { beta: overall.beta, rmseDb: overall.rmseDb },
    tonality: { maxPeakProminenceDb: overall.maxPeakProminenceDb, tonalPowerRatio: overall.tonalPowerRatio },
    modelAdequacy: { segmentedSlopeDelta: overall.segmentedSlopeDelta, logBinnedRmseDb: overall.logBinnedRmseDb },
    temporalSd: reliableSummary.sd || 0,
  });
  const sessionSummary = summarizeSession(observations, overall.durationSeconds);
  if (Number.isFinite(reliableSummary.sd) && reliableSummary.sd > 0.55) {
    gated = { state: "unstable", label: "Spectrally unstable", reliable: false, detail: "The estimated slope changes too much over time for one stable color label." };
  } else if (gated.reliable && sessionSummary.rejectedPercentage >= 20) {
    const rejectedStates = Object.entries(sessionSummary.percentages).filter(([state]) => !CANONICAL_COLORS.some((color) => color.key === state));
    const [state, percentage] = rejectedStates.sort((left, right) => right[1] - left[1])[0] || ["mixed", sessionSummary.rejectedPercentage];
    const labels = { silence: "Intermittent silence", tonal: "Intermittent tonal input", mixed: "Mixed / non-power-law", clipping: "Intermittent clipping", invalid: "Invalid intervals", insufficient: "Insufficient intervals", unstable: "Spectrally unstable" };
    gated = { state, label: labels[state] || "Mixed / unreliable intervals", reliable: false, detail: `${percentage.toFixed(1)}% of analyzed time was ${state}; one reliable color would hide rejected intervals.` };
  }
  return {
    ...overall,
    state: gated.state,
    classification: gated.label,
    reliable: gated.reliable,
    confidence: gated.confidence || "None",
    qualityDetail: gated.detail,
    temporalBetaMean: reliableSummary.mean,
    temporalBetaSd: reliableSummary.sd,
    temporalBetaMedian: reliableSummary.median,
    temporalBeta: observations,
    colorTimeline: buildColorTimeline(observations, overall.durationSeconds),
    sessionSummary,
  };
}

export function buildSpectrogram(samples, sampleRate, options = {}) {
  const fftSize = Math.min(2048, highestPowerOfTwo(samples.length));
  if (fftSize < 256) return { times: [], frequencies: [], values: [] };
  const hop = fftSize / 2;
  const frequencyCount = 56;
  const minFrequency = 80;
  const maxFrequency = Math.min(12000, sampleRate * 0.48);
  const frequencies = Array.from({ length: frequencyCount }, (_, index) => minFrequency * (maxFrequency / minFrequency) ** (index / (frequencyCount - 1)));
  const values = [];
  const times = [];
  const maxFrames = options.maxFrames || 80;
  const totalFrames = Math.max(0, Math.floor((samples.length - fftSize) / hop) + 1);
  const frameStride = Math.max(1, Math.ceil(totalFrames / maxFrames));
  const { window } = hannWindow(fftSize);
  for (let frame = 0; frame < totalFrames; frame += frameStride) {
    const start = frame * hop;
    const real = new Float64Array(fftSize);
    const imaginary = new Float64Array(fftSize);
    for (let index = 0; index < fftSize; index += 1) real[index] = samples[start + index] * window[index];
    fftInPlace(real, imaginary);
    values.push(frequencies.map((frequency) => {
      const bin = Math.max(1, Math.min(fftSize / 2, Math.round((frequency * fftSize) / sampleRate)));
      return 10 * Math.log10(Math.max(real[bin] ** 2 + imaginary[bin] ** 2, Number.MIN_VALUE));
    }));
    times.push((start + fftSize / 2) / sampleRate);
  }
  return { times, frequencies, values };
}
