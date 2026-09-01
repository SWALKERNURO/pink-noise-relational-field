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
