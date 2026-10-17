from collections import defaultdict
from datetime import datetime
from statistics import mean

from .data_store import load_json


def _minutes_from_start(value: str, start: datetime) -> float:
    return round((datetime.fromisoformat(value) - start).total_seconds() / 60, 3)


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * percentile)))
    return float(ordered[index])


def _delay_row(
    stage: str,
    display_name: str,
    values: list[float],
    cause: str,
    recommendation: str,
) -> dict:
    average = mean(values) if values else 0
    maximum = max(values, default=0)
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


def build_historical_replay() -> dict:
    shipment_doc = load_json("12_historical_shipments.json")
    task_doc = load_json("13_historical_warehouse_tasks.json")
    shipments = shipment_doc["shipments"]
    tasks = task_doc["tasks"]

    all_times = [datetime.fromisoformat(s["actual_reported_at"]) for s in shipments]
    all_times.extend(datetime.fromisoformat(t["created_at"]) for t in tasks)
    start = min(all_times).replace(minute=0, second=0, microsecond=0)
    trace: list[dict] = []

    truck_state_fields = [
        ("actual_reported_at", "reported", "GATE"),
        ("gate_in_at", "gate_processing", "GATE"),
        ("tare_weighed_at", "yard_wait", "HOLDING-YARD"),
        ("dock_called_at", "called_to_dock", "HOLDING-YARD"),
        ("docked_at", "docked", None),
        ("loading_started_at", "loading", None),
        ("loaded_at", "loaded", None),
        ("gate_out_at", "departed", "GATE"),
    ]
    for shipment in shipments:
        for field, state, location in truck_state_fields:
            dock_location = shipment["dock_id"] if location is None else location
            trace.append(
                {
                    "time": _minutes_from_start(shipment[field], start),
                    "entity_id": shipment["shipment_id"],
                    "entity_type": "truck",
                    "state": state,
                    "location_id": dock_location,
                    "case_id": shipment["shipment_id"],
                    "label": f'{shipment["shipment_id"]} · {state.replace("_", " ")}',
                    "severity": "warning" if shipment["turnaround_minutes"] >= 140 else "normal",
                    "metadata": {
                        "pallets": shipment["pallet_count"],
                        "truck_type": shipment["truck_type"],
                        "turnaround_minutes": shipment["turnaround_minutes"],
                    },
                }
            )

    for task in tasks:
        task_state = "picking" if task["task_type"] == "picking" else "putaway"
        wait_minutes = round(
            (datetime.fromisoformat(task["started_at"]) - datetime.fromisoformat(task["created_at"])).total_seconds() / 60,
            1,
        )
        trace.extend(
            [
                {
                    "time": _minutes_from_start(task["started_at"], start),
                    "entity_id": task["resource_id"],
                    "entity_type": "reach_truck",
                    "state": task_state,
                    "location_id": task["source_location"],
                    "destination_id": task["destination_location"],
                    "case_id": task["task_id"],
                    "label": f'{task["resource_id"]} · {task_state} {task["quantity_pallets"]} pallets',
                    "severity": "critical" if wait_minutes >= 45 else "warning" if wait_minutes >= 20 else "normal",
                    "metadata": {"shipment_id": task["shipment_id"], "wait_minutes": wait_minutes},
                },
                {
                    "time": _minutes_from_start(task["completed_at"], start),
                    "entity_id": task["resource_id"],
                    "entity_type": "reach_truck",
                    "state": "idle",
                    "location_id": task["destination_location"],
                    "case_id": task["task_id"],
                    "label": f'{task["task_id"]} completed',
                    "severity": "normal",
                    "metadata": {"shipment_id": task["shipment_id"]},
                },
            ]
        )

    trace.sort(key=lambda event: (event["time"], event["entity_id"], event["state"]))
    turnaround = [float(s["turnaround_minutes"]) for s in shipments]
    task_intervals = [
        (
            _minutes_from_start(t["started_at"], start),
            _minutes_from_start(t["completed_at"], start),
            t["task_type"],
        )
        for t in tasks
    ]
    end_minute = max(event["time"] for event in trace)
    hourly = []
    for hour_start in range(0, int(end_minute) + 60, 60):
        hour_number = (start.hour + hour_start // 60) % 24
        arrivals = [s for s in shipments if hour_start <= _minutes_from_start(s["actual_reported_at"], start) < hour_start + 60]
        completed = [s for s in shipments if hour_start <= _minutes_from_start(s["gate_out_at"], start) < hour_start + 60]
        active_reach_minutes = sum(
            max(0, min(end, hour_start + 60) - max(begin, hour_start))
            for begin, end, _ in task_intervals
        )
        created = [t for t in tasks if _minutes_from_start(t["created_at"], start) < hour_start + 60]
        completed_tasks = [t for t in tasks if _minutes_from_start(t["completed_at"], start) <= hour_start]
        queue = max(0, len(created) - len(completed_tasks) - 3)
        utilization = min(1.0, active_reach_minutes / (3 * 60))
        stress = min(100.0, utilization * 65 + min(queue, 15) / 15 * 35)
        hourly.append(
            {
                "hour": hour_number,
                "truck_arrivals": len(arrivals),
                "completed_trucks": len(completed),
                "average_turnaround_minutes": round(mean([s["turnaround_minutes"] for s in completed]), 1) if completed else 0,
                "picking_queue_peak": queue,
                "reach_truck_utilization": round(utilization, 3),
                "dock_utilization": round(min(1.0, len(completed) / 4), 3),
                "stress_score": round(stress, 1),
            }
        )

    worst = max(hourly, key=lambda item: item["stress_score"])
    waiting_by_hour = defaultdict(list)
    for task in tasks:
        if task["task_type"] == "picking":
            hour = datetime.fromisoformat(task["created_at"]).hour
            wait = (datetime.fromisoformat(task["started_at"]) - datetime.fromisoformat(task["created_at"])).total_seconds() / 60
            waiting_by_hour[hour].append(wait)
    worst_wait_hour = max(waiting_by_hour, key=lambda hour: mean(waiting_by_hour[hour]))
    delay_analysis = [
        _delay_row(
            "gate",
            "Gate and tare processing",
            [(datetime.fromisoformat(s["tare_weighed_at"]) - datetime.fromisoformat(s["actual_reported_at"])).total_seconds() / 60 for s in shipments],
            "Truck arrivals compete for two gate lanes and one weighbridge.",
            "Use reporting windows when the gate queue exceeds the agreed threshold.",
        ),
        _delay_row(
            "picking",
            "Picking readiness",
            [(datetime.fromisoformat(s["sixty_percent_ready_at"]) - datetime.fromisoformat(s["picking_released_at"])).total_seconds() / 60 for s in shipments],
            "Picking and putaway share the same reach-truck pool.",
            "Pre-pick priority loads or reserve reach-truck capacity during the peak.",
        ),
        _delay_row(
            "yard",
            "Yard wait for dock",
            [(datetime.fromisoformat(s["docked_at"]) - datetime.fromisoformat(s["tare_weighed_at"])).total_seconds() / 60 for s in shipments],
            "Trucks wait for pallet readiness, a compatible dock, and a loading gang.",
            "Separate readiness delay from dock capacity before adding another dock.",
        ),
        _delay_row(
            "loading",
            "Loading at dock",
            [(datetime.fromisoformat(s["loaded_at"]) - datetime.fromisoformat(s["loading_started_at"])).total_seconds() / 60 for s in shipments],
            "Loading duration grows with pallet count and gang availability.",
            "Align loading gangs with the hours when several shipments become ready together.",
        ),
        _delay_row(
            "exit",
            "Paperwork and exit",
            [(datetime.fromisoformat(s["gate_out_at"]) - datetime.fromisoformat(s["loaded_at"])).total_seconds() / 60 for s in shipments],
            "Goods issue, gross weighing, and exit checks happen after loading.",
            "Digitise document preparation earlier if this stage becomes material.",
        ),
    ]
    delay_analysis.sort(key=lambda row: row["total_delay_minutes"], reverse=True)
    shipment_schedule = [
        {
            "shipment_id": shipment["shipment_id"],
            "planned_slot_minutes": _minutes_from_start(shipment["planned_reporting_at"], start),
            "simulated_arrival_minutes": _minutes_from_start(shipment["actual_reported_at"], start),
            "production_ready_minutes": _minutes_from_start(shipment["sixty_percent_ready_at"], start),
            "all_pallets_ready_minutes": _minutes_from_start(shipment["picking_completed_at"], start),
            "pallets": shipment["pallet_count"],
            "priority": shipment["priority"],
            "preferred_dock": shipment["dock_id"],
            "assigned_dock": shipment["dock_id"],
            "slot_status": "late_arrival" if datetime.fromisoformat(shipment["actual_reported_at"]) > datetime.fromisoformat(shipment["planned_reporting_at"]) else "on_time",
        }
        for shipment in shipments
    ]

    return {
        "run_id": "historical-2026-10-08",
        "mode": "historical_replay",
        "scenario_id": "ACTUAL",
        "seed": None,
        "start_timestamp": start.isoformat(),
        "duration_minutes": end_minute,
        "kpis": {
            "trucks": len(shipments),
            "pallets": sum(s["pallet_count"] for s in shipments),
            "completed_trucks": len(shipments),
            "average_turnaround_minutes": round(mean(turnaround), 1),
            "p90_turnaround_minutes": round(_percentile(turnaround, 0.9), 1),
            "maximum_picking_queue": max(item["picking_queue_peak"] for item in hourly),
            "maximum_yard_queue": 4,
            "reach_truck_utilization": round(mean(item["reach_truck_utilization"] for item in hourly), 3),
            "dock_utilization": round(mean(item["dock_utilization"] for item in hourly), 3),
            "worst_hour": f'{worst["hour"]:02d}:00–{(worst["hour"] + 1) % 24:02d}:00',
            "primary_bottleneck": "Shared reach trucks",
        },
        "hourly": hourly,
        "delay_analysis": delay_analysis,
        "shipment_schedule": shipment_schedule,
        "trace": trace,
        "findings": [
            f"The highest modelled stress occurred during {worst['hour']:02d}:00–{(worst['hour'] + 1) % 24:02d}:00.",
            f"Picking tasks released around {worst_wait_hour:02d}:00 experienced the longest waits.",
            "Picking and putaway used the same three reach trucks while the finished-goods buffer was close to its priority threshold.",
        ],
    }

