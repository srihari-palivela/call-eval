# Connector contract. A connector is an object with `provider` and:
#   async list_calls(creds, *, since, cursor, agent_id) -> {calls: [{externalId, startedAt, complete}], cursor, done}
#     One page of calls started after `since`, oldest first where the provider allows.
#   async fetch_call(creds, external_id) -> {canonical, raw}
#   normalise(raw) -> canonical call: map a raw provider payload (from the API or a webhook) to the canonical record.
#   async fetch_agent(creds, agent_id, version=None) -> {externalId, name, prompt, firstMessage, providerVersion, config} | None
#   async list_agents(creds) -> [{id, name}]
#   async fetch_audio(creds, call) -> httpx.Response | None
#   verify_webhook(raw_body, headers, creds) -> bool
#   parse_webhook(body) -> {kind: 'call', externalId, event, raw} | {kind: 'ignore', reason}
# creds = {apiKey, webhookSecret, baseUrl, agentIds}.

from __future__ import annotations

import json
import math
from typing import Any
from urllib.parse import quote

from ..js import jsre, js_split, js_str

_WS = jsre(r'\s+', 'u')  # JavaScript's \s matches Unicode whitespace even without the u flag
_TAG = jsre(r'\[([a-z][a-z _-]{1,30})\]', 'gi')


def truthy(v: Any) -> bool:
    """JavaScript truthiness: objects and arrays are truthy even when empty; NaN is falsy."""
    if v is None or v is False:
        return False
    if isinstance(v, bool):
        return True
    if isinstance(v, (int, float)):
        return v != 0 and not (isinstance(v, float) and math.isnan(v))
    if isinstance(v, str):
        return v != ''
    return True


def is_num(v: Any) -> bool:
    """typeof v === 'number'."""
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def s_of(v: Any) -> str:
    """String(v)."""
    if isinstance(v, str):
        return v
    if isinstance(v, (bool, int, float)) or v is None:
        return js_str(v)
    if isinstance(v, (list, tuple)):
        return ','.join('' if x is None else s_of(x) for x in v)
    return '[object Object]'


def enc_uri(v: Any) -> str:
    """encodeURIComponent."""
    return quote(s_of(v), safe="-_.!~*'()")


def _no_constants(c: str) -> Any:
    raise ValueError(c)


def js_parse_args(s: Any) -> Any:
    """A tool argument or result string as an object: JSON objects and arrays as-is, other JSON as
    {value}, and text that is not JSON as {raw}. Empty input is {}."""
    if not truthy(s):
        return {}
    try:
        v = json.loads(s if isinstance(s, str) else s_of(s), parse_constant=_no_constants)
    except (ValueError, TypeError):
        return {'raw': s}
    return v if isinstance(v, (dict, list)) else {'value': v}


def header(h: dict[str, Any], name: str) -> str | None:
    v = h.get(name.lower())
    return v[0] if isinstance(v, (list, tuple)) else v


# Words per second used to estimate an utterance's end when the provider only gives its start.
SPEECH_WPS = {'agent': 2.6, 'caller': 2.4}


def estimate_end(start: float, text: str, speaker: str, next_start: float | None = None) -> float:
    t = text.strip()
    words = len(js_split(t, _WS)) if t else 0
    est = start + max(0.6, words / SPEECH_WPS[speaker])
    return min(est, next_start - 0.05) if next_start is not None and next_start > start else est


def extract_tags(text: str) -> list[str]:
    """Delivery tags such as [confidently] written into the agent text by the LLM."""
    return [m.group(1).lower() for m in _TAG.finditer(text)]
