# Dispatch Twin frontend

React, TypeScript and three.js interface for the Dispatch Twin. It reads only the event log and statistics the backend returns; it never computes results itself.

## Run locally

```powershell
npm install
npm run dev
```

The application expects the API at `http://127.0.0.1:8000` (Vite proxies `/api`). Override it with `VITE_API_BASE` when required.

## Build

```powershell
npm run build
```

## Screens

| Tab | What the user does |
|---|---|
| Recorded | Replays the recorded day (read-only evidence) |
| What-if | Picks a past day, changes fill, policy, resources and demand, runs 1, 10 or 30 simulated days |
| Live replan | Freezes the day at a time and moves future truck bookings only |
| Compare | Baseline against the scenario with paired seeds: 95% ranges, verdict, cost, the fill knee, three fill levels, levers, share brief |
| Model card | Every number with kind, source and status; edit values; switch rules off |
| Analyze | Report up to the current time: statistics, stress heatmap (click to replay an hour), bottleneck evidence |

In the 3D view: numbered stress points turn amber and red from the engine's meters; delay alerts pop up over the vehicle or area and list in a feed; the event log panel shows recent events with their reasons; "Play the story of this day" flies the camera through the cascade; `H` toggles clean mode for recording, and the frame button shows a 16:9 or 4:5 recording frame. Every panel collapses.

## 3D scene architecture

```text
trace (API) ──► scene/tracks.ts ──► per-vehicle timeline ──► scene/Agents.tsx  (animated GLB rigs)
layout (API) ─┘   motion model        (move / hold segments)   scene/Facility.tsx (site, stock, docks, gate)
                                                                     ▲
tools/blender/build_equipment.py ──► out/*.glb ──► check ──► optimise ──► public/models/*.glb ──► scene/models.tsx
```

- **Motion model (`src/scene/tracks.ts`).** Built once per result. Each vehicle gets a timeline of move and hold segments: moves follow the aisle graph or the yard road network with filleted corners and a trapezoidal speed profile; holds carry the handling (mast lift, reach, fork insertion). Sampling depends only on time, so playback, scrubbing and seeking stay consistent.
- **Engine identities.** Reach trucks and forklifts come from the engine's event log with their own ids; each pallet a forklift drops lands in the next cargo slot of its truck. For older traces without forklift events, loader motion is derived from loading windows and labelled as derived.
- **Equipment numbers** come from `04_resource_catalog.json` and the item contracts. When a recorded window is shorter than physics allows, motion is time-compressed; when longer, the vehicle dwells; it always reaches each recorded state at the recorded time.
- **Playback clock.** `App.tsx` advances a ref every frame; the scene reads it at display rate while the panels refresh about ten times a second.
- **Showcase (`src/scene/director.ts`, `src/scene/flows/dispatch.ts`).** The 🎬 button opens a card that lists every shipment that goes from gate to departure in the run; pick one, then Play or Export MP4. While it plays, Space pauses, ← and → jump between steps, Esc stops (also as buttons in the bottom bar). The film follows it in process order (arrival, gate check, wait, picking, staging, docking, loading, exit), one headline and one number from the run per beat, framed with black bars and dips to black. `director.ts` is generic (shot types, camera maths, timing); the flow file holds the story for this simulation. While a showcase plays, `CinemaRig` in `WarehouseScene.tsx` owns both the clock and the camera and runs before the vehicles each frame. How to direct, check and extend it: `.claude/skills/showcase/SKILL.md`; checks without a browser: `node tools/showcase/check.mjs`.
- **Video export (`src/scene/recorder.ts`).** Renders the showcase to an MP4 in the browser: 1920×1080, or 1080×1350 when the 4:5 recording frame is on, at 60 fps with the bars and titles drawn in. Frame *n* always shows time *n*/60 s, however slowly the machine renders. Encoded to H.264 with WebCodecs and muxed with `mp4-muxer`; needs Chrome or Edge, with the tab in front.

## Equipment library (Blender)

```powershell
npm run models          # build in Blender, check against item contracts, optimise into public/models
npm run models:build    # tools/blender/out/*.glb (raw, git-ignored)
npm run models:check    # budgets, parts, sockets, materials; writes tools/blender/reports and reviews
npm run models:optimize # glTF-Transform meshopt, keeping parts and sockets
```

Blender is found from `$BLENDER`, then the default Windows install, then `PATH`. Each item has a contract in `tools/blender/items/<id>.json`; the method and lessons are in `.claude/skills/3d-item/SKILL.md`. `tools/blender/worlds/plant_campus_blockout.py` is the seed of the production-plant world template.

| Asset | Animated nodes |
|---|---|
| `truck_20` (also the 17 ft LCV at 86%), `truck_32`, `tractor` + `trailer_40` | `wheel_*`, `door_l`, `door_r`, ghostable `shell` material, `livery` material |
| `reach_truck` | `reach` (pantograph), `mast_outer`, `mast_inner`, `carriage`, `load_socket`, `beacon` |
| `forklift` (counterbalance) | `tilt`, `mast_inner`, `carriage`, `load_socket`, `beacon` |
| `pallet_truck` | `forks`, `load_socket`, `beacon` |
| `pallet_full`, `pallet_mixed` | instanced batches; `tint` carries the shipment colour |
| `dock_station`, `barrier`, `gatehouse` | `door`, `signal_red`/`signal_green`; `arm` |

Conventions: metres; forward is +X (Blender +X, three.js +X after the Y-up conversion); origins sit on the ground at the animated reference point.
