"""Disruptions, decisions from a fork time, and parallel futures."""

from app.engine.runner import futures, normalise, replicate, run_once, statistics_for


def test_reach_truck_breakdown_hurts_and_recovers():
    base = normalise({"replications": 6, "params": {"fillRate": 0.88}})
    broken = normalise({**base, "disruptions": [{"kind": "reach_truck_down", "count": 2, "duration": 180, "at": 540}]})
    assert statistics_for(replicate(broken), broken)["turnaround_hours"]["mean"] > statistics_for(replicate(base), base)["turnaround_hours"]["mean"]
    engine, _ = run_once(broken, broken["seed"], record=True)
    states = [(event["entity_id"], event["state"]) for event in engine.log if event["entity_type"] == "reach_truck" and event["metadata"].get("reason") in ("breakdown", "repaired")]
    assert sum(1 for _, state in states if state == "down") == 2
    assert sum(1 for _, state in states if state == "idle") == 2
    assert engine.rt_units == engine.C["reachTrucks"]


def test_decisions_apply_only_from_the_fork():
    base = normalise({"replications": 1, "chance": "det", "params": {"fillRate": 0.9}})
    decided = normalise({**base, "decisions": [{"at": 600, "params": {"addReachTrucks": 2}}]})
    before, _ = run_once(base, base["seed"], record=True)
    after, _ = run_once(decided, decided["seed"], record=True)
    cut = 600
    early = lambda log: [(e["time"], e["entity_id"], e["state"]) for e in log if e["time"] < cut and e["entity_id"] != "DECISION"]  # noqa: E731
    assert early(before.log) == early(after.log)
    assert after.rt_units == before.rt_units + 2


def test_rush_order_adds_trucks_and_dock_outage_closes_a_door():
    rush = normalise({"replications": 1, "disruptions": [{"kind": "truck_surge", "count": 6, "duration": 60, "at": 600}]})
    engine, summary = run_once(rush, rush["seed"])
    assert summary["n"] == 64 + 6
    dock = normalise({"replications": 1, "disruptions": [{"kind": "dock_down", "target": "D02", "duration": 240, "at": 600}]})
    engine, _ = run_once(dock, dock["seed"], record=True)
    assert not any(e["state"] == "docked" and e["location_id"] == "D02" and 600 < e["time"] < 840 and any(x["entity_id"] == "DOCK-D02" and x["state"] == "down" and x["time"] <= e["time"] for x in engine.log) for e in engine.log)


def test_futures_rank_decisions_against_do_nothing():
    result = futures({"replications": 4, "params": {"fillRate": 0.9}}, 540, "reach_truck_down")
    assert len(result["futures"]) == 24
    by_id = {item["id"]: item for item in result["futures"]}
    assert by_id[result["baseline"]]["do_nothing"]
    assert by_id[result["best"]]["on_time"] >= by_id[result["baseline"]]["on_time"]
    assert len(by_id[result["best"]]["series"]) == result["horizon"] // result["step"]
