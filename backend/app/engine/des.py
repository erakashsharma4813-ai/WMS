"""Discrete-event engine for the outbound warehouse world.

A faithful port of the starter-kit engine (simulation-lab/des.js): the same
future event list ordering (time, then sequence), the same seven random
streams and the same decisions, so the same seed gives the same day. The
golden tests in tests/test_engine_golden.py pin this.

Two additions sit on top without changing results:
  * Every policy decision goes through a named rule hook (rules.py), so a
    constraint can be switched off or replaced without touching this loop.
  * With record=True the engine writes an event log (the contract the 3D
    viewer reads): every state change with the entity, the resource that did
    the work, the location, and a reason.
"""

from __future__ import annotations

import heapq
import math
from dataclasses import dataclass, field

from .rng import exponential, mulberry, streams, triangular
from .rules import RuleSet

STATE_GONE = "gone"


@dataclass
class Truck:
    id: int
    code: str
    report: float
    pallets: int
    type: str
    shipment_id: str = ""
    transporter: str = ""
    staged: int = 0
    pre: int = 0
    loaded: int = 0
    in_pick: int = 0
    in_load: int = 0
    lane: int = -1
    dock: int = -1
    released: bool = False
    state: str = "due"
    t: dict = field(default_factory=dict)
    tat: float | None = None
    picks_started: int = 0
    loading_started: bool = False
    blocked_by: str | None = None

    def backlog(self) -> int:
        return self.pallets - self.staged - self.pre - self.in_pick - self.loaded


class Engine:
    """One simulated day. Build with a resolved config, call run(), read summary()."""

    def __init__(self, config: dict, day: list[dict], rules: RuleSet, *, record: bool = False):
        self.C = config
        self.rules = rules
        self.record = record
        self.R = streams(config.get("seed") or 1)
        self.det = config["chance"] == "det"
        self.t = config["start"]
        self.fel: list = []
        self.seq = 0
        self.events = 0
        self.trucks = [
            Truck(id=index, code=item.get("code") or f"T{index + 1:02d}", report=item["report"], pallets=item["pallets"], type=item["type"], shipment_id=item.get("shipment_id", ""), transporter=item.get("transporter", ""))
            for index, item in enumerate(day)
        ]
        self.gate_busy = 0
        self.gate_q: list[Truck] = []
        self.yard: list[Truck] = []
        lanes = rules.value("lane.count", max(1, len(self.trucks)), lanes=config["lanes"])
        self.lanes = [-1] * lanes
        self.docks = [-1] * config["docks"]
        self.rt_free = config["reachTrucks"]
        self.flt_free = config["forklifts"]
        # units in service (idle + busy); disruptions and decisions change these during the day
        self.rt_units = config["reachTrucks"]
        self.flt_units = config["forklifts"]
        self.gate_lanes = config["gateLanes"]
        self.rt_pending_down: set[int] = set()
        self.flt_pending_down: set[int] = set()
        self.dock_pending_down: set[int] = set()
        self.rt_next_id = config["reachTrucks"] + 1
        self.flt_next_id = config["forklifts"] + 1
        self.prepick_horizon = 0
        self.rt_all = set(range(1, config["reachTrucks"] + 1))
        self.flt_all = set(range(1, config["forklifts"] + 1))
        self.clerk_free = config["clerks"]
        self.office_q: list[Truck] = []
        self.inbound = 0
        self.prestage = 0
        self.line_held = 0
        self.hourly: dict[int, dict] = {}
        self.last_t = config["start"]
        self.done = False
        self.dec = 0
        # resource identity (instrumentation only; never changes decisions)
        self.rt_ids = list(range(1, config["reachTrucks"] + 1))
        self.flt_ids = list(range(1, config["forklifts"] + 1))
        heapq.heapify(self.rt_ids)
        heapq.heapify(self.flt_ids)
        self.put_counter = 0
        self.log: list[dict] = []
        self.meter_levels: dict[str, str] = {}
        # utilisation meters read a 20-minute exponential average, so one busy
        # moment does not turn a zone red; queue meters read the live count
        self._ema: dict[str, float] = {}
        self._ema_metrics: dict | None = None
        self._ema_t = config["start"]

        step = config.get("clock") or 0
        self._step = step
        for truck in self.trucks:
            self._sched("ARRIVE", truck.report, truck.id)
        first_prod = 60 / config["prodPerHour"] if self.det else exponential(self.R["prod"](), 60 / config["prodPerHour"])
        self._sched("PROD", config["start"] + first_prod, None)
        release_at = rules.value("day.prepick_release_at", None)
        if release_at is not None:
            self._sched("RELEASE", release_at, None)
        # disruptions and decisions are given in minutes after the day starts
        for disruption in config.get("disruptions") or []:
            if disruption.get("kind") == "truck_surge":
                continue  # extra trucks are added to the day by the runner
            data = {**disruption, "ids": []}
            self._sched("DISRUPT", config["start"] + disruption["at"], data)
            self._sched("RESTORE", config["start"] + disruption["at"] + disruption.get("duration", 120), data)
        for decision in config.get("decisions") or []:
            self._sched("DECIDE", config["start"] + decision["at"], decision)

    # --- event list -------------------------------------------------------
    def _at(self, t: float) -> float:
        if not self._step:
            return t
        start = self.C["start"]
        return math.ceil((t - start) / self._step - 1e-9) * self._step + start

    def _sched(self, kind: str, t: float, data) -> None:
        heapq.heappush(self.fel, (self._at(t), self.seq, kind, data))
        self.seq += 1

    def _sample(self, kind: str) -> float:
        mean, tri = self.rules.value("task.params", (self.C["mean"][kind], self.C["tri"][kind]), kind=kind)
        return mean if self.det else triangular(self.R[kind](), tri)

    # --- statistics -------------------------------------------------------
    def _metrics(self) -> dict:
        backlog = 0
        for truck in self.trucks:
            if truck.released and truck.state not in ("due", STATE_GONE):
                backlog += truck.backlog()
        lanes_used = sum(1 for lane in self.lanes if lane >= 0)
        return {
            "backlog": max(0, backlog),
            "yard": len(self.yard),
            "rt": (self.rt_units - self.rt_free) / max(1, self.rt_units),
            "inbound": self.inbound,
            "gateQ": len(self.gate_q),
            "lanes": lanes_used / max(1, len(self.lanes)),
            "flt": (self.flt_units - self.flt_free) / max(1, self.flt_units),
            "docsQ": len(self.office_q),
        }

    def _accrue(self, t_new: float) -> None:
        t0 = self.last_t
        metrics = self._metrics()
        while t0 < t_new:
            hour = math.floor(t0 / 60)
            t_end = min(t_new, (hour + 1) * 60)
            dt = t_end - t0
            bucket = self.hourly.setdefault(hour, {key: 0.0 for key in (*metrics.keys(), "w")})
            for key, value in metrics.items():
                bucket[key] += value * dt
            bucket["w"] += dt
            t0 = t_end
        self.last_t = t_new

    # --- event log --------------------------------------------------------
    def _emit(self, entity_id: str, entity_type: str, state: str, location: str | None, *, destination: str | None = None, case_id: str | None = None, severity: str = "normal", reason: str | None = None, rule: str | None = None, **metadata) -> None:
        if not self.record:
            return
        if reason:
            metadata["reason"] = reason
        if rule:
            metadata["rule"] = rule
        self.log.append({
            "time": round(self.t - self.C["start"], 4),
            "entity_id": entity_id,
            "entity_type": entity_type,
            "state": state,
            "location_id": location,
            "destination_id": destination,
            "case_id": case_id,
            "label": f"{entity_id} · {state.replace('_', ' ')}",
            "severity": severity,
            "metadata": metadata,
        })

    def _truck_meta(self, truck: Truck) -> dict:
        return {"pallets": truck.pallets, "truck_type": truck.type, "shipment_id": truck.shipment_id, "transporter": truck.transporter}

    def _rack_for(self, truck: Truck) -> str:
        racks = self.C["racks"]
        return racks[(truck.id * 7 + truck.picks_started * 3) % len(racks)]

    SMOOTHED = ("rt", "flt")
    TAU = 20.0

    def _meters(self) -> None:
        if not self.record:
            return
        metrics = self._metrics()
        previous = self._ema_metrics or metrics
        weight = 1 - math.exp(-(self.t - self._ema_t) / self.TAU)
        for key in self.SMOOTHED:
            current = self._ema.get(key, 0.0)
            self._ema[key] = current + (previous[key] - current) * weight
        self._ema_metrics = metrics
        self._ema_t = self.t
        metrics = {**metrics, **{key: self._ema[key] for key in self.SMOOTHED}}
        metrics["fg"] = self.inbound / max(1, self.C["inboundCap"])
        metrics["line"] = 1.0 if self.inbound >= self.C["inboundCap"] else 0.0
        for point in self.C["stress_points"]:
            value = metrics[point["metric"]]
            level = "red" if value >= point["red"] else "amber" if value >= point["amber"] else "normal"
            if point.get("also_red_metric"):
                if metrics[point["also_red_metric"]] >= point["also_red_at"]:
                    level = "red"
                elif level == "normal" and metrics[point["also_red_metric"]] >= point.get("also_amber_at", math.inf):
                    level = "amber"
            if self.meter_levels.get(point["id"], "normal") != level:
                self.meter_levels[point["id"]] = level
                self._emit(f"meter:{point['id']}", "system", level, point["location"], severity={"red": "critical", "amber": "warning"}.get(level, "normal"), value=round(value, 3), label=point["label"], number=point["number"])

    # --- decisions --------------------------------------------------------
    def _release(self, truck: Truck, reason: str) -> None:
        if not truck.released:
            truck.released = True
            # an order event, not a truck movement: a pre-picked truck is not on site yet
            self._emit(f"ORDER-{truck.code}", "system", "picking_released", "GATE" if truck.state != "due" else "PRESTAGE", case_id=truck.code, reason=reason, **self._truck_meta(truck))

    def _try_gate(self) -> None:
        while self.gate_busy < self.gate_lanes and self.gate_q:
            truck = self.gate_q.pop(0)
            self.gate_busy += 1
            truck.state = "gate"
            self._emit(truck.code, "truck", "gate_processing", "GATE", case_id=truck.code, **self._truck_meta(truck))
            self._sched("GATE_DONE", self.t + self._sample("gate"), truck.id)

    def _try_lanes(self) -> None:
        for truck in self.trucks:
            if truck.released and truck.lane < 0 and truck.state in ("gate", "gateQ", "yard"):
                try:
                    lane = self.lanes.index(-1)
                except ValueError:
                    break
                self.lanes[lane] = truck.id
                truck.lane = lane

    def _try_rt(self) -> None:
        while self.rt_free > 0:
            prestage_ok = self.rules.value("prestage.allowed", True, prestage=self.prestage, cap=self.C["prestageCap"])
            picks = [tr for tr in self.trucks if tr.released and tr.backlog() > 0 and (tr.lane >= 0 or (tr.state == "due" and prestage_ok))]
            picks.sort(key=lambda tr: (tr.state == "due", tr.report))
            self.dec += 1
            want_put = self.rules.value("rt.want_putaway", self.inbound > 0 and not picks, inbound=self.inbound, has_picks=bool(picks), decision=self.dec)
            if want_put and self.inbound > 0:
                self.inbound -= 1
                self.rt_free -= 1
                rt = heapq.heappop(self.rt_ids)
                self.put_counter += 1
                rack = self.C["racks"][self.put_counter % len(self.C["racks"])]
                self._emit(f"RT-{rt:02d}", "reach_truck", "putaway", "FG-BUFFER", destination=rack, case_id=f"PUT-{self.put_counter:04d}", buffer_occupancy=round(self.inbound / max(1, self.C["inboundCap"]), 3))
                self._sched("PUT_DONE", self.t + self._sample("put"), {"rt": rt, "rack": rack, "case": f"PUT-{self.put_counter:04d}"})
                continue
            if not picks:
                break
            truck = picks[0]
            pre = truck.lane < 0
            truck.in_pick += 1
            if pre:
                self.prestage += 1
            self.rt_free -= 1
            rt = heapq.heappop(self.rt_ids)
            source = self._rack_for(truck)
            truck.picks_started += 1
            destination = "PRESTAGE" if pre else f"ML-{truck.lane + 1:02d}"
            self._emit(f"RT-{rt:02d}", "reach_truck", "picking", source, destination=destination, case_id=truck.code, shipment_id=truck.code, pallets=1, pre_pick=pre)
            self._sched("PICK_DONE", self.t + self._sample("pick"), {"id": truck.id, "pre": pre, "rt": rt, "dest": destination})

    def _try_dock(self) -> None:
        for truck in list(self.yard):
            share = (truck.staged + truck.pre) / truck.pallets
            ready = self.rules.value("dock.ready", True, share=share, call_share=self.C["callShare"])
            try:
                dock = self.docks.index(-1)
            except ValueError:
                dock = -1
            if ready and dock >= 0:
                self.docks[dock] = truck.id
                truck.dock = dock
                self.yard.remove(truck)
                truck.state = "toDock"
                dock_id = f"D{dock + 1:02d}"
                self._emit(truck.code, "truck", "called_to_dock", "HOLDING-YARD", destination=dock_id, case_id=truck.code, **self._truck_meta(truck))
                self._sched("DOCKED", self.t + self.C["dockDrive"], truck.id)
            else:
                blocked = "pallets" if not ready else "dock"
                if blocked != truck.blocked_by:
                    truck.blocked_by = blocked
                    reason = f"waiting for {round(self.C['callShare'] * 100)}% of pallets staged ({round(share * 100)}% now)" if blocked == "pallets" else "all docks occupied"
                    self._emit(truck.code, "truck", "yard_wait", "HOLDING-YARD", case_id=truck.code, reason=reason, rule="dock-call-readiness" if blocked == "pallets" else "dock-free", yard_queue=len(self.yard), **self._truck_meta(truck))

    def _try_flt(self) -> None:
        while self.flt_free > 0:
            loading = [x for x in self.trucks if x.state == "loading" and x.staged + x.pre > 0 and x.loaded + x.in_load < x.pallets]
            # how many forklifts may work one door at once; unconstrained: no limit
            per_door = self.rules.value("dock.loaders", None, forklifts=self.flt_units)
            candidates = [x for x in loading if per_door is None or x.in_load < per_door]
            if not candidates:
                break
            candidates.sort(key=lambda x: (x.in_load, x.t["docked"]))
            truck = candidates[0]
            from_pre = truck.pre > 0
            if from_pre:
                truck.pre -= 1
                self.prestage -= 1
            else:
                truck.staged -= 1
            truck.in_load += 1
            self.flt_free -= 1
            flt = heapq.heappop(self.flt_ids)
            dock_id = f"D{truck.dock + 1:02d}"
            source = "PRESTAGE" if from_pre else f"ML-{truck.lane + 1:02d}"
            if not truck.loading_started:
                truck.loading_started = True
                self._emit(truck.code, "truck", "loading", dock_id, case_id=truck.code, **self._truck_meta(truck))
            self._emit(f"FL-{flt:02d}", "forklift", "loading_pallet", source, destination=dock_id, case_id=truck.code, shipment_id=truck.code, pallets=1, prestage=self.prestage)
            self._sched("LOAD_DONE", self.t + self._sample("load"), {"id": truck.id, "flt": flt, "dock": dock_id})

    def _try_office(self) -> None:
        while self.clerk_free > 0 and self.office_q:
            truck = self.office_q.pop(0)
            self.clerk_free -= 1
            self._emit(truck.code, "truck", "paperwork", "GATE", case_id=truck.code, **self._truck_meta(truck))
            self._sched("DOCS_DONE", self.t + self._sample("docs"), truck.id)

    # --- event handlers ----------------------------------------------------
    def _handle(self, kind: str, data) -> None:
        if isinstance(data, int):
            truck = self.trucks[data]
        elif isinstance(data, dict) and data.get("id") is not None:
            truck = self.trucks[data["id"]]
        else:
            truck = None
        C = self.C
        if kind == "ARRIVE":
            truck.state = "gateQ"
            truck.t["report"] = self.t
            self._emit(truck.code, "truck", "reported", "GATE", case_id=truck.code, planned_slot=round(truck.report - C["start"], 2), **self._truck_meta(truck))
            if self.rules.value("truck.release_on_arrival", True, report=truck.report):
                self._release(truck, "picking released when the truck reports")
            self.gate_q.append(truck)
            self._try_gate()
            self._try_lanes()
            self._try_rt()
        elif kind == "GATE_DONE":
            self.gate_busy -= 1
            truck.state = "yard"
            self.yard.append(truck)
            self._emit(truck.code, "truck", "yard_wait", "HOLDING-YARD", case_id=truck.code, yard_queue=len(self.yard), **self._truck_meta(truck))
            self._try_gate()
            self._try_lanes()
            self._try_rt()
            self._try_dock()
        elif kind == "PROD":
            if self.rules.value("production.accept", True, inbound=self.inbound, cap=C["inboundCap"]):
                self.inbound += 1
                self._emit("PROD", "pallet", "production_released", "PRODUCTION-OUT", destination="FG-BUFFER", case_id=f"P{self.seq}", pallets=1, buffer_occupancy=round(self.inbound / max(1, C["inboundCap"]), 3))
            else:
                self.line_held += 1
                self._emit("LINE-1", "system", "line_held", "PRODUCTION-OUT", severity="critical", reason="finished-goods buffer full", rule="production-buffer-full", buffer_occupancy=1.0)
            if self.t < C["end"] - 60:
                gap = 60 / C["prodPerHour"] if self.det else exponential(self.R["prod"](), 60 / C["prodPerHour"])
                self._sched("PROD", self.t + gap, None)
            self._try_rt()
        elif kind == "RELEASE":
            for other in self.trucks:
                if self.rules.value("prepick.include", False, report=other.report):
                    self._release(other, "pre-pick release")
            self._try_rt()
        elif kind == "PICK_DONE":
            self._return_rt(data["rt"])
            truck.in_pick -= 1
            if data["pre"]:
                truck.pre += 1
            else:
                truck.staged += 1
            self._emit(f"RT-{data['rt']:02d}", "reach_truck", "idle", data["dest"], case_id=truck.code, shipment_id=truck.code, prestage=self.prestage)
            self._try_dock()
            self._try_flt()
            self._try_rt()
        elif kind == "PUT_DONE":
            self._return_rt(data["rt"])
            self._emit(f"RT-{data['rt']:02d}", "reach_truck", "idle", data["rack"], case_id=data["case"], buffer_occupancy=round(self.inbound / max(1, C["inboundCap"]), 3))
            self._try_rt()
        elif kind == "DOCKED":
            truck.state = "loading"
            truck.t["docked"] = self.t
            self._emit(truck.code, "truck", "docked", f"D{truck.dock + 1:02d}", case_id=truck.code, **self._truck_meta(truck))
            self._try_flt()
        elif kind == "LOAD_DONE":
            self._return_flt(data["flt"])
            truck.in_load -= 1
            truck.loaded += 1
            self._emit(f"FL-{data['flt']:02d}", "forklift", "idle", data["dock"], case_id=truck.code, shipment_id=truck.code, loaded=truck.loaded, prestage=self.prestage)
            if truck.loaded >= truck.pallets:
                if truck.dock in self.dock_pending_down:
                    self.dock_pending_down.discard(truck.dock)
                    self.docks[truck.dock] = -2  # taken out of service once the truck has left
                    self._emit(f"DOCK-D{truck.dock + 1:02d}", "system", "down", f"D{truck.dock + 1:02d}", severity="critical", reason="dock out of service")
                else:
                    self.docks[truck.dock] = -1
                if truck.lane >= 0:
                    self.lanes[truck.lane] = -1
                truck.state = "office"
                self._emit(truck.code, "truck", "loaded", data["dock"], case_id=truck.code, **self._truck_meta(truck))
                self.office_q.append(truck)
                self._try_office()
                self._try_lanes()
                self._try_dock()
                self._try_rt()
            self._try_flt()
        elif kind == "DISRUPT":
            self._disrupt(data)
        elif kind == "RESTORE":
            self._restore(data)
        elif kind == "DECIDE":
            self._decide(data)
        elif kind == "PREPICK_ROLL":
            if self.prepick_horizon > 0:
                self._prepick_window()
                if self.t < C["end"]:
                    self._sched("PREPICK_ROLL", self.t + 30, None)
        elif kind == "DOCS_DONE":
            self.clerk_free += 1
            truck.state = STATE_GONE
            truck.t["out"] = self.t
            truck.tat = self.t - truck.report
            self._emit(truck.code, "truck", "departed", "GATE", case_id=truck.code, turnaround_minutes=round(truck.tat, 2), **self._truck_meta(truck))
            self._try_office()

    # --- disruptions and decisions -----------------------------------------
    def _return_rt(self, rt: int) -> None:
        if rt in self.rt_pending_down:
            self.rt_pending_down.discard(rt)
            self.rt_units -= 1
            self._emit(f"RT-{rt:02d}", "reach_truck", "down", None, severity="critical", reason="breakdown")
        else:
            self.rt_free += 1
            heapq.heappush(self.rt_ids, rt)

    def _return_flt(self, flt: int) -> None:
        if flt in self.flt_pending_down:
            self.flt_pending_down.discard(flt)
            self.flt_units -= 1
            self._emit(f"FL-{flt:02d}", "forklift", "down", None, severity="critical", reason="breakdown")
        else:
            self.flt_free += 1
            heapq.heappush(self.flt_ids, flt)

    def _take_down(self, heap: list[int], pending: set[int], prefix: str, entity: str, count: int, target: str | None, reason: str) -> list[int]:
        """Take units out of service: idle units at once, busy ones when their task ends."""
        in_service = self.rt_all if prefix == "RT" else self.flt_all
        free = set(heap)
        candidates = sorted(in_service - pending, key=lambda unit: (unit not in free, -unit))
        chosen = []
        if target and int(target.split("-")[1]) in in_service - pending:
            chosen.append(int(target.split("-")[1]))
        for unit in candidates:
            if len(chosen) >= count:
                break
            if unit not in chosen:
                chosen.append(unit)
        for unit in chosen:
            in_service.discard(unit)
            if unit in free:
                heap.remove(unit)
                heapq.heapify(heap)
                if prefix == "RT":
                    self.rt_free -= 1
                    self.rt_units -= 1
                else:
                    self.flt_free -= 1
                    self.flt_units -= 1
                self._emit(f"{prefix}-{unit:02d}", entity, "down", None, severity="critical", reason=reason)
            else:
                pending.add(unit)
        return chosen

    def _bring_back(self, heap: list[int], pending: set[int], prefix: str, entity: str, ids: list[int], reason: str) -> None:
        for unit in ids:
            (self.rt_all if prefix == "RT" else self.flt_all).add(unit)
            if unit in pending:
                pending.discard(unit)
                continue
            heapq.heappush(heap, unit)
            if prefix == "RT":
                self.rt_free += 1
                self.rt_units += 1
            else:
                self.flt_free += 1
                self.flt_units += 1
            self._emit(f"{prefix}-{unit:02d}", entity, "idle", None, reason=reason)

    def _disrupt(self, data: dict) -> None:
        kind = data["kind"]
        count = int(data.get("count", 1))
        if kind == "reach_truck_down":
            data["ids"] = self._take_down(self.rt_ids, self.rt_pending_down, "RT", "reach_truck", count, data.get("target"), "breakdown")
        elif kind == "forklift_down":
            data["ids"] = self._take_down(self.flt_ids, self.flt_pending_down, "FL", "forklift", count, data.get("target"), "breakdown")
        elif kind == "dock_down":
            index = int(str(data.get("target") or "D02")[1:]) - 1
            if 0 <= index < len(self.docks):
                if self.docks[index] == -1:
                    self.docks[index] = -2
                    self._emit(f"DOCK-D{index + 1:02d}", "system", "down", f"D{index + 1:02d}", severity="critical", reason="dock out of service")
                else:
                    self.dock_pending_down.add(index)
                data["ids"] = [index]
        elif kind == "gate_down":
            taken = min(count, self.gate_lanes - 1)
            self.gate_lanes -= taken
            data["ids"] = [taken]
            self._emit("GATE-LANES", "system", "down", "GATE", severity="critical", reason=f"{taken} gate lane closed", lanes=self.gate_lanes)
        self._emit("DISRUPTION", "system", kind, data.get("target"), severity="critical", reason=data.get("label") or kind.replace("_", " "), duration=data.get("duration"))
        self._try_gate()
        self._try_rt()
        self._try_flt()

    def _restore(self, data: dict) -> None:
        kind = data["kind"]
        if kind == "reach_truck_down":
            self._bring_back(self.rt_ids, self.rt_pending_down, "RT", "reach_truck", data["ids"], "repaired")
        elif kind == "forklift_down":
            self._bring_back(self.flt_ids, self.flt_pending_down, "FL", "forklift", data["ids"], "repaired")
        elif kind == "dock_down":
            for index in data["ids"]:
                self.dock_pending_down.discard(index)
                if self.docks[index] == -2:
                    self.docks[index] = -1
                self._emit(f"DOCK-D{index + 1:02d}", "system", "restored", f"D{index + 1:02d}", reason="dock back in service")
        elif kind == "gate_down":
            self.gate_lanes += data["ids"][0] if data["ids"] else 0
            self._emit("GATE-LANES", "system", "restored", "GATE", reason="gate lane reopened", lanes=self.gate_lanes)
        self._try_gate()
        self._try_dock()
        self._try_rt()
        self._try_flt()

    def _add_units(self, prefix: str, count: int) -> None:
        for _ in range(count):
            if prefix == "RT":
                unit = self.rt_next_id
                self.rt_next_id += 1
                self.rt_all.add(unit)
                heapq.heappush(self.rt_ids, unit)
                self.rt_free += 1
                self.rt_units += 1
                self._emit(f"RT-{unit:02d}", "reach_truck", "idle", "FG-BUFFER", reason="added by decision")
            else:
                unit = self.flt_next_id
                self.flt_next_id += 1
                self.flt_all.add(unit)
                heapq.heappush(self.flt_ids, unit)
                self.flt_free += 1
                self.flt_units += 1
                self._emit(f"FL-{unit:02d}", "forklift", "idle", "MARSHALLING", reason="added by decision")

    def _prepick_window(self) -> None:
        for truck in self.trucks:
            if not truck.released and truck.state == "due" and truck.report <= self.t + self.prepick_horizon:
                self._release(truck, f"pre-pick: due within {round(self.prepick_horizon / 60, 1)} h")

    def _decide(self, decision: dict) -> None:
        params = decision.get("params") or {}
        self._add_units("RT", int(params.get("addReachTrucks", 0)))
        self._add_units("FL", int(params.get("addForklifts", 0)))
        for key in ("callShare", "putawayFirstAt"):
            if key in params:
                self.C[key] = params[key]
        horizon = int(params.get("prepickHorizon", 0))
        if horizon > 0:
            self.prepick_horizon = horizon
            self._prepick_window()
            self._sched("PREPICK_ROLL", self.t + 30, None)
        self._emit("DECISION", "system", "applied", None, reason=decision.get("label") or "decision applied", params=params)
        self._try_rt()
        self._try_flt()
        self._try_dock()

    def step(self):
        if not self.fel or self.done:
            self.done = True
            return None
        t, _, kind, data = heapq.heappop(self.fel)
        if t > self.C["end"] + 600:
            self.done = True
            return None
        self._accrue(t)
        self.t = t
        self.events += 1
        self._handle(kind, data)
        self._meters()
        return kind

    def run(self) -> "Engine":
        while self.step():
            pass
        return self


def summarize(engine: Engine) -> dict:
    done = [truck for truck in engine.trucks if truck.tat is not None]
    mean = lambda values: sum(values) / len(values) if values else math.nan  # noqa: E731
    late_after = engine.C["lateReportAfter"]
    by_hour: dict[int, list] = {}
    for truck in done:
        by_hour.setdefault(math.floor(truck.report / 60), []).append(truck.tat)
    hourly = {hour: {key: value / bucket["w"] for key, value in bucket.items() if key != "w"} for hour, bucket in engine.hourly.items() if bucket["w"] > 0}
    return {
        "n": len(engine.trucks),
        "done": len(done),
        "avg": mean([truck.tat for truck in done]),
        "late": mean([truck.tat for truck in done if truck.report >= late_after]),
        "max": max((truck.tat for truck in done), default=math.nan),
        "byHour": {hour: mean(values) for hour, values in by_hour.items()},
        "hourly": hourly,
        "events": engine.events,
        "lineHeld": engine.line_held,
        "tats": [truck.tat for truck in done],
        "departures": [(truck.t["out"], truck.tat) for truck in done],
    }


T95 = [0, 12.71, 4.30, 3.18, 2.78, 2.57, 2.45, 2.36, 2.31, 2.26, 2.23, 2.20, 2.18, 2.16, 2.14, 2.13, 2.12, 2.11, 2.10, 2.09, 2.09, 2.08, 2.07, 2.07, 2.06, 2.06, 2.06, 2.05, 2.05, 2.05, 2.04]


def confidence_interval(values: list[float]) -> dict:
    n = len(values)
    m = sum(values) / n
    if n < 2:
        return {"m": m, "h": 0.0, "n": n, "s": 0.0}
    s = math.sqrt(sum((value - m) ** 2 for value in values) / (n - 1))
    t = T95[n - 1] if n - 1 <= 30 else 1.96
    return {"m": m, "h": t * s / math.sqrt(n), "n": n, "s": s}


def trace_day(config: dict, seed: int = 1410) -> list[dict]:
    """The dummy SAP day: fixed by seed 1410, identical to the starter kit's TRACE."""
    draw = mulberry(seed)
    out = []
    for hour, count in sorted(config["arrivals"].items(), key=lambda item: int(item[0])):
        for _ in range(count):
            u = draw()
            acc = 0.0
            chosen = config["types"][0]
            for item in config["types"]:
                acc += item["share"]
                if u <= acc:
                    chosen = item
                    break
            out.append({"report": int(hour) * 60 + math.floor(draw() * 60), "pallets": chosen["pallets"], "type": chosen["name"]})
    return sorted(out, key=lambda item: item["report"])


def random_day(config: dict, draw) -> list[dict]:
    """A random day: non-stationary Poisson arrivals with the same hourly profile."""
    out = []
    for hour, count in sorted(config["arrivals"].items(), key=lambda item: int(item[0])):
        t = int(hour) * 60
        while True:
            t += exponential(draw(), 60 / count)
            if t >= int(hour) * 60 + 60:
                break
            u = draw()
            acc = 0.0
            chosen = config["types"][0]
            for item in config["types"]:
                acc += item["share"]
                if u <= acc:
                    chosen = item
                    break
            out.append({"report": t, "pallets": chosen["pallets"], "type": chosen["name"]})
    return sorted(out, key=lambda item: item["report"])
