import { isIosDevice } from "./pwa.js?v=0.6.8-recovery.3";
import { sanitizeAudioSettings } from "./privacy.js?v=0.6.8-recovery.3";

export function microphoneEnvironment(windowLike, navigatorLike) {
  const standaloneDisplay = Boolean(windowLike.matchMedia?.("(display-mode: standalone)").matches);
  return {
    standalone: navigatorLike.standalone === true || standaloneDisplay,
    displayMode: standaloneDisplay ? "standalone" : windowLike.matchMedia?.("(display-mode: fullscreen)").matches ? "fullscreen" : "browser",
    ios: isIosDevice(navigatorLike), secureContext: windowLike.isSecureContext === true,
    mediaDevicesAvailable: Boolean(navigatorLike.mediaDevices),
    getUserMediaAvailable: typeof navigatorLike.mediaDevices?.getUserMedia === "function",
  };
}

export function isPermissionContextDenial(error) {
  return ["NotAllowedError", "PermissionDeniedError", "SecurityError"].includes(error?.name) ||
    /not allowed|permission denied|permission dismissed|denied permission|access was denied|user agent or the platform|not permitted.*context/i.test(String(error?.message || ""));
}

// Deliberately normalize, rather than retain arbitrary browser error prose:
// messages may contain device identifiers, track labels, URLs or file paths.
export function sanitizeStartupFailure(failure) {
  if (!failure) return null;
  const names = ["NotAllowedError", "PermissionDeniedError", "SecurityError", "NotFoundError", "DevicesNotFoundError", "NotReadableError", "TrackStartError", "AbortError", "OverconstrainedError", "NotSupportedError", "TypeError", "Error"];
  const errorName = names.includes(failure.errorName) ? failure.errorName : "Error";
  const permissionDenied = isPermissionContextDenial({ name: errorName, message: failure.errorMessage });
  return {
    acquisitionMode: failure.acquisitionMode === "recording" ? "recording" : "live",
    stage: ["get-user-media", "audio-setup", "startup"].includes(failure.stage) ? failure.stage : "startup",
    errorName,
    errorMessage: permissionDenied ? "Microphone access was denied by the user, browser or platform context."
      : ["NotFoundError", "DevicesNotFoundError"].includes(errorName) ? "No microphone was found."
        : ["NotReadableError", "TrackStartError"].includes(errorName) ? "The microphone could not be read by the browser."
          : "Microphone startup failed. Browser error detail omitted for privacy.",
    messageSanitization: "normalized-category; original free-form message not retained",
    permissionDenied,
    standalone: failure.standalone === true,
    displayMode: ["standalone", "fullscreen", "browser"].includes(failure.displayMode) ? failure.displayMode : "browser",
    ios: failure.ios === true, secureContext: failure.secureContext === true,
    mediaDevicesAvailable: failure.mediaDevicesAvailable === true,
    getUserMediaAvailable: failure.getUserMediaAvailable === true,
    trackObtained: failure.trackObtained === true,
    audioTrackSettings: failure.trackObtained === true ? sanitizeAudioSettings(failure.audioTrackSettings) : null,
  };
}

export function microphoneStartupFailure(error, context) {
  return sanitizeStartupFailure({ ...context, errorName: error?.name, errorMessage: error?.message });
}

export function isIosStandaloneDenial(failure) {
  return Boolean(failure?.ios && failure.standalone && failure.stage === "get-user-media" && failure.permissionDenied);
}

export function canonicalAppUrl(pageUrl) {
  const url = new URL("./", pageUrl);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("A same-site HTTP(S) app URL is required.");
  return url.href; // no query/hash, action flags, custom schemes or redirect loop
}

export function openSafariFromGesture(windowLike, pageUrl) {
  const url = canonicalAppUrl(pageUrl);
  // noopener can itself produce a null return even when opening succeeds.
  // Always offer the manual fallback; never infer successful Safari handoff.
  try { windowLike.open(url, "_blank", "noopener,noreferrer"); } catch { /* manual link remains available */ }
  return url;
}
