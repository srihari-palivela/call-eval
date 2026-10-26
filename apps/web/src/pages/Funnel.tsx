import { useEffect, useState } from 'react';
import { Alert, Box, Card, Group, NumberInput, Paper, SimpleGrid, Stack, Table, Tabs, Text } from '@mantine/core';
import type { FunnelDTO } from '@calleval/framework';
import { usePal } from '../theme';
import { filterQs, useApi } from '../api';
import { AgentSelect, DirectionSelect, EmptyState, ErrorState, Loading, Mono, PageHeader, RangeSelect, SectionTitle, StatCard, fmt } from '../components/ui';
import { useMeta, useStore } from '../store';

const pct = (v: number | null | undefined, d = 0) => (v === null || v === undefined || !isFinite(v) ? '—' : `${(v * 100).toFixed(d)}%`);

export function FunnelPage() {
  const p = usePal();
  const meta = useMeta();
  const { filters, go } = useStore();
  const [cost, setCost] = useState<number | string>(meta.settings.costPerMinuteAed ?? '');
  const [sel, setSel] = useState<string | null>(null);
  const range = filters.range === '90' ? '90' : '30';
  const f = useApi<FunnelDTO>(`/api/funnel${filterQs({ ...filters, range }, {}, ['range', 'dir', 'agent'])}`);
  const d = f.data;
  useEffect(() => {
    if (!d || (sel && [...d.investor, ...d.broker].some((r) => r.id === sel))) return;
    setSel(d.investor[0]?.id ?? d.broker[0]?.id ?? null);
  }, [d]); // eslint-disable-line react-hooks/exhaustive-deps

  const header = (
    <PageHeader
      eyebrow="Business view · Sales leadership · Weekly"
      title="Funnel by persona"
      description={`Each persona followed down the sales funnel, with outcomes joined from the CRM and credited to the most recent call within a ${d?.attributionDays ?? meta.settings.attributionDays}-day window. Brokers follow their own path.`}
      right={
        <Group gap="sm" align="flex-end" wrap="wrap">
          <RangeSelect options={['30', '90']} />
          <DirectionSelect />
          <AgentSelect />
          <NumberInput label="Cost per call minute (AED)" w={190} min={0} step={0.05} decimalScale={2} placeholder="e.g. 0.60" value={cost} onChange={setCost} />
        </Group>
      }
    />
  );
  if (f.error && !d) return <>{header}<ErrorState error={f.error} onRetry={f.reload} /></>;
  if (!d) return <>{header}<Loading /></>;
  if (!d.totals.calls) return <>{header}<EmptyState /></>;

  const c = typeof cost === 'number' ? cost : parseFloat(cost);
  const hasCost = !isNaN(c) && c > 0;
  const iv = d.investor.find((r) => r.id === sel), bk = d.broker.find((r) => r.id === sel);

  type Stage = [string, number | null, string, number | null, string];
  let title = '', sub = '', foot = '', stages: Stage[] = [];
  if (iv) {
    const q = iv.qual, booked = q * iv.mb;
    title = `${iv.id} ${iv.name} · investor funnel`;
    sub = 'Call → qualified lead → next step → meeting booked → attended → site visit → reservation.';
    stages = [
      ['Calls', iv.n, 'Tags', null, ''], ['Qualified lead', q, 'Tags + captured fields', iv.n, 'calls'],
      ['Next step', q * Math.min(1, iv.ns), 'Tool results', q, 'qualified'], ['Meeting booked', booked, 'Tool results', q, 'qualified'],
      ['Meeting attended', iv.show === null ? null : booked * iv.show, 'CRM', booked, 'booked'],
      ['Site visit', iv.sv === null ? null : q * iv.sv, 'CRM', q, 'qualified'],
      ['Reservation', iv.res === null ? null : q * iv.res, 'CRM', q, 'qualified'],
    ];
    foot = iv.value !== null && iv.res !== null
      ? `Reservation value: AED ${iv.value.toFixed(1)}m across ${fmt(q * iv.res)} reservations. Qualified = persona resolved and at least 5 of the 7 discovery fields captured.`
      : 'Qualified = persona resolved and at least 5 of the 7 discovery fields captured. Later stages appear once CRM outcomes are synced.';
  } else if (bk) {
    title = `${bk.id} ${bk.name} · broker funnel`;
    sub = 'Call → registered → BDM call held → first broker-sourced lead within 90 days.';
    stages = [
      ['Calls', bk.n, 'Tags', null, ''], ['Unregistered called', bk.unreg, 'Tool arguments', bk.n, 'calls'],
      ['Registered', d.crmConnected ? bk.reg : null, 'CRM', bk.unreg, 'unregistered'],
      ['BDM call held', d.crmConnected ? bk.bdm : null, 'CRM', bk.reg, 'registered'],
      ['First broker lead', d.crmConnected ? bk.lead : null, 'CRM · 90 days', bk.reg, 'registered'],
    ];
    foot = 'Broker activation = unregistered brokers called who complete registration ÷ unregistered brokers called.';
  }
  const top = stages[0]?.[1] || 1;
  const lost = sel ? d.lost[sel] ?? [] : [];
  const lostMax = Math.max(1, ...lost);
  const drops = sel ? d.drops[sel] ?? [] : [];

  return (
    <>
      {header}

      {!d.crmConnected && (
        <Alert color="gray" variant="light" radius="lg" mb="lg" title="CRM outcomes not synced yet">
          <Text size="sm">Stages after the call (attended, site visit, reservation, broker registration) come from the CRM. Push outcomes to the API or paste a CSV under <Text span fw={600} style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={() => go('integrations')}>Integrations</Text>.</Text>
        </Alert>
      )}

      <SimpleGrid cols={{ base: 2, md: 4 }} mb="lg">
        <StatCard label="Calls" value={fmt(d.totals.calls)} note={range === '90' ? 'Last 90 days' : 'Last 30 days'} />
        <StatCard label="Qualified lead rate" value={pct(d.totals.targetCalls ? d.totals.qualified / d.totals.targetCalls : null)} note="Of target-persona calls" />
        <StatCard label="Next-step rate" value={pct(d.totals.nextStep / d.totals.calls)} note="Meeting, callback, send, transfer or note" />
        <StatCard label="Non-target share" value={pct(d.totals.nonTarget / d.totals.calls, 1)} note="P9–P11 calls; report to the source owner" />
      </SimpleGrid>

      <Tabs value={sel} onChange={(v) => v && setSel(v)} variant="pills" radius="xl" mb="lg">
        <Tabs.List>
          {[...d.investor, ...d.broker].map((r) => (
            <Tabs.Tab key={r.id} value={r.id} leftSection={<Mono size="xs" fw={600}>{r.id}</Mono>}>{r.name}</Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs>

      {stages.length > 0 && (
        <Box style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-start' }} mb="lg">
          <Card style={{ flex: '1.6 1 520px', minWidth: 0 }}>
            <SectionTitle note={sub}>{title}</SectionTitle>
            <Stack gap="sm" mt="xs">
              {stages.map((s, k) => {
                const prev = k ? stages[k - 1][1] : s[1];
                const v = s[1];
                const w = v === null ? 0 : Math.max(1, Math.round((v / top) * 100));
                const fill = k === 0 ? p.ink : v !== null && v / top < 0.1 ? p.warn : p.bar;
                const base = s[3] || prev || 0;
                return (
                  <Box key={s[0]} style={{ display: 'grid', gridTemplateColumns: 'minmax(120px,170px) minmax(0,1fr) 120px', gap: 14, alignItems: 'center' }}>
                    <Stack gap={0}><Text size="sm" fw={600}>{s[0]}</Text><Text size="xs" c="dimmed">{s[2]}</Text></Stack>
                    <Box h={26} style={{ borderRadius: 6, background: p.track }}><Box h={26} style={{ width: `${w}%`, background: fill, borderRadius: 6 }} /></Box>
                    <Stack gap={0} align="flex-end">
                      <Mono size="sm" fw={600}>{v === null ? '—' : fmt(v)}</Mono>
                      <Text size="xs" c="dimmed">{v === null ? 'Needs CRM data' : k ? `${pct(base ? v / base : null)} of ${s[4]}` : '100%'}</Text>
                    </Stack>
                  </Box>
                );
              })}
            </Stack>
            <Text size="sm" c="dimmed" mt="md">{foot}</Text>
          </Card>

          <Stack style={{ flex: '1 1 340px', minWidth: 0 }} gap="lg">
            <Card>
              <SectionTitle note="Mix of objection events on calls that ended with no next step.">Lost reasons</SectionTitle>
              {lost.length === 0 || lost.every((x) => !x) ? <Text size="sm" c="dimmed">No lost calls with an objection in this slice.</Text> : (
                <Stack gap={8}>
                  {d.lostLabels.map((label, k) => (
                    <Box key={label} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,150px) minmax(0,1fr) 40px', gap: 10, alignItems: 'center' }}>
                      <Text size="sm">{label}</Text>
                      <Box h={8} style={{ borderRadius: 4, background: p.track }}><Box h={8} style={{ width: `${Math.round(((lost[k] ?? 0) / lostMax) * 100)}%`, background: lost[k] === lostMax ? p.warn : p.barMuted, borderRadius: 4 }} /></Box>
                      <Mono size="sm" ta="right">{Math.round(lost[k] ?? 0)}%</Mono>
                    </Box>
                  ))}
                </Stack>
              )}
            </Card>
            <Card>
              <SectionTitle note="Where calls with no next step ended: the phase and the first missed checkpoint.">Drop-off points</SectionTitle>
              {drops.length === 0 && <Text size="sm" c="dimmed">No drop-offs recorded in this slice.</Text>}
              <Stack gap={0}>
                {drops.map(([step, phase, share], i) => (
                  <Group key={step + i} justify="space-between" wrap="nowrap" py="xs" style={{ borderBottom: i < drops.length - 1 ? `1px solid ${p.line}` : undefined }}>
                    <Stack gap={0}><Text size="sm" fw={600}>{step}</Text><Text size="xs" c="dimmed">{phase}</Text></Stack>
                    <Mono fw={600}>{Math.round(share)}%</Mono>
                  </Group>
                ))}
              </Stack>
            </Card>
          </Stack>
        </Box>
      )}

      <Card mb="lg">
        <SectionTitle note="Rates after the qualified stage are ÷ qualified leads, as the framework defines them.">Investor path KPIs</SectionTitle>
        <Table.ScrollContainer minWidth={1080}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Persona</Table.Th>{['Calls', 'Qualified', 'Next step', 'Meeting booked', 'Show rate', 'Site visit', 'Reservation', 'Value (AED)', 'Intent lift', 'Cost / qualified'].map((h) => <Table.Th key={h} ta="right">{h}</Table.Th>)}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {d.investor.map((r) => {
                const on = r.id === sel;
                return (
                  <Table.Tr key={r.id} bg={on ? p.soft : undefined} style={{ cursor: 'pointer' }} onClick={() => setSel(r.id)}>
                    <Table.Td><Text size="sm" fw={on ? 600 : 400}><Mono size="sm" fw={600}>{r.id}</Mono> {r.name}</Text></Table.Td>
                    {[fmt(r.n), pct(r.q), pct(r.ns), pct(r.mb), pct(r.show), pct(r.sv), pct(r.res, 1), r.value === null ? '—' : `${r.value.toFixed(1)}m`, pct(r.lift)].map((v, i) => <Table.Td key={i} ta="right"><Mono size="sm">{v}</Mono></Table.Td>)}
                    <Table.Td ta="right"><Mono size="sm" c={hasCost ? undefined : 'dimmed'}>{hasCost && r.qual ? `AED ${((r.n * r.mins * c) / r.qual).toFixed(2)}` : hasCost ? '—' : 'Set cost'}</Mono></Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>

      <Card mb="lg">
        <SectionTitle note="Call → registered → BDM call held → first broker-sourced lead within 90 days.">Broker path KPIs</SectionTitle>
        <Table.ScrollContainer minWidth={760}>
          <Table>
            <Table.Thead><Table.Tr><Table.Th>Persona</Table.Th>{['Calls', 'Unregistered called', 'Broker activation', 'BDM call held', 'First lead (90 d)', 'Next step'].map((h) => <Table.Th key={h} ta="right">{h}</Table.Th>)}</Table.Tr></Table.Thead>
            <Table.Tbody>
              {d.broker.map((r) => (
                <Table.Tr key={r.id} bg={r.id === sel ? p.soft : undefined} style={{ cursor: 'pointer' }} onClick={() => setSel(r.id)}>
                  <Table.Td><Text size="sm"><Mono size="sm" fw={600}>{r.id}</Mono> {r.name}</Text></Table.Td>
                  {[fmt(r.n), fmt(r.unreg), pct(r.act), r.bdmR === null ? '—' : `${pct(r.bdmR)} of reg.`, r.leadR === null ? '—' : `${pct(r.leadR)} of reg.`, pct(r.ns)].map((v, i) => <Table.Td key={i} ta="right"><Mono size="sm">{v}</Mono></Table.Td>)}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>

      <SimpleGrid cols={{ base: 1, md: 3 }}>
        {[
          ['Non-target share is an upstream signal', 'Owners and renters on the sales line are usually a routing or marketing problem. Report it to the team that owns the source, not as an agent failure.'],
          ['Reservations are the confirming signal', 'Counts are small and slow to arrive. Judge the agent on qualified, next step, meeting booked and show rate; read reservation and revenue over a quarter.'],
          ['Advisor lead rating', 'The advisor’s 1–5 rating after first follow-up needs a CRM field. It appears here once the CRM sends it as an outcome stage.'],
        ].map(([t, txt]) => (
          <Paper key={t} p="lg" bg={p.soft}><Text fw={600} mb={4}>{t}</Text><Text size="sm" c="dimmed">{txt}</Text></Paper>
        ))}
      </SimpleGrid>
    </>
  );
}
