import type { HourlyMetric, SimulationResult } from "./types";

type Props = {
  result: SimulationResult;
  modeLabel: string;
  isPartial: boolean;
  asOfLabel: string;
  onInspectHour: (hour: number) => void;
  onInspectArea: (area: string) => void;
};

function ResourceHealth({ result }: { result: SimulationResult }) {
  const metrics = [
    ["Reach trucks", result.kpis.reach_truck_utilization * 100, `${Math.round(result.kpis.reach_truck_utilization * 100)}% used`],
    ["Dock doors", result.kpis.dock_utilization * 100, `${Math.round(result.kpis.dock_utilization * 100)}% used`],
    ["Truck completion", result.kpis.trucks ? result.kpis.completed_trucks / result.kpis.trucks * 100 : 0, `${result.kpis.completed_trucks}/${result.kpis.trucks}`],
  ] as const;
  return <div className="analytics-card resource-card"><div className="card-heading"><div><p className="eyebrow">RESOURCE HEALTH</p><h3>Capacity used in this report window</h3></div></div><div className="resource-health">{metrics.map(([label, value, text]) => <div key={label}><span>{label}<b>{text}</b></span><div><i className={value >= 85 ? "critical" : value >= 70 ? "warning" : ""} style={{ width: `${Math.min(100, value)}%` }} /></div></div>)}</div></div>;
}

function ReadinessChart({ result }: { result: SimulationResult }) {
  const shipments = (result.shipment_schedule ?? []).filter((item) => item.planned_slot_minutes <= result.duration_minutes);
  const values = shipments.map((item) => ({ ...item, difference: item.production_ready_minutes - item.planned_slot_minutes }));
  const maximum = Math.max(1, ...values.map((item) => Math.abs(item.difference)));
  return <div className="analytics-card readiness-card"><div className="card-heading"><div><p className="eyebrow">SLOT READINESS</p><h3>Was production ready for each booked truck?</h3></div><span className="table-hint">Orange means product became ready after the slot</span></div><div className="readiness-chart">{values.slice(0, 14).map((item) => <div key={item.shipment_id}><b>{item.shipment_id}</b><div><i className={item.difference > 0 ? "late" : "early"} style={{ width: `${Math.max(3, Math.abs(item.difference) / maximum * 100)}%` }} /></div><span>{item.difference > 0 ? `+${Math.round(item.difference)} min late` : `${Math.abs(Math.round(item.difference))} min early`}</span></div>)}</div></div>;
}

function FindingsCard({ result }: { result: SimulationResult }) {
  return <div className="analytics-card findings-card"><div className="card-heading"><div><p className="eyebrow">MODEL FINDINGS</p><h3>What the evidence says</h3></div></div><ol>{result.findings.slice(0, 5).map((finding, index) => <li key={index}><b>{String(index + 1).padStart(2, "0")}</b><span>{finding}</span></li>)}</ol></div>;
}

function ChartLegend() {
  return (
    <div className="chart-legend">
      <span><i className="stress" />Stress</span>
      <span><i className="queue" />Pick queue</span>
      <span><i className="tat" />Truck TAT</span>
    </div>
  );
}

function HourlyPerformanceChart({ hourly, onInspectHour }: { hourly: HourlyMetric[]; onInspectHour: (hour: number) => void }) {
  const maxQueue = Math.max(1, ...hourly.map((item) => item.picking_queue_peak));
  const maxTat = Math.max(1, ...hourly.map((item) => item.average_turnaround_minutes));
  const width = 900;
  const height = 220;
  const padding = { top: 18, right: 20, bottom: 30, left: 34 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const step = chartWidth / Math.max(1, hourly.length);
  const linePoints = (selector: (metric: HourlyMetric) => number, maximum: number) => hourly.map((metric, index) => `${padding.left + step * index + step / 2},${padding.top + chartHeight - selector(metric) / maximum * chartHeight}`).join(" ");

  return (
    <div className="analytics-card performance-card">
      <div className="card-heading"><div><p className="eyebrow">HOURLY PERFORMANCE</p><h3>Where pressure built during the run</h3></div><ChartLegend /></div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Hourly stress, picking queue, and turnaround time">
        {[0, 25, 50, 75, 100].map((tick) => {
          const y = padding.top + chartHeight - tick / 100 * chartHeight;
          return <g key={tick}><line x1={padding.left} x2={width - padding.right} y1={y} y2={y} className="chart-grid-line" /><text x={4} y={y + 4} className="chart-axis-label">{tick}</text></g>;
        })}
        {hourly.map((metric, index) => {
          const x = padding.left + step * index;
          const barHeight = metric.stress_score / 100 * chartHeight;
          return (
            <g key={`${metric.hour}-${index}`} className="chart-hour" onClick={() => onInspectHour(metric.hour)}>
              <rect x={x + step * 0.12} y={padding.top + chartHeight - barHeight} width={step * 0.76} height={barHeight} className={metric.stress_score >= 75 ? "stress-bar critical" : metric.stress_score >= 50 ? "stress-bar warning" : "stress-bar"} />
              {(index % 2 === 0 || hourly.length < 14) && <text x={x + step / 2} y={height - 8} textAnchor="middle" className="chart-axis-label">{String(metric.hour).padStart(2, "0")}</text>}
              <title>{`${metric.hour}:00 — stress ${metric.stress_score}, queue ${metric.picking_queue_peak}, TAT ${metric.average_turnaround_minutes} min`}</title>
            </g>
          );
        })}
        <polyline points={linePoints((metric) => metric.picking_queue_peak, maxQueue)} className="chart-line queue" />
        <polyline points={linePoints((metric) => metric.average_turnaround_minutes, maxTat)} className="chart-line tat" />
      </svg>
      <p className="chart-note">Click any hour to return to the 3D view at that point in the run.</p>
    </div>
  );
}

function ThroughputChart({ hourly }: { hourly: HourlyMetric[] }) {
  const maximum = Math.max(1, ...hourly.flatMap((item) => [item.truck_arrivals, item.completed_trucks]));
  return (
    <div className="analytics-card throughput-card">
      <div className="card-heading"><div><p className="eyebrow">FLOW BALANCE</p><h3>Arrivals versus departures</h3></div></div>
      <div className="throughput-bars">
        {hourly.map((metric, index) => (
          <div className="throughput-hour" key={`${metric.hour}-${index}`} title={`${metric.hour}:00 — ${metric.truck_arrivals} arrivals, ${metric.completed_trucks} completed`}>
            <div><i className="arrival" style={{ height: `${metric.truck_arrivals / maximum * 100}%` }} /><i className="departure" style={{ height: `${metric.completed_trucks / maximum * 100}%` }} /></div>
            {(index % 3 === 0) && <span>{String(metric.hour).padStart(2, "0")}</span>}
          </div>
        ))}
      </div>
      <div className="mini-legend"><span><i className="arrival" />Arrivals</span><span><i className="departure" />Completed</span></div>
    </div>
  );
}

function DelayContribution({ result }: { result: SimulationResult }) {
  const maximum = Math.max(1, ...result.delay_analysis.map((item) => item.total_delay_minutes));
  return (
    <div className="analytics-card delay-card">
      <div className="card-heading"><div><p className="eyebrow">TIME CONTRIBUTION</p><h3>Total elapsed time by process</h3></div></div>
      <div className="delay-bars">
        {result.delay_analysis.map((item) => (
          <div key={item.stage}>
            <span>{item.display_name}</span>
            <div><i className={item.severity} style={{ width: `${item.total_delay_minutes / maximum * 100}%` }} /></div>
            <strong>{Math.round(item.total_delay_minutes)} min</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

const areaForStage: Record<string, string> = {
  production: "PRODUCTION-OUT",
  gate: "GATE",
  picking: "RACK-A",
  yard: "HOLDING-YARD",
  loading: "DOCK-APRON",
  exit: "GATE",
};

const LEVEL_LABEL = { normal: "Normal", amber: "Amber", red: "Red" } as const;

/** Hour-by-hour stress per stress point (the starter-kit twin's heatmap). Click a cell to replay that hour. */
function StressHeatmap({ result, onInspectHour }: { result: SimulationResult; onInspectHour: (hour: number) => void }) {
  const hours = result.stress_hourly ?? [];
  const points = result.stress_points ?? [];
  if (!hours.length || !points.length) return null;
  const worstHour = hours.reduce((worst, row) => (Object.values(row.levels).filter((level) => level === "red").length > Object.values(worst.levels).filter((level) => level === "red").length ? row : worst), hours[0]);
  return (
    <div className="analytics-card heatmap-card">
      <div className="card-heading"><div><p className="eyebrow">STRESS HEATMAP</p><h3>Where and when each stress point turned amber or red</h3></div><span className="table-hint">Click a cell to replay that hour</span></div>
      <div className="heatmap-wrap">
        <table className="heatmap">
          <thead><tr><th />{hours.map((row, index) => <th key={index}>{String(row.hour).padStart(2, "0")}</th>)}</tr></thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.id}>
                <th><b>{point.number}</b>{point.label}</th>
                {hours.map((row, index) => {
                  const level = row.levels[point.id] ?? "normal";
                  const value = row.metrics[point.metric];
                  return <td key={index}><button className={`heat ${level}`} title={`${String(row.hour).padStart(2, "0")}:00 · ${point.label}: ${LEVEL_LABEL[level]}${value !== undefined ? ` (${point.metric} ${value})` : ""}`} onClick={() => onInspectHour(row.hour)} aria-label={`${point.label} at ${row.hour}:00 is ${LEVEL_LABEL[level]}`} /></td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="heatmap-insight">The worst hour is {String(worstHour.hour).padStart(2, "0")}:00, with {Object.values(worstHour.levels).filter((level) => level === "red").length} stress points red at once.</p>
    </div>
  );
}

function StatisticsCard({ result }: { result: SimulationResult }) {
  const stats = result.statistics;
  if (!stats) return null;
  const cost = (value: number) => (value >= 1e5 ? `₹${(value / 1e5).toFixed(1)} L` : `₹${Math.round(value).toLocaleString("en-IN")}`);
  return (
    <div className="analytics-card stats-card">
      <div className="card-heading"><div><p className="eyebrow">ACROSS {stats.replications} SIMULATED DAYS</p><h3>What this day costs, with its uncertainty</h3></div><span className="table-hint">95% confidence; the 3D replay shows the median day</span></div>
      <div className="stats-grid">
        <span><small>Average turnaround</small><b>{stats.turnaround_hours.mean.toFixed(2)} h</b><em>± {stats.turnaround_hours.ci95.toFixed(2)} h</em></span>
        <span><small>Past the {stats.slot_minutes / 60} h slot</small><b>{Math.round(stats.over_slot_pct)}%</b><em>of all trucks</em></span>
        <span><small>Yard overflows</small><b>{stats.yard_full_days}/{stats.replications}</b><em>days</em></span>
        <span><small>Cost of the day</small><b>{cost(stats.cost_inr.mean)}</b><em>± {cost(stats.cost_inr.ci95)}</em></span>
        <span><small>Task time from fill</small><b>×{stats.congestion_factor.toFixed(2)}</b><em>picks and putaways</em></span>
        <span><small>Line held</small><b>{stats.line_held_pallets}</b><em>pallets not produced</em></span>
      </div>
    </div>
  );
}

export function AnalyticsView({ result, modeLabel, isPartial, asOfLabel, onInspectHour, onInspectArea }: Props) {
  return (
    <div className="analytics-view">
      <div className="analytics-header">
        <div><p className="eyebrow">{isPartial ? "PAUSED-RUN ANALYSIS" : "FINAL RUN ANALYSIS"}</p><h2>Why the operation waited</h2><p>{modeLabel} · report {isPartial ? `through ${asOfLabel}` : "for the completed run"}. Only events inside this window are counted.</p></div>
        <div className="summary-pills"><span className={isPartial ? "partial-pill" : "final-pill"}><small>Report status</small>{isPartial ? `Partial · ${asOfLabel}` : "Complete"}</span><span><small>Primary constraint</small>{result.kpis.primary_bottleneck}</span><span><small>Completed</small>{result.kpis.completed_trucks}/{result.kpis.trucks}</span><span><small>Avg / P90 TAT</small>{result.kpis.average_turnaround_minutes}/{result.kpis.p90_turnaround_minutes} min</span></div>
      </div>
      <StatisticsCard result={result} />
      <StressHeatmap result={result} onInspectHour={onInspectHour} />
      <div className="analytics-grid">
        <HourlyPerformanceChart hourly={result.hourly} onInspectHour={onInspectHour} />
        <ThroughputChart hourly={result.hourly} />
        <DelayContribution result={result} />
        <ResourceHealth result={result} />
        <FindingsCard result={result} />
      </div>
      {result.mode === "historical_replay" && <ReadinessChart result={result} />}
      <div className="analytics-card table-card">
        <div className="card-heading"><div><p className="eyebrow">BOTTLENECK EVIDENCE</p><h3>Waiting and elapsed time by process stage</h3></div><span className="table-hint">Sorted by total time</span></div>
        <div className="analysis-table-wrap">
          <table className="analysis-table">
            <thead><tr><th>Process stage</th><th>Avg</th><th>P90</th><th>Maximum</th><th>Affected</th><th>Total time</th><th>Likely cause and action</th><th /></tr></thead>
            <tbody>
              {result.delay_analysis.map((item) => (
                <tr key={item.stage}>
                  <td><i className={`severity-dot ${item.severity}`} /><b>{item.display_name}</b></td>
                  <td>{item.average_wait_minutes.toFixed(1)} min</td>
                  <td>{item.p90_wait_minutes.toFixed(1)} min</td>
                  <td>{item.maximum_wait_minutes.toFixed(1)} min</td>
                  <td>{item.affected_entities} trucks</td>
                  <td><strong>{item.total_delay_minutes.toFixed(0)} min</strong></td>
                  <td><p>{item.cause}</p><small>{item.recommendation}</small></td>
                  <td><button onClick={() => onInspectArea(areaForStage[item.stage] ?? "OVERVIEW")}>View area →</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

