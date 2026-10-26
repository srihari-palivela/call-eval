// Prompt text for the Claude classifier and judge. The system prompt is identical for every call,
// so it is cached once and reused across the whole pipeline; per-call content goes after it.

import {
  EVENT_TYPES, FACETS, GATES, METRICS, P0, PERSONAS, SCENARIOS, TOOL_MAP,
  type CanonicalCall, type ContextRecord, type Phases,
} from '@calleval/framework';
import { expectedOpening } from '../context';
import { fmtTime } from '../text';
import { JUDGED_METRICS } from './types';

export function systemPrompt(): string {
  const personas = [...PERSONAS, P0].map((p) => `- ${p.id} ${p.name} (${p.path} path). Signals: ${p.signals}. Watch for: ${p.watch}.`).join('\n');
  const scenarios = SCENARIOS.map((s) => `- ${s.id} ${s.name}. Trigger: ${s.trigger}. Expected path: ${s.path}. Success: ${s.success}.`).join('\n');
  const events = EVENT_TYPES.map((e) => `${e.id} (${e.group}: ${e.label})`).join('; ');
  const facets = FACETS.map((f) => `${f.name}: ${f.values}`).join('; ');
  const tools = TOOL_MAP.map((t) => `- ${t.name}: fires when ${t.shouldFire}. Must come first: ${t.mustComeFirst}. Failure to catch: ${t.failure}.`).join('\n');
  const rubrics = JUDGED_METRICS.map((m) => `- ${m.key} · ${m.name} (raw unit: ${m.unit}; target ${m.target}). ${m.rubric}`).join('\n');
  const gates = GATES.map((g) => `- ${g.id}: ${g.text}`).join('\n');
  return `You evaluate calls handled by an AI voice sales agent for a Dubai real-estate developer selling off-plan homes. Callers are investors, brokers or non-target callers. You work inside an evaluation pipeline: code has already measured timings, counts and tool order; you supply the judgements that need the meaning of the words. Always quote evidence as turn ids (the #numbers in the transcript), and judge only what is in the transcript and tool log.

# Call structure
Every call has three phases. Introduction: from the agent's first line until the persona (investor or broker) is resolved; on an inbound call, also until the caller's first question has been answered. Body: until the first closing signal. Conclusion: from the first closing signal (a booking confirmed and the agent wraps up, a second refusal, a do-not-contact request, a live transfer starting, the caller saying goodbye, or about 900 seconds passing) to the end. A call that ends before persona is resolved has no body. Body turns are segmented as Discovery, Pitch, Objection, Action (documents, scheduling, callbacks, transfers) or Off-topic.

The investor-or-broker fork switches whole groups of metrics: on the broker path buyer discovery (budget, location, bedrooms, timeline, end use) is not scored and asking any of it is a violation; on the investor path broker registration checks do not apply.

# Persona taxonomy (exactly one per call, judged at the end of the call)
${personas}

# Scenario taxonomy (one primary — the journey that decided the outcome — and at most one secondary)
${scenarios}

# Event tags (moments inside any scenario)
${events}

# Facets
${facets}. Intent is hot, warm or cold, from stated timeline and engagement; record it at the start and at the end.

# Agent tools
${tools}

# Judged metrics (score each one; mark it not applicable when the call gave no opportunity for it)
${rubrics}

# Compliance gates (pass or fail; one failure caps the call at 40 and sends it to human review)
${gates}
Realism means the caller is comfortable, not fooled: the agent must say it is an AI when asked.

# How to answer
- Turn ids are integers from the transcript. Evidence lists hold the 1–4 turns that matter most.
- Raw values use each metric's unit: averages, percentages 0–100, counts, 1 for pass and 0 for fail, or the −2 to +2 sentiment scale.
- A metric with no opportunity in the call is not applicable (applicable false, raw 0): do not score it as perfect.
- Rationales are one short sentence a QA reviewer can check against the quoted turns.
- Be strict and consistent: two reviewers reading the same call should reach the same answer.`;
}

export function renderCall(call: CanonicalCall, ctx: ContextRecord, phases?: Phases): string {
  const exp = expectedOpening(ctx);
  const facts = ctx.knownFacts ? (typeof ctx.knownFacts === 'string' ? ctx.knownFacts : JSON.stringify(ctx.knownFacts)) : 'none';
  const lines: string[] = [];
  lines.push('OPENING CONTEXT');
  lines.push(`direction: ${ctx.direction} · identity: ${ctx.identity === 'known' ? `name known (${ctx.customerName})` : 'name unknown'} · history: ${ctx.history} · objective: ${ctx.objectiveText ?? 'empty'} · persona: ${ctx.persona === 'unknown' ? 'unknown' : `${ctx.persona} (from history)`}`);
  lines.push(`known_facts: ${facts}`);
  if (call.dynamicVariables?.recent_history) lines.push(`recent_history: ${String(call.dynamicVariables.recent_history)}`);
  lines.push(`Expected opening for this context: ${exp.expected}. Scored as an error: ${exp.errors}.`);
  lines.push('');
  lines.push('TRANSCRIPT (turn id · time · speaker; tool calls listed under the turn they belong to)');
  const toolsByTurn = new Map<number, typeof call.toolCalls>();
  for (const tc of call.toolCalls) { const a = toolsByTurn.get(tc.turnIdx) ?? []; a.push(tc); toolsByTurn.set(tc.turnIdx, a); }
  for (const t of call.turns) {
    const phase = phases?.phases.find((p) => t.idx >= p.from && t.idx <= p.to)?.name;
    for (const tc of (toolsByTurn.get(t.idx) ?? []).filter((x) => x.startS !== undefined && x.startS < t.startS - 0.05)) lines.push(`   ↳ before #${t.idx}, in silence: ${toolLine(tc)}`);
    lines.push(`#${t.idx} ${fmtTime(t.startS)} ${t.speaker === 'agent' ? 'AGENT' : 'CALLER'}${phase ? ` [${phase}]` : ''}${t.interrupted ? ' (interrupted)' : ''}: ${t.text}`);
    for (const tc of (toolsByTurn.get(t.idx) ?? []).filter((x) => !(x.startS !== undefined && x.startS < t.startS - 0.05))) lines.push(`   ↳ ${toolLine(tc)}`);
  }
  lines.push('');
  lines.push(`CALL END: ${call.endReason}${call.endReasonRaw ? ` (provider: ${call.endReasonRaw})` : ''} · duration ${Math.round(call.durationS)} s`);
  return lines.join('\n');
}

function toolLine(tc: CanonicalCall['toolCalls'][number]) {
  const args = JSON.stringify(tc.args ?? {});
  const res = tc.resultText ?? (tc.result !== undefined ? JSON.stringify(tc.result) : 'no result');
  return `tool ${tc.name}(${args.length > 400 ? args.slice(0, 400) + '…' : args}) → ${res.length > 900 ? res.slice(0, 900) + '…' : res}${tc.ok === false ? ' [ERROR]' : ''}${tc.durationS !== undefined ? ` [${tc.durationS.toFixed(1)} s]` : ''}`;
}

export const METRIC_KEYS_JUDGED = JUDGED_METRICS.map((m) => m.key);
export const metricUnit = (k: string) => METRICS.find((m) => m.key === k)?.unit ?? '';
