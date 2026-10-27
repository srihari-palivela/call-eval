import { useEffect, useState } from 'react';
import { Alert, Anchor, Badge, Button, Card, Drawer, Group, Modal, NumberInput, Pagination, Select, SimpleGrid, Stack, Switch, Table, TagsInput, Text, TextInput, Textarea, Timeline, UnstyledButton } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAddressBook, IconSearch, IconSparkles, IconUpload, IconUserPlus } from '@tabler/icons-react';
import type { BusinessDTO, LeadConsent, LeadDetailDTO, LeadDTO, LeadFunnelsDTO, LeadListDTO } from '@calleval/framework';
import { usePal } from '../theme';
import { apiSend, apiSendText, errMsg, qs, useApi } from '../api';
import { ErrorState, Loading, Mono, PageHeader, SectionTitle, fmtWhen, useLookups } from '../components/ui';
import { MILESTONE_LABELS, SOURCES, StageBadge, defaultFunnel, funnelById, stageLabel } from '../components/funnels';
import { useStore } from '../store';
import { NeedsTip, useAllow, useCan } from '../components/access';
import { PlanNotice } from '../components/plan';

const CONSENT: { value: LeadConsent; label: string }[] = [
  { value: 'opt_in', label: 'Opted in' }, { value: 'existing_customer', label: 'Existing customer' }, { value: 'unknown', label: 'Unknown' }, { value: 'denied', label: 'Denied' },
];
const consentLabel = (s: string) => CONSENT.find((x) => x.value === s)?.label ?? s;
const CSV_SAMPLE = 'first_name,last_name,phone,email,company,title,consent,stage,tags\nAisha,Khan,+971500000010,aisha@example.com,Khan Realty,Broker,opt_in,new,broker;vip';
const PAGE = 50;

export function LeadsPage() {
  const { meta, reloadMeta, params, go } = useStore();
  const p = usePal();
  const can = useCan();
  const allow = useAllow();
  const [q, setQ] = useState(params.q ?? '');
  const [query, setQuery] = useState(params.q ?? '');
  const [funnel, setFunnel] = useState<string | null>(params.funnel ?? null);
  const [stage, setStage] = useState<string | null>(params.stage ?? null);
  const [source, setSource] = useState<string | null>(null);
  const [consent, setConsent] = useState<string | null>(null);
  const [eligible, setEligible] = useState(false);
  const [page, setPage] = useState(1);
  const [sel, setSel] = useState<string | null>(params.id ?? null);
  const [dialog, setDialog] = useState<'add' | 'import' | 'find' | 'enrich' | null>(null);
  useEffect(() => { const t = window.setTimeout(() => { setQuery(q); setPage(1); }, 300); return () => window.clearTimeout(t); }, [q]);

  const on = meta!.settings.features.crm;
  const list = useApi<LeadListDTO>(on ? `/api/crm/leads${qs({ q: query, funnel, stage, source, consent, eligible: eligible ? 'true' : null, limit: PAGE, offset: (page - 1) * PAGE })}` : null);
  const funnels = useApi<LeadFunnelsDTO>(on ? '/api/crm/funnels' : null);
  const business = useApi<BusinessDTO>(on ? '/api/business' : null);

  if (!on) {
    return (
      <>
        <PlanNotice feature="crm" />
        <PageHeader eyebrow="Grow · Sales" title="Leads" description="A simple built-in CRM: leads, their stage and history, filled by lead finders and imports, and called by campaigns." />
        <Card padding="xl">
          <Group gap="md" align="flex-start" wrap="nowrap">
            <IconAddressBook size={28} stroke={1.6} />
            <Stack gap={6}>
              <Text fw={650}>The built-in CRM is off</Text>
              <Text size="sm" c="dimmed">Turn it on to keep leads here. Stage changes become CRM outcomes, so the funnel and attribution work as they do with an external CRM; an external CRM feed keeps working alongside it.</Text>
              <Group gap="xs" mt={4}>
                <NeedsTip perm="settings:manage" feature="crm"><Button size="xs" disabled={!allow('settings:manage', 'crm')} onClick={() => apiSend('PUT', '/api/settings', { features: { crm: true } }).then(reloadMeta).catch((e) => notifications.show({ title: 'Couldn’t turn it on', message: errMsg(e), color: 'accent' }))}>Turn on the CRM</Button></NeedsTip>
                <Button size="xs" variant="default" onClick={() => go('business')}>Business setup</Button>
              </Group>
            </Stack>
          </Group>
        </Card>
      </>
    );
  }

  const data = list.data;
  const finder = business.data?.leadFinder;
  const current = data?.funnel ?? funnelById(funnels.data, funnel);
  const pickFunnel = (v: string | null) => { setFunnel(v); setStage(null); setPage(1); };
  return (
    <>
      <PlanNotice feature="crm" />
      <PageHeader eyebrow="Grow · Sales" title="Leads"
        description="Every lead with its stage, consent and call history. Scored calls move leads forward on their own; a do-not-contact request on a call stops all contact."
        right={(
          <Group gap="xs">
            <NeedsTip perm="crm:write"><Button leftSection={<IconUserPlus size={16} />} variant="default" disabled={!can('crm:write')} onClick={() => setDialog('add')}>Add lead</Button></NeedsTip>
            <NeedsTip perm="crm:write"><Button leftSection={<IconUpload size={16} />} variant="default" disabled={!can('crm:write')} onClick={() => setDialog('import')}>Import CSV</Button></NeedsTip>
            <NeedsTip perm="leadfinder:spend" feature="lead_finder"><Button leftSection={<IconSearch size={16} />} variant="default" disabled={!allow('leadfinder:spend', 'lead_finder')} onClick={() => setDialog('find')}>Find leads</Button></NeedsTip>
            <NeedsTip perm="leadfinder:spend" feature="lead_finder"><Button leftSection={<IconSparkles size={16} />} disabled={!allow('leadfinder:spend', 'lead_finder')} onClick={() => setDialog('enrich')}>Enrich</Button></NeedsTip>
          </Group>
        )} />

      {data && (
        <Group gap={6} mb="md" wrap="wrap">
          <Badge component="button" variant={stage ? 'outline' : 'filled'} color="ink" tt="none" style={{ cursor: 'pointer' }} onClick={() => { setStage(null); setPage(1); }}>All · {Object.values(data.stages).reduce((a, b) => a + b, 0)}</Badge>
          {data.funnel.stages.map((s) => (
            <Badge key={s.key} component="button" variant={stage === s.key ? 'filled' : 'light'} color={s.kind === 'lost' ? 'accent' : 'ink'} tt="none" style={{ cursor: 'pointer' }}
              onClick={() => { setStage(stage === s.key ? null : s.key); setPage(1); }}>{s.label} · {data.stages[s.key] ?? 0}</Badge>
          ))}
          <Anchor component="button" size="xs" ml={4} onClick={() => go('funnels', { id: data.funnel.id })}>Edit stages</Anchor>
        </Group>
      )}

      <Group gap="sm" mb="md" align="flex-end" wrap="wrap">
        {(funnels.data?.funnels.length ?? 0) > 1 && (
          <Select label="Funnel" w={200} data={funnels.data!.funnels.map((f) => ({ value: f.id, label: f.isDefault ? `${f.name} (default)` : f.name }))}
            value={funnel ?? current?.id ?? null} onChange={pickFunnel} />
        )}
        <TextInput label="Search" placeholder="Name, company, phone or email" leftSection={<IconSearch size={16} />} value={q} onChange={(e) => setQ(e.currentTarget.value)} w={280} />
        <Select label="Source" w={150} clearable data={SOURCES} value={source} onChange={(v) => { setSource(v); setPage(1); }} />
        <Select label="Consent" w={170} clearable data={CONSENT} value={consent} onChange={(v) => { setConsent(v); setPage(1); }} />
        <Switch label="Callable now" description="What a campaign may dial" checked={eligible} onChange={() => { setEligible(!eligible); setPage(1); }} />
      </Group>

      {list.error && !data && <ErrorState error={list.error} onRetry={list.reload} />}
      {!data && !list.error && <Loading />}
      {data && (
        <Card padding={0}>
          {data.items.length === 0 ? (
            <Text p="lg" size="sm" c="dimmed">No leads match. Add one, import a CSV, or find leads from the ideal customer profile.</Text>
          ) : (
            <Table.ScrollContainer minWidth={880}>
              <Table highlightOnHover verticalSpacing="xs" fz="sm">
                <Table.Thead><Table.Tr>
                  <Table.Th>Lead</Table.Th><Table.Th>Phone</Table.Th><Table.Th>Email</Table.Th><Table.Th>Stage</Table.Th><Table.Th>Consent</Table.Th><Table.Th ta="right">Calls</Table.Th><Table.Th>Last call</Table.Th><Table.Th>Source</Table.Th>
                </Table.Tr></Table.Thead>
                <Table.Tbody>
                  {data.items.map((l) => (
                    <Table.Tr key={l.id} onClick={() => setSel(l.id)} style={{ cursor: 'pointer' }}>
                      <Table.Td><UnstyledButton onClick={() => setSel(l.id)}><Text size="sm" fw={600}>{l.name ?? '—'}</Text><Text size="xs" c="dimmed">{[l.title, l.company].filter(Boolean).join(' · ') || '—'}</Text></UnstyledButton>{l.hold && <HoldBadge hold={l.hold} />}</Table.Td>
                      <Table.Td><Mono size="xs" c={l.phone && !l.phoneValid ? p.warnText : undefined}>{l.phone ?? '—'}</Mono></Table.Td>
                      <Table.Td><Text size="xs">{l.email ?? '—'}</Text></Table.Td>
                      <Table.Td><StageBadge funnel={funnelById(funnels.data, l.funnelId) ?? current} stage={l.stage} /></Table.Td>
                      <Table.Td><Text size="xs" c={l.consent === 'denied' || l.dnc ? p.warnText : l.consent === 'unknown' ? 'dimmed' : undefined}>{l.dnc ? 'DNC' : consentLabel(l.consent)}</Text></Table.Td>
                      <Table.Td ta="right"><Mono size="xs">{l.callCount}</Mono></Table.Td>
                      <Table.Td><Text size="xs" c="dimmed">{fmtWhen(l.lastCalledAt)}</Text></Table.Td>
                      <Table.Td><Text size="xs" c="dimmed">{l.source}</Text></Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
          {data.total > PAGE && <Group justify="center" p="sm"><Pagination size="sm" total={Math.ceil(data.total / PAGE)} value={page} onChange={setPage} /></Group>}
        </Card>
      )}

      <LeadDrawer id={sel} funnels={funnels.data} onClose={() => setSel(null)} onChanged={() => { list.reload(); funnels.reload(); }} />
      <AddLead opened={dialog === 'add'} funnels={funnels.data} funnelId={current?.id ?? null} onClose={() => setDialog(null)} onSaved={(id) => { setDialog(null); list.reload(); setSel(id); }} />
      <ImportLeads opened={dialog === 'import'} onClose={() => setDialog(null)} onDone={() => { setDialog(null); list.reload(); }} />
      <FindLeads opened={dialog === 'find'} business={business.data} onClose={() => setDialog(null)} />
      <EnrichLeads opened={dialog === 'enrich'} phoneWebhook={!!finder?.phoneWebhook} apollo={!!finder?.apollo} onClose={() => setDialog(null)} />
    </>
  );
}

/** Why campaigns won't call this lead now (a refusal, the do-not-call list, retry pacing, consent). */
function HoldBadge({ hold }: { hold: NonNullable<LeadDTO['hold']> }) {
  return (
    <Badge size="xs" variant="light" color="accent" tt="none" mt={4} display="block" w="fit-content" title={hold.until ? `Until ${fmtWhen(hold.until)}` : undefined}>
      {hold.reason}{hold.until ? ` · until ${fmtWhen(hold.until)}` : ''}
    </Badge>
  );
}

function LeadDrawer({ id, funnels, onClose, onChanged }: { id: string | null; funnels: LeadFunnelsDTO | null; onClose: () => void; onChanged: () => void }) {
  const p = usePal();
  const { go } = useStore();
  const { pName, sName } = useLookups();
  const d = useApi<LeadDetailDTO>(id ? `/api/crm/leads/${encodeURIComponent(id)}` : null);
  const [edit, setEdit] = useState<Partial<LeadDTO>>({});
  const [stageNote, setStageNote] = useState('');
  const [value, setValue] = useState<string | number>('');
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { setEdit({}); setStageNote(''); setValue(''); }, [id]);
  const lead = d.data;
  const done = () => { d.reload(); onChanged(); };
  const fail = (e: unknown) => notifications.show({ title: 'Couldn’t update the lead', message: errMsg(e), color: 'accent' });
  const save = () => { setBusy('save'); apiSend('PATCH', `/api/crm/leads/${id}`, edit).then(() => { setEdit({}); done(); }).catch(fail).finally(() => setBusy(null)); };
  const fnl = funnelById(funnels, lead?.funnelId);
  const outcomeLabel = (s: string) => funnels?.milestones.find((m) => m.id === s)?.label ?? MILESTONE_LABELS[s] ?? s;
  const moveFunnel = (funnelId: string) => { setBusy('funnel'); apiSend('PATCH', `/api/crm/leads/${id}`, { funnelId }).then(done).catch(fail).finally(() => setBusy(null)); };
  const move = (stage: string) => { setBusy('stage'); apiSend('POST', `/api/crm/leads/${id}/stage`, { stage, note: stageNote || undefined, valueAed: value === '' ? undefined : Number(value) }).then(() => { setStageNote(''); done(); }).catch(fail).finally(() => setBusy(null)); };
  const v = <K extends keyof LeadDTO>(k: K) => (edit[k] !== undefined ? edit[k] : lead?.[k]) as any;

  return (
    <Drawer opened={!!id} onClose={onClose} position="right" size="lg" title={<Text fw={650}>{lead?.name ?? lead?.company ?? 'Lead'}</Text>}>
      {d.error && !lead && <ErrorState error={d.error} onRetry={d.reload} />}
      {!lead && !d.error && <Loading />}
      {lead && (
        <Stack gap="lg">
          {lead.dnc && <Alert color="accent" variant="light" radius="md" title="Do not contact">This lead asked not to be contacted. Campaigns never call it.</Alert>}
          {lead.hold && !lead.dnc && (
            <Alert color="gray" variant="light" radius="md" title="Campaigns are holding this lead back">
              {lead.hold.reason}{lead.hold.until ? `, until ${fmtWhen(lead.hold.until)}` : ''}. See Calling compliance for the rules.
            </Alert>
          )}
          <SimpleGrid cols={2}>
            <TextInput label="First name" value={v('firstName') ?? ''} onChange={(e) => setEdit({ ...edit, firstName: e.currentTarget.value })} />
            <TextInput label="Last name" value={v('lastName') ?? ''} onChange={(e) => setEdit({ ...edit, lastName: e.currentTarget.value })} />
            <TextInput label="Phone (E.164)" error={lead.phone && !lead.phoneValid && edit.phone === undefined ? 'Not dialable: use +country code' : undefined} value={v('phone') ?? ''} onChange={(e) => setEdit({ ...edit, phone: e.currentTarget.value })} />
            <TextInput label="Email" value={v('email') ?? ''} onChange={(e) => setEdit({ ...edit, email: e.currentTarget.value })} />
            <TextInput label="Company" value={v('company') ?? ''} onChange={(e) => setEdit({ ...edit, company: e.currentTarget.value })} />
            <TextInput label="Title" value={v('title') ?? ''} onChange={(e) => setEdit({ ...edit, title: e.currentTarget.value })} />
            <Select label="Consent" data={CONSENT} value={v('consent')} onChange={(x) => x && setEdit({ ...edit, consent: x as LeadConsent })} />
            <TextInput label="Owner" value={v('owner') ?? ''} onChange={(e) => setEdit({ ...edit, owner: e.currentTarget.value })} />
          </SimpleGrid>
          <TagsInput label="Tags" value={v('tags') ?? []} onChange={(x) => setEdit({ ...edit, tags: x })} />
          <Textarea label="Notes" autosize minRows={2} value={v('notes') ?? ''} onChange={(e) => setEdit({ ...edit, notes: e.currentTarget.value })} />
          <Group gap="sm">
            <Button size="xs" disabled={!Object.keys(edit).length} loading={busy === 'save'} onClick={save}>Save</Button>
            {Object.keys(edit).length > 0 && <Button size="xs" variant="default" onClick={() => setEdit({})}>Discard</Button>}
          </Group>

          <Card withBorder>
            <SectionTitle note="Stages that stand for an outcome milestone (meeting booked through sale) become CRM outcomes credited to the call before them."
              right={(funnels?.funnels.length ?? 0) > 1 ? (
                <Select size="xs" w={190} aria-label="Funnel" data={funnels!.funnels.map((f) => ({ value: f.id, label: f.name }))} value={lead.funnelId}
                  disabled={busy === 'funnel'} onChange={(v) => v && v !== lead.funnelId && moveFunnel(v)} />
              ) : undefined}>Stage · {stageLabel(fnl, lead.stage)}</SectionTitle>
            <Group gap="xs" align="flex-end" wrap="wrap">
              <TextInput size="xs" label="Note (optional)" value={stageNote} onChange={(e) => setStageNote(e.currentTarget.value)} w={220} />
              <NumberInput size="xs" label="Value (AED, for won stages)" value={value} onChange={setValue} w={200} min={0} />
            </Group>
            <Group gap={6} mt="sm" wrap="wrap">
              {(fnl?.stages ?? []).filter((s) => s.key !== lead.stage).map((s) => (
                <Button key={s.key} size="compact-xs" variant={s.kind === 'lost' ? 'outline' : 'default'} color={s.kind === 'lost' ? 'accent' : undefined} loading={busy === 'stage'} onClick={() => move(s.key)}>{s.label}</Button>
              ))}
            </Group>
          </Card>

          <div>
            <SectionTitle>Calls · {lead.calls.length}</SectionTitle>
            {lead.calls.length === 0 ? <Text size="sm" c="dimmed">No calls yet.</Text> : (
              <Stack gap={6}>
                {lead.calls.map((c) => (
                  <Group key={c.id} justify="space-between" wrap="nowrap">
                    <Anchor component="button" size="sm" onClick={() => go('calls', { id: c.id })}>{fmtWhen(c.startedAt)} · {c.persona ? `${c.persona} ${pName(c.persona)}` : 'Not scored'}{c.scenario ? ` × ${sName(c.scenario)}` : ''}</Anchor>
                    <Mono size="xs">{c.cqs ?? '—'}{c.nextStep ? ` · ${c.nextStep}` : ''}</Mono>
                  </Group>
                ))}
              </Stack>
            )}
          </div>

          {lead.outcomes.length > 0 && (
            <div>
              <SectionTitle>Outcomes</SectionTitle>
              <Stack gap={4}>{lead.outcomes.map((o, i) => <Text key={i} size="sm">{outcomeLabel(o.stage)} · {fmtWhen(o.at)}{o.valueAed ? ` · AED ${o.valueAed.toLocaleString('en-US')}` : ''}{o.creditedCallId ? '' : ' · not credited to a call'}</Text>)}</Stack>
            </div>
          )}

          <div>
            <SectionTitle>History</SectionTitle>
            <Timeline active={-1} bulletSize={14} lineWidth={2}>
              {lead.events.map((e, i) => (
                <Timeline.Item key={i} title={<Text size="sm" fw={600}>{e.type === 'stage' ? `${stageLabel(fnl, e.detail.from)} → ${stageLabel(fnl, e.detail.to)}` : e.type}</Text>}>
                  <Text size="xs" c="dimmed">{fmtWhen(e.at)} · {e.actor ?? 'system'}{e.detail?.note ? ` · ${e.detail.note}` : ''}{e.detail?.fields ? ` · ${(e.detail.fields as string[]).join(', ')}` : ''}</Text>
                </Timeline.Item>
              ))}
            </Timeline>
          </div>
          <Text size="xs" c={p.warnText}>{lead.source === 'apollo' && lead.consent === 'unknown' ? 'Found by a lead finder: record consent before a campaign may call this lead.' : ''}</Text>
        </Stack>
      )}
    </Drawer>
  );
}

function AddLead({ opened, funnels, funnelId, onClose, onSaved }: { opened: boolean; funnels: LeadFunnelsDTO | null; funnelId: string | null; onClose: () => void; onSaved: (id: string) => void }) {
  const [f, setF] = useState({ firstName: '', lastName: '', phone: '', email: '', company: '', title: '', consent: 'opt_in' });
  const [fid, setFid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (opened) setFid(funnelId ?? defaultFunnel(funnels)?.id ?? null); }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = () => {
    setBusy(true);
    apiSend<LeadDTO & { created: boolean }>('POST', '/api/crm/leads', { ...f, ...(fid ? { funnelId: fid } : {}) })
      .then((r) => { notifications.show({ title: r.created ? 'Lead added' : 'Lead already existed', message: r.created ? 'Saved to the CRM.' : 'Its empty fields were filled in from what you entered.', color: 'ink' }); onSaved(r.id); })
      .catch((e) => notifications.show({ title: 'Couldn’t add the lead', message: errMsg(e), color: 'accent' }))
      .finally(() => setBusy(false));
  };
  return (
    <Modal opened={opened} onClose={onClose} title="Add a lead" size="lg">
      <SimpleGrid cols={2}>
        {(['firstName', 'lastName', 'phone', 'email', 'company', 'title'] as const).map((k) => (
          <TextInput key={k} label={{ firstName: 'First name', lastName: 'Last name', phone: 'Phone (+country code)', email: 'Email', company: 'Company', title: 'Title' }[k]} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.currentTarget.value })} />
        ))}
        <Select label="Consent" data={CONSENT} value={f.consent} onChange={(v) => v && setF({ ...f, consent: v })} />
        {(funnels?.funnels.length ?? 0) > 1 && <Select label="Funnel" data={funnels!.funnels.map((x) => ({ value: x.id, label: x.name }))} value={fid} onChange={setFid} />}
      </SimpleGrid>
      <Group mt="md"><Button loading={busy} onClick={save}>Add lead</Button><Button variant="default" onClick={onClose}>Cancel</Button></Group>
    </Modal>
  );
}

function ImportLeads({ opened, onClose, onDone }: { opened: boolean; onClose: () => void; onDone: () => void }) {
  const [csv, setCsv] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ created: number; updated: number; skipped: number; errors: string[] } | null>(null);
  const run = () => {
    setBusy(true);
    apiSendText<{ created: number; updated: number; skipped: number; errors: string[] }>('/api/crm/leads/import', csv)
      .then((r) => { setResult(r); if (!r.skipped) { notifications.show({ title: 'Leads imported', message: `${r.created} new, ${r.updated} updated.`, color: 'ink' }); setCsv(''); onDone(); } })
      .catch((e) => notifications.show({ title: 'Import failed', message: errMsg(e), color: 'accent' }))
      .finally(() => setBusy(false));
  };
  return (
    <Modal opened={opened} onClose={() => { setResult(null); onClose(); }} title="Import leads from CSV" size="xl">
      <Text size="sm" c="dimmed" mb="xs">Columns: first_name, last_name (or name), phone, email, company, title, city, country, consent, stage, owner, tags (separated by ;), notes, external_id. A lead with the same email or phone is updated: empty fields are filled, filled ones kept.</Text>
      <Textarea autosize minRows={6} maxRows={16} placeholder={CSV_SAMPLE} value={csv} onChange={(e) => setCsv(e.currentTarget.value)} styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } }} />
      {result && <Alert mt="sm" color={result.skipped ? 'accent' : 'gray'} variant="light">{result.created} new, {result.updated} updated, {result.skipped} skipped.{result.errors.map((e) => <Text key={e} size="xs">{e}</Text>)}</Alert>}
      <Group mt="md"><Button loading={busy} disabled={!csv.trim()} onClick={run}>Import</Button><Anchor component="button" size="sm" onClick={() => setCsv(CSV_SAMPLE)}>Use the example</Anchor></Group>
    </Modal>
  );
}

function FindLeads({ opened, business, onClose }: { opened: boolean; business: BusinessDTO | null; onClose: () => void }) {
  const { go } = useStore();
  const [max, setMax] = useState<string | number>(100);
  const [busy, setBusy] = useState(false);
  const icpEmpty = !business || Object.keys(business.apolloQuery).length === 0;
  const run = () => {
    setBusy(true);
    apiSend('POST', '/api/leadfinder/search', { max: Number(max) })
      .then(() => { notifications.show({ title: 'Searching Apollo', message: 'New people are added to the CRM as they are found. Search uses no Apollo credits.', color: 'ink' }); onClose(); })
      .catch((e) => notifications.show({ title: 'Couldn’t start the search', message: errMsg(e), color: 'accent' }))
      .finally(() => setBusy(false));
  };
  return (
    <Modal opened={opened} onClose={onClose} title="Find leads with Apollo.io" size="lg">
      {!business?.leadFinder.apollo && <Alert color="accent" variant="light" mb="sm">Connect Apollo.io under Integrations (or set APOLLO_API_KEY) first.</Alert>}
      {icpEmpty && <Alert color="accent" variant="light" mb="sm">The ideal customer profile is empty. <Anchor component="button" onClick={() => { onClose(); go('business'); }}>Fill it in</Anchor> so the search finds the right people.</Alert>}
      <Text size="sm" c="dimmed" mb="sm">Searches Apollo with the ideal customer profile and adds new people as consent-unknown leads. Existing leads (same Apollo person, email or phone) are only backfilled. Search returns names, titles and companies; run Enrich for emails and phone numbers.</Text>
      <NumberInput label="People to add" min={1} max={5000} value={max} onChange={setMax} w={200} />
      <Group mt="md"><Button loading={busy} disabled={!business?.leadFinder.apollo || icpEmpty} onClick={run}>Search</Button><Button variant="default" onClick={onClose}>Cancel</Button></Group>
    </Modal>
  );
}

function EnrichLeads({ opened, apollo, phoneWebhook, onClose }: { opened: boolean; apollo: boolean; phoneWebhook: boolean; onClose: () => void }) {
  const [cap, setCap] = useState<string | number>(100);
  const [phones, setPhones] = useState(true);
  const [busy, setBusy] = useState(false);
  const perPerson = 1 + (phones && phoneWebhook ? 8 : 0);
  const run = () => {
    setBusy(true);
    apiSend('POST', '/api/leadfinder/enrich', { creditCap: Number(cap), revealPhone: phones })
      .then(() => { notifications.show({ title: 'Enriching leads', message: 'Emails and profile fields fill in shortly; phone numbers arrive from Apollo within minutes.', color: 'ink' }); onClose(); })
      .catch((e) => notifications.show({ title: 'Couldn’t start enrichment', message: errMsg(e), color: 'accent' }))
      .finally(() => setBusy(false));
  };
  return (
    <Modal opened={opened} onClose={onClose} title="Backfill leads from Apollo.io" size="lg">
      {!apollo && <Alert color="accent" variant="light" mb="sm">Connect Apollo.io under Integrations (or set APOLLO_API_KEY) first.</Alert>}
      <Text size="sm" c="dimmed" mb="sm">Fills missing emails, last names, titles and locations for leads Apollo can match, oldest first, and stops at the credit cap. Apollo charges about 1 credit a person, plus 8 for a mobile number.</Text>
      <NumberInput label="Credit cap for this run" min={1} max={100000} value={cap} onChange={setCap} w={220} description={`About ${Math.floor(Number(cap) / perPerson)} leads`} />
      <Switch mt="md" label="Request phone numbers" checked={phones} onChange={() => setPhones(!phones)}
        description={phoneWebhook ? 'Apollo sends numbers to this service’s webhook a few minutes later.' : 'Needs PUBLIC_URL to be a public https address so Apollo can deliver numbers; without it only emails and profile fields are filled.'} />
      <Group mt="md"><Button loading={busy} disabled={!apollo} onClick={run}>Enrich</Button><Button variant="default" onClick={onClose}>Cancel</Button></Group>
    </Modal>
  );
}
