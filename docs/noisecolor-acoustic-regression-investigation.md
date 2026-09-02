# Acoustic regression investigation — local diagnostic candidate

Status: `0.6.8-diagnostic.1`, on `codex/noisecolor-live-tonality-fix`.
Not v0.6.9, not published. The exact real-device beta jump remains unverified
without the original audio and exported measurement/route metadata. This report
distinguishes demonstrated implementation defects from device hypotheses.

## Findings and changes

### Raw measured beta

The v0.6.8 curvature/model-adequacy functions did not overwrite the continuous
PSD beta fit. The FFT, Hann window, Welch normalization, and `fitPowerLaw`
mathematics remain unchanged. A frozen independent copy of that path from
`c18a6348077335efc70d86d7fb423788bac9bbd9` is checked into the test fixtures.
Identical PCM, sample rate, fit range, FFT/overlap, and segment budget produce
exactly equal PSD arrays and beta values in the Node regressions, including
live, recorded, and uploaded source paths.

There were two important provenance ambiguities:

- `beta` / “Measured beta” could describe a calibration-corrected PSD, not raw
  capture. `rawMeasuredBeta` and its compatibility alias `beta` now always come
  from the original PSD. `rawMeasurement`, `smoothAcousticCurvature`,
  `breakpointDiagnostics`, and canonical classification fields are separate.
  `correctedEstimate` is explicitly auxiliary; it cannot replace raw beta or the
  classification input. No stored history is rewritten.
- Record/Analyze decoded a separate MediaRecorder encoding, whereas Live used
  Web Audio PCM. Codec decoding, sample-rate conversion, channel policy, and
  differing Welch segment budgets made those workflows nonidentical. Recording
  analysis now uses up to 120 seconds of the same mono captured PCM; the encoded
  download remains separate and is labeled accordingly. Primary source paths
  share a 48-segment budget. Fast previews and temporal subwindows still use 24.

Neither ambiguity is proven to explain this user's 1.4 → 3.74 observation.
Changing acoustic response or input route is another possibility. A synthetic
pink source with a fourth-order low-pass power response at 1010 Hz measures
beta **3.740265708418 in both engines** and remains Mixed. This is a demonstration
of why source identity does not determine the captured slope, not a substitute
for the unavailable device recording.

### Adjusted breakpoint inflation

The degree-five smooth polynomial and added hinge were fitted jointly using
normal equations, without conditioning or effective-bandwidth checks. A large
hinge coefficient can be canceled by the polynomial while barely changing the
predicted spectrum. Normal equations further worsen numerical conditioning.
Therefore the coefficient need not be a credible physical slope change.

The diagnostic solver now uses twice-reorthogonalized QR. Accepted adjusted
candidates require at least three bins, 2.5 effective weighted bins, and 0.25
octave of support on each side. The remaining orthogonal basis norm must be at
least 1% of its original norm (solver rank cutoff 0.001%). Adjusted delta cannot
exceed three times the original hinge delta at the same breakpoint, using a
0.5-beta floor for weak original evidence. That last check is a conservative
identifiability safeguard, not a calibrated statistical test. Discarded fits
retain delta, frequency, original delta, support, and rejection reason in exports;
they cannot win the adjusted gate. Original unadjusted evidence remains visible.

Tests cover polynomial/hinge cancellation, narrow support, gain/frequency-scale
invariance, smooth EQ with resonances, and the existing 36 sharp-breakpoint cases.
The unavailable 13.14-at-3854-Hz device fit itself has not been replayed.

### Live “100% Low signal”

The old independent fast and stable timers had harmonic intervals: 500/1000 ms
in Balanced mode. Fast was registered first and claimed the single worker;
stable returned immediately when the worker was busy. Repeated coincident
callbacks could starve stable observations indefinitely. The summary then added
`insufficient` time to `silence` and labeled the total “Low signal.” This reproduces
the reported symptom with entirely audible PCM; the silence threshold was not
the cause and remains -58 dBFS.

One dispatcher now gives due stable jobs priority and preserves skipped
deadlines. Low signal counts only actual PCM silence. Awaiting analysis is
reported separately. Session beta statistics use observed raw estimates rather
than the display-smoothed beta.

## PCM trace and limits

Diagnostics expose peak, RMS, dBFS, sample count, and nonzero ratio at Web Audio
input, worklet/ScriptProcessor output, capture callback, selected rolling or
recording buffer, session accumulator, 500 ms activity frame, worker input, and
analyzer input. Full scale is 1; RMS level is `20 log10(RMS)`. There is no gain
adjustment in this instrumentation. The worklet explicitly receives mono, matching
the ScriptProcessor input convention.

Input/session meters are cumulative; callback/buffer/worker entries describe
their latest block or selected window. Different time supports can legitimately
have different RMS. For identical PCM, buffer/worker/analyzer dBFS are identical.
`getUserMedia` does not expose pre-browser PCM: the first observable PCM boundary
is Web Audio input. Requested/actual browser processing and physical device behavior
still require on-device verification. Metrics retain no audio; recording PCM is
in-memory only and released on completion/clear. The final incomplete worklet
packet can omit fewer than 2048 samples; metadata describes delivered PCM time.

## Verification

- `npm run verify`: 57 repository/scientific tests, production build, and four
  Sites tests pass. The existing parent-app large-chunk build warning remains.
- `node scripts/verify-noisecolor-browser.mjs`: production-preview Chromium QA
  uses a labeled synthetic -18 dBFS pink stream in place of device acquisition,
  retaining native MediaStream, AudioWorklet, ScriptProcessor, MediaRecorder,
  worker, and UI behavior. It covers 28-second Live, Record/Analyze, Float32 WAV
  upload, exact frozen-reference beta comparison, 500 ms activity PCM, mobile and
  desktop layout, PWA scope/offline shell, and install guidance/events.
- The original 30-second acoustic fixture remains Pink-like / Moderate:
  beta **1.361437536348**, temporal SD **0.029806514797**, RMSE
  **3.897909223703 dB**. Raw beta is not detrended or snapped.
- Synthetic browser Live reported roughly -18.02 dBFS and recording -18.00 dBFS.
  Recording buffer/worker/analyzer levels matched exactly. Live reported **0%
  Low signal**, with initial warm-up separately reported as Awaiting analysis.
  These are simulated-capture checks, not phone hardware validation.
- Source review and `git diff --check` pass. Parent React code and the protected
  Sites hosting/worker files are unchanged. Generated screenshots stay in the OS
  temporary directory, not the repository.

To reproduce browser QA, supply a running production preview using
`NOISECOLOR_URL` (default localhost port 43817). Install Playwright or provide its
module URL using `PLAYWRIGHT_MODULE`; `NOISECOLOR_BROWSER_CHANNEL=chrome` uses
an installed Chrome. Run `node scripts/verify-noisecolor-browser.mjs`.

## Release hold / device acceptance still needed

Attach the original beta-3.74 recording and exported JSON, the earlier matching
recording if available, phone/browser/OS, input route, and calibration selection.
Replay the same bytes with identical settings before comparing engines. Then
capture simultaneous Live/Record diagnostics on that phone, test silence and a
strong tone/music source, and verify route/background/interruption behavior.
This local candidate is not promoted to v0.6.9 until the unexplained device change
is resolved. No merge, push, or deployment is authorized by this task.

## Intentional files

- `public/noisecolor/analysis-engine.js`, `analysis-worker.js`, `audio-worklet.js`,
  `app.js`, `live-runtime.js`, and new `pcm-diagnostics.js`: measurement isolation,
  conditioned adequacy diagnostics, shared capture, priority dispatch, and tracing.
- `public/noisecolor/index.html`, `live-state.js`, `sw.js`: diagnostic build identity,
  coherent module/cache URLs, offline inclusion, and accurate calibration copy.
- `tests/noisecolor.test.mjs`, new
  `tests/fixtures/noisecolor-v067-beta-reference.mjs`, and
  `scripts/verify-noisecolor-browser.mjs`: deterministic and browser regressions.
- `README.md` and this report: measurement semantics, reproduction, and limitations.
