# Decisions

The framework document leaves several choices open and some only implied. These are the calls made
while building the platform, with the reasoning, so each can be revisited deliberately.

## Business

**Who the platform serves.** Two audiences, as the framework says: the AI team (prompt engineers, QA
reviewers), who need per-call evidence and per-version proof, and sales leadership, who need the
funnel and where agent quality costs money. The console groups screens accordingly (Improve, AI team,
Shared with sales, Governance, Data), and the landing page is **Needs attention**: the dimensions,
personas, scenarios and cells costing the most score in the period, each with an owner and a status.

**Recommendations are the product's output, not dashboards.** Every number exists to answer "what
should we change in the prompt, tools or routing next week". Recommendations carry the problem in
numbers, the proposed fix, the exact prompt rule to add, quoted evidence turns, and the metric or cell
that should move. They are only counted as done when the next prompt version moves that metric with a
95% interval above zero. This closes the loop the framework describes ("every prompt release is
measured with the version report") and stops the team shipping changes that feel right but do nothing.

**Compliance gates cap the score and page someone.** A gate failure caps CQS at 40 (framework rule),
raises an alert within the hour, and queues the call for human confirmation. A reviewer can reject a
false gate, and the call is re-scored without it.

**Value per call uses the meeting-booked rate until reservations accumulate.** Off-plan reservations
are rare and slow; with fewer than about 30 per cell the reservation rate is noise. The fix-first map
defaults to the meeting-booked rate as a stand-in and offers the reservation rate once CRM data is
deep enough.

**Brokers are scored on their own path.** Broker personas (P7, P8) skip buyer discovery and are
measured on registration, the broker fork, and the BDM meeting, as the framework requires; the
demo data shows broker onboarding as the weakest high-value cell to illustrate it.

**Default answers to the open questions** (all editable in **Scoring model → Settings** or by API):

| Question | Default | Why |
| --- | --- | --- |
| Which CRM fields record attended, site visit, reservation, value? | Nine stages with synonyms (`EOI` → reservation, `SPA signed` → sale), `value_aed` optional | Map once in the Treppan adapter or CSV; the funnel shows what exists |
| Is 30 days long enough for attribution? | 30 days for meetings and visits; **90 days** for reservations, sales and broker deals | Off-plan decisions often take one to three months after the first call |
| Budget bands per community | A < 1M, B 1–2M, C 2–4M, D > 4M AED, one set | A starting point for the sales workshop; bands are data, not code |
| Weekly call volume vs 30 calls per cell | Cells under 30 calls are shown but flagged and excluded from fix-first, alerts and verdicts | Avoids acting on noise; lower the minimum if volume is small and merging personas is not wanted |
| Retention and consent | Keep everything until `retentionDays` is set; the daily job then removes raw payloads, transcripts and tool payloads but keeps scores and tags. Uploads require a consent confirmation | Retention is a legal decision for Fakhruddin; the mechanism is ready |
| Who owns the taxonomy | Clustering and the co-pilot only propose; the taxonomy changes through a draft a person activates as a new version | Keeps the classifier stable between reviews |
| Languages besides English | Rules and the heuristic judge are English; the Claude judge reads any language and records it; Arabic and other language switches surface as a taxonomy cluster | The framework scopes v1 to English |

## Technical

**Provider-neutral canonical call.** ElevenLabs and Retell disagree on almost everything (seconds vs
milliseconds, interleaved vs separate tool events, word timings vs item timings, termination reason
names). Each connector maps once into one record; nothing downstream knows the provider. Adding a
provider (Vapi, Bland, a SIP recorder) means one new connector.

**Webhooks and polling together.** Webhooks give minutes-fresh scores; polling from a cursor (with a
10-minute overlap) recovers anything missed during an outage and backfills history. Both enqueue the
same deduplicated ingest job, so a call delivered twice is stored once.

**Tool calls are placed on turns.** The tool metrics (precision, recall, sequencing, fidelity, dead air)
need to know which agent turn made each call and what the caller said before it. Both connectors place
a tool call on the agent turn that issued it, or on the next agent turn when the call fired after the
caller spoke.

**Code first, LLM second.** Anything decidable from timestamps or the tool log (latency, interruptions,
tool recall and sequencing, do-not-contact, unconfirmed claims, abandoned transfers) is computed in
code: cheaper, exact and stable across model versions. Claude judges what needs reading (persona,
scenario, empathy, objection handling, invented facts, path checkpoints) and must cite evidence turns
for each score, which the console links to the transcript.

**Claude settings.** `claude-opus-5-5` with structured outputs (JSON schema, validated with pydantic),
streaming for long calls, effort `medium` for judging and `high` for recommendation tailoring, the
judge's system prompt and the transcript cached, a concurrency limit, and server-side refusal
fallbacks enabled by default (`CLAUDE_FALLBACKS=off` to disable). Classification and judging are
separate requests; if either fails or is refused, that step falls back to the heuristic judge and the
trace records why, so a call is never left unscored.

**A heuristic judge as the floor.** Without an API key (and for demo data) a deterministic judge
produces every judged output from transcript patterns. The console labels which judge scored the data.
The platform works end to end on day one, and judge agreement can be measured by comparing the two.

**Numbers spoken as words.** Voice agents write prices out for the TTS ("one point two five million
dirhams"). Grounding checks convert spoken numbers to digits before comparing them with the tool
output, so a correctly read price is not flagged as invented.

**Read-back only where it matters.** G6 (unconfirmed send) requires the destination to be named before
a send, and an explicit read-back and confirmation only when the caller gave a new number or email, as
the tool map specifies. Sending to the number on the call is not a violation.

**Prompt versions without release tagging.** Versions come from the `prompt_version` variable, the
provider's agent version, or a hash of the fetched prompt, in that order. Labels are assigned per
agent in order of first appearance, so the version report works even if nobody tags releases. With
several agents (an ElevenLabs outbound agent and a Retell inbound one, say), "live" means each agent's
own live version in every view and in recommendation runs, and the version report compares one
agent's releases (the busiest unless another is chosen).

**Statistics.** Version comparisons and recommendation verification use a bootstrap 95% interval on
the difference in medians; pass/fail metrics and gates compare pass rates, since their medians barely
move. A cell needs 30 calls on each side for a verdict. Reviewer agreement is Cohen's kappa; it is
reported as not measured when a sample has no variation.

**PostgreSQL everywhere, embedded for development.** One SQL dialect; the job queue is a table with
`SKIP LOCKED`, so there is no Redis or broker to run. An embedded PostgreSQL (real Postgres binaries
installed with the Python package) makes `npm run setup:api && npm run dev:api` work with nothing else
installed, and gives each test module its own throwaway database. SQL keeps PostgreSQL's native `$1`
placeholders (psycopg's raw cursor), so queries read the same in code and in `psql`.

**One process by default, split when needed.** API, workers and scheduler run in one process; set
`RUN_WORKER=false` on web instances and run `npm run worker` (`calleval worker`) elsewhere when volume grows. Jobs dedupe,
so several schedulers are safe.

**Audio analysis behind a contract.** Emotion and MOS models need GPUs and change often, so they are
an optional HTTP service ([contract](audio-model.md)) rather than a dependency. Without one, the emotion
dimension uses transcript-side measures, and drops out of the score where there is no recording, so
calls are not penalised for missing audio.

**Settings in the database.** Weights and thresholds are "starting values to revisit after 200 calls";
the attribution window and budget bands are for sales to agree. They are stored settings, editable in
the console, not constants.

**Demo data runs through the real pipeline.** The synthetic quarter (three prompt versions, faults
concentrated where a real agent would struggle) is stored, scored, attributed and alerted by the same
code as live calls, so every screen can be evaluated before a provider is connected, and the demo is
an integration test of the whole platform.

**The API in Python.** The service moved from TypeScript to Python (FastAPI, async psycopg, the
Anthropic Python SDK, httpx). The move was a faithful port first: every module was checked against the
TypeScript on the same inputs (the framework on 2,594 cases, 22,744 text-helper cases, 1,976 call
evaluations, the rows written for 226 stored calls, 904 analytics views on a 3,000-call reference
database, and 1,327 HTTP requests with both servers on one database) before any behaviour changed.
`calleval/js.py` keeps JavaScript's rounding (`Math.round`, `toFixed`), number formatting, JSON output,
regex semantics and date formats where they show, so scores and stored data are unchanged. The console
stays TypeScript and keeps its own copy of the framework, tested against the API's.

**Gaps fixed in the move.** The port surfaced gaps in the TypeScript service, fixed with a regression test
each (`tests/test_gaps.py`): the API token could be skipped with a percent-encoded path; a copied
`.env.example` disabled the console and the speech-to-text key fallback; retention left uploads, their
audio files and transcript text copied into other tables, and re-scoring a purged call overwrote its
scores; uploaded recordings never reached the audio model; polling could skip a call that was in
progress at poll time; a job that killed its worker was retried forever, and a long job could run twice;
nothing could record the answer keys and metric labels that field capture accuracy and judge agreement
need (`POST /api/calls/:id/labels`); version-report intervals depended on unordered rows; a review item
could be resolved twice; a confirmed gate went back to review on every re-score; two new prompt versions
could get the same label; ingesting without agent info erased the agent's config; evaluator runs piled
up on re-scoring; a disabled integration still imported webhook calls; Treppan's connection test
imported data; a transcript containing the word "constructor" failed evaluation.

## Growth modules

**A simple CRM, off by default.** Teams with Treppan keep their feed; teams without a CRM turn the
built-in one on. Its outcome stages are written as lead outcomes, so attribution, the funnel and the
fix-first map need no second code path, and an external feed keeps working alongside it.

**Lead finders fill the CRM, never the call list.** Apollo.io search is free and returns names, titles
and companies; enrichment spends credits, so it runs only on request with a credit cap. Found leads are
consent-unknown, and campaigns skip them unless Business setup allows unknown consent: outbound calls
to purchased contacts are regulated (do-not-call registers, consent rules), and that choice belongs to
the business, not the default.

**A user-defined taxonomy keeps the framework's rules through anchors.** The pipeline has rules that
belong to specific framework entries: failed calls are S12, the registration tool means a broker and
S7, P11 feeds the drift alert, P1–P11 each have a check. Rather than drop them for custom taxonomies
or force every taxonomy to keep v1's ids, each entry may name the framework entry it behaves like
(`basedOn`), and code asks for "the active entry based on S12". v1.0 is every entry based on itself, so
its behaviour is unchanged (the TypeScript parity tests still pass). Versions are immutable once
active, ids are never reused, and lookups fall back to retired versions, so historical calls keep their
meaning; re-scoring history under a new version is an explicit choice at activation, because with a
Claude key it costs judge tokens.

**Funnels own stages; milestones own meaning.** Teams name their stages, but attribution, the persona
funnel, call-driven progress and campaign eligibility need to know what a stage means. Each stage may
stand for a framework milestone; outcomes are recorded under the milestone, so reports and the external
CRM feed share one vocabulary while every funnel reads in the team's own words. The default funnel is
the CRM's original stages, so nothing moves for existing leads.

**The co-pilot proposes; people apply.** Business profile, taxonomy and funnel changes shape how every
call is scored and who gets called, so the co-pilot never writes: it returns proposals that are first
run through the same checks as a manual edit (operations that would fail are flagged, impossible ones
dropped, small funnel slips repaired), and the console applies the ones a person picks. Websites are
read with Claude's web fetch tool restricted to the given site, so the API never fetches arbitrary
URLs itself (no server-side request forgery surface).

**Accounts with fixed roles, one company per installation.** Sign-in is email and password first (single
sign-on can be added in front of the same sessions later); roles are a fixed set rather than custom ones,
because each permission maps to a real risk (placing calls, changing the live agent, spending credits,
changing how calls are scored) and a short table is easier to reason about than a role editor. One
company per installation keeps every query free of a tenant filter; an agency running several clients
runs several installations. The app stays open until the first owner exists, as it was before accounts,
so local demos need no setup; `API_TOKEN` keeps working as an owner token. Permissions live in one table
keyed by route and are checked by one dependency, so a new route without a decision is refused rather
than left open.

**Harness²'s method, not its code.** Google's Harness² (arXiv 2610.14224) improves an agent's harness
with Propose → Probe → Compose and a library of evidence-backed lessons, without ground-truth labels. Its
release is a CLI over its own benchmarks with OpenCode or Codex executors; it cannot run a voice agent
that lives on ElevenLabs or Retell. The loop is therefore built in: proposals come from the
recommendation findings and past lessons; probes replay real callers' goals in simulated text
conversations (Claude plays caller and agent) scored by this pipeline, which is the ground-truth-free
verifier the method needs; the composed winner runs as a challenger on a share of live campaign calls,
and only the bootstrap interval on those calls decides promotion.

**Safety rails on self-improvement.** Default mode is *propose*: a person approves each challenger
and each promotion. *Auto* promotes only when live calls show a 95% interval above zero and no rise in
gate failures, and an edit that touches compliance rules always waits for a person. Every outcome,
including rejections and regressions, is recorded as a lesson the next cycle reads, and each cycle's
model spend is capped and recorded.

## Not verified against live accounts

The provider request and payload shapes follow the official SDKs' type definitions. The webhook
signature header names and formats follow the providers' documentation as known at build time; they
are covered by tests but have not been exercised against live accounts from this environment. The
Treppan adapter assumes a simple outcomes endpoint, since Treppan's API is not public. Batch calling
follows the providers' documented request shapes (ElevenLabs `batch-calling/submit`, Retell
`create-batch-call`); the per-call prompt override for the challenger arm (ElevenLabs
`conversation_config_override`, which the agent must allow; Retell `agent_override`) and Apollo's
phone-number webhook payload need confirming with a live account before relying on them.
