# Pink Noise Relational Field

Interactive React/Vite visualization exploring pink-noise / 1/f EEG structure alongside eye-movement measures from one recording.

## Local development

```bash
npm install
npm run dev
```

## Production build

```bash
npm run build
```

The static client build is written to `dist/client`.

## GitHub Pages

This repository includes a GitHub Actions workflow at `.github/workflows/deploy-pages.yml` that builds the app and deploys `dist/client` to GitHub Pages on pushes to `main`.

The Vite base path is derived automatically from `GITHUB_REPOSITORY` during GitHub Actions builds, so bundled assets and files under `public/data` resolve correctly at `https://<username>.github.io/<repo>/`, even if the repository is renamed.
