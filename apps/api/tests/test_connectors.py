import json
import time
from datetime import UTC, datetime

import pytest


from calleval.connectors.demo import generate_call, generate_demo_calls
from calleval.connectors.elevenlabs import elevenlabs, map_termination, normalise_elevenlabs
from calleval.connectors.retell import map_disconnection, normalise_retell, retell
from calleval.connectors.upload import stt_to_turns
from .fixtures import eleven_labs_conversation, eleven_labs_signature, retell_call, retell_signature


class TestElevenLabsNormalisation:
    c = normalise_elevenlabs(eleven_labs_conversation())

    def test_keeps_spoken_turns_and_drops_tool_only_items_and_backchannels(self):
        assert [t['speaker'] for t in self.c['turns']] == ['agent', 'caller', 'agent', 'caller', 'agent', 'agent', 'caller', 'agent', 'agent']
        assert not any(t['text'] == 'mm-hmm' for t in self.c['turns'])
        assert all(t['idx'] == i for i, t in enumerate(self.c['turns']))

    def test_estimates_turn_ends_that_never_overlap_the_next_turn(self):
        turns = self.c['turns']
        for i in range(len(turns) - 1):
            assert turns[i]['endS'] <= turns[i + 1]['startS']

    def test_attaches_tool_calls_to_the_agent_turn_that_made_them(self):
        assert len(self.c['toolCalls']) == 2
        details, docs = self.c['toolCalls']
        assert details['name'] == 'get_project_details' and details['ok'] is True and details['durationS'] == 0.8
        assert details['args'] == {'project': 'Treppan Tower', 'bedrooms': 1}
        assert details['result']['starting_price_aed'] == 1250000
        assert 'check the latest availability' in self.c['turns'][details['turnIdx']]['text']
        assert 'send the brochure' in self.c['turns'][docs['turnIdx']]['text']

    def test_maps_metadata_direction_lead_and_prompt_version(self):
        c = self.c
        expected = {'provider': 'elevenlabs', 'externalId': 'conv_01', 'agentExternalId': 'agent_el_1', 'agentVersion': 'agtvrsn_7', 'direction': 'outbound',
                    'endReason': 'natural_close', 'language': 'en', 'fromNumber': '+97140000000', 'toNumber': '+971500000001', 'leadId': 'lead_123',
                    'promptVersionHint': 'v7', 'cost': {'amount': 412, 'currency': 'credits'}}
        assert {k: c[k] for k in expected} == expected
        assert c['recording']['available'] is True
        assert c['turns'][2]['turnMetrics'] == {'convai_llm_service_ttfb': 0.62, 'convai_tts_service_ttfb': 0.21}
        assert c['providerAnalysis']['successful'] is True
        assert c['providerAnalysis']['dataCollection']['budget']['value'] == '1.5M AED'

    def test_maps_termination_reasons(self):
        assert map_termination('Remote party ended call') == 'caller_hangup'
        assert map_termination('Maximum duration exceeded') == 'time_limit'
        assert map_termination('voicemail detected') == 'voicemail'
        assert map_termination(None) == 'unknown'

    def test_parses_post_call_webhooks(self):
        data = eleven_labs_conversation('conv_9')
        assert elevenlabs.parse_webhook({'type': 'post_call_transcription', 'data': data}) == {'kind': 'call', 'externalId': 'conv_9', 'event': 'post_call_transcription', 'raw': data}
        assert elevenlabs.parse_webhook({'type': 'post_call_audio', 'data': {'conversation_id': 'conv_9'}})['kind'] == 'ignore'
        assert elevenlabs.parse_webhook({'hello': 'world'})['kind'] == 'ignore'


class TestRetellNormalisation:
    c = normalise_retell(retell_call())

    def test_builds_turns_from_word_timings_and_leaves_the_human_advisor_out(self):
        assert len(self.c['turns']) == 5
        assert not any('Ahmed' in t['text'] for t in self.c['turns'])
        assert self.c['turns'][0]['startS'] == pytest.approx(0.2)
        assert len(self.c['turns'][0]['words']) > 5

    def test_places_a_tool_call_made_after_the_caller_spoke_on_the_next_agent_turn(self):
        docs = next(t for t in self.c['toolCalls'] if t['name'] == 'send_documents')
        assert self.c['turns'][docs['turnIdx']]['speaker'] == 'agent'
        assert 'connect you' in self.c['turns'][docs['turnIdx']]['text']
        assert docs['args']['channel'] == 'whatsapp'

    def test_maps_provider_built_in_tools_onto_the_framework_names(self):
        xfer = next(t for t in self.c['toolCalls'] if t['rawName'] == 'transfer_to_sales')
        assert xfer['name'] == 'transfer_to_number'
        assert xfer['ok'] is True

    def test_converts_latency_cost_and_recording(self):
        c = self.c
        assert c['latency']['e2eP50'] == 1.1 and c['latency']['e2eP90'] == 2.3 and c['latency']['llmP90'] == 0.9 and c['latency']['ttsP50'] == 0.2
        assert c['cost'] == {'amount': 0.375, 'currency': 'USD'}
        assert c['recording']['available'] is True and c['recording']['channels'] == 2
        expected = {'direction': 'inbound', 'endReason': 'transfer', 'agentVersion': '3', 'leadId': 'lead_456', 'promptVersionHint': 'v2', 'durationS': 30}
        assert {k: c[k] for k in expected} == expected

    def test_maps_disconnection_reasons(self):
        assert map_disconnection('user_hangup') == 'caller_hangup'
        assert map_disconnection('agent_hangup') == 'natural_close'
        assert map_disconnection('dial_no_answer') == 'no_answer'
        assert map_disconnection('agent_hangup', True) == 'voicemail'
        assert map_disconnection('error_llm_websocket_open') == 'error'

    def test_parses_call_webhooks(self):
        call = retell_call('call_x')
        r = retell.parse_webhook({'event': 'call_analyzed', 'call': call})
        assert r['kind'] == 'call' and r['externalId'] == 'call_x' and r['raw'] == call
        # call_started carries no transcript yet: ignored.
        assert retell.parse_webhook({'event': 'call_started', 'call': {'call_id': 'call_x'}})['kind'] == 'ignore'


class TestWebhookSignatures:
    body = json.dumps({'event': 'call_analyzed', 'call': {'call_id': 'c1'}}, separators=(',', ':'))

    def test_retell_accepts_valid_and_rejects_tampering_staleness_and_a_wrong_key(self):
        creds = {'apiKey': 'key_retell_test', 'agentIds': []}
        b = self.body
        assert retell.verify_webhook(b, {'x-retell-signature': retell_signature('key_retell_test', b)}, creds) is True
        assert retell.verify_webhook(b + ' ', {'x-retell-signature': retell_signature('key_retell_test', b)}, creds) is False
        assert retell.verify_webhook(b, {'x-retell-signature': retell_signature('key_retell_test', b, int(time.time() * 1000) - 10 * 60_000)}, creds) is False
        assert retell.verify_webhook(b, {'x-retell-signature': retell_signature('other_key', b)}, creds) is False
        assert retell.verify_webhook(b, {}, creds) is False

    def test_elevenlabs_accepts_valid_and_rejects_tampering_staleness_and_a_missing_secret(self):
        creds = {'apiKey': 'xi_key', 'webhookSecret': 'wsec_test', 'agentIds': []}
        b = self.body
        assert elevenlabs.verify_webhook(b, {'elevenlabs-signature': eleven_labs_signature('wsec_test', b)}, creds) is True
        assert elevenlabs.verify_webhook(b.replace('c1', 'c2'), {'elevenlabs-signature': eleven_labs_signature('wsec_test', b)}, creds) is False
        assert elevenlabs.verify_webhook(b, {'elevenlabs-signature': eleven_labs_signature('wsec_test', b, int(time.time()) - 3600)}, creds) is False
        assert elevenlabs.verify_webhook(b, {'elevenlabs-signature': eleven_labs_signature('wsec_test', b)}, {**creds, 'webhookSecret': None}) is False


def test_turns_a_two_channel_transcript_into_ordered_agent_and_caller_turns():
    def w(text, start):
        return [{'text': x, 'start': start + i * 0.3, 'end': start + i * 0.3 + 0.25, 'type': 'word'} for i, x in enumerate(text.split(' '))]

    stt = {'transcripts': [
        {'language_code': 'en', 'text': '', 'channel_index': 0, 'words': w('Hello this is Sara', 0) + w('Which project interests you?', 6)},
        {'language_code': 'en', 'text': '', 'channel_index': 1, 'words': w('Hi I saw your ad', 2.5)},
    ]}
    r = stt_to_turns(stt, {'layout': 'al'})
    assert [t['speaker'] for t in r['turns']] == ['agent', 'caller', 'agent']
    assert r['language'] == 'en'


class TestDemoGenerator:
    def test_is_deterministic_for_a_seed_and_time(self):
        at = datetime(2026, 10, 1, 10, tzinfo=UTC)
        assert generate_call(1001, at=at, version='v3') == generate_call(1001, at=at, version='v3')
        now = datetime(2026, 10, 26, 12, tzinfo=UTC)
        a, b = generate_demo_calls(count=40, days=30, now=now), generate_demo_calls(count=40, days=30, now=now)
        assert a == b
        assert [c['startedAt'] for c in a] == sorted(c['startedAt'] for c in a)

    def test_builds_calls_shaped_like_a_provider_export(self):
        c = generate_call(77, at=datetime(2026, 10, 1, 10, tzinfo=UTC), version='v2', pi=0, si=0)
        assert c['provider'] == 'demo' and c['dynamicVariables']['demo_persona'] == 'P1' and c['dynamicVariables']['demo_scenario'] == 'S1'
        assert all(t['idx'] == i for i, t in enumerate(c['turns']))
        assert all(c['turns'][tc['turnIdx']]['speaker'] == 'agent' for tc in c['toolCalls'] if 0 <= tc['turnIdx'] < len(c['turns']))
        assert c['startedAt'] == '2026-10-01T10:00:00.000Z' and c['leadId'] == 'lead_77'
