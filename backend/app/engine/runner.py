"""Scenario runner: replications, statistics, compare, fill sweep and the event log.

Contract: a scenario goes in as JSON, an event log (plus summary statistics)
comes out as JSON. The frontend reads only what this module returns.
"""

from __future__ import annotations

import json
import math
import os
import statistics
from concurrent.futures import ProcessPoolExecutor
import hashlib

from .days import DEFAULT_DAY, get_day
from .des import Engine, confidence_interval, random_day, summarize
from .rng import mulberry, streams
from .rules import RuleSet
from .rules.fill_congestion import factor as congestion_factor
from .site import engine_config, model_card, site

CONTRACT = "dispatch-twin/event-log@1"
MAX_WORKERS = max(1, min(8, (os.cpu_count() or 2) - 1))


# --- scenario ---------------------------------------------------------------
def normalise(scenario: dict) -> dict:
    """Defaults for every scenario field, so cache keys and echoes are stable."""
    out = {
        "day_id": scenario.get("day_id") or DEFAULT_DAY,
        "arrivals": scenario.get("arrivals") or "trace",
        "chance": scenario.get("chance") or "sto",
        "clock": int(scenario.get("clock") or 0),
        "seed": int(scenario.get("seed") if scenario.get("seed") is not None else 5000),
        "replications": max(1, min(200, int(scenario.get("replications") or 1))),
        "params": dict(sorted((scenario.get("params") or {}).items())),
        "rules": dict(sorted((scenario.get("rules") or {}).items())),
        "demand_multiplier": float(scenario.get("demand_multiplier") or 1.0),
        "slot_overrides": sorted(scenario.get("slot_overrides") or [], key=lambda item: item["shipment_id"]),
        "live_as_of_minutes": scenario.get("live_as_of_minutes"),
        "disruptions": [dict(item) for item in scenario.get("disruptions") or []],
        "decisions": [dict(item) for item in scenario.get("decisions") or []],
    }
    if out["chance"] == "det":
        out["replications"] = 1
    return out


def _key(scenario: dict) -> str:
    return json.dumps(scenario, sort_keys=True)


def _trucks(scenario: dict, config: dict, seed: int) -> list[dict]:
    if scenario["arrivals"] == "random":
        trucks = random_day(config, streams(seed)["arrivals"])
    else:
        trucks = [dict(truck) for truck in get_day(scenario["day_id"])["trucks"]]
    multiplier = scenario["demand_multiplier"]
    if abs(multiplier - 1) > 1e-6 and trucks:
        target = max(1, round(len(trucks) * multiplier))
        if target < len(trucks):
            step = len(trucks) / target
            trucks = [trucks[math.floor(i * step)] for i in range(target)]
        else:
            base = list(trucks)
            for i in range(target - len(base)):
                clone = dict(base[i % len(base)])
                clone["report"] = clone["report"] + 7 + 11 * (i // len(base))
                if clone.get("code"):
                    clone["code"] = f"{clone['code']}-X{i // len(base) + 1}"
                trucks.append(clone)
        trucks.sort(key=lambda truck: truck["report"])
    overrides = {item["shipment_id"]: item for item in scenario["slot_overrides"]}
    if overrides:
        cut = scenario["live_as_of_minutes"]
        start = config["start"]
        for truck in trucks:
            item = overrides.get(truck.get("code")) or overrides.get(truck.get("shipment_id"))
            if not item:
                continue
            # live replanning only moves bookings that are still in the future
            if cut is not None and truck["report"] - start < cut:
                continue
            truck["report"] = max(start, truck["report"] + item.get("arrival_offset_minutes", 0))
            if cut is not None:
                truck["report"] = max(truck["report"], start + cut)
        trucks.sort(key=lambda truck: truck["report"])
    for disruption in scenario["disruptions"]:
        if disruption.get("kind") != "truck_surge":
            continue
        # a rush order: extra trucks report over the next window; fixed draws so every replication sees the same rush
        draw = mulberry(4242 + int(disruption["at"]))
        count = int(disruption.get("count", 6))
        window = disruption.get("duration", 60)
        start = config["start"] + disruption["at"]
        for index in range(count):
            u = draw()
            acc = 0.0
            chosen = config["types"][0]
            for item in config["types"]:
                acc += item["share"]
                if u <= acc:
                    chosen = item
                    break
            trucks.append({"report": start + window * index / max(1, count) + draw() * 5, "pallets": chosen["pallets"], "type": chosen["name"], "code": f"RUSH-{index + 1:02d}", "shipment_id": f"RUSH-{index + 1:02d}", "transporter": "Rush order"})
        trucks.sort(key=lambda truck: truck["report"])
    for index, truck in enumerate(trucks):
        truck.setdefault("code", f"T{index + 1:02d}")
    return trucks


def _config(scenario: dict, seed: int) -> dict:
    config = engine_config(scenario["params"], seed=seed, chance=scenario["chance"], clock=scenario["clock"])
    config["disruptions"] = scenario["disruptions"]
    config["decisions"] = scenario["decisions"]
    return config


def run_once(scenario: dict, seed: int, record: bool = False) -> tuple[Engine, dict]:
    config = _config(scenario, seed)
    engine = Engine(config, _trucks(scenario, config, seed), RuleSet(config, scenario["rules"]), record=record).run()
    return engine, summarize(engine)


def _summary_only(args) -> dict:
    scenario, seed = args
    return run_once(scenario, seed)[1]


_CACHE: dict[str, list[dict]] = {}
_POOL: ProcessPoolExecutor | None = None


def _pool() -> ProcessPoolExecutor:
    """One long-lived worker pool for the whole server: no per-request start-up, no oversubscription."""
    global _POOL
    if _POOL is None:
        _POOL = ProcessPoolExecutor(max_workers=MAX_WORKERS)
    return _POOL
_CACHE_LIMIT = 256


def replicate_many(scenarios: list[dict]) -> list[list[dict]]:
    """Run every replication of every scenario in one process pool.

    Common random numbers: replication r always uses seed base + r, in every
    scenario, so differences between scenarios are not random-number noise.
    """
    keys = [_key(scenario) for scenario in scenarios]
    jobs = []
    for key, scenario in zip(keys, scenarios):
        if key not in _CACHE:
            jobs.extend((key, scenario, scenario["seed"] + r) for r in range(scenario["replications"]))
    if jobs:
        args = [(scenario, seed) for _, scenario, seed in jobs]
        if len(jobs) >= 8 and MAX_WORKERS > 1:
            results = list(_pool().map(_summary_only, args, chunksize=max(1, len(args) // (MAX_WORKERS * 3))))
        else:
            results = [_summary_only(arg) for arg in args]
        fresh: dict[str, list[dict]] = {}
        for (key, _, _), result in zip(jobs, results):
            fresh.setdefault(key, []).append(result)
        if len(_CACHE) + len(fresh) > _CACHE_LIMIT:
            _CACHE.clear()
        _CACHE.update(fresh)
    return [_CACHE[key] for key in keys]


def replicate(scenario: dict) -> list[dict]:
    return replicate_many([scenario])[0]


# --- statistics ---------------------------------------------------------------
def _costs(summary: dict, values: dict) -> dict:
    slot = values["slotMinutes"]
    detention_hours = sum(max(0.0, tat - slot) for tat in summary["tats"]) / 60
    missed = sum(1 for tat in summary["tats"] if tat > slot)
    line_hours = summary["lineHeld"] / max(1e-9, values["prodPerHour"])
    detention = detention_hours * values["detentionPerHour"]
    penalties = missed * values["missedSlotPenalty"]
    line = line_hours * values["lineStopPerHour"]
    return {"detention": detention, "penalties": penalties, "line_stop": line, "total": detention + penalties + line}


def statistics_for(summaries: list[dict], scenario: dict) -> dict:
    values = engine_config(scenario["params"])
    slot = values["slotMinutes"]
    yard_cap = values["holdingYardBays"]
    tats = [tat for summary in summaries for tat in summary["tats"]]
    avg_ci = confidence_interval([summary["avg"] / 60 for summary in summaries if not math.isnan(summary["avg"])] or [0.0])
    costs = [_costs(summary, values) for summary in summaries]
    cost_ci = confidence_interval([cost["total"] for cost in costs])
    full_hours = []
    for summary in summaries:
        hit = next((int(hour) for hour, row in sorted(summary["hourly"].items(), key=lambda item: int(item[0])) if row["yard"] >= yard_cap), None)
        if hit is not None:
            full_hours.append(hit)
    late = [summary["late"] / 60 for summary in summaries if not math.isnan(summary["late"])]
    return {
        "replications": len(summaries),
        "turnaround_hours": {"mean": round(avg_ci["m"], 3), "ci95": round(avg_ci["h"], 3)},
        "p90_turnaround_hours": round(_percentile(tats, 0.9) / 60, 3) if tats else 0.0,
        "evening_turnaround_hours": round(statistics.fmean(late), 3) if late else 0.0,
        "over_slot_pct": round(100 * sum(1 for tat in tats if tat > slot) / len(tats), 1) if tats else 0.0,
        "yard_full_days": len(full_hours),
        "first_yard_full_hour": round(statistics.fmean(full_hours), 1) if full_hours else None,
        "trucks_completed_share": round(statistics.fmean(summary["done"] / max(1, summary["n"]) for summary in summaries), 3),
        "line_held_pallets": round(statistics.fmean(summary["lineHeld"] for summary in summaries), 1),
        "cost_inr": {
            "mean": round(cost_ci["m"]),
            "ci95": round(cost_ci["h"]),
            "detention": round(statistics.fmean(cost["detention"] for cost in costs)),
            "penalties": round(statistics.fmean(cost["penalties"] for cost in costs)),
            "line_stop": round(statistics.fmean(cost["line_stop"] for cost in costs)),
        },
        "congestion_factor": round(congestion_factor(values), 3),
        "slot_minutes": slot,
    }


def _percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return float(ordered[min(len(ordered) - 1, max(0, round((len(ordered) - 1) * fraction)))])


# --- event log post-processing --------------------------------------------------
def _slot_events(log: list[dict], config: dict) -> list[dict]:
    """Truck amber at 80% of its slot, red past it; later events keep the escalation."""
    slot = config["slotMinutes"]
    amber_share = config["slotAmberShare"]
    by_truck: dict[str, list[dict]] = {}
    for event in log:
        if event["entity_type"] == "truck":
            by_truck.setdefault(event["entity_id"], []).append(event)
    extra = []
    for truck_id, events in by_truck.items():
        reported = next((event["time"] for event in events if event["state"] == "reported"), None)
        if reported is None:
            continue
        departed = next((event["time"] for event in events if event["state"] == "departed"), math.inf)
        marks = [(reported + slot * amber_share, "warning", f"{round(amber_share * 100)}% of the {slot // 60} h slot used"), (reported + slot, "critical", f"past its {slot // 60} h slot")]
        for at, severity, reason in marks:
            if at >= departed:
                break
            current = [event for event in events if event["time"] <= at][-1]
            extra.append({**current, "time": round(at, 4), "severity": severity, "label": f"{truck_id} · {reason}", "metadata": {**current["metadata"], "slot": severity, "reason": reason, "rule": "delivery-slot"}})
        level = 0
        thresholds = [reported + slot * amber_share, reported + slot]
        for event in events:
            level = sum(1 for threshold in thresholds if event["time"] >= threshold)
            if level:
                event["severity"] = "critical" if level == 2 else "warning"
    return extra


def _first(events: list[dict], state: str):
    return next((event["time"] for event in events if event["state"] == state), None)


def _delay_row(stage: str, display_name: str, values: list[float], cause: str, recommendation: str) -> dict:
    average = statistics.fmean(values) if values else 0.0
    maximum = max(values, default=0.0)
    severity = "critical" if average >= 60 or maximum >= 150 else "warning" if average >= 20 or maximum >= 60 else "normal"
    return {
        "stage": stage,
        "display_name": display_name,
        "average_wait_minutes": round(average, 1),
        "p90_wait_minutes": round(_percentile(values, 0.9), 1),
        "maximum_wait_minutes": round(maximum, 1),
        "affected_entities": sum(1 for value in values if value >= 10),
        "total_delay_minutes": round(sum(values), 1),
        "severity": severity,
        "cause": cause,
        "recommendation": recommendation,
    }


LEVEL_SCORE = {"normal": 0, "amber": 1, "red": 2}


def response(scenario: dict, engine: Engine, summary: dict, stats: dict | None) -> dict:
    config = engine.C
    start = config["start"]
    log = engine.log
    log.extend(_slot_events(log, config))
    log.sort(key=lambda event: event["time"])
    day = get_day(scenario["day_id"]) if scenario["arrivals"] == "trace" else None
    date = day["date"] if day else "2026-10-13"
    trucks: dict[str, list[dict]] = {}
    for event in log:
        if event["entity_type"] == "truck":
            trucks.setdefault(event["entity_id"], []).append(event)
    done = [events for events in trucks.values() if _first(events, "departed") is not None]
    tats = [_first(events, "departed") - _first(events, "reported") for events in done]
    slot = config["slotMinutes"]

    # stress points: intervals and first red time from meter events
    points = []
    for point in config["stress_points"]:
        events = [event for event in log if event["entity_id"] == f"meter:{point['id']}"]
        red_minutes = 0.0
        first_red = None
        for index, event in enumerate(events):
            end = events[index + 1]["time"] if index + 1 < len(events) else summary_end(log)
            if event["state"] == "red":
                red_minutes += end - event["time"]
                first_red = event["time"] if first_red is None else first_red
        first_amber = next((event["time"] for event in events if event["state"] == "amber"), None)
        points.append({**{k: point[k] for k in ("id", "number", "label", "location", "metric", "amber", "red")}, "first_amber": first_amber, "first_red": first_red, "red_minutes": round(red_minutes, 1)})

    hours = range(math.floor(start / 60), math.floor((start + summary_end(log)) / 60) + 1)
    hourly = []
    stress_hourly = []
    for hour in hours:
        row = summary["hourly"].get(hour) or {}
        begin, end = hour * 60 - start, hour * 60 - start + 60
        arrivals = sum(1 for events in trucks.values() if (t := _first(events, "reported")) is not None and begin <= t < end)
        departures = [events for events in done if begin <= _first(events, "departed") < end]
        hour_tats = [_first(events, "departed") - _first(events, "reported") for events in departures]
        levels = {}
        metrics = {**row, "fg": row.get("inbound", 0) / max(1, config["inboundCap"]), "line": 0.0}
        for point in config["stress_points"]:
            value = metrics.get(point["metric"], 0.0)
            level = "red" if value >= point["red"] else "amber" if value >= point["amber"] else "normal"
            if point.get("also_red_metric") and metrics.get(point["also_red_metric"], 0) >= point["also_red_at"]:
                level = "red"
            levels[point["id"]] = level
        held = sum(1 for event in log if event["entity_id"] == "LINE-1" and begin <= event["time"] < end)
        if held:
            levels["line"] = "red"
        stress_score = min(100.0, row.get("rt", 0) * 60 + min(row.get("backlog", 0), 90) / 90 * 40)
        hourly.append({
            "hour": hour % 24,
            "truck_arrivals": arrivals,
            "completed_trucks": len(departures),
            "average_turnaround_minutes": round(statistics.fmean(hour_tats), 1) if hour_tats else 0.0,
            "picking_queue_peak": round(row.get("backlog", 0)),
            "reach_truck_utilization": round(row.get("rt", 0), 3),
            "dock_utilization": round(row.get("flt", 0), 3),
            "stress_score": round(stress_score, 1),
        })
        stress_hourly.append({"hour": hour % 24, "metrics": {key: round(value, 3) for key, value in metrics.items()}, "levels": levels})

    worst = max(hourly, key=lambda item: item["stress_score"]) if hourly else {"hour": 0}
    ranked = sorted(points, key=lambda point: point["red_minutes"], reverse=True)
    bottleneck = ranked[0]["label"] if ranked and ranked[0]["red_minutes"] > 0 else "None reached red"

    def stage(begin_state: str, end_state: str) -> list[float]:
        values = []
        for events in trucks.values():
            a, b = _first(events, begin_state), _first(events, end_state)
            if a is not None and b is not None:
                values.append(max(0.0, b - a))
        return values

    delay_analysis = [
        _delay_row("gate", "Gate and check-in", stage("reported", "yard_wait"), "Trucks queue for two gate lanes during the reporting peak.", "Spread transporter reporting times when the gate queue builds."),
        _delay_row("picking", "Pallet readiness", stage("yard_wait", "called_to_dock"), "A truck is called only when its pallets are staged; picking shares reach trucks with putaway.", "Pre-pick evening trucks in the morning, or add reach trucks during the peak."),
        _delay_row("yard", "Yard wait for dock", stage("called_to_dock", "docked"), "Drive from the holding yard to the called dock.", "Keep docks free of trucks that are waiting for pallets."),
        _delay_row("loading", "Loading at dock", stage("docked", "loaded"), "Forklifts load from the lane; pallets still being picked hold the truck at the dock.", "Call trucks when pallets are ready, not before."),
        _delay_row("exit", "Invoice and gate out", stage("loaded", "departed"), "Invoice and goods issue by the dispatch office.", "Prepare documents before loading completes."),
    ]
    delay_analysis.sort(key=lambda row: row["total_delay_minutes"], reverse=True)

    schedule = []
    for code, events in trucks.items():
        reported = _first(events, "reported")
        called = _first(events, "called_to_dock")
        loaded = _first(events, "loaded")
        departed = _first(events, "departed")
        docked = next((event["location_id"] for event in events if event["state"] == "docked"), None)
        meta = events[0]["metadata"]
        schedule.append({
            "shipment_id": code,
            "planned_slot_minutes": round(meta.get("planned_slot", reported or 0), 1),
            "simulated_arrival_minutes": round(reported or 0, 1),
            "production_ready_minutes": round(called if called is not None else reported or 0, 1),
            "all_pallets_ready_minutes": round(loaded or 0, 1),
            "pallets": meta.get("pallets", 0),
            "priority": "normal",
            "preferred_dock": None,
            "assigned_dock": docked,
            "slot_status": "past_slot" if departed is not None and departed - reported > slot else "within_slot" if departed is not None else "on_site",
            "truck_type": meta.get("truck_type"),
            "transporter": meta.get("transporter"),
        })
    schedule.sort(key=lambda row: row["simulated_arrival_minutes"])

    def clock(minutes):
        return f"{int((start + minutes) // 60) % 24:02d}:{int((start + minutes) % 60):02d}"

    reds = [point for point in points if point["first_red"] is not None]
    reds.sort(key=lambda point: point["first_red"])
    findings = []
    if stats:
        findings.append(f"Average turnaround {stats['turnaround_hours']['mean']:.2f} h ± {stats['turnaround_hours']['ci95']:.2f} h over {stats['replications']} simulated days; {stats['over_slot_pct']:.0f}% of trucks past the {slot // 60} h slot.")
        if stats["congestion_factor"] > 1.001:
            findings.append(f"At {round(config['fillRate'] * 100)}% fill every pick and putaway takes {round((stats['congestion_factor'] - 1) * 100)}% longer; the queues multiply that into turnaround.")
        findings.append(f"Estimated cost of the day: ₹{stats['cost_inr']['mean']:,} (detention, missed slots and line stops).")
    if reds:
        findings.append("Stress cascade: " + " → ".join(f"{point['label']} {clock(point['first_red'])}" for point in reds[:6]) + ".")
    else:
        findings.append("No stress point reached red in this run.")
    findings.append(f"The worst hour is {worst['hour']:02d}:00–{(worst['hour'] + 1) % 24:02d}:00.")

    lanes_used = [event["metadata"].get("yard_queue", 0) for event in log if event["state"] == "yard_wait"]
    return {
        "contract": CONTRACT,
        "run_id": "des-" + hashlib.sha1(_key(scenario).encode()).hexdigest()[:10],
        "mode": "dynamic_simulation",
        "scenario_id": scenario["params"].get("policy", "gate").upper(),
        "seed": engine.C["seed"],
        "start_timestamp": f"{date}T{start // 60:02d}:{start % 60:02d}:00+05:30",
        "duration_minutes": round(summary_end(log), 1),
        "kpis": {
            "trucks": len(trucks),
            "pallets": sum(events[0]["metadata"].get("pallets", 0) for events in trucks.values()),
            "completed_trucks": len(done),
            "average_turnaround_minutes": round(statistics.fmean(tats), 1) if tats else 0.0,
            "p90_turnaround_minutes": round(_percentile(tats, 0.9), 1),
            "maximum_picking_queue": max((row["picking_queue_peak"] for row in hourly), default=0),
            "maximum_yard_queue": max(lanes_used, default=0),
            "reach_truck_utilization": round(statistics.fmean(row["reach_truck_utilization"] for row in hourly), 3) if hourly else 0.0,
            "dock_utilization": round(statistics.fmean(row["dock_utilization"] for row in hourly), 3) if hourly else 0.0,
            "worst_hour": f"{worst['hour']:02d}:00–{(worst['hour'] + 1) % 24:02d}:00",
            "primary_bottleneck": bottleneck,
        },
        "hourly": hourly,
        "delay_analysis": delay_analysis,
        "shipment_schedule": schedule,
        "trace": log,
        "findings": findings,
        "statistics": stats,
        "stress_points": points,
        "stress_hourly": stress_hourly,
        "scenario": scenario,
        "day_id": scenario["day_id"],
    }


def summary_end(log: list[dict]) -> float:
    return max((event["time"] for event in log), default=0.0)


# --- public operations ------------------------------------------------------------
def simulate(raw: dict) -> dict:
    scenario = normalise(raw)
    summaries = replicate(scenario)
    stats = statistics_for(summaries, scenario)
    # the 3D replay shows the replication closest to the median turnaround
    order = sorted(range(len(summaries)), key=lambda index: summaries[index]["avg"])
    representative = order[len(order) // 2]
    engine, summary = run_once(scenario, scenario["seed"] + representative, record=True)
    result = response(scenario, engine, summary, stats)
    result["representative_replication"] = representative
    return result


def compare(baseline_raw: dict, variant_raw: dict) -> dict:
    baseline = normalise(baseline_raw)
    variant = normalise({**variant_raw, "seed": baseline["seed"], "replications": baseline["replications"]})
    a, b = replicate_many([baseline, variant])
    diffs = [(y["avg"] - x["avg"]) / 60 for x, y in zip(a, b)]
    ci = confidence_interval(diffs)
    return {
        "contract": CONTRACT,
        "baseline": {"scenario": baseline, "statistics": statistics_for(a, baseline)},
        "variant": {"scenario": variant, "statistics": statistics_for(b, variant)},
        "difference_hours": {"mean": round(ci["m"], 3), "ci95": round(ci["h"], 3)},
        "verdict": "real" if abs(ci["m"]) > ci["h"] else "within noise",
        "method": "Common random numbers: replication r uses the same seed in both scenarios; 95% CI of the paired difference.",
    }


def sweep(raw: dict, fills: list[float], policies: list[str]) -> dict:
    base = normalise(raw)
    grid = [(policy, fill, {**base, "params": dict(sorted({**base["params"], "fillRate": fill, "policy": policy}.items()))}) for policy in policies for fill in fills]
    results = replicate_many([scenario for _, _, scenario in grid])
    curves = []
    for policy in policies:
        points = [{"fill": fill, **statistics_for(result, scenario)} for (p, fill, scenario), result in zip(grid, results) if p == policy]
        curves.append({"policy": policy, "points": points})
    return {"contract": CONTRACT, "scenario": base, "curves": curves}


# --- parallel futures --------------------------------------------------------------
DISRUPTIONS = {
    "reach_truck_down": {"label": "Reach truck down", "kind": "reach_truck_down", "count": 1, "duration": 180},
    "rush_order": {"label": "Rush order: 6 extra trucks", "kind": "truck_surge", "count": 6, "duration": 60},
    "dock_down": {"label": "Dock D02 out of service", "kind": "dock_down", "target": "D02", "duration": 240},
    "gate_clerk_out": {"label": "Gate clerk out", "kind": "gate_down", "count": 1, "duration": 180},
}

FUTURE_ROWS = [("No extra reach trucks", 0), ("+1 reach truck", 1), ("+2 reach trucks", 2), ("+3 reach trucks", 3)]
FUTURE_COLS = [
    ("Pick at gate", "call at 60%", {}),
    ("Pick at gate", "call at 40%", {"callShare": 0.4}),
    ("Pre-pick next 2 h", "call at 60%", {"prepickHorizon": 120}),
    ("Pre-pick next 2 h", "call at 40%", {"prepickHorizon": 120, "callShare": 0.4}),
    ("Pre-pick next 4 h", "call at 60%", {"prepickHorizon": 240}),
    ("Pre-pick next 4 h", "call at 40%", {"prepickHorizon": 240, "callShare": 0.4}),
]


def _after_fork(summary: dict, start: int, fork: float, horizon: float, slot: float, step: float = 15) -> dict:
    begin, end = start + fork, start + fork + horizon
    window = [(out, tat) for out, tat in summary["departures"] if begin < out <= end]
    on_time = [out for out, tat in window if tat <= slot]
    buckets = int(horizon // step)
    series = [sum(1 for out in on_time if out <= begin + step * (k + 1)) for k in range(buckets)]
    return {
        "dispatched": len(window),
        "on_time": len(on_time),
        "late": len(window) - len(on_time),
        "tat": statistics.fmean(tat for _, tat in window) / 60 if window else 0.0,
        "series": series,
    }


def futures(raw: dict, fork_at: float, disruption_id: str, horizon: float = 480) -> dict:
    """Fork the day at a disruption and play every decision with the same seeds.

    Every future sees the same breakdown and the same random task times
    (common random numbers); only the decision differs. Ranked by trucks
    dispatched within their slot after the fork, then by late trucks.
    """
    base = normalise(raw)
    disruption = {**DISRUPTIONS[disruption_id], "at": fork_at}
    base = {**base, "disruptions": [*base["disruptions"], disruption]}
    grid = []
    for row, (row_label, extra) in enumerate(FUTURE_ROWS):
        for col, (policy_label, call_label, params) in enumerate(FUTURE_COLS):
            decision = {**params, **({"addReachTrucks": extra} if extra else {})}
            label = f"{row_label} · {policy_label} · {call_label}"
            scenario = {**base, "decisions": [*base["decisions"], {"at": fork_at, "params": decision, "label": label}] if decision else base["decisions"]}
            grid.append((row, col, label, decision, scenario))
    results = replicate_many([scenario for *_, scenario in grid])
    values = engine_config(base["params"])
    slot = values["slotMinutes"]
    start = values["start"]
    rows = []
    for (row, col, label, decision, scenario), summaries in zip(grid, results):
        per = [_after_fork(summary, start, fork_at, horizon, slot) for summary in summaries]
        stats = statistics_for(summaries, scenario)
        rows.append({
            "id": f"F{len(rows) + 1}",
            "row": row,
            "col": col,
            "label": label,
            "decision": decision,
            "do_nothing": not decision,
            "on_time": round(statistics.fmean(item["on_time"] for item in per), 1),
            "late": round(statistics.fmean(item["late"] for item in per), 1),
            "dispatched": round(statistics.fmean(item["dispatched"] for item in per), 1),
            "tat_hours": round(statistics.fmean(item["tat"] for item in per), 2),
            "series": [round(statistics.fmean(item["series"][k] for item in per), 2) for k in range(len(per[0]["series"]))],
            "cost_inr": stats["cost_inr"]["mean"],
            "over_slot_pct": stats["over_slot_pct"],
        })
    baseline = next(item for item in rows if item["do_nothing"])
    for item in rows:
        item["delta"] = round(item["on_time"] - baseline["on_time"], 1)
        item["delta_cost"] = item["cost_inr"] - baseline["cost_inr"]
    ranking = sorted(rows, key=lambda item: (-item["on_time"], item["late"], item["cost_inr"]))
    for rank, item in enumerate(ranking, start=1):
        item["rank"] = rank
    return {
        "contract": CONTRACT,
        "fork_at": fork_at,
        "horizon": horizon,
        "step": 15,
        "disruption": {"id": disruption_id, **DISRUPTIONS[disruption_id]},
        "rows": [label for label, _ in FUTURE_ROWS],
        "cols": [{"policy": policy, "call": call} for policy, call, _ in FUTURE_COLS],
        "replications": base["replications"],
        "futures": rows,
        "ranking": [item["id"] for item in ranking],
        "baseline": baseline["id"],
        "best": ranking[0]["id"],
        "scenario": base,
        "method": "Common random numbers: every future sees the same disruption and the same random task times; only the decision differs.",
    }


def levers(raw: dict) -> dict:
    base = normalise(raw)
    reach = base["params"].get("reachTrucks", engine_config()["reachTrucks"])
    options = [
        ("As it is", {}),
        ("Pre-pick evening trucks", {"policy": "prepick"}),
        (f"+2 reach trucks ({reach + 2})", {"reachTrucks": reach + 2}),
        ("Pre-pick and +2 reach trucks", {"policy": "prepick", "reachTrucks": reach + 2}),
    ]
    scenarios = [{**base, "params": dict(sorted({**base["params"], **change}.items()))} for _, change in options]
    results = replicate_many(scenarios)
    rows = [{"lever": name, "change": change, **statistics_for(result, scenario)} for (name, change), scenario, result in zip(options, scenarios, results)]
    return {"contract": CONTRACT, "scenario": base, "levers": rows}


def card(raw: dict | None = None) -> dict:
    scenario = normalise(raw or {})
    return {**model_card(scenario["params"], scenario["rules"]), "contract": CONTRACT, "site_file": site().get("description")}
