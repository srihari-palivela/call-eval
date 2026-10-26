# Call Evaluation Console

A React front end for the AI Call Evaluation Framework: 14 screens covering recommendations, quality, call drill-down, traces, audio uploads, the sales funnel, fix-first priorities, the review queue, taxonomy health, alerts, the scoring model and provider integrations.

Every figure comes from the Call Evaluation API (`apps/api`). Definitions (personas, scenarios, metrics, gates, scoring maths) come from `@calleval/framework`.

## Stack

- React 18 + TypeScript, built with Vite 5
- [Mantine 7](https://mantine.dev): the design system (core, dropzone, notifications)
- [Recharts](https://recharts.org) for charts
- [Tabler Icons](https://tabler.io/icons)

## Run it

```bash
npm install
npm run dev        # http://localhost:5173, proxies /api and /webhooks to API_URL (default http://localhost:8787)
npm run build      # outputs dist/ (assets/app.js + assets/app.css)
npm run typecheck
```

## Layout

| Path | What it holds |
| --- | --- |
| `src/api.ts` | Typed fetch helpers, `useApi` (loading, error, reload) and `usePoll`. A bearer token in `localStorage['calleval.token']` is sent when present |
| `src/store.tsx` | App state: page and params (hash routing, e.g. `#calls?id=…`), filters (range, direction, path, prompt version, agent), `/api/meta`, open-alert count, attention owners and statuses (saved through the API) |
| `src/theme.ts` | Mantine theme, the light/dark chart palette `usePal()`, score bands |
| `src/components/` | App shell (navigation, data-mode and judge badges) and shared UI: stat cards, bars, band badges, filter selects, loading/error/empty states, roll-up helpers |
| `src/pages/` | One file per screen |

The Scoring model screen keeps two static presets, the annotated calls from the framework document, as a sandbox; it also offers the most recent Excellent call from the API.

## Scoring

CQS = min(Σ w·S ÷ Σ w, G), where G = 40 if any compliance gate failed. Dimension weights default to Understanding 20, Body 15, Conclusion 15, Tool use 15, Emotion and realism 15, Introduction 10, Voice and timing 10, and come from the API's settings. Metrics with no opportunity in a call are dropped, not scored as 100; Re-ask and Wrong path count twice.
