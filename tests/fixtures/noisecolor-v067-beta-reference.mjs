// Frozen original estimator from commit c18a6348077335efc70d86d7fb423788bac9bbd9.
// Test oracle only: intentionally independent of production imports.
export const APP_VERSION = "0.6.7";
export const ENGINE_VERSION = "0.6.7";
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
