import { useEffect, useRef, useState } from 'react';
import { Badge, Box, Button, Card, Group, SegmentedControl, SimpleGrid, Stack, Text } from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { Bar as RBar, BarChart, CartesianGrid, Cell as RCell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import type { TaxonomyHealthDTO } from '@calleval/framework';
import { usePal } from '../theme';
import { apiSend, errMsg, useApi } from '../api';
import { ErrorState, Legend, Loading, Mono, PageHeader, SectionTitle, StatCard, fmtWhen } from '../components/ui';
import { TaxonomyEditor } from '../components/TaxonomyEditor';
import { useMeta, useStore } from '../store';
import { NeedsTip, useCan } from '../components/access';

const f2 = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toFixed(2));
const pc = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);

export function TaxonomyPage() {
  const p = usePal();
  const meta = useMeta();
  const { params } = useStore();
  const [confTag, setConfTag] = useState<'persona' | 'scenario' | 'intent'>('persona');
  const [busy, setBusy] = useState<string | null>(null);
  const can = useCan();
  const h = useApi<TaxonomyHealthDTO>('/api/taxonomy/health');
  const editorRef = useRef<HTMLDivElement>(null);
  const ready = !!h.data;
  useEffect(() => { if (ready && params.copilot) editorRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [ready, params.copilot]);

  const header = (
    <PageHeader
      eyebrow="Taxonomy owner · Monthly"
      title="Taxonomy"
      description="The personas, scenarios and events calls are tagged with, and whether they still describe the calls: the Unclassified and Other share, reviewer agreement, classifier confidence, and new clusters nobody has named yet. Define your own below, by hand or with the co-pilot."
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
          <SectionTitle note="Call summaries clustered by meaning. A cluster with 20 or more calls is reviewed for the next version." right={<NeedsTip perm="quality:manage"><Button size="xs" variant="default" loading={busy === 'run'} disabled={!can('quality:manage')} onClick={runClusters}>Run clustering</Button></NeedsTip>}>New clusters</SectionTitle>
          {d.clusters.length === 0 && <Text size="sm" c="dimmed">No unnamed clusters found yet.</Text>}
          <Stack gap={0}>
            {d.clusters.map((c) => (
              <Group key={c.id} justify="space-between" wrap="nowrap" py="sm" style={{ borderBottom: `1px solid ${p.line}` }}>
                <Stack gap={0} style={{ minWidth: 0 }}><Text size="sm" fw={600}>{c.label}</Text><Text size="xs" c="dimmed">{c.size} calls · nearest tag {c.nearest}</Text></Stack>
                {c.size >= 20
                  ? <Button size="xs" variant={c.proposed ? 'filled' : 'default'} loading={busy === c.id} disabled={!can('quality:manage')} leftSection={c.proposed ? <IconCheck size={14} /> : undefined} onClick={() => propose(c.id, c.proposed)} aria-pressed={c.proposed} style={{ flex: 'none' }}>{c.proposed ? 'Proposed for next version' : 'Propose for next version'}</Button>
                  : <Text size="xs" c="dimmed" style={{ flex: 'none' }}>Watching · under 20</Text>}
              </Group>
            ))}
          </Stack>
        </Card>
      </SimpleGrid>

      <div ref={editorRef} style={{ scrollMarginTop: 72 }}>
        <TaxonomyEditor initialMode={params.copilot} onActivated={h.reload} />
      </div>
    </>
  );
}
