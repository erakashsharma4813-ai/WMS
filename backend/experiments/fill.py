"""Turnaround against warehouse fill: the knee behind the flagship demo.

Ports experiments/fill.js from the starter kit. Random days with the site's
hourly arrival profile, 30 replications per fill level, common random numbers.

    python experiments/fill.py            # 9 reach trucks (the demo setting)
    python experiments/fill.py 7          # site default
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.engine.runner import sweep  # noqa: E402

FILLS = [0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]


def main() -> None:
    reach = int(sys.argv[1]) if len(sys.argv) > 1 else 9
    result = sweep({"arrivals": "random", "chance": "sto", "seed": 5000, "replications": 30, "params": {"reachTrucks": reach}}, FILLS, ["gate"])
    for point in result["curves"][0]["points"]:
        print(json.dumps({
            "fill": point["fill"],
            "k": point["congestion_factor"],
            "avg_h": point["turnaround_hours"]["mean"],
            "ci95_h": point["turnaround_hours"]["ci95"],
            "evening_h": point["evening_turnaround_hours"],
            "over_slot_pct": point["over_slot_pct"],
            "yard_full_days": point["yard_full_days"],
            "line_held": point["line_held_pallets"],
        }))


if __name__ == "__main__":
    main()
