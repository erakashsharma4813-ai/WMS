from . import Rule


def _limit(ctx, config, default):
    return max(1, int(config["loadersPerDoor"]))


RULE = Rule(
    id="loaders-per-door",
    name="Forklifts per dock door",
    hooks={"dock.loaders": _limit},
    params=("loadersPerDoor",),
    source="Site operating rules",
    description="Only so many forklifts can work one door at once (one in the trailer, one at the leveller); the rest load other doors or wait.",
    order=70,
    # Off by default until the site confirms the limit: switched on, it moves the
    # design-document numbers that the golden tests hold (spreading forklifts
    # across doors cuts turnaround from 2.00 h to 1.67 h on the reference set-up).
    default_enabled=False,
)
