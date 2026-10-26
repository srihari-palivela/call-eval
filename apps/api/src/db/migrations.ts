// Schema migrations. The seven framework tables (calls, call_tag, call_event, call_score,
// metric_result, lead_outcome, taxonomy) plus trace_span and eval_run from the Traces design,
// and the platform's own tables (integrations, agents, prompt versions, jobs, review, alerts,
// recommendations). The framework's `call` table is named `calls` here.

export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
create table app_setting (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table integration (
  id text primary key,
  provider text not null,
  name text not null,
  enabled boolean not null default true,
  config jsonb not null default '{}',
  secrets text,
  api_key_hint text,
  cursor jsonb,
  calls_imported int not null default 0,
  last_sync_at timestamptz,
  last_sync_status text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table agent (
  id text primary key,
  provider text not null,
  external_id text not null,
  integration_id text,
  name text,
  prompt_text text,
  first_message text,
  config jsonb,
  prompt_hash text,
  updated_at timestamptz not null default now(),
  unique (provider, external_id)
);

create table prompt_version (
  id text primary key,
  agent_id text,
  label text not null,
  hash text not null,
  prompt_text text,
  provider_version text,
  source text,
  notes text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz,
  unique (agent_id, hash)
);

create table calls (
  call_id text primary key,
  provider text not null,
  external_id text not null,
  integration_id text,
  agent_id text,
  lead_id text,
  started_at timestamptz not null,
  duration_s double precision not null default 0,
  direction text not null default 'unknown',
  end_reason text,
  end_reason_raw text,
  language text,
  prompt_version text,
  agent_version text,
  source text not null default 'live',
  recording_url text,
  recording_channels int,
  has_audio boolean not null default false,
  status text not null default 'ingested',
  error text,
  canonical jsonb,
  raw jsonb,
  persona text,
  persona_path text,
  scenario text,
  scenario2 text,
  intent_start text,
  intent_end text,
  cqs double precision,
  raw_cqs double precision,
  band text,
  gated boolean,
  next_step text,
  qualified boolean,
  judge_mode text,
  needs_review boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  scored_at timestamptz,
  unique (provider, external_id)
);
create index calls_started_idx on calls (started_at);
create index calls_cell_idx on calls (persona, scenario);
create index calls_lead_idx on calls (lead_id);
create index calls_version_idx on calls (prompt_version);
create index calls_status_idx on calls (status);

create table call_tag (
  call_id text not null,
  taxonomy_version text not null,
  tag_key text not null,
  value text,
  confidence double precision,
  layer text not null,
  evidence jsonb not null default '[]',
  run_id text,
  created_at timestamptz not null default now(),
  primary key (call_id, taxonomy_version, tag_key)
);

create table call_event (
  id bigint generated always as identity primary key,
  call_id text not null,
  type text not null,
  turn int,
  detail text,
  source text
);
create index call_event_call_idx on call_event (call_id);
create index call_event_type_idx on call_event (type);

create table metric_result (
  call_id text not null,
  framework_version text not null,
  metric_key text not null,
  raw double precision,
  value double precision,
  applicable boolean not null,
  method text,
  evidence jsonb not null default '[]',
  rationale text,
  run_id text,
  primary key (call_id, framework_version, metric_key)
);
create index metric_result_key_idx on metric_result (metric_key);

create table call_score (
  call_id text not null,
  framework_version text not null,
  und double precision,
  body double precision,
  concl double precision,
  tools double precision,
  emo double precision,
  intro double precision,
  voice double precision,
  dims jsonb not null,
  cqs double precision not null,
  raw_cqs double precision not null,
  band text not null,
  gated boolean not null,
  gates jsonb not null default '[]',
  path jsonb,
  outcome jsonb,
  fields jsonb,
  context jsonb,
  phases jsonb,
  lowest jsonb,
  coaching jsonb,
  tool_stats jsonb,
  created_at timestamptz not null default now(),
  primary key (call_id, framework_version)
);

create table lead_outcome (
  id text primary key,
  lead_id text not null,
  stage text not null,
  occurred_at timestamptz not null,
  project text,
  value_aed double precision,
  credited_call_id text,
  source text,
  external_id text unique,
  created_at timestamptz not null default now()
);
create index lead_outcome_lead_idx on lead_outcome (lead_id);

create table taxonomy_version (
  version text primary key,
  status text not null,
  approved_by text,
  approved_at timestamptz,
  notes text,
  created_at timestamptz not null default now()
);

create table taxonomy (
  tag_id text not null,
  version text not null,
  kind text not null,
  name text not null,
  definition jsonb not null,
  active_from timestamptz,
  active_to timestamptz,
  primary key (tag_id, version)
);

create table trace_span (
  id text primary key,
  call_id text not null,
  turn int,
  kind text not null,
  name text,
  start_s double precision,
  duration_s double precision,
  model text,
  tokens_in int,
  tokens_out int,
  status text,
  meta jsonb
);
create index trace_span_call_idx on trace_span (call_id);

create table eval_run (
  id text primary key,
  call_id text,
  kind text not null,
  version text,
  model text,
  input_tokens int,
  output_tokens int,
  latency_ms int,
  status text not null,
  error text,
  output jsonb,
  cited_turns jsonb,
  created_at timestamptz not null default now()
);
create index eval_run_call_idx on eval_run (call_id);

create table review_item (
  id text primary key,
  call_id text not null,
  kind text not null,
  tag_key text,
  reason text not null,
  status text not null default 'open',
  current_value text,
  confidence double precision,
  resolution jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index review_item_status_idx on review_item (status);

create table review_label (
  id text primary key,
  call_id text not null,
  reviewer text not null,
  key text not null,
  value text not null,
  created_at timestamptz not null default now()
);
create index review_label_key_idx on review_label (key);

create table alert (
  id text primary key,
  rule text not null,
  urgency text not null,
  fired_at timestamptz not null default now(),
  text text not null,
  page text not null,
  link_label text not null,
  params jsonb not null default '{}',
  dedupe_key text unique,
  acked boolean not null default false,
  acked_at timestamptz
);

create table attention_item (
  key text primary key,
  owner text,
  status text,
  note text,
  updated_at timestamptz not null default now()
);

create table recommendation (
  id text primary key,
  scope text not null,
  scope_key text,
  kind text not null,
  title text not null,
  problem text not null,
  proposal text not null,
  prompt_patch text,
  evidence jsonb not null default '[]',
  metrics jsonb not null default '[]',
  impact jsonb not null default '{}',
  priority double precision not null default 0,
  status text not null default 'proposed',
  source text not null,
  target_version text,
  baseline jsonb,
  fingerprint text unique,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table cluster (
  id text primary key,
  label text not null,
  size int not null,
  nearest text,
  call_ids jsonb not null default '[]',
  proposed boolean not null default false,
  run_at timestamptz not null default now()
);

create table job (
  id text primary key,
  kind text not null,
  payload jsonb not null default '{}',
  status text not null default 'queued',
  priority int not null default 0,
  attempts int not null default 0,
  max_attempts int not null default 5,
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  dedupe_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index job_queue_idx on job (status, run_after);
create unique index job_dedupe_idx on job (dedupe_key) where status in ('queued', 'running');

create table upload (
  id text primary key,
  call_id text,
  filename text not null,
  size_bytes bigint,
  mime text,
  path text,
  status text not null,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);
`,
  },
];
