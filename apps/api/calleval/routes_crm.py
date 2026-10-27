# Business onboarding, the built-in CRM (leads and funnels) and lead finders. CRM routes answer 403 while the CRM
# is off (settings.features.crm); onboarding and its co-pilot are always available.

from __future__ import annotations

from fastapi import APIRouter, Request

from . import billing, copilot
from .business import apollo_search_params, get_business, goals_progress, update_business
from .config import llm_enabled
from .crm import funnels
from .crm import leads as crm
from .jobs.queue import enqueue_or_existing
from .leadfinder import apollo
from .lib.errors import http_error
from .lib.log import log
from .tenancy import DEFAULT_WORKSPACE, in_workspace
from .web import J, body_json, body_text, q

router = APIRouter()


def _db(req: Request):
    return req.app.state.db


def _who(req: Request) -> str:
    return req.state.principal.label


# ---------- Onboarding ----------
@router.get('/api/business')
async def get_business_route(req: Request):
    db = _db(req)
    profile = await get_business(db)
    creds = await apollo.apollo_credentials(db)
    return J({'profile': profile, 'progress': await goals_progress(db), 'apolloQuery': apollo_search_params(profile),
              'leadFinder': {'apollo': bool(creds), 'phoneWebhook': bool(apollo.phone_webhook_url(creds['integrationId'])) if creds else False}})


@router.put('/api/business')
async def put_business(req: Request):
    return J(await update_business(_db(req), await body_json(req) or {}))


@router.post('/api/business/copilot')
async def business_copilot(req: Request):
    return J(await copilot.propose_business(_db(req), await body_json(req) or {}))


# ---------- CRM ----------
@router.get('/api/crm/leads')
async def get_leads(req: Request):
    await crm.require_crm(_db(req))
    return J(await crm.list_leads(_db(req), q(req)))


@router.post('/api/crm/leads')
async def post_lead(req: Request):
    db = _db(req)
    await crm.require_crm(db)
    row, created = await crm.upsert_lead(db, await body_json(req) or {}, source='manual', actor=_who(req))
    return J({**crm.to_dto(row), 'created': created})


@router.post('/api/crm/leads/import')
async def import_leads(req: Request):
    db = _db(req)
    await crm.require_crm(db)
    return J(await crm.import_csv(db, await body_text(req), actor=_who(req)))


@router.get('/api/crm/leads/{id}')
async def get_lead(id: str, req: Request):
    await crm.require_crm(_db(req))
    return J(await crm.lead_detail(_db(req), id))


@router.patch('/api/crm/leads/{id}')
async def patch_lead(id: str, req: Request):
    db = _db(req)
    await crm.require_crm(db)
    return J(crm.to_dto(await crm.update_lead(db, id, await body_json(req) or {}, actor=_who(req))))


@router.post('/api/crm/leads/{id}/stage')
async def post_stage(id: str, req: Request):
    db = _db(req)
    await crm.require_crm(db)
    b = await body_json(req) or {}
    return J(crm.to_dto(await crm.set_stage(db, id, str(b.get('stage') or ''), note=b.get('note'), value_aed=b.get('valueAed'), actor=_who(req))))


@router.delete('/api/crm/leads/{id}')
async def del_lead(id: str, req: Request):
    db = _db(req)
    await crm.require_crm(db)
    await crm.delete_lead(db, id)
    return J({'ok': True})


# ---------- Lead funnels ----------
@router.get('/api/crm/funnels')
async def get_funnels(req: Request):
    db = _db(req)
    await crm.require_crm(db)
    return J({'funnels': await funnels.list_funnels(db), 'milestones': funnels.MILESTONES, 'templates': funnels.templates(), 'copilot': llm_enabled()})


@router.post('/api/crm/funnels')
async def post_funnel(req: Request):
    db = _db(req)
    await crm.require_crm(db)
    return J(await funnels.create_funnel(db, await body_json(req) or {}))


@router.post('/api/crm/funnels/copilot')
async def funnel_copilot(req: Request):
    db = _db(req)
    await crm.require_crm(db)
    return J(await copilot.propose_funnel(db, await body_json(req) or {}))


@router.get('/api/crm/funnels/{id}')
async def get_funnel(id: str, req: Request):
    db = _db(req)
    await crm.require_crm(db)
    return J(await funnels.funnel_dto(db, id))


@router.put('/api/crm/funnels/{id}')
async def put_funnel(id: str, req: Request):
    db = _db(req)
    await crm.require_crm(db)
    return J(await funnels.update_funnel(db, id, await body_json(req) or {}, actor=_who(req)))


@router.delete('/api/crm/funnels/{id}')
async def del_funnel(id: str, req: Request):
    db = _db(req)
    await crm.require_crm(db)
    await funnels.delete_funnel(db, id, q(req).get('moveTo') or None)
    return J({'ok': True})


@router.post('/api/crm/funnels/{id}/default')
async def default_funnel(id: str, req: Request):
    db = _db(req)
    await crm.require_crm(db)
    return J(await funnels.set_default(db, id))


@router.get('/api/crm/funnels/{id}/report')
async def funnel_report(id: str, req: Request):
    db = _db(req)
    await crm.require_crm(db)
    return J(await funnels.report(db, id, q(req).get('range') or '30'))


# ---------- Lead finders ----------
@router.post('/api/leadfinder/search')
async def leadfinder_search(req: Request):
    db = _db(req)
    await crm.require_crm(db)
    await billing.require_feature(db, 'lead_finder')
    if not await apollo.apollo_credentials(db):
        raise http_error(400, 'Add an Apollo integration (or set APOLLO_API_KEY) first.')
    b = await body_json(req) or {}
    mx = b.get('max', 100)
    if not isinstance(mx, int) or not 1 <= mx <= 5000:
        raise http_error(400, 'max is the number of people to add, 1 to 5000')
    filters = b.get('filters')
    if filters is not None and not isinstance(filters, dict):
        raise http_error(400, 'filters is an object of Apollo search parameters')
    return J({'jobId': await enqueue_or_existing(db, 'lead_search', {'max': mx, 'filters': filters}, dedupe_key='lead_search', priority=3, max_attempts=2)})


@router.post('/api/leadfinder/enrich')
async def leadfinder_enrich(req: Request):
    db = _db(req)
    await crm.require_crm(db)
    await billing.require_feature(db, 'lead_finder')
    if not await apollo.apollo_credentials(db):
        raise http_error(400, 'Add an Apollo integration (or set APOLLO_API_KEY) first.')
    b = await body_json(req) or {}
    cap = b.get('creditCap', 100)
    if not isinstance(cap, int) or not 1 <= cap <= 100000:
        raise http_error(400, 'creditCap is the most Apollo credits this run may use, 1 to 100000')
    ids = b.get('leadIds')
    if ids is not None and (not isinstance(ids, list) or not all(isinstance(x, str) for x in ids)):
        raise http_error(400, 'leadIds is a list of lead ids')
    payload = {'leadIds': ids, 'creditCap': cap, 'revealPhone': b.get('revealPhone') is not False}
    return J({'jobId': await enqueue_or_existing(db, 'lead_enrich', payload, dedupe_key='lead_enrich', priority=3, max_attempts=2)})


@router.post('/webhooks/apollo/{integration_id}/{secret}')
async def apollo_phones(integration_id: str, secret: str, req: Request):
    if not apollo.verify_phone_webhook(integration_id, secret):
        return J({'error': 'Invalid webhook'}, 401)
    # No session here: the integration says which workspace the people belong to (the env key: the default).
    row = None if integration_id == 'env' else await _db(req).as_system().one('select workspace_id from integration where id = $1', [integration_id])
    if integration_id != 'env' and not row:
        return J({'error': 'Unknown integration'}, 404)
    with in_workspace(row['workspace_id'] if row else DEFAULT_WORKSPACE):
        r = await apollo.receive_phones(_db(req), await body_json(req))
    log.info('apollo phones received', r)
    return J({'ok': True, **r})
