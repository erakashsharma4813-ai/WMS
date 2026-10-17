# Dispatch Twin

Warehouse dispatch digital twin: replay a real past day, change only what is different tomorrow, and see in 3D where stress starts and how it spreads, with the result in hours, percentages and rupees.

- `backend/`: FastAPI service with the event-driven simulation engine (`app/engine/`), plug-in rules, the model card, replications, compare and fill sweep.
- `frontend/`: React, TypeScript and three.js 3D operations view; Blender pipeline for the equipment library (`frontend/tools/blender/`).
- `demo-data/automotive-dispatch-demo/`: synthetic site data, the engine site file (`20_engine_site.json`, the model card) and the dummy SAP day (`21_sap_day_2026-10-06.json`).
- `.claude/skills/`: `3d-item` (build an equipment item to the standard) and `sim-rule` (add a constraint as a plug-in rule).
- `docs/`: design review and the starter-kit port record.

## What it does

1. **Recorded replay.** Plays a recorded day from timestamped shipments and warehouse tasks.
2. **What-if.** Runs a past day through the engine with your changes (warehouse fill, pre-pick, reach trucks, docks, forklifts, lanes, demand) over 1 to 30 simulated days, with 95% confidence ranges.
3. **Live replanning.** Freezes the day at a time and moves only future truck bookings.
4. **Compare.** Baseline against scenario with the same random seeds: the difference, whether it is real, the cost, the fill knee and the levers. The flagship message: act at 88% full, not at 95%.
5. **Model card.** Every number with its kind, source and status; every rule with a switch.

## Start locally

Terminal 1:

```powershell
cd C:\Code\WMS\backend
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
.\.venv\Scripts\python -m uvicorn app.main:app --reload --port 8000
```

Terminal 2:

```powershell
cd C:\Code\WMS\frontend
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. API documentation is at `http://127.0.0.1:8000/docs`.

## Verification

```powershell
cd C:\Code\WMS\backend
.\.venv\Scripts\python -m pytest -q        # includes the golden numbers from the design documents

cd C:\Code\WMS\frontend
npm run build
npm run models                             # needs Blender: rebuild, check and optimise the 3D items
```
