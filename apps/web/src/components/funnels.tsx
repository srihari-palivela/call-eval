// Lead funnel helpers shared by Leads, Funnels and Campaigns: stage labels and colours from the
// funnel a lead belongs to, with the framework's milestone names as the fallback.
import { Badge } from '@mantine/core';
import type { FunnelStageDef, LeadFunnelDTO, LeadFunnelsDTO } from '@calleval/framework';

/** Labels for the framework milestones (also the stage keys of the default funnel and the CRM outcome stages). */
export const MILESTONE_LABELS: Record<string, string> = {
  new: 'New', contacted: 'Contacted', qualified: 'Qualified', meeting_booked: 'Meeting booked', meeting_attended: 'Meeting attended',
  site_visit: 'Site visit', reservation: 'Reservation', sale: 'Sale', broker_registered: 'Broker registered', bdm_call_held: 'BDM call held',
  broker_first_lead: 'Broker’s first lead', broker_deal: 'Broker deal', lost: 'Lost', dnc: 'Do not contact',
};

export const SOURCES = ['manual', 'csv', 'apollo', 'call', 'api'];
export const PATHS = [
  { value: 'Investor', label: 'Investor (buyer path)' },
  { value: 'Broker', label: 'Broker (partner path)' },
  { value: 'Non-target', label: 'Non-target' },
];

export function defaultFunnel(list: LeadFunnelsDTO | null | undefined): LeadFunnelDTO | undefined {
  return list?.funnels.find((f) => f.isDefault) ?? list?.funnels[0];
}

export function funnelById(list: LeadFunnelsDTO | null | undefined, id: string | null | undefined): LeadFunnelDTO | undefined {
  return (id && list?.funnels.find((f) => f.id === id)) || defaultFunnel(list);
}

export function stageDef(funnel: LeadFunnelDTO | undefined, key: string | null | undefined): FunnelStageDef | undefined {
  return key ? funnel?.stages.find((s) => s.key === key) : undefined;
}

export function stageLabel(funnel: LeadFunnelDTO | undefined, key: string | null | undefined): string {
  if (!key) return '—';
  return stageDef(funnel, key)?.label ?? MILESTONE_LABELS[key] ?? key;
}

/** Closed-lost stages (lost, do not contact) read in the accent colour, as elsewhere in the console. */
export function stageColor(funnel: LeadFunnelDTO | undefined, key: string): 'accent' | 'ink' {
  const d = stageDef(funnel, key);
  return d ? (d.kind === 'lost' ? 'accent' : 'ink') : key === 'dnc' || key === 'lost' ? 'accent' : 'ink';
}

export function StageBadge({ funnel, stage, size = 'sm' }: { funnel: LeadFunnelDTO | undefined; stage: string; size?: 'xs' | 'sm' | 'md' }) {
  const d = stageDef(funnel, stage);
  return <Badge size={size} tt="none" variant={d?.kind === 'won' ? 'filled' : 'light'} color={stageColor(funnel, stage)}>{stageLabel(funnel, stage)}</Badge>;
}

/** A stage key from a label: lower case, letters, digits and underscores, starting with a letter. */
export function stageKey(label: string): string {
  let k = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (k && !/^[a-z]/.test(k)) k = `s_${k}`;
  return k.slice(0, 40);
}
