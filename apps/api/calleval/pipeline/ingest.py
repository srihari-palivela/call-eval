# Step 1: collect. Store the provider's call as a canonical record, link it to its agent, and work
# out which prompt version produced it so every score can be compared across releases.

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable

from ..db import json_
from ..js import UNDEFINED
from ..lib.ids import call_id_of, new_id, sha
from ..lib.log import err_msg, log
from ..tenancy import namespaced

_agent_cache: dict[str, tuple[float, dict | None]] = {}


async def upsert_agent(db, call: dict, integration_id: str | None, info: dict | None) -> str | None:
    if not call.get('agentExternalId'):
        return None
    id = namespaced(f"ag_{sha(f'{call['provider']}:{call['agentExternalId']}', 12)}")
    name = (info or {}).get('name')
    if name is None:
        name = call.get('agentName')
    prompt = (info or {}).get('prompt')
    await db.query(
        """insert into agent (id, provider, external_id, integration_id, name, prompt_text, first_message, config, prompt_hash, updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9, now())
           on conflict (workspace_id, provider, external_id) do update set
             name = coalesce(excluded.name, agent.name),
             integration_id = coalesce(excluded.integration_id, agent.integration_id),
             prompt_text = coalesce(excluded.prompt_text, agent.prompt_text),
             first_message = coalesce(excluded.first_message, agent.first_message),
             config = coalesce(excluded.config, agent.config),
             prompt_hash = coalesce(excluded.prompt_hash, agent.prompt_hash),
             updated_at = now()""",
        # Without agent info the stored config stays as it was (SQL null, not JSON null, so coalesce keeps it).
        [id, call['provider'], call['agentExternalId'], integration_id, name, prompt, (info or {}).get('firstMessage'),
         json_(info['config']) if info and info.get('config') is not None else None, sha(prompt) if prompt else None],
    )
    return id


async def _label_for(db, agent_id: str | None, key: str, *, label: str | None = None, prompt: str | None = None, provider_version: str | None = None,
                     source: str, at: str) -> str:
    existing = await db.one('select label from prompt_version where agent_id is not distinct from $1 and hash = $2', [agent_id, key])
    if existing:
        await db.query(
            'update prompt_version set last_seen_at = greatest(coalesce(last_seen_at, $3::timestamptz), $3::timestamptz), first_seen_at = least(first_seen_at, $3::timestamptz) where agent_id is not distinct from $1 and hash = $2',
            [agent_id, key, at],
        )
        return existing['label']
    if not label and prompt:
        same = await db.one('select label from prompt_version where agent_id is not distinct from $1 and hash = $2', [agent_id, f'prompt:{sha(prompt)}'])
        label = same['label'] if same else None
    if not label:
        n = await db.one('select count(distinct label)::int as n from prompt_version where agent_id is not distinct from $1', [agent_id])
        label = f"v{(n['n'] if n else 0) + 1}"
    await db.query(
        """insert into prompt_version (id, agent_id, label, hash, prompt_text, provider_version, source, first_seen_at, last_seen_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$8)
           on conflict (agent_id, hash) do nothing""",
        [new_id('pv'), agent_id, label, key, prompt, provider_version, source, at],
    )
    if prompt and not key.startswith('prompt:'):
        await db.query(
            """insert into prompt_version (id, agent_id, label, hash, prompt_text, provider_version, source, first_seen_at, last_seen_at) values ($1,$2,$3,$4,$5,$6,'prompt',$7,$7) on conflict (agent_id, hash) do nothing""",
            [new_id('pv'), agent_id, label, f'prompt:{sha(prompt)}', prompt, provider_version, at],
        )
    return label


async def resolve_prompt_version(db, agent_id: str | None, call: dict, info: dict | None) -> str | None:
    """Prompt version, in order of preference: an explicit `prompt_version` dynamic variable; the
    provider's agent version (Retell agent_version, ElevenLabs version_id), labelled v1, v2, … per
    agent in order of first appearance; or a hash of the agent's prompt at ingest time."""
    hint = call.get('promptVersionHint')
    if hint:
        args = dict(key=f'hint:{hint}', label=hint, source='dynamic_variable')
    elif call.get('agentVersion'):
        args = dict(key=f"pv:{call['agentVersion']}", prompt=(info or {}).get('prompt'), provider_version=call['agentVersion'], source='provider_version')
    elif info and info.get('prompt'):
        args = dict(key=f"prompt:{sha(info['prompt'])}", prompt=info['prompt'], source='prompt_hash')
    else:
        return None

    async def run(t) -> str:
        # One label decision at a time per agent: two workers seeing a new version at once would
        # otherwise both count the existing labels and give two versions the same vN.
        await t.query('select pg_advisory_xact_lock(hashtext($1))', [f'prompt_version:{agent_id or ""}'])
        key = args.pop('key')
        return await _label_for(t, agent_id, key, at=call['startedAt'], **args)

    return await db.tx(run)


async def fetch_agent_cached(key: str, fn: Callable[[], Awaitable[dict | None]]) -> dict | None:
    hit = _agent_cache.get(key)
    if hit and time.monotonic() - hit[0] < 600:
        return hit[1]
    info = None
    try:
        info = await fn()
    except Exception as e:  # noqa: BLE001 - a missing prompt only weakens versioning
        log.warn('could not fetch agent configuration', {'key': key, 'error': err_msg(e)})
    _agent_cache[key] = (time.monotonic(), info)
    return info


async def store_canonical(db, call: dict, raw, *, integration_id: str | None, source: str, agent_info: dict | None = None, keep_raw: bool = True) -> str:
    call_id = call_id_of(call['provider'], call['externalId'])
    agent_id = await upsert_agent(db, call, integration_id, agent_info)
    version = await resolve_prompt_version(db, agent_id, call, agent_info)
    rec = call.get('recording') or {}
    await db.query(
        """insert into calls (call_id, provider, external_id, integration_id, agent_id, lead_id, started_at, duration_s, direction, end_reason, end_reason_raw, language,
              prompt_version, agent_version, source, recording_url, recording_channels, has_audio, status, canonical, raw)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'ingested',$19::jsonb,$20::jsonb)
           on conflict (workspace_id, provider, external_id) do update set
             integration_id = coalesce(excluded.integration_id, calls.integration_id), agent_id = excluded.agent_id, lead_id = excluded.lead_id,
             started_at = excluded.started_at, duration_s = excluded.duration_s, direction = excluded.direction, end_reason = excluded.end_reason,
             end_reason_raw = excluded.end_reason_raw, language = excluded.language, prompt_version = coalesce(excluded.prompt_version, calls.prompt_version),
             agent_version = excluded.agent_version, recording_url = excluded.recording_url, recording_channels = excluded.recording_channels,
             has_audio = excluded.has_audio, status = 'ingested', canonical = excluded.canonical, raw = excluded.raw, updated_at = now()""",
        [call_id, call['provider'], call['externalId'], integration_id, agent_id, call.get('leadId'), call['startedAt'], call['durationS'], call['direction'],
         call['endReason'], call.get('endReasonRaw'), call.get('language'), version, call.get('agentVersion'), source,
         rec['multiChannelUrl'] if rec.get('multiChannelUrl') is not None else rec.get('url'), rec.get('channels'), bool(rec.get('available')), json_(call),
         None if keep_raw is False else json_(UNDEFINED if raw is UNDEFINED else raw)],
    )
    return call_id
