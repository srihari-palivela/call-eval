# Plans, pay-as-you-go credit and usage limits (BILLING=on). Off, every function here allows everything, as a
# self-hosted installation for one company has no plan. The rest of the app calls only these functions.
#
# Usage is counted in usage_event (one row per scored call, co-pilot draft or improvement cycle, unique by its
# reference, so a retry never counts twice) and money in credit_ledger (top-ups and charges). A workspace's
# plan, status, credit and Stripe ids live on its workspace row. Stripe takes the payments: Checkout for plans
# and top-ups, the customer portal, and webhooks that move the plan and the credit.

from __future__ import annotations

import calendar
from datetime import UTC, datetime, timedelta
from typing import Any

from .. import tenancy
from ..config import config
from ..js import iso, js_json
from ..lib.errors import HttpStatusError, http_error
from ..lib.ids import new_id
from ..lib.log import err_msg, log
from . import stripe
from .plans import FEATURE_LABELS, PLAN_IDS, PLANS, TOPUPS, first_plan_with, has_feature, limits, monthly_cost, plan

RECHARGE_EVERY = timedelta(hours=1)


def enabled() -> bool:
    return config.billing


def _now() -> datetime:
    return datetime.now(UTC)


async def workspace(db) -> dict:
    w = await db.one('select * from workspace where id = $1', [tenancy.workspace_id()])
    if not w:
        raise http_error(404, 'Workspace not found')
    return w


def _month_after(t: datetime) -> datetime:
    y, m = (t.year + 1, 1) if t.month == 12 else (t.year, t.month + 1)
    return t.replace(year=y, month=m, day=min(t.day, calendar.monthrange(y, m)[1]))


async def period(db, w: dict) -> tuple[datetime, datetime]:
    """This month's usage window, from period_start (moved forward a month at a time as months pass)."""
    start = w['period_start']
    end = _month_after(start)
    now = _now()
    if now >= end:
        while now >= end:
            start, end = end, _month_after(end)
        await db.query('update workspace set period_start = $2, updated_at = now() where id = $1', [w['id'], start])
    return start, end


async def _counts(db, start: datetime, end: datetime) -> dict[str, dict]:
    rows = await db.query(
        'select kind, count(*)::int as n, coalesce(sum(amount_usd), 0) as usd from usage_event where at >= $1 and at < $2 group by kind', [start, end])
    return {r['kind']: {'n': r['n'], 'usd': float(r['usd'])} for r in rows}


async def _used(db, kind: str, start: datetime, end: datetime) -> int:
    r = await db.one('select count(*)::int as n from usage_event where kind = $1 and at >= $2 and at < $3', [kind, start, end])
    return r['n']


async def editor_seats(db, ws: str) -> int:
    r = await db.one(
        """select (select count(*) from app_user where workspace_id = $1 and status = 'active' and role <> 'viewer')
                + (select count(*) from user_invite where workspace_id = $1 and kind = 'invite' and used_at is null and revoked_at is null
                     and expires_at > now() and role <> 'viewer') as n""", [ws])
    return int(r['n'])


def _blocked_status(w: dict) -> str | None:
    if w['status'] == 'cancelled':
        return 'The subscription is cancelled: choose a plan to keep scoring.'
    if w['status'] == 'trial' and w['trial_ends_at'] and w['trial_ends_at'] <= _now():
        return 'The trial has ended: choose a plan to keep scoring.'
    return None


# ---------- Limits the rest of the app checks ----------

async def require_feature(db, feature: str) -> None:
    """402 when the workspace's plan doesn't include the feature (crm, campaigns, lead_finder, improvement, copilot,
    api_tokens, alerts, audit_export)."""
    if not enabled():
        return
    w = await workspace(db)
    if has_feature(w, feature):
        return
    up = first_plan_with(feature)
    raise http_error(402, f"Your plan ({plan(w['plan'])['name']}) doesn't include {FEATURE_LABELS.get(feature, feature)}"
                          + (f'; it comes with {up["name"]}.' if up else '.'))


async def check_seat(db, role: str) -> None:
    """402 when adding someone with this role would pass the plan's editor seats (viewers are free)."""
    if not enabled() or role == 'viewer':
        return
    w = await workspace(db)
    seats = limits(w)['seats']
    if seats is not None and await editor_seats(db, w['id']) + 1 > seats:
        raise http_error(402, f"Your plan ({plan(w['plan'])['name']}) includes {seats} editor seats, all in use. "
                              'Viewers are free; for more editors, upgrade or remove someone.')


async def can_score(db) -> tuple[bool, str | None]:
    """Whether a new call may be scored now (included calls, credit, spend cap); when not, the reason."""
    if not enabled():
        return True, None
    w = await workspace(db)
    why = _blocked_status(w)
    if why:
        return False, why
    lim = limits(w)
    if lim['unlimited']:
        return True, None
    start, end = await period(db, w)
    used = await _used(db, 'scored_call', start, end)
    if w['status'] == 'trial':
        return (True, None) if used < lim['calls'] else (False, f"The trial's {lim['calls']} scored calls are used: choose a plan to keep scoring.")
    if lim['callUsd'] is not None:  # pay as you go
        return (True, None) if float(w['credit_usd']) >= lim['callUsd'] else (False, 'Out of credit: top up to keep scoring.')
    if used >= lim['calls'] and w['spend_cap_usd'] is not None and (used - lim['calls'] + 1) * lim['extraUsd'] > float(w['spend_cap_usd']):
        return False, f"This period's spend cap for extra calls (${float(w['spend_cap_usd']):g}) is reached."
    return True, None


async def _charge(t, ws: str, amount: float, note: str, ref: str) -> None:
    await t.query('update workspace set credit_usd = credit_usd - $2, updated_at = now() where id = $1', [ws, amount])
    await t.query("insert into credit_ledger (kind, amount_usd, note, ref) values ('charge', $1, $2, $3) on conflict do nothing", [-amount, note, ref])


async def record_scored_call(db, call_id: str) -> None:
    """Count a scored call once (re-scoring the same call is not counted again)."""
    if not enabled():
        return
    w = await workspace(db)
    lim = limits(w)
    price = lim['callUsd'] if w['status'] != 'trial' and lim['callUsd'] else 0.0

    async def body(t) -> None:
        r = await t.one("insert into usage_event (kind, ref, amount_usd) values ('scored_call', $1, $2) on conflict (workspace_id, kind, ref) do nothing returning id",
                        [call_id, price])
        if r and price:
            await _charge(t, w['id'], price, 'Scored call', f'call:{call_id}')

    await db.tx(body)
    if price:
        await maybe_recharge(db)


async def _use(db, kind: str, ref: str, included_key: str, price_key: str, what: str) -> None:
    w = await workspace(db)
    why = _blocked_status(w)
    if why:
        raise http_error(402, why.replace('to keep scoring', f'to use {what}'))
    lim = limits(w)
    if lim['unlimited']:
        await db.query('insert into usage_event (kind, ref) values ($1, $2) on conflict (workspace_id, kind, ref) do nothing', [kind, ref])
        return
    start, end = await period(db, w)
    included = lim[included_key]
    if included is None or await _used(db, kind, start, end) < included:
        await db.query('insert into usage_event (kind, ref) values ($1, $2) on conflict (workspace_id, kind, ref) do nothing', [kind, ref])
        return
    price = lim[price_key]
    if not price or w['status'] == 'trial':
        raise http_error(402, f"This {'trial' if w['status'] == 'trial' else 'period'}'s {what} {'are' if included != 1 else 'is'} used up: choose a plan for more.")
    if float(w['credit_usd']) < price:
        raise http_error(402, f'The included {what} are used: top up credit to keep going (${price:g} each).')

    async def body(t) -> None:
        r = await t.one('insert into usage_event (kind, ref, amount_usd) values ($1, $2, $3) on conflict (workspace_id, kind, ref) do nothing returning id',
                        [kind, ref, price])
        if r:
            await _charge(t, w['id'], price, {'copilot_draft': 'Co-pilot draft', 'improvement_cycle': 'Improvement cycle'}.get(kind, kind), f'{kind}:{ref}')

    await db.tx(body)
    await maybe_recharge(db)


async def use_copilot(db, kind: str) -> None:
    """Before a co-pilot draft: 402 when not allowed; counts it (or charges credit on pay-as-you-go)."""
    if not enabled():
        return
    await require_feature(db, 'copilot')
    await _use(db, 'copilot_draft', new_id(f'cp_{kind}'), 'drafts', 'draftUsd', 'co-pilot drafts')


async def use_improvement_cycle(db, ref: str) -> None:
    """Before an improvement cycle: 402 when not allowed; counts it (or charges credit)."""
    if not enabled():
        return
    await require_feature(db, 'improvement')
    await _use(db, 'improvement_cycle', ref, 'cycles', 'cycleUsd', 'improvement cycles')


async def release_waiting(db) -> int:
    """Queue the calls that waited for credit, once scoring is allowed again; returns how many."""
    from ..jobs.queue import enqueue_or_existing
    if not (await can_score(db))[0]:
        return 0
    rows = await db.query("select call_id from calls where status = 'waiting' order by started_at")
    for r in rows:
        await enqueue_or_existing(db, 'evaluate_call', {'callId': r['call_id'], 'reason': 'credit'}, dedupe_key=f"eval:{r['call_id']}", priority=3)
    return len(rows)


async def start_trial(db, workspace_id: str, plan: str | None) -> None:
    """A new self-serve workspace: its trial (Growth; a paid plan chosen at sign-up applies after checkout)."""
    chosen = plan if plan in PLAN_IDS and plan != 'enterprise' else None
    await db.query(
        """update workspace set plan = 'growth', status = 'trial', trial_ends_at = now() + ($2::int * interval '1 day'), period_start = now(),
             setup = setup || $3::jsonb, updated_at = now() where id = $1""",
        [workspace_id, config.trial_days, js_json({'chosenPlan': chosen} if chosen else {})])


# ---------- Auto-recharge ----------

async def maybe_recharge(db) -> None:
    """When credit falls below the threshold, charge the saved card once (at most once an hour). Failures are logged."""
    if not enabled() or not stripe.configured():
        return
    w = await workspace(db)
    ar = w['auto_recharge'] or {}
    if not ar.get('enabled') or not w['stripe_customer_id'] or float(w['credit_usd']) >= float(ar.get('thresholdUsd') or 0):
        return
    last = ar.get('lastAttemptAt')
    if last and _now() - datetime.fromisoformat(last.replace('Z', '+00:00')) < RECHARGE_EVERY:
        return
    await db.query("update workspace set auto_recharge = auto_recharge || $2::jsonb where id = $1", [w['id'], js_json({'lastAttemptAt': iso(_now())})])
    amount = int(ar.get('amountUsd') or 50)
    try:
        pms = await stripe.call('GET', '/payment_methods', {'customer': w['stripe_customer_id'], 'type': 'card', 'limit': 1})
        pm = next(iter(pms.get('data') or []), None)
        if not pm:
            log.warn('auto-recharge: no saved card', {'workspace': w['id']})
            return
        await stripe.call('POST', '/payment_intents', {
            'amount': amount * 100, 'currency': 'usd', 'customer': w['stripe_customer_id'], 'payment_method': pm['id'], 'off_session': True, 'confirm': True,
            'description': f'Credit top-up (automatic) ${amount}',
            'metadata': {'workspace': w['id'], 'kind': 'auto_topup', 'amountUsd': amount},
        }, idempotency_key=f"recharge-{w['id']}-{_now():%Y%m%d%H}")
    except Exception as e:  # noqa: BLE001 - a failed recharge leaves scoring to wait for a manual top-up
        log.warn('auto-recharge failed', {'workspace': w['id'], 'error': err_msg(e)})


# ---------- What the Billing page shows ----------

def plans_dto() -> list[dict]:
    """The catalogue; empty when billing is off, so nothing is gated by a plan (the console reads it that way)."""
    return [dict(p) for p in PLANS] if enabled() else []


async def recommendation(db, w: dict) -> dict | None:
    calls = (await db.one("select count(*)::int as n from calls where status = 'scored' and scored_at > now() - interval '30 days'"))['n']
    editors = await editor_seats(db, w['id'])
    s = (await db.one("select value from app_setting where key = 'framework'") or {}).get('value') or {}
    feats = s.get('features') or {}
    needs = {'crm'} if feats.get('crm') else set()
    if feats.get('campaigns'):
        needs.add('campaigns')
    best = None
    for p in PLANS:
        cost = monthly_cost(p, calls)
        if cost is None or (p['seats'] is not None and p['seats'] < editors) or not needs <= set(p['features']):
            continue
        if best is None or cost < best[1]:
            best = (p, cost)
    if not best:
        return {'plan': 'enterprise', 'why': f'{editors} editors and the features in use need more than Scale; talk to us.'}
    p, cost = best
    return {'plan': p['id'], 'why': f"{calls:,} scored calls in the last 30 days and {editors} editor{'s' if editors != 1 else ''}: "
                                    f"about ${cost:,.0f} a month on {p['name']}, the lowest of the plans that fit."}


async def billing_dto(db) -> dict:
    w = await workspace(db)
    lim = limits(w)
    start, end = await period(db, w)
    c = await _counts(db, start, end)
    scored = c.get('scored_call', {}).get('n', 0)
    included = lim['calls'] or 0
    extra = 0 if lim['unlimited'] or lim['callUsd'] is not None or w['status'] == 'trial' else max(0, scored - included)
    spent = await db.one("select coalesce(-sum(amount_usd), 0) as usd from credit_ledger where kind = 'charge' and at >= $1 and at < $2", [start, end])
    allowed, why = await can_score(db) if enabled() else (True, None)
    waiting = (await db.one("select count(*)::int as n from calls where status = 'waiting'"))['n']
    ledger = await db.query('select at, kind, amount_usd, note from credit_ledger order by at desc, id desc limit 20')
    ar = w['auto_recharge'] or {}
    return {
        'enabled': enabled(),
        'plan': w['plan'], 'status': w['status'], 'trialEndsAt': iso(w['trial_ends_at']), 'annual': bool(w['annual']),
        'period': {'start': iso(start), 'end': iso(end)},
        'usage': {
            'scoredCalls': scored, 'includedCalls': included, 'extraCalls': extra,
            'copilotDrafts': c.get('copilot_draft', {}).get('n', 0), 'copilotIncluded': lim['drafts'],
            'improvementCycles': c.get('improvement_cycle', {}).get('n', 0), 'cyclesIncluded': lim['cycles'],
            'editorSeats': await editor_seats(db, w['id']), 'seatsIncluded': lim['seats'],
        },
        'estimate': {'extraUsd': round(extra * (lim['extraUsd'] or 0), 2), 'creditSpentUsd': round(float(spent['usd']), 2)},
        'credit': {'balanceUsd': round(float(w['credit_usd']), 2),
                   'autoRecharge': {'enabled': bool(ar.get('enabled')), 'thresholdUsd': float(ar.get('thresholdUsd') or 10), 'amountUsd': float(ar.get('amountUsd') or 50)}},
        'spendCapUsd': None if w['spend_cap_usd'] is None else float(w['spend_cap_usd']),
        'scoring': {'allowed': allowed, 'reason': why, 'waiting': waiting},
        'plans': [dict(p) for p in PLANS],
        'recommendation': await recommendation(db, w),
        'stripe': {'checkout': stripe.configured(), 'portal': stripe.configured() and bool(w['stripe_customer_id'])},
        'ledger': [{'at': iso(r['at']), 'kind': r['kind'], 'amountUsd': round(float(r['amount_usd']), 2), 'note': r['note']} for r in ledger],
    }


async def update_settings(db, b: dict) -> dict:
    w = await workspace(db)
    if 'spendCapUsd' in b:
        cap = b['spendCapUsd']
        if cap is not None and (isinstance(cap, bool) or not isinstance(cap, (int, float)) or not 0 <= cap <= 1_000_000):
            raise http_error(400, 'spendCapUsd is a number of dollars from 0, or null for no cap')
        await db.query('update workspace set spend_cap_usd = $2, updated_at = now() where id = $1', [w['id'], cap])
    if 'autoRecharge' in b:
        a = b['autoRecharge'] or {}
        if not isinstance(a, dict):
            raise http_error(400, 'autoRecharge is { enabled, thresholdUsd, amountUsd }')
        th, amt = a.get('thresholdUsd', 10), a.get('amountUsd', 50)
        if isinstance(th, bool) or not isinstance(th, (int, float)) or not 0 <= th <= 10_000:
            raise http_error(400, 'thresholdUsd is from 0 to 10,000')
        if amt not in TOPUPS:
            raise http_error(400, f"amountUsd is one of {', '.join(map(str, TOPUPS))}")
        await db.query('update workspace set auto_recharge = auto_recharge || $2::jsonb, updated_at = now() where id = $1',
                       [w['id'], js_json({'enabled': bool(a.get('enabled')), 'thresholdUsd': th, 'amountUsd': amt})])
    return await billing_dto(db)


# ---------- Stripe: checkout, top-ups, portal ----------

def _base() -> str:
    return (config.public_url or f'http://localhost:{config.port}').rstrip('/')


def _return_urls() -> dict:
    return {'success_url': f'{_base()}/app/#billing?checkout=success', 'cancel_url': f'{_base()}/app/#billing?checkout=cancelled'}


async def _customer(db, w: dict) -> str:
    if w['stripe_customer_id']:
        return w['stripe_customer_id']
    owner = await db.one("select email from app_user where workspace_id = $1 and role = 'owner' and status = 'active' order by created_at limit 1", [w['id']])
    c = await stripe.call('POST', '/customers', {'name': w['name'], 'email': (owner or {}).get('email'), 'metadata': {'workspace': w['id']}},
                          idempotency_key=f"customer-{w['id']}")
    await db.query('update workspace set stripe_customer_id = $2, updated_at = now() where id = $1', [w['id'], c['id']])
    return c['id']


async def checkout(db, plan_id: Any, annual: bool = False) -> dict:
    if plan_id not in PLAN_IDS:
        raise http_error(400, f"plan is one of {', '.join(PLAN_IDS)}")
    if plan_id == 'enterprise':
        raise http_error(400, 'Enterprise is by contract: talk to us')
    w = await workspace(db)
    if plan_id == 'payg':
        # No subscription: credit pays per use. A running subscription ends at its period end.
        if w['stripe_subscription_id'] and stripe.configured():
            await stripe.call('POST', f"/subscriptions/{w['stripe_subscription_id']}", {'cancel_at_period_end': True},
                              idempotency_key=f"payg-{w['id']}-{w['stripe_subscription_id']}")
        await db.query("update workspace set plan = 'payg', status = 'active', trial_ends_at = null, updated_at = now() where id = $1", [w['id']])
        await release_waiting(db)
        return {'url': _return_urls()['success_url']}
    if not stripe.configured():
        raise http_error(400, 'Stripe is not configured')
    p = plan(plan_id)
    customer = await _customer(db, w)
    cents = p['monthlyUsd'] * 100 * (10 if annual else 1)
    meta = {'workspace': w['id'], 'kind': 'subscription', 'plan': plan_id, 'annual': bool(annual)}
    s = await stripe.call('POST', '/checkout/sessions', {
        'mode': 'subscription', 'customer': customer, 'client_reference_id': w['id'], **_return_urls(),
        'line_items': [{'quantity': 1, 'price_data': {'currency': 'usd', 'unit_amount': cents, 'recurring': {'interval': 'year' if annual else 'month'},
                                                      'product_data': {'name': f"{p['name']} plan"}}}],
        'subscription_data': {'metadata': meta}, 'metadata': meta,
    }, idempotency_key=f"checkout-{w['id']}-{plan_id}-{'y' if annual else 'm'}-{_now():%Y%m%d%H%M}")
    return {'url': s['url']}


async def topup(db, amount: Any) -> dict:
    if amount not in TOPUPS:
        raise http_error(400, f"amountUsd is one of {', '.join(map(str, TOPUPS))}")
    if not stripe.configured():
        raise http_error(400, 'Stripe is not configured')
    w = await workspace(db)
    customer = await _customer(db, w)
    meta = {'workspace': w['id'], 'kind': 'topup', 'amountUsd': amount}
    s = await stripe.call('POST', '/checkout/sessions', {
        'mode': 'payment', 'customer': customer, 'client_reference_id': w['id'], **_return_urls(),
        'line_items': [{'quantity': 1, 'price_data': {'currency': 'usd', 'unit_amount': amount * 100, 'product_data': {'name': f'Credit top-up ${amount}'}}}],
        # Saves the card so auto-recharge can charge it later.
        'payment_intent_data': {'setup_future_usage': 'off_session', 'metadata': meta}, 'metadata': meta,
    }, idempotency_key=f"topup-{w['id']}-{amount}-{_now():%Y%m%d%H%M}")
    return {'url': s['url']}


async def portal(db) -> dict:
    w = await workspace(db)
    if not stripe.configured():
        raise http_error(400, 'Stripe is not configured')
    if not w['stripe_customer_id']:
        raise http_error(400, 'No billing account yet: choose a plan or top up first')
    s = await stripe.call('POST', '/billing_portal/sessions', {'customer': w['stripe_customer_id'], 'return_url': f'{_base()}/app/#billing'})
    return {'url': s['url']}


# ---------- Stripe webhooks ----------

STATUS = {'active': 'active', 'trialing': 'active', 'past_due': 'past_due', 'unpaid': 'past_due', 'canceled': 'cancelled',
          'incomplete_expired': 'cancelled'}


async def _workspace_for(system, obj: dict) -> str | None:
    meta = obj.get('metadata') or {}
    for ws in (obj.get('client_reference_id'), meta.get('workspace')):
        if ws and await system.one('select 1 from workspace where id = $1', [ws]):
            return ws
    cust = obj.get('customer')
    if isinstance(cust, dict):
        cust = cust.get('id')
    if cust:
        r = await system.one('select id from workspace where stripe_customer_id = $1', [cust])
        return r['id'] if r else None
    return None


async def _add_credit(db, ws: str, amount: float, kind: str, note: str, ref: str) -> bool:
    async def body(t) -> bool:
        r = await t.one('insert into credit_ledger (kind, amount_usd, note, ref) values ($1, $2, $3, $4) on conflict do nothing returning id',
                        [kind, amount, note, ref])
        if r:
            await t.query('update workspace set credit_usd = credit_usd + $2, updated_at = now() where id = $1', [ws, amount])
        return bool(r)
    return await db.tx(body)


def _ts(v: Any) -> datetime | None:
    return datetime.fromtimestamp(int(v), UTC) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


async def handle_webhook(db, payload: bytes, signature: str | None) -> dict:
    import json
    if not config.stripe_webhook_secret:
        raise http_error(400, 'Stripe webhooks are not configured (STRIPE_WEBHOOK_SECRET)')
    if not stripe.verify(payload, signature, config.stripe_webhook_secret):
        raise http_error(400, 'Invalid Stripe signature')
    try:
        event = json.loads(payload)
    except ValueError as e:
        raise http_error(400, 'Invalid JSON') from e
    system = db.as_system()
    first = await system.one('insert into stripe_event (id, type) values ($1, $2) on conflict do nothing returning id', [event.get('id'), event.get('type')])
    if not first:
        return {'ok': True, 'duplicate': True}
    obj = (event.get('data') or {}).get('object') or {}
    ws = await _workspace_for(system, obj)
    if not ws:
        log.warn('stripe event for no known workspace', {'type': event.get('type'), 'id': event.get('id')})
        return {'ok': True, 'ignored': 'no workspace'}
    with tenancy.in_workspace(ws):
        try:
            done = await _apply(db, ws, event.get('type') or '', obj)
        except HttpStatusError:
            raise
        except Exception:
            # Let Stripe retry: forget the event id so the retry is processed.
            await system.query('delete from stripe_event where id = $1', [event.get('id')])
            raise
    return {'ok': True, **done}


async def _apply(db, ws: str, type: str, obj: dict) -> dict:
    meta = obj.get('metadata') or {}
    if type == 'checkout.session.completed':
        if obj.get('customer'):
            await db.query('update workspace set stripe_customer_id = coalesce(stripe_customer_id, $2) where id = $1', [ws, obj['customer']])
        if obj.get('mode') == 'payment' and meta.get('kind') == 'topup':
            if obj.get('payment_status') not in (None, 'paid'):
                return {'pending': 'payment not settled'}
            amount = (obj.get('amount_total') or 0) / 100
            await _add_credit(db, ws, amount, 'topup', f'Top-up ${amount:g}', f"stripe:{obj.get('id')}")
            return {'credit': amount, 'released': await release_waiting(db)}
        if obj.get('mode') == 'subscription':
            p = meta.get('plan') if meta.get('plan') in PLAN_IDS else 'growth'
            old = await db.one('select stripe_subscription_id from workspace where id = $1', [ws])
            new_sub = obj.get('subscription')
            if old and old['stripe_subscription_id'] and old['stripe_subscription_id'] != new_sub:
                # A plan change: the old subscription ends now, with its unused time credited by Stripe.
                try:
                    await stripe.call('DELETE', f"/subscriptions/{old['stripe_subscription_id']}?prorate=true")
                except Exception as e:  # noqa: BLE001 - logged; a person can cancel it in the portal
                    log.warn('could not end the previous subscription', {'workspace': ws, 'error': err_msg(e)})
            await db.query(
                """update workspace set plan = $2, status = 'active', annual = $3, stripe_subscription_id = $4, trial_ends_at = null,
                     period_start = now(), updated_at = now() where id = $1""", [ws, p, str(meta.get('annual')).lower() == 'true', new_sub])
            return {'plan': p, 'released': await release_waiting(db)}
        return {}
    if type in ('customer.subscription.updated', 'customer.subscription.deleted'):
        cur = await db.one('select stripe_subscription_id from workspace where id = $1', [ws])
        if cur and cur['stripe_subscription_id'] and obj.get('id') != cur['stripe_subscription_id']:
            return {'ignored': 'an older subscription'}
        status = 'cancelled' if type.endswith('deleted') else STATUS.get(obj.get('status') or '', 'active')
        item = next(iter((obj.get('items') or {}).get('data') or []), {})
        start = _ts(obj.get('current_period_start')) or _ts(item.get('current_period_start'))
        interval = ((item.get('price') or {}).get('recurring') or {}).get('interval')
        p = meta.get('plan') if meta.get('plan') in PLAN_IDS else None
        await db.query(
            """update workspace set status = $2, plan = coalesce($3, plan), period_start = coalesce($4, period_start),
                 annual = coalesce($5, annual), updated_at = now() where id = $1""",
            [ws, status, p, start, None if interval is None else interval == 'year'])
        return {'status': status}
    if type == 'invoice.created' and obj.get('billing_reason') == 'subscription_cycle' and obj.get('status') == 'draft':
        return await _bill_extra_calls(db, ws, obj)
    if type == 'invoice.payment_failed':
        await db.query("update workspace set status = 'past_due', updated_at = now() where id = $1", [ws])
        return {'status': 'past_due'}
    if type in ('invoice.paid', 'invoice.payment_succeeded'):
        await db.query("update workspace set status = 'active', updated_at = now() where id = $1 and status = 'past_due'", [ws])
        return {}
    if type == 'payment_intent.succeeded' and meta.get('kind') == 'auto_topup':
        amount = (obj.get('amount_received') or obj.get('amount') or 0) / 100
        await _add_credit(db, ws, amount, 'topup', f'Automatic top-up ${amount:g}', f"stripe:{obj.get('id')}")
        return {'credit': amount, 'released': await release_waiting(db)}
    return {'ignored': type}


async def _bill_extra_calls(db, ws: str, inv: dict) -> dict:
    """A renewal invoice: add the previous period's extra calls as one invoice item, once."""
    w = await db.one('select * from workspace where id = $1', [ws])
    lim = limits(w)
    start, end = _ts(inv.get('period_start')), _ts(inv.get('period_end'))
    if lim['unlimited'] or lim['extraUsd'] is None or not start or not end:
        return {'extra': 0}
    rows = await db.query("select id, reported_at from usage_event where kind = 'scored_call' and at >= $1 and at < $2", [start, end])
    if any(r['reported_at'] for r in rows):
        return {'extra': 0, 'already': True}
    extra = max(0, len(rows) - lim['calls'])
    if extra:
        await stripe.call('POST', '/invoiceitems', {
            'customer': inv.get('customer'), 'invoice': inv.get('id'), 'currency': 'usd',
            'amount': round(extra * lim['extraUsd'] * 100),
            'description': f"{extra:,} extra scored calls at ${lim['extraUsd']:g}",
        }, idempotency_key=f"extra-{inv.get('id')}")
    if rows:
        await db.query('update usage_event set reported_at = now() where id = any($1::bigint[])', [[r['id'] for r in rows]])
    return {'extra': extra}
