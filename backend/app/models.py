from typing import Literal

from pydantic import BaseModel, Field


class SlotOverride(BaseModel):
    shipment_id: str
    arrival_offset_minutes: int = Field(default=0, ge=-240, le=480)
    preferred_dock: str | None = None


class Scenario(BaseModel):
    """Scenario JSON in. Anything not given comes from the site file (the model card)."""

    day_id: str | None = None
    arrivals: Literal["trace", "random"] = "trace"
    chance: Literal["det", "sto"] = "sto"
    clock: Literal[0, 1, 5] = 0
    seed: int = Field(default=5000, ge=0, le=2_000_000_000)
    replications: int = Field(default=30, ge=1, le=200)
    params: dict[str, float | int | str] = Field(default_factory=dict)
    rules: dict[str, bool] = Field(default_factory=dict)
    demand_multiplier: float = Field(default=1.0, ge=0.5, le=2.0)
    slot_overrides: list[SlotOverride] = Field(default_factory=list)
    live_as_of_minutes: int | None = Field(default=None, ge=0, le=1440)
    disruptions: list[dict] = Field(default_factory=list)
    decisions: list[dict] = Field(default_factory=list)


class FuturesRequest(BaseModel):
    scenario: Scenario
    fork_at: float = Field(ge=0, le=1440)
    disruption: Literal["reach_truck_down", "rush_order", "dock_down", "gate_clerk_out"]
    horizon: float = Field(default=480, ge=60, le=720)


class CompareRequest(BaseModel):
    baseline: Scenario
    variant: Scenario


class SweepRequest(BaseModel):
    scenario: Scenario
    fills: list[float] = Field(default_factory=lambda: [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.88, 0.9, 0.95])
    policies: list[Literal["gate", "prepick"]] = Field(default_factory=lambda: ["gate", "prepick"])


class TraceEvent(BaseModel):
    time: float
    entity_id: str
    entity_type: Literal["truck", "reach_truck", "forklift", "pallet", "system"]
    state: str
    location_id: str | None = None
    destination_id: str | None = None
    case_id: str | None = None
    label: str | None = None
    severity: Literal["normal", "warning", "critical"] = "normal"
    metadata: dict = Field(default_factory=dict)


class HourlyMetric(BaseModel):
    hour: int
    truck_arrivals: int
    completed_trucks: int
    average_turnaround_minutes: float
    picking_queue_peak: int
    reach_truck_utilization: float
    dock_utilization: float
    stress_score: float


class SimulationKpis(BaseModel):
    trucks: int
    pallets: int
    completed_trucks: int
    average_turnaround_minutes: float
    p90_turnaround_minutes: float
    maximum_picking_queue: int
    maximum_yard_queue: int
    reach_truck_utilization: float
    dock_utilization: float
    worst_hour: str
    primary_bottleneck: str


class DelayAnalysisRow(BaseModel):
    stage: str
    display_name: str
    average_wait_minutes: float
    p90_wait_minutes: float
    maximum_wait_minutes: float
    affected_entities: int
    total_delay_minutes: float
    severity: Literal["normal", "warning", "critical"]
    cause: str
    recommendation: str


class SimulationResponse(BaseModel):
    """Event log out, plus the summary the screens show."""

    contract: str | None = None
    run_id: str
    mode: Literal["historical_replay", "dynamic_simulation"]
    scenario_id: str
    seed: int | None
    start_timestamp: str
    duration_minutes: float
    kpis: SimulationKpis
    hourly: list[HourlyMetric]
    delay_analysis: list[DelayAnalysisRow]
    shipment_schedule: list[dict] = Field(default_factory=list)
    trace: list[TraceEvent]
    findings: list[str]
    statistics: dict | None = None
    stress_points: list[dict] = Field(default_factory=list)
    stress_hourly: list[dict] = Field(default_factory=list)
    scenario: dict | None = None
    day_id: str | None = None
    representative_replication: int | None = None


class VisitorEntry(BaseModel):
    """Who opened the app. Logged to the visitor workbook on the server."""

    name: str = Field(min_length=2, max_length=120)
    email: str = Field(min_length=5, max_length=200, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    organisation: str | None = Field(default=None, max_length=160)
    role: str | None = Field(default=None, max_length=120)
    purpose: str | None = Field(default=None, max_length=500)
    visit: Literal["first", "return"] = "first"
