// Request filters and response shapes shared by the API and the console.

import type { Dimension, DimKey, Gate, Metric } from './metrics';
import type { EventType, Facet, Persona, Scenario } from './taxonomy';
import type { Checkpoint } from './paths';

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
  /** Who is asking, with what the role allows (the console hides what it can't use). */
  me: MeDTO;
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
  /** Optional modules: the built-in CRM, batch-calling campaigns, and what the self-improvement loop may do on its own. */
  features: { crm: boolean; campaigns: boolean; improvement: 'off' | 'propose' | 'auto' };
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
  provider: 'elevenlabs' | 'retell' | 'treppan' | 'apollo';
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

// ---------- Business onboarding, built-in CRM, lead finders ----------

export type LeadStage = 'new' | 'contacted' | 'qualified' | 'meeting_booked' | 'meeting_attended' | 'site_visit' | 'reservation' | 'sale' | 'lost' | 'dnc';
export type LeadConsent = 'opt_in' | 'existing_customer' | 'unknown' | 'denied';

export type LeadDTO = {
  id: string; source: string; externalRef: string | null; apolloId: string | null;
  firstName: string | null; lastName: string | null; name: string | null;
  phone: string | null; phoneValid: boolean; email: string | null; company: string | null; title: string | null;
  city: string | null; country: string | null; timezone: string | null; personaHint: string | null;
  /** The lead's funnel (the default funnel when none was chosen) and its stage key in that funnel. */
  funnelId: string; stage: string; owner: string | null; consent: LeadConsent; dnc: boolean; tags: string[]; notes: string | null;
  enrichment: Record<string, unknown>; enrichedAt: string | null;
  callCount: number; lastCalledAt: string | null; lastCallId: string | null; createdAt: string; updatedAt: string;
  /** Why campaigns won't call this lead now (refused on a call, on the do-not-call list, retry pacing, consent), or null. */
  hold: { reason: string; until: string | null } | null;
};

/** `stages` counts the leads in each stage of `funnel` (the `funnel` query, or the default funnel). */
export type LeadListDTO = { items: LeadDTO[]; total: number; stages: Record<string, number>; funnel: LeadFunnelDTO };

export type LeadDetailDTO = LeadDTO & {
  events: { at: string; type: string; detail: Record<string, any>; actor: string | null }[];
  calls: { id: string; startedAt: string; durationS: number; direction: string; persona: string | null; scenario: string | null; cqs: number | null; band: string | null; nextStep: string | null; status: string }[];
  outcomes: { stage: string; at: string; valueAed: number | null; creditedCallId: string | null }[];
};

export type BusinessProfile = {
  company: { name: string; website: string; industry: string; description: string; offer: string; markets: string[]; languages: string[] };
  icp: { titles: string[]; excludeTitles: string[]; seniorities: string[]; industries: string[]; personLocations: string[]; organizationLocations: string[]; employeeRanges: string[]; keywords: string; personaHint: string | null };
  goals: { meetingsPerWeek: number | null; targetMeetingRate: number | null; targetCqs: number | null; leadsPerWeek: number | null; monthlyCallBudget: number | null; focusPersonas: string[]; focusScenarios: string[] };
  calling: { timezone: string; startHour: number; endHour: number; days: number[]; maxAttemptsPerLead: number; allowUnknownConsent: boolean };
  onboardedAt: string | null;
};

export type BusinessDTO = {
  profile: BusinessProfile;
  progress: {
    onboarded: boolean;
    week: { meetings: number; calls: number; meetingRate: number | null; cqs: number | null; newLeads: number };
    month: { calls: number };
    goals: BusinessProfile['goals'];
    onTrack: Record<'meetings' | 'meetingRate' | 'cqs' | 'leads' | 'budget', boolean | null>;
  };
  apolloQuery: Record<string, unknown>;
  leadFinder: { apollo: boolean; phoneWebhook: boolean };
};

// ---------- Batch-calling campaigns and the self-improvement loop ----------

export type ImprovementMode = 'off' | 'propose' | 'auto';
export type CampaignArmDTO = { arm: 'champion' | 'challenger'; label: string; dispatched: number; scored: number; cqs: number | null; gateRate: number | null; meetingRate: number | null; nextStepRate: number | null };

export type CampaignDTO = {
  id: string; name: string; integrationId: string; agentExternalId: string; agentId: string | null; fromNumber: string | null;
  status: 'draft' | 'running' | 'paused' | 'completed' | 'cancelled'; objective: string | null;
  leadFilter: { funnels?: string[]; stages?: string[]; sources?: string[]; tags?: string[]; leadIds?: string[] };
  batchSize: number; dailyCap: number; concurrency: number | null; allowUnknownConsent: boolean;
  improvement: ImprovementMode; challengerShare: number; minCallsPerArm: number; maxCallsPerArm: number;
  champion: { label?: string; source?: string } | null; championPrompt: string | null;
  challenger: { label?: string; cycleId?: string; startedAt?: string } | null; challengerPrompt: string | null;
  stats: { arms?: CampaignArmDTO[]; dispatched?: number; called?: number; failed?: number; leads?: number; error?: string; updatedAt?: string } & Record<string, any>;
  createdAt: string; updatedAt: string;
};

export type CampaignDetailDTO = CampaignDTO & {
  arms: CampaignArmDTO[];
  eligibleLeads: number;
  inCallingWindow: boolean;
  batches: { id: string; providerBatchId: string | null; status: string; size: number; submittedAt: string | null; arms: Record<string, number> | null; error: string | null }[];
  cycle: { id: string; status: string; mode: string; championLabel: string | null; challengerLabel: string | null; createdAt: string; updatedAt: string } | null;
};

export type CycleStatus = 'proposing' | 'probing' | 'awaiting_approval' | 'live' | 'awaiting_promotion' | 'promoted' | 'rolled_back' | 'rejected' | 'failed';
export type PromptEditDTO = { id: string; kind: 'general' | 'domain'; targets: string[]; mode: 'add' | 'replace'; section: string; before: string; after: string; rationale: string; compliance?: boolean } & Record<string, any>;
export type ProbeSummaryDTO = { n: number; meanTargetDelta: number | null; meanCqsDelta: number | null; gatesAdded: number; wins: number; losses: number };
export type CycleVerdictDTO = {
  decision: 'pending' | 'promote' | 'rollback' | 'reject'; why?: string; checkedAt?: string; minCalls?: number; maxCalls?: number;
  champion?: { n: number; cqs?: number; gateRate?: number; metrics?: Record<string, number | null> };
  challenger?: { n: number; cqs?: number; gateRate?: number; metrics?: Record<string, number | null> };
  cqsDelta?: number; lo?: number; hi?: number;
};

export type CycleDTO = {
  id: string; campaignId: string; agentId: string | null; status: CycleStatus; mode: ImprovementMode;
  championLabel: string | null; challengerLabel: string | null;
  reference: Record<string, any> | null; candidates: PromptEditDTO[];
  probes: { candidates?: Record<string, { summary: ProbeSummaryDTO }> } & Record<string, any> | null;
  composed: { prompt?: string; applied?: string[]; skipped?: { id: string; reason: string }[]; probe?: ProbeSummaryDTO; compliance?: boolean; unprobed?: boolean } & Record<string, any> | null;
  verdict: CycleVerdictDTO | null; cost: { llmCalls?: number; inputTokens?: number; outputTokens?: number } & Record<string, any>;
  error: string | null; createdAt: string; updatedAt: string; decidedAt: string | null; decidedBy: string | null;
};

export type LessonDTO = { id: string; cycleId: string; agentId: string | null; scope: string | null; scopeKey: string | null; metrics: string[]; edit: string; outcome: 'adopted' | 'rejected' | 'regressed'; effect: Record<string, any>; createdAt: string };

export type CycleDetailDTO = CycleDTO & { championPrompt: string | null; lessons: LessonDTO[] };

// ---------- Co-pilot (Claude): proposals a person reviews before anything changes ----------

export type CopilotUsage = { inputTokens: number; outputTokens: number; model: string };

export type BusinessSection = 'company' | 'icp' | 'goals' | 'calling';
export type BusinessProposalDTO = {
  /** Only the sections the co-pilot proposes; apply one with PUT /api/business { [section]: profile[section] }. */
  profile: Partial<Pick<BusinessProfile, BusinessSection>>;
  changes: { section: BusinessSection; field: string; from: unknown; to: unknown }[];
  assumptions: string[];
  questions: string[];
  /** Whether the website was read (Claude's web fetch); false when no URL was given or it could not be read. */
  websiteRead: boolean;
  usage: CopilotUsage;
};

// ---------- User-defined taxonomy (versioned: edit a draft, then activate it) ----------

export type TaxonomyKind = 'persona' | 'scenario' | 'event';
export type PersonaDef = Persona & { basedOn: string | null; keywords: string[] };
export type ScenarioDef = Scenario & { basedOn: string | null; keywords: string[]; checkpoints: Checkpoint[] };
export type EventDef = EventType & { basedOn: string | null; keywords: string[]; system: boolean };

export type TaxonomyDoc = {
  version: string; status: 'active' | 'draft' | 'retired';
  /** Who calls and why, in a sentence or two; the classifier and judge read it before the definitions. */
  domain: string;
  personas: PersonaDef[]; p0: Persona; scenarios: ScenarioDef[]; events: EventDef[]; facets: Facet[];
  notes: string | null; createdAt: string; approvedAt: string | null;
};

export type TaxonomyDiff = {
  added: { kind: TaxonomyKind; id: string; name: string }[];
  changed: { kind: TaxonomyKind; id: string; name: string; fields: string[] }[];
  retired: { kind: TaxonomyKind; id: string; name: string; calls: number }[];
  domainChanged: boolean;
};

export type TaxonomyDTO = {
  active: TaxonomyDoc;
  draft: TaxonomyDoc | null;
  /** The draft against the active version (null without a draft). */
  diff: TaxonomyDiff | null;
  versions: { version: string; status: string; approvedAt: string | null; notes: string | null; createdAt: string }[];
  /** The framework's own entries, which `basedOn` refers to. */
  builtins: { personas: Persona[]; scenarios: Scenario[]; events: EventType[] };
  /** Code detectors a checkpoint can use with detect.by = 'rule'. */
  rules: { id: string; label: string; description: string }[];
  /** Tool names the agents use (checkpoints with detect.by = 'tool'). */
  tools: string[];
  templates: { id: string; name: string; description: string }[];
  /** Scored calls in the last 90 days per persona and scenario id. */
  usage: { personas: Record<string, number>; scenarios: Record<string, number> };
  copilot: boolean;
};

/** One proposed change. `add` has id null (the server assigns one); `retire` has entry null. */
export type TaxonomyOp = {
  op: 'add' | 'update' | 'retire';
  kind: TaxonomyKind;
  id: string | null;
  entry: Partial<PersonaDef & ScenarioDef & EventDef> | null;
  reason: string;
  warnings?: string[];
};

export type TaxonomyCopilotMode = 'draft' | 'edit' | 'review';
export type TaxonomyProposalDTO = {
  summary: string;
  /** A new domain sentence, or null to keep the draft's. */
  domain: string | null;
  operations: TaxonomyOp[];
  questions: string[];
  /** What the co-pilot looked at: calls sampled, clusters, health figures. */
  evidence: { calls: number; clusters: number; unclassifiedShare: number | null };
  usage: CopilotUsage;
};

// ---------- Lead funnels (built-in CRM) ----------

/** Framework milestones a stage can stand for: calls move leads to contacted, qualified and meeting booked;
 *  outcome milestones are credited to calls (attribution, Funnel by persona); lost and dnc close the lead. */
export type FunnelMilestone =
  | 'new' | 'contacted' | 'qualified' | 'meeting_booked' | 'meeting_attended' | 'site_visit' | 'reservation' | 'sale'
  | 'broker_registered' | 'bdm_call_held' | 'broker_first_lead' | 'broker_deal' | 'lost' | 'dnc';

export type FunnelStageDef = {
  key: string; label: string; description: string;
  milestone: FunnelMilestone | null;
  kind: 'open' | 'won' | 'lost';
  /** Campaigns may call leads in this stage (always false for won and lost stages). */
  callable: boolean;
};

export type LeadFunnelDTO = {
  id: string; name: string; description: string; isDefault: boolean;
  stages: FunnelStageDef[];
  /** New leads matching these go to this funnel (empty lists match nothing; the default funnel takes the rest). */
  match: { paths: string[]; personas: string[]; sources: string[] };
  leads: number; byStage: Record<string, number>;
  createdAt: string; updatedAt: string;
};

export type LeadFunnelsDTO = {
  funnels: LeadFunnelDTO[];
  milestones: { id: FunnelMilestone; label: string; description: string }[];
  templates: { id: string; name: string; description: string }[];
  copilot: boolean;
};

export type LeadFunnelReportDTO = {
  funnel: LeadFunnelDTO;
  range: '30' | '90' | 'all';
  /** Leads created in the range that the report follows. */
  cohort: number;
  stages: {
    key: string; label: string; kind: 'open' | 'won' | 'lost';
    now: number;
    /** Leads that reached this stage or a later open or won stage. */
    reached: number;
    /** reached here ÷ reached at the previous open stage (null for the first and for lost stages). */
    conv: number | null;
    medianDays: number | null;
    /** Leads that went from this stage to a lost stage. */
    lostFrom: number;
  }[];
  overall: { open: number; won: number; lost: number; winRate: number | null };
  sources: { source: string; n: number; won: number }[];
};

export type FunnelProposalDTO = {
  funnel: Pick<LeadFunnelDTO, 'name' | 'description' | 'stages' | 'match'>;
  reason: string;
  questions: string[];
  usage: CopilotUsage;
};

// ---------- Users, roles and access ----------

export type Role = 'owner' | 'admin' | 'qa_lead' | 'sales_manager' | 'reviewer' | 'viewer';
export type Permission =
  | 'analytics:read' | 'calls:read' | 'calls:review' | 'calls:upload' | 'quality:manage'
  | 'taxonomy:edit' | 'taxonomy:activate' | 'settings:manage' | 'integrations:manage' | 'business:manage'
  | 'crm:read' | 'crm:write' | 'leadfinder:spend' | 'campaigns:read' | 'campaigns:manage' | 'campaigns:start'
  | 'improvement:approve' | 'improvement:promote' | 'copilot:use' | 'users:manage' | 'audit:read';

/** `via`: a session cookie, an API token, the API_TOKEN environment token, or open (no users yet: anyone can use the app). */
export type MeDTO = {
  id: string | null; email: string | null; name: string; role: Role; permissions: Permission[];
  via: 'session' | 'token' | 'env' | 'open';
  /** The workspace (company) the request acts in. */
  /** `billing` false: no plans or limits apply (BILLING=off), so the console shows no trial or plan. */
  workspace: { id: string; name: string; plan: PlanId; status: WorkspaceStatus; billing: boolean } | null;
};

/** GET /api/auth/status, answered without signing in. */
export type AuthStatusDTO = {
  signedIn: boolean;
  me: MeDTO | null;
  /** No users exist yet: the console offers to create the first owner. */
  setupRequired: boolean;
  /** Creating the first owner needs the API_TOKEN (set on the server). */
  setupNeedsToken: boolean;
  /** Anyone may create a workspace (self-serve sign-up is on for this installation). */
  signupOpen: boolean;
};

export type RoleDTO = { id: Role; name: string; description: string; permissions: Permission[] };
export type PermissionDTO = { id: Permission; label: string; description: string; risky: boolean };

export type UserDTO = {
  id: string; email: string; name: string; role: Role; status: 'active' | 'disabled';
  createdAt: string; lastLoginAt: string | null; lastSeenAt: string | null; sessions: number;
};

/** An invitation, or a password-reset link for an existing user. `url` is only returned when it is created. */
export type InviteDTO = {
  id: string; email: string; role: Role; kind: 'invite' | 'reset'; createdAt: string; expiresAt: string; createdBy: string | null; url?: string;
};

/** `token` is only returned once, when it is created. */
export type ApiTokenDTO = {
  id: string; name: string; prefix: string; role: Role; userId: string | null; userEmail: string | null;
  createdAt: string; expiresAt: string | null; lastUsedAt: string | null; token?: string;
};

export type AuditEventDTO = {
  id: number; at: string; actor: string; actorId: string | null; action: string; target: string | null;
  status: number | null; ip: string | null; detail: Record<string, unknown>;
};

export type AccessDTO = { users: UserDTO[]; invites: InviteDTO[]; tokens: ApiTokenDTO[]; roles: RoleDTO[]; permissions: PermissionDTO[] };

// ---------- Workspaces, self-serve sign-up and the setup checklist ----------

export type WorkspaceStatus = 'trial' | 'active' | 'past_due' | 'cancelled';
export type WorkspaceDTO = {
  id: string; name: string; plan: PlanId; status: WorkspaceStatus; trialEndsAt: string | null; createdAt: string; members: number;
  billing: boolean;
};

/** POST /api/auth/signup → no session yet: the person verifies their email first. `devLink` only when the server
 *  sends no email (SMTP not configured), so a local install can still be tried. */
export type SignupResultDTO = { sent: boolean; email: string; devLink?: string };

export type SetupStepDTO = {
  id: string; title: string; detail: string;
  /** The console page that does it (a PageKey), with optional hash params. */
  page: string; params?: Record<string, string>;
  done: boolean; optional: boolean;
  /** The co-pilot helps with this step. */
  copilot: boolean;
  /** False when the plan doesn't include it (then `upgrade` names the plan that does). */
  available: boolean; upgrade?: PlanId;
};
export type SetupDTO = { steps: SetupStepDTO[]; done: number; total: number; dismissed: boolean };

// ---------- Billing: plans, pay-as-you-go credit, usage ----------

export type PlanId = 'payg' | 'starter' | 'growth' | 'scale' | 'enterprise';
export type PlanFeature = 'copilot' | 'alerts' | 'api_tokens' | 'crm' | 'campaigns' | 'lead_finder' | 'improvement' | 'audit_export' | 'priority_support';

export type PlanDTO = {
  id: PlanId; name: string; summary: string;
  /** null = by contract (Enterprise). */
  monthlyUsd: number | null;
  includedCalls: number; extraCallUsd: number | null;
  /** null = unlimited. */
  seats: number | null;
  /** Drafts included a month; null with a price = paid per draft. */
  copilotDrafts: number | null; copilotDraftUsd: number | null;
  improvementCycles: number | null; improvementCycleUsd: number | null;
  features: PlanFeature[];
};

export type BillingDTO = {
  /** Billing is switched on for this installation (BILLING=on); off = no limits (self-hosted). */
  enabled: boolean;
  plan: PlanId; status: WorkspaceStatus; trialEndsAt: string | null; annual: boolean;
  period: { start: string; end: string };
  usage: {
    scoredCalls: number; includedCalls: number; extraCalls: number;
    copilotDrafts: number; copilotIncluded: number | null;
    improvementCycles: number; cyclesIncluded: number | null;
    editorSeats: number; seatsIncluded: number | null;
  };
  /** This period so far, in USD: extra calls billed at period end, and credit spent (pay-as-you-go). */
  estimate: { extraUsd: number; creditSpentUsd: number };
  credit: { balanceUsd: number; autoRecharge: { enabled: boolean; thresholdUsd: number; amountUsd: number } };
  /** Most a period's extra usage may cost; null = no cap. */
  spendCapUsd: number | null;
  /** Whether new calls are scored now; when not, calls are kept and wait (`waiting`). */
  scoring: { allowed: boolean; reason: string | null; waiting: number };
  plans: PlanDTO[];
  recommendation: { plan: PlanId; why: string } | null;
  stripe: { checkout: boolean; portal: boolean };
  /** Latest credit and charge movements, newest first. */
  ledger: { at: string; kind: string; amountUsd: number; note: string }[];
};

// ---------- Calling compliance ----------

export type CountryRuleDTO = {
  country: string; name: string; prefixes: string[];
  /** Local calling window (the lead's country), 24-hour; days 0 = Monday … 6 = Sunday, null = every day. */
  startHour: number; endHour: number; days: number[] | null;
  /** Attempts allowed while unanswered, per rolling day and week (null = no limit). */
  maxPerDay: number | null; maxPerWeek: number | null;
  stopAfterRefusal: boolean;
  /** 'opt_in': only leads with recorded consent may be called. */
  consent: 'any' | 'opt_in';
  /** The agent must say it is an AI at the start of the call. */
  aiDisclosure: boolean;
  registry: string | null;
  source: string;
};
export type ComplianceIssueDTO = { severity: 'block' | 'warn'; title: string; detail: string; fix: string | null };
export type ComplianceDTO = {
  rules: CountryRuleDTO[];
  dnc: { count: number; updatedAt: string | null };
  issues: ComplianceIssueDTO[];
  /** Leads campaigns hold back right now, by reason. */
  held: { refused: number; dnc: number; pacing: number; consent: number };
};
