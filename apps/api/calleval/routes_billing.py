# Plans, checkout, credit top-ups and the Stripe webhook.

from __future__ import annotations

from fastapi import APIRouter, Request

from . import billing
from .web import J, body_json

router = APIRouter()


def _db(req: Request):
    return req.app.state.db


@router.get('/api/billing/plans')
async def billing_plans(req: Request):
    return J(billing.plans_dto())


@router.get('/api/billing')
async def get_billing(req: Request):
    return J(await billing.billing_dto(_db(req)))


@router.post('/api/billing/checkout')
async def billing_checkout(req: Request):
    b = await body_json(req) or {}
    return J(await billing.checkout(_db(req), b.get('plan'), b.get('annual') is True))


@router.post('/api/billing/topup')
async def billing_topup(req: Request):
    b = await body_json(req) or {}
    return J(await billing.topup(_db(req), b.get('amountUsd')))


@router.post('/api/billing/portal')
async def billing_portal(req: Request):
    return J(await billing.portal(_db(req)))


@router.put('/api/billing/settings')
async def billing_settings(req: Request):
    return J(await billing.update_settings(_db(req), await body_json(req) or {}))


@router.post('/webhooks/stripe')
async def stripe_webhook(req: Request):
    return J(await billing.handle_webhook(_db(req), await req.body(), req.headers.get('stripe-signature')))
