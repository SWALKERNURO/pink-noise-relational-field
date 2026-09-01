import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("repository root is free of Windows shortcuts and loose design screenshots", async () => {
  const rootEntries = await readdir(root);
  assert.ok(!rootEntries.includes("Flux EEG.lnk"));
  assert.deepEqual(rootEntries.filter((entry) => entry.toLowerCase().endsWith(".png")), []);
});

test("design evidence is organized under docs/design", async () => {
  for (const file of [
    "reference-selected.png",
    "implementation-final.png",
    "implementation-responsive.png",
    "design-comparison-final.png",
    "design-comparison-chart-focus.png",
    "design-comparison-rail-focus.png",
  ]) {
    await access(new URL(`../docs/design/${file}`, import.meta.url));
  }
});

test("documentation uses repository paths and includes licensing and verification", async () => {
  const [readme, designQa, license, agents] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../design-qa.md", import.meta.url), "utf8"),
    readFile(new URL("../LICENSE", import.meta.url), "utf8"),
    readFile(new URL("../AGENTS.md", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(designQa, /[A-Za-z]:\\/);
  assert.match(readme, /NoiseColor audio input/);
  assert.match(readme, /npm run verify/);
  assert.match(readme, /MIT License/);
  assert.match(license, /^MIT License/);
  assert.match(agents, /docs\/design\/reference-selected\.png/);
});

test("application has no staged trajectory or hard-coded condition summary", async () => {
  const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(app, /stagedValue/);
  assert.doesNotMatch(app, /CONDITION_SUMMARY\s*=/);
  assert.match(app, /condition_eye_movement_summary\.csv/);
  assert.match(app, /showGlow/);
  assert.match(app, /showValueLabels/);
});
