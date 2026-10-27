# Request and response helpers shared by the API routes.

from __future__ import annotations

import json
from typing import Any

from fastapi import Request
from fastapi.responses import Response

from .js import js_json
from .lib.errors import http_error


class JsResponse(Response):
    """JSON the way JSON.stringify writes it (integral numbers without '.0', NaN as null)."""

    media_type = 'application/json'

    def render(self, content: Any) -> bytes:
        return js_json(content).encode()


def J(data: Any, status_code: int = 200) -> JsResponse:
    return JsResponse(data, status_code=status_code)


async def body_json(req: Request) -> Any:
    raw = await req.body()
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except ValueError as e:
        raise http_error(400, f'Invalid JSON: {e}') from e


async def body_text(req: Request) -> str:
    return (await req.body()).decode('utf-8', errors='replace')


def q(req: Request) -> dict[str, str]:
    return dict(req.query_params)
