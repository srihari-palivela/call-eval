import { useState } from 'react';
import { Anchor, Badge, Button, Card, Group, NumberInput, Paper, SegmentedControl, Select, SimpleGrid, Stack, Text, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { ReviewItemDTO } from '@calleval/framework';
import { usePal } from '../theme';
import { apiSend, errMsg, qs, useApi } from '../api';
import { EmptyState, ErrorState, Loading, Mono, PageHeader, StatCard, fmtWhen } from '../components/ui';
import { useMeta, useStore } from '../store';
import { useCan } from '../components/access';

const KIND_LABEL: Record<ReviewItemDTO['kind'], string> = { tag: 'Low-confidence tag', gate: 'Gate failure', sample: 'Random sample', metric: 'Judged metric' };

export function ReviewPage() {
  const p = usePal();
  const { refreshAlerts } = useStore();
  const [status, setStatus] = useState<'open' | 'done'>('open');
  const [kind, setKind] = useState('all');
  const r = useApi<ReviewItemDTO[]>(`/api/review${qs({ status, kind: kind === 'all' ? null : kind })}`);
  const items = r.data ?? [];
  const counts = { tag: 0, gate: 0, sample: 0, metric: 0 } as Record<string, number>;
  items.forEach((x) => { counts[x.kind] = (counts[x.kind] ?? 0) + 1; });

  return (
    <>
      <PageHeader
        eyebrow="QA reviewers · Daily"
        title="Review queue"
        description="Tags under the confidence threshold, every gated call and a random sample of everything else. Reviewer decisions override the classifier, become labelled examples for it, and feed reviewer agreement."
        right={<Group gap="sm" align="flex-end">
          <SegmentedControl value={status} onChange={(v) => setStatus(v as any)} data={[{ value: 'open', label: 'Open' }, { value: 'done', label: 'Resolved' }]} />
          <Select label="Kind" w={190} value={kind} onChange={(v) => v && setKind(v)} data={[{ value: 'all', label: 'All kinds' }, ...Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))]} />
        </Group>}
      />

      {r.data && (
        <SimpleGrid cols={{ base: 2, md: 4 }} mb="lg">
          <StatCard label="Gate failures" value={counts.gate} note="Confirm or overturn; a gate caps the call at 40" tone={counts.gate && status === 'open' ? 'warn' : undefined} />
          <StatCard label="Low-confidence tags" value={counts.tag} note="Persona or scenario under the threshold" />
          <StatCard label="Random sample" value={counts.sample} note="Checks the classifier on confident calls" />
          <StatCard label="Judged metrics" value={counts.metric} note="Second reviewer for agreement" />
        </SimpleGrid>
      )}

      {r.error && !r.data && <ErrorState error={r.error} onRetry={r.reload} />}
      {!r.data && !r.error && <Loading />}
      {r.data && items.length === 0 && (status === 'open' ? <EmptyState title="Nothing waiting for review">Every low-confidence tag, gated call and sampled call has been reviewed.</EmptyState> : <Card><Text c="dimmed">No resolved items yet.</Text></Card>)}

      <Stack gap="md">
        {items.map((it) => <ReviewCard key={it.id} item={it} onDone={() => { r.reload(); refreshAlerts(); }} p={p} />)}
      </Stack>
    </>
  );
}

function ReviewCard({ item, onDone, p }: { item: ReviewItemDTO; onDone: () => void; p: ReturnType<typeof usePal> }) {
  const meta = useMeta();
  const { go } = useStore();
  // Reading the queue needs calls:read; deciding needs calls:review (the API refuses it otherwise).
  const reviewer = useCan()('calls:review');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const isPersona = (item.tagKey ?? '').startsWith('persona');
  const isScenario = (item.tagKey ?? '').startsWith('scenario');
  const current = (item.currentValue ?? '').split(' ')[0] || null;
  const [value, setValue] = useState<string | null>(current);
  const open = item.status === 'open';
  const [score, setScore] = useState<number | string>('');
  const personaOptions = [...meta.personas.map((x) => ({ value: x.id, label: `${x.id} ${x.name}` })), { value: 'P0', label: 'P0 Unclassified' }];

  const options = isPersona
    ? [...meta.personas.map((x) => ({ value: x.id, label: `${x.id} ${x.name}` })), { value: 'P0', label: 'P0 Unclassified' }]
    : isScenario
      ? [...meta.scenarios.map((x) => ({ value: x.id, label: `${x.id} ${x.name}` })), ...(item.tagKey === 'scenario_secondary' ? [{ value: 'none', label: 'No secondary scenario' }] : [])]
      : item.tagKey?.startsWith('intent') ? [{ value: 'hot', label: 'Hot' }, { value: 'warm', label: 'Warm' }, { value: 'cold', label: 'Cold' }] : [];

  const resolve = (body: Record<string, unknown>) => {
    setBusy(true);
    apiSend('POST', `/api/review/${encodeURIComponent(item.id)}`, { ...body, note: note || undefined })
      .then(() => { notifications.show({ title: 'Review saved', message: 'The call’s tags and score update with your decision.', color: 'ink' }); onDone(); })
      .catch((e) => notifications.show({ title: 'Couldn’t save the review', message: errMsg(e), color: 'accent' }))
      .finally(() => setBusy(false));
  };

  return (
    <Paper withBorder p="md" radius="lg" style={{ borderColor: open && item.kind === 'gate' ? p.warn : undefined }}>
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
        <Stack gap={4} style={{ flex: '1 1 420px', minWidth: 0 }}>
          <Group gap={6} wrap="wrap">
            <Badge color={item.kind === 'gate' ? 'accent' : 'gray'} variant={item.kind === 'gate' ? 'filled' : 'light'} tt="none">{KIND_LABEL[item.kind]}</Badge>
            {item.confidence !== null && <Badge color="gray" variant="outline" tt="none">Confidence {item.confidence.toFixed(2)}</Badge>}
            <Text size="xs" c="dimmed">{fmtWhen(item.createdAt)}</Text>
          </Group>
          <Text fw={650}>{item.title}</Text>
          <Text size="sm" c="dimmed">{item.reason}</Text>
          {item.currentValue && <Text size="sm">Current value: <Mono size="sm" fw={600}>{item.currentValue}</Mono></Text>}
          <Anchor component="button" size="sm" fw={600} c="inherit" style={{ alignSelf: 'flex-start' }} onClick={() => go('calls', { id: item.callId })}>Open call {item.callId} →</Anchor>
        </Stack>
        {!open && (
          <Stack gap={2} align="flex-end">
            <Badge color="gray" variant="light">Resolved {fmtWhen(item.resolvedAt)}</Badge>
            {item.resolution && <Text size="xs" c="dimmed">{Object.entries(item.resolution).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `${k}: ${String(v)}`).join(' · ')}</Text>}
          </Stack>
        )}
      </Group>

      {open && (
        <Stack gap="sm" mt="md">
          <Textarea autosize minRows={1} placeholder="Note for the record (optional)" value={note} onChange={(e) => setNote(e.currentTarget.value)} />
          <Group gap="sm" align="flex-end" wrap="wrap">
            {(item.kind === 'tag' || item.kind === 'sample') && (
              <>
                <Select label={options.length ? 'Correct value' : 'Persona'} w={260} searchable data={options.length ? options : personaOptions} value={value} onChange={setValue} />
                <Button loading={busy} disabled={!value || !reviewer} onClick={() => resolve({ value: value === 'none' ? null : value })}>{item.kind === 'sample' ? 'Mark reviewed' : value === current ? 'Confirm tag' : 'Override tag'}</Button>
              </>
            )}
            {item.kind === 'gate' && (
              <>
                <Button color="accent" loading={busy} disabled={!reviewer} onClick={() => resolve({ gateConfirmed: true })}>Confirm gate failure</Button>
                <Button variant="default" loading={busy} disabled={!reviewer} onClick={() => resolve({ gateConfirmed: false })}>Overturn · not a failure</Button>
              </>
            )}
            {item.kind === 'metric' && (
              <>
                <NumberInput label="Your score (0–100)" w={160} min={0} max={100} value={score} onChange={setScore} />
                <Button loading={busy} disabled={score === '' || !reviewer} onClick={() => resolve({ value: String(score) })}>Save score</Button>
              </>
            )}
          </Group>
        </Stack>
      )}
    </Paper>
  );
}
