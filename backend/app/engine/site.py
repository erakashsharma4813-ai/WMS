"""Site file loading: the model card is the only source of numbers for the engine."""

from __future__ import annotations

import copy
from functools import lru_cache

from ..data_store import load_json
from .rules import RuleSet

SITE_FILE = "20_engine_site.json"
TASKS = ("gate", "pick", "put", "load", "docs")


@lru_cache(maxsize=1)
def site() -> dict:
    return load_json(SITE_FILE)


def parameter_values(overrides: dict | None = None) -> dict:
    values = {key: copy.deepcopy(entry["value"]) for key, entry in site()["parameters"].items()}
    for key, value in (overrides or {}).items():
        if key not in values:
            raise KeyError(f"Unknown model parameter: {key}")
        values[key] = value
    return values


def engine_config(overrides: dict | None = None, *, seed: int = 1, chance: str = "sto", clock: int = 0) -> dict:
    """Flatten the site file plus scenario overrides into the engine's config."""
    data = site()
    values = parameter_values(overrides)
    config = {key: value for key, value in values.items() if key not in TASKS}
    config["mean"] = {task: values[task]["mean"] for task in TASKS}
    config["tri"] = {task: list(values[task]["tri"]) for task in TASKS}
    config.update({
        "start": data["clock"]["start"],
        "end": data["clock"]["end"],
        "arrivals": data["arrivals"],
        "types": data["truck_types"],
        "racks": data["racks"],
        "stress_points": data["stress_points"],
        "slotAmberShare": data["truck_slot"]["amber_share"],
        "seed": seed,
        "chance": chance,
        "clock": clock,
    })
    return config


def model_card(overrides: dict | None = None, rules: dict | None = None) -> dict:
    data = site()
    values = parameter_values(overrides)
    parameters = []
    for key, entry in data["parameters"].items():
        row = {k: v for k, v in entry.items() if k != "value"}
        row.update({"key": key, "value": values[key], "default": entry["value"], "changed": values[key] != entry["value"]})
        parameters.append(row)
    rule_set = RuleSet(engine_config(overrides), rules or {})
    return {
        "site_id": data["site_id"],
        "world_template": data["world_template"],
        "parameters": parameters,
        "rules": rule_set.cards(),
        "stress_points": data["stress_points"],
    }
