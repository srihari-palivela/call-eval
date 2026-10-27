# One structured-output request to Claude, shared by the co-pilot and the improvement loop (the judge keeps
# its own, with a per-taxonomy cached system prompt). Same client as the judge, so tests swap one fake in.
# Handles the server-side fallback parameter some gateways reject, server tools that pause a long turn, and
# refusals or truncation, which never yield schema-valid JSON.

from __future__ import annotations

import asyncio
import json
from typing import Any

import anthropic

from ..config import config
from .log import log

_fallbacks: bool | None = None
_sem: asyncio.Semaphore | None = None
MAX_CONTINUATIONS = 4


def _usage(u: Any) -> dict[str, int]:
    return {'input': (u.input_tokens or 0) + (getattr(u, 'cache_read_input_tokens', 0) or 0) + (getattr(u, 'cache_creation_input_tokens', 0) or 0),
            'output': u.output_tokens or 0}


def _block_dict(b: Any) -> Any:
    return b.model_dump(exclude_none=True) if hasattr(b, 'model_dump') else b


async def request_json(system: str, content: str | list[dict], schema: dict, *, model: str | None = None, effort: str = 'medium',
                       max_tokens: int = 16000, tools: list[dict] | None = None, thinking: bool = False, cache_system: bool = True) -> dict:
    """Returns {'json', 'usage': {'input', 'output'}, 'model', 'content'} (content: every block, for tool results)."""
    from ..pipeline.judge.llm import get_client
    global _fallbacks, _sem
    if _fallbacks is None:
        _fallbacks = config.llm.fallbacks
    if _sem is None:
        _sem = asyncio.Semaphore(max(1, config.llm.max_concurrent))
    messages: list[dict] = [{'role': 'user', 'content': content}]
    params: dict[str, Any] = {
        'model': model or config.llm.model, 'max_tokens': max_tokens,
        'system': [{'type': 'text', 'text': system, **({'cache_control': {'type': 'ephemeral'}} if cache_system else {})}],
        'output_config': {'effort': effort, 'format': {'type': 'json_schema', 'schema': schema}},
        **({'tools': tools} if tools else {}),
        **({'thinking': {'type': 'adaptive'}} if thinking else {}),
    }

    async def send(with_fallbacks: bool) -> Any:
        req = {**params, 'messages': messages}
        if with_fallbacks:
            req = {**req, 'betas': ['server-side-fallback-2026-07-01'], 'fallbacks': 'default'}
        async with get_client().beta.messages.stream(**req) as s:
            return await s.get_final_message()

    usage = {'input': 0, 'output': 0}
    blocks: list[Any] = []
    async with _sem:
        for _ in range(MAX_CONTINUATIONS + 1):
            try:
                msg = await send(_fallbacks)
            except anthropic.BadRequestError as e:
                if _fallbacks and 'fallback' in str(e).lower():
                    _fallbacks = False
                    log.warn('Claude fallbacks not accepted here; continuing without them', {'error': str(e)})
                    msg = await send(False)
                else:
                    raise
            u = _usage(msg.usage)
            usage = {k: usage[k] + u[k] for k in usage}
            blocks += list(msg.content)
            # A server tool (web fetch) paused a long turn: send it back as is to let Claude continue.
            if msg.stop_reason != 'pause_turn':
                break
            messages = [*messages, {'role': 'assistant', 'content': [_block_dict(b) for b in msg.content]}]
    if msg.stop_reason == 'refusal':
        raise RuntimeError('Claude declined this request')
    if msg.stop_reason == 'max_tokens':
        raise RuntimeError('Claude response hit max_tokens before finishing')
    if msg.stop_reason == 'pause_turn':
        raise RuntimeError('Claude did not finish after reading the web pages')
    texts = [b.text for b in msg.content if getattr(b, 'type', None) == 'text']
    try:
        data = json.loads(''.join(texts))
    except json.JSONDecodeError:
        data = json.loads(texts[-1]) if texts else {}
    return {'json': data, 'usage': usage, 'model': getattr(msg, 'model', model or config.llm.model), 'content': blocks}
