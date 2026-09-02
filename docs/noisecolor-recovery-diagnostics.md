# NoiseColor recovery diagnostics

Recovery development stays on `codex/noisecolor-recovery`; no historical branches are merged. This is a recovery prerelease, not evidence that the unexplained physical-device beta discrepancy is resolved.

## One measurement boundary

`pcm-input.js` standardizes decoded PCM to mono float32, full scale 1, without gain normalization, clipping, resampling, filtering, or non-finite-value repair. WAV and browser-decoded channel mixing now accumulate in double precision and round once per frame. Browser microphone mono conversion occurs upstream of this boundary and is identified as such.

`analysis-pipeline.js` is the worker entry point for live, recording and upload. Primary jobs use the same 4096-point, 50%-overlap, at-most-48-segment configuration. FFT, Welch normalization, original-PSD regression and scientific thresholds are unchanged. Fast previews intentionally use shorter PCM windows and at most 24 segments. Recording/upload temporal windows intentionally use at most 24 segments, default 6-second windows / 2-second steps.

Results separate:

- `measurement`: input quality, original raw fit, raw flatness, static residual tonality, acoustic/breakpoint diagnostics;
- `coreDecision`: window-only decision, no acquisition history;
- `qualityContext`: observed temporal evidence and peak history used for contextual classification;
- final classification: scientific gate decision;
- live display: explicitly smoothed/hysteretic state, never a replacement for raw beta or engine confidence;
- session: aggregates of measured observations and actual 500 ms captured activity frames.

Live window timestamps use dispatched sample boundaries, not worker completion time. The exported Welch plan includes actual segment offsets, FFT/hop size, window energy and scaling. Missing temporal evidence is explicit; the existing gate's zero-SD fallback is not presented as observed stability.

## Export on the device

Use **Export diagnostic bundle** in Live (also available after stopping), a recording/upload result, or Advanced → Diagnostics. JSON is downloaded locally; no network request sends the measurement. Live exports the last completed primary window's PSD/raw fit, separately from session statistics and retained temporal observations. Clear/new capture releases that diagnostic snapshot. Compact history cannot recreate missing PSD and therefore cannot generate a complete bundle.

The closed `noisecolor-diagnostic/1` schema includes versions, acquisition/window provenance, requested/effective fit limits, the actual Welch plan, raw beta/R²/RMSE/MAE, input quality and PCM statistics, residual tonality, smooth curvature and conditioned/original/rejected breakpoint diagnostics, auxiliary calibration data, temporal observations, original PSD, live-stage meters and allowlisted browser/track settings. Non-finite/unavailable values serialize as null. Meter scopes are documented because cumulative capture statistics and a selected analysis window need not have the same sample count or level.

No raw PCM, encoded audio, deviceId, groupId, route identifiers, filenames, track labels, full user-agent string, or calibration names are included. Spectrum/metadata may still describe the environment: review before sharing. Existing **Download Audio** is a separate opt-in action in Record mode. That browser-encoded file is not a bit-exact backup of captured PCM.

## Reproduce a reported discrepancy

1. Export the result showing the unexpected beta before clearing or beginning a new capture. Repeat the same setup in the other mode and export again.
2. Compare versions, acquisition/decoder, actual sample rate, track processing settings, exact fit range, analysis-window sample boundaries and Welch segment plan first.
3. Re-fit each original PSD locally:

   ```sh
   node scripts/replay-noisecolor-diagnostic.mjs measurement.json
   node scripts/replay-noisecolor-diagnostic.mjs measurement.json comparison.json
   ```

   The command performs no network operation or file write. It prints the reconstructed raw fit/tonality/model diagnostics. Exit 2 means stored/replayed beta differs by more than 1e-12; exit 1 means invalid input/usage. Separate JS runtime math may differ in the final floating-point bit.
4. If beta reproduces from the PSD but differs between captures, inspect the PSD/configuration difference. Summary dBFS or source labels cannot prove equal PCM. Only separately consented audio can support waveform-level investigation; the bundle cannot identify physical acoustics or browser processing before capture.

## Evidence

The baseline 57 tests passed before changes. Recovery adds exact adapter/worker cross-path comparisons for canonical beta −2/−1/0/+1/+2, acoustic-like noise, tones, broken spectra and silence; multichannel/sample-rate checks; explicit window/context differences; privacy/schema/replay checks; and confidence ownership checks.

The existing reported-style acoustic fixture remains beta 1.36143753634769, SD 0.02980651479724472, RMSE 3.897909223702877 dB, Moderate Pink-like. The synthetic low-pass example remains beta 3.740265708418 in both frozen and current estimators. It is a counterexample to estimator mutation, **not** a diagnosis of the user's recording.

Browser regression uses a synthetic source through native MediaStream, AudioWorklet/ScriptProcessor, capture buffers, worker and MediaRecorder. It checks ~−18 dBFS input, no false Low signal, every diagnostic download, original-PSD replay, offline analysis/export and install guidance. Physical iPhone/Android recordings, telephone interruptions, Bluetooth routes and thermal behavior still require real-device checks.
