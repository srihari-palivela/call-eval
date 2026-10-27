# CRM outcomes (Treppan or any CRM that can export lead stages). Outcomes join to calls through
# lead_id and are credited to the most recent call before each stage, within the attribution
# window (30 days by default; reservations and deals use the longer window, 90 days by default,
# because off-plan decisions take longer). A stage with no call in the window is stored but not
# credited to the agent.

from __future__ import annotations

from datetime import datetime
from typing import Any

from ..connectors.types import enc_uri, s_of, truthy
from ..js import iso, is_finite, js_number, jsre, parse_date
from ..lib.http import get_json
from ..lib.ids import new_id, sha
from ..lib.settings import get_settings

STAGES = ['meeting_booked', 'meeting_attended', 'site_visit', 'reservation', 'sale', 'broker_registered', 'bdm_call_held', 'broker_first_lead', 'broker_deal']
SYNONYMS: dict[str, str] = {
    'attended': 'meeting_attended', 'meeting_held': 'meeting_attended', 'visit': 'site_visit', 'sitevisit': 'site_visit', 'site_visit_done': 'site_visit',
    'reserved': 'reservation', 'booking': 'reservation', 'eoi': 'reservation', 'spa_signed': 'sale', 'sold': 'sale', 'closed_won': 'sale',
    'registered': 'broker_registered', 'broker_registration': 'broker_registered', 'bdm_call': 'bdm_call_held', 'first_lead': 'broker_first_lead', 'deal': 'broker_deal',
}
LONG_WINDOW = ['reservation', 'sale', 'broker_deal', 'broker_first_lead']

_SEP = jsre(r'[\s-]+', 'u')
_NOT_NUM = jsre(r'[^\d.]')

# OutcomeInput: {lead_id, stage, occurred_at, project?, value_aed?, external_id?, source?}


def normalise_stage(s: str) -> str | None:
    k = _SEP.sub('_', s.strip().lower())
    if k in STAGES:
        return k
    return SYNONYMS.get(k)


async def upsert_outcomes(db, rows: list[dict], source: str = 'api') -> dict:
    imported = skipped = 0
    leads: dict[str, None] = {}
    for r in rows:
        stage = normalise_stage(s_of(r.get('stage') if r.get('stage') is not None else ''))
        oa = r.get('occurred_at')
        at = parse_date(s_of(oa if oa is not None else ''))
        if not truthy(r.get('lead_id')) or not stage or at is None:
            skipped += 1
            continue
        v = r.get('value_aed')
        digits = '' if v is None else _NOT_NUM.sub('', s_of(v))
        value = js_number(digits) if digits else None  # 'n/a' or '' is no value, not 0 AED
        ext = r.get('external_id') if truthy(r.get('external_id')) else f"{source}:{sha(f'{s_of(r['lead_id'])}|{stage}|{iso(at)}', 20)}"
        await db.query(
            """insert into lead_outcome (id, lead_id, stage, occurred_at, project, value_aed, source, external_id) values ($1,$2,$3,$4,$5,$6,$7,$8)
               on conflict (workspace_id, external_id) do update set stage = excluded.stage, occurred_at = excluded.occurred_at, project = excluded.project, value_aed = excluded.value_aed""",
            [new_id('out'), s_of(r['lead_id']), stage, iso(at), r.get('project'), value if value is not None and is_finite(value) else None,
             r.get('source') if r.get('source') is not None else source, ext],
        )
        leads[s_of(r['lead_id'])] = None
        imported += 1
    credited = await attribute(db, list(leads))
    return {'imported': imported, 'skipped': skipped, 'credited': credited}


async def attribute(db, lead_ids: list[str] | None = None) -> int:
    """Credit each outcome to the most recent call for the lead before it, within the window."""
    s = await get_settings(db)
    await db.query(
        """update lead_outcome o set credited_call_id = (
             select c.call_id from calls c
             where c.lead_id = o.lead_id and c.started_at <= o.occurred_at
               and c.started_at >= o.occurred_at - (case when o.stage = any($3::text[]) then $2::int else $1::int end) * interval '1 day'
             order by c.started_at desc limit 1)
           where $4::text[] is null or o.lead_id = any($4::text[])
           returning o.id""",
        [s['attributionDays'], s['reservationAttributionDays'], LONG_WINDOW, lead_ids if lead_ids else None],
    )
    n = await db.one(f"select count(*)::int as n from lead_outcome where credited_call_id is not null {'and lead_id = any($1::text[])' if lead_ids else ''}",
                     [lead_ids] if lead_ids else [])
    return n['n'] if n else 0


def parse_csv(text: str) -> list[dict[str, str]]:
    """Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF)."""
    rows: list[list[str]] = []
    row: list[str] = []
    field = ''
    q = False
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if q:
            if ch == '"':
                if i + 1 < n and text[i + 1] == '"':
                    field += '"'
                    i += 1
                else:
                    q = False
            else:
                field += ch
        elif ch == '"':
            q = True
        elif ch == ',':
            row.append(field)
            field = ''
        elif ch in ('\n', '\r'):
            if ch == '\r' and i + 1 < n and text[i + 1] == '\n':
                i += 1
            row.append(field)
            rows.append(row)
            row = []
            field = ''
        else:
            field += ch
        i += 1
    if field or row:
        row.append(field)
        rows.append(row)
    clean = [r for r in rows if any(c.strip() for c in r)]
    if not clean:
        return []
    head = [h.strip().lower() for h in clean[0]]
    return [{h: (r[i] if i < len(r) else '').strip() for i, h in enumerate(head)} for r in clean[1:]]


async def pull_crm(db, base_url: str, api_key: str, since: datetime | None) -> dict:
    """Pull outcomes from the CRM. Treppan's export API is not public, so this adapter expects an
    endpoint returning `[{ lead_id, stage, occurred_at, project, value_aed, id }]` (or `{ items: [...] }`)
    for `?since=<ISO>`; point TREPPAN_API_URL at it or at a small mapping service in front of Treppan."""
    base = base_url[:-1] if base_url.endswith('/') else base_url
    url = f"{base}/outcomes{('?since=' + enc_uri(iso(since))) if since else ''}"
    body = await get_json(url, {'authorization': f'Bearer {api_key}'} if api_key else {})
    items: list[Any] = body if isinstance(body, list) else ((body.get('items') if isinstance(body, dict) else None) or [])

    def first(x: dict, *keys: str) -> Any:
        for k in keys:
            if x.get(k) is not None:
                return x[k]
        return None

    rows = [{'lead_id': first(x, 'lead_id', 'leadId'), 'stage': x.get('stage'), 'occurred_at': first(x, 'occurred_at', 'occurredAt', 'date'),
             'project': x.get('project'), 'value_aed': first(x, 'value_aed', 'valueAed', 'value'),
             'external_id': f"treppan:{s_of(x['id'])}" if truthy(x.get('id')) else None} for x in items]
    return await upsert_outcomes(db, rows, 'treppan')
