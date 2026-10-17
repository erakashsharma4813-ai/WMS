from . import Rule


def _ready(ctx, config, default):
    return ctx["share"] >= ctx["call_share"]


RULE = Rule(
    id="dock-call-readiness",
    name="Dock call readiness",
    hooks={"dock.ready": _ready},
    params=("callShare",),
    source="Site operating rules",
    description="A truck is called to a dock only when the set share of its pallets is staged.",
    order=60,
)
