from . import Rule


def _allowed(ctx, config, default):
    return ctx["prestage"] < ctx["cap"]


RULE = Rule(
    id="prestage-capacity",
    name="Pre-stage area capacity",
    hooks={"prestage.allowed": _allowed},
    params=("prestageCap",),
    source="Site layout",
    description="Pre-picked pallets need floor space; picking ahead stops when the pre-stage area is full.",
    order=50,
)
