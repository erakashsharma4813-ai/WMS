import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { loadConfig, loadDays, loadModelCard, loadReplay, runFutures, runSimulation } from "./api";
import { AnalyticsView } from "./AnalyticsView";
import { CompareView } from "./CompareView";
import { FuturesView } from "./FuturesView";
import { ModelCardView } from "./ModelCardView";
import type { ConfigResponse, DaySummary, DisruptionId, Future, FuturesResult, ModelCard, SimulationResult, SimulationSettings, StressPoint, TraceEvent } from "./types";
import { showcaseSeconds, type Showcase } from "./scene/director";
import { buildDispatchShowcase, defaultHero, dispatchHeroes } from "./scene/flows/dispatch";
import { VideoRecorder } from "./scene/recorder";
import { WarehouseScene } from "./WarehouseScene";
import { alertsAt, buildAlerts, type ActiveAlert } from "./scene/alerts";
import { cargoCount, latestEvent, samplePose, type SceneModel } from "./scene/tracks";

type OperationalMode = "replay" | "stress" | "live";

const impactMap: Record<string, { label: string; targets: string[] }> = {
  fill: { label: "Every pick and putaway in the racks", targets: ["RACK-A", "RACK-B", "RACK-C", "RACK-D", "RACK-E", "RACK-F", "FG-BUFFER"] },
  policy: { label: "Pre-stage area, racks and marshalling", targets: ["PRESTAGE", "MARSHALLING", "RACK-A", "RACK-B"] },
  demand: { label: "Gate, yard, picking and docks", targets: ["GATE", "HOLDING-YARD", "RACK-A", "FG-BUFFER", "DOCK-APRON"] },
  docks: { label: "Dock apron and truck waiting", targets: ["DOCK-APRON", "D01", "D02", "D03", "D04", "D05", "D06"] },
  forklifts: { label: "Loading at the docks", targets: ["MARSHALLING", "DOCK-APRON"] },
  reach: { label: "Storage racks, buffer and marshalling", targets: ["RACK-A", "RACK-B", "RACK-C", "RACK-D", "RACK-E", "RACK-F", "FG-BUFFER", "MARSHALLING"] },
  lanes: { label: "Marshalling lanes", targets: ["MARSHALLING"] },
  readiness: { label: "Yard wait, marshalling and dock occupancy", targets: ["HOLDING-YARD", "MARSHALLING", "DOCK-APRON"] },
  booking: { label: "Gate, yard and docks", targets: ["GATE", "HOLDING-YARD", "DOCK-APRON"] },
};

function percentile(values: number[], fraction: number) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.round((ordered.length - 1) * fraction))];
}

function partialAnalysis(result: SimulationResult, cutoff: number): SimulationResult {
  if (cutoff >= result.duration_minutes - .01) return result;
  const trace = result.trace.filter((event) => event.time <= cutoff);
  const trucks = new Map<string, TraceEvent[]>();
  const reachIntervals: Array<[number, number]> = [];
  const dockIntervals: Array<[number, number]> = [];
  trace.filter((event) => event.entity_type === "truck").forEach((event) => trucks.set(event.entity_id, [...(trucks.get(event.entity_id) ?? []), event]));
  const durations: Record<string, number[]> = { gate: [], yard: [], loading: [], exit: [], picking: [], production: [] };
  const interval = (events: TraceEvent[], startState: string, endStates: string[]) => {
    const start = events.find((event) => event.state === startState);
    if (!start) return null;
    const end = events.find((event) => endStates.includes(event.state) && event.time >= start.time);
    return Math.max(0, (end?.time ?? cutoff) - start.time);
  };
  trucks.forEach((events) => {
    const gate = interval(events, "reported", ["yard_wait"]); if (gate !== null) durations.gate.push(gate);
    const yard = interval(events, "yard_wait", ["docked"]); if (yard !== null) durations.yard.push(yard);
    const loading = interval(events, "loading", ["loaded", "departed"]); if (loading !== null) durations.loading.push(loading);
    const loadingStart = events.find((event) => event.state === "loading");
    if (loadingStart) dockIntervals.push([loadingStart.time, events.find((event) => ["loaded", "departed"].includes(event.state) && event.time >= loadingStart.time)?.time ?? cutoff]);
    const exit = interval(events, "loaded", ["departed"]); if (exit !== null) durations.exit.push(exit);
  });
  const tasks = new Map<string, TraceEvent[]>();
  trace.filter((event) => event.entity_type === "reach_truck" && event.case_id).forEach((event) => tasks.set(event.case_id!, [...(tasks.get(event.case_id!) ?? []), event]));
  tasks.forEach((events) => {
    const start = events.find((event) => event.state === "picking" || event.state === "putaway");
    if (!start) return;
    const end = events.find((event) => event.state === "idle" && event.time >= start.time);
    const finish = end?.time ?? cutoff;
    reachIntervals.push([start.time, finish]);
    if (start.state === "picking") durations.picking.push(Math.max(0, finish - start.time));
  });
  // production readiness only exists in recorded and legacy traces; the engine reports it through stress points
  if (!result.contract) result.shipment_schedule?.filter((shipment) => shipment.planned_slot_minutes <= cutoff).forEach((shipment) => durations.production.push(Math.max(0, Math.min(shipment.production_ready_minutes, cutoff) - shipment.planned_slot_minutes)));
  const originalRows = new Map(result.delay_analysis.map((row) => [row.stage, row]));
  const delay_analysis = Object.entries(durations).map(([stage, values]) => {
    const original = originalRows.get(stage);
    const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    const maximum = Math.max(0, ...values);
    return {
      stage,
      display_name: original?.display_name ?? stage,
      average_wait_minutes: Number(average.toFixed(1)),
      p90_wait_minutes: Number(percentile(values, .9).toFixed(1)),
      maximum_wait_minutes: Number(maximum.toFixed(1)),
      affected_entities: values.filter((value) => value >= 10).length,
      total_delay_minutes: Number(values.reduce((sum, value) => sum + value, 0).toFixed(1)),
      severity: (average >= 60 || maximum >= 150 ? "critical" : average >= 20 || maximum >= 60 ? "warning" : "normal") as "normal" | "warning" | "critical",
      cause: original?.cause ?? "No completed evidence yet in this time window.",
      recommendation: original?.recommendation ?? "Continue the run to collect more evidence.",
    };
  }).sort((a, b) => b.total_delay_minutes - a.total_delay_minutes);
  const reported = [...trucks.values()].filter((events) => events.some((event) => event.state === "reported"));
  const completed = [...trucks.values()].filter((events) => events.some((event) => event.state === "departed"));
  const turnaround = completed.map((events) => (events.find((event) => event.state === "departed")!.time - events.find((event) => event.state === "reported")!.time));
  const capacityMinutes = Math.max(1, cutoff);
  const reachCount = Math.max(1, new Set(trace.filter((event) => event.entity_type === "reach_truck").map((event) => event.entity_id)).size || 3);
  const dockCount = Math.max(1, new Set(trace.filter((event) => event.entity_type === "truck" && event.location_id?.startsWith("D")).map((event) => event.location_id)).size || 4);
  const activeInWindow = (intervals: Array<[number, number]>, start: number, end: number) => intervals.reduce((sum, [begin, finish]) => sum + Math.max(0, Math.min(finish, end) - Math.max(begin, start)), 0);
  const reachUtilization = Math.min(1, activeInWindow(reachIntervals, 0, cutoff) / (reachCount * capacityMinutes));
  const dockUtilization = Math.min(1, activeInWindow(dockIntervals, 0, cutoff) / (dockCount * capacityMinutes));
  const startHour = siteHour(result.start_timestamp);
  const hourly = Array.from({ length: Math.max(1, Math.ceil(cutoff / 60)) }, (_, index) => {
    const begin = index * 60;
    const end = Math.min(cutoff, begin + 60);
    const arrivalEvents = trace.filter((event) => event.entity_type === "truck" && event.state === "reported" && event.time >= begin && event.time < end);
    const departureEvents = trace.filter((event) => event.entity_type === "truck" && event.state === "departed" && event.time >= begin && event.time < end);
    const hourTat = departureEvents.map((departure) => departure.time - (trucks.get(departure.entity_id)?.find((event) => event.state === "reported")?.time ?? departure.time));
    const reach = Math.min(1, activeInWindow(reachIntervals, begin, end) / (reachCount * Math.max(1, end - begin)));
    const dock = Math.min(1, activeInWindow(dockIntervals, begin, end) / (dockCount * Math.max(1, end - begin)));
    const warningPicks = trace.filter((event) => event.entity_type === "reach_truck" && event.state === "picking" && event.time >= begin && event.time < end && event.severity !== "normal").length;
    return { hour: (startHour + index) % 24, truck_arrivals: arrivalEvents.length, completed_trucks: departureEvents.length, average_turnaround_minutes: hourTat.length ? Number((hourTat.reduce((sum, value) => sum + value, 0) / hourTat.length).toFixed(1)) : 0, picking_queue_peak: warningPicks, reach_truck_utilization: Number(reach.toFixed(3)), dock_utilization: Number(dock.toFixed(3)), stress_score: Number(Math.min(100, reach * 65 + dock * 25 + warningPicks * 5).toFixed(1)) };
  });
  const worst = hourly.reduce((current, item) => item.stress_score > current.stress_score ? item : current, hourly[0]);
  const primary = delay_analysis[0]?.display_name ?? "Insufficient evidence";
  return {
    ...result,
    duration_minutes: cutoff,
    trace,
    hourly,
    delay_analysis,
    kpis: {
      ...result.kpis,
      trucks: reported.length,
      completed_trucks: completed.length,
      pallets: reported.reduce((sum, events) => sum + Number(events.find((event) => event.state === "reported")?.metadata.pallets ?? 0), 0),
      average_turnaround_minutes: turnaround.length ? Number((turnaround.reduce((sum, value) => sum + value, 0) / turnaround.length).toFixed(1)) : 0,
      p90_turnaround_minutes: Number(percentile(turnaround, .9).toFixed(1)),
      maximum_picking_queue: Math.max(0, ...hourly.map((item) => item.picking_queue_peak)),
      maximum_yard_queue: Math.max(0, ...trace.filter((event) => event.state === "yard_wait").map((event) => Number(event.metadata.yard_queue ?? 0))),
      reach_truck_utilization: Number(reachUtilization.toFixed(3)),
      dock_utilization: Number(dockUtilization.toFixed(3)),
      worst_hour: `${String(worst.hour).padStart(2, "0")}:00–${String((worst.hour + 1) % 24).padStart(2, "0")}:00`,
      primary_bottleneck: primary,
    },
    findings: [`Partial report using ${trace.length} events recorded through ${Math.round(cutoff)} minutes.`, ...result.findings],
  };
}

const DEFAULT_DAY = "DAY-2026-10-06";

const DISRUPTION_BUTTONS: Array<{ id: DisruptionId; key: string; icon: string; label: string; detail: string }> = [
  { id: "reach_truck_down", key: "1", icon: "🔧", label: "Reach truck down", detail: "one reach truck breaks down for 3 h" },
  { id: "rush_order", key: "2", icon: "⚡", label: "Rush order", detail: "6 extra trucks report in the next hour" },
  { id: "dock_down", key: "3", icon: "⛔", label: "Dock D02 out", detail: "dock door out of service for 4 h" },
  { id: "gate_clerk_out", key: "4", icon: "👤", label: "Gate clerk out", detail: "one gate lane closed for 3 h" },
];

const THEME_KEY = "dispatch-twin:theme";

/** Trucks that left after the fork, read from an event log (for the best-against-baseline counters). */
function sinceFork(trace: TraceEvent[], forkAt: number, now: number, slot: number) {
  let dispatched = 0;
  let onTime = 0;
  let tatSum = 0;
  for (const event of trace) {
    if (event.time > now) break;
    if (event.entity_type !== "truck" || event.state !== "departed" || event.time <= forkAt) continue;
    const tat = Number(event.metadata?.turnaround_minutes ?? 0);
    dispatched += 1;
    tatSum += tat;
    if (tat <= slot) onTime += 1;
  }
  return { dispatched, onTime, late: dispatched - onTime, tat: dispatched ? tatSum / dispatched / 60 : 0 };
}
const initialSettings: SimulationSettings = {
  day_id: DEFAULT_DAY,
  arrivals: "trace",
  chance: "sto",
  clock: 0,
  seed: 5000,
  replications: 30,
  params: {},
  rules: {},
  demand_multiplier: 1,
  live_as_of_minutes: null,
  slot_overrides: [],
};

const hasValidRunRef = (mode: string, scenarioHasRun: boolean) => mode === "replay" || scenarioHasRun;

function Toggle<T extends string | number>({ value, options, disabled, onChange }: { value: T; options: Array<[T, string]>; disabled?: boolean; onChange: (value: T) => void }) {
  return <div className="arrival-toggle">{options.map(([option, label]) => <button key={String(option)} disabled={disabled} className={value === option ? "active" : ""} onClick={() => onChange(option)}>{label}</button>)}</div>;
}

const LEVEL_ORDER = { red: 2, amber: 1, normal: 0 } as const;
type Level = keyof typeof LEVEL_ORDER;

/** Current level of every stress point, read from the engine's meter events. */
function meterLevels(trace: TraceEvent[], time: number) {
  const levels: Record<string, { level: Level; since: number; value: number }> = {};
  for (const event of trace) {
    if (event.time > time) break;
    if (!event.entity_id.startsWith("meter:")) continue;
    levels[event.entity_id.slice(6)] = { level: event.state as Level, since: event.time, value: Number(event.metadata?.value ?? 0) };
  }
  return levels;
}

type StoryStep = { at: number; target: string; caption: string };

function buildStory(result: SimulationResult, startTimestamp: string): StoryStep[] {
  const points = (result.stress_points ?? []).filter((point) => point.first_red !== null).sort((a, b) => (a.first_red ?? 0) - (b.first_red ?? 0));
  const steps: StoryStep[] = [];
  const first = result.trace.find((event) => event.entity_type === "truck");
  if (first) steps.push({ at: first.time, target: "GATE", caption: `${formatTime(startTimestamp, first.time)} · The day starts: the first truck reports at the gate.` });
  points.slice(0, 6).forEach((point) => steps.push({ at: Math.max(0, (point.first_red ?? 0) - 6), target: point.location, caption: `${formatTime(startTimestamp, point.first_red ?? 0)} · ${point.number}. ${point.label} turns red, and stays red for ${Math.round(point.red_minutes)} min.` }));
  if (!points.length) steps.push({ at: result.duration_minutes * 0.6, target: "OVERVIEW", caption: "No stress point reaches red on this day: the site absorbs the load." });
  const stats = result.statistics;
  steps.push({ at: Math.min(result.duration_minutes - 1, (steps[steps.length - 1]?.at ?? 0) + 45), target: "OVERVIEW", caption: stats ? `Over ${stats.replications} simulated days: ${stats.turnaround_hours.mean.toFixed(2)} h average turnaround, ${Math.round(stats.over_slot_pct)}% of trucks past the slot. Open Compare to test a lever.` : "Open Compare to test a lever." });
  return steps.sort((a, b) => a.at - b.at);
}

const focusAreas = [
  ["OVERVIEW", "⌂"],
  ["GATE", "G"],
  ["FG-BUFFER", "B"],
  ["RACK-A", "R"],
  ["MARSHALLING", "M"],
  ["DOCK-APRON", "D"],
] as const;

// Timestamps carry the site offset (e.g. +05:30). Read clock fields from the
// string itself so every viewer sees site time, not their browser's timezone.
function siteClock(timestamp: string) {
  const match = timestamp.match(/T(\d{2}):(\d{2})/);
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : { hour: 0, minute: 0 };
}

function siteHour(timestamp: string) {
  return siteClock(timestamp).hour;
}

function formatTime(startTimestamp: string, minutes: number) {
  const { hour, minute } = siteClock(startTimestamp);
  const total = Math.floor(hour * 60 + minute + minutes);
  const hh = ((Math.floor(total / 60) % 24) + 24) % 24;
  const mm = ((total % 60) + 60) % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function formatDay(timestamp: string) {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${timestamp.slice(0, 10)}T12:00:00Z`));
}

const EQUIPMENT_LEGEND = [
  { key: "17FT", label: "17 ft LCV", className: "truck-20" },
  { key: "20FT", label: "20 ft rigid", className: "truck-20" },
  { key: "32FT", label: "32 ft rigid", className: "truck-32" },
  { key: "40FT", label: "40 ft trailer", className: "truck-40" },
  { key: "reach_truck", label: "Reach truck", className: "reach" },
  { key: "forklift", label: "Forklift", className: "forklift" },
  { key: "pallet_truck", label: "Pallet truck", className: "pallet-truck" },
] as const;

function Slider({ label, value, min, max, step, suffix, disabled = false, onChange }: { label: string; value: number; min: number; max: number; step: number; suffix?: string; disabled?: boolean; onChange: (value: number) => void }) {
  return (
    <label className="yard-slider">
      <span><b>{label}</b><strong>{value}{suffix}</strong></span>
      <input type="range" value={value} min={min} max={max} step={step} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function Icon({ type }: { type: "truck" | "clock" | "box" | "alert" | "p90" }) {
  const symbol = { truck: "▰", clock: "T", box: "◇", alert: "!", p90: "90" }[type];
  return <span className={`metric-icon ${type}`}>{symbol}</span>;
}

function MetricCard({ label, value, note }: { label: string; value: string; note: string }) {
  return <article className="dock-metric" title={`${label}: ${value} · ${note}`}><span>{label}</span><strong>{value}</strong><small>{note}</small></article>;
}

function latestEntityStates(trace: TraceEvent[], currentTime: number) {
  const latest = new Map<string, TraceEvent>();
  trace.forEach((event) => {
    if (event.time <= currentTime) latest.set(event.entity_id, event);
  });
  return [...latest.values()];
}

type DoorSegment = { start: number; end: number; state: "seal" | "loading" | "paperwork" | "delay" | "outage"; truck: string; note: string };

const WAIT_AT_DOOR_MINUTES = 15;
const LONG_LOADING_MINUTES = 60;

/** Dock occupancy per door. Door-related delays are drawn in red with the reason in the tooltip. */
function DoorTimeline({ result, currentTime, onSeek, collapsed, onToggle }: { result: SimulationResult; currentTime: number; onSeek: (minute: number) => void; collapsed: boolean; onToggle: (id: string) => void }) {
  const rows = useMemo(() => {
    const byTruck = new Map<string, TraceEvent[]>();
    result.trace.forEach((event) => {
      if (event.entity_type === "truck") byTruck.set(event.entity_id, [...(byTruck.get(event.entity_id) ?? []), event]);
    });
    const used = [...byTruck.values()].flatMap((events) => events.filter((event) => event.state === "docked" && event.location_id).map((event) => event.location_id!));
    const dockIds = [...new Set(["D01", "D02", "D03", "D04", ...used])].sort();
    const segmentsByDock = new Map<string, DoorSegment[]>(dockIds.map((id) => [id, []]));
    byTruck.forEach((events, truck) => {
      const docked = events.find((event) => event.state === "docked");
      if (!docked?.location_id) return;
      const at = (state: string) => events.find((event) => event.state === state && event.time >= docked.time)?.time;
      const loading = at("loading");
      const loaded = at("loaded");
      const departed = at("departed");
      const loadEnd = loaded ?? Math.max((loading ?? docked.time) + 8, (departed ?? (loading ?? docked.time) + 45) - 18);
      const doorEnd = loaded !== undefined ? loaded : departed ?? loadEnd;
      const list = segmentsByDock.get(docked.location_id)!;
      const sealEnd = loading ?? docked.time + 8;
      const waited = sealEnd - docked.time;
      list.push({ start: docked.time, end: sealEnd, state: waited > WAIT_AT_DOOR_MINUTES ? "delay" : "seal", truck, note: waited > WAIT_AT_DOOR_MINUTES ? `${truck} held the door ${Math.round(waited)} min before loading started (pallets not ready)` : `${truck} · docking and gate check` });
      if (loading !== undefined) {
        const minutes = loadEnd - loading;
        list.push({ start: loading, end: Math.max(loading + 4, loadEnd), state: minutes > LONG_LOADING_MINUTES ? "delay" : "loading", truck, note: minutes > LONG_LOADING_MINUTES ? `${truck} loading took ${Math.round(minutes)} min (over ${LONG_LOADING_MINUTES})` : `${truck} · loading ${Math.round(minutes)} min` });
      }
      if (loaded === undefined && departed !== undefined) list.push({ start: Math.max(docked.time, departed - 18), end: departed, state: "paperwork", truck, note: `${truck} · paperwork at the door` });
      // a truck that runs past its delivery slot while it still occupies the door
      const slotRed = events.find((event) => event.metadata?.slot === "critical")?.time;
      if (slotRed !== undefined && slotRed < doorEnd) list.push({ start: Math.max(docked.time, slotRed), end: doorEnd, state: "delay", truck, note: `${truck} past its delivery slot while at the door` });
    });
    // a dock taken out of service by an injected disruption
    result.trace.filter((event) => event.entity_type === "system" && event.entity_id.startsWith("DOCK-") && event.state === "down").forEach((event) => {
      const dock = event.entity_id.slice(5);
      const back = result.trace.find((item) => item.entity_id === event.entity_id && item.state === "restored" && item.time >= event.time)?.time ?? result.duration_minutes;
      if (!segmentsByDock.has(dock)) segmentsByDock.set(dock, []);
      segmentsByDock.get(dock)!.push({ start: event.time, end: back, state: "outage", truck: event.entity_id, note: `Dock ${dock} out of service for ${Math.round(back - event.time)} min` });
    });
    return [...segmentsByDock.keys()].sort().map((dockId) => ({ dockId, segments: segmentsByDock.get(dockId)! }));
  }, [result]);

  const ticks = Array.from({ length: 8 }, (_, index) => index / 7 * result.duration_minutes);
  const delays = rows.reduce((sum, row) => sum + row.segments.filter((segment) => segment.state === "delay" && segment.start <= currentTime).length, 0);
  return (
    <Collapsible id="timeline" className="door-timeline-card" collapsed={collapsed} onToggle={onToggle} title={<><strong>Door timeline</strong><small>Click a block to jump to that truck</small></>} extra={<div className="door-legend"><span><i className="seal" />Docking</span><span><i className="loading" />Loading</span><span><i className="paperwork" />Paperwork</span><span><i className="delay" />Delay{delays ? ` (${delays})` : ""}</span>{rows.some((row) => row.segments.some((segment) => segment.state === "outage")) && <span><i className="outage" />Out of service</span>}</div>}>
      <div className="timeline-scale">{ticks.map((time) => <span key={time}>{formatTime(result.start_timestamp, time)}</span>)}</div>
      <div className="timeline-rows">
        {rows.map((row) => {
          const delayedNow = row.segments.some((segment) => (segment.state === "delay" || segment.state === "outage") && segment.start <= currentTime && segment.end >= currentTime);
          return (
            <div className={`timeline-row${delayedNow ? " delayed-now" : ""}`} key={row.dockId}>
              <b title={delayedNow ? "Delay at this door now" : undefined}>{row.dockId}</b>
              <div>
                {row.segments.map((segment, index) => <button key={`${segment.truck}-${segment.state}-${index}`} className={segment.state} style={{ left: `${segment.start / result.duration_minutes * 100}%`, width: `${Math.max(.8, (segment.end - segment.start) / result.duration_minutes * 100)}%` }} title={`${formatTime(result.start_timestamp, segment.start)}–${formatTime(result.start_timestamp, segment.end)} · ${segment.note}`} onClick={() => onSeek(segment.start)} />)}
                <i className="now-line" style={{ left: `${currentTime / result.duration_minutes * 100}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </Collapsible>
  );
}

const COLLAPSE_KEY = "dispatch-twin:collapsed";

function useCollapsed() {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "{}");
    } catch {
      return {};
    }
  });
  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = { ...current, [id]: !current[id] };
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        // storage unavailable: keep the in-memory state only
      }
      return next;
    });
  const set = (id: string, value: boolean) =>
    setCollapsed((current) => {
      const next = { ...current, [id]: value };
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        // storage unavailable: keep the in-memory state only
      }
      return next;
    });
  return { collapsed, toggle, set };
}

function Collapsible({ id, title, extra, className = "", collapsed, onToggle, children }: { id: string; title: ReactNode; extra?: ReactNode; className?: string; collapsed: boolean; onToggle: (id: string) => void; children: ReactNode }) {
  return (
    <section className={`glass-card collapsible ${className}${collapsed ? " collapsed" : ""}`}>
      <header className="collapsible-head">
        <button className="collapsible-toggle" aria-expanded={!collapsed} onClick={() => onToggle(id)}>
          <i aria-hidden>{collapsed ? "▸" : "▾"}</i>
          <span>{title}</span>
        </button>
        {extra}
      </header>
      {!collapsed && <div className="collapsible-body">{children}</div>}
    </section>
  );
}

function AlertFeed({ alerts, startTimestamp, onPick }: { alerts: ActiveAlert[]; startTimestamp: string; onPick: (alert: ActiveAlert) => void }) {
  if (!alerts.length) return <p className="feed-empty">No delays detected up to this point in the run.</p>;
  return (
    <ol className="alert-feed">
      {alerts.slice(0, 40).map((alert) => (
        <li key={alert.id}>
          <button className={`${alert.severity}${alert.open ? " open" : ""}`} onClick={() => onPick(alert)}>
            <i />
            <span>
              <b>{alert.title}</b>
              <small>{alert.detail}</small>
            </span>
            <time>{formatTime(startTimestamp, alert.start)}{alert.open ? <em>Live</em> : <em className="closed">Cleared</em>}</time>
          </button>
        </li>
      ))}
    </ol>
  );
}

type InspectorInfo = {
  id: string;
  kind: string;
  role: string;
  derived: boolean;
  state: string;
  location: string | null;
  destination: string | null;
  severity: "normal" | "warning" | "critical";
  since: string | null;
  wait: number;
  loaded: number | null;
  pallets: number | null;
  dock: string | null;
  onSite: boolean;
};

function EntityInspector({ info, follow, onFollow, onClose }: { info: InspectorInfo; follow: boolean; onFollow: () => void; onClose: () => void }) {
  const progress = info.loaded !== null && info.pallets ? Math.round(info.loaded / info.pallets * 100) : null;
  return (
    <div className="entity-inspector">
      <div className="inspector-head">
        <span className={`detail-chip ${info.severity}`}>{info.kind.replace("_", " ")}</span>
        <button title="Close" onClick={onClose}>×</button>
      </div>
      <h3>{info.id}</h3>
      <p className="inspector-role">{info.role}</p>
      <div className="inspector-state"><i className={info.severity} /><b>{info.onSite ? info.state : "Not on site"}</b>{info.since && <small>since {info.since}</small>}</div>
      <dl>
        {info.location && <><dt>Location</dt><dd>{info.location}{info.destination ? ` → ${info.destination}` : ""}</dd></>}
        {info.dock && <><dt>Dock</dt><dd>{info.dock}</dd></>}
        {Number.isFinite(info.wait) && <><dt>Queue wait</dt><dd>{info.wait.toFixed(0)} min</dd></>}
      </dl>
      {progress !== null && <div className="inspector-progress"><span>Loaded <b>{info.loaded}/{info.pallets}</b> pallets</span><div><i style={{ width: `${progress}%` }} /></div></div>}
      {info.derived && <p className="inspector-note">Motion derived from truck loading windows; not a recorded resource.</p>}
      <button className={`follow-button${follow ? " active" : ""}`} onClick={onFollow}>{follow ? "Following · release camera" : "Follow with camera"}</button>
    </div>
  );
}

export default function App() {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [settings, setSettings] = useState(initialSettings);
  const [appliedSettings, setAppliedSettings] = useState(initialSettings);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(15);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"3d" | "analysis" | "compare" | "card">(
    new URLSearchParams(window.location.search).get("view") === "analysis" ? "analysis" : "3d",
  );
  const [days, setDays] = useState<DaySummary[]>([]);
  const [card, setCard] = useState<ModelCard | null>(null);
  const [story, setStory] = useState<{ steps: StoryStep[]; index: number } | null>(null);
  const [clean, setClean] = useState(false);
  const [showcase, setShowcase] = useState<(Showcase & { n: number; recorder?: VideoRecorder | null }) | null>(null);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const heroRef = useRef<string | null>(null);
  heroRef.current = showcase?.hero ?? null;
  // the showcase set-up card: which shipment to follow
  const [showcaseHero, setShowcaseHero] = useState<string | null>(null);
  // live showcase transport: pause, and jumps between beats
  const [showcasePaused, setShowcasePaused] = useState(false);
  const [showcaseSeek, setShowcaseSeek] = useState({ to: 0, n: 0 });
  const [showcaseAt, setShowcaseAt] = useState({ index: 0, elapsed: 0 });
  const [frame, setFrame] = useState<"none" | "16:9" | "4:5">("none");
  const [focusRequest, setFocusRequest] = useState({ target: "OVERVIEW", n: 0 });
  const [zoomRequest, setZoomRequest] = useState({ factor: 1, n: 0 });
  const focusTarget = focusRequest.target;
  const setFocusTarget = (target: string) => setFocusRequest((current) => ({ target, n: current.n + 1 }));
  const zoomBy = (factor: number) => setZoomRequest((current) => ({ factor, n: current.n + 1 }));
  const { collapsed, toggle: togglePanel, set: setPanel } = useCollapsed();
  const [fullscreen, setFullscreen] = useState(false);
  const [futures, setFutures] = useState<{ result: FuturesResult | null; error: string | null; forkAt: number; disruption: DisruptionId } | null>(null);
  const [futuresPlaying, setFuturesPlaying] = useState(false);
  const [versus, setVersus] = useState<{ baseline: SimulationResult; label: string; disruption: string; forkAt: number } | null>(null);
  const [theme, setTheme] = useState<"industrial" | "light">(() => {
    try {
      return localStorage.getItem(THEME_KEY) === "light" ? "light" : "industrial";
    } catch {
      return "industrial";
    }
  });
  const actions = useRef<{ togglePlay: () => void; inject: (id: DisruptionId) => void; step?: (direction: -1 | 1) => void }>({ togglePlay: () => undefined, inject: () => undefined });
  const [showEnvelope, setShowEnvelope] = useState(true);
  const [mode, setMode] = useState<OperationalMode>("replay");
  const [scenarioHasRun, setScenarioHasRun] = useState(false);
  const [selectedBooking, setSelectedBooking] = useState<string>("");
  const [modeResults, setModeResults] = useState<Partial<Record<OperationalMode, SimulationResult>>>({});
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [changedParameter, setChangedParameter] = useState<string | null>(null);
  const [impactTargets, setImpactTargets] = useState<string[]>([]);
  const [analysisCutoff, setAnalysisCutoff] = useState(0);
  const [selectedEntity, setSelectedEntity] = useState<string | null>(null);
  const [sceneModel, setSceneModel] = useState<SceneModel | null>(null);
  const [follow, setFollow] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const lastFrame = useRef<number | null>(null);
  // The 3D scene reads this ref every frame, so motion stays smooth while
  // React state (HUD, panels) refreshes at a lower rate.
  const clock = useRef(0);
  const lastPublish = useRef(0);
  const seek = (minute: number) => {
    clock.current = minute;
    setCurrentTime(minute);
  };

  useEffect(() => {
    Promise.all([loadConfig(), loadReplay(), loadDays(), loadModelCard()])
      .then(([loadedConfig, replay, loadedDays, loadedCard]) => {
        setConfig(loadedConfig);
        setResult(replay);
        setModeResults({ replay });
        setDays(loadedDays);
        setCard(loadedCard);
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      if (event.key === "h" || event.key === "H") setClean((value) => !value);
      if (event.key === " ") {
        event.preventDefault();
        actions.current.togglePlay();
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") actions.current.step?.(event.key === "ArrowLeft" ? -1 : 1);
      const disruption = DISRUPTION_BUTTONS.find((item) => item.key === event.key);
      if (disruption) actions.current.inject(disruption.id);
      if (event.key === "Escape") {
        setClean(false);
        setStory(null);
        setShowcase((current) => {
          current?.recorder?.cancel();
          return null;
        });
        setExportProgress(null);
        setFullscreen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Full screen: the browser's full screen plus every card hidden; leaving browser full screen leaves the mode too.
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) setFullscreen(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  function toggleFullscreen() {
    if (fullscreen) {
      setFullscreen(false);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      return;
    }
    setFullscreen(true);
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
  }

  // Story mode: each step seeks, flies the camera and plays until the next step.
  useEffect(() => {
    if (!story || !result) return;
    const step = story.steps[story.index];
    if (!step) {
      setStory(null);
      return;
    }
    seek(step.at);
    setSelectedEntity(null);
    setFocusTarget(step.target);
    setSpeed(15);
    setPlaying(true);
    const next = story.steps[story.index + 1];
    const wait = next ? Math.min(14000, Math.max(5000, ((next.at - step.at) / 15) * 1000)) : 9000;
    const timer = window.setTimeout(() => setStory((current) => (current ? { ...current, index: current.index + 1 } : null)), wait);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story]);

  useEffect(() => {
    let frame = 0;
    const animate = (timestamp: number) => {
      if (lastFrame.current === null) lastFrame.current = timestamp;
      const deltaSeconds = Math.min(0.1, (timestamp - lastFrame.current) / 1000);
      lastFrame.current = timestamp;
      if (playing && result && viewMode === "3d") {
        const next = clock.current + deltaSeconds * speed;
        if (next >= result.duration_minutes) {
          clock.current = result.duration_minutes;
          setCurrentTime(result.duration_minutes);
          setPlaying(false);
          setAnalysisCutoff(result.duration_minutes);
          setViewMode("analysis");
        } else {
          clock.current = next;
          if (timestamp - lastPublish.current > 90) {
            lastPublish.current = timestamp;
            setCurrentTime(next);
          }
        }
      }
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [playing, result, speed, viewMode]);

  const entityStates = useMemo(() => result ? latestEntityStates(result.trace, currentTime) : [], [result, currentTime]);
  const trucksOnSite = entityStates.filter((event) => event.entity_type === "truck" && event.state !== "departed").length;
  const activeResources = entityStates.filter((event) => event.entity_type === "reach_truck" && event.state !== "idle").length;
  const currentHour = result ? (siteHour(result.start_timestamp) + Math.floor(currentTime / 60)) % 24 : 0;
  const currentMetric = result?.hourly.find((metric) => metric.hour === currentHour) ?? result?.hourly[0];
  const yardDelay = result?.delay_analysis.find((item) => item.stage === "yard")?.average_wait_minutes ?? 0;
  const processedPallets = result ? Math.min(result.kpis.pallets, Math.round(result.kpis.pallets * currentTime / Math.max(1, result.duration_minutes))) : 0;
  const truckQueue = useMemo(() => {
    if (!result) return [];
    const reported = result.trace.filter((event) => event.entity_type === "truck" && event.state === "reported");
    return reported.filter((event) => event.time >= currentTime - 20).slice(0, 4);
  }, [result, currentTime]);

  const inspector = useMemo<InspectorInfo | null>(() => {
    if (!selectedEntity || !sceneModel || !result) return null;
    const track = sceneModel.tracks.find((item) => item.id === selectedEntity);
    if (!track) return null;
    const event = latestEvent(track, currentTime);
    const pose = samplePose(track, currentTime);
    return {
      id: track.id,
      kind: track.kind,
      role: track.role,
      derived: track.derived,
      state: track.kind === "truck" ? (event?.state ?? "not yet arrived").replaceAll("_", " ") : pose?.activity ?? "Off shift",
      location: event?.location_id ?? null,
      destination: event?.destination_id ?? null,
      severity: event?.severity ?? "normal",
      since: event ? formatTime(result.start_timestamp, event.time) : null,
      wait: Number(event?.metadata?.queue_wait_minutes ?? event?.metadata?.wait_minutes ?? NaN),
      loaded: track.kind === "truck" ? cargoCount(track, currentTime) : null,
      pallets: track.pallets ?? null,
      dock: track.dockId ?? null,
      onSite: Boolean(pose),
    };
  }, [selectedEntity, sceneModel, result, currentTime]);
  const equipmentOnSite = useMemo(() => {
    const counts: Record<string, number> = {};
    sceneModel?.tracks.forEach((track) => {
      if (!samplePose(track, currentTime)) return;
      const key = track.kind === "truck" ? track.variant ?? "32FT" : track.kind;
      counts[key] = (counts[key] ?? 0) + 1;
    });
    return counts;
  }, [sceneModel, currentTime]);

  const levels = useMemo(() => (result ? meterLevels(result.trace, currentTime) : {}), [result, currentTime]);
  const recentEvents = useMemo(() => {
    if (!result) return [];
    let index = result.trace.findIndex((event) => event.time > currentTime);
    if (index < 0) index = result.trace.length;
    return result.trace.slice(Math.max(0, index - 14), index).filter((event) => !event.entity_id.startsWith("meter:")).reverse();
  }, [result, currentTime]);
  const cardValue = (key: string, source: SimulationSettings = appliedSettings) => {
    const fromScenario = source.params[key];
    if (fromScenario !== undefined) return fromScenario;
    return card?.parameters.find((row) => row.key === key)?.value as number | string | undefined;
  };
  const alertSpecs = useMemo(() => (result && sceneModel ? buildAlerts(result, sceneModel) : []), [result, sceneModel]);
  const alerts = useMemo(() => alertsAt(alertSpecs, currentTime), [alertSpecs, currentTime]);
  const openAlerts = alerts.filter((alert) => alert.open);
  const criticalOpen = openAlerts.filter((alert) => alert.severity === "critical").length;

  function pickAlert(alert: ActiveAlert) {
    const track = alert.entityId ? sceneModel?.tracks.find((item) => item.id === alert.entityId) : undefined;
    if (track && samplePose(track, clock.current)) {
      setSelectedEntity(track.id);
      setFollow(true);
    } else if (alert.locationId) {
      setSelectedEntity(null);
      setFocusTarget(alert.locationId);
    }
    setPlaying(false);
  }

  function togglePlay() {
    if (!result) return;
    if (!playing && clock.current >= result.duration_minutes - 0.01) seek(0);
    setPlaying(!playing);
  }

  // Returning from the report keeps the model at the report's time; only an
  // explicit replay (restart button, or play after the end) starts over.
  function backToModel() {
    if (!result) return;
    seek(Math.min(analysisCutoff || clock.current, result.duration_minutes));
    setViewMode("3d");
    setPlaying(false);
  }

  const canInject = Boolean(result && mode !== "replay" && result.mode === "dynamic_simulation" && scenarioHasRun && !settingsDirty);

  function inject(id: DisruptionId) {
    if (!canInject || futures) return;
    setPlaying(false);
    const forkAt = Math.floor(clock.current);
    setFutures({ result: null, error: null, forkAt, disruption: id });
    runFutures({ ...appliedSettings, replications: 10 }, forkAt, id)
      .then((next) => setFutures((current) => (current && current.forkAt === forkAt ? { ...current, result: next } : current)))
      .catch((reason: Error) => setFutures((current) => (current ? { ...current, error: reason.message } : current)));
  }

  async function playFutures(best: Future, baseline: Future) {
    if (!futures?.result) return;
    const fork = futures.result.fork_at;
    const base = { ...(futures.result.scenario as SimulationSettings), replications: 10 };
    const bestScenario: SimulationSettings = best.do_nothing ? base : { ...base, decisions: [...(base.decisions ?? []), { at: fork, params: best.decision, label: best.label }] };
    setFuturesPlaying(true);
    try {
      const [bestRun, baseRun] = await Promise.all([runSimulation(bestScenario), runSimulation(base)]);
      setResult(bestRun);
      setModeResults((current) => ({ ...current, [mode]: bestRun }));
      setSettings(bestScenario);
      setAppliedSettings(bestScenario);
      setScenarioHasRun(true);
      setSettingsDirty(false);
      setVersus({ baseline: baseRun, label: best.do_nothing ? "Do nothing" : best.label, disruption: futures.result.disruption.label, forkAt: fork });
      setFutures(null);
      setViewMode("3d");
      seek(Math.max(0, fork - 10));
      setPlaying(true);
      void baseline;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Replay failed");
    } finally {
      setFuturesPlaying(false);
    }
  }

  async function simulate(override?: SimulationSettings) {
    const scenario = override ?? settings;
    setLoading(true);
    setError(null);
    try {
      const simulation = await runSimulation(scenario);
      setResult(simulation);
      setModeResults((current) => ({ ...current, [mode]: simulation }));
      seek(0);
      setMode((current) => current === "live" ? "live" : "stress");
      setScenarioHasRun(true);
      setSettingsDirty(false);
      setAppliedSettings(scenario);
      setSettings(scenario);
      setVersus(null);
      setChangedParameter(null);
      setImpactTargets([]);
      setViewMode("3d");
      setPlaying(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Simulation failed");
    } finally {
      setLoading(false);
    }
  }

  function updateParam(key: string, value: number | string, parameter?: string) {
    const defaultValue = card?.parameters.find((row) => row.key === key)?.default;
    const params = { ...settings.params };
    if (value === defaultValue) delete params[key];
    else params[key] = value;
    updateSettings({ params }, parameter);
  }

  function updateSettings(change: Partial<SimulationSettings>, parameter?: string) {
    if (playing) return;
    setSettings((current) => ({ ...current, ...change }));
    setScenarioHasRun(false);
    setSettingsDirty(true);
    if (parameter && impactMap[parameter]) {
      setChangedParameter(parameter);
      setImpactTargets(impactMap[parameter].targets);
    }
  }

  function updateBooking(shipmentId: string, change: { arrival_offset_minutes?: number; preferred_dock?: string | null }) {
    const existing = settings.slot_overrides.find((item) => item.shipment_id === shipmentId);
    const next = {
      shipment_id: shipmentId,
      arrival_offset_minutes: change.arrival_offset_minutes ?? existing?.arrival_offset_minutes ?? 0,
      preferred_dock: change.preferred_dock === undefined ? existing?.preferred_dock ?? null : change.preferred_dock,
    };
    updateSettings({ slot_overrides: [...settings.slot_overrides.filter((item) => item.shipment_id !== shipmentId), next], live_as_of_minutes: Math.floor(currentTime) }, "booking");
  }

  function openMode(nextMode: OperationalMode) {
    if (settingsDirty) return;
    const saved = modeResults[nextMode];
    const base = saved ?? (nextMode === "live" ? modeResults.stress ?? modeResults.replay : modeResults.replay) ?? result;
    setMode(nextMode);
    setResult(base);
    seek(0);
    setPlaying(false);
    setViewMode("3d");
    setSettingsDirty(false);
    setChangedParameter(null);
    setImpactTargets([]);
    setScenarioHasRun(nextMode !== "replay" && Boolean(saved));
    if (nextMode === "live") setSettings((current) => ({ ...current, live_as_of_minutes: 0 }));
  }

  function discardParameterChanges() {
    setSettings(appliedSettings);
    setSettingsDirty(false);
    setChangedParameter(null);
    setImpactTargets([]);
    setScenarioHasRun(mode !== "replay" && Boolean(modeResults[mode]));
  }

  function openView(next: "compare" | "card") {
    if (viewMode === next) return;
    setPlaying(false);
    setViewMode(next);
  }

  const heroes = useMemo(() => (sceneModel && result ? dispatchHeroes(sceneModel, (minute) => formatTime(result.start_timestamp, minute)) : []), [sceneModel, result]);

  /** Opens the set-up card, with the selected truck (or the day's best candidate) chosen. */
  function openShowcase() {
    if (!sceneModel) return;
    const chosen = heroes.find((hero) => hero.id === selectedEntity) ?? defaultHero(heroes, sceneModel.horizon);
    if (!chosen) {
      setError("No truck in this run goes all the way from gate to departure, so there is nothing to follow.");
      return;
    }
    setPlaying(false);
    setShowcaseHero(chosen.id);
  }

  /** Follows one shipment from gate to gate with a directed camera, live or rendered to MP4. */
  async function startShowcase(heroId: string, record = false) {
    if (!result || !sceneModel) return;
    const built = buildDispatchShowcase(sceneModel, result.trace, (minute) => formatTime(result.start_timestamp, minute), heroId);
    if (!built) {
      setError("No truck in this run goes all the way from gate to departure, so there is nothing to follow.");
      return;
    }
    let recorder: VideoRecorder | null = null;
    if (record) {
      // the recording frame decides the shape: 4:5 for a feed post, otherwise 1080p widescreen
      try {
        recorder = await VideoRecorder.create(frame === "4:5" ? { width: 1080, height: 1350, fps: 60 } : { width: 1920, height: 1080, fps: 60 });
      } catch (reason) {
        setError((reason as Error).message);
        return;
      }
      setExportProgress(0);
    }
    setPlaying(false);
    setStory(null);
    setSelectedEntity(null);
    setClean(true);
    setShowcaseHero(null);
    setShowcasePaused(false);
    setShowcaseAt({ index: 0, elapsed: 0 });
    setShowcase((current) => ({ ...built, recorder, n: (current?.n ?? 0) + 1 }));
  }

  function stopShowcase() {
    showcase?.recorder?.cancel();
    setExportProgress(null);
    setShowcase(null);
  }

  const onRecord = useCallback((state: { progress: number } | { video: Blob } | { error: string }) => {
    if ("progress" in state) {
      setExportProgress(state.progress);
      return;
    }
    setExportProgress(null);
    if ("video" in state) {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(state.video);
      link.download = `dispatch-twin-${heroRef.current ?? "showcase"}.mp4`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    } else setError(`Video export failed: ${state.error}`);
    setShowcase(null);
  }, []);

  const onShowcase = useCallback((state: { index: number; time: number; elapsed: number } | null) => {
    if (!state) {
      setShowcase(null);
      return;
    }
    setCurrentTime(state.time);
    setShowcaseAt((current) => (current.index === state.index && Math.abs(current.elapsed - state.elapsed) < 0.05 ? current : { index: state.index, elapsed: state.elapsed }));
  }, []);

  /** Jumps to the start of the previous or next beat (a shot with its own headline); back within 1.5 s of a start goes one further. */
  function stepShowcase(direction: -1 | 1) {
    if (!showcase || showcase.recorder) return;
    let start = 0;
    const starts = showcase.shots.map((shot) => {
      const at = start;
      start += shot.seconds;
      return { at, beat: Boolean(shot.title) };
    }).filter((item) => item.beat).map((item) => item.at);
    const now = showcaseAt.elapsed;
    const target = direction > 0 ? starts.find((at) => at > now + 0.01) : [...starts].reverse().find((at) => at < now - 1.5);
    if (target === undefined && direction > 0) return;
    setShowcaseSeek((current) => ({ to: target ?? 0, n: current.n + 1 }));
  }

  function startStory() {
    if (!result || result.mode === "historical_replay" || !result.stress_points?.length) return;
    setClean(true);
    setStory({ steps: buildStory(result, result.start_timestamp), index: 0 });
  }

  function openAnalysis() {
    if (settingsDirty || !result || !(mode === "replay" || scenarioHasRun)) return;
    setAnalysisCutoff(currentTime >= result.duration_minutes ? result.duration_minutes : currentTime);
    setViewMode("analysis");
    setPlaying(false);
  }

  actions.current = {
    togglePlay: () => {
      if (showcase) {
        if (!showcase.recorder) setShowcasePaused((value) => !value);
        return;
      }
      if (viewMode === "3d" && hasValidRunRef(mode, scenarioHasRun)) togglePlay();
    },
    inject,
    step: (direction) => stepShowcase(direction),
  };

  if (!config || !result) {
    return <div className="yard-splash"><div>DT</div><p>{error ?? "Loading the operational twin..."}</p></div>;
  }

  const avgPallets = Math.round(result.kpis.pallets / Math.max(1, result.kpis.trucks));
  const loadingMinutes = result.delay_analysis.find((item) => item.stage === "loading")?.average_wait_minutes ?? 0;
  const paperworkMinutes = result.delay_analysis.find((item) => item.stage === "exit")?.average_wait_minutes ?? 0;
  const recordedReachTrucks = config.resources.equipment.filter((resource) => resource.type === "reach_truck").length;
  const recordedForklifts = config.resources.equipment.filter((resource) => resource.type === "forklift").length;
  const sourceState = viewMode === "analysis"
    ? result.mode === "historical_replay" ? "recorded" : "simulated"
    : mode === "replay" ? "recorded" : scenarioHasRun ? "simulated" : "draft";
  const shipmentSchedule = result.shipment_schedule ?? [];
  const bookingCandidates = shipmentSchedule.filter((shipment) => shipment.simulated_arrival_minutes >= currentTime).slice(0, 8);
  const activeBookingId = selectedBooking || bookingCandidates[0]?.shipment_id || shipmentSchedule[0]?.shipment_id || "";
  const activeBooking = shipmentSchedule.find((shipment) => shipment.shipment_id === activeBookingId);
  const activeOverride = settings.slot_overrides.find((item) => item.shipment_id === activeBookingId);
  const runCompleted = currentTime >= result.duration_minutes - .01;
  const hasValidRun = mode === "replay" || scenarioHasRun;
  const canAnalyze = !settingsDirty && hasValidRun && currentTime > 0;
  const modeName = mode === "replay" ? "Recorded" : mode === "live" ? "Live replan" : "What-if";
  const reportResult = partialAnalysis(result, Math.min(analysisCutoff || currentTime, result.duration_minutes));
  const stats = mode !== "replay" && result.mode === "dynamic_simulation" ? result.statistics ?? null : null;
  const reachCount = Number(cardValue("reachTrucks") ?? 7);
  const dockTotal = Number(cardValue("docks") ?? 6);

  return (
    <main className={`yard-app theme-${theme} source-${sourceState}${clean || fullscreen ? " clean" : ""}${fullscreen ? " fullscreen" : ""}${showcase ? " showcase" : ""}${mode !== "replay" ? " disrupt-on" : ""}${collapsed["side-left"] ? " left-hidden" : ""}${collapsed["side-right"] ? " right-hidden" : ""}`}>
      <header className="yard-header">
        <div className="yard-brand"><div className="yard-logo">DT</div><div><strong>Dispatch Twin</strong><small>Outbound warehouse · discrete-event digital twin</small></div></div>
        <div className="day-summary">
          <b>{mode === "live" ? scenarioHasRun ? "Live replan result" : "Live slot plan" : sourceState === "recorded" ? "Recorded day" : sourceState === "simulated" ? "Simulated scenario" : "Scenario draft"}, {formatDay(result.start_timestamp)}</b>
          {mode === "replay" ? <span>{result.kpis.trucks} trucks · 4 doors · {result.kpis.pallets} pallets · task log</span> : (
            <select className="day-picker" value={settings.day_id ?? DEFAULT_DAY} disabled={playing || loading} onChange={(event) => updateSettings({ day_id: event.target.value, slot_overrides: [] }, "demand")} title="Baseline day: the run replays this day, then applies your changes">
              {days.map((day) => <option key={day.day_id} value={day.day_id}>{day.label} · {day.trucks} trucks</option>)}
            </select>
          )}
        </div>
        <nav className="mode-nav" aria-label="Simulation type and view">
          <div className="main-mode-switch" role="tablist" aria-label="Simulation type">
            <button disabled={settingsDirty && mode !== "replay"} className={mode === "replay" ? "active" : ""} onClick={() => openMode("replay")}>Recorded</button>
            <button disabled={settingsDirty && mode !== "stress"} className={mode === "stress" ? "active" : ""} onClick={() => openMode("stress")}>What-if</button>
            <button disabled={settingsDirty && mode !== "live"} className={mode === "live" ? "active" : ""} onClick={() => openMode("live")}>Live replan</button>
          </div>
          <div className="view-switch" role="tablist" aria-label={`${modeName} views`}>
            <span className="view-owner">{modeName}</span>
            <button className={viewMode === "3d" ? "active" : ""} onClick={viewMode === "3d" ? undefined : backToModel}>3D model</button>
            <button className={viewMode === "analysis" ? "active" : ""} disabled={!canAnalyze && viewMode !== "analysis"} title={canAnalyze ? "Report up to the current time" : "Run or replay the day first"} onClick={viewMode === "analysis" ? undefined : openAnalysis}>Analyze</button>
            {mode !== "replay" && <button className={viewMode === "compare" ? "active" : ""} disabled={!card} onClick={() => openView("compare")}>Compare</button>}
            {mode !== "replay" && <button className={viewMode === "card" ? "active" : ""} disabled={!card} onClick={() => openView("card")}>Model card</button>}
          </div>
        </nav>
        <div className="big-clock" title="Simulated site time"><b>{formatDay(result.start_timestamp).slice(0, 3)} {formatTime(result.start_timestamp, currentTime)}</b><small>1 s = {speed} min</small></div>
        <button className="theme-toggle" title={theme === "industrial" ? "Switch to the light theme" : "Switch to the industrial theme"} onClick={() => { const next = theme === "industrial" ? "light" : "industrial"; setTheme(next); try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ } }}>{theme === "industrial" ? "☀" : "☾"}</button>
        <div className="top-playback"><button title="Restart manually" disabled={viewMode !== "3d" || !hasValidRun} onClick={() => { seek(0); setPlaying(false); }}>↶</button><button className="pause" disabled={viewMode !== "3d" || (!playing && (settingsDirty || !hasValidRun))} title={settingsDirty || !hasValidRun ? "Run a new simulation first." : playing ? "Pause simulation" : runCompleted ? "Replay from the start" : "Play simulation"} onClick={togglePlay}>{playing ? "Ⅱ" : "▶"}</button><div className="top-speeds">{[1, 5, 15, 40].map((value) => <button key={value} className={speed === value ? "active" : ""} title={`${value} simulated minutes per second`} onClick={() => setSpeed(value)}>{value}×</button>)}</div>{openAlerts.length > 0 && viewMode === "3d" && <button className={`header-alerts${criticalOpen ? " critical" : ""}`} title="Show delay alerts" onClick={() => { if (collapsed.alerts) togglePanel("alerts"); }}>{openAlerts.length} delay{openAlerts.length === 1 ? "" : "s"}</button>}<span className="sim-status"><i />{viewMode === "analysis" ? analysisCutoff < result.duration_minutes ? "Partial report" : "Final report" : !hasValidRun ? "Ready to configure" : settingsDirty ? "Needs new run" : playing ? sourceState === "recorded" ? "Replaying" : "Simulating" : runCompleted ? "Complete" : "Paused"}</span></div>
      </header>

      {viewMode === "compare" && card ? (
        <section className="yard-analysis"><CompareView baseline={{ ...settings, params: {}, rules: {}, slot_overrides: [], live_as_of_minutes: null, demand_multiplier: 1 }} scenario={{ ...settings, slot_overrides: [], live_as_of_minutes: null }} dayLabel={days.find((day) => day.day_id === settings.day_id)?.label ?? "Reference day"} onOpenModel={(next) => { setMode("stress"); void simulate(next); }} /></section>
      ) : viewMode === "card" && card ? (
        <section className="yard-analysis"><ModelCardView card={card} settings={settings} running={loading} onChange={(params, rules) => { setSettings((current) => ({ ...current, params, rules })); setMode((current) => (current === "replay" ? "stress" : current)); setSettingsDirty(true); setScenarioHasRun(false); }} onRun={() => { setMode((current) => (current === "replay" ? "stress" : current)); void simulate(); }} /></section>
      ) : viewMode === "analysis" ? (
        <section className="yard-analysis"><AnalyticsView result={reportResult} modeLabel={mode === "replay" ? "Recorded replay" : mode === "live" ? "Live replan" : "What-if simulation"} isPartial={analysisCutoff < result.duration_minutes} asOfLabel={formatTime(result.start_timestamp, analysisCutoff)} onInspectHour={(hour) => { seek(((hour - siteHour(result.start_timestamp) + 24) % 24) * 60); setViewMode("3d"); setPlaying(false); }} onInspectArea={(area) => { seek(Math.min(analysisCutoff || clock.current, result.duration_minutes)); setFocusTarget(area); setViewMode("3d"); setPlaying(false); }} /></section>
      ) : (
        <section className="yard-stage">
          <WarehouseScene showcase={showcase} showcasePaused={showcasePaused} showcaseSeek={showcaseSeek} onShowcase={onShowcase} onRecord={onRecord} paused={Boolean(futures)} theme={theme} stressPoints={result.mode === "dynamic_simulation" ? result.stress_points ?? [] : []} stressLevels={levels} layout={config.layout} trace={result.trace} clock={clock} startHour={siteHour(result.start_timestamp)} stressScore={currentMetric?.stress_score ?? 0} focusRequest={focusRequest} zoomRequest={zoomRequest} alerts={alerts} onAlertPick={pickAlert} onSelectLocation={(id) => { setSelectedEntity(null); setFocusTarget(id); }} showEnvelope={showEnvelope} showLabels={showLabels && !showcase} sourceMode={sourceState} highlightTargets={impactTargets} equipment={config.resources.equipment} dockCount={mode === "replay" ? 4 : Number(cardValue("docks") ?? 6)} selectedEntity={selectedEntity} follow={follow} onSelectEntity={(id) => { setSelectedEntity(id); if (id) setFollow(true); }} onModel={setSceneModel} />

          <div className="source-ribbon">
            <span className="source-dot" />
            <div><strong>{mode === "replay" ? "RECORDED OPERATIONS" : mode === "live" ? scenarioHasRun ? "LIVE REPLAN RESULT" : "LIVE REPLAN DRAFT" : scenarioHasRun ? "WHAT-IF RESULT" : "WHAT-IF DRAFT"}</strong><small>{mode === "replay" ? "Read-only · events from historical JSON" : mode === "live" ? `State frozen at ${formatTime(result.start_timestamp, settings.live_as_of_minutes ?? currentTime)} · only future bookings change` : scenarioHasRun ? `Generated run · seed ${result.seed ?? settings.seed}` : "Inputs changed · run simulation to generate new events"}</small></div>
            <code>{mode === "replay" ? result.run_id : scenarioHasRun ? result.run_id : "NOT RUN"}</code>
          </div>
          {changedParameter && <div className="impact-ribbon"><b>Expected impact highlighted</b><span>{impactMap[changedParameter].label}</span><small>Run the simulation to measure the actual result.</small></div>}

          <div className="state-legend" aria-label="Legend">
            <span><i className="working" />Working</span><span><i className="waiting" />Waiting</span><span><i className="blocked" />Blocked</span><span><i className="down" />Down / late</span>
            <em />
            <span><i className="eq reach" />Reach truck</span><span><i className="eq forklift" />Forklift</span><span><i className="eq truck" />Truck</span>
          </div>

          {versus && (() => {
            const slot = result.statistics?.slot_minutes ?? 180;
            const best = sinceFork(result.trace, versus.forkAt, currentTime, slot);
            const base = sinceFork(versus.baseline.trace, versus.forkAt, currentTime, slot);
            return (
              <section className="versus-panel glass-card">
                <header><b>Best plan against do nothing</b><small>{versus.disruption} at {formatTime(result.start_timestamp, versus.forkAt)}</small><button onClick={() => setVersus(null)} title="Close">×</button></header>
                <p className="versus-decision">{versus.label}</p>
                <table>
                  <thead><tr><th /><th>Best plan</th><th>Do nothing</th></tr></thead>
                  <tbody>
                    <tr><td>Trucks out since the fork</td><td>{best.dispatched}</td><td>{base.dispatched}</td></tr>
                    <tr><td>Within their slot</td><td className={best.onTime >= base.onTime ? "up" : "down"}>{best.onTime}</td><td>{base.onTime}</td></tr>
                    <tr><td>Past their slot</td><td className={best.late <= base.late ? "up" : "down"}>{best.late}</td><td>{base.late}</td></tr>
                    <tr><td>Average turnaround</td><td>{best.tat ? `${best.tat.toFixed(2)} h` : "–"}</td><td>{base.tat ? `${base.tat.toFixed(2)} h` : "–"}</td></tr>
                  </tbody>
                </table>
              </section>
            );
          })()}

          {mode !== "replay" && <section className={`disruption-panel glass-card${canInject ? "" : " locked"}`}>
            <header>Inject a disruption</header>
            <div className="disruption-grid">
              {DISRUPTION_BUTTONS.map((item) => (
                <button key={item.id} disabled={!canInject} title={canInject ? `${item.detail} · fork the day into parallel futures` : "Run a What-if first: futures fork a simulated day"} onClick={() => inject(item.id)}>
                  <i>{item.icon}</i><span>{item.label}</span><kbd>{item.key}</kbd>
                </button>
              ))}
            </div>
          </section>}

          {collapsed["side-left"] && (
            <section className="policy-card glass-card">
              <header>Operating policy</header>
              <dl>
                <dt>Picking release</dt><dd>{String(cardValue("policy") ?? "gate") === "prepick" ? "Pre-pick evening trucks" : "Pick at gate"}</dd>
                <dt>Dock call</dt><dd>at {Math.round(Number(cardValue("callShare") ?? 0.6) * 100)}% staged</dd>
                <dt>Putaway priority</dt><dd>above {String(cardValue("putawayFirstAt") ?? 45)} pallets</dd>
                <dt>Warehouse fill</dt><dd>{Math.round(Number(cardValue("fillRate") ?? 0.5) * 100)}%</dd>
                <dt>Reach trucks · docks</dt><dd>{String(cardValue("reachTrucks") ?? 7)} · {String(cardValue("docks") ?? 6)}</dd>
              </dl>
            </section>
          )}


          {collapsed["side-left"] && <button className="side-tab left" title="Show the control panel" onClick={() => setPanel("side-left", false)}><i>›</i><span>{mode === "stress" ? "What-if controls" : mode === "live" ? "Live slot desk" : "Recorded day setup"}</span></button>}
          {!collapsed["side-left"] && <Collapsible id="setup" className="stress-panel" collapsed={Boolean(collapsed.setup)} onToggle={togglePanel} title={<strong>{mode === "stress" ? "What-if controls" : mode === "live" ? "Live slot desk" : "Recorded day setup"}</strong>} extra={<><span className={mode === "replay" ? "locked-badge" : "editable-badge"}>{mode === "replay" ? "LOCKED" : mode === "live" ? "FUTURE ONLY" : "EDITABLE"}</span><button className="side-hide" title="Slide the panel to the side" onClick={() => setPanel("side-left", true)}>‹</button></>}>
            <p className="panel-explainer">{mode === "replay" ? "This is an evidence replay. Values below describe what actually operated that day and cannot be changed." : mode === "live" ? "Completed events are frozen. Move a future booking, then recalculate the remaining shift." : "Pick a past day, change only what is different tomorrow, and run it over many simulated days."}</p>
            {playing && mode !== "replay" && <div className="running-lock">Simulation running · pause to unlock parameters</div>}
            <div className="rate-box">
              <div><span>Production availability</span><b>{result.delay_analysis.find((item) => item.stage === "production")?.average_wait_minutes.toFixed(0) ?? "n/a"}{result.delay_analysis.some((item) => item.stage === "production") ? " min" : ""}</b></div>
              <div><span>Minutes per pallet</span><b>{(loadingMinutes / Math.max(1, avgPallets)).toFixed(2)}</b></div>
              <div><span>Gate and tare</span><b>{result.delay_analysis.find((item) => item.stage === "gate")?.average_wait_minutes.toFixed(0)} min</b></div>
              <div><span>Paperwork</span><b>{paperworkMinutes.toFixed(0)} min</b></div>
              <div><span>Pallets per truck</span><b>{avgPallets}</b></div>
              <div><span>Trucks this run</span><b>{result.kpis.trucks}</b></div>
            </div>
            {mode === "replay" ? <>
              <h3>Resources available that day</h3>
              <div className="recorded-parameters">
                <div><span>Dock doors operated</span><b>4</b></div>
                <div><span>Reach trucks</span><b>{recordedReachTrucks}</b></div>
                <div><span>Loading forklifts</span><b>{recordedForklifts}</b></div>
                <div><span>Loading gangs</span><b>3</b></div>
                <div><span>Arrival pattern</span><b>As recorded</b></div>
                <div><span>Dock call readiness</span><b>60%</b></div>
                <div><span>Replay duration</span><b>{Math.round(result.duration_minutes / 60)} hours</b></div>
              </div>
              <div className="read-only-note"><b>Why locked?</b><span>Editing historical inputs would make this replay different from the recorded evidence.</span></div>
            </> : mode === "live" ? <>
              <h3>Future truck bookings</h3>
              <div className="booking-list">
                {bookingCandidates.map((booking) => <button disabled={playing} key={booking.shipment_id} className={activeBookingId === booking.shipment_id ? "active" : ""} onClick={() => setSelectedBooking(booking.shipment_id)}><span><b>{booking.shipment_id}</b><small>{booking.pallets} pallets · {booking.truck_type ?? booking.priority}</small></span><time>{formatTime(result.start_timestamp, booking.planned_slot_minutes)}</time><i className={booking.slot_status === "past_slot" ? "late" : "ready"}>{booking.slot_status === "past_slot" ? "PAST SLOT" : "IN SLOT"}</i></button>)}
              </div>
              {activeBooking && <div className="booking-editor">
                <div className="booking-readiness"><span>Booked slot<b>{formatTime(result.start_timestamp, activeBooking.planned_slot_minutes)}</b></span><span>Called to dock<b>{formatTime(result.start_timestamp, activeBooking.production_ready_minutes)}</b></span></div>
                <label>Move booking</label>
                <div className="slot-stepper"><button disabled={playing} onClick={() => updateBooking(activeBookingId, { arrival_offset_minutes: (activeOverride?.arrival_offset_minutes ?? 0) - 30 })}>−30 min</button><strong>{(activeOverride?.arrival_offset_minutes ?? 0) > 0 ? "+" : ""}{activeOverride?.arrival_offset_minutes ?? 0} min</strong><button disabled={playing} onClick={() => updateBooking(activeBookingId, { arrival_offset_minutes: (activeOverride?.arrival_offset_minutes ?? 0) + 30 })}>+30 min</button></div>
                <small className="booking-note">Docks are assigned first-free by the engine's dock-free rule.</small>
              </div>}
              <div className="draft-note">Planning cut-off: {formatTime(result.start_timestamp, settings.live_as_of_minutes ?? currentTime)}. Changes affect future events only.{settingsDirty && <button onClick={discardParameterChanges}>Discard changes</button>}</div>
              <button className="teal-action" onClick={() => void simulate()} disabled={loading || playing || !settings.slot_overrides.length}>{loading ? "Recalculating shift..." : "Apply and replan shift"}</button>
            </> : <>
              <h3>Warehouse and policy</h3>
              <Slider disabled={playing} label="Opening warehouse fill" value={Math.round(Number(cardValue("fillRate", settings) ?? 0.5) * 100)} min={40} max={97} step={1} suffix="%" onChange={(value) => updateParam("fillRate", value / 100, "fill")} />
              <Toggle disabled={playing} value={String(cardValue("policy", settings) ?? "gate")} options={[["gate", "Pick at gate"], ["prepick", "Pre-pick evening trucks"]]} onChange={(value) => updateParam("policy", value, "policy")} />
              <h3>Resources</h3>
              <Slider disabled={playing} label="Reach trucks" value={Number(cardValue("reachTrucks", settings) ?? 7)} min={3} max={12} step={1} onChange={(value) => updateParam("reachTrucks", value, "reach")} />
              <Slider disabled={playing} label="Dock doors" value={Number(cardValue("docks", settings) ?? 6)} min={3} max={8} step={1} onChange={(value) => updateParam("docks", value, "docks")} />
              <Slider disabled={playing} label="Loading forklifts" value={Number(cardValue("forklifts", settings) ?? 6)} min={3} max={8} step={1} onChange={(value) => updateParam("forklifts", value, "forklifts")} />
              <Slider disabled={playing} label="Marshalling lanes" value={Number(cardValue("lanes", settings) ?? 10)} min={4} max={14} step={1} onChange={(value) => updateParam("lanes", value, "lanes")} />
              <Slider disabled={playing} label="Pallets staged before dock call" value={Math.round(Number(cardValue("callShare", settings) ?? 0.6) * 100)} min={30} max={100} step={5} suffix="%" onChange={(value) => updateParam("callShare", value / 100, "readiness")} />
              <h3>Demand and chance</h3>
              <Slider disabled={playing} label="Trucks per day" value={Math.round((days.find((day) => day.day_id === settings.day_id)?.trucks ?? 64) * settings.demand_multiplier)} min={Math.round((days.find((day) => day.day_id === settings.day_id)?.trucks ?? 64) * 0.5)} max={Math.round((days.find((day) => day.day_id === settings.day_id)?.trucks ?? 64) * 2)} step={1} onChange={(value) => updateSettings({ demand_multiplier: Number((value / (days.find((day) => day.day_id === settings.day_id)?.trucks ?? 64)).toFixed(3)) }, "demand")} />
              <Toggle disabled={playing} value={settings.arrivals} options={[["trace", "Arrivals as on the day"], ["random", "Random days"]]} onChange={(value) => updateSettings({ arrivals: value }, "demand")} />
              <Toggle disabled={playing} value={settings.chance} options={[["sto", "Stochastic times"], ["det", "Average times"]]} onChange={(value) => updateSettings({ chance: value, replications: value === "det" ? 1 : Math.max(10, settings.replications) })} />
              <Toggle disabled={playing || settings.chance === "det"} value={settings.replications} options={[[1, "1 day"], [10, "10 days"], [30, "30 days"]]} onChange={(value) => updateSettings({ replications: value })} />
              {Object.keys(settings.rules).length > 0 && <div className="draft-note">{Object.keys(settings.rules).length} rule{Object.keys(settings.rules).length === 1 ? "" : "s"} switched off in the model card.</div>}
              {!scenarioHasRun && <div className="draft-note">{settingsDirty ? "Inputs changed. The previous run cannot resume until you run again or discard the changes." : "Configure the inputs, then generate a new simulation."}{settingsDirty && <button onClick={discardParameterChanges}>Discard changes</button>}</div>}
              <button className="teal-action" onClick={() => void simulate()} disabled={loading || playing}>{loading ? `Simulating ${settings.replications} day${settings.replications === 1 ? "" : "s"}…` : settingsDirty || !scenarioHasRun ? "Run new simulation" : "Run again"}</button>
              {scenarioHasRun && result.stress_points?.length ? <button className="analyze-action" onClick={startStory} disabled={playing}>Play the story of this day</button> : null}
            </>}
            <button className="analyze-action" disabled={!canAnalyze} onClick={openAnalysis}>{runCompleted ? "Open final analysis" : `Analyze progress to ${formatTime(result.start_timestamp, currentTime)}`}</button>
          </Collapsible>}

          {collapsed["side-right"] && (
            <div className="side-tab right" role="toolbar" aria-label="Panels">
              {([["details", "i", "Details"], ["stress", "S", "Stress points"], ["alerts", "!", "Delay alerts"], ["events", "≡", "Event log"], ["legend", "◧", "Equipment on site"], ["trucks", "▰", "Arriving trucks"]] as const).map(([id, icon, label]) => {
                const badge = id === "alerts" ? openAlerts.length : id === "stress" ? Object.values(levels).filter((item) => item.level === "red").length : 0;
                return <button key={id} title={label} className={id === "alerts" && criticalOpen ? "critical" : ""} onClick={() => { setPanel("side-right", false); setPanel(id, false); }}><b>{icon}</b>{badge > 0 && <em>{badge}</em>}<span>{label}</span></button>;
              })}
            </div>
          )}
          {!collapsed["side-right"] && <div className="right-rail">
          <button className="rail-hide" title="Slide the panels to the side" onClick={() => setPanel("side-right", true)}>Hide panels ›</button>
          <Collapsible id="details" className="details-card" collapsed={Boolean(collapsed.details)} onToggle={togglePanel} title={<strong>Details</strong>}>
            {inspector ? <EntityInspector info={inspector} follow={follow} onFollow={() => setFollow(!follow)} onClose={() => setSelectedEntity(null)} /> : focusTarget === "OVERVIEW" ? <><p>Tap equipment, a rack, dock, or zone to inspect it. The model is showing <b>{mode === "replay" ? "recorded events" : scenarioHasRun ? "generated events" : "the previous run"}</b>.</p><div className="quick-facts"><span><b>{currentMetric?.stress_score.toFixed(0)}</b>stress</span><span><b>{currentMetric?.picking_queue_peak ?? 0}</b>pick queue</span><span><b>{currentMetric?.average_turnaround_minutes.toFixed(0) ?? 0}</b>TAT min</span></div></> : <><span className="detail-chip">Selected area</span><h3>{focusTarget.replaceAll("-", " ")}</h3><p>Current stress: {currentMetric?.stress_score.toFixed(0)}/100<br />Active reach trucks: {activeResources}/{mode === "replay" ? recordedReachTrucks : reachCount}<br />Current picking queue: {currentMetric?.picking_queue_peak ?? 0} tasks</p></>}
          </Collapsible>

          {result.mode === "dynamic_simulation" && (result.stress_points?.length ?? 0) > 0 && (
            <Collapsible id="stress" className="stress-card" collapsed={Boolean(collapsed.stress)} onToggle={togglePanel} title={<strong>Stress points</strong>} extra={<span className="alert-count">{Object.values(levels).filter((item) => item.level === "red").length} red</span>}>
              <ol className="stress-list">
                {(result.stress_points ?? []).map((point: StressPoint) => {
                  const level = levels[point.id]?.level ?? "normal";
                  return (
                    <li key={point.id}>
                      <button className={level} onClick={() => { setSelectedEntity(null); setFocusTarget(point.location); setPlaying(false); }}>
                        <b>{point.number}</b>
                        <span>{point.label}<small>{point.first_red !== null ? `first red ${formatTime(result.start_timestamp, point.first_red)} · ${Math.round(point.red_minutes)} min red` : point.first_amber !== null ? `amber from ${formatTime(result.start_timestamp, point.first_amber)}` : "stays normal"}</small></span>
                        <i>{level}</i>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </Collapsible>
          )}

          <Collapsible id="alerts" className="alerts-card" collapsed={Boolean(collapsed.alerts)} onToggle={togglePanel} title={<strong>Delay alerts</strong>} extra={<span className={`alert-count${criticalOpen ? " critical" : openAlerts.length ? " warning" : ""}`}>{openAlerts.length} live · {alerts.length} total</span>}>
            <AlertFeed alerts={alerts} startTimestamp={result.start_timestamp} onPick={pickAlert} />
          </Collapsible>

          <Collapsible id="events" className="events-card" collapsed={collapsed.events !== false} onToggle={(id) => togglePanel(id)} title={<strong>Event log</strong>} extra={<span className="alert-count">{result.trace.length.toLocaleString("en-IN")} events</span>}>
            <ol className="event-log">
              {recentEvents.map((event, index) => (
                <li key={`${event.entity_id}-${event.time}-${index}`}>
                  <button onClick={() => { seek(event.time); setPlaying(false); if (event.entity_type === "truck" || event.entity_type === "reach_truck" || event.entity_type === "forklift") { setSelectedEntity(event.entity_id); setFollow(true); } }}>
                    <time>{formatTime(result.start_timestamp, event.time)}</time>
                    <span><b>{event.entity_id}</b> {event.state.replaceAll("_", " ")}{event.location_id ? ` · ${event.location_id}` : ""}{event.destination_id ? ` → ${event.destination_id}` : ""}{event.metadata?.reason ? <small>{String(event.metadata.reason)}{event.metadata?.rule ? ` · rule ${String(event.metadata.rule)}` : ""}</small> : null}</span>
                  </button>
                </li>
              ))}
            </ol>
          </Collapsible>

          <Collapsible id="legend" className="model-legend" collapsed={Boolean(collapsed.legend)} onToggle={togglePanel} title={<strong>Equipment on site</strong>}><div className="legend-grid">{EQUIPMENT_LEGEND.map((item) => <span key={item.key} title={`${equipmentOnSite[item.key] ?? 0} active now`}><i className={`equipment-chip ${item.className}`} />{item.label}<b>{equipmentOnSite[item.key] ?? 0}</b></span>)}</div></Collapsible>

          <Collapsible id="trucks" className="truck-list-card" collapsed={Boolean(collapsed.trucks)} onToggle={togglePanel} title={<strong>Arriving trucks</strong>}>
            <div className="list-tabs"><b>Trucks {trucksOnSite}</b><span>Doors {Math.min(trucksOnSite, mode === "replay" ? 4 : dockTotal)}/{mode === "replay" ? 4 : dockTotal}</span><span>Reach trucks {activeResources}/{mode === "replay" ? recordedReachTrucks : reachCount}</span></div>
            <div className="truck-list">
              {(truckQueue.length ? truckQueue : result.trace.filter((event) => event.entity_type === "truck" && event.state === "reported").slice(0, 3)).map((truck) => <button key={`${truck.entity_id}-${truck.time}`} onClick={() => { seek(truck.time + 0.5); setSelectedEntity(truck.entity_id); setFollow(true); setPlaying(false); }}><span><b>{truck.entity_id}</b><small>{String(truck.metadata.truck_type ?? "Outbound truck")}</small></span><time>Due {formatTime(result.start_timestamp, truck.time)}</time><i>View</i></button>)}
            </div>
          </Collapsible>
          </div>}


          {/* camera and location controls: one horizontal bar along the top */}
          <div className="view-tools">
            <nav className="location-dock glass-card" aria-label="Warehouse locations">
              {focusAreas.map(([id, label]) => <button key={id} className={focusTarget === id ? "active" : ""} title={id.replaceAll("-", " ")} onClick={() => { setSelectedEntity(null); setFocusTarget(id); }}>{label}</button>)}
            </nav>
            <nav className="camera-toolbar glass-card" aria-label="Camera controls">
              <button title="Zoom in" onClick={() => zoomBy(0.7)}>+</button>
              <button title="Zoom out" onClick={() => zoomBy(1.4)}>−</button>
              <button title="Reset view" onClick={() => { setSelectedEntity(null); setFocusTarget("OVERVIEW"); }}>↻</button>
              <button title="Show or hide warehouse shell" className={showEnvelope ? "active" : ""} onClick={() => setShowEnvelope(!showEnvelope)}>◉</button>
              <button title="Show or hide vehicle labels" className={showLabels ? "active" : ""} onClick={() => setShowLabels(!showLabels)}>Aa</button>
              <button title="Full screen: hide every card (Esc to leave)" className={fullscreen ? "active" : ""} onClick={toggleFullscreen}>⛶</button>
              <button title="Showcase: follow one shipment from gate to gate with a directed camera, live or as an MP4" className={showcase ? "active" : ""} disabled={!sceneModel} onClick={() => (showcase ? stopShowcase() : openShowcase())}>🎬</button>
              <button title="Clean mode for recording (H)" className={clean ? "active" : ""} onClick={() => setClean(!clean)}>▣</button>
              <button title="Recording frame" className={frame !== "none" ? "active" : ""} onClick={() => setFrame(frame === "none" ? "16:9" : frame === "16:9" ? "4:5" : "none")}>{frame === "4:5" ? "4:5" : "▭"}</button>
            </nav>
          </div>
          {showcaseHero && (() => {
            const hero = heroes.find((item) => item.id === showcaseHero);
            return (
              <section className="showcase-setup glass-card" role="dialog" aria-label="Showcase">
                <header><b>Showcase</b><button onClick={() => setShowcaseHero(null)} title="Close">×</button></header>
                <p>A directed film of one shipment, gate to gate: arrival, gate check, picking, loading and departure, with the run's numbers on screen.</p>
                <label>Follow<select value={showcaseHero} onChange={(event) => setShowcaseHero(event.target.value)}>{heroes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
                {hero && <small>{hero.pallets} pallets · at the site {Math.round(hero.departed - hero.reported)} min · door {hero.dock ?? "?"}</small>}
                <div className="showcase-actions">
                  <button className="teal-action" onClick={() => void startShowcase(showcaseHero)}>▶ Play</button>
                  <button onClick={() => void startShowcase(showcaseHero, true)} title="Rendered frame by frame at 60 fps with the titles in the picture; the file downloads when done">⤓ Export MP4 · {frame === "4:5" ? "1080×1350" : "1920×1080"}</button>
                </div>
                <small>The 4:5 recording frame (▭ in the toolbar) exports a portrait video for a feed post.</small>
              </section>
            );
          })()}
          {showcase && !showcase.recorder && (() => {
            const total = showcaseSeconds(showcase.shots);
            const beat = showcase.shots.slice(0, showcaseAt.index + 1).reverse().find((shot) => shot.title)?.title;
            return (
              <div className={`showcase-controls${showcasePaused ? " paused" : ""}`} role="toolbar" aria-label="Showcase playback">
                <button onClick={() => stepShowcase(-1)} title="Previous step (←)">⏮</button>
                <button className="play" onClick={() => setShowcasePaused((value) => !value)} title={showcasePaused ? "Play (Space)" : "Pause (Space)"}>{showcasePaused ? "▶" : "⏸"}</button>
                <button onClick={() => stepShowcase(1)} title="Next step (→)">⏭</button>
                <span className="showcase-progress" title={beat}><i style={{ width: `${Math.min(100, (showcaseAt.elapsed / total) * 100)}%` }} /></span>
                <small>{showcasePaused ? "Paused · " : ""}{beat ?? ""}</small>
                <button onClick={stopShowcase} title="Stop (Esc)">■</button>
              </div>
            );
          })()}
          {exportProgress !== null && showcase && <div className="export-overlay" role="status"><b>Rendering video · {Math.round(exportProgress * 100)}%</b><span><i style={{ width: `${exportProgress * 100}%` }} /></span><small>{Math.round(showcaseSeconds(showcase.shots))} s at 60 fps · keep this tab in front · the file downloads when done</small><button onClick={stopShowcase}>Cancel</button></div>}
          {story && <div className="story-caption"><span>{story.steps[story.index]?.caption}</span><small>Step {Math.min(story.index + 1, story.steps.length)} of {story.steps.length} · Esc to stop</small><button onClick={() => setStory(null)}>Stop</button></div>}
          {frame !== "none" && <div className={`record-frame f${frame.replace(":", "x")}`} aria-hidden />}
          {clean && !story && !showcase && !fullscreen && <button className="clean-exit" onClick={() => setClean(false)}>Exit clean mode (H)</button>}
          {fullscreen && (
            <div className="fullscreen-bar">
              <button onClick={togglePlay} disabled={!playing && (settingsDirty || !hasValidRun)}>{playing ? "Ⅱ" : "▶"}</button>
              <span>{formatTime(result.start_timestamp, currentTime)}</span>
              <div className="top-speeds">{[1, 5, 15, 40].map((value) => <button key={value} className={speed === value ? "active" : ""} onClick={() => setSpeed(value)}>{value}×</button>)}</div>
              {openAlerts.length > 0 && <em className={criticalOpen ? "critical" : ""}>{openAlerts.length} delay{openAlerts.length === 1 ? "" : "s"}</em>}
              <button className="exit" onClick={toggleFullscreen}>Exit full screen</button>
            </div>
          )}
          <div className="map-hint">Drag to move · right-drag to rotate · scroll to zoom · Space pause · H hide panels{mode !== "replay" ? " · 1–4 disrupt" : ""}</div>


          <div className="bottom-dock glass-card">
            <div className="dock-metrics">
              <MetricCard label="Trucks on site" value={`${trucksOnSite}`} note={`${result.kpis.maximum_yard_queue} peak yard queue`} />
              {stats ? <>
                <MetricCard label="Average truck TAT" value={`${stats.turnaround_hours.mean.toFixed(2)} h`} note={`± ${stats.turnaround_hours.ci95.toFixed(2)} h · ${stats.replications} simulated days`} />
                <MetricCard label="Past the delivery slot" value={`${Math.round(stats.over_slot_pct)}%`} note={`${stats.yard_full_days}/${stats.replications} days the yard overflows`} />
                <MetricCard label="Cost of the day" value={stats.cost_inr.mean >= 1e5 ? `₹${(stats.cost_inr.mean / 1e5).toFixed(1)} L` : `₹${stats.cost_inr.mean.toLocaleString("en-IN")}`} note="Detention, missed slots, line stops" />
                <MetricCard label="Task time from fill" value={`×${stats.congestion_factor.toFixed(2)}`} note={`${Math.round(Number(cardValue("fillRate") ?? 0.5) * 100)}% warehouse fill`} />
              </> : <>
                <MetricCard label="Average truck TAT" value={`${result.kpis.average_turnaround_minutes.toFixed(0)} min`} note="Gate-in to gate-out" />
                <MetricCard label="P90 truck TAT" value={`${result.kpis.p90_turnaround_minutes.toFixed(0)} min`} note={`${yardDelay.toFixed(0)} min avg door wait`} />
                <MetricCard label="Pallets processed" value={`${processedPallets}`} note={`of ${result.kpis.pallets} planned`} />
                <MetricCard label="Reach-truck load" value={`${Math.round(result.kpis.reach_truck_utilization * 100)}%`} note={`${result.kpis.maximum_picking_queue} peak pick queue`} />
              </>}
            </div>
            <DoorTimeline result={result} currentTime={currentTime} onSeek={(minute) => { seek(minute); setPlaying(false); }} collapsed={Boolean(collapsed.timeline)} onToggle={togglePanel} />
          </div>


          <div className="stage-scrubber"><button disabled={!playing && (settingsDirty || !hasValidRun)} onClick={togglePlay}>{playing ? "Ⅱ" : "▶"}</button><input disabled={!hasValidRun} type="range" min={0} max={result.duration_minutes} step={.1} value={currentTime} onChange={(event) => { seek(Number(event.target.value)); setPlaying(false); }} /><span>{formatTime(result.start_timestamp, result.duration_minutes)}</span></div>
        </section>
      )}
      {futures && <FuturesView result={futures.result} error={futures.error} disruptionLabel={DISRUPTION_BUTTONS.find((item) => item.id === futures.disruption)?.label ?? futures.disruption} clock={(minutes) => `${formatDay(result.start_timestamp).slice(0, 3)} ${formatTime(result.start_timestamp, minutes)}`} forkAt={futures.forkAt} onClose={() => setFutures(null)} onPlay={(best, baseline) => void playFutures(best, baseline)} playing={futuresPlaying} />}
      {error && <div className="yard-error">{error}</div>}
    </main>
  );
}
