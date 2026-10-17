# Dispatch Twin backend

FastAPI service around an event-driven simulation engine for the outbound warehouse world.

- **Recorded replay** of a historical day from shipment and warehouse-task records (`app/replay.py`).
- **Engine** (`app/engine/`): a faithful Python port of the starter-kit engine (`simulation-lab/des.js`): future event list ordered by time then sequence, seven seeded random streams (common random numbers), triangular task times, replications and 95% confidence intervals. The same seed gives the same day, and the golden tests pin the numbers in the design documents.
- **Glass box:** every number comes from the site file (`demo-data/automotive-dispatch-demo/20_engine_site.json`), which is also the model card; every constraint is a plug-in rule (`app/engine/rules/`).

## Run locally

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
.\.venv\Scripts\python -m uvicorn app.main:app --reload --port 8000
```

Open API documentation at `http://localhost:8000/docs`. Extra CORS origins (for example a tunnel URL) go in `DISPATCH_TWIN_ORIGINS`, comma separated.

## Test

```powershell
.\.venv\Scripts\python -m pytest -q
```

`tests/test_engine_golden.py` is validation check 1 (verification): bit-identical random numbers, the 64-truck reference day at 1.95 h, the fill knee (1.18 / 1.49 / 1.67 / 3.28 h at 50 / 85 / 88 / 95% fill) and the levers (pre-pick at 88%: 1.03 h, 0% past slot).

## Experiments

```powershell
.\.venv\Scripts\python experiments\fill.py 9   # turnaround against warehouse fill, 30 random days per point
.\.venv\Scripts\python experiments\lever.py    # pre-pick and extra reach trucks at 50, 85, 88 and 95% fill
```

## Engine layout

| File | Role |
|---|---|
| `app/engine/des.py` | Event loop, entities, rule hooks, event log, stress meters |
| `app/engine/rng.py` | mulberry32 streams, triangular and exponential draws |
| `app/engine/rules/` | One module per constraint (`Rule` with id, name, hooks, params, source). Discovered automatically |
| `app/engine/site.py` | Site file to engine config; the model card |
| `app/engine/days.py` | Day catalogue: the dummy SAP export (64 trucks), the recorded day, tomorrow's plan |
| `app/engine/runner.py` | Scenario in, event log out: replications in a shared process pool, statistics, costs, compare, sweep, levers |

To add a constraint, follow `.claude/skills/sim-rule/SKILL.md`.

## Contract

`dispatch-twin/event-log@1`: a scenario goes in as JSON; an event log comes out as JSON, with the statistics over all replications. The 3D replay shows the replication closest to the median turnaround.

Scenario fields: `day_id`, `arrivals` (`trace` replays the day, `random` draws days from the hourly profile), `chance` (`sto` or `det`), `clock` (0 event-driven, 1 or 5 minute ticks), `seed`, `replications`, `params` (any model-card key), `rules` (rule id to false to switch it off), `demand_multiplier`, `slot_overrides`, `live_as_of_minutes`.

Every event: `time` (minutes after 06:00), `entity_id`, `entity_type` (`truck`, `reach_truck`, `forklift`, `pallet`, `system`), `state`, `location_id`, `destination_id`, `case_id`, `severity`, `metadata` (including `reason` and `rule` when a rule held something). Stress meters appear as `system` events `meter:<id>` whenever a level changes.

## Endpoints

| Method | Path | Returns |
|---|---|---|
| GET | `/health` | Service status and contract version |
| GET | `/api/config` | Layout, resources, shifts, rules and counts for the viewer |
| GET | `/api/days` | Day catalogue with trucks, pallets and peak hour |
| GET / POST | `/api/model-card` | Every parameter (value, kind, source, status) and rule; POST a scenario to see what it changes |
| GET | `/api/replay` | Recorded day as an event log |
| POST | `/api/simulate` | Scenario run: event log, statistics, stress points, heatmap |
| POST | `/api/compare` | Baseline against variant with paired seeds and a verdict |
| POST | `/api/sweep` | Turnaround against fill for each policy (the knee) |
| POST | `/api/levers` | As it is, pre-pick, +2 reach trucks, both |
