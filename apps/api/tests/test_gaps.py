# Regression tests for gaps found in the TypeScript service and fixed in the Python one.

import asyncio
import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from calleval.analytics.meta import seed_taxonomy
from calleval.config import reload_config
from calleval.connectors.elevenlabs import normalise_elevenlabs
from calleval.jobs import handlers
from calleval.jobs.queue import claim, enqueue, heartbeat, requeue_stale
from calleval.lib.settings import update_settings
from calleval.pipeline.evaluate import evaluate_call
from calleval.pipeline.ingest import resolve_prompt_version, store_canonical
from calleval.pipeline.judge.heuristic import heuristic
from calleval.pipeline.store import store_evaluation
from calleval.server import build_app

from .fixtures import drain, eleven_labs_conversation, eleven_labs_signature, stub_http

pytestmark = pytest.mark.asyncio(loop_scope='session')


@pytest.fixture(scope='module')
async def client(db):
    await seed_taxonomy(db)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=build_app(db)), base_url='http://test') as c:
        yield c


async def _score(db, conv: dict, *, source: str = 'live') -> str:
    c = normalise_elevenlabs(conv)
    cid = await store_canonical(db, c, conv, integration_id=None, source=source)
    from calleval.lib.settings import get_settings
    r = await evaluate_call(c, call_id=cid, judge=heuristic, settings=await get_settings(db))
    await store_evaluation(db, c, r['evaluation'], r['runs'], r['summary'])
    return cid


async def test_blank_env_values_keep_their_defaults_and_fallbacks(monkeypatch):
    # .env.example copied as is: blank WEB_DIST must not disable the console, blank STT key must fall back.
    monkeypatch.setenv('WEB_DIST', '')
    monkeypatch.setenv('ELEVENLABS_STT_API_KEY', '')
    monkeypatch.setenv('ELEVENLABS_API_KEY', 'xi_real')
    try:
        c = reload_config()
        assert c.web_dist is None
        assert c.stt_api_key == 'xi_real'
    finally:
        monkeypatch.undo()
        reload_config()


async def test_a_job_that_keeps_losing_its_worker_fails_instead_of_looping(db):
    jid = await enqueue(db, 'alerts', {}, dedupe_key='stale-test', max_attempts=2)
    for _ in range(2):
        job = await claim(db, 'w')
        assert job['id'] == jid
        await db.query("update job set locked_at = now() - interval '1 hour' where id = $1", [jid])
        await requeue_stale(db)
    row = await db.one('select status, last_error from job where id = $1', [jid])
    assert row['status'] == 'failed' and 'stopped responding' in row['last_error']


async def test_a_running_job_with_a_heartbeat_is_not_taken_for_lost(db):
    jid = await enqueue(db, 'alerts', {}, dedupe_key='beat-test')
    await claim(db, 'w')
    await db.query("update job set locked_at = now() - interval '20 minutes' where id = $1", [jid])
    await heartbeat(db, jid)
    await requeue_stale(db)
    assert (await db.one('select status from job where id = $1', [jid]))['status'] == 'running'
    await db.query("update job set status = 'done' where id = $1", [jid])


async def test_polling_cursor_does_not_pass_a_call_still_in_progress(db, client, monkeypatch):
    r = await client.post('/api/integrations', json={'provider': 'elevenlabs', 'apiKey': 'xi', 'webhookSecret': 'ws', 'agentIds': ['agent_el_1']})
    iid = r.json()['id']
    now = int(datetime.now(UTC).timestamp())
    stub_http(monkeypatch, [(r'/v1/convai/conversations$', lambda u, req: {'conversations': [
        {'conversation_id': 'long_call', 'start_time_unix_secs': now - 3600, 'status': 'in-progress'},
        {'conversation_id': 'short_call', 'start_time_unix_secs': now - 60, 'status': 'done'},
    ], 'has_more': False, 'next_cursor': None})])
    await handlers.sync_integration(db, {'integrationId': iid})
    row = await db.one('select cursor from integration where id = $1', [iid])
    since = datetime.fromisoformat(row['cursor']['since'].replace('Z', '+00:00'))
    # The next poll (cursor minus the 10-minute overlap) still lists the hour-long call once it ends.
    assert since <= datetime.fromtimestamp(now - 3600, UTC)
    await db.query('delete from job')
    await db.query('update integration set enabled = false where id = $1', [iid])


async def test_a_disabled_integration_acknowledges_webhooks_but_imports_nothing(db, client):
    iid = (await db.one("select id from integration where provider = 'elevenlabs' and not enabled"))['id']
    body = json.dumps({'type': 'post_call_transcription', 'data': eleven_labs_conversation('conv_disabled')})
    r = await client.post(f'/webhooks/elevenlabs/{iid}', content=body, headers={'content-type': 'application/json', 'elevenlabs-signature': eleven_labs_signature('ws', body)})
    assert r.status_code == 200 and r.json()['queued'] is False
    assert not await db.one("select 1 from job where kind = 'ingest_call'")


async def test_treppan_connection_test_reads_without_importing(db, client, monkeypatch):
    r = await client.post('/api/integrations', json={'provider': 'treppan', 'apiKey': 'tok', 'baseUrl': 'https://crm.example.com/api'})
    calls = stub_http(monkeypatch, [(r'/outcomes$', lambda u, req: [{'id': 'o1', 'lead_id': 'L1', 'stage': 'sale', 'occurred_at': '2026-10-20T10:00:00Z'}])])
    t = await client.post(f"/api/integrations/{r.json()['id']}/test")
    assert t.json()['ok'] and '1 outcome' in t.json()['message']
    assert calls and not await db.one("select 1 from lead_outcome where lead_id = 'L1'")


async def test_retention_purges_transcripts_everywhere_and_uploaded_audio(db, tmp_path):
    old = int((datetime.now(UTC) - timedelta(days=60)).timestamp())
    cid = await _score(db, eleven_labs_conversation('conv_old', old))
    f = tmp_path / 'rec.wav'
    f.write_bytes(b'RIFF')
    await db.query("insert into upload (id, filename, path, status, call_id, created_at) values ('upl_x','rec.wav',$1,'stored',$2, now() - interval '60 days')", [str(f), cid])
    await db.query("insert into recommendation (id, scope, kind, title, problem, proposal, evidence, source) values ('rec_x','global','prompt','t','p','x',$1::jsonb,'playbook')",
                   [json.dumps([{'callId': cid, 'turn': 1, 'quote': 'Yes, this is Omar.', 'metric': 'trel'}])])
    await update_settings(db, {'retentionDays': 30})
    r = await handlers.retention(db)
    assert r['purged'] >= 1 and r['files'] == 1 and not f.exists()
    c = await db.one('select raw, canonical, purged_at from calls where call_id = $1', [cid])
    assert c['raw'] is None and c['purged_at'] and c['canonical']['turns'] == [] and c['canonical']['dynamicVariables'] == {} and 'providerAnalysis' not in c['canonical']
    assert (await db.one("select value from call_tag where call_id = $1 and tag_key = 'summary'", [cid]))['value'] is None
    s = await db.one('select fields, context, lowest from call_score where call_id = $1', [cid])
    assert s['fields'] is None and s['context'] is None and all(x['quote'] is None for x in s['lowest'])
    assert (await db.one("select evidence from recommendation where id = 'rec_x'"))['evidence'][0]['quote'] is None
    assert (await db.one("select path, purged_at from upload where id = 'upl_x'"))['path'] is None
    # Scoring a purged call again would replace its real scores with an empty transcript's: it is skipped.
    before = (await db.one('select cqs from calls where call_id = $1', [cid]))['cqs']
    assert (await handlers.evaluate_stored(db, {'callId': cid}))['skipped']
    assert (await db.one('select cqs from calls where call_id = $1', [cid]))['cqs'] == before
    await update_settings(db, {'retentionDays': None})


async def test_answer_key_and_metric_labels_can_be_recorded_for_a_call(db, client):
    cid = await _score(db, eleven_labs_conversation('conv_labels'))
    bad = await client.post(f'/api/calls/{cid}/labels', json={'metrics': {'rl': 50}})
    assert bad.status_code == 400  # code-measured metrics are not labelled
    r = await client.post(f'/api/calls/{cid}/labels', json={'fields': {'budget': '1.5m AED', 'name': 'Omar'}, 'metrics': {'trel': 80}})
    assert r.json() == {'labels': 3, 'reevaluating': True}
    await drain(db)
    m = await db.one("select applicable, raw from metric_result where call_id = $1 and metric_key = 'fca'", [cid])
    assert m['applicable'] and m['raw'] is not None


async def test_a_review_item_cannot_be_resolved_twice(db, client):
    item = await db.one("select id from review_item where status = 'open' limit 1")
    if not item:
        cid = await _score(db, eleven_labs_conversation('conv_rev'))
        await db.query("insert into review_item (id, call_id, kind, tag_key, reason, current_value) values ('rev_x', $1, 'tag', 'persona', 'low', 'P3')", [cid])
        item = {'id': 'rev_x'}
    assert (await client.post(f"/api/review/{item['id']}", json={'value': 'P1'})).status_code == 200
    assert (await client.post(f"/api/review/{item['id']}", json={'value': 'P2'})).status_code == 409


async def test_a_confirmed_gate_is_not_sent_back_for_review_when_rescored(db):
    conv = eleven_labs_conversation('conv_g8')
    conv['transcript'] = [t for t in conv['transcript'] if not any(c['tool_name'] == 'send_documents' for c in t.get('tool_calls') or []) and
                          not any(r['tool_name'] == 'send_documents' for r in t.get('tool_results') or [])]
    conv['transcript'].append({'role': 'agent', 'message': "Done — it's on your WhatsApp now.", 'time_in_call_secs': 40})
    cid = await _score(db, conv)
    gate_item = await db.one("select id, current_value from review_item where call_id = $1 and kind = 'gate'", [cid])
    assert gate_item and 'G8' in gate_item['current_value']
    from calleval.analytics.review import resolve_review
    await resolve_review(db, gate_item['id'], {'gateConfirmed': True})
    await handlers.evaluate_stored(db, {'callId': cid})
    assert not await db.one("select 1 from review_item where call_id = $1 and kind = 'gate' and status = 'open'", [cid])
    assert (await db.one('select gated from calls where call_id = $1', [cid]))['gated'] is True


async def test_concurrent_new_prompt_versions_get_distinct_labels(db):
    agent = 'ag_race'
    calls = [{'promptVersionHint': None, 'agentVersion': f'ver_{i}', 'startedAt': '2026-10-01T00:00:00.000Z'} for i in range(6)]
    labels = await asyncio.gather(*[resolve_prompt_version(db, agent, c, None) for c in calls])
    assert len(set(labels)) == 6


async def test_crm_values_without_digits_are_not_zero(db):
    from calleval.crm.outcomes import upsert_outcomes
    await upsert_outcomes(db, [{'lead_id': 'L_na', 'stage': 'sale', 'occurred_at': '2026-10-01T00:00:00Z', 'value_aed': 'n/a'}])
    assert (await db.one("select value_aed from lead_outcome where lead_id = 'L_na'"))['value_aed'] is None


async def test_call_list_ignores_a_non_numeric_limit(client):
    r = await client.get('/api/calls?limit=abc&offset=x')
    assert r.status_code == 200


async def test_version_report_intervals_are_stable_between_requests(client):
    a = (await client.get('/api/version-report')).json()
    b = (await client.get('/api/version-report')).json()
    assert a == b

