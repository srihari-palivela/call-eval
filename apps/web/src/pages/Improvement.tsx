import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Code, Group, ScrollArea, Select, SimpleGrid, Stack, Table, Tabs, Text, Textarea, UnstyledButton } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowBackUp, IconCheck, IconRocket, IconX } from '@tabler/icons-react';
import type { CampaignDTO, CycleDetailDTO, CycleDTO, LessonDTO, ProbeSummaryDTO } from '@calleval/framework';
import { metricByKey } from '@calleval/framework';
import { usePal } from '../theme';
import { apiSend, errMsg, useApi, usePoll } from '../api';
import { ErrorState, Loading, Mono, PageHeader, SectionTitle, StatCard, fmtWhen } from '../components/ui';
import { useStore } from '../store';
import { NeedsTip, useAllow, useCan } from '../components/access';
import { PlanNotice } from '../components/plan';

const STATUS: Record<string, { label: string; tone: 'ink' | 'accent' | 'gray' }> = {
  proposing: { label: 'Proposing', tone: 'gray' }, probing: { label: 'Probing', tone: 'gray' }, awaiting_approval: { label: 'Awaiting approval', tone: 'accent' },
  live: { label: 'Live on calls', tone: 'ink' }, awaiting_promotion: { label: 'Awaiting promotion', tone: 'accent' }, promoted: { label: 'Promoted', tone: 'ink' },
  rolled_back: { label: 'Rolled back', tone: 'gray' }, rejected: { label: 'Rejected', tone: 'gray' }, failed: { label: 'Failed', tone: 'accent' },
};
const name = (k: string) => metricByKey(k)?.name ?? k;
const sign = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v}`);

export function ImprovementPage() {
  const { meta, params, go } = useStore();
  const on = meta!.settings.features.campaigns;
  const campaigns = useApi<CampaignDTO[]>(on ? '/api/campaigns' : null);
  const [campaign, setCampaign] = useState<string | null>(null);
  const cycles = useApi<CycleDTO[]>(on ? `/api/improvement/cycles${campaign ? `?campaign=${campaign}` : ''}` : null);
  const lessons = useApi<LessonDTO[]>(on ? '/api/improvement/lessons' : null);
  const [sel, setSel] = useState<string | null>(params.cycle ?? null);
  usePoll(() => cycles.reload(), 15000, on);
  useEffect(() => { if (!sel && cycles.data?.length) setSel(cycles.data[0].id); }, [cycles.data, sel]);

  if (!on) {
    return (
      <>
        <PlanNotice feature="improvement" />
        <PageHeader eyebrow="Improve · AI team" title="Self-improvement" description="Prompt changes proposed from the evaluation, tested on simulated callers, then on a share of live campaign calls." />
        <Card><Text size="sm" c="dimmed" mb="sm">The loop runs on campaigns. Turn on batch calling to use it.</Text><Button size="xs" variant="default" onClick={() => go('campaigns')}>Campaigns</Button></Card>
      </>
    );
  }

  return (
    <>
      <PlanNotice feature="improvement" />
      <PageHeader eyebrow="Improve · AI team" title="Self-improvement"
        description="Each cycle follows Propose → Probe → Compose: edits are proposed from the weakest metrics and past lessons, tested against the current prompt on simulated callers scored by this pipeline, and the winners become a challenger. Live calls then decide: promoted only with a 95% interval above zero and no rise in gate failures." />
      <Tabs defaultValue="cycles">
        <Tabs.List mb="md"><Tabs.Tab value="cycles">Cycles</Tabs.Tab><Tabs.Tab value="lessons">Lessons library · {lessons.data?.length ?? 0}</Tabs.Tab></Tabs.List>
        <Tabs.Panel value="cycles">
          <Group mb="md"><Select label="Campaign" clearable w={260} data={(campaigns.data ?? []).map((c) => ({ value: c.id, label: c.name }))} value={campaign} onChange={(v) => { setCampaign(v); setSel(null); }} /></Group>
          {cycles.error && !cycles.data && <ErrorState error={cycles.error} onRetry={cycles.reload} />}
          {!cycles.data && !cycles.error && <Loading />}
          {cycles.data && cycles.data.length === 0 && <Card><Text size="sm" c="dimmed">No cycles yet. One starts on its own once a campaign’s current prompt has enough scored calls, or use Improve now on a campaign.</Text></Card>}
          {cycles.data && cycles.data.length > 0 && (
            <SimpleGrid cols={{ base: 1, lg: 3 }} spacing="lg">
              <Stack gap={6}>
                {cycles.data.map((c) => (
                  <UnstyledButton key={c.id} onClick={() => setSel(c.id)}>
                    <Card withBorder padding="sm" style={{ outline: sel === c.id ? '2px solid var(--mantine-color-ink-filled)' : undefined }}>
                      <Group justify="space-between" wrap="nowrap"><Text size="sm" fw={600}>{c.championLabel} → {c.challengerLabel ?? 'candidate'}</Text>
                        <Badge size="sm" tt="none" color={STATUS[c.status]?.tone} variant={STATUS[c.status]?.tone === 'accent' ? 'filled' : 'light'}>{STATUS[c.status]?.label ?? c.status}</Badge></Group>
                      <Text size="xs" c="dimmed">{fmtWhen(c.createdAt)} · {c.candidates.length} edits · {c.mode}</Text>
                    </Card>
                  </UnstyledButton>
                ))}
              </Stack>
              <div style={{ gridColumn: 'span 2' }}>{sel && <CycleView id={sel} onChanged={() => { cycles.reload(); lessons.reload(); }} />}</div>
            </SimpleGrid>
          )}
        </Tabs.Panel>
        <Tabs.Panel value="lessons">
          <Card padding={0}>
            {(lessons.data ?? []).length === 0 ? <Text p="lg" size="sm" c="dimmed">Lessons are recorded when a cycle ends, one per edit, with the effect measured. The next cycle reads them before proposing.</Text> : (
              <Table.ScrollContainer minWidth={760}>
                <Table fz="sm" verticalSpacing="xs">
                  <Table.Thead><Table.Tr><Table.Th>Edit</Table.Th><Table.Th>Targets</Table.Th><Table.Th>Outcome</Table.Th><Table.Th>When</Table.Th></Table.Tr></Table.Thead>
                  <Table.Tbody>{(lessons.data ?? []).map((l) => (
                    <Table.Tr key={l.id}>
                      <Table.Td maw={520}><Text size="sm" style={{ whiteSpace: 'pre-wrap' }} lineClamp={4}>{l.edit}</Text></Table.Td>
                      <Table.Td><Text size="xs">{l.metrics.map(name).join(', ') || '—'}</Text></Table.Td>
                      <Table.Td><Badge size="sm" tt="none" color={l.outcome === 'adopted' ? 'ink' : l.outcome === 'regressed' ? 'accent' : 'gray'} variant="light">{l.outcome}</Badge></Table.Td>
                      <Table.Td><Text size="xs" c="dimmed">{fmtWhen(l.createdAt)}</Text></Table.Td>
                    </Table.Tr>
                  ))}</Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            )}
          </Card>
        </Tabs.Panel>
      </Tabs>
    </>
  );
}

function Probe({ s }: { s: ProbeSummaryDTO | undefined }) {
  const p = usePal();
  if (!s) return <Text size="xs" c="dimmed">Not probed</Text>;
  return (
    <Text size="xs" c={s.gatesAdded ? p.warnText : undefined}>
      {s.n} simulated callers · target metrics {sign(s.meanTargetDelta)} · CQS {sign(s.meanCqsDelta)} · {s.wins} better, {s.losses} worse{s.gatesAdded ? ` · ${s.gatesAdded} new gate failures` : ''}
    </Text>
  );
}

function CycleView({ id, onChanged }: { id: string; onChanged: () => void }) {
  const p = usePal();
  const d = useApi<CycleDetailDTO>(`/api/improvement/cycles/${id}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const can = useCan();
  const allow = useAllow();
  usePoll(() => d.reload(), 10000, ['proposing', 'probing', 'live'].includes(d.data?.status ?? ''));
  const c = d.data;
  if (d.error && !c) return <ErrorState error={d.error} onRetry={d.reload} />;
  if (!c) return <Loading />;
  const act = (a: string) => {
    setBusy(a);
    apiSend('POST', `/api/improvement/cycles/${id}/${a}`, a === 'reject' && note ? { note } : {})
      .then(() => { d.reload(); onChanged(); })
      .catch((e) => notifications.show({ title: 'Couldn’t do that', message: errMsg(e), color: 'accent' }))
      .finally(() => setBusy(null));
  };
  const probes = c.probes?.candidates ?? {};
  const applied = new Set(c.composed?.applied ?? []);
  const v = c.verdict;

  return (
    <Stack gap="md">
      <Card withBorder>
        <Group justify="space-between" wrap="wrap">
          <Stack gap={2}>
            <Group gap={8}><Text fw={650}>{c.championLabel} → {c.challengerLabel ?? 'candidate'}</Text><Badge tt="none" color={STATUS[c.status]?.tone}>{STATUS[c.status]?.label ?? c.status}</Badge></Group>
            <Text size="xs" c="dimmed">Started {fmtWhen(c.createdAt)} · mode {c.mode}{c.decidedBy ? ` · decided by ${c.decidedBy} ${fmtWhen(c.decidedAt)}` : ''} · {c.cost.llmCalls ?? 0} model calls, {(c.cost.inputTokens ?? 0).toLocaleString('en-US')} in / {(c.cost.outputTokens ?? 0).toLocaleString('en-US')} out tokens</Text>
          </Stack>
          <Group gap="xs">
            {c.status === 'awaiting_approval' && <NeedsTip perm="improvement:approve" feature="improvement"><Button size="xs" leftSection={<IconCheck size={14} />} loading={busy === 'approve'} disabled={!allow('improvement:approve', 'improvement')} onClick={() => act('approve')}>Approve · put live</Button></NeedsTip>}
            {c.status === 'awaiting_promotion' && <NeedsTip perm="improvement:promote" feature="improvement"><Button size="xs" leftSection={<IconRocket size={14} />} loading={busy === 'promote'} disabled={!allow('improvement:promote', 'improvement')} onClick={() => act('promote')}>Promote to champion</Button></NeedsTip>}
            {c.status === 'live' && <NeedsTip perm="improvement:approve" feature="improvement"><Button size="xs" variant="default" loading={busy === 'verify'} disabled={!allow('improvement:approve', 'improvement')} onClick={() => act('verify')}>Check verdict now</Button></NeedsTip>}
            {(c.status === 'live' || c.status === 'awaiting_promotion') && <NeedsTip perm="improvement:promote" feature="improvement"><Button size="xs" variant="default" leftSection={<IconArrowBackUp size={14} />} loading={busy === 'rollback'} disabled={!allow('improvement:promote', 'improvement')} onClick={() => act('rollback')}>Roll back</Button></NeedsTip>}
            {(c.status === 'awaiting_approval' || c.status === 'awaiting_promotion') && <NeedsTip perm="improvement:approve" feature="improvement"><Button size="xs" variant="default" color="accent" leftSection={<IconX size={14} />} loading={busy === 'reject'} disabled={!allow('improvement:approve', 'improvement')} onClick={() => act('reject')}>Reject</Button></NeedsTip>}
          </Group>
        </Group>
        {(c.status === 'awaiting_approval' || c.status === 'awaiting_promotion') && <Textarea mt="sm" size="xs" placeholder="Reason, if you reject (kept with the lesson)" autosize value={note} onChange={(e) => setNote(e.currentTarget.value)} />}
        {c.composed?.compliance && <Alert mt="sm" color="accent" variant="light" title="Touches compliance rules">At least one edit concerns a compliance gate, so it never goes live or gets promoted without a person, whatever the mode.</Alert>}
        {c.composed?.unprobed && <Alert mt="sm" color="gray" variant="light">Not probed on simulated callers (no Claude key): live calls are the only test, so a person approves it first.</Alert>}
        {c.error && <Alert mt="sm" color="accent" variant="light">{c.error}</Alert>}
      </Card>

      {v && (
        <Card withBorder>
          <SectionTitle note={v.why}>Live verdict · {v.decision}</SectionTitle>
          <SimpleGrid cols={{ base: 2, md: 4 }}>
            <StatCard label={`Champion · ${c.championLabel}`} value={v.champion?.cqs ?? '—'} note={`${v.champion?.n ?? 0} calls · gates ${v.champion?.gateRate ?? '—'}%`} />
            <StatCard label={`Challenger · ${c.challengerLabel}`} value={v.challenger?.cqs ?? '—'} note={`${v.challenger?.n ?? 0} calls · gates ${v.challenger?.gateRate ?? '—'}%`} tone={v.challenger?.gateRate !== undefined && v.champion?.gateRate !== undefined && v.challenger.gateRate > v.champion.gateRate ? 'warn' : undefined} />
            <StatCard label="CQS change" value={sign(v.cqsDelta)} note={v.lo !== undefined ? `95% interval ${v.lo} to ${v.hi}` : `needs ${v.minCalls ?? '—'} calls an arm`} tone={v.lo !== undefined && v.lo > 0 ? 'ok' : v.hi !== undefined && v.hi < 0 ? 'warn' : undefined} />
            <StatCard label="Checked" value={<Text fz="sm">{fmtWhen(v.checkedAt)}</Text>} />
          </SimpleGrid>
        </Card>
      )}

      <Card withBorder>
        <SectionTitle note="General edits address weaknesses across calls; domain edits a cell, persona or scenario. Each was simulated against the current prompt on the same callers.">Proposed edits</SectionTitle>
        <Stack gap="sm">
          {c.candidates.map((e) => (
            <Card key={e.id} withBorder padding="sm" style={{ borderColor: applied.has(e.id) ? 'var(--mantine-color-ink-filled)' : undefined }}>
              <Group gap={6} mb={4}>
                <Badge size="xs" tt="none" variant="light">{e.kind}</Badge>
                {applied.has(e.id) && <Badge size="xs" tt="none">in the challenger</Badge>}
                {e.compliance && <Badge size="xs" tt="none" color="accent">compliance</Badge>}
                <Text size="xs" c="dimmed">{e.mode === 'replace' ? 'Replace' : 'Add'}{e.section ? ` in “${e.section}”` : ''} · targets {e.targets.map(name).join(', ')}</Text>
              </Group>
              {e.mode === 'replace' && e.before && <Text size="xs" c={p.warnText} td="line-through" style={{ whiteSpace: 'pre-wrap' }}>{e.before}</Text>}
              <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{e.after}</Text>
              {e.rationale && <Text size="xs" c="dimmed" mt={4}>{e.rationale}</Text>}
              <Mono component="div" mt={4}><Probe s={probes[e.id]?.summary} /></Mono>
            </Card>
          ))}
        </Stack>
        {c.composed && (
          <Stack gap={4} mt="md">
            <Text size="sm" fw={600}>Composed challenger</Text>
            <Probe s={c.composed.probe} />
            {(c.composed.skipped ?? []).map((s) => <Text key={s.id} size="xs" c="dimmed">Skipped an edit: {s.reason}</Text>)}
          </Stack>
        )}
      </Card>

      {c.championPrompt && (
        <Card withBorder>
          <SectionTitle>Champion prompt</SectionTitle>
          <ScrollArea.Autosize mah={220}><Code block fz={11}>{c.championPrompt}</Code></ScrollArea.Autosize>
        </Card>
      )}

      {c.lessons.length > 0 && (
        <Card withBorder>
          <SectionTitle>Lessons from this cycle</SectionTitle>
          <Stack gap={4}>{c.lessons.map((l) => <Text key={l.id} size="sm"><Badge size="xs" tt="none" mr={6} color={l.outcome === 'adopted' ? 'ink' : l.outcome === 'regressed' ? 'accent' : 'gray'}>{l.outcome}</Badge>{l.edit.split('\n')[0]}</Text>)}</Stack>
        </Card>
      )}
    </Stack>
  );
}
