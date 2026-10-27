# Business onboarding: who the agent sells for, who it should reach (the ideal customer profile), the goals
# the sales team holds it to, and the calling rules. Lead finders search from the profile, campaigns obey
# the calling rules, and the self-improvement loop ranks fixes by the goals.

from __future__ import annotations

import copy
import re
from typing import Any

from .js import now_iso
from .lib.errors import http_error
from .lib.settings import get_kv, set_kv
from .taxonomy import current

DEFAULT_BUSINESS: dict[str, Any] = {
    'company': {'name': '', 'website': '', 'industry': '', 'description': '', 'offer': '', 'markets': [], 'languages': ['en']},
    # Who to find. Titles, seniorities, industries and locations follow Apollo's search vocabulary.
    'icp': {'titles': [], 'excludeTitles': [], 'seniorities': [], 'industries': [], 'personLocations': [], 'organizationLocations': [],
            'employeeRanges': [], 'keywords': '', 'personaHint': None},
    'goals': {'meetingsPerWeek': None, 'targetMeetingRate': None, 'targetCqs': None, 'leadsPerWeek': None, 'monthlyCallBudget': None,
              'focusPersonas': [], 'focusScenarios': []},
    'calling': {'timezone': 'Asia/Dubai', 'startHour': 9, 'endHour': 20, 'days': [0, 1, 2, 3, 4, 5], 'maxAttemptsPerLead': 3,
                'allowUnknownConsent': False},
    'onboardedAt': None,
}

SENIORITIES = ('owner', 'founder', 'c_suite', 'partner', 'vp', 'head', 'director', 'manager', 'senior', 'entry', 'intern')
_RANGE = re.compile(r'^\d+,\d+$')


async def get_business(db) -> dict[str, Any]:
    stored = await get_kv(db, 'business') or {}
    out = copy.deepcopy(DEFAULT_BUSINESS)
    for k, v in stored.items():
        out[k] = {**out[k], **v} if isinstance(out.get(k), dict) and isinstance(v, dict) else v
    return out


def _strs(v: Any, limit: int = 50) -> list[str]:
    if not isinstance(v, list):
        raise http_error(400, 'Expected a list of strings')
    out = [str(x).strip() for x in v if str(x).strip()][:limit]
    return list(dict.fromkeys(out))


def _num(v: Any, lo: float, hi: float) -> float | None:
    if v is None or v == '':
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not lo <= v <= hi:
        raise http_error(400, f'Expected a number from {lo} to {hi}')
    return v


async def update_business(db, patch: dict[str, Any]) -> dict[str, Any]:
    cur = merge_business(await get_business(db), patch)
    await set_kv(db, 'business', cur)
    return cur


def merge_business(cur: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    """The profile with a patch applied, checked; raises 400 on the first bad field. Nothing is saved."""
    cur = copy.deepcopy(cur)
    if not isinstance(patch, dict):
        raise http_error(400, 'Expected an object')
    c = patch.get('company')
    if isinstance(c, dict):
        for k in ('name', 'website', 'industry', 'description', 'offer'):
            if k in c:
                cur['company'][k] = str(c[k] or '').strip()[:2000]
        for k in ('markets', 'languages'):
            if k in c:
                cur['company'][k] = _strs(c[k])
    i = patch.get('icp')
    if isinstance(i, dict):
        for k in ('titles', 'excludeTitles', 'industries', 'personLocations', 'organizationLocations'):
            if k in i:
                cur['icp'][k] = _strs(i[k])
        if 'seniorities' in i:
            bad = [s for s in _strs(i['seniorities']) if s not in SENIORITIES]
            if bad:
                raise http_error(400, f"Unknown seniority: {', '.join(bad)} (use {', '.join(SENIORITIES)})")
            cur['icp']['seniorities'] = _strs(i['seniorities'])
        if 'employeeRanges' in i:
            r = _strs(i['employeeRanges'])
            if any(not _RANGE.match(x) for x in r):
                raise http_error(400, 'Employee ranges look like "11,50"')
            cur['icp']['employeeRanges'] = r
        if 'keywords' in i:
            cur['icp']['keywords'] = str(i['keywords'] or '').strip()[:500]
        if 'personaHint' in i:
            ph = i['personaHint']
            if ph is not None and not current().is_active(ph):
                raise http_error(400, 'personaHint must be a persona id from the active taxonomy, or null')
            cur['icp']['personaHint'] = ph
    g = patch.get('goals')
    if isinstance(g, dict):
        limits = {'meetingsPerWeek': (0, 100000), 'targetMeetingRate': (0, 100), 'targetCqs': (0, 100), 'leadsPerWeek': (0, 1000000), 'monthlyCallBudget': (0, 10000000)}
        for k, (lo, hi) in limits.items():
            if k in g:
                cur['goals'][k] = _num(g[k], lo, hi)
        if 'focusPersonas' in g:
            ids = _strs(g['focusPersonas'])
            bad = [x for x in ids if not current().is_active(x) or not x.startswith('P')]
            if bad:
                raise http_error(400, f"focusPersonas takes persona ids from the active taxonomy (not {', '.join(bad)})")
            cur['goals']['focusPersonas'] = ids
        if 'focusScenarios' in g:
            ids = _strs(g['focusScenarios'])
            bad = [x for x in ids if not current().is_active(x) or not x.startswith('S')]
            if bad:
                raise http_error(400, f"focusScenarios takes scenario ids from the active taxonomy (not {', '.join(bad)})")
            cur['goals']['focusScenarios'] = ids
    cl = patch.get('calling')
    if isinstance(cl, dict):
        if 'timezone' in cl:
            from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
            try:
                ZoneInfo(str(cl['timezone']))
            except (ZoneInfoNotFoundError, ValueError) as e:
                raise http_error(400, f"Unknown timezone: {cl['timezone']}") from e
            cur['calling']['timezone'] = str(cl['timezone'])
        for k, lo, hi in (('startHour', 0, 23), ('endHour', 1, 24), ('maxAttemptsPerLead', 1, 20)):
            if k in cl:
                v = _num(cl[k], lo, hi)
                cur['calling'][k] = int(v) if v is not None else DEFAULT_BUSINESS['calling'][k]
        if cur['calling']['endHour'] <= cur['calling']['startHour']:
            raise http_error(400, 'endHour must be after startHour')
        if 'days' in cl:
            days = sorted({int(d) for d in cl['days'] if isinstance(d, int) and 0 <= d <= 6}) if isinstance(cl['days'], list) else None
            if not days:
                raise http_error(400, 'days takes weekday numbers, 0 = Monday … 6 = Sunday')
            cur['calling']['days'] = days
        if 'allowUnknownConsent' in cl:
            cur['calling']['allowUnknownConsent'] = bool(cl['allowUnknownConsent'])
    if patch.get('onboarded') and not cur['onboardedAt']:
        cur['onboardedAt'] = now_iso()
    return cur


async def drop_retired_ids(db) -> None:
    """After a taxonomy activation: forget the focus personas and scenarios, and the expected persona, it retired."""
    stored = await get_kv(db, 'business')
    if not stored:
        return
    t = current()
    goals, icp = stored.get('goals') or {}, stored.get('icp') or {}
    changed = False
    for k in ('focusPersonas', 'focusScenarios'):
        keep = [x for x in goals.get(k) or [] if t.is_active(x)]
        if keep != (goals.get(k) or []):
            goals[k] = keep
            changed = True
    if icp.get('personaHint') and not t.is_active(icp['personaHint']):
        icp['personaHint'] = None
        changed = True
    if changed:
        await set_kv(db, 'business', stored)


def apollo_search_params(profile: dict[str, Any]) -> dict[str, Any]:
    """The Apollo people-search filters the ideal customer profile implies (array params end in [])."""
    icp = profile['icp']
    p: dict[str, Any] = {}
    if icp['titles']:
        p['person_titles[]'] = icp['titles']
        p['include_similar_titles'] = True
    if icp['excludeTitles']:
        p['person_not_titles[]'] = icp['excludeTitles']
    if icp['seniorities']:
        p['person_seniorities[]'] = icp['seniorities']
    if icp['personLocations']:
        p['person_locations[]'] = icp['personLocations']
    if icp['organizationLocations']:
        p['organization_locations[]'] = icp['organizationLocations']
    if icp['employeeRanges']:
        p['organization_num_employees_ranges[]'] = icp['employeeRanges']
    kw = ' '.join(x for x in [icp['keywords'], *icp['industries']] if x).strip()
    if kw:
        p['q_keywords'] = kw
    return p


async def goals_progress(db) -> dict[str, Any]:
    """This week against the goals: meetings booked, meeting rate, median CQS, new leads, calls this month."""
    b = await get_business(db)
    g = b['goals']
    # Live calls once there are any (as the console's data mode does); demo calls until then.
    live = await db.one("select 1 from calls where source <> 'demo' limit 1")
    src = "c.source <> 'demo'" if live else 'true'
    r = await db.one(
        f"""select count(*) filter (where c.next_step = 'meeting')::int as meetings,
             count(*)::int as calls,
             percentile_cont(0.5) within group (order by c.cqs) as cqs
           from calls c where c.status = 'scored' and {src} and c.started_at > now() - interval '7 days'""")
    m = await db.one(f"select count(*)::int as n from calls c where {src} and c.started_at > date_trunc('month', now())")
    leads = await db.one("select count(*)::int as n from lead where created_at > now() - interval '7 days'")
    calls = r['calls'] or 0
    rate = round(r['meetings'] / calls * 100, 1) if calls else None
    return {
        'onboarded': bool(b['onboardedAt']),
        'week': {'meetings': r['meetings'], 'calls': calls, 'meetingRate': rate, 'cqs': None if r['cqs'] is None else round(r['cqs']), 'newLeads': leads['n']},
        'month': {'calls': m['n']},
        'goals': g,
        'onTrack': {
            'meetings': None if g['meetingsPerWeek'] is None else r['meetings'] >= g['meetingsPerWeek'],
            'meetingRate': None if g['targetMeetingRate'] is None or rate is None else rate >= g['targetMeetingRate'],
            'cqs': None if g['targetCqs'] is None or r['cqs'] is None else r['cqs'] >= g['targetCqs'],
            'leads': None if g['leadsPerWeek'] is None else leads['n'] >= g['leadsPerWeek'],
            'budget': None if g['monthlyCallBudget'] is None else m['n'] <= g['monthlyCallBudget'],
        },
    }
