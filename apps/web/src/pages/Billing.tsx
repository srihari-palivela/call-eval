// Billing: the workspace's plan, what this period has used, pay-as-you-go credit, the spend cap, and changing
// plan through Stripe Checkout. Voice minutes and Apollo credits stay on the customer's own accounts.
import { useEffect, useState } from 'react';
import { Alert, Badge, Box, Button, Card, Group, List, NumberInput, Progress, SegmentedControl, SimpleGrid, Stack, Switch, Table, Text, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconCheck, IconExternalLink, IconStar } from '@tabler/icons-react';
import type { BillingDTO, PlanDTO, PlanFeature, PlanId } from '@calleval/framework';
import { apiSend, errMsg, useApi } from '../api';
import { ErrorState, Loading, Mono, PageHeader, SectionTitle, StatCard, fmt, fmtWhen } from '../components/ui';
import { PLAN_LABEL, PLAN_ORDER } from '../components/plan';
import { useStore } from '../store';
import { usePal } from '../theme';

const SALES_EMAIL = 'sales@example.com';
const TOPUPS = [50, 200, 500] as const;
const FEATURE_NAME: Record<PlanFeature, string> = {
  copilot: 'Co-pilot', alerts: 'Alerts', api_tokens: 'API tokens', crm: 'CRM and funnels', campaigns: 'Batch campaigns',
  lead_finder: 'Apollo lead finder', improvement: 'Self-improvement', audit_export: 'Audit-log export', priority_support: 'Priority support',
};
const STATUS_LABEL: Record<BillingDTO['status'], string> = { trial: 'Trial', active: 'Active', past_due: 'Payment failed', cancelled: 'Cancelled' };

const usd = (n: number | null | undefined, cents = true) => (n === null || n === undefined || !isFinite(n) ? '—'
  : `$${n.toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`);
const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const failed = (title: string) => (e: unknown) => notifications.show({ title, message: errMsg(e), color: 'accent' });
const redirect = (r: { url: string }) => { window.location.assign(r.url); };

export function BillingPage() {
  const { params, go } = useStore();
  const b = useApi<BillingDTO>('/api/billing');

  // Back from Stripe Checkout: say what happened, then drop the marker from the address.
  useEffect(() => {
    if (params.checkout === 'success') notifications.show({ title: 'Payment received', message: 'Your plan and credit update as soon as Stripe confirms it, usually within a minute.', color: 'ink' });
    if (params.checkout === 'cancelled') notifications.show({ title: 'Checkout cancelled', message: 'Nothing was charged.', color: 'ink' });
    if (params.checkout) { go('billing'); window.setTimeout(b.reload, 3000); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.checkout]);

  const header = (right?: JSX.Element) => (
    <PageHeader
      eyebrow="Account · Owners and admins"
      title="Billing"
      description="Your plan, what this period has used, and pay-as-you-go credit. Voice minutes stay on your ElevenLabs or Retell account, and Apollo credits on your Apollo account."
      right={right}
    />
  );
  if (b.error && !b.data) return <>{header()}<ErrorState error={b.error} onRetry={b.reload} /></>;
  if (!b.data) return <>{header()}<Loading /></>;
  const d = b.data;

  if (!d.enabled) {
    return (
      <>
        {header()}
        <Card maw={640}>
          <Text fw={650} mb={4}>Billing is off on this installation</Text>
          <Text size="sm" c="dimmed">This installation runs without plans or usage limits: every feature is available and nothing is charged here.</Text>
        </Card>
      </>
    );
  }

  const portal = () => apiSend<{ url: string }>('POST', '/api/billing/portal').then(redirect).catch(failed('Couldn’t open the billing portal'));

  return (
    <>
      {header(d.stripe.portal ? <Button variant="default" rightSection={<IconExternalLink size={16} />} onClick={portal}>Manage billing</Button> : undefined)}

      {!d.scoring.allowed && (
        <Alert color="accent" variant="light" radius="md" mb="lg" icon={<IconAlertTriangle size={18} />} title="New calls aren’t being scored">
          <Text size="sm">{d.scoring.reason ?? 'The plan’s limit or the credit has run out.'} {fmt(d.scoring.waiting)} call{d.scoring.waiting === 1 ? '' : 's'} waiting; nothing is lost, and they are scored once you {d.plan === 'payg' ? 'add credit' : 'raise the cap or change plan'}.</Text>
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, xs: 2, lg: 4 }} mb="lg">
        <StatCard label="Plan" value={PLAN_LABEL[d.plan]} note={d.status === 'trial' && d.trialEndsAt ? `Trial until ${day(d.trialEndsAt)}` : `${STATUS_LABEL[d.status]}${d.annual ? ' · billed yearly' : ''}`} tone={d.status === 'past_due' ? 'warn' : undefined} />
        <StatCard label="Scored calls this period" value={fmt(d.usage.scoredCalls)} note={d.usage.includedCalls ? `of ${fmt(d.usage.includedCalls)} included` : 'Paid per call from credit'} tone={d.usage.includedCalls && d.usage.scoredCalls > d.usage.includedCalls ? 'warn' : undefined} />
        <StatCard label="Extra so far" value={usd(d.estimate.extraUsd)} note={`${fmt(d.usage.extraCalls)} extra calls, billed at period end`} />
        <StatCard label="Credit balance" value={usd(d.credit.balanceUsd)} note={`${usd(d.estimate.creditSpentUsd)} spent this period`} tone={d.credit.balanceUsd <= 0 && d.plan === 'payg' ? 'warn' : undefined} />
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg" mb="lg">
        <Usage d={d} />
        <Stack gap="lg">
          <Credit d={d} onSaved={b.setData} />
          <SpendCap d={d} onSaved={b.setData} />
        </Stack>
      </SimpleGrid>

      <Plans d={d} />

      <Card padding={0} mt="lg">
        <Box p="lg" pb="sm"><SectionTitle note="Credit added, charges and refunds, newest first.">Credit and charges</SectionTitle></Box>
        {d.ledger.length === 0 ? <Text px="lg" pb="lg" size="sm" c="dimmed">Nothing yet.</Text> : (
          <Table.ScrollContainer minWidth={560}>
            <Table verticalSpacing="xs" fz="sm">
              <Table.Thead><Table.Tr><Table.Th>When</Table.Th><Table.Th>What</Table.Th><Table.Th ta="right">Amount</Table.Th><Table.Th>Note</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>
                {d.ledger.map((e, i) => (
                  <Table.Tr key={`${e.at}-${i}`}>
                    <Table.Td><Text size="xs" c="dimmed">{fmtWhen(e.at)}</Text></Table.Td>
                    <Table.Td><Text size="sm">{e.kind}</Text></Table.Td>
                    <Table.Td ta="right"><Mono size="sm">{e.amountUsd > 0 ? '+' : ''}{usd(e.amountUsd)}</Mono></Table.Td>
                    <Table.Td><Text size="xs" c="dimmed">{e.note}</Text></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>
    </>
  );
}

function Meter({ label, used, included, note }: { label: string; used: number; included: number | null; note?: string }) {
  const p = usePal();
  const over = included !== null && included > 0 && used > included;
  return (
    <Stack gap={4}>
      <Group justify="space-between" gap="xs" wrap="nowrap">
        <Text size="sm">{label}</Text>
        <Mono size="sm" c={over ? p.warnText : undefined}>{fmt(used)}{included !== null ? ` / ${fmt(included)}` : ''}</Mono>
      </Group>
      {included !== null && included > 0 && <Progress value={Math.min(100, (used / included) * 100)} color={over ? 'accent' : 'ink'} size="sm" aria-label={`${label}: ${used} of ${included}`} />}
      {note && <Text size="xs" c="dimmed">{note}</Text>}
    </Stack>
  );
}

function Usage({ d }: { d: BillingDTO }) {
  const u = d.usage;
  const plan = d.plans.find((p) => p.id === d.plan);
  return (
    <Card>
      <SectionTitle note={`This period: ${day(d.period.start)} to ${day(d.period.end)}.`}>Usage</SectionTitle>
      <Stack gap="md">
        <Meter label="Scored calls" used={u.scoredCalls} included={u.includedCalls || null}
          note={u.includedCalls ? (u.extraCalls ? `${fmt(u.extraCalls)} beyond the plan, at ${usd(plan?.extraCallUsd ?? null)} each` : undefined) : `Paid from credit at ${usd(plan?.extraCallUsd ?? null)} a call`} />
        <Meter label="Co-pilot drafts" used={u.copilotDrafts} included={u.copilotIncluded}
          note={u.copilotIncluded === null ? (plan?.copilotDraftUsd ? `Paid from credit at ${usd(plan.copilotDraftUsd)} a draft` : undefined) : undefined} />
        <Meter label="Improvement cycles" used={u.improvementCycles} included={u.cyclesIncluded}
          note={u.cyclesIncluded === null && plan?.improvementCycleUsd ? `Paid from credit at ${usd(plan.improvementCycleUsd, false)} a cycle` : undefined} />
        <Meter label="Editor seats" used={u.editorSeats} included={u.seatsIncluded} note="Viewers are free and don’t count." />
      </Stack>
    </Card>
  );
}

function Credit({ d, onSaved }: { d: BillingDTO; onSaved: (b: BillingDTO) => void }) {
  const [busy, setBusy] = useState<number | 'save' | null>(null);
  const [auto, setAuto] = useState(d.credit.autoRecharge);
  useEffect(() => { setAuto(d.credit.autoRecharge); }, [d.credit.autoRecharge]);
  const topup = (amountUsd: number) => {
    setBusy(amountUsd);
    apiSend<{ url: string }>('POST', '/api/billing/topup', { amountUsd }).then(redirect).catch(failed('Couldn’t start the payment')).finally(() => setBusy(null));
  };
  const save = () => {
    setBusy('save');
    apiSend<BillingDTO>('PUT', '/api/billing/settings', { autoRecharge: auto })
      .then((b) => { onSaved(b); notifications.show({ title: 'Auto-recharge saved', message: auto.enabled ? `Adds ${usd(auto.amountUsd, false)} when credit falls below ${usd(auto.thresholdUsd, false)}.` : 'Off.', color: 'ink' }); })
      .catch(failed('Couldn’t save auto-recharge')).finally(() => setBusy(null));
  };
  const dirty = JSON.stringify(auto) !== JSON.stringify(d.credit.autoRecharge);
  const checkout = d.stripe.checkout;
  return (
    <Card>
      <SectionTitle note="Pay-as-you-go calls, co-pilot drafts and improvement cycles come out of credit. Credit lasts 12 months.">Credit</SectionTitle>
      <Group gap="sm" align="center" mb="md" wrap="wrap">
        <Text ff="monospace" fz={24} fw={500}>{usd(d.credit.balanceUsd)}</Text>
        <Group gap="xs">
          {TOPUPS.map((a) => (
            <Tooltip key={a} label="Stripe isn’t set up on this installation" disabled={checkout}>
              <Button size="xs" variant="default" loading={busy === a} disabled={!checkout || busy !== null} onClick={() => topup(a)}>Add {usd(a, false)}</Button>
            </Tooltip>
          ))}
        </Group>
      </Group>
      <Stack gap="xs">
        <Switch label="Auto-recharge" description="Top up automatically with the card on file when credit runs low." checked={auto.enabled} onChange={() => setAuto({ ...auto, enabled: !auto.enabled })} />
        {auto.enabled && (
          <Group gap="sm" align="flex-end">
            <NumberInput label="When credit falls below" prefix="$" min={0} w={170} value={auto.thresholdUsd} onChange={(v) => setAuto({ ...auto, thresholdUsd: Number(v) || 0 })} />
            <NumberInput label="Add" prefix="$" min={10} step={50} w={130} value={auto.amountUsd} onChange={(v) => setAuto({ ...auto, amountUsd: Number(v) || 0 })} />
          </Group>
        )}
        {dirty && <Group><Button size="xs" loading={busy === 'save'} onClick={save}>Save auto-recharge</Button></Group>}
      </Stack>
    </Card>
  );
}

function SpendCap({ d, onSaved }: { d: BillingDTO; onSaved: (b: BillingDTO) => void }) {
  const [cap, setCap] = useState<number | ''>(d.spendCapUsd ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setCap(d.spendCapUsd ?? ''); }, [d.spendCapUsd]);
  const save = () => {
    setBusy(true);
    apiSend<BillingDTO>('PUT', '/api/billing/settings', { spendCapUsd: cap === '' ? null : cap })
      .then((b) => { onSaved(b); notifications.show({ title: 'Spend cap saved', message: cap === '' ? 'No cap on extra usage.' : `Extra usage stops at ${usd(cap, false)} a period; calls then wait to be scored.`, color: 'ink' }); })
      .catch(failed('Couldn’t save the spend cap')).finally(() => setBusy(false));
  };
  const dirty = (cap === '' ? null : cap) !== d.spendCapUsd;
  return (
    <Card>
      <SectionTitle note="The most extra usage may cost in a period. At the cap, new calls wait to be scored instead of being charged. Alerts go out at 50%, 80% and 100%.">Spend cap</SectionTitle>
      <Group gap="sm" align="flex-end">
        <NumberInput label="Monthly cap on extra usage" description="Leave empty for no cap" prefix="$" min={0} step={50} w={240} value={cap} onChange={(v) => setCap(v === '' ? '' : Number(v))} />
        <Button loading={busy} disabled={!dirty} onClick={save}>Save</Button>
      </Group>
    </Card>
  );
}

function Plans({ d }: { d: BillingDTO }) {
  const p = usePal();
  const [annual, setAnnual] = useState<'monthly' | 'annual'>(d.annual ? 'annual' : 'monthly');
  const [busy, setBusy] = useState<PlanId | null>(null);
  const plans = [...d.plans].sort((a, b) => PLAN_ORDER.indexOf(a.id) - PLAN_ORDER.indexOf(b.id));
  const choose = (plan: PlanId) => {
    setBusy(plan);
    apiSend<{ url: string }>('POST', '/api/billing/checkout', { plan, annual: annual === 'annual' }).then(redirect).catch(failed('Couldn’t start checkout')).finally(() => setBusy(null));
  };
  const rec = d.recommendation;
  const recPlan = rec ? plans.find((x) => x.id === rec.plan) : null;
  return (
    <Card>
      <SectionTitle note="Prices in US dollars before VAT. Annual billing is ten months’ price for twelve." right={<SegmentedControl size="xs" value={annual} onChange={(v) => setAnnual(v as 'monthly' | 'annual')} data={[{ value: 'monthly', label: 'Monthly' }, { value: 'annual', label: 'Annual' }]} />}>Plans</SectionTitle>
      {rec && recPlan && rec.plan !== d.plan && (
        <Alert color="ink" variant="light" radius="md" mb="md" icon={<IconStar size={18} />} title={`${recPlan.name} fits your usage`}>
          <Group justify="space-between" gap="sm"><Text size="sm">{rec.why}</Text>
            {rec.plan !== 'enterprise' && <Button size="xs" loading={busy === rec.plan} disabled={!d.stripe.checkout} onClick={() => choose(rec.plan)}>Choose {recPlan.name}</Button>}</Group>
        </Alert>
      )}
      <SimpleGrid cols={{ base: 1, sm: 2, xl: 5 }} spacing="md">
        {plans.map((pl) => <PlanCard key={pl.id} pl={pl} current={pl.id === d.plan} recommended={rec?.plan === pl.id} annual={annual === 'annual'} busy={busy === pl.id} checkout={d.stripe.checkout} onChoose={() => choose(pl.id)} />)}
      </SimpleGrid>
      {!d.stripe.checkout && <Text size="xs" c={p.warnText} mt="sm">Stripe isn’t set up on this installation, so plans can’t be bought here yet.</Text>}
    </Card>
  );
}

function PlanCard({ pl, current, recommended, annual, busy, checkout, onChoose }: { pl: PlanDTO; current: boolean; recommended: boolean; annual: boolean; busy: boolean; checkout: boolean; onChoose: () => void }) {
  const p = usePal();
  const monthly = pl.monthlyUsd;
  const price = monthly === null ? null : annual ? (monthly * 10) / 12 : monthly;
  const lines = [
    pl.includedCalls ? `${fmt(pl.includedCalls)} scored calls a month` : 'No calls included',
    pl.extraCallUsd !== null ? `${pl.includedCalls ? 'Extra calls' : 'Calls'} ${usd(pl.extraCallUsd)} each` : 'Calls by contract',
    pl.seats === null ? 'Unlimited editor seats' : `${pl.seats} editor seats`,
    pl.copilotDrafts !== null ? `${fmt(pl.copilotDrafts)} co-pilot drafts a month` : pl.copilotDraftUsd !== null ? `Co-pilot drafts ${usd(pl.copilotDraftUsd)} each` : 'Co-pilot by contract',
    pl.improvementCycles !== null ? `${pl.improvementCycles} improvement cycles a month` : pl.improvementCycleUsd !== null ? `Improvement cycles ${usd(pl.improvementCycleUsd, false)} each` : null,
  ].filter(Boolean) as string[];
  return (
    <Card padding="md" style={{ outline: current ? `2px solid ${p.ink}` : recommended ? `2px solid ${p.warn}` : undefined }}>
      <Stack gap="xs" h="100%">
        <Group justify="space-between" gap={4} wrap="nowrap">
          <Text fw={650}>{pl.name}</Text>
          {current ? <Badge size="sm" variant="filled" color="ink" tt="none">Current</Badge> : recommended ? <Badge size="sm" variant="light" color="accent" tt="none">Recommended</Badge> : null}
        </Group>
        <Box>
          {price === null ? <Text ff="monospace" fz={22} fw={500}>Custom</Text> : (
            <Group gap={4} align="baseline"><Text ff="monospace" fz={22} fw={500}>{usd(price, price % 1 !== 0)}</Text><Text size="xs" c="dimmed">a month</Text></Group>
          )}
          <Text size="xs" c="dimmed">{price === null ? 'Annual contract' : monthly === 0 ? 'Prepaid credit from $50' : annual ? `${usd(monthly! * 10, false)} billed yearly` : 'Billed monthly'}</Text>
        </Box>
        <Text size="xs" c="dimmed">{pl.summary}</Text>
        <List size="xs" spacing={4} icon={<IconCheck size={12} />}>
          {lines.map((l) => <List.Item key={l}>{l}</List.Item>)}
          {pl.features.map((f) => <List.Item key={f}>{FEATURE_NAME[f]}</List.Item>)}
        </List>
        <Box mt="auto" pt="xs">
          {pl.id === 'enterprise'
            ? <Button component="a" href={`mailto:${SALES_EMAIL}?subject=${encodeURIComponent('Call Evaluation Enterprise')}`} variant="default" fullWidth size="xs">Talk to us</Button>
            : current ? <Button fullWidth size="xs" variant="default" disabled>Your plan</Button>
            : (
              <Tooltip label="Stripe isn’t set up on this installation" disabled={checkout}>
                <Button fullWidth size="xs" variant={recommended ? 'filled' : 'default'} loading={busy} disabled={!checkout} onClick={onChoose}>Choose {pl.name}</Button>
              </Tooltip>
            )}
        </Box>
      </Stack>
    </Card>
  );
}
