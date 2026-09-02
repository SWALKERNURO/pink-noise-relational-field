export const APP_VERSION = "0.6.8";
export const ENGINE_VERSION = "0.6.8";
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

function hingeRegressPoints(xs, ys, breakpointX) {
  const hinge = xs.map((x) => Math.max(0, x - breakpointX));
  const hingeTrend = regressPoints(xs, hinge);
  if (!Number.isFinite(hingeTrend.slope)) return null;
  const residualizedHinge = hinge.map((value, index) => value - hingeTrend.intercept - hingeTrend.slope * xs[index]);
  const hingeEnergy = residualizedHinge.reduce((sum, value) => sum + value * value, 0);
  if (hingeEnergy <= Number.EPSILON) return null;
  const hingeCoefficient = residualizedHinge.reduce((sum, value, index) => sum + value * ys[index], 0) / hingeEnergy;
  const adjusted = ys.map((value, index) => value - hingeCoefficient * hinge[index]);
  const base = regressPoints(xs, adjusted);
  if (!Number.isFinite(base.slope)) return null;
  const squaredError = ys.reduce((sum, value, index) => {
    const predicted = base.intercept + base.slope * xs[index] + hingeCoefficient * hinge[index];
    return sum + (value - predicted) ** 2;
  }, 0);
  return {
    lowBeta: -base.slope,
    highBeta: -(base.slope + hingeCoefficient),
    slopeDelta: Math.abs(hingeCoefficient),
    squaredError,
    rmseDb: 10 * Math.sqrt(squaredError / xs.length),
  };
}

function solveLinearSystem(matrix, vector) {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) <= 1e-12) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let item = column; item <= size; item += 1) augmented[column][item] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let item = column; item <= size; item += 1) augmented[row][item] -= factor * augmented[column][item];
    }
  }
  return augmented.map((row) => row[size]);
}

function robustBasisRegression(rows, ys, iterations = 5) {
  if (!rows.length || rows.length < rows[0].length + 2 || rows.length !== ys.length) return null;
  const coefficientCount = rows[0].length;
  let weights = new Float64Array(rows.length).fill(1);
  let coefficients = null;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const matrix = Array.from({ length: coefficientCount }, () => new Array(coefficientCount).fill(0));
    const vector = new Array(coefficientCount).fill(0);
    for (let row = 0; row < rows.length; row += 1) {
      for (let left = 0; left < coefficientCount; left += 1) {
        vector[left] += weights[row] * rows[row][left] * ys[row];
        for (let right = 0; right < coefficientCount; right += 1) matrix[left][right] += weights[row] * rows[row][left] * rows[row][right];
      }
    }
    coefficients = solveLinearSystem(matrix, vector);
    if (!coefficients) return null;
    const residuals = ys.map((value, index) => value - rows[index].reduce((sum, basis, item) => sum + basis * coefficients[item], 0));
    const center = median(residuals);
    const scale = 1.4826 * median(residuals.map((value) => Math.abs(value - center)));
    if (!(scale > 1e-9)) break;
    const cutoff = 1.5 * scale;
    weights = Float64Array.from(residuals, (value) => Math.min(1, cutoff / Math.max(Math.abs(value - center), Number.EPSILON)));
  }
  const predictions = rows.map((row) => row.reduce((sum, basis, index) => sum + basis * coefficients[index], 0));
  const residuals = ys.map((value, index) => value - predictions[index]);
  const squaredError = residuals.reduce((sum, value) => sum + value * value, 0);
  const residualCenter = median(residuals);
  return {
    coefficients,
    predictions,
    residuals,
    squaredError,
    rmseDb: 10 * Math.sqrt(squaredError / residuals.length),
    residualMadDb: 10 * 1.4826 * median(residuals.map((value) => Math.abs(value - residualCenter))),
  };
}

export function modelAdequacyDiagnostics(frequencies, power, minFrequency, maxFrequency, binCount = 48) {
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
  const overallSquaredError = Number.isFinite(overall.rmseDb) ? (overall.rmseDb / 10) ** 2 * points.length : Infinity;
  // This robust smooth model is diagnostic only. The canonical beta above still
  // comes from the unchanged continuous-PSD fitPowerLaw estimator.
  const centerX = xs.reduce((sum, value) => sum + value, 0) / Math.max(xs.length, 1);
  const smoothRows = xs.map((x) => {
    const centered = x - centerX;
    return [1, centered, centered ** 2, centered ** 3, centered ** 4, centered ** 5];
  });
  const smoothFit = robustBasisRegression(smoothRows, ys);
  const smoothLinear = smoothFit ? regressPoints(xs, smoothFit.predictions) : null;
  const smoothDeviationsDb = smoothFit && smoothLinear
    ? smoothFit.predictions.map((value, index) => 10 * (value - (smoothLinear.intercept + smoothLinear.slope * xs[index])))
    : [];
  const smoothCurvatureMagnitudeDb = smoothDeviationsDb.length ? Math.max(...smoothDeviationsDb) - Math.min(...smoothDeviationsDb) : Infinity;
  const smoothCurvatureRmseDb = smoothDeviationsDb.length ? Math.sqrt(smoothDeviationsDb.reduce((sum, value) => sum + value * value, 0) / smoothDeviationsDb.length) : Infinity;
  const split = Math.floor(points.length / 2);
  const low = regressPoints(xs.slice(0, split), ys.slice(0, split));
  const high = regressPoints(xs.slice(split), ys.slice(split));
  let strongestBreakpoint = { slopeDelta: 0, frequency: null, piecewiseRmseDb: Infinity, improvementDb: 0, relativeImprovement: 0, evidence: 0, supportBins: 0 };
  // Low-frequency log bins contain far fewer FFT ordinates, so require seven below
  // a candidate while allowing two dense high-frequency bins above an edge break.
  for (let breakpoint = 7; breakpoint <= points.length - 2; breakpoint += 1) {
    const breakpointX = (points[breakpoint - 1].x + points[breakpoint].x) / 2;
    const piecewise = hingeRegressPoints(xs, ys, breakpointX);
    if (!piecewise) continue;
    const improvementDb = overall.rmseDb - piecewise.rmseDb;
    const relativeImprovement = overallSquaredError > 0 ? Math.max(0, 1 - piecewise.squaredError / overallSquaredError) : 0;
    const supportBins = Math.min(breakpoint, points.length - breakpoint);
    const evidence = piecewise.slopeDelta * relativeImprovement * Math.sqrt(supportBins);
    if (evidence > strongestBreakpoint.evidence) {
      strongestBreakpoint = {
        slopeDelta: piecewise.slopeDelta,
        frequency: 10 ** breakpointX,
        piecewiseRmseDb: piecewise.rmseDb,
        improvementDb,
        relativeImprovement,
        evidence,
        supportBins,
      };
    }
  }
  let strongestAbruptBreakpoint = { slopeDelta: 0, frequency: null, rmseDb: Infinity, improvementDb: 0, relativeImprovement: 0, evidence: 0, supportBins: 0 };
  if (smoothFit) {
    // Re-test each hinge after accounting for broad, continuous coloration.
    for (let breakpoint = 7; breakpoint <= points.length - 2; breakpoint += 1) {
      const breakpointX = (points[breakpoint - 1].x + points[breakpoint].x) / 2;
      const rows = xs.map((x) => {
        const centered = x - centerX;
        return [1, centered, centered ** 2, centered ** 3, centered ** 4, centered ** 5, Math.max(0, x - breakpointX)];
      });
      const adjusted = robustBasisRegression(rows, ys);
      if (!adjusted) continue;
      const improvementDb = smoothFit.rmseDb - adjusted.rmseDb;
      const relativeImprovement = smoothFit.squaredError > 0 ? Math.max(0, 1 - adjusted.squaredError / smoothFit.squaredError) : 0;
      const slopeDelta = Math.abs(adjusted.coefficients.at(-1));
      const supportBins = Math.min(breakpoint, points.length - breakpoint);
      const evidence = slopeDelta * relativeImprovement * Math.sqrt(supportBins);
      if (evidence > strongestAbruptBreakpoint.evidence) {
        strongestAbruptBreakpoint = { slopeDelta, frequency: 10 ** breakpointX, rmseDb: adjusted.rmseDb, improvementDb, relativeImprovement, evidence, supportBins };
      }
    }
  }
  return {
    logBinCount: points.length,
    logBinnedBeta: overall.beta,
    logBinnedRmseDb: overall.rmseDb,
    lowBandBeta: low.beta,
    highBandBeta: high.beta,
    segmentedSlopeDelta: Number.isFinite(low.beta) && Number.isFinite(high.beta) ? Math.abs(low.beta - high.beta) : Infinity,
    maxBreakpointSlopeDelta: strongestBreakpoint.slopeDelta,
    strongestBreakpointFrequency: strongestBreakpoint.frequency,
    piecewiseRmseDb: strongestBreakpoint.piecewiseRmseDb,
    piecewiseImprovementDb: strongestBreakpoint.improvementDb,
    piecewiseRelativeImprovement: strongestBreakpoint.relativeImprovement,
    breakpointEvidence: strongestBreakpoint.evidence,
    breakpointSupportBins: strongestBreakpoint.supportBins,
    smoothCurvatureMagnitudeDb,
    smoothCurvatureRmseDb,
    smoothResidualRmseDb: smoothFit?.rmseDb ?? Infinity,
    smoothResidualMadDb: smoothFit?.residualMadDb ?? Infinity,
    abruptBreakpointSlopeDelta: strongestAbruptBreakpoint.slopeDelta,
    abruptBreakpointFrequency: strongestAbruptBreakpoint.frequency,
    abruptBreakpointRmseDb: strongestAbruptBreakpoint.rmseDb,
    abruptBreakpointImprovementDb: strongestAbruptBreakpoint.improvementDb,
    abruptBreakpointRelativeImprovement: strongestAbruptBreakpoint.relativeImprovement,
    abruptBreakpointEvidence: strongestAbruptBreakpoint.evidence,
    abruptBreakpointSupportBins: strongestAbruptBreakpoint.supportBins,
  };
}

export function tonalityDiagnostics(frequencies, power, minFrequency, maxFrequency, fit = null, previousPeakFrequencies = []) {
  const indices = [];
  for (let index = 1; index < frequencies.length; index += 1) {
    if (frequencies[index] >= minFrequency && frequencies[index] <= maxFrequency && power[index] > 0 && Number.isFinite(power[index])) indices.push(index);
  }
  if (indices.length < 16) return { slopeNormalizedFlatness: 0, maxPeakProminenceDb: 0, tonalPowerRatio: 0, prominentPeakCount: 0, persistentPeakCount: 0, harmonicPeakCount: 0, harmonicEvidence: 0, broadbandOccupancy: 0, prominentPeakFrequencies: [] };
  const residual = new Float64Array(power.length);
  let residualLogSum = 0;
  let residualSum = 0;
  for (const index of indices) {
    const frequency = frequencies[index];
    const predicted = Number.isFinite(fit?.intercept) && Number.isFinite(fit?.slope)
      ? 10 ** (fit.intercept + fit.slope * Math.log10(frequency))
      : 1;
    residual[index] = Math.max(power[index] / Math.max(predicted, Number.MIN_VALUE), Number.MIN_VALUE);
    residualLogSum += Math.log(residual[index]);
    residualSum += residual[index];
  }
  const slopeNormalizedFlatness = Math.exp(residualLogSum / indices.length) / (residualSum / indices.length);
  let tonalExcess = 0;
  let maxPeakProminenceDb = 0;
  const first = indices[0];
  const last = indices.at(-1);
  const candidates = [];
  for (const index of indices) {
    const value = residual[index];
    let localMaximum = true;
    for (let neighbor = Math.max(first, index - 2); neighbor <= Math.min(last, index + 2); neighbor += 1) {
      if (neighbor !== index && residual[neighbor] >= value) { localMaximum = false; break; }
    }
    if (!localMaximum) continue;
    const neighborhood = [];
    for (let neighbor = Math.max(first, index - 18); neighbor <= Math.min(last, index + 18); neighbor += 1) {
      if (Math.abs(neighbor - index) <= 3) continue;
      neighborhood.push(residual[neighbor]);
    }
    const localFloor = median(neighborhood.filter((item) => item > 0 && Number.isFinite(item)));
    if (!(localFloor > 0)) continue;
    const prominenceDb = 10 * Math.log10(value / localFloor);
    maxPeakProminenceDb = Math.max(maxPeakProminenceDb, prominenceDb);
    if (prominenceDb >= 10) candidates.push({ index, frequency: frequencies[index], prominenceDb, localFloor });
  }

  const peaks = [];
  for (const candidate of candidates.sort((left, right) => right.prominenceDb - left.prominenceDb)) {
    if (peaks.some((peak) => Math.abs(peak.index - candidate.index) <= 10)) continue;
    peaks.push(candidate);
  }
  peaks.sort((left, right) => left.frequency - right.frequency);
  for (const peak of peaks) {
    const threshold = peak.localFloor * 10 ** (8 / 10);
    let peakExcess = 0;
    for (let index = Math.max(first, peak.index - 2); index <= Math.min(last, peak.index + 2); index += 1) {
      peakExcess += Math.max(0, residual[index] - threshold);
    }
    peak.excessPower = peakExcess;
    tonalExcess += peakExcess;
  }

  const logMin = Math.log10(minFrequency);
  const logMax = Math.log10(maxFrequency);
  const bands = Array.from({ length: 24 }, () => []);
  for (const index of indices) {
    const band = Math.min(bands.length - 1, Math.floor(((Math.log10(frequencies[index]) - logMin) / (logMax - logMin)) * bands.length));
    bands[band].push(residual[index]);
  }
  const bandLevels = bands.filter((values) => values.length).map((values) => median(values));
  const maximumBandLevel = Math.max(...bandLevels);
  const broadbandOccupancy = maximumBandLevel > 0 ? bandLevels.filter((value) => value >= maximumBandLevel / 100).length / bandLevels.length : 0;
  const prominentPeaks = peaks.filter((peak) => peak.prominenceDb >= 15 && peak.excessPower / residualSum >= 0.001);
  const prominentPeakCount = prominentPeaks.length;
  let harmonicPeakCount = 0;
  for (const seedPeak of prominentPeaks) {
    for (let divisor = 1; divisor <= 12; divisor += 1) {
      const fundamentalFrequency = seedPeak.frequency / divisor;
      if (fundamentalFrequency < 40) continue;
      let matched = 0;
      for (const candidate of prominentPeaks) {
        const harmonic = Math.round(candidate.frequency / fundamentalFrequency);
        if (harmonic < 1 || harmonic > 12) continue;
        const tolerance = Math.max(0.018, (2 * (frequencies[1] - frequencies[0])) / candidate.frequency);
        if (Math.abs(candidate.frequency / fundamentalFrequency - harmonic) / harmonic <= tolerance) matched += 1;
      }
      harmonicPeakCount = Math.max(harmonicPeakCount, matched);
    }
  }
  const persistentPeakCount = prominentPeaks.filter((peak) => previousPeakFrequencies.some((frequency) => {
    const toleranceHz = Math.max(12, frequency * 0.02);
    return Math.abs(peak.frequency - frequency) <= toleranceHz;
  })).length;
  return {
    slopeNormalizedFlatness,
    maxPeakProminenceDb,
    tonalPowerRatio: residualSum > 0 ? Math.min(1, tonalExcess / residualSum) : 0,
    prominentPeakCount,
    persistentPeakCount,
    harmonicPeakCount,
    harmonicEvidence: prominentPeakCount ? Math.min(1, harmonicPeakCount / prominentPeakCount) : 0,
    broadbandOccupancy,
    prominentPeakFrequencies: prominentPeaks.map((peak) => peak.frequency),
  };
}

export function calculateInputMetrics(samples) {
  if (!samples.length) return { rms: 0, dbfs: -Infinity, peak: 0, clippingRatio: 0, nearClipRatio: 0, plateauRatio: 0, crestFactor: Infinity, amplitudeKurtosis: null, edgeDensityRatio: 0, limitingSuspected: false, nonFiniteRatio: 0 };
  let sumSquares = 0;
  let sumFourth = 0;
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
    sumFourth += sample ** 4;
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
  const amplitudeKurtosis = finiteCount && rms > 0 ? (sumFourth / finiteCount) / (rms ** 4) : null;
  let edgeSamples = 0;
  if (peak > 0) {
    const edge = peak * 0.9;
    for (const sample of samples) if (Number.isFinite(sample) && Math.abs(sample) >= edge) edgeSamples += 1;
  }
  const edgeDensityRatio = finiteCount ? edgeSamples / finiteCount : 0;
  const smoothSaturation = dbfs > -8 && crestFactor < 1.55 && ((amplitudeKurtosis ?? Infinity) < 1.9 || edgeDensityRatio > 0.08);
  return {
    rms,
    dbfs,
    peak,
    clippingRatio: finiteCount ? clipped / finiteCount : 0,
    nearClipRatio,
    plateauRatio,
    crestFactor,
    amplitudeKurtosis,
    edgeDensityRatio,
    limitingSuspected: plateauRatio > 0.002 || (dbfs > -4 && crestFactor < 1.35) || smoothSaturation,
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

function assessModelAdequacy(fit, tonality, modelAdequacy, temporalSd) {
  const smoothMagnitude = Number(modelAdequacy.smoothCurvatureMagnitudeDb);
  const smoothResidual = Number(modelAdequacy.smoothResidualRmseDb);
  const smoothResidualMad = Number(modelAdequacy.smoothResidualMadDb);
  const abruptDelta = Number(modelAdequacy.abruptBreakpointSlopeDelta);
  const abruptImprovement = Number(modelAdequacy.abruptBreakpointImprovementDb);
  const abruptRelativeImprovement = Number(modelAdequacy.abruptBreakpointRelativeImprovement);
  const abruptEvidence = Number(modelAdequacy.abruptBreakpointEvidence);
  const normalizedFlatness = Number(tonality.slopeNormalizedFlatness);
  const occupancy = Number(tonality.broadbandOccupancy);
  const acousticColoration = fit.rmseDb > 2.2 || smoothMagnitude > 6;
  const strongAbruptBreakpoint = abruptDelta >= 0.6
    && abruptImprovement >= 0.04
    && abruptRelativeImprovement >= 0.35
    && abruptEvidence >= 0.8;
  const subtleAbruptBreakpoint = smoothMagnitude <= 5.5
    && modelAdequacy.maxBreakpointSlopeDelta >= 0.55
    && modelAdequacy.piecewiseImprovementDb >= 0.012
    && modelAdequacy.piecewiseRelativeImprovement >= 0.18
    && modelAdequacy.breakpointEvidence >= 0.2
    && abruptDelta >= 0.35;
  const extremeSmoothCurvature = smoothMagnitude > 22;
  const irregularResidual = smoothResidual > 1.5 && smoothResidualMad > 1.1 && fit.rmseDb > 3.8;
  const inadequateBroadbandSupport = acousticColoration && (normalizedFlatness < 0.18 || occupancy < 0.65);
  const failures = [
    (!Number.isFinite(fit.beta) || fit.beta < -2.8 || fit.beta > 2.8) && "slope outside the supported range",
    fit.rmseDb > 5.8 && "excessive continuous-PSD residual",
    (strongAbruptBreakpoint || subtleAbruptBreakpoint) && "abrupt breakpoint evidence",
    extremeSmoothCurvature && "extreme smooth curvature",
    irregularResidual && "irregular residual after smooth-trend removal",
    inadequateBroadbandSupport && "insufficient broadband support for acoustic-coloration tolerance",
  ].filter(Boolean);
  const breakpointFrequency = Number.isFinite(modelAdequacy.abruptBreakpointFrequency) ? `${Math.round(modelAdequacy.abruptBreakpointFrequency)} Hz` : "none";
  const metrics = `smooth curvature ${Number.isFinite(smoothMagnitude) ? smoothMagnitude.toFixed(1) : "—"} dB, smooth residual ${Number.isFinite(smoothResidual) ? smoothResidual.toFixed(2) : "—"} dB, abrupt Δβ ${Number.isFinite(abruptDelta) ? abruptDelta.toFixed(2) : "—"} at ${breakpointFrequency}, abrupt improvement ${Number.isFinite(abruptImprovement) ? abruptImprovement.toFixed(2) : "—"} dB, occupancy ${Number.isFinite(occupancy) ? `${(occupancy * 100).toFixed(0)}%` : "—"}, temporal SD ${Number.isFinite(temporalSd) ? temporalSd.toFixed(2) : "—"}`;
  if (failures.length) return { passed: false, status: "failed", acousticColoration, detail: `Model adequacy failed: ${failures.join(", ")} (${metrics}).` };
  const status = acousticColoration ? "smooth-acoustic-coloration" : "power-law";
  const interpretation = acousticColoration ? "smooth acoustic coloration accepted" : "single power-law adequate";
  return { passed: true, status, acousticColoration, detail: `Model adequacy passed: ${interpretation} (${metrics}).` };
}

export function qualityGate({ durationSeconds, input, flatness, fit, tonality = {}, modelAdequacy = {}, temporalSd = 0 }) {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) return { state: "invalid", label: "Invalid audio data", reliable: false, detail: "The sample rate or signal duration is invalid." };
  if (input.nonFiniteRatio > 0 || !Number.isFinite(input.rms)) return { state: "invalid", label: "Invalid audio data", reliable: false, detail: "The decoded signal contains non-finite samples and cannot be analyzed reliably." };
  if (durationSeconds < 1.5) return { state: "insufficient", label: "Keep listening…", reliable: false, detail: "More audio is needed for a stable estimate." };
  if (input.dbfs < -58) return { state: "silence", label: "Signal too low", reliable: false, detail: "Raise the signal level or move closer to the source." };
  if (input.clippingRatio > 0.001 || input.nearClipRatio > 0.01 || input.peak >= 0.9999 || input.limitingSuspected) return { state: "clipping", label: "Clipping / limiting suspected", reliable: false, detail: "The waveform appears clipped or aggressively limited; move farther away or reduce gain if possible." };
  const normalizedFlatness = Number.isFinite(tonality.slopeNormalizedFlatness) ? tonality.slopeNormalizedFlatness : flatness;
  const concentratedPeak = tonality.maxPeakProminenceDb >= 18 && tonality.tonalPowerRatio >= 0.3 && normalizedFlatness < 0.72;
  const dominantPeak = tonality.maxPeakProminenceDb >= 22 && tonality.tonalPowerRatio >= 0.15 && normalizedFlatness < 0.9;
  const extremePeak = tonality.maxPeakProminenceDb >= 30 && tonality.tonalPowerRatio >= 0.025;
  const harmonicStructure = tonality.harmonicPeakCount >= 3 && tonality.harmonicEvidence >= 0.55 && tonality.tonalPowerRatio >= 0.02;
  const multipleNarrowPeaks = tonality.prominentPeakCount >= 4 && tonality.tonalPowerRatio >= 0.06 && normalizedFlatness < 0.72;
  const noBroadbandBackground = normalizedFlatness < 0.08 && tonality.broadbandOccupancy < 0.55;
  const tonalReasons = [
    concentratedPeak && "concentrated narrow peak",
    dominantPeak && "dominant narrow peak",
    extremePeak && "extreme peak prominence",
    harmonicStructure && "harmonic spacing",
    multipleNarrowPeaks && "multiple narrow peaks",
    noBroadbandBackground && "insufficient broadband background",
  ].filter(Boolean);
  if (tonalReasons.length) {
    const evidence = `normalized flatness ${normalizedFlatness.toFixed(3)}, peak ${Number(tonality.maxPeakProminenceDb || 0).toFixed(1)} dB, tonal power ${(100 * Number(tonality.tonalPowerRatio || 0)).toFixed(1)}%, peaks ${tonality.prominentPeakCount || 0}, persistent ${tonality.persistentPeakCount || 0}, harmonic matches ${tonality.harmonicPeakCount || 0}`;
    return { state: "tonal", label: "Tonal / non-noise", reliable: false, detail: `Tonal evidence: ${tonalReasons.join(", ")} (${evidence}).` };
  }
  const adequacy = assessModelAdequacy(fit, tonality, modelAdequacy, temporalSd);
  if (!adequacy.passed) return { state: "mixed", label: "Mixed / non-power-law", reliable: false, detail: adequacy.detail, modelAdequacyStatus: adequacy.status, modelAdequacyDetail: adequacy.detail };
  if (temporalSd > 0.55) return { state: "unstable", label: "Spectrally unstable", reliable: false, detail: "The estimated slope is changing too much for one stable color label.", modelAdequacyStatus: adequacy.status, modelAdequacyDetail: adequacy.detail };
  const canonical = nearestCanonical(fit.beta);
  const distance = Math.abs(fit.beta - canonical.beta);
  let confidence = "Low";
  if (!adequacy.acousticColoration && fit.rmseDb <= 2.2 && distance <= 0.3 && temporalSd <= 0.16) confidence = "High";
  else if (fit.rmseDb <= 4.6 && distance <= 0.55 && temporalSd <= 0.35) confidence = "Moderate";
  return {
    state: canonical.key,
    label: canonical.label,
    canonical,
    distance,
    confidence,
    reliable: true,
    detail: `Measured β = ${fit.beta.toFixed(2)}; nearest canonical target β = ${canonical.beta.toFixed(2)}; distance ${distance.toFixed(2)} β. ${adequacy.detail}`,
    modelAdequacyStatus: adequacy.status,
    modelAdequacyDetail: adequacy.detail,
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
  const tonality = tonalityDiagnostics(psd.frequencies, psd.power, fitRange[0], maxFrequency, fit, options.previousProminentPeakFrequencies || []);
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
    temporalSd: Number(options.temporalSd) || 0,
    beta: fit.beta,
    rawSlope: fit.slope,
    intercept: fit.intercept,
    r2: fit.r2,
    rmseDb: fit.rmseDb,
    maeDb: fit.maeDb,
    spectralFlatness: flatness,
    slopeNormalizedFlatness: tonality.slopeNormalizedFlatness,
    rms: input.rms,
    dbfs: input.dbfs,
    peak: input.peak,
    clippingRatio: input.clippingRatio,
    nearClipRatio: input.nearClipRatio,
    plateauRatio: input.plateauRatio,
    crestFactor: input.crestFactor,
    amplitudeKurtosis: input.amplitudeKurtosis,
    edgeDensityRatio: input.edgeDensityRatio,
    limitingSuspected: input.limitingSuspected,
    nonFiniteRatio: input.nonFiniteRatio,
    maxPeakProminenceDb: tonality.maxPeakProminenceDb,
    tonalPowerRatio: tonality.tonalPowerRatio,
    prominentPeakCount: tonality.prominentPeakCount,
    persistentPeakCount: tonality.persistentPeakCount,
    harmonicPeakCount: tonality.harmonicPeakCount,
    harmonicEvidence: tonality.harmonicEvidence,
    broadbandOccupancy: tonality.broadbandOccupancy,
    prominentPeakFrequencies: tonality.prominentPeakFrequencies,
    logBinnedBeta: modelAdequacy.logBinnedBeta,
    logBinnedRmseDb: modelAdequacy.logBinnedRmseDb,
    lowBandBeta: modelAdequacy.lowBandBeta,
    highBandBeta: modelAdequacy.highBandBeta,
    segmentedSlopeDelta: modelAdequacy.segmentedSlopeDelta,
    maxBreakpointSlopeDelta: modelAdequacy.maxBreakpointSlopeDelta,
    strongestBreakpointFrequency: modelAdequacy.strongestBreakpointFrequency,
    piecewiseRmseDb: modelAdequacy.piecewiseRmseDb,
    piecewiseImprovementDb: modelAdequacy.piecewiseImprovementDb,
    piecewiseRelativeImprovement: modelAdequacy.piecewiseRelativeImprovement,
    breakpointEvidence: modelAdequacy.breakpointEvidence,
    breakpointSupportBins: modelAdequacy.breakpointSupportBins,
    smoothCurvatureMagnitudeDb: modelAdequacy.smoothCurvatureMagnitudeDb,
    smoothCurvatureRmseDb: modelAdequacy.smoothCurvatureRmseDb,
    smoothResidualRmseDb: modelAdequacy.smoothResidualRmseDb,
    smoothResidualMadDb: modelAdequacy.smoothResidualMadDb,
    abruptBreakpointSlopeDelta: modelAdequacy.abruptBreakpointSlopeDelta,
    abruptBreakpointFrequency: modelAdequacy.abruptBreakpointFrequency,
    abruptBreakpointRmseDb: modelAdequacy.abruptBreakpointRmseDb,
    abruptBreakpointImprovementDb: modelAdequacy.abruptBreakpointImprovementDb,
    abruptBreakpointRelativeImprovement: modelAdequacy.abruptBreakpointRelativeImprovement,
    abruptBreakpointEvidence: modelAdequacy.abruptBreakpointEvidence,
    abruptBreakpointSupportBins: modelAdequacy.abruptBreakpointSupportBins,
    modelAdequacyStatus: quality.modelAdequacyStatus || "not-evaluated",
    modelAdequacyDetail: quality.modelAdequacyDetail || "Model adequacy was not evaluated because an earlier quality gate fired.",
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

const SESSION_STATE_KEYS = [...CANONICAL_COLORS.map((color) => color.key), "mixed", "tonal", "silence", "unstable", "clipping", "insufficient", "invalid"];
export const MAX_SESSION_TIMELINE_SEGMENTS = 2048;

function emptyStateDurations() {
  return Object.fromEntries(SESSION_STATE_KEYS.map((key) => [key, 0]));
}

function timelineStateDurations(timeline) {
  const durations = emptyStateDurations();
  for (const segment of timeline) {
    if (segment.compressed && segment.stateDurations) {
      for (const [state, duration] of Object.entries(segment.stateDurations)) durations[state] = (durations[state] || 0) + Math.max(0, Number(duration) || 0);
    } else {
      durations[segment.state] = (durations[segment.state] || 0) + Math.max(0, segment.endSeconds - segment.startSeconds);
    }
  }
  return durations;
}

function activityState(samples, fallback = null) {
  const input = calculateInputMetrics(samples);
  if (input.nonFiniteRatio > 0) return { state: "invalid", label: "Invalid audio data", reliable: false };
  if (input.dbfs < -58) return { state: "silence", label: "Signal too low", reliable: false };
  if (input.clippingRatio > 0.001 || input.nearClipRatio > 0.01 || input.peak >= 0.9999 || input.limitingSuspected) return { state: "clipping", label: "Clipping / limiting suspected", reliable: false };
  if (!fallback) return { state: "insufficient", label: "No stable spectral observation", reliable: false };
  if (fallback.state === "silence") return { state: "mixed", label: "Active signal without a reliable long-window color", reliable: false };
  const state = SESSION_STATE_KEYS.includes(fallback.state) ? fallback.state : "insufficient";
  return { state, label: fallback.classification || fallback.label || "No stable spectral observation", reliable: Boolean(fallback.reliable) && CANONICAL_COLORS.some((color) => color.key === state) };
}

export function buildActivityTimeline(samples, sampleRate, observations = [], frameSeconds = 0.5) {
  if (!samples.length || !Number.isFinite(sampleRate) || sampleRate <= 0) return [];
  const frameSize = Math.max(1, Math.round(frameSeconds * sampleRate));
  const ordered = [...observations].filter((item) => Number.isFinite(item.timeSeconds)).sort((left, right) => left.timeSeconds - right.timeSeconds);
  const timeline = [];
  let observationIndex = 0;
  for (let start = 0; start < samples.length; start += frameSize) {
    const end = Math.min(samples.length, start + frameSize);
    const centerSeconds = (start + end) / (2 * sampleRate);
    while (observationIndex + 1 < ordered.length && Math.abs(ordered[observationIndex + 1].timeSeconds - centerSeconds) <= Math.abs(ordered[observationIndex].timeSeconds - centerSeconds)) observationIndex += 1;
    const classified = activityState(samples.subarray(start, end), ordered[observationIndex] || null);
    const startSeconds = start / sampleRate;
    const endSeconds = end / sampleRate;
    const previous = timeline.at(-1);
    if (previous?.state === classified.state) previous.endSeconds = endSeconds;
    else timeline.push({ ...classified, startSeconds, endSeconds });
  }
  return timeline;
}

function summarizeWithDurations(observations, durationSeconds, durations, colorTimeline) {
  const total = Math.max(Number(durationSeconds) || 0, Number.EPSILON);
  const reliable = observations.filter((observation) => observation.reliable && Number.isFinite(observation.beta));
  const betaSummary = summarize(reliable.map((observation) => observation.beta));
  const dominant = CANONICAL_COLORS.reduce((best, color) => durations[color.key] > durations[best.key] ? color : best, CANONICAL_COLORS[0]);
  const rmseSummary = summarize(reliable.map((observation) => observation.rmseDb));
  const r2Summary = summarize(reliable.map((observation) => observation.r2));
  const flatnessSummary = summarize(reliable.map((observation) => observation.spectralFlatness));
  const reliableDuration = Object.entries(durations).filter(([state]) => CANONICAL_COLORS.some((color) => color.key === state)).reduce((sum, [, value]) => sum + value, 0);
  return {
    sessionDurationSeconds: durationSeconds,
    dominantReliableColor: reliableDuration > 0 ? dominant.label : null,
    percentages: Object.fromEntries(Object.entries(durations).map(([key, value]) => [key, (value / total) * 100])),
    betaMean: betaSummary.mean,
    betaSd: betaSummary.sd,
    betaMedian: betaSummary.median,
    fitRmseMeanDb: rmseSummary.mean,
    fitR2Mean: r2Summary.mean,
    spectralFlatnessMean: flatnessSummary.mean,
    reliablePercentage: reliableDuration / total * 100,
    rejectedPercentage: (total - reliableDuration) / total * 100,
    temporalBeta: observations.map(({ timeSeconds, startSeconds, endSeconds, beta, state, classification, reliable, rmseDb, r2, spectralFlatness }) => ({ timeSeconds, startSeconds, endSeconds, beta, state, classification, reliable, rmseDb, r2, spectralFlatness })),
    colorTimeline,
  };
}

export function summarizeSession(observations, durationSeconds, activityTimeline = null) {
  const durations = emptyStateDurations();
  const colorTimeline = activityTimeline || buildColorTimeline(observations, durationSeconds);
  for (const segment of colorTimeline) durations[segment.state] = (durations[segment.state] || 0) + Math.max(0, segment.endSeconds - segment.startSeconds);
  return summarizeWithDurations(observations, durationSeconds, durations, colorTimeline);
}

export class SessionAccumulator {
  constructor(sampleRate, frameSeconds = 0.5) {
    this.sampleRate = sampleRate;
    this.frameSize = Math.max(1, Math.round(sampleRate * frameSeconds));
    this.pending = new Float32Array(this.frameSize);
    this.pendingLength = 0;
    this.durations = emptyStateDurations();
    this.durationSeconds = 0;
    this.timeline = [];
    this.observations = { count: 0, betaMean: 0, betaM2: 0, rmseSum: 0, r2Sum: 0, flatnessSum: 0 };
  }

  addAudio(samples, fallback = null) {
    let offset = 0;
    while (offset < samples.length) {
      const count = Math.min(samples.length - offset, this.frameSize - this.pendingLength);
      this.pending.set(samples.subarray(offset, offset + count), this.pendingLength);
      this.pendingLength += count;
      offset += count;
      if (this.pendingLength === this.frameSize) this.commitFrame(this.pending, this.frameSize / this.sampleRate, fallback);
    }
  }

  commitFrame(samples, durationSeconds, fallback) {
    const classified = activityState(samples, fallback);
    const startSeconds = this.durationSeconds;
    const endSeconds = startSeconds + durationSeconds;
    this.durations[classified.state] = (this.durations[classified.state] || 0) + durationSeconds;
    const previous = this.timeline.at(-1);
    if (previous && !previous.compressed && previous.state === classified.state && previous.label === classified.label) {
      previous.endSeconds = endSeconds;
    } else {
      this.timeline.push({ ...classified, startSeconds, endSeconds });
    }
    this.durationSeconds = endSeconds;
    if (this.timeline.length > MAX_SESSION_TIMELINE_SEGMENTS) this.compressTimeline();
    this.pendingLength = 0;
  }

  compressTimeline() {
    const count = Math.ceil(MAX_SESSION_TIMELINE_SEGMENTS / 2);
    const compacted = this.timeline.splice(0, count);
    const stateDurations = timelineStateDurations(compacted);
    const startSeconds = compacted[0]?.startSeconds || 0;
    const endSeconds = compacted.at(-1)?.endSeconds || startSeconds;
    const composition = Object.entries(stateDurations)
      .filter(([, duration]) => duration > 0)
      .map(([state, duration]) => `${state} ${((duration / Math.max(endSeconds - startSeconds, Number.EPSILON)) * 100).toFixed(1)}%`)
      .join(", ");
    this.timeline.unshift({
      state: "session-compressed",
      label: `Compressed earlier session states: ${composition}`,
      startSeconds,
      endSeconds,
      reliable: false,
      compressed: true,
      stateDurations,
    });
  }

  addObservation(observation) {
    if (!observation?.reliable || !Number.isFinite(observation.beta)) return;
    const stats = this.observations;
    stats.count += 1;
    const delta = observation.beta - stats.betaMean;
    stats.betaMean += delta / stats.count;
    stats.betaM2 += delta * (observation.beta - stats.betaMean);
    if (Number.isFinite(observation.rmseDb)) stats.rmseSum += observation.rmseDb;
    if (Number.isFinite(observation.r2)) stats.r2Sum += observation.r2;
    if (Number.isFinite(observation.spectralFlatness)) stats.flatnessSum += observation.spectralFlatness;
  }

  finish(fallback = null) {
    if (this.pendingLength) this.commitFrame(this.pending.subarray(0, this.pendingLength), this.pendingLength / this.sampleRate, fallback);
  }

  summary(visualObservations = []) {
    const colorTimeline = this.timeline.map((segment) => ({ ...segment, stateDurations: segment.stateDurations ? { ...segment.stateDurations } : undefined }));
    const summary = summarizeWithDurations(visualObservations, this.durationSeconds, { ...this.durations }, colorTimeline);
    const stats = this.observations;
    if (stats.count) {
      summary.betaMean = stats.betaMean;
      summary.betaSd = Math.sqrt(stats.betaM2 / stats.count);
      summary.betaMedian = null;
      summary.fitRmseMeanDb = stats.rmseSum / stats.count;
      summary.fitR2Mean = stats.r2Sum / stats.count;
      summary.spectralFlatnessMean = stats.flatnessSum / stats.count;
    }
    summary.aggregateObservationCount = stats.count;
    summary.statisticsCoverFullSession = true;
    summary.timelineStateDurations = timelineStateDurations(colorTimeline);
    summary.timelineCoversFullSession = Math.abs((colorTimeline.at(-1)?.endSeconds || 0) - this.durationSeconds) <= 1 / this.sampleRate;
    summary.timelineMatchesAggregates = SESSION_STATE_KEYS.every((key) => Math.abs(summary.timelineStateDurations[key] - this.durations[key]) <= 1 / this.sampleRate);
    summary.timelineCompressed = colorTimeline.some((segment) => segment.compressed);
    return summary;
  }
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
    tonality: {
      slopeNormalizedFlatness: overall.slopeNormalizedFlatness,
      maxPeakProminenceDb: overall.maxPeakProminenceDb,
      tonalPowerRatio: overall.tonalPowerRatio,
      prominentPeakCount: overall.prominentPeakCount,
      persistentPeakCount: overall.persistentPeakCount,
      harmonicPeakCount: overall.harmonicPeakCount,
      harmonicEvidence: overall.harmonicEvidence,
      broadbandOccupancy: overall.broadbandOccupancy,
    },
    modelAdequacy: {
      segmentedSlopeDelta: overall.segmentedSlopeDelta,
      logBinnedRmseDb: overall.logBinnedRmseDb,
      maxBreakpointSlopeDelta: overall.maxBreakpointSlopeDelta,
      piecewiseImprovementDb: overall.piecewiseImprovementDb,
      piecewiseRelativeImprovement: overall.piecewiseRelativeImprovement,
      breakpointEvidence: overall.breakpointEvidence,
      smoothCurvatureMagnitudeDb: overall.smoothCurvatureMagnitudeDb,
      smoothCurvatureRmseDb: overall.smoothCurvatureRmseDb,
      smoothResidualRmseDb: overall.smoothResidualRmseDb,
      smoothResidualMadDb: overall.smoothResidualMadDb,
      abruptBreakpointSlopeDelta: overall.abruptBreakpointSlopeDelta,
      abruptBreakpointFrequency: overall.abruptBreakpointFrequency,
      abruptBreakpointImprovementDb: overall.abruptBreakpointImprovementDb,
      abruptBreakpointRelativeImprovement: overall.abruptBreakpointRelativeImprovement,
      abruptBreakpointEvidence: overall.abruptBreakpointEvidence,
    },
    temporalSd: reliableSummary.sd || 0,
  });
  const activityTimeline = buildActivityTimeline(samples, sampleRate, observations, options.activityFrameSeconds || 0.5);
  const sessionSummary = summarizeSession(observations, overall.durationSeconds, activityTimeline);
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
    modelAdequacyStatus: gated.modelAdequacyStatus || overall.modelAdequacyStatus,
    modelAdequacyDetail: gated.modelAdequacyDetail || overall.modelAdequacyDetail,
    temporalBetaMean: reliableSummary.mean,
    temporalBetaSd: reliableSummary.sd,
    temporalBetaMedian: reliableSummary.median,
    temporalBeta: observations,
    colorTimeline: activityTimeline,
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
