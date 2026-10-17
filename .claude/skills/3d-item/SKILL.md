---
name: 3d-item
description: Build or improve one 3D item (truck, trailer, reach truck, forklift, pallet truck, pallet, dock, barrier, gatehouse, rack piece) for the Dispatch Twin 3D view. Use when a developer asks to add an item, fix how an item looks, make equipment look more realistic or less alike, change its size, add optional kit or variants, or add a state or motion that the runtime drives.
---

# 3D item skill

One item = one builder function in Blender + one contract file + one check + one review.
The contract is shared by the engine (numbers) and the viewer (named parts it moves).
After every review, add what you learned to "Lessons". That is how this skill improves.

## Where things live

```
frontend/
  tools/blender/build_equipment.py   one function per item; builds and exports every GLB
  tools/blender/items/<id>.json      item contract: budget, parts, sockets, options, per-instance materials, states, engine numbers, reference
  tools/blender/check_items.py       imports each raw GLB and checks it against its contract (budget, nodes, materials)
  tools/blender/optimize.mjs         optimises into public/models, then checks the optimised JSON against the contract again
  tools/blender/reports/<id>.report.json   triangles, materials, nodes, size, pass/fail
  tools/blender/reviews/<id>.png     review render (and <id>-v<n>.md review notes)
  tools/blender/out/                 raw builds (git-ignored)
  public/models/<id>.glb             optimised copy the browser loads (dist/models is a copy made by npm run build)
  src/scene/models.tsx               loads GLBs, clones rigs, pickOptions, instanced pallets (PalletBatch)
  src/scene/Agents.tsx               drives the named parts of vehicles; sets livery, shell colour and options per unit
  src/scene/tracks.ts                per-unit colours: LIVERIES (trucks), MHE_LIVERIES (shade families per kind)
  src/scene/Facility.tsx             docks, gate, racks, stock
```

## Steps

1. **Start from the closest item.** Copy its builder function in `build_equipment.py` and its contract in `items/`. Change `id`, `family`, `notes`, `reference`.
2. **Measure the real thing.** Real sizes in metres from a datasheet or a photo with a known scale; write the source in the contract's `reference`. Never guess a vehicle size; scale errors break the whole scene (trucks reverse onto docks, forklifts drive into trailers). Free CC0 models are rare, stylised and lack the named rig, so build procedurally and use photos and datasheets for proportions and detail.
3. **Block out the silhouette first, then detail.** Get the side profile right with `m.prism` (cab, hood, counterweight, deflector, fork); plan shapes with `axis="Z"` (rounded chassis). Then add the details in the realism checklist below.
4. **Model with the helpers.**
   - `m.box(node, mat, size, centre, bevel, rotation, segs)`, `m.cylinder(node, mat, r, depth, centre, axis, segments, radius2)`
   - `m.prism(node, mat, profile, depth, at, axis)`: extrude a 2D outline (`axis="Y"`: (x, z) side profile; `"Z"`: (x, y) plan; `"X"`: (y, z)). `arc(...)` and `rounded_rect(...)` make outlines.
   - `m.rod(node, mat, p0, p1, r, radius2=)`: cylinder or cone between two points (columns, hoses, rails, levers, hubs). `m.beam(node, mat, p0, p1, thick)`: square bar between points (raked guard posts, braces).
   - `m.wheel(name, parent, centre, r, width, rim, dual=, tread_bevel=)`: tyre, rim, hub and five hand holes; `dual=True` draws twin tyres.
   - `m.node(name, parent, pivot)`. Geometry is bucketed per (node, material, bevel, segments) and merged, so static detail costs triangles but no draw calls.
   - Edges sharper than 38 degrees are marked sharp, so boxes shade flat and cylinders shade smooth. Bevel only big, visible pieces; small parts take `bevel=0.0` or `segs=1`.
5. **Every moving part is a node with a pivot.** Use exact names; the runtime finds parts by name: `wheel_*`, `reach`, `mast_outer`, `mast_inner`, `carriage`, `forks`, `tilt`, `tiller`, `door_l`, `door_r`, `shell_node`, `door`, `leveller`, `arm`, `signal_red`, `signal_green`, `beacon`.
6. **Optional kit goes under `opt_*` nodes** (roof deflector, sun visor, roof lamps, air horns, LPG bottle, rain roof, cold-store cabin, fork camera). `pickOptions(rig, track.id)` shows or hides each from a stable per-unit hash, so a fleet of one model is not a row of clones. List them in the contract's `options`. Fixtures (docks, gate) do not call `pickOptions`, so do not put `opt_*` on them.
7. **Add sockets as empty nodes:** `load_socket` (cargo attaches), more when needed. List them in the contract.
8. **Use the shared material names.** Materials whose name starts with `livery`, `shell`, `tint`, `wrap`, `glass`, `beacon` or `signal_` are restyled per instance at runtime; never alias them away. Vehicle bodies (cabs and MHE bodies) are `livery`; box bodies are `shell`. Merge everything else through the model's alias table (`MHE_ALIASES`, `TRUCK_ALIASES`, `DOCK_ALIASES`) to stay in the material budget.
9. **Write the contract** (`items/<id>.json`): `budget`, `parts`, `sockets`, `options`, `perInstanceMaterials`, `states` (what the runtime does in each state), `engine` (speeds and handling times; placeholders until calibration, and they must match `04_resource_catalog.json`), `reference`.
10. **Build, check and optimise:** `npm run models` (from `frontend/`). It stops when an item breaks its contract, before or after optimisation. While iterating on one item: `npm run models:build -- "" <id>` then `npm run models:check -- <id>`. Run `npm run build` to refresh `dist/`.
11. **Drive it.** Add or extend the agent in `src/scene/Agents.tsx`: read nodes with `rig.node(name)`, keep their base position with `rig.base(name)`, and move them from the pose (`pose.lift`, `pose.reach`, `pose.carrying`, `pose.odo`, `pose.moving`). Wheels spin by `-odo / radius` around local Z.
12. **Review.** Look at the render in `reviews/`, then the item in the running app at the wide demo camera and up close (the showcase capture in `tools/showcase/capture.cjs` gives close-ups). Write `reviews/<id>-v<n>.md` with the checklist below.
13. **Update this skill.** Add each lesson to "Lessons", one line each.

## Realism checklist (what makes an item read as the real thing)

- **Silhouette:** raked windscreen and rounded roof edge on cabs; counterweight curve and hood over the wheels on forklifts; rounded chassis and straddle legs on reach trucks; rounded drive unit on pallet trucks.
- **Wheels:** tyre, rim, hub, hand holes; twin tyres on truck drive and trailer axles; wheel-arch liners or fenders; mud flaps.
- **Lights:** headlamps, indicators, fog lamps, tail and reverse lamps, side markers, roof marker lamps, work lamps, beacon. These are small emissive boxes and cost almost nothing.
- **Glass framed by dark gaskets**, door seams, handles, grab rails, mirrors on arms, steps, wipers.
- **Underside clutter:** chassis rails, cross members, tanks with straps, battery box, air tanks, side guards, underrun bar with stripes, landing gear.
- **Bodies:** ribs or panel seams, aluminium rails and corner posts, livery band, conspicuity tape, lock rods, cam keepers, hinges.
- **Site kit:** panel seams, bumpers with face plates, guide stripes, wheel guides, bollards, chocks, visors on signals.
- **Variety:** per-unit livery, shell colour and `opt_*` kit, so no two units on screen look identical.
- **Check for collisions** between parts after resizing (mast and drive wheels, landing gear and tractor, tyre spacing on multi-axle groups).

## Conventions (different from the starter kit)

- Units are metres. **Forward is +X**, up is +Y in three.js (Blender: +X forward, +Z up; the glTF exporter converts). The starter kit used front = +Z; this repo uses +X because the motion model's heading is a math angle from east.
- Origin: on the ground under the point the runtime animates: vehicle centre, trailer kingpin, dock door centre on the outside wall face, barrier post.
- Lateral is three.js Z. A wheel's spin axis is local Z.
- The indoor floor is a dock-height slab at 1.2 m; indoor vehicles are placed at `FLOOR`, trucks at yard level, so a truck deck lines up with the dock.
- Per-unit colour stays inside the kind's legend colour (the equipment chips in `styles.css`): forklifts are blues, reach trucks ambers, pallet trucks teals. Trucks use the full `LIVERIES` set; box bodies pick from `BODY_SHELLS`.

## Budgets

| Class | Max triangles | Max materials | Notes |
|---|---|---|---|
| Small prop (pallet, tote, cone) | 500 | 4 | Instanced by the hundred: no bevels. Tint and translucent wrap need their own materials. |
| Vehicle (reach truck, forklift, pallet truck) | 5,000 | 8 | |
| Large vehicle (truck, tractor, trailer) | 8,000 | 10 | |
| Fixture (dock station, barrier, gatehouse) | 3,000 | 10 | |

Whole first scene: under about 10 MB of GLB (v2 library: 0.61 MB), draw calls in the low hundreds.
Anything that appears more than about 20 times is drawn with `InstancedMesh` (`PalletBatch`, rack uprights and beams).

## Motion rules

- Timing comes from the engine's event log. The viewer only draws the path between two events; it never changes timing.
- Vehicles follow aisle or road paths with filleted corners and face along the tangent; reversing flips the heading.
- Speed eases in and out (trapezoidal profile). Handling (lift, reach, insert forks) happens inside hold segments.
- A blocked or late entity shows a red status ring and its reason in the label; red is used only for stress.

## Review checklist

1. `reports/<id>.report.json` shows `budgetPass: true`, and `npm run models:optimize` prints no FAIL.
2. Every part, socket and option in the contract exists in the GLB (both checks fail otherwise).
3. The item reads clearly from the wide demo camera (about 100 m away) and up close.
4. Size looks right next to a 1.2 m pallet, a truck and a dock door; no parts pass through each other.
5. Every state in the contract shows: moving, lifting or reaching, loaded, docked (shell ghosts, doors open), blocked.
6. Colours match the scene palette; red only for stress. Two units of the same model look different (paint, shell, options).
7. The realism checklist above is covered for the item's family.

## Lessons

- v1 reach truck (starter kit, 1,240 triangles): reads as a reach truck from a 3/4 view; flat colours with small bevels (0.01 to 0.04 m) look better at the wide camera than textures.
- Default `gltf-transform optimize` flattens items and drops socket nodes. Always pass `--flatten false --join false --simplify false --prune false --instance false --palette false` (done by `tools/blender/optimize.mjs`).
- gltf-transform v4's default palette step baked every flat colour into "PaletteMaterial" textures. That silently killed every per-instance material (all trucks the same colour, shells never ghosted, beacons and dock signals dead) while the raw-build check still passed. optimize.mjs now re-checks the optimised JSON against the contract.
- Bevels with two segments on pallets cost 1,700+ triangles per pallet; flat boards bring it to about 250 with no visible loss at scene distance.
- Material budgets are met by aliasing near-identical materials per model (rim to steel, fork and mast to graphite, seat to graphite) rather than by recolouring.
- Blender's glTF importer cannot read meshopt-compressed files, so check_items.py runs on the raw build in `tools/blender/out`; optimize.mjs checks the optimised copy by reading its JSON chunk.
- A 17 ft LCV reuses the 20 ft model at 86% scale; cargo slots are computed in the unscaled local frame.
- v2 (2026-10-11): marking edges over 38 degrees sharp fixed the "blobby box" look of smooth-shaded unbevelled cubes; it is free.
- v2: twin tyres, hand holes, lamps, seams and underside clutter carry most of the realism; a full truck stays at 5,400 to 6,900 triangles.
- v2: the old trailer axles were 0.8 m apart with 1.0 m tyres (overlapping) and the landing gear sat inside the tractor; check spacing against tyre diameter and coupled vehicles.
- v2: forklift drive wheels at x = 0.42 passed through the mast channels; the drive axle sits behind the mast (x = 0.30).
- v2: Workbench review renders show glass as opaque dark panels; at runtime glass is 62% opaque, so judge glazing (cold-store cabin) in the app.
- v2: per-kind shade families keep the side-panel legend meaningful; fully different colours per unit (red or green forklifts) would contradict it.
