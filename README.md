# call-eval

Evaluate AI calls better and self-improve your calls.

call-eval pulls the voice agent's calls from **ElevenLabs** and **Retell AI**, scores each one against
the *AI Call Evaluation Framework* (CQS, 62 metrics in 7 dimensions, 9 compliance gates, personas
P0–P11, scenarios S1–S12), joins CRM outcomes, and turns the patterns into **improvement
recommendations**: prompt changes, tool and routing fixes, and taxonomy updates. Each recommendation
carries its evidence and is verified against the next prompt version.

It can also run the sales side: a **built-in CRM** (on by toggle) that **Apollo.io** fills from the
business's ideal customer profile, **batch outbound campaigns** through ElevenLabs or Retell, and a
**self-improvement loop** that proposes prompt edits, tests them on simulated callers, runs the winner as
a challenger on a share of live calls, and promotes it only when the calls prove it better.

It is built for the Fakhruddin off-plan sales agent described in the framework document. The
taxonomy, metrics and tool map live in one framework definition, so another agent can be evaluated by
changing them.

```
ElevenLabs ─┐  webhook (signed) or polling     ┌─ rules → classifier → segment → code checks
Retell AI  ─┼──────────────► ingest ─► queue ──┤  → LLM judge (Claude) → audio model (optional)
Uploads    ─┘   (ElevenLabs STT for recordings) └─ → gates → CQS → path → coaching → store
                                                          │
CRM (built-in / Treppan / CSV) ─► lead outcomes ─► attribution ─┤
Apollo.io ─► leads ─► campaigns (batch calls) ◄── self-improvement (propose → probe → compose → verify)
                                                          ▼
              console: matrix · fix-first · funnel · version report · recommendations · alerts · CRM · campaigns
```

## Quick start

Needs Python 3.12 with [uv](https://docs.astral.sh/uv/) for the API, and Node 22 for the console.

```bash
npm install                        # console and shared framework types
npm run setup:api                  # Python environment for the API (uv sync)
npm run build                      # build the console once
npm run seed:demo                  # optional: 5,000 synthetic calls over 90 days (~100 s, no API spend)
npm run dev:api                    # API + worker + console on http://localhost:8787
```

Without `DATABASE_URL` the API runs an embedded PostgreSQL (installed with the Python package) with
its data in `./data/pg`, so there is nothing else to install. The console can also seed demo data
itself (**Integrations → Load demo data**). For console development with hot reload, run
`npm run dev:web` as well and open http://localhost:5173.

### Self-serve launch

The image serves the landing site at `/`, the console at `/app/` and the API at `/api`. With `SELF_SIGNUP=on` anyone
can sign up for a workspace of their own (verified by email); with `BILLING=on` plans, pay-as-you-go credit and
usage limits apply through Stripe; calling-compliance rules apply to every campaign. Follow
[docs/launch.md](docs/launch.md), and run `calleval doctor` before and after switching on. See
[docs/billing.md](docs/billing.md) for plans, limits and the calling rules.

### Users

Until someone creates the first owner, the app is open to anyone who can reach it (fine for a local
demo). Create the owner from the console's banner, or on a server with
`cd apps/api && uv run calleval users create --email you@example.com`, then invite the team with a role
each (Governance → Users and access). See [docs/access.md](docs/access.md).

### Connect real calls

1. Copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY` (the LLM judge), `APP_SECRET`, and the
   provider keys, or add the integrations from the console (**Integrations → Add integration**). Blank
   lines in `.env` are fine: an empty value counts as unset.
2. Point the provider's post-call webhook at the URL shown for the integration
   (`{PUBLIC_URL}/webhooks/{provider}/{integration id}`). Polling every 15 minutes also runs, so a
   missed webhook is picked up, and **Sync now** or **Backfill** (from a date) imports history.
3. Turn `DEMO_MODE=off` once real calls flow, and delete the demo data (or start from a fresh database).

### Grow: business setup, taxonomy, funnels, lead finders, campaigns, self-improvement

1. **Business setup** in the console: company, ideal customer profile, weekly goals and calling hours,
   and the modules to turn on (built-in CRM, batch calling, and what the improvement loop may do alone).
   With a Claude key, **Co-pilot** drafts it from a description or your website.
2. **Taxonomy** (Governance): define the personas, scenarios and events your calls are scored by, by
   hand, from a template or with the co-pilot; changes go into a draft you activate. See
   [docs/taxonomy.md](docs/taxonomy.md).
3. **Funnels** and **Leads**: name your funnel stages (or start from a template or the co-pilot), then
   add or import leads, or connect Apollo.io (**Integrations**) and use **Find leads** and **Enrich**.
   Found leads are consent-unknown and are not called until consent is recorded (or you allow unknown
   consent where your rules permit it).
4. **Campaigns**: pick the ElevenLabs or Retell agent, the funnel and stages, and the batch size, and start.
   Calls arrive through the normal webhooks, are scored, and move their leads forward.
5. **Self-improvement**: cycles start once the current prompt has enough scored campaign calls. In
   *propose* mode a person approves each challenger and each promotion; in *auto* mode only verified
   wins are promoted, and edits touching compliance rules always wait for a person.

See [docs/integrations.md](docs/integrations.md) for the provider settings, the CRM feed, uploads,
Apollo and the audio model, and [docs/growth.md](docs/growth.md) for the CRM, campaigns and the
self-improvement loop.

### Production

```bash
docker compose up --build          # PostgreSQL 16 + the app on :8787
```

or run directly: `npm run build && DATABASE_URL=postgres://… npm start`. Run extra workers with
`npm run worker` (they share the PostgreSQL job queue) and start the web process with
`RUN_WORKER=false` if you want them separate.

Create the first owner before the app is reachable from outside, since it is open until then:
`docker compose exec app calleval users create --email you@example.com`. Set `PUBLIC_URL` to the
https address (invitation links use it, and session cookies are then marked secure), and behind a load
balancer set `FORWARDED_ALLOW_IPS` to its address.

## Repository

| Path | What it holds |
| --- | --- |
| `apps/api` | Python service (FastAPI, `calleval` package): provider connectors, evaluation pipeline, Postgres job queue and scheduler, analytics, alerts, CRM attribution, recommendation engine, built-in CRM, lead finders, campaigns and the self-improvement loop |
| `apps/api/calleval/framework` | The framework as code for the API: taxonomy, 62 metrics, gates, tool map, scenario paths, scoring maths |
| `packages/framework` | The same framework in TypeScript for the console, plus every API response type; a test keeps the two in step |
| `apps/web` | React console (Mantine), 22 screens, served by the API at `/app/` in production |
| `apps/site` | Landing site: the scroll-driven 3D story (three.js, GSAP), pricing and FAQ, prerendered, served at `/` |
| `docs/` | [Go-live runbook](docs/launch.md), [billing and compliance](docs/billing.md), [architecture](docs/architecture.md), [decisions](docs/decisions.md), [users and access](docs/access.md), [integrations](docs/integrations.md), [taxonomy](docs/taxonomy.md), [growth features](docs/growth.md), [REST API](docs/api.md), [audio model contract](docs/audio-model.md) |

## Scripts

| Command | Does |
| --- | --- |
| `npm run setup:api` | Creates the API's Python environment (`uv sync` in `apps/api`) |
| `npm run dev:api` / `npm run dev:web` | API with auto-reload / console with hot reload |
| `npm run build` | Builds the console (`apps/web/dist`); the API needs no build |
| `npm start` / `npm run worker` | Production server (API + worker) / worker only (`calleval serve`, `calleval worker`) |
| `npm run seed:demo` | Synthetic demo quarter through the real pipeline (`calleval seed-demo --count N --days D`) |
| `npm run typecheck` / `npm test` | Console and framework typecheck / every test suite (console, framework, API) |
| `npm run test:api` | API tests only (`uv run pytest` in `apps/api`) |

## What the tests cover

`npm test` runs without network or API keys. The API suite (pytest, 131 tests, each module on its own
throwaway embedded PostgreSQL) covers framework scoring maths and its agreement with the console's
TypeScript copy; ElevenLabs and Retell payload normalisation from SDK-shaped fixtures; webhook
signature checks for both providers (valid, tampered, stale, wrong key); the pipeline on fixture and
synthetic calls, including the Claude judge against a stand-in client; spoken-number grounding; an
end-to-end HTTP suite (signed webhook → queue → scored call, polling sync against a stubbed provider,
duplicate delivery, CRM CSV attribution, the API token on encoded paths, every console endpoint on demo
data, the recommendation lifecycle); the built-in CRM, onboarding and the Apollo lead finder;
campaigns (eligibility, calling window, arm split, both providers' batch payloads); the
self-improvement loop (propose-only without a key, probing, live verification, promotion, rollback,
compliance holds); and regression tests for the gaps fixed in the move to Python (retention, polling
cursor, stuck jobs, review duplicates, prompt-version races).

## Configuration

All settings are environment variables; `.env.example` lists them with defaults. Framework knobs
that the sales team owns (dimension weights, attribution windows, budget bands, review sample rate,
confidence threshold, retention, optional modules) are stored in the database and edited from the
console (**Scoring model**, **Business setup**, and `PUT /api/settings`).
