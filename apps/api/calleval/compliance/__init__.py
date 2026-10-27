# Calling compliance: country rules (calling hours, retry pacing, stop after refusal, consent, AI disclosure),
# the workspace's do-not-call list, and the issues Business setup and campaigns have against them.
#
# A lead is called only when both windows are open: the business's calling hours (campaigns/engine) and its
# country's (here, in the lead's local time), so the business window never widens a country's. Numbers with no
# country rule follow the business's hours and attempt limit alone. Every lead that refused on a call, or whose
# number is on the do-not-call list, is never called again.

from __future__ import annotations

import csv
import io
import re
from datetime import UTC, datetime, timedelta
from typing import Any, Callable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ..js import iso

CONSENTED = ('opt_in', 'existing_customer')

RULES: list[dict[str, Any]] = [
    {'country': 'AE', 'name': 'United Arab Emirates', 'prefixes': ['+971'], 'timezone': 'Asia/Dubai', 'startHour': 9, 'endHour': 18, 'days': None,
     'maxPerDay': 1, 'maxPerWeek': 2, 'stopAfterRefusal': True, 'consent': 'any', 'aiDisclosure': False,
     'registry': 'UAE Do Not Call Registry (TDRA)', 'source': 'UAE Cabinet Resolution 56 of 2024 (in force 27 August 2024)'},
    # The lead's own time zone (lead.timezone): the US spans several.
    {'country': 'US', 'name': 'United States', 'prefixes': ['+1'], 'timezone': None, 'startHour': 8, 'endHour': 21, 'days': None,
     'maxPerDay': None, 'maxPerWeek': None, 'stopAfterRefusal': True, 'consent': 'opt_in', 'aiDisclosure': True,
     'registry': 'National Do Not Call Registry',
     'source': 'TCPA calling-hour rule (47 CFR 64.1200(c)(1)); FCC declaratory ruling on AI voices, February 2024'},
]


def rule_for(phone: str | None) -> dict | None:
    """The country rule for an E.164 number (longest matching prefix), or None."""
    if not phone:
        return None
    best = None
    for r in RULES:
        for pre in r['prefixes']:
            if phone.startswith(pre) and (best is None or len(pre) > best[0]):
                best = (len(pre), r)
    return best[1] if best else None


def ai_disclosure(phone: str | None) -> bool:
    r = rule_for(phone)
    return bool(r and r['aiDisclosure'])


def rules_dto() -> list[dict]:
    return [{k: v for k, v in r.items() if k != 'timezone'} for r in RULES]


def _tz(name: str | None) -> ZoneInfo | None:
    try:
        return ZoneInfo(name) if name else None
    except (ZoneInfoNotFoundError, ValueError):
        return None


def window_open(rule: dict, now: datetime, tz: str | None = None) -> bool:
    """The rule's calling window at `now`, in its own time zone or the lead's."""
    zone = _tz(rule['timezone'] or tz)
    if zone is None:
        return False
    t = now.astimezone(zone)
    return rule['startHour'] <= t.hour < rule['endHour'] and (rule['days'] is None or t.weekday() in rule['days'])


def _prefix_sql(r: dict) -> str:
    # Prefixes are constants of this module, never input.
    return '(' + ' or '.join(f"left(l.phone, {len(p)}) = '{p}'" for p in r['prefixes']) + ')'


def campaign_conditions(now: datetime, p: Callable[[Any], str]) -> list[str]:
    """SQL conditions on `lead l` for the leads a campaign may call at `now` (`p` adds a parameter, returns its placeholder)."""
    conds = ['l.refused_at is null', 'not exists (select 1 from dnc_number d where d.phone = l.phone)']
    for r in RULES:
        req: list[str] = []
        if r['timezone']:
            if not window_open(r, now):
                req.append('false')
        else:
            ts = p(now)
            local = f'({ts}::timestamptz at time zone l.timezone)'
            days = f" and (extract(isodow from {local})::int - 1) in ({','.join(map(str, r['days']))})" if r['days'] else ''
            # A time zone PostgreSQL doesn't know would fail the query: CASE checks it before converting.
            req.append(f"(case when l.timezone in (select name from pg_timezone_names) then extract(hour from {local}) >= {r['startHour']}"
                       f" and extract(hour from {local}) < {r['endHour']}{days} else false end)")
        if r['consent'] == 'opt_in':
            req.append("l.consent in ('opt_in', 'existing_customer')")
        if r['maxPerDay'] or r['maxPerWeek']:
            ts = p(now)
            for n, span in ((r['maxPerDay'], '1 day'), (r['maxPerWeek'], '7 days')):
                if n:
                    req.append(f"(select count(*) from campaign_lead x where x.lead_id = l.id and x.attempted_at > {ts}::timestamptz - interval '{span}') < {int(n)}")
        if req:
            conds.append(f"(not {_prefix_sql(r)} or ({' and '.join(req)}))")
    return conds


def _when(t: datetime, rule: dict) -> str:
    zone = _tz(rule['timezone']) or UTC
    lt = t.astimezone(zone)
    return f"{lt.day} {lt:%b}, {lt:%H:%M} ({zone.key if isinstance(zone, ZoneInfo) else 'UTC'})"


async def holds(db, rows: list[dict], now: datetime | None = None) -> dict[str, dict]:
    """Why campaigns won't call each of these leads now ({reason, until}); leads with nothing holding them are absent."""
    now = now or datetime.now(UTC)
    if not rows:
        return {}
    phones = [r['phone'] for r in rows if r.get('phone')]
    listed = {x['phone'] for x in await db.query('select phone from dnc_number where phone = any($1::text[])', [phones])} if phones else set()
    paced = [r['id'] for r in rows if (rule_for(r.get('phone')) or {}).get('maxPerDay') or (rule_for(r.get('phone')) or {}).get('maxPerWeek')]
    attempts: dict[str, list[datetime]] = {}
    if paced:
        for x in await db.query("select lead_id, attempted_at from campaign_lead where lead_id = any($1::text[]) and attempted_at > $2::timestamptz - interval '7 days'",
                                [paced, now]):
            attempts.setdefault(x['lead_id'], []).append(x['attempted_at'])
    out: dict[str, dict] = {}
    for r in rows:
        rule = rule_for(r.get('phone'))
        if r.get('refused_at'):
            out[r['id']] = {'reason': 'Refused on a call', 'until': None}
        elif r.get('phone') in listed:
            out[r['id']] = {'reason': 'On the do-not-call list', 'until': None}
        elif rule and rule['consent'] == 'opt_in' and r.get('consent') not in CONSENTED:
            out[r['id']] = {'reason': f"Needs recorded consent ({rule['country']})", 'until': None}
        elif rule and not rule['timezone'] and _tz(r.get('timezone')) is None:
            out[r['id']] = {'reason': 'Time zone unknown', 'until': None}
        elif rule and r['id'] in attempts:
            until = _next_allowed(sorted(attempts[r['id']]), rule, now)
            if until:
                out[r['id']] = {'reason': f'Retry limit: next call after {_when(until, rule)}', 'until': iso(until)}
    return out


def _next_allowed(ats: list[datetime], rule: dict, now: datetime) -> datetime | None:
    """When the retry limits next allow a call (None: they allow one now)."""
    until = None
    for n, span in ((rule['maxPerDay'], timedelta(days=1)), (rule['maxPerWeek'], timedelta(days=7))):
        if not n:
            continue
        inside = [a for a in ats if a > now - span]
        if len(inside) >= n:
            t = inside[len(inside) - n] + span
            until = t if until is None or t > until else until
    return until


# ---------- Issues against the rules ----------

def _business_offset_hours(tz: str, rule_tz: str, now: datetime) -> float:
    a, b = _tz(tz), _tz(rule_tz)
    if not a or not b:
        return 0.0
    return ((now.astimezone(b).utcoffset() or timedelta()) - (now.astimezone(a).utcoffset() or timedelta())).total_seconds() / 3600


async def compliance_dto(db, now: datetime | None = None) -> dict:
    from ..business import get_business
    now = now or datetime.now(UTC)
    biz = await get_business(db)
    calling = biz['calling']
    markets = ' '.join(biz['company'].get('markets') or []).lower()
    counts = await db.one(
        f"""select count(*) filter (where {_prefix_sql(RULES[0])})::int as ae,
                   count(*) filter (where {_prefix_sql(RULES[1])})::int as us,
                   count(*) filter (where {_prefix_sql(RULES[1])} and l.consent not in ('opt_in', 'existing_customer'))::int as us_consent,
                   count(*) filter (where {_prefix_sql(RULES[1])} and (l.timezone is null or l.timezone not in (select name from pg_timezone_names)))::int as us_tz,
                   count(*) filter (where l.refused_at is not null)::int as refused,
                   count(*) filter (where exists (select 1 from dnc_number d where d.phone = l.phone))::int as dnc,
                   count(*) filter (where {_prefix_sql(RULES[0])} and l.refused_at is null and (
                       (select count(*) from campaign_lead x where x.lead_id = l.id and x.attempted_at > $1::timestamptz - interval '1 day') >= 1
                       or (select count(*) from campaign_lead x where x.lead_id = l.id and x.attempted_at > $1::timestamptz - interval '7 days') >= 2))::int as pacing
            from lead l where not l.dnc""", [now])
    dnc = await db.one('select count(*)::int as n, max(added_at) as at from dnc_number')
    issues: list[dict] = []
    for r in RULES:
        in_country = (counts['ae'] if r['country'] == 'AE' else counts['us']) > 0 or r['name'].lower() in markets \
            or (r['country'] == 'AE' and ('uae' in markets.split() or calling['timezone'] == 'Asia/Dubai')) \
            or (r['country'] == 'US' and calling['timezone'].startswith('America/'))
        if not in_country:
            continue
        if r['timezone'] or calling['timezone'].startswith('America/'):
            shift = _business_offset_hours(calling['timezone'], r['timezone'] or calling['timezone'], now)
            start, end = calling['startHour'] + shift, calling['endHour'] + shift
            if start < r['startHour'] or end > r['endHour']:
                issues.append({'severity': 'block', 'title': f"Calling hours run outside the {r['name']} window",
                               'detail': f"Business setup calls {calling['startHour']}:00–{calling['endHour']}:00 ({calling['timezone']}); {r['name']} allows "
                                         f"{r['startHour']}:00–{r['endHour']}:00 local time. Campaigns already hold those calls to the country's window.",
                               'fix': f"Set calling hours within {r['startHour']}:00–{r['endHour']}:00 in Business setup."})
    if counts['ae'] and not dnc['n']:
        issues.append({'severity': 'warn', 'title': 'No do-not-call list uploaded',
                       'detail': f"{counts['ae']} leads have UAE numbers. Scrub them against the UAE Do Not Call Registry (TDRA) before calling.",
                       'fix': 'Upload the registered numbers under Do-not-call list.'})
    if counts['ae'] or calling['timezone'] == 'Asia/Dubai':
        issues.append({'severity': 'warn', 'title': 'UAE telemarketing needs TDRA approval',
                       'detail': 'Companies need prior approval from the TDRA and must call from local numbers tied to their trade licence.',
                       'fix': 'Confirm the approval before starting UAE campaigns.'})
    if counts['us_consent']:
        issues.append({'severity': 'warn', 'title': f"{counts['us_consent']} US leads have no recorded consent",
                       'detail': 'AI-voiced calls to US numbers need prior express consent; campaigns skip these leads.',
                       'fix': 'Record opt-in consent on each lead before calling.'})
    if counts['us_tz']:
        issues.append({'severity': 'warn', 'title': f"{counts['us_tz']} US leads have no time zone",
                       'detail': 'US calls must fall within 8:00–21:00 in the lead’s own time zone; campaigns skip leads without one.',
                       'fix': 'Add the time zone, such as America/New_York, to each lead.'})
    if counts['us']:
        issues.append({'severity': 'warn', 'title': 'US calls must say the agent is an AI',
                       'detail': 'Campaigns pass ai_disclosure = true to the agent on calls to US numbers.',
                       'fix': 'Add it to the agent’s first line, such as “I’m an AI assistant calling from …”.'})
    return {
        'rules': rules_dto(),
        'dnc': {'count': dnc['n'], 'updatedAt': iso(dnc['at'])},
        'issues': sorted(issues, key=lambda i: i['severity'] != 'block'),
        'held': {'refused': counts['refused'], 'dnc': counts['dnc'], 'pacing': counts['pacing'], 'consent': counts['us_consent']},
    }


async def blocking_issues(db) -> int:
    """How many 'block' issues the workspace has (the setup checklist ticks its compliance step at 0)."""
    return sum(1 for i in (await compliance_dto(db))['issues'] if i['severity'] == 'block')


# ---------- The do-not-call list ----------

_PHONEISH = re.compile(r'^[+\d][\d\s().-]{5,}$')


def parse_numbers(body: Any) -> tuple[list[str], int]:
    """Numbers from {numbers: [...]} or CSV text (a header row and several columns allowed: the first column that looks
    like a phone number is used). Returns (E.164 numbers, how many were not valid)."""
    from ..crm.leads import is_e164, normalise_phone
    if isinstance(body, dict):
        raw = [str(x) for x in body.get('numbers') or [] if str(x).strip()]
    else:
        raw = []
        for row in csv.reader(io.StringIO(str(body or ''))):
            cell = next((c.strip() for c in row if _PHONEISH.match(c.strip())), None)
            if cell is not None:
                raw.append(cell)
            elif any(c.strip() for c in row) and any(ch.isdigit() for c in row for ch in c):
                raw.append(' '.join(row))  # digits that don't look like a number: counted as invalid
    good, bad = [], 0
    for x in raw:
        n = normalise_phone(x)
        if is_e164(n):
            good.append(n)
        else:
            bad += 1
    return list(dict.fromkeys(good)), bad


async def dnc_add(db, body: Any, source: str = 'upload') -> dict:
    numbers, invalid = parse_numbers(body)
    added = 0
    for i in range(0, len(numbers), 1000):
        chunk = numbers[i:i + 1000]
        rows = await db.query('insert into dnc_number (phone, source) select unnest($1::text[]), $2 on conflict do nothing returning phone', [chunk, source])
        added += len(rows)
    total = (await db.one('select count(*)::int as n from dnc_number'))['n']
    return {'added': added, 'invalid': invalid, 'total': total}


async def dnc_clear(db) -> dict:
    return {'removed': len(await db.query('delete from dnc_number returning phone'))}


async def dnc_check(db, phone: Any) -> dict:
    from ..crm.leads import normalise_phone
    n = normalise_phone(phone)
    return {'listed': bool(n and await db.one('select 1 from dnc_number where phone = $1', [n]))}
