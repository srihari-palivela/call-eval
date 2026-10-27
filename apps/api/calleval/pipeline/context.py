# Step 2: the opening context. Five facts fixed before the agent says a word decide the expected
# path and which metrics apply: direction, identity, history, objective and persona.

from __future__ import annotations

import json
from typing import Any

from ..js import js_json, jsre
from .text import js_string, lc


def _str(v: Any) -> str:
    return v.strip() if isinstance(v, str) else '' if v is None else js_json(v)


def _reject(c: str) -> Any:
    raise ValueError(c)  # JSON.parse has no NaN or Infinity


def _parse_facts(v: Any) -> Any:
    if v is None or v == '':
        return None
    if isinstance(v, (dict, list)):
        return v
    s = js_string(v).strip()
    if not s or s in ('{}', '[]') or s.lower() == 'none':
        return None
    try:
        o = json.loads(s, parse_constant=_reject)
    except ValueError:
        return s
    return o if isinstance(o, (dict, list)) and len(o) else None


_INBOUND = jsre(r'\b(thanks|thank you) for calling\b')
_OUTBOUND = jsre(r'\b(calling (you )?(about|from|back|regarding)|this is .{1,40} calling|following up)\b')


def infer_direction(call: dict) -> str | None:
    if call.get('direction') != 'unknown':
        return call.get('direction')
    first = next((t for t in call['turns'] if t['speaker'] == 'agent'), None)
    if first is None:
        return 'unknown'
    s = lc(first['text'])
    if _INBOUND.search(s):
        return 'inbound'
    if _OUTBOUND.search(s):
        return 'outbound'
    return 'unknown'


_BROKER = jsre(r'\bbroker\b')
_INVESTOR = jsre(r'\b(investor|buyer|end.?user|family)\b')
_CALLBACK = jsre(r'call ?back|callback', 'i')
_NO_NAME = jsre(r'^(there|unknown|null)$', 'i')


def _first(*vs: Any) -> Any:
    return next((v for v in vs if v is not None), None)


def build_context(call: dict) -> dict:
    dv = call.get('dynamicVariables') or {}
    name = _str(_first(dv.get('customer_name'), dv.get('name'), dv.get('caller_name')))
    facts = _parse_facts(dv.get('known_facts'))
    history = _str(dv.get('recent_history'))
    objective = _str(dv.get('objective'))
    persona = 'unknown'
    fact_text = facts.lower() if isinstance(facts, str) else js_json(facts).lower() if facts is not None else ''
    if _BROKER.search(fact_text):
        persona = 'broker'
    elif _INVESTOR.search(fact_text):
        persona = 'investor'
    objective_kind = 'empty' if not objective else 'callback' if _CALLBACK.search(objective) else 'set'
    return {
        'direction': infer_direction(call),
        'identity': 'known' if name and not _NO_NAME.search(name) else 'unknown',
        'history': 'returning' if (facts is not None and facts != '') or history else 'new',
        'objective': objective_kind,
        'objectiveText': objective or None,
        'persona': persona,
        'personaSource': 'unresolved' if persona == 'unknown' else 'history',
        'customerName': name or None,
        'knownFacts': facts,
    }


def expected_opening(ctx: dict) -> dict:
    """Expected opening per context, as the framework lists it (used by the judge prompt and Context handling)."""
    if ctx['persona'] != 'unknown' and ctx['history'] == 'returning':
        return {'expected': 'Brief acknowledgement of where things stand, then what they need today; skips the persona fork', 'errors': 'Re-asking anything in known_facts; reading history out as a list; offering a meeting or document already done; asking investor-or-broker again'}
    if ctx['direction'] == 'outbound' and ctx['objective'] == 'callback':
        return {'expected': 'First sentence says this is the callback they asked for', 'errors': 'A cold introduction'}
    if ctx['history'] == 'returning':
        return {'expected': 'Brief acknowledgement of where things stand, then what they need today', 'errors': 'Re-asking anything in known_facts; reading history out as a list; offering a meeting or document already done'}
    if ctx['direction'] == 'outbound':
        return {'expected': 'Warm greeting, check it is a good time, then the persona fork on its own', 'errors': 'Skipping the time check; stacking a second question onto the fork; “how can I help you”'}
    if ctx['identity'] == 'known':
        return {'expected': 'Uses the name, answers first, then the persona fork if still unknown', 'errors': 'Asking for the name'}
    return {'expected': 'Asks if they are looking for a property, answers what they rang about, persona fork, name asked once early', 'errors': '“Is now a good time”; mentioning an enquiry; running the guide in order; never asking the name'}
