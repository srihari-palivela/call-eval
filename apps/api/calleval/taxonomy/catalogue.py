# The framework's own taxonomy entries, which user-defined entries anchor to with `basedOn`, the code
# detectors a checkpoint can use, and the templates a new draft can start from.
#
# Code that needs a specific framework entry (the failed-call rule, the broker-registration rule, the
# per-persona checks) asks for "the active entry based on S12", never for the id S12, so a user-defined
# taxonomy keeps those rules wherever an entry inherits them.

from __future__ import annotations

import copy

from ..framework import EVENT_TYPES, FACETS, P0, PATHS, PERSONAS, SCENARIOS, TAXONOMY_VERSION

BUILTIN_PERSONAS = {p['id']: p for p in PERSONAS}
BUILTIN_SCENARIOS = {s['id']: s for s in SCENARIOS}
BUILTIN_EVENTS = {e['id']: e for e in EVENT_TYPES}

DEFAULT_DOMAIN = 'a Dubai real-estate developer selling off-plan homes. Callers are investors, brokers or non-target callers.'

PERSONA_PATHS = ('Investor', 'Broker', 'Non-target')
EVENT_GROUPS = ('Objections', 'Caller behaviour', 'Agent or system', 'Outcome moments')

# Events code detects (rules, tool results, timing, gates): every taxonomy keeps them; only the label is editable.
SYSTEM_EVENTS = ('tool_failure', 'transfer_unavailable', 'whatsapp_fallback_email', 'time_limit_reached', 'gate_failure', 'asked_if_ai',
                 'dnc_request', 'interruption_burst')

# Code detectors for checkpoints with detect.by = 'rule' (pipeline/path.py).
RULES: list[dict] = [
    {'id': 'persona_resolved', 'label': 'Persona resolved', 'description': 'The caller’s path (investor or broker) became clear.'},
    {'id': 'discovery', 'label': 'Discovery', 'description': 'A discovery segment in which at least two needs were captured.'},
    {'id': 'filler_before_transfer', 'label': 'Filler before transfer', 'description': 'The agent spoke a filler line before calling the live-transfer tool.'},
    {'id': 'transfer_outcome', 'label': 'Transfer outcome', 'description': 'Handed over, or a callback or note saved when nobody was free.'},
    {'id': 'short_call', 'label': 'Short call', 'description': 'Ended within 60 seconds or 4 turns.'},
    {'id': 'tool_confirmed_readback', 'label': 'Change read back', 'description': 'The agent read back the change the meeting tool confirmed.'},
    {'id': 'question_after_send', 'label': 'Question after sending', 'description': 'One follow-up question after documents were sent.'},
    {'id': 'no_further_pitch', 'label': 'No further pitch', 'description': 'No pitch after the caller refused (after the second refusal when the checkpoint id is "stop").'},
]
RULE_IDS = {r['id'] for r in RULES}


def builtin_doc() -> dict:
    """Taxonomy v1.0 as a document: every entry based on itself, scenarios with the framework's paths."""
    return {
        'domain': DEFAULT_DOMAIN,
        'personas': [{**p, 'basedOn': p['id'], 'keywords': []} for p in PERSONAS],
        'scenarios': [{**s, 'basedOn': s['id'], 'keywords': [], 'checkpoints': copy.deepcopy(PATHS.get(s['id'], []))} for s in SCENARIOS],
        'events': [{**e, 'basedOn': e['id'], 'keywords': [], 'system': e['id'] in SYSTEM_EVENTS} for e in EVENT_TYPES],
    }


def _judge(id: str, label: str, hint: str) -> dict:
    return {'id': id, 'label': label, 'hint': hint, 'detect': {'by': 'judge'}}


def _tool(id: str, label: str, *tools: str) -> dict:
    return {'id': id, 'label': label, 'detect': {'by': 'tool', 'tools': list(tools)}}


def _rule(id: str, label: str, rule: str) -> dict:
    return {'id': id, 'label': label, 'detect': {'by': 'rule', 'rule': rule}}


def _p(id: str, name: str, path: str, signals: str, watch: str, check: str, keywords: list[str], based: str | None = None) -> dict:
    return {'id': id, 'name': name, 'path': path, 'signals': signals, 'watch': watch, 'checkLabel': check, 'basedOn': based, 'keywords': keywords}


def _s(id: str, name: str, short: str, trigger: str, path: str, success: str, based: str | None, checkpoints: list[dict],
       keywords: list[str] | None = None) -> dict:
    return {'id': id, 'name': name, 'short': short, 'trigger': trigger, 'path': path, 'success': success, 'basedOn': based,
            'keywords': keywords or [], 'checkpoints': checkpoints}


def _b2b_doc() -> dict:
    """A starting point for selling to businesses: demos and meetings booked by phone."""
    events = [{**e, 'basedOn': e['id'], 'keywords': [], 'system': e['id'] in SYSTEM_EVENTS}
              for e in EVENT_TYPES if e['id'] not in ('objection_location', 'objection_family', 'project_chosen', 'visit_requested', 'whatsapp_fallback_email')]
    events += [
        {'id': 'whatsapp_fallback_email', 'label': 'Message fallback to email', 'group': 'Agent or system', 'basedOn': 'whatsapp_fallback_email', 'keywords': [], 'system': True},
        {'id': 'objection_authority', 'label': 'Objection · not the decision maker', 'group': 'Objections', 'basedOn': None,
         'keywords': ['not my decision', 'talk to my boss', 'run it by', 'need approval'], 'system': False},
        {'id': 'objection_incumbent', 'label': 'Objection · already have a provider', 'group': 'Objections', 'basedOn': None,
         'keywords': ['already use', 'already have a provider', 'under contract', 'happy with our current'], 'system': False},
        {'id': 'demo_requested', 'label': 'Demo requested', 'group': 'Outcome moments', 'basedOn': None, 'keywords': ['show me', 'see a demo', 'walk me through'],
         'system': False},
    ]
    return {
        'domain': 'a company selling its product to businesses by phone, booking demos and meetings with its sales team. Callers are buyers '
                  '(decision makers and evaluators), partners or resellers, and non-target callers.',
        'personas': [
            _p('P1', 'Decision maker', 'Investor', 'Owns the budget or the decision; talks about rollout, contracts, price and timing',
               'Get to a meeting with the right people; no over-explaining', 'Meeting offered once needs are known',
               ['my budget', 'i decide', 'sign off', 'our company', 'roll out', 'contract']),
            _p('P2', 'Evaluator', 'Investor', 'Researching for someone else; compares features, asks for material and pricing pages',
               'Equip them to sell internally; find out who decides', 'Decision maker identified',
               ['researching', 'comparing', 'for my manager', 'send me something', 'shortlist']),
            _p('P3', 'Small business owner', 'Investor', 'Owner-operator; price-sensitive; wants something simple that works quickly',
               'Plain language; short path to a trial or meeting', 'Price questions answered plainly', ['my shop', 'my business', 'small team', 'just me']),
            _p('P4', 'Existing customer', 'Non-target', 'Already a customer; billing, support or account questions',
               'Routed to support or the account manager, not pitched', 'Calls that included a pitch',
               ['my account', 'already a customer', 'support ticket', 'invoice', 'not working']),
            _p('P5', 'Partner or reseller', 'Broker', 'Agency, reseller, consultant or integrator wanting to work together',
               'Partner programme and the partner team, not buyer discovery', 'Buyer questions asked per call',
               ['partner', 'reseller', 'agency', 'refer clients', 'integrator']),
            _p('P6', 'Other', 'Non-target', 'Vendor, job seeker, wrong number, spam', 'Short, polite close', 'Closed within 60 seconds',
               ['job opening', 'vacancy', 'wrong number', 'supplier', 'vendor', 'recruit'], 'P11'),
        ],
        'scenarios': [
            _s('S1', 'Discovery to demo', 'Discovery', 'Open interest, needs not yet known', 'Persona → needs → fit → demo or meeting booked',
               'Demo or meeting booked', 'S1', [
                   _rule('persona', 'Persona resolved', 'persona_resolved'),
                   _judge('needs', 'Needs uncovered', 'Use case, team size and current tool asked before pitching'),
                   _judge('fit', 'Fit explained', 'One or two capabilities tied to the stated needs, not a feature list'),
                   _tool('booking', 'Demo booked', 'schedule_meeting'),
               ]),
            _s('S2', 'Product question', 'Question', 'Asks how the product does something specific', 'Answer from the knowledge base → qualify → next step',
               'Question answered accurately, plus a next step', 'S2', [
                   _judge('answer', 'Answered from facts', 'The answer comes from tool data or the knowledge base, not guessed'),
                   _judge('qualify', 'Qualify around it', 'A question about their use case tied to what they asked'),
                   _judge('next_step', 'Offer a next step', 'A demo, material, callback or transfer offered'),
               ], ['does it', 'can it', 'integrate with', 'how does']),
            _s('S3', 'Pricing or quote', 'Pricing', 'Asks for price, a quote or a proposal', 'Confirm scope → share pricing or send a quote → next step',
               'Pricing shared or quote sent, plus a next step', 'S3', [
                   _judge('scope', 'Scope confirmed', 'Seats, plan or volume confirmed before quoting'),
                   _tool('send', 'Quote or pricing sent', 'send_documents'),
                   _rule('follow_up', 'One follow-up question', 'question_after_send'),
               ], ['how much', 'pricing', 'quote', 'proposal', 'cost']),
            _s('S4', 'Callback request', 'Callback', 'Busy, driving, “call me later”', 'Repeat time back → schedule_callback',
               'Callback booked at the caller’s time', 'S4', copy.deepcopy(PATHS['S4'])),
            _s('S5', 'Live transfer', 'Transfer', 'Wants a person now', 'Filler → request_live_transfer → hand-over or graceful fallback',
               'Connected, or a callback or note when nobody is free', 'S5', copy.deepcopy(PATHS['S5'])),
            _s('S6', 'Meeting change', 'Mtg change', 'Reschedule or cancel', 'Move with schedule_meeting, or a clear-cut cancel_meeting',
               'Change confirmed by the tool', 'S6', copy.deepcopy(PATHS['S6'])),
            _s('S7', 'Partner enquiry', 'Partner', 'Caller wants to partner or resell', 'Partner type → programme → partner-team call',
               'Partner team call booked or programme details sent', 'S7', [
                   _judge('type', 'Partner type asked', 'Agency, reseller, consultant or integrator established'),
                   _judge('programme', 'Programme explained', 'How the partner programme works, in a sentence or two'),
                   _judge('team', 'Partner-team call offered', 'A call with the partner team offered or booked'),
               ]),
            _s('S8', 'Objection-led', 'Objection', 'Price, timing, authority or an incumbent provider dominates',
               'Acknowledge → one alternative → soft end; stop after a second no', 'Alternative accepted, or material or a callback kept the lead open',
               'S8', copy.deepcopy(PATHS['S8'])),
            _s('S9', 'Returning follow-up', 'Returning', 'objective set or prior history', 'Acknowledge where things stand → the objective',
               'The objective completed', 'S9', copy.deepcopy(PATHS['S9'])),
            _s('S10', 'Not interested', 'Not interested', 'Declines, or asks not to be contacted', 'Accept the first time; honour do-not-contact',
               'Clean, courteous close, no further contact', 'S10', copy.deepcopy(PATHS['S10'])),
            _s('S11', 'Support or out of scope', 'Out of scope', 'Support, billing, legal or anything the agent can’t handle',
               'One-line deflection → right team → back on track', 'Routed correctly, with nothing promised', 'S11', [
                   _judge('deflect', 'One-line deflection', 'Says plainly it can’t help with that here'),
                   _judge('redirect', 'Right team', 'Support, billing or the account manager named, or a ticket raised'),
                   _judge('back', 'Back on track', 'Offers what it can help with, or closes politely'),
               ]),
            _s('S12', 'Failed call', 'Failed', 'Voicemail, silence, dropped line, wrong number, language mismatch', 'End or leave a message quickly',
               'Short, with nothing wrong claimed', 'S12', copy.deepcopy(PATHS['S12'])),
        ],
        'events': events,
    }


TEMPLATES: dict[str, dict] = {
    'real_estate': {'name': 'Off-plan real estate (framework default)',
                    'description': 'Taxonomy v1.0: investors, brokers and non-target callers for a developer selling off-plan homes.', 'doc': builtin_doc},
    'b2b_sales': {'name': 'B2B sales: demos and meetings',
                  'description': 'Decision makers, evaluators, partners and existing customers; discovery to demo, pricing, partner enquiries.', 'doc': _b2b_doc},
}


def template_doc(id: str) -> dict | None:
    t = TEMPLATES.get(id)
    return t['doc']() if t else None


def templates() -> list[dict]:
    return [{'id': k, 'name': v['name'], 'description': v['description']} for k, v in TEMPLATES.items()]


__all__ = ['BUILTIN_EVENTS', 'BUILTIN_PERSONAS', 'BUILTIN_SCENARIOS', 'DEFAULT_DOMAIN', 'EVENT_GROUPS', 'FACETS', 'P0', 'PERSONA_PATHS', 'RULES', 'RULE_IDS',
           'SYSTEM_EVENTS', 'TAXONOMY_VERSION', 'builtin_doc', 'template_doc', 'templates']
