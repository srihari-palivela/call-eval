# call-eval

Evaluate AI calls better and self-improve your calls.

call-eval pulls the voice agent's calls from **ElevenLabs** and **Retell AI**, scores each one against
the *AI Call Evaluation Framework* (CQS, 62 metrics in 7 dimensions, 9 compliance gates, personas
P0–P11, scenarios S1–S12), joins CRM outcomes, and turns the patterns into **improvement
recommendations**: prompt changes, tool and routing fixes, and taxonomy updates. Each recommendation
carries its evidence and is verified against the next prompt version.

It is built for the Fakhruddin off-plan sales agent described in the framework document. The
taxonomy, metrics and tool map live in one shared package, so another agent can be evaluated by
changing them.

```
ElevenLabs ─┐  webhook (signed) or polling     ┌─ rules → classifier → segment → code checks
Retell AI  ─┼──────────────► ingest ─► queue ──┤  → LLM judge (Claude) → audio model (optional)
Uploads    ─┘   (ElevenLabs STT for recordings) └─ → gates → CQS → path → coaching → store
                                                          │
CRM (Treppan / CSV) ─► lead outcomes ─► attribution ──────┤
                                                          ▼
              console: matrix · fix-first · funnel · version report · recommendations · alerts
```

## Quick start

Needs Node 22.

```bash
npm install
npm run build -w @calleval/web     # build the console once
npm run seed:demo                  # optional: 5,000 synthetic calls over 90 days (~90 s, no API spend)
npm run dev:api                    # API + worker + console on http://localhost:8787
```

Without `DATABASE_URL` the API runs on an embedded PostgreSQL (PGlite) in `./data/pglite`, so there is
nothing else to install. The console can also seed demo data itself (**Integrations → Load demo
data**). For console development with hot reload, run `npm run dev:web` as well and open
http://localhost:5173.

### Connect real calls

1. Copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY` (the LLM judge), `APP_SECRET`, and the
   provider keys, or add the integrations from the console (**Integrations → Add integration**).
2. Point the provider's post-call webhook at the URL shown for the integration
   (`{PUBLIC_URL}/webhooks/{provider}/{integration id}`). Polling every 15 minutes also runs, so a
   missed webhook is picked up, and **Sync now** or **Backfill** (from a date) imports history.
3. Turn `DEMO_MODE=off` once real calls flow, and delete the demo data (or start from a fresh database).

See [docs/integrations.md](docs/integrations.md) for the provider settings, the CRM feed, uploads and
the audio model.

### Production

```bash
docker compose up --build          # PostgreSQL 16 + the app on :8787
```

or build and run directly: `npm run build && DATABASE_URL=postgres://… npm start`. Run extra workers
with `npm run worker` (they share the PostgreSQL job queue) and start the web process with
`RUN_WORKER=false` if you want them separate.

## Repository

| Path | What it holds |
| --- | --- |
| `packages/framework` | The framework as code: taxonomy, 62 metrics, gates, tool map, scenario paths, scoring maths, API types shared by server and console |
| `apps/api` | Fastify API, provider connectors, evaluation pipeline, Postgres job queue and scheduler, analytics, alerts, CRM attribution, recommendation engine |
| `apps/web` | React console (Mantine), 14 screens, served by the API in production |
| `docs/` | [Architecture](docs/architecture.md), [decisions](docs/decisions.md), [integrations](docs/integrations.md), [REST API](docs/api.md), [audio model contract](docs/audio-model.md) |

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev:api` / `npm run dev:web` | API (watch mode) / console with hot reload |
| `npm run build` | Bundles the API (`apps/api/dist`) and the console (`apps/web/dist`) |
| `npm start` / `npm run worker` | Production server (API + worker) / worker only |
| `npm run seed:demo` | Synthetic demo quarter through the real pipeline |
| `npm run typecheck` / `npm test` | All workspaces |

## What the tests cover

`npm test` runs without network or API keys: framework scoring maths; ElevenLabs and Retell payload
normalisation from SDK-shaped fixtures; webhook signature checks for both providers (valid, tampered,
stale, wrong key); the pipeline on fixture and synthetic calls; spoken-number grounding; and an
end-to-end HTTP suite on an in-memory database (signed webhook → queue → scored call, polling sync
against a stubbed provider, duplicate delivery, CRM CSV attribution, every console endpoint on demo
data, the recommendation lifecycle).

## Configuration

All settings are environment variables; `.env.example` lists them with defaults. Framework knobs
that the sales team owns (dimension weights, attribution windows, budget bands, review sample rate,
confidence threshold, retention) are stored in the database and edited from the console
(**Scoring model** and `PUT /api/settings`).
