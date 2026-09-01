# Design QA

## Comparison target

- Source visual truth: `docs/design/reference-selected.png`
- Density-normalized source: `docs/design/reference-selected-normalized.png`
- Browser-rendered implementation: `docs/design/implementation-measured-final.png`
- Responsive implementation: `docs/design/implementation-measured-responsive.png`
- Full-view comparison: `docs/design/design-comparison-measured-final.png`
- Main-field comparison: `docs/design/design-comparison-measured-chart-focus.png`
- Interpretation-rail comparison: `docs/design/design-comparison-measured-rail-focus.png`
- NoiseColor file-input evidence: `docs/design/noisecolor-file-upload.png`

## Comparison setup

- State: default Video view; all interpretation sections expanded; playback paused; glow and value labels enabled.
- Source pixels: 1487 × 1058.
- Normalized source pixels: 1486 × 1058.
- Implementation pixels: 1486 × 1058.
- CSS viewport: 1486 × 1058 at device scale factor 1.
- Density normalization: the source was reduced by one horizontal pixel with high-quality bicubic interpolation, then compared at equal pixel dimensions.
- Responsive check: 900 × 1000 at device scale factor 1. The document scroll width was 900 px and the measured body width was 885 px, with no horizontal overflow.

## Full-view and focused evidence

The equal-size full-view comparison verifies the overall tool-rail, temporal-field, interpretation-rail, and playback composition. Focused comparisons were required because the measured values, IQR labels, scale guides, and interpretation copy are too small to judge reliably in the full view.

The chart-focused comparison confirms four correctly ordered signal bands, phase boundaries, right-side scale guides, measured phase labels, and the persistent playback boundary. The implementation is intentionally less cinematic than the generated source: its core lines pass through the 94 measured Video windows and its blink marks use measured candidate events, with no staged trajectory or synthetic particle field.

The rail-focused comparison confirms the measured/relation/question hierarchy, phase-median values, early-to-end deltas, final IQRs, cautious relation copy, and open-question section.

## Findings

- No actionable P0, P1, or P2 differences remain.
- Fonts and typography: Inter and IBM Plex Mono preserve the source hierarchy. Headings, metadata, measured values, IQR labels, compact scale labels, interpretation copy, and control text remain legible without unintended wrapping.
- Spacing and layout rhythm: the narrow tool rail, fluid central field, 300 px interpretation rail, chart-to-playback boundary, four signal bands, and responsive rail reflow preserve the selected composition. No viewport overflow hides persistent controls.
- Colors and visual tokens: the near-black navy ground and lime, cyan, violet, and amber signal palette match the source. Glow remains subordinate to the measured core lines and can be disabled without changing data.
- Image quality and asset fidelity: the target contains no photographic or illustrative assets. Phosphor icons provide a consistent icon family. The generated source's decorative particle field is not reproduced because the requested data-integrity constraint requires the primary trajectories and marks to originate in measured tables.
- Copy and content: measured results, interpretation, and questions remain clearly separated. Phase values and uncertainty labels are calculated from `movement_windows.csv`; condition values and deltas are calculated from `condition_eye_movement_summary.csv`.
- Accessibility and interaction states: controls use semantic buttons, labels, range/select inputs, checkboxes, expanded state, pressed state, status regions, and visible text. Color is reinforced by labels and spatial separation.

## Interaction verification

- Playback advanced the timeline from 648 to 656 seconds and paused correctly.
- Playback speed accepted the 2× option.
- Add marker produced `Marker added at 10:56` and a visible chart marker.
- Nature condition selection stayed open and displayed measured deltas versus Video: EEG −0.23, horizontal 0/min, vertical +9/min, and blinks −7.5/min.
- Signal glow disabled and restored the chart glow state.
- Value labels changed from 12 measured annotations to 0 and restored to 12.
- Measured, Relation, and Question sections remain independently collapsible.
- NoiseColor decoded a local four-second WAV, reported a White-like result with β 0.04, and enabled JSON/CSV export.
- Main field and NoiseColor browser consoles: no errors or warnings.

## Comparison history

1. The original implementation corrected chart height, signal-band alignment, phase labels, scale guides, and responsive layout; the retained historical evidence is organized under `docs/design/`.
2. The measured-data refactor removed the staged trend, hard-coded annotations, synthetic strands, and synthetic particle scatter. Before the final comparison, browser inspection found the header was counting a looser row-level acceptance flag; it was corrected to the validated `strict_eeg_accepted_windows` value from the condition summary.
3. Final equal-size full and focused comparisons found no actionable P0/P1/P2 mismatch after accounting for the intentional measured-data constraint. No post-comparison visual fix loop was required.

## Follow-up polish

- [P3] The raw measured trajectories are visibly sharper than the generated source's flowing ribbons. This is an intentional scientific-integrity trade-off: interpolation passes through measured windows and no staged trend is added.

## Implementation checklist

- [x] Preserve the selected full-screen hierarchy and color system.
- [x] Plot measured temporal values and measured candidate events.
- [x] Calculate all phase annotations and rail summaries from the source CSV.
- [x] Populate and operate condition comparison from the condition summary CSV.
- [x] Verify glow and value-label controls.
- [x] Verify NoiseColor audio-file decoding and export readiness.
- [x] Verify desktop and responsive browser states with clean consoles.

## Final result

final result: passed

---

# NoiseColor Design QA

## Comparison target

- Source visual truth: `docs/design/reference-selected.png`
- Browser-rendered desktop implementation: `docs/design/noisecolor-desktop.png`
- Browser-rendered portrait implementation: `docs/design/noisecolor-mobile.png`
- Combined comparison evidence: `docs/design/noisecolor-design-comparison.png`

## Comparison setup

- State: NoiseColor default Live Analysis view, microphone stopped, Balanced mode selected, install control available.
- Source pixels: 1487 × 1058.
- Desktop implementation pixels and CSS viewport: 1440 × 1000 at device scale factor 1.
- Portrait CSS viewport: 390 × 844 at device scale factor 1; full-page implementation capture: 390 × 1303.
- Responsive bound check: at a 360 × 800 viewport, `innerWidth` was 360 px and document scroll width was 345 px, with no document-level horizontal overflow.
- Density normalization: the combined evidence scales both desktop images to 900 px high with high-quality bicubic interpolation. The source occupies the left half and the NoiseColor implementation occupies the right half.

## Full-view and focused evidence

The combined full-view comparison verifies the selected direction's dark full-screen field, narrow left tool rail, lime scientific accent, dense central measurement area, and measured/interpretation/question rail. NoiseColor intentionally replaces the recording-specific four-trajectory field and playback footer with a live stable-classification field, current metrics, β history, and microphone controls because it is a separate product with a different primary task.

The portrait capture is the focused evidence because phone use is the primary NoiseColor target. It verifies the complete first-use hierarchy, all five primary actions, large touch targets, text-plus-β-plus-quality communication, privacy statement, and a legible β-history card without horizontal overflow. A separate crop was unnecessary because the primary controls and small scientific labels remain readable at original capture density.

## Findings

- No actionable P0, P1, or P2 visual differences remain.
- Fonts and typography: system Inter/SF/Segoe fallbacks preserve the source's compact scientific hierarchy while remaining native and legible on iPhone and Android. Large classification text, β, confidence, metric labels, and monospace scientific metadata retain distinct optical roles.
- Spacing and layout rhythm: desktop preserves the source's rail/field/interpretation proportions. Portrait collapses to one clear column, keeps the install control and five actions visible, and uses 44–52 px touch targets. No persistent control is hidden by viewport overflow.
- Colors and visual tokens: near-black navy surfaces, hairline blue-gray borders, and lime measurement accents match the source. Canonical color states use violet, cyan, white, pink, and orange, always paired with text and β rather than hue alone.
- Image quality and asset fidelity: the project-bound bitmap app icon and README install badges are sharp at their target sizes and share the selected field's waveform/grid art direction. No placeholder imagery, emoji, CSS-drawn logo, or copied NoiseCapture asset is used.
- Copy and content: the first screen answers the live spectral-color question directly, states local-only audio handling, distinguishes the stable result from Instant β, and retains measured/interpretation/question framing in the desktop rail and scientific details.
- Accessibility: semantic navigation, headings, status regions, labels, dialogs, tabs, visible focus, reduced-motion handling, safe-area variables, large controls, and text/β/quality redundancy are present.

## Interaction verification

- Exact local route `/noisecolor/` opened NoiseColor rather than the parent React application.
- iOS and Android install query links opened their platform-specific instruction sheets; normal app opening did not auto-open installation guidance.
- A synthetic 4-second WAV uploaded through the browser, retained its declared 16 kHz rate, and produced the scientifically correct `Tonal / non-noise` gate instead of a color label.
- The uploaded result populated diagnostics and a visible time-frequency spectrogram, saved to local IndexedDB history, and exposed JSON/CSV/advanced actions.
- The versioned service worker registered at scope `/noisecolor/`; the earlier update exercise displayed and activated the waiting v0.4.4 worker, and the final v0.5.3 pass confirmed versioned module URLs plus a coherent offline launch.
- The original Pink Noise Relational Field root route rendered its unchanged heading and produced no browser console warnings or errors.
- Console checks for NoiseColor mobile, desktop, upload, history, spectrogram, install, update, and offline states produced no warnings or errors.
- Live microphone permission could not be completed in the available in-app browser; the Start Live Analysis control was exercised, but real iPhone Safari and Android Chromium microphone/permission/interruption behavior remains a clearly documented manual device check.

## Comparison history

1. The first portrait pass found duplicate pre-measurement guidance and a scrolling action row that hid History and Advanced beyond the initial viewport. The copy was separated into a concise `No stable estimate yet` line plus one explanatory sentence, and the phone labels were compacted so all five actions remain visible.
2. Upload verification found browser resampling obscured a low-rate WAV's declared source rate and recorded/uploaded results did not yet populate the spectrogram. WAV sample-rate preservation and worker-generated recording spectrograms were added; the same 16 kHz tonal file then rendered correctly in both diagnostics and the spectrogram.
3. The service-worker update test found the old v0.4.0 shell remained active until an update was offered. The visible update banner successfully activated the waiting worker and reloaded a coherent v0.4.4 shell. The v0.5.3 follow-up added matching version query parameters to the shell and every imported module, then verified the new version offline. Final mobile and desktop review found no remaining P0/P1/P2 issue.

## Follow-up polish

- [P3] The desktop idle β field is intentionally quieter than the source's measured temporal ribbons. Once listening begins, live β history, PSD, and spectrogram data provide the corresponding visual density without fabricating an idle trace.
- [P3] Native iOS Safari and Android Chromium install banners, safe-area insets, Bluetooth route changes, calls, screen lock, and microphone constraint reporting should receive a final physical-device pass before public launch.

## Implementation checklist

- [x] Preserve the selected scientific visual language without changing the parent React app.
- [x] Make Live Analysis the phone-first primary task.
- [x] Keep color, β, quality, privacy, and installation messaging legible in portrait.
- [x] Verify upload, local history, advanced views, spectrogram, update flow, offline shell, scoped service worker, and root-app regression.
- [x] Save equal-view comparison evidence and final responsive captures.

## Final result

final result: passed
