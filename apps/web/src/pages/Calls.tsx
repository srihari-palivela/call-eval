import { useEffect, useState } from 'react';
import { Accordion, Alert, Anchor, Badge, Blockquote, Box, Button, Card, Group, Pagination, Paper, ScrollArea, SegmentedControl, Select, SimpleGrid, Stack, Table, Text, TextInput, Timeline, Tooltip, UnstyledButton } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconArrowRight, IconCheck, IconListDetails, IconRefresh, IconSearch, IconX } from '@tabler/icons-react';
import { DIMS, type CallDetailDTO, type CallListDTO, type SpanDTO, type TurnDTO } from '@calleval/framework';
import { bandOf, usePal } from '../theme';
import { apiSend, errMsg, filterQs, useApi } from '../api';
import { AgentSelect, Bar, BandBadge, DirectionSelect, EmptyState, ErrorState, Loading, Mono, PageHeader, RangeSelect, SectionTitle, VersionSelect, fmtDuration, fmtWhen, useLookups } from '../components/ui';
import { useMeta, useStore } from '../store';
import { NeedsTip, useCan } from '../components/access';

const fmtTime = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const PAGE = 12;

export function CallsPage() {
  const p = usePal();
  const { filters, params, go } = useStore();
  const meta = useMeta();
  const { pName, sName } = useLookups();
  const [q, setQ] = useState(params.q ?? '');
  const [query, setQuery] = useState(params.q ?? '');
  const [persona, setPersona] = useState(params.persona ?? 'all');
  const [scenario, setScenario] = useState(params.scenario ?? 'all');
  const [band, setBand] = useState(params.band ?? 'all');
  const [flag, setFlag] = useState(params.flag ?? 'all');
  const [sort, setSort] = useState(params.sort ?? 'recent');
  const [pageNo, setPageNo] = useState(1);
  const [selId, setSelId] = useState<string | null>(params.id ?? null);

  useEffect(() => {
    if (params.id) setSelId(params.id);
    if (params.persona) setPersona(params.persona);
    if (params.scenario) setScenario(params.scenario);
  }, [params]);
  useEffect(() => { setPageNo(1); }, [query, persona, scenario, band, flag, sort, filters.range, filters.dir, filters.ver, filters.agent]);
  useEffect(() => { const id = window.setTimeout(() => setQuery(q.trim()), 300); return () => window.clearTimeout(id); }, [q]);

  const list = useApi<CallListDTO>(`/api/calls${filterQs(filters, {
    path: filters.path,
    q: query, persona: persona === 'all' ? null : persona, scenario: scenario === 'all' ? null : scenario,
    band: band === 'all' ? null : band, gated: flag === 'gated' ? 'true' : null, review: flag === 'review' ? 'true' : null,
    sort, limit: PAGE, offset: (pageNo - 1) * PAGE,
  })}`);
  const items = list.data?.items ?? [];
  const activeId = selId ?? (params.id ? params.id : items[0]?.id ?? null);
  const detail = useApi<CallDetailDTO>(activeId ? `/api/calls/${encodeURIComponent(activeId)}` : null);

  const pick = (id: string) => { setSelId(id); go('calls', { ...params, id }); };

  return (
    <>
      <PageHeader
        eyebrow="Per call · QA reviewers and prompt engineers"
        title="Call drill-down"
        description="Find any scored call, then read its transcript, the tags with their evidence turns, every metric, any gate flags, coaching and the AI trace behind each turn."
        right={<Group gap="sm" wrap="wrap" align="flex-end"><RangeSelect /><DirectionSelect /><VersionSelect /><AgentSelect /></Group>}
      />

      <Card mb="lg">
        <Group gap="sm" wrap="wrap" align="flex-end" mb="sm">
          <TextInput label="Search" placeholder="Call ID, name or words in the transcript" leftSection={<IconSearch size={16} />} value={q} onChange={(e) => setQ(e.currentTarget.value)} w={280} />
          <Select label="Persona" w={190} value={persona} onChange={(v) => v && setPersona(v)} data={[{ value: 'all', label: 'All personas' }, ...meta.personas.map((x) => ({ value: x.id, label: `${x.id} ${x.name}` })), { value: 'P0', label: 'P0 Unclassified' }]} />
          <Select label="Scenario" w={200} value={scenario} onChange={(v) => v && setScenario(v)} data={[{ value: 'all', label: 'All scenarios' }, ...meta.scenarios.map((x) => ({ value: x.id, label: `${x.id} ${x.name}` }))]} />
          <Select label="Band" w={150} value={band} onChange={(v) => v && setBand(v)} data={[{ value: 'all', label: 'All bands' }, 'Excellent', 'Good', 'Needs review', 'Fail']} />
          <Select label="Show" w={170} value={flag} onChange={(v) => v && setFlag(v)} data={[{ value: 'all', label: 'All calls' }, { value: 'gated', label: 'Gate failures' }, { value: 'review', label: 'Queued for review' }]} />
          <Select label="Sort" w={150} value={sort} onChange={(v) => v && setSort(v)} data={[{ value: 'recent', label: 'Most recent' }, { value: 'worst', label: 'Lowest CQS' }, { value: 'best', label: 'Highest CQS' }]} />
        </Group>
        {list.error && !list.data && <ErrorState error={list.error} onRetry={list.reload} />}
        {!list.data && !list.error && <Loading />}
        {list.data && items.length === 0 && (meta.dataMode === 'empty' ? <EmptyState /> : <Text size="sm" c="dimmed" py="md">No calls match these filters.</Text>)}
        {items.length > 0 && (
          <Table.ScrollContainer minWidth={880}>
            <Table verticalSpacing={6}>
              <Table.Thead><Table.Tr><Table.Th>Call</Table.Th><Table.Th>Persona × scenario</Table.Th><Table.Th>When</Table.Th><Table.Th ta="right">Length</Table.Th><Table.Th>Prompt</Table.Th><Table.Th ta="right">CQS</Table.Th><Table.Th>Flags</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>
                {items.map((c) => {
                  const on = c.id === activeId;
                  return (
                    <Table.Tr key={c.id} onClick={() => pick(c.id)} style={{ cursor: 'pointer', background: on ? p.soft : undefined }} aria-selected={on}>
                      <Table.Td><Mono size="sm" fw={on ? 600 : 500}>{c.externalId || c.id}</Mono><Text size="xs" c="dimmed">{c.provider}{c.agentName ? ` · ${c.agentName}` : ''}</Text></Table.Td>
                      <Table.Td><Text size="sm">{c.persona ?? 'P0'} {pName(c.persona)} × {c.scenario ?? '—'} {c.scenario ? sName(c.scenario) : ''}</Text>{c.scenario2 && <Text size="xs" c="dimmed">also {c.scenario2} {sName(c.scenario2)}</Text>}</Table.Td>
                      <Table.Td><Text size="sm">{fmtWhen(c.startedAt)}</Text><Text size="xs" c="dimmed">{c.direction}</Text></Table.Td>
                      <Table.Td ta="right"><Mono size="sm">{fmtDuration(c.durationS)}</Mono></Table.Td>
                      <Table.Td><Mono size="sm">{c.promptVersion ?? '—'}</Mono></Table.Td>
                      <Table.Td ta="right">{c.cqs === null ? <Text size="xs" c="dimmed">{c.status}</Text> : <Group gap={6} justify="flex-end" wrap="nowrap"><Mono fw={500}>{c.cqs}</Mono><BandBadge v={c.cqs} size="xs" /></Group>}</Table.Td>
                      <Table.Td>
                        <Group gap={4} wrap="wrap">
                          {c.gates.length > 0 && <Badge size="xs" color="accent" variant="filled">Gate {c.gates.join(', ')}</Badge>}
                          {c.needsReview && <Badge size="xs" color="accent" variant="light">Review</Badge>}
                          {c.nextStep && <Badge size="xs" color="gray" variant="light" tt="none">{c.nextStep}</Badge>}
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
        {list.data && list.data.total > PAGE && (
          <Group justify="space-between" mt="sm">
            <Text size="sm" c="dimmed">{list.data.total.toLocaleString('en-US')} calls</Text>
            <Pagination size="sm" value={pageNo} onChange={setPageNo} total={Math.ceil(list.data.total / PAGE)} />
          </Group>
        )}
      </Card>

      {activeId && detail.error && !detail.data && <ErrorState error={detail.error} onRetry={detail.reload} />}
      {activeId && !detail.data && !detail.error && <Loading label="Loading the call…" />}
      {detail.data && <CallDetail call={detail.data} reload={detail.reload} />}
    </>
  );
}

function CallDetail({ call, reload }: { call: CallDetailDTO; reload: () => void }) {
  const p = usePal();
  const { go } = useStore();
  const meta = useMeta();
  const can = useCan();
  const [phase, setPhase] = useState('all');
  const [focus, setFocus] = useState<string | null>(null);
  const [only, setOnly] = useState(false);
  const [trace, setTrace] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setPhase('all'); setFocus(null); setOnly(false); setTrace(null); }, [call.id]);

  const toggleFocus = (k: string) => { setFocus(focus === k ? null : k); setOnly(false); };
  const metricBy = (k: string) => call.metrics.find((m) => m.key === k);

  let focusTurns: number[] = [], focusLabel = '';
  if (focus?.startsWith('tag:')) { const t = call.tags.find((x) => x.key === focus.slice(4)); if (t) { focusTurns = t.ev; focusLabel = `${t.label} · ${t.value}`; } }
  else if (focus?.startsWith('ev:')) { const e = call.events[Number(focus.slice(3))]; if (e) { focusTurns = [e.turn]; focusLabel = `Event · ${e.label}`; } }
  else if (focus?.startsWith('gate:')) { const g = call.gates[Number(focus.slice(5))]; if (g && g.turn !== null) { focusTurns = [g.turn]; focusLabel = `Gate · ${g.text}`; } }
  else if (focus?.startsWith('turn:')) { focusTurns = [Number(focus.slice(5))]; focusLabel = 'Selected turn'; }
  else if (focus?.startsWith('m:')) { const m = metricBy(focus.slice(2)); if (m) { focusTurns = m.evidence; focusLabel = m.name; } }

  const phaseOf = (id: number) => call.phases.find((ph) => id >= ph.from && id <= ph.to)?.name ?? '';
  const segOf = (t: TurnDTO) => t.seg ?? call.segs.find((s) => t.id >= s.from && t.id <= s.to)?.name ?? '';
  const turns = call.turns.filter((t) => (phase === 'all' || (t.phase ?? phaseOf(t.id)) === phase) && (!only || !focusTurns.length || focusTurns.includes(t.id)));
  const tr = call.trace;
  const trTot = tr.sums.eot + tr.sums.llm + tr.sums.tool + tr.sums.tts || 1;
  const segColor: Record<string, string> = { Discovery: p.scale.goodHi[0], Pitch: p.scale.goodLo[0], Objection: p.scale.nrLo[0], Action: p.track, 'Off-topic': p.track };
  const intro = call.phases.find((x) => x.name === 'Introduction'), concl = call.phases.find((x) => x.name === 'Conclusion');
  const bar = [
    ...(intro ? [{ name: 'Intro', from: intro.from, to: intro.to, c: p.scale.exc }] : []),
    ...call.segs.map((s) => ({ name: s.name, from: s.from, to: s.to, c: [segColor[s.name] ?? p.track, p.ink] })),
    ...(concl ? [{ name: 'Close', from: concl.from, to: concl.to, c: p.scale.exc }] : []),
  ];
  const cqs = call.cqs;

  const reevaluate = () => {
    setBusy(true);
    apiSend('POST', `/api/calls/${encodeURIComponent(call.id)}/reevaluate`)
      .then(() => { notifications.show({ title: 'Queued for re-scoring', message: `${call.externalId || call.id} is being scored again.`, color: 'ink' }); window.setTimeout(reload, 4000); })
      .catch((e) => notifications.show({ title: 'Couldn’t queue the call', message: errMsg(e), color: 'accent' }))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <Card mb="lg" padding="xl">
        <Group justify="space-between" align="flex-start" wrap="wrap" mb="md">
          <Stack gap={2}>
            <Group gap="xs"><Mono fw={600}>{call.externalId || call.id}</Mono>{call.note && <Text size="sm" fw={600} c={call.noteTone === 'accent' ? p.warnText : undefined}>· {call.note}</Text>}</Group>
            <Text fw={600} fz={18}>{call.title}</Text>
          </Stack>
          <Group gap="xs">
            {call.judgeMode && <Badge variant="light" color="gray" tt="none">{call.judgeMode === 'llm' ? 'Scored by the LLM judge' : 'Scored by heuristics'}</Badge>}
            <NeedsTip perm="quality:manage"><Button size="xs" variant="default" leftSection={<IconRefresh size={14} />} loading={busy} disabled={!can('quality:manage')} onClick={reevaluate}>Re-evaluate</Button></NeedsTip>
          </Group>
        </Group>
        <SimpleGrid cols={{ base: 1, md: 3 }} spacing="xl">
          <Stack gap={6}>
            <Text size="xs" fw={600} tt="uppercase" c="dimmed">Call Quality Score</Text>
            {cqs === null ? <Text c="dimmed">Not scored yet · {call.status}</Text> : (
              <>
                <Group gap="md"><Mono fz={48} fw={500} lh={1}>{cqs}</Mono><BandBadge v={cqs} size="lg" /></Group>
                <Text size="sm" c="dimmed">{call.gates.length ? `Uncapped score ${call.rawCqs ?? '—'} · capped at 40 by a compliance gate.` : 'Seven dimensions weighted; no gate failed.'}</Text>
                <Text size="sm" c="dimmed">Action: {bandOf(cqs).action.toLowerCase()}</Text>
              </>
            )}
          </Stack>
          {([['Opening context', call.context], ['Call record', call.record]] as [string, [string, string][]][]).map(([title, rows]) => (
            <Stack gap={6} key={title}>
              <Text size="xs" fw={600} tt="uppercase" c="dimmed">{title}</Text>
              <Box style={{ display: 'grid', gridTemplateColumns: '96px minmax(0,1fr)', rowGap: 4, columnGap: 12 }}>
                {rows.map(([k, v]) => [<Text key={k} size="sm" c="dimmed">{k}</Text>, <Text key={k + 'v'} size="sm" style={{ overflowWrap: 'anywhere' }}>{v}</Text>])}
              </Box>
            </Stack>
          ))}
        </SimpleGrid>
        {call.audioUrl && (
          <Box mt="md">
            <Text size="xs" fw={600} c="dimmed" mb={4}>Recording{call.recordingChannels === 2 ? ' · dual-channel' : call.recordingChannels === 1 ? ' · mono' : ''}</Text>
            <audio controls preload="none" src={call.audioUrl} style={{ width: '100%' }} />
          </Box>
        )}
        {call.providerAnalysis?.summary && (
          <Paper bg={p.soft} p="sm" mt="md">
            <Text size="xs" fw={600} c="dimmed">Provider summary{call.providerAnalysis.sentiment ? ` · sentiment ${call.providerAnalysis.sentiment}` : ''}{call.providerAnalysis.successful !== null && call.providerAnalysis.successful !== undefined ? ` · ${call.providerAnalysis.successful ? 'successful' : 'not successful'}` : ''}</Text>
            <Text size="sm">{call.providerAnalysis.summary}</Text>
          </Paper>
        )}
      </Card>

      {call.gates.length > 0 && (
        <Alert mb="lg" color="accent" radius="lg" variant="light" icon={<IconAlertTriangle />} title="Compliance gate failed — score capped at 40 and sent to human review">
          <Stack gap="sm">
            {call.gates.map((g, i) => (
              <Group key={i} justify="space-between" wrap="wrap" gap="sm">
                <Stack gap={0} style={{ flex: '1 1 380px' }}><Text fw={600} size="sm">{g.id} · {g.text}</Text><Text size="sm">{g.detail}{g.runId ? ` Flagged by run ${g.runId}.` : ''}</Text></Stack>
                {g.turn !== null && <Button size="xs" color="accent" variant={focus === `gate:${i}` ? 'filled' : 'outline'} onClick={() => toggleFocus(`gate:${i}`)}>Highlight turn {g.turn}</Button>}
              </Group>
            ))}
          </Stack>
        </Alert>
      )}

      <Box style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-start' }}>
        <Card style={{ flex: '1.35 1 520px', minWidth: 0 }}>
          <SectionTitle right={<SegmentedControl size="xs" value={phase} onChange={setPhase} data={[{ value: 'all', label: 'All' }, { value: 'Introduction', label: 'Intro' }, { value: 'Body', label: 'Body' }, { value: 'Conclusion', label: 'Conclusion' }]} />}>Transcript</SectionTitle>
          {bar.length > 0 && (
            <>
              <Group gap={2} wrap="nowrap" h={26} mb={6} style={{ borderRadius: 8, overflow: 'hidden' }}>
                {bar.map((s, i) => (
                  <Tooltip key={i} label={`${s.name} · turns ${s.from}–${s.to}`}>
                    <Box h="100%" px={6} style={{ flex: `${s.to - s.from + 1} 1 0`, background: s.c[0], color: s.c[1], fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', overflow: 'hidden', whiteSpace: 'nowrap' }}>{s.name}</Box>
                  </Tooltip>
                ))}
              </Group>
              <Text size="xs" c="dimmed" mb="sm">Introduction, body segments and conclusion, sized by turns ({call.turns.length} turns).</Text>
            </>
          )}

          {focusTurns.length > 0 && (
            <Paper p="sm" mb="sm" bg={p.warnSoft} withBorder style={{ borderColor: p.warn }}>
              <Group justify="space-between" wrap="wrap" gap="xs">
                <Text size="sm">Evidence for <b>{focusLabel}</b> · turns {focusTurns.join(', ')}</Text>
                <Group gap="xs"><Button size="xs" variant={only ? 'filled' : 'default'} onClick={() => setOnly(!only)}>Only these turns</Button><Button size="xs" variant="default" onClick={() => { setFocus(null); setOnly(false); }}>Clear</Button></Group>
              </Group>
            </Paper>
          )}

          {call.turns.length === 0 && <Text size="sm" c="dimmed">No transcript is stored for this call.</Text>}
          <ScrollArea.Autosize mah={1180} offsetScrollbars>
            <Stack gap={8}>
              {turns.map((t) => <TurnRow key={t.id} t={t} spans={tr.turnSpans[String(t.id)] ?? null} hl={focusTurns.includes(t.id)} seg={segOf(t)} open={trace === t.id} onTrace={() => setTrace(trace === t.id ? null : t.id)} />)}
            </Stack>
          </ScrollArea.Autosize>
        </Card>

        <Stack style={{ flex: '1 1 400px', minWidth: 0 }} gap="lg">
          <Card>
            <SectionTitle>Three lowest metrics</SectionTitle>
            {call.lowest.length === 0 && <Text size="sm" c="dimmed">No metric scored below its target.</Text>}
            <Stack gap="md">
              {call.lowest.map((x) => {
                const m = metricBy(x.key), k = `m:${x.key}`;
                return (
                  <Stack key={x.key} gap={6} pb="sm" style={{ borderBottom: `1px solid ${p.line}` }}>
                    <Group justify="space-between" align="baseline" wrap="nowrap">
                      <Stack gap={0}><Text fw={600}>{m?.name ?? x.key}</Text>{m && <Text size="xs" c="dimmed">{DIMS.find((d) => d.key === m.dim)?.name} · target {m.target}</Text>}</Stack>
                      <Mono fz={20} fw={500} c={p.warnText}>{x.value}</Mono>
                    </Group>
                    {(x.why ?? m?.rationale) && <Text size="sm">{x.why ?? m?.rationale}</Text>}
                    {x.quote && <Blockquote p="xs" radius="md" color="gray" fz="sm" style={{ fontStyle: 'normal' }}>{x.turn !== null ? `#${x.turn} · ` : ''}“{x.quote}”</Blockquote>}
                    {m && <Mono size="xs" c="dimmed">{m.method}{m.runId ? ` · run ${m.runId}` : ''}{m.raw !== null ? ` · raw ${m.raw} ${m.unit}` : ''}</Mono>}
                    {(x.turn !== null || (m?.evidence.length ?? 0) > 0) && <Button size="xs" variant={focus === k ? 'filled' : 'default'} style={{ alignSelf: 'flex-start' }} onClick={() => toggleFocus(k)}>Highlight {m?.evidence.length ? `turn${m.evidence.length > 1 ? 's' : ''} ${m.evidence.join(', ')}` : `turn ${x.turn}`}</Button>}
                  </Stack>
                );
              })}
            </Stack>
          </Card>

          {call.coaching.length > 0 && (
            <Card>
              <SectionTitle note="What the agent should have done differently on this call.">Coaching</SectionTitle>
              <Stack gap="sm">
                {call.coaching.map((c, i) => (
                  <Paper key={i} withBorder p="sm" radius="md">
                    <Group justify="space-between" wrap="nowrap" align="flex-start"><Text size="sm" fw={600}>{c.title}</Text>{c.turn !== null && <Anchor component="button" size="xs" onClick={() => toggleFocus(`turn:${c.turn}`)}>#{c.turn}</Anchor>}</Group>
                    <Text size="sm" c="dimmed">{c.detail}</Text>
                    {c.suggestion && <Text size="sm" mt={4}><b>Better:</b> “{c.suggestion}”</Text>}
                  </Paper>
                ))}
              </Stack>
            </Card>
          )}

          {(call.recommendations.length > 0 || call.review.length > 0) && (
            <Card>
              {call.recommendations.length > 0 && (
                <>
                  <SectionTitle note="Fix proposals this call is evidence for.">Recommendations</SectionTitle>
                  <Stack gap={6} mb={call.review.length ? 'md' : 0}>
                    {call.recommendations.map((r) => (
                      <Group key={r.id} justify="space-between" wrap="nowrap" align="flex-start">
                        <Stack gap={0} style={{ minWidth: 0 }}><Text size="sm" fw={600}>{r.title}</Text><Text size="xs" c="dimmed">{r.kind} · {r.status.replace('_', ' ')} · priority {Math.round(r.priority)}</Text></Stack>
                        <Anchor component="button" size="xs" onClick={() => go('recommendations', { id: r.id })}>Open →</Anchor>
                      </Group>
                    ))}
                  </Stack>
                </>
              )}
              {call.review.length > 0 && (
                <>
                  <SectionTitle>Human review</SectionTitle>
                  <Stack gap={6}>
                    {call.review.map((r) => (
                      <Group key={r.id} justify="space-between" wrap="nowrap">
                        <Stack gap={0} style={{ minWidth: 0 }}><Text size="sm">{r.title}</Text><Text size="xs" c="dimmed">{r.reason}</Text></Stack>
                        <Badge size="sm" color={r.status === 'open' ? 'accent' : 'gray'} variant="light">{r.status === 'open' ? 'Open' : 'Resolved'}</Badge>
                      </Group>
                    ))}
                    {call.review.some((r) => r.status === 'open') && <Button size="xs" variant="default" style={{ alignSelf: 'flex-start' }} rightSection={<IconArrowRight size={14} />} onClick={() => go('review')}>Review queue</Button>}
                  </Stack>
                </>
              )}
            </Card>
          )}

          <Card>
            <SectionTitle right={<Mono size="xs" c="dimmed">trace {tr.id}</Mono>} note="Joined to this call on the conversation ID. Each agent turn, tool call and evaluator run is a span; open any agent turn’s trace from the transcript.">AI trace</SectionTitle>
            <SimpleGrid cols={3} spacing="xs" mb="sm">
              {[['Agent spans', tr.spans], ['LLM calls', tr.llmCalls], ['Tokens in / out', `${(tr.inTok / 1000).toFixed(1)}k / ${tr.outTok}`]].map(([k, v]) => (
                <Paper key={k as string} p="xs" bg={p.soft}><Text size="xs" c="dimmed">{k}</Text><Mono fz={15} fw={500}>{v}</Mono></Paper>
              ))}
            </SimpleGrid>
            {tr.n > 0 && (
              <>
                <Text size="xs" fw={600} c="dimmed" mb={4}>Where response latency goes · average per agent turn</Text>
                <Group gap={2} wrap="nowrap" h={14} style={{ borderRadius: 4, overflow: 'hidden' }} mb={6}>
                  {([['End-of-turn', tr.sums.eot, p.series.eot], ['LLM', tr.sums.llm, p.series.llm], ['Tool wait', tr.sums.tool, p.series.tool], ['TTS', tr.sums.tts, p.series.tts]] as [string, number, string][]).filter((b) => b[1] > 0).map(([l, v, c]) => <Box key={l} h="100%" style={{ flex: `${v / trTot} 1 0`, background: c }} />)}
                </Group>
                <Group gap="md" mb="sm">
                  {([['End-of-turn', tr.sums.eot, p.series.eot], ['LLM', tr.sums.llm, p.series.llm], ['Tool wait', tr.sums.tool, p.series.tool], ['TTS', tr.sums.tts, p.series.tts]] as [string, number, string][]).filter((b) => b[1] > 0).map(([l, v, c]) => (
                    <Group key={l} gap={5} wrap="nowrap"><Box w={10} h={10} style={{ background: c, borderRadius: 2 }} /><Text size="xs">{l} <Mono size="xs">{(v / tr.n).toFixed(2)} s</Mono></Text></Group>
                  ))}
                </Group>
              </>
            )}
            {tr.slowTurn && <Button size="xs" variant="default" mb="sm" onClick={() => { setTrace(tr.slowTurn!.id); setFocus(`turn:${tr.slowTurn!.id}`); setOnly(true); setPhase('all'); }}>Open the slowest turn · #{tr.slowTurn.id} · {tr.slowTurn.lat.toFixed(1)} s</Button>}
            {tr.evals.length > 0 && <Text size="xs" fw={600} c="dimmed" mb={4}>Evaluator runs on this call</Text>}
            {tr.evals.map(([k, v]) => <Group key={k} justify="space-between" wrap="nowrap"><Text size="sm">{k}</Text><Mono size="sm">{v}</Mono></Group>)}
            <Button variant="subtle" size="xs" mt="sm" px={0} rightSection={<IconArrowRight size={14} />} onClick={() => go('traces')}>Trace health across all calls</Button>
          </Card>

          <Card>
            <SectionTitle right={<Mono size="xs" c="dimmed">Taxonomy v{meta.taxonomyVersion}</Mono>}>Tags</SectionTitle>
            <Stack gap="xs">
              {call.tags.map((t) => {
                const k = `tag:${t.key}`, on = focus === k;
                return (
                  <UnstyledButton key={t.key} onClick={() => toggleFocus(k)} aria-pressed={on}>
                    <Paper withBorder p="sm" radius="md" bg={on ? p.hl : undefined} style={{ borderColor: on ? p.ink : undefined }}>
                      <Group justify="space-between" wrap="nowrap"><Text size="xs" c="dimmed">{t.label}</Text>{t.conf < 0.7 && t.layer !== 'human' && <Badge size="xs" color="accent">Under 0.7 · queued for review</Badge>}</Group>
                      <Text fw={600}>{t.value}</Text>
                      <Text size="xs" c="dimmed">Confidence {t.conf.toFixed(2)} · set by {t.layer}{t.ev.length ? ` · evidence turns ${t.ev.join(', ')}` : ''}</Text>
                    </Paper>
                  </UnstyledButton>
                );
              })}
            </Stack>
            {call.events.length > 0 && (
              <>
                <Text size="xs" fw={600} c="dimmed" mt="md" mb={6}>Events</Text>
                <Group gap={6}>{call.events.map((e, i) => <Button key={i} size="compact-sm" variant={focus === `ev:${i}` ? 'filled' : 'default'} onClick={() => toggleFocus(`ev:${i}`)}>{e.label} · #{e.turn}</Button>)}</Group>
              </>
            )}
            {call.facets.length > 0 && (
              <>
                <Text size="xs" fw={600} c="dimmed" mt="md" mb={6}>Facets</Text>
                <Group gap={6}>{call.facets.map(([k, v]) => <Badge key={k} variant="light" color="gray" tt="none" fw={500}>{k} · {v}</Badge>)}</Group>
              </>
            )}
          </Card>

          <Card>
            <SectionTitle note="Each dimension is scored and banded on its own, beside the CQS. Metrics with no opportunity in this call are left out, not scored as 100.">Dimensions and metrics</SectionTitle>
            <Accordion variant="separated" radius="md" chevronPosition="right">
              {DIMS.map((d) => {
                const r = call.dims[d.key];
                const ms = call.metrics.filter((m) => m.dim === d.key);
                return (
                  <Accordion.Item key={d.key} value={d.key}>
                    <Accordion.Control>
                      <Box style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 70px 30px 96px', gap: 10, alignItems: 'center' }}>
                        <Stack gap={0}><Text size="sm" fw={500}>{d.name}</Text><Text size="xs" c="dimmed">Weight {d.w} · {r ? `${r.n} metrics apply` : 'not in this call'}</Text></Stack>
                        <Bar value={r ? r.v : 0} color={r && r.v < 70 ? p.warn : p.bar} />
                        <Mono ta="right" fw={500} size="sm">{r ? Math.round(r.v) : 'n/a'}</Mono>
                        <Box ta="right">{r ? <BandBadge v={Math.round(r.v)} size="xs" /> : <Badge size="xs" color="gray">Not in call</Badge>}</Box>
                      </Box>
                    </Accordion.Control>
                    <Accordion.Panel>
                      <Stack gap={4}>
                        {ms.map((m) => (
                          <UnstyledButton key={m.key} onClick={() => m.evidence.length && toggleFocus(`m:${m.key}`)} style={{ cursor: m.evidence.length ? 'pointer' : 'default' }}>
                            <Group justify="space-between" wrap="nowrap" py={2}>
                              <Stack gap={0} style={{ minWidth: 0 }}>
                                <Text size="sm">{m.name}</Text>
                                <Text size="xs" c="dimmed">Target {m.target} · {m.method}{m.raw !== null ? ` · raw ${m.raw} ${m.unit}` : ''}{m.evidence.length ? ` · turns ${m.evidence.join(', ')}` : ''}</Text>
                                {m.rationale && m.value !== null && m.value < 70 && <Text size="xs">{m.rationale}</Text>}
                              </Stack>
                              <Mono size="sm" c={m.value === null ? 'dimmed' : m.value < 50 ? p.warnText : undefined} fw={m.value !== null && m.value < 50 ? 600 : 400}>{m.value === null ? 'n/a' : m.value}</Mono>
                            </Group>
                          </UnstyledButton>
                        ))}
                      </Stack>
                    </Accordion.Panel>
                  </Accordion.Item>
                );
              })}
            </Accordion>
          </Card>

          {call.path && (
            <Card>
              <SectionTitle note={`${call.path.scenario} · ${call.path.steps.filter((s) => s.hit).length} of ${call.path.steps.length} checkpoints reached in order`}>Path adherence</SectionTitle>
              <Timeline active={-1} bulletSize={22} lineWidth={2}>
                {call.path.steps.map((s) => (
                  <Timeline.Item key={s.label} bullet={s.hit ? <IconCheck size={13} /> : <IconX size={13} />} color={s.hit ? 'ink' : 'accent'} title={<Text size="sm" fw={500}>{s.label}</Text>}>
                    <Text size="xs" c={s.hit ? 'dimmed' : p.warnText} fw={s.hit ? 400 : 600}>{s.hit ? `Hit${s.turn !== null ? ` · #${s.turn}` : ''}` : `Missed${s.turn !== null ? ` · #${s.turn}` : ''}${call.path!.deviation === s.label ? ' — deviation point' : ''}`}</Text>
                  </Timeline.Item>
                ))}
              </Timeline>
            </Card>
          )}

          <Card>
            <SectionTitle>Captured fields and outcome</SectionTitle>
            <Box style={{ display: 'grid', gridTemplateColumns: '120px minmax(0,1fr)', rowGap: 5, columnGap: 12 }}>
              {call.fields.map(([k, v]) => [<Text key={k} size="sm" c="dimmed">{k}</Text>, <Text key={k + 'v'} size="sm" c={v === 'Not captured' ? p.warnText : undefined}>{v}</Text>])}
            </Box>
            <Box mt="sm" pt="sm" style={{ display: 'grid', gridTemplateColumns: '120px minmax(0,1fr)', rowGap: 5, columnGap: 12, borderTop: `1px solid ${p.line}` }}>
              {call.outcome.map(([k, v]) => [<Text key={k} size="sm" c="dimmed">{k}</Text>, <Text key={k + 'v'} size="sm" fw={600}>{v}</Text>])}
            </Box>
            {(call.crm.leadId || call.crm.outcomes.length > 0) && (
              <Box mt="sm" pt="sm" style={{ borderTop: `1px solid ${p.line}` }}>
                <Text size="xs" fw={600} c="dimmed" mb={4}>CRM{call.crm.leadId ? ` · lead ${call.crm.leadId}` : ''}</Text>
                {call.crm.outcomes.length === 0 && <Text size="sm" c="dimmed">No later stage recorded for this lead yet.</Text>}
                {call.crm.outcomes.map((o, i) => (
                  <Group key={i} justify="space-between" wrap="nowrap">
                    <Text size="sm">{o.stage}{o.credited ? '' : ' · not credited to this call'}</Text>
                    <Text size="sm" c="dimmed">{fmtWhen(o.at)}{o.valueAed ? ` · AED ${o.valueAed.toLocaleString('en-US')}` : ''}</Text>
                  </Group>
                ))}
              </Box>
            )}
          </Card>
        </Stack>
      </Box>
    </>
  );
}

function TurnRow({ t, spans, hl, seg, open, onTrace }: { t: TurnDTO; spans: SpanDTO[] | null; hl: boolean; seg: string; open: boolean; onTrace: () => void }) {
  const p = usePal();
  const isA = t.sp === 'A';
  const colors: Record<string, string> = { eot: p.series.eot, llm: p.series.llm, tool: p.series.tool, tts: p.series.tts, bg: p.scale.nrHi[0] };
  const win = spans && spans.length ? Math.max(...spans.map((r) => r.start + r.dur)) || 1 : 1;
  const speech = spans?.filter((r) => r.kind !== 'bg').reduce((a, r) => Math.max(a, r.start + r.dur), 0) ?? 0;
  return (
    <Paper className="turn-row" withBorder p="sm" radius="md" bg={hl ? p.hl : isA ? undefined : p.soft} style={{ borderColor: hl ? p.warn : undefined }}>
      <Box style={{ display: 'grid', gridTemplateColumns: '46px minmax(0,1fr)', gap: 10 }}>
        <Stack gap={2}><Mono size="xs" c="dimmed">#{t.id}</Mono><Mono size="xs" c="dimmed">{fmtTime(t.t)}</Mono></Stack>
        <Stack gap={6} style={{ minWidth: 0 }}>
          <Group gap={6} wrap="wrap">
            <Text size="xs" fw={700}>{isA ? 'Agent' : 'Caller'}</Text>
            {seg && <Badge size="xs" color="gray" variant="light" tt="none">{seg}</Badge>}
            {t.lat !== undefined && t.lat !== null && <Badge size="xs" color={t.lat > 2.5 ? 'accent' : 'gray'} variant="light" tt="none">{t.lat.toFixed(1)} s</Badge>}
            {t.tag && <Badge size="xs" color="ink" variant="outline" tt="none">[{t.tag}]</Badge>}
            {t.barge && <Badge size="xs" color="accent" variant="light" tt="none">Barge-in · {t.barge}</Badge>}
            {t.event && <Badge size="xs" color="accent" variant={t.event === 'Gate failure' ? 'filled' : 'light'} tt="none">{t.event}</Badge>}
          </Group>
          <Text size="sm" style={{ textWrap: 'pretty' }}>{t.text}</Text>
          {(t.tools ?? []).map((tc, i) => (
            <Paper key={i} bg={p.soft} p={6} radius="sm"><Mono size="xs" style={{ overflowWrap: 'anywhere' }} c={tc.ok === false ? p.warnText : undefined}>→ {tc.name}({tc.args}) · {tc.result}{tc.durationS !== null && tc.durationS !== undefined ? ` · ${tc.durationS.toFixed(2)} s` : ''}</Mono></Paper>
          ))}
          {isA && <Button size="compact-xs" variant={open ? 'filled' : 'default'} leftSection={<IconListDetails size={13} />} style={{ alignSelf: 'flex-start' }} onClick={onTrace} aria-expanded={open}>{open ? 'Hide trace' : 'Trace'}</Button>}
          {open && (
            <Paper p="sm" radius="md" bg={p.soft} withBorder>
              {!spans || spans.length === 0 ? <Text size="xs" c="dimmed">The provider didn’t report a timing breakdown for this turn{t.lat !== null && t.lat !== undefined ? `; response latency was ${t.lat.toFixed(2)} s` : ''}.</Text> : (
                <>
                  <Text size="xs" fw={600} mb={6}>Trace · {t.lat !== null && t.lat !== undefined ? `response latency ${t.lat.toFixed(2)} s` : `audio after ${speech.toFixed(2)} s`}</Text>
                  <Stack gap={5}>
                    {spans.map((r, i) => (
                      <Box key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.15fr) minmax(0,1.4fr) 52px', gap: 10, alignItems: 'center' }}>
                        <Text size="xs" truncate title={r.label}>{r.label}</Text>
                        <Box pos="relative" h={12} style={{ borderRadius: 3, background: p.track }}>
                          <Box pos="absolute" top={0} bottom={0} style={{ left: `${(r.start / win) * 100}%`, width: `${Math.max(0.8, (r.dur / win) * 100)}%`, borderRadius: 3, background: colors[r.kind] }} />
                        </Box>
                        <Mono size="xs" ta="right">{r.dur.toFixed(2)} s</Mono>
                      </Box>
                    ))}
                  </Stack>
                </>
              )}
            </Paper>
          )}
        </Stack>
      </Box>
    </Paper>
  );
}
