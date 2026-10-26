// Audio logs: recordings from live calls and uploads, with where each one is in the pipeline.

import type { AudioRowDTO } from '@calleval/framework';
import { iso, type Db } from '../db';

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const STAGE: Record<string, number> = { ingested: 1, evaluating: 2, scored: 4, failed: 4 };

export async function recordings(db: Db, group: string | null): Promise<AudioRowDTO[]> {
  const rows: AudioRowDTO[] = [];
  const pending = await db.query("select * from upload where call_id is null or status in ('received','transcribing','failed') order by created_at desc limit 50");
  for (const u of pending) {
    const failed = u.status === 'failed';
    rows.push({
      id: u.id, callId: u.call_id, src: `Upload · ${u.filename}`, len: u.meta?.duration ? fmt(Number(u.meta.duration)) : '—',
      ch: u.meta?.channels === 2 ? 'Dual-channel' : u.meta?.channels === 1 ? 'Mono' : '—', stage: failed ? 1 : u.status === 'transcribing' ? 1 : 0,
      note: failed ? `Failed: ${String(u.meta?.error ?? 'see jobs').slice(0, 90)}` : u.status === 'transcribing' ? 'Transcribing' : 'Received', cqs: '—', link: false,
      group: failed ? 'attention' : 'pipeline', createdAt: iso(u.created_at)!,
    });
  }
  const calls = await db.query(
    `select c.call_id, c.external_id, c.provider, c.source, c.duration_s, c.recording_channels, c.has_audio, c.status, c.cqs, c.gated, c.needs_review, c.error, c.created_at, u.filename
     from calls c left join upload u on u.call_id = c.call_id
     where (c.has_audio or c.source = 'upload') and c.provider <> 'demo' order by c.started_at desc limit 200`,
  );
  for (const c of calls) {
    const attention = c.status === 'failed' || c.gated || c.needs_review || (c.source === 'upload' && !c.has_audio);
    const note = c.status === 'failed' ? `Pipeline error: ${String(c.error ?? '').slice(0, 80)}`
      : c.status !== 'scored' ? 'Segmenting, tagging and scoring'
      : c.gated ? 'Scored · gate failure, capped at 40'
      : c.needs_review ? 'Scored · tag queued for review'
      : c.recording_channels === 1 ? 'Scored · speakers from diarisation' : 'Scored';
    rows.push({
      id: c.external_id, callId: c.call_id, src: c.source === 'upload' ? `Upload · ${c.filename ?? 'recording'}` : `Live call · ${c.provider === 'elevenlabs' ? 'ElevenLabs' : 'Retell AI'}`,
      len: fmt(Number(c.duration_s)), ch: c.recording_channels === 2 ? 'Dual-channel' : c.recording_channels === 1 ? 'Mono' : '—',
      stage: STAGE[c.status] ?? 1, note, cqs: c.cqs === null ? '—' : String(Math.round(Number(c.cqs))), link: c.status === 'scored',
      group: attention ? 'attention' : c.status === 'scored' ? 'scored' : 'pipeline', createdAt: iso(c.created_at)!,
    });
  }
  return group ? rows.filter((r) => r.group === group) : rows;
}
