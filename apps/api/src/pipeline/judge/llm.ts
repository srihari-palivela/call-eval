// Claude classifier and judge. One request classifies the call (persona, scenarios, intent, events,
// captured fields); a second scores the judged metrics, gates and path checkpoints. Both share a
// cached system prompt (the framework itself) and a cached transcript block, and both use
// structured outputs so every answer arrives as schema-valid JSON.

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { EVENT_TYPES, GATES, PERSONAS, P0, SCENARIOS, type SegmentName } from '@calleval/framework';
import { config } from '../../config';
import { newId } from '../../lib/ids';
import { errMsg, log } from '../../lib/log';
import { renderCall, systemPrompt } from './prompt';
import { JUDGED_GATES, JUDGED_METRICS, type ClassifierOutput, type ClassifyInput, type Judge, type JudgeInput, type JudgeOutput, type RunInfo } from './types';

// ---------- Concurrency ----------
let active = 0;
const waiters: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= config.llm.maxConcurrent) await new Promise<void>((r) => waiters.push(r));
  active++;
  try { return await fn(); } finally { active--; waiters.shift()?.(); }
}

// ---------- Schemas ----------
const tagSchema = (values: string[]) => ({
  type: 'object', additionalProperties: false,
  required: ['value', 'confidence', 'evidence_turns'],
  properties: { value: { type: 'string', enum: values }, confidence: { type: 'number' }, evidence_turns: { type: 'array', items: { type: 'integer' } } },
});
const FIELD_KEYS = ['name', 'email', 'phone', 'city', 'buy_intent', 'property_type', 'bedrooms', 'location', 'budget', 'timeline', 'must_haves', 'who_for', 'broker_type', 'registration', 'project_interest'];
const SEGMENTS: SegmentName[] = ['Discovery', 'Pitch', 'Objection', 'Action', 'Off-topic'];

const CLASSIFIER_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['persona', 'persona_resolved_turn', 'scenario_primary', 'scenario_secondary', 'intent_start', 'intent_end', 'events', 'fields', 'budget_aed', 'timeline_months', 'language', 'summary', 'body_segments'],
  properties: {
    persona: tagSchema([...PERSONAS.map((p) => p.id), P0.id]),
    persona_resolved_turn: { type: 'integer', description: 'Turn id where investor or broker became clear; -1 if never; 0 if known from history.' },
    scenario_primary: tagSchema(SCENARIOS.map((s) => s.id)),
    scenario_secondary: tagSchema([...SCENARIOS.map((s) => s.id), 'none']),
    intent_start: tagSchema(['hot', 'warm', 'cold']),
    intent_end: tagSchema(['hot', 'warm', 'cold']),
    events: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['type', 'turn'], properties: { type: { type: 'string', enum: EVENT_TYPES.map((e) => e.id) }, turn: { type: 'integer' } } } },
    fields: { type: 'object', additionalProperties: false, required: FIELD_KEYS, properties: Object.fromEntries(FIELD_KEYS.map((k) => [k, { type: 'string', description: 'Captured value, or empty string when not captured in this call.' }])) },
    budget_aed: { type: 'number', description: 'Stated budget in AED; 0 when not stated.' },
    timeline_months: { type: 'number', description: 'Months until the caller wants to buy or move; -1 when not stated.' },
    language: { type: 'string', description: 'ISO 639-1 code of the main language spoken.' },
    summary: { type: 'string', description: 'One sentence on what the caller wanted and how the call ended, without names or numbers.' },
    body_segments: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['turn', 'segment'], properties: { turn: { type: 'integer' }, segment: { type: 'string', enum: SEGMENTS } } } },
  },
};

const metricItem = { type: 'object', additionalProperties: false, required: ['applicable', 'raw', 'evidence_turns', 'rationale'], properties: { applicable: { type: 'boolean' }, raw: { type: 'number' }, evidence_turns: { type: 'array', items: { type: 'integer' } }, rationale: { type: 'string' } } };
const gateItem = { type: 'object', additionalProperties: false, required: ['failed', 'turn', 'detail'], properties: { failed: { type: 'boolean' }, turn: { type: 'integer', description: '-1 when not failed' }, detail: { type: 'string' } } };

const JUDGE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['metrics', 'gates', 'checkpoints', 'coaching'],
  properties: {
    metrics: { type: 'object', additionalProperties: false, required: JUDGED_METRICS.map((m) => m.key), properties: Object.fromEntries(JUDGED_METRICS.map((m) => [m.key, metricItem])) },
    gates: { type: 'object', additionalProperties: false, required: JUDGED_GATES, properties: Object.fromEntries(JUDGED_GATES.map((g) => [g, gateItem])) },
    checkpoints: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'hit', 'turn'], properties: { id: { type: 'string' }, hit: { type: 'boolean' }, turn: { type: 'integer' } } } },
    coaching: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['turn', 'issue', 'better_response'], properties: { turn: { type: 'integer' }, issue: { type: 'string' }, better_response: { type: 'string', description: 'What the agent should have said instead, in its own voice.' } } } },
  },
};

const zTag = z.object({ value: z.string(), confidence: z.number(), evidence_turns: z.array(z.number().int()) });
const zClassifier = z.object({
  persona: zTag, persona_resolved_turn: z.number().int(), scenario_primary: zTag, scenario_secondary: zTag,
  intent_start: zTag, intent_end: zTag,
  events: z.array(z.object({ type: z.string(), turn: z.number().int() })),
  fields: z.record(z.string(), z.string()), budget_aed: z.number(), timeline_months: z.number(),
  language: z.string(), summary: z.string(),
  body_segments: z.array(z.object({ turn: z.number().int(), segment: z.string() })),
});
const zJudge = z.object({
  metrics: z.record(z.string(), z.object({ applicable: z.boolean(), raw: z.number(), evidence_turns: z.array(z.number().int()), rationale: z.string() })),
  gates: z.record(z.string(), z.object({ failed: z.boolean(), turn: z.number().int(), detail: z.string() })),
  checkpoints: z.array(z.object({ id: z.string(), hit: z.boolean(), turn: z.number().int() })),
  coaching: z.array(z.object({ turn: z.number().int(), issue: z.string(), better_response: z.string() })),
});

// ---------- Client ----------
let client: Anthropic | null = null;
let fallbacksSupported = config.llm.fallbacks;
const SYSTEM = systemPrompt();

function getClient() {
  client ??= new Anthropic({ maxRetries: 3, timeout: 10 * 60 * 1000 });
  return client;
}

type Usage = { input: number; output: number };

async function structuredCall(callText: string, instruction: string, schema: Record<string, unknown>, effort: typeof config.llm.effort): Promise<{ json: unknown; usage: Usage; model: string }> {
  return withSlot(async () => {
    const params: Parameters<Anthropic['beta']['messages']['stream']>[0] = {
      model: config.llm.model,
      max_tokens: 32000,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: callText, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: instruction },
        ],
      }],
      output_config: { effort, format: { type: 'json_schema', schema } },
    };
    const send = async (withFallbacks: boolean) => {
      const req = withFallbacks ? { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : params;
      return getClient().beta.messages.stream(req).finalMessage();
    };
    let msg: Anthropic.Beta.Messages.BetaMessage;
    try {
      msg = await send(fallbacksSupported);
    } catch (e) {
      // Some deployments (gateways, other platforms) reject the fallbacks parameter; retry once without it.
      if (fallbacksSupported && e instanceof Anthropic.BadRequestError && /fallback/i.test(e.message)) {
        fallbacksSupported = false;
        log.warn('Claude fallbacks not accepted here; continuing without them', { error: e.message });
        msg = await send(false);
      } else throw e;
    }
    if (msg.stop_reason === 'refusal') throw new Error(`Claude declined to evaluate this call (${msg.stop_details?.category ?? 'no category'})`);
    if (msg.stop_reason === 'max_tokens') throw new Error('Claude response hit max_tokens before finishing');
    const text = msg.content.filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text').map((b) => b.text).join('');
    return { json: JSON.parse(text), usage: { input: (msg.usage.input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0), output: msg.usage.output_tokens ?? 0 }, model: msg.model };
  });
}

const clampTurn = (n: number, max: number) => (Number.isInteger(n) && n >= 0 && n <= max ? n : null);
const clampTurns = (xs: number[], max: number) => Array.from(new Set(xs.filter((n) => Number.isInteger(n) && n >= 0 && n <= max))).slice(0, 6);

export const claude: Judge = {
  mode: 'llm',
  get model() { return config.llm.model; },

  async classify(inp: ClassifyInput): Promise<ClassifierOutput> {
    const t0 = Date.now();
    const max = inp.call.turns.length - 1;
    const fixed: string[] = [];
    if (inp.rules.persona) fixed.push(`persona = ${inp.rules.persona.value} (set by rule from the tool log)`);
    if (inp.rules.scenarioPrimary) fixed.push(`scenario_primary = ${inp.rules.scenarioPrimary.value} (set by rule)`);
    if (inp.rules.scenarioCandidates.length) fixed.push(`candidate scenario: ${inp.rules.scenarioCandidates.join(', ')} (objective set or prior history)`);
    const instruction = `TASK: classify this call against taxonomy v${inp.taxonomyVersion}.
${fixed.length ? `Rule-layer tags already fixed — return them unchanged with confidence 1 and cite their turns: ${fixed.join('; ')}.` : 'No rule-layer tags fired.'}
Give a confidence from 0 to 1 for every tag (below 0.7 sends it to a human reviewer, so be honest). Judge the persona at the end of the call: a caller who opens as "just looking" and reveals a family move is P1. Use scenario_secondary "none" when one journey covers the call. List every event with the turn it happens on. Fill captured fields only with what the caller said or confirmed in this call. Label every body-phase turn with its segment.`;
    try {
      const { json, usage, model } = await structuredCall(renderCall(inp.call, inp.ctx), instruction, CLASSIFIER_SCHEMA, config.llm.effort);
      const o = zClassifier.parse(json);
      const tag = (t: z.infer<typeof zTag>) => ({ value: t.value === 'none' ? null : t.value, confidence: Math.max(0, Math.min(1, t.confidence)), evidence: clampTurns(t.evidence_turns, max) });
      const fields: Record<string, string | null> = {};
      for (const k of FIELD_KEYS) fields[k] = o.fields[k]?.trim() ? o.fields[k].trim() : null;
      const segs: Record<number, SegmentName> = {};
      for (const s of o.body_segments) if (SEGMENTS.includes(s.segment as SegmentName) && clampTurn(s.turn, max) !== null) segs[s.turn] = s.segment as SegmentName;
      const run: RunInfo = { id: newId('run'), kind: 'classifier', mode: 'llm', model, inputTokens: usage.input, outputTokens: usage.output, latencyMs: Date.now() - t0, status: 'ok', output: o };
      return {
        persona: tag(o.persona), personaResolvedTurn: o.persona_resolved_turn >= 0 ? clampTurn(o.persona_resolved_turn, max) : null,
        scenarioPrimary: tag(o.scenario_primary), scenarioSecondary: tag(o.scenario_secondary),
        intentStart: tag(o.intent_start) as ClassifierOutput['intentStart'], intentEnd: tag(o.intent_end) as ClassifierOutput['intentEnd'],
        events: o.events.filter((e) => EVENT_TYPES.some((x) => x.id === e.type)).map((e) => ({ type: e.type, turn: clampTurn(e.turn, max) ?? 0 })),
        fields, budgetAed: o.budget_aed > 0 ? o.budget_aed : null, timelineMonths: o.timeline_months >= 0 ? o.timeline_months : null,
        language: o.language || null, summary: o.summary, turnSegments: segs, run,
      };
    } catch (e) {
      log.error('Claude classifier failed', { call: inp.call.externalId, error: errMsg(e) });
      throw Object.assign(new Error(`classifier: ${errMsg(e)}`), { run: { id: newId('run'), kind: 'classifier', mode: 'llm', model: config.llm.model, inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - t0, status: 'error', error: errMsg(e) } satisfies RunInfo });
    }
  },

  async judge(inp: JudgeInput): Promise<JudgeOutput> {
    const t0 = Date.now();
    const max = inp.call.turns.length - 1;
    const cps = inp.checkpoints.map((c) => `- ${c.id}: ${c.label}${c.hint ? ` (${c.hint})` : ''}`).join('\n');
    const instruction = `TASK: judge this call.
Persona ${inp.personaId ?? 'P0'} (${inp.personaPath} path); primary scenario ${inp.scenario ?? 'unknown'}${inp.scenario2 ? `, secondary ${inp.scenario2}` : ''}.
Phases: ${inp.phases.phases.map((p) => `${p.name} #${p.from}–#${p.to}`).join(', ') || 'none'}.
Captured fields: ${JSON.stringify(Object.fromEntries(Object.entries(inp.fields).filter(([, v]) => v)))}.
1. Score every judged metric in its raw unit, or mark it not applicable.
2. Decide every gate. For G1 compare each project fact the agent stated with the get_project_details output in this call; a fact with no tool output behind it, or that differs from it, fails. G8 fails when the agent claims a booking, cancellation or send that no tool result confirmed.
3. For these expected-path checkpoints of ${inp.scenario ?? 'the scenario'}, say whether each was reached and on which turn (-1 if missed):
${cps || '- none'}
4. Coaching: for the (up to) three moments that cost the call most, give the turn, the issue, and what the agent should have said instead.`;
    try {
      const { json, usage, model } = await structuredCall(renderCall(inp.call, inp.ctx, inp.phases), instruction, JUDGE_SCHEMA, config.llm.effort);
      const o = zJudge.parse(json);
      const metrics: JudgeOutput['metrics'] = {};
      for (const m of JUDGED_METRICS) {
        const r = o.metrics[m.key];
        if (r) metrics[m.key] = { applicable: r.applicable, raw: r.applicable ? r.raw : null, evidence: clampTurns(r.evidence_turns, max), rationale: r.rationale };
      }
      const gates: JudgeOutput['gates'] = {};
      for (const g of JUDGED_GATES) { const r = o.gates[g]; if (r) gates[g] = { failed: r.failed, turn: r.failed ? clampTurn(r.turn, max) : null, detail: r.detail }; }
      const checkpoints: JudgeOutput['checkpoints'] = {};
      for (const c of o.checkpoints) checkpoints[c.id] = { hit: c.hit, turn: c.hit ? clampTurn(c.turn, max) : null };
      const run: RunInfo = { id: newId('run'), kind: 'judge', mode: 'llm', model, inputTokens: usage.input, outputTokens: usage.output, latencyMs: Date.now() - t0, status: 'ok', output: o };
      return { metrics, gates, checkpoints, coaching: o.coaching.slice(0, 3).map((c) => ({ turn: clampTurn(c.turn, max), issue: c.issue, better: c.better_response })), run };
    } catch (e) {
      log.error('Claude judge failed', { call: inp.call.externalId, error: errMsg(e) });
      throw Object.assign(new Error(`judge: ${errMsg(e)}`), { run: { id: newId('run'), kind: 'judge', mode: 'llm', model: config.llm.model, inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - t0, status: 'error', error: errMsg(e) } satisfies RunInfo });
    }
  },
};

void GATES;
