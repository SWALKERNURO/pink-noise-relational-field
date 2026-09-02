# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Selected product direction

- The selected visual target is `docs/design/reference-selected.png`: a dark, full-screen temporal field with four vertically stacked signal trajectories, a narrow left tool rail, persistent playback controls, and a measured/relation/question interpretation rail.
- Keep scientific claims cautious and legible. Always distinguish measured results from interpretation and open questions.
- The default state focuses on the 31:31 video recording and uses the validated EEG/EOG pilot analysis in `public/data/`.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
## NoiseColor product boundary

- NoiseColor is the only product modified by NoiseColor feature work. Do not redesign or materially change the Pink Noise Relational Field React application.
- Primary NoiseColor application code belongs under `public/noisecolor/`; repository-level files may change only when needed to build, test, document, install, or deploy NoiseColor.
- Preserve both the repository root experience and the existing `/noisecolor/` GitHub Pages URL.
- Live microphone spectral-color estimation is NoiseColor's primary workflow. Audio stays local, raw live audio is not persisted by default, and scientific quality gates must prevent confident labels for silence, tonal input, unstable input, clipping, or poor single-power-law fits.
- NoiseColor's canonical development branch is `codex/noisecolor-recovery`. Historical NoiseColor branches are reference only; do not merge them or develop on them. Recovery work is performed by one engineer without separate agents. Do not merge or push to main without a new explicit instruction.
- Keep raw PSD regression, acoustic/tonality diagnostics, contextual classification, and display/session aggregates distinct. Diagnostic exports must be local-only, exclude deviceId/groupId, and never include raw audio implicitly.
- Keep NoiseColor directory-scoped and safe-area-aware. A live microphone track may recover from background/mute/suspension/device-change pauses through explicit Resume capture; never pad missing time with silence or splice separated PCM segments into one scientific fit.
- For iPhone/iPad Live/Record, recommend Safari → Share → Add to Home Screen → Open as Web App OFF. Standalone capture may fail on affected devices; offer explicit Safari/retry/reinstall actions without bypassing permissions, blocking other tools, or promising forced Safari navigation. Android installation remains unchanged.
