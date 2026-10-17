// Showcase checks that run without a browser.
//
//   node tools/showcase/check.mjs shots   <config.json> <result.json> <docks> [hero]
//   node tools/showcase/check.mjs overlap <config.json> <result.json> <docks> [id-regex]
//   node tools/showcase/check.mjs heroes  <config.json> <result.json> <docks>
//
// `shots` prints the shot list the flow writes, with the subject and camera
// position at the start, middle and end of every shot: a camera far from its
// subject, or a subject that has left the scene ("GONE"), shows up here.
// `overlap` samples every vehicle through the day and lists pairs that stand
// closer than they physically can (3.2 m for trucks, 1.6 m for equipment).
// Get the JSON from a running backend: GET /api/config, GET /api/replay, or
// POST /api/simulate. Run through check.mjs, which bundles this file first.

import { readFileSync } from "fs";
import * as THREE from "three";

import { evaluateShot, subjectAt, type Stage } from "../../src/scene/director";
import { buildDispatchShowcase, dispatchHeroes } from "../../src/scene/flows/dispatch";
import { buildSceneModel, samplePose } from "../../src/scene/tracks";

const [command, configPath, resultPath, docksArg, extra] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath, "utf8"));
const result = JSON.parse(readFileSync(resultPath, "utf8"));
const model = buildSceneModel(config.layout, result.trace, config.resources.equipment, Number(docksArg ?? 6));
const fmt = (minute: number) => minute.toFixed(1);

if (command === "heroes") {
  dispatchHeroes(model, fmt).forEach((hero) => console.log(hero.label));
} else if (command === "shots") {
  const origin = { x: config.layout.plot.width_m / 2, y: config.layout.plot.height_m / 2 };
  const stage: Stage = { tracks: new Map(model.tracks.map((track) => [track.id, track])), locations: new Map(), origin, site: new THREE.Vector3(6, 0.5, 27) };
  config.layout.marshalling_lanes.forEach((lane: { lane_id: string; x: number; y: number; width: number; height: number }) => stage.locations.set(lane.lane_id, new THREE.Vector3(lane.x + lane.width / 2 - origin.x, 1.7, lane.y + lane.height / 2 - origin.y)));
  model.docks.forEach((dock) => stage.locations.set(dock.id, new THREE.Vector3(dock.cx - origin.x, 0.5, 70 - origin.y)));
  const showcase = buildDispatchShowcase(model, result.trace, fmt, extra);
  if (!showcase) throw new Error("no truck goes from gate to departure in this run");
  const v = (p: THREE.Vector3) => `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`;
  let at = 0;
  for (const shot of showcase.shots) {
    const track = stage.tracks.get(shot.subject);
    console.log(`@${at.toFixed(1)}s ${shot.kind} ${shot.subject} ${shot.from.toFixed(2)}–${shot.to.toFixed(2)} ${shot.seconds}s${shot.dip ? " dip" : shot.cut ? " cut" : ""} | ${shot.title ?? "·"} — ${shot.fact ?? ""}`);
    for (const u of [0, 0.5, 1]) {
      const t = shot.from + (shot.to - shot.from) * u;
      const pose = evaluateShot(stage, shot, u);
      const subject = subjectAt(stage, shot.subject, t).pos;
      const gone = track && !samplePose(track, t) ? " GONE" : "";
      console.log(`    u${u} subject ${v(subject)}${gone} camera ${v(pose.position)} distance ${pose.position.distanceTo(subject).toFixed(1)} m`);
    }
    at += shot.seconds;
  }
  console.log(`total ${at.toFixed(1)} s, ${showcase.shots.length} shots`);
} else if (command === "overlap") {
  const filter = extra ? new RegExp(extra) : null;
  const pairs = new Map<string, { samples: number; closest: number; where: string }>();
  for (let t = 0; t < model.horizon; t += 0.05) {
    const live = model.tracks.flatMap((track) => {
      const pose = samplePose(track, t);
      return pose ? [{ track, pose }] : [];
    });
    for (let i = 0; i < live.length; i += 1) {
      for (let j = i + 1; j < live.length; j += 1) {
        const a = live[i];
        const b = live[j];
        if ((a.track.kind === "truck") !== (b.track.kind === "truck")) continue;
        const gap = Math.hypot(a.pose.x - b.pose.x, a.pose.y - b.pose.y);
        if (gap >= (a.track.kind === "truck" ? 3.2 : 1.6)) continue;
        const key = `${a.track.id} ~ ${b.track.id}`;
        if (filter && !filter.test(key)) continue;
        const entry = pairs.get(key) ?? { samples: 0, closest: Infinity, where: "" };
        entry.samples += 1;
        if (gap < entry.closest) {
          entry.closest = gap;
          entry.where = `t=${t.toFixed(1)} at (${a.pose.x.toFixed(1)}, ${a.pose.y.toFixed(1)}) ${a.pose.activity} / ${b.pose.activity}`;
        }
        pairs.set(key, entry);
      }
    }
  }
  const rows = [...pairs.entries()].sort((a, b) => b[1].samples - a[1].samples);
  console.log(`${rows.length} pairs too close`);
  rows.slice(0, 30).forEach(([key, entry]) => console.log(`${key}: ${(entry.samples * 0.05).toFixed(1)} min, closest ${entry.closest.toFixed(2)} m, ${entry.where}`));
} else {
  console.log("usage: node tools/showcase/check.mjs shots|overlap|heroes <config.json> <result.json> <docks> [hero|id-regex]");
}
