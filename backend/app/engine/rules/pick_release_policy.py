from . import Rule

# Gate policy: a truck's picking starts when it reports at the gate.
# Pre-pick policy: trucks due after the cut-off are released for picking at a
# fixed morning time, so their pallets wait in the pre-stage area.


def _on_arrival(ctx, config, default):
    if config["policy"] != "prepick":
        return True
    return ctx["report"] < config["prepickForReportsAfter"]


def _release_at(ctx, config, default):
    return config["prepickReleaseAt"] if config["policy"] == "prepick" else default


def _include(ctx, config, default):
    return ctx["report"] >= config["prepickForReportsAfter"]


RULE = Rule(
    id="pick-release-policy",
    name="Picking release policy",
    hooks={"truck.release_on_arrival": _on_arrival, "day.prepick_release_at": _release_at, "prepick.include": _include},
    params=("policy", "prepickReleaseAt", "prepickForReportsAfter"),
    source="Site operating rules; pre-pick is the user lever",
    description="Release picking when the truck reports (gate), or pre-pick evening trucks in the morning.",
    order=10,
)
