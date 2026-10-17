# Dispatch Twin: Simulation Review

**Status:** Draft for product review
**Scope:** Backend simulation and replay (`backend/`), 3D and analysis frontend (`frontend/`), demo dataset (`demo-data/automotive-dispatch-demo/`)
**Reviewed at commit:** `602af25` plus uncommitted working changes (October 2026)

---

## 1. Summary

Dispatch Twin is meant to answer one operational question for an outbound automotive DC:

> **Why do trucks queue in the evening even when docks are free, and which lever fixes it: more docks, more reach trucks, pre-picking, or appointment windows?**

The product concept, the dataset and the UI flow are strong. In particular, splitting truck delay into stages (production, gate, picking, yard, loading, exit) is the right foundation for decision support.

However, **the simulation engine doesn't yet behave the way the product story and the dataset describe**:

- Two of the four policy scenarios have no real effect, or a much weaker effect than described.
- The main cause of the evening bottleneck (the finished-goods buffer reaching 85% and putaway taking priority) is effectively a fixed setting, not a modelled effect.
- Much of the shipped data (shifts, breaks, maintenance, transporter lateness, dock compatibility) is not used.
- Each result is one run with one random seed. The engine isn't calibrated against history, so differences between scenarios can't yet be told apart from noise.
- "Live replan" re-runs the whole day instead of continuing from the current state.

**Today the product works as a convincing demo. It is not yet a tool for making decisions.** This document lists the gaps, their impact on the product, and the decisions we need from the product team before backend work starts.

---

## 2. The product promise vs. what it delivers today

| Mode | What we promise | What it does today | Gap |
|---|---|---|---|
| **Recorded (past replay)** | Replay a real historical day and show where delay came from | Replays truck and task timestamps correctly. Some KPIs and findings are hardcoded, not computed. | Medium |
| **What-if (dynamic simulation)** | Change resources and policies, see the measured impact | Runs a new simulation. Several levers are missing or weak, and results come from a single run. | **High** |
| **Live replan** | Freeze the day at time T, change only future bookings, recalculate the rest of the shift | Re-runs the whole day from 06:00. The past can change, and in one flow edits are silently ignored. | **High** |

---

## 3. Findings

Severity reflects impact on **trust in the numbers**, which is what the product sells.

### 3.1 Critical: scenarios don't do what they say

| # | Finding | Product impact |
|---|---|---|
| C1 | **The baseline doesn't follow the baseline rule.** The operating rules say picking starts when the truck reports at the gate. The simulator starts picking as soon as production releases pallets, whether or not the truck is there. | The baseline already behaves like a "pre-pick everything" policy. The evening crunch the demo is built around doesn't emerge naturally. |
| C2 | **"Pre-pick high-priority shipments" has no effect.** The engine calculates the earlier release time and then never uses it. | Demoing this lever shows zero improvement, which is a credibility risk in front of a client. |
| C3 | **"Reserve a reach truck for picking" doesn't reserve a truck.** It only nudges task priority during 15:30–19:30. | The effect is understated and inconsistent with how the scenario is described. |
| C4 | **The finished-goods buffer level isn't simulated.** It only ever goes up and crosses 85% almost immediately. Production doesn't fill it and putaway doesn't empty it. | The core cause in our story is a constant. We can't show "the buffer filled at 16:10 and that's when picking stalled". |
| C5 | **Reach truck IDs in the 3D view aren't real vehicles.** The same ID (e.g. RT-02) can appear on two vehicles at once. | Visible glitch in demos. Per-vehicle utilisation can't be reported. |

### 3.2 High: available data isn't used

The dataset already contains this information, but the simulator ignores it:

| Data in the dataset | Used today? | Why the product team should care |
|---|---|---|
| Shift headcounts (2 loading gangs in the morning, 3 in the afternoon, 1 at night) | No: 3 all day | Morning capacity is overstated |
| **18:00–18:30 break at 50% staffing, inside the evening peak** | No | Probably one of the biggest real drivers of the evening problem |
| RT-03 maintenance, 09:30–11:00 | No | Morning picking is too optimistic |
| Work already in progress at day start (2 picks, 7 putaways) | No: the day starts empty | First hours are too optimistic |
| Transporter lateness (e.g. Transporter B is on average 26 min late) | No: every truck gets the same random noise with no bias | "Balanced appointments" results aren't realistic |
| Dock compatibility (long vehicles need specific docks) | No | Long trucks can use any dock |
| Travel distances and vehicle speeds from the layout | No: task time is a generic formula | Layout changes would have no effect |
| Marshalling lane capacity (16 pallets, no overflow) | No: shipments of up to 29 pallets fit anyway | A real constraint is missing |
| Forklifts needed for loading, a single weighbridge | No | Possible hidden bottlenecks aren't visible |
| Dock call order by delivery window | No: first come, first served | Prioritisation policies can't be tested |
| Opening inventory | No | No stock-out scenarios possible |

Also, one pick task moves a whole batch of up to about 10 pallets, while a real reach truck carries 1–2 pallets per trip. This distorts queue lengths and utilisation.

### 3.3 High: results can't yet be trusted statistically

| # | Finding | Product impact |
|---|---|---|
| S1 | **Each What-if result comes from one simulated day.** | One run is one possible day. Run-to-run variation is often larger than the difference between scenarios, so users may pick the "better" option by chance. |
| S2 | **"Same seed" doesn't mean "same day with one change".** Any input change reshuffles all the random draws. | Comparing a scenario with the baseline mixes the effect of the change with random noise. |
| S3 | **The model isn't calibrated or validated against history.** Durations are hand-picked constants, and nobody has checked that a baseline run reproduces the recorded day (average turnaround 119 min, P90 185 min, peak 17:00–18:00). | We can't claim the twin represents this warehouse. This is the first question an operations manager will ask. |

### 3.4 Medium: Recorded replay

| # | Finding | Product impact |
|---|---|---|
| R1 | **Some replay KPIs and conclusions are hardcoded:** "Primary bottleneck: Shared reach trucks", peak yard queue = 4, and one fixed finding sentence. Dock utilisation is really trucks completed per hour. | An evidence view that states its own conclusion undermines the "evidence" claim. |
| R2 | **Recorded, What-if and the partial analysis each use a different stress score formula.** | "Stress 72" means something different in each mode, so users can't compare a scenario with history. |
| R3 | **The replay doesn't use the dataset's main event log**, which is the file the dataset guide designates for replay. | It doesn't follow the data contract we documented. Low user impact for now. |

### 3.5 High: Live replan

| # | Finding | Product impact |
|---|---|---|
| L1 | **It re-runs the whole day instead of continuing from the frozen state.** Events before the cutoff can come out different. | This breaks the core promise: "completed events are frozen". |
| L2 | **A truck can be moved to before the cutoff time** (e.g. by −4 h), which changes the past. | Same as L1. |
| L3 | **Opening Live replan before any What-if run shows historical shipments.** Edits to them are silently ignored. | Users think they replanned and nothing changed. A trust-breaking bug. |
| L4 | **There's no snapshot of current state** (trucks in the yard, picks in progress, buffer level). | Needed before this can connect to a real WMS or yard management system. |

### 3.6 Medium: UX and correctness

- **Times follow the viewer's own timezone, not the site's (IST).** Reviewers outside India see shifted clocks and some hourly figures don't line up. This matters for our distributed team.
- **The "Doors open" slider goes up to 6, but the layout has 4 docks.** Trucks at docks 5–6 appear at the wrong place in 3D, and the door timeline always shows 4 doors.
- **The "Trucks per day" slider copies existing trucks at the same times.** That's cloned demand, not realistic growth.
- **"Pallets processed" is estimated from elapsed time**, not counted.
- **Pallet objects build up** in the production area in 3D and never disappear.
- **A temporary public ngrok URL is in the backend's allowed-origins list.** It should be moved to configuration.

---

## 4. Decisions needed from the product team

These questions change what we build, so we need your input before backend work starts.

1. **Primary use: demo or decision tool?**
   If this is mainly a sales demo for now, we can fix the critical items (C1–C5, L3, the timezone bug) and leave statistics and calibration for later. If site managers will make staffing or slotting decisions with it, multiple runs and calibration (S1–S3) become mandatory.
2. **How should we present uncertainty?**
   With multiple runs we can show ranges (e.g. "P90 turnaround 160–185 min") and say whether a scenario is reliably better. Is the target audience comfortable with ranges, or do we need one headline number plus a confidence label?
3. **Material flow: make-to-order, from stock, or both?**
   Do outbound pallets come straight from production through the finished-goods buffer, get picked from rack stock, or a mix per product group? Today the model mixes both inconsistently.
4. **Which levers matter most to users?**
   Today: demand, docks, loading gangs, reach trucks, readiness threshold, arrival spread, production variation, slot moves. Candidates to add: shift and break planning, dock call priority rules, buffer threshold, reserved resources by time window. Please rank them.
5. **What does "Live" mean for the next release?**
   Simulated "live" based on the forecast day, or a target integration with real WMS/yard events? This decides whether we design the state snapshot now.
6. **Is a calibration target available?**
   Can operations give us acceptance criteria, e.g. "the baseline must reproduce the historical average turnaround within ±10%"?
7. **Single stress score or separate KPIs?**
   We will unify the formula either way. Should "stress" remain a headline concept, or should we show turnaround, queues and utilisation directly?
8. **Scope of demand scaling.**
   Should "more trucks per day" spread new trucks across the day, follow a profile (e.g. extra evening trucks), or follow a transporter mix?

---

## 5. Proposed roadmap (for discussion)

| Phase | Content | Outcome |
|---|---|---|
| **1. Make the levers real** | Gate-triggered pick release (C1), working pre-pick (C2), real truck reservation (C3), simulated buffer level (C4), real vehicle IDs (C5), Live replan ID bug (L3), timezone fix, one KPI and stress definition (R2) | Every scenario does what it says. Demo-safe. |
| **2. Use the data we have** | Shifts and breaks, maintenance, start-of-day work, transporter lateness, dock compatibility, lane capacity, dock call ordering | The evening bottleneck emerges from realistic causes |
| **3. Make results trustworthy** | Fit durations from history, validate the baseline against the recorded day, 20–30 runs per scenario, fair comparison with the baseline, ranges in the analysis view | Defensible numbers for operations decisions |
| **4. Real live replanning** | Continue from a state snapshot at time T, future-only edits enforced, groundwork for WMS/yard integration | A true digital twin for the dispatcher |
| **5. More detail** | Travel times from the layout, per-pallet trips, forklifts, weighbridge, stock checks | Layout and equipment what-ifs become possible |

Phase 1 is a prerequisite for everything else. Phases 2 and 3 can partly run in parallel. Answers to section 4 will change the order and scope of phases 3–5.

---

## 6. What's already good, and should be kept

- One event format for replay and simulation, so one 3D/analysis frontend serves every mode.
- The breakdown of delay by stage with a cause and a recommendation for each. This is the most valuable analytical idea in the product.
- Locked historical replay. Users can't edit evidence.
- "Inputs changed, re-run required" before results are shown, which prevents stale results.
- Partial analysis at any point in the timeline.
- Seeded, reproducible runs with automated tests around the API.
- A well-documented, modular synthetic dataset that's easy to swap for real site data.

---

## Appendix A: Technical references (for engineering)

| Finding | Location |
|---|---|
| C1: picks start at production batch time, not gate report | `backend/app/simulation.py` `pick_task` (lines 181–182) |
| C2: pre-pick `release` computed but never used | `backend/app/simulation.py` lines 161–163 |
| C3: reservation is only a priority shift, with no preemption | `backend/app/simulation.py` lines 196–197, 295–296 |
| C4: buffer occupancy only increases | `backend/app/simulation.py` `putaway_generator` (line 291) |
| C5: vehicle ID derived from `users.index()` | `backend/app/simulation.py` lines 203, 299 |
| Same random noise for every truck, transporter bias unused | `backend/app/simulation.py` line 128 |
| Single shared RNG stream | `backend/app/simulation.py` line 59 |
| R1: hardcoded replay KPIs and findings | `backend/app/replay.py` lines 142–153, 234, 238, 247 |
| R2: three stress formulas | `replay.py` line 144, `simulation.py` line 344, `frontend/src/App.tsx` line 97 |
| L2: future check uses planned rather than effective arrival | `backend/app/simulation.py` line 132 |
| L3: Live mode falls back to the replay result | `frontend/src/App.tsx` line 337 |
| Timezone: browser-local `getHours()` / `Intl` | `frontend/src/App.tsx` lines 87, 148–152, 280 |
| Door timeline hardcodes D01–D04 | `frontend/src/App.tsx` line 186 |
| Hardcoded ngrok origin | `backend/app/main.py` line 18 |
