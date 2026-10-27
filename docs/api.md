# REST API

Base path `/api`. Every response is JSON. Response shapes are TypeScript types in
`packages/framework/src/api.ts`, shared by the API and the console.

Once a user exists, every `/api` route needs a session (sign in), a personal API token
(`Authorization: Bearer ce_…`) or the `API_TOKEN` environment token; before the first user, and without
`API_TOKEN`, the API is open. Each route needs one permission of the caller's role: 401 means nobody is
signed in, 403 that the role lacks the permission (the message names it). Changes made with a session
cookie need the header `X-CallEval-Client: console`. See [access.md](access.md).
Webhooks under `/webhooks` are authenticated by the provider's signature instead.

## Signing in, accounts and access

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/auth/status` | `AuthStatusDTO` (no sign-in needed): signed in, who, whether the first owner is still to be created |
| POST | `/api/auth/setup` | `{ email, name, password, setupToken? }` → `MeDTO` and a session: the first owner, only while no user exists (`setupToken` = `API_TOKEN` when one is set) |
| POST | `/api/auth/login` | `{ email, password }` → `MeDTO` and a session; 401 wrong email or password, 429 too many attempts |
| POST | `/api/auth/logout` | Ends the session |
| GET / PUT | `/api/auth/me` | `MeDTO` / `{ name?, currentPassword?, newPassword? }` (a new password signs out other sessions) |
| GET | `/api/auth/invites/:token` | `{ email, role, kind, expiresAt }` (no sign-in needed) |
| POST | `/api/auth/invites/:token/accept` | `{ name, password }` → `MeDTO` and a session (a reset link sets a new password) |
| GET / POST | `/api/auth/tokens` | Your API tokens / `{ name, role?, expiresDays?: 30 \| 90 \| 365 \| null }` → `ApiTokenDTO` with the token, shown once |
| DELETE | `/api/auth/tokens/:id` | Revokes a token (yours, or anyone's with users:manage) |
| GET | `/api/access` | `AccessDTO`: users, pending invitations, API tokens, roles and permissions (users:manage) |
| POST | `/api/access/invites` | `{ email, role }` → `InviteDTO` with the link to send (users:manage) |
| DELETE | `/api/access/invites/:id` | Revokes an invitation |
| PATCH | `/api/access/users/:id` | `{ role?, status?, name? }` → `UserDTO` (owner rules in access.md) |
| POST | `/api/access/users/:id/reset` | → `InviteDTO` with a password-reset link |
| DELETE | `/api/access/users/:id/sessions` | Signs the user out everywhere → `{ ok, revoked }` |
| GET | `/api/access/audit?limit&actor&action` | `AuditEventDTO[]`, newest first (audit:read) |
| POST | `/api/auth/signup` | `{ email, name, password, workspaceName, plan? }` → `SignupResultDTO` (self-serve only; no session until the email is verified) |
| POST | `/api/auth/verify` | `{ token }` → `MeDTO` and a session |
| POST | `/api/auth/resend`, `/api/auth/forgot` | `{ email }` → `{ sent: true }` always (verification again; a password-reset email) |
| GET / PATCH | `/api/workspace` | `WorkspaceDTO` / `{ name }` (users:manage) |
| GET | `/api/setup` | `SetupDTO`: the setup checklist with each step's state; `POST /api/setup/dismiss { dismissed }` |

## Billing and compliance

See [billing.md](billing.md). Billing routes need settings:manage, except the plan list.

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/billing/plans` | `PlanDTO[]` (empty when billing is off) |
| GET | `/api/billing` | `BillingDTO`: plan, period, usage, credit, limits, recommendation, ledger |
| POST | `/api/billing/checkout` | `{ plan, annual? }` → `{ url }` (Stripe Checkout) |
| POST | `/api/billing/topup` | `{ amountUsd: 50 \| 200 \| 500 }` → `{ url }` |
| POST | `/api/billing/portal` | → `{ url }` (Stripe customer portal) |
| PUT | `/api/billing/settings` | `{ spendCapUsd?, autoRecharge? }` → `BillingDTO` |
| POST | `/webhooks/stripe` | Stripe events, verified by the `Stripe-Signature` header |
| GET | `/api/compliance` | `ComplianceDTO`: country rules, issues, the do-not-call list, held leads (crm:read) |
| POST / DELETE | `/api/compliance/dnc` | `{ numbers }` or a CSV body → `{ added, invalid, total }` / clear → `{ removed }` (crm:write) |
| GET | `/api/compliance/dnc/check?phone` | `{ listed }` |

Plan limits answer **402** with the plan that includes the feature, or the reason scoring is paused.

## Common filters

| Query | Values | Default |
| --- | --- | --- |
| `range` | `7`, `30`, `90` (days back from now) | `30` |
| `dir` | `all`, `in`, `out` | `all` |
| `path` | `all`, `Investor`, `Broker`, `Non-target` | `all` |
| `ver` | a prompt version label, `live`, `previous` or `all` | `live` |
| `agent` | an agent id or `all` | `all` |

## Reference data

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/meta` | `MetaDTO`: taxonomy, metrics, gates, prompt versions, agents, data mode, settings |
| GET | `/api/settings` | `SettingsDTO` |
| PUT | `/api/settings` | Partial `SettingsDTO` → `SettingsDTO` |

## Technical view

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/matrix?range&dir&ver&agent` | `MatrixDTO`: persona × scenario cells (median CQS and dimensions, gate rate, meeting rate) |
| GET | `/api/cells/:pid/:sid?range&dir&ver&agent` | `CellDetailDTO`: path adherence, tool health, persona check, sample calls |
| GET | `/api/calls?range&dir&ver&agent&persona&scenario&band&gated&review&q&sort&limit&offset` | `CallListDTO` |
| GET | `/api/calls/:id` | `CallDetailDTO`: transcript, tags with evidence, metrics, gates, path, trace, coaching |
| GET | `/api/calls/:id/audio` | The recording, proxied from the provider |
| POST | `/api/calls/:id/reevaluate` | Queues the call for re-scoring (a call purged by retention is not re-scored) |
| POST | `/api/calls/:id/labels` | `{ fields?: { budget: '2m AED', … }, metrics?: { trel: 80, … } }`: a reviewer's answer key (Field capture accuracy; the call is re-scored) and judged-metric scores 0–100 (judge agreement) |
| GET | `/api/version-report?from&to&measure=cqs\|ns&score&agent` | `VersionReportDTO` with 95% bootstrap intervals |
| GET | `/api/traces?range&agent` | `TracesDTO` |

## Business view

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/funnel?range&dir&agent` | `FunnelDTO` |
| GET | `/api/fix?range&dir&vm=meet\|res&agent` | `FixDTO`: quality × value map and top five |

## Improvement

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/recommendations?status&scope&kind` | `RecommendationDTO[]` |
| POST | `/api/recommendations/generate` | Queues a recommendation run → `{ jobId }` |
| PATCH | `/api/recommendations/:id` | `{ status?, note?, targetVersion? }` → `RecommendationDTO` |
| GET | `/api/attention-items` | `Record<key, { owner, status }>` |
| PUT | `/api/attention-items/:key` | `{ owner?, status? }` |

## Taxonomy

Versioned: changes go into a draft, which is activated as a whole. See [taxonomy.md](taxonomy.md).

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/taxonomy` | `TaxonomyDTO`: the active version, the draft and its diff, versions, the framework entries `basedOn` refers to, checkpoint rules, tools, templates, calls per entry (90 days) |
| POST | `/api/taxonomy/draft` | `{ from: 'active' \| templateId, replace? }` → `TaxonomyDTO`; 409 while a draft exists unless `replace` |
| PUT | `/api/taxonomy/draft` | `{ domain, personas, scenarios, events }` (new entries with `id: ''`; leaving one out retires it) → `TaxonomyDTO`; 400 lists every problem |
| POST | `/api/taxonomy/draft/apply` | `{ operations: TaxonomyOp[], domain? }` → `TaxonomyDTO` (creates the draft if needed) |
| DELETE | `/api/taxonomy/draft` | Discards the draft → `TaxonomyDTO` |
| POST | `/api/taxonomy/draft/activate` | `{ notes?, rescoreDays?: 0 \| 7 \| 30 \| 90 }` → `{ version, rescoring }` (calls queued for re-scoring) |
| POST | `/api/taxonomy/copilot` | `{ mode: 'draft' \| 'edit' \| 'review', instruction }` → `TaxonomyProposalDTO` (needs a Claude key) |

## Governance

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/taxonomy/health` | `TaxonomyHealthDTO` |
| POST | `/api/taxonomy/clusters/run` | Queues a clustering run |
| POST | `/api/taxonomy/clusters/:id/propose` | `{ proposed: boolean }` |
| GET | `/api/alerts?status=open\|ack\|all&rule` | `AlertsDTO` |
| POST | `/api/alerts/:id/ack` | `{ acked: boolean }` |
| GET | `/api/review?status=open\|done&kind` | `ReviewItemDTO[]` |
| POST | `/api/review/:id` | `{ value?, gateConfirmed?, note? }` resolves an item; a tag value overrides the classifier; 409 if already resolved |

## Data in

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/integrations` | `IntegrationDTO[]` (secrets never returned) |
| POST | `/api/integrations` | `{ provider, name, apiKey, webhookSecret?, agentIds?, baseUrl?, pollMinutes?, enabled?, toolAliases? }` |
| PATCH | `/api/integrations/:id` | Any of the fields above |
| DELETE | `/api/integrations/:id` | — |
| POST | `/api/integrations/:id/test` | `{ ok, message, agents? }` |
| POST | `/api/integrations/:id/sync` | `{ since?: ISO date }` → `{ jobId }` backfill |
| GET | `/api/recordings?group` | `AudioRowDTO[]` |
| POST | `/api/uploads` | multipart: `file` + `conv`, `dir`, `prompt`, `layout`, `consent` → `{ id, callId, status }` |
| POST | `/api/crm/outcomes` | `[{ lead_id, stage, occurred_at, project?, value_aed?, external_id? }]` |
| POST | `/api/crm/outcomes/csv` | CSV text with the same columns |
| GET | `/api/jobs?limit` | `JobDTO[]` |
| POST | `/api/demo/seed` | Loads synthetic demo calls (only when `DEMO_MODE` is not `off`) |

## Onboarding, CRM, funnels and lead finders

CRM, funnel and lead-finder routes answer 403 while the built-in CRM is off (`settings.features.crm`).
Co-pilot routes answer 400 without a Claude key; their proposals change nothing until applied.

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/business` | `BusinessDTO`: profile (company, ideal customer profile, goals, calling rules), progress against the goals, the Apollo query, lead-finder status |
| PUT | `/api/business` | Partial profile (+ `onboarded: true`) → profile |
| POST | `/api/business/copilot` | `{ description, website?, sections? }` → `BusinessProposalDTO` (needs a Claude key; the website is read with Claude's web fetch, limited to that site) |
| GET | `/api/crm/leads?funnel&q&stage&source&consent&owner&dnc&eligible&needsEnrichment&sort&limit&offset` | `LeadListDTO`: one funnel's leads (the default funnel without `funnel`), with counts by stage and the funnel; `eligible=true` is what a campaign may call |
| POST | `/api/crm/leads` | A lead (camelCase or snake_case fields, optional `funnelId`) → created, or the matching lead backfilled |
| POST | `/api/crm/leads/import` | CSV text: `first_name,last_name,phone,email,company,title,city,country,consent,stage,owner,tags,notes,external_id` → `{ created, updated, skipped, errors }` |
| GET / PATCH / DELETE | `/api/crm/leads/:id` | `LeadDetailDTO` (events, calls, outcomes) / edit (`funnelId` moves it, keeping its milestone) / delete |
| POST | `/api/crm/leads/:id/stage` | `{ stage, note?, valueAed? }`: a stage key of the lead's funnel, or a milestone; outcome milestones become lead outcomes |
| GET | `/api/crm/funnels` | `LeadFunnelsDTO`: funnels with lead counts by stage, milestones, templates |
| POST | `/api/crm/funnels` | `{ name, description?, stages?, match?, template? }` → `LeadFunnelDTO` |
| GET / PUT / DELETE | `/api/crm/funnels/:id` | `LeadFunnelDTO` / edit (`remap: { oldKey: newKey }` for removed stages that hold leads, else 409) / delete (`?moveTo=` another funnel when it has leads; the default can't be deleted) |
| POST | `/api/crm/funnels/:id/default` | Makes it the default funnel |
| GET | `/api/crm/funnels/:id/report?range=30\|90\|all` | `LeadFunnelReportDTO`: reached, conversion, median days and losses per stage; win rate; sources |
| POST | `/api/crm/funnels/copilot` | `{ instruction, funnelId? }` → `FunnelProposalDTO` (needs a Claude key) |
| POST | `/api/leadfinder/search` | `{ max, filters? }` → `{ jobId }` (Apollo search from the ideal customer profile) |
| POST | `/api/leadfinder/enrich` | `{ creditCap, leadIds?, revealPhone? }` → `{ jobId }` |

## Campaigns and self-improvement

Every route answers 403 while batch calling is off (`settings.features.campaigns`).

| Method | Path | Returns |
| --- | --- | --- |
| GET / POST | `/api/campaigns` | `CampaignDTO[]` / create `{ name, integrationId, agentExternalId, fromNumber, objective, leadFilter (funnels, stages, sources, tags, leadIds), batchSize, dailyCap, allowUnknownConsent, improvement, challengerShare, minCallsPerArm, maxCallsPerArm }` |
| GET / PATCH | `/api/campaigns/:id` | `CampaignDetailDTO` (arms, batches, eligible leads, current cycle) / edit |
| POST | `/api/campaigns/:id/start\|pause\|cancel\|improve` | Lifecycle; `improve` starts an improvement cycle now (starting needs its own permission, as it places calls) |
| GET | `/api/improvement/cycles?campaign` | `CycleDTO[]` |
| GET | `/api/improvement/cycles/:id` | `CycleDetailDTO`: reference, candidate edits with probe results, composed challenger, live verdict, cost, lessons |
| POST | `/api/improvement/cycles/:id/approve\|reject\|promote\|rollback\|verify` | Decisions on a cycle (`{ note? }` for reject) |
| GET | `/api/improvement/lessons?agent` | `LessonDTO[]`: the lessons library |

## Webhooks

| Method | Path | Verified by |
| --- | --- | --- |
| POST | `/webhooks/elevenlabs/:integrationId` | `ElevenLabs-Signature: t=<unix s>,v0=<hex HMAC-SHA256(secret, "t.body")>`, 30-minute tolerance |
| POST | `/webhooks/retell/:integrationId` | `x-retell-signature: v=<unix ms>,d=<hex HMAC-SHA256(api key, body + ms)>`, 5-minute tolerance |
| POST | `/webhooks/apollo/:integrationId/:secret` | A secret in the URL, derived from `APP_SECRET` (Apollo's asynchronous phone numbers) |

The provider webhooks return `200` quickly and queue the work; the pipeline fetches the full call from
the provider. A disabled integration's webhooks are acknowledged (`queued: false`) but import nothing.
