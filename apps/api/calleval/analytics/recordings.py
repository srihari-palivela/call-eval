# Audio logs: recordings from live calls and uploads, with where each one is in the pipeline.

from __future__ import annotations

from ..js import iso, js_number, js_round

_STAGE = {'ingested': 1, 'evaluating': 2, 'scored': 4, 'failed': 4}


def _fmt(s: float) -> str:
    t = js_round(s)  # round first, so 119.6 s reads 2:00, not 1:60
    return f'{t // 60}:{t % 60:02d}'


async def recordings(db, group: str | None) -> list[dict]:
    rows = []
    pending = await db.query("select * from upload where call_id is null or status in ('received','transcribing','failed') order by created_at desc limit 50")
    for u in pending:
        failed = u['status'] == 'failed'
        meta = u['meta'] or {}
        err = meta.get('error')
        rows.append({
            'id': u['id'], 'callId': u['call_id'], 'src': f"Upload · {u['filename']}", 'len': _fmt(js_number(meta['duration'])) if meta.get('duration') else '—',
            'ch': 'Dual-channel' if meta.get('channels') == 2 else 'Mono' if meta.get('channels') == 1 else '—', 'stage': 1 if failed else 1 if u['status'] == 'transcribing' else 0,
            'note': f"Failed: {str(err if err is not None else 'see jobs')[:90]}" if failed else 'Transcribing' if u['status'] == 'transcribing' else 'Received', 'cqs': '—', 'link': False,
            'group': 'attention' if failed else 'pipeline', 'createdAt': iso(u['created_at']),
        })
    calls = await db.query(
        """select c.call_id, c.external_id, c.provider, c.source, c.duration_s, c.recording_channels, c.has_audio, c.status, c.cqs, c.gated, c.needs_review, c.error, c.created_at, u.filename
     from calls c left join upload u on u.call_id = c.call_id
     where (c.has_audio or c.source = 'upload') and c.provider <> 'demo' order by c.started_at desc limit 200""",
    )
    for c in calls:
        attention = c['status'] == 'failed' or bool(c['gated']) or bool(c['needs_review']) or (c['source'] == 'upload' and not c['has_audio'])
        note = (f"Pipeline error: {str(c['error'] if c['error'] is not None else '')[:80]}" if c['status'] == 'failed'
                else 'Segmenting, tagging and scoring' if c['status'] != 'scored'
                else 'Scored · gate failure, capped at 40' if c['gated']
                else 'Scored · tag queued for review' if c['needs_review']
                else 'Scored · speakers from diarisation' if c['recording_channels'] == 1 else 'Scored')
        rows.append({
            'id': c['external_id'], 'callId': c['call_id'],
            'src': f"Upload · {c['filename'] if c['filename'] is not None else 'recording'}" if c['source'] == 'upload' else f"Live call · {'ElevenLabs' if c['provider'] == 'elevenlabs' else 'Retell AI'}",
            'len': _fmt(js_number(c['duration_s'])), 'ch': 'Dual-channel' if c['recording_channels'] == 2 else 'Mono' if c['recording_channels'] == 1 else '—',
            'stage': _STAGE.get(c['status'], 1), 'note': note, 'cqs': '—' if c['cqs'] is None else str(js_round(js_number(c['cqs']))), 'link': c['status'] == 'scored',
            'group': 'attention' if attention else 'scored' if c['status'] == 'scored' else 'pipeline', 'createdAt': iso(c['created_at']),
        })
    return [r for r in rows if r['group'] == group] if group else rows
