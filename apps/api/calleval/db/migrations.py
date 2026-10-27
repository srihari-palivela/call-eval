# Schema migrations. The seven framework tables (calls, call_tag, call_event, call_score,
# metric_result, lead_outcome, taxonomy) plus trace_span and eval_run from the Traces design,
# and the platform's own tables (integrations, agents, prompt versions, jobs, review, alerts,
# recommendations). The framework's `call` table is named `calls` here. Version 1 is the schema the
# TypeScript service created, unchanged, so an existing database migrates in place.

MIGRATIONS: list[dict] = [
    {
        'version': 1,
        'sql': """
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
""",
    },
    {
        # Retention marks what it purged, so a purged call is never re-scored from an empty transcript.
        'version': 2,
        'sql': """
alter table calls add column if not exists purged_at timestamptz;
alter table upload add column if not exists purged_at timestamptz;
""",
    },
    {
        # Built-in CRM: leads and their history. Lead finders (Apollo) fill it; campaigns call from it;
        # stage changes become lead outcomes, so attribution and the funnel work as with an external CRM.
        'version': 3,
        'sql': """
create table lead (
  id text primary key,
  source text not null default 'manual',
  external_ref text,
  apollo_id text unique,
  first_name text,
  last_name text,
  phone text,
  email text,
  company text,
  title text,
  city text,
  country text,
  timezone text,
  persona_hint text,
  stage text not null default 'new',
  owner text,
  consent text not null default 'unknown',
  dnc boolean not null default false,
  tags jsonb not null default '[]',
  notes text,
  enrichment jsonb not null default '{}',
  enriched_at timestamptz,
  call_count int not null default 0,
  last_called_at timestamptz,
  last_call_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index lead_email_idx on lead (lower(email)) where email is not null;
create unique index lead_phone_idx on lead (phone) where phone is not null;
create index lead_stage_idx on lead (stage);
create index lead_created_idx on lead (created_at);

create table lead_event (
  id bigint generated always as identity primary key,
  lead_id text not null,
  at timestamptz not null default now(),
  type text not null,
  detail jsonb not null default '{}',
  actor text
);
create index lead_event_lead_idx on lead_event (lead_id, at);
""",
    },
    {
        # Batch-calling campaigns over CRM leads, and the self-improvement loop: champion/challenger prompt
        # arms, improvement cycles (propose → probe → compose → live verification) and the lessons library.
        'version': 4,
        'sql': """
create table campaign (
  id text primary key,
  name text not null,
  integration_id text not null,
  agent_external_id text not null,
  agent_id text,
  from_number text,
  status text not null default 'draft',
  objective text,
  lead_filter jsonb not null default '{}',
  batch_size int not null default 50,
  daily_cap int not null default 500,
  concurrency int,
  allow_unknown_consent boolean not null default false,
  improvement text not null default 'propose',
  challenger_share double precision not null default 0.2,
  min_calls_per_arm int not null default 30,
  max_calls_per_arm int not null default 300,
  champion jsonb,
  challenger jsonb,
  stats jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table campaign_batch (
  id text primary key,
  campaign_id text not null,
  provider_batch_id text,
  status text not null,
  size int not null default 0,
  submitted_at timestamptz not null default now(),
  detail jsonb not null default '{}',
  error text
);
create index campaign_batch_campaign_idx on campaign_batch (campaign_id, submitted_at);

create table campaign_lead (
  campaign_id text not null,
  lead_id text not null,
  batch_id text not null,
  arm text not null,
  prompt_version text,
  status text not null default 'queued',
  call_id text,
  attempted_at timestamptz not null default now(),
  primary key (campaign_id, lead_id, batch_id)
);
create index campaign_lead_lead_idx on campaign_lead (lead_id);
create index campaign_lead_call_idx on campaign_lead (call_id);

create table improvement_cycle (
  id text primary key,
  campaign_id text,
  agent_id text,
  status text not null,
  mode text not null,
  champion_label text,
  challenger_label text,
  reference jsonb,
  candidates jsonb,
  probes jsonb,
  composed jsonb,
  verdict jsonb,
  cost jsonb not null default '{}',
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by text
);
create index improvement_cycle_campaign_idx on improvement_cycle (campaign_id, created_at);

create table improvement_lesson (
  id text primary key,
  cycle_id text not null,
  agent_id text,
  scope text,
  scope_key text,
  metrics jsonb not null default '[]',
  edit text not null,
  outcome text not null,
  effect jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index improvement_lesson_agent_idx on improvement_lesson (agent_id, created_at);
""",
    },
    {
        # User-defined taxonomies (drafts, the domain sentence, entry order) and lead funnels: ordered stages,
        # each standing for a framework milestone, that leads move through.
        'version': 5,
        'sql': """
alter table taxonomy_version add column if not exists domain text;
alter table taxonomy add column if not exists ord int not null default 0;

create table funnel (
  id text primary key,
  name text not null,
  description text not null default '',
  is_default boolean not null default false,
  stages jsonb not null,
  match jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index funnel_default_idx on funnel (is_default) where is_default;
alter table lead add column if not exists funnel_id text;
alter table lead add column if not exists stage_at timestamptz;
create index lead_funnel_idx on lead (funnel_id, stage);
""",
    },
    {
        # Users and access: accounts with a role, sessions (the cookie holds a token; only its hash is stored),
        # API tokens, invitations and password-reset links, and the audit log of who changed what.
        'version': 6,
        'sql': """
create table app_user (
  id text primary key,
  email text not null,
  name text not null default '',
  role text not null,
  password_hash text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz,
  last_seen_at timestamptz,
  password_changed_at timestamptz
);
create unique index app_user_email_idx on app_user (lower(email));

create table user_session (
  id text primary key,
  user_id text not null references app_user (id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ip text,
  user_agent text,
  revoked_at timestamptz
);
create index user_session_user_idx on user_session (user_id);

create table api_token (
  id text primary key,
  name text not null,
  token_hash text not null unique,
  prefix text not null,
  user_id text references app_user (id) on delete cascade,
  role text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz
);

create table user_invite (
  id text primary key,
  token_hash text not null unique,
  email text not null,
  role text not null,
  kind text not null default 'invite',
  user_id text references app_user (id) on delete cascade,
  created_by text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz
);

create table audit_event (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id text,
  actor text not null,
  action text not null,
  target text,
  status int,
  ip text,
  detail jsonb not null default '{}'
);
create index audit_event_at_idx on audit_event (at desc);
create index audit_event_action_idx on audit_event (action, at);
""",
    },
    {
        # Workspaces: several companies in one installation. Every tenant table gets workspace_id (existing rows go
        # to the default workspace) and row-level security keyed on the app.workspace_id setting the app sets per
        # connection; the app works as the non-superuser role calleval_app, which those policies bind (owners and
        # superusers bypass them, which only the job queue, the scheduler and sign-in use). Unique keys become
        # per-workspace. Also: billing (plans, credit, usage) and calling compliance (do-not-call list, refusals).
        'version': 7,
        'sql': """
create table workspace (
  id text primary key,
  name text not null,
  plan text not null default 'growth',
  status text not null default 'trial',
  trial_ends_at timestamptz,
  annual boolean not null default false,
  period_start timestamptz not null default date_trunc('month', now()),
  stripe_customer_id text unique,
  stripe_subscription_id text,
  credit_usd numeric not null default 0,
  spend_cap_usd numeric,
  auto_recharge jsonb not null default '{}',
  setup jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into workspace (id, name, plan, status) values ('ws_default', 'Default', 'enterprise', 'active') on conflict do nothing;

create table usage_event (
  id bigint generated always as identity primary key,
  workspace_id text not null default current_setting('app.workspace_id', true),
  at timestamptz not null default now(),
  kind text not null,
  ref text not null,
  quantity numeric not null default 1,
  amount_usd numeric not null default 0,
  reported_at timestamptz,
  unique (workspace_id, kind, ref)
);
create index usage_event_at_idx on usage_event (workspace_id, kind, at);

create table credit_ledger (
  id bigint generated always as identity primary key,
  workspace_id text not null default current_setting('app.workspace_id', true),
  at timestamptz not null default now(),
  kind text not null,
  amount_usd numeric not null,
  note text not null default '',
  ref text,
  unique (workspace_id, ref)
);

create table stripe_event (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now()
);

create table dnc_number (
  workspace_id text not null default current_setting('app.workspace_id', true),
  phone text not null,
  source text not null default 'upload',
  added_at timestamptz not null default now(),
  primary key (workspace_id, phone)
);

alter table lead add column if not exists refused_at timestamptz;

do $$
declare t text;
begin
  foreach t in array array['app_setting','integration','agent','prompt_version','calls','call_tag','call_event','metric_result','call_score','lead_outcome','taxonomy_version','taxonomy','trace_span','eval_run','review_item','review_label','alert','attention_item','recommendation','cluster','job','upload','lead','lead_event','campaign','campaign_batch','campaign_lead','improvement_cycle','improvement_lesson','funnel','usage_event','credit_ledger','dnc_number'] loop
    execute format('alter table %I add column if not exists workspace_id text not null default %L', t, 'ws_default');
    execute format('alter table %I alter column workspace_id set default current_setting(%L, true)', t, 'app.workspace_id');
    execute format('alter table %I add constraint %I check (workspace_id <> %L)', t, t || '_ws_check', '');
    execute format('create index if not exists %I on %I (workspace_id)', t || '_ws_idx', t);
    execute format('alter table %I enable row level security', t);
    execute format('create policy tenant on %I using (workspace_id = current_setting(%L, true)) with check (workspace_id = current_setting(%L, true))',
                   t, 'app.workspace_id', 'app.workspace_id');
  end loop;
end $$;

alter table app_setting drop constraint app_setting_pkey, add primary key (workspace_id, key);
alter table agent drop constraint agent_provider_external_id_key, add constraint agent_provider_external_id_key unique (workspace_id, provider, external_id);
alter table calls drop constraint calls_provider_external_id_key, add constraint calls_provider_external_id_key unique (workspace_id, provider, external_id);
alter table lead_outcome drop constraint lead_outcome_external_id_key, add constraint lead_outcome_external_id_key unique (workspace_id, external_id);
alter table taxonomy_version drop constraint taxonomy_version_pkey, add primary key (workspace_id, version);
alter table taxonomy drop constraint taxonomy_pkey, add primary key (workspace_id, tag_id, version);
alter table alert drop constraint alert_dedupe_key_key, add constraint alert_dedupe_key_key unique (workspace_id, dedupe_key);
alter table attention_item drop constraint attention_item_pkey, add primary key (workspace_id, key);
alter table recommendation drop constraint recommendation_fingerprint_key, add constraint recommendation_fingerprint_key unique (workspace_id, fingerprint);
alter table lead drop constraint lead_apollo_id_key, add constraint lead_apollo_id_key unique (workspace_id, apollo_id);
alter table funnel drop constraint funnel_pkey, add primary key (workspace_id, id);
drop index job_dedupe_idx;
create unique index job_dedupe_idx on job (workspace_id, dedupe_key) where status in ('queued', 'running');
drop index lead_email_idx;
create unique index lead_email_idx on lead (workspace_id, lower(email)) where email is not null;
drop index lead_phone_idx;
create unique index lead_phone_idx on lead (workspace_id, phone) where phone is not null;
drop index funnel_default_idx;
create unique index funnel_default_idx on funnel (workspace_id) where is_default;

-- Accounts belong to one workspace; they are read before any workspace is known (sign-in), so they carry the
-- column without row-level security and every query names the workspace.
alter table app_user add column workspace_id text not null default 'ws_default';
alter table app_user add column email_verified_at timestamptz;
update app_user set email_verified_at = created_at;
alter table api_token add column workspace_id text not null default 'ws_default';
alter table user_invite add column workspace_id text not null default 'ws_default';
alter table audit_event add column workspace_id text;
update audit_event set workspace_id = 'ws_default';
create index app_user_workspace_idx on app_user (workspace_id);
create index audit_event_workspace_idx on audit_event (workspace_id, at desc);

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'calleval_app') then
    create role calleval_app nologin;
  end if;
  begin
    execute format('grant calleval_app to %I', current_user);
  exception when others then
    raise notice 'could not grant calleval_app to %: %', current_user, sqlerrm;
  end;
end $$;
grant usage on schema public to calleval_app;
grant select, insert, update, delete on all tables in schema public to calleval_app;
grant usage, select on all sequences in schema public to calleval_app;
alter default privileges in schema public grant select, insert, update, delete on tables to calleval_app;
alter default privileges in schema public grant usage, select on sequences to calleval_app;
""",
    },
]
