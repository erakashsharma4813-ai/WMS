"""Write the dummy SAP export of the reference day (64 trucks, seed 1410).

The truck arrivals, types and pallet counts are the engine's trace day, so the
golden numbers in the design docs (64 trucks, 1.95 h average turnaround) come
from this file. Shipment, delivery and vehicle numbers are generated from a
separate seed and are made up. Transporter names are placeholders, never
real companies.

    python scripts/build_sap_day.py
"""

import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.engine.des import trace_day  # noqa: E402
from app.engine.rng import mulberry  # noqa: E402
from app.engine.site import engine_config  # noqa: E402

DATE = "2026-10-06"
OUT = Path(__file__).resolve().parents[2] / "demo-data" / "automotive-dispatch-demo" / "21_sap_day_2026-10-06.json"
TRANSPORTERS = ["Transporter A", "Transporter B", "Transporter C", "Transporter D", "Transporter E", "Transporter F"]
REGIONS = ["MH 12", "MH 14", "MH 42", "KA 51", "GJ 05", "TS 07"]


def clock(minutes: int) -> str:
    return f"{DATE}T{minutes // 60:02d}:{minutes % 60:02d}:00+05:30"


def main() -> None:
    config = engine_config()
    day = trace_day(config)
    draw = mulberry(2026)
    shipments = []
    for index, truck in enumerate(day):
        deliveries = [str(80041200 + index * 7 + d * 3) for d in range(1 + math.floor(draw() * 3))]
        letters = chr(65 + math.floor(draw() * 26)) + chr(65 + math.floor(draw() * 26))
        shipments.append({
            "shipment": f"000{1004200 + index * 3}",
            "truck_code": f"T{index + 1:02d}",
            "vehicle": f"{REGIONS[math.floor(draw() * len(REGIONS))]} {letters} {1000 + math.floor(draw() * 9000)}",
            "transporter": TRANSPORTERS[math.floor(draw() * len(TRANSPORTERS))],
            "truck_type": truck["type"],
            "pallets": truck["pallets"],
            "reported_at": clock(truck["report"]),
            "deliveries": deliveries,
        })
    payload = {
        "schema_version": "1.0",
        "site_id": "DEMO-PUNE-01",
        "day_id": f"DAY-{DATE}",
        "business_date": DATE,
        "source": "Dummy SAP export shaped like VTTK/VTTP shipments and LIKP deliveries; gate report times from the gate log",
        "classification": "synthetic_demo_data",
        "shipments": shipments,
    }
    OUT.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"wrote {OUT} with {len(shipments)} shipments")


if __name__ == "__main__":
    main()
