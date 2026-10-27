import { useState } from 'react';
import { Anchor, Badge, Box, Button, Card, Group, Paper, Select, Stack, Table, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconBellCheck, IconBellRinging } from '@tabler/icons-react';
import type { AlertsDTO } from '@calleval/framework';
import { usePal } from '../theme';
import { apiSend, errMsg, qs, useApi } from '../api';
import { ErrorState, Loading, PageHeader, SectionTitle } from '../components/ui';
import { PlanNotice } from '../components/plan';
import { PAGE_KEYS, PageKey, useStore } from '../store';

const URG: Record<string, { color: string; variant: string }> = {
  'Within the hour': { color: 'accent', variant: 'filled' },
  'Same day': { color: 'accent', variant: 'light' },
  'Next working day': { color: 'accent', variant: 'outline' },
  'Weekly review': { color: 'gray', variant: 'light' },
  'Monthly review': { color: 'gray', variant: 'outline' },
};

export function AlertsPage() {
  const p = usePal();
  const { go, refreshAlerts } = useStore();
  const [status, setStatus] = useState('open');
  const [rule, setRule] = useState('all');
  const [busy, setBusy] = useState<string | null>(null);
  const a = useApi<AlertsDTO>(`/api/alerts${qs({ status, rule: rule === 'all' ? null : rule })}`);
  const rules = useApi<AlertsDTO>('/api/alerts?status=open');

  const header = (
    <>
    <PageHeader
      eyebrow="AI and sales leads"
      title="Alerts"
      description="Six rules watch compliance, quality, latency, tools, the funnel and the taxonomy. A gate failure is raised within the hour, every time."
      right={
        <Group gap="sm" align="flex-end">
          <Select label="Status" w={150} value={status} onChange={(v) => v && setStatus(v)} data={[{ value: 'open', label: 'Open' }, { value: 'ack', label: 'Acknowledged' }, { value: 'all', label: 'All' }]} />
          <Select label="Rule" w={170} value={rule} onChange={(v) => v && setRule(v)} data={[{ value: 'all', label: 'All rules' }, ...(rules.data?.rules ?? a.data?.rules ?? []).map((r) => r.name)]} />
        </Group>
      }
    />
    <PlanNotice feature="alerts" />
    </>
  );
  if (a.error && !a.data) return <>{header}<ErrorState error={a.error} onRetry={a.reload} /></>;
  if (!a.data) return <>{header}<Loading /></>;

  const toggle = (id: string, acked: boolean) => {
    setBusy(id);
    apiSend('POST', `/api/alerts/${encodeURIComponent(id)}/ack`, { acked: !acked })
      .then(() => { a.reload(); rules.reload(); refreshAlerts(); })
      .catch((e) => notifications.show({ title: 'Couldn’t update the alert', message: errMsg(e), color: 'accent' }))
      .finally(() => setBusy(null));
  };
  const ruleRows = rules.data?.rules ?? a.data.rules;

  return (
    <>
      {header}

      <Stack gap="sm" mb="xl">
        {a.data.alerts.map((al) => {
          const u = URG[al.urgency] ?? { color: 'gray', variant: 'light' };
          const target = (PAGE_KEYS as string[]).includes(al.page) ? (al.page as PageKey) : null;
          return (
            <Paper key={al.id} withBorder p="md" radius="lg" style={{ borderColor: !al.acked && al.urgency === 'Within the hour' ? p.warn : undefined, opacity: al.acked ? 0.82 : 1 }}>
              <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
                <Stack gap={6} style={{ flex: '1 1 420px', minWidth: 0 }}>
                  <Group gap="xs" wrap="wrap">
                    <Text fw={650}>{al.rule}</Text>
                    <Badge color={u.color} variant={u.variant as any} tt="none">{al.urgency}</Badge>
                    <Text size="xs" c="dimmed">{al.when}</Text>
                  </Group>
                  <Text size="sm" style={{ textWrap: 'pretty' }}>{al.text}</Text>
                  <Group gap="md">
                    {target && <Anchor component="button" size="sm" fw={600} c="inherit" onClick={() => go(target, al.params ?? {})}>{al.link} →</Anchor>}
                    <Text size="xs" c="dimmed">{al.acked ? 'Acknowledged' : 'Open'}</Text>
                  </Group>
                </Stack>
                <Button variant={al.acked ? 'default' : 'filled'} loading={busy === al.id} leftSection={al.acked ? <IconBellRinging size={16} /> : <IconBellCheck size={16} />} onClick={() => toggle(al.id, al.acked)} aria-pressed={al.acked}>{al.acked ? 'Reopen' : 'Acknowledge'}</Button>
              </Group>
            </Paper>
          );
        })}
        {a.data.alerts.length === 0 && <Card><Text c="dimmed">Nothing here for this filter.</Text></Card>}
      </Stack>

      <Card>
        <SectionTitle>Rules</SectionTitle>
        <Table.ScrollContainer minWidth={720}>
          <Table>
            <Table.Thead><Table.Tr><Table.Th>Alert</Table.Th><Table.Th>Fires when</Table.Th><Table.Th>Urgency</Table.Th><Table.Th ta="right">Open now</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>
              {ruleRows.map((r) => (
                <Table.Tr key={r.name} style={{ cursor: 'pointer' }} onClick={() => { setRule(r.name); setStatus('all'); }}>
                  <Table.Td><Text size="sm" fw={600}>{r.name}</Text></Table.Td>
                  <Table.Td><Text size="sm">{r.when}</Text></Table.Td>
                  <Table.Td><Text size="sm" c="dimmed">{r.urgency}</Text></Table.Td>
                  <Table.Td ta="right"><Box component="span"><Text span size="sm" fw={600} c={r.open ? p.warnText : 'dimmed'}>{r.open ? `${r.open} open` : 'Quiet'}</Text></Box></Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>
    </>
  );
}
