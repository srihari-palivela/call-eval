# Integrations

Calls come in three ways: provider webhooks (fastest), provider polling (catches anything a webhook
missed, and backfills history), and uploaded recordings. All three end in the same canonical call
record and the same pipeline. CRM outcomes come from the Treppan adapter, a CSV upload or the JSON
API.

Credentials added in the console are encrypted at rest (AES-256-GCM, key derived from `APP_SECRET`)
and never returned by the API. Integrations can also be created from environment variables at start
(`ELEVENLABS_*`, `RETELL_*`, `TREPPAN_*`); they are refreshed on every restart.

## ElevenLabs Agents Platform

| Setting | Where |
| --- | --- |
| API key | ElevenLabs → Developers → API keys. Needs read access to Agents/Conversational AI (and Speech-to-Text if you upload recordings). |
| Agent IDs | Agent → settings. Leave empty to import every agent on the account. |
| Webhook | Agents Platform → Settings → **Post-call webhook**: URL from the console, event *Transcription*. Copy the signing secret into the integration's *Webhook secret*. |

What is pulled:

- `GET /v1/convai/conversations?agent_id&call_start_after_unix&cursor` to list finished conversations;
  `GET /v1/convai/conversations/{id}` for transcript, tool calls and results, turn latency metrics,
  termination reason, phone metadata, analysis and dynamic variables.
- `GET /v1/convai/agents/{id}` for the system prompt, first message and version, so prompt versions
  are tracked and recommendations can quote the prompt they change.
- `GET /v1/convai/conversations/{id}/audio` only when the audio model is configured, and for the
  console's player (proxied, never stored).

Webhooks are verified with the `ElevenLabs-Signature` header (`t=<unix>,v0=<HMAC-SHA256(secret,
"t.body")>`), rejected when older than 30 minutes, and acknowledged immediately; the evaluation runs
from the queue. `post_call_audio` and `call_initiation_failure` events are acknowledged and ignored.

Pass these as **dynamic variables** when starting a call so the platform can join and version calls:

| Variable | Used for |
| --- | --- |
| `lead_id` | CRM join (falls back to the conversation's `user_id`) |
| `prompt_version` | Version report labels (otherwise the agent's `version_id`, then a hash of the prompt) |
| `customer_name`, `known_facts`, `recent_history`, `objective` | Context record: known caller, returning lead, callback objective (otherwise inferred from the transcript) |
| `direction` | Inbound or outbound when the call has no phone metadata (web calls) |

## Retell AI

| Setting | Where |
| --- | --- |
| API key | Retell dashboard → API keys. The same key signs webhooks. |
| Agent IDs | Agent → settings. Leave empty to import every agent. |
| Webhook | Agent → **Webhook URL** (or the account-level webhook): URL from the console. Events `call_analyzed` (preferred) and `call_ended` are used. |

What is pulled:

- `POST /v3/list-calls` (filter by agent and start time, paginated) and `GET /v2/get-call/{id}` for the
  word-timed transcript, `transcript_with_tool_calls`, latency percentiles, disconnection reason,
  recording URLs (multi-channel preferred), analysis and dynamic variables.
- `GET /get-agent/{id}` and, for Retell LLM agents, `GET /get-retell-llm/{llm_id}` for the general
  prompt, state prompts and begin message.

Webhooks are verified with `x-retell-signature` (`v=<ms>,d=<HMAC-SHA256(api key, body + ms)>`) and a
five-minute tolerance. Retell built-ins map onto the framework's tool names (`transfer_call` →
`transfer_to_number`, `end_call` → `end_call`); extra aliases can be set per integration
(`toolAliases` on `POST`/`PATCH /api/integrations`, e.g. `{"book_viewing": "schedule_meeting"}`). The human advisor's side of a transferred call (`transfer_target`) is left
out of scoring.

Set `lead_id` and `prompt_version` in `retell_llm_dynamic_variables` or the call `metadata`.

> The request and payload shapes follow the official SDKs' wire types (`@elevenlabs/elevenlabs-js`,
> `retell-sdk`). The signature header names come from the providers' webhook documentation; confirm
> them with **Test connection** and a test call before relying on webhooks alone. Polling keeps working
> either way.

## Uploaded recordings

**Audio logs → Upload** takes a WAV/MP3/M4A of a call that never went through a provider (a pilot,
another dialler). The file is transcribed with ElevenLabs Speech-to-Text (`scribe_v2`): stereo files
per channel (choose which channel is the agent), mono files with diarisation (the first speaker is
taken as the agent). The uploader must confirm the recording notice covers transcript, classifier and
audio analysis. Set `ELEVENLABS_STT_API_KEY` (or `ELEVENLABS_API_KEY`).

## CRM outcomes (Treppan)

Outcomes are lead stages: `meeting_booked`, `meeting_attended`, `site_visit`, `reservation`, `sale`,
`broker_registered`, `bdm_call_held`, `broker_first_lead`, `broker_deal` (common synonyms such as
`EOI`, `SPA signed`, `closed_won` are mapped). Each is credited to the most recent call for the same
`lead_id` before it, within 30 days (90 for reservations, sales and broker deals; both editable).

Three ways in:

- **Treppan adapter.** Treppan's export API is not public, so the adapter calls
  `GET {TREPPAN_API_URL}/outcomes?since=<ISO>` with `Authorization: Bearer {TREPPAN_API_KEY}` and expects
  `[{ id, lead_id, stage, occurred_at, project, value_aed }]` (or `{ items: [...] }`). Put a small
  mapping service in front of Treppan if its export differs. Synced daily.
- **CSV**: `POST /api/crm/outcomes/csv` with columns `lead_id,stage,occurred_at,project,value_aed`.
- **JSON**: `POST /api/crm/outcomes` with an array of the same objects.

Re-sending an outcome updates it (keyed on `id`, or on lead, stage and time).

## Audio model (optional)

Emotion trajectory, naturalness (MOS), prosody and delivery-tag metrics need audio models. Set
`AUDIO_MODEL_URL` to a service implementing [the audio model contract](audio-model.md). Without it,
the Emotion and realism dimension uses transcript-side measures where a recording exists, and drops
out of the score where there is none.

## Claude (LLM judge)

With `ANTHROPIC_API_KEY` set, the classifier, judged metrics, judged gates, path checkpoints,
recommendation tailoring and taxonomy clustering run on Claude (`CLAUDE_MODEL`, default
`claude-opus-5-5`) with structured outputs. The judge's system prompt and each transcript are
cached. Requests opt in to server-side refusal fallbacks by default (`CLAUDE_FALLBACKS=off` turns
that off). Without a key, or with `LLM_JUDGE=off`, a deterministic heuristic judge runs instead and the
console labels the data accordingly. Demo calls always use the heuristic judge.
