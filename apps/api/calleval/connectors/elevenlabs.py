# ElevenLabs Agents Platform (Conversational AI) connector.
# Endpoints and field names follow the official SDK's wire types (@elevenlabs/elevenlabs-js):
#   GET  /v1/convai/conversations                 list (agent_id, cursor, page_size ≤ 100, call_start_after_unix)
#   GET  /v1/convai/conversations/{id}            transcript, metadata, analysis, initiation data
#   GET  /v1/convai/conversations/{id}/audio      recording
#   GET  /v1/convai/agents/{id}                   conversation_config.agent.prompt.prompt, first_message, version_id
# Auth header: xi-api-key. Post-call webhooks are signed: ElevenLabs-Signature: t=<s>,v0=<HMAC-SHA256(secret, `${t}.${body}`)>.

from __future__ import annotations

import hashlib
import hmac
import math
from datetime import datetime
from typing import Any
from urllib.parse import urlencode

from ..js import iso, is_finite, js_number, now_ms, to_ms
from ..lib.http import Response, fetch_retry, get_json
from .types import enc_uri, estimate_end, extract_tags, header, is_num, js_parse_args, s_of, truthy

DEFAULT_BASE = 'https://api.elevenlabs.io'


def _base(c: dict) -> str:
    b = c.get('baseUrl') or DEFAULT_BASE
    return b[:-1] if b.endswith('/') else b


def _auth(c: dict) -> dict[str, str]:
    return {'xi-api-key': c.get('apiKey')}


def map_termination(reason: str | None) -> str:
    r = (reason if reason is not None else '').lower()
    if not r:
        return 'unknown'
    if 'max' in r and 'duration' in r:
        return 'time_limit'
    if 'voicemail' in r:
        return 'voicemail'
    if 'transfer' in r:
        return 'transfer'
    if 'end_call' in r or 'agent ended' in r or 'agent' in r:
        return 'natural_close'
    if 'remote party' in r or 'client disconnected' in r or 'user' in r or 'hang' in r:
        return 'caller_hangup'
    if 'no answer' in r or 'busy' in r:
        return 'no_answer'
    if 'error' in r or 'fail' in r:
        return 'error'
    return 'unknown'


def normalise_elevenlabs(raw: Any) -> dict:
    c = raw
    items = [it for it in (c.get('transcript') if c.get('transcript') is not None else []) if truthy(it)]
    turns: list[dict] = []
    tool_calls: list[dict] = []
    pending: list[dict] = []
    results: dict[Any, dict] = {}

    for it in items:
        for r in (it.get('tool_results') if it.get('tool_results') is not None else []):
            results[r.get('request_id')] = r

    for it in items:
        msg = it.get('message')
        text = (msg if msg is not None else '').strip()
        speaker = 'agent' if it.get('role') == 'agent' else 'caller'
        if text and not (speaker == 'caller' and truthy(it.get('ignored_as_backchannel'))):
            metrics: dict[str, float] = {}
            ctm = it.get('conversation_turn_metrics')
            m = (ctm.get('metrics') if ctm is not None else None)
            for k, v in (m if m is not None else {}).items():
                if truthy(v) and is_num(v.get('elapsed_time')):
                    metrics[k] = v['elapsed_time']
            t = it.get('time_in_call_secs')
            turn: dict[str, Any] = {'idx': len(turns), 'speaker': speaker, 'text': text, 'startS': t if t is not None else 0,
                                    'interrupted': truthy(it.get('interrupted'))}
            if metrics:
                turn['turnMetrics'] = metrics
            if speaker == 'agent':
                turn['tags'] = extract_tags(text)
            turns.append(turn)
        for tc in (it.get('tool_calls') if it.get('tool_calls') is not None else []):
            last = turns[-1] if turns else None
            # A tool call in the same item as spoken text, or right after an agent turn, belongs to that turn;
            # one that arrives after the caller spoke belongs to the agent's next turn (dead air before it).
            t = it.get('time_in_call_secs')
            pending.append({'tc': tc, 'at': t if t is not None else 0, 'afterTurn': last['idx'] if last is not None and last['speaker'] == 'agent' else None})

    for i, t in enumerate(turns):
        nxt = turns[i + 1] if i + 1 < len(turns) else None
        t['endS'] = estimate_end(t['startS'], t['text'], t['speaker'], nxt['startS'] if nxt is not None else None)

    for p in pending:
        turn_idx = p['afterTurn']
        if turn_idx is None:
            hit = next((t for t in turns if t['speaker'] == 'agent' and t['startS'] >= p['at']), None)
            if hit is not None:
                turn_idx = hit['idx']
            else:
                agents = [t for t in turns if t['speaker'] == 'agent']
                turn_idx = agents[-1]['idx'] if agents else 0
        tc = p['tc']
        r = results.get(tc.get('request_id'))
        out: dict[str, Any] = {
            'id': tc.get('request_id'), 'turnIdx': turn_idx, 'name': tc.get('tool_name'), 'rawName': tc.get('tool_name'),
            'args': js_parse_args(tc.get('params_as_json')),
        }
        if r is not None:
            if r.get('result_value') is not None:
                out['resultText'] = r['result_value']
            if truthy(r.get('result_value')):
                out['result'] = js_parse_args(r['result_value'])
            out['ok'] = not truthy(r.get('is_error'))
        out['startS'] = p['at']
        if r is not None and r.get('tool_latency_secs') is not None:
            out['durationS'] = r['tool_latency_secs']
        tool_calls.append(out)

    md = c.get('metadata') if c.get('metadata') is not None else {}
    cicd = c.get('conversation_initiation_client_data')
    dv = cicd.get('dynamic_variables') if cicd is not None else None
    dyn = dict(dv if dv is not None else {})
    pc = md.get('phone_call')
    d_dir = dyn.get('direction')
    direction = pc.get('direction') if pc is not None and pc.get('direction') is not None else (
        d_dir if isinstance(d_dir, str) and d_dir in ('inbound', 'outbound') else 'unknown')
    an = c.get('analysis')

    start = md.get('start_time_unix_secs')
    term = md.get('termination_reason')
    dur = md.get('call_duration_secs')
    cost = md.get('cost')
    lead = dyn.get('lead_id')
    pv = dyn.get('prompt_version')

    def pick_num(inbound_key: str, outbound_key: str) -> Any:
        v = pc.get(inbound_key) if pc.get('direction') == 'inbound' else pc.get(outbound_key)
        return v

    pa = None
    if truthy(an):
        cs = an.get('call_successful')
        ecr = an.get('evaluation_criteria_results')
        dcr = an.get('data_collection_results')
        pa = {
            'summary': an.get('transcript_summary'),
            'successful': True if cs == 'success' else False if cs == 'failure' else None,
            'evaluationCriteria': {k: {'result': v.get('result'), 'rationale': v.get('rationale')} for k, v in (ecr if ecr is not None else {}).items()},
            'dataCollection': {k: {'value': v.get('value'), 'rationale': v.get('rationale')} for k, v in (dcr if dcr is not None else {}).items()},
        }

    return {
        'provider': 'elevenlabs',
        'externalId': c.get('conversation_id'),
        'agentExternalId': c.get('agent_id'),
        'agentName': c.get('agent_name'),
        'agentVersion': c.get('version_id') if c.get('version_id') is not None else c.get('branch_id'),
        'startedAt': iso(math.trunc((start if start is not None else 0) * 1000)),
        'durationS': dur if dur is not None else 0,
        'direction': direction,
        'endReason': map_termination(term),
        'endReasonRaw': term,
        'language': md.get('main_language'),
        'fromNumber': pick_num('external_number', 'agent_number') if truthy(pc) else None,
        'toNumber': pick_num('agent_number', 'external_number') if truthy(pc) else None,
        'dynamicVariables': dyn,
        'turns': turns,
        'toolCalls': tool_calls,
        'recording': {'available': truthy(c.get('has_audio')), 'channels': 1, 'url': None, 'multiChannelUrl': None},
        'providerAnalysis': pa,
        'latency': None,
        'cost': {'amount': cost, 'currency': 'credits'} if is_num(cost) else None,
        'leadId': (lead if isinstance(lead, str) and lead else None) or _or(cicd.get('user_id') if cicd is not None else None, c.get('user_id')),
        'promptVersionHint': pv if isinstance(pv, str) else None,
    }


def _or(*vals: Any) -> Any:
    """a || b || … || null."""
    for v in vals:
        if truthy(v):
            return v
    return None


class _ElevenLabs:
    provider = 'elevenlabs'

    async def list_calls(self, creds: dict, *, since: datetime | None, cursor: Any, agent_id: str | None) -> dict:
        q: dict[str, str] = {'page_size': '100'}
        if agent_id:
            q['agent_id'] = agent_id
        if since:
            q['call_start_after_unix'] = str(math.floor(to_ms(since) / 1000))
        if cursor:
            q['cursor'] = s_of(cursor)
        page = await get_json(f'{_base(creds)}/v1/convai/conversations?{urlencode(q)}', _auth(creds))
        return {
            'calls': [{'externalId': c.get('conversation_id'), 'startedAt': iso(math.trunc(c['start_time_unix_secs'] * 1000)),
                       'complete': c.get('status') == 'done' or c.get('status') == 'failed'} for c in page['conversations']],
            'cursor': page.get('next_cursor'),
            'done': not truthy(page.get('has_more')) or not truthy(page.get('next_cursor')),
        }

    async def fetch_call(self, creds: dict, external_id: str) -> dict:
        raw = await get_json(f'{_base(creds)}/v1/convai/conversations/{enc_uri(external_id)}', _auth(creds))
        return {'canonical': normalise_elevenlabs(raw), 'raw': raw}

    def normalise(self, raw: Any) -> dict:
        return normalise_elevenlabs(raw)

    async def fetch_agent(self, creds: dict, agent_id: str, version: str | None = None) -> dict | None:
        a = await get_json(f'{_base(creds)}/v1/convai/agents/{enc_uri(agent_id)}', _auth(creds))
        cc = a.get('conversation_config') if a is not None else None
        ag = cc.get('agent') if cc is not None else None
        agent_cfg = ag if ag is not None else {}
        prompt = agent_cfg.get('prompt')
        tools = (prompt.get('tools') if prompt is not None else None)
        return {
            'externalId': a.get('agent_id') if a.get('agent_id') is not None else agent_id,
            'name': a.get('name'),
            'prompt': prompt.get('prompt') if prompt is not None else None,
            'firstMessage': agent_cfg.get('first_message'),
            'providerVersion': a.get('version_id'),
            'config': {
                'llm': prompt.get('llm') if prompt is not None else None,
                'tools': [n for n in ((t.get('name') if t is not None else None) for t in (tools if tools is not None else [])) if truthy(n)],
                'language': agent_cfg.get('language'),
            },
        }

    async def list_agents(self, creds: dict) -> list[dict]:
        r = await get_json(f'{_base(creds)}/v1/convai/agents?page_size=100', _auth(creds))
        agents = r.get('agents')
        return [{'id': a.get('agent_id'), 'name': a.get('name')} for a in (agents if agents is not None else [])]

    async def fetch_audio(self, creds: dict, call: dict) -> Response | None:
        return await fetch_retry(f"{_base(creds)}/v1/convai/conversations/{enc_uri(call['externalId'])}/audio", headers=_auth(creds), timeout_ms=120_000, retries=2)

    def verify_webhook(self, raw_body: str, headers: dict[str, Any], creds: dict) -> bool:
        secret = creds.get('webhookSecret')
        sig = header(headers, 'elevenlabs-signature')
        if not secret or not sig:
            return False
        parts: dict[str, str] = {}
        for p in sig.split(','):
            i = p.find('=')
            parts[(p[:i] if i >= 0 else p[:-1]).strip()] = p[i + 1:].strip()
        t = js_number(parts['t']) if 't' in parts else float('nan')
        if not parts.get('v0') or not is_finite(t):
            return False
        if abs(now_ms() - t * 1000) > 30 * 60 * 1000:
            return False
        digest = hmac.new(secret.encode(), f"{parts['t']}.{raw_body}".encode(), hashlib.sha256).hexdigest()
        a, b = digest.encode(), parts['v0'].encode()
        return len(a) == len(b) and hmac.compare_digest(a, b)

    def parse_webhook(self, body: Any) -> dict:
        type_ = body.get('type') if isinstance(body, dict) else None
        data = body.get('data') if isinstance(body, dict) else None
        if not truthy(type_) or not truthy(data.get('conversation_id') if isinstance(data, dict) else None):
            return {'kind': 'ignore', 'reason': 'not a conversation event'}
        if type_ == 'post_call_transcription':
            return {'kind': 'call', 'externalId': data['conversation_id'], 'event': type_, 'raw': data if isinstance(data.get('transcript'), list) else None}
        if type_ == 'post_call_audio':
            return {'kind': 'ignore', 'reason': 'audio is fetched on demand'}
        if type_ == 'call_initiation_failure':
            return {'kind': 'ignore', 'reason': 'call never connected'}
        return {'kind': 'ignore', 'reason': f'unhandled event {s_of(type_)}'}


elevenlabs = _ElevenLabs()
