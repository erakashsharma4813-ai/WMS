import os

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from .data_store import dataset_summary
from .engine import runner
from .engine.days import summaries as day_summaries
from .models import CompareRequest, FuturesRequest, Scenario, SimulationResponse, SweepRequest, VisitorEntry
from .replay import build_historical_replay
from .visitors import append_visit

app = FastAPI(
    title="Dispatch Twin API",
    description="Recorded replay, event-driven simulation with replications, compare, fill sweep and the model card.",
    version="0.2.0",
)

# Extra origins (for example a tunnel URL) come from the environment, not code.
EXTRA_ORIGINS = [origin.strip() for origin in os.environ.get("DISPATCH_TWIN_ORIGINS", "").split(",") if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", *EXTRA_ORIGINS],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _scenario(model: Scenario) -> dict:
    return model.model_dump()


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "dispatch-twin-backend", "contract": runner.CONTRACT}


@app.post("/api/visitors")
def register_visitor(entry: VisitorEntry, request: Request) -> dict:
    """Append one row per visit to the visitor workbook (backend/data/visitors.xlsx)."""
    forwarded = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    ip = forwarded or (request.client.host if request.client else None)
    return append_visit(entry.model_dump(), ip, request.headers.get("user-agent"))


@app.get("/api/config")
def config() -> dict:
    return dataset_summary()


@app.get("/api/days")
def days() -> list[dict]:
    return day_summaries()


@app.get("/api/model-card")
def model_card() -> dict:
    return runner.card()


@app.post("/api/model-card")
def model_card_for(scenario: Scenario) -> dict:
    try:
        return runner.card(_scenario(scenario))
    except KeyError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.get("/api/replay", response_model=SimulationResponse)
def replay() -> dict:
    return build_historical_replay()


@app.post("/api/simulate", response_model=SimulationResponse)
def simulate(scenario: Scenario) -> dict:
    try:
        return runner.simulate(_scenario(scenario))
    except KeyError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.post("/api/compare")
def compare(request: CompareRequest) -> dict:
    return runner.compare(_scenario(request.baseline), _scenario(request.variant))


@app.post("/api/sweep")
def sweep(request: SweepRequest) -> dict:
    return runner.sweep(_scenario(request.scenario), request.fills, list(request.policies))


@app.post("/api/levers")
def levers(scenario: Scenario) -> dict:
    return runner.levers(_scenario(scenario))


@app.get("/api/disruptions")
def disruptions() -> dict:
    return runner.DISRUPTIONS


@app.post("/api/futures")
def futures(request: FuturesRequest) -> dict:
    """Fork the day at a disruption and run every decision in parallel with the same seeds."""
    return runner.futures(_scenario(request.scenario), request.fork_at, request.disruption, request.horizon)
