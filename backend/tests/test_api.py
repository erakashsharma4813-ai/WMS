from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_health() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_config_loads_demo_data() -> None:
    response = client.get("/api/config")
    assert response.status_code == 200
    payload = response.json()
    assert payload["counts"]["historical_shipments"] == 20
    assert payload["layout"]["site_id"] == "DEMO-PUNE-01"


def test_historical_replay_has_trace_and_findings() -> None:
    response = client.get("/api/replay")
    assert response.status_code == 200
    payload = response.json()
    assert payload["mode"] == "historical_replay"
    assert payload["kpis"]["trucks"] == 20
    assert len(payload["trace"]) > 100
    assert payload["findings"]
    assert len(payload["delay_analysis"]) == 5
    assert payload["delay_analysis"][0]["total_delay_minutes"] >= payload["delay_analysis"][-1]["total_delay_minutes"]


def test_day_catalogue_lists_the_reference_day() -> None:
    days = {day["day_id"]: day for day in client.get("/api/days").json()}
    assert days["DAY-2026-10-06"]["trucks"] == 64
    assert days["DAY-2026-10-08"]["has_recording"] is True


def test_model_card_lists_every_number_and_rule() -> None:
    card = client.get("/api/model-card").json()
    keys = {row["key"]: row for row in card["parameters"]}
    assert keys["congestionA"]["kind"] == "fitted"
    assert keys["docks"]["kind"] == "set"
    assert {rule["id"] for rule in card["rules"]} >= {"fill-congestion", "pick-release-policy", "staging-lane-limit", "production-buffer-full"}
    changed = client.post("/api/model-card", json={"params": {"fillRate": 0.9}}).json()
    assert next(row for row in changed["parameters"] if row["key"] == "fillRate")["changed"] is True


def test_simulate_is_deterministic_for_seed() -> None:
    request = {"replications": 2, "seed": 77, "params": {"fillRate": 0.85}}
    first = client.post("/api/simulate", json=request).json()
    second = client.post("/api/simulate", json=request).json()
    assert first["kpis"] == second["kpis"]
    assert first["trace"] == second["trace"]
    assert first["statistics"]["replications"] == 2


def test_unknown_parameter_is_rejected() -> None:
    response = client.post("/api/simulate", json={"replications": 1, "params": {"notAParameter": 3}})
    assert response.status_code == 422


def test_more_reach_trucks_do_not_increase_turnaround() -> None:
    base = client.post("/api/simulate", json={"replications": 5, "params": {"reachTrucks": 5, "fillRate": 0.9}}).json()
    more = client.post("/api/simulate", json={"replications": 5, "params": {"reachTrucks": 9, "fillRate": 0.9}}).json()
    assert more["statistics"]["turnaround_hours"]["mean"] <= base["statistics"]["turnaround_hours"]["mean"]


def test_compare_uses_paired_seeds() -> None:
    payload = client.post("/api/compare", json={"baseline": {"replications": 10, "params": {"fillRate": 0.95, "reachTrucks": 9}}, "variant": {"replications": 10, "params": {"fillRate": 0.95, "reachTrucks": 9, "policy": "prepick"}}}).json()
    assert payload["variant"]["scenario"]["seed"] == payload["baseline"]["scenario"]["seed"]
    assert payload["difference_hours"]["mean"] < 0
    assert payload["verdict"] == "real"


def test_live_replan_moves_only_future_bookings() -> None:
    request = {"replications": 1, "chance": "det", "live_as_of_minutes": 300, "slot_overrides": [{"shipment_id": "T01", "arrival_offset_minutes": 120}, {"shipment_id": "T40", "arrival_offset_minutes": 60}]}
    moved = {row["shipment_id"]: row for row in client.post("/api/simulate", json=request).json()["shipment_schedule"]}
    base = {row["shipment_id"]: row for row in client.post("/api/simulate", json={"replications": 1, "chance": "det"}).json()["shipment_schedule"]}
    assert moved["T01"]["simulated_arrival_minutes"] == base["T01"]["simulated_arrival_minutes"]
    assert moved["T40"]["simulated_arrival_minutes"] == base["T40"]["simulated_arrival_minutes"] + 60
