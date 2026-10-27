# HTTP for provider APIs: timeouts and retries on 429/5xx and network errors, honouring Retry-After.
# Every request goes through `send`, so tests can replace it with canned provider responses.

from __future__ import annotations

import asyncio
import json
from typing import Any
from urllib.parse import urlparse

import httpx

from .log import log

Response = httpx.Response


class HttpError(Exception):
    def __init__(self, status: int, body: str, url: str):
        self.status = status
        self.body = body
        self.url = url
        super().__init__(f'HTTP {status} from {urlparse(url).netloc}: {body[:300]}')


_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(follow_redirects=True)
    return _client


async def send(method: str, url: str, *, headers: dict[str, str] | None = None, content: bytes | str | None = None,
               data: dict | None = None, files: Any = None, timeout: float = 30.0) -> httpx.Response:
    """One HTTP request. Replaced in tests (see tests/fixtures.py `stub_http`)."""
    return await _get_client().request(method, url, headers=headers, content=content, data=data, files=files, timeout=timeout)


async def fetch_retry(url: str, *, method: str = 'GET', headers: dict[str, str] | None = None, content: bytes | str | None = None,
                      data: dict | None = None, files: Any = None, timeout_ms: int = 30_000, retries: int = 4) -> httpx.Response:
    attempt = 0
    while True:
        try:
            res = await send(method, url, headers=headers, content=content, data=data, files=files, timeout=timeout_ms / 1000)
            if (res.status_code == 429 or res.status_code >= 500) and attempt < retries:
                try:
                    ra = float(res.headers.get('retry-after') or 'nan')
                except ValueError:
                    ra = float('nan')
                wait = ra * 1000 if ra == ra and ra > 0 else 500 * 2 ** attempt
                log.warn('retrying request', {'url': urlparse(url).path, 'status': res.status_code, 'wait': wait})
                await asyncio.sleep(min(wait, 30_000) / 1000)
                attempt += 1
                continue
            if res.status_code >= 400:
                raise HttpError(res.status_code, res.text, url)
            return res
        except HttpError:
            raise
        except Exception:
            if attempt >= retries:
                raise
            await asyncio.sleep(0.5 * 2 ** attempt)
            attempt += 1


async def get_json(url: str, headers: dict[str, str], *, method: str = 'GET', body: Any = None, timeout_ms: int = 30_000) -> Any:
    h = {'accept': 'application/json', **headers}
    content = None
    if body is not None:
        content = body if isinstance(body, (str, bytes)) else json.dumps(body)
    res = await fetch_retry(url, method=method, headers=h, content=content, timeout_ms=timeout_ms)
    return res.json()


async def close() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
