import { useEffect, useMemo, useState } from 'react';
import { ActionIcon, Alert, Badge, Box, Button, Card, Group, Modal, MultiSelect, SegmentedControl, Select, SimpleGrid, Stack, Switch, Table, Tabs, Text, TextInput, Textarea, Tooltip, UnstyledButton } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowDown, IconArrowUp, IconFilter, IconPlus, IconStar, IconTrash, IconWand } from '@tabler/icons-react';
import type { FunnelMilestone, FunnelProposalDTO, FunnelStageDef, LeadFunnelDTO, LeadFunnelReportDTO, LeadFunnelsDTO } from '@calleval/framework';
import { usePal } from '../theme';
import { ApiError, apiSend, errMsg, useApi } from '../api';
import { Bar, ErrorState, Loading, Mono, PageHeader, SectionTitle, StatCard, useLookups } from '../components/ui';
import { CopilotQuestions, CopilotUsageLine, CopilotWorking, NO_CLAUDE_KEY } from '../components/copilot';
import { MILESTONE_LABELS, PATHS, SOURCES, stageKey } from '../components/funnels';
import { useStore } from '../store';
import { NeedsTip, useAllow, useCan } from '../components/access';
import { PlanNotice } from '../components/plan';

type Row = FunnelStageDef & { auto?: boolean };
type Draft = { name: string; description: string; stages: Row[]; match: LeadFunnelDTO['match'] };
type Proposal = FunnelProposalDTO['funnel'];

const KIND_LABEL: Record<FunnelStageDef['kind'], string> = { open: 'Open', won: 'Won', lost: 'Lost' };
const KEY_RX = /^[a-z][a-z0-9_]{0,39}$/;
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
const fail = (title: string) => (e: unknown) => notifications.show({ title, message: errMsg(e), color: 'accent' });

const toDraft = (f: LeadFunnelDTO): Draft => ({ name: f.name, description: f.description, stages: f.stages.map((s) => ({ ...s })), match: { paths: [...f.match.paths], personas: [...f.match.personas], sources: [...f.match.sources] } });
const cleanStages = (rows: Row[]): FunnelStageDef[] => rows.map(({ auto, ...s }) => ({ ...s, callable: s.kind === 'open' ? s.callable : false }));

export function FunnelsPage() {
  const { meta, reloadMeta, go, params } = useStore();
  const can = useCan();
  const allow = useAllow();
  const on = meta!.settings.features.crm;
  const list = useApi<LeadFunnelsDTO>(on ? '/api/crm/funnels' : null);
  const [sel, setSel] = useState<string | null>(params.id ?? null);
  const [creating, setCreating] = useState<{ template: string | null; proposal?: Proposal } | null>(null);
  const [pending, setPending] = useState<Proposal | null>(null);
  useEffect(() => {
    const fs = list.data?.funnels;
    if (fs?.length && (!sel || !fs.some((f) => f.id === sel))) setSel((fs.find((f) => f.isDefault) ?? fs[0]).id);
  }, [list.data, sel]);

  const header = (
    <>
    <PlanNotice feature="crm" />
    <PageHeader eyebrow="Grow · Sales" title="Funnels"
      description="The stages a lead moves through, in your own words. Each stage can stand for a framework milestone, so calls still move leads forward, outcomes are still credited to the call before them, and campaigns know which stages to call."
      right={on ? <NeedsTip perm="crm:write"><Button leftSection={<IconPlus size={16} />} disabled={!can('crm:write')} onClick={() => setCreating({ template: null })}>New funnel</Button></NeedsTip> : undefined} />
    </>
  );

  if (!on) {
    return (
      <>
        {header}
        <Card padding="xl">
          <Group gap="md" align="flex-start" wrap="nowrap">
            <IconFilter size={28} stroke={1.6} />
            <Stack gap={6}>
              <Text fw={650}>The built-in CRM is off</Text>
              <Text size="sm" c="dimmed">Funnels organise the CRM’s leads. Turn the CRM on to design them.</Text>
              <Group gap="xs" mt={4}>
                <NeedsTip perm="settings:manage" feature="crm"><Button size="xs" disabled={!allow('settings:manage', 'crm')} onClick={() => apiSend('PUT', '/api/settings', { features: { crm: true } }).then(reloadMeta).catch(fail('Couldn’t turn it on'))}>Turn on the CRM</Button></NeedsTip>
                <Button size="xs" variant="default" onClick={() => go('business')}>Business setup</Button>
              </Group>
            </Stack>
          </Group>
        </Card>
      </>
    );
  }
  if (list.error && !list.data) return <>{header}<ErrorState error={list.error} onRetry={list.reload} /></>;
  if (!list.data) return <>{header}<Loading /></>;
  const data = list.data;
  const funnel = data.funnels.find((f) => f.id === sel) ?? null;

  return (
    <>
      {header}
      <SimpleGrid cols={{ base: 1, lg: 3 }} spacing="lg">
        <Stack gap="md">
          {data.funnels.map((f) => <FunnelCard key={f.id} f={f} active={f.id === sel} onOpen={() => setSel(f.id)} />)}
          <FunnelCopilot list={data} selected={funnel}
            onCreate={(p) => setCreating({ template: null, proposal: p })}
            onLoad={(p) => { setPending(p); notifications.show({ title: 'Loaded into the editor', message: 'Review the stages, then save. Leads in a removed stage need somewhere to go.', color: 'ink' }); }}
            onTemplate={(t) => setCreating({ template: t })} />
        </Stack>
        <div style={{ gridColumn: 'span 2', minWidth: 0 }}>
          {funnel
            ? <FunnelDetail key={funnel.id} f={funnel} list={data} pending={pending} clearPending={() => setPending(null)} onChanged={list.reload}
                onDeleted={() => { setSel(null); list.reload(); }} />
            : <Card><Text size="sm" c="dimmed">No funnels yet. Create one from a template or with the co-pilot.</Text></Card>}
        </div>
      </SimpleGrid>
      <CreateFunnel opened={!!creating} init={creating} templates={data.templates} onClose={() => setCreating(null)}
        onSaved={(f) => { setCreating(null); list.reload(); setSel(f.id); }} />
    </>
  );
}

function FunnelCard({ f, active, onOpen }: { f: LeadFunnelDTO; active: boolean; onOpen: () => void }) {
  const open = f.stages.filter((s) => s.kind !== 'lost');
  return (
    <UnstyledButton onClick={onOpen}>
      <Card withBorder padding="md" style={{ outline: active ? '2px solid var(--mantine-color-ink-filled)' : undefined }}>
        <Group justify="space-between" wrap="nowrap" mb={4}>
          <Text fw={650} truncate>{f.name}</Text>
          <Group gap={6} wrap="nowrap">
            {f.isDefault && <Badge size="sm" tt="none" variant="filled" color="ink">Default</Badge>}
            <Mono size="sm">{f.leads.toLocaleString('en-US')}</Mono>
          </Group>
        </Group>
        {f.description && <Text size="xs" c="dimmed" lineClamp={2} mb={6}>{f.description}</Text>}
        <Group gap={4} wrap="wrap">
          {open.map((s) => <Badge key={s.key} size="xs" tt="none" variant={s.kind === 'won' ? 'filled' : 'light'} color="ink">{s.label} · {f.byStage[s.key] ?? 0}</Badge>)}
        </Group>
      </Card>
    </UnstyledButton>
  );
}

// ---------- One funnel: report and editor ----------

function FunnelDetail({ f, list, pending, clearPending, onChanged, onDeleted }: {
  f: LeadFunnelDTO; list: LeadFunnelsDTO; pending: Proposal | null; clearPending: () => void; onChanged: () => void; onDeleted: () => void;
}) {
  const [tab, setTab] = useState<string | null>('report');
  const [d, setD] = useState<Draft>(() => toDraft(f));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [remap, setRemap] = useState<{ keys: string[]; message: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const can = useCan();
  const writable = can('crm:write');

  useEffect(() => { if (!dirty) setD(toDraft(f)); }, [f, dirty]);
  useEffect(() => {
    if (!pending) return;
    setD((x) => ({ ...x, stages: pending.stages.map((s) => ({ ...s })), match: pending.match }));
    setDirty(true);
    setTab('edit');
    clearPending();
  }, [pending, clearPending]);

  const edit = (patch: Partial<Draft>) => { setD((x) => ({ ...x, ...patch })); setDirty(true); };
  const save = (mapping?: Record<string, string>) => {
    setBusy('save');
    apiSend<LeadFunnelDTO>('PUT', `/api/crm/funnels/${encodeURIComponent(f.id)}`, { name: d.name, description: d.description, stages: cleanStages(d.stages), match: d.match, ...(mapping ? { remap: mapping } : {}) })
      .then(() => { setDirty(false); setRemap(null); onChanged(); notifications.show({ title: 'Funnel saved', message: `${d.name} now has ${d.stages.length} stages.`, color: 'ink' }); })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 409) {
          const keys = d.stages.map((s) => s.key);
          const held = f.stages.filter((s) => !keys.includes(s.key) && (f.byStage[s.key] ?? 0) > 0).map((s) => s.key);
          setRemap({ keys: held.length ? held : f.stages.filter((s) => !keys.includes(s.key)).map((s) => s.key), message: errMsg(e) });
        } else fail('Couldn’t save the funnel')(e);
      })
      .finally(() => setBusy(null));
  };
  const makeDefault = () => {
    setBusy('default');
    apiSend('POST', `/api/crm/funnels/${encodeURIComponent(f.id)}/default`).then(onChanged).catch(fail('Couldn’t make it the default')).finally(() => setBusy(null));
  };

  return (
    <Card>
      <SectionTitle note={f.description || undefined}
        right={(
          <Group gap="xs">
            {f.isDefault ? <Badge tt="none" variant="filled" color="ink" size="lg">Default funnel</Badge>
              : <NeedsTip perm="crm:write"><Button size="xs" variant="default" leftSection={<IconStar size={14} />} loading={busy === 'default'} disabled={!writable} onClick={makeDefault}>Make default</Button></NeedsTip>}
            {!f.isDefault && <NeedsTip perm="crm:write"><Button size="xs" variant="default" color="accent" leftSection={<IconTrash size={14} />} disabled={!writable} onClick={() => setDeleting(true)}>Delete</Button></NeedsTip>}
          </Group>
        )}>{f.name} · {f.leads.toLocaleString('en-US')} leads</SectionTitle>
      <Tabs value={tab} onChange={setTab}>
        <Tabs.List mb="md">
          <Tabs.Tab value="report">Report</Tabs.Tab>
          <Tabs.Tab value="edit">Stages and rules{dirty ? ' · unsaved' : ''}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="report"><FunnelReport id={f.id} /></Tabs.Panel>
        <Tabs.Panel value="edit">
          <FunnelEditor d={d} edit={edit} milestones={list.milestones} held={f.byStage} isDefault={f.isDefault} />
          <Group mt="md" gap="sm">
            <NeedsTip perm="crm:write"><Button loading={busy === 'save'} disabled={!dirty || !d.name.trim() || !writable} onClick={() => save()}>Save funnel</Button></NeedsTip>
            {dirty && <Button variant="default" onClick={() => { setDirty(false); setD(toDraft(f)); }}>Discard changes</Button>}
          </Group>
        </Tabs.Panel>
      </Tabs>
      <RemapModal remap={remap} f={f} stages={d.stages} busy={busy === 'save'} onClose={() => setRemap(null)} onConfirm={save} />
      <DeleteFunnel opened={deleting} f={f} list={list} onClose={() => setDeleting(false)} onDeleted={() => { setDeleting(false); onDeleted(); }} />
    </Card>
  );
}

function FunnelReport({ id }: { id: string }) {
  const p = usePal();
  const [range, setRange] = useState<'30' | '90' | 'all'>('90');
  const r = useApi<LeadFunnelReportDTO>(`/api/crm/funnels/${encodeURIComponent(id)}/report?range=${range}`);
  const control = <SegmentedControl size="xs" value={range} onChange={(v) => setRange(v as typeof range)} data={[{ value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: 'all', label: 'All time' }]} />;
  if (r.error && !r.data) return <ErrorState error={r.error} onRetry={r.reload} />;
  if (!r.data) return <Loading />;
  const d = r.data;
  const flow = d.stages.filter((s) => s.kind !== 'lost');
  const closed = d.stages.filter((s) => s.kind === 'lost');
  const top = Math.max(1, d.cohort, ...flow.map((s) => s.reached));

  return (
    <Stack gap="lg">
      <Group justify="space-between" wrap="wrap">
        <Text size="sm" c="dimmed">Leads created {range === 'all' ? 'at any time' : `in the last ${range} days`}, followed through the stages.</Text>
        {control}
      </Group>
      <SimpleGrid cols={{ base: 2, sm: 5 }}>
        <StatCard label="Leads" value={d.cohort.toLocaleString('en-US')} note="in this range" />
        <StatCard label="Open" value={d.overall.open.toLocaleString('en-US')} />
        <StatCard label="Won" value={d.overall.won.toLocaleString('en-US')} />
        <StatCard label="Lost" value={d.overall.lost.toLocaleString('en-US')} tone={d.overall.lost > d.overall.won && d.overall.lost > 0 ? 'warn' : undefined} />
        <StatCard label="Win rate" value={pct(d.overall.winRate)} note="won ÷ closed" />
      </SimpleGrid>
      {d.cohort === 0 ? <Text size="sm" c="dimmed">No leads were created in this range yet.</Text> : (
        <Table.ScrollContainer minWidth={720}>
          <Table fz="sm" verticalSpacing="xs" highlightOnHover={false}>
            <Table.Thead><Table.Tr>
              <Table.Th>Stage</Table.Th><Table.Th w="34%">Reached</Table.Th><Table.Th ta="right">From previous</Table.Th><Table.Th ta="right">Median days</Table.Th>
              <Table.Th ta="right">In stage now</Table.Th><Table.Th ta="right">Lost from here</Table.Th>
            </Table.Tr></Table.Thead>
            <Table.Tbody>
              {flow.map((s, i) => {
                const low = s.conv !== null && s.conv < 0.25 && i > 0;
                return (
                  <Table.Tr key={s.key}>
                    <Table.Td><Text size="sm" fw={600}>{s.label}</Text>{s.kind === 'won' && <Text size="xs" c="dimmed">Won</Text>}</Table.Td>
                    <Table.Td>
                      <Group gap="sm" wrap="nowrap">
                        <Box style={{ flex: 1 }}><Bar value={s.reached} max={top} height={10} color={s.kind === 'won' ? p.ink : p.bar} /></Box>
                        <Mono size="sm" w={56} ta="right">{s.reached.toLocaleString('en-US')}</Mono>
                      </Group>
                    </Table.Td>
                    <Table.Td ta="right"><Mono size="sm" c={low ? p.warnText : undefined}>{pct(s.conv)}</Mono></Table.Td>
                    <Table.Td ta="right"><Mono size="sm">{s.medianDays === null ? '—' : s.medianDays.toFixed(1)}</Mono></Table.Td>
                    <Table.Td ta="right"><Mono size="sm">{s.now.toLocaleString('en-US')}</Mono></Table.Td>
                    <Table.Td ta="right"><Mono size="sm" c={s.lostFrom ? p.warnText : 'dimmed'}>{s.lostFrom.toLocaleString('en-US')}</Mono></Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      {closed.length > 0 && (
        <Group gap="xs" wrap="wrap">
          <Text size="sm" c="dimmed">Closed lost:</Text>
          {closed.map((s) => <Badge key={s.key} tt="none" variant="light" color="accent">{s.label} · {s.now.toLocaleString('en-US')}</Badge>)}
        </Group>
      )}
      {d.sources.length > 0 && (
        <div>
          <SectionTitle note="Where this range’s leads came from, and how many were won.">Sources</SectionTitle>
          <Table fz="sm" verticalSpacing={4} maw={480}>
            <Table.Thead><Table.Tr><Table.Th>Source</Table.Th><Table.Th ta="right">Leads</Table.Th><Table.Th ta="right">Won</Table.Th><Table.Th ta="right">Won share</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>{d.sources.map((s) => (
              <Table.Tr key={s.source}><Table.Td>{s.source}</Table.Td><Table.Td ta="right"><Mono size="sm">{s.n}</Mono></Table.Td><Table.Td ta="right"><Mono size="sm">{s.won}</Mono></Table.Td><Table.Td ta="right"><Mono size="sm">{pct(s.n ? s.won / s.n : null)}</Mono></Table.Td></Table.Tr>
            ))}</Table.Tbody>
          </Table>
        </div>
      )}
    </Stack>
  );
}

/** Problems the server will reject or fix, shown while editing (the server has the final word). */
function stageHints(rows: Row[]): string[] {
  const out: string[] = [];
  const keys = rows.map((r) => r.key);
  rows.forEach((r) => { if (!KEY_RX.test(r.key)) out.push(`“${r.label || r.key || 'Untitled'}” needs a key of lower-case letters, digits and underscores, starting with a letter.`); });
  const dup = keys.filter((k, i) => k && keys.indexOf(k) !== i);
  if (dup.length) out.push(`Stage keys must be unique: ${Array.from(new Set(dup)).join(', ')}.`);
  const ms = rows.map((r) => r.milestone).filter(Boolean) as string[];
  const dupM = ms.filter((m, i) => ms.indexOf(m) !== i);
  if (dupM.length) out.push(`A milestone can stand for one stage only: ${Array.from(new Set(dupM)).map((m) => MILESTONE_LABELS[m] ?? m).join(', ')}.`);
  if (!rows.some((r) => r.kind === 'open')) out.push('A funnel needs at least one open stage.');
  else if (rows[0] && rows[0].kind !== 'open') out.push('The first stage should be open: new leads start there.');
  if (!rows.some((r) => r.key === 'dnc')) out.push('A do-not-contact stage (dnc) is added on save: every funnel keeps one.');
  return out;
}

function FunnelEditor({ d, edit, milestones, held, isDefault }: { d: Draft; edit: (p: Partial<Draft>) => void; milestones: LeadFunnelsDTO['milestones']; held: Record<string, number>; isDefault: boolean }) {
  const p = usePal();
  const { personas } = useLookups();
  const hints = stageHints(d.stages);
  const setRow = (i: number, patch: Partial<Row>) => edit({ stages: d.stages.map((r, j) => {
    if (j !== i) return r;
    const next = { ...r, ...patch };
    if (patch.label !== undefined && r.auto) next.key = stageKey(patch.label);
    if (patch.kind && patch.kind !== 'open') next.callable = false;
    return next;
  }) });
  const move = (i: number, by: number) => {
    const s = [...d.stages];
    const j = i + by;
    if (j < 0 || j >= s.length) return;
    [s[i], s[j]] = [s[j], s[i]];
    edit({ stages: s });
  };
  const add = () => {
    const at = d.stages.findIndex((r) => r.kind !== 'open');
    const row: Row = { key: '', label: '', description: '', milestone: null, kind: 'open', callable: true, auto: true };
    const s = [...d.stages];
    s.splice(at < 0 ? s.length : at, 0, row);
    edit({ stages: s });
  };
  const usedMilestones = (i: number) => new Set(d.stages.filter((_, j) => j !== i).map((r) => r.milestone).filter(Boolean));

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput label="Name" value={d.name} onChange={(e) => edit({ name: e.currentTarget.value })} />
        <TextInput label="Description" value={d.description} onChange={(e) => edit({ description: e.currentTarget.value })} />
      </SimpleGrid>
      <div>
        <SectionTitle note="In order. A milestone ties the stage to the framework: calls move leads to contacted, qualified and meeting booked on their own; outcome milestones are credited to the call before them. Campaigns only call leads in callable open stages."
          right={<Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={add}>Add stage</Button>}>Stages</SectionTitle>
        <Table.ScrollContainer minWidth={860}>
          <Table fz="sm" verticalSpacing={6} highlightOnHover={false}>
            <Table.Thead><Table.Tr>
              <Table.Th w={70}>Order</Table.Th><Table.Th>Label</Table.Th><Table.Th w={150}>Key</Table.Th><Table.Th w={190}>Milestone</Table.Th><Table.Th w={110}>Kind</Table.Th>
              <Table.Th w={80}>Callable</Table.Th><Table.Th w={70} ta="right">Leads</Table.Th><Table.Th w={40} />
            </Table.Tr></Table.Thead>
            <Table.Tbody>
              {d.stages.map((r, i) => {
                const dnc = r.key === 'dnc';
                const used = usedMilestones(i);
                return (
                  <Table.Tr key={i}>
                    <Table.Td>
                      <Group gap={0} wrap="nowrap">
                        <ActionIcon size="sm" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><IconArrowUp size={14} /></ActionIcon>
                        <ActionIcon size="sm" aria-label="Move down" disabled={i === d.stages.length - 1} onClick={() => move(i, 1)}><IconArrowDown size={14} /></ActionIcon>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <TextInput size="xs" value={r.label} placeholder="Stage name" onChange={(e) => setRow(i, { label: e.currentTarget.value })} />
                      <TextInput size="xs" mt={4} value={r.description} placeholder="What has happened when a lead is here (optional)" onChange={(e) => setRow(i, { description: e.currentTarget.value })} />
                    </Table.Td>
                    <Table.Td><TextInput size="xs" ff="monospace" value={r.key} disabled={dnc} error={r.key && !KEY_RX.test(r.key) ? true : undefined} onChange={(e) => setRow(i, { key: e.currentTarget.value, auto: false })} /></Table.Td>
                    <Table.Td>
                      <Select size="xs" clearable allowDeselect placeholder="None" disabled={dnc} value={r.milestone}
                        data={milestones.map((m) => ({ value: m.id, label: m.label, disabled: used.has(m.id) }))}
                        onChange={(v) => setRow(i, { milestone: (v as FunnelMilestone | null) ?? null })} />
                    </Table.Td>
                    <Table.Td>
                      <Select size="xs" disabled={dnc} value={r.kind} data={(['open', 'won', 'lost'] as const).map((k) => ({ value: k, label: KIND_LABEL[k] }))} onChange={(v) => v && setRow(i, { kind: v as Row['kind'] })} />
                    </Table.Td>
                    <Table.Td>
                      <Tooltip label={r.kind === 'open' ? 'Campaigns may call leads in this stage' : 'Won and lost stages are never called'}>
                        <span><Switch size="sm" checked={r.kind === 'open' && r.callable} disabled={r.kind !== 'open'} onChange={() => setRow(i, { callable: !r.callable })} /></span>
                      </Tooltip>
                    </Table.Td>
                    <Table.Td ta="right"><Mono size="sm" c={held[r.key] ? undefined : 'dimmed'}>{held[r.key] ?? 0}</Mono></Table.Td>
                    <Table.Td>
                      <Tooltip label={dnc ? 'Every funnel keeps a do-not-contact stage' : 'Remove stage'}>
                        <ActionIcon size="sm" color="accent" aria-label="Remove stage" disabled={dnc} onClick={() => edit({ stages: d.stages.filter((_, j) => j !== i) })}><IconTrash size={14} /></ActionIcon>
                      </Tooltip>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        {hints.length > 0 && <Stack gap={2} mt="xs">{hints.map((h) => <Text key={h} size="xs" c={h.startsWith('A do-not-contact') ? 'dimmed' : p.warnText}>{h}</Text>)}</Stack>}
      </div>
      <div>
        <SectionTitle note={isDefault ? 'The default funnel takes every new lead no other funnel matches; rules here make it take matching leads first.' : 'New leads that match go to this funnel; the default funnel takes the rest. Empty lists match nothing.'}>Who goes in this funnel</SectionTitle>
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <MultiSelect label="Persona paths" data={PATHS} value={d.match.paths} onChange={(v) => edit({ match: { ...d.match, paths: v } })} />
          <MultiSelect label="Personas" searchable data={personas.map((x) => ({ value: x.id, label: `${x.id} ${x.name}` }))} value={d.match.personas} onChange={(v) => edit({ match: { ...d.match, personas: v } })} />
          <MultiSelect label="Lead sources" data={SOURCES} value={d.match.sources} onChange={(v) => edit({ match: { ...d.match, sources: v } })} />
        </SimpleGrid>
      </div>
    </Stack>
  );
}

function RemapModal({ remap, f, stages, busy, onClose, onConfirm }: { remap: { keys: string[]; message: string } | null; f: LeadFunnelDTO; stages: Row[]; busy: boolean; onClose: () => void; onConfirm: (m: Record<string, string>) => void }) {
  const [map, setMap] = useState<Record<string, string>>({});
  useEffect(() => { setMap({}); }, [remap]);
  if (!remap) return null;
  const options = stages.filter((s) => KEY_RX.test(s.key)).map((s) => ({ value: s.key, label: `${s.label || s.key} (${s.key})` }));
  const ready = remap.keys.every((k) => map[k]);
  return (
    <Modal opened onClose={onClose} title="Where should these leads go?" size="lg">
      <Text size="sm" c="dimmed" mb="sm">{remap.message}</Text>
      <Stack gap="sm">
        {remap.keys.map((k) => {
          const old = f.stages.find((s) => s.key === k);
          return (
            <Group key={k} gap="sm" wrap="nowrap" align="flex-end">
              <Text size="sm" w={220}>{old?.label ?? k} · <Mono size="sm">{f.byStage[k] ?? 0}</Mono> leads</Text>
              <Select style={{ flex: 1 }} label="Move to" data={options} value={map[k] ?? null} onChange={(v) => v && setMap({ ...map, [k]: v })} />
            </Group>
          );
        })}
      </Stack>
      <Group mt="md"><Button loading={busy} disabled={!ready} onClick={() => onConfirm(map)}>Move leads and save</Button><Button variant="default" onClick={onClose}>Cancel</Button></Group>
    </Modal>
  );
}

function DeleteFunnel({ opened, f, list, onClose, onDeleted }: { opened: boolean; f: LeadFunnelDTO; list: LeadFunnelsDTO; onClose: () => void; onDeleted: () => void }) {
  const others = list.funnels.filter((x) => x.id !== f.id);
  const [moveTo, setMoveTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (opened) setMoveTo(others.find((x) => x.isDefault)?.id ?? others[0]?.id ?? null); }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = () => {
    setBusy(true);
    apiSend('DELETE', `/api/crm/funnels/${encodeURIComponent(f.id)}${f.leads > 0 && moveTo ? `?moveTo=${encodeURIComponent(moveTo)}` : ''}`)
      .then(() => { notifications.show({ title: 'Funnel deleted', message: f.leads > 0 ? `Its ${f.leads} leads moved to ${others.find((x) => x.id === moveTo)?.name}.` : `${f.name} is gone.`, color: 'ink' }); onDeleted(); })
      .catch(fail('Couldn’t delete the funnel'))
      .finally(() => setBusy(false));
  };
  return (
    <Modal opened={opened} onClose={onClose} title={`Delete ${f.name}?`}>
      {f.leads > 0 ? (
        <>
          <Text size="sm" c="dimmed" mb="sm">It has {f.leads} leads. They move to another funnel, into the stage with the same milestone (or its first stage).</Text>
          <Select label="Move leads to" data={others.map((x) => ({ value: x.id, label: x.name }))} value={moveTo} onChange={setMoveTo} />
        </>
      ) : <Text size="sm" c="dimmed">It has no leads. Campaigns filtered to it will find none.</Text>}
      <Group mt="md"><Button color="accent" loading={busy} disabled={f.leads > 0 && !moveTo} onClick={run}>Delete funnel</Button><Button variant="default" onClick={onClose}>Cancel</Button></Group>
    </Modal>
  );
}

function CreateFunnel({ opened, init, templates, onClose, onSaved }: {
  opened: boolean; init: { template: string | null; proposal?: Proposal } | null; templates: LeadFunnelsDTO['templates']; onClose: () => void; onSaved: (f: LeadFunnelDTO) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [template, setTemplate] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!opened) return;
    const t = templates.find((x) => x.id === init?.template);
    setTemplate(init?.template ?? null);
    setName(init?.proposal?.name ?? t?.name ?? '');
    setDescription(init?.proposal?.description ?? t?.description ?? '');
  }, [opened, init, templates]);
  const proposal = init?.proposal;
  const save = () => {
    setBusy(true);
    const body = proposal ? { name, description, stages: proposal.stages, match: proposal.match } : { name, description, ...(template ? { template } : {}) };
    apiSend<LeadFunnelDTO>('POST', '/api/crm/funnels', body)
      .then((f) => { notifications.show({ title: 'Funnel created', message: `${f.name} with ${f.stages.length} stages.`, color: 'ink' }); onSaved(f); })
      .catch(fail('Couldn’t create the funnel'))
      .finally(() => setBusy(false));
  };
  return (
    <Modal opened={opened} onClose={onClose} title={proposal ? 'Create the proposed funnel' : 'New funnel'} size="lg">
      <Stack gap="sm">
        <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
        <Textarea label="Description" autosize minRows={2} value={description} onChange={(e) => setDescription(e.currentTarget.value)} />
        {proposal ? <Text size="sm" c="dimmed">Stages: {proposal.stages.map((s) => s.label).join(' → ')}</Text> : (
          <Select label="Start from" clearable allowDeselect placeholder="The default funnel’s stages" data={templates.map((t) => ({ value: t.id, label: t.name }))} value={template}
            onChange={(v) => { setTemplate(v); const t = templates.find((x) => x.id === v); if (t && !name.trim()) { setName(t.name); setDescription(t.description); } }}
            description={templates.find((t) => t.id === template)?.description} />
        )}
      </Stack>
      <Group mt="md"><Button loading={busy} disabled={!name.trim()} onClick={save}>Create funnel</Button><Button variant="default" onClick={onClose}>Cancel</Button></Group>
    </Modal>
  );
}

// ---------- Co-pilot ----------

function FunnelCopilot({ list, selected, onCreate, onLoad, onTemplate }: {
  list: LeadFunnelsDTO; selected: LeadFunnelDTO | null; onCreate: (p: Proposal) => void; onLoad: (p: Proposal) => void; onTemplate: (id: string) => void;
}) {
  const [instruction, setInstruction] = useState('');
  const [base, setBase] = useState(false);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<FunnelProposalDTO | null>(null);
  const can = useCan();
  const allow = useAllow();
  const ms = useMemo(() => Object.fromEntries(list.milestones.map((m) => [m.id, m.label])), [list.milestones]);
  const ask = () => {
    setBusy(true);
    setOut(null);
    apiSend<FunnelProposalDTO>('POST', '/api/crm/funnels/copilot', { instruction, ...(base && selected ? { funnelId: selected.id } : {}) })
      .then(setOut)
      .catch(fail('The co-pilot couldn’t design a funnel'))
      .finally(() => setBusy(false));
  };

  return (
    <Card>
      <SectionTitle note="Describe how your leads become customers; it drafts the stages from the business profile.">
        <Group gap={6}><IconWand size={18} />Co-pilot</Group>
      </SectionTitle>
      {!list.copilot ? (
        <Stack gap="xs">
          <Text size="sm" c="dimmed">{NO_CLAUDE_KEY}</Text>
          {list.templates.length > 0 && <Text size="sm" fw={600} mt={4}>Start from a template</Text>}
          {list.templates.map((t) => (
            <UnstyledButton key={t.id} disabled={!can('crm:write')} onClick={() => onTemplate(t.id)}>
              <Card withBorder padding="sm"><Text size="sm" fw={600}>{t.name}</Text><Text size="xs" c="dimmed">{t.description}</Text></Card>
            </UnstyledButton>
          ))}
        </Stack>
      ) : (
        <Stack gap="sm">
          <Textarea autosize minRows={3} placeholder="For example: a funnel for broker partners — registration, first lead sent, first deal closed." value={instruction} onChange={(e) => setInstruction(e.currentTarget.value)} />
          {selected && <Switch size="sm" label={`Start from ${selected.name}`} description="Revise this funnel instead of designing a new one" checked={base} onChange={() => setBase(!base)} />}
          <Group gap="xs">
            <NeedsTip perm={['copilot:use', 'crm:write']} feature="copilot"><Button size="xs" leftSection={<IconWand size={14} />} loading={busy} disabled={busy || !allow(['copilot:use', 'crm:write'], 'copilot')} onClick={ask}>Design a funnel</Button></NeedsTip>
            {list.templates.length > 0 && (
              <Select size="xs" w={180} placeholder="Or use a template" data={list.templates.map((t) => ({ value: t.id, label: t.name }))} value={null} disabled={!can('crm:write')} onChange={(v) => v && onTemplate(v)} />
            )}
          </Group>
          {busy && <CopilotWorking label="Designing the funnel from the business profile…" />}
          {out && (
            <Card withBorder padding="sm">
              <Text fw={650}>{out.funnel.name}</Text>
              {out.funnel.description && <Text size="xs" c="dimmed" mb={6}>{out.funnel.description}</Text>}
              <Stack gap={4} my="xs">
                {out.funnel.stages.map((s, i) => (
                  <Group key={`${s.key}-${i}`} gap={6} wrap="nowrap" align="flex-start">
                    <Mono size="xs" c="dimmed" w={18}>{i + 1}</Mono>
                    <Stack gap={0} style={{ minWidth: 0 }}>
                      <Text size="sm" fw={600}>{s.label} {s.kind !== 'open' && <Badge size="xs" tt="none" variant="light" color={s.kind === 'lost' ? 'accent' : 'ink'}>{KIND_LABEL[s.kind]}</Badge>}</Text>
                      <Text size="xs" c="dimmed">{s.milestone ? `Milestone: ${ms[s.milestone] ?? s.milestone}` : 'No milestone'}{s.kind === 'open' ? (s.callable ? ' · callable' : ' · not called') : ''}{s.description ? ` · ${s.description}` : ''}</Text>
                    </Stack>
                  </Group>
                ))}
              </Stack>
              {(out.funnel.match.paths.length > 0 || out.funnel.match.personas.length > 0 || out.funnel.match.sources.length > 0) && (
                <Text size="xs" c="dimmed" mb={6}>Takes new leads matching: {[...out.funnel.match.paths, ...out.funnel.match.personas, ...out.funnel.match.sources].join(', ')}</Text>
              )}
              <Text size="sm" mb="xs">{out.reason}</Text>
              <CopilotQuestions questions={out.questions} />
              <Group gap="xs" mt="sm">
                <Button size="xs" onClick={() => onCreate(out.funnel)}>Create as new funnel</Button>
                <Button size="xs" variant="default" disabled={!selected} onClick={() => onLoad(out.funnel)}>Replace {selected ? `${selected.name}’s` : 'this funnel’s'} stages</Button>
              </Group>
              <Box mt="xs"><CopilotUsageLine usage={out.usage} /></Box>
            </Card>
          )}
          {!out && !busy && <Alert color="gray" variant="light" radius="md">Proposals change nothing until you create the funnel or save the edited stages.</Alert>}
        </Stack>
      )}
    </Card>
  );
}
