"""Golden tests: the engine must reproduce the numbers in the design documents.

These numbers were produced by the starter-kit engine (simulation-lab/des.js)
before it was ported. The Python engine is a faithful port; if any of these
change, a rule or the event ordering changed. Validation check 1
(verification) in "Simulation platform design".
"""

import math

import pytest

from app.engine.des import Engine, random_day, summarize, trace_day
from app.engine.rng import mulberry, streams
from app.engine.rules import RuleSet
from app.engine.runner import levers, normalise, replicate, run_once, simulate, statistics_for, sweep
from app.engine.site import engine_config

KIT = {"seed": 5000, "replications": 30, "arrivals": "random", "chance": "sto"}


def run(config, day, rules=None, record=False):
    engine = Engine(config, day, RuleSet(config, rules or {}), record=record).run()
    return engine, summarize(engine)


def test_random_numbers_match_mulberry32():
    draw = mulberry(1410)
    assert [round(draw(), 12) for _ in range(3)] == [round(value, 12) for value in (0.1316542790737003, 0.45434008771553636, 0.4294538164976984)]


def test_reference_day_is_the_dummy_sap_trace():
    day = trace_day(engine_config())
    assert len(day) == 64
    assert sum(truck["pallets"] for truck in day) == 1050
    assert day[0] == {"report": 387, "pallets": 22, "type": "32 ft"}


def test_deterministic_baseline_matches_the_kit():
    config = engine_config(seed=1, chance="det")
    _, summary = run(config, trace_day(config))
    assert summary["done"] == 64
    assert summary["events"] == 4020
    assert summary["avg"] / 60 == pytest.approx(1.9542968749999778, abs=1e-9)


def test_time_stepped_clock_matches_the_kit():
    config = engine_config(seed=1, chance="det", clock=5)
    _, summary = run(config, trace_day(config))
    assert summary["avg"] / 60 == pytest.approx(3.29375, abs=1e-9)


def test_stochastic_random_day_matches_the_kit():
    config = engine_config({"reachTrucks": 9}, seed=5000, chance="sto")
    _, summary = run(config, random_day(config, streams(5000)["arrivals"]))
    assert summary["done"] == 69
    assert summary["events"] == 4147
    assert summary["avg"] / 60 == pytest.approx(1.1607181472573986, abs=1e-9)


def test_prepick_policy_matches_the_kit():
    config = engine_config({"policy": "prepick"}, seed=77, chance="sto")
    _, summary = run(config, trace_day(config))
    assert summary["events"] == 3984
    assert summary["avg"] / 60 == pytest.approx(1.001153570671423, abs=1e-9)


def test_fill_knee_matches_the_design_doc():
    result = sweep({**KIT, "params": {"reachTrucks": 9}}, [0.5, 0.85, 0.88, 0.95], ["gate"])
    points = {point["fill"]: point for point in result["curves"][0]["points"]}
    assert points[0.5]["turnaround_hours"]["mean"] == pytest.approx(1.18, abs=0.01)
    assert points[0.85]["turnaround_hours"]["mean"] == pytest.approx(1.49, abs=0.01)
    assert points[0.88]["turnaround_hours"]["mean"] == pytest.approx(1.67, abs=0.01)
    assert points[0.95]["turnaround_hours"]["mean"] == pytest.approx(3.28, abs=0.01)
    assert points[0.95]["turnaround_hours"]["ci95"] == pytest.approx(0.28, abs=0.01)
    assert points[0.95]["over_slot_pct"] == pytest.approx(49, abs=1)
    assert points[0.95]["yard_full_days"] == 24


def test_act_at_88_not_95():
    at88 = {row["lever"]: row for row in levers({**KIT, "params": {"reachTrucks": 9, "fillRate": 0.88}})["levers"]}
    assert at88["As it is"]["turnaround_hours"]["mean"] == pytest.approx(1.67, abs=0.01)
    assert at88["Pre-pick evening trucks"]["turnaround_hours"]["mean"] == pytest.approx(1.03, abs=0.01)
    assert at88["Pre-pick evening trucks"]["over_slot_pct"] == 0
    at95 = {row["lever"]: row for row in levers({**KIT, "params": {"reachTrucks": 9, "fillRate": 0.95}})["levers"]}
    assert at95["Pre-pick evening trucks"]["turnaround_hours"]["mean"] == pytest.approx(2.13, abs=0.01)
    assert at95["+2 reach trucks (11)"]["turnaround_hours"]["mean"] == pytest.approx(2.14, abs=0.01)


def test_same_seed_same_result_and_common_random_numbers():
    scenario = normalise({"replications": 4, "params": {"fillRate": 0.9}})
    first = [summary["avg"] for summary in replicate(scenario)]
    _, again = run_once(scenario, scenario["seed"])
    assert first[0] == again["avg"]


def test_switching_a_rule_off_changes_the_result():
    scenario = normalise({"replications": 6, "params": {"fillRate": 0.95, "reachTrucks": 9}})
    with_rule = statistics_for(replicate(scenario), scenario)["turnaround_hours"]["mean"]
    off = normalise({**scenario, "rules": {"fill-congestion": False}})
    without = statistics_for(replicate(off), off)["turnaround_hours"]["mean"]
    assert without < with_rule


def test_forklifts_per_door_spreads_loading_across_doors():
    scenario = normalise({"replications": 6, "params": {"fillRate": 0.88, "reachTrucks": 9}})
    unlimited = statistics_for(replicate(scenario), scenario)["turnaround_hours"]["mean"]
    limited = normalise({**scenario, "rules": {"loaders-per-door": True}})
    engine, _ = run_once(limited, limited["seed"], record=True)
    at_door: dict[str, int] = {}
    busiest = 0
    for event in engine.log:
        if event["entity_type"] != "forklift":
            continue
        door = event["destination_id"] if event["state"] == "loading_pallet" else event["location_id"]
        at_door[door] = at_door.get(door, 0) + (1 if event["state"] == "loading_pallet" else -1)
        busiest = max(busiest, at_door[door])
    assert busiest <= 2
    assert statistics_for(replicate(limited), limited)["turnaround_hours"]["mean"] < unlimited


def test_event_log_conserves_trucks_and_pallets():
    scenario = normalise({"replications": 1, "params": {"fillRate": 0.88}})
    engine, summary = run_once(scenario, scenario["seed"], record=True)
    trucks = {}
    for event in engine.log:
        if event["entity_type"] == "truck":
            trucks.setdefault(event["entity_id"], []).append(event["state"])
    assert len(trucks) == summary["n"]
    for states in trucks.values():
        assert states[0] == "reported"
        assert states[-1] == "departed"
    loaded = sum(1 for event in engine.log if event["entity_type"] == "forklift" and event["state"] == "idle")
    assert loaded == sum(truck.pallets for truck in engine.trucks)
    times = [event["time"] for event in engine.log]
    assert times == sorted(times)
    reach = {event["entity_id"] for event in engine.log if event["entity_type"] == "reach_truck"}
    assert reach <= {f"RT-{i:02d}" for i in range(1, engine.C["reachTrucks"] + 1)}


def test_simulate_returns_the_contract():
    result = simulate({"replications": 3, "params": {"fillRate": 0.95}})
    assert result["contract"].startswith("dispatch-twin/event-log")
    assert result["statistics"]["replications"] == 3
    assert any(point["first_red"] is not None for point in result["stress_points"])
    assert any(event["metadata"].get("rule") == "delivery-slot" for event in result["trace"])
    assert not math.isnan(result["kpis"]["average_turnaround_minutes"])
