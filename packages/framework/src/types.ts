// Provider-neutral call record and the evaluation the pipeline produces from it.

import type { DimKey } from './metrics';
import type { Intent } from './taxonomy';

export type Provider = 'elevenlabs' | 'retell' | 'upload' | 'demo';
export type Direction = 'inbound' | 'outbound' | 'unknown';
export type Speaker = 'agent' | 'caller';

export type EndReason =
  | 'natural_close' | 'caller_hangup' | 'agent_hangup' | 'transfer' | 'time_limit'
  | 'voicemail' | 'dnc' | 'no_answer' | 'error' | 'unknown';

export type CanonicalWord = { w: string; s: number; e: number };

export type CanonicalTurn = {
  idx: number;
  speaker: Speaker;
  text: string;
  /** Seconds from call start. */
  startS: number;
  endS?: number;
  words?: CanonicalWord[];
  /** The agent was cut off by the caller during this turn (provider flag). */
  interrupted?: boolean;
  /** Provider-measured response latency for this agent turn, if any. */
  latencyS?: number;
  /** Provider per-turn timing breakdown, if any (e.g. ElevenLabs conversation_turn_metrics). */
  turnMetrics?: Record<string, number>;
  /** Delivery tags found in the agent text, e.g. [confidently]. */
  tags?: string[];
};

export type CanonicalToolCall = {
  id: string;
  /** Agent turn index the call belongs to. */
  turnIdx: number;
  name: string;
  /** The tool name as the provider reported it, before aliasing. */
  rawName?: string;
  args: Record<string, unknown>;
  result?: unknown;
  resultText?: string;
  ok?: boolean;
  startS?: number;
  durationS?: number;
};

export type ProviderAnalysis = {
  summary?: string | null;
  successful?: boolean | null;
  sentiment?: string | null;
  evaluationCriteria?: Record<string, { result: string; rationale?: string }>;
  dataCollection?: Record<string, { value: unknown; rationale?: string }>;
};

export type CanonicalCall = {
  provider: Provider;
  externalId: string;
  agentExternalId?: string | null;
  agentName?: string | null;
  /** Provider agent version (Retell agent_version, ElevenLabs version_id). */
  agentVersion?: string | null;
  startedAt: string;
  durationS: number;
  direction: Direction;
  endReason: EndReason;
  endReasonRaw?: string | null;
  language?: string | null;
  fromNumber?: string | null;
  toNumber?: string | null;
  dynamicVariables: Record<string, unknown>;
  turns: CanonicalTurn[];
  toolCalls: CanonicalToolCall[];
  recording?: { url?: string | null; multiChannelUrl?: string | null; channels?: number | null; available: boolean } | null;
  providerAnalysis?: ProviderAnalysis | null;
  /** Provider call-level latency stats in seconds. */
  latency?: { e2eP50?: number; e2eP90?: number; llmP50?: number; llmP90?: number; ttsP50?: number; ttsP90?: number } | null;
  cost?: { amount: number; currency: string } | null;
  leadId?: string | null;
  promptVersionHint?: string | null;
};

// ---------- Evaluation ----------

export type TagLayer = 'rule' | 'classifier' | 'human' | 'heuristic';

export type TagValue = { value: string | null; confidence: number; layer: TagLayer; evidence: number[]; runId?: string | null };

export type ContextRecord = {
  direction: Direction;
  identity: 'known' | 'unknown';
  history: 'new' | 'returning';
  objective: 'empty' | 'set' | 'callback';
  objectiveText?: string | null;
  persona: 'unknown' | 'investor' | 'broker';
  personaSource: 'history' | 'introduction' | 'unresolved';
  customerName?: string | null;
  knownFacts?: Record<string, unknown> | string | null;
};

export type PhaseName = 'Introduction' | 'Body' | 'Conclusion';
export type SegmentName = 'Discovery' | 'Pitch' | 'Objection' | 'Action' | 'Off-topic';

export type Phases = {
  phases: { name: PhaseName; from: number; to: number }[];
  segments: { name: SegmentName; from: number; to: number }[];
  /** Per body turn segment label (turn idx → segment). */
  turnSegments: Record<number, SegmentName>;
  personaResolvedAt: number | null;
  closingSignal: { turn: number; kind: string } | null;
};

export type CallEventRec = { type: string; turn: number; detail?: string | null; source: TagLayer | 'code' };

export type Tags = {
  persona: TagValue;
  scenarioPrimary: TagValue;
  scenarioSecondary: TagValue;
  intentStart: TagValue & { value: Intent | null };
  intentEnd: TagValue & { value: Intent | null };
  facets: Record<string, string | null>;
  events: CallEventRec[];
};

export type MetricOutcome = {
  key: string;
  applicable: boolean;
  /** Raw measurement in the metric's unit. */
  raw: number | null;
  /** 0–100 after normalisation; null when not applicable. */
  value: number | null;
  method: string;
  evidence: number[];
  rationale?: string | null;
  runId?: string | null;
};

export type GateOutcome = { id: string; failed: boolean; turn: number | null; detail: string | null; source: string; runId?: string | null };

export type PathOutcome = {
  scenario: string;
  steps: { id: string; label: string; hit: boolean; turn: number | null }[];
  hit: number;
  total: number;
  deviation: string | null;
};

export type CallOutcome = {
  nextStep: 'meeting' | 'callback' | 'document' | 'transfer' | 'note' | null;
  nextStepDetail: string | null;
  meetingKind: string | null;
  sentimentDelta: number | null;
  intentChange: string | null;
  qualified: boolean;
  abandoned: boolean;
};

export type Evaluation = {
  callId: string;
  frameworkVersion: string;
  taxonomyVersion: string;
  context: ContextRecord;
  phases: Phases;
  tags: Tags;
  fields: Record<string, string | null>;
  metrics: MetricOutcome[];
  gates: GateOutcome[];
  path: PathOutcome | null;
  outcome: CallOutcome;
  dims: Partial<Record<DimKey, { v: number; n: number }>>;
  rawCqs: number;
  cqs: number;
  band: string;
  lowest: { key: string; value: number; turn: number | null; quote: string | null; why: string | null }[];
  coaching: { title: string; detail: string; turn: number | null; suggestion: string | null }[];
  review: { kind: string; reason: string; tagKey?: string | null }[];
  judgeMode: 'llm' | 'heuristic';
  /** Per-tool tallies for tool health: calls made, correct, expected, met, fidelity checked/ok, errors. */
  toolStats: { name: string; made: number; correct: number; expected: number; met: number; fidelityChecked: number; fidelityOk: number; errors: number }[];
};
