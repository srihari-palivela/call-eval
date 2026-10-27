import { useEffect, useMemo, useState } from 'react';
import { Anchor, Badge, Blockquote, Box, Button, Card, Code, Collapse, Group, Paper, SegmentedControl, Select, SimpleGrid, Stack, Text, TextInput, Textarea, UnstyledButton } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconBulb, IconChevronDown, IconChevronUp, IconRefresh } from '@tabler/icons-react';
import { metricByKey, type JobDTO, type RecommendationDTO } from '@calleval/framework';
import { usePal } from '../theme';
import { apiGet, apiSend, errMsg, qs, useApi } from '../api';
import { EmptyState, ErrorState, Loading, Mono, PageHeader, StatCard, fmtWhen, useLookups } from '../components/ui';
import { useMeta, useStore } from '../store';
import { NeedsTip, useCan } from '../components/access';

type Status = RecommendationDTO['status'];
const STATUS: Record<Status, { label: string; color: string; variant: string }> = {
  proposed: { label: 'Proposed', color: 'accent', variant: 'light' },
  accepted: { label: 'Accepted', color: 'ink', variant: 'light' },
  in_prompt: { label: 'Shipped in prompt', color: 'ink', variant: 'filled' },
  verified: { label: 'Verified', color: 'ink', variant: 'outline' },
  rejected: { label: 'Rejected', color: 'gray', variant: 'light' },
};
const KINDS: Record<RecommendationDTO['kind'], string> = {
  prompt: 'Prompt change', tool: 'Tool or integration', routing: 'Routing', taxonomy: 'Taxonomy', voice: 'Voice and timing', data: 'Data and CRM', coaching: 'Coaching',
};
const SCOPES: Record<RecommendationDTO['scope'], string> = { call: 'Call', cell: 'Persona × scenario', persona: 'Persona', scenario: 'Scenario', dimension: 'Dimension', global: 'Whole agent' };

export function RecommendationsPage() {
  const p = usePal();
  const meta = useMeta();
  const { params, go } = useStore();
  const can = useCan();
  const { cellName, pName, sName } = useLookups();
  const [status, setStatus] = useState<string>(params.status ?? 'active');
  const [kind, setKind] = useState<string>('all');
  const [scope, setScope] = useState<string>(params.scope ?? 'all');
  const [scopeKey] = useState<string | null>(params.key ?? null);
  const [genJob, setGenJob] = useState<string | null>(null);
  const r = useApi<RecommendationDTO[]>(`/api/recommendations${qs({ status: status === 'active' || status === 'all' ? null : status, kind: kind === 'all' ? null : kind, scope: scope === 'all' ? null : scope })}`);

  // Follow a generation run until the job finishes, then refresh.
  useEffect(() => {
    if (!genJob) return;
    let alive = true;
    const tick = () => apiGet<JobDTO[]>('/api/jobs?limit=50').then((jobs) => {
      if (!alive) return;
      const j = jobs.find((x) => x.id === genJob);
      if (!j || j.status === 'done' || j.status === 'failed') {
        setGenJob(null);
        r.reload();
        if (j?.status === 'failed') notifications.show({ title: 'Recommendation run failed', message: j.lastError ?? 'See the API logs.', color: 'accent' });
        else notifications.show({ title: 'Recommendations updated', message: 'The list now reflects the latest scored calls.', color: 'ink' });
      }
    }).catch(() => { /* keep polling */ });
    const id = window.setInterval(tick, 2500);
    return () => { alive = false; window.clearInterval(id); };
  }, [genJob]); // eslint-disable-line react-hooks/exhaustive-deps

  const generate = () => {
    apiSend<{ jobId: string }>('POST', '/api/recommendations/generate')
      .then((res) => { setGenJob(res?.jobId ?? null); if (!res?.jobId) window.setTimeout(r.reload, 4000); notifications.show({ title: 'Generating recommendations', message: 'Failing metrics are being grouped by cell and turned into fixes.', color: 'ink' }); })
      .catch((e) => notifications.show({ title: 'Couldn’t start a run', message: errMsg(e), color: 'accent' }));
  };

  const all = r.data ?? [];
  const items = useMemo(() => {
    let list = all.filter((x) => (status === 'active' ? !['rejected', 'verified'].includes(x.status) : true));
    if (scopeKey) list = list.filter((x) => x.scopeKey === scopeKey).concat(list.filter((x) => x.scopeKey !== scopeKey));
    if (params.id) list = list.filter((x) => x.id === params.id).concat(list.filter((x) => x.id !== params.id));
    return list;
  }, [all, status, scopeKey, params.id]);

  const scopeLabel = (x: RecommendationDTO) => {
    if (!x.scopeKey) return SCOPES[x.scope];
    if (x.scope === 'cell') { const [pid, sid] = x.scopeKey.split('|'); return cellName({ pid, sid }); }
    if (x.scope === 'persona') return `${x.scopeKey} ${pName(x.scopeKey)}`;
    if (x.scope === 'scenario') return `${x.scopeKey} ${sName(x.scopeKey)}`;
    if (x.scope === 'dimension') return meta.dims.find((d) => d.key === x.scopeKey)?.name ?? x.scopeKey;
    if (x.scope === 'call') return `Call ${x.scopeKey}`;
    return x.scopeKey;
  };

  const counts = { proposed: 0, accepted: 0, in_prompt: 0, verified: 0, rejected: 0 } as Record<Status, number>;
  all.forEach((x) => { counts[x.status]++; });
  // Open items overlap (one call can sit behind several), so show the widest single reach, not a sum.
  const stake = all.filter((x) => !['rejected', 'verified'].includes(x.status)).reduce((a, x) => Math.max(a, x.impact.calls), 0);

  return (
    <>
      <PageHeader
        eyebrow="Improve · AI team and sales leads"
        title="Recommendations"
        description="Concrete fixes drawn from the calls: prompt changes, tool and routing fixes, and taxonomy updates, each with the calls and turns that justify it and the cells it should move. Ship a fix, then verify it in the next version report."
        right={<NeedsTip perm="quality:manage"><Button leftSection={genJob ? <IconRefresh size={16} /> : <IconBulb size={16} />} loading={!!genJob} disabled={!can('quality:manage')} onClick={generate}>Generate recommendations</Button></NeedsTip>}
      />

      <SimpleGrid cols={{ base: 2, md: 5 }} mb="lg">
        <StatCard label="Proposed" value={counts.proposed} note="Waiting for a decision" tone={counts.proposed ? 'warn' : undefined} />
        <StatCard label="Accepted" value={counts.accepted} note="Planned for the next prompt" />
        <StatCard label="Shipped in prompt" value={counts.in_prompt} note="Waiting for the version report" />
        <StatCard label="Verified" value={counts.verified} note="Cell moved right after release" />
        <StatCard label="Widest open item" value={stake.toLocaleString('en-US')} note="Calls the broadest open fix targets" />
      </SimpleGrid>

      <Group justify="space-between" mb="md" wrap="wrap" gap="sm" align="flex-end">
        <SegmentedControl value={status} onChange={setStatus} data={[{ value: 'active', label: 'Open' }, { value: 'proposed', label: 'Proposed' }, { value: 'accepted', label: 'Accepted' }, { value: 'in_prompt', label: 'Shipped' }, { value: 'verified', label: 'Verified' }, { value: 'rejected', label: 'Rejected' }, { value: 'all', label: 'All' }]} />
        <Group gap="sm" align="flex-end">
          <Select label="Kind" w={190} value={kind} onChange={(v) => v && setKind(v)} data={[{ value: 'all', label: 'All kinds' }, ...Object.entries(KINDS).map(([value, label]) => ({ value, label }))]} />
          <Select label="Scope" w={190} value={scope} onChange={(v) => v && setScope(v)} data={[{ value: 'all', label: 'All scopes' }, ...Object.entries(SCOPES).map(([value, label]) => ({ value, label }))]} />
        </Group>
      </Group>

      {r.error && !r.data && <ErrorState error={r.error} onRetry={r.reload} />}
      {!r.data && !r.error && <Loading />}
      {r.data && items.length === 0 && (
        meta.dataMode === 'empty' ? <EmptyState /> : (
          <Card padding="xl">
            <Text fw={650}>No recommendations in this view</Text>
            <Text size="sm" c="dimmed" mt={4}>Run a generation pass to turn the latest failing metrics, gate failures and Fix-first cells into proposed fixes.</Text>
            <Button mt="md" size="xs" onClick={generate} loading={!!genJob} disabled={!can('quality:manage')}>Generate recommendations</Button>
          </Card>
        )
      )}
      <Stack gap="md">
        {items.map((x) => <RecCard key={x.id} rec={x} highlight={x.id === params.id || (!!scopeKey && x.scopeKey === scopeKey)} scopeLabel={scopeLabel(x)} onChanged={(nx) => r.setData(all.map((y) => (y.id === nx.id ? nx : y)))} go={go} />)}
      </Stack>

      <SimpleGrid cols={{ base: 1, md: 3 }} mt="xl">
        {[
          ['Where they come from', 'Each run reads the scored calls: metrics under target, gate failures and the Fix-first map. A playbook turns each failing metric into a known fix; when the LLM judge is on, Claude drafts the prompt wording from the quoted turns and the agent’s current prompt.'],
          ['How they are ranked', 'Priority weighs the calls affected, how far below target they are and the business value of the cells involved, so high-value cells handled badly come first.'],
          ['Closing the loop', 'Accept a fix, ship it in a prompt version, then mark it verified once the version report shows the target cells improved with intervals that exclude zero.'],
        ].map(([t, d]) => <Paper key={t} p="lg" bg={p.soft}><Text fw={600} mb={4}>{t}</Text><Text size="sm" c="dimmed">{d}</Text></Paper>)}
      </SimpleGrid>
    </>
  );
}

function RecCard({ rec, highlight, scopeLabel, onChanged, go }: { rec: RecommendationDTO; highlight: boolean; scopeLabel: string; onChanged: (r: RecommendationDTO) => void; go: ReturnType<typeof useStore>['go'] }) {
  const p = usePal();
  const meta = useMeta();
  const [open, setOpen] = useState(highlight);
  const [busy, setBusy] = useState(false);
  const [ver, setVer] = useState<string>(rec.targetVersion ?? '');
  const [note, setNote] = useState<string>(rec.note ?? '');
  const st = STATUS[rec.status];

  const update = (body: { status?: Status; note?: string; targetVersion?: string | null }) => {
    setBusy(true);
    apiSend<RecommendationDTO>('PATCH', `/api/recommendations/${encodeURIComponent(rec.id)}`, body)
      .then((nx) => { onChanged(nx && (nx as RecommendationDTO).id ? nx : ({ ...rec, ...body, updatedAt: new Date().toISOString() } as RecommendationDTO)); })
      .catch((e) => notifications.show({ title: 'Couldn’t update the recommendation', message: errMsg(e), color: 'accent' }))
      .finally(() => setBusy(false));
  };

  return (
    <Card style={{ outline: highlight ? `2px solid ${p.ink}` : undefined, outlineOffset: -1 }}>
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
        <Stack gap={4} style={{ flex: '1 1 480px', minWidth: 0 }}>
          <Group gap={6} wrap="wrap">
            <Badge color={st.color} variant={st.variant as any} tt="none">{st.label}</Badge>
            <Badge color="gray" variant="light" tt="none">{KINDS[rec.kind]}</Badge>
            <Badge color="gray" variant="outline" tt="none">{scopeLabel}</Badge>
            {rec.source === 'llm' && <Badge color="gray" variant="light" tt="none">Drafted by Claude</Badge>}
          </Group>
          <Text fw={650} fz={17}>{rec.title}</Text>
          <Text size="sm" c="dimmed">{rec.problem}</Text>
        </Stack>
        <Stack gap={2} align="flex-end" style={{ flex: 'none' }}>
          <Text size="xs" c="dimmed">Priority</Text>
          <Mono fz={24} fw={500}>{Math.round(rec.priority)}</Mono>
          <Text size="xs" c="dimmed">{rec.impact.calls.toLocaleString('en-US')} calls · {Math.round(rec.impact.pointsBelow)} pts below</Text>
          {rec.impact.valueAtStake !== null && <Text size="xs" c="dimmed">AED {Math.round(rec.impact.valueAtStake).toLocaleString('en-US')}k at stake</Text>}
        </Stack>
      </Group>

      <Paper bg={p.soft} p="sm" mt="sm" radius="md">
        <Text size="xs" fw={600} c="dimmed" mb={2}>Proposed fix</Text>
        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{rec.proposal}</Text>
      </Paper>

      {rec.metrics.length > 0 && (
        <Group gap={6} mt="sm">
          <Text size="xs" c="dimmed">Moves</Text>
          {rec.metrics.map((k) => <Badge key={k} size="sm" variant="light" color="gray" tt="none">{metricByKey(k)?.name ?? k}</Badge>)}
        </Group>
      )}

      <UnstyledButton mt="sm" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Group gap={4}><Text size="sm" fw={600}>{open ? 'Hide' : 'Show'} prompt change and evidence ({rec.evidence.length} quotes)</Text>{open ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}</Group>
      </UnstyledButton>
      <Collapse in={open}>
        <Stack gap="sm" mt="sm">
          {rec.promptPatch && (
            <Box>
              <Text size="xs" fw={600} c="dimmed" mb={4}>Prompt change</Text>
              <Code block style={{ whiteSpace: 'pre-wrap' }}>{rec.promptPatch}</Code>
            </Box>
          )}
          {rec.evidence.length > 0 && (
            <Box>
              <Text size="xs" fw={600} c="dimmed" mb={4}>Evidence</Text>
              <Stack gap={6}>
                {rec.evidence.map((e, i) => (
                  <Blockquote key={i} p="xs" radius="md" color="gray" fz="sm" style={{ fontStyle: 'normal' }}>
                    {e.quote ? `“${e.quote}”` : 'No quote stored.'}
                    <Group gap={8} mt={4}>
                      <Anchor component="button" size="xs" onClick={() => go('calls', { id: e.callId })}>{e.callId}{e.turn !== null ? ` · #${e.turn}` : ''} →</Anchor>
                      {e.metric && <Text size="xs" c="dimmed">{metricByKey(e.metric)?.name ?? e.metric}</Text>}
                    </Group>
                  </Blockquote>
                ))}
              </Stack>
            </Box>
          )}
          <Textarea label="Note" autosize minRows={1} value={note} onChange={(e) => setNote(e.currentTarget.value)} onBlur={() => { if (note !== (rec.note ?? '')) update({ note }); }} placeholder="Decision, owner or follow-up" />
        </Stack>
      </Collapse>

      <Group justify="space-between" mt="md" wrap="wrap" gap="sm">
        <Text size="xs" c="dimmed">Created {fmtWhen(rec.createdAt)} · updated {fmtWhen(rec.updatedAt)}{rec.targetVersion ? ` · target prompt ${rec.targetVersion}` : ''}</Text>
        <Group gap="xs" wrap="wrap" align="flex-end">
          {rec.status === 'proposed' && <>
            <Button size="xs" loading={busy} onClick={() => update({ status: 'accepted' })}>Accept</Button>
            <Button size="xs" variant="default" loading={busy} onClick={() => update({ status: 'rejected' })}>Reject</Button>
          </>}
          {rec.status === 'accepted' && <>
            <TextInput size="xs" w={130} placeholder={`e.g. ${meta.liveVersion ? bumpVersion(meta.liveVersion) : 'v4'}`} value={ver} onChange={(e) => setVer(e.currentTarget.value)} aria-label="Prompt version that ships the fix" />
            <Button size="xs" loading={busy} disabled={!ver.trim()} onClick={() => update({ status: 'in_prompt', targetVersion: ver.trim() })}>Shipped in prompt</Button>
            <Button size="xs" variant="default" loading={busy} onClick={() => update({ status: 'proposed' })}>Back to proposed</Button>
          </>}
          {rec.status === 'in_prompt' && <>
            <Button size="xs" variant="default" onClick={() => go('version')}>Version report</Button>
            <Button size="xs" loading={busy} onClick={() => update({ status: 'verified' })}>Mark verified</Button>
            <Button size="xs" variant="default" loading={busy} onClick={() => update({ status: 'accepted' })}>Not fixed yet</Button>
          </>}
          {(rec.status === 'verified' || rec.status === 'rejected') && <Button size="xs" variant="default" loading={busy} onClick={() => update({ status: 'proposed' })}>Reopen</Button>}
        </Group>
      </Group>
    </Card>
  );
}

function bumpVersion(v: string) {
  const m = /^(.*?)(\d+)$/.exec(v);
  return m ? `${m[1]}${Number(m[2]) + 1}` : `${v}.1`;
}

