# Integrations: provider credentials stored encrypted, plus the ones bootstrapped from the
# environment so a deployment can be configured without touching the console.

from __future__ import annotations

import json
from typing import Any

from ..config import config
from ..js import is_finite, iso, js_json, js_number, js_round
from ..lib.crypto import decrypt, encrypt, hint
from ..lib.errors import http_error
from ..lib.ids import new_id
from .elevenlabs import elevenlabs
from .retell import retell
from .types import truthy

CONNECTORS: dict[str, Any] = {'elevenlabs': elevenlabs, 'retell': retell}

# IntegrationRow: the `integration` table row (config: {agentIds, baseUrl, pollMinutes, toolAliases},
# secrets: encrypted {apiKey, webhookSecret}, cursor: {since}).

_LABEL = {'elevenlabs': 'ElevenLabs', 'retell': 'Retell AI', 'apollo': 'Apollo.io'}
# Voice platforms send calls; Treppan sends CRM outcomes; Apollo is a lead finder for the built-in CRM.
PROVIDERS = ('elevenlabs', 'retell', 'treppan', 'apollo')
CALL_PROVIDERS = ('elevenlabs', 'retell')


def _label(provider: str) -> str:
    return _LABEL.get(provider, 'Treppan CRM')


def credentials_of(row: dict) -> dict:
    s: dict = {}
    if row.get('secrets'):
        try:
            s = json.loads(decrypt(row['secrets']))
        except Exception:
            s = {}
    cfg = row.get('config') or {}
    return {
        'apiKey': s.get('apiKey') if s.get('apiKey') is not None else '',
        'webhookSecret': s.get('webhookSecret'),
        'baseUrl': cfg.get('baseUrl'),
        'agentIds': cfg.get('agentIds') if cfg.get('agentIds') is not None else [],
    }


async def get_integration(db, id: str) -> dict | None:
    return await db.one('select * from integration where id = $1', [id])


async def list_integrations(db) -> list[dict]:
    return await db.query('select * from integration order by created_at')


def to_dto(row: dict) -> dict:
    creds = credentials_of(row)
    base = config.public_url[:-1] if config.public_url and config.public_url.endswith('/') else (config.public_url or '')
    cfg = row.get('config') or {}
    return {
        'id': row['id'], 'provider': row['provider'], 'name': row['name'], 'enabled': row['enabled'],
        'agentIds': cfg.get('agentIds') if cfg.get('agentIds') is not None else [],
        'baseUrl': cfg.get('baseUrl'),
        'pollMinutes': cfg.get('pollMinutes') if cfg.get('pollMinutes') is not None else 15,
        'hasApiKey': truthy(creds['apiKey']), 'hasWebhookSecret': truthy(creds['webhookSecret']), 'apiKeyHint': row.get('api_key_hint'),
        'webhookUrl': f"{base}/webhooks/{row['provider']}/{row['id']}" if row['provider'] in CALL_PROVIDERS else '',
        'lastSyncAt': iso(row.get('last_sync_at')), 'lastSyncStatus': row.get('last_sync_status'), 'lastError': row.get('last_error'),
        'callsImported': row.get('calls_imported'), 'createdAt': iso(row['created_at']),
    }


# IntegrationInput: {provider?, name?, apiKey?, webhookSecret?, agentIds?, baseUrl?, pollMinutes?, enabled?, toolAliases?}.
# A key that is absent keeps the stored value; webhookSecret: null clears it.

async def save_integration(db, id: str | None, input: dict) -> dict:
    cur = await get_integration(db, id) if id else None
    if id and not cur:
        raise http_error(404, 'Integration not found')
    provider = input.get('provider') if input.get('provider') is not None else (cur['provider'] if cur else None)
    if not provider or provider not in PROVIDERS:
        raise http_error(400, 'provider must be elevenlabs, retell, treppan or apollo')
    prev = credentials_of(cur) if cur else {'apiKey': '', 'webhookSecret': None}
    api_key = input['apiKey'] if input.get('apiKey') is not None and input.get('apiKey') != '' else prev['apiKey']
    webhook_secret = (input['webhookSecret'] if truthy(input['webhookSecret']) else None) if 'webhookSecret' in input else prev['webhookSecret']
    cfg: dict[str, Any] = dict((cur.get('config') if cur else None) or {})
    if 'agentIds' in input:
        cfg['agentIds'] = [a.strip() for a in input['agentIds'] if a.strip()]
    if 'baseUrl' in input:
        cfg['baseUrl'] = input['baseUrl'] if truthy(input['baseUrl']) else None
    if 'pollMinutes' in input:
        pm = js_number(input['pollMinutes'])
        cfg['pollMinutes'] = max(0, js_round(pm)) if is_finite(pm) else None  # JSON.stringify(NaN) is null
    if 'toolAliases' in input:
        ta = input['toolAliases'] if input['toolAliases'] is not None else {}
        cfg['toolAliases'] = {k.strip(): v.strip() for k, v in ta.items() if k and isinstance(v, str)}
    secrets = encrypt(js_json({'apiKey': api_key, 'webhookSecret': webhook_secret})) if truthy(api_key) or truthy(webhook_secret) else None
    if cur:
        await db.query('update integration set name = $2, enabled = $3, config = $4::jsonb, secrets = $5, api_key_hint = $6, updated_at = now() where id = $1',
                       [cur['id'], input['name'] if input.get('name') is not None else cur['name'], input['enabled'] if input.get('enabled') is not None else cur['enabled'],
                        js_json(cfg), secrets, hint(api_key)])
        return await get_integration(db, cur['id'])  # type: ignore[return-value]
    nid = new_id('int')
    await db.query('insert into integration (id, provider, name, enabled, config, secrets, api_key_hint) values ($1,$2,$3,$4,$5::jsonb,$6,$7)',
                   [nid, provider, input['name'] if input.get('name') is not None else _label(provider), input['enabled'] if input.get('enabled') is not None else True,
                    js_json({'pollMinutes': 15, **cfg}), secrets, hint(api_key)])
    return await get_integration(db, nid)  # type: ignore[return-value]


async def bootstrap_from_env(db) -> None:
    """Create or refresh integrations defined by environment variables."""
    b = config.bootstrap

    async def upsert(provider: str, input: dict) -> None:
        existing = await db.one("select * from integration where provider = $1 and name like '%(env)'", [provider])
        await save_integration(db, existing['id'] if existing else None, {'provider': provider, 'name': f'{_label(provider)} (env)', **input})

    if b.get('elevenlabs'):
        e = b['elevenlabs']
        await upsert('elevenlabs', {'apiKey': e['apiKey'], 'webhookSecret': e['webhookSecret'], 'agentIds': e['agentIds'], 'baseUrl': e['baseUrl']})
    if b.get('retell'):
        e = b['retell']
        await upsert('retell', {'apiKey': e['apiKey'], 'agentIds': e['agentIds'], 'baseUrl': e['baseUrl']})
    if b.get('treppan'):
        e = b['treppan']
        await upsert('treppan', {'apiKey': e['apiKey'], 'baseUrl': e['baseUrl'], 'pollMinutes': 1440})
