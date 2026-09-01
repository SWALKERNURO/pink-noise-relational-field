# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Selected product direction

- The selected visual target is `docs/design/reference-selected.png`: a dark, full-screen temporal field with four vertically stacked signal trajectories, a narrow left tool rail, persistent playback controls, and a measured/relation/question interpretation rail.
- Keep scientific claims cautious and legible. Always distinguish measured results from interpretation and open questions.
- The default state focuses on the 31:31 video recording and uses the validated EEG/EOG pilot analysis in `public/data/`.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
## NoiseColor

NoiseColor is the mobile-first acoustic spectral-analysis application under:

public/noisecolor/

Rules:

- NoiseColor is independent of the Pink Noise Relational Field React visualization.
- Do not materially modify src/App.jsx or the main relational-field application unless explicitly requested.
- Repository-level README, tests, package scripts, and deployment files may be changed when required for NoiseColor.
- Preserve:
  https://swalkernuro.github.io/pink-noise-relational-field/
- Preserve:
  https://swalkernuro.github.io/pink-noise-relational-field/noisecolor/

Scientific requirements:

- Estimate β from the unweighted continuous PSD.
- Do not estimate β from A-weighted or third-octave values.
- Do not force tonal, silent, unstable, or poorly fit signals into canonical noise colors.
- Preserve raw β separately from smoothed/display β.
- Audio processing must remain local to the user's device.
- Do not persist raw microphone audio unless explicitly requested.
- NoiseCapture may be used only as conceptual inspiration; do not copy GPLv3 source.
- Run scientific validation, tests, production build, and browser QA before committing.
