# Batch-calling campaigns and the self-improvement loop. Every route answers 403 while campaigns are off
# (settings.features.campaigns).

from __future__ import annotations

from fastapi import APIRouter, Request

from . import billing
from .campaigns import engine
from .improve import loop
from .jobs.queue import enqueue_or_existing
from .lib.errors import http_error
from .web import J, body_json, q

router = APIRouter()


async def _db(req: Request):
    db = req.app.state.db
    await engine.require_campaigns(db)
    return db


@router.get('/api/campaigns')
async def get_campaigns(req: Request):
    return J(await engine.list_campaigns(await _db(req)))


@router.post('/api/campaigns')
async def post_campaign(req: Request):
    db = await _db(req)
    await billing.require_feature(db, 'campaigns')
    return J(await engine.create_campaign(db, await body_json(req) or {}))


@router.get('/api/campaigns/{id}')
async def get_campaign(id: str, req: Request):
    return J(await engine.campaign_detail(await _db(req), id))


@router.patch('/api/campaigns/{id}')
async def patch_campaign(id: str, req: Request):
    return J(await engine.update_campaign(await _db(req), id, await body_json(req) or {}))


# One route per action, so each can need its own permission (starting places real calls).
async def _set_status(req: Request, id: str, action: str):
    return J(await engine.set_status(await _db(req), id, action))


@router.post('/api/campaigns/{id}/start')
async def start_campaign(id: str, req: Request):
    await billing.require_feature(await _db(req), 'campaigns')
    return await _set_status(req, id, 'start')


@router.post('/api/campaigns/{id}/pause')
async def pause_campaign(id: str, req: Request):
    return await _set_status(req, id, 'pause')


@router.post('/api/campaigns/{id}/cancel')
async def cancel_campaign(id: str, req: Request):
    return await _set_status(req, id, 'cancel')


@router.post('/api/campaigns/{id}/improve')
async def improve_campaign(id: str, req: Request):
    db = await _db(req)
    if not await db.one('select id from campaign where id = $1', [id]):
        raise http_error(404, 'Campaign not found')
    payload = {'campaignId': id, 'requestedBy': req.state.principal.label}
    return J({'jobId': await enqueue_or_existing(db, 'improve_cycle', payload, dedupe_key=f'improve:{id}', priority=4, max_attempts=1)})


@router.get('/api/improvement/cycles')
async def get_cycles(req: Request):
    return J(await loop.list_cycles(await _db(req), q(req).get('campaign') or None))


@router.get('/api/improvement/cycles/{id}')
async def get_cycle(id: str, req: Request):
    return J(await loop.cycle_detail(await _db(req), id))


@router.post('/api/improvement/cycles/{id}/approve')
async def approve_cycle(id: str, req: Request):
    return J(await loop.approve(await _db(req), id, req.state.principal.label))


@router.post('/api/improvement/cycles/{id}/reject')
async def reject_cycle(id: str, req: Request):
    b = await body_json(req) or {}
    return J(await loop.reject(await _db(req), id, req.state.principal.label, b.get('note')))


@router.post('/api/improvement/cycles/{id}/promote')
async def promote_cycle(id: str, req: Request):
    return J(await loop.promote(await _db(req), id, req.state.principal.label))


@router.post('/api/improvement/cycles/{id}/rollback')
async def rollback_cycle(id: str, req: Request):
    return J(await loop.rollback(await _db(req), id, req.state.principal.label))


@router.post('/api/improvement/cycles/{id}/verify')
async def verify_cycle(id: str, req: Request):
    return J(await loop.verify(await _db(req), id))


@router.get('/api/improvement/lessons')
async def get_lessons(req: Request):
    return J(await loop.list_lessons(await _db(req), q(req).get('agent') or None))
