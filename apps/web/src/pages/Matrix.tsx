import { useEffect, useState } from 'react';
import { Badge, Box, Button, Card, Group, Paper, SegmentedControl, Select, SimpleGrid, Stack, Table, Text, Title, Tooltip, UnstyledButton } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import { DIMS, dimName, type CellDTO, type CellDetailDTO, type DimKey, type MatrixDTO } from '@calleval/framework';
import { useMeta, useStore } from '../store';
import { scoreColor, usePal } from '../theme';
import { filterQs, useApi } from '../api';
import { AgentSelect, Bar, BandBadge, DirectionSelect, EmptyState, ErrorState, Legend, Loading, Mono, PageHeader, PathSelect, RangeSelect, SCORE_OPTIONS, SectionTitle, StatCard, VersionSelect, fmtDuration, fmtWhen, weightedMedian } from '../components/ui';

type Measure = 'cqs' | 'calls' | 'gate';

export function MatrixPage() {
  const { filters, params, go } = useStore();
  const meta = useMeta();
  const p = usePal();
  const [measure, setMeasure] = useState<Measure>('cqs');
  const [score, setScore] = useState<string>(params.score ?? 'cqs');
  const [sel, setSel] = useState<string>(params.sel ?? '');
  useEffect(() => { if (params.score) setScore(params.score); if (params.sel) setSel(params.sel); }, [params]);
  const minN = meta.settings.minCellCalls || 30;

  const m = useApi<MatrixDTO>(`/api/matrix${filterQs(filters)}`);
  const cells = m.data?.cells ?? [];
  const PERSONAS = meta.personas, SCENARIOS = meta.scenarios;
  const cellAt = (pid: string, sid: string) => cells.find((c) => c.pid === pid && c.sid === sid) ?? null;

  // Default to the biggest cell below the Good line, else the biggest cell.
  let [spid, ssid] = sel ? sel.split('|') : ['', ''];
  if (!cellAt(spid, ssid) && cells.length) {
    const big = [...cells].sort((a, b) => b.n - a.n);
    const pick = big.find((c) => c.n >= minN && c.cqs < 70) ?? big[0];
    spid = pick.pid; ssid = pick.sid;
  }
  const c = cellAt(spid, ssid);
  const detail = useApi<CellDetailDTO>(c ? `/api/cells/${encodeURIComponent(spid)}/${encodeURIComponent(ssid)}${filterQs(filters)}` : null);

  const sv = (x: CellDTO) => (score === 'cqs' ? x.cqs : x.dims[score as DimKey]);
  const visiblePersonas = PERSONAS.filter((x) => filters.path === 'all' || x.path === filters.path);
  const all = cells.filter((x) => visiblePersonas.some((vp) => vp.id === x.pid));
  const calls = all.reduce((a, x) => a + x.n, 0);
  const med = all.length ? weightedMedian(all, sv) : 0;
  const gate = calls ? all.reduce((a, x) => a + x.gate * x.n, 0) / calls : 0;

  const colorFor = (cl: CellDTO): [string, string] => {
    const thin = cl.n < minN;
    if (measure === 'calls') {
      if (cl.n >= 200) return p.scale.exc as [string, string];
      if (cl.n >= 100) return p.scale.goodHi as [string, string];
      if (cl.n >= minN) return p.scale.goodLo as [string, string];
      return p.thin as [string, string];
    }
    if (thin) return p.thin as [string, string];
    if (measure === 'gate') {
      if (cl.gate >= 6) return p.scale.fail as [string, string];
      if (cl.gate >= 3) return p.scale.nrLo as [string, string];
      if (cl.gate >= 1) return p.scale.nrHi as [string, string];
      return p.scale.goodLo as [string, string];
    }
    return scoreColor(p, sv(cl));
  };

  const groups: [string, string[]][] = [
    ['Investor path', PERSONAS.filter((x) => x.path === 'Investor').map((x) => x.id)],
    ['Broker path', PERSONAS.filter((x) => x.path === 'Broker').map((x) => x.id)],
    ['Non-target', PERSONAS.filter((x) => x.path === 'Non-target').map((x) => x.id)],
  ];
  const legend = measure === 'calls'
    ? [{ label: `${minN}–99`, color: p.scale.goodLo[0] }, { label: '100–199', color: p.scale.goodHi[0] }, { label: '200+', color: p.scale.exc[0] }, { label: `Under ${minN} · not compared`, color: p.thin[0], border: p.line }]
    : measure === 'gate'
      ? [{ label: 'Under 1%', color: p.scale.goodLo[0] }, { label: '1–3%', color: p.scale.nrHi[0] }, { label: '3–6%', color: p.scale.nrLo[0] }, { label: '6%+', color: p.scale.fail[0] }, { label: `Under ${minN} calls`, color: p.thin[0], border: p.line }]
      : [{ label: 'Fail · under 50', color: p.scale.fail[0] }, { label: 'Needs review · 50–69', color: p.scale.nrHi[0] }, { label: 'Good · 70–84', color: p.scale.goodLo[0] }, { label: 'Excellent · 85+', color: p.scale.exc[0] }, { label: `Under ${minN} calls`, color: p.thin[0], border: p.line }];

  const cols = `200px repeat(${SCENARIOS.length}, minmax(64px, 1fr))`;
  const verLabel = filters.ver === 'live' ? (meta.liveVersion ?? 'live') : filters.ver;
  const header = (
    <PageHeader
      eyebrow="Technical view · Refreshed daily"
      title="Quality matrix"
      description="Median Call Quality Score, or any one of its seven dimensions, for every persona × scenario cell. One overall average hides an agent that handles family buyers well but fumbles brokers."
      right={<Group gap="sm" wrap="wrap" align="flex-end"><RangeSelect /><DirectionSelect /><PathSelect />
        <Select label="Score" size="sm" w={190} data={SCORE_OPTIONS} value={score} onChange={(v) => { if (v) { setScore(v); setMeasure('cqs'); } }} />
        <VersionSelect /><AgentSelect /></Group>}
    />
  );
  if (m.error && !m.data) return <>{header}<ErrorState error={m.error} onRetry={m.reload} /></>;
  if (!m.data) return <>{header}<Loading /></>;
  if (!cells.length) return <>{header}<EmptyState /></>;

  const persona = PERSONAS.find((x) => x.id === spid), scen = SCENARIOS.find((x) => x.id === ssid);
  const low = c ? DIMS.reduce((a, d) => (c.dims[d.key] < c.dims[a.key] ? d : a), DIMS[0]) : DIMS[0];
  const path = detail.data?.path ?? [];
  const tools = detail.data?.tools ?? [];

  return (
    <>
      {header}

      <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} mb="lg">
        <StatCard label="Calls scored" value={calls.toLocaleString('en-US')} />
        <StatCard label={`Median ${dimName(score)}`} value={<Group gap="sm" component="span"><span>{med}</span><BandBadge v={med} size="sm" /></Group>} />
        <StatCard label="Gate-failure rate" value={gate.toFixed(1) + '%'} />
        <StatCard label={`Cells compared (${minN}+ calls)`} value={`${all.filter((x) => x.n >= minN).length} of ${all.length}`} />
      </SimpleGrid>

      <Group justify="space-between" mb="sm" wrap="wrap" gap="sm">
        <SegmentedControl value={measure} onChange={(v) => setMeasure(v as Measure)} data={[{ value: 'cqs', label: score === 'cqs' ? 'Median CQS' : 'Median score' }, { value: 'calls', label: 'Call count' }, { value: 'gate', label: 'Gate-failure rate' }]} />
        <Legend items={legend} />
      </Group>

      <Card mb="lg" padding="md" style={{ overflowX: 'auto' }}>
        <Box miw={1020}>
          <Box style={{ display: 'grid', gridTemplateColumns: cols, gap: 4, alignItems: 'end' }} mb={4}>
            <Text size="xs" c="dimmed" pb={6}>Persona ↓ · Scenario →</Text>
            {SCENARIOS.map((s) => (
              <Tooltip key={s.id} label={`${s.id} ${s.name} · success: ${s.success}`} multiline maw={260}>
                <Stack gap={0} pb={6} px={2}><Mono size="xs" fw={500}>{s.id}</Mono><Text size="xs" c="dimmed" lh={1.25}>{s.short}</Text></Stack>
              </Tooltip>
            ))}
          </Box>
          {groups.filter(([label]) => filters.path === 'all' || label.startsWith(filters.path)).map(([label, ids]) => (
            <Box key={label}>
              <Text size="xs" fw={600} tt="uppercase" c="dimmed" pt="sm" pb={4} style={{ letterSpacing: '0.08em' }}>{label}</Text>
              {ids.map((pid) => {
                const pr = PERSONAS.find((x) => x.id === pid)!;
                const rowCalls = cells.filter((x) => x.pid === pid).reduce((a, x) => a + x.n, 0);
                return (
                  <Box key={pid} style={{ display: 'grid', gridTemplateColumns: cols, gap: 4 }} mb={4}>
                    <Stack gap={0} justify="center" pr="xs" mih={52}>
                      <Text size="sm" fw={600} lh={1.25}><Mono c="dimmed" fw={500}>{pr.id}</Mono> {pr.name}</Text>
                      <Text size="xs" c="dimmed">{rowCalls.toLocaleString('en-US')} calls</Text>
                    </Stack>
                    {SCENARIOS.map((s) => {
                      const cl = cellAt(pid, s.id);
                      if (!cl) return <Box key={s.id} mih={52} style={{ borderRadius: 10, border: `1px dashed ${p.line}` }} aria-hidden />;
                      const [bg, fg] = colorFor(cl);
                      const on = pid === spid && s.id === ssid;
                      const main = measure === 'calls' ? cl.n : measure === 'gate' ? cl.gate.toFixed(1) : sv(cl);
                      const sub = measure === 'calls' ? (cl.n < minN ? `under ${minN}` : '') : `n ${cl.n}`;
                      return (
                        <Tooltip key={s.id} label={`${pid} × ${s.id} · CQS ${cl.cqs} · ${cl.n} calls · gate ${cl.gate.toFixed(1)}%${cl.n < minN ? ` · under ${minN} calls, not compared` : ''}`}>
                          <UnstyledButton
                            className="cell-btn"
                            onClick={() => setSel(`${pid}|${s.id}`)}
                            aria-pressed={on}
                            aria-label={`${pr.name} × ${s.name}: ${main}`}
                            style={{ minHeight: 52, borderRadius: 10, background: bg, color: fg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', outline: on ? `2px solid ${p.ink}` : cl.n < minN ? `1px dashed ${p.barMuted}` : 'none', outlineOffset: on ? 1 : -1 }}
                          >
                            <Mono fz={16} fw={500} lh={1.2}>{main}</Mono>
                            <Text fz={11} lh={1.2} style={{ opacity: 0.85 }}>{sub}</Text>
                          </UnstyledButton>
                        </Tooltip>
                      );
                    })}
                  </Box>
                );
              })}
            </Box>
          ))}
        </Box>
      </Card>

      {c && persona && scen && (
        <Card padding="xl">
          <Group justify="space-between" align="flex-start" wrap="wrap" mb="lg">
            <Stack gap={4}>
              <Text size="xs" fw={600} tt="uppercase" c="dimmed" style={{ letterSpacing: '0.07em' }}>Selected cell</Text>
              <Title order={2} fz={21}>{persona.id} {persona.name} × {scen.id} {scen.name}</Title>
              <Text c="dimmed" size="sm">{c.n.toLocaleString('en-US')} calls · {persona.path} path · gate failures {c.gate.toFixed(1)}% · next step {c.ns.toFixed(0)}% · prompt {verLabel}</Text>
              {c.n < minN && <Text size="sm" c={p.warnText}>Fewer than {minN} calls in this cell — shown for reference, not compared.</Text>}
            </Stack>
            <Group gap="md"><Stack gap={0} align="flex-end"><Text size="xs" c="dimmed">Median CQS</Text><Mono fz={36} fw={500} lh={1}>{c.cqs}</Mono></Stack><BandBadge v={c.cqs} size="lg" /></Group>
          </Group>

          <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="xl">
            <Stack gap="sm">
              <SectionTitle note="The seven dimension scores, so a low cell shows which dimension pulls it down. The tick marks the Good line at 70.">Dimension profile</SectionTitle>
              {DIMS.map((d) => {
                const v = c.dims[d.key], isLow = d.key === low.key;
                return (
                  <Box key={d.key} style={{ display: 'grid', gridTemplateColumns: '170px minmax(0,1fr) 36px', gap: 12, alignItems: 'center' }}>
                    <Stack gap={0}><Text size="sm" fw={500}>{d.name}</Text><Text size="xs" c={isLow ? p.warnText : 'dimmed'}>{isLow ? `Pulls this cell down · weight ${d.w}` : `Weight ${d.w}`}{d.key === score ? ' · in the grid' : ''}</Text></Stack>
                    <Bar value={v} marker={70} color={isLow ? p.warn : p.bar} height={10} />
                    <Mono ta="right" fw={500}>{v}</Mono>
                  </Box>
                );
              })}
              <Paper p="md" bg={p.soft} mt="xs">
                <Text size="xs" fw={600} c="dimmed">Persona check · watch for</Text>
                <Text size="sm">{persona.watch}</Text>
                {detail.data?.personaCheck && <Text size="sm" c="dimmed">{detail.data.personaCheck.label}: <Mono c={p.ink} fw={500}>{detail.data.personaCheck.value}</Mono></Text>}
              </Paper>
            </Stack>

            <Stack gap="lg">
              {detail.error && <ErrorState error={detail.error} onRetry={detail.reload} />}
              {!detail.data && !detail.error && <Loading label="Loading the cell…" />}
              {detail.data && (
                <>
                  <Box>
                    <SectionTitle note={path.length ? <>Share of calls reaching each checkpoint of the expected path, in order. <b>{path[path.length - 1].pct}%</b> followed it to the end. Success: {scen.success.toLowerCase()}.</> : 'No checkpoints recorded for this cell yet.'}>Path adherence · {scen.id} {scen.name}</SectionTitle>
                    <Stack gap={8}>
                      {path.map((s, k) => (
                        <Box key={s.label} style={{ display: 'grid', gridTemplateColumns: '22px minmax(0,1fr) 46px', gap: 10, alignItems: 'center' }}>
                          <Mono size="xs" c="dimmed">{k + 1}</Mono>
                          <Stack gap={4}>
                            <Group gap={8} wrap="wrap"><Text size="sm">{s.label}</Text>{s.exit && <Badge size="xs" color="accent">Most common exit</Badge>}</Group>
                            <Bar value={s.pct} color={s.exit ? p.warn : p.bar} height={6} />
                          </Stack>
                          <Mono size="sm" ta="right">{s.pct}%</Mono>
                        </Box>
                      ))}
                    </Stack>
                  </Box>
                  <Box>
                    <SectionTitle note="Targets: precision 95%+, recall 90%+, result fidelity 100%. Values below target are marked ↓.">Tool health</SectionTitle>
                    {tools.length === 0 ? <Text size="sm" c="dimmed">No tool calls expected or made in this cell.</Text> : (
                      <Table withTableBorder withRowBorders striped={false} fz="sm">
                        <Table.Thead><Table.Tr><Table.Th>Tool</Table.Th><Table.Th ta="right">Calls</Table.Th><Table.Th ta="right">Precision</Table.Th><Table.Th ta="right">Recall</Table.Th><Table.Th ta="right">Fidelity</Table.Th></Table.Tr></Table.Thead>
                        <Table.Tbody>
                          {tools.map((t) => (
                            <Table.Tr key={t.name}>
                              <Table.Td><Mono size="xs">{t.name}</Mono></Table.Td>
                              <Table.Td ta="right"><Mono size="sm">{t.n}</Mono></Table.Td>
                              {([[t.p, 95], [t.r, 90], [t.f, 100]] as [number | null, number][]).map(([v, tgt], i) => (
                                <Table.Td key={i} ta="right">{v === null ? <Mono size="sm" c="dimmed">—</Mono> : <Mono size="sm" c={v < tgt ? p.warnText : undefined} fw={v < tgt ? 600 : 400}>{v < tgt ? '↓ ' : ''}{Math.round(v)}%</Mono>}</Table.Td>
                              ))}
                            </Table.Tr>
                          ))}
                        </Table.Tbody>
                      </Table>
                    )}
                  </Box>
                  {detail.data.calls.length > 0 && (
                    <Box>
                      <SectionTitle note="Lowest-scoring calls in this cell first.">Calls in this cell</SectionTitle>
                      <Stack gap={0}>
                        {detail.data.calls.slice(0, 6).map((cl) => (
                          <UnstyledButton key={cl.id} onClick={() => go('calls', { id: cl.id })}>
                            <Group justify="space-between" wrap="nowrap" py={6} style={{ borderBottom: `1px solid ${p.line}` }}>
                              <Stack gap={0} style={{ minWidth: 0 }}>
                                <Mono size="sm" fw={500}>{cl.externalId || cl.id}</Mono>
                                <Text size="xs" c="dimmed" truncate>{fmtWhen(cl.startedAt)} · {fmtDuration(cl.durationS)}{cl.gates.length ? ` · gate ${cl.gates.join(', ')}` : ''}{cl.note ? ` · ${cl.note}` : ''}</Text>
                              </Stack>
                              <Group gap={6} wrap="nowrap">{cl.cqs !== null && <><Mono fw={500}>{cl.cqs}</Mono><BandBadge v={cl.cqs} size="xs" /></>}</Group>
                            </Group>
                          </UnstyledButton>
                        ))}
                      </Stack>
                    </Box>
                  )}
                </>
              )}
              <Group gap="sm">
                <Button variant="default" rightSection={<IconArrowRight size={16} />} onClick={() => go('calls', { persona: spid, scenario: ssid })}>Open calls in this cell</Button>
                <Button variant="default" rightSection={<IconArrowRight size={16} />} onClick={() => go('fix')}>See it on the fix-first map</Button>
              </Group>
            </Stack>
          </SimpleGrid>
        </Card>
      )}
    </>
  );
}
