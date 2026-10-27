# Growth: CRM, funnels, lead finders, campaigns and self-improvement

Four optional modules turn the evaluation platform into a loop that finds leads, calls them, and
improves the agent from what the calls show. All of them are configured in **Business setup**, which
the co-pilot can draft.

```
Business setup ──► ideal customer profile ──► Apollo.io search ──► CRM leads (consent unknown)
      │                                           │ enrich (credit cap)          │ consent recorded
      │ goals, calling hours                      ▼                              ▼
      └──────────────────────────────────► campaigns ── batch calls (champion | challenger) ──► provider
                                                ▲                                                │
             promote / roll back ◄── verify ◄── live calls scored by the pipeline ◄──────────────┘
                                                ▲
      self-improvement: findings + lessons ─► propose edits ─► probe on simulated callers ─► compose challenger
```

## Business setup

`GET/PUT /api/business`, stored in `app_setting` (`business`).

| Part | Holds | Used by |
| --- | --- | --- |
| Company | Name, website, industry, offer, markets, languages | Context for proposals |
| Ideal customer profile | Titles (and excluded titles), seniority, industries, person and company locations, company size, keywords, expected persona | Apollo search filters; the expected persona is set on found leads |
| Goals | Meetings a week, meeting-rate and CQS targets, new leads a week, monthly call budget, focus personas and scenarios | Progress tiles; the improvement loop ranks findings in focus personas and scenarios first |
| Calling rules | Time zone, days, hours, attempts per lead, whether unknown consent may be called | Campaign eligibility and the calling window |

The **Modules** card switches `settings.features`: `crm`, `campaigns` (which turns the CRM on), and
`improvement` (`off`, `propose`, `auto`).

## Built-in CRM

A lead has contact details (phone normalised to E.164), company and title, a funnel and its stage in
that funnel, an owner, consent (opted in, existing customer, unknown, denied), tags, notes, enrichment
data and its call history. Every change is an event on the lead.

- **Adding leads**: the console, CSV import, the API, Apollo. A lead with the same Apollo id, email or
  phone is not duplicated: its empty fields are filled and filled ones kept.
- **Outcomes**: moving a lead to a stage whose milestone is an outcome (meeting booked, meeting attended,
  site visit, reservation, sale, or a partner outcome) writes a lead outcome (`source crm`) under the
  milestone's name, so attribution credits the call before it and Funnel by persona counts it, exactly
  as with Treppan or a CSV feed.
- **Calls update leads**: when a call with the lead's id is scored, the lead's attempt count and last
  call update once per call, and it moves forward to its funnel's stage for the furthest milestone the
  call reached: meeting booked (the call secured a meeting), else qualified (the pipeline judged the
  lead qualified), else contacted; a funnel without a stage for one falls back to the next. Leads never
  move backwards, nor out of a won or lost stage. A do-not-contact request on a call moves the lead to
  its funnel's do-not-contact stage, consent denied, and no campaign calls it again.

## Lead funnels

**Leads → Funnels**. A funnel is the ordered list of stages a lead moves through, in the team's own
words ("Demo booked", "Proposal sent", "Closed won"). Each stage has:

| Field | Meaning |
| --- | --- |
| Milestone | The framework milestone it stands for, at most once per funnel: new, contacted, qualified, meeting booked, meeting attended, site visit, reservation, sale, partner registered, partner call held, partner's first lead, partner deal, lost, do not contact. Calls move leads to contacted, qualified and meeting booked; outcome milestones are credited to calls; a stage without a milestone is moved by hand. |
| Kind | Open, won or lost (sale and partner deal are won; lost and do-not-contact are lost) |
| Callable | Whether campaigns may call leads in it (only open stages; usually not stages a person is handling, such as a proposal) |

Every funnel keeps a do-not-contact stage, and its first stage is open. The default funnel starts with
the stages the CRM had before funnels, so existing leads keep theirs. New leads go to the first other
funnel whose rules match their source, expected persona or persona path, else the default; a lead can
be moved to another funnel, keeping its milestone where the new funnel has one. A CSV or API stage can
be a stage key or a milestone ("meeting_booked" lands on "Demo booked").

Removing a stage that still holds leads needs a destination for them (`remap`); deleting a funnel with
leads moves them to another, by milestone. The **report** follows the leads created in the last 30 or
90 days (or all): how many reached each stage or a later one, the conversion from the previous stage,
the median days to reach it, where leads were lost, the win rate, and leads and wins by source.

Templates: property buyers (the default stages), B2B demo pipeline, partners and brokers.

## Co-pilot

With a Claude key (the judge's), the co-pilot drafts; a person applies.

- **Business setup → Co-pilot**: describe the business, or give its website, and it drafts the company,
  the ideal customer profile in Apollo's vocabulary, goals and calling rules. The website is read with
  Claude's web fetch tool, limited to that site, so the server never fetches arbitrary addresses
  itself. Each section is shown as from → to and applied on its own; a field that fails the profile's
  checks is left as it was, with a note. Goals nobody stated stay unset.
- **Funnels → Co-pilot**: describe how leads become customers, and it drafts a funnel (or a redesign of
  one, keeping stage keys so its leads keep their place), repaired for small slips (duplicate keys or
  milestones, the do-not-contact stage) and checked like a manual edit.
- **Taxonomy → Co-pilot**: see [taxonomy.md](taxonomy.md#the-co-pilot).

## Lead finders: Apollo.io

Search is free and returns no contact details; enrichment costs credits and fills emails, names,
titles and locations, and phone numbers when Apollo can deliver them to a public HTTPS webhook. Details
in [integrations.md](integrations.md#lead-finder-apolloio).

## Campaigns

A campaign calls eligible leads through one ElevenLabs or Retell agent, in batches, inside the calling
hours, up to a daily cap, with at most one batch in flight.

**Eligible** means: a valid E.164 number, not DNC, consent opted in or existing customer (or unknown
when allowed), attempts left, in a callable stage of its funnel, not already waiting on a call, and
matching the campaign's funnel, stage, source and tag filters.

Each recipient carries dynamic variables the pipeline uses: `lead_id`, `campaign_id`, `arm`,
`prompt_version` (the arm's label, so the version report separates them), `customer_name`,
`known_facts` and `objective`. With a live challenger, a share of each batch (20% by default) gets the
challenger prompt as a per-call override: ElevenLabs `conversation_config_override.agent.prompt.prompt`
(enable prompt overrides in the agent's security settings) or Retell `agent_override`. A provider
rejection pauses the campaign with the error shown, rather than retrying a bad batch.

## Self-improvement

The loop follows the method of Google's Harness² (Propose → Probe → Compose, with a library of lessons)
on this platform's own evaluation, then adds a live test.

1. **Reference**: the champion prompt's recent campaign calls (median CQS, metric means, gate rate,
   meeting rate) and the recommendation findings for its agent, focus personas and scenarios first.
2. **Propose**: general edits (weaknesses across calls) and domain edits (a cell, persona or scenario),
   each an add or replace in the prompt with its target metrics and rationale. With a Claude key one
   structured request writes them from the champion prompt, the findings with quoted evidence, and the
   lessons library (what worked and what didn't, with the measured effect). Without a key, playbook
   rules for the top findings are used.
3. **Probe** (needs a Claude key): real calls that failed the target metrics, plus controls, become caller
   briefs; Claude plays the caller and the agent (champion prompt, then each candidate) in text, tools
   answer from the real call's results, and every transcript is scored by this pipeline. Matched pairs
   give each candidate its effect on the target metrics, CQS and gates.
4. **Compose**: candidates that helped and added no gate failures are applied together, the result is
   probed once more against the champion, and if it still wins it becomes the challenger.
5. **Live test**: the challenger runs on its share of campaign calls. Once both arms have enough scored
   calls (30 by default), the bootstrap interval on CQS and the gate-failure rates decide: **promote**
   when the interval is above zero and gates did not rise, **roll back** when the interval is below zero
   or gates rose, **reject** when the call limit passes without a verdict.
6. **Lessons**: every edit's outcome (adopted, rejected, regressed) is stored with its effect, and the
   next proposal reads them.

**Who decides.** In *propose* mode a person approves each challenger before it takes live calls and
each promotion. In *auto* mode verified wins are promoted (the provider agent's prompt is updated:
ElevenLabs agent prompt, or Retell's LLM general prompt). An edit that touches compliance rules (the
G1–G9 topics) always waits for a person. A campaign's own mode can only be stricter than the global one.

**Cost.** A cycle at the defaults simulates about 24 conversations (4 callers × the champion, 4
candidates and the composed prompt) of up to 14 turns at low effort, capped by `IMPROVE_TOKEN_BUDGET`
(1.5 million tokens) and recorded on the cycle. Set `CLAUDE_SIM_MODEL` to run simulations on another
model; `IMPROVE_PROBE_TASKS`, `IMPROVE_CANDIDATES_GENERAL`, `IMPROVE_CANDIDATES_DOMAIN` and
`IMPROVE_MAX_TURNS` size the probe.

## Before going live

- Confirm each provider applies the per-call prompt override on a test call (the challenger's
  `prompt_version` label appears on its calls, and its transcript follows the challenger prompt). If
  ElevenLabs ignores the override because the agent does not allow it, both arms run the same prompt and
  verification finds no difference.
- Record consent on leads where you have it; keep **Call leads with unknown consent** off unless your
  local rules (do-not-call registers, telemarketing consent) allow it.
- Start in *propose* mode and review the first cycles' probes and verdicts before switching to *auto*.
