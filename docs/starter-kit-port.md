# Starter kit port record

Everything useful from `dispatch-twin-starter-kit` now lives in this repository. Nothing in the code reads the kit, so the kit folder can be deleted. This page records where each part went, what was left behind and why, and how the port was verified.

## Where each part went

| Starter kit | Now | Notes |
|---|---|---|
| `simulation-lab/des.js` (event-driven engine) | `backend/app/engine/des.py`, `rng.py` | Faithful port: same event ordering, same seven mulberry32 streams, same decisions. Adds rule hooks, an event log with resource identities and reasons, and stress meters, none of which change results. |
| des.js replications, 95% CI, common random numbers | `backend/app/engine/runner.py` | Replication r uses seed base + r in every scenario; paired-difference verdict from `lab.html`. Shared process pool. |
| des.js `BASE` constants | `demo-data/automotive-dispatch-demo/20_engine_site.json` | The model card: every number with kind (read, fitted, set), unit, source, status. |
| des.js trace day (seed 1410) and the twin's dummy SAP export | `demo-data/.../21_sap_day_2026-10-06.json` (built by `backend/scripts/build_sap_day.py`) | 64 trucks, VTTK/LIKP-shaped. Transporter names replaced by placeholders (the kit used real-sounding company names). |
| des.js policy branches (gate, pre-pick), putaway priority, lane limit, pre-stage cap, dock call, line held | `backend/app/engine/rules/*.py` | One plug-in rule each, switchable from the model card. |
| `experiments/fill.js`, `lever.js` | `backend/experiments/fill.py`, `lever.py` and `/api/sweep`, `/api/levers` | Same seeds and numbers; the Compare screen shows them. |
| Fill-congestion curve (a = 0.12, f0 = 0.70, 40% on loading) | `backend/app/engine/rules/fill_congestion.py` | Parameters in the model card as fitted assumptions. |
| `simulation-lab/lab.html` switches (chance, inputs, clock, replications, seed, policy, resources) | What-if controls in `frontend/src/App.tsx` | Chance, arrivals, replications, policy, fill, reach trucks, docks, forklifts, lanes, dock-call share, demand. Clock (1 and 5 minute ticks) is in the API. |
| `lab.html` engine room | Event log panel in the 3D view | Recent events with the rule and reason that held them. |
| `lab.html` policy comparison | Compare screen (`frontend/src/CompareView.tsx`) | Paired seeds, 95% ranges, verdict, cost. |
| `warehouse_twin.html` 8 stress points and thresholds | `stress_points` in the site file; meters in `des.py` | Thresholds aligned with the design doc's red-state table; utilisation meters use a 20-minute average. |
| `warehouse_twin.html` hour heatmap (click to replay) | Stress heatmap in Analyze (`AnalyticsView.tsx`) | |
| `warehouse_twin.html` story mode | "Play the story of this day" | Steps are built from the run's own first-red times, not a fixed script. |
| `warehouse_twin.html` day-to-night light, instanced pallets, merged static geometry | `WarehouseScene.tsx`, `scene/Facility.tsx`, `scene/models.tsx` | Already present; kept. |
| `port_twin.html` clean and recording mode, 4:5 frame, follow label | `H` clean mode, recording frame button, follow camera | |
| `.claude/skills/3d-item/` | `.claude/skills/3d-item/SKILL.md`, `frontend/tools/blender/items/*.json`, `check_items.py`, `optimize.mjs` | Adapted to this repo: forward +X, procedural builder, contract per item, budget check, review renders, glTF-Transform step with the five false flags. Lessons carried over. |
| `blender/lineup_campus_blockout.py`, `helpers.py` | `frontend/tools/blender/worlds/` | Seed of the production-plant world. Fixed for Blender 4.1+ (auto smooth) and the helper path. |
| Design doc rule contract | `.claude/skills/sim-rule/SKILL.md`, `backend/app/engine/rules/__init__.py` | How to add a constraint as one file. |

## Not ported, and why

| Starter kit | Reason |
|---|---|
| `warehouse-twin/engine.js` (time-stepped twin engine) | Not the reference (the kit README says so). Its extra rules (weighbridge, mixed pallets by pickers, shift handovers) are listed as next rules in `.claude/skills/sim-rule/SKILL.md`. |
| `yardline/` (inbound receiving prototype, CSV replay, detention in $) | A different world (inbound). Its CSV validator and break-point sweep are the pattern for the inbound template later; detention cost is now in the model card in rupees. |
| `yardline/yardline_world.glb`, `blender/yardline_build_world.py` | Superseded by the equipment library in `frontend/tools/blender/build_equipment.py`. |
| `.claude/skills/3d-item/blender/build_item.py`, `items/reach-truck.json` | Its JSON-to-geometry builder used front = +Z; this repo builds procedurally with front = +X. Its budget check, report and review render are ported into `check_items.py`. |
| `port-twin/port_twin.html` port simulation | Port terminal is a later world template; only the camera and recording techniques were taken. |

## Verification

- `backend/tests/test_engine_golden.py`: the Python engine reproduces the kit exactly (64 trucks, 1.9542968749999778 h; random day seed 5000: 69 trucks, 4,147 events; pre-pick seed 77; 5-minute clock 3.29375 h) and the design-doc tables (knee 1.18 / 1.49 / 1.67 / 3.28 h, pre-pick at 88% 1.03 h with 0% past slot, at 95% pre-pick 2.13 h and +2 reach trucks 2.14 h, yard overflow 24 of 30 days at 95%).
- `npm run models`: all 12 items pass their contracts; 752 KB raw to 427 KB optimised.
- The 3D motion model was checked headless against engine runs at 88% and 95% fill: no teleports, docked trucks in the right place, every pallet loaded before departure, no parked vehicles overlapping.

## Open items found during the port

- In the kit's own numbers the production line is never held (`lineHeld` is 0 even at 95% fill), so the last step of the documented cascade does not happen yet. It needs calibration of the buffer size, line rate and putaway priority, not a code change.
- Shift breaks, reach-truck maintenance, dock type and the weighbridge are not in the engine yet (see the sim-rule backlog).
