# Defining the taxonomy

Every call gets one **persona** (who the caller is), one primary **scenario** (the journey that decided
the outcome, plus at most one secondary) and any number of **events** (moments inside a scenario). The
quality matrix, alerts, recommendations and the self-improvement loop all report by persona × scenario,
so the taxonomy decides what a team can see. It starts as the framework's v1.0 (an off-plan real-estate
developer: investors, brokers and non-target callers) and can be redefined for any business.

Edit it under **Governance → Taxonomy**, by hand or with the co-pilot.

## Versions and drafts

The taxonomy is versioned, and a version is never edited in place: calls keep the definitions they
were classified under.

1. **Edit in a draft.** A draft starts as a copy of the active version (v1.0 → v1.1) or from a
   template (a new major version, v2.0). There is one draft at a time.
2. **Change it.** Add, edit or retire personas, scenarios and events; edit the domain sentence. Every
   save checks the whole draft; the changes against the active version are listed, including how many
   recent calls a retired entry still has.
3. **Activate.** The draft becomes the active version and the previous one is retired. New calls are
   classified with it at once (every process picks it up within seconds). Optionally, re-score the
   last 7, 30 or 90 days of calls under it (up to 5,000 calls, newest first, at low priority; with a
   Claude key this spends judge tokens).

A retired entry keeps its name, so older calls still read correctly; the matrix and filters show the
active version's entries. Ids are never reused: a new persona after P11 is P12 even if P10 was retired.

## What an entry holds

| Kind | Fields |
| --- | --- |
| Persona | Name; **path** (Investor = the buyer path: discovery, qualification and meeting metrics apply; Broker = a partner or intermediary: registration checks apply and buyer discovery must not be asked; Non-target = routed, never pitched); identifying signals; what to watch for; the one check reported for it; behaves like; keywords |
| Scenario | Name and short name; trigger; expected path; success; behaves like; keywords; **checkpoints** |
| Event | Label; group (Objections feed the lost-reason report; Caller behaviour; Agent or system; Outcome moments); keywords |
| Domain | One or two sentences, "who, selling what to whom; callers are …". The classifier and judge read it first. |

P0 Unclassified, the facets (direction, history, intent, budget and timeline bands, language, broker
registration, lead source) and the events code detects (tool failure, transfer unavailable, message
fallback to email, time limit, gate failure, asked if AI, do-not-contact request, interruption burst)
are part of every version; only the events' labels can change. Metrics, gates and weights are the
scoring model, not the taxonomy.

**Checkpoints** are the scenario's expected path, 2–5 steps in order; path adherence scores the share a
call reaches in order, and the first one missed is its deviation point. Each is detected by:

- `judge`: the meaning of the words (give a hint a reviewer could check);
- `tool`: a successful call to one of the named tools (the editor lists the tools seen on recent calls);
- `rule`: a code detector: persona resolved, discovery, filler before transfer, transfer outcome, short
  call, change read back, question after sending, no further pitch.

## Behaves like: keeping the framework's rules

Some rules in the pipeline belong to specific framework entries. A user-defined entry gets them by
naming that entry in **behaves like** (`basedOn`):

| Framework entry | What an entry based on it gets |
| --- | --- |
| S12 Failed call | Tagged by code for voicemail, silence and dropped lines |
| S4 Callback, S5 Live transfer, S6 Meeting change | Tagged from the callback, transfer and meeting tools |
| S7 Broker onboarding | Tagged from the partner-registration tool |
| S9 Returning follow-up | Proposed when the call has an objective or prior history |
| S1, S2, S7, S8 | Discovery coverage is scored on these journeys |
| S10, S12 | No next step expected; S12 also skips most body metrics |
| S11 Out of scope | Feeds the clusters of calls the taxonomy doesn't describe |
| P7, P8 brokers | Tagged from the registration tool (overseas or local) |
| P11 Other | Counts in the Other share watched for taxonomy drift |
| P1–P11 | The per-persona check in the cell view, and the persona's built-in phrases for the classifier without a Claude key |

Without an entry based on, say, S12, failed calls are left to the classifier. Inherit only where the
meaning matches: a persona based on P1 is also recognised by P1's phrases (family, children, schools)
when no Claude key is set.

## Without a Claude key

The heuristic classifier recognises an entry by its **keywords** (short caller phrases), plus the
built-in phrases of the framework entry it is based on. Keywords also reach the Claude classifier as
typical phrases. Judge checkpoints the heuristic judge has no pattern for are left out of path
adherence for that call rather than counted as missed.

## The co-pilot

With a Claude key, the co-pilot proposes changes; nothing changes until a person applies them.

- **Design from the business profile**: a taxonomy for the business described in Business setup.
- **Edit with an instruction**: "split brokers into agencies and freelancers", "add a scenario for
  warranty claims".
- **Review against recent calls**: reads the last 30 days of call summaries (unclear ones first), the
  unnamed clusters, call counts per entry and the Unclassified and Other share, and proposes only what
  that evidence supports.

Each proposal is a list of operations (add, update, retire), each with a reason. Before they are shown,
each operation is checked as if applied alone: an operation that would fail is flagged with why, and
changes to entries that don't exist are dropped. Applying the chosen operations writes them to the
draft (creating it if needed); activation is still a separate step.

Two templates are available with or without a key: the framework default (off-plan real estate) and
B2B sales (decision makers, evaluators, partners and existing customers; discovery to demo, pricing,
partner enquiries).
