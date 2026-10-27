import { ReactNode, useState } from 'react';
import { Alert, Badge, Box, Button, Card, Group, Loader, Select, Stack, Text, Title, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconDatabaseOff } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import type { CellDTO, DimKey, MetaDTO } from '@calleval/framework';
import { DIMS } from '@calleval/framework';
import { bandOf, usePal } from '../theme';
import { useStore } from '../store';
import { apiSend, errMsg } from '../api';
import { NeedsTip, useCan } from './access';

export function PageHeader({ eyebrow, title, description, right }: { eyebrow: string; title: string; description: ReactNode; right?: ReactNode }) {
  return (
    <Group justify="space-between" align="flex-end" wrap="wrap" gap="md" mb="lg">
      <Stack gap={6} maw={680} style={{ minWidth: 0 }}>
        <Text size="xs" fw={600} tt="uppercase" c="dimmed" style={{ letterSpacing: '0.07em' }}>{eyebrow}</Text>
        <Title order={1} fz={30} lh={1.15} style={{ letterSpacing: '-0.015em', textWrap: 'balance' }}>{title}</Title>
        <Text c="dimmed" style={{ textWrap: 'pretty' }}>{description}</Text>
      </Stack>
      {right}
    </Group>
  );
}

export function StatCard({ label, value, note, tone }: { label: ReactNode; value: ReactNode; note?: ReactNode; tone?: 'warn' | 'ok' }) {
  const p = usePal();
  return (
    <Card padding="md">
      <Text size="xs" c="dimmed">{label}</Text>
      <Text component="div" ff="monospace" fz={24} fw={500} lh={1.3} c={tone === 'warn' ? p.warnText : undefined}>{value}</Text>
      {note && <Text size="xs" c={tone === 'warn' ? p.warnText : 'dimmed'} fw={tone ? 600 : 400}>{note}</Text>}
    </Card>
  );
}

export function BandBadge({ v, size = 'md' }: { v: number; size?: 'xs' | 'sm' | 'md' | 'lg' }) {
  const b = bandOf(v);
  return <Badge size={size} color={b.color} variant={b.variant}>{b.name}</Badge>;
}

/** A thin horizontal bar with an optional marker line (e.g. the Good line at 70). */
export function Bar({ value, max = 100, color, marker, height = 8 }: { value: number; max?: number; color?: string; marker?: number; height?: number }) {
  const p = usePal();
  return (
    <Box pos="relative" h={height} style={{ borderRadius: 4, background: p.track }}>
      <Box h={height} style={{ width: `${Math.max(0, Math.min(100, (value / max) * 100))}%`, borderRadius: 4, background: color ?? p.bar }} />
      {marker !== undefined && <Box pos="absolute" top={-3} bottom={-3} w={2} style={{ left: `${(marker / max) * 100}%`, background: p.ink }} />}
    </Box>
  );
}

export function Mono({ children, ...rest }: { children: ReactNode } & Record<string, any>) {
  return <Text span ff="monospace" {...rest}>{children}</Text>;
}

export function Delta({ now, prev, unit = '' }: { now: number; prev: number | null | undefined; unit?: string }) {
  const p = usePal();
  if (prev === null || prev === undefined || !isFinite(prev)) return <Mono size="xs" c="dimmed">—</Mono>;
  const d = Math.round(now - prev);
  const color = d > 0 ? undefined : d < 0 ? p.warnText : 'dimmed';
  return <Mono size="xs" c={color}>{d > 0 ? '▲ +' : d < 0 ? '▼ ' : '± '}{d}{unit}</Mono>;
}

const sel = { size: 'sm' as const, w: 150, comboboxProps: { withinPortal: true } };
export function RangeSelect({ options = ['7', '30', '90'] }: { options?: string[] }) {
  const { filters, setFilter } = useStore();
  const labels: Record<string, string> = { '7': 'Last 7 days', '30': 'Last 30 days', '90': 'Last 90 days' };
  const value = options.includes(filters.range) ? filters.range : '30';
  return <Select label="Date range" {...sel} data={options.map((o) => ({ value: o, label: labels[o] }))} value={value} onChange={(v) => v && setFilter('range', v as any)} />;
}
export function DirectionSelect() {
  const { filters, setFilter } = useStore();
  return <Select label="Direction" {...sel} w={130} data={[{ value: 'all', label: 'All calls' }, { value: 'in', label: 'Inbound' }, { value: 'out', label: 'Outbound' }]} value={filters.dir} onChange={(v) => v && setFilter('dir', v as any)} />;
}
export function PathSelect() {
  const { filters, setFilter } = useStore();
  return <Select label="Persona path" {...sel} w={140} data={[{ value: 'all', label: 'All paths' }, 'Investor', 'Broker', 'Non-target']} value={filters.path} onChange={(v) => v && setFilter('path', v as any)} />;
}
export function VersionSelect({ label = 'Prompt version' }: { label?: string }) {
  const { filters, setFilter, meta } = useStore();
  const data = versionOptions(meta);
  const value = data.some((d) => d.value === filters.ver) ? filters.ver : 'live';
  return <Select label={label} {...sel} w={150} data={data} value={value} onChange={(v) => v && setFilter('ver', v)} />;
}
export function versionOptions(meta: MetaDTO | null) {
  const live = meta?.liveVersion ?? null;
  const out = [{ value: 'live', label: live ? `${live} (live)` : 'Live' }];
  (meta?.promptVersions ?? []).forEach((v) => { if (v.label !== live && !out.some((o) => o.value === v.label)) out.push({ value: v.label, label: v.label }); });
  out.push({ value: 'all', label: 'All versions' });
  return out;
}
export function AgentSelect() {
  const { filters, setFilter, meta } = useStore();
  if (!meta || meta.agents.length < 2) return null;
  return <Select label="Agent" {...sel} w={180} data={[{ value: 'all', label: 'All agents' }, ...meta.agents.map((a) => ({ value: a.id, label: a.name }))]} value={filters.agent} onChange={(v) => v && setFilter('agent', v)} />;
}

export const SCORE_OPTIONS = [
  { value: 'cqs', label: 'CQS (all dimensions)' }, { value: 'und', label: 'Understanding' }, { value: 'body', label: 'Body' }, { value: 'concl', label: 'Conclusion' },
  { value: 'tools', label: 'Tool use' }, { value: 'emo', label: 'Emotion and realism' }, { value: 'intro', label: 'Introduction' }, { value: 'voice', label: 'Voice and timing' },
];

export function SectionTitle({ children, note, right }: { children: ReactNode; note?: ReactNode; right?: ReactNode }) {
  return (
    <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm" mb="sm">
      <Stack gap={2} style={{ minWidth: 0 }}>
        <Title order={3} fz={17} fw={650}>{children}</Title>
        {note && <Text size="sm" c="dimmed">{note}</Text>}
      </Stack>
      {right}
    </Group>
  );
}

export function Legend({ items }: { items: { label: string; color: string; border?: string }[] }) {
  return (
    <Group gap="md" wrap="wrap">
      {items.map((i) => (
        <Group key={i.label} gap={6} wrap="nowrap">
          <Box w={12} h={12} style={{ borderRadius: 3, background: i.color, border: `1px solid ${i.border ?? 'transparent'}` }} />
          <Text size="xs" c="dimmed">{i.label}</Text>
        </Group>
      ))}
    </Group>
  );
}

export function Hint({ label, children }: { label: string; children: ReactNode }) {
  return <Tooltip label={label} multiline maw={280}>{children as any}</Tooltip>;
}

/** Loading, error and empty states shared by every page. */
export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <Group justify="center" py={60} gap="sm">
      <Loader size="sm" color="ink" />
      <Text c="dimmed" size="sm">{label}</Text>
    </Group>
  );
}

export function ErrorState({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <Alert color="accent" variant="light" radius="lg" icon={<IconAlertTriangle />} title="Couldn’t load this view" mb="lg">
      <Text size="sm">{error}</Text>
      {onRetry && <Button mt="sm" size="xs" variant="default" onClick={onRetry}>Try again</Button>}
    </Alert>
  );
}

/** Shown when the API has no scored calls for the current slice. */
export function EmptyState({ title = 'No calls in this slice yet', children }: { title?: string; children?: ReactNode }) {
  const { go, meta, reloadMeta } = useStore();
  const [busy, setBusy] = useState(false);
  const can = useCan();
  const empty = meta?.dataMode === 'empty';
  const seed = () => {
    setBusy(true);
    apiSend('POST', '/api/demo/seed')
      .then(() => { notifications.show({ title: 'Demo data loading', message: 'Synthetic calls are being generated and scored. Views fill in as they finish.', color: 'ink' }); setTimeout(reloadMeta, 2500); })
      .catch((e) => notifications.show({ title: 'Couldn’t load demo data', message: errMsg(e), color: 'accent' }))
      .finally(() => setBusy(false));
  };
  return (
    <Card mb="lg" padding="xl">
      <Group gap="md" align="flex-start" wrap="nowrap">
        <IconDatabaseOff size={28} stroke={1.6} />
        <Stack gap={6}>
          <Text fw={650}>{empty ? 'No calls yet' : title}</Text>
          <Text size="sm" c="dimmed">
            {children ?? (empty
              ? 'Connect ElevenLabs or Retell AI to pull calls, upload recordings, or load demo data to explore the console.'
              : 'Try a wider date range, another direction or prompt version.')}
          </Text>
          {empty && (
            <Group gap="xs" mt={4}>
              <Button size="xs" onClick={() => go('integrations')}>Connect a provider</Button>
              <NeedsTip perm="settings:manage"><Button size="xs" variant="default" loading={busy} disabled={!can('settings:manage')} onClick={seed}>Load demo data</Button></NeedsTip>
            </Group>
          )}
        </Stack>
      </Group>
    </Card>
  );
}

// ---------- Small helpers over meta and cells ----------

export function useLookups() {
  const { meta } = useStore();
  const personas = meta?.personas ?? [];
  const scenarios = meta?.scenarios ?? [];
  const pName = (id: string | null | undefined) => (id ? (personas.find((p) => p.id === id)?.name ?? (id === 'P0' ? 'Unclassified' : id)) : 'Unclassified');
  const sName = (id: string | null | undefined) => (id ? (scenarios.find((s) => s.id === id)?.name ?? id) : '—');
  const cellName = (c: { pid: string; sid: string }) => `${c.pid} ${pName(c.pid)} × ${c.sid} ${sName(c.sid)}`;
  return { personas, scenarios, pName, sName, cellName };
}

export type Agg = { n: number; cqs: number; gate: number; dims: Record<DimKey, number> };

/** Call-weighted mean of cell values, used for persona and scenario roll-ups. */
export function aggregate(cells: CellDTO[]): Agg | null {
  const n = cells.reduce((a, c) => a + c.n, 0);
  if (!n) return null;
  const dims = {} as Record<DimKey, number>;
  DIMS.forEach((d) => { dims[d.key] = Math.round(cells.reduce((a, c) => a + c.n * (c.dims?.[d.key] ?? c.cqs), 0) / n); });
  return { n, cqs: Math.round(cells.reduce((a, c) => a + c.n * c.cqs, 0) / n), gate: cells.reduce((a, c) => a + c.n * c.gate, 0) / n, dims };
}

/** Call-weighted median of cell values. */
export function weightedMedian(cells: CellDTO[], val: (c: CellDTO) => number) {
  const total = cells.reduce((a, c) => a + c.n, 0);
  const sorted = [...cells].sort((a, b) => val(a) - val(b));
  let acc = 0;
  for (const c of sorted) { acc += c.n; if (acc >= total / 2) return val(c); }
  return 0;
}

export const fmt = (n: number | null | undefined) => (n === null || n === undefined || !isFinite(n) ? '—' : Math.round(n).toLocaleString('en-US'));
export const fmtDuration = (s: number | null | undefined) => {
  if (s === null || s === undefined || !isFinite(s)) return '—';
  let m = Math.floor(s / 60), r = Math.round(s % 60);
  if (r === 60) { m++; r = 0; }
  return `${m}:${String(r).padStart(2, '0')}`;
};
export const fmtWhen = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
