from . import Rule

# Glass-box congestion curve: task time = base x (1 + a x max(0, f - f0) / (1 - f)).
# Flat until f0, then rising as free locations run out. Loading takes a share of
# the effect. a and f0 are assumptions until fitted from task times against
# stock level in the pilot's SAP data.


def factor(config: dict) -> float:
    f = min(config["fillRate"], 0.995)
    return 1 + config["congestionA"] * max(0.0, f - config["congestionF0"]) / (1 - f)


def _params(ctx, config, default):
    mean, tri = default
    k = factor(config)
    if ctx["kind"] in ("pick", "put"):
        scale = k
    elif ctx["kind"] == "load":
        scale = 1 + (k - 1) * config["congestionLoadShare"]
    else:
        return default
    return mean * scale, [value * scale for value in tri]


RULE = Rule(
    id="fill-congestion",
    name="Warehouse fill congestion",
    hooks={"task.params": _params},
    params=("fillRate", "congestionA", "congestionF0", "congestionLoadShare"),
    source="Fitted: warehouse task confirmation times against stock level (assumption until fitted)",
    description="Picks and putaways slow down as the warehouse fills; loading takes part of the effect.",
    order=20,
)
