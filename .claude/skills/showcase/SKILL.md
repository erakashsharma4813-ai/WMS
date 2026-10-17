---
name: showcase
description: Make or improve a showcase film of a simulation run, a directed camera that follows one order, truck or piece of equipment through the process, with headlines and numbers on screen, played live or exported as an MP4 for a post or a demo. Use when someone asks for a showcase, demo video, cinematic view, LinkedIn video, camera angles, "follow this truck/order", or says a shot looks wrong (seen from above, blocked, overlapping vehicles, people wandering around). Also use to build the same thing for a new simulation.
---

# Showcase skill

A showcase is a short film of one thing moving through the process: one shipment from gate to gate in the dispatch twin. The camera follows the work, not the map. Each beat is one place, one piece of work, one headline and one number from the run. The style comes from a reference video the team liked: process order, about 3 to 4 seconds per shot, eye-level and equipment-level angles, black bars, dips to black between acts, no interface in the picture.

## First, ask

Before building or changing a film, ask the user (one question, with choices):

1. **What to follow.** List the candidates from the run: `node tools/showcase/check.mjs heroes …` prints every truck that goes from gate to departure, with its order number, size, pallets, times and door. Offer the default (the largest load in the middle of the day) plus 2 or 3 others that make a point: the longest wait, the one hit by a disruption.
2. **Live or MP4, and the shape.** 16:9 (1920×1080) for a deck or YouTube; 4:5 (1080×1350) for a feed post (turn on the 4:5 recording frame first).
3. **Which run.** The recorded day, or a What-if run (run it first; the film follows that run's events).

In the app, the same choice is the 🎬 button: a card lists the shipments, with Play and Export MP4. While it plays, the transport in the bottom bar (and Space, ←, →, Esc) pauses, steps between beats and stops; it is never drawn into an export.

## Where things live

```
frontend/src/scene/director.ts        generic: shot types, camera maths, blends, dips, lower thirds, timing helpers
frontend/src/scene/flows/dispatch.ts  the dispatch story: heroes list + beats for one shipment
frontend/src/scene/recorder.ts        MP4 export (WebCodecs H.264 + mp4-muxer), draws bars/lower third/dips into frames
frontend/src/WarehouseScene.tsx       CinemaRig (owns clock + camera while playing), RecorderRig, the live frame overlay
frontend/src/scene/tracks.ts          where vehicles are at any time; FloorPlan (no two vehicles on one spot); yard/lay-by parking
frontend/tools/showcase/check.mjs     shots | overlap | heroes, without a browser
frontend/tools/showcase/capture.cjs   plays the film headless and saves frames, one per 0.7 s
```

## Story grammar

- **Process order.** Title card → arrival → gate check → wait → picking → to marshalling → staging → called to dock → docking → loading → paperwork and exit → end card. Skip a beat when the run has nothing to show for it; never invent one.
- **Anchor every beat to its own events**, then order beats by when they start. Work that overlaps (picking while the truck docks) cuts back a minute: that is a "meanwhile", not an error. Never chain a beat to the end of the previous shot: in a busy run it grabs the wrong movement.
- **One beat = one headline + one fact.** The fact is a number from the run (minutes at the gate, pallets, forklifts, gate-to-gate time). No adjectives, no claims the data does not support.
- **Time is the edit.** A shot's sim-minutes ÷ its seconds sets the speed: near real time for actions (0.3 to 1 min in 3 s), time-lapse for waits (30 min in 3.5 s). Waits are where the story is, so show them, briefly.
- **Rhythm.** 2.5 to 4.5 s per shot, 45 to 55 s in all. `dip: true` at act changes (arrival, picking, docking, loading, exit); `cut: true` inside a beat; otherwise blend.

## Camera grammar

| Shot | Use it for | Rule |
|---|---|---|
| `workAt` | equipment handling a load: reach truck at the pick face | a tripod in the aisle at the handling spot, on the side the vehicle drives towards, aimed at the forks: it sees the approach forks-first, then the lift side-on. It tries spots along the aisle and keeps the one no other vehicle blocks; in a busy aisle it rises above the vehicles (7 m), never into a rack |
| `lead` | equipment carrying a load: reach truck to the lane, forklift along the loaded lane | the camera travels ahead on the vehicle's own route, looking back at the forks and the pallet. Hand over to the next shot before the camera reaches a door frame (about 9 m out) |
| `fixed` | a place where the work arrives: behind the truck at the door, docking | a tripod set by the flow. Loading: straight behind the truck in line with the trailer, inside the hall, above the lane-end pallets (3.8 m), so the forklift crosses the frame, turns in and sets the pallet down. Docking: on the apron between two doors, on the side away from the reversing path, far enough back for the whole rig |
| `follow` | equipment driving where the load is not the point | trails along the route just driven. Not for loaded reach trucks or forklifts: the mast hides the load |
| `lockOff` | a check or a passing truck: gate check, departure | a tripod set from the subject's pose at `anchor`, offset `forward`/`across`, low (1.3 to 3 m); it only pans |
| `track` / `chase` | trucks on open ground | alongside or behind at 3 to 7 m; trucks are framed on the middle of the whole rig, not the cab |
| `orbit` / `pushIn` | time-lapses: yard wait, lane filling | keep the camera on the open side; a dock door or rack between camera and subject is a failed shot |
| `establish` | title and end card | high, slow |

- Show the work, not the roof. If a shot is from above, it must be a deliberate establishing shot.
- Nothing in the picture that is not on site: in a showcase, labels, status lamps and rings, alert pop-ups and stress pins are hidden (`plain` mode in `Agents`).
- The scene must be clean before the camera is: no people at all, no vehicles inside each other, equipment on the marked travel lanes.
- **Focus on the material.** Equipment shots aim at the forks and the pallet (`forksAt`), not the vehicle body. Show where a pallet comes from and where it goes: equipment must never appear from nowhere, so frame its approach.
- **Smooth.** Every shot is averaged over ±0.3 s (`smoothShot`); never point a camera at a vehicle while it reverses out of a lane or a trailer. Use `loadedRun` (forward, loaded drives only) rather than `motion` for equipment.

## Steps

1. **Ask** (above). Get the run's JSON if you need to inspect it: `GET /api/config`, `GET /api/replay` or `POST /api/simulate`.
2. **Check the scene**: `node tools/showcase/check.mjs overlap config.json result.json <docks>`. Equipment pairs standing on one spot for minutes, or trucks inside each other, must be fixed in `tracks.ts` (FloorPlan claims, parking geometry) before filming. Brief passes (0.1 min) are fine.
3. **Write or adjust the beats** in the flow. Print them: `node tools/showcase/check.mjs shots config.json result.json <docks> <hero>`. Look for a camera more than ~30 m from a working subject, a `GONE` subject, a shot with `to <= from`, and titles in the wrong order.
4. **Look at it**: `node tools/showcase/capture.cjs frames replay <hero>` (and `sim`). Open a frame from every beat. Fix what you see, then capture again. Do both the recorded day and a What-if run: they differ (pick at gate, six docks, engine forklifts).
5. **Export** from the app (🎬 → Export MP4) and check the file plays, has the right size and length, and has the titles burned in.

## A story for another simulation

Keep `director.ts` as it is. Write `src/scene/flows/<simulation>.ts` with:

- `heroes(model, fmt)`: the things a viewer can follow (an order, a batch, a unit), each with a one-line label and the trace keys that link its events (case id, order id).
- `build(model, trace, fmt, heroId)`: the beats. Find each beat's events in the trace, turn them into time windows with `motion(track, after, limit)` (next stretch of movement) and `stop(track, t)` (the stationary stretch), pick a shot type from the grammar above, write the headline and fact.

Then point the 🎬 card at the new flow. The vehicles must already be tracks in the scene model; places must be in the `locations` map.

## Equipment must move like it does on site

- **Travel lanes.** The dock apron has two one-way lanes marked on the floor: loaded forklifts on the lane nearest the doors (`LOADED_Y`), empty ones back on the lane nearest the marshalling lanes (`RETURN_Y`); `apronRoute` routes them. Picks happen at the lane ends, just off the travel lanes. Reach trucks use the marked aisles and the cross-aisle.
- **Give way.** Equipment is planned one vehicle at a time; before each drive a vehicle checks those planned before it (`Builder.drive`) and waits a few seconds if they would meet. Stops are booked (`FloorPlan`) with a margin for that wait, so the next vehicle stops beside, not inside.
- Run `check.mjs overlap` after any change to routes or layout, on the recorded day and on a What-if run with and without `loaders-per-door`.

## Pitfalls seen so far

- Six forklifts loading one truck at the same moment: the engine allows it unless the `loaders-per-door` rule is on (model card; off by default because it moves the design-document numbers). Film What-if runs with it on. Behaviour belongs in a model rule (see the `sim-rule` skill), never in a camera fix.
- A tractor-trailer cannot straighten into a 45° yard bay in a 10 m yard; it waits in the lay-by beyond the outbound lane instead.
- Rack blocks are 8.5 m tall and the hall's far walls are solid: indoor cameras either follow at aisle level or sit inside the hall on the yard side.
- Headless Chrome renders slowly: live capture timing is approximate; exports are exact (frame n is always time n/60).
- The backend reads the layout file once at start: restart it after changing `02_warehouse_layout.json`, or the app keeps the old geometry.

## Feedback log

Every piece of direction given on the film, newest last. Each line is already applied; keep applying it.

- 2026-10-11 · Camera must go with the flow, from several angles, like the reference video (process order, short shots, headline plus one fact, black bars, dips).
- 2026-10-11 · Gate check at eye level, not from above. Follow equipment to the racks instead of filming from above. No vehicles overlapping (forklifts at lanes, trucks in the yard and at docks). No people walking around.
- 2026-10-11 · Ask which truck or order to follow. Make the film pausable (Space, ← →, Esc).
- 2026-10-11 · Remove all people. Picking: the camera was behind the reach truck or on the far side of the rack and lost the goods; film the pick from the aisle, aimed at the forks, and carry the pallet with a camera ahead of it.
- 2026-10-11 · When the truck moves, show the truck. When loading, put the camera behind the truck so the forklift's movement into the trailer is seen; equipment must not appear from thin air. Smooth out glitches. Focus on the material, the equipment and the path. When equipment moves, the camera follows its path. Equipment must run on marked travel lanes, not along the edge by the docks.
