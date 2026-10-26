import { useState } from 'react';
import { Badge, Box, Button, Card, Group, SegmentedControl, SimpleGrid, Stack, Table, Tabs, Text } from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { Bar as RBar, BarChart, CartesianGrid, Cell as RCell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import type { TaxonomyHealthDTO } from '@calleval/framework';
import { usePal } from '../theme';
import { apiSend, errMsg, useApi } from '../api';
import { ErrorState, Legend, Loading, Mono, PageHeader, SectionTitle, StatCard, fmtWhen } from '../components/ui';
import { useMeta } from '../store';

const f2 = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toFixed(2));
const pc = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);

export function TaxonomyPage() {
  const p = usePal();
  const meta = useMeta();
  const [confTag, setConfTag] = useState<'persona' | 'scenario' | 'intent'>('persona');
  const [tab, setTab] = useState<string | null>('personas');
  const [busy, setBusy] = useState<string | null>(null);
  const h = useApi<TaxonomyHealthDTO>('/api/taxonomy/health');

  const header = (
    <PageHeader
      eyebrow="Taxonomy owner · Monthly"
      title="Taxonomy health"
      description="Whether personas and scenarios still describe the calls: the Unclassified and Other share, reviewer agreement, classifier confidence, and new clusters nobody has named yet."
      right={h.data && <Badge variant="light" color="gray" size="lg" tt="none" fw={500}>Active version v{h.data.version} · last clustering run {h.data.lastClusterRun ? fmtWhen(h.data.lastClusterRun) : 'not yet'}</Badge>}
    />
  );
  if (h.error && !h.data) return <>{header}<ErrorState error={h.error} onRetry={h.reload} /></>;
  if (!h.data) return <>{header}<Loading /></>;
  const d = h.data;

  const propose = (id: string, on: boolean) => {
    setBusy(id);
    apiSend('POST', `/api/taxonomy/clusters/${encodeURIComponent(id)}/propose`, { proposed: !on })
      .then(() => h.reload())
      .catch((e) => notifications.show({ title: 'Couldn’t update the cluster', message: errMsg(e), color: 'accent' }))
      .finally(() => setBusy(null));
  };
  const runClusters = () => {
    setBusy('run');
    apiSend('POST', '/api/taxonomy/clusters/run')
      .then(() => { notifications.show({ title: 'Clustering queued', message: 'Call summaries are being clustered; new clusters appear here when it finishes.', color: 'ink' }); window.setTimeout(h.reload, 5000); })
      .catch((e) => notifications.show({ title: 'Couldn’t start clustering', message: errMsg(e), color: 'accent' }))
      .finally(() => setBusy(null));
  };

  const trend = d.weeks.map((w) => ({ ...w, total: Math.round((w.unc + w.oth) * 10) / 10 }));
  const last = trend.length ? trend[trend.length - 1].total : 0;
  const counts = d.conf[confTag] ?? [];
  const lowBins = d.confBins.map((b) => Number(b) < 0.7);
  const conf = counts.map((c, i) => ({ bin: `${d.confBins[i]}–${(Number(d.confBins[i]) + 0.1).toFixed(1)}`, c, low: lowBins[i] }));
  const low = counts.reduce((a, c, i) => a + (lowBins[i] ? c : 0), 0);
  const axis = { fontSize: 12, fill: p.text3, fontFamily: 'IBM Plex Mono, monospace' };
  const ymaxTrend = Math.max(8, Math.ceil(Math.max(0, ...trend.map((t) => t.total)) + 1));
  const tip = (fmt: (pl: any) => string) => ({ active, payload }: any) => active && payload?.length ? (
    <Box p="xs" style={{ background: 'var(--mantine-color-body)', border: `1px solid ${p.line}`, borderRadius: 8 }}><Text size="xs">{fmt(payload[0].payload)}</Text></Box>
  ) : null;
  const agreeOk = (d.agreement.persona ?? 0) >= 0.75 && (d.agreement.scenario ?? 0) >= 0.75;
  const matchOk = (d.classifierMatch.persona ?? 0) >= 0.85 && (d.classifierMatch.scenario ?? 0) >= 0.85;
  const groups = Array.from(new Set(meta.eventTypes.map((e) => e.group)));

  return (
    <>
      {header}

      <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} mb="lg">
        <StatCard label="Unclassified + Other · last week" value={`${last.toFixed(1)}%`} note={last > 5 ? 'Above 5% · taxonomy drift alert' : 'Under 5%'} tone={last > 5 ? 'warn' : undefined} />
        <StatCard label="Reviewer agreement · persona / scenario" value={`${f2(d.agreement.persona)} / ${f2(d.agreement.scenario)}`} note={d.agreement.n ? `Target κ 0.75 · ${agreeOk ? 'met' : 'not met'} · ${d.agreement.n} double-labelled calls` : 'Needs two reviewers on the same calls'} tone={d.agreement.n && !agreeOk ? 'warn' : undefined} />
        <StatCard label="Classifier matches reviewers" value={`${pc(d.classifierMatch.persona)} / ${pc(d.classifierMatch.scenario)}`} note={d.classifierMatch.n ? `Target 85% · ${matchOk ? 'met' : 'not met'} · ${d.classifierMatch.n} reviewed calls` : 'Fills in as reviewers label calls'} tone={d.classifierMatch.n && !matchOk ? 'warn' : undefined} />
        <StatCard label="Review queue" value={d.reviewQueue.open.toLocaleString('en-US')} note={`${d.reviewQueue.lowConfidence} low-confidence tags + ${d.reviewQueue.sample} sampled calls`} />
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg" mb="lg">
        <Card>
          <SectionTitle right={<Legend items={[{ label: 'Unclassified', color: p.bar }, { label: 'Other', color: p.barMuted }]} />} note="If either passes 5% of calls, or a reviewer sees the same new pattern 10 times, a new tag is proposed.">Unclassified + Other, by week</SectionTitle>
          {trend.length === 0 ? <Text size="sm" c="dimmed">No tagged calls yet.</Text> : (
            <Box h={250}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={trend} margin={{ top: 22, right: 8, left: -12, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke={p.line} />
                  <XAxis dataKey="week" tickLine={false} axisLine={{ stroke: p.line }} tick={{ ...axis, fontSize: 11 }} interval={0} />
                  <YAxis domain={[0, ymaxTrend]} tickLine={false} axisLine={false} tick={axis} tickFormatter={(v) => `${v}%`} />
                  <RTooltip cursor={{ fill: p.soft }} content={tip((x) => `Week ending ${x.week}: Unclassified ${x.unc}%, Other ${x.oth}%`)} />
                  <ReferenceLine y={5} stroke={p.warn} strokeDasharray="4 3" label={{ value: '5% review threshold', position: 'insideTopLeft', fill: p.warnText, fontSize: 11 }} />
                  <RBar dataKey="unc" stackId="a" fill={p.bar} isAnimationActive={false} />
                  <RBar dataKey="oth" stackId="a" fill={p.barMuted} radius={[3, 3, 0, 0]} isAnimationActive={false}>
                    <LabelList dataKey="total" position="top" style={{ fontSize: 11, fontFamily: 'IBM Plex Mono, monospace', fill: p.ink }} formatter={(v: number) => v.toFixed(1)} />
                  </RBar>
                </BarChart>
              </ResponsiveContainer>
            </Box>
          )}
        </Card>

        <Card>
          <SectionTitle right={<SegmentedControl size="xs" value={confTag} onChange={(v) => setConfTag(v as any)} data={[{ value: 'persona', label: 'Persona' }, { value: 'scenario', label: 'Scenario' }, { value: 'intent', label: 'Intent' }]} />}>Classifier confidence</SectionTitle>
          {counts.every((c) => !c) ? <Text size="sm" c="dimmed">No classifier tags yet.</Text> : (
            <Box h={220}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={conf} margin={{ top: 22, right: 8, left: -12, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke={p.line} />
                  <XAxis dataKey="bin" tickLine={false} axisLine={{ stroke: p.line }} tick={{ ...axis, fontSize: 11 }} interval={0} />
                  <YAxis hide />
                  <RTooltip cursor={{ fill: p.soft }} content={tip((x) => `Confidence ${x.bin}: ${x.c.toLocaleString('en-US')} tags`)} />
                  <RBar dataKey="c" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                    {conf.map((x) => <RCell key={x.bin} fill={x.low ? p.warn : p.bar} />)}
                    <LabelList dataKey="c" position="top" style={{ fontSize: 11, fontFamily: 'IBM Plex Mono, monospace', fill: p.ink }} formatter={(v: number) => v.toLocaleString('en-US')} />
                  </RBar>
                </BarChart>
              </ResponsiveContainer>
            </Box>
          )}
          <Text size="sm" c="dimmed" mt="sm"><b style={{ color: p.warnText }}>{low.toLocaleString('en-US')}</b> tags under {meta.settings.confidenceThreshold} are marked Unclassified and queued for a reviewer, along with a {Math.round(meta.settings.reviewSampleRate * 100)}% random sample of everything else. Reviewer tags override the classifier and become labelled examples.</Text>
        </Card>

        <Card>
          <SectionTitle note="Cohen’s kappa between two reviewers on the same calls. A judged metric is trusted at 0.7 or above.">Agreement on judged metrics</SectionTitle>
          {d.kappa.length === 0 && <Text size="sm" c="dimmed">No double-labelled metrics yet.</Text>}
          <Stack gap={8}>
            {d.kappa.map(({ name, v, n }) => {
              const ok = v !== null && v >= 0.7;
              return (
                <Box key={name} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,1fr) 40px 110px', gap: 10, alignItems: 'center' }}>
                  <Text size="sm">{name}</Text>
                  <Box pos="relative" h={8} style={{ borderRadius: 4, background: p.track }}>
                    <Box h={8} style={{ width: `${Math.max(0, (v ?? 0) * 100)}%`, background: ok ? p.bar : p.warn, borderRadius: 4 }} />
                    <Box pos="absolute" top={-3} bottom={-3} w={2} style={{ left: '70%', background: p.ink }} />
                  </Box>
                  <Mono size="sm" ta="right">{f2(v)}</Mono>
                  <Text size="xs" fw={600} c={v === null ? 'dimmed' : ok ? 'dimmed' : p.warnText}>{v === null ? `Needs labels (${n})` : ok ? 'Trusted' : 'Not yet trusted'}</Text>
                </Box>
              );
            })}
          </Stack>
        </Card>

        <Card>
          <SectionTitle note="Call summaries clustered by meaning. A cluster with 20 or more calls is reviewed for the next version." right={<Button size="xs" variant="default" loading={busy === 'run'} onClick={runClusters}>Run clustering</Button>}>New clusters</SectionTitle>
          {d.clusters.length === 0 && <Text size="sm" c="dimmed">No unnamed clusters found yet.</Text>}
          <Stack gap={0}>
            {d.clusters.map((c) => (
              <Group key={c.id} justify="space-between" wrap="nowrap" py="sm" style={{ borderBottom: `1px solid ${p.line}` }}>
                <Stack gap={0} style={{ minWidth: 0 }}><Text size="sm" fw={600}>{c.label}</Text><Text size="xs" c="dimmed">{c.size} calls · nearest tag {c.nearest}</Text></Stack>
                {c.size >= 20
                  ? <Button size="xs" variant={c.proposed ? 'filled' : 'default'} loading={busy === c.id} leftSection={c.proposed ? <IconCheck size={14} /> : undefined} onClick={() => propose(c.id, c.proposed)} aria-pressed={c.proposed} style={{ flex: 'none' }}>{c.proposed ? 'Proposed for next version' : 'Propose for next version'}</Button>
                  : <Text size="xs" c="dimmed" style={{ flex: 'none' }}>Watching · under 20</Text>}
              </Group>
            ))}
          </Stack>
        </Card>
      </SimpleGrid>

      <Card>
        <SectionTitle note="A draft for the sales team to confirm. A change to a definition creates a new version, never an edit in place." right={d.versions.length > 0 ? <Group gap={6}>{d.versions.map((v) => <Badge key={v.version} variant={v.status === 'active' ? 'filled' : 'light'} color={v.status === 'active' ? 'ink' : 'gray'} tt="none">v{v.version} · {v.status}</Badge>)}</Group> : undefined}>Taxonomy v{d.version}</SectionTitle>
        <Tabs value={tab} onChange={setTab}>
          <Tabs.List mb="sm">
            <Tabs.Tab value="personas">Personas</Tabs.Tab>
            <Tabs.Tab value="scenarios">Scenarios</Tabs.Tab>
            <Tabs.Tab value="events">Events</Tabs.Tab>
            <Tabs.Tab value="facets">Facets</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="personas">
            <Table.ScrollContainer minWidth={820}>
              <Table>
                <Table.Thead><Table.Tr><Table.Th w={56}>ID</Table.Th><Table.Th>Persona</Table.Th><Table.Th>Path</Table.Th><Table.Th>Identifying signals</Table.Th><Table.Th>Watch for</Table.Th></Table.Tr></Table.Thead>
                <Table.Tbody>
                  {[...meta.personas, meta.p0].map((r) => (
                    <Table.Tr key={r.id}><Table.Td><Mono size="sm" c="dimmed">{r.id}</Mono></Table.Td><Table.Td><Text size="sm" fw={600}>{r.name}</Text></Table.Td><Table.Td><Text size="sm" c="dimmed">{r.path}</Text></Table.Td><Table.Td><Text size="sm">{r.signals}</Text></Table.Td><Table.Td><Text size="sm">{r.watch}</Text></Table.Td></Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Tabs.Panel>
          <Tabs.Panel value="scenarios">
            <Table.ScrollContainer minWidth={900}>
              <Table>
                <Table.Thead><Table.Tr><Table.Th w={56}>ID</Table.Th><Table.Th>Scenario</Table.Th><Table.Th>Typical trigger</Table.Th><Table.Th>Expected agent path</Table.Th><Table.Th>Success</Table.Th></Table.Tr></Table.Thead>
                <Table.Tbody>
                  {meta.scenarios.map((r) => (
                    <Table.Tr key={r.id}><Table.Td><Mono size="sm" c="dimmed">{r.id}</Mono></Table.Td><Table.Td><Text size="sm" fw={600}>{r.name}</Text></Table.Td><Table.Td><Text size="sm">{r.trigger}</Text></Table.Td><Table.Td><Text size="sm">{r.path}</Text></Table.Td><Table.Td><Text size="sm">{r.success}</Text></Table.Td></Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Tabs.Panel>
          <Tabs.Panel value="events">
            <Table>
              <Table.Thead><Table.Tr><Table.Th w={200}>Group</Table.Th><Table.Th>Events</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>{groups.map((g) => <Table.Tr key={g}><Table.Td><Text size="sm" fw={600}>{g}</Text></Table.Td><Table.Td><Text size="sm">{meta.eventTypes.filter((e) => e.group === g).map((e) => e.label.replace(/^Objection · /, '')).join(' · ')}</Text></Table.Td></Table.Tr>)}</Table.Tbody>
            </Table>
          </Tabs.Panel>
          <Tabs.Panel value="facets">
            <Table.ScrollContainer minWidth={640}>
              <Table>
                <Table.Thead><Table.Tr><Table.Th w={220}>Facet</Table.Th><Table.Th>Values</Table.Th><Table.Th>Source</Table.Th></Table.Tr></Table.Thead>
                <Table.Tbody>{meta.facets.map((f) => <Table.Tr key={f.id}><Table.Td><Text size="sm" fw={600}>{f.name}</Text></Table.Td><Table.Td><Text size="sm">{f.values}</Text></Table.Td><Table.Td><Text size="sm" c="dimmed">{f.source}</Text></Table.Td></Table.Tr>)}</Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Tabs.Panel>
        </Tabs>
      </Card>
    </>
  );
}
