# Demo mode: a realistic quarter of synthetic calls run through the real pipeline (heuristic judge,
# no API spend), plus CRM outcomes, reviewer labels, alerts, clusters and recommendations, so every
# screen has something real to show before a provider is connected.

from __future__ import annotations

import time

from ..alerts.engine import gate_alert, run_alert_rules
from ..analytics.clusters import run_clusters
from ..connectors.demo import demo_outcomes, generate_demo_calls
from ..crm.outcomes import upsert_outcomes
from ..framework import mulberry32
from ..js import js_json, js_str, now_ms, parse_date, to_ms
from ..lib.ids import new_id
from ..lib.log import log
from ..lib.settings import get_settings
from ..pipeline.evaluate import evaluate_call
from ..pipeline.ingest import store_canonical
from ..pipeline.judge.heuristic import heuristic
from ..pipeline.judge.types import JUDGED_METRICS
from ..pipeline.store import store_evaluation
from ..recommendations.engine import generate_recommendations, update_recommendation, verify_shipped

JUDGED_METRIC_KEYS = [m['key'] for m in JUDGED_METRICS]


async def seed_demo(db, *, count: int = 5000, days: int = 90, seed: int | None = None) -> dict:
    t0 = time.monotonic()
    settings = await get_settings(db)
    calls = generate_demo_calls(count=count, days=days, seed=42 if seed is None else seed)
    scored: list[dict] = []
    for i, c in enumerate(calls):
        call_id = await store_canonical(db, c, None, integration_id=None, source='demo', keep_raw=False)
        r = await evaluate_call(c, call_id=call_id, judge=heuristic, settings=settings)
        ev = r['evaluation']
        await store_evaluation(db, c, ev, r['runs'], r['summary'])
        scored.append({'leadId': c.get('leadId'), 'startedAt': c['startedAt'], 'nextStep': ev['outcome']['nextStep'], 'meetingKind': ev['outcome']['meetingKind'],
                       'persona': ev['tags']['persona']['value'], 'cqs': ev['cqs'], 'callId': call_id, 'gated': any(g['failed'] for g in ev['gates']),
                       'truth': {'p': str(c['dynamicVariables']['demo_persona']), 's': str(c['dynamicVariables']['demo_scenario'])}})
        if (i + 1) % 500 == 0:
            log.info('demo seed progress', {'done': i + 1, 'of': len(calls)})

    # CRM outcomes credited to the calls that preceded them.
    outcomes = demo_outcomes(scored)
    crm = await upsert_outcomes(db, outcomes, 'demo-crm')

    # Two reviewers label a sample, as the rollout's first phase asks: persona, scenario and judged metrics.
    rnd = mulberry32(7)
    sample = [s for s in scored if rnd() < 0.05][:150]
    for s in sample:
        items = await db.query("select id, kind, tag_key, current_value from review_item where call_id = $1 and status = 'open'", [s['callId']])
        await db.query("insert into review_label (id, call_id, reviewer, key, value) values ($1,$2,'reviewer-a','persona',$3), ($4,$2,'reviewer-a','scenario_primary',$5)",
                       [new_id('lbl'), s['callId'], s['truth']['p'], new_id('lbl'), s['truth']['s']])
        if rnd() < 0.5:
            p2 = s['truth']['p'] if rnd() < 0.9 else 'P6'
            s2 = s['truth']['s'] if rnd() < 0.88 else 'S8'
            await db.query("insert into review_label (id, call_id, reviewer, key, value) values ($1,$2,'reviewer-b','persona',$3), ($4,$2,'reviewer-b','scenario_primary',$5)",
                           [new_id('lbl'), s['callId'], p2, new_id('lbl'), s2])
        for it in [x for x in items if x['kind'] in ('tag', 'sample')]:
            key = it['tag_key'] or 'persona'
            value = s['truth']['p'] if key == 'persona' else s['truth']['s'] if key == 'scenario_primary' else it['current_value']
            model_value = it['current_value'] if it['current_value'] is not None else (s['persona'] if key == 'persona' else None)
            await db.query("update review_item set status = 'done', resolved_at = now(), resolution = $2::jsonb where id = $1",
                           [it['id'], js_json({'value': value, 'reviewer': 'reviewer-a', 'modelValue': model_value})])

    # Judged metrics: reviewers score a balanced sample (half failing, half passing) per metric, so
    # agreement is measured where the judge has to discriminate. Some metrics agree less, as in practice.
    looser = {'er', 'econ', 'rga', 'oh'}
    for key in JUDGED_METRIC_KEYS:
        rows = await db.query(
            """(select call_id, value from metric_result where metric_key = $1 and applicable and value < 50 order by md5(call_id) limit 25)
               union all (select call_id, value from metric_result where metric_key = $1 and applicable and value >= 50 order by md5(call_id) limit 25)""", [key])
        for m in rows:
            agree = rnd() < (0.8 if key in looser else 0.93)
            v = float(m['value']) if agree else (30 if float(m['value']) >= 50 else 80)
            await db.query("insert into review_label (id, call_id, reviewer, key, value) values ($1,$2,'reviewer-a',$3,$4)", [new_id('lbl'), m['call_id'], f'metric:{key}', js_str(v)])

    # Alerts over the last three weeks, gate alerts for the last week.
    for s in scored:
        if s['gated'] and now_ms() - to_ms(parse_date(s['startedAt'])) < 7 * 86_400_000:
            await gate_alert(db, s['callId'])
    await run_alert_rules(db, 21)
    await db.query("update alert set acked = true, acked_at = now() where fired_at < now() - interval '5 days'")

    await run_clusters(db)
    rec = await generate_recommendations(db, use_llm=False)

    # Close the loop: v3 shipped the fix for the metric that improved most from v2, and the version
    # report verifies it; the top open item is accepted for the next prompt.
    recs = await db.query(
        "select id, baseline->'key' as key from recommendation where status = 'proposed' and (baseline->'key' ? 'metric' or baseline->'key' ? 'gate') order by priority desc")
    gains = await db.query(
        """select m.metric_key as k, avg(m.value) filter (where c.prompt_version = 'v3') - avg(m.value) filter (where c.prompt_version = 'v2') as d
           from metric_result m join calls c on c.call_id = m.call_id where m.applicable and m.value is not null group by 1""")

    def gain(r: dict) -> float:
        k = (r.get('key') or {}).get('metric')
        g = next((x for x in gains if x['k'] == k), None)
        return float(g['d']) if g and g['d'] is not None else -1e9

    for r in sorted([x for x in recs if (x.get('key') or {}).get('metric') and gain(x) > 0], key=lambda x: -gain(x))[:5]:
        await db.query("""update recommendation set status = 'in_prompt', target_version = 'v3', baseline = jsonb_set(coalesce(baseline, '{}'::jsonb), '{version}', '"v2"') where id = $1""", [r['id']])
        if await verify_shipped(db):
            break
        await db.query("update recommendation set status = 'proposed', target_version = null, note = null where id = $1", [r['id']])
    top = await db.one("select id from recommendation where status = 'proposed' order by priority desc limit 1")
    if top:
        await update_recommendation(db, top['id'], {'status': 'accepted', 'note': 'Planned for the next prompt release.'})
    elapsed = round(time.monotonic() - t0)
    log.info('demo seed done', {'calls': len(calls), 'outcomes': crm['imported'], 'recommendations': rec['created'], 'seconds': elapsed})
    return {'calls': len(calls), 'outcomes': crm['imported'], 'credited': crm['credited'], 'recommendations': rec['created'], 'seconds': elapsed}
