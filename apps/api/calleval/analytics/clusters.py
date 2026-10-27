# Monthly clustering of calls the taxonomy doesn't describe well (Other, Unclassified, low-confidence,
# out-of-scope), to surface journeys nobody has named yet. With a Claude key the summaries are
# grouped by meaning; without one, recurring caller phrases stand in for themes.

from __future__ import annotations

import json

import anthropic
from pydantic import BaseModel

from ..config import config, llm_enabled
from ..js import at, js_json, jsre, test
from ..lib.ids import new_id
from ..lib.log import err_msg, log
from ..lib.settings import get_settings
from ..taxonomy import current, persona_by_id, scenario_by_id

STOP = set('the a an and or but to of in on for with is it i you we my me your this that be are was do can what how about just so if not no yes okay ok there have has like would could should will from at by as they them our us its im dont thats want looking call calling get know thanks thank please much sure really actually also some more then than here when where which who whom whose does done tell need right good great fine well maybe think said told again still into over very many much bedrooms bedroom price prices'.split(' '))


async def _candidates(db) -> list[dict]:
    s = await get_settings(db)
    tax = current()
    # Unclassified, Other and Out of scope: the personas and scenarios based on P11 and S11 in any version.
    return await db.query(
        """select c.call_id, c.persona, c.scenario, (select value from call_tag t where t.call_id = c.call_id and t.tag_key = 'summary') as summary, c.canonical
     from calls c where c.status = 'scored' and c.started_at > now() - interval '30 days' and (
       c.persona = 'P0' or c.persona = any($2::text[]) or c.scenario = any($3::text[])
       or exists (select 1 from call_tag t where t.call_id = c.call_id and t.tag_key in ('persona','scenario_primary') and t.layer in ('classifier','heuristic') and t.confidence < $1)
       or exists (select 1 from call_event e where e.call_id = c.call_id and e.type = 'off_topic_request'))
     order by c.started_at desc limit 400""",
        [s['confidenceThreshold'], tax.ids_based_on('persona', ('P11',)), tax.ids_based_on('scenario', ('S11',))],
    )


# Themes the v1 taxonomy folds into Other or Out of scope. Without a Claude key these known themes
# are counted; with one, the summaries are grouped by meaning and new themes surface on their own.
THEMES = [
    {'label': 'Golden visa eligibility through a purchase', 'rx': jsre(r'\bgolden visa\b', 'i')},
    {'label': 'Reselling an off-plan unit before handover', 'rx': jsre(r'\bresell|re-sell|sell (it|my unit) before handover\b', 'i')},
    {'label': 'Payment plan changes for an existing buyer', 'rx': jsre(r'\b(change|move|defer|reschedule) (my|the) (payment plan|instalment|installment)\b|\bnext instalment\b', 'i')},
    {'label': 'Mortgage pre-approval timing', 'rx': jsre(r'\bmortgage|pre-?approval|non-resident.{0,20}loan\b', 'i')},
    {'label': 'Caller switches language mid-call', 'rx': jsre(r'\b(arabic|hindi|urdu|russian|french)\b|^(marhaba|shukran|ahlan)', 'i')},
]


def _caller_text(c: dict) -> str:
    return ' '.join(t['text'] for t in ((c.get('canonical') or {}).get('turns') or []) if t.get('speaker') == 'caller')


def phrase_clusters(cands: list[dict]) -> list[dict]:
    out = []
    used: set[str] = set()
    for th in THEMES:
        ids = [c['call_id'] for c in cands if c['call_id'] not in used and test(th['rx'], _caller_text(c))]
        if len(ids) >= 5:
            out.append({'label': th['label'], 'ids': ids})
            used.update(ids)
    return out


class _Cluster(BaseModel):
    label: str
    members: list[int]
    nearest_tag: str


class _Clusters(BaseModel):
    clusters: list[_Cluster]


async def _llm_clusters(cands: list[dict]) -> list[dict]:
    client = anthropic.AsyncAnthropic(max_retries=2)
    lines = '\n'.join(f"{i}\t{c['persona'] if c['persona'] is not None else 'P0'}/{c['scenario'] if c['scenario'] is not None else '-'}\t{(c['summary'] or '')[:200]}" for i, c in enumerate(cands))
    schema = {
        'type': 'object', 'additionalProperties': False, 'required': ['clusters'],
        'properties': {'clusters': {'type': 'array', 'items': {'type': 'object', 'additionalProperties': False, 'required': ['label', 'members', 'nearest_tag'],
                                                              'properties': {'label': {'type': 'string'}, 'members': {'type': 'array', 'items': {'type': 'integer'}}, 'nearest_tag': {'type': 'string'}}}}},
    }
    taxonomy = '; '.join([*[f"{p['id']} {p['name']}" for p in current().personas], *[f"{s['id']} {s['name']}" for s in current().scenarios]])
    params = dict(
        model=config.llm.model, max_tokens=16000,
        system='You maintain the call taxonomy for an AI voice sales agent selling off-plan property in Dubai. Group call summaries into themes the current taxonomy does not name yet. Ignore themes the taxonomy already covers well.',
        messages=[{'role': 'user', 'content': f'Current taxonomy: {taxonomy}\n\nSummaries (index, current tags, summary):\n{lines}\n\nReturn up to 8 clusters of at least 5 calls each: a short label for the shared need, the member indexes, and the nearest existing tag id.'}],
        output_config={'effort': 'medium', 'format': {'type': 'json_schema', 'schema': schema}},
    )
    try:
        msg = await (client.beta.messages.create(**params, betas=['server-side-fallback-2026-07-01'], fallbacks='default') if config.llm.fallbacks
                     else client.beta.messages.create(**params))
    except anthropic.BadRequestError as e:
        # Some deployments (gateways, other platforms) reject the fallbacks parameter; retry once without it.
        if config.llm.fallbacks and 'fallback' in str(e).lower():
            msg = await client.beta.messages.create(**params)
        else:
            raise
    if msg.stop_reason == 'refusal':
        raise RuntimeError('Claude declined to cluster these calls')
    text = ''.join(b.text for b in msg.content if b.type == 'text')
    o = _Clusters.model_validate(json.loads(text))
    return [{'label': c.label, 'ids': [cands[i]['call_id'] for i in c.members if at(cands, i)], 'nearest': c.nearest_tag} for c in o.clusters]


async def run_clusters(db) -> dict:
    cands = await _candidates(db)
    if len(cands) < 5:
        return {'clusters': 0, 'candidates': len(cands)}
    clusters: list[dict] = []
    if llm_enabled():
        try:
            clusters = await _llm_clusters(cands)
        except Exception as e:  # noqa: BLE001 - the phrase clusters stand in
            log.warn('LLM clustering failed; using phrase clusters', {'error': err_msg(e)})
    if not clusters:
        clusters = phrase_clusters(cands)
    proposed = {r['label'].lower() for r in await db.query('select label from cluster where proposed')}

    async def body(t) -> None:
        await t.query('delete from cluster where not proposed')
        for c in clusters:
            if c['label'].lower() in proposed:
                continue
            members = [x for x in cands if x['call_id'] in c['ids']]
            near = c.get('nearest')
            if near is None:
                counts: dict[str, int] = {}
                for m in members:
                    k = m['scenario'] if current().basis(m['scenario']) == 'S11' or not m['persona'] else m['persona']
                    if k:  # a member with neither tag says nothing about the nearest one
                        counts[k] = counts.get(k, 0) + 1
                top = sorted(counts.items(), key=lambda kv: -kv[1])
                near = top[0][0] if top else '—'
            if near.startswith('S'):
                sc = scenario_by_id(near)
                near_label = f"{near} {sc['name'] if sc else ''}"
            elif near.startswith('P'):
                near_label = f"{near} {persona_by_id(near)['name']}"
            else:
                near_label = near
            await t.query('insert into cluster (id, label, size, nearest, call_ids) values ($1,$2,$3,$4,$5::jsonb)',
                          [new_id('cl'), c['label'], len(c['ids']), near_label, js_json(c['ids'][:50])])

    await db.tx(body)
    return {'clusters': len(clusters), 'candidates': len(cands)}
