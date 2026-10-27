# The plan catalogue (PlanDTO) and what each plan allows. Prices in US dollars; annual plans bill ten months
# for twelve. A trial is Growth for config.trial_days with smaller allowances.

from __future__ import annotations

from typing import Any

CALL_USD_PAYG = 0.20
DRAFT_USD = 1.0
CYCLE_USD = 25.0
TRIAL = {'calls': 250, 'drafts': 10, 'cycles': 1}
TOPUPS = (50, 200, 500)

BASE_FEATURES: list[str] = []
STARTER_FEATURES = ['copilot', 'alerts', 'api_tokens']
GROWTH_FEATURES = [*STARTER_FEATURES, 'crm', 'campaigns', 'lead_finder', 'improvement']
SCALE_FEATURES = [*GROWTH_FEATURES, 'audit_export', 'priority_support']

PLANS: list[dict[str, Any]] = [
    {'id': 'payg', 'name': 'Pay as you go', 'summary': 'No monthly fee: prepaid credit, $0.20 per scored call.',
     'monthlyUsd': 0, 'includedCalls': 0, 'extraCallUsd': CALL_USD_PAYG, 'seats': 2, 'copilotDrafts': None, 'copilotDraftUsd': DRAFT_USD,
     'improvementCycles': None, 'improvementCycleUsd': CYCLE_USD, 'features': BASE_FEATURES},
    {'id': 'starter', 'name': 'Starter', 'summary': 'Scoring for one team, with the co-pilot, alerts and API tokens.',
     'monthlyUsd': 149, 'includedCalls': 1000, 'extraCallUsd': 0.15, 'seats': 3, 'copilotDrafts': 20, 'copilotDraftUsd': None,
     'improvementCycles': None, 'improvementCycleUsd': CYCLE_USD, 'features': STARTER_FEATURES},
    {'id': 'growth', 'name': 'Growth', 'summary': 'Adds the CRM and funnels, lead finders, batch campaigns and self-improvement.',
     'monthlyUsd': 499, 'includedCalls': 3500, 'extraCallUsd': 0.13, 'seats': 10, 'copilotDrafts': 100, 'copilotDraftUsd': None,
     'improvementCycles': 4, 'improvementCycleUsd': None, 'features': GROWTH_FEATURES},
    {'id': 'scale', 'name': 'Scale', 'summary': 'For larger teams: audit-log export, choice of data region, priority support.',
     'monthlyUsd': 1499, 'includedCalls': 12000, 'extraCallUsd': 0.11, 'seats': 25, 'copilotDrafts': 300, 'copilotDraftUsd': None,
     'improvementCycles': 15, 'improvementCycleUsd': None, 'features': SCALE_FEATURES},
    {'id': 'enterprise', 'name': 'Enterprise', 'summary': 'Annual contract: dedicated installation, own data region, SLA, custom retention.',
     'monthlyUsd': None, 'includedCalls': 0, 'extraCallUsd': None, 'seats': None, 'copilotDrafts': None, 'copilotDraftUsd': None,
     'improvementCycles': None, 'improvementCycleUsd': None, 'features': SCALE_FEATURES},
]
PLAN_IDS = tuple(p['id'] for p in PLANS)
_BY_ID = {p['id']: p for p in PLANS}

FEATURE_LABELS = {
    'copilot': 'the co-pilot', 'alerts': 'alerts', 'api_tokens': 'API tokens', 'crm': 'the built-in CRM', 'campaigns': 'batch campaigns',
    'lead_finder': 'lead finders', 'improvement': 'self-improvement', 'audit_export': 'audit-log export', 'priority_support': 'priority support',
}


def plan(id: str | None) -> dict[str, Any]:
    return _BY_ID.get(id or '', _BY_ID['growth'])


def first_plan_with(feature: str) -> dict[str, Any] | None:
    return next((p for p in PLANS if feature in p['features']), None)


def limits(w: dict) -> dict[str, Any]:
    """What a workspace may use this period. None = unlimited. A trial is Growth with the trial allowances."""
    if w['plan'] == 'enterprise':
        return {'calls': None, 'callUsd': None, 'extraUsd': None, 'drafts': None, 'draftUsd': None, 'cycles': None, 'cycleUsd': None,
                'seats': None, 'features': SCALE_FEATURES, 'unlimited': True}
    p = plan(w['plan'])
    if w['status'] == 'trial':
        g = plan('growth')
        return {'calls': TRIAL['calls'], 'callUsd': None, 'extraUsd': None, 'drafts': TRIAL['drafts'], 'draftUsd': None, 'cycles': TRIAL['cycles'],
                'cycleUsd': None, 'seats': g['seats'], 'features': g['features'], 'unlimited': False}
    payg = p['id'] == 'payg'
    return {
        'calls': 0 if payg else p['includedCalls'], 'callUsd': CALL_USD_PAYG if payg else None, 'extraUsd': None if payg else p['extraCallUsd'],
        # Beyond the included drafts and cycles, any plan may pay for more from credit.
        'drafts': 0 if payg else p['copilotDrafts'], 'draftUsd': DRAFT_USD, 'cycles': p['improvementCycles'] or 0, 'cycleUsd': CYCLE_USD,
        'seats': p['seats'], 'features': p['features'], 'unlimited': False,
    }


def has_feature(w: dict, feature: str) -> bool:
    if feature == 'copilot' and w['plan'] == 'payg':
        return True  # paid per draft from credit
    return feature in limits(w)['features']


def monthly_cost(p: dict, calls: int) -> float | None:
    """What `calls` scored calls a month would cost on plan `p` (None: by contract)."""
    if p['monthlyUsd'] is None:
        return None
    if p['id'] == 'payg':
        return round(calls * CALL_USD_PAYG, 2)
    return round(p['monthlyUsd'] + max(0, calls - p['includedCalls']) * p['extraCallUsd'], 2)
