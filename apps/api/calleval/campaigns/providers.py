# Batch outbound calling and prompt updates at the voice providers. One batch carries both prompt arms:
# the champion runs the agent as configured; the challenger arm overrides the prompt per call, so no agent
# copies are needed. Every call carries the dynamic variables that tie it back to the lead, the campaign,
# the arm and its prompt version label.
#   ElevenLabs  POST /v1/convai/batch-calling/submit   recipients[].conversation_initiation_client_data
#               {dynamic_variables, conversation_config_override.agent.prompt.prompt}; the agent must allow
#               prompt overrides (agent → Security → Overrides).
#               PATCH /v1/convai/agents/{id}              conversation_config.agent.prompt.prompt
#   Retell      POST /create-batch-call                   {from_number, name, tasks[{to_number,
#               retell_llm_dynamic_variables (strings), metadata, agent_override}]}
#               GET /get-agent/{id} → response_engine.llm_id; PATCH /update-retell-llm/{llm_id} {general_prompt}

from __future__ import annotations

from typing import Any

from ..compliance import ai_disclosure
from ..js import js_json
from ..lib.errors import http_error
from ..lib.http import HttpError, fetch_retry, get_json

EL_BASE = 'https://api.elevenlabs.io'
RETELL_BASE = 'https://api.retellai.com'


def _base(creds: dict, default: str) -> str:
    return (creds.get('baseUrl') or default).rstrip('/')


def dynamic_variables(lead: dict, campaign: dict, arm: str, label: str) -> dict[str, str]:
    """Per-call variables: the join keys (lead, campaign, arm, prompt version) and the context record the
    agent's opening depends on (name, known facts, objective). Strings, as Retell requires."""
    facts = {k: v for k, v in {'company': lead.get('company'), 'title': lead.get('title'), 'persona': lead.get('persona_hint'),
                               'city': lead.get('city'), 'notes': lead.get('notes')}.items() if v}
    return {
        'lead_id': lead['id'], 'campaign_id': campaign['id'], 'arm': arm, 'prompt_version': label,
        'customer_name': lead.get('first_name') or '', 'known_facts': js_json(facts) if facts else '',
        'objective': campaign.get('objective') or '', 'direction': 'outbound',
        # Where the country's rules require it (US), the agent says it is an AI at the start of the call.
        'ai_disclosure': 'true' if ai_disclosure(lead.get('phone')) else 'false',
    }


def elevenlabs_recipient(lead: dict, campaign: dict, arm: str, label: str, prompt: str | None) -> dict:
    init: dict[str, Any] = {'dynamic_variables': dynamic_variables(lead, campaign, arm, label)}
    if prompt is not None:
        init['conversation_config_override'] = {'agent': {'prompt': {'prompt': prompt}}}
    return {'id': lead['id'], 'phone_number': lead['phone'], 'conversation_initiation_client_data': init}


def retell_task(lead: dict, campaign: dict, arm: str, label: str, prompt: str | None) -> dict:
    task: dict[str, Any] = {
        'to_number': lead['phone'],
        'retell_llm_dynamic_variables': dynamic_variables(lead, campaign, arm, label),
        'metadata': {'lead_id': lead['id'], 'campaign_id': campaign['id'], 'arm': arm, 'prompt_version': label},
    }
    if prompt is not None:
        # Unverified shape: Retell documents `agent_override` as per-call overrides of agent / retell_llm /
        # conversation_flow settings; general_prompt is assumed to be overridable there. A 400 is surfaced as is.
        task['agent_override'] = {'retell_llm': {'general_prompt': prompt}}
    return task


def _rejected(provider: str, e: HttpError) -> Exception:
    return http_error(502, f'{provider} rejected the request ({e.status}): {e.body[:500]}')


async def submit_batch(provider: str, creds: dict, *, name: str, agent_id: str, from_number: str | None, entries: list[dict],
                       concurrency: int | None = None, timezone: str | None = None) -> dict:
    """Submit one batch; returns {providerBatchId, raw}. `entries` are recipients (ElevenLabs) or tasks (Retell)."""
    try:
        if provider == 'elevenlabs':
            body: dict[str, Any] = {'call_name': name, 'agent_id': agent_id, 'recipients': entries}
            if from_number:
                body['agent_phone_number_id'] = from_number
            if concurrency:
                body['target_concurrency_limit'] = concurrency
            if timezone:
                body['timezone'] = timezone
            res = await fetch_retry(f"{_base(creds, EL_BASE)}/v1/convai/batch-calling/submit", method='POST',
                                    headers={'xi-api-key': creds['apiKey'], 'content-type': 'application/json'}, content=js_json(body), retries=2)
            raw = res.json()
            return {'providerBatchId': raw.get('id'), 'raw': raw}
        if provider == 'retell':
            if not from_number:
                raise http_error(400, 'Retell batches need a from_number (an E.164 number on the Retell account).')
            body = {'from_number': from_number, 'name': name, 'tasks': entries}
            res = await fetch_retry(f"{_base(creds, RETELL_BASE)}/create-batch-call", method='POST',
                                    headers={'authorization': f"Bearer {creds['apiKey']}", 'content-type': 'application/json'}, content=js_json(body), retries=2)
            raw = res.json()
            return {'providerBatchId': raw.get('batch_call_id'), 'raw': raw}
    except HttpError as e:
        raise _rejected('ElevenLabs' if provider == 'elevenlabs' else 'Retell', e) from e
    raise http_error(400, f'Batch calling is not available for {provider}')


async def batch_status(provider: str, creds: dict, batch_id: str) -> dict | None:
    """The provider's view of a batch where it offers one (ElevenLabs); None otherwise."""
    if provider != 'elevenlabs' or not batch_id:
        return None
    try:
        return await get_json(f"{_base(creds, EL_BASE)}/v1/convai/batch-calling/{batch_id}", {'xi-api-key': creds['apiKey']})
    except HttpError:
        return None


async def update_agent_prompt(provider: str, creds: dict, agent_external_id: str, prompt: str) -> dict:
    """Make `prompt` the agent's live prompt at the provider (used when a challenger is promoted)."""
    try:
        if provider == 'elevenlabs':
            body = {'conversation_config': {'agent': {'prompt': {'prompt': prompt}}}}
            await fetch_retry(f"{_base(creds, EL_BASE)}/v1/convai/agents/{agent_external_id}", method='PATCH',
                              headers={'xi-api-key': creds['apiKey'], 'content-type': 'application/json'}, content=js_json(body), retries=2)
            return {'provider': provider, 'agent': agent_external_id}
        if provider == 'retell':
            auth = {'authorization': f"Bearer {creds['apiKey']}"}
            agent = await get_json(f"{_base(creds, RETELL_BASE)}/get-agent/{agent_external_id}", auth)
            eng = (agent or {}).get('response_engine') or {}
            if eng.get('type') != 'retell-llm' or not eng.get('llm_id'):
                raise http_error(400, 'Only Retell LLM agents can be updated automatically; update this agent in Retell.')
            await fetch_retry(f"{_base(creds, RETELL_BASE)}/update-retell-llm/{eng['llm_id']}", method='PATCH',
                              headers={**auth, 'content-type': 'application/json'}, content=js_json({'general_prompt': prompt}), retries=2)
            return {'provider': provider, 'agent': agent_external_id, 'llmId': eng['llm_id']}
    except HttpError as e:
        raise _rejected('ElevenLabs' if provider == 'elevenlabs' else 'Retell', e) from e
    raise http_error(400, f'Prompt updates are not available for {provider}')
