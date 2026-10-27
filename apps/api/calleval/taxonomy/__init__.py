# The taxonomy the pipeline and analytics use: the active version (user-defined or the framework's v1.0).
# `calleval.framework` keeps the framework's own entries; everything that classifies, scores or labels calls
# reads them through here.

from __future__ import annotations

from .active import Taxonomy, current, load, refresh, reset


def persona_by_id(id: str | None) -> dict:
    return current().persona(id)


def scenario_by_id(id: str | None) -> dict | None:
    return current().scenario(id)


def is_target_persona(id: str | None) -> bool:
    return persona_by_id(id)['path'] in ('Investor', 'Broker')


def basis(id: str | None) -> str | None:
    """The framework entry this persona, scenario or event inherits its built-in rules and checks from."""
    return current().basis(id)


__all__ = ['Taxonomy', 'basis', 'current', 'is_target_persona', 'load', 'persona_by_id', 'refresh', 'reset', 'scenario_by_id']
