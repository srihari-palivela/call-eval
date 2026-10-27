# Improvement recommendations: the framework's output. Findings come from compliance gates, metrics
# below the line, the fix-first cells, routing (non-target share) and taxonomy drift. Each finding is
# sized by impact (calls × points below the line), backed by quoted evidence turns, and turned into a
# concrete change — a prompt rule, a tool change, a routing fix or a new tag. With a Claude key the
# change is written against the agent's actual prompt. A shipped fix is verified when the next prompt
# version measurably moves the metric it targeted.

from __future__ import annotations

import json
import re
from typing import Any, Literal

import anthropic
from pydantic import BaseModel

from ..analytics.filters import resolve_version, version_pairs_sql
from ..analytics.matrix import fix_map
from ..config import config, llm_enabled
from ..framework import DIMS, GATES, METRICS, bootstrap_median_diff, gate_by_id, median, metric_by_key
from ..js import at, fixed, iso, js_json, js_number, js_round, js_str, now_ms, to_fixed
from ..lib.errors import http_error
from ..lib.ids import new_id, sha
from ..lib.log import err_msg, log
from ..lib.settings import get_settings
from ..taxonomy import current, persona_by_id, scenario_by_id
from .playbook import PLAYBOOK


def _scope_label(scope: str, key: str | None) -> str:
    if not key:
        return 'all calls'
    if scope == 'persona':
        return f"{key} {persona_by_id(key)['name']}"
    if scope == 'scenario':
        sc = scenario_by_id(key)
        return f"{key} {sc['name'] if sc else ''}"
    if scope == 'cell':
        p, s = (key.split('|') + [None])[:2]
        sc = scenario_by_id(s)
        return f"{p} {persona_by_id(p)['name']} × {js_str(s) if s is not None else 'undefined'} {sc['name'] if sc else ''}"
    return key


async def _quote_evidence(db, rows: list[dict]) -> list[dict]:
    out = []
    for r in rows:
        c = await db.one('select canonical from calls where call_id = $1', [r['call_id']])
        turns = ((c or {}).get('canonical') or {}).get('turns') if c else None
        t = at(turns, r['turn']) if r['turn'] is not None and turns is not None else None
        out.append({'callId': r['call_id'], 'turn': r['turn'], 'quote': t['text'][:280] if t else None, 'metric': r.get('metric')})
    return out


async def collect_findings(db, *, range_days: float, agent: str) -> dict:
    settings = await get_settings(db)
    line = settings['goodLine']
    ver = await resolve_version(db, 'live', agent)
    params: list[Any] = [iso(int(now_ms() - range_days * 86_400_000))]

    def p(v: Any) -> str:
        params.append(v)
        return f'${len(params)}'

    where = "c.status = 'scored' and c.started_at > $1"
    if ver.get('perAgent'):
        where += f" and {version_pairs_sql(ver['perAgent'], p)}"
    elif ver['label']:
        params.append(ver['label'])
        where += f' and c.prompt_version = ${len(params)}'
    if agent != 'all':
        params.append(agent)
        where += f' and c.agent_id = ${len(params)}'
    total_row = await db.one(f'select count(*)::int as n from calls c where {where}', params)
    total = total_row['n'] if total_row else 0
    findings: list[dict] = []
    if not total:
        return {'findings': findings, 'version': ver['label'], 'calls': 0}

    # 1. Compliance gates: every failure caps a call at 40 and goes to human review.
    gate_rows = await db.query(
        f"""select g->>'id' as id, c.call_id, nullif(g->>'turn','')::int as turn, g->>'detail' as detail, s.raw_cqs as raw, c.persona as pid, c.scenario as sid
     from calls c join call_score s on s.call_id = c.call_id, jsonb_array_elements(s.gates) g where {where}""",
        params,
    )
    for g in GATES:
        rows = [r for r in gate_rows if r['id'] == g['id']]
        if not rows:
            continue
        by_scen: dict[Any, int] = {}
        for r in rows:
            by_scen[r['sid']] = by_scen.get(r['sid'], 0) + 1
        top_scen, top_n = sorted(by_scen.items(), key=lambda kv: -kv[1])[0]
        concentrated = len(rows) >= 3 and top_n / len(rows) >= 0.6
        pb = PLAYBOOK[g['id']]
        lost = sum(max(0, js_number(r['raw']) - 40) for r in rows)
        n = len(rows)
        findings.append({
            'fingerprint': sha(f"gate|{g['id']}"), 'scope': 'scenario' if concentrated else 'global', 'scopeKey': top_scen if concentrated else None, 'kind': pb['kind'],
            'title': pb['title'],
            'problem': f"{re.sub(r'\.$', '', g['text'], count=1)} on {n} call{'s' if n > 1 else ''} ({to_fixed((n / total) * 100, 1)}% of {total}){f', mostly in {_scope_label('scenario', top_scen)}' if concentrated else ''}. Each one caps the call at 40 and sends it to human review.",
            'proposal': pb['fix'], 'promptPatch': f"Add to the prompt's compliance rules:\n{pb['promptRule']}" if pb.get('promptRule') else None,
            'evidence': await _quote_evidence(db, [{'call_id': r['call_id'], 'turn': r['turn'], 'metric': g['id']} for r in rows[:3]]),
            'metrics': [g['id']], 'impact': {'calls': n, 'pointsBelow': js_round(lost / n), 'score': js_round(lost), 'valueAtStake': None},
            'priority': 1000 + lost, 'baselineKey': {'gate': g['id']},
        })

    # 2. Metrics below the line, located to the persona, scenario or cell where the shortfall concentrates.
    mrows = await db.query(
        f"""select m.metric_key as k, c.persona as pid, c.scenario as sid, count(*)::int as n, count(*) filter (where m.value < ${len(params) + 1})::int as below,
       sum(greatest(0, ${len(params) + 1} - m.value)) as pts, avg(m.value) as avg
     from metric_result m join calls c on c.call_id = m.call_id where {where} and m.applicable and m.value is not null group by 1, 2, 3""",
        [*params, line],
    )
    dim_w = {d['key']: settings['weights'][d['key']] / 100 for d in DIMS}
    metric_findings: list[dict] = []
    for m in METRICS:
        rows = [r for r in mrows if r['k'] == m['key']]
        n = sum(r['n'] for r in rows)
        if n < 10 or not PLAYBOOK.get(m['key']):
            continue
        avg = sum(js_number(r['avg']) * r['n'] for r in rows) / n
        below = sum(r['below'] for r in rows)
        pts = sum(js_number(r['pts']) for r in rows)
        if avg >= line and below / n < 0.25:
            continue

        def share(key) -> dict | None:
            acc: dict[Any, float] = {}
            for r in rows:
                acc[key(r)] = acc.get(key(r), 0) + js_number(r['pts'])
            top = sorted(acc.items(), key=lambda kv: -kv[1])[0] if acc else None
            return {'key': top[0], 'share': top[1] / pts} if top and pts else None

        cell = share(lambda r: f"{js_str(r['pid'])}|{js_str(r['sid'])}")
        pers = share(lambda r: r['pid'])
        scen = share(lambda r: r['sid'])
        scope, scope_key = 'global', None
        if cell and cell['share'] >= 0.6:
            scope, scope_key = 'cell', cell['key']
        elif scen and scen['share'] >= 0.6:
            scope, scope_key = 'scenario', scen['key']
        elif pers and pers['share'] >= 0.6:
            scope, scope_key = 'persona', pers['key']
        pb = PLAYBOOK[m['key']]
        scope_sql = (f"and c.persona || '|' || c.scenario = ${len(params) + 3}" if scope == 'cell' else f'and c.scenario = ${len(params) + 3}' if scope == 'scenario'
                     else f'and c.persona = ${len(params) + 3}' if scope == 'persona' else '')
        worst = await db.query(
            f"""select m.call_id, m.evidence as ev from metric_result m join calls c on c.call_id = m.call_id
       where {where} and m.metric_key = ${len(params) + 1} and m.applicable and m.value < ${len(params) + 2}
       {scope_sql}
       order by m.value asc, c.started_at desc limit 3""",
            [*params, m['key'], line] if scope == 'global' else [*params, m['key'], line, scope_key],
        )
        score = pts * dim_w.get(m['dim'], 0.1) * m.get('weight', 1)
        dim = next(d for d in DIMS if d['key'] == m['dim'])
        metric_findings.append({
            'fingerprint': sha(f"metric|{m['key']}|{scope}|{'' if scope_key is None else js_str(scope_key)}"), 'scope': scope, 'scopeKey': scope_key, 'kind': pb['kind'], 'title': pb['title'],
            'problem': f"{m['name']} averages {js_round(avg)} (target {m['target']}) over {n} calls; {below} ({js_round((below / n) * 100)}%) fall below {js_str(line)}{f', concentrated in {_scope_label(scope, scope_key)}' if scope != 'global' else ''}. It sits in {dim['name']}, weight {js_str(settings['weights'][m['dim']])}.",
            'proposal': pb['fix'], 'promptPatch': f"Add to the prompt:\n{pb['promptRule']}" if pb.get('promptRule') else None,
            'evidence': await _quote_evidence(db, [{'call_id': w['call_id'], 'turn': at(w['ev'] or [], 0), 'metric': m['key']} for w in worst]),
            'metrics': [m['key']], 'impact': {'calls': below, 'pointsBelow': js_round(pts / max(1, below)), 'score': js_round(score), 'valueAtStake': None},
            'priority': score, 'baselineKey': {'metric': m['key']},
        })
    findings.extend(sorted(metric_findings, key=lambda f: -f['priority'])[:12])

    # 3. The fix-first cells: high value, handled badly.
    fix = await fix_map(db, {'range': js_str(range_days), 'agent': agent, 'vm': 'meet'})
    for c in fix['top5']:
        weak_dim = c['weak']['key']
        ms = sorted([r for r in mrows if r['pid'] == c['pid'] and r['sid'] == c['sid'] and (metric_by_key(r['k']) or {}).get('dim') == weak_dim and r['n'] >= 3],
                    key=lambda r: js_number(r['avg']))[:2]
        keys = [x['k'] for x in ms]
        fixes = ' '.join(f"{metric_by_key(k)['name']}: {(PLAYBOOK.get(k) or {}).get('fix', '')}" for k in keys)
        rules = [PLAYBOOK[k]['promptRule'] for k in keys if (PLAYBOOK.get(k) or {}).get('promptRule')]
        worst = await db.query(
            f"""select m.call_id, m.evidence as ev, m.metric_key as k from metric_result m join calls c on c.call_id = m.call_id
       where {where} and c.persona = ${len(params) + 1} and c.scenario = ${len(params) + 2} and m.metric_key = any(${len(params) + 3}::text[]) and m.applicable
       order by m.value asc limit 3""",
            [*params, c['pid'], c['sid'], keys if keys else ['__none__']],
        )
        driven = f", driven by {' and '.join(metric_by_key(k)['name'] for k in keys)}" if keys else ''
        findings.append({
            'fingerprint': sha(f"cell|{c['key']}|{weak_dim}"), 'scope': 'cell', 'scopeKey': c['key'],
            'kind': ((PLAYBOOK.get(keys[0]) or {}).get('kind') or 'prompt') if keys else 'prompt',
            'title': f"Fix first: {c['pid']} × {c['sid']} — {c['weak']['name'].lower()}",
            'problem': f"{_scope_label('cell', c['key'])} is high value (meeting-booked rate {to_fixed(c['meet'], 1)}% against a {to_fixed(fix['med'], 1)}% median) but handled badly: median CQS {js_str(c['cqs'])} over {js_str(c['n'])} calls, weakest dimension {c['weak']['name']} at {js_str(c['dims'][weak_dim])}{driven}.",
            'proposal': fixes or 'Review the lowest calls in this cell and the weakest dimension’s metrics.',
            'promptPatch': 'Add to the prompt:\n' + '\n'.join(rules) if rules else None,
            'evidence': await _quote_evidence(db, [{'call_id': w['call_id'], 'turn': at(w['ev'] or [], 0), 'metric': w['k']} for w in worst]),
            'metrics': keys,
            'impact': {'calls': c['n'], 'pointsBelow': max(0, settings['goodLine'] - c['cqs']), 'score': js_round(c['n'] * max(1, settings['goodLine'] - c['cqs'])),
                       'valueAtStake': fixed((c['n'] * c['meet']) / 100, 1)},
            'priority': 500 + c['depth'] * 100, 'baselineKey': {'cell': c['key']},
        })

    # 4. Routing: owners, renters and other non-buyers on the sales line.
    nt = await db.one(f"select count(*)::int as n from calls c where {where} and c.persona = any(${len(params) + 1}::text[])",
                      [*params, current().persona_ids_on_path('Non-target')])
    if nt and nt['n'] / total > 0.08:
        findings.append({
            'fingerprint': sha('routing|nontarget'), 'scope': 'global', 'scopeKey': None, 'kind': 'routing', 'title': 'Route non-buyers away from the sales line',
            'problem': f"{nt['n']} calls ({to_fixed((nt['n'] / total) * 100, 1)}%) were existing owners, renters or other non-buyers. This is usually a routing or marketing problem upstream, not an agent failure.",
            'proposal': 'Report the share to the team that owns each lead source (wrong numbers on ads, residents calling the sales line). Add an IVR option or a separate number for owners and renters; keep the agent’s short, polite redirect.',
            'promptPatch': None, 'evidence': [], 'metrics': [], 'impact': {'calls': nt['n'], 'pointsBelow': 0, 'score': nt['n'] * 5, 'valueAtStake': None}, 'priority': nt['n'] * 5, 'baselineKey': {},
        })

    # 5. Taxonomy: clusters big enough to become tags, and drift.
    clusters = await db.query('select id, label, size, nearest from cluster where size >= 20 and not proposed')
    for cl in clusters:
        findings.append({
            'fingerprint': sha(f"taxonomy|{cl['label'].lower()}"), 'scope': 'global', 'scopeKey': None, 'kind': 'taxonomy', 'title': f"New tag: {cl['label']}",
            'problem': f"{cl['size']} calls cluster around “{cl['label']}”, nearest existing tag {cl['nearest'] if cl['nearest'] is not None else 'none'}. Calls like these are counted as Other or forced into the nearest tag.",
            'proposal': 'Review the cluster with the taxonomy owner; if it is a distinct journey, add it in the next taxonomy version, write its expected path, and re-tag past calls so trends stay comparable.',
            'promptPatch': None, 'evidence': [], 'metrics': [], 'impact': {'calls': cl['size'], 'pointsBelow': 0, 'score': cl['size'] * 3, 'valueAtStake': None}, 'priority': cl['size'] * 3, 'baselineKey': {},
        })
    return {'findings': findings, 'version': ver['label'], 'calls': total}


# ---------- LLM tailoring ----------

_TAILOR_SCHEMA = {
    'type': 'object', 'additionalProperties': False,
    'required': ['title', 'problem', 'proposal', 'patch_mode', 'patch_section', 'patch_before', 'patch_after', 'expected_effect'],
    'properties': {
        'title': {'type': 'string', 'description': 'Imperative, under 10 words.'},
        'problem': {'type': 'string', 'description': 'What goes wrong and how often, in two sentences, citing the numbers given.'},
        'proposal': {'type': 'string', 'description': 'The change to make, concrete enough to implement today. Name the tool, prompt section or setting.'},
        'patch_mode': {'type': 'string', 'enum': ['add', 'replace', 'none']},
        'patch_section': {'type': 'string', 'description': 'Heading or rule in the current prompt the patch belongs to; empty if none.'},
        'patch_before': {'type': 'string', 'description': 'For replace: the exact current prompt text to replace. Empty otherwise.'},
        'patch_after': {'type': 'string', 'description': 'The new prompt text to add or to replace it with. Empty for none.'},
        'expected_effect': {'type': 'string', 'description': 'Which metric or cell should move, and how the next version report will show it.'},
    },
}


class _Tailor(BaseModel):
    title: str
    problem: str
    proposal: str
    patch_mode: Literal['add', 'replace', 'none']
    patch_section: str
    patch_before: str
    patch_after: str
    expected_effect: str


async def _tailor(f: dict, prompt: str | None) -> dict | None:
    client = anthropic.AsyncAnthropic(max_retries=2, timeout=10 * 60)

    def define(k: str) -> str:
        m = metric_by_key(k)
        if m:
            return f"{m['name']} (target {m['target']}){f': {m['rubric']}' if m.get('rubric') else ''}"
        g = gate_by_id(k)
        return g['text'] if g else k

    rubric = '\n'.join(define(k) for k in f['metrics'])
    ev = '\n'.join(f"- call {e['callId']}, turn #{js_str(e['turn']) if e['turn'] is not None else '?'}: “{e['quote'] if e['quote'] is not None else ''}”" for e in f['evidence'])
    system = "You improve an AI voice sales agent for a Dubai real-estate developer. You turn evaluation findings into changes a prompt engineer can ship today: prefer one precise prompt edit over general advice, keep the agent's existing structure and tone, and never weaken a compliance rule. If the fix is not a prompt change (a tool, routing, voice or data change), say so and leave the patch empty."
    current = prompt[:60_000] if prompt else '(not available — write the patch as a standalone rule)'
    rule_line = f"\nPlaybook rule: {f['promptPatch']}" if f['promptPatch'] else ''
    user = (f"CURRENT AGENT PROMPT\n{current}\n\nFINDING\nTitle: {f['title']}\nKind: {f['kind']}\nScope: {_scope_label(f['scope'], f['scopeKey'])}\n"
            f"Problem: {f['problem']}\nMetric definitions:\n{rubric or '—'}\nPlaybook suggestion: {f['proposal']}{rule_line}\n"
            f"Evidence from calls:\n{ev or '—'}\n\nWrite the recommendation.")
    params = dict(
        model=config.llm.model, max_tokens=32000, system=system, messages=[{'role': 'user', 'content': user}],
        output_config={'effort': config.llm.recommendation_effort, 'format': {'type': 'json_schema', 'schema': _TAILOR_SCHEMA}},
    )

    async def send(fb: bool):
        extra = {'betas': ['server-side-fallback-2026-07-01'], 'fallbacks': 'default'} if fb else {}
        async with client.beta.messages.stream(**params, **extra) as stream:
            return await stream.get_final_message()

    try:
        msg = await send(config.llm.fallbacks)
    except anthropic.BadRequestError as e:
        if 'fallback' in str(e).lower():
            msg = await send(False)
        else:
            raise
    if msg.stop_reason in ('refusal', 'max_tokens'):
        return None
    text = ''.join(b.text for b in msg.content if b.type == 'text')
    o = _Tailor.model_validate(json.loads(text))
    if o.patch_mode == 'none' or not o.patch_after.strip():
        patch = None
    elif o.patch_mode == 'replace' and o.patch_before.strip():
        patch = f"Replace{f' in “{o.patch_section}”' if o.patch_section else ''}:\n{o.patch_before.strip()}\n\nWith:\n{o.patch_after.strip()}"
    else:
        patch = f"Add{f' to “{o.patch_section}”' if o.patch_section else ' to the prompt'}:\n{o.patch_after.strip()}"
    return {'title': o.title, 'problem': o.problem, 'proposal': f'{o.proposal}\n\nExpected effect: {o.expected_effect}', 'promptPatch': patch}


async def generate_recommendations(db, *, range_days: float = 30, agent: str = 'all', use_llm: bool = True) -> dict:
    r = await collect_findings(db, range_days=range_days, agent=agent)
    findings, version = r['findings'], r['version']
    findings.sort(key=lambda f: -f['priority'])
    use = use_llm and llm_enabled()
    tailored = 0
    if use:
        agent_row = await db.one(f"select prompt_text from agent {'where id = $1' if agent != 'all' else 'order by updated_at desc limit 1'}", [agent] if agent != 'all' else [])
        for f in [x for x in findings if x['kind'] not in ('taxonomy', 'routing')][:8]:
            existing = await db.one('select source, status, updated_at from recommendation where fingerprint = $1', [f['fingerprint']])
            if existing and existing['source'] == 'llm' and existing['status'] != 'proposed':
                continue
            try:
                t = await _tailor(f, agent_row['prompt_text'] if agent_row else None)
                if t:
                    f.update(t)
                    f['source'] = 'llm'
                    tailored += 1
            except Exception as e:  # noqa: BLE001 - the playbook version stays
                log.warn('recommendation tailoring failed; keeping the playbook version', {'title': f['title'], 'error': err_msg(e)})
    created = updated = 0
    keep: set[str] = set()
    for f in findings:
        keep.add(f['fingerprint'])
        source = f.get('source', 'playbook')
        cur = await db.one('select id, status from recommendation where fingerprint = $1', [f['fingerprint']])
        if not cur:
            await db.query(
                """insert into recommendation (id, scope, scope_key, kind, title, problem, proposal, prompt_patch, evidence, metrics, impact, priority, status, source, baseline, fingerprint)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,'proposed',$13,$14::jsonb,$15)""",
                [new_id('rec'), f['scope'], f['scopeKey'], f['kind'], f['title'], f['problem'], f['proposal'], f['promptPatch'], js_json(f['evidence']), js_json(f['metrics']),
                 js_json(f['impact']), f['priority'], source, js_json({'version': version, 'key': f['baselineKey']}), f['fingerprint']],
            )
            created += 1
        elif cur['status'] == 'proposed':
            await db.query(
                """update recommendation set scope = $2, scope_key = $3, kind = $4, title = $5, problem = $6, proposal = $7, prompt_patch = $8, evidence = $9::jsonb, metrics = $10::jsonb,
           impact = $11::jsonb, priority = $12, source = $13, baseline = $14::jsonb, updated_at = now() where id = $1""",
                [cur['id'], f['scope'], f['scopeKey'], f['kind'], f['title'], f['problem'], f['proposal'], f['promptPatch'], js_json(f['evidence']), js_json(f['metrics']),
                 js_json(f['impact']), f['priority'], source, js_json({'version': version, 'key': f['baselineKey']})],
            )
            updated += 1
        elif cur['status'] in ('accepted', 'in_prompt'):
            await db.query('update recommendation set impact = $2::jsonb, evidence = $3::jsonb, priority = $4, updated_at = now() where id = $1',
                           [cur['id'], js_json(f['impact']), js_json(f['evidence']), f['priority']])
            updated += 1
    # Proposals whose finding has gone away are withdrawn.
    stale = await db.query("select id, fingerprint from recommendation where status = 'proposed' and scope <> 'call'")
    withdrawn = 0
    for s in stale:
        if s['fingerprint'] not in keep:
            await db.query('delete from recommendation where id = $1', [s['id']])
            withdrawn += 1
    verified = await verify_shipped(db)
    return {'created': created, 'updated': updated, 'withdrawn': withdrawn, 'tailored': tailored, 'verified': verified, 'version': version}


def _mean(xs: list[float]) -> float:
    return sum(xs) / len(xs)


async def verify_shipped(db) -> int:
    """A shipped fix is verified when its target version moves the metric, gate or cell it was for."""
    recs = await db.query("select id, target_version, baseline, metrics from recommendation where status = 'in_prompt' and target_version is not null")
    settings = await get_settings(db)
    n = 0
    for r in recs:
        baseline = r['baseline'] or {}
        from_, to = baseline.get('version') if isinstance(baseline, dict) else None, r['target_version']
        if not from_ or from_ == to:
            continue
        key = (baseline.get('key') if isinstance(baseline, dict) else None) or {}
        a: list[float] = []
        b: list[float] = []
        label = ''
        if key.get('metric'):
            rows = await db.query("select c.prompt_version as v, m.value as x from metric_result m join calls c on c.call_id = m.call_id where m.metric_key = $1 and m.applicable and c.prompt_version in ($2,$3)",
                                  [key['metric'], from_, to])
            a = [js_number(x['x']) for x in rows if x['v'] == from_]
            b = [js_number(x['x']) for x in rows if x['v'] == to]
            label = (metric_by_key(key['metric']) or {}).get('name') or key['metric']
        elif key.get('cell'):
            pid, sid = (str(key['cell']).split('|') + [None])[:2]
            rows = await db.query("select prompt_version as v, cqs as x from calls where status = 'scored' and persona = $1 and scenario = $2 and prompt_version in ($3,$4)", [pid, sid, from_, to])
            a = [js_number(x['x']) for x in rows if x['v'] == from_]
            b = [js_number(x['x']) for x in rows if x['v'] == to]
            label = f"median CQS of {key['cell']}"
        elif key.get('gate'):
            rows = await db.query("select c.prompt_version as v, case when s.gates @> $1::jsonb then 0 else 100 end as x from calls c join call_score s on s.call_id = c.call_id where c.prompt_version in ($2,$3)",
                                  [js_json([{'id': key['gate']}]), from_, to])
            a = [js_number(x['x']) for x in rows if x['v'] == from_]
            b = [js_number(x['x']) for x in rows if x['v'] == to]
            label = f"{key['gate']}-free call share"
        if len(a) < settings['minCellCalls'] or len(b) < settings['minCellCalls']:
            continue
        # Pass/fail metrics and gates only take 0 or 100, so their median barely moves; compare pass rates.
        binary = bool(key.get('gate')) or all(x in (0, 100) for x in [*a, *b])
        stat = _mean if binary else median
        if binary and key.get('metric'):
            label = f'{label} pass rate'
        res = bootstrap_median_diff(a, b, 800, 5, stat)
        sa, sb, lo, hi = to_fixed(stat(a), 1), to_fixed(stat(b), 1), to_fixed(res['lo'], 1), to_fixed(res['hi'], 1)
        if res['lo'] > 0:
            await db.query("update recommendation set status = 'verified', note = $2, updated_at = now() where id = $1",
                           [r['id'], f'{label} moved from {sa} on {from_} to {sb} on {to} (95% interval {lo} to {hi}, {len(a)} and {len(b)} calls).'])
            n += 1
        elif res['hi'] < 0:
            await db.query('update recommendation set note = $2, updated_at = now() where id = $1',
                           [r['id'], f'Regressed: {label} fell from {sa} on {from_} to {sb} on {to} (95% interval {lo} to {hi}). Check what else changed in {to}.'])
        else:
            await db.query('update recommendation set note = $2, updated_at = now() where id = $1',
                           [r['id'], f'Not verified yet: {label} {sa} on {from_} → {sb} on {to}; the 95% interval ({lo} to {hi}) still includes zero.'])
    return n


def _to_dto(r: dict) -> dict:
    return {
        'id': r['id'], 'scope': r['scope'], 'scopeKey': r['scope_key'], 'kind': r['kind'], 'title': r['title'], 'problem': r['problem'], 'proposal': r['proposal'],
        'promptPatch': r['prompt_patch'], 'evidence': r['evidence'] if r['evidence'] is not None else [], 'metrics': r['metrics'] if r['metrics'] is not None else [],
        'impact': r['impact'] if r['impact'] is not None else {'calls': 0, 'pointsBelow': 0, 'score': 0, 'valueAtStake': None}, 'priority': js_number(r['priority']),
        'status': r['status'], 'source': r['source'], 'targetVersion': r['target_version'], 'createdAt': iso(r['created_at']), 'updatedAt': iso(r['updated_at']), 'note': r['note'],
    }


async def list_recommendations(db, *, status: str | None = None, scope: str | None = None, scope_key: str | None = None, kind: str | None = None) -> list[dict]:
    conds: list[str] = []
    params: list[Any] = []

    def add(sql: str, v: Any) -> None:
        params.append(v)
        conds.append(sql.replace('?', f'${len(params)}', 1))

    if status == 'active':
        conds.append("status in ('proposed','accepted','in_prompt')")
    elif status and status != 'all':
        add('status = ?', status)
    if scope == 'call' and scope_key:
        # A call's page shows recommendations whose evidence quotes it.
        add('evidence @> ?::jsonb', js_json([{'callId': scope_key}]))
    else:
        if scope:
            add('scope = ?', scope)
        if scope_key:
            add('scope_key = ?', scope_key)
    if kind:
        add('kind = ?', kind)
    rows = await db.query(
        f"select * from recommendation {f'where {' and '.join(conds)}' if conds else ''} order by case status when 'proposed' then 0 when 'accepted' then 1 when 'in_prompt' then 2 when 'verified' then 3 else 4 end, priority desc limit 200",
        params,
    )
    return [_to_dto(r) for r in rows]


async def update_recommendation(db, id: str, patch: dict[str, Any]) -> dict:
    cur = await db.one('select * from recommendation where id = $1', [id])
    if not cur:
        raise http_error(404, 'Recommendation not found')
    status = patch.get('status') if patch.get('status') is not None else cur['status']
    if status not in ('proposed', 'accepted', 'in_prompt', 'verified', 'rejected'):
        raise http_error(400, 'Unknown status')
    # Accepting re-baselines on the live version, so verification compares like with like.
    baseline = cur['baseline']
    if patch.get('status') == 'accepted' and cur['status'] == 'proposed':
        v = await resolve_version(db, 'live', 'all')
        baseline = {**(cur['baseline'] or {}), 'version': v['label']}
    await db.query('update recommendation set status = $2, note = coalesce($3, note), target_version = coalesce($4, target_version), baseline = $5::jsonb, updated_at = now() where id = $1',
                   [id, status, patch.get('note'), patch.get('targetVersion'), js_json(baseline)])
    if status == 'in_prompt':
        await verify_shipped(db)
    return _to_dto(await db.one('select * from recommendation where id = $1', [id]))
