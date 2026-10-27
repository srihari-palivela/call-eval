# Calling compliance: country rules, issues, and the do-not-call list.

from __future__ import annotations

from fastapi import APIRouter, Request

from . import compliance
from .web import J, body_json, body_text, q

router = APIRouter()


def _db(req: Request):
    return req.app.state.db


@router.get('/api/compliance')
async def get_compliance(req: Request):
    return J(await compliance.compliance_dto(_db(req)))


@router.post('/api/compliance/dnc')
async def add_dnc(req: Request):
    # JSON {numbers: [...]}, or a CSV/text body of numbers.
    body = await body_json(req) if 'json' in (req.headers.get('content-type') or '') else await body_text(req)
    return J(await compliance.dnc_add(_db(req), body))


@router.delete('/api/compliance/dnc')
async def clear_dnc(req: Request):
    return J(await compliance.dnc_clear(_db(req)))


@router.get('/api/compliance/dnc/check')
async def check_dnc(req: Request):
    return J(await compliance.dnc_check(_db(req), q(req).get('phone')))
