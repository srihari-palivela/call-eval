# The active taxonomy, held in memory for the pipeline and analytics. It starts as the framework's v1.0 and
# is loaded from the database at startup; each process re-checks the active version every few seconds, so
# an activation in the API reaches the workers without a restart.
#
# Lookups fall back from the active version to retired versions and then to the framework's own entries,
# so calls classified under an older version still show their persona and scenario names.

from __future__ import annotations

import asyncio
import time
from ..framework import P0
from ..tenancy import workspace_id
from .catalogue import BUILTIN_EVENTS, BUILTIN_PERSONAS, BUILTIN_SCENARIOS, DEFAULT_DOMAIN, FACETS, SYSTEM_EVENTS, TAXONOMY_VERSION, builtin_doc


def _natural(id: str) -> tuple:
    head = id.rstrip('0123456789')
    tail = id[len(head):]
    return (head, int(tail) if tail else -1, id)


def normalise_entry(kind: str, d: dict) -> dict:
    """Fill the keys older rows lack: v1.0 rows were stored before entries had basedOn, keywords or checkpoints."""
    from ..framework import PATHS
    d = dict(d)
    builtin = {'persona': BUILTIN_PERSONAS, 'scenario': BUILTIN_SCENARIOS, 'event': BUILTIN_EVENTS}[kind]
    if 'basedOn' not in d:
        d['basedOn'] = d['id'] if d['id'] in builtin else None
    d.setdefault('keywords', [])
    if kind == 'scenario' and 'checkpoints' not in d:
        d['checkpoints'] = [dict(c) for c in PATHS.get(d['basedOn'] or '', [])]
    if kind == 'event':
        d['system'] = d['id'] in SYSTEM_EVENTS
    return d


class Taxonomy:
    def __init__(self, version: str, domain: str | None, personas: list[dict], scenarios: list[dict], events: list[dict],
                 archive: dict[str, dict[str, dict]] | None = None):
        self.version = version
        self.domain = domain or DEFAULT_DOMAIN
        self.personas = personas
        self.scenarios = scenarios
        self.events = events
        self.facets = FACETS
        self.p0 = P0
        arc = archive or {}

        def merged(kind: str, builtin: dict, active: list[dict]) -> dict[str, dict]:
            out = {id: normalise_entry(kind, d) for id, d in builtin.items()}
            out.update({id: normalise_entry(kind, d) for id, d in arc.get(kind, {}).items()})
            out.update({d['id']: normalise_entry(kind, d) for d in active})
            return out

        self._p = merged('persona', BUILTIN_PERSONAS, personas)
        self._s = merged('scenario', BUILTIN_SCENARIOS, scenarios)
        self._e = merged('event', BUILTIN_EVENTS, events)
        self._active_ids = {p['id'] for p in personas} | {s['id'] for s in scenarios}

    def persona(self, id: str | None) -> dict:
        return self._p.get(id or '', P0) if id != 'P0' else P0

    def scenario(self, id: str | None) -> dict | None:
        return self._s.get(id or '')

    def event(self, id: str | None) -> dict | None:
        return self._e.get(id or '')

    def basis(self, id: str | None) -> str | None:
        """The framework entry a persona, scenario or event inherits from (P0 is itself)."""
        if not id:
            return None
        if id == 'P0':
            return 'P0'
        d = self._p.get(id) or self._s.get(id) or self._e.get(id)
        return d['basedOn'] if d else None

    def persona_for(self, builtin: str) -> str | None:
        """The active persona based on a framework persona (P7, P11…), if the taxonomy has one."""
        return next((p['id'] for p in self.personas if p.get('basedOn') == builtin), None)

    def scenario_for(self, builtin: str) -> str | None:
        return next((s['id'] for s in self.scenarios if s.get('basedOn') == builtin), None)

    def ids_based_on(self, kind: str, builtins: tuple[str, ...]) -> list[str]:
        """Every id, active or retired, based on one of these framework entries (SQL filters over past calls)."""
        src = self._p if kind == 'persona' else self._s
        return sorted({id for id, d in src.items() if d['basedOn'] in builtins}, key=_natural)

    def persona_ids_on_path(self, *paths: str) -> list[str]:
        return sorted({id for id, d in self._p.items() if d.get('path') in paths}, key=_natural)

    def checkpoints(self, scenario: str | None) -> list[dict]:
        s = self._s.get(scenario or '')
        return s['checkpoints'] if s else []

    def is_active(self, id: str | None) -> bool:
        return bool(id) and id in self._active_ids


def _builtin() -> Taxonomy:
    d = builtin_doc()
    return Taxonomy(TAXONOMY_VERSION, d['domain'], d['personas'], d['scenarios'], d['events'])


_BUILTIN = _builtin()
CHECK_EVERY_S = 5.0


class _Held:
    """One workspace's active taxonomy in this process, and when it was last checked."""

    def __init__(self, tax: Taxonomy, checked_at: float, db_id: int | None):
        self.tax, self.checked_at, self.db_id = tax, checked_at, db_id


_held: dict[str, _Held] = {}
_locks: dict[str, asyncio.Lock] = {}


def current() -> Taxonomy:
    h = _held.get(workspace_id())
    return h.tax if h else _BUILTIN


def reset() -> None:
    """Back to the framework's v1.0 everywhere (tests)."""
    _held.clear()


async def load(db) -> Taxonomy:
    """Read the workspace's active version (and every retired one, for names of old calls) from the database."""
    ws = workspace_id()
    v = await db.one("select version, domain from taxonomy_version where status = 'active' order by created_at desc limit 1")
    if not v:
        _held[ws] = _Held(_BUILTIN, time.monotonic(), id(db))
        return _BUILTIN
    rows = await db.query(
        """select t.tag_id, t.version, t.kind, t.definition, t.ord, tv.status from taxonomy t join taxonomy_version tv on tv.version = t.version
           where tv.status in ('active', 'retired') order by tv.created_at, t.ord""")
    act: dict[str, list] = {'persona': [], 'scenario': [], 'event': []}
    archive: dict[str, dict[str, dict]] = {'persona': {}, 'scenario': {}, 'event': {}}
    for r in rows:
        if r['kind'] not in act or r['tag_id'] == 'P0':
            continue
        d = normalise_entry(r['kind'], {**r['definition'], 'id': r['tag_id']})
        if r['version'] == v['version']:
            act[r['kind']].append((r['ord'], d))
        else:
            archive[r['kind']][r['tag_id']] = d
    ordered = {k: [d for _, d in sorted(xs, key=lambda x: (x[0], _natural(x[1]['id'])))] for k, xs in act.items()}
    tax = Taxonomy(v['version'], v['domain'], ordered['persona'], ordered['scenario'], ordered['event'], archive)
    _held[ws] = _Held(tax, time.monotonic(), id(db))
    return tax


async def refresh(db, *, force: bool = False) -> Taxonomy:
    """Reload when another process activated a version (checked at most every few seconds per workspace)."""
    ws = workspace_id()

    def fresh() -> bool:
        h = _held.get(ws)
        return bool(h) and h.db_id == id(db) and time.monotonic() - h.checked_at < CHECK_EVERY_S

    if not force and fresh():
        return current()
    lock = _locks.setdefault(ws, asyncio.Lock())
    async with lock:
        if not force and fresh():
            return current()
        h = _held.get(ws)
        v = await db.one("select version from taxonomy_version where status = 'active' order by created_at desc limit 1")
        if force or not h or h.db_id != id(db) or (v and v['version'] != h.tax.version):
            return await load(db)
        h.checked_at = time.monotonic()
        return h.tax
