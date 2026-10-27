# Architecture

One Python service (API, worker and scheduler, which can be split) on PostgreSQL, a React console it
serves, and the framework itself, defined once for the API (Python) and once for the console
(TypeScript), with a test that keeps the two identical.

```
                 ┌──────────────────────── apps/api (Python) ────────────────────────┐
 ElevenLabs ──►  │ webhooks ─┐                                                        │
 Retell AI  ──►  │ polling  ─┼─► job queue (Postgres, SKIP LOCKED) ─► workers         │
 Uploads    ──►  │ uploads  ─┘        ▲            │                                  │
                 │                    │ scheduler   ▼                                  │
 CRM ─────────►  │ outcomes ──────────┤   ingest → evaluate → store → alerts          │
                 │                    │                                               │
                 │ REST API ◄── analytics (matrix, fix map, funnel, version report…) │
                 │          ◄── recommendations engine ◄── playbook + Claude          │
                 └──────────────────────────────┬────────────────────────────────────┘
                                                │ serves
                                   apps/web (React console)
```

## Packages

**`apps/api/calleval/framework`** is the framework document as code for the API: personas and
scenarios (`taxonomy.py`), the 62 metrics with their dimension, weight, green and red lines, method and
N/A rule (`metrics.py`), the 9 gates, the tool map (`tools.py`), scenario paths (`paths.py`), and the
scoring maths (`scoring.py`: normalisation, roll-up, CQS, bands, bootstrap intervals, Cohen's kappa).
**`packages/framework`** holds the same definitions in TypeScript for the console, the canonical call
and evaluation types (`types.ts`) and every API response type (`api.ts`); `test_scoring.py` checks the
two definitions are identical.

**`apps/api/calleval/taxonomy`** is the taxonomy the pipeline actually uses: the active version, which
may be user-defined, loaded from the database and re-checked every few seconds by each process. Code
that needs a framework entry (the failed-call rule, the broker-registration rule, the per-persona
checks) asks for the active entry based on it (`basedOn`), so those rules survive a redefined taxonomy;
lookups fall back to retired versions so older calls keep their names. The framework package keeps the
v1.0 definitions, the templates and the demo data's taxonomy. See [taxonomy.md](taxonomy.md).

**`apps/api`** is the platform (the `calleval` package: FastAPI, psycopg, the Anthropic Python SDK).
**`apps/web`** is the console. `calleval/js.py` keeps JavaScript's number formatting, rounding and
JSON rules where they show in scores, labels and stored data, so the service reads exactly as the
TypeScript one it replaced did.

## Data in

Each provider has a connector (`calleval/connectors/`) with the same interface: list calls since a time,
fetch one call, fetch the agent's prompt, fetch audio, verify and parse a webhook, and normalise a raw
payload into a **canonical call**: turns with timings (word-level where the provider has them), tool
calls placed on the agent turn that made them with results and latency, end reason, direction,
dynamic variables, provider analysis, latency percentiles, cost and recording.

- **Webhooks** are verified against the raw request bytes, then a job is queued and the provider gets
  a 200 immediately. When the payload carries the transcript it is used directly; otherwise the call is
  fetched.
- **Polling** runs per integration (every 15 minutes by default) from a cursor with a 10-minute overlap,
  pages through the provider's list endpoint, skips calls already scored and calls still in progress,
  and continues in a follow-up job after 20 pages, so a large backfill never blocks the queue.
- **Uploads** are transcribed with ElevenLabs Speech-to-Text and become canonical calls too.

`pipeline/ingest.py` stores the canonical call (and the raw payload, until retention purges it), upserts the
agent, and resolves the **prompt version** (one decision at a time per agent, under an advisory lock): the `prompt_version` dynamic variable if set, else the
provider's agent version, else a hash of the prompt text. Each distinct version gets a label (v1, v2…)
per agent, so the version report works without anyone tagging releases.

## Evaluation pipeline

`calleval/pipeline/evaluate.py` runs the framework's steps in order for one call:

1. **Context record** from dynamic variables (known caller, returning lead, objective) and direction.
2. **Rules**: deterministic tags (failed calls → S12/P0, broker signals, transfers, callbacks,
   do-not-contact, tool events).
3. **Classifier**: persona, primary and secondary scenario, start and end intent, with confidence and
   evidence turns (Claude, or the heuristic). Tags under the confidence threshold go to review.
4. **Segmentation** into Introduction, Body and Conclusion, using the persona resolution and closing
   signals.
5. **Fields**: name, bedrooms, location, budget, timeline, must-haves, who it is for.
6. **Code checks**: voice and timing from turn timestamps, tool use against the tool map (precision,
   recall, argument accuracy, sequencing, result fidelity, dead air), discovery coverage, re-asks,
   question discipline, code-decidable gates (G5 do-not-contact, G6 unconfirmed send, G8 claims the
   tool did not confirm, G9 abandoned transfer).
7. **LLM judge**: the judged metrics, judged gates (G1 invented fact, G2 promise, G3 advice, G4 AI
   identity, G7 other customer discussed)
   and scenario path checkpoints, each with a score, evidence turns and a rationale.
8. **Audio** (optional): emotion trajectory, naturalness, prosody, delivery-tag fidelity.
9. **Scoring**: normalise each metric to 0–100, drop the ones that do not apply, roll up into seven
   dimensions (Re-ask and Wrong path count twice), weight, and cap at 40 if any gate failed.
10. **Path adherence, outcome** (next step, meeting kind, qualified, abandoned), lowest metrics with
    quotes, coaching notes, review items, tool tallies.

`pipeline/store.py` writes the evaluation in one transaction: call score, metric results, tags, events,
trace spans, evaluator runs, review items. Re-scoring replaces, never duplicates. Reviewer decisions (a corrected persona,
a confirmed or rejected gate) are fed back as overrides on the next evaluation.

## Jobs and scheduling

The queue is a Postgres table claimed with `FOR UPDATE SKIP LOCKED`, so any number of worker
processes can share it; jobs have priorities, dedupe keys, retries with exponential backoff, and stale
locks are recovered. A running job renews its lock every minute, so only a lost worker's jobs go back to
the queue, and a job that has used all its attempts is failed rather than retried forever. The
scheduler (in each process; jobs dedupe) queues: provider polling, alert rules hourly, CRM sync and
retention daily, recommendations weekly, clustering monthly, and every 30 seconds the campaign tick
(next batch inside the calling window, improvement cycles, challenger verification).

Polling never moves its cursor past a call that is still in progress, so a long call missed by its
webhook is still listed once it ends.

## Growth modules

Optional, switched on in **Business setup** (`settings.features`); see [growth.md](growth.md).

- **Built-in CRM** (`crm/leads.py`, `crm/funnels.py`): leads, consent and history, in user-defined
  funnels whose stages stand for framework milestones. Outcome milestones become lead outcomes, so
  attribution and Funnel by persona work as with an external CRM; a scored call moves its lead forward
  by milestone and a do-not-contact request on a call stops contact.
- **Co-pilot** (`copilot.py`): Claude drafts the business profile (reading the website with Claude's
  web fetch), taxonomy changes and funnels as proposals checked like manual edits; a person applies
  them. Structured outputs through `lib/claude.py`, which the improvement loop shares.
- **Lead finders** (`leadfinder/apollo.py`): Apollo.io search from the ideal customer profile
  (`business.py`) and credit-capped enrichment; phone numbers arrive on a signed webhook.
- **Campaigns** (`campaigns/`): batch calls through ElevenLabs or Retell to eligible leads, split
  between the champion prompt and a live challenger.
- **Self-improvement** (`improve/`): Propose → Probe (simulated callers scored by this pipeline) →
  Compose a challenger, then live verification with the bootstrap interval, promotion or rollback, and
  a library of lessons the next cycle reads.

## Analytics

All views are SQL over the scored calls with the same filters (range, direction, persona path, prompt
version, agent):

- **Quality matrix**: persona × scenario cells with median CQS and dimensions, gate rate, meeting
  rate; cells under the minimum call count are marked.
- **Cell drill-down**: path adherence per checkpoint, tool health, persona-specific check, sample calls.
- **Version report**: per cell, old vs new prompt version, with a 95% bootstrap interval on the
  difference in medians; verdicts *up*, *down*, *flat* or *too few calls*.
- **Fix-first map**: cells by agent quality and business value (meeting-booked rate until there is
  enough reservation data), top five in *Fix first*.
- **Funnel by persona**: calls → qualified → next step → meeting → attended → site visit →
  reservation, from CRM outcomes credited to calls.
- **Taxonomy health**: Unclassified and Other share by week, classifier confidence, reviewer
  agreement (kappa), classifier-vs-reviewer match, clusters of calls the taxonomy does not describe.
- **Traces**: LLM and tool spans per turn, latency and token use.

## Recommendations

`calleval/recommendations/engine.py` turns patterns into fixes:

1. **Findings**: failed gates; metrics below the line, scoped to the persona, scenario or cell where
   the failures concentrate; fix-first cells; routing (non-target callers above 8% of calls);
   taxonomy clusters of 20 or more calls.
2. **Playbook** (`playbook.py`): each metric and gate has a kind (prompt, tool, routing, voice,
   coaching), a proposed fix and a prompt rule.
3. **Tailoring** (with a Claude key): the top findings are rewritten against the agent's actual
   prompt, with an exact prompt patch, quoting the evidence turns.
4. **Priority** estimates the score at stake: for a gate, the CQS its failures lost to the cap plus a
   fixed premium (each failure is a compliance incident); for a metric, the points below the line
   summed over calls × dimension weight × metric weight; fix-first cells by depth in the quadrant;
   routing and taxonomy items by call count.
5. **Lifecycle**: proposed → accepted → in prompt (with a target version) → **verified** when the
   version report shows the metric, cell or gate improved with a 95% interval above zero, or flagged as
   regressed. Re-running the engine updates open items by fingerprint instead of duplicating them.

## Alerts

Gate failure (on scoring), latency p90 above 4 s in a day, tool failure above 5% in a day, a cell's
median CQS down 5 or more week on week, a persona's next-step rate down 10 points, Unclassified plus
Other above 5% for a week. Each alert links to the view that explains it and dedupes per period.

## Database

PostgreSQL in production; for local use and tests an embedded PostgreSQL (real Postgres binaries
installed with the Python package, `pgserver`) runs from `PG_DIR`, so there is one SQL dialect and
nothing else to install. Tests give each module its own throwaway database. Migrations are plain SQL in
`calleval/db/migrations.py`, applied at start; version 1 is the schema the TypeScript service created,
so an existing database migrates in place. Main tables: `integration`, `agent`, `prompt_version`, `calls` (canonical and raw JSON plus
denormalised tags and scores for fast filtering), `call_score`, `metric_result`, `call_tag`,
`call_event`, `trace_span`, `lead_outcome`, `review_item`, `review_label`, `recommendation`, `alert`,
`cluster`, `job`, `upload`, `app_setting`, for the growth modules `lead`, `lead_event`, `funnel`,
`campaign`, `campaign_batch`, `campaign_lead`, `improvement_cycle`, `improvement_lesson`, and for access
`app_user`, `user_session`, `api_token`, `user_invite`, `audit_event`.

## Security

- Users with fixed roles (`calleval/auth`): sessions, personal API tokens and the `API_TOKEN` environment
  token resolve to a principal in one middleware, on the decoded path so an encoded form such as
  `/%61pi/…` cannot skip it; an app-wide dependency then checks the permission `auth/policy.py` gives
  the matched route (a route missing from the table is refused, and a test fails). Changes are written
  to the audit log. See [access.md](access.md).
- Webhooks authenticate by signature (Apollo's phone webhook by a secret in its URL), and a disabled
  integration's webhooks are acknowledged but import nothing.
- Provider keys encrypted at rest with AES-256-GCM (`APP_SECRET`); only a four-character hint is shown.
- Retention (`retentionDays` setting) keeps scores, tags and outcomes and removes what was said and who
  said it: raw payloads, transcripts, tool payloads, phone numbers, dynamic variables, captured fields,
  quotes copied into scores, coaching, gate details and recommendation evidence, judge outputs, the
  summary tag, and uploaded audio files. A purged call is never re-scored.
- Uploads require confirmation that the recording notice covers analysis.
