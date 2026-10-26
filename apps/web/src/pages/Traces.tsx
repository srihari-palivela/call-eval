import { useEffect, useState } from 'react';
import { Anchor, Badge, Box, Button, Card, Group, Paper, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import { Bar as RBar, BarChart, CartesianGrid, Cell as RCell, ReferenceLine, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import type { TracesDTO } from '@calleval/framework';
import { usePal } from '../theme';
import { filterQs, useApi } from '../api';
import { AgentSelect, EmptyState, ErrorState, Legend, Loading, Mono, PageHeader, RangeSelect, SectionTitle, StatCard } from '../components/ui';
import { useStore } from '../store';

const TRACE_JOINS: [string, string][] = [
  ['call.call_id = trace_id', 'The voice platform’s conversation ID is the trace ID, so each call has exactly one trace.'],
  ['turn_id → span.turn_index', 'Each agent turn’s spans carry its index; timestamps line up with the transcript.'],
  ['call_event → tool span', 'Tool calls keep their arguments, result, duration and status.'],
  ['metric_result.run_id', 'Each judged metric points to the judge run: rubric version, model and the turns it cited.'],
  ['call_tag.run_id', 'Each tag points to the classifier run and the confidence it gave.'],
  ['call_score.trace_id', 'Scores, tags and spans for one call open together in Call drill-down.'],
];
const pctOf = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');

export function TracesPage() {
  const p = usePal();
  const { filters, go } = useStore();
  const t = useApi<TracesDTO>(`/api/traces${filterQs(filters, {}, ['range', 'agent'])}`);
  const days = t.data?.days ?? [];
  const [day, setDay] = useState(-1);
  useEffect(() => {
    if (!days.length) return;
    // Default to the day with the worst p90.
    let worst = 0;
    days.forEach((d, i) => { if (d.total > days[worst].total) worst = i; });
    setDay(worst);
  }, [t.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const header = (
    <PageHeader
      eyebrow="AI team · Refreshed per call"
      title="Traces"
      description="Agent and evaluator traces joined to every call by conversation ID, so a slow turn, a failed tool or a judge’s score can be followed back to the span behind it."
      right={<Group gap="sm" align="flex-end" wrap="wrap"><RangeSelect /><AgentSelect />{t.data && <Badge variant="light" color="gray" size="lg" tt="none" fw={500}>Window · {t.data.window}</Badge>}</Group>}
    />
  );
  if (t.error && !t.data) return <>{header}<ErrorState error={t.error} onRetry={t.reload} /></>;
  if (!t.data) return <>{header}<Loading /></>;
  const d = t.data;
  if (!d.coverage.calls) return <>{header}<EmptyState /></>;

  const series: ['eot' | 'llm' | 'tool' | 'tts', string, string][] = [['eot', 'End-of-turn', p.series.eot], ['llm', 'LLM', p.series.llm], ['tool', 'Tool wait', p.series.tool], ['tts', 'TTS', p.series.tts]];
  const sel = day >= 0 ? days[day] : null;
  const note = !sel ? '' : sel.total > 4
    ? `p90 above the 4 s alert line; ${sel.tool >= Math.max(sel.llm, sel.eot, sel.tts) ? 'tool wait' : sel.llm >= Math.max(sel.eot, sel.tts) ? 'LLM time to first token' : 'end-of-turn detection'} was the largest share.`
    : sel.tool > 1.1 ? 'Tool wait is above its usual level.' : 'Within the usual range; LLM time to first token is usually the largest share.';
  const axis = { fontSize: 12, fill: p.text3, fontFamily: 'IBM Plex Mono, monospace' };
  const ymax = Math.max(5, Math.ceil(Math.max(0, ...days.map((x) => x.total)) + 0.5));

  return (
    <>
      {header}

      <SimpleGrid cols={{ base: 2, md: 4 }} mb="lg">
        <StatCard label="Calls with turn timing" value={pctOf(d.coverage.withTiming, d.coverage.calls)} note={`${d.coverage.withTiming.toLocaleString('en-US')} of ${d.coverage.calls.toLocaleString('en-US')} · joined on conversation ID`} />
        <StatCard label="Agent turns with latency" value={pctOf(d.coverage.turnsWithLatency, d.coverage.turns)} note="Turn index matched to the transcript" />
        <StatCard label="Metrics linked to a run" value={`${d.coverage.metricsLinked}%`} note="Every judged metric and tag cites its run" />
        <StatCard label="Orphan traces" value={d.coverage.orphan.toLocaleString('en-US')} note="No call record · mostly test calls" />
      </SimpleGrid>

      <Box style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'stretch' }} mb="lg">
        <Card style={{ flex: '2 1 560px', minWidth: 0 }}>
          <SectionTitle right={<Legend items={series.map(([, l, c]) => ({ label: l, color: c }))} />} note="Each day’s slowest 10% of agent turns, split by where the time went. Select a day to see its spans.">p90 response latency, by span</SectionTitle>
          {days.length === 0 ? <Text size="sm" c="dimmed">No turn timing in this window.</Text> : (
            <Box h={300}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={days.map((x, i) => ({ ...x, i }))} margin={{ top: 16, right: 8, left: -8, bottom: 0 }} onClick={(e: any) => { if (e && typeof e.activeTooltipIndex === 'number') setDay(e.activeTooltipIndex); }} style={{ cursor: 'pointer' }}>
                  <CartesianGrid vertical={false} stroke={p.line} />
                  <XAxis dataKey="day" tickLine={false} axisLine={{ stroke: p.line }} tick={axis} />
                  <YAxis domain={[0, ymax]} tickLine={false} axisLine={false} tick={axis} tickFormatter={(v) => `${v} s`} width={44} />
                  <RTooltip
                    cursor={{ fill: p.soft }}
                    content={({ active, payload }: any) => active && payload?.length ? (
                      <Paper withBorder shadow="sm" p="xs" radius="md">
                        <Text size="xs" fw={600}>{payload[0].payload.date} · p90 {payload[0].payload.total.toFixed(1)} s · {payload[0].payload.n} turns</Text>
                        {payload.slice().reverse().map((s: any) => <Text key={s.dataKey} size="xs">{s.name}: <Mono size="xs">{Number(s.value).toFixed(2)} s</Mono></Text>)}
                      </Paper>
                    ) : null}
                  />
                  <ReferenceLine y={4} stroke={p.warn} strokeDasharray="4 3" label={{ value: '4 s alert line', position: 'insideTopLeft', fill: p.warnText, fontSize: 11 }} />
                  {series.map(([k, l, c], si) => (
                    <RBar key={k} dataKey={k} name={l} stackId="a" fill={c} radius={si === 3 ? [3, 3, 0, 0] : 0} isAnimationActive={false}>
                      {days.map((x, i) => <RCell key={x.date} fill={c} fillOpacity={i === day ? 1 : 0.55} stroke={i === day ? p.ink : undefined} strokeWidth={i === day ? 1 : 0} />)}
                    </RBar>
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </Box>
          )}
        </Card>

        <Card style={{ flex: '1 1 300px', minWidth: 0 }}>
          {!sel ? <Text size="sm" c="dimmed">Select a day.</Text> : (
            <>
              <Text size="xs" fw={600} tt="uppercase" c="dimmed">{sel.date}</Text>
              <Group gap={8} align="baseline" mb="md"><Mono fz={36} fw={500} c={sel.total > 4 ? p.warnText : undefined}>{sel.total.toFixed(1)} s</Mono><Text size="sm" c="dimmed">p90 response latency</Text></Group>
              <Stack gap="sm">
                {series.map(([k, l, c]) => {
                  const v = sel[k];
                  return (
                    <Box key={k} style={{ display: 'grid', gridTemplateColumns: '84px minmax(0,1fr) 56px', gap: 10, alignItems: 'center' }}>
                      <Text size="sm">{l}</Text>
                      <Box h={8} style={{ borderRadius: 4, background: p.track }}><Box h={8} style={{ width: `${sel.total ? Math.round((v / sel.total) * 100) : 0}%`, background: c, borderRadius: 4 }} /></Box>
                      <Mono size="sm" ta="right">{v.toFixed(2)} s</Mono>
                    </Box>
                  );
                })}
              </Stack>
              <Text size="sm" c="dimmed" mt="md">{note}</Text>
              {sel.total > 4 && <Button mt="md" size="xs" color="accent" variant="light" rightSection={<IconArrowRight size={14} />} onClick={() => go('alerts')}>Latency alerts</Button>}
            </>
          )}
        </Card>
      </Box>

      <Card mb="lg">
        <SectionTitle note="Every tool in the prompt. Error rate is spans that returned an error; the Tool failure alert fires above 5% in a day.">Tool spans</SectionTitle>
        {d.toolSpans.length === 0 ? <Text size="sm" c="dimmed">No tool calls in this window.</Text> : (
          <Table.ScrollContainer minWidth={760}>
            <Table>
              <Table.Thead><Table.Tr><Table.Th>Tool</Table.Th><Table.Th ta="right">Spans</Table.Th><Table.Th ta="right">p50</Table.Th><Table.Th ta="right">p90</Table.Th><Table.Th ta="right">Errors</Table.Th><Table.Th>Most common error</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>
                {d.toolSpans.map((r) => (
                  <Table.Tr key={r.name}>
                    <Table.Td><Mono size="sm">{r.name}</Mono></Table.Td>
                    <Table.Td ta="right"><Mono size="sm">{r.n.toLocaleString('en-US')}</Mono></Table.Td>
                    <Table.Td ta="right"><Mono size="sm">{r.p50 === null ? '—' : `${r.p50.toFixed(2)} s`}</Mono></Table.Td>
                    <Table.Td ta="right"><Mono size="sm" c={r.p90 !== null && r.p90 > 3 ? p.warnText : undefined} fw={r.p90 !== null && r.p90 > 3 ? 600 : 400}>{r.p90 === null ? '—' : `${r.p90.toFixed(2)} s`}</Mono></Table.Td>
                    <Table.Td ta="right"><Mono size="sm" c={r.errPct > 2 ? p.warnText : undefined} fw={r.errPct > 2 ? 600 : 400}>{r.errPct.toFixed(1)}%</Mono></Table.Td>
                    <Table.Td><Text size="sm" c="dimmed">{r.topError ?? '—'}</Text></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>

      <SimpleGrid cols={{ base: 1, md: 2 }} mb="lg" spacing="lg">
        <Card>
          <SectionTitle note="Turn timing and size by prompt version; a longer prompt usually adds input tokens and time to first token.">Agent spans by prompt version</SectionTitle>
          {d.llmSpans.length === 0 ? <Text size="sm" c="dimmed">Needs calls on two prompt versions.</Text> : (
            <Table>
              <Table.Thead><Table.Tr><Table.Th>Measure</Table.Th><Table.Th ta="right">{d.versions.a ?? 'Previous'}</Table.Th><Table.Th ta="right">{d.versions.b ?? 'Live'} (live)</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>
                {d.llmSpans.map((r) => (
                  <Table.Tr key={r.measure}><Table.Td><Text size="sm">{r.measure}</Text></Table.Td><Table.Td ta="right"><Mono size="sm">{r.a}</Mono></Table.Td><Table.Td ta="right"><Mono size="sm" c={r.flag ? p.warnText : undefined} fw={r.flag ? 600 : 400}>{r.b}</Mono></Table.Td></Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Card>
        <Card>
          <SectionTitle note="The judge, classifier and audio models are traced too, so every metric and tag links to the run that produced it.">Evaluator runs</SectionTitle>
          {d.evalRuns.length === 0 && <Text size="sm" c="dimmed">No evaluator runs in this window.</Text>}
          <Stack gap={0}>
            {d.evalRuns.map((r) => (
              <Group key={r.name} justify="space-between" align="flex-start" wrap="nowrap" py="sm" style={{ borderBottom: `1px solid ${p.line}` }}>
                <Stack gap={0} style={{ minWidth: 0 }}><Text size="sm" fw={600}>{r.name}</Text><Text size="xs" c="dimmed">{r.meta}</Text></Stack>
                <Stack gap={0} align="flex-end" style={{ flex: 'none' }}><Mono size="sm">{r.runs}</Mono><Text size="xs" c={r.bad ? p.warnText : 'dimmed'} fw={r.bad ? 600 : 400}>{r.err}</Text></Stack>
              </Group>
            ))}
          </Stack>
        </Card>
      </SimpleGrid>

      <Card mb="lg">
        <SectionTitle>Slowest agent turns</SectionTitle>
        {d.slowTurns.length === 0 && <Text size="sm" c="dimmed">No slow turns in this window.</Text>}
        <Stack gap={0}>
          {d.slowTurns.map((s) => (
            <Box key={`${s.callId}#${s.turn}`} py="sm" style={{ display: 'grid', gridTemplateColumns: '200px 60px minmax(0,1fr) auto', gap: 14, alignItems: 'center', borderBottom: `1px solid ${p.line}` }}>
              <Mono size="sm" fw={500} style={{ overflowWrap: 'anywhere' }}>{s.callId} · #{s.turn}</Mono>
              <Mono size="sm" fw={600} c={p.warnText}>{s.lat.toFixed(1)} s</Mono>
              <Text size="sm">{s.why}</Text>
              <Anchor component="button" size="sm" fw={600} c="inherit" onClick={() => go('calls', { id: s.callId })}>Open the call →</Anchor>
            </Box>
          ))}
        </Stack>
      </Card>

      <Card>
        <SectionTitle>How traces join the evaluation data</SectionTitle>
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} mb="md">
          {TRACE_JOINS.map(([k, txt]) => (
            <Paper key={k} p="md" bg={p.soft}><Mono size="sm" fw={500}>{k}</Mono><Text size="sm" c="dimmed" mt={4}>{txt}</Text></Paper>
          ))}
        </SimpleGrid>
        <Text size="sm" c="dimmed">Two tables join the seven in the framework: <Mono size="sm" c={p.ink}>trace_span</Mono> (one row per span: call, turn, kind, start, duration, model, tokens, status) and <Mono size="sm" c={p.ink}>eval_run</Mono> (one row per judge, classifier or audio-model run: rubric or taxonomy version, model, output, cited turns).</Text>
      </Card>
    </>
  );
}
