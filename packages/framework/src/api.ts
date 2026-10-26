// Request filters and response shapes shared by the API and the console.

import type { Dimension, DimKey, Gate, Metric } from './metrics';
import type { EventType, Facet, Persona, Scenario } from './taxonomy';

export type RangeKey = '7' | '30' | '90';
export type DirKey = 'all' | 'in' | 'out';
export type PathKey = 'all' | 'Investor' | 'Broker' | 'Non-target';

export type Filters = { range: RangeKey; dir: DirKey; path: PathKey; ver: string; agent: string };

export type PromptVersionDTO = { label: string; agentId: string | null; agentName: string | null; firstSeen: string; lastSeen: string | null; calls: number; live: boolean };
export type AgentDTO = { id: string; name: string; provider: string; externalId: string };

export type MetaDTO = {
  personas: Persona[];
  p0: Persona;
  scenarios: Scenario[];
  dims: Dimension[];
  metrics: Omit<Metric, 'rubric'>[];
  gates: Gate[];
  eventTypes: EventType[];
  facets: Facet[];
  taxonomyVersion: string;
  frameworkVersion: string;
  weights: Record<DimKey, number>;
  promptVersions: PromptVersionDTO[];
  liveVersion: string | null;
  previousVersion: string | null;
  agents: AgentDTO[];
  dataMode: 'live' | 'demo' | 'empty';
  llm: { enabled: boolean; model: string | null };
  audioModel: { enabled: boolean };
  totals: { calls: number; scored: number; lastCallAt: string | null };
  settings: SettingsDTO;
};

export type SettingsDTO = {
  weights: Record<DimKey, number>;
  attributionDays: number;
  reservationAttributionDays: number;
  minCellCalls: number;
  reviewSampleRate: number;
  confidenceThreshold: number;
  costPerMinuteAed: number | null;
  budgetBands: { band: string; maxAed: number | null }[];
  retentionDays: number | null;
  goodLine: number;
};

/** One persona × scenario cell. Scores are medians across the cell's calls. */
export type CellDTO = {
  pid: string;
  sid: string;
  n: number;
  cqs: number;
  /** Gate-failure rate, percent. */
  gate: number;
  dims: Record<DimKey, number>;
  /** Meeting-booked rate, percent of calls. */
  meet: number;
  /** Reservation value per call, AED thousands. */
  res: number;
  /** Next-step rate, percent. */
  ns: number;
};

export type MatrixDTO = { ver: string | null; cells: CellDTO[]; calls: number };

export type CellDetailDTO = {
  cell: CellDTO;
  path: { label: string; pct: number; exit: boolean }[];
  tools: { name: string; p: number | null; r: number | null; f: number | null; n: number }[];
  personaCheck: { label: string; value: string } | null;
  calls: CallListItemDTO[];
};

export type CallListItemDTO = {
  id: string;
  provider: string;
  externalId: string;
  title: string;
  startedAt: string;
  durationS: number;
  direction: string;
  persona: string | null;
  scenario: string | null;
  scenario2: string | null;
  cqs: number | null;
  rawCqs: number | null;
  band: string | null;
  gates: string[];
  promptVersion: string | null;
  agentName: string | null;
  status: string;
  note: string | null;
  needsReview: boolean;
  nextStep: string | null;
};

export type CallListDTO = { items: CallListItemDTO[]; total: number };

export type TurnDTO = {
  id: number;
  sp: 'A' | 'C';
  t: number;
  end?: number | null;
  text: string;
  lat?: number | null;
  tag?: string | null;
  barge?: string | null;
  event?: string | null;
  seg?: string | null;
  phase?: string | null;
  tools?: { name: string; args: string; result: string; ok: boolean | null; durationS: number | null }[];
};

export type SpanDTO = { label: string; start: number; dur: number; kind: 'eot' | 'llm' | 'tool' | 'tts' | 'bg' };

export type MetricResultDTO = {
  key: string;
  dim: DimKey;
  name: string;
  target: string;
  method: string;
  value: number | null;
  raw: number | null;
  unit: string;
  evidence: number[];
  rationale: string | null;
  runId: string | null;
};

export type RecommendationDTO = {
  id: string;
  scope: 'call' | 'cell' | 'persona' | 'scenario' | 'dimension' | 'global';
  scopeKey: string | null;
  kind: 'prompt' | 'tool' | 'routing' | 'taxonomy' | 'voice' | 'data' | 'coaching';
  title: string;
  problem: string;
  proposal: string;
  promptPatch: string | null;
  evidence: { callId: string; turn: number | null; quote: string | null; metric: string | null }[];
  metrics: string[];
  impact: { calls: number; pointsBelow: number; score: number; valueAtStake: number | null };
  priority: number;
  status: 'proposed' | 'accepted' | 'in_prompt' | 'verified' | 'rejected';
  source: 'playbook' | 'llm';
  targetVersion: string | null;
  createdAt: string;
  updatedAt: string;
  note: string | null;
};

export type ReviewItemDTO = {
  id: string;
  callId: string;
  kind: 'tag' | 'gate' | 'sample' | 'metric';
  tagKey: string | null;
  reason: string;
  status: 'open' | 'done';
  currentValue: string | null;
  confidence: number | null;
  createdAt: string;
  resolvedAt: string | null;
  resolution: Record<string, unknown> | null;
  title: string;
};

export type CallDetailDTO = {
  id: string;
  provider: string;
  externalId: string;
  title: string;
  startedAt: string;
  durationS: number;
  direction: string;
  endReason: string;
  endReasonRaw: string | null;
  language: string | null;
  promptVersion: string | null;
  agentVersion: string | null;
  agentName: string | null;
  audioUrl: string | null;
  recordingChannels: number | null;
  status: string;
  source: string;
  judgeMode: string | null;
  note: string | null;
  noteTone: 'ink' | 'accent';
  context: [string, string][];
  record: [string, string][];
  gates: { id: string; text: string; detail: string; turn: number | null; runId: string | null }[];
  tags: { key: string; label: string; value: string; conf: number; layer: string; ev: number[] }[];
  events: { type: string; label: string; turn: number }[];
  facets: [string, string][];
  phases: { name: string; from: number; to: number }[];
  segs: { name: string; from: number; to: number }[];
  path: { scenario: string; steps: { label: string; turn: number | null; hit: boolean }[]; deviation: string | null } | null;
  fields: [string, string][];
  outcome: [string, string][];
  metrics: MetricResultDTO[];
  dims: Partial<Record<DimKey, { v: number; n: number }>>;
  cqs: number | null;
  rawCqs: number | null;
  band: string | null;
  lowest: { key: string; value: number; turn: number | null; quote: string | null; why: string | null }[];
  turns: TurnDTO[];
  trace: {
    id: string;
    spans: number;
    llmCalls: number;
    inTok: number;
    outTok: number;
    n: number;
    sums: { eot: number; llm: number; tool: number; tts: number };
    slowTurn: { id: number; lat: number } | null;
    evals: [string, string][];
    turnSpans: Record<string, SpanDTO[]>;
  };
  coaching: { title: string; detail: string; turn: number | null; suggestion: string | null }[];
  recommendations: RecommendationDTO[];
  review: ReviewItemDTO[];
  providerAnalysis: { summary?: string | null; successful?: boolean | null; sentiment?: string | null } | null;
  crm: { leadId: string | null; outcomes: { stage: string; at: string; valueAed: number | null; credited: boolean }[] };
};

export type VersionCellDTO = { pid: string; sid: string; n2: number; n3: number; old: number; nw: number; d: number; lo: number; hi: number; verdict: 'up' | 'down' | 'flat' | 'few'; key: string };
export type VersionReportDTO = {
  from: string | null;
  to: string | null;
  fromWindow: string | null;
  toWindow: string | null;
  cells: VersionCellDTO[];
  fixKeys: string[];
};

export type TracesDTO = {
  window: string;
  days: { day: string; date: string; total: number; eot: number; llm: number; tool: number; tts: number; n: number }[];
  coverage: { calls: number; withTiming: number; turns: number; turnsWithLatency: number; metricsLinked: number; orphan: number };
  toolSpans: { name: string; n: number; p50: number | null; p90: number | null; errPct: number; topError: string | null }[];
  llmSpans: { measure: string; a: string; b: string; flag: boolean }[];
  versions: { a: string | null; b: string | null };
  evalRuns: { name: string; meta: string; runs: string; err: string; bad: boolean }[];
  slowTurns: { callId: string; turn: number; lat: number; why: string }[];
};

export type FunnelInvestorRow = { id: string; name: string; n: number; q: number; ns: number; mb: number; show: number | null; sv: number | null; res: number | null; qual: number; value: number | null; lift: number; mins: number };
export type FunnelBrokerRow = { id: string; name: string; n: number; unreg: number; reg: number; bdm: number; lead: number; act: number | null; bdmR: number | null; leadR: number | null; ns: number; mins: number };
export type FunnelDTO = {
  range: string;
  totals: { calls: number; targetCalls: number; qualified: number; nextStep: number; nonTarget: number };
  investor: FunnelInvestorRow[];
  broker: FunnelBrokerRow[];
  lostLabels: string[];
  lost: Record<string, number[]>;
  drops: Record<string, [string, string, number][]>;
  crmConnected: boolean;
  attributionDays: number;
};

export type FixCellDTO = CellDTO & { key: string; val: number; quad: 'fix' | 'protect' | 'review' | 'maintain'; depth: number; weak: { key: DimKey; name: string } };
export type FixDTO = { cells: FixCellDTO[]; med: number; vmax: number; top5: FixCellDTO[]; vm: 'meet' | 'res' };

export type TaxonomyHealthDTO = {
  version: string;
  lastClusterRun: string | null;
  weeks: { week: string; unc: number; oth: number }[];
  confBins: string[];
  conf: Record<'persona' | 'scenario' | 'intent', number[]>;
  kappa: { name: string; v: number | null; n: number }[];
  agreement: { persona: number | null; scenario: number | null; n: number };
  classifierMatch: { persona: number | null; scenario: number | null; n: number };
  reviewQueue: { open: number; lowConfidence: number; sample: number };
  clusters: { id: string; label: string; size: number; nearest: string; proposed: boolean }[];
  versions: { version: string; status: string; approvedAt: string | null; notes: string | null }[];
};

export type AlertDTO = { id: string; rule: string; urgency: string; when: string; firedAt: string; text: string; page: string; link: string; params: Record<string, string>; acked: boolean };
export type AlertsDTO = { alerts: AlertDTO[]; rules: { name: string; when: string; urgency: string; open: number }[] };

export type AudioRowDTO = { id: string; callId: string | null; src: string; len: string; ch: string; stage: number; note: string; cqs: string; link: boolean; group: 'scored' | 'pipeline' | 'attention'; createdAt: string };

export type IntegrationDTO = {
  id: string;
  provider: 'elevenlabs' | 'retell' | 'treppan';
  name: string;
  enabled: boolean;
  agentIds: string[];
  baseUrl: string | null;
  pollMinutes: number;
  hasApiKey: boolean;
  hasWebhookSecret: boolean;
  apiKeyHint: string | null;
  webhookUrl: string;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastError: string | null;
  callsImported: number;
  createdAt: string;
};

export type JobDTO = { id: string; kind: string; status: string; attempts: number; createdAt: string; updatedAt: string; lastError: string | null; payload: Record<string, unknown> };
