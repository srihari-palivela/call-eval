# User-defined taxonomy: versions, the draft (edit, apply co-pilot operations, activate) and the co-pilot.

from __future__ import annotations

from fastapi import APIRouter, Request

from . import copilot
from .js import UNDEFINED
from .taxonomy import store
from .web import J, body_json

router = APIRouter()


def _db(req: Request):
    return req.app.state.db


@router.get('/api/taxonomy')
async def get_taxonomy(req: Request):
    return J(await store.taxonomy_dto(_db(req)))


@router.post('/api/taxonomy/draft')
async def create_draft(req: Request):
    b = await body_json(req) or {}
    return J(await store.create_draft(_db(req), str(b.get('from') or 'active'), replace=b.get('replace') is True))


@router.put('/api/taxonomy/draft')
async def save_draft(req: Request):
    return J(await store.save_draft(_db(req), await body_json(req) or {}))


@router.post('/api/taxonomy/draft/apply')
async def apply_ops(req: Request):
    b = await body_json(req) or {}
    return J(await store.apply_ops(_db(req), b.get('operations'), b.get('domain', UNDEFINED)))


@router.delete('/api/taxonomy/draft')
async def discard_draft(req: Request):
    return J(await store.discard_draft(_db(req)))


@router.post('/api/taxonomy/draft/activate')
async def activate(req: Request):
    b = await body_json(req) or {}
    return J(await store.activate(_db(req), b.get('notes'), b.get('rescoreDays', 0), by=req.state.principal.label))


@router.post('/api/taxonomy/copilot')
async def taxonomy_copilot(req: Request):
    return J(await copilot.propose_taxonomy(_db(req), await body_json(req) or {}))
