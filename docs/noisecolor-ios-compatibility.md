# iPhone microphone compatibility — recovery.3

## Scope and evidence

App/cache version: `0.6.8-recovery.3`. Scientific engine: `0.6.8-recovery.2` (unchanged).

The user physically confirmed working capture in Safari and a NotAllowedError in
the same phone's installed standalone app. This patch handles that execution-context
failure; it does not claim to repair WebKit, bypass permission, or explain the
unresolved acoustic beta 3.74 measurement.

[WebKit's Safari 26 documentation](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)
describes disabling **Open as Web App** to create a browser bookmark. Older iOS
versions may not expose this switch; use Safari directly if it is unavailable.
A NotAllowedError alone cannot distinguish a deliberate permission denial from a
platform restriction. The UI says so alongside the requested compatibility message.

## Behavior

- iPhone/iPad detection includes desktop-style iPad user agents. Standalone detection
  accepts `navigator.standalone === true` or the standalone display media query.
- Both Live and Record still use the same startup lock and acquisition function.
  Only iOS standalone permission/context denials during getUserMedia receive
  **MICROPHONE BLOCKED BY iOS**. Successful standalone capture is not blocked.
- Recovery offers explicit Safari, Retry Microphone and reinstall actions. It
  replaces the large classification placeholder without disabling navigation.
- Safari opening is one `window.open` call, on a direct click, to the canonical
  same-origin directory URL with `_blank` and `noopener,noreferrer`. There are no
  custom protocols, query-driven redirects, automatic microphone retries or loops.
  iOS chooses the browser; actual Safari handoff cannot be guaranteed. The normal
  external link, Copy Link, and manual instructions are always offered after the
  attempt, including when popup/clipboard access is blocked.
- iOS Install help remains accessible while installed and distinguishes the
  recommended Safari shortcut from the more app-like standalone presentation.
  Android's native prompt and installed state are unchanged.

## Startup diagnostic bundle

The existing `noisecolor-diagnostic/1` exporter now also accepts a
`kind: microphone-startup-failure` record. This explicit variant contains app and
engine versions, acquisition mode, startup stage, allowlisted error name, normalized
error message, independent standalone/display mode, iOS detection, secure-context
and mediaDevices/getUserMedia availability. Track settings are allowlisted and
included only if the failed attempt actually obtained a track.

Free-form error messages are mapped to fixed categories, not retained with fragile
string redaction. No deviceId/groupId, track label, filename, raw audio, raw PCM or
full browser string is exported. `rawMeasurement`, `psd`, and measurement timestamp
are null: failed startup is not a scientific observation. Failure-only bundles
cannot be PSD-replayed. Successful measurement bundles are unchanged.

Failure state is session-local and cleared by Clear or the next acquisition
attempt. Export it before retrying if needed. It is not stored in History or sent
to any server.

## Verification

Recorded results: `npm run verify` passes all 69 repository/NoiseColor tests,
the production build, and four Sites tests. The complete browser regression passes
Live/Record/Upload, interruption recovery, diagnostic replay, Android install events,
and scoped offline analysis/export with no page errors. The parent application
loads its four trajectories and six-condition comparison unchanged. Its existing
large-chunk build warning remains; no parent assets or application code changed.
All 11 compatibility scenarios pass, including offline startup-failure export and
reinstall guidance. Browser page/console error lists are empty.

In the browser QA harness, initial controller activation is allowed to settle
before capture. Export equality now matches the exported sample window to its
actual worker result: a pre-Stop snapshot can otherwise refer to the preceding
window. No scientific tolerance, production scheduling or acquisition behavior was
changed for either test-timing correction.

Run from the repository root:

```text
npm run verify
node scripts/verify-noisecolor-browser.mjs
node scripts/verify-noisecolor-ios-browser.mjs
```

Browser scripts require Playwright (or `PLAYWRIGHT_MODULE`), an installed browser
channel (`NOISECOLOR_BROWSER_CHANNEL=chrome`), and the production preview URL in
`NOISECOLOR_URL`. Build and preview use the GitHub Pages repository prefix when
`GITHUB_ACTIONS=true` and `GITHUB_REPOSITORY=SWALKERNURO/pink-noise-relational-field`.
Screenshots and diagnostic downloads go to the OS temporary directory, not the repo.

The compatibility matrix uses native Chromium audio APIs with a synthetic
MediaStream and simulated iOS/Android browser context. It covers Safari and
standalone success, Live/Record standalone rejection, desktop-style iPad detection,
ordinary Safari/desktop denial, Android standalone success/native install prompt,
gesture-only Safari fallback, blocked popup/clipboard, exact reinstall steps,
retry, actual Upload/History/Advanced use after failure, and offline failure
export/guidance. This is not a physical iPhone or Safari/WebKit engine test.

The complete regression covers frozen raw-beta equality, canonical beta -2/-1/0/1/2,
tonality/acoustic fixtures, cross-path PCM equivalence, scheduling, interruption
continuity, diagnostics, Android install events, service-worker scope and offline
analysis. The pre-existing first-install service-worker activation reload is
unchanged; tests wait for activation/navigation to settle before capture.

## Exact physical-iPhone acceptance procedure

This patch is committed locally, not deployed. After an explicitly approved deployment:

1. On the original affected phone, open the existing standalone NoiseColor app
   online. Apply its update/reload and let initial loading settle. Confirm app
   **0.6.8-recovery.3**, engine **0.6.8-recovery.2** in Advanced/version information.
2. Start Live Analysis. On the known denial, expect **MICROPHONE BLOCKED BY iOS**
   with the Safari explanation and all three recovery actions, not the giant
   Microphone unavailable placeholder. Export its diagnostic bundle locally.
3. Try Record → Start Recording. Expect the same recovery UX with acquisitionMode
   `recording` in a second bundle. Verify sanitized error/context fields and no
   device identifiers or raw audio. An acquisition denial must have no track settings.
4. Test Retry Microphone. It must make only one new attempt in the failed mode,
   without redirecting automatically. A continuing platform denial is expected to
   redisplay the recovery panel, not bypass permission.
5. Open NoiseColor in Safari. Confirm whether iOS opens Safari. If not, use the
   displayed URL or Copy Link and paste manually into Safari. If copying is blocked,
   touch and hold the normal link. No automatic navigation back to standalone occurs.
6. In Safari at the canonical URL below, allow microphone access. Run Live for at
   least 30 seconds, then record/analyze the same acoustic source. Export matched
   measurement bundles. Do not infer that every physical pink source must measure
   beta 1; retain measured beta and diagnostics for the unresolved discrepancy.
7. Confirm Upload can analyze a local file, save it to History, and display Advanced
   after a standalone failure. Preserve wanted results before removing the old app;
   Safari and the standalone app may have separate local storage.
8. Follow **How to reinstall for microphone access** exactly:
   1. Remove the existing NoiseColor Home Screen web app.
   2. Open NoiseColor in Safari.
   3. Confirm Live Analysis works and allow microphone access.
   4. Safari → Share → Add to Home Screen.
   5. Turn **Open as Web App OFF**.
   6. Tap Add.
9. Launch the new Home Screen shortcut. Confirm it opens Safari and repeat Live
   and Record. Check installation text readability, portrait/landscape safe areas,
   and scrollability of the full instructions. If the switch is absent, use Safari
   directly. Record iPhone model/iOS version and actual handoff/permission results
   separately; automated emulation cannot certify them.

Canonical URL: <https://swalkernuro.github.io/pink-noise-relational-field/noisecolor/>

## Changed files

Functional UI, compatibility, diagnostics and cache changes:

- `public/noisecolor/app.js`
- `public/noisecolor/microphone-compatibility.js` (new)
- `public/noisecolor/pwa.js`
- `public/noisecolor/diagnostic-bundle.js`
- `public/noisecolor/index.html`
- `public/noisecolor/styles.css`
- `public/noisecolor/sw.js`

App-version/cache-import strings only (all other source text verified identical to
the approved parent, after normalizing version strings and line endings):

- `public/noisecolor/analysis-engine.js` (APP_VERSION only; ENGINE_VERSION unchanged)
- `public/noisecolor/analysis-pipeline.js`
- `public/noisecolor/analysis-worker.js`
- `public/noisecolor/audio-worklet.js`
- `public/noisecolor/history.js`
- `public/noisecolor/live-state.js`

Tests and documentation:

- `tests/noisecolor.test.mjs`
- `scripts/verify-noisecolor-browser.mjs`
- `scripts/verify-noisecolor-ios-browser.mjs` (new)
- `docs/noisecolor-ios-compatibility.md` (this file)
- `README.md`
- `AGENTS.md`
