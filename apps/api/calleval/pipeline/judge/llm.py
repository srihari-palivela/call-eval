# Claude classifier and judge. One request classifies the call (persona, scenarios, intent, events,
# captured fields); a second scores the judged metrics, gates and path checkpoints. Both share a
# cached system prompt (the framework and the active taxonomy) and a cached transcript block, and both
# use structured outputs so every answer arrives as schema-valid JSON.

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

import anthropic
from pydantic import BaseModel

from ...config import config
from ...js import js_json
from ...lib.ids import new_id
from ...lib.log import err_msg, log
from ...taxonomy import Taxonomy, current
from .prompt import render_call, system_prompt
from .types import JUDGED_GATES, JUDGED_METRICS

# ---------- Concurrency ----------
_slots: asyncio.Semaphore | None = None


def _semaphore() -> asyncio.Semaphore:
    global _slots
    if _slots is None:
        _slots = asyncio.Semaphore(max(1, config.llm.max_concurrent))
    return _slots


# ---------- Schemas ----------
def _tag_schema(values: list[str]) -> dict:
    return {
        'type': 'object', 'additionalProperties': False,
        'required': ['value', 'confidence', 'evidence_turns'],
        'properties': {'value': {'type': 'string', 'enum': values}, 'confidence': {'type': 'number'}, 'evidence_turns': {'type': 'array', 'items': {'type': 'integer'}}},
    }


FIELD_KEYS = ['name', 'email', 'phone', 'city', 'buy_intent', 'property_type', 'bedrooms', 'location', 'budget', 'timeline', 'must_haves', 'who_for', 'broker_type', 'registration', 'project_interest']
SEGMENTS = ['Discovery', 'Pitch', 'Objection', 'Action', 'Off-topic']


def classifier_schema(tax: Taxonomy) -> dict:
    """The classifier's answer, with the active taxonomy's ids as the allowed values."""
    return {
        'type': 'object', 'additionalProperties': False,
        'required': ['persona', 'persona_resolved_turn', 'scenario_primary', 'scenario_secondary', 'intent_start', 'intent_end', 'events', 'fields', 'budget_aed', 'timeline_months', 'language', 'summary', 'body_segments'],
        'properties': {
            'persona': _tag_schema([*[p['id'] for p in tax.personas], tax.p0['id']]),
            'persona_resolved_turn': {'type': 'integer', 'description': 'Turn id where investor or broker became clear; -1 if never; 0 if known from history.'},
            'scenario_primary': _tag_schema([s['id'] for s in tax.scenarios]),
            'scenario_secondary': _tag_schema([*[s['id'] for s in tax.scenarios], 'none']),
            'intent_start': _tag_schema(['hot', 'warm', 'cold']),
            'intent_end': _tag_schema(['hot', 'warm', 'cold']),
            'events': {'type': 'array', 'items': {'type': 'object', 'additionalProperties': False, 'required': ['type', 'turn'], 'properties': {'type': {'type': 'string', 'enum': [e['id'] for e in tax.events]}, 'turn': {'type': 'integer'}}}},
            'fields': {'type': 'object', 'additionalProperties': False, 'required': FIELD_KEYS, 'properties': {k: {'type': 'string', 'description': 'Captured value, or empty string when not captured in this call.'} for k in FIELD_KEYS}},
            'budget_aed': {'type': 'number', 'description': 'Stated budget in AED; 0 when not stated.'},
            'timeline_months': {'type': 'number', 'description': 'Months until the caller wants to buy or move; -1 when not stated.'},
            'language': {'type': 'string', 'description': 'ISO 639-1 code of the main language spoken.'},
            'summary': {'type': 'string', 'description': 'One sentence on what the caller wanted and how the call ended, without names or numbers.'},
            'body_segments': {'type': 'array', 'items': {'type': 'object', 'additionalProperties': False, 'required': ['turn', 'segment'], 'properties': {'turn': {'type': 'integer'}, 'segment': {'type': 'string', 'enum': SEGMENTS}}}},
        },
    }


_METRIC_ITEM = {'type': 'object', 'additionalProperties': False, 'required': ['applicable', 'raw', 'evidence_turns', 'rationale'], 'properties': {'applicable': {'type': 'boolean'}, 'raw': {'type': 'number'}, 'evidence_turns': {'type': 'array', 'items': {'type': 'integer'}}, 'rationale': {'type': 'string'}}}
_GATE_ITEM = {'type': 'object', 'additionalProperties': False, 'required': ['failed', 'turn', 'detail'], 'properties': {'failed': {'type': 'boolean'}, 'turn': {'type': 'integer', 'description': '-1 when not failed'}, 'detail': {'type': 'string'}}}

JUDGE_SCHEMA = {
    'type': 'object', 'additionalProperties': False,
    'required': ['metrics', 'gates', 'checkpoints', 'coaching'],
    'properties': {
        'metrics': {'type': 'object', 'additionalProperties': False, 'required': [m['key'] for m in JUDGED_METRICS], 'properties': {m['key']: _METRIC_ITEM for m in JUDGED_METRICS}},
        'gates': {'type': 'object', 'additionalProperties': False, 'required': JUDGED_GATES, 'properties': {g: _GATE_ITEM for g in JUDGED_GATES}},
        'checkpoints': {'type': 'array', 'items': {'type': 'object', 'additionalProperties': False, 'required': ['id', 'hit', 'turn'], 'properties': {'id': {'type': 'string'}, 'hit': {'type': 'boolean'}, 'turn': {'type': 'integer'}}}},
        'coaching': {'type': 'array', 'items': {'type': 'object', 'additionalProperties': False, 'required': ['turn', 'issue', 'better_response'], 'properties': {'turn': {'type': 'integer'}, 'issue': {'type': 'string'}, 'better_response': {'type': 'string', 'description': 'What the agent should have said instead, in its own voice.'}}}},
    },
}


class ZTag(BaseModel):
    value: str
    confidence: float
    evidence_turns: list[int]


class ZEvent(BaseModel):
    type: str
    turn: int


class ZSegment(BaseModel):
    turn: int
    segment: str


class ZClassifier(BaseModel):
    persona: ZTag
    persona_resolved_turn: int
    scenario_primary: ZTag
    scenario_secondary: ZTag
    intent_start: ZTag
    intent_end: ZTag
    events: list[ZEvent]
    fields: dict[str, str]
    budget_aed: float
    timeline_months: float
    language: str
    summary: str
    body_segments: list[ZSegment]


class ZMetric(BaseModel):
    applicable: bool
    raw: float
    evidence_turns: list[int]
    rationale: str


class ZGate(BaseModel):
    failed: bool
    turn: int
    detail: str


class ZCheckpoint(BaseModel):
    id: str
    hit: bool
    turn: int


class ZCoaching(BaseModel):
    turn: int
    issue: str
    better_response: str


class ZJudge(BaseModel):
    metrics: dict[str, ZMetric]
    gates: dict[str, ZGate]
    checkpoints: list[ZCheckpoint]
    coaching: list[ZCoaching]


# ---------- Client ----------
_client: anthropic.AsyncAnthropic | None = None
_fallbacks_supported: bool | None = None
_prompts: tuple[Taxonomy, str, dict] | None = None


def _for_taxonomy() -> tuple[str, dict]:
    """System prompt and classifier schema for the active taxonomy, rebuilt when it changes."""
    global _prompts
    tax = current()
    if _prompts is None or _prompts[0] is not tax:
        _prompts = (tax, system_prompt(tax), classifier_schema(tax))
    return _prompts[1], _prompts[2]


def get_client() -> anthropic.AsyncAnthropic:
    global _client
    if _client is None:
        _client = anthropic.AsyncAnthropic(max_retries=3, timeout=600)
    return _client


def set_client(client: Any) -> None:
    """Replace the Anthropic client (tests pass a fake)."""
    global _client
    _client = client


class FailedRun(Exception):
    """An LLM step that failed; `run` is its RunInfo for the trace."""

    def __init__(self, message: str, run: dict):
        super().__init__(message)
        self.run = run


async def structured_call(call_text: str, instruction: str, schema: dict, effort: str) -> dict:
    global _fallbacks_supported
    if _fallbacks_supported is None:
        _fallbacks_supported = config.llm.fallbacks
    async with _semaphore():
        params: dict[str, Any] = {
            'model': config.llm.model,
            'max_tokens': 32000,
            'system': [{'type': 'text', 'text': _for_taxonomy()[0], 'cache_control': {'type': 'ephemeral'}}],
            'messages': [{
                'role': 'user',
                'content': [
                    {'type': 'text', 'text': call_text, 'cache_control': {'type': 'ephemeral'}},
                    {'type': 'text', 'text': instruction},
                ],
            }],
            'output_config': {'effort': effort, 'format': {'type': 'json_schema', 'schema': schema}},
        }

        async def send(with_fallbacks: bool) -> Any:
            req = {**params, 'betas': ['server-side-fallback-2026-07-01'], 'fallbacks': 'default'} if with_fallbacks else params
            async with get_client().beta.messages.stream(**req) as s:
                return await s.get_final_message()

        try:
            msg = await send(_fallbacks_supported)
        except anthropic.BadRequestError as e:
            # Some deployments (gateways, other platforms) reject the fallbacks parameter; retry once without it.
            if _fallbacks_supported and 'fallback' in str(e).lower():
                _fallbacks_supported = False
                log.warn('Claude fallbacks not accepted here; continuing without them', {'error': str(e)})
                msg = await send(False)
            else:
                raise
        if msg.stop_reason == 'refusal':
            details = getattr(msg, 'stop_details', None)
            category = getattr(details, 'category', None) if details is not None else None
            raise RuntimeError(f"Claude declined to evaluate this call ({category or 'no category'})")
        if msg.stop_reason == 'max_tokens':
            raise RuntimeError('Claude response hit max_tokens before finishing')
        text = ''.join(b.text for b in msg.content if getattr(b, 'type', None) == 'text')
        u = msg.usage
        usage = {
            'input': (u.input_tokens or 0) + (getattr(u, 'cache_read_input_tokens', 0) or 0) + (getattr(u, 'cache_creation_input_tokens', 0) or 0),
            'output': u.output_tokens or 0,
        }
        return {'json': json.loads(text), 'usage': usage, 'model': msg.model}


def _clamp_turn(n: Any, mx: int) -> int | None:
    return n if isinstance(n, int) and not isinstance(n, bool) and 0 <= n <= mx else None


def _clamp_turns(xs: list[int], mx: int) -> list[int]:
    return list(dict.fromkeys(n for n in xs if isinstance(n, int) and 0 <= n <= mx))[:6]


def _failed_run(kind: str, t0: float, e: BaseException) -> dict:
    return {'id': new_id('run'), 'kind': kind, 'mode': 'llm', 'model': config.llm.model, 'inputTokens': 0, 'outputTokens': 0,
            'latencyMs': int((time.monotonic() - t0) * 1000), 'status': 'error', 'error': err_msg(e)}


class _Claude:
    mode = 'llm'

    @property
    def model(self) -> str:
        return config.llm.model

    async def classify(self, inp: dict) -> dict:
        t0 = time.monotonic()
        mx = len(inp['call']['turns']) - 1
        rules = inp['rules']
        fixed: list[str] = []
        if rules.get('persona'):
            fixed.append(f"persona = {rules['persona']['value']} (set by rule from the tool log)")
        if rules.get('scenarioPrimary'):
            fixed.append(f"scenario_primary = {rules['scenarioPrimary']['value']} (set by rule)")
        if rules.get('scenarioCandidates'):
            fixed.append(f"candidate scenario: {', '.join(rules['scenarioCandidates'])} (objective set or prior history)")
        family = current().persona_for('P1')
        example = (f'a caller who opens as "just looking" and reveals a family move is {family}.' if family
                   else 'a caller who opens vaguely and later states a clear need belongs to the persona that need describes.')
        rule_line = f"Rule-layer tags already fixed — return them unchanged with confidence 1 and cite their turns: {'; '.join(fixed)}." if fixed else 'No rule-layer tags fired.'
        instruction = f"""TASK: classify this call against taxonomy v{inp['taxonomyVersion']}.
{rule_line}
Give a confidence from 0 to 1 for every tag (below 0.7 sends it to a human reviewer, so be honest). Judge the persona at the end of the call: {example} Use scenario_secondary "none" when one journey covers the call. List every event with the turn it happens on. Fill captured fields only with what the caller said or confirmed in this call. Label every body-phase turn with its segment."""
        try:
            r = await structured_call(render_call(inp['call'], inp['ctx']), instruction, _for_taxonomy()[1], config.llm.effort)
            o = ZClassifier.model_validate(r['json'])

            def tag(t: ZTag) -> dict:
                return {'value': None if t.value == 'none' else t.value, 'confidence': max(0, min(1, t.confidence)), 'evidence': _clamp_turns(t.evidence_turns, mx)}

            fields = {k: (o.fields[k].strip() if (o.fields.get(k) or '').strip() else None) for k in FIELD_KEYS}
            segs = {s.turn: s.segment for s in o.body_segments if s.segment in SEGMENTS and _clamp_turn(s.turn, mx) is not None}
            run = {'id': new_id('run'), 'kind': 'classifier', 'mode': 'llm', 'model': r['model'], 'inputTokens': r['usage']['input'], 'outputTokens': r['usage']['output'],
                   'latencyMs': int((time.monotonic() - t0) * 1000), 'status': 'ok', 'output': o.model_dump()}
            event_ids = {e['id'] for e in current().events}
            ct = _clamp_turn(o.persona_resolved_turn, mx) if o.persona_resolved_turn >= 0 else None
            return {
                'persona': tag(o.persona), 'personaResolvedTurn': ct,
                'scenarioPrimary': tag(o.scenario_primary), 'scenarioSecondary': tag(o.scenario_secondary),
                'intentStart': tag(o.intent_start), 'intentEnd': tag(o.intent_end),
                'events': [{'type': e.type, 'turn': _clamp_turn(e.turn, mx) or 0} for e in o.events if e.type in event_ids],
                'fields': fields, 'budgetAed': o.budget_aed if o.budget_aed > 0 else None, 'timelineMonths': o.timeline_months if o.timeline_months >= 0 else None,
                'language': o.language or None, 'summary': o.summary, 'turnSegments': segs, 'run': run,
            }
        except Exception as e:  # noqa: BLE001 - the caller falls back to the heuristic classifier
            log.error('Claude classifier failed', {'call': inp['call'].get('externalId'), 'error': err_msg(e)})
            raise FailedRun(f'classifier: {err_msg(e)}', _failed_run('classifier', t0, e)) from e

    async def judge(self, inp: dict) -> dict:
        t0 = time.monotonic()
        mx = len(inp['call']['turns']) - 1
        cps = '\n'.join(f"- {c['id']}: {c['label']}" + (f" ({c['hint']})" if c.get('hint') else '') for c in inp['checkpoints'])
        phases = ', '.join(f"{p['name']} #{p['from']}–#{p['to']}" for p in inp['phases']['phases']) or 'none'
        captured = js_json({k: v for k, v in inp['fields'].items() if v})
        scen2 = f", secondary {inp['scenario2']}" if inp.get('scenario2') else ''
        instruction = f"""TASK: judge this call.
Persona {inp.get('personaId') or 'P0'} ({inp['personaPath']} path); primary scenario {inp.get('scenario') or 'unknown'}{scen2}.
Phases: {phases}.
Captured fields: {captured}.
1. Score every judged metric in its raw unit, or mark it not applicable.
2. Decide every gate. For G1 compare each project fact the agent stated with the get_project_details output in this call; a fact with no tool output behind it, or that differs from it, fails. G8 fails when the agent claims a booking, cancellation or send that no tool result confirmed.
3. For these expected-path checkpoints of {inp.get('scenario') or 'the scenario'}, say whether each was reached and on which turn (-1 if missed):
{cps or '- none'}
4. Coaching: for the (up to) three moments that cost the call most, give the turn, the issue, and what the agent should have said instead."""
        try:
            r = await structured_call(render_call(inp['call'], inp['ctx'], inp['phases']), instruction, JUDGE_SCHEMA, config.llm.effort)
            o = ZJudge.model_validate(r['json'])
            metrics = {}
            for m in JUDGED_METRICS:
                x = o.metrics.get(m['key'])
                if x is not None:
                    metrics[m['key']] = {'applicable': x.applicable, 'raw': x.raw if x.applicable else None, 'evidence': _clamp_turns(x.evidence_turns, mx), 'rationale': x.rationale}
            gates = {}
            for g in JUDGED_GATES:
                x = o.gates.get(g)
                if x is not None:
                    gates[g] = {'failed': x.failed, 'turn': _clamp_turn(x.turn, mx) if x.failed else None, 'detail': x.detail}
            checkpoints = {c.id: {'hit': c.hit, 'turn': _clamp_turn(c.turn, mx) if c.hit else None} for c in o.checkpoints}
            run = {'id': new_id('run'), 'kind': 'judge', 'mode': 'llm', 'model': r['model'], 'inputTokens': r['usage']['input'], 'outputTokens': r['usage']['output'],
                   'latencyMs': int((time.monotonic() - t0) * 1000), 'status': 'ok', 'output': o.model_dump()}
            coaching = [{'turn': _clamp_turn(c.turn, mx), 'issue': c.issue, 'better': c.better_response} for c in o.coaching[:3]]
            return {'metrics': metrics, 'gates': gates, 'checkpoints': checkpoints, 'coaching': coaching, 'run': run}
        except Exception as e:  # noqa: BLE001 - the caller falls back to the heuristic judge
            log.error('Claude judge failed', {'call': inp['call'].get('externalId'), 'error': err_msg(e)})
            raise FailedRun(f'judge: {err_msg(e)}', _failed_run('judge', t0, e)) from e


claude = _Claude()
