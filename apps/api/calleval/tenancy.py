# Which workspace (company) the current work belongs to. Every request, job and scheduler pass runs inside
# one, held in a context variable; the database layer passes it to PostgreSQL, whose row-level security
# shows and accepts only that workspace's rows. Without self-serve sign-up the installation has one
# workspace, the default, and work outside a request uses it.

from __future__ import annotations

import contextlib
from collections.abc import Iterator
from contextvars import ContextVar

from .config import config

DEFAULT_WORKSPACE = 'ws_default'
_current: ContextVar[str | None] = ContextVar('workspace', default=None)


class NoWorkspace(RuntimeError):
    """Tenant data was touched outside any workspace (a bug: refuse rather than guess)."""


def workspace_id() -> str:
    ws = _current.get()
    if ws:
        return ws
    if not config.self_signup:
        return DEFAULT_WORKSPACE
    raise NoWorkspace('No workspace for this work; it must run inside a request, a job or a scheduler pass')


def set_workspace(ws: str | None):
    """Set for the rest of this task (a request, a job); returns the token for `reset_workspace`."""
    return _current.set(ws)


def reset_workspace(token) -> None:
    _current.reset(token)


@contextlib.contextmanager
def in_workspace(ws: str) -> Iterator[None]:
    token = _current.set(ws)
    try:
        yield
    finally:
        _current.reset(token)


def namespaced(id: str) -> str:
    """Ids built from provider ids (calls) get the workspace in them outside the default workspace, so two
    companies importing the same provider or demo ids never collide."""
    ws = workspace_id()
    return id if ws == DEFAULT_WORKSPACE else f"{ws.removeprefix('ws_')}_{id}"
