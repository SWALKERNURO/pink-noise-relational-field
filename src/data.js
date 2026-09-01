export const DURATION_SECONDS = 1891;

export const PHASES = [
  { key: "early", label: "early", start: 0, end: 600 },
  { key: "mid", label: "middle", start: 600, end: 1200 },
  { key: "end", label: "end", start: 1200, end: Number.POSITIVE_INFINITY },
];

export const TEMPORAL_METRICS = [
  {
    key: "eeg_exponent",
    className: "eeg",
    title: "Posterior EEG exponent",
    band: "2–40 Hz",
    unit: "",
    decimals: 2,
    domain: [0, 2.25],
    plotBase: 3.38,
    plotHeight: 0.88,
  },
  {
    key: "horizontal_saccades_per_min",
    className: "horizontal",
    title: "Horizontal eye movement",
    band: "0.5–15 Hz",
    unit: " /min",
    decimals: 1,
    domain: [0, 150],
    plotBase: 2.42,
    plotHeight: 0.56,
  },
  {
    key: "vertical_saccades_per_min",
    className: "vertical",
    title: "Vertical eye movement",
    band: "0.5–15 Hz",
    unit: " /min",
    decimals: 1,
    domain: [0, 60],
    plotBase: 1.59,
    plotHeight: 0.45,
  },
  {
    key: "blink_rate_per_min",
    className: "blinks",
    title: "Blinks",
    band: "candidate events",
    unit: " /min",
    decimals: 1,
    domain: [0, 80],
    plotBase: 0.73,
    plotHeight: 0.31,
  },
];

export const CONDITION_METRICS = [
  { key: "eeg_exponent_condition_fit", label: "EEG exponent", decimals: 2, unit: "" },
  { key: "horizontal_saccades_per_min_median", label: "Horizontal", decimals: 1, unit: "/min" },
  { key: "vertical_saccades_per_min_median", label: "Vertical", decimals: 1, unit: "/min" },
  { key: "blink_rate_per_min_median", label: "Blinks", decimals: 1, unit: "/min" },
];

export function parseCsv(text) {
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];

    if (character === '"' && quoted && next === '"') {
      field += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      record.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && next === "\n") index += 1;
      record.push(field);
      if (record.some((value) => value !== "")) records.push(record);
      record = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (field || record.length) {
    record.push(field);
    if (record.some((value) => value !== "")) records.push(record);
  }

  const [headers = [], ...rows] = records;
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

export function numeric(value, fallback = null) {
  if (value === "" || value == null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function quantile(values, percentile) {
  const sorted = values.map((value) => numeric(value)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sorted[lower + 1] === undefined
    ? sorted[lower]
    : sorted[lower] + fraction * (sorted[lower + 1] - sorted[lower]);
}

export function summarizeTemporalRows(rows) {
  return PHASES.map((phase) => {
    const phaseRows = rows.filter((row) => {
      const midpoint = numeric(row.midpoint_seconds);
      return midpoint !== null && midpoint >= phase.start && midpoint < phase.end;
    });

    const metrics = Object.fromEntries(TEMPORAL_METRICS.map((metric) => {
      const values = phaseRows.map((row) => row[metric.key]);
      return [metric.key, {
        count: values.map((value) => numeric(value)).filter(Number.isFinite).length,
        median: quantile(values, 0.5),
        q1: quantile(values, 0.25),
        q3: quantile(values, 0.75),
      }];
    }));

    return { ...phase, rowCount: phaseRows.length, metrics };
  });
}

export function formatMetricValue(value, decimals = 1) {
  if (!Number.isFinite(value)) return "—";
  if (decimals === 0) return Math.round(value).toString();
  const fixed = value.toFixed(decimals);
  return decimals === 1 ? fixed.replace(/\.0$/, "") : fixed;
}

export function formatSignedMetric(value, decimals = 1) {
  if (!Number.isFinite(value)) return "—";
  const prefix = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${prefix}${formatMetricValue(Math.abs(value), decimals)}`;
}

export function conditionQuality(row) {
  const windows = numeric(row?.windows, 0);
  const recordings = numeric(row?.recordings, 0);
  const accepted = numeric(row?.strict_eeg_accepted_windows, 0);
  return `${windows} windows · ${recordings} recording${recordings === 1 ? "" : "s"} · ${accepted} strict EEG`;
}
