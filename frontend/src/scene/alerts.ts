// Delay and congestion alerts derived from a run.
//
// Each alert is an interval: it opens when a wait crosses its threshold and
// closes when the wait ends. Intervals are computed once per result; the UI
// asks which are open (popups) or have opened so far (notification feed).

import type { SimulationResult } from "../types";
import { laneTints, type SceneModel } from "./tracks";

export type AlertKind = "gate_hold" | "yard_wait" | "long_loading" | "pick_wait" | "production_late" | "dock_full" | "lane_overflow" | "stress_point" | "truck_slot" | "line_held";
export type Severity = "warning" | "critical";

export type AlertSpec = {
  id: string;
  kind: AlertKind;
  start: number;
  end: number;
  origin: number;
  criticalAt: number;
  entityId?: string;
  locationId?: string;
  title: string;
  describe: (minutes: number) => string;
};

export type ActiveAlert = {
  id: string;
  kind: AlertKind;
  severity: Severity;
  title: string;
  detail: string;
  entityId?: string;
  locationId?: string;
  start: number;
  minutes: number;
  open: boolean;
};

const THRESHOLDS = {
  gate: { warn: 25, critical: 45 },
  yard: { warn: 20, critical: 45 },
  loading: { warn: 60, critical: 90 },
};

/** Merge a per-minute condition into intervals, bridging short dips so one episode raises one alert. */
function scan(horizon: number, test: (t: number) => number, gap = 10) {
  const intervals: Array<{ start: number; end: number; peak: number; peakAt: number }> = [];
  let current: (typeof intervals)[number] | null = null;
  for (let t = 0; t <= horizon; t += 1) {
    const value = test(t);
    if (value > 0) {
      if (!current) current = { start: t, end: t + 1, peak: value, peakAt: t };
      current.end = t + 1;
      if (value > current.peak) {
        current.peak = value;
        current.peakAt = t;
      }
    } else if (current && t - current.end >= gap) {
      intervals.push(current);
      current = null;
    }
  }
  if (current) intervals.push(current);
  return intervals;
}

/**
 * Engine runs carry their own stress meters, truck slot marks and line stops
 * in the event log, so the alerts read those instead of re-deriving them.
 */
function engineAlerts(result: SimulationResult, model: SceneModel): AlertSpec[] {
  const specs: AlertSpec[] = [];
  const points = new Map((result.stress_points ?? []).map((point) => [point.id, point]));
  const meters = new Map<string, typeof result.trace>();
  result.trace.forEach((event) => {
    if (event.entity_id.startsWith("meter:")) meters.set(event.entity_id, [...(meters.get(event.entity_id) ?? []), event]);
  });
  meters.forEach((events, entity) => {
    const id = entity.slice("meter:".length);
    const point = points.get(id);
    let open: { start: number; criticalAt: number; peak: number } | null = null;
    const close = (end: number, index: number) => {
      if (!open) return;
      const span = open;
      if (end - span.start >= 3) {
        specs.push({
          id: `${id}:${index}`,
          kind: "stress_point",
          start: span.start,
          end,
          origin: span.start,
          criticalAt: span.criticalAt,
          locationId: point?.location ?? String(events[0].location_id ?? ""),
          title: `${point ? `${point.number}. ` : ""}${point?.label ?? id}`,
          describe: (m) => `${span.criticalAt < Infinity ? "Red" : "Amber"} for ${m} min · peak ${formatValue(point?.metric, span.peak)}`,
        });
      }
      open = null;
    };
    events.forEach((event, index) => {
      const value = Number(event.metadata?.value ?? 0);
      if (event.state === "normal") close(event.time, index);
      else {
        if (!open) open = { start: event.time, criticalAt: Infinity, peak: value };
        open.peak = Math.max(open.peak, value);
        if (event.state === "red") open.criticalAt = Math.min(open.criticalAt, event.time);
      }
    });
    close(model.horizon, events.length);
  });

  const trucks = model.tracks.filter((track) => track.kind === "truck");
  trucks.forEach((track) => {
    const amber = track.events.find((event) => event.metadata?.slot === "warning");
    if (!amber) return;
    const red = track.events.find((event) => event.metadata?.slot === "critical");
    const departed = track.events.find((event) => event.state === "departed")?.time ?? model.horizon;
    const reported = track.events.find((event) => event.state === "reported")?.time ?? amber.time;
    specs.push({ id: `${track.id}:slot`, kind: "truck_slot", start: amber.time, end: departed, origin: reported, criticalAt: red?.time ?? Infinity, entityId: track.id, locationId: "HOLDING-YARD", title: red ? "Truck past its slot" : "Truck near its slot", describe: (m) => `${track.id} on site ${m} min · ${String((red ?? amber).metadata?.reason ?? "")}` });
  });

  const held = result.trace.filter((event) => event.state === "line_held").map((event) => event.time);
  let start: number | null = null;
  let last = -Infinity;
  held.forEach((t, index) => {
    if (start === null) start = t;
    if (t - last > 10 && index > 0 && start !== t) {
      const from: number = start;
      specs.push({ id: `line:${from}`, kind: "line_held", start: from, end: last + 2, origin: from, criticalAt: from, locationId: "PRODUCTION-OUT", title: "Production line held", describe: (m) => `Finished-goods buffer full · line held ${m} min` });
      start = t;
    }
    last = t;
  });
  if (start !== null) {
    const from: number = start;
    specs.push({ id: `line:${from}`, kind: "line_held", start: from, end: last + 2, origin: from, criticalAt: from, locationId: "PRODUCTION-OUT", title: "Production line held", describe: (m) => `Finished-goods buffer full · line held ${m} min` });
  }
  return specs.sort((a, b) => a.start - b.start);
}

function formatValue(metric: string | undefined, value: number) {
  if (metric === "rt" || metric === "flt" || metric === "lanes" || metric === "fg") return `${Math.round(value * 100)}%`;
  return `${Math.round(value)}`;
}

export function buildAlerts(result: SimulationResult, model: SceneModel): AlertSpec[] {
  if (result.trace.some((event) => event.entity_id.startsWith("meter:"))) return engineAlerts(result, model);
  const specs: AlertSpec[] = [];
  const trucks = model.tracks.filter((track) => track.kind === "truck");

  trucks.forEach((track) => {
    const first = (state: string) => track.events.find((event) => event.state === state)?.time;
    const reported = first("reported");
    const yard = first("yard_wait");
    const docked = first("docked");
    const loading = first("loading");
    if (reported !== undefined && yard !== undefined && yard - reported > THRESHOLDS.gate.warn) {
      specs.push({ id: `${track.id}:gate`, kind: "gate_hold", start: reported + THRESHOLDS.gate.warn, end: yard, origin: reported, criticalAt: reported + THRESHOLDS.gate.critical, entityId: track.id, locationId: "GATE", title: "Held at gate", describe: (m) => `${track.id} has been at the gate for ${m} min` });
    }
    if (yard !== undefined) {
      const until = docked ?? model.horizon;
      if (until - yard > THRESHOLDS.yard.warn) {
        specs.push({ id: `${track.id}:yard`, kind: "yard_wait", start: yard + THRESHOLDS.yard.warn, end: until, origin: yard, criticalAt: yard + THRESHOLDS.yard.critical, entityId: track.id, locationId: "HOLDING-YARD", title: "Waiting for a dock", describe: (m) => `${track.id} waiting ${m} min in the yard` });
      }
    }
    if (loading !== undefined && track.dockWindow && track.dockWindow[1] - loading > THRESHOLDS.loading.warn) {
      specs.push({ id: `${track.id}:load`, kind: "long_loading", start: loading + THRESHOLDS.loading.warn, end: track.dockWindow[1], origin: loading, criticalAt: loading + THRESHOLDS.loading.critical, entityId: track.id, locationId: track.dockId, title: "Long loading", describe: (m) => `${track.id} loading for ${m} min at ${track.dockId}` });
    }
  });

  result.trace.forEach((event, index) => {
    if (event.entity_type !== "reach_truck" || event.state !== "picking" || event.severity === "normal") return;
    const wait = Number(event.metadata?.queue_wait_minutes ?? event.metadata?.wait_minutes ?? 0);
    const shipment = String(event.metadata?.shipment_id ?? event.case_id ?? "pick");
    specs.push({ id: `pick:${index}`, kind: "pick_wait", start: event.time, end: event.time + 15, origin: event.time - wait, criticalAt: event.severity === "critical" ? event.time : Infinity, locationId: event.location_id ?? undefined, title: "Pick waited for a reach truck", describe: () => `${shipment} pick waited ${Math.round(wait)} min at ${event.location_id ?? "racks"}` });
  });

  if (result.mode === "dynamic_simulation") {
    (result.shipment_schedule ?? []).forEach((shipment) => {
      const late = shipment.production_ready_minutes - shipment.planned_slot_minutes;
      if (late <= 5) return;
      specs.push({ id: `${shipment.shipment_id}:prod`, kind: "production_late", start: shipment.planned_slot_minutes, end: shipment.production_ready_minutes, origin: shipment.planned_slot_minutes, criticalAt: shipment.planned_slot_minutes + 30, entityId: shipment.shipment_id, locationId: "PRODUCTION-OUT", title: "Production behind slot", describe: (m) => `${shipment.shipment_id} pallets ${m} min behind the booked slot` });
    });
  }

  const docks = model.docks.length;
  const waitingAt = (t: number) =>
    trucks.filter((track) => {
      let state = "";
      for (const event of track.events) {
        if (event.time > t) break;
        state = event.state;
      }
      return state === "yard_wait" || state === "called_to_dock";
    }).length;
  scan(model.horizon, (t) => {
    let busy = 0;
    model.dockWindows.forEach((windows) => {
      if (windows.some(([from, to]) => t >= from && t <= to)) busy += 1;
    });
    const waiting = waitingAt(t);
    return busy >= docks && waiting >= 2 ? waiting : 0;
  }).forEach((interval, index) =>
    specs.push({ id: `docks:${index}`, kind: "dock_full", start: interval.start, end: interval.end, origin: interval.start, criticalAt: interval.peak >= 4 ? interval.peakAt : Infinity, locationId: "DOCK-APRON", title: "All docks busy", describe: (m) => `All ${docks} docks occupied · trucks queuing for ${m} min` }),
  );

  model.lanes.forEach((lane) => {
    const events = model.laneStock.get(lane.id);
    scan(model.horizon, (t) => {
      const count = laneTints(events, t).length;
      return count > lane.capacity ? count : 0;
    }).forEach((interval, index) =>
      specs.push({ id: `${lane.id}:${index}`, kind: "lane_overflow", start: interval.start, end: interval.end, origin: interval.start, criticalAt: interval.peak > lane.capacity * 1.25 ? interval.peakAt : Infinity, locationId: lane.id, title: "Lane over capacity", describe: () => `${lane.id} holds up to ${interval.peak} pallets (capacity ${lane.capacity})` }),
    );
  });

  return specs.sort((a, b) => a.start - b.start);
}

export function alertsAt(specs: AlertSpec[], t: number): ActiveAlert[] {
  return specs
    .filter((spec) => spec.start <= t)
    .map((spec) => {
      const open = t <= spec.end;
      const at = open ? t : spec.end;
      const minutes = Math.max(0, Math.round(at - spec.origin));
      return {
        id: spec.id,
        kind: spec.kind,
        severity: at >= spec.criticalAt ? "critical" : "warning",
        title: spec.title,
        detail: spec.describe(minutes),
        entityId: spec.entityId,
        locationId: spec.locationId,
        start: spec.start,
        minutes,
        open,
      } satisfies ActiveAlert;
    })
    .sort((a, b) => Number(b.open) - Number(a.open) || b.start - a.start);
}
