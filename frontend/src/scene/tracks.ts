// Converts the event trace into continuous, time-addressable motion.
//
// The trace only says *when* an entity changed state and *where* it was. A
// viewer needs to know where every vehicle is at any instant, so each entity
// gets a track of move/hold segments built once per result. Sampling a track is
// a pure function of time, which keeps scrubbing, seeking and playback in sync.
//
// Motion between events uses real equipment speeds and handling times from the
// resource catalogue. When a recorded window is shorter or longer than that
// physics allows, motion is time-scaled or padded with dwell so every vehicle
// still reaches each recorded state at the recorded time.

import type { Layout, TraceEvent } from "../types";
import { AisleGraph, Path, clamp01, dist, hash01, smooth, angleLerp, trapezoid, v, type Vec2 } from "./geometry";

export const FLOOR = 1.2; // dock-height slab: indoor floor sits level with truck decks
export const WALL_Y = 64.6;
export const DOCK_FACE_Y = 66.2;
export const ROAD_IN_Y = 90;
export const ROAD_OUT_Y = 94;
// The dock apron inside the hall: between the marshalling lanes (end at y 59)
// and the dock wall (64.6), two one-way travel lanes marked on the floor.
// Loaded forklifts run on the lane nearest the doors, empty ones return on the
// lane nearest the marshalling lanes; picks happen at the lane ends, just off it.
export const LOADED_Y = 63.5;
export const RETURN_Y = 61.8;
export const CORRIDOR_Y = (LOADED_Y + RETURN_Y) / 2;
export const CORRIDOR_HALF = 1.95;
export const LANE_PICK_GAP = 1.0;

/** Forklift routes on the apron: into a trailer on the loaded lane, everything else on the return lane. */
export function apronRoute(from: Vec2, to: Vec2): Vec2[] {
  const into = to.y > WALL_Y;
  const lane = into ? LOADED_Y : RETURN_Y;
  return [v(from.x, lane), v(to.x, lane), to];
}

/**
 * Vehicles already planned, for yielding. A vehicle about to drive checks its
 * path against every vehicle planned before it and, if they would meet, waits
 * a few seconds and goes, as a driver would; the drive keeps its own speed.
 */
export type Traffic = Track[];
const CLEAR = 1.7;
function meets(traffic: Traffic, path: Path, start: number, minutes: number, accel: number) {
  const samples = Math.max(4, Math.ceil(minutes / 0.02));
  let hits = 0;
  for (let k = 0; k <= samples; k += 1) {
    const u = k / samples;
    const p = path.at(path.length * trapezoid(u, accel));
    const t = start + minutes * u;
    for (const other of traffic) {
      const pose = samplePose(other, t);
      if (pose && Math.hypot(pose.x - p.x, pose.y - p.y) < CLEAR) hits += 1;
    }
  }
  return hits;
}
function standsIn(traffic: Traffic, point: Vec2, t0: number, t1: number) {
  for (let t = t0; t <= t1; t += 0.1) {
    for (const other of traffic) {
      const pose = samplePose(other, t);
      if (pose && Math.hypot(pose.x - point.x, pose.y - point.y) < CLEAR) return true;
    }
  }
  return false;
}
export const GATE_LANES = [66.6, 70.8];
export const GATE_STOP_X = 11;
export const GATE_BARRIER_X = 17.5;
export const EXIT_BARRIER_X = 12;
export const YARD_BAY_COUNT = 6;
export const yardBay = (index: number) => v(29 + 4.3 * index, 70.4);
export const YARD_BAY_ANGLE = Math.PI / 4;
/**
 * Waiting spots for trucks that do not fit a yard bay: a lay-by beyond the
 * outbound lane, east of the paperwork stop and clear of every dock's
 * reversing path. Spaced for a tractor-trailer.
 */
export const LAYBY_Y = ROAD_OUT_Y + 5.5;
export const laybySpot = (index: number) => v(60 + 19 * index, LAYBY_Y);

/**
 * A free yard bay at t, or -1. The 45° bays fit rigid trucks only: the yard
 * is too shallow for a tractor-trailer to straighten into one, and its trailer
 * would lie across the neighbouring bays. Tractor-trailers wait on the
 * shoulder of the approach road instead, parallel to the kerb.
 */
function freeBay(bayFree: number[], t: number, articulated: boolean) {
  return articulated ? -1 : bayFree.findIndex((free) => free <= t);
}
function bookBay(bayFree: number[], bay: number, until: number) {
  bayFree[bay] = until;
}

export type VehicleKind = "truck" | "reach_truck" | "forklift" | "pallet_truck";
export type TruckVariant = "17FT" | "20FT" | "32FT" | "40FT";

export const TRUCK_DIMS: Record<TruckVariant, { length: number; box: number; articulated: boolean; label: string; scale?: number }> = {
  // a 17 ft LCV reuses the 20 ft rigid model at 86% scale
  "17FT": { length: 7.4, box: 5.2, articulated: false, label: "17 ft LCV", scale: 0.86 },
  "20FT": { length: 8.6, box: 6.1, articulated: false, label: "20 ft rigid" },
  "32FT": { length: 11.6, box: 9.3, articulated: false, label: "32 ft rigid" },
  "40FT": { length: 6.0, box: 12.2, articulated: true, label: "40 ft tractor-trailer" },
};
export const KINGPIN_OFFSET = 1.6; // tractor centre to fifth wheel
export const TRAILER_FRONT_OVERHANG = 1.0; // kingpin to trailer nose
export const TRAILER_AXLE_FROM_KINGPIN = 8.8;
const dockedCentreY = (variant: TruckVariant) => {
  const dims = TRUCK_DIMS[variant];
  return dims.articulated
    ? DOCK_FACE_Y + KINGPIN_OFFSET + (dims.box - TRAILER_FRONT_OVERHANG)
    : DOCK_FACE_Y + dims.length / 2;
};

export type HandlingOp = { kind: "pick" | "drop"; height: number; duration: number; pallets: number };

type Context = { path: Path; s: number; reverse: boolean };

export type MoveSegment = { type: "move"; t0: number; t1: number; path: Path; reverse: boolean; carrying: number; odo0: number; accel: number };
export type HoldSegment = {
  type: "hold";
  t0: number;
  t1: number;
  x: number;
  y: number;
  yawFrom: number;
  yawFace: number;
  yawTo: number;
  turn: number;
  op?: HandlingOp;
  carrying: number;
  odo0: number;
  ctx: Context;
};
export type Segment = MoveSegment | HoldSegment;

export type Track = {
  id: string;
  kind: VehicleKind;
  variant?: TruckVariant;
  color: string;
  segments: Segment[];
  start: number;
  end: number;
  events: TraceEvent[];
  derived: boolean;
  role: string;
  pallets?: number;
  cargo?: number[];
  dockId?: string;
  dockWindow?: [number, number];
  tint?: string;
};

export type Pose = {
  x: number;
  y: number;
  angle: number;
  odo: number;
  lift: number;
  reach: number;
  carrying: number;
  moving: boolean;
  reverse: boolean;
  ctx: Context;
  activity: string;
};

export type EquipmentSpec = {
  resource_id: string;
  type: string;
  loaded_speed_mps?: number;
  empty_speed_mps?: number;
  pickup_seconds?: number;
  drop_seconds?: number;
};

export type DockSite = { id: string; cx: number; width: number; extra: boolean; types: string[] };
export type LaneSite = { id: string; cx: number; width: number; y0: number; y1: number; capacity: number };

export type StockEvent = { t: number; delta: number; tint: string };

export type SceneModel = {
  docks: DockSite[];
  lanes: LaneSite[];
  tracks: Track[];
  dockWindows: Map<string, Array<[number, number]>>;
  gatePasses: Array<{ lane: number; t: number }>;
  exitPasses: number[];
  laneStock: Map<string, StockEvent[]>;
  production: Array<{ t: number; pallets: number; tint: string }>;
  buffer: Array<{ t: number; occupancy: number }>;
  prestage: Array<{ t: number; count: number }>;
  engineLoaders: boolean;
  dockDown: Map<string, Array<[number, number]>>;
  horizon: number;
};

const TRAVEL_LIFT = 0.12;
const CARRY_LIFT = 0.3;
const MIN = 60; // seconds per minute
const TURN_MINUTES = 0.06;

export const SHIPMENT_TINTS = ["#d4553f", "#2f7ea6", "#e1a730", "#4f9a6a", "#8a62c9", "#cf6f9b", "#3aa6a0"];
export const tintFor = (key: string) => SHIPMENT_TINTS[Math.floor(hash01(key) * SHIPMENT_TINTS.length)];
const LIVERIES = ["#1f6f8b", "#d0573c", "#2e8a57", "#6b4fb5", "#c99a2e", "#34495e"];
// Body paint of warehouse trucks: shades within each kind's legend colour (equipment chips in
// styles.css), so units of one kind do not look like clones but the kind still reads at a glance.
const MHE_LIVERIES: Record<string, string[]> = {
  reach_truck: ["#f0a530", "#e6bb2e", "#e2852a"],
  forklift: ["#2f6f9f", "#24577f", "#3f8cc0", "#2b7a8c"],
  pallet_truck: ["#38a39a", "#2a8a80", "#4cb8a2"],
};
const mheLivery = (kind: string, id: string) => {
  const colours = MHE_LIVERIES[kind] ?? MHE_LIVERIES.reach_truck;
  return colours[Math.floor(hash01(`${id}:paint`) * colours.length)];
};

class Builder {
  segments: Segment[] = [];
  odo = 0;
  carrying = 0;
  ctx: Context;

  constructor(public t: number, public pos: Vec2, public angle: number, private turning: boolean) {
    this.ctx = { path: new Path([pos, v(pos.x + Math.cos(angle) * 0.1, pos.y + Math.sin(angle) * 0.1)]), s: 0, reverse: false };
  }

  move(points: Vec2[], duration: number, options: { reverse?: boolean; radius?: number; accel?: number } = {}) {
    const path = new Path([this.pos, ...points], options.radius ?? 1.4);
    if (path.length < 0.05) return;
    const reverse = Boolean(options.reverse);
    const startAngle = path.startAngle + (reverse ? Math.PI : 0);
    const last = this.segments[this.segments.length - 1];
    if (this.turning && last?.type === "hold") last.yawTo = startAngle;
    const t1 = this.t + Math.max(0.01, duration);
    this.segments.push({ type: "move", t0: this.t, t1, path, reverse, carrying: this.carrying, odo0: this.odo, accel: options.accel ?? 0.22 });
    const end = path.points[path.points.length - 1];
    this.pos = v(end.x, end.y);
    this.angle = path.endAngle + (reverse ? Math.PI : 0);
    this.odo += reverse ? -path.length : path.length;
    this.ctx = { path, s: path.length, reverse };
    this.t = t1;
  }

  /** A move that first gives way to planned traffic: waits up to `patience` minutes for a clear path. */
  drive(points: Vec2[], duration: number, traffic: Traffic | undefined, options: { reverse?: boolean; radius?: number; accel?: number } = {}, patience = 0.6) {
    if (traffic?.length) {
      const path = new Path([this.pos, ...points], options.radius ?? 1.4);
      const start = this.t;
      let best = { delay: 0, hits: Infinity };
      for (const delay of [0, 0.04, 0.08, 0.13, 0.2, 0.3, 0.42, 0.6]) {
        if (delay > patience) break;
        const hits = meets(traffic, path, start + delay, Math.max(0.01, duration), options.accel ?? 0.22);
        if (hits < best.hits) best = { delay, hits };
        if (hits === 0) break;
      }
      if (best.delay > 0) this.hold(start + best.delay);
    }
    const departure = this.t;
    this.move(points, duration, options);
    return departure;
  }

  hold(until: number, options: { face?: number; op?: HandlingOp } = {}) {
    if (until <= this.t + 1e-4) return;
    const face = this.turning && options.face !== undefined ? options.face : this.angle;
    this.segments.push({
      type: "hold",
      t0: this.t,
      t1: until,
      x: this.pos.x,
      y: this.pos.y,
      yawFrom: this.angle,
      yawFace: face,
      yawTo: face,
      turn: this.turning ? TURN_MINUTES : 0,
      op: options.op,
      carrying: this.carrying,
      odo0: this.odo,
      ctx: this.ctx,
    });
    if (options.op) this.carrying = options.op.kind === "pick" ? options.op.pallets : 0;
    this.angle = face;
    this.t = until;
  }
}

function handling(op: HandlingOp, fraction: number, carryingBefore: number) {
  const f = clamp01(fraction);
  const top = op.height + (op.kind === "pick" ? 0 : 0.12);
  const startLift = carryingBefore ? CARRY_LIFT : TRAVEL_LIFT;
  const endLift = op.kind === "pick" ? CARRY_LIFT : TRAVEL_LIFT;
  let lift: number;
  let reach = 0;
  if (f < 0.3) lift = startLift + (top - startLift) * smooth(f / 0.3);
  else if (f < 0.45) {
    lift = top;
    reach = smooth((f - 0.3) / 0.15);
  } else if (f < 0.55) {
    reach = 1;
    const k = smooth((f - 0.45) / 0.1);
    lift = op.kind === "pick" ? top + 0.12 * k : top - 0.12 * k;
  } else if (f < 0.7) {
    reach = 1 - smooth((f - 0.55) / 0.15);
    lift = op.kind === "pick" ? top + 0.12 : top - 0.12;
  } else {
    const from = op.kind === "pick" ? top + 0.12 : top - 0.12;
    lift = from + (endLift - from) * smooth((f - 0.7) / 0.3);
  }
  const carrying = f < 0.5 ? carryingBefore : op.kind === "pick" ? op.pallets : 0;
  return { lift, reach, carrying };
}

function findSegment(segments: Segment[], t: number) {
  let low = 0;
  let high = segments.length - 1;
  if (t <= segments[0].t0) return 0;
  if (t >= segments[high].t0) return high;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (segments[mid].t0 <= t) low = mid;
    else high = mid;
  }
  return low;
}

export function samplePose(track: Track, t: number): Pose | null {
  if (!track.segments.length || t < track.start || t > track.end) return null;
  const segment = track.segments[findSegment(track.segments, t)];
  if (segment.type === "move") {
    const u = clamp01((t - segment.t0) / (segment.t1 - segment.t0));
    const s = segment.path.length * trapezoid(u, segment.accel);
    const p = segment.path.at(s);
    return {
      x: p.x,
      y: p.y,
      angle: p.angle + (segment.reverse ? Math.PI : 0),
      odo: segment.odo0 + (segment.reverse ? -s : s),
      lift: segment.carrying ? CARRY_LIFT : TRAVEL_LIFT,
      reach: 0,
      carrying: segment.carrying,
      moving: u > 0 && u < 1,
      reverse: segment.reverse,
      ctx: { path: segment.path, s, reverse: segment.reverse },
      activity: segment.reverse ? "Reversing" : segment.carrying ? "Travelling loaded" : "Travelling",
    };
  }
  const span = segment.t1 - segment.t0;
  const turn = Math.min(segment.turn, span / 3);
  let angle = segment.yawFace;
  if (turn > 0 && t < segment.t0 + turn) angle = angleLerp(segment.yawFrom, segment.yawFace, smooth((t - segment.t0) / turn));
  else if (turn > 0 && t > segment.t1 - turn) angle = angleLerp(segment.yawFace, segment.yawTo, smooth((t - (segment.t1 - turn)) / turn));
  let lift = segment.carrying ? CARRY_LIFT : TRAVEL_LIFT;
  let reach = 0;
  let carrying = segment.carrying;
  let activity = "Waiting";
  if (segment.op) {
    const opStart = segment.t0 + turn;
    const fraction = (t - opStart) / segment.op.duration;
    const state = handling(segment.op, fraction, segment.carrying);
    ({ lift, reach, carrying } = state);
    if (fraction >= 0 && fraction <= 1) activity = segment.op.kind === "pick" ? (segment.op.height > 1 ? `Retrieving from level ${Math.round(segment.op.height / 1.45)}` : "Picking up pallet") : segment.op.height > 1.3 ? `Storing at level ${Math.round(segment.op.height / 1.45)}` : "Setting down pallet";
    else if (fraction > 1) activity = "Scanning and confirming";
  }
  return { x: segment.x, y: segment.y, angle, odo: segment.odo0, lift, reach, carrying, moving: false, reverse: false, ctx: segment.ctx, activity };
}

/** Latest trace event for a track at time t (for status and severity). */
export function latestEvent(track: Track, t: number): TraceEvent | undefined {
  let result: TraceEvent | undefined;
  for (const event of track.events) {
    if (event.time <= t) result = event;
    else break;
  }
  return result;
}

export function cargoCount(track: Track, t: number) {
  if (!track.cargo) return 0;
  let low = 0;
  let high = track.cargo.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (track.cargo[mid] <= t) low = mid + 1;
    else high = mid;
  }
  return low;
}

// --- site ------------------------------------------------------------------

function buildDocks(layout: Layout, dockIds: Set<string>): DockSite[] {
  const known = [...layout.docks].sort((a, b) => a.x - b.x).map((dock) => ({
    id: dock.dock_id,
    cx: dock.x + dock.width / 2,
    width: dock.width,
    extra: false,
    types: (dock as { supported_truck_types?: string[] }).supported_truck_types ?? [],
  }));
  const extras = [...dockIds].filter((id) => !known.some((dock) => dock.id === id)).sort();
  const last = known[known.length - 1] ?? { cx: 50, width: 9 };
  extras.forEach((id, index) => known.push({ id, cx: last.cx + 11 * (index + 1), width: 9, extra: true, types: ["20FT", "32FT", "40FT"] }));
  return known;
}

function buildGraph(layout: Layout) {
  const spines = [27, 65, 103];
  const segments: Array<[Vec2, Vec2]> = [
    [v(27, 10), v(27, 48)],
    [v(65, 12), v(65, 48)],
    [v(103, 12), v(103, 48)],
    [v(27, 18.5), v(103, 18.5)],
    [v(27, 31.5), v(103, 31.5)],
    [v(22, 48), v(105, 48)],
    [v(53, 48), v(53, RETURN_Y)],
    [v(105, 48), v(105, RETURN_Y)],
    [v(53, RETURN_Y), v(105, RETURN_Y)],
  ];
  layout.rack_blocks.forEach((rack) => {
    const y = rack.y + rack.height / 2;
    const left = Math.max(...spines.filter((x) => x <= rack.x));
    const right = Math.min(...spines.filter((x) => x >= rack.x + rack.width));
    segments.push([v(left, y), v(right, y)]);
  });
  return new AisleGraph(segments);
}

/** Where equipment stops to work. `spread` says which way a second vehicle steps aside: along the face (lanes, racks) or back from it (inside a trailer). */
type Anchor = { point: Vec2; face: number; height: number; spread?: "lateral" | "depth" };

/**
 * Who stands where, and when. Equipment tracks are built one vehicle at a
 * time; each vehicle books the spot it stops on until it moves off, so the
 * next vehicle that works at the same lane, rack or trailer stops beside it
 * instead of inside it. Only positions change: every recorded time is kept.
 */
export class FloorPlan {
  constructor(private traffic: Traffic = []) {}
  private spots: Array<{ id: string; x: number; y: number; t0: number; t1: number }> = [];
  private open = new Map<string, number>();
  private static CLEARANCE = 1.9;

  private closed = new Map<string, number>();

  /** The vehicle drives off at t: its current spot is free from then on. */
  leave(id: string, t: number) {
    const index = this.open.get(id);
    if (index === undefined) return;
    this.spots[index].t1 = t;
    this.open.delete(id);
    this.closed.set(id, index);
  }

  /** It gave way and actually drove off later, at t: the spot it left stays booked until then. */
  departed(id: string, t: number) {
    const index = this.closed.get(id);
    if (index !== undefined && this.spots[index].t1 < t) this.spots[index].t1 = t;
  }

  /** Books the nearest free spot to the anchor for a vehicle arriving at t0 and expected to stay `stay` minutes. */
  claim(id: string, anchor: Anchor, t0: number, stay: number): Vec2 {
    const across = v(Math.cos(anchor.face + Math.PI / 2), Math.sin(anchor.face + Math.PI / 2));
    const back = v(-Math.cos(anchor.face), -Math.sin(anchor.face));
    const offsets = anchor.spread === "depth"
      ? [0, 1.6, 3.2, 4.8, 6.4].map((k) => v(back.x * k, back.y * k))
      : [0, 2.1, -2.1, 4.2, -4.2, 6.3, -6.3].map((k) => v(across.x * k, across.y * k));
    const candidates = offsets.map((offset) => v(anchor.point.x + offset.x, anchor.point.y + offset.y));
    // a vehicle may give way on its way in and arrive up to a minute late: book with that margin
    const until = t0 + stay + 1;
    const spot = candidates.find((point) => this.free(id, point, t0, until) && !standsIn(this.traffic, point, t0, until))
      ?? candidates.find((point) => this.free(id, point, t0, until))
      ?? candidates[candidates.length - 1];
    this.open.set(id, this.spots.push({ id, x: spot.x, y: spot.y, t0, t1: Infinity }) - 1);
    return spot;
  }

  private free(id: string, point: Vec2, t0: number, t1: number) {
    return !this.spots.some((spot) => spot.id !== id && spot.t1 > t0 && spot.t0 < t1 && Math.hypot(spot.x - point.x, spot.y - point.y) < FloorPlan.CLEARANCE);
  }
}

function mheAnchor(layout: Layout, lanes: LaneSite[], location: string | null, key: string): Anchor {
  const rack = layout.rack_blocks.find((item) => item.rack_id === location);
  if (rack) {
    const north = hash01(`${key}:side`) > 0.5;
    const level = Math.floor(hash01(`${key}:level`) * 5);
    const x = rack.x + 1.6 + hash01(`${key}:bay`) * (rack.width - 3.2);
    return { point: v(x, rack.y + rack.height / 2), face: north ? Math.PI / 2 : -Math.PI / 2, height: level * 1.45 + (level ? 0.14 : 0) };
  }
  const lane = lanes.find((item) => item.id === location);
  if (lane) return { point: v(lane.cx + (hash01(`${key}:lane`) - 0.5) * Math.min(2.4, lane.width * 0.5), lane.y0 - 1.3), face: Math.PI / 2, height: 0 };
  const zone = layout.zones.find((item) => item.zone_id === location);
  if (zone && zone.x + zone.width < 30) {
    return { point: v(zone.x + zone.width + 1.6, zone.y + 2.5 + hash01(`${key}:zone`) * (zone.height - 5)), face: Math.PI, height: 0 };
  }
  if (zone) return { point: v(zone.x + zone.width / 2, Math.min(zone.y + zone.height / 2, 60)), face: Math.PI / 2, height: 0 };
  return { point: v(60, 48), face: 0, height: 0 };
}

const palletCount = (event: TraceEvent | undefined, fallback: number) => {
  const fromMeta = Number(event?.metadata?.pallets);
  if (Number.isFinite(fromMeta) && fromMeta > 0) return fromMeta;
  const match = event?.label?.match(/(\d+)\s*pallets?/);
  return match ? Number(match[1]) : fallback;
};

// --- builders --------------------------------------------------------------

function travelMinutes(metres: number, speed: number) {
  return (metres / Math.max(0.3, speed) / MIN) * 1.18 + 0.02;
}

type AnchorFn = (location: string | null, key: string, role: "src" | "dst", event: TraceEvent) => Anchor;
type MheOptions = { kind?: VehicleKind; home?: Vec2; anchor?: AnchorFn; color?: string; role?: string; onDrop?: (event: TraceEvent, time: number) => void; floor?: FloorPlan; route?: (from: Vec2, to: Vec2) => Vec2[]; traffic?: Traffic };
const TASK_STATES = new Set(["picking", "putaway", "loading_pallet"]);

function buildMheTrack(
  id: string,
  index: number,
  events: TraceEvent[],
  layout: Layout,
  lanes: LaneSite[],
  graph: AisleGraph,
  spec: EquipmentSpec | undefined,
  laneStock: Map<string, StockEvent[]>,
  options: MheOptions = {},
): Track {
  // reach trucks park in two columns beside the finished-goods buffer
  const home = options.home ?? v(22.4 - Math.floor(index / 6) * 2.4, 24.5 + (index % 6) * 2.9);
  const anchor: AnchorFn = options.anchor ?? ((location, key) => mheAnchor(layout, lanes, location, key));
  const builder = new Builder(0, home, 0, true);
  const empty = spec?.empty_speed_mps ?? 2.1;
  const loaded = spec?.loaded_speed_mps ?? 1.6;
  const pickMinutes = ((spec?.pickup_seconds ?? 55) / MIN) * 1.25;
  const dropMinutes = ((spec?.drop_seconds ?? 45) / MIN) * 1.25;
  const route = options.route ?? ((from: Vec2, to: Vec2) => graph.route(from, to));
  const traffic = options.traffic;
  const routeLength = (points: Vec2[]) => new Path(points, 1.4).length;

  for (let i = 0; i < events.length; i += 1) {
    const start = events[i];
    if (!TASK_STATES.has(start.state)) continue;
    const finish = events.slice(i + 1).find((event) => event.state === "idle");
    const t0 = start.time;
    const t1 = Math.max(t0 + 2, finish?.time ?? t0 + 20);
    const key = `${start.case_id ?? id}:${t0}`;
    const source = anchor(start.location_id, `${key}:src`, "src", start);
    const target = anchor(start.destination_id ?? finish?.location_id ?? null, `${key}:dst`, "dst", start);
    const shipment = String(start.metadata?.shipment_id ?? start.case_id ?? "");
    const tint = start.state === "putaway" ? "#b88a55" : tintFor(shipment);

    if (t0 - builder.t > 14 && dist(builder.pos, home) > 3) {
      builder.hold(builder.t + 2);
      options.floor?.leave(id, builder.t);
      builder.drive(route(builder.pos, home), travelMinutes(routeLength(route(builder.pos, home)), empty), traffic);
      builder.hold(builder.t + 0.1, { face: 0 });
    }
    builder.hold(t0);

    const firstEmpty = travelMinutes(routeLength(route(builder.pos, source.point)), empty);
    const laden = travelMinutes(routeLength(route(source.point, target.point)), loaded);
    const back = travelMinutes(routeLength(route(target.point, source.point)), empty);
    const handlingTime = pickMinutes + dropMinutes + TURN_MINUTES * 4;
    const firstTrip = firstEmpty + laden + handlingTime;
    const nextTrip = back + laden + handlingTime;
    const window = t1 - t0;
    const pallets = Math.max(1, Math.round(palletCount(start, 3)));
    const fit = window >= firstTrip ? 1 + Math.floor((window - firstTrip) / nextTrip) : 1;
    const trips = Math.max(1, Math.min(pallets, fit));
    const perTrip = Math.ceil(pallets / trips);
    const nominal = firstTrip + (trips - 1) * nextTrip;
    const scale = Math.min(1, window / nominal);
    const dwell = scale < 1 ? 0 : (window - nominal) / trips;

    for (let trip = 0; trip < trips; trip += 1) {
      const carried = trip === trips - 1 ? pallets - perTrip * (trips - 1) : perTrip;
      const loadCount = Math.max(1, Math.min(2, carried));
      const emptyMinutes = (trip === 0 ? firstEmpty : back) * scale;
      const pickDuration = pickMinutes * scale;
      options.floor?.leave(id, builder.t);
      const pickAt = options.floor?.claim(id, source, builder.t + emptyMinutes, pickDuration + TURN_MINUTES * 2 * scale) ?? source.point;
      options.floor?.departed(id, builder.drive(route(builder.pos, pickAt), emptyMinutes, traffic));
      builder.hold(builder.t + pickDuration + TURN_MINUTES * 2 * scale, { face: source.face, op: { kind: "pick", height: source.height, duration: pickDuration, pallets: loadCount } });
      const sourceLane = lanes.find((lane) => lane.id === start.location_id);
      if (sourceLane) laneStock.get(sourceLane.id)?.push({ t: builder.t - pickDuration * 0.5, delta: -carried, tint });
      const dropDuration = dropMinutes * scale;
      options.floor?.leave(id, builder.t);
      const dropAt = options.floor?.claim(id, target, builder.t + laden * scale, dropDuration + TURN_MINUTES * 2 * scale + dwell) ?? target.point;
      options.floor?.departed(id, builder.drive(route(builder.pos, dropAt), laden * scale, traffic));
      const dropStart = builder.t;
      const isLast = trip === trips - 1;
      const holdEnd = isLast ? Math.max(t1, dropStart + dropDuration + TURN_MINUTES) : dropStart + dropDuration + TURN_MINUTES * 2 * scale + dwell;
      builder.hold(holdEnd, { face: target.face, op: { kind: "drop", height: target.height, duration: dropDuration, pallets: loadCount } });
      const targetLane = lanes.find((lane) => lane.id === (start.destination_id ?? finish?.location_id));
      if (targetLane) laneStock.get(targetLane.id)?.push({ t: dropStart + TURN_MINUTES * scale + dropDuration * 0.5, delta: carried, tint });
      options.onDrop?.(start, dropStart + TURN_MINUTES * scale + dropDuration * 0.5);
    }
  }

  return {
    id,
    kind: options.kind ?? "reach_truck",
    color: options.color ?? mheLivery(options.kind ?? "reach_truck", id),
    segments: builder.segments.length ? builder.segments : [{ type: "hold", t0: 0, t1: 1e9, x: home.x, y: home.y, yawFrom: 0, yawFace: 0, yawTo: 0, turn: 0, carrying: 0, odo0: 0, ctx: builder.ctx }],
    start: 0,
    end: Infinity,
    events,
    derived: false,
    role: options.role ?? "Reach truck · picking and putaway",
  };
}

type TruckPlan = {
  track: Track;
  dock?: DockSite;
  window?: [number, number];
  load?: [number, number];
  lane?: string;
  pallets: number;
};

function inferVariant(events: TraceEvent[], pallets: number): TruckVariant {
  const declared = String(events.map((event) => event.metadata?.truck_type).find(Boolean) ?? "").replace(/\s+/g, "").toUpperCase();
  if (declared === "17FT" || declared === "20FT" || declared === "32FT" || declared === "40FT") return declared;
  return pallets <= 9 ? "17FT" : pallets <= 15 ? "20FT" : pallets <= 24 ? "32FT" : "40FT";
}

function buildTrucks(byEntity: Map<string, TraceEvent[]>, docks: DockSite[], horizon: number, gatePasses: SceneModel["gatePasses"], exitPasses: number[], shipmentLane: Map<string, string>): TruckPlan[] {
  const trucks = [...byEntity.entries()]
    .filter(([, events]) => events[0]?.entity_type === "truck")
    .map(([id, events]) => ({ id, events, reported: events.find((event) => event.state === "reported")?.time ?? events[0].time }))
    .sort((a, b) => a.reported - b.reported);
  const laneFree = [-Infinity, -Infinity];
  const bayFree = new Array(YARD_BAY_COUNT).fill(-Infinity);
  // queue spots on the approach road, per gate lane: spot k is free after the time stored
  const queueSpots: number[][] = [[], []];
  const shoulderFree: number[] = [];
  const exitFree: number[] = [];
  const dockSchedule = new Map<string, number[]>();
  trucks.forEach(({ events }) => {
    const docked = events.find((event) => event.state === "docked");
    if (docked?.location_id) dockSchedule.set(docked.location_id, [...(dockSchedule.get(docked.location_id) ?? []), docked.time].sort((a, b) => a - b));
  });
  const plans: TruckPlan[] = [];
  const yard = 4.4;
  const reverseSpeed = 1.4;

  trucks.forEach(({ id, events, reported }) => {
    const first = (state: string) => events.find((event) => event.state === state)?.time;
    const reportedEvent = events.find((event) => event.state === "reported");
    const pallets = palletCount(reportedEvent ?? events[0], 20);
    const variant = inferVariant(events, pallets);
    const dims = TRUCK_DIMS[variant];
    const dockedEvent = events.find((event) => event.state === "docked");
    const dock = docks.find((item) => item.id === dockedEvent?.location_id);
    const yardAt = first("yard_wait") ?? first("called_to_dock") ?? dockedEvent?.time ?? reported + 12;
    const dockedAt = dockedEvent?.time;
    const departedAt = first("departed");

    const lane = laneFree[0] <= laneFree[1] ? 0 : 1;
    const laneY = GATE_LANES[lane];
    const spawn = v(-70, laneY);
    const stop = v(GATE_STOP_X, laneY);
    const builder = new Builder(reported, spawn, 0, false);
    const approach = travelMinutes(dist(spawn, stop), 9);
    let laneStart = Math.max(reported + approach, laneFree[lane]);
    if (laneStart > yardAt - 0.4) laneStart = Math.max(reported + approach, yardAt - 0.4);
    laneFree[lane] = yardAt + 0.3;
    if (laneStart > reported + approach + 0.15) {
      const spots = queueSpots[lane];
      let queueIndex = spots.findIndex((freeAt) => freeAt <= reported);
      if (queueIndex < 0) queueIndex = spots.length;
      spots[queueIndex] = laneStart;
      const spot = v(GATE_STOP_X - 16 * (queueIndex + 1), laneY);
      builder.move([spot], travelMinutes(dist(spawn, spot), 9), { radius: 0 });
      builder.hold(laneStart - 0.12);
      builder.move([stop], 0.12, { radius: 0 });
    } else {
      builder.move([stop], approach, { radius: 0, accel: 0.35 });
    }
    let window: [number, number] | undefined;
    let load: [number, number] | undefined;
    if (dock && dockedAt !== undefined) {
      const centreY = dockedCentreY(variant);
      const reverseStart = v(dock.cx + (dims.articulated ? 17 : 13), ROAD_IN_Y);
      const reversePoints = [v(dock.cx, ROAD_IN_Y), v(dock.cx, centreY)];
      const reverseLength = new Path([reverseStart, ...reversePoints], 7).length;
      const reverseMinutes = travelMinutes(reverseLength, reverseSpeed) + 0.08;
      const minutes = (points: Vec2[], from: Vec2, radius: number) => travelMinutes(new Path([from, ...points], radius).length, yard);
      const directPoints = [v(19.5, laneY), v(22.5, 79), v(28, ROAD_IN_Y), reverseStart];
      const directMinutes = minutes(directPoints, stop, 5);

      const bay = freeBay(bayFree, yardAt, TRUCK_DIMS[variant].articulated);
      const bayPoint = bay >= 0 ? yardBay(bay) : null;
      const shoulderSlot = shoulderFree.findIndex((free) => free <= yardAt);
      const shoulderIndex = shoulderSlot >= 0 ? shoulderSlot : shoulderFree.length;
      const shoulder = laybySpot(shoulderIndex);
      const parkPoints = bayPoint ? [v(19.5, laneY), v(23, 66.4), v(bayPoint.x - 3.2, 66.4), bayPoint] : [v(19.5, laneY), v(22.5, 79), v(30, ROAD_IN_Y), v(shoulder.x - 14, ROAD_OUT_Y), shoulder];
      const parked = parkPoints[parkPoints.length - 1];
      const leavePoints = bayPoint ? [v(bayPoint.x + (ROAD_IN_Y - bayPoint.y), ROAD_IN_Y), reverseStart] : [v(shoulder.x + 8, ROAD_IN_Y), reverseStart];
      const parkMinutes = minutes(parkPoints, stop, 3);
      const leaveMinutes = minutes(leavePoints, parked, 7);
      const viaYard = dockedAt - yardAt >= parkMinutes + leaveMinutes + reverseMinutes + 1.5;

      // The simulator can call a truck to a dock the instant gate processing
      // ends. A truck cannot teleport, so the drive borrows the tail of the
      // gate hold and goes straight to the dock instead of parking first.
      const driveMinutes = viaYard ? 0 : directMinutes + reverseMinutes + 0.1;
      const leaveGate = viaYard ? yardAt : Math.max(laneStart + 0.25, Math.min(yardAt, dockedAt - driveMinutes));
      const scale = viaYard ? 1 : Math.min(1, Math.max(0.05, (dockedAt - leaveGate) / driveMinutes));
      builder.hold(leaveGate);
      gatePasses.push({ lane, t: leaveGate });
      if (viaYard) {
        builder.move(parkPoints, parkMinutes, { radius: 3 });
        const leaveAt = dockedAt - (leaveMinutes + reverseMinutes + 0.1);
        builder.hold(leaveAt);
        if (bayPoint) bookBay(bayFree, bay, leaveAt + 0.3);
        else shoulderFree[shoulderIndex] = leaveAt + 0.3;
        builder.move(leavePoints, leaveMinutes, { radius: 7 });
      } else {
        builder.move(directPoints, directMinutes * scale, { radius: 5 });
      }
      builder.hold(builder.t + 0.1 * scale);
      builder.move(reversePoints, reverseMinutes * scale, { reverse: true, radius: 7, accel: 0.3 });

      // Docks are released when loading ends; paperwork and weighing happen
      // afterwards, so the truck pulls into exit staging and leaves at gate-out.
      const loadingAt = first("loading") ?? dockedAt + 2;
      const loadedEstimate = first("loaded") ?? Math.max(loadingAt + 6, (departedAt ?? loadingAt + 40) - 18);
      const nextDocked = (dockSchedule.get(dock.id) ?? []).find((time) => time > dockedAt + 1e-6);
      const dockedPoint = v(dock.cx, centreY);
      const exitStop = v(EXIT_BARRIER_X + 10, ROAD_OUT_Y);
      const directExit = [v(dock.cx, ROAD_OUT_Y), exitStop];
      const directExitMinutes = minutes(directExit, dockedPoint, 6);
      let releaseAt = loadedEstimate + 0.4;
      if (nextDocked !== undefined) releaseAt = Math.min(releaseAt, nextDocked - 2.4);
      if (departedAt !== undefined) releaseAt = Math.min(releaseAt, departedAt - directExitMinutes - 0.15);
      releaseAt = Math.max(dockedAt + 0.5, releaseAt);
      if (departedAt === undefined) releaseAt = horizon;
      builder.hold(releaseAt);
      window = [dockedAt, releaseAt];
      load = [loadingAt, Math.max(loadingAt + 0.5, Math.min(loadedEstimate, releaseAt - 0.3))];
      if (departedAt !== undefined) {
        const slot = exitFree.findIndex((free) => free <= releaseAt);
        const index = slot >= 0 ? slot : exitFree.length;
        const spot = v(30 + 17 * index, ROAD_OUT_Y + 3.6);
        const toSpot = [v(dock.cx, ROAD_OUT_Y), v(spot.x + 8, ROAD_OUT_Y), spot];
        const fromSpot = [v(spot.x - 8, ROAD_OUT_Y), exitStop];
        const toSpotMinutes = minutes(toSpot, dockedPoint, 5);
        const fromSpotMinutes = minutes(fromSpot, spot, 5);
        const leaveTime = departedAt - 0.12;
        if (toSpotMinutes + fromSpotMinutes + 1.5 < leaveTime - releaseAt) {
          builder.move(toSpot, toSpotMinutes, { radius: 5 });
          builder.hold(leaveTime - fromSpotMinutes);
          exitFree[index] = leaveTime - fromSpotMinutes + 0.3;
          builder.move(fromSpot, fromSpotMinutes, { radius: 5 });
        } else {
          builder.move(directExit, Math.min(directExitMinutes, Math.max(0.05, leaveTime - releaseAt)), { radius: 6 });
        }
        builder.hold(leaveTime);
        exitPasses.push(departedAt);
        builder.move([v(-70, ROAD_OUT_Y)], travelMinutes(exitStop.x + 70, 9), { radius: 0, accel: 0.15 });
      }
    } else {
      builder.hold(yardAt);
      gatePasses.push({ lane, t: yardAt });
      const bay = freeBay(bayFree, yardAt, TRUCK_DIMS[variant].articulated);
      const bayPoint = yardBay(Math.max(0, bay));
      builder.move([v(19.5, laneY), v(23, 66.4), v(bayPoint.x - 3.2, 66.4), bayPoint], 0.6, { radius: 3 });
      if (bay >= 0) bookBay(bayFree, bay, Infinity);
      builder.hold(horizon);
    }

    const track: Track = {
      id,
      kind: "truck",
      variant,
      color: LIVERIES[Math.floor(hash01(id) * LIVERIES.length)],
      segments: builder.segments,
      start: reported,
      end: builder.t,
      events,
      derived: false,
      role: `${TRUCK_DIMS[variant].label} · ${pallets} pallets`,
      pallets,
      cargo: [],
      dockId: dock?.id,
      dockWindow: window,
      tint: tintFor(id),
    };
    plans.push({ track, dock, window, load, lane: shipmentLane.get(id), pallets });
  });
  return plans;
}

function buildLoaders(plans: TruckPlan[], lanes: LaneSite[], specs: EquipmentSpec[], laneStock: Map<string, StockEvent[]>): Track[] {
  const forklifts = specs.filter((spec) => spec.type === "forklift").map((spec) => spec.resource_id);
  const ids = [...(forklifts.length ? forklifts : ["FL-01", "FL-02"]), "PT-01", "PT-02", "PT-03", "PT-04"];
  const units = ids.map((id, index) => {
    const kind: VehicleKind = id.startsWith("FL") ? "forklift" : "pallet_truck";
    const home = v(kind === "forklift" ? 50 : 45, RETURN_Y + 0.4 - (index % 2) * 2.6);
    const spec = specs.find((item) => item.resource_id === id);
    return { id, kind, home, spec, builder: new Builder(0, home, 0, true), busy: false };
  });
  const corridor = apronRoute;

  plans
    .filter((plan) => plan.dock && plan.load)
    .sort((a, b) => a.load![0] - b.load![0])
    .forEach((plan) => {
      const [loadStart, loadEnd] = plan.load!;
      const ready = units.filter((unit) => unit.builder.t <= loadStart);
      const unit = ready[0] ?? [...units].sort((a, b) => a.builder.t - b.builder.t)[0];
      const builder = unit.builder;
      unit.busy = true;
      const dock = plan.dock!;
      const lane = lanes.find((item) => item.id === plan.lane) ?? lanes[Math.floor(hash01(plan.track.id) * lanes.length)];
      const dims = TRUCK_DIMS[plan.track.variant ?? "32FT"];
      const speed = unit.kind === "forklift" ? unit.spec?.loaded_speed_mps ?? 1.9 : 1.4;
      const pick = ((unit.spec?.pickup_seconds ?? 45) / MIN) * 1.2;
      const drop = ((unit.spec?.drop_seconds ?? 40) / MIN) * 1.2;
      const rows = Math.max(1, Math.floor((dims.box - 0.4) / 1.22));
      const slot = (index: number) => {
        const row = Math.floor(index / 2) % rows;
        const tier = Math.floor(index / (rows * 2));
        const side = index % 2 ? 0.46 : -0.46;
        const depth = dims.box - 0.7 - row * 1.22;
        return { point: v(dock.cx + side, DOCK_FACE_Y + depth - 1.7), height: tier * 1.32 };
      };
      if (loadStart > builder.t + 0.2) builder.hold(loadStart);
      const window = Math.max(1, loadEnd - Math.max(loadStart, builder.t));
      const pickPoint = v(lane.cx, lane.y1 + LANE_PICK_GAP);
      const tripLength = 2 * (Math.abs(lane.cx - dock.cx) + 6) + dims.box;
      const tripMinutes = travelMinutes(tripLength, speed) + pick + drop + TURN_MINUTES * 4 + 0.1;
      const palletsPerTrip = unit.kind === "forklift" && plan.pallets > 2 * window / tripMinutes ? 2 : 1;
      const trips = Math.ceil(plan.pallets / palletsPerTrip);
      const scale = Math.min(1.25, Math.max(0.35, window / (trips * tripMinutes)));
      const dwell = Math.max(0, (window - trips * tripMinutes * scale) / trips);
      const tint = plan.track.tint ?? "#c78f4d";
      let loaded = 0;
      for (let trip = 0; trip < trips; trip += 1) {
        const count = Math.min(palletsPerTrip, plan.pallets - loaded);
        const toLane = corridor(builder.pos, pickPoint);
        builder.move(toLane, travelMinutes(new Path([builder.pos, ...toLane], 1).length, speed) * scale, { radius: 1 });
        builder.hold(builder.t + (pick + TURN_MINUTES * 2) * scale, { face: -Math.PI / 2, op: { kind: "pick", height: 0, duration: pick * scale, pallets: count } });
        laneStock.get(lane.id)?.push({ t: builder.t - pick * scale * 0.5, delta: -count, tint });
        // back out of the lane end across the return lane onto the loaded lane
        builder.move([v(pickPoint.x, LOADED_Y)], 0.07 * scale + 0.03, { reverse: true, radius: 0 });
        builder.hold(builder.t + TURN_MINUTES * 1.4);
        const target = slot(loaded);
        const toTruck = [v(target.point.x, LOADED_Y), target.point];
        builder.move(toTruck, travelMinutes(new Path([builder.pos, ...toTruck], 1).length, speed) * scale, { radius: 1.2 });
        const dropStart = builder.t;
        builder.hold(builder.t + (drop + TURN_MINUTES * 2) * scale + dwell * 0.5, { face: Math.PI / 2, op: { kind: "drop", height: target.height, duration: drop * scale, pallets: count } });
        for (let k = 0; k < count; k += 1) plan.track.cargo!.push(dropStart + TURN_MINUTES * scale + drop * scale * 0.5);
        loaded += count;
        // back out of the trailer across the loaded lane onto the return lane
        builder.move([v(target.point.x, RETURN_Y)], travelMinutes(target.point.y - RETURN_Y, speed) * scale + 0.03, { reverse: true, radius: 0 });
        builder.hold(builder.t + TURN_MINUTES * 1.4 + dwell * 0.5);
      }
      builder.hold(builder.t + 0.6);
      const homeLeg = corridor(builder.pos, unit.home);
      builder.move(homeLeg, travelMinutes(new Path([builder.pos, ...homeLeg], 1).length, speed), { radius: 1 });
      builder.hold(builder.t + 0.1, { face: 0 });
    });

  return units
    .filter((unit) => unit.kind === "forklift" || unit.busy)
    .map((unit) => ({
      id: unit.id,
      kind: unit.kind,
      color: mheLivery(unit.kind, unit.id),
      segments: unit.builder.segments.length ? unit.builder.segments : [{ type: "hold" as const, t0: 0, t1: 1e9, x: unit.home.x, y: unit.home.y, yawFrom: 0, yawFace: 0, yawTo: 0, turn: 0, carrying: 0, odo0: 0, ctx: unit.builder.ctx }],
      start: 0,
      end: Infinity,
      events: [],
      derived: true,
      role: unit.kind === "forklift" ? "Counterbalance forklift · truck loading" : "Electric pallet truck · loading gang",
    }));
}

/**
 * A physical vehicle can only do one task at a time. Some simulated traces
 * label concurrent tasks with the same vehicle id, so each task (start event
 * plus its matching idle event) is re-assigned to a vehicle that is actually
 * free, preferring the id the trace gave it.
 */
function reconcileTasks(ids: string[], byEntity: Map<string, TraceEvent[]>) {
  type Task = { start: TraceEvent; finish?: TraceEvent; preferred: string };
  const tasks: Task[] = [];
  ids.forEach((id) => {
    const events = byEntity.get(id)!;
    const used = new Set<TraceEvent>();
    events.forEach((event, index) => {
      if (event.state !== "picking" && event.state !== "putaway") return;
      const finish = events.slice(index + 1).find((candidate) => candidate.state === "idle" && !used.has(candidate) && candidate.case_id === event.case_id);
      if (finish) used.add(finish);
      tasks.push({ start: event, finish, preferred: id });
    });
  });
  tasks.sort((a, b) => a.start.time - b.start.time);
  const freeAt = new Map(ids.map((id) => [id, -Infinity]));
  const assigned = new Map<string, TraceEvent[]>(ids.map((id) => [id, []]));
  tasks.forEach((task) => {
    const end = task.finish?.time ?? task.start.time + 20;
    const free = ids.filter((id) => freeAt.get(id)! <= task.start.time + 1e-6);
    const vehicle = free.includes(task.preferred) ? task.preferred : free[0] ?? [...ids].sort((a, b) => freeAt.get(a)! - freeAt.get(b)!)[0];
    freeAt.set(vehicle, end);
    const relabel = (event: TraceEvent) => (event.entity_id === vehicle ? event : { ...event, entity_id: vehicle, label: event.label?.replace(event.entity_id, vehicle) ?? null });
    assigned.get(vehicle)!.push(relabel(task.start));
    if (task.finish) assigned.get(vehicle)!.push(relabel(task.finish));
  });
  assigned.forEach((events) => events.sort((a, b) => a.time - b.time || (a.state === "idle" ? -1 : 1)));
  return assigned;
}

export function buildSceneModel(layout: Layout, trace: TraceEvent[], specs: EquipmentSpec[], dockCount: number): SceneModel {
  const byEntity = new Map<string, TraceEvent[]>();
  trace.forEach((event) => {
    const list = byEntity.get(event.entity_id);
    if (list) list.push(event);
    else byEntity.set(event.entity_id, [event]);
  });
  byEntity.forEach((events) => events.sort((a, b) => a.time - b.time));
  const horizon = trace.reduce((max, event) => Math.max(max, event.time), 0) + 30;

  const dockIds = new Set(trace.filter((event) => event.entity_type === "truck" && event.state === "docked" && event.location_id).map((event) => event.location_id!));
  for (let i = 1; i <= dockCount; i += 1) dockIds.add(`D${String(i).padStart(2, "0")}`);
  const docks = buildDocks(layout, dockIds);
  const lanes: LaneSite[] = layout.marshalling_lanes.map((lane) => ({ id: lane.lane_id, cx: lane.x + lane.width / 2, width: lane.width, y0: lane.y, y1: lane.y + lane.height, capacity: lane.capacity_pallets }));
  const graph = buildGraph(layout);
  const laneStock = new Map<string, StockEvent[]>(lanes.map((lane) => [lane.id, []]));

  const shipmentLane = new Map<string, string>();
  trace.forEach((event) => {
    if (event.entity_type !== "reach_truck" || event.state !== "picking" || !event.destination_id) return;
    const shipment = String(event.metadata?.shipment_id ?? event.case_id ?? "");
    if (shipment && !shipmentLane.has(shipment)) shipmentLane.set(shipment, event.destination_id);
  });

  const reachIds = [...byEntity.keys()].filter((id) => byEntity.get(id)![0].entity_type === "reach_truck").sort();
  const reconciled = reconcileTasks(reachIds, byEntity);
  // equipment is planned one vehicle at a time; each gives way to the ones planned before it
  const traffic: Traffic = [];
  const floor = new FloorPlan(traffic);
  const mhe = reachIds.map((id, index) => {
    const track = buildMheTrack(id, index, reconciled.get(id)!, layout, lanes, graph, specs.find((spec) => spec.resource_id === id), laneStock, { floor, traffic });
    traffic.push(track);
    return track;
  });

  const gatePasses: SceneModel["gatePasses"] = [];
  const exitPasses: number[] = [];
  const plans = buildTrucks(byEntity, docks, horizon, gatePasses, exitPasses, shipmentLane);
  // The engine records every forklift task. Older traces do not, so loader
  // motion is then derived from each truck's loading window instead.
  const forkliftIds = [...byEntity.keys()].filter((id) => byEntity.get(id)![0].entity_type === "forklift").sort();
  const engineLoaders = forkliftIds.length > 0;
  const loaders = engineLoaders ? buildEngineForklifts(forkliftIds, byEntity, plans, docks, layout, lanes, graph, specs, laneStock, floor, traffic) : buildLoaders(plans, lanes, specs, laneStock);
  plans.forEach((plan) => plan.track.cargo!.sort((a, b) => a - b));

  const dockWindows = new Map<string, Array<[number, number]>>();
  plans.forEach((plan) => {
    if (!plan.dock || !plan.window) return;
    dockWindows.set(plan.dock.id, [...(dockWindows.get(plan.dock.id) ?? []), plan.window]);
  });
  laneStock.forEach((events) => events.sort((a, b) => a.t - b.t));

  const production = trace
    .filter((event) => event.entity_type === "pallet" && event.state === "production_released")
    .map((event) => ({ t: event.time, pallets: palletCount(event, 4), tint: tintFor(String(event.case_id ?? event.entity_id)) }));
  const buffer = trace
    .filter((event) => typeof event.metadata?.buffer_occupancy === "number")
    .map((event) => ({ t: event.time, occupancy: Number(event.metadata.buffer_occupancy) }));
  const prestage = trace
    .filter((event) => typeof event.metadata?.prestage === "number")
    .map((event) => ({ t: event.time, count: Number(event.metadata.prestage) }));
  // docks taken out of service by a disruption: [from, to] per dock
  const dockDown = new Map<string, Array<[number, number]>>();
  trace.filter((event) => event.entity_type === "system" && event.entity_id.startsWith("DOCK-")).forEach((event) => {
    const dock = event.entity_id.slice(5);
    const list = dockDown.get(dock) ?? [];
    if (event.state === "down") list.push([event.time, Infinity]);
    else if (event.state === "restored" && list.length) list[list.length - 1][1] = event.time;
    dockDown.set(dock, list);
  });

  return {
    docks,
    lanes,
    tracks: [...plans.map((plan) => plan.track), ...mhe, ...loaders],
    dockWindows,
    gatePasses,
    exitPasses,
    laneStock,
    production,
    buffer,
    prestage,
    engineLoaders,
    dockDown,
    horizon,
  };
}

function buildEngineForklifts(
  ids: string[],
  byEntity: Map<string, TraceEvent[]>,
  plans: TruckPlan[],
  docks: DockSite[],
  layout: Layout,
  lanes: LaneSite[],
  graph: AisleGraph,
  specs: EquipmentSpec[],
  laneStock: Map<string, StockEvent[]>,
  floor: FloorPlan,
  traffic: Traffic,
): Track[] {
  const planByTruck = new Map(plans.map((plan) => [plan.track.id, plan]));
  // the k-th pallet loaded into a truck goes to its k-th cargo slot, in time order
  const slotOf = new Map<TraceEvent, number>();
  const counters = new Map<string, number>();
  ids
    .flatMap((id) => byEntity.get(id)!.filter((event) => event.state === "loading_pallet"))
    .sort((a, b) => a.time - b.time)
    .forEach((event) => {
      const truck = String(event.case_id);
      const index = counters.get(truck) ?? 0;
      counters.set(truck, index + 1);
      slotOf.set(event, index);
    });
  const anchor: AnchorFn = (location, key, role, event) => {
    if (role === "src") {
      const lane = lanes.find((item) => item.id === location);
      if (lane) return { point: v(lane.cx, lane.y1 + LANE_PICK_GAP), face: -Math.PI / 2, height: 0 };
      return mheAnchor(layout, lanes, location, key);
    }
    const dock = docks.find((item) => item.id === location);
    const plan = planByTruck.get(String(event.case_id));
    if (!dock) return { point: v(60, CORRIDOR_Y), face: Math.PI / 2, height: 0 };
    const dims = TRUCK_DIMS[plan?.track.variant ?? "32FT"];
    const rows = Math.max(1, Math.floor((dims.box - 0.4) / 1.22));
    const index = slotOf.get(event) ?? 0;
    const row = Math.floor(index / 2) % rows;
    const tier = Math.floor(index / (rows * 2));
    const depth = dims.box - 0.7 - row * 1.22;
    return { point: v(dock.cx + (index % 2 ? 0.46 : -0.46), DOCK_FACE_Y + depth - 1.7), face: Math.PI / 2, height: tier * 1.32, spread: "depth" };
  };
  return ids.map((id, index) => {
    const spec = specs.find((item) => item.resource_id === id) ?? { resource_id: id, type: "forklift", loaded_speed_mps: 1.9, empty_speed_mps: 2.5, pickup_seconds: 45, drop_seconds: 40 };
    const track = buildMheTrack(id, index, byEntity.get(id)!, layout, lanes, graph, spec, laneStock, {
      kind: "forklift",
      home: v(38 + index * 2.6, 62.2),
      anchor,
      color: mheLivery("forklift", id),
      role: "Counterbalance forklift · truck loading",
      onDrop: (event, time) => planByTruck.get(String(event.case_id))?.track.cargo?.push(time),
      floor,
      traffic,
      route: apronRoute,
    });
    traffic.push(track);
    return track;
  });
}

/** Door opening 0..1 for a dock at time t, eased so doors roll rather than snap. */
export function dockOpen(windows: Array<[number, number]> | undefined, t: number) {
  if (!windows) return 0;
  let open = 0;
  windows.forEach(([from, to]) => {
    const rise = smooth((t - (from - 0.5)) / 0.45);
    const fall = 1 - smooth((t - to) / 0.45);
    open = Math.max(open, Math.min(rise, fall));
  });
  return open;
}

export function barrierLift(passes: number[], t: number) {
  let lift = 0;
  passes.forEach((pass) => {
    const up = smooth((t - (pass - 0.18)) / 0.08);
    const down = 1 - smooth((t - (pass + 0.22)) / 0.1);
    lift = Math.max(lift, Math.min(up, down));
  });
  return lift;
}

export function laneTints(events: StockEvent[] | undefined, t: number) {
  const stack: string[] = [];
  if (!events) return stack;
  for (const event of events) {
    if (event.t > t) break;
    if (event.delta > 0) for (let i = 0; i < event.delta; i += 1) stack.push(event.tint);
    else {
      for (let i = 0; i < -event.delta; i += 1) {
        const index = stack.lastIndexOf(event.tint);
        if (index >= 0) stack.splice(index, 1);
        else stack.shift();
      }
    }
  }
  return stack;
}
