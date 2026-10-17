// Camera director for showcase playback. Generic: nothing here knows about
// trucks or docks. A story for a particular simulation lives in scene/flows/
// and only produces a list of shots.
//
// A shot names a subject (a vehicle track or a site location), a slice of
// simulated time to play, how many real seconds that slice lasts on screen, a
// shot type that places the camera relative to the subject, and the lower-third
// text (a title and one fact). Evaluating a shot is a pure function of its
// progress, so a showcase plays back identically every time and renders frame
// by frame for export.
//
// Camera grammar (see .claude/skills/showcase/SKILL.md):
//   workAt   a tripod in the aisle at the spot where equipment handles a load, aimed at the forks
//   fixed    a tripod at a place chosen by the flow (plan x, height, plan y), aimed at a point: process views
//   lead     travels ahead of equipment on its own route, looking back at the forks and the load
//   follow   trails equipment along the route it just drove (only where the load is not hidden by the mast)
//   lockOff  a tripod placed relative to the subject: checks, docking, exits
//   orbit / pushIn / crane / establish   for places and time-lapses
//   track / chase   for vehicles on open ground

import * as THREE from "three";

import { FLOOR, KINGPIN_OFFSET, TRAILER_FRONT_OVERHANG, TRUCK_DIMS, samplePose, type SceneModel, type Track } from "./tracks";

export type ShotKind = "establish" | "crane" | "chase" | "track" | "orbit" | "pushIn" | "topDown" | "follow" | "lockOff" | "workAt" | "lead" | "fixed";

export type ShotParams = {
  /** metres from the subject (behind it, for follow and chase) */
  distance: number;
  /** metres above the subject */
  height: number;
  /** world azimuth in degrees, from +z (the yard side) towards +x */
  angle: number;
  /** degrees the azimuth turns over the shot */
  sweep: number;
  fov: number;
  /** which side of the subject a tracking or lock-off camera stands on */
  side: 1 | -1;
  /** metres ahead of the subject the camera looks */
  lead: number;
  /** lock-off: metres forward / sideways of the subject's pose at `anchor` */
  forward: number;
  across: number;
  /** lock-off: which moment fixes the tripod (0 = shot start, 1 = shot end) */
  anchor: number;
  /** metres above the subject the camera aims */
  aim: number;
};

export type Shot = {
  kind: ShotKind;
  /** a track id, a location id, or "SITE" */
  subject: string;
  /** simulated minutes played during the shot */
  from: number;
  to: number;
  /** real seconds on screen */
  seconds: number;
  /** lower-third headline; a shot without one keeps the previous text */
  title?: string;
  /** one line with a number from the run */
  fact?: string;
  /** fixed shots: camera and aim point as [plan x, height above floor, plan y] */
  camera?: [number, number, number];
  target?: [number, number, number];
  /** hard cut into this shot; otherwise the camera blends from the previous one */
  cut?: boolean;
  /** dip to black into this shot (an act change) */
  dip?: boolean;
  params?: Partial<ShotParams>;
};

export type Showcase = { hero: string; shots: Shot[]; label?: string };

export type Stage = {
  tracks: Map<string, Track>;
  locations: Map<string, THREE.Vector3>;
  origin: { x: number; y: number };
  site: THREE.Vector3;
};

export type CameraPose = { position: THREE.Vector3; look: THREE.Vector3; fov: number };

const BASE: ShotParams = { distance: 20, height: 10, angle: 30, sweep: 0, fov: 40, side: 1, lead: 0, forward: 0, across: 0, anchor: 0, aim: 0 };
const DEFAULTS: Record<ShotKind, Partial<ShotParams>> = {
  establish: { distance: 125, height: 88, angle: 30, sweep: 18, fov: 38 },
  crane: { distance: 24, height: 13, angle: 35, sweep: 20 },
  chase: { distance: 15, height: 6.5, fov: 46, lead: 6 },
  track: { distance: 13, height: 4, fov: 38, lead: 2 },
  orbit: { distance: 22, height: 11, angle: 25, sweep: 40 },
  pushIn: { distance: 30, height: 14, angle: 35, sweep: 6, fov: 42 },
  topDown: { distance: 6, height: 58, sweep: 14 },
  // a camera operator walking behind the vehicle, eye level above the forks
  follow: { distance: 6.5, height: 2.6, fov: 50, lead: 3, aim: 0.4 },
  lockOff: { forward: 8, across: 7, height: 1.6, fov: 36, aim: 0.6 },
  // distance along the aisle from the handling spot; height is chosen from the lift height
  workAt: { distance: 6.5, fov: 44, anchor: 1 },
  // metres ahead on the route, metres above the floor
  lead: { distance: 6.5, height: 2.8, fov: 46 },
  // sweep: metres the camera drifts towards the target over the shot
  fixed: { fov: 46, sweep: 1.5 },
};

const UP = new THREE.Vector3(0, 1, 0);
const smoothstep = (u: number) => u * u * (3 - 2 * u);
const clamp01 = (u: number) => Math.min(1, Math.max(0, u));
const rad = THREE.MathUtils.degToRad;

function poseNear(track: Track, t: number) {
  return samplePose(track, t) ?? samplePose(track, Math.min(Math.max(t, track.start), Number.isFinite(track.end) ? track.end - 1e-3 : t));
}

function worldOf(stage: Stage, track: Track, x: number, y: number) {
  return new THREE.Vector3(x - stage.origin.x, track.kind === "truck" ? 1.8 : FLOOR + 1.4, y - stage.origin.y);
}

/** Where the subject is at sim time t, and which way it faces (unit, horizontal). */
export function subjectAt(stage: Stage, subject: string, t: number) {
  const track = stage.tracks.get(subject);
  if (!track) {
    const at = subject === "SITE" ? stage.site : stage.locations.get(subject) ?? stage.site;
    return { pos: at.clone(), dir: new THREE.Vector3(0, 0, 1) };
  }
  const pose = poseNear(track, t);
  if (!pose) return { pos: stage.site.clone(), dir: new THREE.Vector3(0, 0, 1) };
  // body heading averaged over a short window so turns read as one smooth swing
  const dir = new THREE.Vector3();
  for (let i = -3; i <= 3; i += 1) {
    const sample = samplePose(track, t + i * 0.12) ?? pose;
    dir.x += Math.cos(sample.angle);
    dir.z += Math.sin(sample.angle);
  }
  if (dir.lengthSq() < 1e-6) dir.set(Math.cos(pose.angle), 0, Math.sin(pose.angle));
  dir.normalize();
  const pos = worldOf(stage, track, pose.x, pose.y);
  // a tractor-trailer's pose is the tractor: aim at the middle of the whole rig
  const dims = track.variant ? TRUCK_DIMS[track.variant] : null;
  if (dims?.articulated) pos.addScaledVector(dir, -(KINGPIN_OFFSET + dims.box / 2 - TRAILER_FRONT_OVERHANG) * 0.75);
  return { pos, dir };
}

/**
 * The point on the route the vehicle drove, `distance` metres back. A camera
 * placed there stays in the aisle the vehicle came down, so racks never come
 * between them, and it holds still while the vehicle stops to work.
 */
function trailPoint(stage: Stage, track: Track, t: number, distance: number) {
  const now = poseNear(track, t);
  if (!now) return null;
  let travelled = 0;
  let last = now;
  for (let back = 0.02; back <= 4; back += 0.02) {
    const pose = samplePose(track, t - back);
    if (!pose) break;
    travelled += Math.hypot(pose.x - last.x, pose.y - last.y);
    last = pose;
    if (travelled >= distance) return worldOf(stage, track, pose.x, pose.y);
  }
  return null;
}

/** Where the forks (and any load on them) are: the work the camera should be looking at. */
function forksAt(stage: Stage, track: Track, t: number) {
  const pose = poseNear(track, t);
  if (!pose) return null;
  const ahead = 1.3 + pose.reach * 0.8;
  return new THREE.Vector3(pose.x + Math.cos(pose.angle) * ahead - stage.origin.x, FLOOR + Math.max(0, pose.lift) + 0.55, pose.y + Math.sin(pose.angle) * ahead - stage.origin.y);
}

/** The point `distance` metres ahead on the route the vehicle is about to drive; past the end of its run, straight on. */
function routeAhead(stage: Stage, track: Track, t: number, distance: number) {
  const now = poseNear(track, t);
  if (!now) return null;
  let travelled = 0;
  let last = now;
  let heading = { x: Math.cos(now.angle), y: Math.sin(now.angle) };
  for (let step = 0.02; step <= 3; step += 0.02) {
    const pose = samplePose(track, t + step);
    if (!pose) break;
    const moved = Math.hypot(pose.x - last.x, pose.y - last.y);
    if (moved > 1e-4) heading = { x: (pose.x - last.x) / moved, y: (pose.y - last.y) / moved };
    travelled += moved;
    last = pose;
    if (travelled >= distance) return worldOf(stage, track, pose.x, pose.y);
    // a long stop ends the run: the camera stays put beyond where it stops
    const segment = track.segments.find((item) => item.t0 <= t + step && item.t1 > t + step);
    if (segment?.type === "hold" && segment.t1 - segment.t0 > 0.5) break;
  }
  const rest = distance - travelled;
  return worldOf(stage, track, last.x + heading.x * rest, last.y + heading.y * rest);
}

type Hold = Extract<Track["segments"][number], { type: "hold" }>;
const tripods = new WeakMap<Shot, { x: number; y: number; z: number } | null>();

/**
 * Where to stand in the aisle to watch a vehicle work at a hold: along the
 * aisle on either side, 4.5 to 10 m out. Spots where another vehicle crosses
 * the line of sight to the forks during the work lose; ties go to the side
 * the vehicle drove towards, then to the nearer spot. Worked out once per shot.
 */
function tripodFor(stage: Stage, shot: Shot, track: Track, hold: Hold, distance: number) {
  if (tripods.has(shot)) return tripods.get(shot)!;
  const face = { x: Math.cos(hold.yawFace), y: Math.sin(hold.yawFace) };
  let along = { x: -face.y, y: face.x };
  const before = samplePose(track, hold.t0 - 0.15);
  if (before && (hold.x - before.x) * along.x + (hold.y - before.y) * along.y < 0) along = { x: -along.x, y: -along.y };
  const tip = { x: hold.x + face.x * 1.3, y: hold.y + face.y * 1.3 };
  const others = [...stage.tracks.values()].filter((other) => other !== track && other.kind !== "truck");
  const times = [0, 0.25, 0.5, 0.75, 1].map((k) => hold.t0 + (hold.t1 - hold.t0) * k);
  const lift = hold.op?.height ?? 0;
  const tipHeight = FLOOR + lift + 0.6;
  const blocked = (cam: { x: number; y: number }, camHeight: number) => {
    let hits = 0;
    for (const t of times) {
      for (const other of others) {
        const pose = samplePose(other, t);
        if (!pose) continue;
        // distance from the other vehicle to the sight line camera → forks, in plan
        const vx = tip.x - cam.x;
        const vy = tip.y - cam.y;
        const k = Math.max(0, Math.min(1, ((pose.x - cam.x) * vx + (pose.y - cam.y) * vy) / (vx * vx + vy * vy)));
        // equipment stands about 3.2 m tall: a sight line passing above it is clear
        const lineHeight = camHeight + (tipHeight - camHeight) * k;
        if (lineHeight < FLOOR + 3.4 && Math.hypot(cam.x + vx * k - pose.x, cam.y + vy * k - pose.y) < 1.6) hits += 1;
      }
    }
    return hits;
  };
  const working = FLOOR + Math.min(5.2, Math.max(2.4, lift + 1.4));
  let best: { x: number; y: number; h: number; score: number } | null = null;
  for (const [h, penalty] of [[working, 0], [FLOOR + 7.2, 40]] as const) {
    for (const side of [1, -1]) {
      for (const reach of [distance, distance - 2, distance + 1.5, distance + 3.5]) {
        const cam = { x: hold.x + along.x * side * reach - face.x * 0.6, y: hold.y + along.y * side * reach - face.y * 0.6 };
        const score = blocked(cam, h) * 100 + penalty + (side === 1 ? 0 : 5) + Math.abs(reach - distance);
        if (!best || score < best.score) best = { ...cam, h, score };
      }
    }
  }
  const spot = best ? { x: best.x - stage.origin.x, y: best.h, z: best.y - stage.origin.y } : null;
  tripods.set(shot, spot);
  return spot;
}

/** Camera pose for a shot at progress u (0..1). */
export function evaluateShot(stage: Stage, shot: Shot, u: number): CameraPose {
  const p: ShotParams = { ...BASE, ...DEFAULTS[shot.kind], ...shot.params };
  const t = shot.from + (shot.to - shot.from) * u;
  const e = smoothstep(clamp01(u));
  const { pos: s, dir: d } = subjectAt(stage, shot.subject, t);
  const side = new THREE.Vector3(-d.z, 0, d.x).multiplyScalar(p.side);
  const aim = s.clone().addScaledVector(UP, p.aim);
  const around = (azimuth: number, radius: number, height: number) =>
    s.clone().add(new THREE.Vector3(Math.sin(rad(azimuth)) * radius, height, Math.cos(rad(azimuth)) * radius));

  switch (shot.kind) {
    case "establish":
      return { position: around(p.angle + p.sweep * e, p.distance * (1.08 - 0.12 * e), p.height * (1.1 - 0.15 * e)), look: s, fov: p.fov };
    case "crane":
      // starts high and wide, settles down onto the subject
      return { position: around(p.angle + p.sweep * e, p.distance * (1.5 - 0.5 * e), p.height * (2.4 - 1.4 * e)), look: aim, fov: p.fov };
    case "chase":
      return { position: s.clone().addScaledVector(d, -p.distance * (1.1 - 0.15 * e)).addScaledVector(UP, p.height), look: aim.addScaledVector(d, p.lead), fov: p.fov };
    case "track":
      return { position: s.clone().addScaledVector(side, p.distance).addScaledVector(d, -p.distance * 0.3).addScaledVector(UP, p.height), look: aim.addScaledVector(d, p.lead), fov: p.fov };
    case "orbit":
      return { position: around(p.angle + p.sweep * e, p.distance, p.height), look: aim, fov: p.fov };
    case "pushIn":
      return { position: around(p.angle + p.sweep * e, p.distance * (1.5 - 0.6 * e), p.height * (1.3 - 0.4 * e)), look: aim, fov: p.fov - 8 * e };
    case "topDown":
      return { position: around(p.angle + p.sweep * e, p.distance, p.height), look: s, fov: p.fov };
    case "follow": {
      const track = stage.tracks.get(shot.subject);
      const trail = track ? trailPoint(stage, track, t, p.distance) : null;
      const position = (trail ?? s.clone().addScaledVector(d, -p.distance)).addScaledVector(UP, p.height);
      // look past the vehicle along the line from the camera, so it sits in the lower middle of the frame
      const ahead = s.clone().sub(position).setY(0);
      const look = aim.clone().addScaledVector(ahead.lengthSq() > 1e-6 ? ahead.normalize() : d, p.lead);
      return { position, look, fov: p.fov };
    }
    case "workAt": {
      const track = stage.tracks.get(shot.subject);
      const anchorAt = shot.from + (shot.to - shot.from) * p.anchor;
      const hold = track?.segments.find((segment) => segment.type === "hold" && segment.t0 <= anchorAt && segment.t1 >= anchorAt);
      const spot = track && hold?.type === "hold" ? tripodFor(stage, shot, track, hold, p.distance) : null;
      if (!track || !spot) return { position: s.clone().addScaledVector(d, -8).addScaledVector(UP, 3), look: aim, fov: p.fov };
      // the aisle runs across the face the vehicle works at
      return { position: new THREE.Vector3(spot.x, spot.y, spot.z), look: forksAt(stage, track, t) ?? aim, fov: p.fov };
    }
    case "lead": {
      const track = stage.tracks.get(shot.subject);
      const ahead = track ? routeAhead(stage, track, t, p.distance) : null;
      const position = (ahead ?? s.clone().addScaledVector(d, p.distance)).setY(FLOOR + p.height);
      return { position, look: (track && forksAt(stage, track, t)) ?? aim, fov: p.fov };
    }
    case "fixed": {
      const [cx, ch, cy] = shot.camera ?? [s.x + stage.origin.x, 8, s.z + stage.origin.y + 10];
      const [tx, th, ty] = shot.target ?? [s.x + stage.origin.x, 0, s.z + stage.origin.y];
      const look = new THREE.Vector3(tx - stage.origin.x, FLOOR + th, ty - stage.origin.y);
      const start = new THREE.Vector3(cx - stage.origin.x, FLOOR + ch, cy - stage.origin.y);
      const drift = look.clone().sub(start).setY(0);
      if (drift.lengthSq() > 1e-6) start.addScaledVector(drift.normalize(), p.sweep * e);
      return { position: start, look, fov: p.fov };
    }
    case "lockOff": {
      // the tripod is set once, from the subject's pose at the anchor moment; then it only pans
      const set = subjectAt(stage, shot.subject, shot.from + (shot.to - shot.from) * p.anchor);
      const setSide = new THREE.Vector3(-set.dir.z, 0, set.dir.x).multiplyScalar(p.side);
      const position = set.pos.clone().addScaledVector(set.dir, p.forward).addScaledVector(setSide, p.across).setY(p.height + (stage.tracks.get(shot.subject)?.kind === "truck" ? 0 : FLOOR));
      return { position, look: aim.addScaledVector(d, p.lead), fov: p.fov };
    }
  }
}

/**
 * The camera averaged over ±0.3 s of the shot. Vehicles turn on the spot and
 * stop dead; averaging takes those steps out of the camera without lag at
 * cuts, and stays a pure function of time, so exports match playback.
 */
const SMOOTH_SECONDS = 0.3;
const SMOOTH_WEIGHTS = [1, 2, 3, 2, 1];
function smoothShot(stage: Stage, shot: Shot, u: number): CameraPose {
  if (shot.kind === "establish" || shot.kind === "fixed") return evaluateShot(stage, shot, u);
  const spread = SMOOTH_SECONDS / shot.seconds;
  const position = new THREE.Vector3();
  const look = new THREE.Vector3();
  let fov = 0;
  let total = 0;
  SMOOTH_WEIGHTS.forEach((weight, index) => {
    const k = clamp01(u + ((index - 2) / 2) * spread);
    const pose = evaluateShot(stage, shot, k);
    position.addScaledVector(pose.position, weight);
    look.addScaledVector(pose.look, weight);
    fov += pose.fov * weight;
    total += weight;
  });
  return { position: position.divideScalar(total), look: look.divideScalar(total), fov: fov / total };
}

/** Total length of a showcase in real seconds. */
export const showcaseSeconds = (shots: Shot[]) => shots.reduce((sum, shot) => sum + shot.seconds, 0);

/** Which shot is on screen after `elapsed` real seconds, and how far through it. */
export function shotAt(shots: Shot[], elapsed: number) {
  let start = 0;
  for (let index = 0; index < shots.length; index += 1) {
    const end = start + shots[index].seconds;
    if (elapsed < end) return { index, u: (elapsed - start) / shots[index].seconds, local: elapsed - start, start };
    start = end;
  }
  return null;
}

const BLEND_SECONDS = 1.2;
const DIP_SECONDS = 0.35;

/** The camera at `elapsed` seconds into the showcase, with blends between shots. */
export function directorPose(stage: Stage, shots: Shot[], elapsed: number) {
  const at = shotAt(shots, elapsed);
  if (!at) return null;
  const shot = shots[at.index];
  const pose = smoothShot(stage, shot, at.u);
  const previous = shots[at.index - 1];
  const blend = Math.min(BLEND_SECONDS, shot.seconds * 0.35);
  if (previous && !shot.cut && !shot.dip && at.local < blend) {
    const from = smoothShot(stage, previous, 1);
    const k = smoothstep(at.local / blend);
    pose.position.lerpVectors(from.position, pose.position, k);
    pose.look.lerpVectors(from.look, pose.look, k);
    pose.fov = THREE.MathUtils.lerp(from.fov, pose.fov, k);
  }
  return { ...at, shot, pose, time: shot.from + (shot.to - shot.from) * at.u };
}

/** Opacity of the black dip at `elapsed`: fades out of the shot before a dip and into the dipped shot. */
export function dipAt(shots: Shot[], elapsed: number) {
  const at = shotAt(shots, elapsed);
  if (!at) return 1;
  const shot = shots[at.index];
  const total = showcaseSeconds(shots);
  let alpha = 0;
  if (at.index === 0 || shot.dip) alpha = Math.max(alpha, 1 - at.local / DIP_SECONDS);
  const next = shots[at.index + 1];
  const left = shot.seconds - at.local;
  if (next?.dip) alpha = Math.max(alpha, 1 - left / DIP_SECONDS);
  if (total - elapsed < DIP_SECONDS * 1.5) alpha = Math.max(alpha, 1 - (total - elapsed) / (DIP_SECONDS * 1.5));
  return clamp01(alpha);
}

/** The lower third on screen at `elapsed`, and how long it has been up (for its fade-in). */
export function lowerThirdAt(shots: Shot[], elapsed: number) {
  const at = shotAt(shots, elapsed);
  if (!at) return null;
  let text = null as { title: string; fact?: string; since: number } | null;
  let start = 0;
  for (let index = 0; index <= at.index; index += 1) {
    const shot = shots[index];
    if (shot.title && shot.title !== text?.title) text = { title: shot.title, fact: shot.fact, since: start };
    start += shot.seconds;
  }
  return text ? { ...text, age: elapsed - text.since } : null;
}

// --- helpers for flows ---------------------------------------------------------

/** The first stretch of motion on a track at or after `after`, short pauses included, capped at `limit` minutes. */
export function motion(track: Track, after: number, limit = Infinity): [number, number] | null {
  const segments = track.segments;
  const first = segments.findIndex((segment) => segment.type === "move" && segment.t1 > after);
  if (first < 0) return null;
  const a = Math.max(after, segments[first].t0 - 0.05);
  let b = segments[first].t1;
  for (let i = first + 1; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment.type === "hold" && segment.t1 - segment.t0 > 0.5) break;
    b = segment.t1;
  }
  return [a, Math.min(b + 0.1, a + limit)];
}

/**
 * The next loaded drive at or after `after`: forward moves with a load on the
 * forks (reversing out of a lane or a trailer is left out), short pauses included.
 */
export function loadedRun(track: Track, after: number): [number, number] | null {
  const segments = track.segments;
  const first = segments.findIndex((segment) => segment.type === "move" && !segment.reverse && segment.carrying > 0 && segment.t1 > after);
  if (first < 0) return null;
  let end = segments[first].t1;
  for (let i = first + 1; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment.type === "move" && !segment.reverse) end = segment.t1;
    else if (segment.type === "hold" && segment.t1 - segment.t0 < 0.3 && !segment.op) continue;
    else break;
  }
  return [Math.max(after, segments[first].t0), end];
}

/** The stationary stretch that contains t (or the next one after it). */
export function stop(track: Track, t: number): [number, number] | null {
  const hold = track.segments.find((segment) => segment.type === "hold" && segment.t1 > t);
  return hold ? [Math.max(hold.t0, t), hold.t1] : null;
}

export const trackById = (model: SceneModel, id: string) => model.tracks.find((track) => track.id === id);
