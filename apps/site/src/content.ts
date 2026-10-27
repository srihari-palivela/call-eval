// The words on the page. Scenes are the scroll story, in order; each ends on a claim the product can prove.

import type { PlanId } from './site';

export type Scene = { id: string; eyebrow: string; claim: string; body: string };

export const SCENES: Scene[] = [
  {
    id: 'calls',
    eyebrow: 'A day of calls',
    claim: 'Your agent made 1,284 calls today. Which ones lost you a sale?',
    body: 'Each light is one call, coloured by its quality score. Most went well. A few did not, and nobody has listened to them.',
  },
  {
    id: 'one-call',
    eyebrow: 'One call',
    claim: 'Every word, every pause, every tool call.',
    body: 'Open any call and read it turn by turn: what was said, how long the agent took to answer, and every tool it used.',
  },
  {
    id: 'scored',
    eyebrow: 'Scored like your best reviewer',
    claim: '62 metrics, 9 compliance gates, the evidence quoted.',
    body: 'Introduction, body and conclusion are scored on their own. Break a compliance rule and the call is capped at 40 and sent to a person.',
  },
  {
    id: 'patterns',
    eyebrow: 'Patterns, not anecdotes',
    claim: 'See which callers and journeys go wrong.',
    body: 'Thousands of calls fold into one grid of caller types by journeys. The weakest cell rises to the top, with the calls behind it.',
  },
  {
    id: 'fixes',
    eyebrow: 'Fixes, not dashboards',
    claim: 'The change to make, and the calls that prove it.',
    body: 'Each recommendation names the prompt line to change, the metric it should move and the calls that show the problem.',
  },
  {
    id: 'safely',
    eyebrow: 'It gets better, safely',
    claim: 'Proven on live calls before it ships.',
    body: 'A challenger prompt takes a share of live calls. It is promoted only when the gain is clear, and only when a person agrees.',
  },
  {
    id: 'leads',
    eyebrow: 'From lead to meeting',
    claim: 'Find leads, call them within the rules, book meetings.',
    body: 'Leads from Apollo.io move through your own funnel. Campaigns call inside permitted hours only, never after a no, never a number on the do-not-call list.',
  },
  {
    id: 'setup',
    eyebrow: 'Set up in an afternoon',
    claim: 'The co-pilot drafts it. You approve it.',
    body: 'Describe your business in two lines. The co-pilot drafts your profile, the caller types and journeys to score, and your funnel.',
  },
  {
    id: 'start',
    eyebrow: 'Start',
    claim: 'Connect a voice platform and get your first scores in minutes.',
    body: 'Works with ElevenLabs and Retell AI, or upload recordings. Your voice minutes stay on your own account; we score every call.',
  },
];

export const PROOF = [
  { title: 'Roles and an audit log', body: 'Six roles decide who can see transcripts, start campaigns or change the scoring. Every change is recorded.' },
  { title: 'Retention you set', body: 'Transcripts and recordings are removed on your schedule. Scores and outcomes stay.' },
  { title: 'Calling rules enforced', body: 'Country calling hours, consent, the do-not-call list, and no second call after a no.' },
  { title: 'Keys encrypted', body: 'Voice platform and lead finder keys are encrypted at rest and never shown again.' },
];

export type Plan = {
  id: PlanId;
  name: string;
  monthly: number;
  tagline: string;
  calls: string;
  extra: string;
  seats: string;
  drafts: string;
  cycles: string;
  adds: string[];
  cta: string;
  highlight?: string;
};

export const PLANS: Plan[] = [
  {
    id: 'payg',
    name: 'Pay as you go',
    monthly: 0,
    tagline: 'Prepaid credit from $50',
    calls: '$0.20 per scored call',
    extra: 'Credit lasts 12 months',
    seats: '2 editor seats',
    drafts: 'Co-pilot drafts $1 each',
    cycles: 'Improvement cycles $25 each',
    adds: ['Scoring and dashboards', 'Recommendations', 'Review queue', 'Taxonomy editor'],
    cta: 'Start with credit',
  },
  {
    id: 'starter',
    name: 'Starter',
    monthly: 149,
    tagline: 'For one agent going live',
    calls: '1,000 scored calls a month',
    extra: 'Extra calls $0.15 each',
    seats: '3 editor seats',
    drafts: '20 co-pilot drafts a month',
    cycles: 'Improvement cycles $25 each',
    adds: ['Everything in Pay as you go', 'Co-pilot', 'Alerts', 'API tokens'],
    cta: 'Start free trial',
  },
  {
    id: 'growth',
    name: 'Growth',
    monthly: 499,
    tagline: 'For teams that call leads',
    calls: '3,500 scored calls a month',
    extra: 'Extra calls $0.13 each',
    seats: '10 editor seats',
    drafts: '100 co-pilot drafts a month',
    cycles: '4 improvement cycles a month',
    adds: ['Everything in Starter', 'CRM and funnels', 'Apollo.io lead finder', 'Batch campaigns', 'Self-improvement'],
    cta: 'Start free trial',
    highlight: 'Most teams',
  },
  {
    id: 'scale',
    name: 'Scale',
    monthly: 1499,
    tagline: 'For high call volumes',
    calls: '12,000 scored calls a month',
    extra: 'Extra calls $0.11 each',
    seats: '25 editor seats',
    drafts: '300 co-pilot drafts a month',
    cycles: '15 improvement cycles a month',
    adds: ['Everything in Growth', 'Audit-log export', 'Choice of data region', 'Priority support'],
    cta: 'Start free trial',
  },
];

export const ENTERPRISE = {
  name: 'Enterprise',
  tagline: 'Annual contract',
  adds: ['Dedicated installation', 'Your own data region', 'SLA', 'Custom retention', 'Invoice billing'],
};

export const PRICING_NOTES = [
  '14-day trial of Growth with 250 scored calls and 10 co-pilot drafts. No card needed.',
  'Viewers are free and unlimited on every plan.',
  'Annual billing: two months free.',
  'Prices in US dollars, before VAT.',
];

export const FAQ = [
  {
    q: 'What counts as a scored call?',
    a: 'A call imported from your voice platform, or uploaded as a recording, once it has been scored: transcript, 62 metrics, compliance gates and a quality score. Demo data is free.',
  },
  {
    q: 'Do you charge for voice minutes or lead data?',
    a: 'No. Calls run on your own ElevenLabs or Retell AI account, and lead enrichment uses your own Apollo.io credits. We charge for scoring and the co-pilot only.',
  },
  {
    q: 'What happens when my credit runs out?',
    a: 'Calls keep arriving and wait to be scored; nothing is lost. Top up or change plan and they are scored. You are alerted at 50%, 80% and 100% of your calls or credit.',
  },
  {
    q: 'Do I need a card for the trial?',
    a: 'No. The 14-day trial includes the Growth plan with 250 scored calls and 10 co-pilot drafts.',
  },
  {
    q: 'Who can see our calls, and how long are they kept?',
    a: 'Each person has a role, and viewers see dashboards without transcripts or contact details. Provider keys are encrypted at rest, every change is in the audit log, and transcripts are removed after the retention period you set.',
  },
  {
    q: 'Which voice platforms work?',
    a: 'ElevenLabs Agents and Retell AI, by webhook with polling as a back-up. You can also upload recordings from any other platform.',
  },
];
