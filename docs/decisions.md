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
| Who owns the taxonomy | Clustering only proposes candidate tags for the monthly review; the taxonomy changes through a new versioned release a person signs off | Keeps the classifier stable between reviews |
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

**Claude settings.** `claude-opus-5-5` with structured outputs (JSON schema, validated with zod),
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

**PostgreSQL everywhere, with PGlite for development.** One SQL dialect; the job queue is a table with
`SKIP LOCKED`, so there is no Redis or broker to run. PGlite (Postgres in WebAssembly) makes
`npm install && npm run dev:api` work with nothing else installed and lets tests run on a real Postgres
in memory.

**One process by default, split when needed.** API, workers and scheduler run in one process; set
`RUN_WORKER=false` on web instances and run `npm run worker` elsewhere when volume grows. Jobs dedupe,
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

## Not verified against live accounts

The provider request and payload shapes follow the official SDKs' type definitions. The webhook
signature header names and formats follow the providers' documentation as known at build time; they
are covered by tests but have not been exercised against live accounts from this environment. The
Treppan adapter assumes a simple outcomes endpoint, since Treppan's API is not public.
