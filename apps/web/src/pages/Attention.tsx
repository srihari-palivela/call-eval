import { useEffect, useMemo, useState } from 'react';
import { Badge, Box, Button, Card, Group, Paper, SegmentedControl, Select, SimpleGrid, Stack, Table, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import { DIMS, DimKey, type CellDTO, type MatrixDTO } from '@calleval/framework';
import { useStore, useMeta } from '../store';
import { scoreColor, usePal } from '../theme';
import { filterQs, useApi } from '../api';
import { Agg, AgentSelect, Bar, BandBadge, Delta, DirectionSelect, EmptyState, ErrorState, Loading, Mono, PageHeader, RangeSelect, SectionTitle, StatCard, aggregate } from '../components/ui';

type Item = { key: string; kind: 'Dimension' | 'Persona' | 'Scenario' | 'Cell'; name: string; sub: string; v: number; n: number; impact: number; go: [any, Record<string, string>] };
type AggP = (Agg & { prev: Agg | null }) | null;

export function AttentionPage() {
  const { filters, queue, setOwner, setStatus, setOpenAttention, go } = useStore();
  const meta = useMeta();
  const p = usePal();
  const [line, setLine] = useState('70');
  const [axis, setAxis] = useState<'persona' | 'scenario'>('persona');
  const [sel, setSel] = useState('');
  const [kind, setKind] = useState('all');
  const [more, setMore] = useState(false);
  const T = Number(line) || 70;
  const minN = meta.settings.minCellCalls || 30;
  const range = filters.range === '7' ? '30' : filters.range;

  const cur = useApi<MatrixDTO>(`/api/matrix${filterQs({ ...filters, range }, { ver: 'live' })}`);
  const prev = useApi<MatrixDTO>(meta.previousVersion ? `/api/matrix${filterQs({ ...filters, range }, { ver: meta.previousVersion })}` : null);

  const PERSONAS = meta.personas, SCENARIOS = meta.scenarios;

  const data = useMemo(() => {
    const cells = cur.data?.cells ?? [];
    const prevCells = prev.data?.cells ?? [];
    const prevOf = (c: CellDTO) => prevCells.find((x) => x.pid === c.pid && x.sid === c.sid);
    const aggWithPrev = (list: CellDTO[]): AggP => {
      const a = aggregate(list);
      if (!a) return null;
      const paired = list.map((c) => { const o = prevOf(c); return o ? { ...o, n: c.n } : null; }).filter(Boolean) as CellDTO[];
      return { ...a, prev: paired.length ? aggregate(paired) : null };
    };
    const pAgg = PERSONAS.map((x) => aggWithPrev(cells.filter((c) => c.pid === x.id)));
    const sAgg = SCENARIOS.map((x) => aggWithPrev(cells.filter((c) => c.sid === x.id)));
    const all = aggWithPrev(cells);
    return { cells, pAgg, sAgg, all };
  }, [cur.data, prev.data, PERSONAS, SCENARIOS]);

  const { cells, pAgg, sAgg, all } = data;
  const weakOf = (a: Agg) => DIMS.reduce((w, d) => (a.dims[d.key] < a.dims[w.key] ? d : w), DIMS[0]);

  const items: Item[] = [];
  if (all) {
    pAgg.forEach((a, i) => { if (a && a.n >= minN && a.cqs < T) items.push({ key: 'p' + PERSONAS[i].id, kind: 'Persona', name: `${PERSONAS[i].id} ${PERSONAS[i].name}`, sub: `Weakest: ${weakOf(a).name}`, v: a.cqs, n: a.n, impact: 0, go: ['matrix', {}] }); });
    sAgg.forEach((a, i) => { if (a && a.n >= minN && a.cqs < T) items.push({ key: 's' + SCENARIOS[i].id, kind: 'Scenario', name: `${SCENARIOS[i].id} ${SCENARIOS[i].name}`, sub: `Weakest: ${weakOf(a).name}`, v: a.cqs, n: a.n, impact: 0, go: ['matrix', {}] }); });
    cells.forEach((c) => {
      if (c.n >= minN && c.cqs < T) {
        const w = DIMS.reduce((x, d) => (c.dims[d.key] < c.dims[x.key] ? d : x), DIMS[0]);
        const pn = PERSONAS.find((x) => x.id === c.pid)?.name ?? c.pid, sn = SCENARIOS.find((x) => x.id === c.sid)?.name ?? c.sid;
        items.push({ key: `c${c.pid}_${c.sid}`, kind: 'Cell', name: `${c.pid} ${pn} × ${c.sid} ${sn}`, sub: `Weakest: ${w.name} ${c.dims[w.key]}`, v: c.cqs, n: c.n, impact: 0, go: ['matrix', { sel: `${c.pid}|${c.sid}` }] });
      }
    });
    DIMS.forEach((d) => {
      pAgg.forEach((a, i) => { if (a && a.n >= minN && a.dims[d.key] < T) items.push({ key: `dp${PERSONAS[i].id}${d.key}`, kind: 'Dimension', name: `${d.name} · ${PERSONAS[i].id} ${PERSONAS[i].name}`, sub: `Driven by ${d.drivers}`, v: a.dims[d.key], n: a.n, impact: 0, go: ['matrix', { score: d.key }] }); });
      sAgg.forEach((a, i) => { if (a && a.n >= minN && a.dims[d.key] < T) items.push({ key: `ds${SCENARIOS[i].id}${d.key}`, kind: 'Dimension', name: `${d.name} · ${SCENARIOS[i].id} ${SCENARIOS[i].name}`, sub: `Driven by ${d.drivers}`, v: a.dims[d.key], n: a.n, impact: 0, go: ['matrix', { score: d.key }] }); });
    });
    items.forEach((it) => { it.impact = Math.round(it.n * (T - it.v)); });
    items.sort((a, b) => b.impact - a.impact);
  }
  const openItems = items.filter((it) => !['done', 'wont'].includes(queue.statuses[it.key] ?? 'open')).length;
  useEffect(() => { setOpenAttention(openItems); }, [openItems, setOpenAttention]);

  const isP = axis === 'persona';
  const defs = isP ? PERSONAS : SCENARIOS;
  const aggs = isP ? pAgg : sAgg;
  useEffect(() => {
    // Default selection: the lowest dimension cell with enough calls on this axis.
    if (!all || (sel && defs.some((d) => sel.startsWith(d.id + '|')))) return;
    let best: { k: string; v: number } | null = null;
    aggs.forEach((a, i) => { if (a && a.n >= minN) DIMS.forEach((d) => { if (!best || a.dims[d.key] < best.v) best = { k: `${defs[i].id}|${d.key}`, v: a.dims[d.key] }; }); });
    if (best) setSel((best as { k: string }).k);
  }, [all, axis]); // eslint-disable-line react-hooks/exhaustive-deps

  if (cur.error && !cur.data) return <><Header line={line} setLine={setLine} /><ErrorState error={cur.error} onRetry={cur.reload} /></>;
  if (!cur.data) return <><Header line={line} setLine={setLine} /><Loading /></>;
  if (!all) return <><Header line={line} setLine={setLine} /><EmptyState /></>;

  const dimList = DIMS.map((d) => {
    const v = all.dims[d.key];
    const big = (arr: AggP[]) => arr.map((a, i) => ({ a, i })).filter((x) => x.a && x.a.n >= minN);
    const wp = big(pAgg).sort((x, y) => x.a!.dims[d.key] - y.a!.dims[d.key])[0];
    const ws = big(sAgg).sort((x, y) => x.a!.dims[d.key] - y.a!.dims[d.key])[0];
    return { d, v, prev: all.prev?.dims[d.key] ?? null, below: v < T, wp: wp ? `${PERSONAS[wp.i].id} ${wp.a!.dims[d.key]}` : '—', ws: ws ? `${SCENARIOS[ws.i].id} ${ws.a!.dims[d.key]}` : '—' };
  });

  const listBelow = (list: AggP[], ds: { id: string; name: string }[]) => list
    .map((a, i) => ({ a, i })).filter((x) => x.a && x.a.n >= minN && x.a.cqs < T).sort((x, y) => x.a!.cqs - y.a!.cqs)
    .map((x) => ({ id: ds[x.i].id, name: ds[x.i].name, a: x.a!, weak: weakOf(x.a!) }));
  const pList = listBelow(pAgg, PERSONAS), sList = listBelow(sAgg, SCENARIOS);

  const counts = { all: items.length, Dimension: 0, Persona: 0, Scenario: 0, Cell: 0 } as Record<string, number>;
  items.forEach((it) => { counts[it.kind]++; });
  const filtered = items.filter((it) => kind === 'all' || it.kind === kind);
  const shown = more ? filtered : filtered.slice(0, 12);

  const [selId, selDim] = sel.split('|');
  const selIdx = defs.findIndex((d) => d.id === selId);
  const selAgg = selIdx >= 0 ? aggs[selIdx] : null;
  const worst = selAgg && selDim ? cells.filter((c) => (isP ? c.pid : c.sid) === selId && c.n >= 10).sort((a, b) => a.dims[selDim as DimKey] - b.dims[selDim as DimKey]).slice(0, 3) : [];

  const cellsBig = cells.filter((c) => c.n >= minN), cellsLow = cellsBig.filter((c) => c.cqs < T);
  const callsLow = cellsLow.reduce((a, c) => a + c.n, 0);
  const weakest = [...dimList].sort((a, b) => a.v - b.v)[0];
  const kindColor: Record<string, string> = { Persona: 'ink', Scenario: 'ink', Cell: 'accent', Dimension: 'gray' };
  const prevLabel = meta.previousVersion ? `prompt ${meta.previousVersion}` : null;

  return (
    <>
      <Header line={line} setLine={setLine} />

      <SimpleGrid cols={{ base: 1, xs: 2, lg: 5 }} mb="lg">
        <StatCard label="Weakest dimension" value={`${weakest.d.name} ${weakest.v}`} note={`${dimList.filter((d) => d.below).length} of 7 dimensions below ${T} overall`} tone={weakest.v < T ? 'warn' : undefined} />
        <StatCard label="Personas below the line" value={`${pList.length} of ${pAgg.filter((a) => a && a.n >= minN).length}`} note={`With ${minN} or more calls`} />
        <StatCard label="Scenarios below the line" value={`${sList.length} of ${sAgg.filter((a) => a && a.n >= minN).length}`} note={`With ${minN} or more calls`} />
        <StatCard label="Cells below the line" value={`${cellsLow.length} of ${cellsBig.length}`} note={`Persona × scenario, ${minN}+ calls`} />
        <StatCard label="Calls in those cells" value={callsLow.toLocaleString('en-US')} note={`${Math.round((callsLow / all.n) * 100)}% of all calls`} />
      </SimpleGrid>

      <SimpleGrid cols={{ base: 1, md: 3 }} mb="lg">
        <Card>
          <SectionTitle note="Across all calls, with the persona and scenario that pull each one down most.">Dimensions</SectionTitle>
          <Stack gap={10}>
            {dimList.map((x) => (
              <Box key={x.d.key}>
                <Box style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 80px 30px 44px', gap: 8, alignItems: 'center' }}>
                  <Text size="sm" fw={x.below ? 700 : 500} c={x.below ? p.warnText : undefined}>{x.d.name}</Text>
                  <Bar value={x.v} marker={T} color={x.below ? p.warn : p.bar} />
                  <Mono ta="right" fw={500} size="sm">{x.v}</Mono>
                  <Box ta="right"><Delta now={x.v} prev={x.prev} /></Box>
                </Box>
                <Text size="xs" c="dimmed">Lowest: {x.wp} · {x.ws}</Text>
              </Box>
            ))}
          </Stack>
        </Card>
        {([['Personas below the line', pList], ['Scenarios below the line', sList]] as [string, typeof pList][]).map(([title, list]) => (
          <Card key={title}>
            <SectionTitle note={`Call-weighted CQS across their cells${prevLabel ? `; change is against ${prevLabel}` : ''}.`}>{title}</SectionTitle>
            {list.length === 0 && <Text size="sm" c="dimmed">Nothing is below the line.</Text>}
            <Stack gap={0}>
              {list.map((r) => (
                <Group key={r.id} justify="space-between" wrap="nowrap" py={8} style={{ borderBottom: `1px solid ${p.line}` }}>
                  <Stack gap={0} style={{ minWidth: 0 }}>
                    <Text size="sm" fw={600}><Mono c="dimmed" fw={500}>{r.id}</Mono> {r.name}</Text>
                    <Text size="xs" c="dimmed">{r.a.n.toLocaleString('en-US')} calls · weakest {r.weak.name.toLowerCase()} {r.a.dims[r.weak.key]}</Text>
                  </Stack>
                  <Group gap="xs" wrap="nowrap"><Mono fw={500}>{r.a.cqs}</Mono><Delta now={r.a.cqs} prev={r.a.prev?.cqs} /></Group>
                </Group>
              ))}
            </Stack>
          </Card>
        ))}
      </SimpleGrid>

      <Card mb="lg">
        <SectionTitle
          note={`Outlined cells are below the line. Grey cells have fewer than ${minN} calls. Select a cell to see what drives it.`}
          right={<SegmentedControl value={axis} onChange={(v) => { setAxis(v as any); setSel(''); }} data={[{ value: 'persona', label: 'By persona' }, { value: 'scenario', label: 'By scenario' }]} />}
        >Dimension scores by {axis}</SectionTitle>
        <Box style={{ overflowX: 'auto' }}>
          <Box miw={980}>
            <Box style={{ display: 'grid', gridTemplateColumns: `170px repeat(${defs.length}, minmax(0,1fr))`, gap: 4, alignItems: 'end' }} mb={4}>
              <Text size="xs" c="dimmed">Dimension ↓</Text>
              {defs.map((d: any) => <Stack key={d.id} gap={0} px={2}><Mono size="xs" fw={500}>{d.id}</Mono><Text fz={11} c="dimmed" lh={1.2}>{isP ? d.name : d.short}</Text></Stack>)}
            </Box>
            {DIMS.map((dm) => (
              <Box key={dm.key} style={{ display: 'grid', gridTemplateColumns: `170px repeat(${defs.length}, minmax(0,1fr))`, gap: 4 }} mb={4}>
                <Text size="sm" fw={500} style={{ alignSelf: 'center' }}>{dm.name}</Text>
                {aggs.map((a, i) => {
                  if (!a) return <Box key={i} />;
                  const v = a.dims[dm.key], thin = a.n < minN, below = v < T;
                  const [bg, fg] = thin ? (p.thin as [string, string]) : scoreColor(p, v);
                  const key = `${defs[i].id}|${dm.key}`, on = sel === key;
                  return (
                    <Tooltip key={i} label={`${defs[i].id} · ${dm.name} ${v} · ${a.n} calls${below ? ' · below the line' : ''}`}>
                      <UnstyledButton className="cell-btn" onClick={() => setSel(key)} aria-pressed={on} aria-label={`${defs[i].id} ${dm.name}: ${v}`}
                        style={{ minHeight: 42, borderRadius: 10, background: bg, color: fg, textAlign: 'center', fontFamily: 'var(--mantine-font-family-monospace)', fontWeight: 500, outline: on ? `2px solid ${p.ink}` : below && !thin ? `2px solid ${p.warnStrong}` : 'none', outlineOffset: on ? 1 : -2 }}>
                        {v}
                      </UnstyledButton>
                    </Tooltip>
                  );
                })}
              </Box>
            ))}
          </Box>
        </Box>
        {selAgg && selDim && (
          <Paper bg={p.soft} p="md" mt="md">
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <Stack gap={4}>
                <Text size="xs" fw={600} tt="uppercase" c="dimmed">Selected</Text>
                <Text fw={600}>{DIMS.find((d) => d.key === selDim)!.name} · {defs[selIdx].id} {defs[selIdx].name}</Text>
                <Group gap="sm"><Mono fz={28} fw={500}>{selAgg.dims[selDim as DimKey]}</Mono><BandBadge v={selAgg.dims[selDim as DimKey]} size="sm" /></Group>
                <Text size="sm" c="dimmed">{selAgg.n.toLocaleString('en-US')} calls · {selAgg.dims[selDim as DimKey] < T ? `${T - selAgg.dims[selDim as DimKey]} points below the line` : 'above the line'}</Text>
              </Stack>
              <Stack gap={4}>
                <Text size="xs" fw={600} c="dimmed">Lowest cells for this {axis}</Text>
                {worst.length === 0 && <Text size="sm" c="dimmed">No cell with 10 or more calls.</Text>}
                {worst.map((c) => {
                  const other = isP ? SCENARIOS.find((s) => s.id === c.sid) : PERSONAS.find((x) => x.id === c.pid);
                  return <Group key={`${c.pid}${c.sid}`} justify="space-between" wrap="nowrap"><Text size="sm">{isP ? c.sid : c.pid} {other?.name} · {c.n} calls</Text><Mono size="sm">{c.dims[selDim as DimKey]}</Mono></Group>;
                })}
              </Stack>
              <Stack gap={6}>
                <Text size="xs" fw={600} c="dimmed">Usually driven by</Text>
                <Text size="sm">{DIMS.find((d) => d.key === selDim)!.drivers}</Text>
                <Group gap="xs" mt={4}>
                  <Button size="xs" variant="default" rightSection={<IconArrowRight size={14} />} onClick={() => go('matrix', { score: selDim })}>Quality matrix</Button>
                  <Button size="xs" variant="default" rightSection={<IconArrowRight size={14} />} onClick={() => go('calls', isP ? { persona: selId } : { scenario: selId })}>Calls</Button>
                  <Button size="xs" variant="default" rightSection={<IconArrowRight size={14} />} onClick={() => go('recommendations')}>Recommendations</Button>
                </Group>
              </Stack>
            </SimpleGrid>
          </Paper>
        )}
      </Card>

      <Card>
        <SectionTitle
          note="Ranked by impact: calls × points below the line. Assign an owner and track each item to a fix; owners and statuses are saved for the team."
          right={<SegmentedControl size="xs" value={kind} onChange={(v) => { setKind(v); setMore(false); }} data={[['all', 'All'], ['Dimension', 'Dimensions'], ['Persona', 'Personas'], ['Scenario', 'Scenarios'], ['Cell', 'Cells']].map(([v, l]) => ({ value: v, label: `${l} · ${counts[v]}` }))} />}
        >Attention queue</SectionTitle>
        {items.length === 0 && <Text size="sm" c="dimmed">Nothing with {minN} or more calls is below the line.</Text>}
        {items.length > 0 && (
          <Box style={{ overflowX: 'auto' }}>
            <Table miw={1000} verticalSpacing="xs">
              <Table.Thead><Table.Tr><Table.Th w={40}>#</Table.Th><Table.Th w={110}>Type</Table.Th><Table.Th>Item</Table.Th><Table.Th ta="right" w={70}>Score</Table.Th><Table.Th ta="right" w={80}>Calls</Table.Th><Table.Th ta="right" w={90}>Impact</Table.Th><Table.Th w={160}>Owner</Table.Th><Table.Th w={180}>Status</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>
                {shown.map((it, i) => {
                  const status = queue.statuses[it.key] ?? 'open', closed = status === 'done' || status === 'wont';
                  return (
                    <Table.Tr key={it.key} style={{ opacity: closed ? 0.55 : 1 }}>
                      <Table.Td><Mono c="dimmed" size="sm">{i + 1}</Mono></Table.Td>
                      <Table.Td><Badge color={kindColor[it.kind]} variant={it.kind === 'Cell' ? 'light' : 'outline'} size="sm">{it.kind}</Badge></Table.Td>
                      <Table.Td>
                        <UnstyledButton onClick={() => go(it.go[0], it.go[1])}><Text size="sm" fw={500} td="underline" style={{ textDecorationColor: p.line }}>{it.name}</Text></UnstyledButton>
                        <Text size="xs" c="dimmed">{it.sub}</Text>
                      </Table.Td>
                      <Table.Td ta="right"><Mono fw={500} c={it.v < 50 ? p.warnText : undefined}>{it.v}</Mono></Table.Td>
                      <Table.Td ta="right"><Mono>{it.n.toLocaleString('en-US')}</Mono></Table.Td>
                      <Table.Td ta="right"><Mono>{it.impact.toLocaleString('en-US')}</Mono></Table.Td>
                      <Table.Td><Select size="xs" aria-label={`Owner for ${it.name}`} value={queue.owners[it.key] ?? 'none'} onChange={(v) => setOwner(it.key, v ?? 'none')} data={[{ value: 'none', label: 'Unassigned' }, { value: 'ai', label: 'AI team' }, { value: 'sales', label: 'Sales' }, { value: 'tax', label: 'Taxonomy owner' }, { value: 'crm', label: 'CRM and data' }]} /></Table.Td>
                      <Table.Td><Select size="xs" aria-label={`Status for ${it.name}`} value={status} onChange={(v) => setStatus(it.key, v ?? 'open')} data={[{ value: 'open', label: 'Open' }, { value: 'inv', label: 'Investigating' }, { value: 'prompt', label: 'Fix in next prompt' }, { value: 'routing', label: 'Routing fix' }, { value: 'done', label: 'Fixed · verify' }, { value: 'wont', label: 'Won’t fix' }]} /></Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Box>
        )}
        <Group justify="space-between" mt="sm">
          <Text size="sm" c="dimmed">Showing {shown.length} of {filtered.length} items · {openItems} still open</Text>
          {filtered.length > 12 && <Button variant="default" size="xs" onClick={() => setMore(!more)}>{more ? 'Show top 12' : `Show all ${filtered.length}`}</Button>}
        </Group>
      </Card>
    </>
  );
}

function Header({ line, setLine }: { line: string; setLine: (v: string) => void }) {
  return (
    <PageHeader
      eyebrow="AI and sales leads · Daily"
      title="Needs attention"
      description="Every dimension, persona, scenario and cell scoring below the line, in one place, ranked by how many calls it touches."
      right={<Group gap="sm" align="flex-end" wrap="wrap"><RangeSelect options={['30', '90']} /><DirectionSelect /><AgentSelect />
        <Select label="Attention line" size="sm" w={200} value={line} onChange={(v) => v && setLine(v)} data={[{ value: '70', label: 'Under 70 · below Good' }, { value: '50', label: 'Under 50 · Fail' }, { value: '85', label: 'Under 85 · below Excellent' }]} /></Group>}
    />
  );
}
