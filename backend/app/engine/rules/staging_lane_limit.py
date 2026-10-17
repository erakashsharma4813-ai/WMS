from . import Rule


def _lanes(ctx, config, default):
    return ctx["lanes"]


RULE = Rule(
    id="staging-lane-limit",
    name="Staging lane full",
    hooks={"lane.count": _lanes},
    params=("lanes",),
    source="Site layout",
    description="Each truck needs a free marshalling lane before its pallets can be picked to the dock side.",
    order=40,
)
