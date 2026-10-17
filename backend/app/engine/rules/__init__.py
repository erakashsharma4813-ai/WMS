"""Constraints as plug-in rules.

A rule hooks onto a decision point in the engine, reads its parameters from
the site config, and returns what should happen. The engine never hard-codes
a constraint: it asks the rule set. A rule that is switched off falls back to
the unconstrained behaviour given at the hook, so its effect can be measured.

Add a rule by writing one module in this package that defines RULE.
See .claude/skills/sim-rule/SKILL.md.
"""

from __future__ import annotations

import importlib
import pkgutil
from dataclasses import dataclass, field
from typing import Any, Callable

Effect = Callable[[dict, dict, Any], Any]  # (context, config, default) -> value


@dataclass(frozen=True)
class Rule:
    id: str
    name: str
    hooks: dict[str, Effect]
    params: tuple[str, ...]
    source: str
    description: str
    switchable: bool = True
    default_enabled: bool = True
    order: int = 100

    def card(self, enabled: bool) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "hooks": sorted(self.hooks),
            "params": list(self.params),
            "source": self.source,
            "description": self.description,
            "switchable": self.switchable,
            "enabled": enabled,
        }


def discover() -> list[Rule]:
    rules = []
    for module in pkgutil.iter_modules(__path__):
        loaded = importlib.import_module(f"{__name__}.{module.name}")
        if hasattr(loaded, "RULE"):
            rules.append(loaded.RULE)
    return sorted(rules, key=lambda rule: (rule.order, rule.id))


REGISTRY: list[Rule] = discover()
RULES_BY_ID = {rule.id: rule for rule in REGISTRY}


@dataclass
class RuleSet:
    config: dict
    enabled: dict[str, bool] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.active: dict[str, list[Rule]] = {}
        for rule in REGISTRY:
            if not self.is_enabled(rule.id):
                continue
            for hook in rule.hooks:
                self.active.setdefault(hook, []).append(rule)

    def is_enabled(self, rule_id: str) -> bool:
        rule = RULES_BY_ID[rule_id]
        return not rule.switchable or self.enabled.get(rule_id, rule.default_enabled)

    def value(self, hook: str, default: Any, **context) -> Any:
        """Ask the active rules at a hook. With no active rule, the unconstrained default applies."""
        result = default
        for rule in self.active.get(hook, ()):
            result = rule.hooks[hook](context, self.config, result)
        return result

    def cards(self) -> list[dict]:
        return [rule.card(self.is_enabled(rule.id)) for rule in REGISTRY]
