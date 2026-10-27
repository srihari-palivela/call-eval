# Prompt text for the Claude classifier and judge. The system prompt is identical for every call under one
# taxonomy version, so it is cached and reused across the whole pipeline; per-call content goes after it.

from __future__ import annotations

from ...framework import GATES, METRICS, TOOL_MAP
from ...js import js_json, js_round, to_fixed
from ...taxonomy import Taxonomy, current
from ..context import expected_opening
from ..text import fmt_time, js_string, truthy
from .types import JUDGED_METRICS


def _phrases(e: dict) -> str:
    return f" Typical phrases: {', '.join(e['keywords'])}." if e.get('keywords') else ''


def system_prompt(tax: Taxonomy | None = None) -> str:
    tax = tax or current()
    personas = '\n'.join(f"- {p['id']} {p['name']} ({p['path']} path). Signals: {p['signals']}. Watch for: {p['watch']}.{_phrases(p)}"
                         for p in [*tax.personas, tax.p0])
    scenarios = '\n'.join(f"- {s['id']} {s['name']}. Trigger: {s['trigger']}. Expected path: {s['path']}. Success: {s['success']}.{_phrases(s)}"
                          for s in tax.scenarios)
    events = '; '.join(f"{e['id']} ({e['group']}: {e['label']})" for e in tax.events)
    facets = '; '.join(f"{f['name']}: {f['values']}" for f in tax.facets)
    tools = '\n'.join(f"- {t['name']}: fires when {t['shouldFire']}. Must come first: {t['mustComeFirst']}. Failure to catch: {t['failure']}." for t in TOOL_MAP)
    rubrics = '\n'.join(f"- {m['key']} · {m['name']} (raw unit: {m['unit']}; target {m['target']}). {m['rubric']}" for m in JUDGED_METRICS)
    gates = '\n'.join(f"- {g['id']}: {g['text']}" for g in GATES)
    return f"""You evaluate calls handled by an AI voice sales agent for {tax.domain} You work inside an evaluation pipeline: code has already measured timings, counts and tool order; you supply the judgements that need the meaning of the words. Always quote evidence as turn ids (the #numbers in the transcript), and judge only what is in the transcript and tool log.

# Call structure
Every call has three phases. Introduction: from the agent's first line until the persona (investor or broker) is resolved; on an inbound call, also until the caller's first question has been answered. Body: until the first closing signal. Conclusion: from the first closing signal (a booking confirmed and the agent wraps up, a second refusal, a do-not-contact request, a live transfer starting, the caller saying goodbye, or about 900 seconds passing) to the end. A call that ends before persona is resolved has no body. Body turns are segmented as Discovery, Pitch, Objection, Action (documents, scheduling, callbacks, transfers) or Off-topic.

The investor-or-broker fork switches whole groups of metrics: on the broker path buyer discovery (budget, location, bedrooms, timeline, end use) is not scored and asking any of it is a violation; on the investor path broker registration checks do not apply.

# Persona taxonomy (exactly one per call, judged at the end of the call)
{personas}

# Scenario taxonomy (one primary — the journey that decided the outcome — and at most one secondary)
{scenarios}

# Event tags (moments inside any scenario)
{events}

# Facets
{facets}. Intent is hot, warm or cold, from stated timeline and engagement; record it at the start and at the end.

# Agent tools
{tools}

# Judged metrics (score each one; mark it not applicable when the call gave no opportunity for it)
{rubrics}

# Compliance gates (pass or fail; one failure caps the call at 40 and sends it to human review)
{gates}
Realism means the caller is comfortable, not fooled: the agent must say it is an AI when asked.

# How to answer
- Turn ids are integers from the transcript. Evidence lists hold the 1–4 turns that matter most.
- Raw values use each metric's unit: averages, percentages 0–100, counts, 1 for pass and 0 for fail, or the −2 to +2 sentiment scale.
- A metric with no opportunity in the call is not applicable (applicable false, raw 0): do not score it as perfect.
- Rationales are one short sentence a QA reviewer can check against the quoted turns.
- Be strict and consistent: two reviewers reading the same call should reach the same answer."""


def render_call(call: dict, ctx: dict, phases: dict | None = None) -> str:
    exp = expected_opening(ctx)
    kf = ctx.get('knownFacts')
    facts = (kf if isinstance(kf, str) else js_json(kf)) if truthy(kf) else 'none'
    lines: list[str] = []
    lines.append('OPENING CONTEXT')
    identity = f"name known ({js_string(ctx.get('customerName'))})" if ctx['identity'] == 'known' else 'name unknown'
    objective = ctx.get('objectiveText') if ctx.get('objectiveText') is not None else 'empty'
    persona = 'unknown' if ctx['persona'] == 'unknown' else f"{ctx['persona']} (from history)"
    lines.append(f"direction: {js_string(ctx['direction']) if ctx['direction'] is not None else 'undefined'} · identity: {identity} · history: {ctx['history']} · objective: {objective} · persona: {persona}")
    lines.append(f'known_facts: {facts}')
    rh = (call.get('dynamicVariables') or {}).get('recent_history')
    if truthy(rh):
        lines.append(f'recent_history: {js_string(rh)}')
    lines.append(f"Expected opening for this context: {exp['expected']}. Scored as an error: {exp['errors']}.")
    lines.append('')
    lines.append('TRANSCRIPT (turn id · time · speaker; tool calls listed under the turn they belong to)')
    tools_by_turn: dict[int, list[dict]] = {}
    for tc in call['toolCalls']:
        tools_by_turn.setdefault(tc['turnIdx'], []).append(tc)
    for t in call['turns']:
        phase = next((p['name'] for p in phases['phases'] if p['from'] <= t['idx'] <= p['to']), None) if phases else None
        here = tools_by_turn.get(t['idx'], [])
        for tc in [x for x in here if x.get('startS') is not None and x['startS'] < t['startS'] - 0.05]:
            lines.append(f"   ↳ before #{t['idx']}, in silence: {_tool_line(tc)}")
        lines.append(f"#{t['idx']} {fmt_time(t['startS'])} {'AGENT' if t['speaker'] == 'agent' else 'CALLER'}{f' [{phase}]' if phase else ''}{' (interrupted)' if t.get('interrupted') else ''}: {t['text']}")
        for tc in [x for x in here if not (x.get('startS') is not None and x['startS'] < t['startS'] - 0.05)]:
            lines.append(f'   ↳ {_tool_line(tc)}')
    lines.append('')
    raw = call.get('endReasonRaw')
    lines.append(f"CALL END: {call['endReason']}{f' (provider: {raw})' if raw else ''} · duration {js_round(call['durationS'])} s")
    return '\n'.join(lines)


def _tool_line(tc: dict) -> str:
    args = js_json(tc.get('args') if tc.get('args') is not None else {})
    res = tc['resultText'] if tc.get('resultText') is not None else js_json(tc['result']) if tc.get('result') is not None else 'no result'
    a = args[:400] + '…' if len(args) > 400 else args
    r = res[:900] + '…' if len(res) > 900 else res
    err = ' [ERROR]' if tc.get('ok') is False else ''
    dur = f" [{to_fixed(tc['durationS'], 1)} s]" if tc.get('durationS') is not None else ''
    return f"tool {tc['name']}({a}) → {r}{err}{dur}"


METRIC_KEYS_JUDGED = [m['key'] for m in JUDGED_METRICS]


def metric_unit(k: str) -> str:
    return next((m['unit'] for m in METRICS if m['key'] == k), '')
