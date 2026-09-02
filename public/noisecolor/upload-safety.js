export const MAX_COMPRESSED_FILE_BYTES = 12 * 1024 * 1024;
export const MAX_COMPRESSED_DURATION_SECONDS = 120;
export const MAX_DECODE_WORKING_BYTES = 128 * 1024 * 1024;
export const MIN_DECODER_OVERHEAD_BYTES = 8 * 1024 * 1024;
export const DECODER_OVERHEAD_RATIO = 0.5;

function findBytes(bytes, signature, maximum = bytes.length) {
  const limit = Math.min(bytes.length - signature.length, maximum);
  for (let index = 0; index <= limit; index += 1) {
    let matched = true;
    for (let offset = 0; offset < signature.length; offset += 1) {
      if (bytes[index + offset] !== signature[offset]) { matched = false; break; }
    }
    if (matched) return index;
  }
  return -1;
}

function inspectMp3(bytes) {
  let start = 0;
  if (bytes.length >= 10 && String.fromCharCode(...bytes.subarray(0, 3)) === "ID3") {
    start = 10 + ((bytes[6] & 0x7f) << 21) + ((bytes[7] & 0x7f) << 14) + ((bytes[8] & 0x7f) << 7) + (bytes[9] & 0x7f);
  }
  const sampleRates = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  const mpeg1Bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const mpeg2Bitrates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
  let parsedBytes = 0;
  let frames = 0;
  let maximumSampleRate = 0;
  let maximumChannels = 0;
  for (let index = start; index + 4 <= bytes.length;) {
    if (bytes[index] !== 0xff || (bytes[index + 1] & 0xe0) !== 0xe0) { index += 1; continue; }
    const version = (bytes[index + 1] >> 3) & 0x03;
    const layer = (bytes[index + 1] >> 1) & 0x03;
    const bitrateIndex = (bytes[index + 2] >> 4) & 0x0f;
    const sampleRateIndex = (bytes[index + 2] >> 2) & 0x03;
    if (version === 1 || layer !== 1 || sampleRateIndex === 3 || bitrateIndex === 0 || bitrateIndex === 15) { index += 1; continue; }
    const sampleRate = sampleRates[version]?.[sampleRateIndex];
    const bitrate = (version === 3 ? mpeg1Bitrates : mpeg2Bitrates)[bitrateIndex];
    const padding = (bytes[index + 2] >> 1) & 1;
    const frameLength = Math.floor(((version === 3 ? 144 : 72) * bitrate * 1000) / sampleRate) + padding;
    if (!sampleRate || frameLength < 24 || index + frameLength > bytes.length) { index += 1; continue; }
    maximumSampleRate = Math.max(maximumSampleRate, sampleRate);
    maximumChannels = Math.max(maximumChannels, ((bytes[index + 3] >> 6) & 0x03) === 3 ? 1 : 2);
    parsedBytes += frameLength;
    frames += 1;
    index += frameLength;
  }
  const audioBytes = Math.max(1, bytes.length - start);
  return frames && parsedBytes / audioBytes >= 0.8 ? { container: "mp3", sampleRate: maximumSampleRate, channels: maximumChannels, metadataVerified: true } : null;
}

function inspectOgg(bytes) {
  const opus = findBytes(bytes, [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 256 * 1024);
  if (opus >= 0 && opus + 10 <= bytes.length) return { container: "ogg-opus", sampleRate: 48000, channels: bytes[opus + 9], metadataVerified: true };
  const vorbis = findBytes(bytes, [0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73], 256 * 1024);
  if (vorbis >= 0 && vorbis + 16 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { container: "ogg-vorbis", sampleRate: view.getUint32(vorbis + 12, true), channels: bytes[vorbis + 11], metadataVerified: true };
  }
  return null;
}

function inspectFlac(bytes) {
  if (bytes.length < 42 || String.fromCharCode(...bytes.subarray(0, 4)) !== "fLaC") return null;
  const offset = 18;
  const packed = (BigInt(bytes[offset]) << 56n) | (BigInt(bytes[offset + 1]) << 48n) | (BigInt(bytes[offset + 2]) << 40n) | (BigInt(bytes[offset + 3]) << 32n) |
    (BigInt(bytes[offset + 4]) << 24n) | (BigInt(bytes[offset + 5]) << 16n) | (BigInt(bytes[offset + 6]) << 8n) | BigInt(bytes[offset + 7]);
  const sampleRate = Number((packed >> 44n) & 0xfffffn);
  const channels = Number((packed >> 41n) & 0x7n) + 1;
  const totalSamples = Number(packed & 0xfffffffffn);
  return { container: "flac", sampleRate, channels, durationSeconds: sampleRate > 0 && totalSamples > 0 ? totalSamples / sampleRate : null, metadataVerified: true };
}

function inspectMp4(bytes) {
  const mp4a = findBytes(bytes, [0x6d, 0x70, 0x34, 0x61]);
  if (mp4a < 4) return null;
  const boxStart = mp4a - 4;
  if (boxStart + 36 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels = view.getUint16(boxStart + 24, false);
  const sampleRate = view.getUint32(boxStart + 32, false) >>> 16;
  if (!channels || !sampleRate) return null;
  return { container: "mp4-audio", sampleRate, channels, metadataVerified: true };
}

function inspectAdts(bytes) {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  let parsedBytes = 0;
  let frames = 0;
  let maximumSampleRate = 0;
  let maximumChannels = 0;
  for (let index = 0; index + 7 <= bytes.length;) {
    if (bytes[index] !== 0xff || (bytes[index + 1] & 0xf6) !== 0xf0) { index += 1; continue; }
    const rateIndex = (bytes[index + 2] >> 2) & 0x0f;
    const channels = ((bytes[index + 2] & 1) << 2) | ((bytes[index + 3] >> 6) & 3);
    const frameLength = ((bytes[index + 3] & 3) << 11) | (bytes[index + 4] << 3) | ((bytes[index + 5] >> 5) & 7);
    if (!rates[rateIndex] || !channels || frameLength < 7 || index + frameLength > bytes.length) { index += 1; continue; }
    maximumSampleRate = Math.max(maximumSampleRate, rates[rateIndex]);
    maximumChannels = Math.max(maximumChannels, channels);
    parsedBytes += frameLength;
    frames += 1;
    index += frameLength;
  }
  return frames && parsedBytes / bytes.length >= 0.8 ? { container: "aac-adts", sampleRate: maximumSampleRate, channels: maximumChannels, metadataVerified: true } : null;
}

export function inspectCompressedLayout(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.length < 4) return null;
  if (String.fromCharCode(...bytes.subarray(0, 4)) === "OggS") return inspectOgg(bytes);
  if (String.fromCharCode(...bytes.subarray(0, 4)) === "fLaC") return inspectFlac(bytes);
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(4, 8)) === "ftyp") return inspectMp4(bytes);
  return inspectMp3(bytes) || inspectAdts(bytes);
}

export function estimateCompressedDecodePeakBytes({ encodedBytes, durationSeconds, sampleRate, channels }) {
  const encodedArrayBufferBytes = Math.ceil(Math.max(0, Number(encodedBytes) || 0));
  const sampleFrames = Math.ceil(Math.max(0, Number(durationSeconds) || 0) * Math.max(0, Number(sampleRate) || 0));
  const decodedChannelPcmBytes = sampleFrames * Math.max(0, Number(channels) || 0) * Float32Array.BYTES_PER_ELEMENT;
  const monoOutputBytes = sampleFrames * Float32Array.BYTES_PER_ELEMENT;
  const decoderOverheadBytes = Math.max(MIN_DECODER_OVERHEAD_BYTES, Math.ceil(decodedChannelPcmBytes * DECODER_OVERHEAD_RATIO));
  return {
    encodedArrayBufferBytes,
    decodedChannelPcmBytes,
    monoOutputBytes,
    decoderOverheadBytes,
    estimatedPeakBytes: encodedArrayBufferBytes + decodedChannelPcmBytes + monoOutputBytes + decoderOverheadBytes,
  };
}

export function assessCompressedUploadSafety({ encodedBytes, durationSeconds, sampleRate, channels, metadataVerified }) {
  if (encodedBytes > MAX_COMPRESSED_FILE_BYTES) return { safe: false, reason: "Compressed audio is limited to 12 MB before decoding on mobile." };
  if (!metadataVerified || !Number.isFinite(sampleRate) || sampleRate < 7350 || sampleRate > 192000 || !Number.isInteger(channels) || channels < 1 || channels > 8) {
    return { safe: false, reason: "This compressed file's sample rate and channel layout could not be verified safely before decoding." };
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return { safe: false, reason: "This compressed file's duration could not be verified safely before decoding." };
  if (durationSeconds > MAX_COMPRESSED_DURATION_SECONDS) return { safe: false, reason: "Compressed audio longer than 2 minutes is not decoded on this device. Trim or convert it to PCM WAV first." };
  const peakMemory = estimateCompressedDecodePeakBytes({ encodedBytes, durationSeconds, sampleRate, channels });
  if (peakMemory.estimatedPeakBytes > MAX_DECODE_WORKING_BYTES) {
    return { safe: false, reason: "Decoding this audio would exceed the 128 MiB peak mobile memory safety limit. Use a shorter, lower-rate, or lower-channel file.", estimatedWorkingBytes: peakMemory.estimatedPeakBytes, ...peakMemory };
  }
  return { safe: true, estimatedWorkingBytes: peakMemory.estimatedPeakBytes, ...peakMemory };
}

export async function preflightCompressedUpload(file, arrayBuffer, readDuration) {
  const layout = inspectCompressedLayout(arrayBuffer);
  if (!layout) throw new Error("This compressed container cannot be safely inspected before decoding. Convert it to PCM WAV, MP3, Ogg/Opus, FLAC, AAC, or M4A.");
  const durationSeconds = Number.isFinite(layout.durationSeconds) ? layout.durationSeconds : await readDuration(file);
  const assessment = assessCompressedUploadSafety({ encodedBytes: file.size, durationSeconds, ...layout });
  if (!assessment.safe) throw new Error(assessment.reason);
  return { ...layout, durationSeconds, estimatedWorkingBytes: assessment.estimatedWorkingBytes, estimatedPeakBytes: assessment.estimatedPeakBytes };
}
