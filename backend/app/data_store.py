import json
from functools import lru_cache

from .config import require_data_file


@lru_cache(maxsize=None)
def load_json(name: str) -> dict:
    with require_data_file(name).open("r", encoding="utf-8") as handle:
        return json.load(handle)


def dataset_summary() -> dict:
    site = load_json("01_site_profile.json")
    layout = load_json("02_warehouse_layout.json")
    resources = load_json("04_resource_catalog.json")
    shifts = load_json("05_shift_calendars.json")
    rules = load_json("06_operating_rules.json")
    scenarios = load_json("17_demo_scenarios.json")
    history = load_json("12_historical_shipments.json")
    tasks = load_json("13_historical_warehouse_tasks.json")
    plan = load_json("15_tomorrow_shipment_plan.json")
    production = load_json("19_production_availability.json")

    return {
        "site": site,
        "layout": layout,
        "resources": resources,
        "shifts": shifts,
        "rules": rules,
        "production": production,
        "scenarios": scenarios["scenarios"],
        "counts": {
            "historical_shipments": len(history["shipments"]),
            "historical_tasks": len(tasks["tasks"]),
            "planned_shipments": len(plan["shipments"]),
        },
    }

