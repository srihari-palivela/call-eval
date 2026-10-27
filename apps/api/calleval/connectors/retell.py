# Retell AI connector. Endpoints and field names follow the official SDK (retell-sdk):
#   POST /v3/list-calls              filter_criteria.agent[].agent_id, start_timestamp, limit, pagination_key
#   GET  /v2/get-call/{call_id}      transcript_object (words with timestamps), transcript_with_tool_calls,
#                                    latency (e2e/llm/tts p50/p90 ms), call_analysis, recording urls
#   GET  /get-agent/{agent_id}       response_engine {type, llm_id, version}
#   GET  /get-retell-llm/{llm_id}    general_prompt, begin_message, states[].state_prompt
# Auth: Authorization: Bearer <api key>. Webhooks: x-retell-signature: v=<ms>,d=<HMAC-SHA256(api key, body + ms)>.

from __future__ import annotations

import hashlib
import hmac
from datetime import datetime
from typing import Any

from ..framework import DEFAULT_TOOL_ALIASES
from ..js import iso, js_json, js_number, jsre, now_ms, test, to_ms
from ..lib.http import Response, fetch_retry, get_json
from .types import enc_uri, estimate_end, extract_tags, header, is_num, js_parse_args, s_of, truthy

DEFAULT_BASE = 'https://api.retellai.com'
_ERROR = jsre(r'\berror\b', 'i')
_SIG = jsre(r'v=(\d+),d=([0-9a-f]{64})', 'i')
_MAX_SAFE = 9007199254740991


def _base(c: dict) -> str:
    b = c.get('baseUrl') or DEFAULT_BASE
    return b[:-1] if b.endswith('/') else b


def _auth(c: dict) -> dict[str, str]:
    return {'authorization': f"Bearer {s_of(c.get('apiKey'))}"}


def map_disconnection(r: str | None, in_voicemail: bool | None = None) -> str:
    if truthy(in_voicemail):
        return 'voicemail'
    if r in ('agent_hangup',):
        return 'natural_close'
    if r in ('user_hangup', 'inactivity'):
        return 'caller_hangup'
    if r in ('call_transfer', 'transfer_bridged'):
        return 'transfer'
    if r in ('voicemail_reached', 'ivr_reached'):
        return 'voicemail'
    if r == 'max_duration_reached':
        return 'time_limit'
    if r == 'user_requested_dnc':
        return 'dnc'
    if r == 'user_requested_callback':
        return 'natural_close'
    if r in ('dial_busy', 'dial_failed', 'dial_no_answer', 'user_declined'):
        return 'no_answer'
    if r is None:
        return 'unknown'
    return 'error' if r.startswith('error') else 'unknown'


def _is_utterance(e: Any) -> bool:
    return truthy(e) and e.get('role') in ('agent', 'user', 'transfer_target') and isinstance(e.get('content'), str)


def normalise_retell(raw: Any) -> dict:
    c = raw
    to = c.get('transcript_object')
    utterances = [u for u in (to if to is not None else []) if _is_utterance(u)]
    turns: list[dict] = []
    source_idx: list[int] = []  # utterance index → turn idx (or -1 for transfer_target)
    for u in utterances:
        if u['role'] == 'transfer_target':
            source_idx.append(-1)  # the human advisor is out of scope
            continue
        ws = u.get('words')
        words = [w for w in (ws if ws is not None else []) if is_num(w.get('start')) and is_num(w.get('end'))]
        speaker = 'agent' if u['role'] == 'agent' else 'caller'
        source_idx.append(len(turns))
        if words:
            start = words[0]['start']
        elif turns:
            prev_end = turns[-1].get('endS')
            start = (prev_end if prev_end is not None else 0) + 0.5
        else:
            start = 0
        turn: dict[str, Any] = {'idx': len(turns), 'speaker': speaker, 'text': u['content'].strip(), 'startS': start}
        if words:
            turn['endS'] = words[-1]['end']
            turn['words'] = [{'w': w.get('word') if w.get('word') is not None else '', 's': w['start'], 'e': w['end']} for w in words]
        if speaker == 'agent':
            turn['tags'] = extract_tags(u['content'])
        turns.append(turn)
    for i, t in enumerate(turns):
        if t.get('endS') is None:
            nxt = turns[i + 1] if i + 1 < len(turns) else None
            t['endS'] = estimate_end(t['startS'], t['text'], t['speaker'], nxt['startS'] if nxt is not None else None)

    # Walk the interleaved transcript to place tool calls on agent turns.
    tool_calls: list[dict] = []
    results: dict[Any, dict] = {}
    twtc = c.get('transcript_with_tool_calls')
    events = twtc if twtc is not None else []
    for e in events:
        if e.get('role') == 'tool_call_result':
            results[e.get('tool_call_id')] = e
    utt_seen = -1
    last_turn: dict | None = None
    pending_after_caller: list[dict] = []
    for e in events:
        if _is_utterance(e):
            utt_seen += 1
            ti = source_idx[utt_seen] if utt_seen < len(source_idx) else None
            if ti is None or ti < 0:
                continue
            last_turn = turns[ti]
            if last_turn['speaker'] == 'agent':
                for p in pending_after_caller:
                    p['turnIdx'] = last_turn['idx']
                pending_after_caller = []
            continue
        if e.get('role') != 'tool_call_invocation':
            continue
        inv = e
        res = results.get(inv.get('tool_call_id'))
        typ = inv.get('type')
        if truthy(typ) and typ != 'custom' and isinstance(typ, str) and typ in DEFAULT_TOOL_ALIASES:
            aliased = DEFAULT_TOOL_ALIASES[typ]
        elif typ == 'end_call':
            aliased = 'end_call'
        else:
            aliased = inv.get('name')
        tc: dict[str, Any] = {
            'id': inv.get('tool_call_id'),
            'turnIdx': last_turn['idx'] if last_turn is not None and last_turn['speaker'] == 'agent' else -1,
            'name': aliased if truthy(aliased) else inv.get('name'),
            'rawName': inv.get('name'),
            'args': js_parse_args(inv.get('arguments')),
        }
        if res is not None:
            content = res.get('content')
            if content is not None:
                tc['resultText'] = content
            if truthy(content):
                tc['result'] = js_parse_args(content)
            ok = res.get('successful')
            tc['ok'] = ok if ok is not None else not test(_ERROR, s_of(content) if content is not None else '')
        if last_turn is not None and last_turn.get('endS') is not None:
            tc['startS'] = last_turn['endS']
        if tc['turnIdx'] < 0:
            pending_after_caller.append(tc)
        tool_calls.append(tc)
    last_agent = next((t for t in reversed(turns) if t['speaker'] == 'agent'), None)
    for p in pending_after_caller:
        p['turnIdx'] = last_agent['idx'] if last_agent is not None else 0

    rdv, cdv = c.get('retell_llm_dynamic_variables'), c.get('collected_dynamic_variables')
    dyn: dict[str, Any] = {**(rdv if rdv is not None else {}), **(cdv if cdv is not None else {})}
    md = c.get('metadata') if isinstance(c.get('metadata'), dict) else {}

    def ms(v: Any) -> float | None:
        return v / 1000 if is_num(v) else None

    lat = c.get('latency') if c.get('latency') is not None else {}

    def latency(k: str, p: str) -> float | None:
        x = lat.get(k)
        return ms(x.get(p)) if x is not None else None

    if c.get('duration_ms') is not None:
        duration_s = js_number(c['duration_ms']) / 1000
    elif truthy(c.get('start_timestamp')) and truthy(c.get('end_timestamp')):
        duration_s = (c['end_timestamp'] - c['start_timestamp']) / 1000
    else:
        duration_s = turns[-1].get('endS') if turns and turns[-1].get('endS') is not None else 0

    ca = c.get('call_analysis')
    pa = None
    if truthy(ca):
        cad = ca.get('custom_analysis_data')
        pa = {
            'summary': ca.get('call_summary'),
            'successful': ca.get('call_successful'),
            'sentiment': ca.get('user_sentiment'),
        }
        if truthy(cad) and isinstance(cad, (dict, list)):
            items = cad.items() if isinstance(cad, dict) else ((str(i), v) for i, v in enumerate(cad))
            pa['dataCollection'] = {k: {'value': v} for k, v in items}

    multi, url = c.get('recording_multi_channel_url'), c.get('recording_url')
    cost = (c.get('call_cost') or {}).get('combined_cost') if isinstance(c.get('call_cost'), dict) else None
    st = c.get('start_timestamp')
    pv = dyn.get('prompt_version')
    lead_md = md.get('lead_id')
    lead_dv = dyn.get('lead_id')
    return {
        'provider': 'retell',
        'externalId': c.get('call_id'),
        'agentExternalId': c.get('agent_id'),
        'agentName': c.get('agent_name'),
        'agentVersion': s_of(c['agent_version']) if c.get('agent_version') is not None else None,
        'startedAt': iso(st if st is not None else now_ms()),
        'durationS': duration_s,
        'direction': c.get('direction') if c.get('direction') is not None else 'unknown',
        'endReason': map_disconnection(c.get('disconnection_reason'), ca.get('in_voicemail') if ca is not None else None),
        'endReasonRaw': c.get('disconnection_reason'),
        'language': dyn['language'] if isinstance(dyn.get('language'), str) else None,
        'fromNumber': c.get('from_number'),
        'toNumber': c.get('to_number'),
        'dynamicVariables': dyn,
        'turns': turns,
        'toolCalls': tool_calls,
        'recording': {'available': truthy(multi) or truthy(url), 'url': url, 'multiChannelUrl': multi, 'channels': 2 if truthy(multi) else 1 if truthy(url) else None},
        'providerAnalysis': pa,
        'latency': {'e2eP50': latency('e2e', 'p50'), 'e2eP90': latency('e2e', 'p90'), 'llmP50': latency('llm', 'p50'), 'llmP90': latency('llm', 'p90'), 'ttsP50': latency('tts', 'p50'), 'ttsP90': latency('tts', 'p90')},
        'cost': {'amount': cost / 100, 'currency': 'USD'} if is_num(cost) else None,
        'leadId': lead_md if lead_md is not None else (lead_dv if isinstance(lead_dv, str) else None),
        'promptVersionHint': pv if isinstance(pv, str) else md.get('prompt_version'),
    }


class _Retell:
    provider = 'retell'

    async def list_calls(self, creds: dict, *, since: datetime | None, cursor: Any, agent_id: str | None) -> dict:
        flt: dict[str, Any] = {}
        if agent_id:
            flt['agent'] = [{'agent_id': agent_id}]
        if since:
            flt['start_timestamp'] = {'op': 'ge', 'type': 'number', 'value': to_ms(since)}
        body: dict[str, Any] = {'filter_criteria': flt, 'limit': 100, 'sort_order': 'ascending'}
        if cursor:
            body['pagination_key'] = cursor
        page = await get_json(f'{_base(creds)}/v3/list-calls', {**_auth(creds), 'content-type': 'application/json'}, method='POST', body=js_json(body))
        items = page.get('items')
        return {
            'calls': [{'externalId': x.get('call_id'), 'startedAt': iso(x['start_timestamp']) if truthy(x.get('start_timestamp')) else None,
                       'complete': x.get('call_status') in ('ended', 'error', 'not_connected')} for x in (items if items is not None else [])],
            'cursor': page.get('pagination_key'),
            'done': not truthy(page.get('has_more')) or not truthy(page.get('pagination_key')),
        }

    async def fetch_call(self, creds: dict, external_id: str) -> dict:
        raw = await get_json(f'{_base(creds)}/v2/get-call/{enc_uri(external_id)}', _auth(creds))
        return {'canonical': normalise_retell(raw), 'raw': raw}

    def normalise(self, raw: Any) -> dict:
        return normalise_retell(raw)

    async def fetch_agent(self, creds: dict, agent_id: str, version: str | None = None) -> dict | None:
        q = f'?version={enc_uri(version)}' if version else ''
        a = await get_json(f'{_base(creds)}/get-agent/{enc_uri(agent_id)}{q}', _auth(creds))
        eng = (a.get('response_engine') if a is not None else None) or {}
        prompt = first_message = None
        cfg: dict[str, Any] = {'engine': eng.get('type')}
        if eng.get('type') == 'retell-llm' and truthy(eng.get('llm_id')):
            lq = f"?version={s_of(eng['version'])}" if eng.get('version') is not None else ''
            llm = await get_json(f"{_base(creds)}/get-retell-llm/{enc_uri(eng['llm_id'])}{lq}", _auth(creds))
            states = llm.get('states') if llm is not None else None
            states_text = '\n\n'.join(
                f"## State: {s_of(s['name']) if s.get('name') is not None else 'unnamed'}\n{s.get('state_prompt') if s.get('state_prompt') is not None else ''}" for s in states
            ) if isinstance(states, list) else ''
            gp = llm.get('general_prompt') if llm is not None else None
            prompt = '\n\n'.join(x for x in [gp if gp is not None else '', states_text] if truthy(x)) or None
            first_message = llm.get('begin_message') if llm is not None else None
            tools = llm.get('general_tools') if llm is not None else None
            cfg = {'engine': 'retell-llm', 'model': llm.get('model') if llm is not None else None,
                   'tools': [n for n in ((t.get('name') if t is not None else None) for t in (tools if tools is not None else [])) if truthy(n)]}
        return {'externalId': a.get('agent_id') if a.get('agent_id') is not None else agent_id, 'name': a.get('agent_name'), 'prompt': prompt,
                'firstMessage': first_message, 'providerVersion': s_of(a['version']) if a.get('version') is not None else None, 'config': cfg}

    async def list_agents(self, creds: dict) -> list[dict]:
        try:
            r = await get_json(f'{_base(creds)}/v2/list-agents', {**_auth(creds), 'content-type': 'application/json'}, method='POST', body=js_json({'limit': 100}))
        except Exception:
            r = await get_json(f'{_base(creds)}/list-agents', _auth(creds))
        items = r if isinstance(r, list) else ((r.get('items') if r is not None else None) or [])
        seen: dict[Any, Any] = {}
        for a in items:
            aid = a.get('agent_id') if a is not None else None
            if truthy(aid) and aid not in seen:
                seen[aid] = a.get('agent_name') if a.get('agent_name') is not None else aid
        return [{'id': k, 'name': v} for k, v in seen.items()]

    async def fetch_audio(self, creds: dict, call: dict) -> Response | None:
        rec = call.get('recording') or {}
        url = rec.get('multiChannelUrl') if rec.get('multiChannelUrl') is not None else rec.get('url')
        if not url:
            return None
        return await fetch_retry(url, timeout_ms=120_000, retries=2)

    def verify_webhook(self, raw_body: str, headers: dict[str, Any], creds: dict) -> bool:
        sig = header(headers, 'x-retell-signature')
        if not sig or not creds.get('apiKey'):
            return False
        m = _SIG.fullmatch(sig)
        if not m:
            return False
        ts = int(m.group(1))
        if ts > _MAX_SAFE or abs(now_ms() - ts) > 5 * 60 * 1000:
            return False
        digest = hmac.new(creds['apiKey'].encode(), (raw_body + m.group(1)).encode(), hashlib.sha256).digest()
        given = bytes.fromhex(m.group(2))
        return len(given) == len(digest) and hmac.compare_digest(given, digest)

    def parse_webhook(self, body: Any) -> dict:
        event = body.get('event') if isinstance(body, dict) else None
        call = body.get('call') if isinstance(body, dict) else None
        if not truthy(event) or not truthy(call.get('call_id') if isinstance(call, dict) else None):
            return {'kind': 'ignore', 'reason': 'not a call event'}
        if event in ('call_analyzed', 'call_ended'):
            return {'kind': 'call', 'externalId': call['call_id'], 'event': event, 'raw': call if isinstance(call.get('transcript_object'), list) else None}
        return {'kind': 'ignore', 'reason': f'unhandled event {s_of(event)}'}


retell = _Retell()
