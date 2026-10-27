# Batch-calling campaigns over CRM leads (on when settings.features.campaigns is). A running campaign sends
# small batches inside the business's calling window, never more than its daily cap, only to eligible
# leads (valid E.164 number, not DNC, consent given or explicitly allowed, under the attempt limit, and within
# the calling rules of the lead's country: compliance/), and
# splits each batch between the champion prompt and, while a challenger is live, the challenger prompt.
# Calls come back through the normal provider webhooks and polling; their dynamic variables link them to
# the lead, campaign and arm.

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo

from .. import compliance
from ..business import get_business
from ..connectors.registry import credentials_of, get_integration
from ..crm.funnels import blocked_stages
from ..crm.leads import advance, eligibility_sql, event, is_e164
from ..jobs.queue import enqueue
from ..js import iso, js_json, now_ms, parse_date, to_ms
from ..lib.errors import http_error
from ..lib.ids import new_id, sha
from ..lib.log import err_msg, log
from ..lib.settings import get_settings
from . import providers

STATUSES = ('draft', 'running', 'paused', 'completed', 'cancelled')
MODES = ('off', 'propose', 'auto')
ACTIVE_CYCLE = ('proposing', 'probing', 'awaiting_approval', 'live', 'awaiting_promotion')
IN_FLIGHT_MS = 3 * 3600_000
VERIFY_EVERY_MS = 10 * 60_000


async def require_campaigns(db) -> None:
    if not (await get_settings(db))['features']['campaigns']:
        raise http_error(403, 'Campaigns are off. Turn them on in Scoring model → Settings (features.campaigns).')


def effective_mode(campaign_mode: str, settings_mode: str) -> str:
    """The stricter of the campaign's improvement mode and the global one (off < propose < auto)."""
    rank = {m: i for i, m in enumerate(MODES)}
    return MODES[min(rank.get(campaign_mode, 0), rank.get(settings_mode, 0))]


def agent_row_id(provider: str, external_id: str) -> str:
    """The id ingest gives the provider's agent (pipeline.ingest.upsert_agent)."""
    return f"ag_{sha(f'{provider}:{external_id}', 12)}"


def to_dto(r: dict) -> dict:
    ch = r.get('challenger')
    return {
        'id': r['id'], 'name': r['name'], 'integrationId': r['integration_id'], 'agentExternalId': r['agent_external_id'], 'agentId': r['agent_id'],
        'fromNumber': r['from_number'], 'status': r['status'], 'objective': r['objective'], 'leadFilter': r['lead_filter'] or {},
        'batchSize': r['batch_size'], 'dailyCap': r['daily_cap'], 'concurrency': r['concurrency'], 'allowUnknownConsent': r['allow_unknown_consent'],
        'improvement': r['improvement'], 'challengerShare': r['challenger_share'], 'minCallsPerArm': r['min_calls_per_arm'], 'maxCallsPerArm': r['max_calls_per_arm'],
        'champion': {k: v for k, v in (r.get('champion') or {}).items() if k != 'prompt'} if r.get('champion') else None,
        'championPrompt': (r.get('champion') or {}).get('prompt'),
        'challenger': {k: v for k, v in ch.items() if k != 'prompt'} if ch else None,
        'challengerPrompt': ch.get('prompt') if ch else None,
        'stats': r['stats'] or {}, 'createdAt': iso(r['created_at']), 'updatedAt': iso(r['updated_at']),
    }


def _int(v: Any, lo: int, hi: int, name: str) -> int:
    if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
        raise http_error(400, f'{name} must be a whole number from {lo} to {hi}')
    return v


def _clean(b: dict[str, Any], cur: dict | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if 'name' in b:
        if not str(b['name'] or '').strip():
            raise http_error(400, 'A campaign needs a name')
        out['name'] = str(b['name']).strip()[:200]
    if 'objective' in b:
        out['objective'] = str(b['objective'] or '').strip()[:1000] or None
    if 'fromNumber' in b:
        out['from_number'] = str(b['fromNumber'] or '').strip() or None
    if 'agentExternalId' in b:
        out['agent_external_id'] = str(b['agentExternalId'] or '').strip()
    if 'leadFilter' in b:
        f = b['leadFilter'] or {}
        if not isinstance(f, dict):
            raise http_error(400, 'leadFilter is an object')
        lf: dict[str, list[str]] = {}
        for k in ('funnels', 'stages', 'sources', 'tags', 'leadIds'):
            if k in f and f[k] is not None:
                if not isinstance(f[k], list) or not all(isinstance(x, str) for x in f[k]):
                    raise http_error(400, f'leadFilter.{k} is a list of strings')
                lf[k] = f[k][:5000]
        out['lead_filter'] = lf
    for k, col, lo, hi in (('batchSize', 'batch_size', 1, 1000), ('dailyCap', 'daily_cap', 1, 100000), ('minCallsPerArm', 'min_calls_per_arm', 5, 10000),
                           ('maxCallsPerArm', 'max_calls_per_arm', 10, 100000)):
        if k in b:
            out[col] = _int(b[k], lo, hi, k)
    if 'concurrency' in b:
        out['concurrency'] = None if b['concurrency'] is None else _int(b['concurrency'], 1, 1000, 'concurrency')
    if 'allowUnknownConsent' in b:
        out['allow_unknown_consent'] = bool(b['allowUnknownConsent'])
    if 'improvement' in b:
        if b['improvement'] not in MODES:
            raise http_error(400, f"improvement must be one of {', '.join(MODES)}")
        out['improvement'] = b['improvement']
    if 'challengerShare' in b:
        s = b['challengerShare']
        if isinstance(s, bool) or not isinstance(s, (int, float)) or not 0.05 <= s <= 0.5:
            raise http_error(400, 'challengerShare is the share of calls on the challenger, 0.05 to 0.5')
        out['challenger_share'] = float(s)
    mn = out.get('min_calls_per_arm', (cur or {}).get('min_calls_per_arm', 30))
    mx = out.get('max_calls_per_arm', (cur or {}).get('max_calls_per_arm', 300))
    if mx < mn:
        raise http_error(400, 'maxCallsPerArm must be at least minCallsPerArm')
    return out


async def _row(db, id: str) -> dict:
    r = await db.one('select * from campaign where id = $1', [id])
    if not r:
        raise http_error(404, 'Campaign not found')
    return r


async def create_campaign(db, b: dict[str, Any]) -> dict:
    integ = await get_integration(db, str(b.get('integrationId') or ''))
    if not integ or integ['provider'] not in ('elevenlabs', 'retell'):
        raise http_error(400, 'integrationId must be an ElevenLabs or Retell integration')
    v = _clean({**b, 'name': b.get('name')})
    agent = v.get('agent_external_id') or next(iter((integ.get('config') or {}).get('agentIds') or []), None)
    if not agent:
        raise http_error(400, 'agentExternalId is required (the provider agent that places the calls)')
    if integ['provider'] == 'retell' and not is_e164(v.get('from_number')):
        raise http_error(400, 'Retell campaigns need fromNumber: an E.164 number on the Retell account')
    cid = new_id('cmp')
    cols = {'id': cid, 'integration_id': integ['id'], 'agent_external_id': agent, 'agent_id': agent_row_id(integ['provider'], agent), **v}
    cols['lead_filter'] = js_json(cols.get('lead_filter') or {})
    names = list(cols)
    ph = ','.join(f'${i + 1}' + ('::jsonb' if n == 'lead_filter' else '') for i, n in enumerate(names))
    await db.query(f"insert into campaign ({','.join(names)}) values ({ph})", [cols[n] for n in names])
    return to_dto(await _row(db, cid))


async def update_campaign(db, id: str, b: dict[str, Any]) -> dict:
    cur = await _row(db, id)
    if cur['status'] in ('completed', 'cancelled'):
        raise http_error(400, f"A {cur['status']} campaign can't be changed")
    v = _clean(b, cur)
    if not v:
        return to_dto(cur)
    if 'lead_filter' in v:
        v['lead_filter'] = js_json(v['lead_filter'])
    sets = [f"{k} = ${i + 2}" + ('::jsonb' if k == 'lead_filter' else '') for i, k in enumerate(v)]
    await db.query(f"update campaign set {', '.join(sets)}, updated_at = now() where id = $1", [id, *v.values()])
    return to_dto(await _row(db, id))


async def resolve_champion(db, c: dict) -> dict:
    """The prompt and version label the campaign starts from: the agent's latest version and prompt."""
    from ..analytics.filters import versions
    vs = await versions(db, c['agent_id'])
    label = vs[-1]['label'] if vs else 'v1'
    a = await db.one('select prompt_text from agent where id = $1', [c['agent_id']])
    prompt = (a or {}).get('prompt_text')
    source = 'agent'
    if not prompt:
        integ = await get_integration(db, c['integration_id'])
        from ..connectors.registry import CONNECTORS
        conn = CONNECTORS.get(integ['provider']) if integ else None
        if conn:
            try:
                info = await conn.fetch_agent(credentials_of(integ), c['agent_external_id'])
                prompt = (info or {}).get('prompt')
                source = 'provider'
            except Exception as e:  # noqa: BLE001 - a campaign can run without a known prompt; improvement can't
                log.warn('could not fetch the agent prompt for a campaign', {'campaign': c['id'], 'error': err_msg(e)})
    return {'label': label, 'prompt': prompt, 'source': source if prompt else None}


async def set_status(db, id: str, action: str) -> dict:
    c = await _row(db, id)
    if action == 'start':
        if c['status'] not in ('draft', 'paused'):
            raise http_error(400, f"A {c['status']} campaign can't be started")
        if not c['champion']:
            await db.query('update campaign set champion = $2::jsonb where id = $1', [id, js_json(await resolve_champion(db, c))])
        await db.query("update campaign set status = 'running', updated_at = now() where id = $1", [id])
    elif action == 'pause':
        if c['status'] != 'running':
            raise http_error(400, 'Only a running campaign can be paused')
        await db.query("update campaign set status = 'paused', updated_at = now() where id = $1", [id])
    elif action == 'cancel':
        if c['status'] in ('completed', 'cancelled'):
            raise http_error(400, f"The campaign is already {c['status']}")
        await db.query("update campaign set status = 'cancelled', updated_at = now() where id = $1", [id])
    else:
        raise http_error(400, 'Unknown action')
    return to_dto(await _row(db, id))


# ---------- Who to call, and when ----------

def in_calling_window(calling: dict, now: datetime | None = None) -> bool:
    """Inside the business's calling hours: weekday (0 = Monday) and hour in its timezone."""
    t = (now or datetime.now(UTC)).astimezone(ZoneInfo(calling.get('timezone') or 'UTC'))
    return t.weekday() in (calling.get('days') or []) and calling.get('startHour', 9) <= t.hour < calling.get('endHour', 20)


def assign_arm(lead_id: str, cycle_id: str | None, share: float) -> str:
    """Deterministic split: the same lead lands in the same arm for a given challenger."""
    if not cycle_id:
        return 'champion'
    return 'challenger' if int(sha(f'{lead_id}:{cycle_id}', 8), 16) / 0xFFFFFFFF < share else 'champion'


def _param(params: list[Any]):
    def p(v: Any) -> str:
        params.append(v)
        return f'${len(params)}'
    return p


async def _callable(db, c: dict, calling: dict, params: list[Any], now: datetime) -> list[str]:
    """Who may be called now: CRM eligibility (E.164, not DNC, consent, attempts, a callable stage) and calling
    compliance (no refusal, not on the do-not-call list, the country's window, retry pacing and consent)."""
    max_attempts = int(calling.get('maxAttemptsPerLead') or 3)
    return [eligibility_sql(bool(c['allow_unknown_consent']), max_attempts, await blocked_stages(db)),
            *compliance.campaign_conditions(now, _param(params))]


async def eligible_leads(db, c: dict, calling: dict, limit: int, now: datetime | None = None) -> list[dict]:
    """Leads this campaign may call now, oldest first: CRM eligibility and calling compliance, the campaign's
    lead filter, under the per-lead attempt limit within this campaign, and not already waiting on a call from it."""
    max_attempts = int(calling.get('maxAttemptsPerLead') or 3)
    params: list[Any] = [c['id'], max_attempts]
    conds = [*await _callable(db, c, calling, params, now or datetime.now(UTC)),
             '(select count(*) from campaign_lead x where x.campaign_id = $1 and x.lead_id = l.id) < $2',
             "not exists (select 1 from campaign_lead x where x.campaign_id = $1 and x.lead_id = l.id and x.status in ('queued','dispatched'))"]
    f = c['lead_filter'] or {}
    for key, col in (('funnels', 'l.funnel_id'), ('stages', 'l.stage'), ('sources', 'l.source'), ('leadIds', 'l.id')):
        if f.get(key):
            params.append(f[key])
            conds.append(f'{col} = any(${len(params)}::text[])')
    if f.get('tags'):
        params.append(js_json(f['tags']))
        conds.append(f'l.tags ?| array(select jsonb_array_elements_text(${len(params)}::jsonb))')
    params.append(limit)
    return await db.query(f"select l.* from lead l where {' and '.join(conds)} order by l.created_at, l.id limit ${len(params)}", params)


async def _sent_last_day(db, campaign_id: str) -> int:
    r = await db.one("select count(*)::int as n from campaign_lead where campaign_id = $1 and attempted_at > now() - interval '1 day'", [campaign_id])
    return r['n']


async def _in_flight(db, campaign_id: str) -> bool:
    r = await db.one(
        """select 1 from campaign_batch b where b.campaign_id = $1 and b.status = 'submitted' and b.submitted_at > now() - ($2::int * interval '1 millisecond')
             and exists (select 1 from campaign_lead x where x.batch_id = b.id and x.status = 'dispatched') limit 1""", [campaign_id, IN_FLIGHT_MS])
    return bool(r)


async def dispatch_batch(db, campaign_id: str) -> dict:
    """Send the next batch (job `campaign_dispatch`). Checks every rule again at send time."""
    c = await _row(db, campaign_id)
    if c['status'] != 'running':
        return {'skipped': f"campaign is {c['status']}"}
    if not (await get_settings(db))['features']['campaigns']:
        return {'skipped': 'campaigns are off'}
    calling = (await get_business(db))['calling']
    if not in_calling_window(calling):
        return {'skipped': 'outside calling hours'}
    if await _in_flight(db, campaign_id):
        return {'skipped': 'a batch is still in flight'}
    room = min(c['batch_size'], c['daily_cap'] - await _sent_last_day(db, campaign_id))
    if room <= 0:
        return {'skipped': 'daily cap reached'}
    leads = await eligible_leads(db, c, calling, room)
    if not leads:
        await db.query("update campaign set status = 'completed', updated_at = now() where id = $1 and status = 'running'", [campaign_id])
        return {'completed': True}
    integ = await get_integration(db, c['integration_id'])
    if not integ or not integ['enabled']:
        await db.query("update campaign set status = 'paused', stats = stats || $2::jsonb, updated_at = now() where id = $1",
                       [campaign_id, js_json({'lastError': 'The integration is missing or disabled'})])
        return {'paused': 'integration missing or disabled'}
    creds = credentials_of(integ)
    champion = c['champion'] or {'label': 'v1', 'prompt': None}
    challenger = c['challenger'] or None
    cycle_id = challenger.get('cycleId') if challenger else None
    batch_id = new_id('cb')
    entries, assigned = [], []
    for lead in leads:
        arm = assign_arm(lead['id'], cycle_id, c['challenger_share']) if challenger else 'champion'
        label = challenger['label'] if arm == 'challenger' else champion['label']
        prompt = challenger['prompt'] if arm == 'challenger' else None
        build = providers.elevenlabs_recipient if integ['provider'] == 'elevenlabs' else providers.retell_task
        entries.append(build(lead, c, arm, label, prompt))
        assigned.append((lead, arm, label))
    calling_tz = calling.get('timezone')
    try:
        res = await providers.submit_batch(integ['provider'], creds, name=f"{c['name']} · {batch_id}", agent_id=c['agent_external_id'],
                                           from_number=c['from_number'], entries=entries, concurrency=c['concurrency'], timezone=calling_tz)
    except Exception as e:
        msg = getattr(e, 'message', None) or err_msg(e)
        await db.query("insert into campaign_batch (id, campaign_id, status, size, error) values ($1,$2,'failed',$3,$4)", [batch_id, campaign_id, len(entries), msg[:2000]])
        # A rejected batch pauses the campaign instead of retrying every tick; a person fixes and restarts it.
        await db.query("update campaign set status = 'paused', stats = stats || $2::jsonb, updated_at = now() where id = $1", [campaign_id, js_json({'lastError': msg[:500]})])
        log.warn('campaign batch rejected; campaign paused', {'campaign': campaign_id, 'error': msg})
        return {'paused': msg}

    async def record(t) -> None:
        await t.query("insert into campaign_batch (id, campaign_id, provider_batch_id, status, size, detail) values ($1,$2,$3,'submitted',$4,$5::jsonb)",
                      [batch_id, campaign_id, res['providerBatchId'], len(entries), js_json({'response': res['raw'],
                       'arms': {a: sum(1 for _, x, _ in assigned if x == a) for a in ('champion', 'challenger')}})])
        for lead, arm, label in assigned:
            await t.query("insert into campaign_lead (campaign_id, lead_id, batch_id, arm, prompt_version, status) values ($1,$2,$3,$4,$5,'dispatched')",
                          [campaign_id, lead['id'], batch_id, arm, label])

    await db.tx(record)
    for lead, arm, _ in assigned:
        await event(db, lead['id'], 'campaign', {'campaignId': campaign_id, 'batchId': batch_id, 'arm': arm}, 'campaign')
        await advance(db, lead, ('contacted',), note=f"Called in campaign {c['name']}", actor='campaign')
    await refresh_stats(db, campaign_id)
    return {'batchId': batch_id, 'providerBatchId': res['providerBatchId'], 'size': len(entries)}


# ---------- Results ----------

async def arm_stats(db, campaign_id: str) -> dict[str, dict]:
    rows = await db.query(
        """select cl.arm, cl.prompt_version as label, count(*)::int as dispatched,
             count(c.call_id) filter (where c.status = 'scored')::int as scored,
             percentile_cont(0.5) within group (order by c.cqs) filter (where c.status = 'scored') as cqs,
             avg(case when c.gated then 1.0 else 0.0 end) filter (where c.status = 'scored') * 100 as gate,
             avg(case when c.next_step = 'meeting' then 1.0 else 0.0 end) filter (where c.status = 'scored') * 100 as meet,
             avg(case when c.next_step is not null then 1.0 else 0.0 end) filter (where c.status = 'scored') * 100 as ns
           from campaign_lead cl left join calls c on c.call_id = cl.call_id
           where cl.campaign_id = $1 group by cl.arm, cl.prompt_version order by cl.arm, cl.prompt_version""", [campaign_id])
    out: dict[str, dict] = {}
    for r in rows:
        out[f"{r['arm']}:{r['label']}"] = {'arm': r['arm'], 'label': r['label'], 'dispatched': r['dispatched'], 'scored': r['scored'],
                                         'cqs': None if r['cqs'] is None else round(r['cqs'], 1), 'gateRate': None if r['gate'] is None else round(r['gate'], 1),
                                         'meetingRate': None if r['meet'] is None else round(r['meet'], 1), 'nextStepRate': None if r['ns'] is None else round(r['ns'], 1)}
    return out


async def refresh_stats(db, campaign_id: str) -> dict:
    arms = await arm_stats(db, campaign_id)
    totals = await db.one(
        """select count(*)::int as dispatched, count(*) filter (where status = 'called')::int as called, count(*) filter (where status = 'failed')::int as failed,
             count(distinct lead_id)::int as leads from campaign_lead where campaign_id = $1""", [campaign_id])
    stats = {'arms': list(arms.values()), **totals, 'updatedAt': iso(now_ms())}
    await db.query('update campaign set stats = (stats - $3::text[]) || $2::jsonb where id = $1', [campaign_id, js_json(stats), ['arms']])
    return stats


async def on_call_scored(db, call_id: str) -> dict | None:
    """Link a scored call to its campaign lead (dynamic variables campaign_id + lead_id) and refresh the stats."""
    r = await db.one("select lead_id, canonical->'dynamicVariables' as dv from calls where call_id = $1", [call_id])
    dv = (r or {}).get('dv') or {}
    campaign_id = dv.get('campaign_id')
    lead_id = (r or {}).get('lead_id') or dv.get('lead_id')
    if not campaign_id or not lead_id:
        return None
    hit = await db.query(
        """update campaign_lead set call_id = $3, status = 'called' where campaign_id = $1 and lead_id = $2 and batch_id = (
             select batch_id from campaign_lead where campaign_id = $1 and lead_id = $2 and (call_id is null or call_id = $3)
             order by attempted_at desc limit 1) returning batch_id""", [campaign_id, lead_id, call_id])
    if not hit:
        return None
    return await refresh_stats(db, campaign_id)


async def campaign_tick(db) -> dict:
    """Scheduler step for running campaigns: expire unanswered dispatches, queue the next batch when one may go
    out, start an improvement cycle when the champion has enough new calls, and queue verification of a live
    challenger every ten minutes."""
    settings = await get_settings(db)
    if not settings['features']['campaigns']:
        return {'campaigns': 0}
    calling = (await get_business(db))['calling']
    queued = 0
    await db.query("update campaign_lead set status = 'failed' where status = 'dispatched' and attempted_at < now() - ($1::int * interval '1 millisecond')", [IN_FLIGHT_MS])
    rows = await db.query("select * from campaign where status = 'running' order by created_at")
    for c in rows:
        if in_calling_window(calling) and not await _in_flight(db, c['id']) and await _sent_last_day(db, c['id']) < c['daily_cap']:
            if await enqueue(db, 'campaign_dispatch', {'campaignId': c['id']}, dedupe_key=f"campaign:{c['id']}", priority=4, max_attempts=1):
                queued += 1
        mode = effective_mode(c['improvement'], settings['features']['improvement'])
        if mode == 'off':
            continue
        active = await db.one(f"select id, status, verdict from improvement_cycle where campaign_id = $1 and status in ({','.join(repr(s) for s in ACTIVE_CYCLE)}) order by created_at desc limit 1", [c['id']])
        if active:
            if active['status'] == 'live':
                checked = parse_date(((active['verdict'] or {}).get('checkedAt')))
                if not checked or now_ms() - to_ms(checked) > VERIFY_EVERY_MS:
                    await enqueue(db, 'improve_verify', {'cycleId': active['id']}, dedupe_key=f"verify:{active['id']}", priority=3, max_attempts=2)
            continue
        if (c['champion'] or {}).get('prompt') and await new_champion_calls(db, c) >= c['min_calls_per_arm']:
            await enqueue(db, 'improve_cycle', {'campaignId': c['id']}, dedupe_key=f"improve:{c['id']}", priority=3, max_attempts=1)
    return {'campaigns': len(rows), 'queued': queued}


async def new_champion_calls(db, c: dict) -> int:
    """Scored champion-arm calls since the last improvement cycle ended (or since the campaign started)."""
    last = await db.one('select max(coalesce(decided_at, updated_at)) as t from improvement_cycle where campaign_id = $1', [c['id']])
    r = await db.one(
        """select count(*)::int as n from campaign_lead cl join calls x on x.call_id = cl.call_id
           where cl.campaign_id = $1 and cl.arm = 'champion' and x.status = 'scored' and ($2::timestamptz is null or x.scored_at > $2::timestamptz)""",
        [c['id'], (last or {}).get('t')])
    return r['n']


async def list_campaigns(db) -> list[dict]:
    return [to_dto(r) for r in await db.query('select * from campaign order by created_at desc')]


async def campaign_detail(db, id: str) -> dict:
    c = await _row(db, id)
    batches = await db.query('select * from campaign_batch where campaign_id = $1 order by submitted_at desc limit 50', [id])
    cycle = await db.one('select id, status, mode, champion_label, challenger_label, created_at, updated_at from improvement_cycle where campaign_id = $1 order by created_at desc limit 1', [id])
    calling = (await get_business(db))['calling']
    params: list[Any] = []
    conds = await _callable(db, c, calling, params, datetime.now(UTC))
    eligible = await db.one(f"select count(*)::int as n from lead l where {' and '.join(conds)}", params)
    return {
        **to_dto(c),
        'arms': list((await arm_stats(db, id)).values()),
        'eligibleLeads': eligible['n'],
        'inCallingWindow': in_calling_window(calling),
        'batches': [{'id': b['id'], 'providerBatchId': b['provider_batch_id'], 'status': b['status'], 'size': b['size'], 'submittedAt': iso(b['submitted_at']),
                     'arms': (b['detail'] or {}).get('arms'), 'error': b['error']} for b in batches],
        'cycle': None if not cycle else {'id': cycle['id'], 'status': cycle['status'], 'mode': cycle['mode'], 'championLabel': cycle['champion_label'],
                                         'challengerLabel': cycle['challenger_label'], 'createdAt': iso(cycle['created_at']), 'updatedAt': iso(cycle['updated_at'])},
    }
