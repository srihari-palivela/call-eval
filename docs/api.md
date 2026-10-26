# REST API

Base path `/api`. Every response is JSON. Response shapes are TypeScript types in
`packages/framework/src/api.ts`, shared by the API and the console.

When `API_TOKEN` is set, every `/api` route needs `Authorization: Bearer <token>`.
Webhooks under `/webhooks` are authenticated by the provider's signature instead.

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
| POST | `/api/calls/:id/reevaluate` | Queues the call for re-scoring |
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

## Governance

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/taxonomy/health` | `TaxonomyHealthDTO` |
| POST | `/api/taxonomy/clusters/run` | Queues a clustering run |
| POST | `/api/taxonomy/clusters/:id/propose` | `{ proposed: boolean }` |
| GET | `/api/alerts?status=open\|ack\|all&rule` | `AlertsDTO` |
| POST | `/api/alerts/:id/ack` | `{ acked: boolean }` |
| GET | `/api/review?status=open\|done&kind` | `ReviewItemDTO[]` |
| POST | `/api/review/:id` | `{ value?, gateConfirmed?, note? }` resolves an item; a tag value overrides the classifier |

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

## Webhooks

| Method | Path | Verified by |
| --- | --- | --- |
| POST | `/webhooks/elevenlabs/:integrationId` | `ElevenLabs-Signature: t=<unix s>,v0=<hex HMAC-SHA256(secret, "t.body")>`, 30-minute tolerance |
| POST | `/webhooks/retell/:integrationId` | `x-retell-signature: v=<unix ms>,d=<hex HMAC-SHA256(api key, body + ms)>`, 5-minute tolerance |

Both return `200` quickly and queue the work; the pipeline fetches the full call from the provider.
