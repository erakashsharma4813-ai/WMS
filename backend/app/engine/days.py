"""Day catalogue: the past days a user can pick as a baseline.

Each day is reduced to the engine's input: trucks with a report minute,
pallets and type. The day is played trace-driven; the user then changes only
what is different tomorrow.
"""

from __future__ import annotations

from datetime import datetime
from functools import lru_cache

from ..data_store import load_json

TYPE_NAMES = {"20FT": "20 ft", "32FT": "32 ft", "40FT": "40 ft", "17FT": "17 ft"}


def _minute(stamp: str) -> int:
    parsed = datetime.fromisoformat(stamp)
    return parsed.hour * 60 + parsed.minute


@lru_cache(maxsize=1)
def catalogue() -> dict[str, dict]:
    days: dict[str, dict] = {}

    sap = load_json("21_sap_day_2026-10-06.json")
    days[sap["day_id"]] = {
        "day_id": sap["day_id"],
        "date": sap["business_date"],
        "label": "Tue 06 Oct · same weekday last week",
        "source": sap["source"],
        "has_recording": False,
        "trucks": [
            {"report": _minute(row["reported_at"]), "pallets": row["pallets"], "type": row["truck_type"], "code": row["truck_code"], "shipment_id": row["shipment"], "transporter": row["transporter"]}
            for row in sap["shipments"]
        ],
    }

    history = load_json("12_historical_shipments.json")
    days["DAY-2026-10-08"] = {
        "day_id": "DAY-2026-10-08",
        "date": "2026-10-08",
        "label": "Thu 08 Oct · recorded day with task log",
        "source": "Historical shipments and warehouse tasks (12, 13)",
        "has_recording": True,
        "trucks": sorted(
            [
                {"report": _minute(row["actual_reported_at"]), "pallets": row["pallet_count"], "type": TYPE_NAMES.get(row["truck_type"], row["truck_type"]), "code": row["shipment_id"], "shipment_id": row["shipment_id"], "transporter": row.get("transporter_id", "")}
                for row in history["shipments"]
            ],
            key=lambda truck: truck["report"],
        ),
    }

    plan = load_json("15_tomorrow_shipment_plan.json")
    days["DAY-2026-10-13"] = {
        "day_id": "DAY-2026-10-13",
        "date": "2026-10-13",
        "label": "Tue 13 Oct · tomorrow's plan",
        "source": "Planned shipments (15)",
        "has_recording": False,
        "trucks": sorted(
            [
                {"report": _minute(row["planned_reporting_at"]), "pallets": row["pallet_count"], "type": TYPE_NAMES.get(row["truck_type"], row["truck_type"]), "code": row["shipment_id"], "shipment_id": row["shipment_id"], "transporter": row.get("transporter_id", "")}
                for row in plan["shipments"]
            ],
            key=lambda truck: truck["report"],
        ),
    }
    return days


DEFAULT_DAY = "DAY-2026-10-06"


def get_day(day_id: str) -> dict:
    days = catalogue()
    if day_id not in days:
        raise KeyError(f"Unknown day: {day_id}")
    return days[day_id]


def summaries() -> list[dict]:
    out = []
    for day in catalogue().values():
        trucks = day["trucks"]
        by_hour: dict[int, int] = {}
        for truck in trucks:
            by_hour[truck["report"] // 60] = by_hour.get(truck["report"] // 60, 0) + 1
        peak = max(by_hour, key=by_hour.get) if by_hour else None
        out.append({
            "day_id": day["day_id"],
            "date": day["date"],
            "label": day["label"],
            "source": day["source"],
            "has_recording": day["has_recording"],
            "trucks": len(trucks),
            "pallets": sum(truck["pallets"] for truck in trucks),
            "peak_hour": f"{peak:02d}:00–{peak + 1:02d}:00" if peak is not None else None,
            "arrivals_by_hour": by_hour,
        })
    return out
