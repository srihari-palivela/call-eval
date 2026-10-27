// The taxonomy editor and its co-pilot. Definitions change only in a draft; activating the draft makes it
// the version newly scored calls are tagged with. The co-pilot proposes operations a person picks from.
import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon, Alert, Anchor, Badge, Box, Button, Card, Checkbox, Collapse, Drawer, Group, Menu, Modal, SegmentedControl, Select, SimpleGrid, Stack, Table, Tabs,
  TagsInput, Text, TextInput, Textarea, Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowDown, IconArrowUp, IconChevronDown, IconPencil, IconPlus, IconTemplate, IconTrash, IconWand } from '@tabler/icons-react';
import type {
  Checkpoint, CheckpointDetect, EventDef, EventGroup, PersonaDef, ScenarioDef, TaxonomyCopilotMode, TaxonomyDoc, TaxonomyDTO, TaxonomyKind, TaxonomyOp, TaxonomyProposalDTO,
} from '@calleval/framework';
import { usePal } from '../theme';
import { ApiError, apiSend, errMsg, useApi } from '../api';
import { ErrorState, Loading, Mono, SectionTitle } from './ui';
import { CopilotQuestions, CopilotUsageLine, CopilotWorking, NO_CLAUDE_KEY } from './copilot';
import { useStore } from '../store';
import { NeedsTip, useAllow, useCan } from './access';

type Entry = PersonaDef | ScenarioDef | EventDef;
type Edit = { kind: TaxonomyKind; entry: Entry; isNew: boolean };
type Body = Pick<TaxonomyDoc, 'domain' | 'personas' | 'scenarios' | 'events'>;
type RuleName = Extract<CheckpointDetect, { by: 'rule' }>['rule'];

const KIND_LABEL: Record<TaxonomyKind, string> = { persona: 'Persona', scenario: 'Scenario', event: 'Event' };
const GROUPS: EventGroup[] = ['Objections', 'Caller behaviour', 'Agent or system', 'Outcome moments'];
const PATH_OPTIONS = [
  { value: 'Investor', label: 'Investor (buyer path)', note: 'Buyer discovery (budget, location, timeline…) is scored; broker registration checks don’t apply.' },
  { value: 'Broker', label: 'Broker (partner path)', note: 'Registration and project-brief checks apply; asking buyer discovery questions counts against the agent.' },
  { value: 'Non-target', label: 'Non-target', note: 'Not a prospect: routed or closed politely, and left out of sales metrics.' },
];
const MODES: { value: TaxonomyCopilotMode; label: string; help: string; placeholder: string; working: string }[] = [
  { value: 'draft', label: 'Design from business profile', help: 'Drafts a whole taxonomy (personas, scenarios, events and the domain sentence) from Business setup and what the agent’s tools do.',
    placeholder: 'Anything to emphasise, for example: we also take inbound calls from existing owners about handover.', working: 'Designing a taxonomy from the business profile…' },
  { value: 'edit', label: 'Edit with an instruction', help: 'Changes the draft as you ask, keeping ids stable where entries only change.',
    placeholder: 'For example: split Yield investor into short-term rental and long-term rental investors.', working: 'Working out the edits…' },
  { value: 'review', label: 'Review against recent calls', help: 'Reads recent unclassified, Other and low-confidence calls, the clusters and the health figures, and proposes what is missing or overlapping.',
    placeholder: 'Optional focus, for example: why are so many calls Unclassified?', working: 'Reviewing recent calls, clusters and taxonomy health…' },
];
const SLUG = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
const nameOf = (e: Partial<Entry> | null | undefined) => (e ? ('name' in e && e.name ? e.name : 'label' in e && e.label ? e.label : '') : '');
const fail = (title: string) => (e: unknown) => notifications.show({ title, message: errMsg(e), color: 'accent' });
const bodyOf = (doc: TaxonomyDoc, patch: Partial<Body> = {}): Body => ({ domain: doc.domain, personas: doc.personas, scenarios: doc.scenarios, events: doc.events, ...patch });

const NEW: Record<TaxonomyKind, () => Entry> = {
  persona: () => ({ id: '', name: '', path: 'Investor', signals: '', watch: '', checkLabel: '', basedOn: null, keywords: [] }),
  scenario: () => ({ id: '', name: '', short: '', trigger: '', path: '', success: '', basedOn: null, keywords: [], checkpoints: [] }),
  event: () => ({ id: '', label: '', group: 'Caller behaviour', basedOn: null, keywords: [], system: false }),
};

export function TaxonomyEditor({ initialMode, onActivated }: { initialMode?: string; onActivated: () => void }) {
  const { reloadMeta } = useStore();
  const t = useApi<TaxonomyDTO>('/api/taxonomy');
  const [replace, setReplace] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const createDraft = (from: string, force = false) => {
    setBusy(`draft:${from}`);
    apiSend<TaxonomyDTO>('POST', '/api/taxonomy/draft', { from, ...(force ? { replace: true } : {}) })
      .then((d) => { t.setData(d); setReplace(null); notifications.show({ title: 'Draft started', message: `Edit v${d.draft?.version ?? ''}, then activate it. Calls keep being tagged with the active version until then.`, color: 'ink' }); })
      .catch((e) => { if (e instanceof ApiError && e.status === 409) setReplace(from); else fail('Couldn’t start a draft')(e); })
      .finally(() => setBusy(null));
  };

  if (t.error && !t.data) return <ErrorState error={t.error} onRetry={t.reload} />;
  if (!t.data) return <Loading label="Loading the taxonomy…" />;
  const dto = t.data;

  return (
    <Stack gap="lg">
      <TaxonomyCopilot dto={dto} initialMode={initialMode} onApplied={t.setData} onTemplate={(id) => createDraft(id)} busyTemplate={busy} />
      <Definitions dto={dto} setDto={t.setData} createDraft={createDraft} busy={busy}
        onActivated={() => { t.reload(); reloadMeta(); onActivated(); }} />
      <Modal opened={!!replace} onClose={() => setReplace(null)} title="Replace the current draft?">
        <Text size="sm" c="dimmed">There is already a draft. Starting another one discards its changes.</Text>
        <Group mt="md">
          <Button color="accent" loading={!!busy} onClick={() => replace && createDraft(replace, true)}>Discard it and start again</Button>
          <Button variant="default" onClick={() => setReplace(null)}>Keep the draft</Button>
        </Group>
      </Modal>
    </Stack>
  );
}

// ---------- Definitions: active version or draft ----------

function Definitions({ dto, setDto, createDraft, busy, onActivated }: {
  dto: TaxonomyDTO; setDto: (d: TaxonomyDTO) => void; createDraft: (from: string) => void; busy: string | null; onActivated: () => void;
}) {
  const p = usePal();
  const [tab, setTab] = useState<string | null>('personas');
  const [edit, setEdit] = useState<Edit | null>(null);
  const [retire, setRetire] = useState<{ kind: TaxonomyKind; entry: Entry; calls: number } | null>(null);
  const [activating, setActivating] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [domainEdit, setDomainEdit] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const draft = dto.draft;
  const doc = draft ?? dto.active;
  const can = useCan();
  // Entries change only in a draft, and only for a role that edits the taxonomy.
  const editable = !!draft && can('taxonomy:edit');

  const marks = useMemo(() => {
    const m: Record<string, 'New' | 'Changed'> = {};
    dto.diff?.added.forEach((a) => { m[`${a.kind}:${a.id}`] = 'New'; });
    dto.diff?.changed.forEach((c) => { m[`${c.kind}:${c.id}`] = 'Changed'; });
    return m;
  }, [dto.diff]);
  const usage = (kind: TaxonomyKind, id: string) => (kind === 'persona' ? dto.usage.personas[id] : kind === 'scenario' ? dto.usage.scenarios[id] : undefined) ?? 0;

  const put = (patch: Partial<Body>) => {
    if (!draft) return Promise.reject(new Error('No draft'));
    setSaving(true);
    return apiSend<TaxonomyDTO>('PUT', '/api/taxonomy/draft', bodyOf(draft, patch))
      .then((d) => { setDto(d); return d; })
      .finally(() => setSaving(false));
  };
  const listKey = (kind: TaxonomyKind) => (kind === 'persona' ? 'personas' : kind === 'scenario' ? 'scenarios' : 'events') as 'personas' | 'scenarios' | 'events';
  const saveEntry = (kind: TaxonomyKind, entry: Entry) => {
    if (!draft) return Promise.resolve();
    const k = listKey(kind);
    const cur = draft[k] as Entry[];
    const next = entry.id ? cur.map((x) => (x.id === entry.id ? entry : x)) : [...cur, entry];
    return put({ [k]: next } as Partial<Body>).then(() => { setEdit(null); });
  };
  const doRetire = (kind: TaxonomyKind, id: string) => {
    if (!draft) return;
    const k = listKey(kind);
    put({ [k]: (draft[k] as Entry[]).filter((x) => x.id !== id) } as Partial<Body>)
      .then(() => setRetire(null))
      .catch(fail('Couldn’t retire it'));
  };
  const askRetire = (kind: TaxonomyKind, entry: Entry) => {
    const calls = usage(kind, entry.id);
    if (calls > 0) setRetire({ kind, entry, calls });
    else doRetire(kind, entry.id);
  };
  const discard = () => {
    setSaving(true);
    apiSend<TaxonomyDTO>('DELETE', '/api/taxonomy/draft').then((d) => { setDto(d); setDiscarding(false); }).catch(fail('Couldn’t discard the draft')).finally(() => setSaving(false));
  };

  const mark = (kind: TaxonomyKind, id: string) => {
    const m = marks[`${kind}:${id}`];
    return m ? <Badge size="xs" tt="none" variant={m === 'New' ? 'filled' : 'light'} color="ink" ml={6}>{m}</Badge> : null;
  };
  const actions = (kind: TaxonomyKind, entry: Entry, canRetire = true) => editable ? (
    <Group gap={0} wrap="nowrap" justify="flex-end">
      <Tooltip label="Edit"><ActionIcon size="sm" aria-label="Edit" onClick={(e) => { e.stopPropagation(); setEdit({ kind, entry, isNew: false }); }}><IconPencil size={14} /></ActionIcon></Tooltip>
      {canRetire && <Tooltip label="Retire"><ActionIcon size="sm" color="accent" aria-label="Retire" onClick={(e) => { e.stopPropagation(); askRetire(kind, entry); }}><IconTrash size={14} /></ActionIcon></Tooltip>}
    </Group>
  ) : null;
  const rowProps = (kind: TaxonomyKind, entry: Entry) => (editable ? { onClick: () => setEdit({ kind, entry, isNew: false }), style: { cursor: 'pointer' } } : {});
  const builtinName = (kind: TaxonomyKind, id: string | null) => {
    if (!id) return '—';
    const list: { id: string; name?: string; label?: string }[] = kind === 'persona' ? dto.builtins.personas : kind === 'scenario' ? dto.builtins.scenarios : dto.builtins.events;
    const b = list.find((x) => x.id === id);
    return b ? `${id} ${b.name ?? b.label ?? ''}` : id;
  };
  const addButton = (kind: TaxonomyKind) => editable && (
    <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setEdit({ kind, entry: NEW[kind](), isNew: true })}>Add {KIND_LABEL[kind].toLowerCase()}</Button>
  );

  return (
    <Card>
      <SectionTitle
        note={draft ? 'A draft: calls are tagged with the active version until you activate it. Ids stay stable, so analytics follow an entry across versions.'
          : 'The version every newly scored call is tagged with. Changes go into a draft first.'}
        right={(
          <Group gap="xs">
            {dto.versions.map((v) => <Badge key={v.version} variant={v.status === 'active' ? 'filled' : v.status === 'draft' ? 'outline' : 'light'} color={v.status === 'draft' ? 'accent' : v.status === 'active' ? 'ink' : 'gray'} tt="none">v{v.version} · {v.status}</Badge>)}
            {draft ? (
              <>
                <NeedsTip perm="taxonomy:activate"><Button size="xs" disabled={!can('taxonomy:activate')} onClick={() => setActivating(true)}>Activate draft</Button></NeedsTip>
                <NeedsTip perm="taxonomy:edit"><Button size="xs" variant="default" color="accent" disabled={!can('taxonomy:edit')} onClick={() => setDiscarding(true)}>Discard draft</Button></NeedsTip>
              </>
            ) : (
              <>
                <NeedsTip perm="taxonomy:edit"><Button size="xs" leftSection={<IconPencil size={14} />} loading={busy === 'draft:active'} disabled={!can('taxonomy:edit')} onClick={() => createDraft('active')}>Edit in a draft</Button></NeedsTip>
                {dto.templates.length > 0 && can('taxonomy:edit') && (
                  <Menu position="bottom-end" withinPortal>
                    <Menu.Target><Button size="xs" variant="default" leftSection={<IconTemplate size={14} />} rightSection={<IconChevronDown size={14} />}>From a template</Button></Menu.Target>
                    <Menu.Dropdown>{dto.templates.map((tp) => <Menu.Item key={tp.id} onClick={() => createDraft(tp.id)}><Text size="sm" fw={600}>{tp.name}</Text><Text size="xs" c="dimmed" maw={320}>{tp.description}</Text></Menu.Item>)}</Menu.Dropdown>
                  </Menu>
                )}
              </>
            )}
          </Group>
        )}>
        {draft ? `Draft v${draft.version}` : `Taxonomy v${doc.version}`}
      </SectionTitle>

      <Box mb="md" p="sm" style={{ background: p.soft, borderRadius: 8 }}>
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
            <Text size="xs" c="dimmed" fw={600}>Domain · read by the classifier and judge before the definitions</Text>
            {domainEdit === null ? <Text size="sm">{doc.domain || 'Not set.'}</Text> : (
              <>
                <Textarea autosize minRows={2} value={domainEdit} onChange={(e) => setDomainEdit(e.currentTarget.value)} />
                <Group gap="xs" mt={4}>
                  <Button size="xs" loading={saving} onClick={() => put({ domain: domainEdit }).then(() => setDomainEdit(null)).catch(fail('Couldn’t save the domain'))}>Save</Button>
                  <Button size="xs" variant="default" onClick={() => setDomainEdit(null)}>Cancel</Button>
                </Group>
              </>
            )}
          </Stack>
          {editable && domainEdit === null && <ActionIcon aria-label="Edit the domain" onClick={() => setDomainEdit(doc.domain)}><IconPencil size={16} /></ActionIcon>}
        </Group>
      </Box>

      {draft && dto.diff && <DiffSummary dto={dto} />}

      <Tabs value={tab} onChange={setTab}>
        <Tabs.List mb="sm">
          <Tabs.Tab value="personas">Personas · {doc.personas.length}</Tabs.Tab>
          <Tabs.Tab value="scenarios">Scenarios · {doc.scenarios.length}</Tabs.Tab>
          <Tabs.Tab value="events">Events · {doc.events.length}</Tabs.Tab>
          <Tabs.Tab value="facets">Facets</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="personas">
          {draft && <Group justify="flex-end" mb="xs">{addButton('persona')}</Group>}
          <Table.ScrollContainer minWidth={900}>
            <Table>
              <Table.Thead><Table.Tr><Table.Th w={56}>ID</Table.Th><Table.Th>Persona</Table.Th><Table.Th>Path</Table.Th><Table.Th>Behaves like</Table.Th><Table.Th>Identifying signals</Table.Th><Table.Th ta="right">Calls · 90d</Table.Th>{draft && <Table.Th w={70} />}</Table.Tr></Table.Thead>
              <Table.Tbody>
                {doc.personas.map((r) => (
                  <Table.Tr key={r.id} {...rowProps('persona', r)}>
                    <Table.Td><Mono size="sm" c="dimmed">{r.id}</Mono></Table.Td>
                    <Table.Td><Text size="sm" fw={600} span>{r.name}</Text>{mark('persona', r.id)}{r.watch && <Text size="xs" c="dimmed">Watch for: {r.watch}</Text>}</Table.Td>
                    <Table.Td><Text size="sm" c="dimmed">{r.path}</Text></Table.Td>
                    <Table.Td><Text size="sm" c="dimmed">{builtinName('persona', r.basedOn)}</Text></Table.Td>
                    <Table.Td><Text size="sm">{r.signals}</Text>{r.keywords.length > 0 && <Text size="xs" c="dimmed">Keywords: {r.keywords.join(', ')}</Text>}</Table.Td>
                    <Table.Td ta="right"><Mono size="sm">{usage('persona', r.id).toLocaleString('en-US')}</Mono></Table.Td>
                    {draft && <Table.Td>{actions('persona', r)}</Table.Td>}
                  </Table.Tr>
                ))}
                <Table.Tr>
                  <Table.Td><Mono size="sm" c="dimmed">{doc.p0.id}</Mono></Table.Td>
                  <Table.Td><Text size="sm" fw={600} c="dimmed">{doc.p0.name}</Text><Text size="xs" c="dimmed">Fixed: calls with too little signal</Text></Table.Td>
                  <Table.Td><Text size="sm" c="dimmed">{doc.p0.path}</Text></Table.Td><Table.Td /><Table.Td><Text size="sm" c="dimmed">{doc.p0.signals}</Text></Table.Td>
                  <Table.Td ta="right"><Mono size="sm">{usage('persona', doc.p0.id).toLocaleString('en-US')}</Mono></Table.Td>{draft && <Table.Td />}
                </Table.Tr>
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Tabs.Panel>

        <Tabs.Panel value="scenarios">
          {draft && <Group justify="flex-end" mb="xs">{addButton('scenario')}</Group>}
          <Table.ScrollContainer minWidth={980}>
            <Table>
              <Table.Thead><Table.Tr><Table.Th w={56}>ID</Table.Th><Table.Th>Scenario</Table.Th><Table.Th>Behaves like</Table.Th><Table.Th>Typical trigger</Table.Th><Table.Th>Expected path</Table.Th><Table.Th>Success</Table.Th><Table.Th ta="right">Calls · 90d</Table.Th>{draft && <Table.Th w={70} />}</Table.Tr></Table.Thead>
              <Table.Tbody>
                {doc.scenarios.map((r) => (
                  <Table.Tr key={r.id} {...rowProps('scenario', r)}>
                    <Table.Td><Mono size="sm" c="dimmed">{r.id}</Mono></Table.Td>
                    <Table.Td><Text size="sm" fw={600} span>{r.name}</Text>{mark('scenario', r.id)}</Table.Td>
                    <Table.Td><Text size="sm" c="dimmed">{builtinName('scenario', r.basedOn)}</Text></Table.Td>
                    <Table.Td><Text size="sm">{r.trigger}</Text></Table.Td>
                    <Table.Td>
                      {r.checkpoints.length ? <Text size="sm">{r.checkpoints.map((c) => c.label).join(' → ')}</Text> : <Text size="sm" c="dimmed">{r.path || 'No checkpoints: path adherence not scored'}</Text>}
                    </Table.Td>
                    <Table.Td><Text size="sm">{r.success}</Text></Table.Td>
                    <Table.Td ta="right"><Mono size="sm">{usage('scenario', r.id).toLocaleString('en-US')}</Mono></Table.Td>
                    {draft && <Table.Td>{actions('scenario', r)}</Table.Td>}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Tabs.Panel>

        <Tabs.Panel value="events">
          {draft && <Group justify="flex-end" mb="xs">{addButton('event')}</Group>}
          <Table.ScrollContainer minWidth={760}>
            <Table>
              <Table.Thead><Table.Tr><Table.Th w={170}>Group</Table.Th><Table.Th>Event</Table.Th><Table.Th>Detected by</Table.Th><Table.Th>Keywords</Table.Th>{draft && <Table.Th w={70} />}</Table.Tr></Table.Thead>
              <Table.Tbody>
                {GROUPS.flatMap((g) => doc.events.filter((e) => e.group === g)).concat(doc.events.filter((e) => !GROUPS.includes(e.group))).map((r) => (
                  <Table.Tr key={r.id} {...rowProps('event', r)}>
                    <Table.Td><Text size="sm" c="dimmed">{r.group}</Text></Table.Td>
                    <Table.Td><Text size="sm" fw={600} span>{r.label}</Text>{mark('event', r.id)}<Text size="xs" c="dimmed" ff="monospace">{r.id}</Text></Table.Td>
                    <Table.Td><Text size="sm" c="dimmed">{r.system ? 'Code (fixed)' : 'Classifier'}</Text></Table.Td>
                    <Table.Td><Text size="xs" c="dimmed">{r.keywords.join(', ') || '—'}</Text></Table.Td>
                    {draft && <Table.Td>{actions('event', r, !r.system)}</Table.Td>}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Tabs.Panel>

        <Tabs.Panel value="facets">
          <Text size="sm" c="dimmed" mb="xs">Facets are computed by the pipeline from call data, so they aren’t edited here.</Text>
          <Table.ScrollContainer minWidth={640}>
            <Table>
              <Table.Thead><Table.Tr><Table.Th w={220}>Facet</Table.Th><Table.Th>Values</Table.Th><Table.Th>Source</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>{doc.facets.map((f) => <Table.Tr key={f.id}><Table.Td><Text size="sm" fw={600}>{f.name}</Text></Table.Td><Table.Td><Text size="sm">{f.values}</Text></Table.Td><Table.Td><Text size="sm" c="dimmed">{f.source}</Text></Table.Td></Table.Tr>)}</Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Tabs.Panel>
      </Tabs>

      <EntryDrawer edit={edit} dto={dto} onClose={() => setEdit(null)} onSave={saveEntry} />
      <Modal opened={!!retire} onClose={() => setRetire(null)} title={retire ? `Retire ${retire.entry.id} ${nameOf(retire.entry)}?` : ''}>
        {retire && <Text size="sm" c="dimmed">It has {retire.calls.toLocaleString('en-US')} scored calls in the last 90 days. They keep their tag; once the draft is active, new calls can’t get it. Re-score recent calls when you activate to re-tag them.</Text>}
        <Group mt="md"><Button color="accent" loading={saving} onClick={() => retire && doRetire(retire.kind, retire.entry.id)}>Retire it in the draft</Button><Button variant="default" onClick={() => setRetire(null)}>Cancel</Button></Group>
      </Modal>
      <Modal opened={discarding} onClose={() => setDiscarding(false)} title={draft ? `Discard draft v${draft.version}?` : ''}>
        <Text size="sm" c="dimmed">Its changes are lost. The active version stays as it is.</Text>
        <Group mt="md"><Button color="accent" loading={saving} onClick={discard}>Discard draft</Button><Button variant="default" onClick={() => setDiscarding(false)}>Keep it</Button></Group>
      </Modal>
      {draft && <ActivateModal opened={activating} dto={dto} onClose={() => setActivating(false)} onDone={() => { setActivating(false); onActivated(); }} />}
    </Card>
  );
}

function DiffSummary({ dto }: { dto: TaxonomyDTO }) {
  const p = usePal();
  const d = dto.diff!;
  const none = !d.added.length && !d.changed.length && !d.retired.length && !d.domainChanged;
  return (
    <Card withBorder padding="sm" mb="md">
      <Text size="sm" fw={650} mb={6}>Changes against v{dto.active.version}</Text>
      {none ? <Text size="sm" c="dimmed">No changes yet. Edit an entry, add one, or ask the co-pilot.</Text> : (
        <Stack gap={6}>
          {d.domainChanged && <Text size="sm">Domain sentence changed.</Text>}
          {d.added.length > 0 && <Group gap={6} wrap="wrap"><Text size="sm" c="dimmed" w={70}>Added</Text>{d.added.map((a) => <Badge key={`${a.kind}:${a.id}`} tt="none" variant="filled" color="ink">{a.id} {a.name}</Badge>)}</Group>}
          {d.changed.length > 0 && <Group gap={6} wrap="wrap"><Text size="sm" c="dimmed" w={70}>Changed</Text>{d.changed.map((c) => (
            <Tooltip key={`${c.kind}:${c.id}`} label={`Changed: ${c.fields.join(', ')}`}><Badge tt="none" variant="light" color="ink">{c.id} {c.name}</Badge></Tooltip>
          ))}</Group>}
          {d.retired.length > 0 && <Group gap={6} wrap="wrap" align="flex-start"><Text size="sm" c="dimmed" w={70}>Retired</Text>{d.retired.map((r) => (
            <Badge key={`${r.kind}:${r.id}`} tt="none" variant="light" color={r.calls ? 'accent' : 'gray'}>{r.id} {r.name}{r.calls ? ` · ${r.calls.toLocaleString('en-US')} calls in 90 days` : ''}</Badge>
          ))}</Group>}
          {d.retired.some((r) => r.calls > 0) && <Text size="xs" c={p.warnText}>Retired entries still have recent calls. Re-score them when you activate so they get the new tags.</Text>}
        </Stack>
      )}
    </Card>
  );
}

function ActivateModal({ opened, dto, onClose, onDone }: { opened: boolean; dto: TaxonomyDTO; onClose: () => void; onDone: () => void }) {
  const { meta } = useStore();
  const [notes, setNotes] = useState('');
  const [days, setDays] = useState('0');
  const [busy, setBusy] = useState(false);
  const draft = dto.draft!;
  const run = () => {
    setBusy(true);
    apiSend<{ version: string; rescoring: number }>('POST', '/api/taxonomy/draft/activate', { notes: notes || undefined, rescoreDays: Number(days) })
      .then((r) => {
        notifications.show({ title: `Taxonomy v${r.version} is active`, message: r.rescoring ? `${r.rescoring.toLocaleString('en-US')} recent calls are queued for re-scoring with the new definitions.` : 'New calls are tagged with it from now on.', color: 'ink' });
        setNotes(''); setDays('0'); onDone();
      })
      .catch(fail('Couldn’t activate the draft'))
      .finally(() => setBusy(false));
  };
  return (
    <Modal opened={opened} onClose={onClose} title={`Activate draft v${draft.version}`} size="lg">
      <Stack gap="sm">
        <Text size="sm" c="dimmed">Every call scored from now on is tagged with v{draft.version}; v{dto.active.version} is retired, and its calls keep the tags they have.</Text>
        <Textarea label="Notes for the version history" autosize minRows={2} value={notes} onChange={(e) => setNotes(e.currentTarget.value)} placeholder="What changed and why" />
        <div>
          <Text size="sm" fw={500} mb={4}>Re-score recent calls</Text>
          <SegmentedControl size="xs" value={days} onChange={setDays} data={[{ value: '0', label: 'None' }, { value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
          <Text size="xs" c="dimmed" mt={4}>Runs those calls through the pipeline again so their personas, scenarios and paths use the new definitions{meta?.llm.enabled ? '. With Claude as the judge this costs tokens for every call re-scored.' : '.'}</Text>
        </div>
        {(dto.diff?.retired ?? []).some((r) => r.calls > 0) && days === '0' && (
          <Alert color="accent" variant="light" radius="md">Some retired entries still have recent calls. Without re-scoring, those calls keep tags the new version no longer has.</Alert>
        )}
      </Stack>
      <Group mt="md"><Button loading={busy} onClick={run}>Activate v{draft.version}</Button><Button variant="default" onClick={onClose}>Cancel</Button></Group>
    </Modal>
  );
}

// ---------- Entry form ----------

function EntryDrawer({ edit, dto, onClose, onSave }: { edit: Edit | null; dto: TaxonomyDTO; onClose: () => void; onSave: (kind: TaxonomyKind, e: Entry) => Promise<unknown> }) {
  const [f, setF] = useState<Entry | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setF(edit ? (JSON.parse(JSON.stringify(edit.entry)) as Entry) : null); }, [edit]);
  if (!edit || !f) return <Drawer opened={false} onClose={onClose}>{null}</Drawer>;
  const kind = edit.kind;
  const set = (patch: Partial<Entry>) => setF((x) => (x ? ({ ...x, ...patch } as Entry) : x));
  const valid = kind === 'event' ? !!(f as EventDef).label.trim() : !!(f as PersonaDef).name.trim();
  const save = () => {
    setBusy(true);
    onSave(kind, f).catch(fail(`Couldn’t save the ${KIND_LABEL[kind].toLowerCase()}`)).finally(() => setBusy(false));
  };
  const builtins = (kind === 'persona' ? dto.builtins.personas : kind === 'scenario' ? dto.builtins.scenarios : dto.builtins.events) as { id: string; name?: string; label?: string }[];
  const basedOn = (
    <Select label="Behaves like" clearable allowDeselect placeholder="Nothing built in" searchable
      description="Inherits that framework entry’s built-in rules and checks (tool rules, the heuristic classifier, persona and path checks). Leave empty for something new."
      data={builtins.map((b) => ({ value: b.id, label: `${b.id} ${b.name ?? b.label ?? ''}` }))} value={(f as PersonaDef).basedOn} onChange={(v) => set({ basedOn: v ?? null })} />
  );
  const keywords = (
    <TagsInput label="Keywords" description="Phrases that identify it in the transcript when no Claude key is set (the heuristic classifier). Press Enter after each." value={(f as PersonaDef).keywords} onChange={(v) => set({ keywords: v })} />
  );
  const title = edit.isNew ? `New ${KIND_LABEL[kind].toLowerCase()}` : `${f.id} ${nameOf(f)}`;

  return (
    <Drawer opened onClose={onClose} position="right" size="lg" title={<Text fw={650}>{title}</Text>}>
      <Stack gap="sm">
        {kind === 'persona' && (() => {
          const x = f as PersonaDef;
          return (
            <>
              <TextInput label="Name" required value={x.name} onChange={(e) => set({ name: e.currentTarget.value })} />
              <Select label="Path" data={PATH_OPTIONS.map(({ value, label }) => ({ value, label }))} value={x.path} onChange={(v) => v && set({ path: v as PersonaDef['path'] })}
                description={PATH_OPTIONS.find((o) => o.value === x.path)?.note} />
              {basedOn}
              <Textarea label="Identifying signals" description="What the caller says or does that marks this persona" autosize minRows={2} value={x.signals} onChange={(e) => set({ signals: e.currentTarget.value })} />
              <Textarea label="Watch for" description="What the agent must get right with this persona" autosize minRows={2} value={x.watch} onChange={(e) => set({ watch: e.currentTarget.value })} />
              <TextInput label="Check label" description="The per-persona check shown in the quality matrix" value={x.checkLabel} onChange={(e) => set({ checkLabel: e.currentTarget.value })} />
              {keywords}
            </>
          );
        })()}
        {kind === 'scenario' && (() => {
          const x = f as ScenarioDef;
          const base = dto.builtins.scenarios.find((b) => b.id === x.basedOn);
          return (
            <>
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <TextInput label="Name" required value={x.name} onChange={(e) => set({ name: e.currentTarget.value })} />
                <TextInput label="Short name" description="For narrow columns" value={x.short} onChange={(e) => set({ short: e.currentTarget.value })} />
              </SimpleGrid>
              {basedOn}
              <Textarea label="Typical trigger" autosize minRows={2} value={x.trigger} onChange={(e) => set({ trigger: e.currentTarget.value })} />
              <TextInput label="Expected agent path" description="In words; the checkpoints below are what gets scored" value={x.path} onChange={(e) => set({ path: e.currentTarget.value })} />
              <TextInput label="Success looks like" value={x.success} onChange={(e) => set({ success: e.currentTarget.value })} />
              {keywords}
              <CheckpointsEditor value={x.checkpoints} dto={dto} onChange={(cps) => set({ checkpoints: cps })}
                copyFrom={base?.checkpoints?.length ? { label: `${base.id} ${base.name}`, checkpoints: base.checkpoints } : null} />
            </>
          );
        })()}
        {kind === 'event' && (() => {
          const x = f as EventDef;
          return (
            <>
              {x.system && <Alert color="gray" variant="light" radius="md">Detected by code from the call data, so only its label can change.</Alert>}
              <TextInput label="Label" required value={x.label} onChange={(e) => set({ label: e.currentTarget.value })} />
              <Select label="Group" disabled={x.system} data={GROUPS} value={x.group} onChange={(v) => v && set({ group: v as EventGroup })}
                description={x.group === 'Objections' ? 'Objection events become lost reasons in the funnel views.' : undefined} />
              {!x.system && basedOn}
              {!x.system && keywords}
            </>
          );
        })()}
        <Group mt="sm">
          <Button loading={busy} disabled={!valid} onClick={save}>{edit.isNew ? `Add ${KIND_LABEL[kind].toLowerCase()}` : 'Save to draft'}</Button>
          <Button variant="default" onClick={onClose}>Cancel</Button>
        </Group>
      </Stack>
    </Drawer>
  );
}

function CheckpointsEditor({ value, dto, onChange, copyFrom }: {
  value: Checkpoint[]; dto: TaxonomyDTO; onChange: (v: Checkpoint[]) => void; copyFrom: { label: string; checkpoints: Checkpoint[] } | null;
}) {
  const p = usePal();
  const ids = value.map((c) => c.id);
  const dup = ids.filter((id, i) => id && ids.indexOf(id) !== i);
  const setAt = (i: number, patch: Partial<Checkpoint>, auto = false) => onChange(value.map((c, j) => {
    if (j !== i) return c;
    const next = { ...c, ...patch } as Checkpoint;
    if (auto && patch.label !== undefined && (!c.id || c.id === SLUG(c.label))) next.id = SLUG(patch.label);
    return next;
  }));
  const move = (i: number, by: number) => {
    const s = [...value];
    const j = i + by;
    if (j < 0 || j >= s.length) return;
    [s[i], s[j]] = [s[j], s[i]];
    onChange(s);
  };
  const detectOf = (by: string, prev: CheckpointDetect): CheckpointDetect => {
    if (by === 'tool') return { by: 'tool', tools: prev.by === 'tool' ? prev.tools : [] };
    if (by === 'rule') return { by: 'rule', rule: (prev.by === 'rule' ? prev.rule : dto.rules[0]?.id ?? 'short_call') as RuleName };
    return { by: 'judge' };
  };

  return (
    <div>
      <Group justify="space-between" mb={4} mt="xs">
        <Text size="sm" fw={500}>Checkpoints</Text>
        <Group gap="xs">
          {copyFrom && <Button size="compact-xs" variant="subtle" onClick={() => onChange(copyFrom.checkpoints.map((c) => ({ ...c })))}>Copy from {copyFrom.label}</Button>}
          <Button size="compact-xs" variant="default" leftSection={<IconPlus size={12} />} onClick={() => onChange([...value, { id: '', label: '', hint: '', detect: { by: 'judge' } }])}>Add checkpoint</Button>
        </Group>
      </Group>
      <Text size="xs" c="dimmed" mb="xs">Path adherence scores the share reached in order; the first one missed is the deviation point. The judge decides judged checkpoints from the hint; tools count when they succeed.</Text>
      {value.length === 0 && <Text size="sm" c="dimmed">None: path adherence isn’t scored for this scenario.</Text>}
      <Stack gap="xs">
        {value.map((c, i) => (
          <Card key={i} withBorder padding="xs">
            <Group gap="xs" wrap="nowrap" align="flex-end">
              <Mono size="xs" c="dimmed" mb={8}>{i + 1}</Mono>
              <TextInput size="xs" label="Label" style={{ flex: 2 }} value={c.label} onChange={(e) => setAt(i, { label: e.currentTarget.value }, true)} />
              <TextInput size="xs" label="Id" ff="monospace" w={130} value={c.id} error={dup.includes(c.id) ? true : undefined} onChange={(e) => setAt(i, { id: e.currentTarget.value })} />
              <ActionIcon size="sm" mb={4} aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><IconArrowUp size={14} /></ActionIcon>
              <ActionIcon size="sm" mb={4} aria-label="Move down" disabled={i === value.length - 1} onClick={() => move(i, 1)}><IconArrowDown size={14} /></ActionIcon>
              <ActionIcon size="sm" mb={4} color="accent" aria-label="Remove checkpoint" onClick={() => onChange(value.filter((_, j) => j !== i))}><IconTrash size={14} /></ActionIcon>
            </Group>
            <Group gap="xs" mt={6} align="flex-end" wrap="wrap">
              <SegmentedControl size="xs" value={c.detect.by} onChange={(v) => setAt(i, { detect: detectOf(v, c.detect) })}
                data={[{ value: 'judge', label: 'Judge' }, { value: 'tool', label: 'Tool' }, { value: 'rule', label: 'Code rule' }]} />
              {c.detect.by === 'tool' && (
                <TagsInput size="xs" style={{ flex: 1, minWidth: 220 }} placeholder="Tool names" data={dto.tools} value={c.detect.tools}
                  onChange={(v) => setAt(i, { detect: { by: 'tool', tools: v } })} />
              )}
              {c.detect.by === 'rule' && (
                <Select size="xs" style={{ flex: 1, minWidth: 220 }} data={dto.rules.map((r) => ({ value: r.id, label: r.label }))} value={c.detect.rule}
                  onChange={(v) => v && setAt(i, { detect: { by: 'rule', rule: v as RuleName } })}
                  description={dto.rules.find((r) => c.detect.by === 'rule' && r.id === c.detect.rule)?.description} />
              )}
            </Group>
            {c.detect.by === 'judge' && <TextInput size="xs" mt={6} placeholder="Hint for the judge: what counts as reaching it" value={c.hint ?? ''} onChange={(e) => setAt(i, { hint: e.currentTarget.value })} />}
          </Card>
        ))}
      </Stack>
      {dup.length > 0 && <Text size="xs" c={p.warnText} mt={4}>Checkpoint ids must be unique within the scenario.</Text>}
    </div>
  );
}

// ---------- Co-pilot ----------

function TaxonomyCopilot({ dto, initialMode, onApplied, onTemplate, busyTemplate }: {
  dto: TaxonomyDTO; initialMode?: string; onApplied: (d: TaxonomyDTO) => void; onTemplate: (id: string) => void; busyTemplate: string | null;
}) {
  const [mode, setMode] = useState<TaxonomyCopilotMode>(MODES.some((m) => m.value === initialMode) ? (initialMode as TaxonomyCopilotMode) : dto.draft ? 'edit' : 'draft');
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<TaxonomyProposalDTO | null>(null);
  const [picked, setPicked] = useState<boolean[]>([]);
  const [useDomain, setUseDomain] = useState(true);
  const [applying, setApplying] = useState(false);
  const m = MODES.find((x) => x.value === mode)!;
  const doc = dto.draft ?? dto.active;
  const can = useCan();
  const allow = useAllow();

  const ask = () => {
    setBusy(true);
    setOut(null);
    apiSend<TaxonomyProposalDTO>('POST', '/api/taxonomy/copilot', { mode, instruction })
      .then((r) => { setOut(r); setPicked(r.operations.map(() => true)); setUseDomain(r.domain !== null); })
      .catch(fail('The co-pilot couldn’t propose changes'))
      .finally(() => setBusy(false));
  };
  const apply = () => {
    if (!out) return;
    const operations = out.operations.filter((_, i) => picked[i]);
    setApplying(true);
    apiSend<TaxonomyDTO>('POST', '/api/taxonomy/draft/apply', { operations, domain: useDomain ? out.domain : null })
      .then((d) => {
        onApplied(d);
        setOut(null);
        setInstruction('');
        notifications.show({ title: 'Applied to the draft', message: `${operations.length} change${operations.length === 1 ? '' : 's'} in draft v${d.draft?.version ?? ''}. Review the definitions below, then activate.`, color: 'ink' });
      })
      .catch(fail('Couldn’t apply the changes'))
      .finally(() => setApplying(false));
  };
  const count = picked.filter(Boolean).length;

  return (
    <Card>
      <SectionTitle note="Proposes changes from the business profile, your instruction or the evidence in recent calls. Nothing changes until you apply the ones you pick to the draft.">
        <Group gap={6}><IconWand size={18} />Co-pilot</Group>
      </SectionTitle>
      {!dto.copilot ? (
        <Stack gap="xs">
          <Text size="sm" c="dimmed">{NO_CLAUDE_KEY}</Text>
          {dto.templates.length > 0 && (
            <>
              <Text size="sm" fw={600} mt={4}>Start a draft from a template</Text>
              <SimpleGrid cols={{ base: 1, md: 2 }}>
                {dto.templates.map((tp) => (
                  <Card key={tp.id} withBorder padding="sm">
                    <Group justify="space-between" wrap="nowrap" align="flex-start">
                      <Stack gap={2} style={{ minWidth: 0 }}><Text size="sm" fw={600}>{tp.name}</Text><Text size="xs" c="dimmed">{tp.description}</Text></Stack>
                      <NeedsTip perm="taxonomy:edit"><Button size="xs" variant="default" loading={busyTemplate === `draft:${tp.id}`} disabled={!can('taxonomy:edit')} onClick={() => onTemplate(tp.id)} style={{ flex: 'none' }}>Use</Button></NeedsTip>
                    </Group>
                  </Card>
                ))}
              </SimpleGrid>
            </>
          )}
        </Stack>
      ) : (
        <Stack gap="sm">
          <SegmentedControl value={mode} onChange={(v) => setMode(v as TaxonomyCopilotMode)} data={MODES.map((x) => ({ value: x.value, label: x.label }))} style={{ alignSelf: 'flex-start' }} />
          <Text size="sm" c="dimmed">{m.help}{mode === 'edit' && !dto.draft ? ' A draft is started from the active version when you apply.' : ''}</Text>
          <Textarea autosize minRows={2} maxRows={8} placeholder={m.placeholder} value={instruction} onChange={(e) => setInstruction(e.currentTarget.value)} />
          <Group gap="xs">
            <NeedsTip perm={['copilot:use', 'taxonomy:edit']} feature="copilot">
              <Button leftSection={<IconWand size={16} />} loading={busy} disabled={busy || (mode === 'edit' && !instruction.trim()) || !allow(['copilot:use', 'taxonomy:edit'], 'copilot')} onClick={ask}>Ask the co-pilot</Button>
            </NeedsTip>
            {dto.templates.length > 0 && can('taxonomy:edit') && (
              <Menu position="bottom-start" withinPortal>
                <Menu.Target><Button variant="default" leftSection={<IconTemplate size={16} />} rightSection={<IconChevronDown size={14} />}>Start from a template</Button></Menu.Target>
                <Menu.Dropdown>{dto.templates.map((tp) => <Menu.Item key={tp.id} onClick={() => onTemplate(tp.id)}><Text size="sm" fw={600}>{tp.name}</Text><Text size="xs" c="dimmed" maw={320}>{tp.description}</Text></Menu.Item>)}</Menu.Dropdown>
              </Menu>
            )}
          </Group>
          {busy && <CopilotWorking label={m.working} />}
          {out && (
            <Card withBorder padding="md">
              <Stack gap="sm">
                <Text size="sm">{out.summary}</Text>
                <Text size="xs" c="dimmed">
                  Looked at {out.evidence.calls.toLocaleString('en-US')} calls and {out.evidence.clusters} clusters
                  {out.evidence.unclassifiedShare !== null ? ` · Unclassified share ${Math.round(out.evidence.unclassifiedShare * 1000) / 10}%` : ''}
                </Text>
                {out.domain !== null && (
                  <Checkbox checked={useDomain} onChange={() => setUseDomain(!useDomain)}
                    label={<Text size="sm"><b>Domain:</b> {out.domain}</Text>} description={doc.domain ? `Now: ${doc.domain}` : undefined} />
                )}
                <CopilotQuestions questions={out.questions} />
                {out.operations.length === 0 ? <Text size="sm" c="dimmed">No changes proposed.</Text> : (
                  <>
                    <Group justify="space-between">
                      <Text size="sm" fw={600}>{out.operations.length} proposed change{out.operations.length === 1 ? '' : 's'}</Text>
                      <Group gap="xs">
                        <Anchor component="button" size="xs" onClick={() => setPicked(out.operations.map(() => true))}>Select all</Anchor>
                        <Anchor component="button" size="xs" onClick={() => setPicked(out.operations.map(() => false))}>Select none</Anchor>
                      </Group>
                    </Group>
                    <Stack gap={6}>
                      {out.operations.map((op, i) => (
                        <OperationRow key={i} op={op} doc={doc} checked={!!picked[i]} onToggle={() => setPicked(picked.map((x, j) => (j === i ? !x : x)))} />
                      ))}
                    </Stack>
                  </>
                )}
                <Group gap="xs">
                  <Button loading={applying} disabled={(!count && !(useDomain && out.domain !== null)) || !can('taxonomy:edit')} onClick={apply}>
                    {count ? `Apply ${count} selected to the draft` : 'Apply the domain to the draft'}
                  </Button>
                  <Button variant="default" onClick={() => setOut(null)}>Dismiss</Button>
                </Group>
                <CopilotUsageLine usage={out.usage} />
              </Stack>
            </Card>
          )}
        </Stack>
      )}
    </Card>
  );
}

const FIELD_LABEL: Record<string, string> = {
  name: 'Name', label: 'Label', path: 'Path', basedOn: 'Behaves like', signals: 'Signals', watch: 'Watch for', checkLabel: 'Check label', keywords: 'Keywords',
  short: 'Short name', trigger: 'Trigger', success: 'Success', checkpoints: 'Checkpoints', group: 'Group',
};
const fmtField = (k: string, v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (k === 'checkpoints' && Array.isArray(v)) return (v as Checkpoint[]).map((c) => `${c.label} (${c.detect.by === 'tool' ? c.detect.tools.join(', ') || 'tool' : c.detect.by === 'rule' ? c.detect.rule : 'judge'})`).join(' → ') || '—';
  if (Array.isArray(v)) return v.join(', ') || '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

function OperationRow({ op, doc, checked, onToggle }: { op: TaxonomyOp; doc: TaxonomyDoc; checked: boolean; onToggle: () => void }) {
  const p = usePal();
  const [open, setOpen] = useState(false);
  const list = (op.kind === 'persona' ? doc.personas : op.kind === 'scenario' ? doc.scenarios : doc.events) as Entry[];
  const cur = op.id ? list.find((x) => x.id === op.id) : undefined;
  const name = nameOf(op.entry) || nameOf(cur) || op.id || 'Untitled';
  const changed = op.op === 'update' && op.entry && cur
    ? Object.keys(op.entry).filter((k) => k !== 'id' && JSON.stringify((op.entry as Record<string, unknown>)[k]) !== JSON.stringify((cur as unknown as Record<string, unknown>)[k]))
    : [];
  const shown = op.op === 'update' ? changed : Object.keys(op.entry ?? {}).filter((k) => k !== 'id' && k !== 'system');
  const tone = op.op === 'add' ? { label: 'Add', color: 'ink', variant: 'filled' } : op.op === 'update' ? { label: 'Change', color: 'ink', variant: 'light' } : { label: 'Retire', color: 'accent', variant: 'light' };

  return (
    <Box p="xs" style={{ border: `1px solid ${p.line}`, borderRadius: 8 }}>
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <Checkbox checked={checked} onChange={onToggle} mt={2} aria-label={`Include ${name}`} />
        <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
          <Group gap={6} wrap="wrap">
            <Badge size="sm" tt="none" color={tone.color} variant={tone.variant as 'filled' | 'light'}>{tone.label}</Badge>
            <Text size="xs" c="dimmed">{KIND_LABEL[op.kind]}</Text>
            <Mono size="xs" c="dimmed">{op.id ?? 'new'}</Mono>
            <Text size="sm" fw={600}>{name}</Text>
          </Group>
          {op.reason && <Text size="sm" c="dimmed">{op.reason}</Text>}
          {(op.warnings ?? []).map((w) => <Text key={w} size="xs" c={p.warnText}>{w}</Text>)}
          {op.op === 'retire' && cur && <Text size="xs" c="dimmed">Leaves the draft; calls already tagged with it keep the tag.</Text>}
          {op.entry && shown.length > 0 && (
            <>
              <Anchor component="button" size="xs" onClick={() => setOpen(!open)} style={{ alignSelf: 'flex-start' }}>{open ? 'Hide details' : op.op === 'update' ? `Show what changes (${shown.map((k) => FIELD_LABEL[k] ?? k).join(', ')})` : 'Show details'}</Anchor>
              <Collapse in={open}>
                <Table fz="xs" verticalSpacing={2} highlightOnHover={false} mt={4}>
                  <Table.Tbody>{shown.map((k) => (
                    <Table.Tr key={k}>
                      <Table.Td w={110}><Text size="xs" fw={600}>{FIELD_LABEL[k] ?? k}</Text></Table.Td>
                      {op.op === 'update' && <Table.Td><Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>{fmtField(k, (cur as unknown as Record<string, unknown>)?.[k])}</Text></Table.Td>}
                      <Table.Td><Text size="xs" style={{ whiteSpace: 'pre-wrap' }}>{fmtField(k, (op.entry as Record<string, unknown>)[k])}</Text></Table.Td>
                    </Table.Tr>
                  ))}</Table.Tbody>
                </Table>
              </Collapse>
            </>
          )}
        </Stack>
      </Group>
    </Box>
  );
}
