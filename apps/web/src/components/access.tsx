// What the signed-in role (and the workspace's plan) may do, for hiding pages and disabling actions. The API
// enforces every permission and plan limit itself; this only keeps the console from offering what would be refused.
import { ReactElement } from 'react';
import { Button, HoverCard, Stack, Text, Tooltip } from '@mantine/core';
import type { Permission, PlanFeature, Role } from '@calleval/framework';
import { PageKey, useStore } from '../store';
import { FEATURE_LABEL, usePlan } from './plan';

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner', admin: 'Admin', qa_lead: 'QA lead', sales_manager: 'Sales manager', reviewer: 'Reviewer', viewer: 'Viewer',
};

export const PERMISSION_LABEL: Record<Permission, string> = {
  'analytics:read': 'Read dashboards', 'calls:read': 'Read calls', 'calls:review': 'Review calls', 'calls:upload': 'Upload recordings',
  'quality:manage': 'Manage quality work', 'taxonomy:edit': 'Edit taxonomy drafts', 'taxonomy:activate': 'Activate a taxonomy',
  'settings:manage': 'Change settings and the scoring model', 'integrations:manage': 'Manage integrations', 'business:manage': 'Edit business setup',
  'crm:read': 'Read leads', 'crm:write': 'Change leads and funnels', 'leadfinder:spend': 'Use lead finders', 'campaigns:read': 'Read campaigns',
  'campaigns:manage': 'Create and edit campaigns', 'campaigns:start': 'Start campaigns', 'improvement:approve': 'Approve improvement cycles',
  'improvement:promote': 'Promote or roll back prompts', 'copilot:use': 'Use the co-pilot', 'users:manage': 'Manage users and access',
  'audit:read': 'Read the audit log',
};

/** What a role needs to open each page; the nav hides the rest. */
export const PAGE_PERMISSION: Record<PageKey, Permission> = {
  attention: 'analytics:read', matrix: 'analytics:read', fix: 'analytics:read', funnel: 'analytics:read', version: 'analytics:read',
  traces: 'analytics:read', alerts: 'analytics:read', taxonomy: 'analytics:read', scoring: 'analytics:read', business: 'analytics:read',
  calls: 'calls:read', audio: 'calls:read', recommendations: 'calls:read', review: 'calls:read',
  integrations: 'integrations:manage', leads: 'crm:read', funnels: 'crm:read', campaigns: 'campaigns:read', improvement: 'campaigns:read',
  access: 'users:manage', billing: 'settings:manage', compliance: 'crm:read',
};

const asList = (p: Permission | Permission[]) => (Array.isArray(p) ? p : [p]);

/** `can('campaigns:start')`, or several permissions that are all needed. Allows everything until meta says otherwise. */
export function useCan(): (p: Permission | Permission[]) => boolean {
  const { meta } = useStore();
  const mine = meta?.me?.permissions;
  return (p) => !mine || asList(p).every((x) => mine.includes(x));
}

/** The permissions in `p` the role lacks. */
export function useMissing(): (p: Permission | Permission[]) => Permission[] {
  const { meta } = useStore();
  const mine = meta?.me?.permissions;
  return (p) => (mine ? asList(p).filter((x) => !mine.includes(x)) : []);
}

/** `allow('campaigns:start', 'campaigns')`: the role has the permission(s) and the plan includes the feature. */
export function useAllow(): (p: Permission | Permission[], feature?: PlanFeature) => boolean {
  const can = useCan();
  const { has } = usePlan();
  return (p, feature) => can(p) && (!feature || has(feature));
}

/** Wraps a control the role (or the plan, with `feature`) can't use, naming what it needs; render the control
 *  disabled yourself (`useAllow`). The plan's card links to Billing. */
export function NeedsTip({ perm, feature, children }: { perm: Permission | Permission[]; feature?: PlanFeature; children: ReactElement }) {
  const missing = useMissing()(perm);
  const { has, upgradeFor } = usePlan();
  const { go } = useStore();
  const can = useCan();
  if (missing.length) {
    return (
      <Tooltip label={`Your role can’t do this: it needs “${missing.map((m) => PERMISSION_LABEL[m] ?? m).join('” and “')}”.`} multiline maw={280}>
        <span style={{ display: 'inline-block' }}>{children}</span>
      </Tooltip>
    );
  }
  if (!feature || has(feature)) return children;
  const up = upgradeFor(feature);
  return (
    <HoverCard width={260} shadow="md" withArrow openDelay={150} position="top">
      <HoverCard.Target><span style={{ display: 'inline-block' }}>{children}</span></HoverCard.Target>
      <HoverCard.Dropdown>
        <Stack gap={8}>
          <Text size="sm">{up ? `Included in ${up.name}: your plan doesn’t include ${FEATURE_LABEL[feature]}.` : `Your plan doesn’t include ${FEATURE_LABEL[feature]}.`}</Text>
          {can('settings:manage')
            ? <Button size="xs" variant="default" onClick={() => go('billing')}>See plans</Button>
            : <Text size="xs" c="dimmed">Ask an admin to change the plan.</Text>}
        </Stack>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}
