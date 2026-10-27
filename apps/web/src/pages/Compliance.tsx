// Calling compliance: the rules campaigns follow for each destination country (calling hours, retries, refusals,
// consent, AI disclosure), conflicts with the business's own calling rules, and the do-not-call list.
import { useRef, useState } from 'react';
import { Alert, Badge, Box, Button, Card, FileButton, Group, Modal, SimpleGrid, Stack, Table, Text, TextInput, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconCircleCheck, IconSearch, IconTrash, IconUpload } from '@tabler/icons-react';
import type { ComplianceDTO, CountryRuleDTO } from '@calleval/framework';
import { apiGet, apiSend, apiSendText, errMsg, qs, useApi } from '../api';
import { ErrorState, Loading, Mono, PageHeader, SectionTitle, StatCard, fmt, fmtWhen } from '../components/ui';
import { NeedsTip, useCan } from '../components/access';
import { useStore } from '../store';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hour = (h: number) => `${String(h).padStart(2, '0')}:00`;
const daysLabel = (d: number[] | null) => {
  if (!d || d.length === 7) return 'Every day';
  const s = [...d].sort((a, b) => a - b);
  const run = s.every((x, i) => i === 0 || x === s[i - 1] + 1);
  return run && s.length > 2 ? `${DAYS[s[0]]}–${DAYS[s[s.length - 1]]}` : s.map((x) => DAYS[x]).join(', ');
};
const limits = (r: CountryRuleDTO) => {
  const parts = [r.maxPerDay !== null ? `${r.maxPerDay} a day` : null, r.maxPerWeek !== null ? `${r.maxPerWeek} a week` : null].filter(Boolean);
  return parts.length ? parts.join(', ') : 'No limit';
};
/** Numbers pasted one per line, or separated by commas or semicolons. */
const parseNumbers = (text: string) => text.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);

export function CompliancePage() {
  const can = useCan();
  const { go } = useStore();
  const c = useApi<ComplianceDTO>('/api/compliance');

  const header = (
    <PageHeader
      eyebrow="Governance · Sales and legal"
      title="Calling compliance"
      description="The rules campaigns follow for each destination country: calling hours in the lead’s local time, retries, refusals, consent and the do-not-call list. A lead that a rule holds back is never dialled."
    />
  );
  if (c.error && !c.data) return <>{header}<ErrorState error={c.error} onRetry={c.reload} /></>;
  if (!c.data) return <>{header}<Loading /></>;
  const d = c.data;
  const blocks = d.issues.filter((i) => i.severity === 'block');
  const warns = d.issues.filter((i) => i.severity === 'warn');

  return (
    <>
      {header}

      <Stack gap="sm" mb="lg">
        {d.issues.length === 0 && (
          <Group gap={8}><IconCircleCheck size={18} /><Text size="sm">No conflicts between your calling rules and the country rules.</Text></Group>
        )}
        {[...blocks, ...warns].map((i) => (
          <Alert key={`${i.severity}-${i.title}`} color={i.severity === 'block' ? 'accent' : 'yellow'} variant="light" radius="md" icon={<IconAlertTriangle size={18} />}
            title={<Group gap={8}><Text fw={650} size="sm">{i.title}</Text><Badge size="xs" variant={i.severity === 'block' ? 'filled' : 'light'} color={i.severity === 'block' ? 'accent' : 'yellow'} tt="none">{i.severity === 'block' ? 'Blocks calls' : 'Warning'}</Badge></Group>}>
            <Text size="sm">{i.detail}</Text>
            {i.fix && <Text size="sm" mt={4}><b>Fix:</b> {i.fix}</Text>}
          </Alert>
        ))}
        {d.issues.length > 0 && can('business:manage') && <Group><Button size="xs" variant="default" onClick={() => go('business')}>Open the calling rules in Business setup</Button></Group>}
      </Stack>

      <SimpleGrid cols={{ base: 2, md: 4 }} mb="lg">
        <StatCard label="Refused on a call" value={fmt(d.held.refused)} note="Never called again" />
        <StatCard label="On the do-not-call list" value={fmt(d.held.dnc)} note="Skipped before each batch" />
        <StatCard label="Waiting for a retry" value={fmt(d.held.pacing)} note="Held by retry pacing" />
        <StatCard label="Consent missing" value={fmt(d.held.consent)} note="Where the country requires it" />
      </SimpleGrid>

      <Card padding={0} mb="lg">
        <Box p="lg" pb="sm"><SectionTitle note="A lead is matched to a country by its phone number’s prefix. Hours are in the lead’s local time; the business’s own calling hours apply too, whichever is narrower.">Country rules</SectionTitle></Box>
        <Table.ScrollContainer minWidth={980}>
          <Table verticalSpacing="xs" fz="sm">
            <Table.Thead><Table.Tr>
              <Table.Th>Country</Table.Th><Table.Th>Calling window</Table.Th><Table.Th>Days</Table.Th><Table.Th>Retries while unanswered</Table.Th>
              <Table.Th>After a refusal</Table.Th><Table.Th>Consent</Table.Th><Table.Th>AI disclosure</Table.Th><Table.Th>Registry</Table.Th><Table.Th>Source</Table.Th>
            </Table.Tr></Table.Thead>
            <Table.Tbody>
              {d.rules.map((r) => (
                <Table.Tr key={r.country}>
                  <Table.Td><Text size="sm" fw={600}>{r.name}</Text><Mono size="xs" c="dimmed">{r.prefixes.join(' ')}</Mono></Table.Td>
                  <Table.Td><Mono size="sm">{hour(r.startHour)}–{hour(r.endHour)}</Mono></Table.Td>
                  <Table.Td><Text size="sm">{daysLabel(r.days)}</Text></Table.Td>
                  <Table.Td><Text size="sm">{limits(r)}</Text></Table.Td>
                  <Table.Td><Text size="sm">{r.stopAfterRefusal ? 'Never call again' : 'May call again'}</Text></Table.Td>
                  <Table.Td><Text size="sm">{r.consent === 'opt_in' ? 'Recorded consent only' : 'Your consent setting'}</Text></Table.Td>
                  <Table.Td><Text size="sm">{r.aiDisclosure ? 'Required' : '—'}</Text></Table.Td>
                  <Table.Td><Text size="sm">{r.registry ?? '—'}</Text></Table.Td>
                  <Table.Td><Text size="xs" c="dimmed">{r.source}</Text></Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>

      <DncCard d={d} onChanged={c.reload} />
    </>
  );
}

function DncCard({ d, onChanged }: { d: ComplianceDTO; onChanged: () => void }) {
  const can = useCan();
  const writable = can('crm:write');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'add' | 'upload' | 'clear' | 'check' | null>(null);
  const [check, setCheck] = useState('');
  const [checked, setChecked] = useState<{ phone: string; listed: boolean } | null>(null);
  const [clearing, setClearing] = useState(false);
  const resetRef = useRef<() => void>(null);

  const added = (r: { added: number; invalid: number; total: number }) => {
    notifications.show({ title: `${fmt(r.added)} number${r.added === 1 ? '' : 's'} added`, message: `${fmt(r.total)} on the list${r.invalid ? `; ${fmt(r.invalid)} weren’t phone numbers and were skipped` : ''}.`, color: 'ink' });
    onChanged();
  };
  const add = () => {
    const numbers = parseNumbers(text);
    if (!numbers.length) return;
    setBusy('add');
    apiSend<{ added: number; invalid: number; total: number }>('POST', '/api/compliance/dnc', { numbers })
      .then((r) => { setText(''); added(r); })
      .catch((e) => notifications.show({ title: 'Couldn’t add the numbers', message: errMsg(e), color: 'accent' }))
      .finally(() => setBusy(null));
  };
  const upload = (file: File | null) => {
    if (!file) return;
    setBusy('upload');
    file.text()
      .then((csv) => apiSendText<{ added: number; invalid: number; total: number }>('/api/compliance/dnc', csv))
      .then(added)
      .catch((e) => notifications.show({ title: 'Couldn’t read the file', message: errMsg(e), color: 'accent' }))
      .finally(() => { setBusy(null); resetRef.current?.(); });
  };
  const lookup = () => {
    const phone = check.trim();
    if (!phone) return;
    setBusy('check');
    apiGet<{ listed: boolean }>(`/api/compliance/dnc/check${qs({ phone })}`)
      .then((r) => setChecked({ phone, listed: r.listed }))
      .catch((e) => notifications.show({ title: 'Couldn’t check the number', message: errMsg(e), color: 'accent' }))
      .finally(() => setBusy(null));
  };
  const clear = () => {
    setBusy('clear');
    apiSend<{ removed: number }>('DELETE', '/api/compliance/dnc')
      .then((r) => { setClearing(false); notifications.show({ title: 'Do-not-call list cleared', message: `${fmt(r.removed)} numbers removed.`, color: 'ink' }); onChanged(); })
      .catch((e) => notifications.show({ title: 'Couldn’t clear the list', message: errMsg(e), color: 'accent' }))
      .finally(() => setBusy(null));
  };

  return (
    <Card>
      <SectionTitle note="Your own list of numbers never to call: national registry downloads, opt-outs from other channels, former customers. Campaigns skip them before every batch."
        right={<NeedsTip perm="crm:write"><Button size="xs" variant="default" color="accent" leftSection={<IconTrash size={14} />} disabled={!writable || !d.dnc.count} onClick={() => setClearing(true)}>Clear the list</Button></NeedsTip>}>
        Do-not-call list
      </SectionTitle>
      <Group gap="xl" mb="md" wrap="wrap">
        <Stack gap={0}><Text size="xs" c="dimmed">Numbers on the list</Text><Text ff="monospace" fz={22} fw={500}>{fmt(d.dnc.count)}</Text></Stack>
        <Stack gap={0}><Text size="xs" c="dimmed">Last updated</Text><Text size="sm">{fmtWhen(d.dnc.updatedAt)}</Text></Stack>
      </Group>
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
        <Stack gap="xs">
          <Textarea label="Add numbers" description="One per line, or separated by commas. International format, such as +971501234567." autosize minRows={3} maxRows={8}
            value={text} onChange={(e) => setText(e.currentTarget.value)} disabled={!writable} />
          <Group gap="xs">
            <NeedsTip perm="crm:write"><Button size="xs" loading={busy === 'add'} disabled={!writable || !parseNumbers(text).length} onClick={add}>Add {parseNumbers(text).length || ''} number{parseNumbers(text).length === 1 ? '' : 's'}</Button></NeedsTip>
            <FileButton resetRef={resetRef} onChange={upload} accept=".csv,text/csv,text/plain">
              {(props) => <NeedsTip perm="crm:write"><Button {...props} size="xs" variant="default" leftSection={<IconUpload size={14} />} loading={busy === 'upload'} disabled={!writable}>Upload a CSV</Button></NeedsTip>}
            </FileButton>
          </Group>
        </Stack>
        <Stack gap="xs">
          <TextInput label="Check a number" placeholder="+971501234567" leftSection={<IconSearch size={16} />} value={check}
            onChange={(e) => { setCheck(e.currentTarget.value); setChecked(null); }} onKeyDown={(e) => { if (e.key === 'Enter') lookup(); }} />
          <Group gap="sm">
            <Button size="xs" variant="default" loading={busy === 'check'} disabled={!check.trim()} onClick={lookup}>Check</Button>
            {checked && <Badge variant={checked.listed ? 'filled' : 'light'} color={checked.listed ? 'accent' : 'ink'} tt="none">{checked.listed ? `${checked.phone} is on the list` : `${checked.phone} isn’t on the list`}</Badge>}
          </Group>
        </Stack>
      </SimpleGrid>
      <Modal opened={clearing} onClose={() => setClearing(false)} title="Clear the do-not-call list?">
        <Stack gap="sm">
          <Text size="sm">This removes all {fmt(d.dnc.count)} numbers. Campaigns may then call them, unless another rule holds them back. Leads marked do-not-contact stay that way.</Text>
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={() => setClearing(false)}>Keep the list</Button>
            <Button color="accent" loading={busy === 'clear'} onClick={clear}>Clear it</Button>
          </Group>
        </Stack>
      </Modal>
    </Card>
  );
}
