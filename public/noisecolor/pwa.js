export function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

export function isIosDevice(navigatorLike = navigator) {
  return /iPad|iPhone|iPod/.test(navigatorLike.userAgent || "") || (navigatorLike.platform === "MacIntel" && navigatorLike.maxTouchPoints > 1);
}

export function isIosSafari() {
  const userAgent = navigator.userAgent;
  const ios = isIosDevice();
  const webkit = /WebKit/.test(userAgent);
  const otherIosBrowser = /CriOS|FxiOS|EdgiOS|OPiOS/.test(userAgent);
  return ios && webkit && !otherIosBrowser;
}

export function platformInstallHint() {
  const forced = new URLSearchParams(location.search).get("install");
  if (forced === "ios" || forced === "android") return forced;
  if (isIosDevice()) return "ios";
  if (/Android/i.test(navigator.userAgent)) return "android";
  return "desktop";
}

export function setupPwa({ onInstallReady, onInstalled, onUpdateAvailable, onError } = {}) {
  let deferredPrompt = null;
  const handlePrompt = (event) => {
    event.preventDefault();
    deferredPrompt = event;
    onInstallReady?.(true);
  };
  window.addEventListener("beforeinstallprompt", handlePrompt);
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    onInstallReady?.(false);
    onInstalled?.();
  });

  const promptInstall = async () => {
    if (!deferredPrompt) return { outcome: "unavailable" };
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    deferredPrompt = null;
    onInstallReady?.(false);
    return choice;
  };

  let registration = null;
  let refreshPending = false;
  const register = async () => {
    if (!("serviceWorker" in navigator)) return null;
    try {
      registration = await navigator.serviceWorker.register("./sw.js", { scope: "./", updateViaCache: "none" });
      const announceWaiting = () => registration.waiting && onUpdateAvailable?.(() => registration.waiting.postMessage({ type: "SKIP_WAITING" }));
      announceWaiting();
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) announceWaiting();
        });
      });
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (refreshPending) return;
        refreshPending = true;
        location.reload();
      });
      window.setInterval(() => registration.update(), 60 * 60 * 1000);
      return registration;
    } catch (error) {
      onError?.(error);
      return null;
    }
  };

  return { promptInstall, register, getRegistration: () => registration, dispose: () => window.removeEventListener("beforeinstallprompt", handlePrompt) };
}
