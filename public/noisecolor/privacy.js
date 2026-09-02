// Closed browser/track settings schema. Never persist device/route identifiers
// or free-form track labels, even if nested in browser-provided objects.
export function sanitizeAudioSettings(settings) {
  if (!settings || typeof settings !== "object") return null;
  const allowed = ["sampleRate", "sampleSize", "channelCount", "latency", "echoCancellation", "noiseSuppression", "autoGainControl", "suppressLocalAudioPlayback", "restrictOwnAudio"];
  return Object.fromEntries(allowed.filter((key) => ["number", "boolean"].includes(typeof settings[key]) && (typeof settings[key] !== "number" || Number.isFinite(settings[key]))).map((key) => [key, settings[key]]));
}

export function sanitizeMetadata(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return undefined;
  if (Array.isArray(value)) return value.map(sanitizeMetadata);
  if (typeof value !== "object") return undefined;
  const forbidden = /^(deviceId|groupId|routeId|inputRouteId|calibrationRouteKey|samples|rawSamples|pcmSamples|audio|audioBuffer|recordingBlob)$/i;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !forbidden.test(key)).map(([key, item]) => [key, sanitizeMetadata(item)]));
}
