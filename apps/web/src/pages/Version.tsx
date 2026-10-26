import { useState } from 'react';
import { Badge, Box, Card, Group, Paper, SegmentedControl, Select, SimpleGrid, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import type { VersionCellDTO, VersionReportDTO } from '@calleval/framework';
import { usePal } from '../theme';
import { qs, useApi } from '../api';
import { useMeta, useStore } from '../store';
import { AgentSelect, EmptyState, ErrorState, Loading, Mono, PageHeader, SCORE_OPTIONS, SectionTitle, useLookups } from '../components/ui';

type Verdict = VersionCellDTO['verdict'];
const SPAN = 15;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function VersionPage() {
  const p = usePal();
  const meta = useMeta();
  const { filters } = useStore();
  const { pName, sName } = useLookups();
  const labels = meta.promptVersions.map((v) => v.label);
  const [to, setTo] = useState<string | null>(meta.liveVersion ?? labels[0] ?? null);
  const [from, setFrom] = useState<string | null>(meta.previousVersion ?? labels.find((l) => l !== (meta.liveVersion ?? labels[0])) ?? null);
  const [measure, setMeasure] = useState<'cqs' | 'ns'>('cqs');
  const [score, setScore] = useState('cqs');
  const [group, setGroup] = useState<'enough' | Verdict>('enough');
  const [sort, setSort] = useState('delta');
  const minN = meta.settings.minCellCalls || 30;

  const ready = !!from && !!to && from !== to;
  const r = useApi<VersionReportDTO>(ready ? `/api/version-report${qs({ from, to, measure, score: measure === 'cqs' ? score : null, agent: filters.agent })}` : null);
  const cells = r.data?.cells ?? [];
  const fixKeys = r.data?.fixKeys ?? [];

  const counts = { up: 0, down: 0, flat: 0, few: 0 } as Record<Verdict, number>;
  cells.forEach((c) => counts[c.verdict]++);
  const vmeta: Record<Verdict, { label: string; color: string; text?: string }> = {
    up: { label: 'Improved', color: p.bar },
    down: { label: 'Regressed', color: p.warn, text: p.warnText },
    flat: { label: 'No clear change', color: p.barMuted },
    few: { label: 'Too few calls', color: p.track },
  };
  const tiles: { key: 'enough' | Verdict; label: string; color: string; count: number }[] = [
    { key: 'enough', label: `All cells with ${minN}+ calls`, color: p.ink, count: counts.up + counts.down + counts.flat },
    { key: 'up', label: 'Improved', color: vmeta.up.color, count: counts.up },
    { key: 'down', label: 'Regressed', color: vmeta.down.color, count: counts.down },
    { key: 'flat', label: 'No clear change', color: vmeta.flat.color, count: counts.flat },
    { key: 'few', label: 'Too few calls', color: p.barMuted, count: counts.few },
  ];

  const list = cells.filter((c) => (group === 'enough' ? c.verdict !== 'few' : group === 'few' ? c.verdict === 'few' && c.n3 >= 10 : c.verdict === group));
  list.sort((a, b) => (sort === 'worst' ? a.d - b.d : sort === 'calls' ? b.n3 - a.n3 : b.d - a.d));
  const xp = (v: number) => clamp((v + SPAN) / (2 * SPAN), 0, 1) * 100;
  const isCqs = measure === 'cqs';
  const unit = !isCqs ? 'Next step' : (SCORE_OPTIONS.find((o) => o.value === score)?.label.replace(' (all dimensions)', '') ?? 'CQS');
  const cols = 'minmax(180px,1.4fr) 84px 96px minmax(240px,2fr) 116px';
  const vOpts = labels.map((l) => ({ value: l, label: l === meta.liveVersion ? `${l} (live)` : l }));

  return (
    <>
      <PageHeader
        eyebrow="AI team · Each prompt release"
        title={`Version report · ${from ?? '—'} → ${to ?? '—'}`}
        description={`Per-cell change, old version against new, with a 95% bootstrap interval. A change counts only when the interval excludes zero and both sides have ${minN} or more calls.`}
        right={
          <Group gap="sm" align="flex-end" wrap="wrap">
            <Select label="Old version" w={140} data={vOpts} value={from} onChange={setFrom} />
            <Select label="New version" w={140} data={vOpts} value={to} onChange={setTo} />
            <AgentSelect />
            {r.data && <Stack gap={2}><Text size="sm"><b>{r.data.from}</b> · {r.data.fromWindow ?? '—'}</Text><Text size="sm"><b>{r.data.to}</b> · {r.data.toWindow ?? '—'}</Text></Stack>}
          </Group>
        }
      />

      {!ready && (
        labels.length < 2
          ? <EmptyState title="Only one prompt version so far">The version report compares two prompt versions. It fills in after the first prompt release, when calls arrive on a new version.</EmptyState>
          : <EmptyState title="Pick two different versions">Choose an old and a new prompt version to compare.</EmptyState>
      )}
      {ready && r.error && !r.data && <ErrorState error={r.error} onRetry={r.reload} />}
      {ready && !r.data && !r.error && <Loading />}

      {ready && r.data && (
        <>
          <SimpleGrid cols={{ base: 2, sm: 3, lg: 5 }} mb="lg">
            {tiles.map((t) => {
              const on = group === t.key;
              return (
                <UnstyledButton key={t.key} onClick={() => setGroup(t.key)} aria-pressed={on}>
                  <Card padding="md" style={{ outline: on ? `2px solid ${p.ink}` : undefined, outlineOffset: -1 }}>
                    <Group gap={6} wrap="nowrap"><Box w={10} h={10} style={{ borderRadius: 99, background: t.color, flex: 'none' }} /><Text size="xs" c="dimmed">{t.label}</Text></Group>
                    <Mono fz={26} fw={500}>{t.count}</Mono>
                  </Card>
                </UnstyledButton>
              );
            })}
          </SimpleGrid>

          <Group justify="space-between" align="flex-end" mb="md" wrap="wrap" gap="md">
            <SegmentedControl value={measure} onChange={(v) => setMeasure(v as any)} data={[{ value: 'cqs', label: 'Median score' }, { value: 'ns', label: 'Next-step rate' }]} />
            <Group gap="sm" align="flex-end">
              <Select label="Score" w={210} data={SCORE_OPTIONS} value={score} onChange={(v) => v && setScore(v)} disabled={!isCqs} />
              <Select label="Sort by" w={200} data={[{ value: 'delta', label: 'Change, largest first' }, { value: 'worst', label: 'Change, worst first' }, { value: 'calls', label: 'Call count' }]} value={sort} onChange={(v) => v && setSort(v)} />
            </Group>
          </Group>

          <Card padding={0} mb="lg">
            <Box style={{ overflowX: 'auto' }}>
              <Box miw={860}>
                <Box px="lg" py="sm" style={{ display: 'grid', gridTemplateColumns: cols, gap: 14, alignItems: 'end', borderBottom: `1px solid ${p.line}` }}>
                  <Text size="xs" fw={600} c="dimmed">Persona × scenario · {list.length} cells</Text>
                  <Text size="xs" fw={600} c="dimmed" ta="right">Calls {r.data.from} / {r.data.to}</Text>
                  <Text size="xs" fw={600} c="dimmed" ta="right">{unit} {r.data.from} → {r.data.to}</Text>
                  <Box pos="relative" h={16}>
                    {[-15, -10, -5, 0, 5, 10, 15].map((v) => <Mono key={v} size="xs" c="dimmed" pos="absolute" style={{ left: `${xp(v)}%`, transform: 'translateX(-50%)' }}>{v > 0 ? '+' : ''}{v}</Mono>)}
                  </Box>
                  <Text size="xs" fw={600} c="dimmed">Verdict</Text>
                </Box>
                {list.map((c) => {
                  const v = vmeta[c.verdict];
                  const hasCi = isFinite(c.lo) && isFinite(c.hi);
                  const lo = xp(hasCi ? c.lo : c.d), hi = xp(hasCi ? c.hi : c.d), x = xp(c.d);
                  const left = hi > 72;
                  const lowN = c.n2 < minN || c.n3 < minN;
                  return (
                    <Box key={c.key} px="lg" py={10} style={{ display: 'grid', gridTemplateColumns: cols, gap: 14, alignItems: 'center', borderBottom: `1px solid ${p.line}` }}>
                      <Stack gap={0} style={{ minWidth: 0 }}>
                        <Group gap={6} wrap="nowrap"><Mono size="sm" fw={500}>{c.pid} × {c.sid}</Mono>{fixKeys.includes(c.key) && <Badge size="xs" color="accent" variant="filled">Fix first</Badge>}</Group>
                        <Text size="xs" c="dimmed" truncate>{pName(c.pid)} · {sName(c.sid)}</Text>
                      </Stack>
                      <Mono size="sm" ta="right" c={lowN ? p.warnText : undefined}>{c.n2} / {c.n3}</Mono>
                      <Mono size="sm" ta="right">{isCqs ? `${c.old} → ${c.nw}` : `${c.old}% → ${c.nw}%`}</Mono>
                      <Tooltip label={`${c.d > 0 ? '+' : ''}${c.d}${isCqs ? '' : ' pts'}${hasCi ? ` · 95% interval ${c.lo.toFixed(1)} to ${c.hi.toFixed(1)}` : ''}`}>
                        <Box pos="relative" h={26}>
                          <Box pos="absolute" top={0} bottom={0} w={1} style={{ left: '50%', background: p.barMuted }} />
                          <Box pos="absolute" h={2} top={12} style={{ left: `${lo}%`, width: `${Math.max(0.5, hi - lo)}%`, background: v.color, borderRadius: 2 }} />
                          <Box pos="absolute" w={11} h={11} top={7.5} style={{ left: `${x}%`, transform: 'translateX(-50%)', borderRadius: 99, background: v.color, border: `2px solid ${p.dark ? '#171717' : '#fff'}` }} />
                          <Mono size="xs" pos="absolute" top={-1} style={{ left: `${left ? lo : hi}%`, transform: left ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)', whiteSpace: 'nowrap' }} c="dimmed">
                            {c.d > 0 ? '+' : ''}{c.d}{isCqs ? '' : ' pts'}{hasCi ? ` [${c.lo.toFixed(1)}, ${c.hi.toFixed(1)}]` : ''}
                          </Mono>
                        </Box>
                      </Tooltip>
                      <Text size="sm" fw={600} c={v.text ?? (c.verdict === 'flat' || c.verdict === 'few' ? 'dimmed' : undefined)}>{v.label}</Text>
                    </Box>
                  );
                })}
                {list.length === 0 && <Text p="lg" c="dimmed">No cells in this group.</Text>}
              </Box>
            </Box>
          </Card>
        </>
      )}

      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Paper p="lg" bg={p.soft}>
          <SectionTitle>Reading a row</SectionTitle>
          <Text size="sm" c="dimmed">The dot is the change from the old version to the new one; the line is its 95% interval. Right of the centre line is better. A row counts only when the whole line sits on one side.</Text>
        </Paper>
        <Paper p="lg" bg={p.soft}>
          <SectionTitle>Closing a fix</SectionTitle>
          <Text size="sm" c="dimmed">Cells marked Fix first come from the weekly map. A fix is done when the cell improves here and moves right on the map; mark the matching recommendation verified.</Text>
        </Paper>
      </SimpleGrid>
    </>
  );
}
