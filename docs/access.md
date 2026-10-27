# Users and access

People sign in with an email and password. Each user has one role, and each role is a fixed set of
permissions; every API route names the permission it needs.

## Workspaces

An installation holds one or more workspaces, one per company. Every account belongs to one workspace, and
everything a workspace owns (calls, leads, settings, taxonomy, integrations, jobs) is isolated in the database
itself: each tenant table carries `workspace_id`, and PostgreSQL row-level security shows and accepts only the
current workspace's rows, so a query that forgets to filter still can't leak. The app works as a non-superuser
role (`calleval_app`) that those policies bind; only the job queue, the scheduler and sign-in work across
workspaces, through an explicit system handle. Ids built from provider ids (calls, agents) carry the workspace, so
two companies importing the same provider or demo data never collide.

- **One company (default, `SELF_SIGNUP=off`):** everything lives in the default workspace, as before.
- **Self-serve (`SELF_SIGNUP=on`):** anyone can sign up from the landing page (`/app/#signup`). Sign-up creates a
  workspace and its owner, starts the trial, and emails a verification link (`SMTP_URL`); the account can't sign in
  until the link is opened. Without SMTP, sign-up shows the link on screen (for trying an installation locally
  only). "Forgot your password?" emails a reset link. A sign-up with an email that already has an account says
  nothing new: an unverified account gets a fresh link, a verified one an email saying so. Sign-ups are limited
  to 10 an hour from one address, and reset and verification emails to 3 an hour per email.

## Getting started

With self-serve sign-up off, until the first user exists the app is **open**: anyone who can reach it is treated as an owner, as
before accounts existed, and the console shows a banner offering to create the first owner. Create it
in the console, or on a server from the command line before exposing the app:

```bash
calleval users create --email you@example.com --name "Your name"          # prompts for the password
echo "$PASSWORD" | calleval users create --email you@example.com --password-stdin
```

Once a user exists, every `/api` route needs a sign-in, a personal API token, or the `API_TOKEN`
environment token. With `API_TOKEN` set and no users yet, the app is not open: creating the first owner
in the console asks for that token.

Others join by **invitation** (Governance → Users and access → Invites): enter an email and a role and
copy the link to them. There is no email sending; links last 7 days and work once. A password-reset link
(made by an admin, or with `calleval users reset --email …`) lasts 24 hours and signs the person out of
their other sessions once used.

## Roles

| Role | Can do |
| --- | --- |
| Owner | Everything, including making and changing owners |
| Admin | Everything except making or changing owners |
| QA lead | Dashboards, calls, review and labels, uploads, recommendations, attention items, alerts, clusters, re-scoring, taxonomy drafts, campaigns (read), approving improvement cycles, the co-pilot |
| Sales manager | Dashboards, calls, business setup, leads and funnels, lead finders, campaigns including starting them, the co-pilot |
| Reviewer | Dashboards, calls, review and labels |
| Viewer | Dashboards only: no transcripts, recordings, call summaries or contact details |

Permissions marked risky are the ones that place calls, change the live agent, spend money or change how
every call is scored: activating a taxonomy, changing settings, managing integrations, using lead finders,
starting campaigns, promoting prompts, using the co-pilot and managing users. The full table is in
`apps/api/calleval/auth/roles.py`, and the console shows it under Users and access → Roles.

Rules that hold whatever the route:

- Nobody gives a role, an invitation or an API token more than their own role allows, and only owners
  make or change owners.
- The last active owner can't be demoted or disabled.
- Disabling a user or changing their role signs them out everywhere; their API tokens stop working
  while they are disabled, and a token never does more than its maker can do now.

## Sessions and tokens

- **Sessions**: an HTTP-only, `SameSite=Lax` cookie (`Secure` when `PUBLIC_URL` is https), valid for 30
  days and ended after 7 idle days, on sign-out, on a password change (other sessions), or when an admin
  signs the user out everywhere. Only a hash of the cookie is stored.
- **API tokens** (Your account → API tokens): for scripts and integrations, sent as
  `Authorization: Bearer ce_…`. Each has a name, a role within yours, and an expiry (30, 90 or 365 days, or
  none). The token is shown once; only its hash is stored. Tokens can't create tokens.
- **`API_TOKEN`** (environment): acts as an owner, for automation and as a break-glass key. Keep it long
  and random, or leave it empty.

Changes made with a session cookie must carry the `X-CallEval-Client: console` header, which a cross-site
form or link can't add (CSRF protection); the console sends it. Requests with a bearer token don't need it.

## Sign-in protection

Passwords have 12 to 256 characters and are hashed with Argon2id. After 8 failed sign-ins for an email,
or 30 from one address, within 15 minutes, sign-in answers 429 until the window passes. An unknown email
takes as long to refuse as a wrong password, and both get the same message.

The client address comes from the connection, or from `X-Forwarded-For` when the request comes through a
proxy listed in `FORWARDED_ALLOW_IPS` (default `127.0.0.1`). Behind a load balancer, set it to the
balancer's address so limits and the audit log see real clients.

## Audit log

Every change through the API (any request other than GET) is recorded with who made it, the action (such
as `PUT /api/settings` or `POST /api/campaigns/{id}/start`), the target path, the outcome (including
refusals) and the client address, as are sign-ins, failed sign-ins, sign-outs and accepted invitations.
Request bodies are not recorded. Admins and owners read it under Users and access → Audit log.

People's names also go where the work is recorded: review labels (so reviewer agreement compares real
reviewers), lead history, taxonomy activations, improvement-cycle decisions and campaign improvement
requests.
