# Taxonomy health: whether personas and scenarios still describe the calls. Unclassified and Other
# share, classifier confidence, reviewer agreement, classifier-vs-reviewer match, and clusters.

from __future__ import annotations

from datetime import timedelta

from ..framework import TAXONOMY_VERSION, cohens_kappa
from ..js import day_month_gb, fixed, iso, js_number
from ..lib.settings import get_settings
from ..pipeline.judge.types import JUDGED_METRICS
from ..taxonomy import current

BINS = ['0.3', '0.4', '0.5', '0.6', '0.7', '0.8', '0.9']


async def taxonomy_health(db) -> dict:
    settings = await get_settings(db)
    thr = settings['confidenceThreshold']

    # Weekly Unclassified (P0 or a model tag under the confidence line) and Other (personas based on P11) share.
    weeks = await db.query(
        """select date_trunc('week', c.started_at) as week, count(*)::int as n,
       count(*) filter (where c.persona = 'P0' or exists (select 1 from call_tag t where t.call_id = c.call_id and t.tag_key in ('persona','scenario_primary') and t.layer in ('classifier','heuristic') and t.confidence < $1))::int as unc,
       count(*) filter (where c.persona = any($2::text[]))::int as oth
     from calls c where c.status = 'scored' and c.started_at > now() - interval '8 weeks'
     group by 1 order by 1""",
        [thr, current().ids_based_on('persona', ('P11',))],
    )

    conf = {'persona': [0 for _ in BINS], 'scenario': [0 for _ in BINS], 'intent': [0 for _ in BINS]}
    conf_rows = await db.query(
        """select t.tag_key as k, least(6, greatest(0, floor(t.confidence * 10)::int - 3)) as bin, count(*)::int as n
     from call_tag t join calls c on c.call_id = t.call_id
     where t.tag_key in ('persona','scenario_primary','intent_end') and t.layer in ('classifier','heuristic') and c.started_at > now() - interval '30 days'
     group by 1, 2""",
    )
    for r in conf_rows:
        key = 'persona' if r['k'] == 'persona' else 'scenario' if r['k'] == 'scenario_primary' else 'intent'
        conf[key][int(r['bin'])] += r['n']

    # Judge vs reviewer agreement per judged metric (pass at 50 or above).
    labels = await db.query('select call_id, key, value, reviewer from review_label')
    metric_vals = await db.query(
        "select m.call_id, m.metric_key, m.value from metric_result m where m.call_id in (select distinct call_id from review_label where key like 'metric:%')",
    )
    first_val: dict[tuple[str, str], dict] = {}
    for v in metric_vals:
        first_val.setdefault((v['call_id'], v['metric_key']), v)
    kappa = []
    for m in JUDGED_METRICS:
        pairs = []
        for lb in labels:
            if lb['key'] != f"metric:{m['key']}":
                continue
            j = first_val.get((lb['call_id'], m['key']))
            if not j or j['value'] is None:
                continue
            pairs.append(['pass' if js_number(j['value']) >= 50 else 'fail', 'pass' if js_number(lb['value']) >= 50 else 'fail'])
        # Kappa is undefined when the sample has no variation (every call passed); report it as not measured.
        varied = len({p[0] for p in pairs}) > 1 or len({p[1] for p in pairs}) > 1
        k = cohens_kappa(pairs) if varied else None
        kappa.append({'name': m['name'].replace(' (counts twice)', '', 1), 'v': None if k is None else fixed(k, 2), 'n': len(pairs)})

    # Reviewer agreement: two different reviewers on the same call and tag.
    def agreement(key: str) -> dict:
        by: dict[str, list] = {}
        for lb in labels:
            if lb['key'] == key:
                by.setdefault(lb['call_id'], []).append(lb)
        pairs = []
        for ls in by.values():
            a = ls[0]
            b = next((x for x in ls if x['reviewer'] != a['reviewer']), None)
            if b:
                pairs.append([a['value'], b['value']])
        return {'k': cohens_kappa(pairs), 'n': len(pairs)}

    ap, as_ = agreement('persona'), agreement('scenario_primary')

    # Classifier vs reviewer: resolved review items record the model's value next to the reviewer's.
    resolved = await db.query("select tag_key, resolution from review_item where status = 'done' and resolution ? 'modelValue'")

    def match(key: str) -> dict:
        rs = [r for r in resolved if (r['tag_key'] if r['tag_key'] is not None else 'persona') == key and r['resolution'] and r['resolution'].get('value')]
        if not rs:
            return {'v': None, 'n': 0}
        return {'v': len([r for r in rs if r['resolution']['value'] == r['resolution'].get('modelValue')]) / len(rs), 'n': len(rs)}

    mp, ms = match('persona'), match('scenario_primary')

    queue = await db.one(
        "select count(*)::int as open, count(*) filter (where kind = 'tag')::int as low, count(*) filter (where kind = 'sample')::int as sample from review_item where status = 'open'",
    )
    clusters = await db.query('select * from cluster order by size desc')
    versions = await db.query('select * from taxonomy_version order by created_at')
    last_run = await db.one('select max(run_at) as t from cluster')
    return {
        'version': next((v['version'] for v in versions if v['status'] == 'active'), TAXONOMY_VERSION),
        'lastClusterRun': iso(last_run['t'] if last_run else None),
        'weeks': [{'week': day_month_gb(w['week'] + timedelta(days=6)), 'unc': fixed((w['unc'] / w['n']) * 100, 1) if w['n'] else 0,
                   'oth': fixed((w['oth'] / w['n']) * 100, 1) if w['n'] else 0} for w in weeks],
        'confBins': BINS,
        'conf': conf,
        'kappa': kappa,
        'agreement': {'persona': None if ap['k'] is None else fixed(ap['k'], 2), 'scenario': None if as_['k'] is None else fixed(as_['k'], 2), 'n': ap['n'] + as_['n']},
        'classifierMatch': {'persona': None if mp['v'] is None else fixed(mp['v'], 2), 'scenario': None if ms['v'] is None else fixed(ms['v'], 2), 'n': mp['n'] + ms['n']},
        'reviewQueue': {'open': (queue or {}).get('open') or 0, 'lowConfidence': (queue or {}).get('low') or 0, 'sample': (queue or {}).get('sample') or 0},
        'clusters': [{'id': c['id'], 'label': c['label'], 'size': c['size'], 'nearest': c['nearest'] if c['nearest'] is not None else '—', 'proposed': bool(c['proposed'])} for c in clusters],
        'versions': [{'version': v['version'], 'status': v['status'], 'approvedAt': iso(v['approved_at']), 'notes': v['notes']} for v in versions],
    }
