// Call list and call drill-down.

import {
  DIMS, EVENT_TYPES, FACETS, FIELD_LABELS, GATES, METRICS, TOOL_MAP, bandAction, gateById, metricByKey, personaById, scenarioById,
  type CallDetailDTO, type CallListDTO, type CallListItemDTO, type CanonicalCall, type ContextRecord, type Phases, type SpanDTO, type TurnDTO,
} from '@calleval/framework';
import { iso, type Db } from '../db';
import { fmtTime } from '../pipeline/text';
import { listRecommendations } from '../recommendations/engine';
import { listReview } from './review';
import { parseSlice, sliceWhere } from './filters';

const title = (persona: string | null, scenario: string | null) => {
  const p = personaById(persona), s = scenarioById(scenario);
  return `${p.id} ${p.name}${s ? ` × ${s.id} ${s.name}` : ''}`;
};

function noteOf(r: { gated: boolean; needs_review: boolean; band: string | null; status: string; cqs: number | null; error?: string | null }): { note: string | null; tone: 'ink' | 'accent' } {
  if (r.status === 'failed') return { note: `Pipeline error${r.error ? `: ${String(r.error).slice(0, 80)}` : ''}`, tone: 'accent' };
  if (r.status !== 'scored') return { note: 'In the pipeline', tone: 'ink' };
  if (r.gated) return { note: 'Gate failure · in human review', tone: 'accent' };
  if (r.needs_review) return { note: 'Tag under the confidence line · queued for review', tone: 'accent' };
  if (r.band === 'Excellent') return { note: 'Reference call', tone: 'ink' };
  if (r.band === 'Fail' || r.band === 'Needs review') return { note: bandAction(r.cqs ?? 0), tone: 'accent' };
  return { note: null, tone: 'ink' };
}

export async function listCalls(db: Db, q: Record<string, unknown>): Promise<CallListDTO> {
  const f = parseSlice(q);
  const w = await sliceWhere(db, f, [], 1);
  const params = [...w.params];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const conds = [w.sql.replace("c.status = 'scored'", "c.status in ('scored','failed','ingested','evaluating')")];
  const s = (k: string) => (typeof q[k] === 'string' && q[k] ? String(q[k]) : null);
  if (s('persona')) conds.push(`c.persona = ${p(s('persona'))}`);
  if (s('scenario')) conds.push(`c.scenario = ${p(s('scenario'))}`);
  if (s('band')) conds.push(`c.band = ${p(s('band'))}`);
  if (s('gated') === 'true') conds.push('c.gated');
  if (s('review') === 'true') conds.push('c.needs_review');
  if (s('status')) conds.push(`c.status = ${p(s('status'))}`);
  if (s('q')) {
    const like = `%${s('q')!.replace(/[%_]/g, '')}%`;
    conds.push(`(c.call_id ilike ${p(like)} or c.external_id ilike $${params.length} or c.canonical::text ilike $${params.length})`);
  }
  const sort = s('sort') === 'worst' ? 'c.cqs asc nulls last, c.started_at desc' : s('sort') === 'best' ? 'c.cqs desc nulls last, c.started_at desc' : 'c.started_at desc';
  const limit = Math.min(200, Math.max(1, Number(s('limit') ?? 50)));
  const offset = Math.max(0, Number(s('offset') ?? 0));
  const where = conds.join(' and ');
  const total = (await db.one<{ n: number }>(`select count(*)::int as n from calls c where ${where}`, params))?.n ?? 0;
  const rows = await db.query(
    `select c.call_id, c.provider, c.external_id, c.started_at, c.duration_s, c.direction, c.persona, c.scenario, c.scenario2, c.cqs, c.raw_cqs, c.band, c.gated,
       c.prompt_version, c.status, c.error, c.needs_review, c.next_step, a.name as agent_name, s.gates
     from calls c left join agent a on a.id = c.agent_id left join call_score s on s.call_id = c.call_id
     where ${where} order by ${sort} limit ${limit} offset ${offset}`,
    params,
  );
  const items: CallListItemDTO[] = rows.map((r) => ({
    id: r.call_id, provider: r.provider, externalId: r.external_id, title: r.persona ? title(r.persona, r.scenario) : 'Not scored yet',
    startedAt: iso(r.started_at)!, durationS: Number(r.duration_s), direction: r.direction, persona: r.persona, scenario: r.scenario, scenario2: r.scenario2,
    cqs: r.cqs === null ? null : Math.round(Number(r.cqs)), rawCqs: r.raw_cqs === null ? null : Math.round(Number(r.raw_cqs)), band: r.band,
    gates: (r.gates ?? []).map((g: { id: string }) => g.id), promptVersion: r.prompt_version, agentName: r.agent_name, status: r.status,
    note: noteOf(r as Parameters<typeof noteOf>[0]).note, needsReview: !!r.needs_review, nextStep: r.next_step,
  }));
  return { items, total };
}

const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const END_LABEL: Record<string, string> = {
  natural_close: 'Natural close', caller_hangup: 'Caller hung up', agent_hangup: 'Agent hung up', transfer: 'Live transfer', time_limit: 'Time limit',
  voicemail: 'Voicemail', dnc: 'Do-not-contact', no_answer: 'No answer', error: 'Error', unknown: 'Unknown',
};

export async function callDetail(db: Db, id: string): Promise<CallDetailDTO | null> {
  const c = await db.one(`select c.*, a.name as agent_name from calls c left join agent a on a.id = c.agent_id where c.call_id = $1`, [id]);
  if (!c) return null;
  const call = c.canonical as CanonicalCall;
  const s = await db.one('select * from call_score where call_id = $1', [id]);
  const tags = await db.query('select * from call_tag where call_id = $1', [id]);
  const events = await db.query('select * from call_event where call_id = $1 order by turn', [id]);
  const metrics = await db.query('select * from metric_result where call_id = $1', [id]);
  const spans = await db.query('select * from trace_span where call_id = $1 order by start_s nulls last', [id]);
  const runs = await db.query('select * from eval_run where call_id = $1 order by created_at', [id]);
  const outcomes = c.lead_id ? await db.query('select * from lead_outcome where lead_id = $1 order by occurred_at', [c.lead_id]) : [];
  const tag = (k: string) => tags.find((t) => t.tag_key === k);
  const ctx = (s?.context ?? null) as ContextRecord | null;
  const phases = (s?.phases ?? null) as Phases | null;
  const fields = (s?.fields ?? {}) as Record<string, string | null>;
  const outcome = (s?.outcome ?? {}) as Record<string, any>;

  // Turns with tools, latency, delivery tags, barge-ins and events.
  const evByTurn = new Map<number, string>();
  for (const e of events) if (!evByTurn.has(e.turn)) evByTurn.set(e.turn, e.type === 'gate_failure' ? 'Gate failure' : EVENT_TYPES.find((x) => x.id === e.type)?.label ?? e.type);
  if (phases?.personaResolvedAt !== null && phases?.personaResolvedAt !== undefined && !evByTurn.has(phases.personaResolvedAt)) evByTurn.set(phases.personaResolvedAt, 'Persona resolved');
  const turns: TurnDTO[] = (call?.turns ?? []).map((t) => {
    const prev = call.turns[t.idx - 1];
    const tools = (call.toolCalls ?? []).filter((tc) => tc.turnIdx === t.idx).map((tc) => ({
      name: tc.name, args: Object.entries(tc.args ?? {}).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', '),
      result: tc.resultText ?? (tc.result !== undefined ? JSON.stringify(tc.result) : ''), ok: tc.ok ?? null, durationS: tc.durationS ?? null,
    }));
    const lat = t.speaker === 'agent' && prev?.speaker === 'caller' ? +(t.latencyS ?? Math.max(0, t.startS - (prev.endS ?? prev.startS))).toFixed(2) : null;
    const barge = t.speaker === 'caller' && prev?.speaker === 'agent' && (prev.interrupted || (prev.endS !== undefined && t.startS < prev.endS - 0.15))
      ? (/\b(no|not|i said|we said)\b/i.test(t.text) ? 'correction' : /\b(okay,? okay|just|can you just)\b/i.test(t.text) ? 'impatience' : 'new question') : null;
    return {
      id: t.idx, sp: t.speaker === 'agent' ? 'A' : 'C', t: t.startS, end: t.endS ?? null, text: t.text, lat, tag: t.tags?.[0] ?? null, barge,
      event: evByTurn.get(t.idx) ?? null, seg: phases?.turnSegments?.[t.idx] ?? null,
      phase: phases?.phases.find((p) => t.idx >= p.from && t.idx <= p.to)?.name ?? null,
      tools: tools.length ? tools : undefined,
    };
  });

  // Trace: per-turn spans and evaluator runs.
  const turnSpans: Record<string, SpanDTO[]> = {};
  const sums = { eot: 0, llm: 0, tool: 0, tts: 0 };
  const perTurn = new Map<number, number>();
  for (const sp of spans) {
    if (sp.turn === null || sp.kind === 'tool_call') continue;
    const turn = call.turns[sp.turn];
    const prev = call.turns[sp.turn - 1];
    const origin = prev ? (prev.endS ?? prev.startS) : 0;
    (turnSpans[String(sp.turn)] ??= []).push({ label: sp.name, start: Math.max(0, Number(sp.start_s) - origin), dur: Number(sp.duration_s) || 0, kind: sp.kind });
    if (sp.kind in sums) sums[sp.kind as keyof typeof sums] += Number(sp.duration_s) || 0;
    perTurn.set(sp.turn, (perTurn.get(sp.turn) ?? 0) + (Number(sp.duration_s) || 0));
    void turn;
  }
  for (const sp of spans.filter((x) => x.kind === 'tool_call' && x.turn !== null)) {
    const t = call.turns[sp.turn]; const prev = call.turns[sp.turn - 1];
    const origin = prev ? (prev.endS ?? prev.startS) : 0;
    if (!t || sp.start_s === null) continue;
    const blocking = Number(sp.start_s) < t.startS - 0.05;
    if (!blocking) (turnSpans[String(sp.turn)] ??= []).push({ label: `Tool · ${sp.name} (during speech)`, start: Math.max(0, Number(sp.start_s) - origin), dur: Number(sp.duration_s) || 0.3, kind: 'bg' });
  }
  const latTurns = turns.filter((t) => t.lat !== null && t.lat !== undefined);
  const slow = latTurns.sort((a, b) => (b.lat ?? 0) - (a.lat ?? 0))[0];
  const judged = metrics.filter((m) => m.applicable && String(m.method).includes('judge')).length;
  const tokIn = runs.reduce((a, r) => a + (r.input_tokens ?? 0), 0), tokOut = runs.reduce((a, r) => a + (r.output_tokens ?? 0), 0);
  const evals: [string, string][] = runs.map((r) => [
    r.kind.startsWith('judge') ? 'Judge run · judged metrics, gates and path' : r.kind.startsWith('classifier') ? 'Persona and scenario classifier' : r.kind,
    `${r.kind.endsWith('heuristic') ? 'heuristic' : r.model ?? 'model'} · ${r.status}${r.latency_ms ? ` · ${(r.latency_ms / 1000).toFixed(1)} s` : ''}${r.input_tokens ? ` · ${r.input_tokens.toLocaleString('en-US')} in / ${r.output_tokens} out` : ''}`,
  ]);
  if (judged) evals.unshift(['Judged metrics on this call', String(judged)]);

  const metricRows = METRICS.map((m) => {
    const r = metrics.find((x) => x.metric_key === m.key);
    return {
      key: m.key, dim: m.dim, name: m.name, target: m.target, method: r?.method ?? m.method,
      value: r && r.applicable && r.value !== null ? Math.round(Number(r.value)) : null, raw: r?.raw === null || r?.raw === undefined ? null : Number(r.raw),
      unit: m.unit, evidence: (r?.evidence ?? []) as number[], rationale: r?.rationale ?? null, runId: r?.run_id ?? null,
    };
  });

  const n = noteOf({ gated: !!c.gated, needs_review: !!c.needs_review, band: c.band, status: c.status, cqs: c.cqs, error: c.error });
  const tagRow = (k: string, label: string) => {
    const t = tag(k);
    if (!t || !t.value) return null;
    const v = k === 'persona' ? `${t.value} ${personaById(t.value).name}` : k.startsWith('scenario') ? `${t.value} ${scenarioById(t.value)?.name ?? ''}` : cap(t.value);
    return { key: k, label, value: v, conf: Number(t.confidence ?? 0), layer: t.layer, ev: (t.evidence ?? []) as number[] };
  };
  const intentS = tag('intent_start')?.value, intentE = tag('intent_end')?.value;
  const tagList = [tagRow('persona', 'Persona'), tagRow('scenario_primary', 'Primary scenario'), tagRow('scenario_secondary', 'Secondary scenario')].filter(Boolean) as CallDetailDTO['tags'];
  if (intentS && intentE) {
    const ti = tag('intent_end')!;
    tagList.push({ key: 'intent', label: 'Intent at start → end', value: `${cap(intentS)} → ${cap(intentE)}`, conf: Number(ti.confidence ?? 0), layer: ti.layer, ev: [...(tag('intent_start')?.evidence ?? []), ...(ti.evidence ?? [])] });
  }
  const facetRows: [string, string][] = FACETS.flatMap((f) => {
    if (f.id === 'intent') return [];
    const v = tag(`facet:${f.id}`)?.value;
    return v ? [[f.name, f.id === 'language' ? v.toUpperCase() : v] as [string, string]] : [];
  });

  const hasRecording = !!c.has_audio && c.provider !== 'demo';
  return {
    id: c.call_id, provider: c.provider, externalId: c.external_id, title: c.persona ? title(c.persona, c.scenario) : 'Not scored yet', startedAt: iso(c.started_at)!,
    durationS: Number(c.duration_s), direction: c.direction, endReason: c.end_reason ?? 'unknown', endReasonRaw: c.end_reason_raw, language: c.language,
    promptVersion: c.prompt_version, agentVersion: c.agent_version, agentName: c.agent_name, audioUrl: hasRecording ? `/api/calls/${encodeURIComponent(id)}/audio` : null,
    recordingChannels: c.recording_channels, status: c.status, source: c.source, judgeMode: c.judge_mode, note: n.note, noteTone: n.tone,
    context: ctx ? [
      ['Direction', cap(ctx.direction)], ['Identity', ctx.identity === 'known' ? `Name known${ctx.customerName ? ` (${ctx.customerName})` : ''}` : 'Name unknown'],
      ['History', cap(ctx.history)], ['Objective', ctx.objective === 'empty' ? 'Empty' : ctx.objectiveText ?? cap(ctx.objective)],
      ['Persona', ctx.persona !== 'unknown' ? `${cap(ctx.persona)}, known from history` : phases?.personaResolvedAt !== null && phases?.personaResolvedAt !== undefined ? `${personaById(c.persona).path === 'Broker' ? 'Broker' : personaById(c.persona).path === 'Investor' ? 'Investor' : 'Non-target'}, resolved at turn ${phases.personaResolvedAt}` : 'Unresolved'],
    ] : [],
    record: [
      ['Started', new Date(c.started_at).toUTCString().replace(' GMT', ' UTC')], ['Duration', fmtDur(Number(c.duration_s))], ['End reason', END_LABEL[c.end_reason] ?? c.end_reason ?? '—'],
      ['Prompt', c.prompt_version ?? '—'], ['Agent', c.agent_name ? `${c.agent_name}${c.agent_version ? ` · ${c.agent_version}` : ''}` : '—'], ['Source', c.provider === 'elevenlabs' ? 'ElevenLabs' : c.provider === 'retell' ? 'Retell AI' : c.provider === 'upload' ? 'Upload' : 'Demo'],
      ['Language', (c.language ?? '—').toUpperCase()], ['Recording', c.recording_channels === 2 ? 'Dual-channel' : c.recording_channels === 1 ? 'Mono' : c.has_audio ? 'Available' : 'None'],
    ],
    gates: ((s?.gates ?? []) as { id: string; detail: string | null; turn: number | null; runId?: string | null }[]).map((g) => ({ id: g.id, text: gateById(g.id)?.text ?? g.id, detail: g.detail ?? '', turn: g.turn, runId: g.runId ?? null })),
    tags: tagList,
    events: events.map((e) => ({ type: e.type, label: e.type === 'gate_failure' ? `Gate failure${e.detail ? ` · ${e.detail}` : ''}` : EVENT_TYPES.find((x) => x.id === e.type)?.label ?? e.type, turn: e.turn })),
    facets: facetRows,
    phases: phases?.phases ?? [],
    segs: phases?.segments ?? [],
    path: s?.path ? { scenario: `${s.path.scenario} ${scenarioById(s.path.scenario)?.name ?? ''}`.trim(), steps: s.path.steps.map((x: any) => ({ label: x.label, turn: x.turn, hit: x.hit })), deviation: s.path.deviation } : null,
    fields: Object.entries(fields).filter(([k]) => k in FIELD_LABELS).map(([k, v]) => [FIELD_LABELS[k], v ?? 'Not captured'] as [string, string]),
    outcome: s ? [
      ['Next step', outcome.nextStep ? `${cap(outcome.nextStep)}${outcome.meetingKind ? ` · ${String(outcome.meetingKind).replace('_', ' ')}` : ''}` : 'None'],
      ['Sentiment change', outcome.sentimentDelta === null || outcome.sentimentDelta === undefined ? '—' : `${outcome.sentimentDelta > 0 ? '+' : ''}${outcome.sentimentDelta}`],
      ['Intent', outcome.intentChange ? outcome.intentChange.split(' → ').map(cap).join(' → ') : '—'],
      ['Qualified lead', outcome.qualified ? 'Yes' : 'No'],
    ] : [],
    metrics: metricRows,
    dims: (s?.dims ?? {}) as CallDetailDTO['dims'],
    cqs: c.cqs === null ? null : Math.round(Number(c.cqs)), rawCqs: c.raw_cqs === null ? null : Math.round(Number(c.raw_cqs)), band: c.band,
    lowest: ((s?.lowest ?? []) as CallDetailDTO['lowest']),
    turns,
    trace: {
      id: `tr_${String(c.external_id).slice(-8)}`, spans: spans.length, llmCalls: runs.filter((r) => !String(r.kind).endsWith('heuristic')).length,
      inTok: tokIn, outTok: tokOut, n: perTurn.size, sums, slowTurn: slow ? { id: slow.id, lat: slow.lat ?? 0 } : null, evals, turnSpans,
    },
    coaching: (s?.coaching ?? []) as CallDetailDTO['coaching'],
    recommendations: await listRecommendations(db, { scope: 'call', scopeKey: id }),
    review: await listReview(db, { callId: id, status: 'all' }),
    providerAnalysis: call?.providerAnalysis ? { summary: call.providerAnalysis.summary ?? null, successful: call.providerAnalysis.successful ?? null, sentiment: call.providerAnalysis.sentiment ?? null } : null,
    crm: { leadId: c.lead_id, outcomes: outcomes.map((o) => ({ stage: o.stage, at: iso(o.occurred_at)!, valueAed: o.value_aed, credited: o.credited_call_id === id })) },
  };
}

void DIMS; void GATES; void TOOL_MAP; void metricByKey; void fmtTime;
