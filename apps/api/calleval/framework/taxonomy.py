# Taxonomy v1.0: personas, scenarios, event tags and facets from the Call Evaluation Framework.
# A change to any definition creates a new taxonomy version; the API stores versions in the
# `taxonomy` table and seeds them from these defaults.

from __future__ import annotations

import math

TAXONOMY_VERSION = '1.0'
FRAMEWORK_VERSION = 'v1'

PERSONAS: list[dict] = [
    {
        'id': 'P1',
        'name': 'Family end-user',
        'path': 'Investor',
        'signals': 'Buying to live in; mentions children, schools, space, community, a second bedroom',
        'watch': 'Need fit on bedrooms and community',
        'checkLabel': 'Offers matching stated bedrooms and community',
    },
    {
        'id': 'P2',
        'name': 'First-time buyer',
        'path': 'Investor',
        'signals': 'Unfamiliar with off-plan or payment plans; process questions (“how does it work?”)',
        'watch': 'Patience; plain explanations; no jargon',
        'checkLabel': 'React → give → ask turns',
    },
    {
        'id': 'P3',
        'name': 'Yield investor',
        'path': 'Investor',
        'signals': 'Talks returns, rental yield, resale, handover dates, several units',
        'watch': 'The agent must decline yield predictions, so scope handling matters',
        'checkLabel': 'Yield questions deflected',
    },
    {
        'id': 'P4',
        'name': 'Overseas investor',
        'path': 'Investor',
        'signals': 'Calling from abroad; non-resident; time-zone or residency questions',
        'watch': 'Visa and legal questions to deflect; meeting time zones',
        'checkLabel': 'Meetings booked with the time zone stated',
    },
    {
        'id': 'P5',
        'name': 'Upgrader or relocator',
        'path': 'Investor',
        'signals': 'Already in the UAE; moving up or across; an existing home or lease to exit',
        'watch': 'Timeline fit; handover against their move date',
        'checkLabel': 'Handover checked against the move date',
    },
    {
        'id': 'P6',
        'name': 'Browser',
        'path': 'Investor',
        'signals': '“Just looking”; vague answers; no timeline or budget',
        'watch': 'Over-selling; graceful acceptance',
        'checkLabel': 'Calls still pushed after a no',
    },
    {
        'id': 'P7',
        'name': 'Overseas broker',
        'path': 'Broker',
        'signals': 'International or off-plan clients',
        'watch': 'Registration link; no buyer questions',
        'checkLabel': 'Buyer questions asked per call',
    },
    {
        'id': 'P8',
        'name': 'Local solo broker',
        'path': 'Broker',
        'signals': 'Independent or freelance agent in the UAE',
        'watch': 'Registration link; project brief',
        'checkLabel': 'Registration link sent once status is known',
    },
    {
        'id': 'P9',
        'name': 'Existing owner or resident',
        'path': 'Non-target',
        'signals': 'Handover, service charge, snagging, community issues',
        'watch': 'Routed to the right team, not pitched',
        'checkLabel': 'Calls that included a pitch',
    },
    {
        'id': 'P10',
        'name': 'Renter',
        'path': 'Non-target',
        'signals': 'Wants to rent, not buy',
        'watch': 'Clear redirect, no pitch',
        'checkLabel': 'Calls that included a pitch',
    },
    {
        'id': 'P11',
        'name': 'Other',
        'path': 'Non-target',
        'signals': 'Vendor, job seeker, wrong number, spam',
        'watch': 'Short, polite close',
        'checkLabel': 'Closed within 60 seconds',
    },
]

P0: dict = {
    'id': 'P0',
    'name': 'Unclassified',
    'path': '—',
    'signals': 'Not enough signal (dropped early, silence)',
    'watch': 'Counted, not scored for persona fit',
    'checkLabel': '',
}

SCENARIOS: list[dict] = [
    {
        'id': 'S1',
        'name': 'Discovery to meeting',
        'short': 'Discovery',
        'trigger': 'Open interest, needs not yet known',
        'path': 'Persona → discovery → two-option pitch → meeting fork → booking',
        'success': 'Meeting booked',
    },
    {
        'id': 'S2',
        'name': 'Project enquiry',
        'short': 'Enquiry',
        'trigger': 'Caller asks about a named project',
        'path': 'Answer from get_project_details → qualify around it → offer next step',
        'success': 'Question answered from tool data, plus a next step',
    },
    {
        'id': 'S3',
        'name': 'Document request',
        'short': 'Documents',
        'trigger': '“Send me the brochure”',
        'path': 'Confirm project and channel → send_documents → one follow-up question',
        'success': 'Document confirmed sent',
    },
    {
        'id': 'S4',
        'name': 'Callback request',
        'short': 'Callback',
        'trigger': 'Busy, driving, “call me later”',
        'path': 'Repeat time back → schedule_callback',
        'success': 'Callback booked at the caller’s time',
    },
    {
        'id': 'S5',
        'name': 'Live transfer',
        'short': 'Transfer',
        'trigger': 'Wants a person now',
        'path': 'Filler → request_live_transfer → hand-over or graceful fallback',
        'success': 'Connected, or a callback or note when nobody is free',
    },
    {
        'id': 'S6',
        'name': 'Meeting change',
        'short': 'Mtg change',
        'trigger': 'Reschedule or cancel',
        'path': 'Move with schedule_meeting, or a clear-cut cancel_meeting',
        'success': 'Change confirmed by the tool',
    },
    {
        'id': 'S7',
        'name': 'Broker onboarding',
        'short': 'Broker',
        'trigger': 'Caller is a broker',
        'path': 'Type → registration → project brief → BDM call',
        'success': 'Registration link sent or confirmed, plus BDM call booked',
    },
    {
        'id': 'S8',
        'name': 'Objection-led',
        'short': 'Objection',
        'trigger': 'Price, location, timing or a spouse decision dominates',
        'path': 'Acknowledge → alternative → soft end; stop after a second no',
        'success': 'Alternative accepted, or a brochure or callback kept the lead open',
    },
    {
        'id': 'S9',
        'name': 'Returning follow-up',
        'short': 'Returning',
        'trigger': 'objective set or prior history',
        'path': 'Acknowledge where things stand → the objective',
        'success': 'The objective completed',
    },
    {
        'id': 'S10',
        'name': 'Not interested',
        'short': 'Not interested',
        'trigger': 'Declines, or asks not to be contacted',
        'path': 'Accept the first time; honour do-not-contact',
        'success': 'Clean, courteous close, no further contact',
    },
    {
        'id': 'S11',
        'name': 'Out of scope',
        'short': 'Out of scope',
        'trigger': 'Legal, visa, mortgage, rental, service or complaint',
        'path': 'One-line deflection → advisor or redirect → back on track',
        'success': 'Deflected correctly, with no advice given',
    },
    {
        'id': 'S12',
        'name': 'Failed call',
        'short': 'Failed',
        'trigger': 'Voicemail, silence, dropped line, wrong number, language mismatch',
        'path': 'End or leave a message quickly',
        'success': 'Short, with nothing wrong claimed',
    },
]

EVENT_TYPES: list[dict] = [
    {'id': 'objection_budget', 'label': 'Objection · budget', 'group': 'Objections'},
    {'id': 'objection_location', 'label': 'Objection · location', 'group': 'Objections'},
    {'id': 'objection_timing', 'label': 'Objection · timing', 'group': 'Objections'},
    {'id': 'objection_family', 'label': 'Objection · need to consult family', 'group': 'Objections'},
    {'id': 'objection_just_looking', 'label': 'Objection · just looking', 'group': 'Objections'},
    {'id': 'competitor_mentioned', 'label': 'Competitor mentioned', 'group': 'Objections'},
    {'id': 'asked_if_ai', 'label': 'Asked if it is an AI', 'group': 'Caller behaviour'},
    {'id': 'off_topic_request', 'label': 'Off-topic request', 'group': 'Caller behaviour'},
    {'id': 'frustration', 'label': 'Frustration', 'group': 'Caller behaviour'},
    {'id': 'interruption_burst', 'label': 'Interruption burst', 'group': 'Caller behaviour'},
    {'id': 'language_switch', 'label': 'Language switch', 'group': 'Caller behaviour'},
    {'id': 'dnc_request', 'label': 'Do-not-contact request', 'group': 'Caller behaviour'},
    {'id': 'tool_failure', 'label': 'Tool failure', 'group': 'Agent or system'},
    {'id': 'transfer_unavailable', 'label': 'Transfer unavailable', 'group': 'Agent or system'},
    {'id': 'whatsapp_fallback_email', 'label': 'WhatsApp fallback to email', 'group': 'Agent or system'},
    {'id': 'time_limit_reached', 'label': 'Time limit reached', 'group': 'Agent or system'},
    {'id': 'gate_failure', 'label': 'Gate failure', 'group': 'Agent or system'},
    {'id': 'intent_rose', 'label': 'Intent rose', 'group': 'Outcome moments'},
    {'id': 'intent_fell', 'label': 'Intent fell', 'group': 'Outcome moments'},
    {'id': 'project_chosen', 'label': 'Specific project chosen', 'group': 'Outcome moments'},
    {'id': 'visit_requested', 'label': 'Visit requested', 'group': 'Outcome moments'},
]

OBJECTION_EVENTS = [e['id'] for e in EVENT_TYPES if e['group'] == 'Objections']
LOST_REASON_LABELS: dict[str, str] = {
    'objection_budget': 'Budget',
    'objection_location': 'Location',
    'objection_timing': 'Timing',
    'objection_family': 'Need to consult family',
    'objection_just_looking': 'Just looking',
    'competitor_mentioned': 'Competitor mentioned',
}

FACETS: list[dict] = [
    {'id': 'direction', 'name': 'Direction', 'values': 'Inbound · Outbound', 'source': 'First agent line'},
    {'id': 'history', 'name': 'History', 'values': 'New · Returning', 'source': 'known_facts'},
    {'id': 'intent', 'name': 'Intent at start / at end', 'values': 'Hot · Warm · Cold', 'source': 'Classifier, from stated timeline and engagement'},
    {'id': 'budget_band', 'name': 'Budget band', 'values': 'Bands to agree with sales (default A–D in AED)', 'source': 'Captured budget field'},
    {
        'id': 'timeline_band',
        'name': 'Timeline band',
        'values': 'Under 3 months · 3–12 months · Over 12 months · None',
        'source': 'Captured timeline field',
    },
    {'id': 'language', 'name': 'Language', 'values': 'Language spoken on the call', 'source': 'Speech recognition'},
    {
        'id': 'broker_registration',
        'name': 'Broker registration',
        'values': 'Registered · Unregistered (brokers only)',
        'source': 'send_broker_registration_link arguments',
    },
    {'id': 'lead_source', 'name': 'Lead source', 'values': 'Campaign, portal, referral, walk-in', 'source': 'CRM'},
]

INTENT_RANK: dict[str, int] = {'cold': 0, 'warm': 1, 'hot': 2}


def persona_by_id(id: str | None) -> dict:
    return next((p for p in PERSONAS if p['id'] == id), P0)


def scenario_by_id(id: str | None) -> dict | None:
    return next((s for s in SCENARIOS if s['id'] == id), None)


def is_target_persona(id: str | None) -> bool:
    return persona_by_id(id)['path'] in ('Investor', 'Broker')


# Default budget bands in AED; the framework leaves these for sales to agree, so they are a setting.
DEFAULT_BUDGET_BANDS: list[dict] = [{'band': 'A', 'maxAed': 1000000}, {'band': 'B', 'maxAed': 2000000}, {'band': 'C', 'maxAed': 4000000}, {'band': 'D', 'maxAed': None}]


def budget_band(aed: float | None, bands: list[dict] = DEFAULT_BUDGET_BANDS) -> str | None:
    if aed is None or not isinstance(aed, (int, float)) or not math.isfinite(aed):
        return None
    for b in bands:
        if b.get('maxAed') is None or aed <= b['maxAed']:
            return b['band']
    return bands[-1]['band'] if bands else None


def timeline_band(months: float | None) -> str:
    if months is None or not isinstance(months, (int, float)) or not math.isfinite(months):
        return 'None'
    if months < 3:
        return 'Under 3 months'
    if months <= 12:
        return '3–12 months'
    return 'Over 12 months'
