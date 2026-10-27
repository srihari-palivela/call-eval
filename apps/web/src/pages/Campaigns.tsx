import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Code, Drawer, Group, Modal, MultiSelect, NumberInput, ScrollArea, SegmentedControl, Select, SimpleGrid, Stack, Switch, Table, TagsInput, Text, TextInput, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPhoneOutgoing, IconPlayerPause, IconPlayerPlay, IconPlus, IconSparkles, IconX } from '@tabler/icons-react';
import type { CampaignArmDTO, CampaignDetailDTO, CampaignDTO, ImprovementMode, IntegrationDTO, LeadFunnelsDTO } from '@calleval/framework';
import { usePal } from '../theme';
import { apiSend, errMsg, useApi, usePoll } from '../api';
import { ErrorState, Loading, Mono, PageHeader, SectionTitle, StatCard, fmtWhen } from '../components/ui';
import { defaultFunnel, funnelById } from '../components/funnels';
import { useStore } from '../store';
import { NeedsTip, useAllow, useCan } from '../components/access';
import { PlanNotice } from '../components/plan';

/** Stages offered when the funnels can't be loaded (the default funnel's open stages). */
const STAGES = ['new', 'contacted', 'qualified', 'meeting_booked', 'meeting_attended', 'site_visit'];
const STATUS_COLOR: Record<string, string> = { running: 'ink', draft: 'gray', paused: 'accent', completed: 'gray', cancelled: 'gray' };
const MODE_LABEL: Record<ImprovementMode, string> = { off: 'Off', propose: 'Propose', auto: 'Auto' };

export function CampaignsPage() {
  const { meta, reloadMeta, go } = useStore();
  const can = useCan();
  const allow = useAllow();
  const on = meta!.settings.features.campaigns;
  const list = useApi<CampaignDTO[]>(on ? '/api/campaigns' : null);
  const [sel, setSel] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  usePoll(() => list.reload(), 15000, on);

  if (!on) {
    return (
      <>
        <PlanNotice feature="campaigns" />
        <PageHeader eyebrow="Grow · Sales" title="Campaigns" description="Batch outbound calling from CRM leads through ElevenLabs or Retell, with a self-improvement loop that tests a better prompt on a share of the calls." />
        <Card padding="xl">
          <Group gap="md" align="flex-start" wrap="nowrap">
            <IconPhoneOutgoing size={28} stroke={1.6} />
            <Stack gap={6}>
              <Text fw={650}>Batch calling is off</Text>
              <Text size="sm" c="dimmed">Turning it on also turns on the built-in CRM. Campaigns only call leads with a dialable number, recorded consent (unless you allow unknown consent), no do-not-contact request, and attempts left, inside the calling hours from Business setup.</Text>
              <Group gap="xs" mt={4}>
                <NeedsTip perm="settings:manage" feature="campaigns"><Button size="xs" disabled={!allow('settings:manage', 'campaigns')} onClick={() => apiSend('PUT', '/api/settings', { features: { campaigns: true } }).then(reloadMeta).catch((e) => notifications.show({ title: 'Couldn’t turn it on', message: errMsg(e), color: 'accent' }))}>Turn on batch calling</Button></NeedsTip>
                <Button size="xs" variant="default" onClick={() => go('business')}>Business setup</Button>
              </Group>
            </Stack>
          </Group>
        </Card>
      </>
    );
  }

  return (
    <>
      <PlanNotice feature="campaigns" />
      <PageHeader eyebrow="Grow · Sales" title="Campaigns"
        description="Each campaign calls eligible CRM leads in batches inside the calling hours. When a challenger prompt is live, a share of each batch gets it, and the version report decides whether it is better."
        right={<NeedsTip perm="campaigns:manage" feature="campaigns"><Button leftSection={<IconPlus size={16} />} disabled={!allow('campaigns:manage', 'campaigns')} onClick={() => setCreating(true)}>New campaign</Button></NeedsTip>} />
      {list.error && !list.data && <ErrorState error={list.error} onRetry={list.reload} />}
      {!list.data && !list.error && <Loading />}
      {list.data && list.data.length === 0 && <Card><Text size="sm" c="dimmed">No campaigns yet. Create one to start calling CRM leads.</Text></Card>}
      <Stack gap="md">
        {(list.data ?? []).map((c) => <CampaignCard key={c.id} c={c} onOpen={() => setSel(c.id)} />)}
      </Stack>
      <CampaignDrawer id={sel} onClose={() => setSel(null)} onChanged={list.reload} />
      <CreateCampaign opened={creating} onClose={() => setCreating(false)} onSaved={(id) => { setCreating(false); list.reload(); setSel(id); }} />
    </>
  );
}

function ArmLine({ a }: { a: CampaignArmDTO }) {
  return (
    <Text size="sm">
      <Badge size="xs" variant={a.arm === 'challenger' ? 'filled' : 'light'} color={a.arm === 'challenger' ? 'accent' : 'ink'} tt="none" mr={6}>{a.arm} · {a.label}</Badge>
      {a.scored}/{a.dispatched} scored · CQS {a.cqs ?? '—'} · meetings {a.meetingRate ?? '—'}% · gates {a.gateRate ?? '—'}%
    </Text>
  );
}

function CampaignCard({ c, onOpen }: { c: CampaignDTO; onOpen: () => void }) {
  const p = usePal();
  return (
    <Card withBorder style={{ cursor: 'pointer' }} onClick={onOpen}>
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <Stack gap={4} style={{ minWidth: 0, flex: '1 1 360px' }}>
          <Group gap={8}>
            <Text fw={650}>{c.name}</Text>
            <Badge tt="none" color={STATUS_COLOR[c.status]} variant={c.status === 'running' ? 'filled' : 'light'}>{c.status}</Badge>
            <Badge tt="none" variant="outline" color="gray">Improvement · {MODE_LABEL[c.improvement]}</Badge>
            {c.challenger && <Badge tt="none" color="accent" variant="light">Challenger {c.challenger.label} live</Badge>}
          </Group>
          <Text size="sm" c="dimmed">{c.objective ?? 'No objective'} · batches of {c.batchSize}, up to {c.dailyCap} a day{c.allowUnknownConsent ? ' · includes unknown consent' : ''}</Text>
          {(c.stats.arms ?? []).map((a) => <ArmLine key={`${a.arm}:${a.label}`} a={a} />)}
          {c.stats.error && <Text size="sm" c={p.warnText}>{c.stats.error}</Text>}
        </Stack>
        <Group gap="lg">
          <Stack gap={0} align="flex-end"><Text size="xs" c="dimmed">Leads called</Text><Mono fz="lg">{c.stats.leads ?? 0}</Mono></Stack>
          <Stack gap={0} align="flex-end"><Text size="xs" c="dimmed">Calls</Text><Mono fz="lg">{c.stats.called ?? 0}</Mono></Stack>
        </Group>
      </Group>
    </Card>
  );
}

function CampaignDrawer({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const p = usePal();
  const { go } = useStore();
  const d = useApi<CampaignDetailDTO>(id ? `/api/campaigns/${id}` : null);
  const [busy, setBusy] = useState<string | null>(null);
  const can = useCan();
  const allow = useAllow();
  usePoll(() => d.reload(), 10000, !!id);
  const c = d.data;
  const act = (a: string) => {
    setBusy(a);
    apiSend('POST', `/api/campaigns/${id}/${a}`)
      .then(() => { d.reload(); onChanged(); if (a === 'improve') notifications.show({ title: 'Improvement cycle started', message: 'Proposing and probing prompt edits; follow it under Self-improvement.', color: 'ink' }); })
      .catch((e) => notifications.show({ title: 'Couldn’t do that', message: errMsg(e), color: 'accent' }))
      .finally(() => setBusy(null));
  };
  const setMode = (m: string) => apiSend('PATCH', `/api/campaigns/${id}`, { improvement: m }).then(() => { d.reload(); onChanged(); }).catch((e) => notifications.show({ title: 'Couldn’t change it', message: errMsg(e), color: 'accent' }));

  return (
    <Drawer opened={!!id} onClose={onClose} position="right" size="xl" title={<Text fw={650}>{c?.name ?? 'Campaign'}</Text>}>
      {d.error && !c && <ErrorState error={d.error} onRetry={d.reload} />}
      {!c && !d.error && <Loading />}
      {c && (
        <Stack gap="lg">
          <Group gap="xs">
            {(c.status === 'draft' || c.status === 'paused') && (
              <NeedsTip perm="campaigns:start" feature="campaigns"><Button size="xs" leftSection={<IconPlayerPlay size={14} />} loading={busy === 'start'} disabled={!allow('campaigns:start', 'campaigns')} onClick={() => act('start')}>{c.status === 'draft' ? 'Start calling' : 'Resume'}</Button></NeedsTip>
            )}
            {c.status === 'running' && <NeedsTip perm="campaigns:manage"><Button size="xs" variant="default" leftSection={<IconPlayerPause size={14} />} loading={busy === 'pause'} disabled={!can('campaigns:manage')} onClick={() => act('pause')}>Pause</Button></NeedsTip>}
            {c.status !== 'cancelled' && c.status !== 'completed' && <NeedsTip perm="campaigns:manage"><Button size="xs" variant="default" color="accent" leftSection={<IconX size={14} />} loading={busy === 'cancel'} disabled={!can('campaigns:manage')} onClick={() => act('cancel')}>Cancel</Button></NeedsTip>}
            <NeedsTip perm="improvement:approve" feature="improvement"><Button size="xs" variant="default" leftSection={<IconSparkles size={14} />} loading={busy === 'improve'} disabled={c.improvement === 'off' || !allow('improvement:approve', 'improvement')} onClick={() => act('improve')}>Improve now</Button></NeedsTip>
            {c.cycle && <Button size="xs" variant="subtle" onClick={() => go('improvement', { cycle: c.cycle!.id })}>Open cycle · {c.cycle.status.replace('_', ' ')}</Button>}
          </Group>
          {c.stats.error && <Alert color="accent" variant="light" title="Paused by a provider error">{c.stats.error}</Alert>}
          {!c.inCallingWindow && c.status === 'running' && <Alert color="gray" variant="light">Outside the calling hours set in Business setup; the next batch goes out when the window opens.</Alert>}
          <SimpleGrid cols={3}>
            <StatCard label="Eligible leads" value={c.eligibleLeads} note="callable now" />
            <StatCard label="Leads called" value={c.stats.leads ?? 0} note={`${c.stats.failed ?? 0} not answered`} />
            <StatCard label="Calls" value={c.stats.called ?? 0} note={`batches of ${c.batchSize}`} />
          </SimpleGrid>

          <Card withBorder>
            <SectionTitle note={`A challenger needs ${c.minCallsPerArm} scored calls on each arm before the verdict; it gets ${Math.round(c.challengerShare * 100)}% of each batch.`}
              right={<SegmentedControl size="xs" value={c.improvement} onChange={setMode} disabled={!can('campaigns:manage')} data={[{ value: 'off', label: 'Off' }, { value: 'propose', label: 'Propose' }, { value: 'auto', label: 'Auto' }]} />}>Arms</SectionTitle>
            {c.arms.length === 0 ? <Text size="sm" c="dimmed">No calls yet.</Text> : (
              <Table fz="sm" verticalSpacing={4}>
                <Table.Thead><Table.Tr><Table.Th>Arm</Table.Th><Table.Th ta="right">Dispatched</Table.Th><Table.Th ta="right">Scored</Table.Th><Table.Th ta="right">Median CQS</Table.Th><Table.Th ta="right">Meetings</Table.Th><Table.Th ta="right">Gate failures</Table.Th></Table.Tr></Table.Thead>
                <Table.Tbody>{c.arms.map((a) => (
                  <Table.Tr key={`${a.arm}:${a.label}`}>
                    <Table.Td><Badge size="sm" tt="none" variant={a.arm === 'challenger' ? 'filled' : 'light'} color={a.arm === 'challenger' ? 'accent' : 'ink'}>{a.arm} · {a.label}</Badge></Table.Td>
                    <Table.Td ta="right"><Mono size="sm">{a.dispatched}</Mono></Table.Td><Table.Td ta="right"><Mono size="sm">{a.scored}</Mono></Table.Td>
                    <Table.Td ta="right"><Mono size="sm">{a.cqs ?? '—'}</Mono></Table.Td><Table.Td ta="right"><Mono size="sm">{a.meetingRate ?? '—'}%</Mono></Table.Td>
                    <Table.Td ta="right"><Mono size="sm" c={a.gateRate ? p.warnText : undefined}>{a.gateRate ?? '—'}%</Mono></Table.Td>
                  </Table.Tr>
                ))}</Table.Tbody>
              </Table>
            )}
          </Card>

          <div>
            <SectionTitle>Batches</SectionTitle>
            {c.batches.length === 0 ? <Text size="sm" c="dimmed">None submitted yet.</Text> : (
              <Stack gap={4}>{c.batches.map((b) => (
                <Text key={b.id} size="sm">{fmtWhen(b.submittedAt)} · {b.size} calls · {b.status}{b.arms ? ` · ${Object.entries(b.arms).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}{b.error ? ` · ${b.error}` : ''}</Text>
              ))}</Stack>
            )}
          </div>

          <div>
            <SectionTitle note={c.champion?.source ? `From ${c.champion.source}` : undefined}>Champion prompt · {c.champion?.label ?? '—'}</SectionTitle>
            <ScrollArea.Autosize mah={240}><Code block fz={11}>{c.championPrompt ?? 'Recorded when the campaign starts.'}</Code></ScrollArea.Autosize>
          </div>
          {c.challengerPrompt && (
            <div>
              <SectionTitle>Challenger prompt · {c.challenger?.label}</SectionTitle>
              <ScrollArea.Autosize mah={240}><Code block fz={11}>{c.challengerPrompt}</Code></ScrollArea.Autosize>
            </div>
          )}
        </Stack>
      )}
    </Drawer>
  );
}

function CreateCampaign({ opened, onClose, onSaved }: { opened: boolean; onClose: () => void; onSaved: (id: string) => void }) {
  const integrations = useApi<IntegrationDTO[]>(opened ? '/api/integrations' : null);
  const funnels = useApi<LeadFunnelsDTO>(opened ? '/api/crm/funnels' : null);
  const voice = (integrations.data ?? []).filter((i) => i.provider === 'elevenlabs' || i.provider === 'retell');
  const [f, setF] = useState({ name: '', integrationId: '', agentExternalId: '', fromNumber: '', objective: '', stages: ['new', 'contacted'] as string[], tags: [] as string[],
    batchSize: 50 as number | string, dailyCap: 300 as number | string, allowUnknownConsent: false, improvement: 'propose', challengerShare: 0.2 as number | string, minCallsPerArm: 30 as number | string });
  const [funnelId, setFunnelId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const integ = voice.find((i) => i.id === f.integrationId);
  const fnl = funnelById(funnels.data, funnelId);
  const stageOptions = fnl ? fnl.stages.filter((x) => x.kind === 'open' && x.callable).map((x) => ({ value: x.key, label: x.label })) : STAGES;
  const pickFunnel = (id: string | null) => {
    const next = funnelById(funnels.data, id);
    setFunnelId(next?.id ?? null);
    const callable = (next?.stages ?? []).filter((x) => x.kind === 'open' && x.callable).map((x) => x.key);
    setF((x) => ({ ...x, stages: callable.slice(0, 2) }));
  };
  useEffect(() => { if (funnels.data && !funnelId) pickFunnel(defaultFunnel(funnels.data)?.id ?? null); }, [funnels.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = () => {
    setBusy(true);
    apiSend<CampaignDTO>('POST', '/api/campaigns', {
      name: f.name, integrationId: f.integrationId, agentExternalId: f.agentExternalId || undefined, fromNumber: f.fromNumber || undefined, objective: f.objective || undefined,
      leadFilter: { ...(funnelId ? { funnels: [funnelId] } : {}), stages: f.stages, ...(f.tags.length ? { tags: f.tags } : {}) }, batchSize: Number(f.batchSize), dailyCap: Number(f.dailyCap),
      allowUnknownConsent: f.allowUnknownConsent, improvement: f.improvement, challengerShare: Number(f.challengerShare), minCallsPerArm: Number(f.minCallsPerArm),
    })
      .then((c) => { notifications.show({ title: 'Campaign created', message: 'Review it, then start calling.', color: 'ink' }); onSaved(c.id); })
      .catch((e) => notifications.show({ title: 'Couldn’t create the campaign', message: errMsg(e), color: 'accent' }))
      .finally(() => setBusy(false));
  };
  return (
    <Modal opened={opened} onClose={onClose} title="New campaign" size="xl">
      {integrations.data && voice.length === 0 && <Alert color="accent" variant="light" mb="sm">Connect ElevenLabs or Retell AI under Integrations first: campaigns place calls through them.</Alert>}
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.currentTarget.value })} />
        <Select label="Calls through" data={voice.map((i) => ({ value: i.id, label: `${i.name} (${i.provider === 'retell' ? 'Retell' : 'ElevenLabs'})` }))} value={f.integrationId} onChange={(v) => setF({ ...f, integrationId: v ?? '', agentExternalId: '' })} />
        <Select label="Agent" description="The provider agent that places the calls" searchable data={integ?.agentIds ?? []} value={f.agentExternalId || null} onChange={(v) => setF({ ...f, agentExternalId: v ?? '' })}
          placeholder={integ && !integ.agentIds.length ? 'Type the agent id' : undefined} nothingFoundMessage="Type the agent id" />
        <TextInput label={integ?.provider === 'retell' ? 'From number (E.164)' : 'Phone number id (optional)'} description={integ?.provider === 'retell' ? 'A number on the Retell account' : 'ElevenLabs agent_phone_number_id; Twilio or SIP numbers only'}
          value={f.fromNumber} onChange={(e) => setF({ ...f, fromNumber: e.currentTarget.value })} />
      </SimpleGrid>
      {integ && !integ.agentIds.length && <TextInput mt="sm" label="Agent id" value={f.agentExternalId} onChange={(e) => setF({ ...f, agentExternalId: e.currentTarget.value })} />}
      <Textarea mt="sm" label="Objective" description="Passed to the agent as the call objective" autosize minRows={2} value={f.objective} onChange={(e) => setF({ ...f, objective: e.currentTarget.value })} />
      <SimpleGrid cols={{ base: 1, sm: 2 }} mt="sm">
        {(funnels.data?.funnels.length ?? 0) > 0 && (
          <Select label="Funnel" description="Campaigns call leads in one funnel" data={funnels.data!.funnels.map((x) => ({ value: x.id, label: x.isDefault ? `${x.name} (default)` : x.name }))} value={funnelId} onChange={pickFunnel} />
        )}
        <MultiSelect label="Lead stages to call" description={fnl ? 'Callable open stages of this funnel' : undefined} data={stageOptions} value={f.stages} onChange={(v) => setF({ ...f, stages: v })} />
        <TagsInput label="Only leads tagged (optional)" value={f.tags} onChange={(v) => setF({ ...f, tags: v })} />
        <NumberInput label="Batch size" min={1} max={1000} value={f.batchSize} onChange={(v) => setF({ ...f, batchSize: v })} />
        <NumberInput label="Daily cap" min={1} max={100000} value={f.dailyCap} onChange={(v) => setF({ ...f, dailyCap: v })} />
      </SimpleGrid>
      <Card withBorder mt="md">
        <Text fw={600} size="sm" mb={6}>Self-improvement</Text>
        <SegmentedControl size="xs" value={f.improvement} onChange={(v) => setF({ ...f, improvement: v })} data={[{ value: 'off', label: 'Off' }, { value: 'propose', label: 'Propose: a person approves' }, { value: 'auto', label: 'Auto: verified wins only' }]} />
        <SimpleGrid cols={2} mt="sm">
          <NumberInput label="Challenger share of calls" min={0.05} max={0.5} step={0.05} decimalScale={2} value={f.challengerShare} onChange={(v) => setF({ ...f, challengerShare: v })} />
          <NumberInput label="Calls per arm before a verdict" min={5} max={10000} value={f.minCallsPerArm} onChange={(v) => setF({ ...f, minCallsPerArm: v })} />
        </SimpleGrid>
      </Card>
      <Switch mt="md" label="Include leads with unknown consent" description="Only where your local rules allow calling them; leads from lead finders have no recorded consent." checked={f.allowUnknownConsent} onChange={() => setF({ ...f, allowUnknownConsent: !f.allowUnknownConsent })} />
      <Group mt="md"><Button loading={busy} disabled={!f.name.trim() || !f.integrationId} onClick={save}>Create campaign</Button><Button variant="default" onClick={onClose}>Cancel</Button></Group>
    </Modal>
  );
}
