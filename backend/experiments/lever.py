"""Levers at 85%, 88% and 95% fill: pre-pick and extra reach trucks.

Ports experiments/lever.js from the starter kit. The message it proves:
act at 88%, not at 95%.

    python experiments/lever.py
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.engine.runner import levers  # noqa: E402


def main() -> None:
    for fill in (0.5, 0.85, 0.88, 0.95):
        result = levers({"arrivals": "random", "chance": "sto", "seed": 5000, "replications": 30, "params": {"reachTrucks": 9, "fillRate": fill}})
        for row in result["levers"]:
            hours = row["turnaround_hours"]
            print(json.dumps({
                "fill": fill,
                "lever": row["lever"],
                "avg": f"{hours['mean']:.2f}±{hours['ci95']:.2f}",
                "over_slot": f"{row['over_slot_pct']:.0f}%",
                "yard_full_days": f"{row['yard_full_days']}/{row['replications']}",
                "first_full_hour": row["first_yard_full_hour"],
                "cost_inr": row["cost_inr"]["mean"],
            }, ensure_ascii=False))


if __name__ == "__main__":
    main()
