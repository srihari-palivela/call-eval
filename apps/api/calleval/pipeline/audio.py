# Step 7: audio checks. Emotion, naturalness and prosody models are heavy and change often, so they
# run behind a small HTTP contract (AUDIO_MODEL_URL) rather than inside this service. See
# docs/audio-model.md for the contract; any speech-emotion model plus a MOS predictor (e.g. UTMOS)
# can sit behind it. Without it, the transcript-side emotion metrics still apply.

from __future__ import annotations

import math
import time
from typing import Any

import httpx

from ..config import config
from ..js import fixed, js_json, js_round, to_fixed
from ..lib.http import fetch_retry
from ..lib.log import err_msg, log
from .text import RX, lc

# AudioTurn: {idx, valence?, arousal?, mos?, monotone?, artefacts?, tag_match?, wpm?}
# AudioResult: {usable, turns: [AudioTurn], consistency_ok?, model?, latencyMs}


async def analyse_audio(call: dict, audio: httpx.Response | None) -> dict | None:
    if not config.audio_model_url or audio is None:
        return None
    t0 = time.monotonic()
    try:
        buf = audio.content
        meta = js_json({
            'call_id': call['externalId'],
            'channels': (call.get('recording') or {}).get('channels') or 1,
            'agent_channel': 0,
            'turns': [{'idx': t['idx'], 'speaker': t['speaker'], 'start': t['startS'], 'end': t.get('endS'), 'tags': t.get('tags') or []} for t in call['turns']],
        })
        files = {'audio': ('call-audio', buf, audio.headers.get('content-type') or 'audio/mpeg'), 'meta': (None, meta)}
        res = await fetch_retry(f"{config.audio_model_url.rstrip('/')}/analyze", method='POST', files=files, timeout_ms=300_000, retries=1)
        body = res.json()
        return {**body, 'latencyMs': int((time.monotonic() - t0) * 1000)}
    except Exception as e:  # noqa: BLE001 - the call is still scored without the audio model
        log.warn('audio model failed; continuing with transcript-side emotion metrics', {'call': call['externalId'], 'error': err_msg(e)})
        return None


def _get(t: Any, k: str) -> Any:
    return t.get(k) if isinstance(t, dict) else None


def audio_metrics(call: dict, a: dict) -> dict[str, dict]:
    """Audio-model metrics in their raw units. Missing values leave the transcript-side result in place."""
    out: dict[str, dict] = {}
    if not a.get('usable'):
        return out
    by_idx = {t['idx']: t for t in a.get('turns') or []}
    caller = [t for t in call['turns'] if t['speaker'] == 'caller' and _get(by_idx.get(t['idx']), 'valence') is not None]
    agent = [t for t in call['turns'] if t['speaker'] == 'agent']
    if len(caller) >= 2:
        def v(i: int) -> float:
            return by_idx[caller[i]['idx']]['valence']

        start = (v(0) + v(1)) / 2 if len(caller) >= 4 else v(0)
        end = (v(len(caller) - 1) + v(len(caller) - 2)) / 2 if len(caller) >= 4 else v(len(caller) - 1)
        out['cet'] = {'raw': fixed(end - start, 2), 'applicable': True, 'evidence': [caller[0]['idx'], caller[-1]['idx']],
                      'rationale': f'Caller valence {to_fixed(start, 2)} → {to_fixed(end, 2)} (speech emotion model).'}

        def is_frus(i: int, t: dict) -> bool:
            c = by_idx[t['idx']]
            p = by_idx.get(caller[i - 1]['idx']) if i > 0 else None
            return (c.get('valence') or 0) < -0.3 and (c.get('arousal') or 0) > ((p or {}).get('arousal') or 0)

        frus = [t for i, t in enumerate(caller) if is_frus(i, t)]
        if frus:
            def acked_fn(f: dict) -> bool:
                n = next((t for t in call['turns'] if t['idx'] > f['idx'] and t['speaker'] == 'agent'), None)
                return bool(n is not None and RX['empathy'].search(lc(n['text'])))

            acked = [f for f in frus if acked_fn(f)]
            out['fe'] = {'raw': fixed((len(acked) / len(frus)) * 100, 1), 'applicable': True, 'evidence': [f['idx'] for f in frus]}

        def is_over(t: dict) -> bool:
            at_ = by_idx.get(t['idx'])
            prev = call['turns'][t['idx'] - 1] if t['idx'] - 1 >= 0 and t['idx'] - 1 < len(call['turns']) else None
            ct = by_idx.get(prev['idx']) if prev is not None else None
            return _get(at_, 'arousal') is not None and _get(ct, 'arousal') is not None and at_['arousal'] - ct['arousal'] > 0.3

        over = [t for t in agent if is_over(t)]
        out['od'] = {'raw': len(over), 'applicable': True, 'evidence': [o['idx'] for o in over]}
    mos = [x for x in (_get(by_idx.get(t['idx']), 'mos') for t in agent) if isinstance(x, (int, float)) and not isinstance(x, bool)]
    if mos:
        out['mos'] = {'raw': fixed(sum(mos) / len(mos), 2), 'applicable': True, 'evidence': []}
    mono = [t for t in agent if _get(by_idx.get(t['idx']), 'monotone') is not None]
    if mono:
        bad = [t for t in mono if by_idx[t['idx']]['monotone']]
        out['iv'] = {'raw': fixed((len(bad) / len(mono)) * 100, 1), 'applicable': True, 'evidence': [t['idx'] for t in bad]}
    tagged = [t for t in agent if isinstance(_get(by_idx.get(t['idx']), 'tag_match'), bool)]
    if tagged:
        out['tdel'] = {'raw': fixed((len([t for t in tagged if by_idx[t['idx']]['tag_match']]) / len(tagged)) * 100, 1), 'applicable': True,
                       'evidence': [t['idx'] for t in tagged if not by_idx[t['idx']]['tag_match']]}
    art = sum((_get(by_idx.get(t['idx']), 'artefacts') or 0) for t in agent)
    if any(_get(by_idx.get(t['idx']), 'artefacts') is not None for t in agent):
        out['aart'] = {'raw': art, 'applicable': True, 'evidence': [t['idx'] for t in agent if (_get(by_idx.get(t['idx']), 'artefacts') or 0) > 0]}
    if isinstance(a.get('consistency_ok'), bool):
        out['cons'] = {'raw': 1 if a['consistency_ok'] else 0, 'applicable': True, 'evidence': []}
    wpm = sorted(x for x in (_get(by_idx.get(t['idx']), 'wpm') for t in agent) if isinstance(x, (int, float)) and not isinstance(x, bool))
    if wpm:
        out['srate'] = {'raw': js_round(wpm[math.floor(len(wpm) / 2)]), 'applicable': True, 'evidence': []}
    return out
