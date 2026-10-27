# Human review: low-confidence tags, every gated call, and a random sample. Reviewer decisions
# override the classifier, feed agreement and classifier-match figures, and re-score the call.

from __future__ import annotations

from typing import Any

from ..taxonomy import persona_by_id, scenario_by_id
from ..jobs.queue import enqueue
from ..js import iso, js_json, js_number, js_str
from ..lib.errors import http_error
from ..lib.ids import new_id


def _describe(key: str | None, v: str | None) -> str | None:
    if not v:
        return v
    if key == 'persona':
        return f"{v} {persona_by_id(v)['name']}"
    if key is not None and key.startswith('scenario'):
        sc = scenario_by_id(v)
        return f"{v} {sc['name'] if sc else ''}".strip()
    return v


async def list_review(db, *, status: str | None = None, kind: str | None = None, call_id: str | None = None, limit: int | None = None) -> list[dict]:
    conds: list[str] = []
    params: list[Any] = []
    if status and status != 'all':
        params.append(status)
        conds.append(f'r.status = ${len(params)}')
    if kind:
        params.append(kind)
        conds.append(f'r.kind = ${len(params)}')
    if call_id:
        params.append(call_id)
        conds.append(f'r.call_id = ${len(params)}')
    rows = await db.query(
        f"""select r.*, c.persona, c.scenario from review_item r left join calls c on c.call_id = r.call_id
     {f"where {' and '.join(conds)}" if conds else ''}
     order by case r.kind when 'gate' then 0 when 'tag' then 1 else 2 end, r.created_at desc limit {min(500, limit if limit is not None else 200)}""",
        params,
    )
    out = []
    for r in rows:
        p, sc = persona_by_id(r['persona']), scenario_by_id(r['scenario'])
        out.append({
            'id': r['id'], 'callId': r['call_id'], 'kind': r['kind'], 'tagKey': r['tag_key'], 'reason': r['reason'], 'status': r['status'],
            'currentValue': _describe(r['tag_key'], r['current_value']), 'confidence': None if r['confidence'] is None else js_number(r['confidence']),
            'createdAt': iso(r['created_at']), 'resolvedAt': iso(r['resolved_at']), 'resolution': r['resolution'],
            'title': f"{p['id']} {p['name']}{f' × {r['scenario']} {sc['name']}' if sc else ''}",
        })
    return out


async def resolve_review(db, id: str, body: dict[str, Any], reviewer: str = 'console') -> dict:
    item = await db.one('select * from review_item where id = $1', [id])
    if not item:
        raise http_error(404, 'Review item not found')
    if item['status'] == 'done':
        # Resolving twice would add a second set of labels and skew reviewer agreement.
        raise http_error(409, 'This review item is already resolved')
    labels: list[list[Any]] = []
    if item['kind'] == 'gate' and isinstance(body.get('gateConfirmed'), bool):
        for g in [x for x in str(item['current_value'] if item['current_value'] is not None else '').split(',') if x]:
            labels.append([f'gate:{g}', 'confirmed' if body['gateConfirmed'] else 'overturned'])
    elif item['kind'] == 'metric' and body.get('value') is not None:
        labels.append([f"metric:{js_str(item['tag_key'])}", body['value'] if isinstance(body['value'], str) else js_str(body['value'])])
    elif 'value' in body:
        labels.append([item['tag_key'] if item['tag_key'] is not None else 'persona', body['value'] if body['value'] is not None else 'none'])
    # Keep the model's value next to the reviewer's so classifier-vs-reviewer match can be measured.
    tag_key = None if item['kind'] in ('gate', 'metric') else (item['tag_key'] if item['tag_key'] is not None else 'persona')
    model_value = None
    if tag_key:
        model_value = item['current_value']
        if model_value is None:
            row = await db.one('select value from call_tag where call_id = $1 and tag_key = $2', [item['call_id'], tag_key])
            model_value = row['value'] if row else None

    async def body_tx(t) -> None:
        for key, value in labels:
            await t.query('insert into review_label (id, call_id, reviewer, key, value) values ($1,$2,$3,$4,$5)',
                          [new_id('lbl'), item['call_id'], reviewer, key, value if isinstance(value, str) else js_str(value)])
        await t.query("update review_item set status = 'done', resolved_at = now(), resolution = $2::jsonb where id = $1",
                      [id, js_json({**body, 'reviewer': reviewer, **({'modelValue': model_value} if tag_key else {})})])

    await db.tx(body_tx)
    # A changed tag or an overturned gate changes what applies to the call, so it is scored again.
    pv = model_value if model_value is not None else item['current_value'] if item['current_value'] is not None else ''
    prev = pv if isinstance(pv, str) else js_str(pv)
    changed = any((v == 'overturned') if k.startswith('gate:') else (not k.startswith('metric:') and v != prev) for k, v in labels)
    if changed:
        await enqueue(db, 'evaluate_call', {'callId': item['call_id'], 'reason': 'human review'}, dedupe_key=f"eval:{item['call_id']}", priority=5)
    return {'ok': True, 'reevaluating': changed}


async def human_overrides(db, call_id: str) -> dict:
    """The latest human label per key for a call, as overrides for the pipeline."""
    rows = await db.query('select distinct on (key) key, value from review_label where call_id = $1 order by key, created_at desc', [call_id])
    out: dict[str, Any] = {'tags': {}, 'answerKey': None, 'gates': {}}
    for r in rows:
        if r['key'].startswith('gate:'):
            out['gates'][r['key'][5:]] = r['value'] == 'confirmed'
        elif r['key'].startswith('field:'):
            if out['answerKey'] is None:
                out['answerKey'] = {}
            out['answerKey'][r['key'][6:]] = r['value']
        elif not r['key'].startswith('metric:') and r['value'] != 'none':
            out['tags'][r['key']] = r['value']
    return out
