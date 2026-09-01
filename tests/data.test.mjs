import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CONDITION_METRICS,
  conditionQuality,
  parseCsv,
  summarizeTemporalRows,
} from "../src/data.js";

const movementCsv = await readFile(new URL("../public/data/movement_windows.csv", import.meta.url), "utf8");
const conditionCsv = await readFile(new URL("../public/data/condition_eye_movement_summary.csv", import.meta.url), "utf8");

test("CSV parser preserves quoted commas and escaped quotes", () => {
  assert.deepEqual(parseCsv('name,note\r\nVideo,"measured, not staged"\r\nTest,"a ""quote"""\r\n'), [
    { name: "Video", note: "measured, not staged" },
    { name: "Test", note: 'a "quote"' },
  ]);
});

test("video phase summaries are calculated from all 94 measured windows", () => {
  const videoRows = parseCsv(movementCsv).filter((row) => row.condition === "Video");
  const summaries = summarizeTemporalRows(videoRows);

  assert.equal(videoRows.length, 94);
  assert.deepEqual(summaries.map((phase) => phase.rowCount), [30, 30, 34]);
  assert.deepEqual(
    summaries.map((phase) => Number(phase.metrics.eeg_exponent.median.toFixed(6))),
    [1.280019, 1.302644, 1.621237],
  );
  assert.deepEqual(
    summaries.map((phase) => phase.metrics.horizontal_saccades_per_min.median),
    [51, 33, 28.5],
  );
  assert.deepEqual(
    summaries.map((phase) => phase.metrics.vertical_saccades_per_min.median),
    [24, 18, 9],
  );
  assert.deepEqual(
    summaries.map((phase) => phase.metrics.blink_rate_per_min.median),
    [33, 34.5, 34.5],
  );
});

test("condition comparison fields come from the condition summary table", () => {
  const conditions = parseCsv(conditionCsv);
  const video = conditions.find((row) => row.condition === "Video");
  const eyesOpen = conditions.find((row) => row.condition === "Eyes open");

  assert.equal(conditions.length, 6);
  assert.ok(video);
  assert.ok(eyesOpen);
  assert.equal(Number(video.eeg_exponent_condition_fit).toFixed(2), "1.61");
  assert.equal(Number(video.horizontal_saccades_per_min_median), 36);
  assert.equal(conditionQuality(video), "94 windows · 1 recording · 28 strict EEG");
  for (const metric of CONDITION_METRICS) assert.ok(metric.key in eyesOpen);
});

test("NoiseColor exposes local audio upload and decoded-file provenance", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../public/noisecolor/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/noisecolor/app.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="audioFile"[^>]+accept="audio\/\*/);
  assert.match(app, /async function loadAudioFile\(file\)/);
  assert.match(app, /decodeAudioData/);
  assert.match(app, /currentOptions\("uploaded-file", file\.name, bounded\)/);
  assert.match(app, /addEventListener\("drop"/);
});
