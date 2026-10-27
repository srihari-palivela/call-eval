# Stripe over its REST API: form-encoded requests with bracketed keys, an Idempotency-Key on every write, and
# webhook signature checks. Requests go through lib/http, so tests stub them like any provider.

from __future__ import annotations

import hashlib
import hmac
import time
from typing import Any
from urllib.parse import urlencode

from ..config import config
from ..lib.errors import http_error
from ..lib.http import HttpError, fetch_retry

API = 'https://api.stripe.com/v1'
TOLERANCE_S = 300


def configured() -> bool:
    return bool(config.stripe_secret_key)


def _flatten(v: Any, key: str, out: list[tuple[str, str]]) -> None:
    if isinstance(v, dict):
        for k, x in v.items():
            _flatten(x, f'{key}[{k}]' if key else str(k), out)
    elif isinstance(v, (list, tuple)):
        for i, x in enumerate(v):
            _flatten(x, f'{key}[{i}]', out)
    elif isinstance(v, bool):
        out.append((key, 'true' if v else 'false'))
    elif v is not None:
        out.append((key, str(v)))


def form(params: dict | None) -> str:
    """Stripe's form encoding: nested dicts and lists as a[b][0][c]=v."""
    out: list[tuple[str, str]] = []
    _flatten(params or {}, '', out)
    return urlencode(out)


async def call(method: str, path: str, params: dict | None = None, *, idempotency_key: str | None = None) -> dict:
    if not configured():
        raise http_error(400, 'Stripe is not configured (STRIPE_SECRET_KEY)')
    headers = {'authorization': f'Bearer {config.stripe_secret_key}', 'accept': 'application/json'}
    url, content = f'{API}{path}', None
    if method == 'GET':
        if params:
            url = f'{url}?{form(params)}'
    else:
        headers['content-type'] = 'application/x-www-form-urlencoded'
        content = form(params)
        if idempotency_key:
            headers['idempotency-key'] = idempotency_key
    try:
        res = await fetch_retry(url, method=method, headers=headers, content=content, retries=2)
    except HttpError as e:
        raise http_error(502, f'Stripe refused the request ({e.status}): {e.body[:300]}') from e
    return res.json()


def verify(payload: bytes, header: str | None, secret: str, now: float | None = None) -> bool:
    """Stripe-Signature: t=<unix s>,v1=<hex HMAC-SHA256(secret, "t.payload")>[,v1=…]; within five minutes."""
    if not header or not secret:
        return False
    parts = [p.split('=', 1) for p in header.split(',') if '=' in p]
    ts = next((v for k, v in parts if k.strip() == 't'), None)
    sigs = [v for k, v in parts if k.strip() == 'v1']
    if not ts or not ts.isdigit() or not sigs:
        return False
    if abs((now if now is not None else time.time()) - int(ts)) > TOLERANCE_S:
        return False
    expected = hmac.new(secret.encode(), f'{ts}.'.encode() + payload, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, s) for s in sigs)


def sign(payload: bytes, secret: str, ts: int | None = None) -> str:
    """The header Stripe would send (tests)."""
    ts = int(time.time()) if ts is None else ts
    return f"t={ts},v1={hmac.new(secret.encode(), f'{ts}.'.encode() + payload, hashlib.sha256).hexdigest()}"
