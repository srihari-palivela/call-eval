import { useEffect, useState } from 'react';
import { Badge, Box, Card, Checkbox, Chip, Code, Collapse, Group, List, NumberInput, Paper, SegmentedControl, Select, SimpleGrid, Slider, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconChevronUp } from '@tabler/icons-react';
import { DIMS, DimKey, GATES, METRICS, normalise, normRule, rollUpArray, type CallDetailDTO, type CallListDTO } from '@calleval/framework';
import { bandOf, scoreColor, usePal } from '../theme';
import { apiGet } from '../api';
import { BandBadge, Mono, PageHeader, SectionTitle } from '../components/ui';
import { useMeta } from '../store';

type Preset = 'doc' | 'gated' | 'nobody' | 'norec' | 'ref';
type DimState = Record<DimKey, { on: boolean; v: number; w: number }>;
type State = { preset: Preset | null; dims: DimState; gates: boolean[]; mv: number[]; mna: boolean[] };

// Metric scores (METRICS order) of the two annotated calls in the framework document: conv_123 and a gated broker call.
// They are static reference presets for this sandbox, not live data.
const DOC_CALL: (number | null)[] = [60, 100, 67, 100, null, 71, 80, 93, 60, 79, 100, 93, 100, 100, 100, null, 100, 100, 86, 0, 68, null, 100, 100, 100, 100, 50, 100, 0, 100, 60, 100, 100, null, null, 100, 50, 100, null, 100, 75, 100, 100, 100, 100, 100, 100, 100, 100, 100, 50, 100, 60, 79, 67, 100, 60, 90, 67, 100, 67, 80];
const GATED_CALL: (number | null)[] = [87, 100, 100, 100, null, 100, 100, 80, null, 100, 100, 70, 80, 100, 100, null, 100, 50, 100, null, 100, null, 100, 100, null, 100, 50, 60, null, 0, null, null, 100, 0, 0, 100, 100, 50, null, 100, 50, 100, 25, 100, 100, 100, 100, 100, 75, 100, 100, 100, 90, 100, 100, 100, 80, 100, 100, 100, 100, 100];

function presetScores(name: Preset, ref: (number | null)[] | null): (number | null)[] {
  if (name === 'ref' && ref) return ref.slice();
  if (name === 'gated') return GATED_CALL.slice();
  const s = DOC_CALL.slice();
  if (name === 'nobody') {
    const over: Record<string, number | null> = { trel: 80, fca: null, cco: null, ch: 60, pfd: 50, nss: 0, cf: null, ab: 0, sch: 50 };
    METRICS.forEach((m, i) => {
      if (m.dim === 'body' || m.dim === 'tools') s[i] = null;
      if (m.key in over) s[i] = over[m.key];
    });
  }
  if (name === 'norec') METRICS.forEach((m, i) => { if (m.dim === 'emo') s[i] = null; });
  return s;
}

function preset(name: Preset, ref: (number | null)[] | null = null, refGated = false): State {
  const sc = presetScores(name, ref);
  const r = rollUpArray(sc);
  const dims = {} as DimState;
  DIMS.forEach((d) => { dims[d.key] = { on: !!r[d.key], v: r[d.key] ? Math.round(r[d.key]!.v) : 50, w: d.w }; });
  const gates = GATES.map(() => false);
  if (name === 'gated') gates[0] = true;
  if (name === 'ref' && refGated) gates[0] = true;
  return { preset: name, dims, gates, mv: sc.map((v) => (v === null ? 100 : v)), mna: sc.map((v) => v === null) };
}

const NORM_METRICS = METRICS.filter((m) => m.norm.kind !== 'pass');
const DEFAULT_RAW: Record<string, number> = { rl: 3.1, tda: 4, ls: 1, cbr: 15, br: 90, aci: 5, atl: 34, tr: 66, sra: 12, ent: 92, trel: 1.6, sch: 1, srate: 178, mos: 3.8 };

function explainNorm(m: (typeof METRICS)[number]) {
  const n = m.norm;
  if (n.kind === 'low') return `Lower is better: 100 at ${n.green} or less, 0 at ${n.red} or more.`;
  if (n.kind === 'high') return `Higher is better: 100 at ${n.green} or more, 0 at ${n.red} or less.`;
  if (n.kind === 'two') return 'Two-sided: 100 inside the green range, falling to 0 at either red edge.';
  if (n.kind === 'judge') return `Judge scale ${n.min} to ${n.max} rescaled to 0–100.`;
  return 'Pass is 100, fail is 0.';
}

export function ScoringPage() {
  const p = usePal();
  const meta = useMeta();
  const [st, setSt] = useState<State>(() => preset('doc'));
  const [mode, setMode] = useState<'dim' | 'metric'>('dim');
  const [open, setOpen] = useState<DimKey | null>('body');
  const [normKey, setNormKey] = useState('rl');
  const [raw, setRaw] = useState<number | string>(3.1);
  const [ref, setRef] = useState<{ id: string; scores: (number | null)[]; gated: boolean } | null>(null);

  // A recent Excellent call from the API, offered as a live preset.
  useEffect(() => {
    let alive = true;
    apiGet<CallListDTO>('/api/calls?band=Excellent&limit=1&range=90&ver=all&sort=recent')
      .then((l) => (l.items[0] ? apiGet<CallDetailDTO>(`/api/calls/${encodeURIComponent(l.items[0].id)}`) : null))
      .then((c) => {
        if (!alive || !c) return;
        const byKey = Object.fromEntries(c.metrics.map((m) => [m.key, m.value]));
        setRef({ id: c.externalId || c.id, scores: METRICS.map((m) => (byKey[m.key] ?? null) as number | null), gated: c.gates.length > 0 });
      })
      .catch(() => { /* reference presets stay static */ });
    return () => { alive = false; };
  }, []);

  // Start from the deployment's weights.
  useEffect(() => {
    setSt((s) => {
      const dims = { ...s.dims };
      DIMS.forEach((d) => { dims[d.key] = { ...dims[d.key], w: meta.settings.weights?.[d.key] ?? d.w }; });
      return { ...s, dims };
    });
  }, [meta.settings.weights]);

  const metricMode = mode === 'metric';
  const roll = rollUpArray(st.mv.map((v, i) => (st.mna[i] ? null : v)));
  const setDim = (k: DimKey, pt: Partial<DimState[DimKey]>) => setSt((s) => ({ ...s, preset: null, dims: { ...s.dims, [k]: { ...s.dims[k], ...pt } } }));

  const eff = {} as Record<DimKey, { on: boolean; v: number; n: number }>;
  DIMS.forEach((d) => {
    eff[d.key] = metricMode ? (roll[d.key] ? { on: true, v: roll[d.key]!.v, n: roll[d.key]!.n } : { on: false, v: 0, n: 0 }) : { on: st.dims[d.key].on, v: st.dims[d.key].v, n: 0 };
  });
  let num = 0, den = 0;
  DIMS.forEach((d) => { const x = eff[d.key], w = st.dims[d.key].w; if (x.on && w > 0) { num += w * x.v; den += w; } });
  const rawCqs = den ? num / den : 0;
  const gated = st.gates.some(Boolean);
  const exact = gated ? Math.min(rawCqs, 40) : rawCqs;
  const cqs = Math.round(exact);
  const band = bandOf(cqs);
  let low: DimKey | null = null;
  DIMS.forEach((d) => { if (eff[d.key].on && (!low || eff[d.key].v < eff[low].v)) low = d.key; });

  const changeMode = (m: string) => {
    if (m === 'dim' && mode === 'metric') {
      setSt((s) => {
        const dims = { ...s.dims };
        DIMS.forEach((d) => { dims[d.key] = { ...dims[d.key], on: !!roll[d.key], v: roll[d.key] ? Math.round(roll[d.key]!.v) : dims[d.key].v }; });
        return { ...s, dims };
      });
    }
    setMode(m as any);
  };

  const nm = NORM_METRICS.find((n) => n.key === normKey) ?? NORM_METRICS[0];
  const rawNum = typeof raw === 'number' ? raw : parseFloat(raw);
  const nr = { out: isNaN(rawNum) ? null : normalise(nm.norm, rawNum), rule: normRule(nm.norm), explain: explainNorm(nm) };
  const loadPreset = (k: Preset) => {
    const next = k === 'ref' && ref ? preset('ref', ref.scores, ref.gated) : preset(k);
    DIMS.forEach((d) => { next.dims[d.key].w = st.dims[d.key].w; });
    setSt(next);
  };
  const pos = Math.max(1, Math.min(99, cqs));

  return (
    <>
      <PageHeader
        eyebrow="Reference · Framework v1"
        title="Scoring model"
        description="Metrics roll up into seven dimension scores, and the dimensions roll up into one Call Quality Score. Every call keeps both: the CQS for the headline, the dimension scores for what to fix. Weights and thresholds are starting values to revisit after 200 calls — try changes here; they don’t change the live weights."
      />

      <Group justify="space-between" wrap="wrap" gap="md" mb="lg">
        <Group gap="xs" wrap="wrap">
          <Text size="sm" fw={600} c="dimmed">Start from</Text>
          {([['doc', 'conv_123 from the framework'], ['gated', 'Gated broker call'], ['nobody', 'Ended before persona resolved'], ['norec', 'No usable recording'], ...(ref ? [['ref', `Live reference · ${ref.id}`]] : [])] as [Preset, string][]).map(([k, l]) => (
            <Chip key={k} checked={st.preset === k} onChange={() => loadPreset(k)} variant="outline" radius="xl">{l}</Chip>
          ))}
        </Group>
        <Group gap="xs"><Text size="sm" fw={600} c="dimmed">Score at</Text><SegmentedControl value={mode} onChange={changeMode} data={[{ value: 'dim', label: 'Dimension level' }, { value: 'metric', label: 'Metric level' }]} /></Group>
      </Group>

      <Box style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-start' }} mb="lg">
        <Card style={{ flex: '1.5 1 560px', minWidth: 0 }}>
          <SectionTitle note={metricMode ? 'Each dimension score is the mean of its metrics that apply. Open a dimension to change its metrics; the dimension and the CQS update together.' : 'Set each dimension score directly. Untick a dimension the call doesn’t have (no body, no recording); the remaining weights re-normalise.'}>
            {metricMode ? 'Metric-level scoring' : 'Dimension-level scoring'}
          </SectionTitle>
          <Box style={{ display: 'grid', gridTemplateColumns: 'minmax(150px,190px) minmax(0,1fr) 44px 76px 50px', gap: 12 }} pb={6} mb={4}>
            {['Dimension', metricMode ? 'Metrics' : 'Score', 'S', 'Weight', 'Share'].map((h, i) => <Text key={h} size="xs" fw={600} c="dimmed" ta={i >= 2 && i !== 3 ? 'right' : undefined}>{h}</Text>)}
          </Box>
          <Stack gap={0}>
            {DIMS.map((d) => {
              const x = eff[d.key], w = st.dims[d.key].w, isOpen = metricMode && open === d.key;
              return (
                <Box key={d.key} py="sm" style={{ borderTop: `1px solid ${p.line}` }}>
                  <Box style={{ display: 'grid', gridTemplateColumns: 'minmax(150px,190px) minmax(0,1fr) 44px 76px 50px', gap: 12, alignItems: 'center', opacity: x.on ? 1 : 0.55 }}>
                    <Checkbox label={<Text size="sm" fw={600}>{d.name}</Text>} checked={x.on} disabled={metricMode} onChange={() => setDim(d.key, { on: !st.dims[d.key].on })} />
                    {metricMode ? (
                      <UnstyledButton onClick={() => setOpen(isOpen ? null : d.key)} aria-expanded={isOpen}>
                        <Group gap="sm" wrap="nowrap">
                          <Box h={8} style={{ flex: 1, borderRadius: 4, background: p.track }}><Box h={8} style={{ width: `${x.on ? Math.round(x.v) : 0}%`, background: x.on && x.v < 70 ? p.warn : p.bar, borderRadius: 4 }} /></Box>
                          <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>{x.on ? `${x.n} metrics apply` : 'No metric applies'}</Text>
                          {isOpen ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
                        </Group>
                      </UnstyledButton>
                    ) : (
                      <Slider value={st.dims[d.key].v} onChange={(v) => setDim(d.key, { v })} min={0} max={100} disabled={!x.on} color={x.v < 70 ? 'accent' : 'ink'} label={null} aria-label={`${d.name} score`} />
                    )}
                    <Mono ta="right" fw={600} size="sm">{x.on ? Math.round(x.v) : '—'}</Mono>
                    <NumberInput size="xs" min={0} max={60} value={w} onChange={(v) => setDim(d.key, { w: typeof v === 'number' ? Math.max(0, Math.min(60, v)) : 0 })} aria-label={`${d.name} weight`} />
                    <Mono ta="right" size="sm" c="dimmed">{x.on && den ? `${Math.round((w / den) * 100)}%` : '—'}</Mono>
                  </Box>
                  <Collapse in={isOpen}>
                    <Paper bg={p.soft} p="sm" mt="sm" radius="md">
                      <Stack gap={6}>
                        {METRICS.map((m, i) => ({ m, i })).filter(({ m }) => m.dim === d.key).map(({ m, i }) => {
                          const na = st.mna[i], v = st.mv[i];
                          return (
                            <Box key={m.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,1fr) 40px', gap: 12, alignItems: 'center', opacity: na ? 0.6 : 1 }}>
                              <Checkbox size="xs" checked={!na} onChange={() => setSt((s) => { const a = s.mna.slice(); a[i] = !a[i]; return { ...s, mna: a, preset: null }; })}
                                label={<Stack gap={0}><Text size="sm">{m.name}</Text><Text size="xs" c="dimmed">Target {m.target}</Text></Stack>} />
                              <Slider size="sm" value={v} disabled={na} min={0} max={100} label={null} color={v < 50 ? 'accent' : 'ink'} aria-label={`${m.name} score`}
                                onChange={(nv) => setSt((s) => { const a = s.mv.slice(); a[i] = nv; return { ...s, mv: a, preset: null }; })} />
                              <Mono ta="right" size="sm" c={na ? 'dimmed' : v < 50 ? p.warnText : undefined}>{na ? 'n/a' : v}</Mono>
                            </Box>
                          );
                        })}
                        <Text size="xs" c="dimmed">Untick a metric with no opportunity in the call; it is left out, not scored as 100.</Text>
                      </Stack>
                    </Paper>
                  </Collapse>
                </Box>
              );
            })}
          </Stack>
          <Text size="xs" c="dimmed" mt="sm">Inside a dimension, metrics are a plain mean of those that apply; Re-ask and Wrong path count twice in Understanding.</Text>
        </Card>

        <Stack style={{ flex: '1 1 380px', minWidth: 0 }} gap="lg">
          <Card>
            <Text size="xs" fw={600} tt="uppercase" c="dimmed">Call Quality Score</Text>
            <Group gap="md" align="center" mt={4}><Mono fz={56} fw={500} lh={1}>{den ? cqs : '—'}</Mono><BandBadge v={cqs} size="lg" /></Group>
            <Text size="sm" mt="xs">{band.action}</Text>
            <Text size="sm" c={gated ? p.warnText : 'dimmed'} fw={gated ? 600 : 400}>{gated ? `Uncapped ${rawCqs.toFixed(1)} · capped at 40 by a gate failure; sent to human review.` : 'No gate failed, so G = 100 and the weighted mean stands.'}</Text>
            <Box mt="md" pos="relative">
              <Group gap={2} wrap="nowrap" h={10} style={{ borderRadius: 5, overflow: 'hidden' }}>
                {[[50, p.scale.fail[0]], [20, p.scale.nrLo[0]], [15, p.scale.goodLo[0]], [15, p.scale.exc[0]]].map(([f, c], i) => <Box key={i} h="100%" style={{ flex: `${f} 1 0`, background: c as string }} />)}
              </Group>
              <Box pos="absolute" top={10} style={{ left: `${pos}%`, transform: 'translateX(-50%)', fontSize: 12, lineHeight: 1 }}>▲</Box>
              <Group justify="space-between" mt={16}>{[0, 50, 70, 85, 100].map((v) => <Mono key={v} size="xs" c="dimmed">{v}</Mono>)}</Group>
            </Box>
            <Code block mt="md" fz="sm" style={{ background: p.soft }}>{`CQS = min(Σ w·S ÷ Σ w, G)\n    = min(${Math.round(num).toLocaleString('en-US')} ÷ ${den}, ${gated ? 40 : 100})\n    = ${exact.toFixed(2)}`}</Code>
          </Card>

          <Card>
            <SectionTitle note="Reported beside the CQS on every call, so a passing total can’t hide a weak dimension. Gates cap the CQS, not the dimension scores.">Dimension scorecard</SectionTitle>
            <Stack gap={0}>
              {DIMS.map((d) => {
                const x = eff[d.key], w = st.dims[d.key].w, isLow = d.key === low;
                const [bg, fg] = x.on ? scoreColor(p, Math.round(x.v)) : [p.track, p.text2];
                return (
                  <Group key={d.key} justify="space-between" wrap="nowrap" py={8} style={{ borderBottom: `1px solid ${p.line}` }}>
                    <Stack gap={0} style={{ minWidth: 0 }}>
                      <Text size="sm" fw={500}>{d.name}</Text>
                      <Text size="xs" c={isLow ? p.warnText : 'dimmed'} fw={isLow ? 600 : 400}>{x.on ? `${isLow ? 'Lowest dimension · ' : ''}weight ${w}${den ? ` · ${Math.round((w / den) * 100)}% of CQS` : ''}` : 'Left out; weights re-normalise'}</Text>
                    </Stack>
                    <Group gap="xs" wrap="nowrap" style={{ flex: 'none' }}>
                      <Mono fw={600} size="sm">{x.on ? Math.round(x.v) : '—'}</Mono>
                      <Badge w={108} style={{ background: bg, color: fg }} tt="none">{x.on ? bandOf(Math.round(x.v)).name : 'Not in call'}</Badge>
                    </Group>
                  </Group>
                );
              })}
            </Stack>
          </Card>

          <Card>
            <SectionTitle note="Pass or fail. A single failure caps the call at 40, whatever else went well, and sends it to human review.">Compliance gates</SectionTitle>
            <Stack gap={6}>
              {GATES.map((g, i) => (
                <Paper key={g.id} p={8} radius="md" bg={st.gates[i] ? p.warnSoft : undefined}>
                  <Checkbox color="accent" checked={st.gates[i]} label={<Text size="sm"><Mono size="xs" c="dimmed">{g.id}</Mono> {g.text}</Text>} onChange={() => setSt((s) => { const a = s.gates.slice(); a[i] = !a[i]; return { ...s, gates: a, preset: null }; })} />
                </Paper>
              ))}
            </Stack>
          </Card>
        </Stack>
      </Box>

      <Card mb="lg">
        <SectionTitle note="A continuous metric scores 100 at or better than green, 0 at or worse than red, and linearly in between. Judge scales are rescaled to 0–100.">Normalise a metric</SectionTitle>
        <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} spacing="md" style={{ alignItems: 'end' }}>
          <Select label="Metric" searchable data={NORM_METRICS.map((n) => ({ value: n.key, label: n.name }))} value={normKey} onChange={(v) => { if (v) { setNormKey(v); if (DEFAULT_RAW[v] !== undefined) setRaw(DEFAULT_RAW[v]); } }} />
          <NumberInput label={`Raw value (${nm.unit})`} value={raw} onChange={setRaw} decimalScale={3} />
          <Paper p="sm" bg={p.soft}><Text size="xs" c="dimmed">Green · Red</Text><Mono size="sm" fw={500}>{nr.rule}</Mono></Paper>
          <Paper p="sm" bg={p.soft}><Text size="xs" c="dimmed">Normalised</Text><Mono fz={22} fw={600} c={nr.out === null ? 'dimmed' : nr.out < 50 ? p.warnText : undefined}>{nr.out === null ? '—' : Math.round(nr.out)}</Mono></Paper>
        </SimpleGrid>
        <Text size="sm" c="dimmed" mt="sm">{nr.explain}</Text>
      </Card>

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
        <Card>
          <SectionTitle>Bands</SectionTitle>
          <Stack gap="xs">
            {([['85–100', 90], ['70–84', 75], ['50–69', 60], ['0–49', 30]] as [string, number][]).map(([r, v]) => {
              const b = bandOf(v);
              return (
                <Group key={r} wrap="nowrap" gap="md">
                  <Mono size="sm" w={60}>{r}</Mono>
                  <BandBadge v={v} />
                  <Text size="sm">{b.action}</Text>
                </Group>
              );
            })}
          </Stack>
          <Text size="xs" c="dimmed" mt="md">Dimension scores use the same four bands, so a dimension under 70 reads the same way as a call under 70.</Text>
        </Card>
        <Card>
          <SectionTitle>Five steps</SectionTitle>
          <List type="ordered" spacing="xs" size="sm">
            <List.Item><b>Normalise each metric.</b> Pass/fail is 100 or 0; continuous metrics run green to red.</List.Item>
            <List.Item><b>Drop what doesn’t apply.</b> No opportunity in the call means left out, not scored as 100.</List.Item>
            <List.Item><b>Average into dimensions.</b> A plain mean; Re-ask and Wrong path count twice. Store each dimension score.</List.Item>
            <List.Item><b>Weight the dimensions.</b> Re-normalise if a whole dimension is missing.</List.Item>
            <List.Item><b>Apply the gates.</b> Any failure caps the CQS at 40.</List.Item>
          </List>
        </Card>
      </SimpleGrid>
    </>
  );
}
