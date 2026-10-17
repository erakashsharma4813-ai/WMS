from . import Rule

# Shared reach trucks: putaway jumps ahead of picking when the finished-goods
# buffer is high, and every few decisions when it holds a minimum backlog.


def _want_putaway(ctx, config, default):
    inbound = ctx["inbound"]
    if inbound <= 0:
        return False
    return inbound >= config["putawayFirstAt"] or not ctx["has_picks"] or (ctx["decision"] % config["putawayEveryNth"] == 0 and inbound >= config["putawayMinBacklog"])


RULE = Rule(
    id="putaway-priority",
    name="Putaway priority on shared reach trucks",
    hooks={"rt.want_putaway": _want_putaway},
    params=("putawayFirstAt", "putawayEveryNth", "putawayMinBacklog"),
    source="Site operating rules",
    description="Reach trucks put away first when the buffer is high, and interleave putaway otherwise.",
    order=30,
)
