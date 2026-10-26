// Step 7: audio checks. Emotion, naturalness and prosody models are heavy and change often, so they
// run behind a small HTTP contract (AUDIO_MODEL_URL) rather than inside this service. See
// docs/audio-model.md for the contract; any speech-emotion model plus a MOS predictor (e.g. UTMOS)
// can sit behind it. Without it, the transcript-side emotion metrics still apply.

import type { CanonicalCall } from '@calleval/framework';
import { config } from '../config';
import { errMsg, log } from '../lib/log';
import { fetchRetry } from '../lib/http';
import type { RawMetric } from './code-checks';
import { lc, RX } from './text';

export type AudioTurn = { idx: number; valence?: number; arousal?: number; mos?: number; monotone?: boolean; artefacts?: number; tag_match?: boolean | null; wpm?: number };
export type AudioResult = { usable: boolean; turns: AudioTurn[]; consistency_ok?: boolean; model?: string; latencyMs: number };

export async function analyseAudio(call: CanonicalCall, audio: Response | null): Promise<AudioResult | null> {
  if (!config.audioModelUrl || !audio) return null;
  const t0 = Date.now();
  try {
    const buf = Buffer.from(await audio.arrayBuffer());
    const form = new FormData();
    form.append('audio', new Blob([buf], { type: audio.headers.get('content-type') ?? 'audio/mpeg' }), 'call-audio');
    form.append('meta', JSON.stringify({
      call_id: call.externalId,
      channels: call.recording?.channels ?? 1,
      agent_channel: 0,
      turns: call.turns.map((t) => ({ idx: t.idx, speaker: t.speaker, start: t.startS, end: t.endS ?? null, tags: t.tags ?? [] })),
    }));
    const res = await fetchRetry(`${config.audioModelUrl.replace(/\/$/, '')}/analyze`, { method: 'POST', body: form, timeoutMs: 300_000, retries: 1 });
    const body = (await res.json()) as Omit<AudioResult, 'latencyMs'>;
    return { ...body, latencyMs: Date.now() - t0 };
  } catch (e) {
    log.warn('audio model failed; continuing with transcript-side emotion metrics', { call: call.externalId, error: errMsg(e) });
    return null;
  }
}

/** Audio-model metrics in their raw units. Missing values leave the transcript-side result in place. */
export function audioMetrics(call: CanonicalCall, a: AudioResult): Record<string, RawMetric> {
  const out: Record<string, RawMetric> = {};
  if (!a.usable) return out;
  const byIdx = new Map(a.turns.map((t) => [t.idx, t]));
  const caller = call.turns.filter((t) => t.speaker === 'caller' && byIdx.get(t.idx)?.valence !== undefined);
  const agent = call.turns.filter((t) => t.speaker === 'agent');
  if (caller.length >= 2) {
    const v = (i: number) => byIdx.get(caller[i].idx)!.valence!;
    const start = caller.length >= 4 ? (v(0) + v(1)) / 2 : v(0);
    const end = caller.length >= 4 ? (v(caller.length - 1) + v(caller.length - 2)) / 2 : v(caller.length - 1);
    out.cet = { raw: +(end - start).toFixed(2), applicable: true, evidence: [caller[0].idx, caller[caller.length - 1].idx], rationale: `Caller valence ${start.toFixed(2)} → ${end.toFixed(2)} (speech emotion model).` };
    const frus = caller.filter((t, i) => { const c = byIdx.get(t.idx)!; const p = i > 0 ? byIdx.get(caller[i - 1].idx) : undefined; return (c.valence ?? 0) < -0.3 && (c.arousal ?? 0) > (p?.arousal ?? 0); });
    if (frus.length) {
      const acked = frus.filter((f) => { const n = call.turns.find((t) => t.idx > f.idx && t.speaker === 'agent'); return n && RX.empathy.test(lc(n.text)); });
      out.fe = { raw: +((acked.length / frus.length) * 100).toFixed(1), applicable: true, evidence: frus.map((f) => f.idx) };
    }
    const over = agent.filter((t) => { const at = byIdx.get(t.idx); const prev = call.turns[t.idx - 1]; const ct = prev ? byIdx.get(prev.idx) : undefined; return at?.arousal !== undefined && ct?.arousal !== undefined && at.arousal - ct.arousal > 0.3; });
    out.od = { raw: over.length, applicable: true, evidence: over.map((o) => o.idx) };
  }
  const mos = agent.map((t) => byIdx.get(t.idx)?.mos).filter((x): x is number => typeof x === 'number');
  if (mos.length) out.mos = { raw: +(mos.reduce((s, x) => s + x, 0) / mos.length).toFixed(2), applicable: true, evidence: [] };
  const mono = agent.filter((t) => byIdx.get(t.idx)?.monotone !== undefined);
  if (mono.length) out.iv = { raw: +((mono.filter((t) => byIdx.get(t.idx)!.monotone).length / mono.length) * 100).toFixed(1), applicable: true, evidence: mono.filter((t) => byIdx.get(t.idx)!.monotone).map((t) => t.idx) };
  const tagged = agent.filter((t) => typeof byIdx.get(t.idx)?.tag_match === 'boolean');
  if (tagged.length) out.tdel = { raw: +((tagged.filter((t) => byIdx.get(t.idx)!.tag_match).length / tagged.length) * 100).toFixed(1), applicable: true, evidence: tagged.filter((t) => !byIdx.get(t.idx)!.tag_match).map((t) => t.idx) };
  const art = agent.reduce((s, t) => s + (byIdx.get(t.idx)?.artefacts ?? 0), 0);
  if (agent.some((t) => byIdx.get(t.idx)?.artefacts !== undefined)) out.aart = { raw: art, applicable: true, evidence: agent.filter((t) => (byIdx.get(t.idx)?.artefacts ?? 0) > 0).map((t) => t.idx) };
  if (typeof a.consistency_ok === 'boolean') out.cons = { raw: a.consistency_ok ? 1 : 0, applicable: true, evidence: [] };
  const wpm = agent.map((t) => byIdx.get(t.idx)?.wpm).filter((x): x is number => typeof x === 'number');
  if (wpm.length) out.srate = { raw: Math.round(wpm.sort((x, y) => x - y)[Math.floor(wpm.length / 2)]), applicable: true, evidence: [] };
  return out;
}
