# What each job does. Every handler is idempotent: re-running a job after a crash or a retry
# re-fetches, re-scores and replaces, never duplicates.

from __future__ import annotations

from datetime import timedelta
from pathlib import Path
from typing import Any

import httpx

from .. import billing, taxonomy
from ..alerts.engine import gate_alert, run_alert_rules
from ..analytics.clusters import run_clusters
from ..analytics.review import human_overrides
from ..campaigns import engine as campaign_engine
from ..improve import loop as improve_loop
from ..config import config, llm_enabled
from ..connectors.registry import CONNECTORS, credentials_of, get_integration, list_integrations
from ..connectors.upload import upload_to_canonical
from ..crm.leads import after_call
from ..crm.outcomes import attribute, pull_crm
from ..leadfinder import apollo
from ..demo.seed import seed_demo
from ..js import iso, js_json, now_ms, parse_date, to_ms, utc_from_ms
from ..lib.log import err_msg, log
from ..lib.settings import get_settings
from ..pipeline.audio import analyse_audio
from ..pipeline.evaluate import evaluate_call
from ..pipeline.ingest import fetch_agent_cached, store_canonical
from ..pipeline.judge.heuristic import heuristic
from ..pipeline.judge.llm import claude
from ..pipeline.store import store_evaluation
from ..recommendations.engine import generate_recommendations
from .queue import enqueue

PAGES_PER_RUN = 20
STALE_IN_PROGRESS_MS = 6 * 3600_000


async def sync_integration(db, p: dict[str, Any]) -> dict:
    row = await get_integration(db, p['integrationId'])
    if not row or not row['enabled'] or row['provider'] not in CONNECTORS:
        return {'skipped': True}
    conn = CONNECTORS[row['provider']]
    creds = credentials_of(row)
    if not creds['apiKey']:
        raise RuntimeError('No API key configured for this integration')
    overlap = 10 * 60_000
    cursor_since = (row.get('cursor') or {}).get('since')
    if p.get('since'):
        since = parse_date(p['since'])
    elif cursor_since:
        since = parse_date(cursor_since) - timedelta(milliseconds=overlap)
    else:
        since = utc_from_ms(now_ms() - 30 * 86_400_000)
    agents: list[str | None] = creds['agentIds'] or [None]
    ai = p.get('agentIndex') or 0
    cursor = p.get('cursor')
    max_seen = parse_date(p['maxSeen']) if p.get('maxSeen') else None
    # A call still in progress must be listed again once it ends, so the cursor never moves past the
    # earliest one (calls running for more than STALE_IN_PROGRESS are taken as stuck and ignored).
    open_since = parse_date(p['openSince']) if p.get('openSince') else None
    queued = pages = 0
    try:
        while ai < len(agents):
            page = await conn.list_calls(creds, since=since, cursor=cursor, agent_id=agents[ai])
            pages += 1
            for c in page['calls']:
                started = parse_date(c.get('startedAt'))
                if started and (not max_seen or started > max_seen):
                    max_seen = started
                if not c['complete']:
                    if started and now_ms() - to_ms(started) < STALE_IN_PROGRESS_MS and (not open_since or started < open_since):
                        open_since = started
                    continue
                have = await db.one('select status from calls where provider = $1 and external_id = $2', [row['provider'], c['externalId']])
                if have and have['status'] == 'scored':
                    continue
                if await enqueue(db, 'ingest_call', {'integrationId': row['id'], 'externalId': c['externalId']}, dedupe_key=f"ingest:{row['provider']}:{c['externalId']}"):
                    queued += 1
            if page['done']:
                ai += 1
                cursor = None
            else:
                cursor = page['cursor']
            if pages >= PAGES_PER_RUN and ai < len(agents):
                await enqueue(db, 'sync_integration', {'integrationId': row['id'], 'since': iso(since), 'agentIndex': ai, 'cursor': cursor, 'maxSeen': iso(max_seen),
                                                       'openSince': iso(open_since)},
                              dedupe_key=f"sync-cont:{row['id']}:{ai}:{cursor}")
                break
        done = ai >= len(agents)
        prev = parse_date(cursor_since) if cursor_since else None
        reach = min(max_seen, open_since) if max_seen and open_since else max_seen
        new_since = iso(reach) if done and reach and (not prev or reach > prev) else cursor_since
        await db.query("update integration set last_sync_at = now(), last_sync_status = $2, last_error = null, cursor = $3::jsonb, updated_at = now() where id = $1",
                       [row['id'], f"ok · {queued} new call{'' if queued == 1 else 's'} queued{'' if done else ' (continuing)'}", js_json({'since': new_since})])
        return {'queued': queued, 'pages': pages}
    except Exception as e:
        await db.query("update integration set last_sync_at = now(), last_sync_status = 'error', last_error = $2, updated_at = now() where id = $1", [row['id'], err_msg(e)[:500]])
        raise


async def ingest_call(db, p: dict[str, Any]) -> dict:
    row = await get_integration(db, p['integrationId'])
    if not row or row['provider'] not in CONNECTORS:
        raise RuntimeError('Integration not found')
    conn = CONNECTORS[row['provider']]
    creds = credentials_of(row)
    fetched = {'canonical': conn.normalise(p['raw']), 'raw': p['raw']} if p.get('raw') else await conn.fetch_call(creds, p['externalId'])
    c = fetched['canonical']
    info = None
    if c.get('agentExternalId') and creds['apiKey']:
        info = await fetch_agent_cached(f"{row['provider']}:{c['agentExternalId']}:{c.get('agentVersion') or ''}",
                                        lambda: conn.fetch_agent(creds, c['agentExternalId'], c.get('agentVersion')))
    call_id = await store_canonical(db, c, fetched['raw'], integration_id=row['id'], source='live', agent_info=info)
    await db.query('update integration set calls_imported = (select count(*) from calls where integration_id = $1) where id = $1', [row['id']])
    await enqueue(db, 'evaluate_call', {'callId': call_id}, dedupe_key=f'eval:{call_id}')
    return {'callId': call_id}


async def evaluate_stored(db, p: dict[str, Any]) -> dict:
    row = await db.one('select canonical, integration_id, source, lead_id, purged_at from calls where call_id = $1', [p['callId']])
    if not row or not row['canonical']:
        raise RuntimeError(f"Call {p['callId']} not found")
    if row['purged_at']:
        # Retention removed the transcript; scoring it again would replace real scores with an empty call.
        return {'skipped': 'transcript purged by retention'}
    allowed, why = await billing.can_score(db)
    if not allowed:
        # Kept, not lost: scored once credit or the plan allows (billing.release_waiting).
        await db.query("update calls set status = 'waiting', error = $2, updated_at = now() where call_id = $1", [p['callId'], why])
        return {'waiting': why}
    await db.query("update calls set status = 'evaluating', updated_at = now() where call_id = $1", [p['callId']])
    try:
        settings = await get_settings(db)
        # Demo calls always use the heuristic judge so seeding never spends API credit.
        judge = heuristic if p.get('judge') == 'heuristic' or row['source'] == 'demo' or not llm_enabled() else claude
        audio = None
        canonical = row['canonical']
        if config.audio_model_url and (canonical.get('recording') or {}).get('available'):
            audio = await analyse_audio(canonical, await _recording(db, p['callId'], row))
        integ = await get_integration(db, row['integration_id']) if row['integration_id'] else None
        res = await evaluate_call(canonical, call_id=p['callId'], judge=judge, settings=settings, audio=audio,
                                  human=await human_overrides(db, p['callId']), tool_aliases=((integ or {}).get('config') or {}).get('toolAliases'))
        await store_evaluation(db, canonical, res['evaluation'], res['runs'], res['summary'])
        await billing.record_scored_call(db, p['callId'])
        await campaign_engine.on_call_scored(db, p['callId'])
        if any(g['failed'] for g in res['evaluation']['gates']):
            await gate_alert(db, p['callId'])
        if row['lead_id']:
            await attribute(db, [row['lead_id']])
            await after_call(db, p['callId'])
        return {'cqs': res['evaluation']['cqs'], 'judge': res['evaluation']['judgeMode']}
    except Exception as e:
        await db.query("update calls set status = 'failed', error = $2, updated_at = now() where call_id = $1", [p['callId'], err_msg(e)[:1000]])
        raise


async def _recording(db, call_id: str, row: dict) -> httpx.Response | None:
    """The call's audio: the uploaded file on disk, or the provider's recording."""
    canonical = row['canonical']
    if row['source'] == 'upload':
        u = await db.one('select mime, path from upload where call_id = $1 order by created_at desc limit 1', [call_id])
        path = Path(u['path']) if u and u['path'] else None
        if path and path.is_file():
            return httpx.Response(200, content=path.read_bytes(), headers={'content-type': u['mime'] or 'application/octet-stream'})
        return None
    if not row['integration_id']:
        return None
    integ = await get_integration(db, row['integration_id'])
    conn = CONNECTORS.get(integ['provider']) if integ else None
    if not integ or not conn:
        return None
    try:
        return await conn.fetch_audio(credentials_of(integ), canonical)
    except Exception:
        return None


async def transcribe_upload(db, p: dict[str, Any]) -> dict:
    u = await db.one('select * from upload where id = $1', [p['uploadId']])
    if not u:
        raise RuntimeError('Upload not found')
    await db.query("update upload set status = 'transcribing' where id = $1", [u['id']])
    try:
        m = u.get('meta') or {}
        meta = {'uploadId': u['id'], 'filename': u['filename'], 'filePath': u['path'], 'mime': u['mime'], 'direction': m.get('direction') or 'unknown',
                'promptVersion': m.get('promptVersion'), 'layout': 'cl' if m.get('layout') == 'cl' else 'al', 'channels': m.get('channels'),
                'conversationId': m.get('conversationId'), 'startedAt': m.get('startedAt') or iso(u['created_at'])}
        c = await upload_to_canonical(meta)
        call_id = await store_canonical(db, c, None, integration_id=None, source='upload', keep_raw=False)
        await db.query("update upload set status = 'stored', call_id = $2 where id = $1", [u['id'], call_id])
        await enqueue(db, 'evaluate_call', {'callId': call_id}, dedupe_key=f'eval:{call_id}')
        return {'callId': call_id}
    except Exception as e:
        await db.query("update upload set status = 'failed', meta = meta || $2::jsonb where id = $1", [u['id'], js_json({'error': err_msg(e)})])
        raise


async def crm_sync(db) -> dict:
    total = 0
    for row in [r for r in await list_integrations(db) if r['provider'] == 'treppan' and r['enabled']]:
        creds = credentials_of(row)
        if not creds['baseUrl']:
            continue
        try:
            since = row['last_sync_at'] - timedelta(days=1) if row['last_sync_at'] else None
            r = await pull_crm(db, creds['baseUrl'], creds['apiKey'], since)
            total += r['imported']
            await db.query('update integration set last_sync_at = now(), last_sync_status = $2, last_error = null where id = $1', [row['id'], f"ok · {r['imported']} outcomes"])
        except Exception as e:
            await db.query("update integration set last_sync_at = now(), last_sync_status = 'error', last_error = $2 where id = $1", [row['id'], err_msg(e)])
    return {'imported': total, 'credited': await attribute(db)}


async def retention(db) -> dict:
    """Past the retention window, remove what was said and who said it; keep scores, tags and outcomes.
    Covers every place transcript text or personal data was copied: the raw payload, the canonical call
    (turns, tool calls, numbers, dynamic variables, provider analysis), captured fields and context,
    quotes in lowest metrics, coaching, gate details and recommendation evidence, metric rationales,
    tool span payloads, judge outputs, the summary tag, and uploaded audio files."""
    s = await get_settings(db)
    if not s['retentionDays']:
        return {'purged': 0}

    async def purge(t) -> list[str]:
        ids = [r['call_id'] for r in await t.query(
            """update calls set raw = null, recording_url = null, purged_at = now(), updated_at = now(),
                 canonical = jsonb_set(jsonb_set(canonical - 'providerAnalysis' - 'fromNumber' - 'toNumber', '{turns}', '[]'::jsonb), '{toolCalls}', '[]'::jsonb)
                             || '{"dynamicVariables": {}}'::jsonb
               where started_at < now() - ($1::int * interval '1 day') and purged_at is null returning call_id""",
            [s['retentionDays']])]
        if not ids:
            return ids
        await t.query("update call_tag set value = null where call_id = any($1::text[]) and tag_key = 'summary'", [ids])
        await t.query('update metric_result set rationale = null where call_id = any($1::text[])', [ids])
        await t.query('update trace_span set meta = null where call_id = any($1::text[])', [ids])
        await t.query('update eval_run set output = null where call_id = any($1::text[])', [ids])
        await t.query(
            """update call_score set fields = null, context = null,
                 lowest = (select coalesce(jsonb_agg(x || '{"quote": null, "why": null}'::jsonb), '[]'::jsonb) from jsonb_array_elements(coalesce(lowest, '[]'::jsonb)) x),
                 coaching = (select coalesce(jsonb_agg(x || '{"detail": ""}'::jsonb), '[]'::jsonb) from jsonb_array_elements(coalesce(coaching, '[]'::jsonb)) x),
                 gates = (select coalesce(jsonb_agg(x || '{"detail": null}'::jsonb), '[]'::jsonb) from jsonb_array_elements(coalesce(gates, '[]'::jsonb)) x)
               where call_id = any($1::text[])""", [ids])
        await t.query(
            """update recommendation set evidence = (
                 select coalesce(jsonb_agg(case when e->>'callId' = any($1::text[]) then e || '{"quote": null}'::jsonb else e end), '[]'::jsonb)
                 from jsonb_array_elements(evidence) e)
               where exists (select 1 from jsonb_array_elements(evidence) e where e->>'callId' = any($1::text[]))""", [ids])
        return ids

    ids = await db.tx(purge)
    files = 0
    uploads = await db.query(
        """select id, path from upload where purged_at is null
             and (call_id = any($1::text[]) or (call_id is null and created_at < now() - ($2::int * interval '1 day')))""",
        [ids, s['retentionDays']])
    for u in uploads:
        if u['path']:
            try:
                Path(u['path']).unlink(missing_ok=True)
                files += 1
            except OSError as e:
                log.warn('could not delete uploaded recording', {'upload': u['id'], 'error': err_msg(e)})
                continue
        await db.query("update upload set path = null, purged_at = now(), meta = meta - 'conversationId' where id = $1", [u['id']])
    return {'purged': len(ids), 'files': files}


async def run_job(db, job: dict) -> Any:
    p = job.get('payload') or {}
    kind = job['kind']
    await taxonomy.refresh(db)  # classify and label with the version active now
    if kind == 'sync_integration':
        return await sync_integration(db, p)
    if kind == 'ingest_call':
        return await ingest_call(db, p)
    if kind == 'evaluate_call':
        return await evaluate_stored(db, p)
    if kind == 'transcribe_upload':
        return await transcribe_upload(db, p)
    if kind == 'crm_sync':
        return await crm_sync(db)
    if kind == 'alerts':
        return await run_alert_rules(db, int(p.get('lookbackDays') or 2))
    if kind == 'recommendations':
        return await generate_recommendations(db, range_days=int(p.get('rangeDays') or 30), agent=p.get('agent') or 'all', use_llm=p.get('useLlm') is not False)
    if kind == 'clusters':
        return await run_clusters(db)
    if kind == 'retention':
        return await retention(db)
    if kind == 'demo_seed':
        return await seed_demo(db, count=int(p.get('count') or 5000), days=int(p.get('days') or 90))
    if kind == 'lead_search':
        return await apollo.run_search(db, max_leads=int(p.get('max') or 100), filters=p.get('filters'))
    if kind == 'lead_enrich':
        return await apollo.run_enrich(db, lead_ids=p.get('leadIds'), credit_cap=int(p.get('creditCap') or 100), reveal_phone=p.get('revealPhone') is not False)
    if kind == 'campaign_dispatch':
        return await campaign_engine.dispatch_batch(db, p['campaignId'])
    if kind == 'improve_cycle':
        return await improve_loop.run_cycle(db, p['campaignId'], requested_by=p.get('requestedBy') or 'scheduler')
    if kind == 'improve_verify':
        return await improve_loop.verify(db, p['cycleId'])
    log.warn('unknown job kind', {'kind': kind})
    return None
