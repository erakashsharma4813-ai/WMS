// The showcase story for the outbound dispatch twin: one shipment followed
// from gate to gate, in process order. Each beat is one place and one piece
// of work, with a headline and one fact taken from the run.
//
// To write a story for another simulation, copy this file's shape: list the
// things a viewer can choose to follow (`dispatchHeroes`), then turn the
// chosen one's events into shots with the helpers in ../director.

import type { TraceEvent } from "../../types";
import { loadedRun, motion, stop, trackById, type Shot, type Showcase } from "../director";
import { DOCK_FACE_Y, TRUCK_DIMS, WALL_Y, samplePose, type MoveSegment, type SceneModel, type Track } from "../tracks";

export type Hero = {
  id: string;
  label: string;
  shipment: string;
  pallets: number;
  reported: number;
  departed: number;
  dock: string | null;
  keys: Set<string>;
  track: Track;
};

const keyOf = (event: TraceEvent) => String(event.metadata?.shipment_id ?? event.case_id ?? "");

export const minutesText = (minutes: number) => {
  const m = Math.round(minutes);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`;
};

/** Every truck that goes all the way from the gate to departure in this run: the shipments a viewer can follow. */
export function dispatchHeroes(model: SceneModel, fmt: (minute: number) => string): Hero[] {
  return model.tracks
    .filter((track) => track.kind === "truck")
    .flatMap((track) => {
      const at = (state: string) => track.events.find((event) => event.state === state);
      const reported = at("reported");
      const docked = at("docked");
      const departed = at("departed");
      if (!reported || !docked || !departed) return [];
      const shipment = String(track.events.map((event) => event.metadata?.shipment_id).find(Boolean) ?? "");
      const pallets = track.pallets ?? 0;
      const variant = track.variant ? TRUCK_DIMS[track.variant].label : "truck";
      return [{
        id: track.id,
        label: `${track.id}${shipment && shipment !== track.id ? ` · order ${shipment}` : ""} · ${variant} · ${pallets} pallets · ${fmt(reported.time)}–${fmt(departed.time)} · ${docked.location_id ?? ""}`,
        shipment,
        pallets,
        reported: reported.time,
        departed: departed.time,
        dock: docked.location_id,
        keys: new Set([track.id, ...track.events.map(keyOf).filter(Boolean)]),
        track,
      }];
    })
    .sort((a, b) => a.reported - b.reported);
}

/** The default hero: the largest load in the middle of the day, since it gives the longest loading sequence. */
export function defaultHero(heroes: Hero[], horizon: number) {
  const middle = heroes.filter((hero) => hero.reported > horizon * 0.12 && hero.reported < horizon * 0.7);
  return [...(middle.length ? middle : heroes)].sort((a, b) => b.pallets - a.pallets || a.reported - b.reported)[0];
}

/** The vehicle that loads the hero: from the trace when it says so, otherwise the one seen in its trailer. */
function findLoader(model: SceneModel, trace: TraceEvent[], hero: Hero, window: [number, number]) {
  const load = trace.find((event) => event.entity_type === "forklift" && event.state === "loading_pallet" && hero.keys.has(keyOf(event)) && event.time >= window[0] - 0.5);
  if (load) return { id: load.entity_id, time: load.time };
  const dock = model.docks.find((item) => item.id === hero.dock);
  if (!dock) return null;
  for (let t = window[0]; t < window[1]; t += 0.4) {
    for (const track of model.tracks) {
      if (track.kind !== "forklift" && track.kind !== "pallet_truck") continue;
      const pose = samplePose(track, t);
      if (pose && Math.abs(pose.x - dock.cx) < 3 && pose.y > DOCK_FACE_Y - 4 && pose.y < DOCK_FACE_Y + 2) return { id: track.id, time: Math.max(window[0], t - 1.5) };
    }
  }
  return null;
}

/** One shipment, gate to gate. */
export function buildDispatchShowcase(model: SceneModel, trace: TraceEvent[], fmt: (minute: number) => string, heroId?: string | null): Showcase | null {
  const heroes = dispatchHeroes(model, fmt);
  const hero = heroes.find((item) => item.id === heroId) ?? defaultHero(heroes, model.horizon);
  if (!hero) return null;
  const truck = hero.track;
  const id = hero.id;
  const time = (state: string) => truck.events.find((event) => event.state === state)?.time;
  const variant = truck.variant ? TRUCK_DIMS[truck.variant].label : "truck";
  // Each beat is a group of shots anchored to its own events. Beats are then
  // played in the order they start, so work that overlaps (picking while the
  // truck docks) cuts back a minute or two, as an edit would ("meanwhile").
  const beats: Shot[][] = [];
  const beat = (...shots: Array<Shot | null | false | undefined | "" | 0>) => {
    const kept = shots.filter((shot): shot is Shot => Boolean(shot) && (shot as Shot).to > (shot as Shot).from);
    if (kept.length) beats.push(kept);
  };

  const call = time("called_to_dock") ?? (time("docked") ?? hero.reported) - 4;
  const docked = time("docked") ?? call + 5;
  const loaded = time("loaded") ?? hero.departed - 10;

  // arrival at the gate alongside the cab; the gate check from a tripod beyond
  // the barrier (cab, guard and barrier in one frame); then the wait for a dock
  const arrival = motion(truck, truck.start, 3);
  const gate = arrival ? stop(truck, arrival[1] - 0.01) : null;
  const yard = gate ? stop(truck, gate[1] + 0.05) : null;
  const waits = Boolean(yard && yard[1] - yard[0] > 2 && yard[1] <= docked + 0.01);
  beat(
    arrival && { kind: "track", subject: id, from: arrival[0], to: arrival[1], seconds: 3, dip: true, title: "Arrival", fact: `${fmt(hero.reported)} · ${id} pulls up at the gate`, params: { side: 1, height: 3.4, distance: 16 } },
    gate && { kind: "lockOff", subject: id, from: gate[0], to: gate[1] + 0.12, seconds: 4.5, cut: true, title: "Gate check", fact: `Documents and tare weight · ${minutesText(gate[1] - gate[0])} at the gate`, params: { forward: 12, across: 7, height: 1.7, aim: 0.4, fov: 38 } },
    waits && yard && { kind: "orbit", subject: id, from: yard[0], to: Math.min(yard[1] - 0.1, yard[0] + 30), seconds: 3.5, cut: true, title: "Waiting for a dock", fact: `${minutesText(yard[1] - yard[0])} until ${hero.dock ?? "a door"} is ready`, params: { distance: 26, height: 15, angle: 160, sweep: 30, aim: 0 } },
  );

  // picking: a tripod in the aisle at the pick face sees the reach truck come in forks-first, turn
  // and lift the pallet out of the rack side-on; then a camera ahead of it carries the load to the lane
  const picks = trace.filter((event) => event.entity_type === "reach_truck" && event.state === "picking" && hero.keys.has(keyOf(event)));
  const pick = picks[0];
  const picker = pick ? trackById(model, pick.entity_id) : undefined;
  const pickers = new Set(picks.map((event) => event.entity_id));
  const go = picker && pick ? motion(picker, pick.time, 4) : null;
  const lift = picker && go ? stop(picker, go[1] - 0.01) : null;
  const carry = picker && lift ? loadedRun(picker, lift[1] - 0.01) : null;
  if (picker && pick && go && lift) {
    const who = pickers.size > 1 ? `${pickers.size} reach trucks pick` : `${picker.id} picks`;
    const from = Math.max(go[0], go[1] - 0.3);
    const to = lift[1] + 0.02;
    beat(
      { kind: "workAt", subject: picker.id, from, to, seconds: 6, dip: true, params: { anchor: ((lift[0] + lift[1]) / 2 - from) / (to - from) }, title: "Picking", fact: `${who} the ${hero.pallets} pallets for ${id}${pick.location_id ? ` · first from ${pick.location_id}` : ""}` },
      carry && { kind: "lead", subject: picker.id, from: carry[0], to: carry[1], seconds: 3.5, cut: true, title: "To marshalling", fact: `Staged in lane ${pick.destination_id ?? ""} for loading`.trim() },
      // the lane fills while the truck waits: a time-lapse, when there is a wait to show
      pick.destination_id && carry && call > carry[1] + 1 && { kind: "orbit", subject: pick.destination_id, from: carry[1], to: call - 0.3, seconds: 3, title: "Staging", fact: `Pallets ready in ${pick.destination_id} by ${fmt(call)}`, params: { distance: 15, height: 8, angle: 200, sweep: 25, aim: 0 } },
    );
  }

  // called to dock: the drive round, then a tripod beside the door as the trailer backs in
  const reverse = truck.segments.find((segment): segment is MoveSegment => segment.type === "move" && segment.reverse && segment.t1 <= docked + 0.05 && segment.t1 >= docked - 4);
  const dockSite = model.docks.find((item) => item.id === hero.dock);
  if (reverse) {
    const approach = Math.sign(reverse.path.points[0].x - (dockSite?.cx ?? reverse.path.points[0].x)) || 1;
    beat(
      { kind: "chase", subject: id, from: Math.max(call, reverse.t0 - 0.4), to: reverse.t0, seconds: 2.5, dip: true, title: "Called to dock", fact: `${fmt(call)} · ${hero.dock ?? "a door"} is free and the pallets are staged`, params: { distance: 16, height: 6 } },
      dockSite
        ? { kind: "fixed", subject: id, from: reverse.t0, to: reverse.t1 + 0.3, seconds: 3.5, cut: true, title: "Docking", fact: `Reversing onto ${hero.dock}`, camera: [dockSite.cx - approach * 4, 2.3, DOCK_FACE_Y + 21], target: [dockSite.cx, -0.2, DOCK_FACE_Y + 5], params: { sweep: 0, fov: 44 } }
        : { kind: "lockOff", subject: id, from: reverse.t0, to: reverse.t1 + 0.3, seconds: 3.5, cut: true, title: "Docking", fact: `Reversing onto ${hero.dock}`, params: { anchor: 1, forward: 10, across: 9, height: 3.2, aim: 0, lead: -9, fov: 42 } },
    );
  }

  // loading: one forklift trip into the trailer, then the trailer filling, from inside the hall
  const loader = findLoader(model, trace, hero, [docked, loaded]);
  const loaderTrack = loader ? trackById(model, loader.id) : undefined;
  const trip = loaderTrack && loader ? motion(loaderTrack, Math.max(loader.time, docked) - 0.01, 2.5) : null;
  const loaders = new Set(trace.filter((event) => event.entity_type === "forklift" && event.state === "loading_pallet" && hero.keys.has(keyOf(event))).map((event) => event.entity_id));
  const loadFact = `${hero.pallets} pallets onto ${id}${loaders.size ? ` · ${loaders.size} forklift${loaders.size === 1 ? "" : "s"}` : ""}`;
  // one pallet, followed all the way: a camera ahead of the forklift on the loaded lane looks
  // back at the pallet on its forks; at the door, a cut on the action to a low tripod in the hall
  // beside the door, behind the truck, looking into the trailer as the pallet goes in and down
  const firstLoad = trace.find((event) => event.entity_type === "forklift" && event.state === "loading_pallet" && hero.keys.has(keyOf(event)));
  const laneId = firstLoad?.location_id?.startsWith("ML-") ? firstLoad.location_id : pick?.destination_id;
  const lane = model.lanes.find((item) => item.id === laneId);
  const dock = model.docks.find((item) => item.id === hero.dock);
  const loadingFrom = Math.max(docked, time("loading") ?? docked, firstLoad?.time ?? docked);
  const run = loaderTrack ? loadedRun(loaderTrack, loadingFrom) : null;
  const drop = loaderTrack && run ? stop(loaderTrack, run[1] - 0.001) : null;
  if (loaderTrack && run && dock) {
    // the door tripod stands straight behind the truck, in line with the trailer, a little to the far side from the lane
    const side = Math.sign(dock.cx - (lane?.cx ?? dock.cx)) || 1;
    // hand over while the forklift is still ~9 m from the door, before the camera ahead of it reaches the door frame
    let handover = run[0] + (run[1] - run[0]) * 0.5;
    for (let t = run[0]; t < run[1]; t += 0.005) {
      const pose = samplePose(loaderTrack, t);
      if (pose && Math.hypot(pose.x - dock.cx, pose.y - WALL_Y) < 9) {
        handover = Math.max(run[0] + 0.02, t);
        break;
      }
    }
    beat(
      { kind: "lead", subject: loaderTrack.id, from: run[0], to: handover, seconds: 3.5, dip: true, title: "Loading", fact: loadFact, params: { distance: 6, height: 2.2 } },
      { kind: "fixed", subject: loaderTrack.id, from: handover, to: Math.max(handover + 0.5, (drop?.[1] ?? run[1] + 1) + 0.15), seconds: 4.5, cut: true, fact: `${minutesText(loaded - docked)} at the door, first pallet to last`, camera: [dock.cx + side * 0.8, 3.8, WALL_Y - 7.5], target: [dock.cx, 0.6, DOCK_FACE_Y + 6], params: { sweep: 0.8, fov: 44 } },
    );
  } else if (loaderTrack && trip) {
    beat({ kind: "follow", subject: loaderTrack.id, from: trip[0], to: trip[1], seconds: 3.5, dip: true, title: "Loading", fact: loadFact, params: { distance: 5, height: 0.9, aim: 0.2, lead: 2 } });
  }

  // paperwork and away: the drive from the door, then a low tripod by the road as it passes
  const exit = motion(truck, loaded, 3);
  const paper = exit ? stop(truck, exit[1] - 0.01) : null;
  const out = paper ? motion(truck, paper[1] - 0.01, 3) : null;
  beat(
    exit && { kind: "chase", subject: id, from: exit[0], to: exit[1], seconds: 2.5, dip: true, title: "Paperwork and exit", fact: paper ? `Documents at the gate · ${minutesText(paper[1] - paper[0])}` : `Released at ${fmt(exit[0])}`, params: { distance: 16, height: 6 } },
    out && { kind: "lockOff", subject: id, from: out[0], to: out[0] + (out[1] - out[0]) * 0.55, seconds: 3.5, cut: true, title: "Departed", fact: `${fmt(hero.departed)} · ${minutesText(hero.departed - hero.reported)} gate to gate`, params: { anchor: 0.3, forward: 12, across: 9, height: 1.3, aim: 0.6, fov: 34 } },
  );

  beats.sort((a, b) => a[0].from - b[0].from);
  const shots: Shot[] = [
    // title card over the site
    { kind: "establish", subject: "SITE", from: Math.max(0, hero.reported - 8), to: Math.max(0.5, hero.reported - 1), seconds: 3.5, title: `Following ${id}`, fact: `${hero.shipment && hero.shipment !== id ? `Order ${hero.shipment} · ` : ""}${variant} · ${hero.pallets} pallets · reports at ${fmt(hero.reported)}` },
    ...beats.flat(),
  ];
  // end card: pull back to the whole site
  const lastTime = Math.max(...shots.map((shot) => shot.to));
  const crew = (ids: string[], one: string, many: string) => (ids.length === 1 ? `${one} ${ids[0]}` : ids.length ? `${ids.length} ${many}` : "");
  const credits = [crew([...pickers], "picked by", "reach trucks"), crew(loaders.size ? [...loaders] : loaderTrack ? [loaderTrack.id] : [], "loaded by", "forklifts"), hero.dock ? `door ${hero.dock}` : ""];
  shots.push({ kind: "establish", subject: "SITE", from: lastTime, to: Math.min(model.horizon, lastTime + 10), seconds: 4, dip: true, title: `${id} · ${minutesText(hero.departed - hero.reported)} gate to gate`, fact: credits.filter(Boolean).join(" · "), params: { distance: 110, height: 78, angle: 50, sweep: -16 } });

  return { hero: id, label: hero.label, shots: shots.filter((shot) => shot.to > shot.from) };
}
