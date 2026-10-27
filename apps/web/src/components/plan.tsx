// The workspace's plan and what it includes, for disabling what the plan doesn't cover. The API enforces plans
// itself; with billing off on the installation (no plan list) or an Enterprise contract, everything is available.
import { useEffect, useState } from 'react';
import { Alert, Button, Group, Text } from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import type { PlanDTO, PlanFeature, PlanId } from '@calleval/framework';
import { apiGet } from '../api';
import { useStore } from '../store';

export const PLAN_ORDER: PlanId[] = ['payg', 'starter', 'growth', 'scale', 'enterprise'];
export const PLAN_LABEL: Record<PlanId, string> = { payg: 'Pay as you go', starter: 'Starter', growth: 'Growth', scale: 'Scale', enterprise: 'Enterprise' };
export const FEATURE_LABEL: Record<PlanFeature, string> = {
  copilot: 'the co-pilot', alerts: 'alerts', api_tokens: 'API tokens', crm: 'the CRM and funnels', campaigns: 'batch campaigns',
  lead_finder: 'the lead finder', improvement: 'self-improvement', audit_export: 'audit-log export', priority_support: 'priority support',
};

let cache: Promise<PlanDTO[]> | null = null;

/** The plan catalogue, fetched once per page load (null while loading, [] when the API offers none). */
export function usePlans(): PlanDTO[] | null {
  const [plans, setPlans] = useState<PlanDTO[] | null>(null);
  useEffect(() => {
    let alive = true;
    if (!cache) cache = apiGet<PlanDTO[]>('/api/billing/plans').catch(() => { cache = null; return []; });
    cache.then((p) => { if (alive) setPlans(Array.isArray(p) ? p : []); });
    return () => { alive = false; };
  }, []);
  return plans;
}

export type PlanInfo = {
  /** The workspace's plan, when billing applies to it. */
  current: PlanDTO | null;
  has: (f: PlanFeature) => boolean;
  /** The first plan above the current one that includes `f`. */
  upgradeFor: (f: PlanFeature) => PlanDTO | null;
};

export function usePlan(): PlanInfo {
  const { meta } = useStore();
  const plans = usePlans();
  const id = meta?.me?.workspace?.plan ?? null;
  const current = (plans && id && plans.find((p) => p.id === id)) || null;
  // No catalogue, no workspace plan or an Enterprise contract: nothing is limited by plan.
  const open = !plans || !plans.length || !current || current.id === 'enterprise';
  const has = (f: PlanFeature) => open || current!.features.includes(f);
  const upgradeFor = (f: PlanFeature) => {
    if (!plans) return null;
    const from = current ? PLAN_ORDER.indexOf(current.id) : -1;
    return [...plans].sort((a, b) => PLAN_ORDER.indexOf(a.id) - PLAN_ORDER.indexOf(b.id))
      .find((p) => PLAN_ORDER.indexOf(p.id) > from && p.features.includes(f)) ?? null;
  };
  return { current, has, upgradeFor };
}

/** A page whose feature the plan doesn't include: says so, with the plan that does. */
export function PlanNotice({ feature }: { feature: PlanFeature }) {
  const { has, upgradeFor } = usePlan();
  const { go, meta } = useStore();
  if (has(feature)) return null;
  const up = upgradeFor(feature);
  const canBill = !!meta?.me?.permissions.includes('settings:manage');
  return (
    <Alert color="gray" variant="light" radius="md" mb="lg" icon={<IconLock size={18} />}>
      <Group justify="space-between" gap="sm">
        <Text size="sm">Your plan doesn’t include {FEATURE_LABEL[feature]}{up ? `; ${up.name} does` : ''}.</Text>
        {canBill ? <Button size="xs" variant="default" onClick={() => go('billing')}>See plans</Button> : <Text size="xs" c="dimmed">Ask an admin to change the plan.</Text>}
      </Group>
    </Alert>
  );
}
