# HTTP API: the console's REST endpoints, signed provider webhooks, uploads, and the built console.

from __future__ import annotations

import json
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import quote

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.base import BaseHTTPMiddleware

from . import taxonomy
from .auth import audit, authorize, client_ip, resolve
from .alerts.engine import ack_alert, list_alerts
from .analytics.calls import call_detail, list_calls
from .analytics.funnel import funnel
from .analytics.matrix import cell_detail, fix_map, matrix
from .analytics.meta import meta
from .analytics.recordings import recordings
from .analytics.review import list_review, resolve_review
from .analytics.taxonomy import taxonomy_health
from .analytics.traces import traces
from .analytics.version import version_report
from .config import config
from .connectors.registry import CONNECTORS, credentials_of, get_integration, list_integrations, save_integration, to_dto
from .crm.outcomes import parse_csv, upsert_outcomes
from .db import Db
from .jobs.queue import enqueue, enqueue_or_existing, list_jobs
from .js import iso, js_json, js_number, now_ms, utc_from_ms
from .lib.http import get_json
from .lib.errors import HttpStatusError, http_error
from .lib.ids import new_id
from .lib.log import err_msg, log
from .lib.settings import get_settings, update_settings
from .recommendations.engine import list_recommendations, update_recommendation
from .routes_campaigns import router as campaigns_router
from .routes_crm import router as crm_router
from .routes_auth import router as auth_router
from .routes_billing import router as billing_router
from .routes_compliance import router as compliance_router
from .routes_taxonomy import router as taxonomy_router
from .tenancy import DEFAULT_WORKSPACE, in_workspace, reset_workspace, set_workspace
from .web import J, JsResponse, body_json, body_text, q

UPLOAD_LIMIT = 300 * 1024 * 1024


SAFE_METHODS = ('GET', 'HEAD', 'OPTIONS')
PUBLIC_PATHS = ('/api/auth/status', '/api/auth/setup', '/api/auth/login', '/api/auth/signup', '/api/auth/verify', '/api/auth/resend', '/api/auth/forgot')
# Routes that write their own, more detailed audit events.
SELF_AUDITED = ('POST /api/auth/login', 'POST /api/auth/setup', 'POST /api/auth/invites/{token}/accept', 'POST /api/auth/logout', 'POST /api/auth/signup',
                'POST /api/auth/verify', 'POST /api/auth/resend', 'POST /api/auth/forgot')


def _api_path(path: str) -> bool:
    p = re.sub('/+', '/', path)
    return p == '/api' or p.startswith('/api/')


def build_app(db: Db | None = None, *, lifespan: Any = None) -> FastAPI:
    # Every route checks the permission auth/policy.py gives it.
    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None, default_response_class=JsResponse,
                  dependencies=[Depends(authorize)])
    app.state.db = db

    def D() -> Db:
        return app.state.db

    async def auth(request: Request, call_next):
        # The decoded path decides, so an encoded form such as /%61pi/… cannot skip the check.
        path = re.sub('/+', '/', request.scope['path'])
        if request.method == 'OPTIONS' or not _api_path(path) or D() is None:
            return await call_next(request)
        sys_db = D().as_system()
        p = await resolve(sys_db, request)
        request.state.principal = p
        public = path in PUBLIC_PATHS or path.startswith('/api/auth/invites/')
        if p is None and not public:
            return J({'error': 'Unauthorized', 'message': 'Sign in, or set Authorization: Bearer <token>.'}, 401)
        # A change made with a session cookie must come from the console: a cross-site form can't add this header.
        if request.method not in SAFE_METHODS and (p is None or p.via == 'session') and request.headers.get('x-calleval-client') != 'console':
            return J({'error': 'Forbidden', 'message': 'Changes made with a session need the X-CallEval-Client header.'}, 403)
        # The rest of the request runs in the caller's workspace (row-level security in the database).
        token = set_workspace(p.workspace_id if p else None)
        try:
            if p is not None:
                # Another process (a worker, another replica) may have activated a taxonomy version.
                await taxonomy.refresh(D())
            response = await call_next(request)
        finally:
            reset_workspace(token)
        action = getattr(request.state, 'action', None) or f'{request.method} {path}'
        if request.method not in SAFE_METHODS and action not in SELF_AUDITED:
            await audit(sys_db, p, action, target=path, status=response.status_code, ip=client_ip(request))
        return response

    # CORS wraps the token check, so browser preflights are answered without a token.
    app.add_middleware(BaseHTTPMiddleware, dispatch=auth)
    app.add_middleware(CORSMiddleware, allow_origin_regex='.*', allow_methods=['*'], allow_headers=['*'])

    @app.exception_handler(HttpStatusError)
    async def on_status_error(request: Request, e: HttpStatusError):
        code = e.status_code if e.status_code >= 400 else 500
        if code >= 500:
            log.error('request failed', {'url': str(request.url.path), 'error': e.message})
        return J({'error': 'Internal error' if code >= 500 else 'Bad request', 'message': e.message}, code)

    @app.exception_handler(StarletteHTTPException)
    async def on_http_error(request: Request, e: StarletteHTTPException):
        if e.status_code == 404:
            return J({'error': 'Not found', 'message': f'Route {request.method}:{request.url.path} not found'}, 404)
        return J({'error': 'Bad request', 'message': str(e.detail)}, e.status_code)

    @app.exception_handler(Exception)
    async def on_error(request: Request, e: Exception):
        log.error('request failed', {'url': str(request.url.path), 'error': err_msg(e)})
        return J({'error': 'Internal error', 'message': err_msg(e)}, 500)

    @app.get('/healthz')
    async def healthz():
        await D().as_system().one('select 1 as ok')  # no workspace: a load balancer is asking
        return J({'ok': True})

    # ---------- Reference ----------
    @app.get('/api/meta')
    async def get_meta(req: Request):
        return J({**await meta(D()), 'me': req.state.principal.dto()})

    @app.get('/api/settings')
    async def get_settings_route():
        return J(await get_settings(D()))

    @app.put('/api/settings')
    async def put_settings(req: Request):
        b = await body_json(req)
        return J(await update_settings(D(), b if isinstance(b, dict) else {}))

    # ---------- Technical view ----------
    @app.get('/api/matrix')
    async def get_matrix(req: Request):
        return J(await matrix(D(), q(req)))

    @app.get('/api/cells/{pid}/{sid}')
    async def get_cell(pid: str, sid: str, req: Request):
        r = await cell_detail(D(), pid, sid, q(req))
        if not r:
            raise http_error(404, 'No calls in this cell for the current filters')
        # Sample calls carry summaries; a role without "Read calls" sees the cell's figures only.
        return J(r if req.state.principal.can('calls:read') else {**r, 'calls': []})

    @app.get('/api/calls')
    async def get_calls(req: Request):
        return J(await list_calls(D(), q(req)))

    @app.get('/api/calls/{id}')
    async def get_call(id: str):
        r = await call_detail(D(), id)
        if not r:
            raise http_error(404, 'Call not found')
        return J(r)

    @app.get('/api/calls/{id}/audio')
    async def get_audio(id: str):
        row = await D().one('select canonical, integration_id, source, recording_url from calls where call_id = $1', [id])
        if not row:
            raise http_error(404, 'Call not found')
        rec = ((row['canonical'] or {}).get('recording') or {})
        if row['source'] == 'upload' and rec.get('url') and Path(rec['url']).is_file():
            u = await D().one('select mime from upload where call_id = $1 order by created_at desc limit 1', [id])
            return FileResponse(rec['url'], media_type=(u or {}).get('mime') or 'audio/mpeg')
        integ = await get_integration(D(), row['integration_id']) if row['integration_id'] else None
        conn = CONNECTORS.get(integ['provider']) if integ else None
        if not integ or not conn:
            raise http_error(404, 'No recording available for this call')
        res = await conn.fetch_audio(credentials_of(integ), row['canonical'])
        if res is None:
            raise http_error(404, 'No recording available for this call')
        return Response(res.content, media_type=res.headers.get('content-type') or 'audio/mpeg')

    @app.post('/api/calls/{id}/reevaluate')
    async def reevaluate(id: str):
        job_id = await enqueue_or_existing(D(), 'evaluate_call', {'callId': id, 'reason': 'manual'}, dedupe_key=f'eval:{id}', priority=5)
        return J({'jobId': job_id, 'queued': bool(job_id)})

    @app.post('/api/calls/{id}/labels')
    async def label_call(id: str, req: Request):
        """A reviewer's answer key and metric scores for one call: `fields` ({budget: '2m AED', …}) is the answer key
        Field capture accuracy is measured against (the call is re-scored); `metrics` ({rga: 80, …}, 0–100) feeds
        judge-vs-reviewer agreement in Taxonomy health."""
        from .framework import FIELD_LABELS
        from .pipeline.judge.types import JUDGED_METRICS
        b = await body_json(req) or {}
        if not await D().one('select 1 from calls where call_id = $1', [id]):
            raise http_error(404, 'Call not found')
        fields, metrics = b.get('fields') or {}, b.get('metrics') or {}
        if not isinstance(fields, dict) or not isinstance(metrics, dict):
            raise http_error(400, 'fields and metrics must be objects')
        judged = {m['key'] for m in JUDGED_METRICS}
        rows: list[tuple[str, str]] = []
        for k, v in fields.items():
            if k not in FIELD_LABELS or k == 'persona':
                raise http_error(400, f'Unknown field: {k}')
            rows.append((f'field:{k}', '' if v is None else str(v)))
        for k, v in metrics.items():
            n = js_number(v)
            if k not in judged or not isinstance(n, (int, float)) or not 0 <= n <= 100:
                raise http_error(400, f'Metric labels take a judged metric key and a score from 0 to 100: {k}')
            rows.append((f'metric:{k}', js_json(n)))
        reviewer = _reviewer(req, b)
        for key, value in rows:
            await D().query('insert into review_label (id, call_id, reviewer, key, value) values ($1,$2,$3,$4,$5)', [new_id('lbl'), id, reviewer, key, value])
        job_id = await enqueue_or_existing(D(), 'evaluate_call', {'callId': id, 'reason': 'answer key'}, dedupe_key=f'eval:{id}', priority=5) if fields else None
        return J({'labels': len(rows), 'reevaluating': bool(job_id)})

    @app.get('/api/version-report')
    async def get_version_report(req: Request):
        return J(await version_report(D(), q(req)))

    @app.get('/api/traces')
    async def get_traces(req: Request):
        return J(await traces(D(), q(req)))

    # ---------- Business view ----------
    @app.get('/api/funnel')
    async def get_funnel(req: Request):
        return J(await funnel(D(), q(req)))

    @app.get('/api/fix')
    async def get_fix(req: Request):
        return J(await fix_map(D(), q(req)))

    # ---------- Improvement ----------
    @app.get('/api/recommendations')
    async def get_recs(req: Request):
        p = q(req)
        return J(await list_recommendations(D(), status=p.get('status') or 'all', scope=p.get('scope') or None, kind=p.get('kind') or None,
                                            scope_key=p.get('scopeKey') or None))

    @app.post('/api/recommendations/generate')
    async def gen_recs(req: Request):
        b = await body_json(req) or {}
        job_id = await enqueue_or_existing(D(), 'recommendations', {'rangeDays': b.get('rangeDays') or 30, 'agent': b.get('agent') or 'all', 'useLlm': b.get('useLlm') is not False},
                                           dedupe_key='recommendations', priority=3)
        return J({'jobId': job_id})

    @app.patch('/api/recommendations/{id}')
    async def patch_rec(id: str, req: Request):
        return J(await update_recommendation(D(), id, await body_json(req) or {}))

    @app.get('/api/attention-items')
    async def get_attention():
        rows = await D().query('select key, owner, status from attention_item')
        return J({r['key']: {'owner': r['owner'] or 'none', 'status': r['status'] or 'open'} for r in rows})

    @app.put('/api/attention-items/{key}')
    async def put_attention(key: str, req: Request):
        b = await body_json(req) or {}
        await D().query(
            """insert into attention_item (key, owner, status, note, updated_at) values ($1, $2, $3, $4, now())
               on conflict (workspace_id, key) do update set owner = coalesce($2, attention_item.owner), status = coalesce($3, attention_item.status), note = coalesce($4, attention_item.note), updated_at = now()""",
            [key, b.get('owner'), b.get('status'), b.get('note')],
        )
        return J({'ok': True})

    # ---------- Governance ----------
    @app.get('/api/taxonomy/health')
    async def get_taxonomy():
        return J(await taxonomy_health(D()))

    @app.post('/api/taxonomy/clusters/run')
    async def run_clusters_route():
        return J({'jobId': await enqueue_or_existing(D(), 'clusters', {}, dedupe_key='clusters', priority=3)})

    @app.post('/api/taxonomy/clusters/{id}/propose')
    async def propose_cluster(id: str, req: Request):
        proposed = (await body_json(req) or {}).get('proposed') is not False
        await D().query('update cluster set proposed = $2 where id = $1', [id, proposed])
        return J({'proposed': proposed})

    @app.get('/api/alerts')
    async def get_alerts(req: Request):
        p = q(req)
        return J(await list_alerts(D(), p.get('status') or 'open', p['rule'] if p.get('rule') and p['rule'] != 'all' else None))

    @app.post('/api/alerts/{id}/ack')
    async def ack(id: str, req: Request):
        return J(await ack_alert(D(), id, (await body_json(req) or {}).get('acked') is not False))

    @app.get('/api/review')
    async def get_review(req: Request):
        p = q(req)
        return J(await list_review(D(), status=p.get('status') or 'open', kind=p.get('kind') or None))

    @app.post('/api/review/{id}')
    async def post_review(id: str, req: Request):
        b = await body_json(req) or {}
        return J(await resolve_review(D(), id, b, reviewer=_reviewer(req, b)))

    # ---------- Data in ----------
    @app.get('/api/integrations')
    async def get_integrations():
        return J([to_dto(r) for r in await list_integrations(D())])

    @app.post('/api/integrations')
    async def post_integration(req: Request):
        return J(to_dto(await save_integration(D(), None, await body_json(req) or {})))

    @app.patch('/api/integrations/{id}')
    async def patch_integration(id: str, req: Request):
        return J(to_dto(await save_integration(D(), id, await body_json(req) or {})))

    @app.delete('/api/integrations/{id}')
    async def delete_integration(id: str):
        await D().query('delete from integration where id = $1', [id])
        return J({'ok': True})

    @app.post('/api/integrations/{id}/test')
    async def test_integration(id: str):
        row = await get_integration(D(), id)
        if not row:
            raise http_error(404, 'Integration not found')
        creds = credentials_of(row)
        try:
            if row['provider'] == 'apollo':
                from .business import apollo_search_params, get_business
                from .leadfinder.apollo import search_people
                filters = apollo_search_params(await get_business(D()))
                body = await search_people({'apiKey': creds['apiKey'], 'baseUrl': creds['baseUrl'] or 'https://api.apollo.io/api/v1'}, filters, 1, 1)
                n = body.get('total_entries') or 0
                what = 'people match the ideal customer profile' if filters else 'people found (fill in the ideal customer profile under Business setup to narrow this)'
                return J({'ok': True, 'message': f"Connected; {n:,} {what}."})
            if row['provider'] == 'treppan':
                # A connection test reads only; importing happens on sync.
                since = iso(utc_from_ms(now_ms() - 86_400_000))
                body = await get_json(f"{(creds['baseUrl'] or '').rstrip('/')}/outcomes?since={quote(since)}", {'authorization': f"Bearer {creds['apiKey']}"} if creds['apiKey'] else {})
                n = len(body if isinstance(body, list) else (body or {}).get('items') or [])
                return J({'ok': True, 'message': f"Connected; {n} outcome{'' if n == 1 else 's'} in the last day."})
            agents = await CONNECTORS[row['provider']].list_agents(creds)
            missing = [a for a in creds['agentIds'] if not any(x['id'] == a for x in agents)]
            n = len(agents)
            return J({'ok': True, 'message': f"Connected. {n} agent{'' if n == 1 else 's'} visible{'; not found: ' + ', '.join(missing) if missing else ''}.", 'agents': agents})
        except Exception as e:
            return J({'ok': False, 'message': err_msg(e)})

    @app.post('/api/integrations/{id}/sync')
    async def sync(id: str, req: Request):
        since = (await body_json(req) or {}).get('since')
        row = await get_integration(D(), id)
        if not row:
            raise http_error(404, 'Integration not found')
        if row['provider'] == 'apollo':
            raise http_error(400, 'Apollo finds leads from the CRM page (Find leads), not by sync.')
        kind = 'crm_sync' if row['provider'] == 'treppan' else 'sync_integration'
        payload = {} if kind == 'crm_sync' else {'integrationId': id, **({'since': since} if since else {})}
        job_id = await enqueue_or_existing(D(), kind, payload, dedupe_key=f'backfill:{id}:{since}' if since else f'sync:{id}', priority=4)
        return J({'jobId': job_id})

    @app.get('/api/recordings')
    async def get_recordings(req: Request):
        return J(await recordings(D(), q(req).get('group') or None))

    @app.post('/api/uploads')
    async def upload(req: Request):
        form = await req.form(max_files=1, max_part_size=1024 * 1024)
        file = next((v for v in form.values() if hasattr(v, 'filename') and hasattr(v, 'read')), None)
        if file is None:
            raise http_error(400, 'No file uploaded')
        fields = {k: v for k, v in form.items() if isinstance(v, str)}
        if str(fields.get('consent')) != 'true':
            raise http_error(400, 'Confirm that the recording notice covers transcript, classifier and audio analysis.')
        if not config.stt_api_key:
            raise http_error(400, 'Uploads are transcribed with ElevenLabs Speech-to-Text; set ELEVENLABS_API_KEY (or ELEVENLABS_STT_API_KEY) first.')
        Path(config.upload_dir).mkdir(parents=True, exist_ok=True)
        uid = new_id('upl')
        safe = re.sub(r'[^\w.-]+', '_', str(file.filename or 'recording'), flags=re.ASCII)[-120:]
        dest = Path(config.upload_dir).resolve() / f'{uid}-{safe}'
        size = 0
        with dest.open('wb') as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > UPLOAD_LIMIT:
                    out.close()
                    dest.unlink(missing_ok=True)
                    raise http_error(413, 'The recording is larger than 300 MB.')
                out.write(chunk)
        layout = fields.get('layout')
        channels = 1 if layout == 'mono' else (int(js_number(fields.get('channels'))) if js_number(fields.get('channels')) else None)
        meta_ = {
            'direction': 'outbound' if fields.get('dir') == 'out' else 'inbound' if fields.get('dir') == 'in' else 'unknown',
            'promptVersion': fields['prompt'] if fields.get('prompt') and fields['prompt'] != 'unknown' else None,
            'layout': 'cl' if layout == 'cl' else 'al', 'channels': channels, 'duration': js_number(fields.get('duration')) or None,
            'sampleRate': js_number(fields.get('sampleRate')) or None, 'conversationId': fields.get('conv') or None,
        }
        await D().query("insert into upload (id, filename, size_bytes, mime, path, status, meta) values ($1,$2,$3,$4,$5,'received',$6::jsonb)",
                        [uid, file.filename, size, file.content_type, str(dest), js_json(meta_)])
        await enqueue(D(), 'transcribe_upload', {'uploadId': uid}, dedupe_key=f'upload:{uid}', priority=4)
        return J({'id': uid, 'callId': None, 'status': 'queued'})

    @app.post('/api/crm/outcomes')
    async def post_outcomes(req: Request):
        b = await body_json(req)
        items = b if isinstance(b, list) else (b or {}).get('items') or []
        return J(await upsert_outcomes(D(), items, 'api'))

    @app.post('/api/crm/outcomes/csv')
    async def post_outcomes_csv(req: Request):
        return J(await upsert_outcomes(D(), parse_csv(await body_text(req)), 'csv'))

    @app.get('/api/jobs')
    async def get_jobs(req: Request):
        return J(await list_jobs(D(), min(200, int(js_number(q(req).get('limit') or 50)))))

    @app.post('/api/demo/seed')
    async def demo_seed(req: Request):
        if config.demo_mode == 'off':
            raise http_error(403, 'Demo mode is off (DEMO_MODE=off).')
        b = await body_json(req) or {}
        job_id = await enqueue_or_existing(D(), 'demo_seed', {'count': min(20_000, b.get('count') or 5000), 'days': b.get('days') or 90},
                                           dedupe_key='demo_seed', max_attempts=1, priority=10)
        return J({'jobId': job_id})

    # ---------- Webhooks ----------
    async def webhook(provider: str, id: str, req: Request):
        # No session here: the integration says which workspace the call belongs to.
        row = await get_integration(D().as_system(), id)
        if not row or row['provider'] != provider:
            return J({'error': 'Unknown integration'}, 404)
        with in_workspace(row['workspace_id']):
            return await _webhook_in_workspace(provider, id, row, req)

    async def _webhook_in_workspace(provider: str, id: str, row: dict, req: Request):
        conn = CONNECTORS[provider]
        raw = await body_text(req)
        headers = {k.lower(): v for k, v in req.headers.items()}
        if not conn.verify_webhook(raw, headers, credentials_of(row)):
            log.warn('webhook signature rejected', {'provider': provider, 'integration': id})
            return J({'error': 'Invalid signature'}, 401)
        try:
            body = json.loads(raw) if raw else {}
        except ValueError as e:
            raise http_error(400, f'Invalid JSON: {e}') from e
        ev = conn.parse_webhook(body)
        if not row['enabled']:
            # Acknowledged so the provider stops retrying, but a disabled integration imports nothing.
            return J({'ok': True, 'queued': False, 'ignored': 'integration disabled'})
        if ev['kind'] == 'call':
            await enqueue(D(), 'ingest_call', {'integrationId': id, 'externalId': ev['externalId'], **({'raw': ev['raw']} if ev.get('raw') else {})},
                          dedupe_key=f"ingest:{provider}:{ev['externalId']}", priority=2)
        return J({'ok': True, 'queued': ev['kind'] == 'call'})

    app.include_router(crm_router)
    app.include_router(campaigns_router)
    app.include_router(taxonomy_router)
    app.include_router(auth_router)
    app.include_router(billing_router)
    app.include_router(compliance_router)

    @app.post('/webhooks/elevenlabs/{id}')
    async def webhook_elevenlabs(id: str, req: Request):
        return await webhook('elevenlabs', id, req)

    @app.post('/webhooks/retell/{id}')
    async def webhook_retell(id: str, req: Request):
        return await webhook('retell', id, req)

    # ---------- Landing site and console ----------
    # The landing site (apps/site) at the root and the console under /app/; without a built site the console is at
    # the root too, as before. Both bundles keep fixed file names, so browsers revalidate (a 304 when unchanged).
    console_root = (_console_dist() or Path('/nonexistent')).resolve()
    site_root = (_site_dist() or Path('/nonexistent')).resolve()
    has_console, has_site = (console_root / 'index.html').is_file(), (site_root / 'index.html').is_file()

    def serve(root: Path, path: str) -> FileResponse:
        f = (root / path).resolve()
        if path and f.is_file() and root in f.parents:
            return FileResponse(f, headers={'Cache-Control': 'no-cache'})
        return FileResponse(root / 'index.html', headers={'Cache-Control': 'no-cache'})

    if has_console or has_site:
        @app.get('/{path:path}', include_in_schema=False)
        async def static(path: str):
            if _api_path('/' + path) or path.startswith('webhooks/'):
                return J({'error': 'Not found'}, 404)
            if path == 'app':
                return RedirectResponse('/app/')
            if path.startswith('app/') and has_console:
                return serve(console_root, path[4:])
            if has_site:
                return serve(site_root, path)
            return serve(console_root, path)

        log.info('serving the web apps', {'console': str(console_root) if has_console else None, 'site': str(site_root) if has_site else None})
    return app


def _reviewer(req: Request, body: dict) -> str:
    """The person labelling: their account when signed in (reviewer agreement needs real people); scripts on a
    shared token may name the reviewer."""
    p = req.state.principal
    return p.label if p.via in ('session', 'token') else str(body.get('reviewer') or p.label)[:200]


def _site_dist() -> Path | None:
    candidates = [Path(config.site_dist)] if config.site_dist else []
    here = Path(__file__).resolve().parent
    candidates += [Path.cwd() / '../site/dist', Path.cwd() / 'apps/site/dist', here.parent.parent / 'site/dist']
    return next((p for p in candidates if (p / 'index.html').is_file()), None)


def _console_dist() -> Path | None:
    candidates = [Path(config.web_dist)] if config.web_dist else []
    here = Path(__file__).resolve().parent
    candidates += [Path.cwd() / '../web/dist', Path.cwd() / 'apps/web/dist', here.parent.parent / 'web/dist']
    return next((p for p in candidates if (p / 'index.html').is_file()), None)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Production start-up: open and migrate the database, then run workers and the scheduler here unless RUN_WORKER=false."""
    from .analytics.meta import seed_taxonomy
    from .config import llm_enabled
    from .connectors.registry import bootstrap_from_env
    from .db import get_db
    from .jobs.worker import start_scheduler, start_workers, stop_workers

    db = await get_db()
    app.state.db = db
    # Integrations from the environment and the seed taxonomy belong to the default workspace.
    with in_workspace(DEFAULT_WORKSPACE):
        await seed_taxonomy(db)
        await taxonomy.load(db)
        await bootstrap_from_env(db)
    log.info('database ready', {'kind': db.kind, 'judge': f'claude ({config.llm.model})' if llm_enabled() else 'heuristic (no ANTHROPIC_API_KEY)'})
    stop_scheduler = None
    if config.run_worker:
        start_workers(db)
        stop_scheduler = start_scheduler(db)
    try:
        yield
    finally:
        if stop_scheduler:
            stop_scheduler()
        await stop_workers()
        from .lib import http
        await http.close()
        await db.close()


def create_app() -> FastAPI:
    """App factory for uvicorn (`uvicorn calleval.server:create_app --factory`)."""
    return build_app(None, lifespan=lifespan)
