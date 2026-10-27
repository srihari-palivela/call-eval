# The self-improvement loop for a campaign's agent prompt, after Google's Harness² (arXiv 2610.14224):
#   reference  the champion prompt's recent calls: CQS, metrics, gate rate, and the findings behind them
#   propose    k general (invariant weaknesses) and k domain (cell-specific) prompt edits, informed by the
#              lessons library: edits that were adopted or rejected before, with their measured effect
#   probe      contrastive runs: every candidate and the champion against the same simulated callers, scored by
#              the evaluation pipeline (needs a Claude key; without one the cycle is propose-only and unprobed)
#   compose    winning edits merged into one challenger prompt, probed once more against the champion
#   live       the challenger takes a share of campaign calls; verification with a bootstrap interval on CQS,
#              the gate rate and the targeted metrics decides promote / roll back / reject
# Every decision writes lessons. A person approves challengers and promotions in propose mode; auto mode
# promotes verified wins on its own, except edits that touch compliance rules, which always need a person.

from __future__ import annotations

import asyncio
from typing import Any

from pydantic import BaseModel, ValidationError

from .. import billing
from ..business import get_business
from ..campaigns import providers
from ..campaigns.engine import ACTIVE_CYCLE, effective_mode
from ..config import env, llm_enabled
from ..connectors.registry import credentials_of, get_integration
from ..framework import GATES, METRICS, bootstrap_median_diff, median
from ..js import iso, js_json, jsre, now_iso
from ..lib.errors import HttpStatusError, http_error
from ..lib.ids import new_id, sha
from ..lib.log import err_msg, log
from ..lib.settings import get_settings
from ..pipeline.evaluate import evaluate_call
from ..pipeline.judge.heuristic import heuristic
from ..recommendations.engine import collect_findings
from ..recommendations.playbook import PLAYBOOK
from .simulate import Budget, claude_json, simulate, task_from_call

METRIC_KEYS = {m['key'] for m in METRICS}
GATE_IDS = {g['id'] for g in GATES}
# Wording that belongs to the compliance gates (G1–G9): an edit touching it never goes live or gets promoted
# without a person, whatever the mode.
COMPLIANCE_RX = jsre(r"\b(ai|a\.i\.|artificial intelligence|bot|robot|human|discounts?|guarantee[ds]?|returns?|yield|visa|mortgage|legal|tax|financial advice|"
                     r"do[- ]not[- ]contact|dnc|stop calling|other (customer|client|buyer)s?|read[- ]?back|confirm(ed)? by the tool|transfer_to|compliance)\b", 'i')


def touches_compliance(edit: dict) -> bool:
    if any(t in GATE_IDS for t in edit.get('targets') or []):
        return True
    return bool(COMPLIANCE_RX.search(f"{edit.get('before') or ''}\n{edit.get('after') or ''}"))


def _int_env(k: str, d: int) -> int:
    try:
        return int(env(k) or d)
    except ValueError:
        return d


# ---------- Reference ----------

async def _champion_calls(db, c: dict, label: str, since: Any = None) -> list[dict]:
    rows = await db.query(
        """select x.call_id, x.cqs, x.gated, x.next_step from campaign_lead cl join calls x on x.call_id = cl.call_id
           where cl.campaign_id = $1 and cl.arm = 'champion' and cl.prompt_version = $2 and x.status = 'scored'
             and ($3::timestamptz is null or x.scored_at >= $3::timestamptz)
           order by x.started_at desc limit 200""", [c['id'], label, since])
    if len(rows) < 10:
        # Too few campaign calls yet: the agent's own recent calls on the same prompt version stand in.
        rows = await db.query(
            """select call_id, cqs, gated, next_step from calls where agent_id = $1 and prompt_version = $2 and status = 'scored'
               order by started_at desc limit 200""", [c['agent_id'], label])
    return rows


async def _metric_means(db, ids: list[str]) -> dict[str, float]:
    if not ids:
        return {}
    rows = await db.query('select metric_key as k, avg(value) as v from metric_result where call_id = any($1::text[]) and applicable and value is not null group by 1', [ids])
    return {r['k']: round(r['v'], 1) for r in rows}


async def reference(db, c: dict) -> dict:
    champion = c['champion'] or {}
    label = champion.get('label') or 'v1'
    rows = await _champion_calls(db, c, label)
    ids = [r['call_id'] for r in rows]
    goals = (await get_business(db))['goals']
    focus = set(goals.get('focusPersonas') or []) | set(goals.get('focusScenarios') or [])
    found = (await collect_findings(db, range_days=30, agent=c['agent_id'] or 'all'))['findings']
    for f in found:
        keys = set(str(f.get('scopeKey') or '').split('|'))
        f['_rank'] = f['priority'] * (1.5 if keys & focus else 1)
    found.sort(key=lambda f: -f['_rank'])
    return {
        'label': label, 'calls': len(rows), 'callIds': ids,
        'cqs': None if not rows else round(median([r['cqs'] for r in rows if r['cqs'] is not None] or [0]), 1),
        'gateRate': None if not rows else round(sum(1 for r in rows if r['gated']) / len(rows) * 100, 1),
        'meetingRate': None if not rows else round(sum(1 for r in rows if r['next_step'] == 'meeting') / len(rows) * 100, 1),
        'metrics': await _metric_means(db, ids),
        'findings': [{'fingerprint': f['fingerprint'], 'title': f['title'], 'problem': f['problem'], 'kind': f['kind'], 'scope': f['scope'],
                      'scopeKey': f['scopeKey'], 'metrics': f['metrics'], 'promptPatch': f.get('promptPatch'),
                      'evidence': [{'callId': e['callId'], 'turn': e['turn'], 'quote': (e.get('quote') or '')[:200]} for e in (f.get('evidence') or [])[:3]]}
                     for f in found[:8]],
    }


# ---------- Propose ----------

async def lessons_for(db, agent_id: str | None, limit: int = 30) -> list[dict]:
    rows = await db.query('select * from improvement_lesson where agent_id is not distinct from $1 order by created_at desc limit $2', [agent_id, limit])
    return [_lesson_dto(r) for r in rows]


def playbook_candidates(ref: dict, k_general: int, k_domain: int) -> list[dict]:
    """Without Claude: the playbook's prompt rule for each top finding, as an edit added to the prompt."""
    out: list[dict] = []
    seen: set[str] = set()
    counts = {'general': 0, 'domain': 0}
    for f in ref['findings']:
        key = next((k for k in f['metrics'] if PLAYBOOK.get(k, {}).get('promptRule')), None)
        if not key:
            continue
        rule = PLAYBOOK[key]['promptRule']
        kind = 'general' if f['scope'] == 'global' else 'domain'
        if rule in seen or counts[kind] >= (k_general if kind == 'general' else k_domain):
            continue
        seen.add(rule)
        counts[kind] += 1
        out.append({'kind': kind, 'targets': list(f['metrics']), 'mode': 'add', 'section': PLAYBOOK[key]['title'], 'before': '', 'after': rule,
                    'rationale': f['problem'], 'source': 'playbook'})
    return out


class _Cand(BaseModel):
    kind: str
    targets: list[str]
    mode: str
    section: str
    before: str
    after: str
    rationale: str


class _Cands(BaseModel):
    candidates: list[_Cand]


PROPOSE_SCHEMA = {
    'type': 'object', 'additionalProperties': False, 'required': ['candidates'],
    'properties': {'candidates': {'type': 'array', 'items': {
        'type': 'object', 'additionalProperties': False, 'required': ['kind', 'targets', 'mode', 'section', 'before', 'after', 'rationale'],
        'properties': {
            'kind': {'type': 'string', 'enum': ['general', 'domain']},
            'targets': {'type': 'array', 'items': {'type': 'string'}, 'description': 'Metric keys (or gate ids) this edit should move.'},
            'mode': {'type': 'string', 'enum': ['add', 'replace']},
            'section': {'type': 'string', 'description': 'The heading or rule in the current prompt this belongs to; empty to append.'},
            'before': {'type': 'string', 'description': 'For replace: the exact current prompt text to replace. Empty for add.'},
            'after': {'type': 'string', 'description': 'The new prompt text.'},
            'rationale': {'type': 'string', 'description': 'Which finding this answers and why it should work, in one or two sentences.'},
        }}}},
}

PROPOSE_SYSTEM = """You improve the system prompt of an AI voice sales agent for a Dubai real-estate developer, one cycle of a
self-improvement loop. You propose small, self-contained prompt edits that will each be tested against the current prompt on
simulated callers, and then on live calls. Two kinds:
- general: invariant weaknesses that hurt many calls whatever the caller (grounding facts in tools, turn length, one question
  per turn, read-backs before sends, answering the caller's last turn first);
- domain: a specific persona × scenario cell where the findings concentrate.
Rules: change only what the evidence supports; keep the prompt's structure, voice and tool names; never weaken, remove or
reword a compliance rule (AI disclosure, no invented facts, no promises or advice, do-not-contact, other customers,
confirmed sends and bookings, transfers); for replace, `before` must be copied exactly from the current prompt; learn from the
lessons: don't propose again what was rejected or regressed, build on what was adopted."""


async def llm_candidates(c: dict, ref: dict, lessons: list[dict], goals: dict, k_general: int, k_domain: int, budget: Budget) -> list[dict]:
    prompt = (c['champion'] or {}).get('prompt') or ''
    lesson_lines = '\n'.join(f"- [{x['outcome']}] {x['edit'][:300]} · effect {js_json(x['effect'])[:300]}" for x in lessons) or '- none yet'
    finding_lines = '\n'.join(
        f"- {f['title']} ({', '.join(f['metrics'])}; {f['scope']}{' ' + f['scopeKey'] if f['scopeKey'] else ''}): {f['problem']}"
        + ''.join(f"\n    evidence {e['callId']} #{e['turn']}: “{e['quote']}”" for e in f['evidence']) for f in ref['findings']) or '- none'
    user = f"""CURRENT PROMPT ({ref['label']})
{prompt[:60000]}

REFERENCE ({ref['calls']} recent calls on {ref['label']}): median CQS {ref['cqs']}, gate failures {ref['gateRate']}%, meetings {ref['meetingRate']}%.
Metric means (0–100): {js_json(ref['metrics'])}

FINDINGS (highest impact first)
{finding_lines}

BUSINESS GOALS
{js_json(goals)}

LESSONS FROM EARLIER CYCLES
{lesson_lines}

Propose {k_general} general and {k_domain} domain edits."""
    out = await claude_json(PROPOSE_SYSTEM, user, PROPOSE_SCHEMA, budget=budget, effort=_cfg_effort(), model=_cfg_model(), max_tokens=16000)
    try:
        parsed = _Cands.model_validate(out)
    except ValidationError as e:
        raise RuntimeError(f'Proposals did not match the schema: {e}') from e
    cands = []
    for x in parsed.candidates:
        if not x.after.strip() or x.mode not in ('add', 'replace') or x.kind not in ('general', 'domain'):
            continue
        targets = [t for t in x.targets if t in METRIC_KEYS or t in GATE_IDS]
        cands.append({'kind': x.kind, 'targets': targets, 'mode': x.mode, 'section': x.section.strip(), 'before': x.before if x.mode == 'replace' else '',
                      'after': x.after.strip(), 'rationale': x.rationale.strip(), 'source': 'llm'})
    general = [x for x in cands if x['kind'] == 'general'][:k_general]
    domain = [x for x in cands if x['kind'] == 'domain'][:k_domain]
    return general + domain


def _cfg_effort() -> str:
    from ..config import config
    return config.llm.recommendation_effort


def _cfg_model() -> str:
    from ..config import config
    return config.llm.model


# ---------- Probe ----------

def apply_edit(prompt: str, edit: dict) -> tuple[str, str | None]:
    """Apply one edit; returns (prompt, reason it was skipped or None)."""
    after = (edit.get('after') or '').strip()
    if not after:
        return prompt, 'empty edit'
    if edit.get('mode') == 'replace':
        before = edit.get('before') or ''
        if not before or before not in prompt:
            return prompt, 'the text to replace is not in the current prompt'
        return prompt.replace(before, after, 1), None
    section = (edit.get('section') or '').strip()
    if section:
        lines = prompt.split('\n')
        at = next((i for i, ln in enumerate(lines) if section.lower() in ln.lower()), None)
        if at is not None:
            # Insert after the section's first paragraph.
            j = at + 1
            while j < len(lines) and lines[j].strip():
                j += 1
            return '\n'.join([*lines[:j], after, *lines[j:]]), None
    return f'{prompt.rstrip()}\n\n{after}\n', None


def compose(prompt: str, edits: list[dict]) -> dict:
    out = prompt
    applied, skipped = [], []
    for e in edits:
        nxt, why = apply_edit(out, e)
        if why:
            skipped.append({'id': e['id'], 'reason': why})
        else:
            out = nxt
            applied.append(e['id'])
    return {'prompt': out, 'applied': applied, 'skipped': skipped}


async def probe_tasks(db, ref: dict, targets: set[str], n: int) -> list[dict]:
    """Half the callers come from calls that failed a targeted metric, half are controls, all from the reference."""
    ids = ref['callIds']
    if not ids:
        return []
    settings = await get_settings(db)
    failing = [r['call_id'] for r in await db.query(
        'select distinct call_id from metric_result where call_id = any($1::text[]) and metric_key = any($2::text[]) and applicable and value < $3',
        [ids, sorted(targets) or ['__none__'], settings['goodLine']])]
    order = lambda xs: sorted(xs, key=lambda x: sha(x, 8))  # noqa: E731 - deterministic, spread over the period
    pick = order(failing)[: (n + 1) // 2]
    pick += [x for x in order(ids) if x not in pick][: n - len(pick)]
    tasks = []
    for cid in pick:
        r = await db.one('select canonical, persona, scenario from calls where call_id = $1 and purged_at is null', [cid])
        if r and (r['canonical'] or {}).get('turns'):
            tasks.append(task_from_call(cid, r['canonical'], r['persona'], r['scenario']))
    return tasks


async def run_prompt(tasks: list[dict], prompt: str, settings: dict, budget: Budget, label: str) -> list[dict | None]:
    """Simulate every task with `prompt` and score each transcript; None where the budget ran out or a run failed."""

    async def one(task: dict) -> dict | None:
        if budget.exceeded:
            return None
        try:
            call = await simulate(task, prompt, budget=budget, label=label)
            ev = (await evaluate_call(call, call_id=call['externalId'], judge=heuristic, settings=settings))['evaluation']
        except Exception as e:  # noqa: BLE001 - one failed simulation is a missing data point, not a failed cycle
            log.warn('probe simulation failed', {'task': task['callId'], 'error': err_msg(e)})
            return None
        return {'task': task['callId'], 'cqs': ev['cqs'], 'metrics': {m['key']: m['value'] for m in ev['metrics'] if m['applicable']},
                'gates': [g['id'] for g in ev['gates'] if g['failed']], 'turns': len(call['turns'])}

    return list(await asyncio.gather(*(one(t) for t in tasks)))


def compare(champ: list[dict | None], cand: list[dict | None], targets: list[str]) -> dict:
    """Matched pairs (same caller): mean target-metric delta, mean CQS delta, gate failures the candidate added."""
    td, cd, added, wins, losses = [], [], 0, 0, 0
    for a, b in zip(champ, cand, strict=False):
        if not a or not b:
            continue
        cd.append(b['cqs'] - a['cqs'])
        ds = [b['metrics'][k] - a['metrics'][k] for k in targets if a['metrics'].get(k) is not None and b['metrics'].get(k) is not None]
        if ds:
            td.append(sum(ds) / len(ds))
        added += max(0, len(b['gates']) - len(a['gates']))
        delta = sum(ds) if ds else b['cqs'] - a['cqs']
        wins += delta > 0
        losses += delta < 0
    return {'n': len(cd), 'meanTargetDelta': round(sum(td) / len(td), 1) if td else None, 'meanCqsDelta': round(sum(cd) / len(cd), 1) if cd else None,
            'gatesAdded': added, 'wins': wins, 'losses': losses}


def is_win(s: dict) -> bool:
    if not s['n'] or s['gatesAdded'] > 0:
        return False
    td, cd = s['meanTargetDelta'], s['meanCqsDelta']
    return (td is not None and td > 0 and (cd or 0) >= 0) or (td is None and (cd or 0) > 0)


# ---------- The cycle ----------

def _cycle_dto(r: dict) -> dict:
    return {
        'id': r['id'], 'campaignId': r['campaign_id'], 'agentId': r['agent_id'], 'status': r['status'], 'mode': r['mode'],
        'championLabel': r['champion_label'], 'challengerLabel': r['challenger_label'], 'reference': r['reference'], 'candidates': r['candidates'] or [],
        'probes': r['probes'], 'composed': r['composed'], 'verdict': r['verdict'], 'cost': r['cost'] or {}, 'error': r['error'],
        'createdAt': iso(r['created_at']), 'updatedAt': iso(r['updated_at']), 'decidedAt': iso(r['decided_at']), 'decidedBy': r['decided_by'],
    }


def _lesson_dto(r: dict) -> dict:
    return {'id': r['id'], 'cycleId': r['cycle_id'], 'agentId': r['agent_id'], 'scope': r['scope'], 'scopeKey': r['scope_key'], 'metrics': r['metrics'] or [],
            'edit': r['edit'], 'outcome': r['outcome'], 'effect': r['effect'] or {}, 'createdAt': iso(r['created_at'])}


async def _save(db, id: str, **cols: Any) -> None:
    jsonb = {'reference', 'candidates', 'probes', 'composed', 'verdict', 'cost'}
    names = list(cols)
    sets = [f"{k} = ${i + 2}" + ('::jsonb' if k in jsonb else '') for i, k in enumerate(names)]
    vals = [js_json(cols[k]) if k in jsonb else cols[k] for k in names]
    await db.query(f"update improvement_cycle set {', '.join(sets)}, updated_at = now() where id = $1", [id, *vals])


def _edit_text(e: dict) -> str:
    where = f" in “{e['section']}”" if e.get('section') else ''
    if e.get('mode') == 'replace':
        return f"Replace{where}: “{(e.get('before') or '')[:300]}” → “{e['after'][:600]}”"
    return f"Add{where}: {e['after'][:900]}"


async def _lessons(db, cycle: dict, edits: list[dict], outcome: str, effect: dict) -> None:
    for e in edits:
        await db.query('insert into improvement_lesson (id, cycle_id, agent_id, scope, scope_key, metrics, edit, outcome, effect) values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb)',
                       [new_id('les'), cycle['id'], cycle['agent_id'], e.get('kind'), e.get('scopeKey'), js_json(e.get('targets') or []), _edit_text(e), outcome,
                        js_json({**effect, **({'probe': e['probe']} if e.get('probe') else {})})])


async def _campaign(db, id: str) -> dict:
    c = await db.one('select * from campaign where id = $1', [id])
    if not c:
        raise http_error(404, 'Campaign not found')
    return c


async def run_cycle(db, campaign_id: str, *, requested_by: str = 'scheduler') -> dict:
    """One Propose → Probe → Compose cycle for a campaign (job `improve_cycle`)."""
    c = await _campaign(db, campaign_id)
    settings = await get_settings(db)
    mode = effective_mode(c['improvement'], settings['features']['improvement'])
    if mode == 'off':
        return {'skipped': 'improvement is off'}
    if await db.one(f"select 1 from improvement_cycle where campaign_id = $1 and status in ({','.join(repr(s) for s in ACTIVE_CYCLE)})", [campaign_id]):
        return {'skipped': 'a cycle is already active for this campaign'}
    champion = c['champion'] or {}
    if not champion.get('prompt'):
        return {'skipped': "the champion prompt is unknown (the agent's prompt has not been fetched)"}
    cid = new_id('cyc')
    try:
        await billing.use_improvement_cycle(db, cid)
    except HttpStatusError as e:
        return {'skipped': e.message}
    await db.query("insert into improvement_cycle (id, campaign_id, agent_id, status, mode, champion_label, decided_by) values ($1,$2,$3,'proposing',$4,$5,$6)",
                   [cid, campaign_id, c['agent_id'], mode, champion.get('label'), None])
    cycle = {'id': cid, 'agent_id': c['agent_id']}
    budget = Budget()
    try:
        ref = await reference(db, c)
        await _save(db, cid, reference={k: v for k, v in ref.items() if k != 'callIds'})
        k_general = _int_env('IMPROVE_CANDIDATES_GENERAL', 2)
        k_domain = _int_env('IMPROVE_CANDIDATES_DOMAIN', 2)
        probing = llm_enabled()
        if probing:
            goals = (await get_business(db))['goals']
            cands = await llm_candidates(c, ref, await lessons_for(db, c['agent_id']), goals, k_general, k_domain, budget)
        else:
            cands = playbook_candidates(ref, k_general, k_domain)
        for i, e in enumerate(cands):
            e['id'] = f'cand_{i + 1}'
            e['compliance'] = touches_compliance(e)
        await _save(db, cid, candidates=cands, cost=budget.to_dict())
        if not cands:
            await _save(db, cid, status='rejected', error='No findings with a prompt fix to act on', cost=budget.to_dict())
            return {'cycleId': cid, 'status': 'rejected'}
        label = f"{champion.get('label') or 'v1'}.c{(await db.one('select count(*)::int as n from improvement_cycle where campaign_id = $1', [campaign_id]))['n']}"

        if not probing:
            # Propose-only: no simulator without Claude. A person reviews the composed prompt before anything goes live.
            comp = compose(champion['prompt'], cands)
            composed = {**comp, 'unprobed': True, 'compliance': any(e['compliance'] for e in cands if e['id'] in comp['applied'])}
            await _save(db, cid, status='awaiting_approval', composed=composed, challenger_label=label, cost=budget.to_dict())
            return {'cycleId': cid, 'status': 'awaiting_approval', 'probed': False}

        await _save(db, cid, status='probing')
        targets = {t for e in cands for t in e['targets']}
        tasks = await probe_tasks(db, ref, targets, _int_env('IMPROVE_PROBE_TASKS', 4))
        if not tasks:
            await _save(db, cid, status='rejected', error='No reference calls with transcripts to build simulated callers from', cost=budget.to_dict())
            return {'cycleId': cid, 'status': 'rejected'}
        champ_runs = await run_prompt(tasks, champion['prompt'], settings, budget, 'simc')
        probes: dict[str, Any] = {'tasks': [t['callId'] for t in tasks], 'champion': champ_runs, 'candidates': {}}
        winners = []
        for e in cands:
            prompt, why = apply_edit(champion['prompt'], e)
            if why:
                e['probe'] = {'skipped': why}
                continue
            runs = await run_prompt(tasks, prompt, settings, budget, 'simx')
            s = compare(champ_runs, runs, e['targets'])
            e['probe'] = s
            probes['candidates'][e['id']] = {'summary': s, 'runs': runs}
            if is_win(s):
                winners.append(e)
        await _save(db, cid, candidates=cands, probes=probes, cost=budget.to_dict())
        losers = [e for e in cands if e not in winners]
        await _lessons(db, cycle, losers, 'rejected', {'stage': 'probe'})
        if not winners:
            await _save(db, cid, status='rejected', error='No candidate beat the champion on the simulated callers', cost=budget.to_dict())
            return {'cycleId': cid, 'status': 'rejected', 'winners': 0}
        winners.sort(key=lambda e: -((e['probe']['meanTargetDelta'] if e['probe']['meanTargetDelta'] is not None else e['probe']['meanCqsDelta']) or 0))
        comp = compose(champion['prompt'], winners)
        comp_runs = await run_prompt(tasks, comp['prompt'], settings, budget, 'simz')
        summary = compare(champ_runs, comp_runs, sorted({t for e in winners for t in e['targets']}))
        compliance = any(e['compliance'] for e in winners if e['id'] in comp['applied'])
        composed = {**comp, 'probe': summary, 'runs': comp_runs, 'compliance': compliance, 'unprobed': False}
        if not is_win(summary) or not comp['applied']:
            await _lessons(db, cycle, winners, 'rejected', {'stage': 'compose', 'composed': summary})
            await _save(db, cid, status='rejected', composed=composed, error='The composed prompt did not beat the champion', cost=budget.to_dict())
            return {'cycleId': cid, 'status': 'rejected'}
        await _save(db, cid, composed=composed, challenger_label=label, cost=budget.to_dict())
        if mode == 'auto' and not compliance:
            await _go_live(db, cid, c, label, comp['prompt'], 'auto')
            return {'cycleId': cid, 'status': 'live'}
        await _save(db, cid, status='awaiting_approval')
        return {'cycleId': cid, 'status': 'awaiting_approval'}
    except Exception as e:
        await _save(db, cid, status='failed', error=err_msg(e)[:2000], cost=budget.to_dict())
        raise


async def _go_live(db, cycle_id: str, c: dict, label: str, prompt: str, by: str) -> None:
    challenger = {'label': label, 'prompt': prompt, 'cycleId': cycle_id, 'startedAt': now_iso()}
    await db.query('update campaign set challenger = $2::jsonb, updated_at = now() where id = $1', [c['id'], js_json(challenger)])
    await _save(db, cycle_id, status='live', decided_by=by)
    await db.query('update improvement_cycle set decided_at = now() where id = $1', [cycle_id])


async def _cycle(db, id: str) -> dict:
    r = await db.one('select * from improvement_cycle where id = $1', [id])
    if not r:
        raise http_error(404, 'Improvement cycle not found')
    return r


def _composed_edits(cyc: dict) -> list[dict]:
    applied = set((cyc['composed'] or {}).get('applied') or [])
    return [e for e in cyc['candidates'] or [] if e['id'] in applied]


async def approve(db, cycle_id: str, by: str = 'console') -> dict:
    """A person lets the composed challenger take live traffic."""
    cyc = await _cycle(db, cycle_id)
    if cyc['status'] != 'awaiting_approval':
        raise http_error(400, f"Only a cycle awaiting approval can be approved (this one is {cyc['status']})")
    c = await _campaign(db, cyc['campaign_id'])
    await _go_live(db, cycle_id, c, cyc['challenger_label'], cyc['composed']['prompt'], by)
    return _cycle_dto(await _cycle(db, cycle_id))


async def reject(db, cycle_id: str, by: str = 'console', note: str | None = None) -> dict:
    cyc = await _cycle(db, cycle_id)
    if cyc['status'] not in ('awaiting_approval', 'live', 'awaiting_promotion'):
        raise http_error(400, f"A {cyc['status']} cycle can't be rejected")
    await _end_challenger(db, cyc)
    await _lessons(db, cyc, _composed_edits(cyc), 'rejected', {'stage': 'review', 'by': by, **({'note': note} if note else {}), **({'live': cyc['verdict']} if cyc['verdict'] else {})})
    await _save(db, cycle_id, status='rejected', decided_by=by)
    await db.query('update improvement_cycle set decided_at = now() where id = $1', [cycle_id])
    return _cycle_dto(await _cycle(db, cycle_id))


async def _end_challenger(db, cyc: dict) -> None:
    await db.query("update campaign set challenger = null, updated_at = now() where id = $1 and challenger->>'cycleId' = $2", [cyc['campaign_id'], cyc['id']])


async def rollback(db, cycle_id: str, by: str = 'console') -> dict:
    cyc = await _cycle(db, cycle_id)
    if cyc['status'] not in ('live', 'awaiting_promotion'):
        raise http_error(400, f"A {cyc['status']} cycle has nothing to roll back")
    await _end_challenger(db, cyc)
    worse = (cyc['verdict'] or {}).get('decision') == 'rollback'
    await _lessons(db, cyc, _composed_edits(cyc), 'regressed' if worse else 'rejected', {'stage': 'live', 'by': by, 'live': cyc['verdict']})
    await _save(db, cycle_id, status='rolled_back', decided_by=by)
    await db.query('update improvement_cycle set decided_at = now() where id = $1', [cycle_id])
    return _cycle_dto(await _cycle(db, cycle_id))


async def promote(db, cycle_id: str, by: str = 'console') -> dict:
    """Make the challenger the agent's prompt at the provider and the campaign's champion."""
    cyc = await _cycle(db, cycle_id)
    verdict = cyc['verdict'] or {}
    if cyc['status'] != 'awaiting_promotion' and not (cyc['status'] == 'live' and verdict.get('decision') == 'promote'):
        raise http_error(400, 'Only a challenger with a verified win can be promoted')
    if by == 'auto' and (cyc['composed'] or {}).get('compliance'):
        raise http_error(400, 'This challenger changes compliance wording; a person must promote it')
    c = await _campaign(db, cyc['campaign_id'])
    challenger = c['challenger'] or {}
    if challenger.get('cycleId') != cycle_id:
        raise http_error(400, "This cycle's challenger is no longer live on the campaign")
    integ = await get_integration(db, c['integration_id'])
    if not integ:
        raise http_error(400, 'The campaign integration is missing')
    result = await providers.update_agent_prompt(integ['provider'], credentials_of(integ), c['agent_external_id'], challenger['prompt'])
    champion = {'label': challenger['label'], 'prompt': challenger['prompt'], 'source': 'promoted', 'promotedAt': now_iso(), 'cycleId': cycle_id}
    await db.query('update campaign set champion = $2::jsonb, challenger = null, updated_at = now() where id = $1', [c['id'], js_json(champion)])
    await _lessons(db, cyc, _composed_edits(cyc), 'adopted', {'stage': 'live', 'by': by, 'live': verdict})
    await _save(db, cycle_id, status='promoted', decided_by=by, verdict={**verdict, 'provider': result})
    await db.query('update improvement_cycle set decided_at = now() where id = $1', [cycle_id])
    return _cycle_dto(await _cycle(db, cycle_id))


async def _arm(db, c: dict, arm: str, label: str, since: str | None) -> list[dict]:
    return await db.query(
        """select x.call_id, x.cqs, x.gated from campaign_lead cl join calls x on x.call_id = cl.call_id
           where cl.campaign_id = $1 and cl.arm = $2 and cl.prompt_version = $3 and x.status = 'scored'
             and ($4::timestamptz is null or x.started_at >= $4::timestamptz)""", [c['id'], arm, label, since])


async def verify(db, cycle_id: str) -> dict:
    """Live verification (job `improve_verify`): champion vs challenger calls since the challenger went live."""
    cyc = await _cycle(db, cycle_id)
    if cyc['status'] != 'live':
        return {'skipped': f"cycle is {cyc['status']}"}
    c = await _campaign(db, cyc['campaign_id'])
    ch = c['challenger'] or {}
    if ch.get('cycleId') != cycle_id:
        return {'skipped': 'challenger is no longer live'}
    since = ch.get('startedAt')
    a = await _arm(db, c, 'champion', (c['champion'] or {}).get('label') or 'v1', since)
    b = await _arm(db, c, 'challenger', ch['label'], since)
    targets = sorted({t for e in _composed_edits(cyc) for t in e['targets'] if t in METRIC_KEYS})
    base = {'checkedAt': now_iso(), 'champion': {'n': len(a)}, 'challenger': {'n': len(b)}, 'minCalls': c['min_calls_per_arm'], 'maxCalls': c['max_calls_per_arm']}
    if min(len(a), len(b)) < c['min_calls_per_arm']:
        if max(len(a), len(b)) >= c['max_calls_per_arm'] and min(len(a), len(b)) < c['min_calls_per_arm'] // 3:
            verdict = {**base, 'decision': 'reject', 'why': 'The challenger arm gets too few calls to reach a verdict'}
            await _save(db, cycle_id, verdict=verdict)
            return await _finish(db, cycle_id, verdict)
        await _save(db, cycle_id, verdict={**(cyc['verdict'] or {}), **base, 'decision': 'pending'})
        return {'decision': 'pending', 'champion': len(a), 'challenger': len(b)}
    ca, cb = [r['cqs'] for r in a], [r['cqs'] for r in b]
    boot = bootstrap_median_diff(ca, cb, 1000, int(sha(cycle_id, 6), 16))
    ga = sum(1 for r in a if r['gated']) / len(a) * 100
    gb = sum(1 for r in b if r['gated']) / len(b) * 100
    ma, mb = await _metric_means(db, [r['call_id'] for r in a]), await _metric_means(db, [r['call_id'] for r in b])
    verdict = {
        **base,
        'champion': {'n': len(a), 'cqs': median(ca), 'gateRate': round(ga, 1), 'metrics': {k: ma.get(k) for k in targets}},
        'challenger': {'n': len(b), 'cqs': median(cb), 'gateRate': round(gb, 1), 'metrics': {k: mb.get(k) for k in targets}},
        'cqsDelta': round(boot['d'], 1), 'lo': round(boot['lo'], 1), 'hi': round(boot['hi'], 1),
    }
    if boot['lo'] > 0 and gb <= ga:
        verdict |= {'decision': 'promote', 'why': f"CQS up {verdict['cqsDelta']} (95% interval {verdict['lo']} to {verdict['hi']}) with no more gate failures"}
    elif boot['hi'] < 0 or gb > ga:
        verdict |= {'decision': 'rollback', 'why': 'CQS down with the interval below zero' if boot['hi'] < 0 else f'Gate failures rose from {round(ga, 1)}% to {round(gb, 1)}%'}
    elif max(len(a), len(b)) >= c['max_calls_per_arm']:
        verdict |= {'decision': 'reject', 'why': f"No verdict after {c['max_calls_per_arm']} calls: the interval still includes zero"}
    else:
        verdict |= {'decision': 'pending', 'why': 'The interval still includes zero; collecting more calls'}
    await _save(db, cycle_id, verdict=verdict)
    if verdict['decision'] == 'pending':
        return verdict
    return await _finish(db, cycle_id, verdict)


async def _finish(db, cycle_id: str, verdict: dict) -> dict:
    cyc = await _cycle(db, cycle_id)
    c = await _campaign(db, cyc['campaign_id'])
    mode = effective_mode(c['improvement'], (await get_settings(db))['features']['improvement'])
    d = verdict['decision']
    if d == 'promote':
        if mode == 'auto' and not (cyc['composed'] or {}).get('compliance'):
            return await promote(db, cycle_id, 'auto')
        await _save(db, cycle_id, status='awaiting_promotion')
        return _cycle_dto(await _cycle(db, cycle_id))
    if d == 'rollback':
        return await rollback(db, cycle_id, 'auto')
    return await reject(db, cycle_id, 'auto', verdict.get('why'))


# ---------- Read ----------

async def list_cycles(db, campaign_id: str | None = None) -> list[dict]:
    rows = await db.query('select * from improvement_cycle where ($1::text is null or campaign_id = $1) order by created_at desc limit 100', [campaign_id])
    out = []
    for r in rows:
        d = _cycle_dto(r)
        d.pop('probes', None)
        if d['composed']:
            d['composed'] = {k: v for k, v in d['composed'].items() if k not in ('prompt', 'runs')}
        out.append(d)
    return out


async def cycle_detail(db, cycle_id: str) -> dict:
    cyc = await _cycle(db, cycle_id)
    d = _cycle_dto(cyc)
    c = await db.one('select champion from campaign where id = $1', [cyc['campaign_id']])
    d['championPrompt'] = ((c or {}).get('champion') or {}).get('prompt')
    d['lessons'] = [_lesson_dto(r) for r in await db.query('select * from improvement_lesson where cycle_id = $1 order by created_at', [cycle_id])]
    return d


async def list_lessons(db, agent_id: str | None = None, limit: int = 100) -> list[dict]:
    rows = await db.query('select * from improvement_lesson where ($1::text is null or agent_id = $1) order by created_at desc limit $2', [agent_id, limit])
    return [_lesson_dto(r) for r in rows]
