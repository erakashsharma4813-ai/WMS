import { useEffect, useMemo, useRef, useState } from "react";

import { runCompare, runLevers, runSweep } from "./api";
import type { CompareResult, LeverResult, RunStatistics, SimulationSettings, SweepResult } from "./types";

type Props = {
  baseline: SimulationSettings;
  scenario: SimulationSettings;
  dayLabel: string;
  onOpenModel: (settings: SimulationSettings) => void;
};

const FILLS = [0.5, 0.7, 0.8, 0.85, 0.88, 0.9, 0.93, 0.95];
const SWEEP_DAYS = 10;
const SERIES = {
  gate: { label: "Pick at gate", colour: "var(--series-1)" },
  prepick: { label: "Pre-pick evening trucks", colour: "var(--series-2)" },
} as const;

const inr = (value: number) => (Math.abs(value) >= 1e5 ? `₹${(value / 1e5).toFixed(1)} L` : `₹${Math.round(value).toLocaleString("en-IN")}`);
const hours = (value: number) => `${value.toFixed(2)} h`;
const pct = (value: number) => `${Math.round(value)}%`;
const fillOf = (settings: SimulationSettings) => Number(settings.params.fillRate ?? 0.5);

function StatColumn({ title, subtitle, stats, accent }: { title: string; subtitle: string; stats: RunStatistics; accent?: boolean }) {
  return (
    <div className={`analytics-card compare-column${accent ? " accent" : ""}`}>
      <p className="eyebrow">{title}</p>
      <h3>{subtitle}</h3>
      <div className="compare-hero"><strong>{hours(stats.turnaround_hours.mean)}</strong><span>± {stats.turnaround_hours.ci95.toFixed(2)} h average turnaround · {stats.replications} days</span></div>
      <dl className="compare-stats">
        <dt>Trucks past the {stats.slot_minutes / 60} h slot</dt><dd>{pct(stats.over_slot_pct)}</dd>
        <dt>Days the holding yard overflows</dt><dd>{stats.yard_full_days} of {stats.replications}{stats.first_yard_full_hour !== null ? ` · from about ${String(Math.floor(stats.first_yard_full_hour)).padStart(2, "0")}:${String(Math.round((stats.first_yard_full_hour % 1) * 60)).padStart(2, "0")}` : ""}</dd>
        <dt>Evening trucks (report after 16:00)</dt><dd>{hours(stats.evening_turnaround_hours)}</dd>
        <dt>P90 turnaround</dt><dd>{hours(stats.p90_turnaround_hours)}</dd>
        <dt>Production line held</dt><dd>{stats.line_held_pallets} pallets</dd>
        <dt>Task-time factor from fill</dt><dd>×{stats.congestion_factor.toFixed(2)}</dd>
      </dl>
      <div className="compare-cost"><span>Cost of the day</span><strong>{inr(stats.cost_inr.mean)}</strong><small>detention {inr(stats.cost_inr.detention)} · missed slots {inr(stats.cost_inr.penalties)} · line stop {inr(stats.cost_inr.line_stop)}</small></div>
    </div>
  );
}

function KneeChart({ sweep, markFill, slotHours }: { sweep: SweepResult; markFill: number; slotHours: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const svg = useRef<SVGSVGElement>(null);
  const width = 1240;
  const height = 360;
  const pad = { top: 22, right: 230, bottom: 40, left: 56 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const all = sweep.curves.flatMap((curve) => curve.points);
  const yMax = Math.max(slotHours * 1.25, ...all.map((point) => point.turnaround_hours.mean + point.turnaround_hours.ci95)) * 1.05;
  const xMin = Math.min(...FILLS);
  const xMax = Math.max(...FILLS);
  const x = (fill: number) => pad.left + ((fill - xMin) / (xMax - xMin)) * plotW;
  const y = (value: number) => pad.top + plotH - (value / yMax) * plotH;
  const ticks = Array.from({ length: 5 }, (_, index) => (yMax / 4) * index);
  const fills = sweep.curves[0]?.points.map((point) => point.fill) ?? [];

  const move = (event: React.PointerEvent<SVGRectElement>) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box) return;
    const px = ((event.clientX - box.left) / box.width) * width;
    let best = 0;
    fills.forEach((fill, index) => {
      if (Math.abs(x(fill) - px) < Math.abs(x(fills[best]) - px)) best = index;
    });
    setHover(best);
  };

  const hovered = hover !== null ? sweep.curves.map((curve) => ({ policy: curve.policy, point: curve.points[hover] })) : null;
  return (
    <div className="analytics-card knee-card viz-root">
      <div className="card-heading">
        <div>
          <p className="eyebrow">THE KNEE</p>
          <h3>Turnaround against warehouse fill</h3>
          <p className="chart-sub">Average of {all[0]?.replications ?? 0} simulated days per point; shaded band is the 95% confidence range.</p>
        </div>
        <div className="chart-tools">
          <div className="chart-legend">{sweep.curves.map((curve) => <span key={curve.policy}><i style={{ background: SERIES[curve.policy].colour }} />{SERIES[curve.policy].label}</span>)}</div>
          <button className="table-toggle" onClick={() => setTable(!table)}>{table ? "Chart" : "Table"}</button>
        </div>
      </div>
      {table ? (
        <table className="knee-table">
          <thead><tr><th>Fill</th>{sweep.curves.map((curve) => <th key={curve.policy}>{SERIES[curve.policy].label}</th>)}{sweep.curves.map((curve) => <th key={`${curve.policy}-o`}>Past slot · {SERIES[curve.policy].label}</th>)}</tr></thead>
          <tbody>{fills.map((fill, index) => <tr key={fill}><td>{pct(fill * 100)}</td>{sweep.curves.map((curve) => <td key={curve.policy}>{hours(curve.points[index].turnaround_hours.mean)} ± {curve.points[index].turnaround_hours.ci95.toFixed(2)}</td>)}{sweep.curves.map((curve) => <td key={`${curve.policy}-o`}>{pct(curve.points[index].over_slot_pct)}</td>)}</tr>)}</tbody>
        </table>
      ) : (
        <div className="knee-plot">
          <svg ref={svg} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Average truck turnaround in hours against warehouse fill, for both picking policies">
            {ticks.map((tick) => <g key={tick}><line x1={pad.left} x2={pad.left + plotW} y1={y(tick)} y2={y(tick)} className="viz-grid" /><text x={pad.left - 8} y={y(tick) + 4} className="viz-axis" textAnchor="end">{tick.toFixed(1)} h</text></g>)}
            {fills.map((fill) => <text key={fill} x={x(fill)} y={pad.top + plotH + 18} className="viz-axis" textAnchor="middle">{Math.round(fill * 100)}%</text>)}
            <text x={pad.left + plotW / 2} y={height - 4} className="viz-axis-title" textAnchor="middle">Opening warehouse fill</text>
            <line x1={pad.left} x2={pad.left + plotW} y1={y(slotHours)} y2={y(slotHours)} className="viz-reference" />
            <text x={pad.left + 6} y={y(slotHours) - 6} className="viz-annotation">{slotHours} h delivery slot</text>
            <line x1={x(markFill)} x2={x(markFill)} y1={pad.top} y2={pad.top + plotH} className="viz-marker-line" />
            <text x={x(markFill)} y={pad.top - 4} className="viz-annotation" textAnchor="middle">your scenario · {Math.round(markFill * 100)}%</text>
            {sweep.curves.map((curve) => {
              const band = [...curve.points.map((point) => `${x(point.fill)},${y(point.turnaround_hours.mean + point.turnaround_hours.ci95)}`), ...[...curve.points].reverse().map((point) => `${x(point.fill)},${y(Math.max(0, point.turnaround_hours.mean - point.turnaround_hours.ci95))}`)].join(" ");
              const line = curve.points.map((point) => `${x(point.fill)},${y(point.turnaround_hours.mean)}`).join(" ");
              const last = curve.points[curve.points.length - 1];
              return (
                <g key={curve.policy}>
                  <polygon points={band} fill={SERIES[curve.policy].colour} opacity={0.14} />
                  <polyline points={line} fill="none" stroke={SERIES[curve.policy].colour} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                  {last && <text x={x(last.fill) + 10} y={y(last.turnaround_hours.mean) + 4} className="viz-direct-label">{SERIES[curve.policy].label} · {hours(last.turnaround_hours.mean)}</text>}
                </g>
              );
            })}
            {hover !== null && (
              <g>
                <line x1={x(fills[hover])} x2={x(fills[hover])} y1={pad.top} y2={pad.top + plotH} className="viz-crosshair" />
                {sweep.curves.map((curve) => <circle key={curve.policy} cx={x(fills[hover])} cy={y(curve.points[hover].turnaround_hours.mean)} r={4.5} fill={SERIES[curve.policy].colour} stroke="var(--surface-1)" strokeWidth={2} />)}
              </g>
            )}
            <rect x={pad.left} y={pad.top} width={plotW} height={plotH} fill="transparent" onPointerMove={move} onPointerLeave={() => setHover(null)} />
          </svg>
          {hovered && hover !== null && (
            <div className="viz-tooltip" style={{ left: `${(x(fills[hover]) / width) * 100}%` }}>
              <span className="viz-tooltip-title">{pct(fills[hover] * 100)} full</span>
              {hovered.map(({ policy, point }) => (
                <span key={policy} className="viz-tooltip-row"><i style={{ background: SERIES[policy].colour }} /><strong>{hours(point.turnaround_hours.mean)}</strong><em>± {point.turnaround_hours.ci95.toFixed(2)} · {pct(point.over_slot_pct)} past slot</em><small>{SERIES[policy].label}</small></span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function CompareView({ baseline, scenario, dayLabel, onOpenModel }: Props) {
  const [replications, setReplications] = useState(30);
  const [compare, setCompare] = useState<CompareResult | null>(null);
  const [sweep, setSweep] = useState<SweepResult | null>(null);
  const [levers, setLevers] = useState<LeverResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [brief, setBrief] = useState(false);

  const base = useMemo(() => ({ ...baseline, replications }), [baseline, replications]);
  const variant = useMemo(() => ({ ...scenario, replications }), [scenario, replications]);

  const lastRun = useRef("");
  const sweepKey = useRef("");

  // Results arrive progressively: the comparison first, then the levers, then
  // the knee (the sweep reuses cached days on the server when nothing changed).
  async function run(force = false) {
    const key = JSON.stringify([base, variant]);
    if (!force && key === lastRun.current) return;
    lastRun.current = key;
    setBusy(true);
    setError(null);
    try {
      setCompare(await runCompare(base, variant));
      setLevers(await runLevers(variant));
      const sweepScenario = { ...variant, replications: SWEEP_DAYS, params: Object.fromEntries(Object.entries(variant.params).filter(([name]) => name !== "fillRate" && name !== "policy")) };
      const nextSweepKey = JSON.stringify(sweepScenario);
      if (force || nextSweepKey !== sweepKey.current) {
        sweepKey.current = nextSweepKey;
        setSweep(await runSweep(sweepScenario, FILLS));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Comparison failed");
      lastRun.current = "";
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void run();
    // re-run only when the scenarios themselves change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(base), JSON.stringify(variant)]);

  const gate = sweep?.curves.find((curve) => curve.policy === "gate");
  const pre = sweep?.curves.find((curve) => curve.policy === "prepick");
  const actAt = gate?.points.find((point) => point.over_slot_pct >= 10);
  const story = [0.5, 0.85, 0.95].map((fill) => gate?.points.find((point) => Math.abs(point.fill - fill) < 1e-6)).filter(Boolean) as Array<RunStatistics & { fill: number }>;
  const slotHours = (compare?.variant.statistics.slot_minutes ?? 180) / 60;
  const changes = Object.entries(scenario.params).filter(([key, value]) => baseline.params[key] !== value);
  const best = levers?.levers.reduce((winner, row) => (row.turnaround_hours.mean < winner.turnaround_hours.mean ? row : winner), levers.levers[0]);

  return (
    <section className="compare-view">
      <header className="card-view-head">
        <div>
          <p className="eyebrow">COMPARE · {dayLabel}</p>
          <h2>Baseline against your scenario</h2>
          <p>Both run the same past day with the same random seeds (common random numbers), so the difference is the change you made, not luck.</p>
        </div>
        <div className="card-view-actions">
          <div className="kind-filter">{[10, 30].map((count) => <button key={count} className={replications === count ? "active" : ""} onClick={() => setReplications(count)}>{count} days</button>)}</div>
          <button className="analyze-action" disabled={!compare} onClick={() => setBrief(true)}>Share brief</button>
          <button className="teal-action" disabled={busy} onClick={() => void run(true)}>{busy ? "Simulating…" : "Run again"}</button>
        </div>
      </header>
      {error && <div className="yard-error inline">{error}</div>}
      {busy && !compare && <div className="analytics-card compare-loading">Simulating {replications} days for each scenario…</div>}

      {compare && (
        <div className={`compare-grid${busy ? " refreshing" : ""}`}>
          <StatColumn title="BASELINE" subtitle="Model card as it is" stats={compare.baseline.statistics} />
          <div className="analytics-card compare-diff">
            <p className="eyebrow">DIFFERENCE</p>
            <strong className={compare.difference_hours.mean < 0 ? "better" : compare.difference_hours.mean > 0 ? "worse" : ""}>{compare.difference_hours.mean > 0 ? "+" : ""}{compare.difference_hours.mean.toFixed(2)} h</strong>
            <span>± {compare.difference_hours.ci95.toFixed(2)} h (95%, paired)</span>
            <em className={`verdict ${compare.verdict === "real" ? "real" : "noise"}`}>{compare.verdict === "real" ? "A real difference" : "Within random noise"}</em>
            <p>{changes.length ? `You changed ${changes.map(([key, value]) => `${key} → ${value}`).join(", ")}.` : "No inputs changed yet: edit the What-if controls or the model card."}</p>
            <small>{compare.method}</small>
          </div>
          <StatColumn title="SCENARIO" subtitle={`${Math.round(fillOf(scenario) * 100)}% full · ${scenario.params.policy === "prepick" ? "pre-pick" : "pick at gate"}`} stats={compare.variant.statistics} accent />
        </div>
      )}

      {sweep ? <KneeChart sweep={sweep} markFill={fillOf(scenario)} slotHours={slotHours} /> : compare && <div className="analytics-card compare-loading">Sweeping warehouse fill from 50% to 95% for both policies ({SWEEP_DAYS} days per point)…</div>}

      {(sweep || levers) && (
        <div className="compare-lower">
          {sweep && <div className="analytics-card">
            <p className="eyebrow">ONE PAST DAY, THREE FILL LEVELS</p>
            <h3>Only the opening stock level changes</h3>
            <table className="demo-table">
              <thead><tr><th>Opening fill</th><th>Average turnaround</th><th>Trucks past slot</th><th>Yard overflows</th></tr></thead>
              <tbody>{story.map((point) => <tr key={point.fill}><td>{pct(point.fill * 100)}</td><td>{hours(point.turnaround_hours.mean)} <small>± {point.turnaround_hours.ci95.toFixed(2)}</small></td><td>{pct(point.over_slot_pct)}</td><td>{point.yard_full_days} of {point.replications}</td></tr>)}</tbody>
            </table>
            {actAt && <p className="act-at"><b>Act at {pct(actAt.fill * 100)}.</b> From there more than one truck in ten misses its slot when picking waits for the truck{pre ? `; pre-picking keeps it at ${pct(pre.points.find((point) => point.fill === actAt.fill)?.over_slot_pct ?? 0)}` : ""}.</p>}
          </div>}
          {levers && (
            <div className="analytics-card">
              <p className="eyebrow">LEVERS AT {pct(fillOf(scenario) * 100)} FULL</p>
              <h3>Which single change moves the day?</h3>
              <table className="demo-table">
                <thead><tr><th>Lever</th><th>Turnaround</th><th>Past slot</th><th>Cost</th><th /></tr></thead>
                <tbody>{levers.levers.map((row) => (
                  <tr key={row.lever} className={row === best ? "best" : ""}>
                    <td>{row.lever}</td><td>{hours(row.turnaround_hours.mean)} <small>± {row.turnaround_hours.ci95.toFixed(2)}</small></td><td>{pct(row.over_slot_pct)}</td><td>{inr(row.cost_inr.mean)}</td>
                    <td>{Object.keys(row.change).length > 0 && <button className="table-toggle" onClick={() => onOpenModel({ ...scenario, params: { ...scenario.params, ...row.change } })}>Watch in 3D</button>}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {brief && compare && (
        <div className="brief-overlay" role="dialog" aria-label="Share brief">
          <article className="brief-page">
            <header><p className="eyebrow">DISPATCH TWIN · SHARE BRIEF</p><h2>{dayLabel}</h2></header>
            <h3>The problem</h3>
            <p>At {pct(fillOf(scenario) * 100)} warehouse fill the average truck turnaround is {hours(compare.variant.statistics.turnaround_hours.mean)} (± {compare.variant.statistics.turnaround_hours.ci95.toFixed(2)} h over {compare.variant.statistics.replications} simulated days), against {hours(compare.baseline.statistics.turnaround_hours.mean)} in the baseline. {pct(compare.variant.statistics.over_slot_pct)} of trucks miss the {slotHours} h slot and the holding yard overflows on {compare.variant.statistics.yard_full_days} of {compare.variant.statistics.replications} days.</p>
            {best && <><h3>The lever</h3><p>{best.lever}: turnaround {hours(best.turnaround_hours.mean)}, {pct(best.over_slot_pct)} of trucks past slot.</p></>}
            <h3>The gain in money</h3>
            <p>Cost of the day falls from {inr(compare.variant.statistics.cost_inr.mean)} to {inr(best?.cost_inr.mean ?? compare.variant.statistics.cost_inr.mean)} (detention, missed delivery windows and line stops; rates from the model card, marked as assumptions until confirmed).</p>
            {actAt && <><h3>When to act</h3><p>Act at {pct(actAt.fill * 100)} full, not at 95%: past that point the queues multiply every slower task.</p></>}
            <footer>Results are averages of simulated days with random variation. Every number traces to the model card.</footer>
            <div className="brief-actions"><button className="analyze-action" onClick={() => window.print()}>Print or save as PDF</button><button className="teal-action" onClick={() => setBrief(false)}>Close</button></div>
          </article>
        </div>
      )}
    </section>
  );
}
