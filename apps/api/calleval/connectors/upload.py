# Uploaded recordings go through the same pipeline as live calls. The recording is transcribed with
# ElevenLabs Speech-to-Text (Scribe): dual-channel files are transcribed per channel, so agent and
# caller are separated cleanly; mono files are diarised.
#   POST /v1/speech-to-text  multipart: file, model_id, diarize, use_multi_channel, timestamps_granularity

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from ..config import config
from ..js import jsre
from ..lib.http import fetch_retry
from .types import is_num, s_of

_PUNCT_SPACE = jsre(r'\s+([,.!?;:])', 'gu')

# UploadMeta: {uploadId, filename, filePath, mime, direction, promptVersion, layout ('al' | 'cl'), channels,
#              conversationId, startedAt}


async def transcribe(file_path: str, filename: str, mime: str | None, channels: int | None, api_key: str) -> dict:
    buf = await asyncio.to_thread(Path(file_path).read_bytes)
    data = {'model_id': config.stt_model, 'timestamps_granularity': 'word', 'tag_audio_events': 'false'}
    if channels == 2:
        data['use_multi_channel'] = 'true'
    else:
        data['diarize'] = 'true'
        data['num_speakers'] = '2'
    files = {'file': (filename, buf, mime if mime is not None else 'application/octet-stream')}
    res = await fetch_retry('https://api.elevenlabs.io/v1/speech-to-text', method='POST', headers={'xi-api-key': api_key},
                            data=data, files=files, timeout_ms=600_000, retries=2)
    return res.json()


def stt_to_turns(stt: dict, meta: dict) -> dict:
    """Group words into turns: consecutive words from the same speaker (or channel) form one turn."""
    words: list[dict[str, Any]] = []
    language = None
    duration: Any = 0
    if 'transcripts' in stt:
        for ch in stt['transcripts']:
            if language is None:
                language = ch.get('language_code')
            idx = ch.get('channel_index') if ch.get('channel_index') is not None else 0
            for w in (ch.get('words') if ch.get('words') is not None else []):
                if w.get('type') == 'word' and is_num(w.get('start')):
                    words.append({'text': w.get('text'), 's': w['start'], 'e': w['end'] if w.get('end') is not None else w['start'], 'who': f'ch{s_of(idx)}'})
        duration = stt.get('audio_duration_secs') if stt.get('audio_duration_secs') is not None else 0
    else:
        language = stt.get('language_code')
        for w in (stt.get('words') if stt.get('words') is not None else []):
            if w.get('type') == 'word' and is_num(w.get('start')):
                words.append({'text': w.get('text'), 's': w['start'], 'e': w['end'] if w.get('end') is not None else w['start'],
                              'who': w['speaker_id'] if w.get('speaker_id') is not None else 'speaker_0'})
        duration = stt.get('audio_duration_secs') if stt.get('audio_duration_secs') is not None else 0
    words.sort(key=lambda w: w['s'])
    # Agent identity: on dual-channel audio the layout says which channel is the agent; on mono the agent
    # is the first speaker (it greets on both inbound and outbound calls).
    if any(w['who'].startswith('ch') for w in words):
        agent_key = 'ch0' if meta.get('layout') == 'al' else 'ch1'
    else:
        agent_key = words[0]['who'] if words else None
    turns: list[dict] = []
    cur: dict | None = None

    def flush() -> None:
        if cur is None or not cur['ws']:
            return
        speaker = 'agent' if cur['who'] == agent_key else 'caller'
        joined = ' '.join('' if w['text'] is None else s_of(w['text']) for w in cur['ws'])
        text = _PUNCT_SPACE.sub(r'\1', joined).strip()
        turns.append({'idx': len(turns), 'speaker': speaker, 'text': text, 'startS': cur['ws'][0]['s'], 'endS': cur['ws'][-1]['e'],
                      'words': [{'w': w['text'], 's': w['s'], 'e': w['e']} for w in cur['ws']]})

    for w in words:
        # A new turn starts on a speaker change, or after a long pause from the same speaker crossing the other's speech.
        if cur is None or cur['who'] != w['who']:
            flush()
            cur = {'who': w['who'], 'ws': []}
        cur['ws'].append(w)
    flush()
    if not duration:
        duration = turns[-1]['endS'] if turns and turns[-1].get('endS') is not None else 0
    return {'turns': turns, 'language': language, 'duration': duration}


async def upload_to_canonical(meta: dict) -> dict:
    if not config.stt_api_key:
        raise RuntimeError('Transcribing uploads needs an ElevenLabs API key (ELEVENLABS_STT_API_KEY or ELEVENLABS_API_KEY).')
    stt = await transcribe(meta['filePath'], meta['filename'], meta.get('mime'), meta.get('channels'), config.stt_api_key)
    r = stt_to_turns(stt, meta)
    return {
        'provider': 'upload',
        'externalId': meta.get('conversationId') or meta['uploadId'],
        'agentExternalId': None,
        'agentName': 'Uploaded recordings',
        'agentVersion': None,
        'startedAt': meta['startedAt'],
        'durationS': r['duration'],
        'direction': meta['direction'],
        'endReason': 'unknown',
        'endReasonRaw': None,
        'language': r['language'],
        'dynamicVariables': {},
        'turns': r['turns'],
        'toolCalls': [],
        'recording': {'available': True, 'url': str(Path(meta['filePath']).resolve()), 'multiChannelUrl': None, 'channels': meta.get('channels')},
        'providerAnalysis': None,
        'latency': None,
        'cost': None,
        'leadId': None,
        'promptVersionHint': meta.get('promptVersion'),
    }
