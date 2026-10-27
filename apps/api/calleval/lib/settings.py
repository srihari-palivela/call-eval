# Tunable framework settings. The framework calls weights and thresholds "starting values to revisit
# after 200 calls", and leaves the attribution window and budget bands for sales to agree, so they
# live in the database rather than in code.

from __future__ import annotations

import copy
import math
import time
from typing import Any

from ..framework import DEFAULT_BUDGET_BANDS, DEFAULT_WEIGHTS, DIM_KEYS, GOOD_LINE, MIN_CELL_CALLS
from ..js import js_json, js_round
from ..tenancy import workspace_id

DEFAULT_SETTINGS: dict[str, Any] = {
    'weights': dict(DEFAULT_WEIGHTS),
    'attributionDays': 30,
    'reservationAttributionDays': 90,
    'minCellCalls': MIN_CELL_CALLS,
    'reviewSampleRate': 0.1,
    'confidenceThreshold': 0.7,
    'costPerMinuteAed': None,
    'budgetBands': DEFAULT_BUDGET_BANDS,
    'retentionDays': None,
    'goodLine': GOOD_LINE,
    # Optional modules. crm: the built-in CRM (leads, stages, lead finders); campaigns: batch calling from it;
    # improvement: what the self-improvement loop may do on its own (off · propose: a person approves each
    # challenger and promotion · auto: verified wins are promoted automatically).
    'features': {'crm': False, 'campaigns': False, 'improvement': 'propose'},
}

IMPROVEMENT_MODES = ('off', 'propose', 'auto')

# Per workspace: (read at, settings).
_cache: dict[str, tuple[float, dict]] = {}


def clear_settings_cache() -> None:
    _cache.clear()


async def get_settings(db) -> dict[str, Any]:
    ws = workspace_id()
    hit = _cache.get(ws)
    if hit and time.monotonic() - hit[0] < 5:
        return hit[1]
    row = await db.one("select value from app_setting where key = 'framework'")
    stored = (row or {}).get('value') or {}
    v = {**copy.deepcopy(DEFAULT_SETTINGS), **stored}
    v['weights'] = {**DEFAULT_WEIGHTS, **(stored.get('weights') or {})}
    v['features'] = {**DEFAULT_SETTINGS['features'], **(stored.get('features') or {})}
    _cache[ws] = (time.monotonic(), v)
    return v


def _clamp(v: Any, lo: float, hi: float, d: float) -> float:
    return max(lo, min(hi, v)) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else d


async def update_settings(db, patch: dict[str, Any]) -> dict[str, Any]:
    cur = await get_settings(db)
    nxt = {**cur, **{k: v for k, v in patch.items() if k in DEFAULT_SETTINGS}}
    if isinstance(patch.get('weights'), dict):
        nxt['weights'] = dict(cur['weights'])
        for k in DIM_KEYS:
            w = patch['weights'].get(k)
            if isinstance(w, (int, float)) and not isinstance(w, bool) and math.isfinite(w):
                nxt['weights'][k] = max(0, min(100, w))
    else:
        nxt['weights'] = cur['weights']
    f = patch.get('features')
    nxt['features'] = dict(cur['features'])
    if isinstance(f, dict):
        for k in ('crm', 'campaigns'):
            if isinstance(f.get(k), bool):
                nxt['features'][k] = f[k]
        if f.get('improvement') in IMPROVEMENT_MODES:
            nxt['features']['improvement'] = f['improvement']
        if nxt['features']['campaigns'] and not nxt['features']['crm']:
            nxt['features']['crm'] = True  # campaigns call CRM leads
        # Switching a module on needs a plan that includes it (no-op without billing).
        from .. import billing
        for k in ('crm', 'campaigns'):
            if nxt['features'][k] and not cur['features'][k]:
                await billing.require_feature(db, k)
        if nxt['features']['improvement'] != 'off' and cur['features']['improvement'] != nxt['features']['improvement']:
            await billing.require_feature(db, 'improvement')
    nxt['reviewSampleRate'] = _clamp(nxt['reviewSampleRate'], 0, 1, cur['reviewSampleRate'])
    nxt['confidenceThreshold'] = _clamp(nxt['confidenceThreshold'], 0, 1, cur['confidenceThreshold'])
    nxt['minCellCalls'] = max(1, js_round(_clamp(nxt['minCellCalls'], 1, 1e9, cur['minCellCalls'])))
    for k in ('attributionDays', 'reservationAttributionDays', 'goodLine'):
        nxt[k] = _clamp(nxt[k], 0, 3650 if k != 'goodLine' else 100, cur[k])
    for k in ('retentionDays', 'costPerMinuteAed'):
        if nxt[k] is not None:
            nxt[k] = _clamp(nxt[k], 0, 1e9, cur[k])
    await db.query(
        "insert into app_setting (key, value, updated_at) values ('framework', $1::jsonb, now()) on conflict (workspace_id, key) do update set value = excluded.value, updated_at = now()",
        [js_json(nxt)],
    )
    clear_settings_cache()
    return await get_settings(db)


async def get_kv(db, key: str) -> Any:
    row = await db.one('select value from app_setting where key = $1', [key])
    return row['value'] if row else None


async def set_kv(db, key: str, value: Any) -> None:
    await db.query(
        'insert into app_setting (key, value, updated_at) values ($1, $2::jsonb, now()) on conflict (workspace_id, key) do update set value = excluded.value, updated_at = now()',
        [key, js_json(value)],
    )
