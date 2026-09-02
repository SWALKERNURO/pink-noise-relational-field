// Representation normalization only: full scale = 1. Never apply gain, clip,
// resample, detrend or replace non-finite data at this boundary.
export function normalizePcm(samples) {
  if (samples instanceof Float32Array) return samples;
  if (samples instanceof ArrayBuffer) return new Float32Array(samples);
  if (Array.isArray(samples) || samples instanceof Float64Array) return Float32Array.from(samples);
  throw new TypeError("Expected float PCM, not encoded audio or integer samples.");
}

export function monoFromChannels(length, channels, sampleAt) {
  if (!Number.isSafeInteger(length) || length < 0 || !Number.isInteger(channels) || channels < 1 || channels > 8) throw new Error("Invalid PCM channel layout.");
  const mono = new Float32Array(length);
  for (let frame = 0; frame < length; frame += 1) {
    let value = 0;
    for (let channel = 0; channel < channels; channel += 1) value += sampleAt(channel, frame) / channels;
    mono[frame] = value; // one float32 rounding, common to WAV and AudioBuffer
  }
  return mono;
}

export function mixToMono(audioBuffer) {
  const channels = Array.from({ length: audioBuffer.numberOfChannels }, (_, i) => audioBuffer.getChannelData(i));
  return monoFromChannels(audioBuffer.length, channels.length, (channel, frame) => channels[channel][frame]);
}

export function decodePcmWavTail(arrayBuffer, maxSeconds = 120) {
  if (arrayBuffer.byteLength < 44) return null;
  const view = new DataView(arrayBuffer);
  const textAt = (offset, length) => String.fromCharCode(...new Uint8Array(arrayBuffer, offset, length));
  if (textAt(0, 4) !== "RIFF" || textAt(8, 4) !== "WAVE") return null;
  let format = null;
  let dataOffset = null;
  let dataSize = 0;
  for (let offset = 12; offset + 8 <= arrayBuffer.byteLength;) {
    const id = textAt(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const payload = offset + 8;
    if (payload + size > arrayBuffer.byteLength) break;
    if (id === "fmt " && size >= 16) {
      format = {
        code: view.getUint16(payload, true),
        channels: view.getUint16(payload + 2, true),
        sampleRate: view.getUint32(payload + 4, true),
        blockAlign: view.getUint16(payload + 12, true),
        bitsPerSample: view.getUint16(payload + 14, true),
      };
    } else if (id === "data") {
      dataOffset = payload;
      dataSize = size;
      break;
    }
    offset = payload + size + (size % 2);
  }
  if (!format || dataOffset == null || ![1, 3].includes(format.code) || format.channels < 1 || format.channels > 8 || !format.blockAlign || format.sampleRate < 4000 || format.sampleRate > 384000) return null;
  if ((format.code === 1 && ![8, 16, 24, 32].includes(format.bitsPerSample)) || (format.code === 3 && format.bitsPerSample !== 32)) return null;
  if (format.blockAlign !== format.channels * format.bitsPerSample / 8 || dataSize % format.blockAlign) throw new Error("Invalid PCM WAV frame alignment.");
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) throw new Error("Invalid PCM window duration.");
  const totalFrames = Math.floor(dataSize / format.blockAlign);
  const keptFrames = Math.min(totalFrames, Math.floor(format.sampleRate * maxSeconds));
  const startFrame = totalFrames - keptFrames;
  const bytesPerSample = format.bitsPerSample / 8;
  const readSample = (offset) => {
    if (format.code === 3) return view.getFloat32(offset, true);
    if (format.bitsPerSample === 8) return (view.getUint8(offset) - 128) / 128;
    if (format.bitsPerSample === 16) return view.getInt16(offset, true) / 32768;
    if (format.bitsPerSample === 24) {
      let value = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
      if (value & 0x800000) value |= 0xff000000;
      return value / 8388608;
    }
    return view.getInt32(offset, true) / 2147483648;
  };
  const samples = monoFromChannels(keptFrames, format.channels, (channel, frame) =>
    readSample(dataOffset + (startFrame + frame) * format.blockAlign + channel * bytesPerSample));
  return {
    samples,
    sampleRate: format.sampleRate,
    acquisition: { decoder: "direct-PCM-WAV", channelCount: format.channels, declaredSampleRate: format.sampleRate, decodedSampleRate: format.sampleRate, channelMix: "arithmetic-mean", resampled: false },
    sourceDurationSeconds: totalFrames / format.sampleRate,
    analysisStartSeconds: startFrame / format.sampleRate,
    analysisTruncated: startFrame > 0,
  };
}
