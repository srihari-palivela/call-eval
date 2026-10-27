# Go-live runbook

The order to switch a self-serve installation on: infrastructure, keys, the owner account, `calleval doctor`,
a smoke test, then sign-up and billing. Each step says how to check it.

## 1. Infrastructure

- PostgreSQL 15 or later (`DATABASE_URL`), with daily backups and point-in-time recovery, and a restore tested once.
  The app's login must be able to `GRANT calleval_app TO` itself (a superuser, or a role with CREATEROLE); migration
  7 creates that non-superuser role, which row-level security binds.
- One or more app containers (`docker compose up --build`, or the image behind a load balancer) with a persistent
  volume at `/data` for uploaded recordings.
- HTTPS in front, and `PUBLIC_URL=https://…` (session cookies are then marked secure; email links and webhook
  addresses use it). Behind a load balancer, set `FORWARDED_ALLOW_IPS` to its address.
- The image serves the landing site at `/`, the console at `/app/` and the API at `/api`.

## 2. Keys and settings (`.env`)

| Setting | Value |
| --- | --- |
| `APP_SECRET` | 32+ random characters; never change it afterwards (provider keys are encrypted with it) |
| `ANTHROPIC_API_KEY` | The Claude key (judge and co-pilot). `CLAUDE_MODEL=claude-sonnet-5-5` matches the published prices |
| `DEMO_MODE` | `off` |
| `SMTP_URL`, `EMAIL_FROM` | A transactional email service over SMTP, with SPF, DKIM and DMARC set for the sender domain |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | From the Stripe dashboard (below) |
| `SELF_SIGNUP`, `BILLING` | Leave `off` until step 5 |
| `API_TOKEN` | Optional owner-level key for automation; 32+ characters |

**Stripe.** In the dashboard: Developers → Webhooks → add the endpoint `{PUBLIC_URL}/webhooks/stripe` with the
events `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`,
`invoice.created`, `invoice.paid`, `invoice.payment_succeeded`, `invoice.payment_failed` and
`payment_intent.succeeded`; copy its signing secret into `STRIPE_WEBHOOK_SECRET`. Settings → Billing → Customer
portal: turn it on (plan changes, payment methods, invoices). Turn on Stripe Tax for UAE VAT. No products or prices
need creating: checkout sends the plan prices itself.

## 3. The operator account

Before the app is reachable from outside:

```bash
docker compose exec app calleval users create --email you@yourcompany.com --name "Your name"
```

This owner belongs to the default workspace, which is the operator's own (its plan is Enterprise and unlimited).

## 4. Checks

```bash
docker compose exec app calleval doctor --email you@yourcompany.com
```

It checks the migrations, the app role and row-level security, the settings above, the Claude key, sends a test
email, checks the Stripe key, and tests the connection of every voice integration in every workspace. Fix every
`FAIL`; read every `WARN`. Exit code 0 means ready.

Then, on the real accounts (go-live checklist items 1–5):

1. Connect ElevenLabs and Retell under Integrations; **Test connection** lists the agents.
2. Make one real call on each; it is scored within a minute (the call drill-down shows the transcript, scores and trace).
3. Connect Apollo; run a search of 5 people and enrich 1 with a credit cap of 2.
4. With Claude on, ask each co-pilot once (Business setup, Taxonomy, Funnels) and check the drafts.
5. Run a one-lead test campaign to your own phone number: the call arrives inside the calling window and is scored.

## 5. Switch on self-serve

Set `SELF_SIGNUP=on` and `BILLING=on`, restart, and run `calleval doctor` again. Then, in a private browser window:

1. Open the landing page, choose a plan, sign up with a fresh email address, open the verification email.
2. The setup checklist appears; connect a provider or load demo data; the first call is scored.
3. Billing: buy the Starter plan with Stripe's test card in test mode (or a real card and refund it); the plan turns
   active within seconds of the webhook. Top up $50 on a pay-as-you-go workspace; the credit appears.
4. Forgotten password from the sign-in page: the email arrives and the new password works.

## 6. On launch day

- Watch the logs for `request failed`, `job failed`, `scheduler tick failed` and Stripe webhook errors.
- The audit log (Users and access → Audit log) shows sign-ins and every change per workspace.
- Rolling back: `SELF_SIGNUP=off` stops new sign-ups at once; existing workspaces keep working. `BILLING=off`
  lifts every limit.
