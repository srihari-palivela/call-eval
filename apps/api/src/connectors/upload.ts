// Uploaded recordings go through the same pipeline as live calls. The recording is transcribed with
// ElevenLabs Speech-to-Text (Scribe): dual-channel files are transcribed per channel, so agent and
// caller are separated cleanly; mono files are diarised.
//   POST /v1/speech-to-text  multipart: file, model_id, diarize, use_multi_channel, timestamps_granularity

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CanonicalCall, CanonicalTurn, Direction } from '@calleval/framework';
import { config } from '../config';
import { fetchRetry } from '../lib/http';

type SttWord = { text: string; start?: number | null; end?: number | null; type: 'word' | 'spacing' | 'audio_event'; speaker_id?: string | null; channel_index?: number | null };
type SttChunk = { language_code: string; text: string; words: SttWord[]; channel_index?: number | null; audio_duration_secs?: number | null };
type SttMulti = { transcripts: SttChunk[]; audio_duration_secs?: number | null };

export type UploadMeta = { uploadId: string; filename: string; filePath: string; mime: string | null; direction: Direction; promptVersion: string | null; layout: 'al' | 'cl'; channels: number | null; conversationId: string | null; startedAt: string };

export async function transcribe(filePath: string, filename: string, mime: string | null, channels: number | null, apiKey: string): Promise<SttChunk | SttMulti> {
  const buf = await readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime ?? 'application/octet-stream' }), filename);
  form.append('model_id', process.env.ELEVENLABS_STT_MODEL ?? 'scribe_v2');
  form.append('timestamps_granularity', 'word');
  form.append('tag_audio_events', 'false');
  if (channels === 2) form.append('use_multi_channel', 'true');
  else { form.append('diarize', 'true'); form.append('num_speakers', '2'); }
  const res = await fetchRetry('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': apiKey }, body: form, timeoutMs: 600_000, retries: 2 });
  return (await res.json()) as SttChunk | SttMulti;
}

/** Group words into turns: consecutive words from the same speaker (or channel) form one turn. */
export function sttToTurns(stt: SttChunk | SttMulti, meta: Pick<UploadMeta, 'layout'>): { turns: CanonicalTurn[]; language: string | null; duration: number } {
  type W = { text: string; s: number; e: number; who: string };
  const words: W[] = [];
  let language: string | null = null;
  let duration = 0;
  if ('transcripts' in stt) {
    for (const ch of stt.transcripts) {
      language ??= ch.language_code ?? null;
      const idx = ch.channel_index ?? 0;
      for (const w of ch.words ?? []) if (w.type === 'word' && typeof w.start === 'number') words.push({ text: w.text, s: w.start, e: w.end ?? w.start, who: `ch${idx}` });
    }
    duration = stt.audio_duration_secs ?? 0;
  } else {
    language = stt.language_code ?? null;
    for (const w of stt.words ?? []) if (w.type === 'word' && typeof w.start === 'number') words.push({ text: w.text, s: w.start, e: w.end ?? w.start, who: w.speaker_id ?? 'speaker_0' });
    duration = stt.audio_duration_secs ?? 0;
  }
  words.sort((a, b) => a.s - b.s);
  // Agent identity: on dual-channel audio the layout says which channel is the agent; on mono the agent
  // is the first speaker (it greets on both inbound and outbound calls).
  const agentKey = words.some((w) => w.who.startsWith('ch')) ? (meta.layout === 'al' ? 'ch0' : 'ch1') : words[0]?.who;
  const turns: CanonicalTurn[] = [];
  let cur: { who: string; ws: W[] } | null = null;
  const flush = () => {
    if (!cur || !cur.ws.length) return;
    const speaker = cur.who === agentKey ? 'agent' : 'caller';
    const text = cur.ws.map((w) => w.text).join(' ').replace(/\s+([,.!?;:])/g, '$1').trim();
    turns.push({ idx: turns.length, speaker, text, startS: cur.ws[0].s, endS: cur.ws[cur.ws.length - 1].e, words: cur.ws.map((w) => ({ w: w.text, s: w.s, e: w.e })) });
  };
  for (const w of words) {
    // A new turn starts on a speaker change, or after a long pause from the same speaker crossing the other's speech.
    if (!cur || cur.who !== w.who) { flush(); cur = { who: w.who, ws: [] }; }
    cur.ws.push(w);
  }
  flush();
  if (!duration) duration = turns[turns.length - 1]?.endS ?? 0;
  return { turns, language, duration };
}

export async function uploadToCanonical(meta: UploadMeta): Promise<CanonicalCall> {
  if (!config.sttApiKey) throw new Error('Transcribing uploads needs an ElevenLabs API key (ELEVENLABS_STT_API_KEY or ELEVENLABS_API_KEY).');
  const stt = await transcribe(meta.filePath, meta.filename, meta.mime, meta.channels, config.sttApiKey);
  const { turns, language, duration } = sttToTurns(stt, meta);
  return {
    provider: 'upload',
    externalId: meta.conversationId || meta.uploadId,
    agentExternalId: null,
    agentName: 'Uploaded recordings',
    agentVersion: null,
    startedAt: meta.startedAt,
    durationS: duration,
    direction: meta.direction,
    endReason: 'unknown',
    endReasonRaw: null,
    language,
    dynamicVariables: {},
    turns,
    toolCalls: [],
    recording: { available: true, url: path.resolve(meta.filePath), multiChannelUrl: null, channels: meta.channels },
    providerAnalysis: null,
    latency: null,
    cost: null,
    leadId: null,
    promptVersionHint: meta.promptVersion,
  };
}
