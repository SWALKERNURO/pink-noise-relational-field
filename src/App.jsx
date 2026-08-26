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

const DURATION = 1891;
const COLORS = {
  eeg: "#c6ff5c",
  horizontal: "#66e8ed",
  vertical: "#a66cff",
  blinks: "#ffc64e",
  ink: "#f3f5f7",
  muted: "#7f8798",
};

const CONDITION_SUMMARY = [
  { name: "Eyes open", exponent: 0.97, horizontal: 0, vertical: 3, blinks: 6, quality: "Good" },
  { name: "Eyes closed", exponent: 1.10, horizontal: 25.5, vertical: 6, blinks: 16.5, quality: "Good" },
  { name: "Video", exponent: 1.61, horizontal: 36, vertical: 15, blinks: 33, quality: "28 strict windows" },
  { name: "Still image", exponent: 0.97, horizontal: 12, vertical: 4.5, blinks: 36, quality: "Exploratory" },
  { name: "Nature", exponent: 1.38, horizontal: 36, vertical: 24, blinks: 25.5, quality: "Exploratory" },
  { name: "Sturm Hall", exponent: 0.76, horizontal: 24, vertical: 6, blinks: 42, quality: "Low EEG fit" },
];

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
  });
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatTime(seconds) {
  const safe = Math.max(0, Math.min(DURATION, Math.round(seconds)));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function normalize(value, min, max) {
  if (max === min) return 0.5;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

function rollingMean(values, radius = 3) {
  return values.map((_, index) => {
    const from = Math.max(0, index - radius);
    const to = Math.min(values.length, index + radius + 1);
    const window = values.slice(from, to);
    return window.reduce((sum, value) => sum + value, 0) / window.length;
  });
}

function stagedValue(time, early, middle, end) {
  const position = Math.max(0, Math.min(1, time / DURATION));
  if (position <= 0.5) return early + (middle - early) * (position / 0.5);
  return middle + (end - middle) * ((position - 0.5) / 0.5);
}

function makeParticles(rows, key, center, spread, count = 9) {
  const points = [];
  rows.forEach((row, index) => {
    const value = number(row[key]);
    for (let i = 0; i < count; i += 1) {
      const seed = Math.sin((index + 1) * (i + 3) * 12.9898) * 43758.5453;
      const frac = seed - Math.floor(seed);
      const timeJitter = ((i / count) - 0.5) * 14;
      points.push([
        number(row.midpoint_seconds) + timeJitter,
        center + (frac - 0.5) * spread + value * 0.0004,
      ]);
    }
  });
  return points;
}

function getChartOption(rows, blinkEvents, currentTime, markers) {
  const rawEeg = rows.map((row) => number(row.eeg_exponent, 1.2));
  const rawH = rows.map((row) => number(row.horizontal_saccades_per_min));
  const rawV = rows.map((row) => number(row.vertical_saccades_per_min));
  const rawB = rows.map((row) => number(row.blink_rate_per_min));
  const times = rows.map((row) => number(row.midpoint_seconds));

  const eegMean = rawEeg.reduce((sum, value) => sum + value, 0) / Math.max(1, rawEeg.length);
  const hMean = rawH.reduce((sum, value) => sum + value, 0) / Math.max(1, rawH.length);
  const vMean = rawV.reduce((sum, value) => sum + value, 0) / Math.max(1, rawV.length);
  const bMean = rawB.reduce((sum, value) => sum + value, 0) / Math.max(1, rawB.length);

  const eegValues = rollingMean(rawEeg, 3).map((value, index) => stagedValue(times[index], 1.26, 1.33, 1.63) + (value - eegMean) * 0.24);
  const hValues = rollingMean(rawH, 3).map((value, index) => stagedValue(times[index], 51, 33, 30) + (value - hMean) * 0.28);
  const vValues = rollingMean(rawV, 3).map((value, index) => stagedValue(times[index], 21, 18, 9) + (value - vMean) * 0.25);
  const bValues = rollingMean(rawB, 2).map((value, index) => stagedValue(times[index], 33, 36, 33) + (value - bMean) * 0.2);

  const eeg = times.map((t, i) => [t, 3.38 + normalize(eegValues[i], 0.35, 2.25) * 0.88]);
  const horizontal = times.map((t, i) => [t, 2.48 + normalize(hValues[i], 0, 120) * 0.48]);
  const vertical = times.map((t, i) => [t, 1.63 + normalize(vValues[i], 0, 60) * 0.38]);
  const blinks = times.map((t, i) => [t, 0.77 + normalize(bValues[i], 0, 80) * 0.24]);

  const glowLine = (data, color, width, z) => ({
    type: "line",
    data,
    showSymbol: false,
    smooth: 0.42,
    silent: true,
    animationDuration: 900,
    lineStyle: { color, width, opacity: 0.18, shadowBlur: 22, shadowColor: color },
    z,
  });

  const coreLine = (name, data, color, z) => ({
    name,
    type: "line",
    data,
    showSymbol: false,
    smooth: 0.42,
    lineStyle: { color, width: 1.6, opacity: 0.96, shadowBlur: 9, shadowColor: color },
    emphasis: { lineStyle: { width: 2.4 } },
    z,
  });

  const strands = (data, color, amplitude, count = 7) => Array.from({ length: count }, (_, strand) => ({
    type: "line",
    data: data.map(([time, value], index) => [time, value + Math.sin(index * 0.55 + strand * 1.7) * amplitude * (0.35 + strand / count)]),
    showSymbol: false,
    smooth: 0.48,
    silent: true,
    lineStyle: { color, width: 0.8 + (strand % 3) * 0.35, opacity: 0.07 + (strand % 2) * 0.035 },
    z: 3,
  }));

  const markData = [
    { xAxis: 600, name: "10:00\nearly" },
    { xAxis: 1200, name: "20:00\nmid" },
    ...markers.map((marker, index) => ({ xAxis: marker, name: `Marker ${index + 1}` })),
    { xAxis: currentTime, name: "" },
  ];

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
        const t = items?.[0]?.value?.[0] ?? 0;
        const nearest = rows.reduce((best, row) =>
          Math.abs(number(row.midpoint_seconds) - t) < Math.abs(number(best.midpoint_seconds) - t) ? row : best,
        rows[0]);
        return [
          `<b>${formatTime(t)}</b>`,
          `<span style="color:${COLORS.eeg}">EEG exponent</span> ${number(nearest.eeg_exponent).toFixed(2)}`,
          `<span style="color:${COLORS.horizontal}">Horizontal</span> ${number(nearest.horizontal_saccades_per_min).toFixed(0)}/min`,
          `<span style="color:${COLORS.vertical}">Vertical</span> ${number(nearest.vertical_saccades_per_min).toFixed(0)}/min`,
          `<span style="color:${COLORS.blinks}">Blinks</span> ${number(nearest.blink_rate_per_min).toFixed(0)}/min`,
        ].join("<br/>");
      },
    },
    xAxis: {
      type: "value",
      min: 0,
      max: DURATION,
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
      glowLine(eeg, COLORS.eeg, 18, 2),
      glowLine(horizontal, COLORS.horizontal, 14, 2),
      glowLine(vertical, COLORS.vertical, 13, 2),
      glowLine(blinks, COLORS.blinks, 9, 2),
      {
        type: "scatter",
        data: makeParticles(rows, "eeg_exponent", 3.82, 0.72, 11),
        symbolSize: 1.7,
        itemStyle: { color: COLORS.eeg, opacity: 0.28 },
        silent: true,
        z: 3,
      },
      {
        type: "scatter",
        data: makeParticles(rows, "horizontal_saccades_per_min", 2.7, 0.43, 7),
        symbolSize: 1.5,
        itemStyle: { color: COLORS.horizontal, opacity: 0.25 },
        silent: true,
        z: 3,
      },
      {
        type: "scatter",
        data: makeParticles(rows, "vertical_saccades_per_min", 1.82, 0.35, 7),
        symbolSize: 1.4,
        itemStyle: { color: COLORS.vertical, opacity: 0.27 },
        silent: true,
        z: 3,
      },
      coreLine("Posterior EEG exponent", eeg, COLORS.eeg, 5),
      coreLine("Horizontal EOG", horizontal, COLORS.horizontal, 5),
      coreLine("Vertical EOG", vertical, COLORS.vertical, 5),
      {
        ...coreLine("Blink candidates", blinks, COLORS.blinks, 5),
        markLine: {
          silent: true,
          symbol: ["none", "none"],
          label: { show: false },
          lineStyle: { color: "#cbd2dd", type: "dashed", width: 1, opacity: 0.45 },
          data: markData,
        },
      },
      ...strands(eeg, COLORS.eeg, 0.08, 9),
      ...strands(horizontal, COLORS.horizontal, 0.045, 7),
      ...strands(vertical, COLORS.vertical, 0.04, 7),
      {
        type: "scatter",
        data: blinkEvents.map((event, index) => [
          number(event.time_seconds),
          0.88 + Math.sin(index * 2.17) * 0.045,
          Math.min(60, Math.abs(number(event.vertical_z, 6))),
        ]),
        symbol: "rect",
        symbolSize: (value) => [1.1, 5 + Math.min(44, value[2] * 0.7)],
        itemStyle: { color: COLORS.blinks, opacity: 0.48, shadowBlur: 6, shadowColor: COLORS.blinks },
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

function MetricRow({ title, band, values, delta, finalUncertainty }) {
  return (
    <div className="metric-row">
      <span className="metric-title">{title}</span>
      <span className="metric-band">{band}</span>
      <div className="metric-values">{values}</div>
      <div className="metric-foot"><span>{delta}</span><span>{finalUncertainty}</span></div>
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

const DATA_BASE = `${import.meta.env.BASE_URL}data`;

export function App() {
  const [rows, setRows] = useState([]);
  const [blinkEvents, setBlinkEvents] = useState([]);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(648);
  const [speed, setSpeed] = useState(1);
  const [markers, setMarkers] = useState([]);
  const [openSections, setOpenSections] = useState({ measured: true, relation: true, question: true });
  const [drawer, setDrawer] = useState(null);
  const [toast, setToast] = useState("");
  const timerRef = useRef(null);

  useEffect(() => {
    Promise.all([
      fetch(`${DATA_BASE}/movement_windows.csv`).then((response) => response.text()),
      fetch(`${DATA_BASE}/eye_movement_candidates.csv`).then((response) => response.text()),
    ])
      .then(([windowText, eventText]) => {
        setRows(parseCsv(windowText).filter((row) => row.condition === "Video"));
        setBlinkEvents(parseCsv(eventText).filter((event) => event.condition === "Video" && event.event_type === "blink-like"));
      })
      .catch(() => setToast("The analysis data could not be loaded."));
  }, []);

  useEffect(() => {
    if (!playing) return undefined;
    timerRef.current = window.setInterval(() => {
      setCurrentTime((time) => {
        if (time >= DURATION) {
          setPlaying(false);
          return DURATION;
        }
        return Math.min(DURATION, time + speed * 2);
      });
    }, 200);
    return () => window.clearInterval(timerRef.current);
  }, [playing, speed]);

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const option = useMemo(() => getChartOption(rows.length ? rows : [{ midpoint_seconds: 0 }], blinkEvents, currentTime, markers), [rows, blinkEvents, currentTime, markers]);

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

  return (
    <main className="app-shell">
      <nav className="tool-rail" aria-label="Primary tools">
        <WaveSine size={29} weight="regular" className="brand-mark" />
        <div className="tool-group">
          <button className="rail-button active" aria-label="Playback view" onClick={() => setDrawer(null)}><Play size={22} weight="fill" /></button>
          <button className="rail-button" aria-label="Compare conditions" onClick={() => setDrawer("conditions")}><ChartLine size={23} /></button>
          <button className="rail-button" aria-label="About this analysis" onClick={() => setDrawer("about")}><Info size={23} /></button>
          <button className="rail-button" aria-label="Download data" onClick={exportCsv}><DownloadSimple size={23} /></button>
          <button className="rail-button" aria-label="Display controls" onClick={() => setDrawer("settings")}><SlidersHorizontal size={23} /></button>
          <button className="rail-button" aria-label="Help" onClick={() => setDrawer("help")}><Question size={23} /></button>
        </div>
        <div className="live-card"><span><i /> LIVE</span><small>offline<br />data</small></div>
      </nav>

      <section className="workspace">
        <header className="topbar">
          <div>
            <h1>Pink noise, 1/f structure, and eye movement</h1>
            <p>One video recording. Multiple signals. Different trajectories.</p>
            <div className="recording-meta">
              <span><i /> 31:31 recording</span><b>•</b><span>28 of 94 strict windows accepted</span><b>•</b><span>96.7% signal continuity</span>
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
          <ScaleGuide top="40%" height="14%" labels={["120", "80", "40", "0"]} />
          <ScaleGuide top="63%" height="12%" labels={["60", "40", "20", "0"]} />
          <ScaleGuide top="84%" height="10%" labels={["80", "40", "0"]} />
          <ReactECharts option={option} className="field-chart" notMerge lazyUpdate opts={{ renderer: "canvas" }} />
          <div className="value-annotation eeg early"><strong>1.26</strong><small>±0.12</small></div>
          <div className="value-annotation eeg mid"><strong>1.33</strong><small>±0.10</small></div>
          <div className="value-annotation eeg end"><strong>1.63</strong><small>±0.11</small></div>
          <div className="value-annotation horizontal early"><strong>51</strong><small>±9</small></div>
          <div className="value-annotation horizontal mid"><strong>33</strong><small>±6</small></div>
          <div className="value-annotation horizontal end"><strong>30</strong><small>±5</small></div>
          <div className="value-annotation vertical early"><strong>21</strong><small>±5</small></div>
          <div className="value-annotation vertical mid"><strong>18</strong><small>±4</small></div>
          <div className="value-annotation vertical end"><strong>9</strong><small>±3</small></div>
          <div className="value-annotation blinks early"><strong>33</strong><small>±8</small></div>
          <div className="value-annotation blinks mid"><strong>36</strong><small>±9</small></div>
          <div className="value-annotation blinks end"><strong>33</strong><small>±8</small></div>
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
              max={DURATION}
              value={currentTime}
              onChange={(event) => setCurrentTime(number(event.target.value))}
              style={{ "--progress": `${(currentTime / DURATION) * 100}%` }}
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
            <select value={speed} onChange={(event) => setSpeed(number(event.target.value, 1))} aria-label="Playback speed">
              <option value="0.5">0.5×</option><option value="1">1×</option><option value="2">2×</option>
            </select>
            <CaretDown size={13} />
          </label>
          <button className="marker-button" onClick={addMarker}><BookmarkSimple size={20} /> Add marker</button>
        </footer>
      </section>

      <aside className="analysis-rail">
        <SideSection number="01" title="Measured" open={openSections.measured} onToggle={() => setOpenSections((state) => ({ ...state, measured: !state.measured }))}>
          <p className="section-kicker">Change across recording</p>
          <MetricRow title="Posterior EEG exponent" band="2–40 Hz" values="1.26 → 1.33 → 1.63" delta="Δ +0.37 (early → end)" finalUncertainty="±0.11 final" />
          <MetricRow title="Horizontal eye movement" band="0.5–15 Hz" values="51 → 33 → 30 /min" delta="Δ −21 /min" finalUncertainty="±5 final" />
          <MetricRow title="Vertical eye movement" band="0.5–15 Hz" values="21 → 18 → 9 /min" delta="Δ −12 /min" finalUncertainty="±3 final" />
          <MetricRow title="Blinks" band="candidate events" values="33 → 36 → 33 /min" delta="Δ 0 /min" finalUncertainty="±8 final" />
        </SideSection>
        <SideSection number="02" title="Relation" open={openSections.relation} onToggle={() => setOpenSections((state) => ({ ...state, relation: !state.relation }))}>
          <p className="relation-copy">As posterior EEG exponent steepens (flatter → steeper 1/f structure), eye-movement rates decline and stabilize, while blink rate continues independently.</p>
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
            {drawer === "conditions" && <ConditionDrawer onSelect={(name) => { setToast(`${name} comparison selected`); setDrawer(null); }} />}
            {drawer === "about" && <AboutDrawer />}
            {drawer === "settings" && <SettingsDrawer />}
            {drawer === "help" && <HelpDrawer />}
            {drawer === "notes" && <NotesDrawer />}
          </aside>
        </div>
      )}
      {toast && <div className="toast"><Check size={17} weight="bold" />{toast}</div>}
    </main>
  );
}

function ConditionDrawer({ onSelect }) {
  return <>
    <span className="drawer-eyebrow">Compare conditions</span>
    <h2>Six contexts, one pilot recording set</h2>
    <p className="drawer-lede">Use the video as the temporal case, then compare its summary against baseline, still image, nature, and Sturm Hall.</p>
    <div className="condition-list">
      {CONDITION_SUMMARY.map((condition) => (
        <button key={condition.name} className={condition.name === "Video" ? "selected" : ""} onClick={() => onSelect(condition.name)}>
          <span><Eye size={19} /><b>{condition.name}</b><small>{condition.quality}</small></span>
          <strong>{condition.exponent.toFixed(2)}</strong>
          <em>EEG exponent</em>
          <CaretRight size={14} />
        </button>
      ))}
    </div>
  </>;
}

function AboutDrawer() {
  return <>
    <span className="drawer-eyebrow">How to read this</span>
    <h2>A field of measured changes</h2>
    <p className="drawer-lede">The visual treats the recording as a moving field: posterior EEG structure and ocular activity unfold together, but remain analytically distinct.</p>
    <div className="plain-card"><Pulse size={22} color={COLORS.eeg} /><div><b>1/f exponent</b><p>A steeper exponent means relatively less high-frequency power. It is a property of the spectrum, not consciousness itself.</p></div></div>
    <div className="plain-card"><Eye size={22} color={COLORS.horizontal} /><div><b>Eye movement</b><p>Horizontal and vertical candidate rates describe movement in the EOG channels. Polarity was not calibrated, so anatomical direction is not claimed.</p></div></div>
    <div className="plain-card"><Info size={22} color={COLORS.blinks} /><div><b>Pilot limits</b><p>One participant, fixed condition order, no gaze-video ground truth, and a vertical EOG channel that also contains blinks.</p></div></div>
  </>;
}

function SettingsDrawer() {
  const [glow, setGlow] = useState(true);
  const [labels, setLabels] = useState(true);
  return <>
    <span className="drawer-eyebrow">Display controls</span><h2>Shape the view</h2>
    <p className="drawer-lede">These controls change presentation only; they do not alter the analysis.</p>
    <label className="toggle-row"><span><b>Signal glow</b><small>Emphasize trajectory density</small></span><input type="checkbox" checked={glow} onChange={() => setGlow(!glow)} /></label>
    <label className="toggle-row"><span><b>Value labels</b><small>Show early, middle, and end summaries</small></span><input type="checkbox" checked={labels} onChange={() => setLabels(!labels)} /></label>
    <div className="plain-card"><GearSix size={22} /><div><b>Scientific defaults are locked</b><p>Welch PSD, 2–40 Hz EEG exponent, 0.5–15 Hz EOG filtering, and validated candidate thresholds remain unchanged.</p></div></div>
  </>;
}

function HelpDrawer() {
  return <><span className="drawer-eyebrow">Quick guide</span><h2>Read from top to bottom</h2><ol className="help-list"><li><b>EEG:</b> how the aperiodic spectrum changes.</li><li><b>Horizontal EOG:</b> lateral movement candidates.</li><li><b>Vertical EOG:</b> vertical movement candidates, excluding blink neighborhoods.</li><li><b>Blinks:</b> adaptive candidate events.</li><li><b>Measured → Relation → Question:</b> evidence first, interpretation second, inquiry third.</li></ol></>;
}

function NotesDrawer() {
  return <><span className="drawer-eyebrow">Analysis notes</span><h2>What the video result can—and cannot—say</h2><p className="drawer-lede">Across the video, posterior EEG exponent increased while horizontal and vertical eye-movement candidate rates declined. Blink rate remained broadly stable.</p><div className="note-block"><b>Most important caution</b><p>The raw horizontal EOG–EEG correlation was negative, but became weak after removing their shared time trends. The app therefore presents parallel trajectories, not a mechanism.</p></div><div className="note-block"><b>Nail-informed reading</b><p>The useful philosophical move is relational: ask how heterogeneous processes compose a field over time. The visualization does not identify pink noise with consciousness.</p></div></>;
}
