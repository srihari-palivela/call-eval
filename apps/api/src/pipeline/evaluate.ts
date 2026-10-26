// The evaluation pipeline for one call: context → segment → tag → code, judge and audio checks →
// fields → score. Pure apart from the judge and audio calls, so it runs the same in tests, in the
// worker and in the demo seeder.

import {
  DEFAULT_TOOL_ALIASES, FRAMEWORK_VERSION, GATES, METRICS, TAXONOMY_VERSION, budgetBand, isTargetPersona, metricByKey,
  normaliseMetric, personaById, scenarioById, scoreCall, timelineBand,
  type CallEventRec, type CanonicalCall, type Evaluation, type GateOutcome, type MetricOutcome, type SettingsDTO, type TagValue, type Tags,
  INVESTOR_DISCOVERY, INVESTOR_FIELDS,
} from '@calleval/framework';
import { sha } from '../lib/ids';
import { errMsg } from '../lib/log';
import { PLAYBOOK } from '../recommendations/playbook';
import { audioMetrics, type AudioResult } from './audio';
import { analyseTools, codeGates, codeMetrics, type RawMetric } from './code-checks';
import { buildContext } from './context';
import { heuristicClassify, heuristicJudge } from './judge/heuristic';
import type { ClassifierOutput, Judge, JudgeOutput, RunInfo } from './judge/types';
import { evaluatePath, judgeCheckpoints } from './path';
import { ruleTags } from './rules';
import { segmentCall } from './segment';
import { quoteOf } from './text';

export type HumanOverrides = { tags?: Record<string, string>; answerKey?: Record<string, string> | null; gates?: Record<string, boolean> };

export type EvaluationResult = {
  evaluation: Evaluation;
  runs: RunInfo[];
  classifier: ClassifierOutput;
  summary: string;
};

export function applyAliases(call: CanonicalCall, extra: Record<string, string> = {}): CanonicalCall {
  const aliases = { ...DEFAULT_TOOL_ALIASES, ...extra };
  const toolCalls = call.toolCalls
    .map((tc) => (tc.name in aliases ? { ...tc, rawName: tc.rawName ?? tc.name, name: aliases[tc.name] } : tc))
    .filter((tc) => tc.name);
  return { ...call, toolCalls };
}

/** Turn timing is measured (word timestamps, real ends) rather than estimated from word counts. */
export function hasMeasuredTiming(call: CanonicalCall) {
  if (call.provider === 'demo') return true;
  return call.turns.length > 0 && call.turns.filter((t) => t.words?.length).length / call.turns.length > 0.6;
}

const toTag = (t: { value: string | null; confidence: number; evidence: number[] }, layer: TagValue['layer'], runId?: string | null): TagValue => ({ value: t.value, confidence: t.confidence, layer, evidence: t.evidence, runId: runId ?? null });

function combine(code: RawMetric | undefined, judge: { applicable: boolean; raw: number | null; evidence: number[]; rationale: string } | undefined, kind: string): RawMetric | undefined {
  if (!code?.applicable) return judge ? { raw: judge.raw, applicable: judge.applicable, evidence: judge.evidence, rationale: judge.rationale } : code;
  if (!judge?.applicable || judge.raw === null) return code;
  // Conservative merge: a count takes the larger, a pass or share takes the lower.
  const pickJudge = kind === 'low' ? (judge.raw ?? 0) > (code.raw ?? 0) : (judge.raw ?? 100) < (code.raw ?? 100);
  return pickJudge ? { raw: judge.raw, applicable: true, evidence: Array.from(new Set([...judge.evidence, ...code.evidence])), rationale: judge.rationale || code.rationale } : { ...code, evidence: Array.from(new Set([...code.evidence, ...judge.evidence])), rationale: code.rationale || judge.rationale };
}

export async function evaluateCall(rawCall: CanonicalCall, opts: { callId: string; judge: Judge; settings: SettingsDTO; audio?: AudioResult | null; human?: HumanOverrides; toolAliases?: Record<string, string> }): Promise<EvaluationResult> {
  const call = applyAliases(rawCall, opts.toolAliases);
  const runs: RunInfo[] = [];
  const ctx = buildContext(call);
  const rules = ruleTags(call, ctx);

  // Tag: rules → classifier → human review.
  let cls: ClassifierOutput;
  try {
    cls = await opts.judge.classify({ call, ctx, rules, taxonomyVersion: TAXONOMY_VERSION });
  } catch (e) {
    const failed = (e as { run?: RunInfo }).run;
    if (failed) runs.push(failed);
    cls = heuristicClassify({ call, ctx, rules, taxonomyVersion: TAXONOMY_VERSION });
    cls.run.error = `LLM classifier failed, heuristic used: ${errMsg(e)}`;
  }
  runs.push(cls.run);
  const layer = cls.run.mode === 'llm' ? 'classifier' : 'heuristic';
  const human = opts.human?.tags ?? {};
  const pick = (key: string, rule: TagValue | undefined, model: { value: string | null; confidence: number; evidence: number[] }): TagValue => {
    if (human[key]) return { value: human[key], confidence: 1, layer: 'human', evidence: model.evidence };
    if (rule) return { ...rule, evidence: rule.evidence.length ? rule.evidence : model.evidence };
    return toTag(model, layer, cls.run.id);
  };
  const persona = pick('persona', rules.persona, cls.persona);
  const scenarioPrimary = pick('scenario_primary', rules.scenarioPrimary, cls.scenarioPrimary);
  const scenarioSecondary = human.scenario_secondary ? pick('scenario_secondary', undefined, cls.scenarioSecondary) : toTag(cls.scenarioSecondary.value === scenarioPrimary.value ? { value: null, confidence: 0, evidence: [] } : cls.scenarioSecondary, layer, cls.run.id);
  const intentStart = pick('intent_start', undefined, cls.intentStart) as Tags['intentStart'];
  const intentEnd = pick('intent_end', undefined, cls.intentEnd) as Tags['intentEnd'];
  const pDef = personaById(persona.value);
  const personaPath = rules.personaPath ?? pDef.path;
  if (persona.value && pDef.path !== '—') ctx.personaSource = ctx.persona !== 'unknown' ? 'history' : 'introduction';

  const phases = segmentCall(call, ctx, { personaResolvedAt: rules.failedCall ? null : cls.personaResolvedTurn ?? undefined, turnSegments: cls.turnSegments });

  // Captured fields: classifier extraction, provider data collection where ids match, known facts.
  const fields: Record<string, string | null> = { persona: personaPath === '—' ? null : personaPath, ...cls.fields };
  for (const [k, v] of Object.entries(call.providerAnalysis?.dataCollection ?? {})) if (k in fields && !fields[k] && v.value !== null && v.value !== undefined && v.value !== '') fields[k] = String(v.value);
  if (rules.brokerRegistration && !fields.registration) fields.registration = rules.brokerRegistration;
  if (ctx.customerName && !fields.name) fields.name = ctx.customerName;

  const scenario = scenarioPrimary.value;
  const measuredTiming = hasMeasuredTiming(call);
  const tools = analyseTools(call, ctx, personaPath);
  const codeIn = { call, ctx, phases, personaPath, scenario, fields, measuredTiming };
  const code = codeMetrics(codeIn, tools);
  const cGates = codeGates(codeIn, tools);

  let judged: JudgeOutput;
  const judgeIn = { call, ctx, phases, personaId: persona.value, personaPath, scenario, scenario2: scenarioSecondary.value, fields, tools, checkpoints: judgeCheckpoints(scenario) };
  try {
    judged = await opts.judge.judge(judgeIn);
  } catch (e) {
    const failed = (e as { run?: RunInfo }).run;
    if (failed) runs.push(failed);
    judged = heuristicJudge(judgeIn);
    judged.run.error = `LLM judge failed, heuristic used: ${errMsg(e)}`;
  }
  runs.push(judged.run);

  const audio = opts.audio && opts.audio.usable ? audioMetrics(call, opts.audio) : {};
  const recording = !!call.recording?.available;

  // Field capture accuracy against a human answer key, when one exists.
  if (opts.human?.answerKey && Object.keys(opts.human.answerKey).length) {
    const key = opts.human.answerKey;
    const keys = Object.keys(key);
    const norm = (s: string | null | undefined) => (s ?? '').toString().trim().toLowerCase();
    const tp = keys.filter((k) => norm(fields[k]) && norm(fields[k]) === norm(key[k])).length;
    const predicted = keys.filter((k) => norm(fields[k])).length;
    const precision = predicted ? tp / predicted : 1, recall = keys.length ? tp / keys.length : 1;
    code.fca = { raw: +(Math.min(precision, recall) * 100).toFixed(1), applicable: true, evidence: [], rationale: `Precision ${(precision * 100).toFixed(0)}%, recall ${(recall * 100).toFixed(0)}% against the labelled answer key.` };
  }

  // Merge into metric outcomes.
  const metrics: MetricOutcome[] = METRICS.map((m) => {
    let r: RawMetric | undefined;
    const j = judged.metrics[m.key];
    if (m.method === 'code') r = code[m.key];
    else if (m.method === 'judge') r = j ? { raw: j.raw, applicable: j.applicable, evidence: j.evidence, rationale: j.rationale } : undefined;
    else if (m.method === 'code + judge') r = combine(code[m.key], j, m.norm.kind);
    else r = audio[m.key] ?? (m.needsAudio ? undefined : code[m.key]);
    // No usable recording drops the whole Emotion and realism dimension; weights re-normalise.
    if (m.dim === 'emo' && !recording) r = undefined;
    // Investor path: broker checks don't apply; broker path: buyer discovery isn't scored.
    if (m.key === 'bpp' && personaPath !== 'Broker') r = undefined;
    if (!r || !r.applicable || r.raw === null || r.raw === undefined) {
      return { key: m.key, applicable: false, raw: null, value: null, method: m.method, evidence: r?.evidence ?? [], rationale: r?.rationale ?? null, runId: null };
    }
    const value = r.value !== undefined && r.value !== null ? r.value : normaliseMetric(m, r.raw);
    const runId = m.method.includes('judge') && j ? judged.run.id : m.method === 'audio' && audio[m.key] ? 'audio' : null;
    return { key: m.key, applicable: true, raw: r.raw, value, method: judged.run.mode === 'heuristic' && m.method.includes('judge') ? `${m.method} (heuristic)` : m.method, evidence: r.evidence.slice(0, 6), rationale: r.rationale ?? null, runId };
  });

  // Gates: code and judge each decide what they can see; a failure from either stands.
  const gates: GateOutcome[] = GATES.map((g) => {
    const c = cGates.find((x) => x.id === g.id && x.failed);
    const jg = judged.gates[g.id];
    const humanCall = opts.human?.gates?.[g.id];
    if (humanCall === false) return { id: g.id, failed: false, turn: null, detail: 'Overturned in human review.', source: 'human' };
    if (humanCall === true) return { id: g.id, failed: true, turn: c?.turn ?? jg?.turn ?? null, detail: c?.detail ?? jg?.detail ?? 'Confirmed in human review.', source: 'human' };
    if (c) return { id: g.id, failed: true, turn: c.turn, detail: c.detail, source: 'code' };
    if (jg?.failed) return { id: g.id, failed: true, turn: jg.turn, detail: jg.detail, source: judged.run.mode === 'llm' ? 'judge' : 'heuristic', runId: judged.run.id };
    return { id: g.id, failed: false, turn: null, detail: null, source: 'code' };
  });
  const failedGates = gates.filter((g) => g.failed);

  const values = Object.fromEntries(metrics.map((m) => [m.key, m.value]));
  const score = scoreCall(values, failedGates.length, opts.settings.weights);

  const path = evaluatePath(call, scenario, phases, tools, fields, judged.checkpoints);

  // Events: rules, classifier and gates.
  const events: CallEventRec[] = [];
  const seen = new Set<string>();
  const addEv = (e: CallEventRec) => { const k = `${e.type}|${e.turn}`; if (!seen.has(k)) { seen.add(k); events.push(e); } };
  rules.events.forEach(addEv);
  cls.events.forEach((e) => addEv({ type: e.type, turn: e.turn, detail: null, source: layer }));
  failedGates.forEach((g) => addEv({ type: 'gate_failure', turn: g.turn ?? 0, detail: g.id, source: g.source as CallEventRec['source'] }));
  events.sort((a, b) => a.turn - b.turn);

  const rank = { cold: 0, warm: 1, hot: 2 } as const;
  const intentChange = intentStart.value && intentEnd.value ? `${intentStart.value} → ${intentEnd.value}` : null;
  if (intentStart.value && intentEnd.value && !events.some((e) => e.type === 'intent_rose' || e.type === 'intent_fell')) {
    if (rank[intentEnd.value] > rank[intentStart.value]) addEv({ type: 'intent_rose', turn: call.turns.length - 1, detail: null, source: layer });
    if (rank[intentEnd.value] < rank[intentStart.value]) addEv({ type: 'intent_fell', turn: call.turns.length - 1, detail: null, source: layer });
  }

  // Qualified lead: target persona resolved with at least 5 of the 7 discovery fields (brokers: registration status known).
  const covered = INVESTOR_DISCOVERY.filter((f) => f.fields.some((k) => fields[k] && fields[k] !== 'Not captured')).length;
  const qualified = personaPath === 'Broker' ? !!fields.registration : personaPath === 'Investor' && phases.personaResolvedAt !== null && covered >= 5;
  void INVESTOR_FIELDS;

  const schRaw = metrics.find((m) => m.key === 'sch')?.raw ?? null;
  const abandoned = metrics.find((m) => m.key === 'ab')?.value === 0;

  const lowest = metrics.filter((m) => m.applicable && m.value !== null)
    .sort((a, b) => (a.value! - b.value!) || METRICS.findIndex((x) => x.key === a.key) - METRICS.findIndex((x) => x.key === b.key))
    .slice(0, 3)
    .map((m) => ({ key: m.key, value: m.value!, turn: m.evidence[0] ?? null, quote: quoteOf(call, m.evidence[0]), why: m.rationale ?? null }));

  // Coaching: the judge's own coaching when it ran, otherwise the playbook for the weakest points.
  const coaching: Evaluation['coaching'] = judged.coaching.length
    ? judged.coaching.map((c) => ({ title: c.issue, detail: c.issue, turn: c.turn, suggestion: c.better }))
    : [...failedGates.map((g) => ({ key: g.id, turn: g.turn, why: g.detail })), ...lowest.filter((l) => l.value < 70).map((l) => ({ key: l.key, turn: l.turn, why: l.why }))]
      .slice(0, 3)
      .map((x) => ({ title: PLAYBOOK[x.key]?.title ?? metricByKey(x.key)?.name ?? x.key, detail: x.why ?? '', turn: x.turn, suggestion: PLAYBOOK[x.key]?.coach || null }));

  // Review queue: low-confidence tags, every gate failure, and a random sample.
  const review: Evaluation['review'] = [];
  const thr = opts.settings.confidenceThreshold;
  for (const [key, t] of [['persona', persona], ['scenario_primary', scenarioPrimary], ['intent_end', intentEnd]] as const) {
    if (t.layer !== 'human' && t.layer !== 'rule' && t.value && t.confidence < thr) review.push({ kind: 'tag', reason: `${key.replace('_', ' ')} under ${thr} confidence`, tagKey: key });
  }
  if (failedGates.length) review.push({ kind: 'gate', reason: `Compliance gate failed: ${failedGates.map((g) => g.id).join(', ')}` });
  if (!review.length && parseInt(sha(opts.callId, 8), 16) / 0xffffffff < opts.settings.reviewSampleRate) review.push({ kind: 'sample', reason: `${Math.round(opts.settings.reviewSampleRate * 100)}% random sample` });

  const dv = call.dynamicVariables ?? {};
  const facets: Record<string, string | null> = {
    direction: ctx.direction === 'unknown' ? null : ctx.direction === 'inbound' ? 'Inbound' : 'Outbound',
    history: ctx.history === 'returning' ? 'Returning' : 'New',
    intent_start: intentStart.value, intent_end: intentEnd.value,
    budget_band: budgetBand(cls.budgetAed, opts.settings.budgetBands),
    timeline_band: personaPath === 'Investor' ? timelineBand(cls.timelineMonths) : null,
    language: cls.language ?? call.language ?? null,
    broker_registration: personaPath === 'Broker' ? (fields.registration ?? null) : null,
    lead_source: typeof dv.lead_source === 'string' ? dv.lead_source : null,
  };

  const toolNames = Array.from(new Set([...tools.made.map((x) => x.tc.name), ...tools.expected.map((x) => x.tool)]));
  const toolStats = toolNames.map((name) => {
    const made = tools.made.filter((x) => x.tc.name === name);
    const exp = tools.expected.filter((x) => x.tool === name);
    const fid = made.filter((x) => x.fidelityOk !== null);
    return { name, made: made.length, correct: made.filter((x) => x.correct && x.argsOk).length, expected: exp.length, met: exp.filter((x) => x.met).length, fidelityChecked: fid.length, fidelityOk: fid.filter((x) => x.fidelityOk).length, errors: made.filter((x) => x.tc.ok === false || /\b(fail|failed|error|unavailable)\b/i.test(x.tc.resultText ?? '')).length };
  });

  const evaluation: Evaluation = {
    callId: opts.callId,
    frameworkVersion: FRAMEWORK_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
    context: ctx,
    phases,
    tags: { persona, scenarioPrimary, scenarioSecondary, intentStart, intentEnd, facets, events },
    fields,
    metrics,
    gates,
    path,
    outcome: {
      nextStep: tools.nextStep,
      nextStepDetail: tools.nextStepTool ? `${tools.nextStepTool.name}${tools.meetingKind ? ` · ${tools.meetingKind}` : ''}` : null,
      meetingKind: tools.meetingKind,
      sentimentDelta: schRaw,
      intentChange,
      qualified: !!qualified && isTargetPersona(persona.value),
      abandoned,
    },
    dims: score.roll,
    rawCqs: +score.raw.toFixed(2),
    cqs: score.cqs,
    band: score.band,
    lowest,
    coaching,
    review,
    judgeMode: judged.run.mode,
    toolStats,
  };
  void scenarioById;
  return { evaluation, runs, classifier: cls, summary: cls.summary };
}
