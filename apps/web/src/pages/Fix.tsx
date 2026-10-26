import { useState } from 'react';
import { Badge, Box, Button, Card, Group, Paper, Select, SimpleGrid, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import { CartesianGrid, ReferenceArea, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import type { FixCellDTO, FixDTO } from '@calleval/framework';
import { usePal } from '../theme';
import { filterQs, useApi } from '../api';
import { AgentSelect, DirectionSelect, EmptyState, ErrorState, Loading, Mono, PageHeader, RangeSelect, SectionTitle, useLookups } from '../components/ui';
import { useMeta, useStore } from '../store';

type Quad = FixCellDTO['quad'];
const QUADS: Record<Quad, { name: string; desc: string }> = {
  fix: { name: 'Fix first', desc: 'High value, handled badly. Prompt and tool fixes start here.' },
  protect: { name: 'Protect', desc: 'High value, handled well. Guard with alerts; use as reference calls.' },
  review: { name: 'Review fit', desc: 'Low value, handled badly. Check routing before fixing the agent.' },
  maintain: { name: 'Maintain', desc: 'Low value, handled well. Keep stable; no extra investment.' },
};
const fmtVal = (vm: 'meet' | 'res', v: number) => (vm === 'res' ? `AED ${Math.round(v)}k` : `${v.toFixed(1)}%`);

export function FixPage() {
  const p = usePal();
  const meta = useMeta();
  const { filters, go } = useStore();
  const { cellName } = useLookups();
  const [vm, setVm] = useState<'meet' | 'res'>('meet');
  const [selKey, setSel] = useState<string | null>(null);
  const range = filters.range === '90' ? '90' : '30';
  const minN = meta.settings.minCellCalls || 30;
  const f = useApi<FixDTO>(`/api/fix${filterQs({ ...filters, range }, { vm }, ['range', 'dir', 'agent'])}`);

  const header = (
    <PageHeader
      eyebrow="AI and sales leads together · Weekly"
      title="Where to fix first"
      description={`Every persona × scenario cell with ${minN} or more calls, placed by agent quality (median CQS, split at 70) and business value per call (split at the median across cells). The five cells deepest in Fix first lead each weekly review.`}
      right={
        <Group gap="sm" align="flex-end" wrap="wrap">
          <RangeSelect options={['30', '90']} />
          <DirectionSelect />
          <AgentSelect />
          <Select label="Value per call" w={280} value={vm} onChange={(v) => v && setVm(v as any)} data={[{ value: 'meet', label: 'Meeting-booked rate (stand-in)' }, { value: 'res', label: 'Reservation rate × deal value' }]} />
        </Group>
      }
    />
  );
  if (f.error && !f.data) return <>{header}<ErrorState error={f.error} onRetry={f.reload} /></>;
  if (!f.data) return <>{header}<Loading /></>;
  const { cells, med, vmax, top5 } = f.data;
  if (!cells.length) return <>{header}<EmptyState title={`No cell has ${minN} or more calls yet`}>The map compares cells with enough calls to trust their median. Widen the date range, or wait for more calls.</EmptyState></>;

  const qColor: Record<Quad, string> = { fix: p.warn, protect: p.bar, review: p.scale.nrLo[0], maintain: p.barMuted };
  const sel = cells.find((c) => c.key === selKey) ?? top5[0] ?? cells[0];
  const topKeys = top5.map((c) => c.key);
  const maxN = Math.max(1, ...cells.map((c) => c.n));
  const ymax = vmax * 1.08 || 1;
  const xmin = Math.min(50, Math.floor(Math.min(...cells.map((c) => c.cqs)) / 5) * 5);
  const xmax = Math.max(95, Math.ceil(Math.max(...cells.map((c) => c.cqs)) / 5) * 5);
  const radius = (n: number) => (12 + 20 * Math.sqrt(n / maxN)) / 2;
  const axis = { fontSize: 12, fill: p.text3, fontFamily: 'IBM Plex Mono, monospace' };
  const data = [...cells].sort((a, b) => b.n - a.n);
  const ring = p.dark ? '#171717' : '#FFFFFF';
  const xticks: number[] = [];
  for (let x = xmin; x <= xmax; x += 10) xticks.push(x);

  const Dot = (props: any) => {
    const c: FixCellDTO = props.payload;
    const r = radius(c.n), on = sel && c.key === sel.key;
    const rank = topKeys.indexOf(c.key);
    return (
      <g style={{ cursor: 'pointer' }} role="button" aria-label={`${cellName(c)}: median CQS ${c.cqs}, value ${fmtVal(vm, c.val)}, ${c.n} calls, ${QUADS[c.quad].name}`}>
        <circle cx={props.cx} cy={props.cy} r={r} fill={qColor[c.quad]} stroke={on ? p.ink : ring} strokeWidth={on ? 3 : 2} />
        {rank >= 0 && <text x={props.cx} y={props.cy + 4} textAnchor="middle" fontSize={11} fontWeight={700} fill={p.dark ? '#0A0A0A' : '#FFFFFF'} fontFamily="IBM Plex Mono, monospace" pointerEvents="none">{rank + 1}</text>}
        {on && <text x={props.cx - r - 6} y={props.cy + 4} textAnchor="end" fontSize={12} fontWeight={600} fill={p.ink} fontFamily="IBM Plex Mono, monospace" pointerEvents="none">{c.pid}×{c.sid}</text>}
      </g>
    );
  };

  return (
    <>
      {header}

      <SimpleGrid cols={{ base: 1, xs: 2, lg: 4 }} mb="lg">
        {(['fix', 'protect', 'review', 'maintain'] as Quad[]).map((q) => (
          <Card key={q} padding="md">
            <Group gap={8} wrap="nowrap"><Box w={12} h={12} style={{ borderRadius: 99, background: qColor[q], flex: 'none' }} /><Text fw={600}>{QUADS[q].name}</Text><Mono ml="auto" fz={20} fw={500}>{cells.filter((c) => c.quad === q).length}</Mono></Group>
            <Text size="xs" c="dimmed" mt={4}>{QUADS[q].desc}</Text>
          </Card>
        ))}
      </SimpleGrid>

      <Box style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-start' }}>
        <Card style={{ flex: '1.7 1 560px', minWidth: 0 }}>
          <SectionTitle note={`${vm === 'res' ? 'Value per call = reservation rate × average deal value, in AED thousands.' : 'Until reservation data is deep enough, meeting-booked rate stands in for value per call.'} Dot size is call count; numbers mark this week’s top five. Select a dot to inspect the cell.`}>Agent quality × business value</SectionTitle>
          <Box h={460}>
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 16, right: 56, bottom: 24, left: 8 }}>
                <ReferenceArea x1={xmin} x2={70} y1={med} y2={ymax} fill={p.warnSoft} fillOpacity={1} stroke="none" label={{ value: 'Fix first', position: 'insideTopLeft', fill: p.warnText, fontSize: 12, fontWeight: 700 }} />
                <ReferenceArea x1={70} x2={xmax} y1={med} y2={ymax} fill="transparent" stroke="none" label={{ value: 'Protect', position: 'insideTopRight', fill: p.text2, fontSize: 12, fontWeight: 700 }} />
                <ReferenceArea x1={xmin} x2={70} y1={0} y2={med} fill="transparent" stroke="none" label={{ value: 'Review fit', position: 'insideBottomLeft', fill: p.text2, fontSize: 12, fontWeight: 700 }} />
                <ReferenceArea x1={70} x2={xmax} y1={0} y2={med} fill="transparent" stroke="none" label={{ value: 'Maintain', position: 'insideBottomRight', fill: p.text2, fontSize: 12, fontWeight: 700 }} />
                <CartesianGrid stroke={p.line} />
                <XAxis type="number" dataKey="cqs" domain={[xmin, xmax]} ticks={xticks} allowDataOverflow tick={axis} tickLine={false} axisLine={{ stroke: p.line }} label={{ value: 'Agent quality · median CQS →', position: 'insideBottom', offset: -14, fill: p.text2, fontSize: 12 }} />
                <YAxis type="number" dataKey="val" domain={[0, ymax]} ticks={[0, med, vmax]} tick={axis} tickLine={false} axisLine={false} width={72} tickFormatter={(v) => fmtVal(vm, v)} label={{ value: 'Value per call →', angle: -90, position: 'insideLeft', fill: p.text2, fontSize: 12, dy: 50 }} />
                <ReferenceLine x={70} stroke={p.ink} strokeWidth={1.5} />
                <ReferenceLine y={med} stroke={p.ink} strokeWidth={1.5} strokeDasharray="4 3" />
                <RTooltip
                  cursor={false}
                  content={({ active, payload }: any) => {
                    if (!active || !payload?.length) return null;
                    const c: FixCellDTO = payload[0].payload;
                    return (
                      <Paper withBorder shadow="sm" p="xs" radius="md" maw={260}>
                        <Text size="xs" fw={600}>{cellName(c)}</Text>
                        <Text size="xs">Median CQS <Mono size="xs">{c.cqs}</Mono> · value <Mono size="xs">{fmtVal(vm, c.val)}</Mono></Text>
                        <Text size="xs" c="dimmed">{c.n.toLocaleString('en-US')} calls · {QUADS[c.quad].name}</Text>
                      </Paper>
                    );
                  }}
                />
                <Scatter data={data} shape={Dot} isAnimationActive={false} onClick={(d: any) => setSel(d?.payload?.key ?? d?.key)} />
              </ScatterChart>
            </ResponsiveContainer>
          </Box>
        </Card>

        <Stack style={{ flex: '1 1 360px', minWidth: 0 }} gap="lg">
          <Card>
            <SectionTitle note="Deepest in Fix first: lowest quality and highest value. A fix counts as done when the cell moves right in the next version report.">This week’s top five</SectionTitle>
            <Stack gap="xs">
              {top5.map((c, i) => {
                const on = sel && c.key === sel.key;
                return (
                  <UnstyledButton key={c.key} onClick={() => setSel(c.key)} aria-pressed={!!on}>
                    <Paper withBorder p="sm" radius="md" bg={on ? p.warnSoft : undefined} style={{ borderColor: on ? p.ink : undefined }}>
                      <Group wrap="nowrap" gap="sm" align="flex-start">
                        <Mono fw={600} c={p.warnText}>{i + 1}</Mono>
                        <Stack gap={0} style={{ flex: 1, minWidth: 0 }}><Text size="sm" fw={600}>{cellName(c)}</Text><Text size="xs" c="dimmed">Weakest: {c.weak.name}</Text></Stack>
                        <Stack gap={0} align="flex-end" style={{ flex: 'none' }}><Mono size="xs">CQS {c.cqs}</Mono><Mono size="xs" c="dimmed">{fmtVal(vm, c.val)}</Mono></Stack>
                      </Group>
                    </Paper>
                  </UnstyledButton>
                );
              })}
              {top5.length === 0 && <Text size="sm" c="dimmed">No cell sits in Fix first for this slice.</Text>}
            </Stack>
          </Card>

          {sel && (
            <Card>
              <Text size="xs" fw={600} tt="uppercase" c="dimmed">Selected cell</Text>
              <Text fw={650} fz={18} mt={2}>{cellName(sel)}</Text>
              <Badge mt={6} color={sel.quad === 'fix' ? 'accent' : 'ink'} variant={sel.quad === 'fix' ? 'filled' : 'light'}>{QUADS[sel.quad].name}</Badge>
              <Text size="sm" c="dimmed" mt={6}>{QUADS[sel.quad].desc}</Text>
              <SimpleGrid cols={2} mt="md" spacing="xs">
                {[['Median CQS', String(sel.cqs)], [vm === 'res' ? 'Value per call' : 'Meeting-booked rate', fmtVal(vm, sel.val)], ['Calls', sel.n.toLocaleString('en-US')], ['Gate failures', `${sel.gate.toFixed(1)}%`]].map(([k, v]) => (
                  <Paper key={k} p="xs" bg={p.soft}><Text size="xs" c="dimmed">{k}</Text><Mono fz={18} fw={500}>{v}</Mono></Paper>
                ))}
              </SimpleGrid>
              <Text size="sm" mt="md">Weakest dimension: <b>{sel.weak.name}</b> ({sel.dims[sel.weak.key]})</Text>
              <Group gap="xs" mt="md">
                <Button size="xs" variant="default" rightSection={<IconArrowRight size={14} />} onClick={() => go('matrix', { sel: `${sel.pid}|${sel.sid}` })}>Inspect in Quality matrix</Button>
                <Button size="xs" variant="default" rightSection={<IconArrowRight size={14} />} onClick={() => go('recommendations', { scope: 'cell', key: sel.key })}>Recommendations</Button>
                <Button size="xs" variant="default" rightSection={<IconArrowRight size={14} />} onClick={() => go('version')}>Track in Version report</Button>
              </Group>
            </Card>
          )}
        </Stack>
      </Box>
    </>
  );
}
