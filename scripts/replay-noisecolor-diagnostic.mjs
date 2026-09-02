// Local PSD replay/comparison only. No network, PCM reconstruction or file writes.
import { readFile } from "node:fs/promises";
import { replayDiagnosticSpectrum } from "../public/noisecolor/diagnostic-bundle.js";

const paths = process.argv.slice(2);
if (paths.length < 1 || paths.length > 2) {
  console.error("Usage: node scripts/replay-noisecolor-diagnostic.mjs bundle.json [comparison.json]");
  process.exitCode = 1;
} else {
  try {
    const reports = [];
    for (const path of paths) {
      const bundle = JSON.parse(await readFile(path, "utf8"));
      const replay = replayDiagnosticSpectrum(bundle);
      const storedBeta = bundle.rawMeasurement.rawMeasuredBeta;
      reports.push({ appVersion: bundle.appVersion, engineVersion: bundle.engineVersion,
        acquisition: bundle.acquisition, configuration: bundle.configuration,
        storedBeta, replayedBeta: replay.rawFit.beta, betaDifference: replay.rawFit.beta - storedBeta,
        rawFit: replay.rawFit, input: bundle.rawMeasurement.pcm, temporal: {
          sd: bundle.temporal.temporalSd, observations: bundle.temporal.retainedObservationCount },
        tonality: replay.tonality, modelAdequacy: replay.modelAdequacy,
        classification: bundle.classification,
        explanation: "Replays original PSD, not raw PCM or physical source. No inference about the cause of a device discrepancy." });
      if (!Number.isFinite(storedBeta) || Math.abs(replay.rawFit.beta - storedBeta) > 1e-12) process.exitCode = 2;
    }
    console.log(JSON.stringify({ reports, comparison: reports.length === 2 ? {
      measuredBetaDifference: reports[1].storedBeta - reports[0].storedBeta,
      sampleRatesEqual: reports[0].acquisition.sampleRate === reports[1].acquisition.sampleRate,
      configurationsEqual: JSON.stringify(reports[0].configuration) === JSON.stringify(reports[1].configuration),
      note: "Equal settings or summary levels do not prove equal PCM. Compare original PSDs and optionally separately consented audio."
    } : null }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
