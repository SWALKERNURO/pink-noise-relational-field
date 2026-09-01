import { useEffect, useMemo, useRef, useState } from "react";
import ReactECharts from "echarts-for-react";
import {
  Pulse,
  ArrowSquareOut,
  BookmarkSimple,
  CaretDown,
  CaretRight,
  ChartLine,
  Check,
  DownloadSimple,
  Eye,
  GearSix,
  Info,
  Pause,
  Play,
  Question,
  SlidersHorizontal,
  WaveSine,
  X,
} from "@phosphor-icons/react";
import {
  CONDITION_METRICS,
  DURATION_SECONDS,
  TEMPORAL_METRICS,
  conditionQuality,
  formatMetricValue,
  formatSignedMetric,
  numeric,
  parseCsv,
  summarizeTemporalRows,
} from "./data.js";

const COLORS = {
  eeg: "#c6ff5c",
  horizontal: "#66e8ed",
  vertical: "#a66cff",
  blinks: "#ffc64e",
};

const DATA_BASE = `${import.meta.env.BASE_URL}data`;

function formatTime(seconds) {
  const safe = Math.max(0, Math.min(DURATION_SECONDS, Math.round(seconds)));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function normalize(value, min, max) {
  if (max === min) return 0.5;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

function mapRowsToBand(rows, metric) {
  return rows.flatMap((row) => {
    const time = numeric(row.midpoint_seconds);
    const value = numeric(row[metric.key]);
    if (!Number.isFinite(time) || !Number.isFinite(value)) return [];
    const plotted = metric.plotBase + normalize(value, ...metric.domain) * metric.plotHeight;
    return [[time, plotted, value]];
  });
}

function getChartOption(rows, blinkEvents, currentTime, markers, showGlow) {
  const metricSeries = TEMPORAL_METRICS.map((metric) => ({
    metric,
    color: COLORS[metric.className],
    data: mapRowsToBand(rows, metric),
  }));

  const glowLines = showGlow
    ? metricSeries.map(({ data, color }) => ({
      type: "line",
      data,
      showSymbol: false,
      smooth: 0.24,
      silent: true,
      animationDuration: 700,
      lineStyle: { color, width: 13, opacity: 0.16, shadowBlur: 20, shadowColor: color },
      z: 2,
    }))
    : [];

  const measuredPoints = metricSeries.map(({ data, color }) => ({
    type: "scatter",
    data,
    symbolSize: 2.6,
    itemStyle: { color, opacity: showGlow ? 0.42 : 0.68 },
    silent: true,
    z: 4,
  }));

  const measuredLines = metricSeries.map(({ metric, data, color }) => ({
    name: metric.title,
    type: "line",
    data,
    showSymbol: false,
    smooth: 0.24,
    lineStyle: {
      color,
      width: 1.7,
      opacity: 0.96,
      shadowBlur: showGlow ? 8 : 0,
      shadowColor: color,
    },
    emphasis: { lineStyle: { width: 2.5 } },
    z: 5,
  }));

  const markData = [
    { xAxis: 600, name: "10:00\nearly" },
    { xAxis: 1200, name: "20:00\nmid" },
    ...markers.map((marker, index) => ({ xAxis: marker, name: `Marker ${index + 1}` })),
    { xAxis: currentTime, name: "" },
  ];

  measuredLines[measuredLines.length - 1].markLine = {
    silent: true,
    symbol: ["none", "none"],
    label: { show: false },
    lineStyle: { color: "#cbd2dd", type: "dashed", width: 1, opacity: 0.45 },
    data: markData,
  };

  return {
    animation: true,
    backgroundColor: "transparent",
    grid: { left: 158, right: 50, top: 38, bottom: 18 },
    tooltip: {
      trigger: "axis",
      backgroundColor: "#0b1220",
      borderColor: "#334055",
      textStyle: { color: "#f5f7fa", fontFamily: "Inter" },
      axisPointer: { type: "line", lineStyle: { color: "#d6deeb", opacity: 0.35 } },
      formatter: (items) => {
        const time = numeric(items?.[0]?.value?.[0], 0);
        const nearest = rows.reduce((best, row) => (
          Math.abs(numeric(row.midpoint_seconds, 0) - time) < Math.abs(numeric(best.midpoint_seconds, 0) - time) ? row : best
        ), rows[0]);
        if (!nearest) return `<b>${formatTime(time)}</b>`;
        return [
          `<b>${formatTime(time)} · measured window</b>`,
          `<span style="color:${COLORS.eeg}">EEG exponent</span> ${formatMetricValue(numeric(nearest.eeg_exponent), 2)}`,
          `<span style="color:${COLORS.horizontal}">Horizontal</span> ${formatMetricValue(numeric(nearest.horizontal_saccades_per_min), 1)}/min`,
          `<span style="color:${COLORS.vertical}">Vertical</span> ${formatMetricValue(numeric(nearest.vertical_saccades_per_min), 1)}/min`,
          `<span style="color:${COLORS.blinks}">Blinks</span> ${formatMetricValue(numeric(nearest.blink_rate_per_min), 1)}/min`,
        ].join("<br/>");
      },
    },
    xAxis: {
      type: "value",
      min: 0,
      max: DURATION_SECONDS,
      position: "top",
      interval: 300,
      axisLine: { lineStyle: { color: "#334052", opacity: 0.9 } },
      axisTick: { show: true, lineStyle: { color: "#536074" } },
      axisLabel: {
        color: "#7d8797",
        fontFamily: "IBM Plex Mono",
        fontSize: 10,
        formatter: (value) => `${Math.round(value / 60)}`,
      },
      splitLine: { show: false },
    },
    yAxis: { type: "value", min: 0.45, max: 4.55, show: false },
    series: [
      ...glowLines,
      ...measuredPoints,
      ...measuredLines,
      {
        name: "Measured blink candidates",
        type: "scatter",
        data: blinkEvents.map((event, index) => [
          numeric(event.time_seconds, 0),
          0.88 + Math.sin(index * 2.17) * 0.045,
          Math.min(60, Math.abs(numeric(event.vertical_z, 6))),
        ]),
        symbol: "rect",
        symbolSize: (value) => [1.1, 5 + Math.min(44, value[2] * 0.7)],
        itemStyle: {
          color: COLORS.blinks,
          opacity: 0.48,
          shadowBlur: showGlow ? 6 : 0,
          shadowColor: COLORS.blinks,
        },
        silent: true,
        z: 4,
      },
    ],
  };
}

function SignalLabel({ top, title, color, detail, metric }) {
  return (
    <div className="signal-label" style={{ top }}>
      <span className="signal-name">{title}</span>
      <span className="signal-band">{detail}</span>
      <span className="signal-metric" style={{ color }}>{metric}</span>
    </div>
  );
}

function ScaleGuide({ top, height, labels }) {
  return (
    <div className="scale-guide" style={{ top, height }} aria-hidden="true">
      {labels.map((label) => <span key={label}>{label}</span>)}
    </div>
  );
}

function ValueAnnotation({ metric, phase }) {
  const summary = phase.metrics[metric.key];
  return (
    <div className={`value-annotation ${metric.className} ${phase.key}`} data-source="movement-windows">
      <strong>{formatMetricValue(summary.median, metric.decimals)}</strong>
      <small>IQR {formatMetricValue(summary.q1, metric.decimals)}–{formatMetricValue(summary.q3, metric.decimals)}</small>
    </div>
  );
}

function MetricRow({ metric, phaseSummaries }) {
  const summaries = phaseSummaries.map((phase) => phase.metrics[metric.key]);
  const early = summaries[0]?.median;
  const end = summaries[2]?.median;
  const final = summaries[2];
  const values = summaries.map((summary) => formatMetricValue(summary?.median, metric.decimals)).join(" → ");
  return (
    <div className="metric-row" data-source="movement-windows">
      <span className="metric-title">{metric.title}</span>
      <span className="metric-band">{metric.band} · phase medians</span>
      <div className="metric-values">{values}{metric.unit}</div>
      <div className="metric-foot">
        <span>Δ {formatSignedMetric(end - early, metric.decimals)}{metric.unit}</span>
        <span>final IQR {formatMetricValue(final?.q1, metric.decimals)}–{formatMetricValue(final?.q3, metric.decimals)}</span>
      </div>
    </div>
  );
}

function SideSection({ number, title, children, open, onToggle, dim = false }) {
  return (
    <section className={`side-section ${dim ? "dim" : ""}`}>
      <button className="side-section-header" onClick={onToggle} aria-expanded={open}>
        <span><b>{number}</b>{title}</span>
        {open ? <CaretDown size={14} /> : <CaretRight size={14} />}
      </button>
      {open && <div className="side-section-body">{children}</div>}
    </section>
  );
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status})`);
  return response.text();
}

export function App() {
  const [rows, setRows] = useState([]);
  const [blinkEvents, setBlinkEvents] = useState([]);
  const [conditions, setConditions] = useState([]);
  const [selectedCondition, setSelectedCondition] = useState("Video");
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(648);
  const [speed, setSpeed] = useState(1);
  const [markers, setMarkers] = useState([]);
  const [showGlow, setShowGlow] = useState(true);
  const [showValueLabels, setShowValueLabels] = useState(true);
  const [openSections, setOpenSections] = useState({ measured: true, relation: true, question: true });
  const [drawer, setDrawer] = useState(null);
  const [toast, setToast] = useState("");
  const timerRef = useRef(null);

  useEffect(() => {
    Promise.all([
      fetchText(`${DATA_BASE}/movement_windows.csv`),
      fetchText(`${DATA_BASE}/eye_movement_candidates.csv`),
      fetchText(`${DATA_BASE}/condition_eye_movement_summary.csv`),
    ])
      .then(([windowText, eventText, conditionText]) => {
        setRows(parseCsv(windowText)
          .filter((row) => row.condition === "Video")
          .sort((a, b) => numeric(a.midpoint_seconds, 0) - numeric(b.midpoint_seconds, 0)));
        setBlinkEvents(parseCsv(eventText)
          .filter((event) => event.condition === "Video" && event.event_type === "blink-like")
          .sort((a, b) => numeric(a.time_seconds, 0) - numeric(b.time_seconds, 0)));
        setConditions(parseCsv(conditionText));
      })
      .catch(() => setToast("The analysis data could not be loaded."));
  }, []);

  useEffect(() => {
    if (!playing) return undefined;
    timerRef.current = window.setInterval(() => {
      setCurrentTime((time) => {
        if (time >= DURATION_SECONDS) {
          setPlaying(false);
          return DURATION_SECONDS;
        }
        return Math.min(DURATION_SECONDS, time + speed * 2);
      });
    }, 200);
    return () => window.clearInterval(timerRef.current);
  }, [playing, speed]);

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const phaseSummaries = useMemo(() => summarizeTemporalRows(rows), [rows]);
  const option = useMemo(
    () => getChartOption(rows, blinkEvents, currentTime, markers, showGlow),
    [rows, blinkEvents, currentTime, markers, showGlow],
  );
  const videoCondition = conditions.find((condition) => condition.condition === "Video");
  const acceptedWindows = numeric(videoCondition?.strict_eeg_accepted_windows, 0);
  const analysisWindow = numeric(rows[0]?.duration_seconds, 20);

  const addMarker = () => {
    const marker = Math.round(currentTime);
    setMarkers((existing) => [...existing, marker]);
    setToast(`Marker added at ${formatTime(marker)}`);
  };

  const exportCsv = () => {
    const link = document.createElement("a");
    link.href = `${DATA_BASE}/movement_windows.csv`;
    link.download = "pink-noise-eye-movement-windows.csv";
    link.click();
    setToast("Analysis table downloaded");
  };

  const selectCondition = (name) => {
    setSelectedCondition(name);
    setToast(`${name} compared with Video`);
  };

  return (
    <main className="app-shell" data-glow={showGlow} data-value-labels={showValueLabels}>
      <nav className="tool-rail" aria-label="Primary tools">
        <WaveSine size={29} weight="regular" className="brand-mark" />
        <div className="tool-group">
          <button className={`rail-button ${drawer === null ? "active" : ""}`} aria-label="Playback view" onClick={() => setDrawer(null)}><Play size={22} weight="fill" /></button>
          <button className={`rail-button ${drawer === "conditions" ? "active" : ""}`} aria-label="Compare conditions" onClick={() => setDrawer("conditions")}><ChartLine size={23} /></button>
          <button className={`rail-button ${drawer === "about" ? "active" : ""}`} aria-label="About this analysis" onClick={() => setDrawer("about")}><Info size={23} /></button>
          <button className="rail-button" aria-label="Download data" onClick={exportCsv}><DownloadSimple size={23} /></button>
          <button className={`rail-button ${drawer === "settings" ? "active" : ""}`} aria-label="Display controls" onClick={() => setDrawer("settings")}><SlidersHorizontal size={23} /></button>
          <button className={`rail-button ${drawer === "help" ? "active" : ""}`} aria-label="Help" onClick={() => setDrawer("help")}><Question size={23} /></button>
        </div>
        <div className="live-card"><span><i /> LIVE</span><small>offline<br />data</small></div>
      </nav>

      <section className="workspace">
        <header className="topbar">
          <div>
            <h1>Pink noise, 1/f structure, and eye movement</h1>
            <p>One video recording. Multiple signals. Different trajectories.</p>
            <div className="recording-meta">
              <span><i /> 31:31 recording</span><b>•</b><span>{acceptedWindows} of {rows.length || 94} strict windows accepted</span><b>•</b><span>{analysisWindow} s measured windows</span>
            </div>
          </div>
          <button className="caution" onClick={() => setDrawer("about")}>Different trajectories, not proof of causation. <Info size={13} /></button>
        </header>

        <div className="chart-stage">
          <div className="recording-time-label">Recording time (minutes)</div>
          <div className="phase-label early-phase"><b>10:00</b><span>early</span></div>
          <div className="phase-label mid-phase"><b>20:00</b><span>mid</span></div>
          <div className="phase-label end-phase"><b>31:31</b><span>end</span></div>
          <SignalLabel top="9%" title="Posterior EEG" detail="2–40 Hz" metric="EEG exponent · 1/f slope" color={COLORS.eeg} />
          <SignalLabel top="39%" title="Horizontal eye movement" detail="0.5–15 Hz" metric="candidates / min" color={COLORS.horizontal} />
          <SignalLabel top="62%" title="Vertical eye movement" detail="0.5–15 Hz" metric="candidates / min" color={COLORS.vertical} />
          <SignalLabel top="84%" title="Blinks" detail="candidate events" metric="candidates / min" color={COLORS.blinks} />
          <ScaleGuide top="10%" height="22%" labels={["2.0", "1.5", "1.0", "0.5", "0"]} />
          <ScaleGuide top="40%" height="14%" labels={["150", "100", "50", "0"]} />
          <ScaleGuide top="63%" height="12%" labels={["60", "40", "20", "0"]} />
          <ScaleGuide top="84%" height="10%" labels={["80", "40", "0"]} />
          <ReactECharts option={option} className="field-chart" notMerge lazyUpdate opts={{ renderer: "canvas" }} />
          {showValueLabels && rows.length > 0 && TEMPORAL_METRICS.flatMap((metric) => (
            phaseSummaries.map((phase) => <ValueAnnotation key={`${metric.key}-${phase.key}`} metric={metric} phase={phase} />)
          ))}
        </div>

        <footer className="playback">
          <button className="play-button" aria-label={playing ? "Pause recording" : "Play recording"} onClick={() => setPlaying((value) => !value)}>
            {playing ? <Pause size={28} weight="fill" /> : <Play size={29} weight="fill" />}
          </button>
          <div className="play-label"><b>{playing ? "Playing recording" : "Play recording"}</b><span>31:31 total</span></div>
          <div className="timeline-area">
            <input
              aria-label="Recording time"
              type="range"
              min="0"
              max={DURATION_SECONDS}
              value={currentTime}
              onChange={(event) => setCurrentTime(numeric(event.target.value, 0))}
              style={{ "--progress": `${(currentTime / DURATION_SECONDS) * 100}%` }}
            />
            <div className="timeline-times"><span>{formatTime(currentTime)}</span><span>31:31</span></div>
            <div className="legend">
              <span><i style={{ background: COLORS.eeg }} /> EEG exponent</span>
              <span><i style={{ background: COLORS.horizontal }} /> Horizontal EOG</span>
              <span><i style={{ background: COLORS.vertical }} /> Vertical EOG</span>
              <span><i style={{ background: COLORS.blinks }} /> Blinks</span>
            </div>
          </div>
          <label className="speed-control">
            <select value={speed} onChange={(event) => setSpeed(numeric(event.target.value, 1))} aria-label="Playback speed">
              <option value="0.5">0.5×</option><option value="1">1×</option><option value="2">2×</option>
            </select>
            <CaretDown size={13} />
          </label>
          <button className="marker-button" onClick={addMarker}><BookmarkSimple size={20} /> Add marker</button>
        </footer>
      </section>

      <aside className="analysis-rail">
        <SideSection number="01" title="Measured" open={openSections.measured} onToggle={() => setOpenSections((state) => ({ ...state, measured: !state.measured }))}>
          <p className="section-kicker">Measured phase medians · IQR</p>
          {TEMPORAL_METRICS.map((metric) => <MetricRow key={metric.key} metric={metric} phaseSummaries={phaseSummaries} />)}
        </SideSection>
        <SideSection number="02" title="Relation" open={openSections.relation} onToggle={() => setOpenSections((state) => ({ ...state, relation: !state.relation }))}>
          <p className="relation-copy">Across measured phase medians, posterior EEG exponent steepens while horizontal and vertical candidate rates decline; blink rates vary on a separate trajectory.</p>
          <p className="caveat-copy">After removing the shared passage of time, direct EEG–eye coupling was weak. The trajectories coexist; they do not establish causation.</p>
        </SideSection>
        <SideSection number="03" title="Question" dim open={openSections.question} onToggle={() => setOpenSections((state) => ({ ...state, question: !state.question }))}>
          <p className="question-copy">What conditions support this shift in 1/f structure?</p>
          <p className="question-copy">How do visual states relate to these dynamics?</p>
          <button className="notes-button" onClick={() => setDrawer("notes")}>View analysis notes <ArrowSquareOut size={14} /></button>
        </SideSection>
        <div className="disclaimer">This is an exploratory scientific visualization. Not a diagnostic tool. <Info size={18} /></div>
      </aside>

      {drawer && (
        <div className="drawer-backdrop" onMouseDown={() => setDrawer(null)}>
          <aside className="drawer" onMouseDown={(event) => event.stopPropagation()}>
            <button className="drawer-close" onClick={() => setDrawer(null)} aria-label="Close panel"><X size={20} /></button>
            {drawer === "conditions" && <ConditionDrawer conditions={conditions} selectedName={selectedCondition} onSelect={selectCondition} />}
            {drawer === "about" && <AboutDrawer />}
            {drawer === "settings" && (
              <SettingsDrawer
                showGlow={showGlow}
                showValueLabels={showValueLabels}
                onGlowChange={setShowGlow}
                onValueLabelsChange={setShowValueLabels}
              />
            )}
            {drawer === "help" && <HelpDrawer />}
            {drawer === "notes" && <NotesDrawer />}
          </aside>
        </div>
      )}
      {toast && <div className="toast"><Check size={17} weight="bold" />{toast}</div>}
    </main>
  );
}

function ConditionDrawer({ conditions, selectedName, onSelect }) {
  const video = conditions.find((condition) => condition.condition === "Video");
  const selected = conditions.find((condition) => condition.condition === selectedName) ?? video;
  return <>
    <span className="drawer-eyebrow">Compare conditions</span>
    <h2>Six measured contexts</h2>
    <p className="drawer-lede">Select a condition to compare its measured medians and condition-level EEG fit with the Video reference.</p>
    <div className="condition-list" aria-label="Condition summaries">
      {conditions.length === 0 && <p className="drawer-empty">Loading condition summary…</p>}
      {conditions.map((condition) => {
        const name = condition.condition;
        const selectedState = name === selected?.condition;
        return (
          <button key={name} className={selectedState ? "selected" : ""} aria-pressed={selectedState} onClick={() => onSelect(name)}>
            <span><Eye size={19} /><b>{name}</b><small>{conditionQuality(condition)}</small></span>
            <strong>{formatMetricValue(numeric(condition.eeg_exponent_condition_fit), 2)}</strong>
            <em>EEG exponent</em>
            <CaretRight size={14} />
          </button>
        );
      })}
    </div>
    {selected && video && (
      <section className="condition-comparison" aria-live="polite" data-source="condition-eye-movement-summary">
        <div className="condition-comparison-heading">
          <span>{selected.condition === "Video" ? "Temporal reference" : `${selected.condition} vs Video`}</span>
          <small>{conditionQuality(selected)}</small>
        </div>
        <div className="comparison-grid">
          {CONDITION_METRICS.map((metric) => {
            const value = numeric(selected[metric.key]);
            const videoValue = numeric(video[metric.key]);
            const delta = value - videoValue;
            return (
              <div className="comparison-metric" key={metric.key}>
                <span>{metric.label}</span>
                <strong>{formatMetricValue(value, metric.decimals)} <small>{metric.unit}</small></strong>
                <em>{selected.condition === "Video" ? "Video baseline" : `${formatSignedMetric(delta, metric.decimals)} ${metric.unit} vs Video`}</em>
              </div>
            );
          })}
        </div>
      </section>
    )}
  </>;
}

function AboutDrawer() {
  return <>
    <span className="drawer-eyebrow">How to read this</span>
    <h2>A field of measured changes</h2>
    <p className="drawer-lede">Each temporal line passes through values from the 20-second Video windows in movement_windows.csv. The labels summarize those same rows with phase medians and interquartile ranges.</p>
    <div className="plain-card"><Pulse size={22} color={COLORS.eeg} /><div><b>1/f exponent</b><p>A steeper exponent means relatively less high-frequency power. It is a property of the spectrum, not consciousness itself.</p></div></div>
    <div className="plain-card"><Eye size={22} color={COLORS.horizontal} /><div><b>Eye movement</b><p>Horizontal and vertical candidate rates describe movement in the EOG channels. Polarity was not calibrated, so anatomical direction is not claimed.</p></div></div>
    <div className="plain-card"><Info size={22} color={COLORS.blinks} /><div><b>Pilot limits</b><p>One participant, fixed condition order, no gaze-video ground truth, and a vertical EOG channel that also contains blinks.</p></div></div>
  </>;
}

function SettingsDrawer({ showGlow, showValueLabels, onGlowChange, onValueLabelsChange }) {
  return <>
    <span className="drawer-eyebrow">Display controls</span><h2>Shape the view</h2>
    <p className="drawer-lede">These controls change presentation only; they do not alter the measured values or summaries.</p>
    <label className="toggle-row"><span><b>Signal glow</b><small>Emphasize measured trajectory density</small></span><input aria-label="Signal glow" type="checkbox" checked={showGlow} onChange={(event) => onGlowChange(event.target.checked)} /></label>
    <label className="toggle-row"><span><b>Value labels</b><small>Show phase medians and IQRs</small></span><input aria-label="Value labels" type="checkbox" checked={showValueLabels} onChange={(event) => onValueLabelsChange(event.target.checked)} /></label>
    <div className="plain-card"><GearSix size={22} /><div><b>Scientific defaults are locked</b><p>Welch PSD, 2–40 Hz EEG exponent, 0.5–15 Hz EOG filtering, and validated candidate thresholds remain unchanged.</p></div></div>
  </>;
}

function HelpDrawer() {
  return <><span className="drawer-eyebrow">Quick guide</span><h2>Read from top to bottom</h2><ol className="help-list"><li><b>EEG:</b> measured aperiodic exponent in each Video window.</li><li><b>Horizontal EOG:</b> lateral candidate rate per measured window.</li><li><b>Vertical EOG:</b> vertical candidate rate, excluding blink neighborhoods.</li><li><b>Blinks:</b> window rate plus individual adaptive candidate events.</li><li><b>Measured → Relation → Question:</b> evidence first, interpretation second, inquiry third.</li></ol></>;
}

function NotesDrawer() {
  return <><span className="drawer-eyebrow">Analysis notes</span><h2>What the video result can—and cannot—say</h2><p className="drawer-lede">Measured phase medians show a higher posterior EEG exponent late in the video and lower horizontal and vertical candidate rates. Blink rate does not follow the same change.</p><div className="note-block"><b>Most important caution</b><p>The raw horizontal EOG–EEG correlation was negative, but became weak after removing their shared time trends. The app therefore presents parallel trajectories, not a mechanism.</p></div><div className="note-block"><b>Nail-informed reading</b><p>The useful philosophical move is relational: ask how heterogeneous processes compose a field over time. The visualization does not identify pink noise with consciousness.</p></div></>;
}
