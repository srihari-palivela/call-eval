# Provider payloads shaped like the official SDKs' wire types, plus helpers to sign webhooks,
# stub provider HTTP and drain the job queue in tests.

from __future__ import annotations

import copy
import hashlib
import hmac
import json
import re
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import urlparse

import httpx


def eleven_labs_conversation(id: str = 'conv_01', start_unix: int | None = None) -> dict:
    """An ElevenLabs conversation (GET /v1/convai/conversations/{id}): an investor asking for a brochure."""
    start_unix = int(time.time()) - 3600 if start_unix is None else start_unix
    return {
        'agent_id': 'agent_el_1',
        'agent_name': 'Fakhruddin outbound',
        'conversation_id': id,
        'version_id': 'agtvrsn_7',
        'status': 'done',
        'has_audio': True,
        'has_user_audio': True,
        'has_response_audio': True,
        'transcript': [
            {'role': 'agent', 'message': 'Hi, this is Sara from Fakhruddin Properties. Am I speaking with Omar?', 'time_in_call_secs': 0},
            {'role': 'user', 'message': 'Yes, this is Omar.', 'time_in_call_secs': 5},
            {
                'role': 'agent', 'message': 'Thanks for your enquiry about Treppan Tower, Omar. Are you looking at it as an investment, or to live in yourself?', 'time_in_call_secs': 7,
                'conversation_turn_metrics': {'metrics': {'convai_llm_service_ttfb': {'elapsed_time': 0.62}, 'convai_tts_service_ttfb': {'elapsed_time': 0.21}}},
            },
            {'role': 'user', 'message': "It's an investment. I want rental income, budget around one and a half million.", 'time_in_call_secs': 14},
            {'role': 'user', 'message': 'mm-hmm', 'time_in_call_secs': 18, 'ignored_as_backchannel': True},
            {
                'role': 'agent', 'message': 'Let me check the latest availability for you.', 'time_in_call_secs': 19,
                'tool_calls': [{'request_id': 'tc_1', 'tool_name': 'get_project_details', 'params_as_json': '{"project":"Treppan Tower","bedrooms":1}', 'tool_has_been_called': True, 'type': 'webhook'}],
            },
            {'role': 'agent', 'message': None, 'time_in_call_secs': 20, 'tool_results': [{'request_id': 'tc_1', 'tool_name': 'get_project_details', 'result_value': '{"starting_price_aed":1250000,"handover":"Q4 2027"}', 'is_error': False, 'tool_latency_secs': 0.8, 'type': 'webhook'}]},
            {'role': 'agent', 'message': 'One-bedroom apartments start at one point two five million dirhams, with handover in the last quarter of 2027.', 'time_in_call_secs': 22},
            {'role': 'user', 'message': 'Okay. Can you send me the brochure on WhatsApp?', 'time_in_call_secs': 31},
            {
                'role': 'agent', 'message': 'Of course. I will send the brochure to this number on WhatsApp.', 'time_in_call_secs': 34,
                'tool_calls': [{'request_id': 'tc_2', 'tool_name': 'send_documents', 'params_as_json': '{"project":"Treppan Tower","document":"brochure","channel":"whatsapp"}', 'tool_has_been_called': True, 'type': 'webhook'}],
            },
            {'role': 'agent', 'message': None, 'time_in_call_secs': 35, 'tool_results': [{'request_id': 'tc_2', 'tool_name': 'send_documents', 'result_value': '{"status":"sent"}', 'is_error': False, 'tool_latency_secs': 0.5, 'type': 'webhook'}]},
            {'role': 'agent', 'message': 'It is in your WhatsApp now. Thank you, Omar, and have a lovely day.', 'time_in_call_secs': 37, 'interrupted': False},
        ],
        'metadata': {
            'start_time_unix_secs': start_unix,
            'call_duration_secs': 44,
            'termination_reason': 'end_call tool was called.',
            'main_language': 'en',
            'cost': 412,
            'phone_call': {'direction': 'outbound', 'agent_number': '+97140000000', 'external_number': '+971500000001'},
        },
        'analysis': {
            'call_successful': 'success',
            'transcript_summary': 'Omar is an investor interested in Treppan Tower; the brochure was sent on WhatsApp.',
            'evaluation_criteria_results': {'brochure_sent': {'criteria_id': 'brochure_sent', 'result': 'success', 'rationale': 'Sent on WhatsApp.'}},
            'data_collection_results': {'budget': {'data_collection_id': 'budget', 'value': '1.5M AED', 'rationale': 'Stated by caller.'}},
        },
        'conversation_initiation_client_data': {'dynamic_variables': {'lead_id': 'lead_123', 'prompt_version': 'v7', 'customer_name': 'Omar'}},
    }


def _words(text: str, start: float) -> list[dict]:
    out, t = [], start
    for w in re.split(r'\s+', text):
        s = t
        t += 0.35
        out.append({'word': w, 'start': round(s, 2), 'end': round(s + 0.3, 2)})
    return out


def retell_call(id: str = 'call_abc', start_ms: int | None = None) -> dict:
    """A Retell call (GET /v2/get-call/{id}): a caller asks for a person and is transferred."""
    start_ms = int(time.time() * 1000) - 2 * 3600_000 if start_ms is None else start_ms

    def u(role: str, content: str, start: float) -> dict:
        return {'role': role, 'content': content, 'words': _words(content, start)}

    t = [
        u('agent', 'Thank you for calling Fakhruddin Properties, this is Sara. How can I help?', 0.2),
        u('user', 'Hi, I would like to know about Hatta Lakes. Can you send me the floor plans?', 5),
        u('agent', 'Of course. Shall I send them to this number on WhatsApp?', 10.5),
        u('user', 'Yes please. And can I speak to someone now?', 14),
        u('agent', 'Let me connect you with one of our advisors, one moment please.', 18),
        u('transfer_target', 'Hello, this is Ahmed from the sales team.', 25),
    ]
    return {
        'call_id': id,
        'call_type': 'phone_call',
        'agent_id': 'agent_rt_1',
        'agent_name': 'Fakhruddin inbound',
        'agent_version': 3,
        'call_status': 'ended',
        'direction': 'inbound',
        'from_number': '+971500000002',
        'to_number': '+97140000001',
        'start_timestamp': start_ms,
        'end_timestamp': start_ms + 30_000,
        'duration_ms': 30_000,
        'disconnection_reason': 'call_transfer',
        'transcript_object': t,
        'transcript_with_tool_calls': [
            t[0], t[1],
            # The documents tool fires after the caller's yes, before the agent speaks again.
            t[2], t[3],
            {'role': 'tool_call_invocation', 'tool_call_id': 'tc_doc', 'name': 'send_documents', 'arguments': '{"project":"Hatta Lakes","document":"floor_plans","channel":"whatsapp"}', 'type': 'custom'},
            {'role': 'tool_call_result', 'tool_call_id': 'tc_doc', 'content': '{"status":"sent"}', 'successful': True},
            t[4],
            {'role': 'tool_call_invocation', 'tool_call_id': 'tc_xfer', 'name': 'transfer_to_sales', 'arguments': '{}', 'type': 'transfer_call'},
            {'role': 'tool_call_result', 'tool_call_id': 'tc_xfer', 'content': 'transferred', 'successful': True},
            t[5],
        ],
        'recording_url': 'https://recordings.example.com/call_abc.wav',
        'recording_multi_channel_url': 'https://recordings.example.com/call_abc_multi.wav',
        'latency': {'e2e': {'p50': 1100, 'p90': 2300}, 'llm': {'p50': 600, 'p90': 900}, 'tts': {'p50': 200, 'p90': 350}},
        'call_analysis': {'call_summary': 'Caller asked about Hatta Lakes and was transferred.', 'user_sentiment': 'Positive', 'call_successful': True, 'in_voicemail': False, 'custom_analysis_data': {'project': 'Hatta Lakes'}},
        'retell_llm_dynamic_variables': {'lead_id': 'lead_456', 'prompt_version': 'v2'},
        'call_cost': {'combined_cost': 37.5},
    }


def retell_signature(api_key: str, body: str, ms: int | None = None) -> str:
    ms = int(time.time() * 1000) if ms is None else ms
    return f"v={ms},d={hmac.new(api_key.encode(), (body + str(ms)).encode(), hashlib.sha256).hexdigest()}"


def eleven_labs_signature(secret: str, body: str, s: int | None = None) -> str:
    s = int(time.time()) if s is None else s
    return f"t={s},v0={hmac.new(secret.encode(), f'{s}.{body}'.encode(), hashlib.sha256).hexdigest()}"


Route = tuple[str, Callable[[httpx.URL, dict], Any]]


def stub_http(monkeypatch, routes: list[Route]) -> list[str]:
    """Replace provider HTTP with canned JSON responses (regex over the URL path); unknown URLs get a 404.
    Returns the list of requests made, as 'METHOD /path?query'."""
    import calleval.lib.http as http

    calls: list[str] = []

    async def send(method: str, url: str, *, headers=None, content=None, data=None, files=None, timeout=30.0):
        u = httpx.URL(url)
        calls.append(f"{method} {u.path}{'?' + u.query.decode() if u.query else ''}")
        req = {'method': method, 'headers': headers or {}, 'content': content, 'data': data, 'files': files}
        for rx, fn in routes:
            if re.search(rx, u.path):
                v = fn(u, req)
                if isinstance(v, httpx.Response):
                    return v
                return httpx.Response(200, json=v, request=httpx.Request(method, url))
        return httpx.Response(404, json={'detail': 'not found'}, request=httpx.Request(method, url))

    monkeypatch.setattr(http, 'send', send)
    return calls


async def drain(db, max: int = 200) -> list[dict]:
    """Run queued jobs until the queue is empty, as the worker would: claimed across workspaces, each run in its own."""
    from calleval.jobs.handlers import run_job
    from calleval.jobs.queue import claim, complete, fail
    from calleval.tenancy import in_workspace

    sys_db = db.as_system()
    ran = []
    for _ in range(max):
        job = await claim(sys_db, 'test')
        if not job:
            break
        try:
            with in_workspace(job['workspace_id']):
                await run_job(db, job)
            await complete(sys_db, job['id'])
            ran.append({'kind': job['kind'], 'ok': True, 'workspace': job['workspace_id']})
        except Exception as e:  # noqa: BLE001 - a failed job is reported, not raised
            await fail(sys_db, {**job, 'attempts': job['max_attempts']}, str(e))
            ran.append({'kind': job['kind'], 'ok': False, 'error': repr(e), 'workspace': job['workspace_id']})
    return ran


def path_of(url: str) -> str:
    return urlparse(url).path


def clone(v: Any) -> Any:
    return copy.deepcopy(json.loads(json.dumps(v)))
