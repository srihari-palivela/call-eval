# Billing with BILLING on and Stripe stubbed: plans, trial limits, pay-as-you-go credit (charged once per call,
# blocked when empty, released after a top-up webhook), spend cap, seats, feature gates, checkout and portal,
# webhook signatures and idempotency, and extra calls billed once on a renewal invoice.

import json
from urllib.parse import parse_qs

import httpx
import pytest

from calleval import billing
from calleval.auth.store import forget_users_cache
from calleval.billing import stripe
from calleval.config import config
from calleval.lib.errors import HttpStatusError
from calleval.lib.settings import update_settings
from calleval.server import build_app

from .fixtures import stub_http

pytestmark = pytest.mark.asyncio(loop_scope='session')
SECRET = 'whsec_test'


@pytest.fixture(autouse=True)
def billing_on(monkeypatch):
    monkeypatch.setattr(config, 'billing', True)
    monkeypatch.setattr(config, 'stripe_secret_key', 'sk_test_x')
    monkeypatch.setattr(config, 'stripe_webhook_secret', SECRET)
    monkeypatch.setattr(config, 'public_url', 'https://evals.example.com')


@pytest.fixture(scope='module')
async def client(db):
    app = build_app(db)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as c:
        yield c


async def _set(db, **kw):
    sets = ', '.join(f'{k} = ${i + 1}' for i, k in enumerate(kw))
    await db.query(f"update workspace set {sets}, period_start = now() - interval '1 day' where id = 'ws_default'", list(kw.values()))


async def _usage(db, kind: str, n: int, prefix: str):
    await db.query("insert into usage_event (kind, ref) select $1::text, $2::text || g from generate_series(1, $3::int) g", [kind, prefix, n])


async def _reset(db):
    await db.query('delete from usage_event')
    await db.query('delete from credit_ledger')
    await db.query("update workspace set stripe_customer_id = null, stripe_subscription_id = null, spend_cap_usd = null, auto_recharge = '{}', credit_usd = 0 where id = 'ws_default'")


def _event(id: str, type: str, obj: dict) -> tuple[bytes, dict]:
    body = json.dumps({'id': id, 'type': type, 'data': {'object': obj}}).encode()
    return body, {'stripe-signature': stripe.sign(body, SECRET), 'content-type': 'application/json'}


async def test_plans_are_listed_only_when_billing_is_on(client, monkeypatch):
    plans = (await client.get('/api/billing/plans')).json()
    assert [p['id'] for p in plans] == ['payg', 'starter', 'growth', 'scale', 'enterprise']
    growth = plans[2]
    assert (growth['monthlyUsd'], growth['includedCalls'], growth['extraCallUsd'], growth['seats']) == (499, 3500, 0.13, 10)
    assert 'campaigns' in growth['features'] and 'campaigns' not in plans[1]['features']
    monkeypatch.setattr(config, 'billing', False)
    assert (await client.get('/api/billing/plans')).json() == []
    assert await billing.can_score(None) == (True, None)


async def test_a_trial_stops_scoring_at_its_allowance_or_its_end(db):
    await _reset(db)
    await _set(db, plan='growth', status='trial')
    await db.query("update workspace set trial_ends_at = now() + interval '10 days' where id = 'ws_default'")
    assert await billing.can_score(db) == (True, None)
    await _usage(db, 'scored_call', 250, 'trial')
    ok, why = await billing.can_score(db)
    assert not ok and "trial's 250 scored calls" in why
    await db.query("update workspace set trial_ends_at = now() - interval '1 hour' where id = 'ws_default'")
    assert (await billing.can_score(db))[1].startswith('The trial has ended')


async def test_pay_as_you_go_charges_each_call_once_and_waits_when_credit_runs_out(db, client):
    await _reset(db)
    await _set(db, plan='payg', status='active', credit_usd=0.30)
    await billing.record_scored_call(db, 'el_c1')
    await billing.record_scored_call(db, 'el_c1')  # re-scored: not charged again
    w = await db.one("select credit_usd from workspace where id = 'ws_default'")
    assert round(w['credit_usd'], 2) == 0.10
    ledger = await db.query("select kind, amount_usd, ref from credit_ledger")
    assert [(r['kind'], round(r['amount_usd'], 2), r['ref']) for r in ledger] == [('charge', -0.2, 'call:el_c1')]
    ok, why = await billing.can_score(db)
    assert not ok and why == 'Out of credit: top up to keep scoring.'
    await db.query("insert into calls (call_id, provider, external_id, started_at, status, source) values ('el_wait', 'elevenlabs', 'wait', now(), 'waiting', 'live')")
    assert await billing.release_waiting(db) == 0
    body, h = _event('evt_topup', 'checkout.session.completed', {
        'id': 'cs_1', 'mode': 'payment', 'payment_status': 'paid', 'amount_total': 5000, 'customer': 'cus_1',
        'client_reference_id': 'ws_default', 'metadata': {'workspace': 'ws_default', 'kind': 'topup', 'amountUsd': '50'}})
    r = (await client.post('/webhooks/stripe', content=body, headers=h)).json()
    assert r == {'ok': True, 'credit': 50.0, 'released': 1}
    assert (await client.post('/webhooks/stripe', content=body, headers=h)).json() == {'ok': True, 'duplicate': True}
    w = await db.one("select credit_usd, stripe_customer_id from workspace where id = 'ws_default'")
    assert round(w['credit_usd'], 2) == 50.10 and w['stripe_customer_id'] == 'cus_1'
    job = await db.one("select payload from job where dedupe_key = 'eval:el_wait'")
    assert job['payload']['callId'] == 'el_wait'


async def test_webhook_signatures_are_checked(client):
    body, h = _event('evt_x', 'invoice.paid', {'customer': 'cus_1'})
    assert (await client.post('/webhooks/stripe', content=body, headers={'stripe-signature': 't=1,v1=00'})).status_code == 400
    old = stripe.sign(body, SECRET, ts=1_000_000)
    assert (await client.post('/webhooks/stripe', content=body, headers={'stripe-signature': old})).status_code == 400
    assert (await client.post('/webhooks/stripe', content=body, headers=h)).status_code == 200


async def test_the_spend_cap_holds_extra_calls(db):
    await _reset(db)
    await _set(db, plan='starter', status='active')
    await _usage(db, 'scored_call', 1000, 'inc')
    assert await billing.can_score(db) == (True, None)
    await db.query("update workspace set spend_cap_usd = 0.10 where id = 'ws_default'")
    ok, why = await billing.can_score(db)
    assert not ok and 'spend cap' in why


async def test_seats_and_features_follow_the_plan(db):
    await _reset(db)
    await _set(db, plan='starter', status='active')
    for i in range(3):
        await db.query("insert into app_user (id, email, name, role) values ($1, $2, 'x', 'admin')", [f'usr_{i}', f'u{i}@example.com'])
    with pytest.raises(HttpStatusError) as e:
        await billing.check_seat(db, 'qa_lead')
    assert e.value.status_code == 402 and '3 editor seats' in e.value.message
    await billing.check_seat(db, 'viewer')  # viewers are free
    with pytest.raises(HttpStatusError) as e:
        await billing.require_feature(db, 'crm')
    assert e.value.status_code == 402 and 'Starter' in e.value.message and 'Growth' in e.value.message
    with pytest.raises(HttpStatusError):
        await update_settings(db, {'features': {'crm': True}})
    await billing.require_feature(db, 'api_tokens')
    await _set(db, plan='payg', status='active')
    await billing.require_feature(db, 'copilot')  # paid per draft
    await _set(db, plan='growth', status='active')
    await update_settings(db, {'features': {'crm': True}})
    await update_settings(db, {'features': {'crm': False}})
    await db.query("delete from app_user where id like 'usr_%'")
    forget_users_cache()  # back to open mode for the HTTP tests below


async def test_copilot_drafts_beyond_the_plan_are_paid_from_credit(db):
    await _reset(db)
    await _set(db, plan='starter', status='active')
    await _usage(db, 'copilot_draft', 20, 'cp')
    with pytest.raises(HttpStatusError) as e:
        await billing.use_copilot(db, 'taxonomy')
    assert e.value.status_code == 402 and 'top up credit' in e.value.message
    await db.query("update workspace set credit_usd = 5 where id = 'ws_default'")
    await billing.use_copilot(db, 'taxonomy')
    w = await db.one("select credit_usd from workspace where id = 'ws_default'")
    assert w['credit_usd'] == 4
    with pytest.raises(HttpStatusError):
        await billing.use_improvement_cycle(db, 'cyc_1')  # Starter has no self-improvement


async def test_checkout_creates_a_customer_once_and_a_subscription_session(db, client, monkeypatch):
    await _reset(db)
    await _set(db, plan='growth', status='trial')
    sent: list[tuple[str, dict]] = []

    def record(u, req):
        sent.append((u.path, {k: v[0] for k, v in parse_qs(req['content']).items()}))
        return {'id': 'cus_9'} if u.path.endswith('/customers') else {'id': 'cs_9', 'url': 'https://checkout.stripe.com/c/9'}

    calls = stub_http(monkeypatch, [(r'/v1/customers$', record), (r'/v1/checkout/sessions$', record), (r'/v1/billing_portal/sessions$', lambda u, r: {'url': 'https://billing.stripe.com/p/1'})])
    r = (await client.post('/api/billing/checkout', json={'plan': 'growth', 'annual': True})).json()
    assert r == {'url': 'https://checkout.stripe.com/c/9'}
    session = sent[-1][1]
    assert session['mode'] == 'subscription' and session['client_reference_id'] == 'ws_default' and session['customer'] == 'cus_9'
    assert session['line_items[0][price_data][unit_amount]'] == '499000' and session['line_items[0][price_data][recurring][interval]'] == 'year'
    assert session['success_url'] == 'https://evals.example.com/app/#billing?checkout=success'
    await client.post('/api/billing/checkout', json={'plan': 'starter'})
    assert [c for c in calls if c.endswith('/customers')] == ['POST /v1/customers']  # reused
    assert sent[-1][1]['line_items[0][price_data][unit_amount]'] == '14900'
    top = await client.post('/api/billing/topup', json={'amountUsd': 200})
    assert top.status_code == 200 and sent[-1][1]['payment_intent_data[setup_future_usage]'] == 'off_session'
    assert (await client.post('/api/billing/topup', json={'amountUsd': 75})).status_code == 400
    assert (await client.post('/api/billing/checkout', json={'plan': 'enterprise'})).status_code == 400
    assert (await client.post('/api/billing/portal')).json() == {'url': 'https://billing.stripe.com/p/1'}
    monkeypatch.setattr(config, 'stripe_secret_key', None)
    r = await client.post('/api/billing/checkout', json={'plan': 'growth'})
    assert r.status_code == 400 and 'Stripe is not configured' in r.json()['message']
    payg = (await client.post('/api/billing/checkout', json={'plan': 'payg'})).json()
    assert payg['url'].endswith('checkout=success')
    assert (await db.one("select plan, status from workspace where id = 'ws_default'")) == {'plan': 'payg', 'status': 'active'}


async def test_subscription_webhooks_move_the_plan(db, client):
    await _reset(db)
    await _set(db, plan='growth', status='trial')
    await db.query("update workspace set stripe_customer_id = 'cus_5' where id = 'ws_default'")
    body, h = _event('evt_sub', 'checkout.session.completed', {
        'id': 'cs_5', 'mode': 'subscription', 'subscription': 'sub_5', 'customer': 'cus_5', 'client_reference_id': 'ws_default',
        'metadata': {'workspace': 'ws_default', 'kind': 'subscription', 'plan': 'scale', 'annual': 'false'}})
    assert (await client.post('/webhooks/stripe', content=body, headers=h)).json()['plan'] == 'scale'
    w = await db.one("select plan, status, stripe_subscription_id, trial_ends_at from workspace where id = 'ws_default'")
    assert w == {'plan': 'scale', 'status': 'active', 'stripe_subscription_id': 'sub_5', 'trial_ends_at': None}
    body, h = _event('evt_fail', 'invoice.payment_failed', {'customer': 'cus_5'})
    await client.post('/webhooks/stripe', content=body, headers=h)
    assert (await db.one("select status from workspace where id = 'ws_default'"))['status'] == 'past_due'
    body, h = _event('evt_del', 'customer.subscription.deleted', {'id': 'sub_5', 'customer': 'cus_5', 'status': 'canceled', 'metadata': {}})
    await client.post('/webhooks/stripe', content=body, headers=h)
    assert (await db.one("select status from workspace where id = 'ws_default'"))['status'] == 'cancelled'
    assert (await billing.can_score(db))[1].startswith('The subscription is cancelled')


async def test_a_renewal_invoice_bills_the_extra_calls_once(db, client, monkeypatch):
    await _reset(db)
    await _set(db, plan='starter', status='active')
    await db.query("update workspace set stripe_customer_id = 'cus_7' where id = 'ws_default'")
    await _usage(db, 'scored_call', 1003, 'ren')
    items: list[dict] = []
    stub_http(monkeypatch, [(r'/v1/invoiceitems$', lambda u, r: items.append({k: v[0] for k, v in parse_qs(r['content']).items()}) or {'id': 'ii_1'})])
    period = {'period_start': 1_000_000_000, 'period_end': 4_000_000_000}
    body, h = _event('evt_inv1', 'invoice.created', {'id': 'in_1', 'customer': 'cus_7', 'billing_reason': 'subscription_cycle', 'status': 'draft', **period})
    assert (await client.post('/webhooks/stripe', content=body, headers=h)).json()['extra'] == 3
    assert items == [{'customer': 'cus_7', 'invoice': 'in_1', 'currency': 'usd', 'amount': '45', 'description': '3 extra scored calls at $0.15'}]
    body, h = _event('evt_inv2', 'invoice.created', {'id': 'in_2', 'customer': 'cus_7', 'billing_reason': 'subscription_cycle', 'status': 'draft', **period})
    assert (await client.post('/webhooks/stripe', content=body, headers=h)).json() == {'ok': True, 'extra': 0, 'already': True}
    assert len(items) == 1


async def test_the_billing_page_reports_usage_and_saves_controls(db, client):
    await _reset(db)
    await _set(db, plan='starter', status='active')
    await _usage(db, 'scored_call', 1010, 'pg')
    d = (await client.get('/api/billing')).json()
    assert d['enabled'] and d['plan'] == 'starter' and d['usage']['scoredCalls'] == 1010 and d['usage']['extraCalls'] == 10
    assert d['estimate']['extraUsd'] == 1.5 and d['usage']['seatsIncluded'] == 3 and d['stripe'] == {'checkout': True, 'portal': False}
    assert d['recommendation']['plan'] in ('payg', 'starter', 'growth', 'scale') and len(d['plans']) == 5
    d = (await client.put('/api/billing/settings', json={'spendCapUsd': 25, 'autoRecharge': {'enabled': True, 'thresholdUsd': 10, 'amountUsd': 50}})).json()
    assert d['spendCapUsd'] == 25 and d['credit']['autoRecharge'] == {'enabled': True, 'thresholdUsd': 10.0, 'amountUsd': 50.0}
    assert (await client.put('/api/billing/settings', json={'autoRecharge': {'amountUsd': 7}})).status_code == 400
