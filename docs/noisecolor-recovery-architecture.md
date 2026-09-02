# NoiseColor recovery architecture review

Reviewed clean recovery HEAD `35f800c`, before implementation. Baseline: 57 repository tests passed. No historical branch was checked out or merged.

## Existing data flow

```
getUserMedia -> browser mono conversion -> AudioWorklet / ScriptProcessor
                                         -> capturePcm -> RollingBuffer (live)
                                                       -> recordingPcm (record)
                                                       -> SessionAccumulator (500 ms activity)
WAV -> direct integer/float decode + mono mix ---------------------------+
compressed file -> browser decodeAudioData + separate mono mix ---------+
live / record / upload PCM -> worker -> analyzeSamples -> Welch PSD
                                                    -> original PSD OLS beta
                                                    -> residual tonality + QR acoustic diagnostics
                                                    -> qualityGate -> result
record/upload additionally -> temporal analyzeSamples windows -> contextual qualityGate
live additionally -> ColorStateMachine smoothing/hysteresis -> session accumulation
result / session aggregate -> UI -> JSON/CSV / compact local history
```

## Verified invariants

- Raw beta uses the original continuous PSD, equal FFT ordinate weighting, configured fit limits. Calibration is a separate auxiliary estimate. Neither the smooth trend nor breakpoint analysis substitutes a beta.
- Welch uses segment-mean removal, Hann window-energy normalization, one-sided density scaling and evenly distributed bounded segments. Frozen v0.6.7 equivalence tests pass.
- Record/Analyze already uses captured float PCM, not its separately encoded MediaRecorder download. Live already shares the core engine and measures actual 500 ms activity PCM.
- Residual tonality, conditioning/support safeguards, stable-first scheduling, insufficient-versus-silence accounting, directory-scoped PWA caches are present and must be preserved.

## Inconsistencies and risks

1. Acquisition normalization is implicit and duplicated. WAV mixes channels in double precision before one float32 rounding; browser-decoded audio rounds into float32 after every channel. No shared acquisition/configuration contract exists. Normalization must standardize representation/units, **not** change gain, resample, whiten or correct the signal.
2. Primary UI jobs use 48 Welch segments, fast jobs 24, and temporal subwindows at most 24. Results do not preserve the full configuration/segment selection. Different windows are not equivalent inputs.
3. Live display recomputes confidence with a different RMSE cutoff and omits acoustic confidence restrictions. Display smoothing must not overrule engine confidence or supply the scientific session state.
4. Live observation timestamps use worker completion wall time, not dispatched PCM sample boundaries. Mode changes can leave old-mode work in flight. Export needs a captured-window identity and option snapshot.
5. Live session JSON contains means and percentages, not the exact PSD/raw fit of the measured window. Stopping clears the latest result; compact history intentionally removes PSD. A diagnostic bundle must retain one bounded measurement separately and never relabel a session mean as raw beta.
6. Settings privacy filtering is shallow. Generic JSON exports and nested metadata can retain identifiers. Diagnostic export requires a closed field schema plus recursive identifier filtering; raw arrays must never be included by blindly spreading request options.
7. Recording contextual gating reconstructs partial diagnostics by hand. This can drift from core qualityGate inputs. Core input/fit/diagnostics must be reusable; temporal context and resulting decision must be explicit.
8. Missing temporal history currently falls back to zero SD. This is not evidence of observed stability. Preserve policy for this instrumentation milestone but expose availability, count, selection and actual observations.
9. `corrected` denotes availability of an auxiliary corrected estimate, although PSD and primary beta are uncorrected. Export must explicitly identify which estimate it describes.
10. Capture interruption handling currently finalizes/stops on mute, background, suspension or device change. That is conservative but not seamless recovery when the track remains live; interrupted capture must be identified, not represented as silent PCM. Real-device recovery behavior remains a separate acceptance concern.

## Recovery implementation contract

Introduce a common float32/channel adapter and worker dispatcher. Preserve the scientific estimator and existing gate thresholds. Store core measurement/configuration independently of acquisition provenance, temporal context and display state. Reuse full diagnostics for contextual gating. Export a versioned local JSON bundle containing the original PSD, exact fit limits and Welch plan, raw measurements, diagnostics, acquisition/window provenance, temporal observations and allowlisted browser/track settings. Do not include PCM, filenames, route identifiers or raw browser labels. Existing encoded audio download remains a separate explicit action and is not lossless scientific replay.

Cross-path tests must exercise the actual adapters and dispatcher using identical decoded PCM/configuration and compare every core diagnostic, not only beta. Test multichannel conversion, actual live buffering, bounded tails and deliberate fast/temporal window differences. Keep the complete canonical/acoustic/broken-spectrum/tones/music/limiting/silence regression suite.

## Unresolved empirical question

The reported beta 3.74 cannot be attributed to v0.6.8 estimator changes: identical-input frozen comparisons refute that explanation. Source acoustics, browser processing, frequency limits and actual samples cannot be reconstructed from summary statistics. A diagnostic PSD can reproduce the raw regression and spectral diagnostics; it cannot recover the waveform or prove the physical source. Compare bundles from the same setup, and optionally retain audio separately with explicit consent. Do not promote this instrumentation work as a demonstrated real-phone fix or silently relabel 3.74 as pink.
