---
name: sim-rule
description: Add, change or switch a constraint in the Dispatch Twin simulation engine as a plug-in rule (for example shift breaks, reach-truck charging, dock type, delivery windows, weighbridge), or add a model-card parameter or stress point. Use when someone asks for a new operating rule, a new limit, a policy lever, or when a simulated result misses something that happens on site.
---

# Simulation rule skill

Constraints never stop growing; each pilot finds new ones. A constraint is never
hard-coded inside the engine loop. It is a rule plug-in: one file that hooks onto a
decision point, reads its numbers from the site file, and returns what happens.

## Where things live

```
backend/app/engine/
  des.py                 the event loop (port of the starter-kit des.js); calls rules at hooks
  rules/__init__.py      Rule contract, discovery, RuleSet.value(hook, default, **context)
  rules/<rule>.py        one module per rule, each defines RULE
  site.py                site file to engine config; the model card
  runner.py              replications, statistics, compare, sweep, levers, event log out
demo-data/automotive-dispatch-demo/20_engine_site.json   every number: value, kind, unit, source, status
backend/tests/test_engine_golden.py                       numbers the design docs depend on
```

## The rule contract

```python
from . import Rule

def _effect(ctx, config, default):
    # ctx: what the hook passes; config: the resolved site file; default: the behaviour with the rule off
    return ctx["share"] >= ctx["call_share"]

RULE = Rule(
    id="dock-call-readiness",          # kebab-case, stable: it appears in event logs and the model card
    name="Dock call readiness",
    hooks={"dock.ready": _effect},     # one rule may serve several hooks
    params=("callShare",),             # site-file keys it reads (shown in the model card)
    source="Site operating rules",     # where the numbers come from
    description="A truck is called to a dock only when the set share of its pallets is staged.",
    switchable=True,                   # False only for structural rules (dock-free)
    order=60,                          # evaluation order when several rules share a hook
)
```

The default passed at a hook is the **unconstrained** behaviour. Switching a rule off
in the model card falls back to it, so every rule's effect can be measured.

## Steps

1. **Name the decision.** Find the point in `des.py` where the rule must act. Reuse an existing hook if one fits:
   `truck.release_on_arrival`, `day.prepick_release_at`, `prepick.include`, `task.params`, `rt.want_putaway`,
   `lane.count`, `prestage.allowed`, `dock.ready`, `dock.loaders`, `production.accept`.
2. **Add a hook only if none fits.** Call `self.rules.value("<hook>", <unconstrained default>, **context)` at that point.
   The call must not change any result while no rule handles it (run the golden tests to prove it).
   Never consume random numbers inside a rule; draw them in the engine from the right stream, so common random numbers still hold.
3. **Add the numbers to the site file** (`20_engine_site.json` → `parameters`): `value`, `kind` (`read` from SAP, `fitted` from many days, `set` by the site or the user), `unit`, `group`, `label`, `source`, `status` (`Assumption` until confirmed), and `min`/`max` for levers.
4. **Write the rule module** in `backend/app/engine/rules/`. It is discovered automatically.
5. **Explain it in the event log.** When the rule holds something, emit the reason with `self._emit(..., reason="...", rule="<rule id>")`, so a red truck can say why it waited.
6. **Add a stress point if the rule creates a new queue** (`stress_points` in the site file: metric, amber, red, location). The metric must exist in `Engine._metrics()`.
7. **Test.** Add a test to `backend/tests/` that shows the effect (switching the rule off changes the result in the expected direction), then run `python -m pytest -q`. The golden tests must still pass unless the change is intended and the design docs are updated.
8. **Check the screens.** The model card lists the rule with a switch and its parameters; Compare measures it against the baseline with the same seeds.

## Rules of the engine

- Same seed, same result. Every run.
- Nothing is lost: every truck that enters leaves or is still present; every pallet loaded is counted.
- No number in logic: capacities, times and thresholds come from the site file.
- The frontend reads only the event log and the statistics; it never computes results itself.

## Backlog of rules (from the design doc)

| Rule | Hook (proposed) | Status |
|---|---|---|
| Shift breaks (50% cover 10:00, 18:00, 02:00) | resource capacity by time | Next: needs a capacity hook on reach trucks and forklifts |
| Reach-truck charging and planned maintenance (RT-03 09:30 to 11:00) | resource capacity by time | Next |
| Dock type (40 ft only on D03/D04) | `dock.compatible` | Next: site layout already lists supported truck types |
| Delivery window per shipment | slot check in runner | Partly: a fixed slot (`slotMinutes`) marks trucks amber and red |
| Weighbridge (tare and gross, one bridge) | new gate stage | Next: the starter-kit twin had it |
| Mixed-pallet picking by pickers | new task type | Next |
| Hazardous goods separation | putaway placement | Later |
