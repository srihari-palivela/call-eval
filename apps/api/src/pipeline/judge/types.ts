import { METRICS, type CanonicalCall, type ContextRecord, type Intent, type Phases, type SegmentName } from '@calleval/framework';
import type { RuleTags } from '../rules';
import type { ToolAnalysis } from '../code-checks';

export type ScoredTag = { value: string | null; confidence: number; evidence: number[] };

export type ClassifierOutput = {
  persona: ScoredTag;
  personaResolvedTurn: number | null;
  scenarioPrimary: ScoredTag;
  scenarioSecondary: ScoredTag;
  intentStart: ScoredTag & { value: Intent | null };
  intentEnd: ScoredTag & { value: Intent | null };
  events: { type: string; turn: number }[];
  fields: Record<string, string | null>;
  budgetAed: number | null;
  timelineMonths: number | null;
  language: string | null;
  summary: string;
  turnSegments?: Record<number, SegmentName>;
  run: RunInfo;
};

export type JudgedMetric = { applicable: boolean; raw: number | null; evidence: number[]; rationale: string };
export type JudgedGate = { failed: boolean; turn: number | null; detail: string };

export type JudgeOutput = {
  metrics: Record<string, JudgedMetric>;
  gates: Record<string, JudgedGate>;
  checkpoints: Record<string, { hit: boolean; turn: number | null }>;
  coaching: { turn: number | null; issue: string; better: string }[];
  run: RunInfo;
};

export type RunInfo = { id: string; kind: 'classifier' | 'judge'; mode: 'llm' | 'heuristic'; model: string | null; inputTokens: number; outputTokens: number; latencyMs: number; status: 'ok' | 'error'; error?: string | null; output?: unknown };

export type ClassifyInput = { call: CanonicalCall; ctx: ContextRecord; rules: RuleTags; taxonomyVersion: string };

export type JudgeInput = {
  call: CanonicalCall;
  ctx: ContextRecord;
  phases: Phases;
  personaId: string | null;
  personaPath: 'Investor' | 'Broker' | 'Non-target' | '—';
  scenario: string | null;
  scenario2: string | null;
  fields: Record<string, string | null>;
  tools: ToolAnalysis;
  checkpoints: { id: string; label: string; hint?: string }[];
};

export interface Judge {
  mode: 'llm' | 'heuristic';
  model: string | null;
  classify(input: ClassifyInput): Promise<ClassifierOutput>;
  judge(input: JudgeInput): Promise<JudgeOutput>;
}

/** Metrics the judge scores (alone, or alongside a code check). */
export const JUDGED_METRICS = METRICS.filter((m) => m.rubric);
export const JUDGED_GATES = ['G1', 'G2', 'G3', 'G4', 'G5', 'G7', 'G8'];
