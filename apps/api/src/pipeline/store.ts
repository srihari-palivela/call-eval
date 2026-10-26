// Step 9: score and store. Writes calls (denormalised tags and score for fast slicing), call_tag,
// call_event, metric_result, call_score, review items, trace spans and evaluator runs, replacing
// anything a previous evaluation of the same call wrote.

import { FRAMEWORK_VERSION, TAXONOMY_VERSION, personaById, type CanonicalCall, type Evaluation } from '@calleval/framework';
import { insertMany, json, type Db } from '../db';
import { newId } from '../lib/ids';
import type { RunInfo } from './judge/types';
import { turnEnd } from './text';

export type Span = { id: string; turn: number | null; kind: string; name: string; startS: number | null; durationS: number | null; model?: string | null; tokensIn?: number | null; tokensOut?: number | null; status: string; meta?: unknown };

/** Agent-side spans per turn: end-of-turn, LLM, tool wait and TTS where the provider measures them. */
export function buildSpans(call: CanonicalCall): Span[] {
  const spans: Span[] = [];
  for (const t of call.turns) {
    if (t.speaker !== 'agent') continue;
    const prev = call.turns[t.idx - 1];
    const lat = prev?.speaker === 'caller' ? (t.latencyS ?? Math.max(0, t.startS - turnEnd(prev))) : null;
    const blocking = call.toolCalls.filter((tc) => tc.turnIdx === t.idx && tc.startS !== undefined && tc.startS < t.startS - 0.05);
    const toolWait = blocking.reduce((a, tc) => a + (tc.durationS ?? 0), 0);
    const m = t.turnMetrics ?? {};
    const pickM = (rx: RegExp) => Object.entries(m).filter(([k]) => rx.test(k)).reduce((a, [, v]) => a + v, 0);
    const llm = pickM(/llm/i), tts = pickM(/tts/i), eot = pickM(/asr|stt|eot|end_of_turn|turn_detect/i);
    if (lat !== null) {
      const start = prev ? turnEnd(prev) : t.startS;
      if (llm || tts || eot) {
        let cur = start;
        if (eot) { spans.push({ id: newId('sp'), turn: t.idx, kind: 'eot', name: 'End-of-turn + final transcript', startS: cur, durationS: eot, status: 'ok' }); cur += eot; }
        if (toolWait) { spans.push({ id: newId('sp'), turn: t.idx, kind: 'tool', name: `Tool wait · ${blocking.map((b) => b.name).join(', ')}`, startS: cur, durationS: toolWait, status: 'ok' }); cur += toolWait; }
        if (llm) { spans.push({ id: newId('sp'), turn: t.idx, kind: 'llm', name: 'LLM · time to first token', startS: cur, durationS: llm, status: 'ok' }); cur += llm; }
        if (tts) spans.push({ id: newId('sp'), turn: t.idx, kind: 'tts', name: 'TTS · first audio', startS: cur, durationS: tts, status: 'ok' });
      } else {
        // The provider gives no breakdown: tool wait is known, the rest is the agent's response time.
        if (toolWait) spans.push({ id: newId('sp'), turn: t.idx, kind: 'tool', name: `Tool wait · ${blocking.map((b) => b.name).join(', ')} (no filler)`, startS: start, durationS: Math.min(toolWait, lat), status: 'ok' });
        const rest = Math.max(0, lat - Math.min(toolWait, lat));
        spans.push({ id: newId('sp'), turn: t.idx, kind: 'llm', name: 'Agent response (end-of-turn + LLM + TTS, not broken down)', startS: start + Math.min(toolWait, lat), durationS: rest, status: 'ok' });
      }
    }
  }
  for (const tc of call.toolCalls) {
    spans.push({ id: newId('sp'), turn: tc.turnIdx, kind: 'tool_call', name: tc.name, startS: tc.startS ?? null, durationS: tc.durationS ?? null, status: tc.ok === false || /\b(fail|failed|error|unavailable)\b/i.test(tc.resultText ?? '') ? 'error' : 'ok', meta: { args: tc.args, result: (tc.resultText ?? '').slice(0, 500) } });
  }
  return spans;
}

export async function storeEvaluation(db: Db, call: CanonicalCall, ev: Evaluation, runs: RunInfo[], summary: string) {
  const id = ev.callId;
  const fv = FRAMEWORK_VERSION, tv = TAXONOMY_VERSION;
  const spans = buildSpans(call);
  const gated = ev.gates.some((g) => g.failed);
  const p = personaById(ev.tags.persona.value);
  await db.tx(async (t) => {
    for (const table of ['call_tag', 'call_event', 'metric_result', 'call_score', 'trace_span']) await t.query(`delete from ${table} where call_id = $1`, [id]);
    await t.query("delete from review_item where call_id = $1 and status = 'open'", [id]);

    const tagRows: unknown[][] = [];
    const tag = (key: string, v: { value: string | null; confidence: number; layer: string; evidence: number[]; runId?: string | null }) => tagRows.push([id, tv, key, v.value, v.confidence, v.layer, json(v.evidence), v.runId ?? null]);
    tag('persona', ev.tags.persona);
    tag('scenario_primary', ev.tags.scenarioPrimary);
    tag('scenario_secondary', ev.tags.scenarioSecondary);
    tag('intent_start', ev.tags.intentStart);
    tag('intent_end', ev.tags.intentEnd);
    for (const [k, v] of Object.entries(ev.tags.facets)) tagRows.push([id, tv, `facet:${k}`, v, 1, 'rule', '[]', null]);
    tagRows.push([id, tv, 'summary', summary.slice(0, 500), 1, ev.judgeMode === 'llm' ? 'classifier' : 'heuristic', '[]', null]);
    let q = insertMany('call_tag', ['call_id', 'taxonomy_version', 'tag_key', 'value', 'confidence', 'layer', 'evidence', 'run_id'], tagRows);
    await t.query(q.sql, q.params);

    if (ev.tags.events.length) {
      q = insertMany('call_event', ['call_id', 'type', 'turn', 'detail', 'source'], ev.tags.events.map((e) => [id, e.type, e.turn, e.detail ?? null, e.source]));
      await t.query(q.sql, q.params);
    }

    q = insertMany('metric_result', ['call_id', 'framework_version', 'metric_key', 'raw', 'value', 'applicable', 'method', 'evidence', 'rationale', 'run_id'],
      ev.metrics.map((m) => [id, fv, m.key, m.raw, m.value, m.applicable, m.method, json(m.evidence), m.rationale ?? null, m.runId ?? null]));
    await t.query(q.sql, q.params);

    const d = (k: string) => (ev.dims as Record<string, { v: number }>)[k]?.v ?? null;
    await t.query(
      `insert into call_score (call_id, framework_version, und, body, concl, tools, emo, intro, voice, dims, cqs, raw_cqs, band, gated, gates, path, outcome, fields, context, phases, lowest, coaching, tool_stats)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb,$21::jsonb,$22::jsonb,$23::jsonb)`,
      [id, fv, d('und'), d('body'), d('concl'), d('tools'), d('emo'), d('intro'), d('voice'), json(ev.dims), ev.cqs, ev.rawCqs, ev.band, gated,
        json(ev.gates.filter((g) => g.failed)), json(ev.path), json(ev.outcome), json(ev.fields), json(ev.context), json(ev.phases), json(ev.lowest), json(ev.coaching), json(ev.toolStats)],
    );

    if (spans.length) {
      q = insertMany('trace_span', ['id', 'call_id', 'turn', 'kind', 'name', 'start_s', 'duration_s', 'model', 'tokens_in', 'tokens_out', 'status', 'meta'],
        spans.map((s) => [s.id, id, s.turn, s.kind, s.name, s.startS, s.durationS, s.model ?? null, s.tokensIn ?? null, s.tokensOut ?? null, s.status, json(s.meta ?? null)]));
      await t.query(q.sql, q.params);
    }
    if (runs.length) {
      q = insertMany('eval_run', ['id', 'call_id', 'kind', 'version', 'model', 'input_tokens', 'output_tokens', 'latency_ms', 'status', 'error', 'output', 'cited_turns'],
        runs.map((r) => [r.id, id, r.mode === 'heuristic' ? `${r.kind}_heuristic` : r.kind, r.kind === 'classifier' ? tv : `rubrics-${fv}`, r.model, r.inputTokens, r.outputTokens, r.latencyMs, r.status, r.error ?? null, json(r.output ?? null), '[]']));
      await t.query(q.sql + ' on conflict (id) do nothing', q.params);
    }
    for (const r of ev.review) {
      const tagVal = r.tagKey === 'persona' ? ev.tags.persona : r.tagKey === 'scenario_primary' ? ev.tags.scenarioPrimary : r.tagKey === 'intent_end' ? ev.tags.intentEnd : null;
      await t.query(
        'insert into review_item (id, call_id, kind, tag_key, reason, current_value, confidence) values ($1,$2,$3,$4,$5,$6,$7)',
        [newId('rev'), id, r.kind, r.tagKey ?? null, r.reason, tagVal?.value ?? (r.kind === 'gate' ? ev.gates.filter((g) => g.failed).map((g) => g.id).join(',') : null), tagVal?.confidence ?? null],
      );
    }
    await t.query(
      `update calls set status = 'scored', error = null, persona = $2, persona_path = $3, scenario = $4, scenario2 = $5, intent_start = $6, intent_end = $7,
         cqs = $8, raw_cqs = $9, band = $10, gated = $11, next_step = $12, qualified = $13, judge_mode = $14, needs_review = $15,
         language = coalesce(language, $16), scored_at = now(), updated_at = now()
       where call_id = $1`,
      [id, ev.tags.persona.value, p.path === '—' ? null : p.path, ev.tags.scenarioPrimary.value, ev.tags.scenarioSecondary.value, ev.tags.intentStart.value, ev.tags.intentEnd.value,
        ev.cqs, ev.rawCqs, ev.band, gated, ev.outcome.nextStep, ev.outcome.qualified, ev.judgeMode, ev.review.some((r) => r.kind !== 'sample'), ev.tags.facets.language ?? null],
    );
  });
}
