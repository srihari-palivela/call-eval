# Reference data for the console: taxonomy, metrics, prompt versions, agents, data mode, settings.

from __future__ import annotations

from ..config import config, llm_enabled
from ..framework import DIMS, FRAMEWORK_VERSION, GATES, METRICS
from ..js import at, iso
from ..lib.settings import get_settings
from ..taxonomy import current
from ..taxonomy.store import seed
from .filters import versions


async def meta(db) -> dict:
    settings = await get_settings(db)
    vs = await versions(db, 'all')
    agents = await db.query('select id, name, provider, external_id from agent order by name')
    pv_agents = await db.query(
        'select distinct on (pv.label) pv.label, pv.agent_id, a.name from prompt_version pv left join agent a on a.id = pv.agent_id order by pv.label, pv.first_seen_at',
    )
    totals = await db.one(
        """select count(*)::int as calls, count(*) filter (where status = 'scored')::int as scored, max(started_at) as last,
       count(*) filter (where source <> 'demo')::int as live, count(*) filter (where source = 'demo')::int as demo from calls""",
    )
    tax = current()
    live = vs[-1]['label'] if vs else None

    def pv(label: str) -> dict | None:
        return next((p for p in pv_agents if p['label'] == label), None)

    prev = at(vs, len(vs) - 2)
    return {
        'personas': tax.personas, 'p0': tax.p0, 'scenarios': tax.scenarios, 'dims': DIMS,
        'metrics': [{k: v for k, v in m.items() if k != 'rubric'} for m in METRICS], 'gates': GATES, 'eventTypes': tax.events, 'facets': tax.facets,
        'taxonomyVersion': tax.version, 'frameworkVersion': FRAMEWORK_VERSION, 'weights': settings['weights'],
        'promptVersions': [{
            'label': v['label'], 'agentId': (pv(v['label']) or {}).get('agent_id'), 'agentName': (pv(v['label']) or {}).get('name'),
            'firstSeen': iso(v['firstSeen']), 'lastSeen': iso(v['lastSeen']), 'calls': v['calls'], 'live': v['label'] == live,
        } for v in vs],
        'liveVersion': live, 'previousVersion': prev['label'] if prev else None,
        'agents': [{'id': a['id'], 'name': a['name'] if a['name'] is not None else a['external_id'], 'provider': a['provider'], 'externalId': a['external_id']} for a in agents],
        'dataMode': 'live' if (totals or {}).get('live', 0) > 0 else 'demo' if (totals or {}).get('demo', 0) > 0 else 'empty',
        'llm': {'enabled': llm_enabled(), 'model': config.llm.model if llm_enabled() else None},
        'audioModel': {'enabled': bool(config.audio_model_url)},
        'totals': {'calls': (totals or {}).get('calls', 0), 'scored': (totals or {}).get('scored', 0), 'lastCallAt': iso((totals or {}).get('last'))},
        'settings': settings,
    }


async def seed_taxonomy(db) -> None:
    """Taxonomy v1.0 rows, seeded once so versions can be added alongside it."""
    await seed(db)
