# Recovery verification — 2026-09-02

Branch: `codex/noisecolor-recovery`. Release label: `0.6.8-recovery.2` (unpublished prerelease). One engineer, no separate agents, no historical branch merges, no push or main merge.

## Milestones and scope

- `2ce6b21`: architecture/data-flow findings recorded before implementation.
- `2a51aa2`: common PCM/worker boundary, isolated core measurement and contextual decisions, local diagnostic bundles and PSD replay, cross-path/privacy tests.
- Follow-up recovery milestone: explicit pause/resume, contiguous-segment boundaries, worklet reset acknowledgement, capture-generation guards, live/record recovery QA.

The FFT, Welch power normalization, raw original-PSD beta regression and scientific thresholds were not changed. The Welch return object now exposes its actual segment plan. Recording contextual gating reuses full core diagnostics instead of reconstructing partial copies. UI confidence now comes from the engine; session scientific observations no longer inherit display smoothing/hysteresis.

## Checks

| Verification | Result |
| --- | --- |
| Baseline repository suite before edits | 57 passed |
| Final repository + scientific stress suite (`npm test`) | 65 passed |
| `npm run build` | Passed; required client/server/Sites artifacts emitted |
| `npm run test:sites` | 4 passed |
| `npm run verify` | Passed (tests + build + Sites) |
| Syntax checks of NoiseColor JS; `git diff --check` | Passed |
| Native Chrome production browser suite | Passed; zero page/console errors |
| Local diagnostic CLI replay of downloaded JSON | Exit 0; raw beta reproduced |

Browser suite: `scripts/verify-noisecolor-browser.mjs`, native Chrome with Playwright supplied by the local runtime, preview at localhost port 43817. The source is explicitly synthetic; native MediaStream, AudioWorklet/ScriptProcessor, capture buffers, worker, MediaRecorder and rendered controls are exercised. No physical microphone was opened.

Browser acceptance included 28-second live analysis, recording, float-WAV upload, exported JSON from Live/Record/Upload/Advanced, PSD replay to 1e-12 across Chrome/Node, recording suspend/resume, ScriptProcessor live suspend/resume, ended-track finalization, offline launch/analysis/export, PWA scope/cache version, iOS guidance and Android install events. Exact equality is required within the same JS runtime for identical PCM/configuration; cross-runtime transcendental math may differ in the last bit. Portrait and desktop views were inspected. Evidence JSON/screenshots remain in OS temporary directories, not in the repository.

Observed synthetic live result: 14 stable windows, beta 0.9857768310684766, −18.050781677323958 dBFS; Low signal 0%. Initial awaiting-analysis time remains correctly counted as insufficient, not silence. Recording: beta 0.9938377630019183, −18.00149182513948 dBFS. These captures cover different intervals of the loop and are not asserted to be identical PCM. The recording-buffer/worker/analyzer dBFS values agree exactly. The WAV upload beta was 0.9986270318170238 versus frozen reference 0.998627031817024.

## Scientific invariants

| Fixture | Before recovery | After recovery |
| --- | --- | --- |
| Reported-style smooth acoustic coloration | beta 1.36143753634769; temporal SD 0.02980651479724472; RMSE 3.897909223702877 dB; Moderate Pink-like | Unchanged |
| Synthetic pink + steep low-pass | raw beta 3.740265708418 in frozen/current estimator; Mixed | Unchanged |
| Canonical beta −2/−1/0/+1/+2 | Correct canonical trend | Preserved; exact cross-path core comparisons |
| Resonant/speaker/microphone/room-colored noise | Acoustic tolerance and reduced confidence | Preserved |
| Strong tones/harmonics/music, broken spectra, limiting/clipping, silence and instability | Conservative rejection | Preserved |

Cross-path comparisons exercise the real WAV/AudioBuffer adapters, live/record buffers and worker dispatcher. They compare input metrics, complete PSD, raw fit/R²/RMSE/MAE/flatness, tonality and all model diagnostics. Tests explicitly distinguish fast/temporal/full-window differences. Interruption tests prove that a post-resume fit cannot silently combine pre-pause brown PCM with post-resume white PCM.

## Limitations and failures encountered

- One intermediate browser run produced zero stable windows; it was not reproduced by subsequent runs. The harness now explicitly waits for capture startup and emits browser/capture state if no windows arrive. This is not evidence of a cause for the physical-device discrepancy.
- Intermediate strict Chrome-versus-Node replay assertions differed by approximately 1e-16. Cross-runtime checks use 1e-12 numerical precision; same-runtime acquisition-equivalence assertions remain exact. No scientific gate was loosened.
- The parent React build still reports its existing >500 kB chunk warning; the parent application and Sites worker/hosting integration were not redesigned.
- Physical iPhone/Android acoustic measurements, permissions, telephone/screen-lock interruptions, Bluetooth route changes and sustained thermal behavior remain unverified. Browser simulations do not establish their behavior.
- The beta 3.74 report is still empirically unresolved. Export the unexpected measurement and a comparison capture from the same setup. A PSD bundle reproduces spectral regression/diagnostics, not the underlying waveform or physical source. Raw audio stays separate and explicit opt-in; browser-encoded recordings may differ from captured PCM.
- Missing temporal history remains an explicitly documented legacy zero-SD gate fallback, not a claim of observed stability. Compact history has no PSD and cannot generate a complete diagnostic bundle.

## Changed-file groups

- NoiseColor runtime: `analysis-engine.js`, `analysis-worker.js`, `analysis-pipeline.js`, `pcm-input.js`, `privacy.js`, `diagnostic-bundle.js`, `app.js`, `audio-worklet.js`, `live-runtime.js`, `live-state.js`, `history.js`, `index.html`, `sw.js`.
- Verification/tools: `tests/noisecolor.test.mjs`, `tests/data.test.mjs`, `scripts/verify-noisecolor-browser.mjs`, `scripts/replay-noisecolor-diagnostic.mjs`.
- Documentation: `AGENTS.md`, `README.md`, and the recovery architecture, diagnostic guide and this verification report under `docs/`.
