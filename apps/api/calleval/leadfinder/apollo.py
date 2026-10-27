# Apollo.io lead finder. Search (People API Search, no credits) finds people matching the business's ideal
# customer profile and adds them to the CRM as consent-unknown leads; enrichment (Bulk People Enrichment,
# credits per person) backfills names, emails, titles and locations, and phone numbers when a public HTTPS
# webhook can receive them (Apollo delivers phones asynchronously).
#   POST https://api.apollo.io/api/v1/mixed_people/api_search   x-api-key; filters as query parameters; ≤100 per page, ≤500 pages
#   POST https://api.apollo.io/api/v1/people/bulk_match          ≤10 details per call; reveal_phone_number needs webhook_url

from __future__ import annotations

import hmac
from typing import Any
from urllib.parse import urlencode

from ..business import apollo_search_params, get_business
from ..config import config, env
from ..crm.leads import event, upsert_lead
from ..js import js_json
from ..lib.crypto import decrypt
from ..lib.errors import http_error
from ..lib.http import fetch_retry
from ..lib.ids import sha
from ..lib.log import log

BASE = 'https://api.apollo.io/api/v1'
CREDITS_EMAIL = 1
CREDITS_PHONE = 8


async def apollo_credentials(db) -> dict | None:
    """The first enabled Apollo integration, else APOLLO_API_KEY from the environment."""
    row = await db.one("select id, secrets, config from integration where provider = 'apollo' and enabled order by created_at limit 1")
    if row and row['secrets']:
        import json
        s = json.loads(decrypt(row['secrets']))
        if s.get('apiKey'):
            return {'integrationId': row['id'], 'apiKey': s['apiKey'], 'baseUrl': (row['config'] or {}).get('baseUrl') or BASE}
    if env('APOLLO_API_KEY'):
        return {'integrationId': None, 'apiKey': env('APOLLO_API_KEY'), 'baseUrl': env('APOLLO_BASE_URL') or BASE}
    return None


def _headers(creds: dict) -> dict[str, str]:
    return {'x-api-key': creds['apiKey'], 'content-type': 'application/json', 'accept': 'application/json', 'cache-control': 'no-cache'}


async def search_people(creds: dict, filters: dict[str, Any], page: int = 1, per_page: int = 100) -> dict:
    qs = urlencode({**filters, 'page': page, 'per_page': per_page}, doseq=True)
    res = await fetch_retry(f"{creds['baseUrl'].rstrip('/')}/mixed_people/api_search?{qs}", method='POST', headers=_headers(creds), content='{}', retries=3)
    return res.json()


async def bulk_match(creds: dict, details: list[dict], *, reveal_phone: bool, webhook_url: str | None) -> dict:
    q: dict[str, Any] = {'reveal_personal_emails': 'false', 'reveal_phone_number': 'true' if reveal_phone and webhook_url else 'false'}
    if reveal_phone and webhook_url:
        q['webhook_url'] = webhook_url
    res = await fetch_retry(f"{creds['baseUrl'].rstrip('/')}/people/bulk_match?{urlencode(q)}", method='POST', headers=_headers(creds),
                            content=js_json({'details': details}), retries=3)
    return res.json()


def phone_webhook_secret(integration_id: str | None) -> str:
    return sha(f"apollo-phone:{integration_id or 'env'}:{config.app_secret or 'calleval-dev-secret-change-me'}", 32)


def phone_webhook_url(integration_id: str | None) -> str | None:
    """Where Apollo should send revealed phone numbers; None unless the service has a public HTTPS address."""
    base = (config.public_url or '').rstrip('/')
    if not base.startswith('https://'):
        return None
    return f"{base}/webhooks/apollo/{integration_id or 'env'}/{phone_webhook_secret(integration_id)}"


def verify_phone_webhook(integration_id: str, secret: str) -> bool:
    return hmac.compare_digest(secret.encode(), phone_webhook_secret(None if integration_id == 'env' else integration_id).encode())


def _person_to_lead(p: dict) -> dict[str, Any]:
    org = p.get('organization') or {}
    phones = p.get('phone_numbers') or []
    phone = next((x.get('sanitized_number') or x.get('raw_number') for x in phones if x.get('sanitized_number') or x.get('raw_number')), None)
    out = {
        'apolloId': p.get('id'), 'firstName': p.get('first_name'), 'lastName': p.get('last_name'), 'title': p.get('title'),
        'company': org.get('name') or p.get('organization_name'), 'city': p.get('city'), 'country': p.get('country'),
        'email': p.get('email') if p.get('email_status') in (None, 'verified', 'likely to engage', 'guessed') and p.get('email') and 'email_not_unlocked' not in p.get('email', '') else None,
        'phone': phone,
    }
    return {k: v for k, v in out.items() if v}


async def run_search(db, *, max_leads: int = 100, filters: dict[str, Any] | None = None, actor: str = 'lead finder') -> dict:
    """Search Apollo with the ideal customer profile (or explicit filters) and add new people to the CRM."""
    creds = await apollo_credentials(db)
    if not creds:
        raise http_error(400, 'Add an Apollo integration (or set APOLLO_API_KEY) first.')
    business = await get_business(db)
    f = filters if filters is not None else apollo_search_params(business)
    if not f:
        raise http_error(400, 'The ideal customer profile is empty; fill it in during onboarding before searching.')
    persona = business['icp'].get('personaHint')
    created = existing = pages = seen = 0
    page, per_page = 1, 100
    while seen < max_leads and page <= 500:
        body = await search_people(creds, f, page, per_page)
        people = body.get('people') or []
        pages += 1
        for p in people[: max_leads - seen]:
            seen += 1
            row, was_created = await upsert_lead(db, {**_person_to_lead(p), 'personaHint': persona, 'consent': 'unknown', 'tags': ['apollo']},
                                                 source='apollo', actor=actor)
            await db.query('update lead set enrichment = enrichment || $2::jsonb where id = $1',
                           [row['id'], js_json({'apollo': {'hasEmail': p.get('has_email'), 'hasDirectPhone': p.get('has_direct_phone')}})])
            created += was_created
            existing += not was_created
        if not people or (body.get('total_entries') or 0) <= page * per_page:
            break
        page += 1
    log.info('apollo search done', {'created': created, 'existing': existing, 'pages': pages})
    return {'created': created, 'existing': existing, 'pages': pages}


async def run_enrich(db, *, lead_ids: list[str] | None = None, credit_cap: int = 100, reveal_phone: bool = True, actor: str = 'lead finder') -> dict:
    """Backfill leads from Apollo: those missing an email or phone (or the given ones), within a credit cap."""
    creds = await apollo_credentials(db)
    if not creds:
        raise http_error(400, 'Add an Apollo integration (or set APOLLO_API_KEY) first.')
    webhook = phone_webhook_url(creds['integrationId']) if reveal_phone else None
    per_person = CREDITS_EMAIL + (CREDITS_PHONE if webhook else 0)
    limit = max(0, credit_cap // per_person)
    if lead_ids:
        rows = await db.query('select * from lead where id = any($1::text[]) limit $2', [lead_ids, limit])
    else:
        rows = await db.query(
            """select * from lead where not dnc and (email is null or phone is null or last_name is null) and (apollo_id is not null or (first_name is not null and company is not null))
               order by created_at limit $1""", [limit])
    matched = credits = 0
    for i in range(0, len(rows), 10):
        batch = rows[i:i + 10]
        details = []
        for r in batch:
            d = {'id': r['apollo_id']} if r['apollo_id'] else {}
            for k, col in (('first_name', 'first_name'), ('last_name', 'last_name'), ('email', 'email'), ('organization_name', 'company')):
                if r.get(col):
                    d[k] = r[col]
            details.append(d)
        body = await bulk_match(creds, details, reveal_phone=bool(webhook), webhook_url=webhook)
        credits += int(body.get('credits_consumed') or 0)
        for r, m in zip(batch, body.get('matches') or [], strict=False):
            if not m:
                continue
            matched += 1
            await upsert_lead(db, {**_person_to_lead(m), 'apolloId': r['apollo_id'] or m.get('id')}, source='apollo', actor=actor)
            await db.query("update lead set enriched_at = now(), enrichment = enrichment || $2::jsonb where id = $1",
                           [r['id'], js_json({'apollo': {'matchConfidence': m.get('match_confidence'), 'requestId': body.get('request_id'), 'phonePending': bool(webhook)}})])
            await event(db, r['id'], 'enrich', {'provider': 'apollo', 'phoneRequested': bool(webhook)}, actor)
    return {'requested': len(rows), 'matched': matched, 'creditsConsumed': credits, 'phonesBy': 'webhook' if webhook else None,
            'note': None if webhook or not reveal_phone else 'Phone numbers need a public HTTPS PUBLIC_URL for Apollo to deliver them; emails and profile fields were enriched.'}


async def receive_phones(db, payload: Any) -> dict:
    """Apollo's asynchronous phone delivery: people with their phone_numbers, matched by Apollo id."""
    people: list[dict] = []
    if isinstance(payload, dict):
        for key in ('people', 'matches', 'contacts', 'persons'):
            if isinstance(payload.get(key), list):
                people += [p for p in payload[key] if isinstance(p, dict)]
        if payload.get('id') and payload.get('phone_numbers'):
            people.append(payload)
    elif isinstance(payload, list):
        people = [p for p in payload if isinstance(p, dict)]
    updated = 0
    for p in people:
        data = _person_to_lead(p)
        if not data.get('phone') or not p.get('id'):
            continue
        row = await db.one('select id from lead where apollo_id = $1', [p['id']])
        if row:
            await upsert_lead(db, {'apolloId': p['id'], 'phone': data['phone']}, source='apollo', actor='apollo webhook')
            updated += 1
    return {'updated': updated}
