# Billing and calling compliance

## Plans

Billing is on with `BILLING=on` (and Stripe keys); off, nothing is counted or limited, as a self-hosted
installation for one company needs. The unit is a **scored call**: a call scored once, however often it is
re-scored. Voice minutes stay on the customer's ElevenLabs or Retell account and Apollo credits on their Apollo
account.

| Plan | Price | Scored calls | Extra calls | Editor seats | Co-pilot drafts | Improvement cycles | Features |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Pay as you go | $0 + prepaid credit | — | $0.20 each from credit | 2 | $1 each | $25 each | Scoring, dashboards, recommendations, review queue, taxonomy |
| Starter | $149 / month | 1,000 | $0.15 | 3 | 20 | $25 each | + co-pilot, alerts, API tokens |
| Growth | $499 / month | 3,500 | $0.13 | 10 | 100 | 4 | + CRM and funnels, lead finders, campaigns, self-improvement |
| Scale | $1,499 / month | 12,000 | $0.11 | 25 | 300 | 15 | + audit-log export, data region, priority support |
| Enterprise | Annual contract | Unlimited | — | Unlimited | Unlimited | Unlimited | Everything; dedicated installation |

The catalogue is `apps/api/calleval/billing/plans.py`. Annual plans bill ten months for twelve. Viewers never take
a seat. A **trial** (new self-serve workspaces) is Growth for `TRIAL_DAYS` (14) with 250 scored calls, 10 co-pilot
drafts and 1 improvement cycle, no card; a plan chosen on the landing page applies when it is bought.

## What happens at the limits

- **Scoring** pauses, never drops: a call that can't be scored is stored with status `waiting` and scored as soon as
  credit or the plan allows (after a top-up, a plan change or a new period). It pauses when a trial has ended
  without a plan, a workspace is cancelled, pay-as-you-go credit is below $0.20, or extra calls would pass the
  workspace's spend cap.
- **Features** a plan lacks answer 402 with the plan that includes them; the console disables those buttons.
- **Seats**: inviting an editor past the plan's seats answers 402.
- **Co-pilot drafts and improvement cycles** beyond the plan's allowance are paid from credit, or refused without it.

## Stripe

- **Plans**: Stripe Checkout in subscription mode, with the price sent inline (no products to create). A plan change is
  a new Checkout; the previous subscription is cancelled with proration. Choosing pay-as-you-go switches at once and
  ends any subscription at the period end.
- **Credit**: top-ups of $50, $200 or $500 through Checkout, saving the card for **auto-recharge** (when credit falls
  below the threshold, an off-session charge, at most hourly).
- **Extra calls** on a plan are added to the renewal invoice when Stripe creates it (`invoice.created` for a
  subscription cycle), once per period.
- **The customer portal** handles cards, invoices and cancellation.
- **Webhooks** (`/webhooks/stripe`) are verified by signature and processed once per event id.

Not yet run against a live Stripe account: the renewal-invoice timing and off-session auto-recharge follow Stripe's
documentation (go-live checklist items 10–11).

## Calling compliance

Campaigns call a lead only when every rule allows it, and **Governance → Calling compliance** lists the rules, the
do-not-call list and the issues to fix before calling.

| Country (prefix) | Calling hours | Retries while unanswered | After a refusal | Consent | AI disclosure | Registry | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| United Arab Emirates (+971) | 9:00–18:00 Dubai time | Once a day, twice a week | Never again | Any | — | UAE Do Not Call Registry (TDRA) | Cabinet Resolution 56 of 2024 |
| United States and Canada (+1) | 8:00–21:00 in the lead's time zone | — | Never again | Prior express consent | The agent says it is an AI | National Do Not Call Registry | TCPA 47 CFR 64.1200(c)(1); FCC ruling, February 2024 |

- The business's calling hours apply too, so the effective window is the narrower of the two. Other countries
  follow the business's hours and attempt limit.
- **Refusals**: a call scored as "not interested" (a scenario based on S10) or carrying a do-not-contact request
  marks the lead as refused and moves it to its funnel's lost stage; refused leads are never called again.
- **Do-not-call list**: paste numbers or upload a CSV (scrubbed numbers from the national registries); listed numbers
  are never called.
- **US leads** need recorded consent (opted in or existing customer) and a time zone; each recipient gets an
  `ai_disclosure` dynamic variable for the agent's opening line.
- Leads held back show why (refused, on the list, next call allowed at…, consent, time zone).

These rules implement the published texts as summarised in the sources; they are not legal advice. UAE
telemarketing also needs TDRA approval and local numbers on the company's licence.
