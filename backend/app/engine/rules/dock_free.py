from . import Rule

# Structural rule: a dock holds one truck. Listed in the model card; it cannot
# be switched off because the flow has no meaning without it.
RULE = Rule(
    id="dock-free",
    name="Dock free",
    hooks={},
    params=("docks",),
    source="Site layout",
    description="A truck waits in the holding yard until a dock is free.",
    switchable=False,
    order=5,
)
