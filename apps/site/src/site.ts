// Everything brand-specific in one place: change the name, domain or sales address here.
export const SITE = {
  brand: 'Call Evaluation',
  domain: 'https://callevaluation.example.com',
  salesEmail: 'sales@example.com',
  title: 'Call Evaluation: every call your AI voice agent makes, scored',
  description:
    'Score every call your ElevenLabs or Retell AI agent makes against 62 metrics and 9 compliance gates, see which callers and journeys go wrong, and ship fixes proven on live calls.',
  appUrl: '/app/',
  signupUrl: '/app/#signup',
} as const;

export type PlanId = 'payg' | 'starter' | 'growth' | 'scale';
export const signupFor = (plan: PlanId) => `/app/#signup?plan=${plan}`;
export const salesMailto = `mailto:${SITE.salesEmail}?subject=${encodeURIComponent(`${SITE.brand} Enterprise`)}`;
