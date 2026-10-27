# Text simulations for the Probe step: Claude plays a caller from a real call's brief and plays the agent
# under a given prompt; the agent's tools answer from that real call's tool results. Each transcript becomes
# a canonical call (provider 'simulation') and is scored by the evaluation pipeline with the heuristic judge,
# so the champion and every candidate are measured by the same deterministic verifier on the same callers.
# Provider simulation endpoints are not used: ElevenLabs deprecated its simulate-conversation API and Retell
# has none.

from __future__ import annotations

import json
from typing import Any

from ..config import config, env
from ..js import fixed, js_json
from ..lib.claude import request_json
from ..lib.ids import new_id
from ..taxonomy import persona_by_id, scenario_by_id

SIM_RULES = """

# Simulation harness (not part of your instructions above)
This is a text simulation of a phone call, used to test your instructions. Speak exactly as you would on the call:
one short spoken turn at a time, no stage directions. To use a tool, list it in tool_calls with its arguments as a
JSON object string; you will get the result and then say your next line. Set end_call when the call is over."""

AGENT_SCHEMA = {
    'type': 'object', 'additionalProperties': False, 'required': ['say', 'tool_calls', 'end_call'],
    'properties': {
        'say': {'type': 'string', 'description': 'What you say aloud this turn; empty only when you call a tool first.'},
        'tool_calls': {'type': 'array', 'items': {'type': 'object', 'additionalProperties': False, 'required': ['name', 'args_json'],
                                                   'properties': {'name': {'type': 'string'}, 'args_json': {'type': 'string'}}}},
        'end_call': {'type': 'boolean'},
    },
}
CALLER_SCHEMA = {
    'type': 'object', 'additionalProperties': False, 'required': ['say', 'end_call'],
    'properties': {'say': {'type': 'string'}, 'end_call': {'type': 'boolean', 'description': 'True when you would hang up after saying this.'}},
}


class Budget:
    """LLM spend for one improvement cycle; simulations stop once the token budget is used up."""

    def __init__(self, limit_tokens: int | None = None):
        self.limit = limit_tokens if limit_tokens is not None else int(env('IMPROVE_TOKEN_BUDGET') or 1_500_000)
        self.llm_calls = 0
        self.input_tokens = 0
        self.output_tokens = 0

    @property
    def exceeded(self) -> bool:
        return self.input_tokens + self.output_tokens >= self.limit

    def to_dict(self) -> dict:
        return {'llmCalls': self.llm_calls, 'inputTokens': self.input_tokens, 'outputTokens': self.output_tokens, 'tokenBudget': self.limit}


def sim_model() -> str:
    return env('CLAUDE_SIM_MODEL') or config.llm.model


async def claude_json(system: str, user: str, schema: dict, *, budget: Budget, effort: str = 'low', model: str | None = None,
                      max_tokens: int = 4000, cache_system: bool = True) -> dict:
    """One structured-output request, counted against the cycle's budget."""
    r = await request_json(system, user, schema, model=model or sim_model(), effort=effort, max_tokens=max_tokens, cache_system=cache_system)
    budget.llm_calls += 1
    budget.input_tokens += r['usage']['input']
    budget.output_tokens += r['usage']['output']
    return r['json']


# ---------- Tasks from real calls ----------

def caller_brief(call: dict, persona: str | None, scenario: str | None) -> str:
    """Who the simulated caller is, from a real call: persona, journey, and what they actually said."""
    p = persona_by_id(persona)
    s = scenario_by_id(scenario)
    said = '\n'.join(f'- {t["text"]}' for t in call.get('turns') or [] if t.get('speaker') == 'caller')[:4000]
    return f"""You play a caller in a test of an AI sales agent for a Dubai real-estate developer. Stay in character.
Who you are: {p['name']} ({p['path']} path). {p['signals']}.
{f"What you want from this call: {s['trigger']}. It goes well for you if: {s['success']}." if s else ''}
In the real call this is based on, you said the following; keep the same needs, facts, mood and objections, in your own words:
{said or '- (you said very little)'}
Speak like a person on the phone: short turns, answer what you are asked, don't volunteer everything at once. If the agent does
something you would not accept, react as this caller would. Set end_call to true when you would hang up."""


def task_from_call(call_id: str, call: dict, persona: str | None, scenario: str | None) -> dict:
    results: dict[str, list[str]] = {}
    for tc in call.get('toolCalls') or []:
        txt = tc.get('resultText') if tc.get('resultText') is not None else (js_json(tc['result']) if tc.get('result') is not None else None)
        if txt is not None:
            results.setdefault(tc['name'], []).append(txt)
    dv = call.get('dynamicVariables') or {}
    keep = {k: dv[k] for k in ('customer_name', 'known_facts', 'recent_history', 'objective', 'lead_id') if dv.get(k) not in (None, '')}
    return {'callId': call_id, 'brief': caller_brief(call, persona, scenario), 'toolResults': results, 'dynamicVariables': keep,
            'direction': call.get('direction') or 'outbound', 'persona': persona, 'scenario': scenario}


# ---------- One simulated call ----------

def _transcript(lines: list[str]) -> str:
    return '\n'.join(lines) if lines else '(the call has just connected)'


async def simulate(task: dict, agent_prompt: str, *, budget: Budget, max_turns: int | None = None, label: str = 'sim') -> dict:
    """Run one call between the task's caller and an agent with `agent_prompt`; returns a canonical call."""
    max_turns = max_turns or int(env('IMPROVE_MAX_TURNS') or 14)
    pending = {k: list(v) for k, v in task['toolResults'].items()}
    system = agent_prompt + SIM_RULES
    lines: list[str] = []
    turns: list[dict] = []
    tools: list[dict] = []
    t = 0.0
    ended_by = None

    def add_turn(speaker: str, text: str) -> int:
        nonlocal t
        dur = max(1.0, len(text.split()) / 2.6)
        start = t + (0.8 if turns and turns[-1]['speaker'] != speaker else 0.3)
        turns.append({'idx': len(turns), 'speaker': speaker, 'text': text, 'startS': fixed(start, 2), 'endS': fixed(start + dur, 2)})
        t = start + dur
        lines.append(f"{'AGENT' if speaker == 'agent' else 'CALLER'}: {text}")
        return len(turns) - 1

    ctx = f"Call context (dynamic variables): {js_json(task['dynamicVariables'])}\n" if task['dynamicVariables'] else ''
    while len(turns) < max_turns and not budget.exceeded:
        a = await claude_json(system, f"{ctx}Transcript so far:\n{_transcript(lines)}\n\nYour next turn as the agent.", AGENT_SCHEMA, budget=budget)
        said = (a.get('say') or '').strip()
        calls = a.get('tool_calls') or []
        idx = add_turn('agent', said) if said else None
        if calls:
            results = []
            for c in calls[:3]:
                name = str(c.get('name') or '')
                try:
                    args = json.loads(c.get('args_json') or '{}')
                except ValueError:
                    args = {'raw': c.get('args_json')}
                res = pending.get(name, []).pop(0) if pending.get(name) else js_json({'status': 'not available in this simulation'})
                results.append((name, args if isinstance(args, dict) else {'value': args}, res))
                lines.append(f'TOOL {name}({js_json(args)}) → {res}')
            follow = await claude_json(system, f"{ctx}Transcript so far:\n{_transcript(lines)}\n\nThe tool results are in. Your next line to the caller.", AGENT_SCHEMA, budget=budget)
            fsay = (follow.get('say') or '').strip()
            wait = 0.4 * len(results)
            if idx is not None:
                # A filler line was spoken first; the tools ran while it played.
                target, tool_start = idx, turns[idx]['startS'] + 0.05
                if fsay:
                    add_turn('agent', fsay)
            else:
                # No filler: the caller waits in silence while the tools run.
                tool_start = t + 0.3
                t += wait
                target = add_turn('agent', fsay) if fsay else max(0, len(turns) - 1)
            for name, args, res in results:
                tools.append({'id': new_id('stc'), 'turnIdx': target, 'name': name, 'args': args, 'resultText': res, 'result': _parse(res),
                              'ok': 'error' not in res.lower(), 'startS': fixed(tool_start, 2), 'durationS': 0.4})
            a = follow if follow.get('end_call') else a
        if a.get('end_call'):
            ended_by = 'agent'
            break
        if len(turns) >= max_turns or budget.exceeded:
            break
        cl = await claude_json(task['brief'], f"Transcript so far:\n{_transcript(lines)}\n\nYour next turn as the caller.", CALLER_SCHEMA, budget=budget)
        csay = (cl.get('say') or '').strip()
        if csay:
            add_turn('caller', csay)
        if cl.get('end_call'):
            ended_by = 'caller'
            break
    end_reason = 'natural_close' if ended_by == 'agent' else 'caller_hangup' if ended_by == 'caller' else 'time_limit' if len(turns) >= max_turns else 'unknown'
    return {
        'provider': 'simulation', 'externalId': new_id(label), 'agentExternalId': None, 'agentName': 'Simulation', 'agentVersion': None,
        'startedAt': '2026-01-01T00:00:00.000Z', 'durationS': fixed(t + 0.5, 1), 'direction': task.get('direction') or 'outbound',
        'endReason': end_reason, 'endReasonRaw': ended_by, 'language': 'en', 'dynamicVariables': dict(task['dynamicVariables']),
        'turns': turns, 'toolCalls': tools, 'recording': {'available': False}, 'providerAnalysis': None, 'latency': None, 'cost': None,
        'leadId': None, 'promptVersionHint': None,
    }


def _parse(s: str) -> Any:
    try:
        return json.loads(s)
    except ValueError:
        return s
