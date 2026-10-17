from . import Rule


def _accept(ctx, config, default):
    return ctx["inbound"] < ctx["cap"]


RULE = Rule(
    id="production-buffer-full",
    name="Production buffer full",
    hooks={"production.accept": _accept},
    params=("inboundCap", "prodPerHour"),
    source="Site layout and line rate",
    description="When putaway cannot clear the finished-goods buffer, the production line is held.",
    order=70,
)
