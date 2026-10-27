import { useState } from 'react';
import { ActionIcon, Alert, Anchor, Badge, Box, Button, Card, Code, CopyButton, Group, List, NumberInput, Paper, PasswordInput, Select, SimpleGrid, Stack, Switch, Table, Text, TextInput, Textarea, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconCopy, IconPlugConnected, IconPlus, IconRefresh, IconTrash } from '@tabler/icons-react';
import type { IntegrationDTO, JobDTO } from '@calleval/framework';
import { usePal } from '../theme';
import { apiSend, apiSendText, errMsg, useApi, usePoll } from '../api';
import { ErrorState, Loading, Mono, PageHeader, SectionTitle, fmtWhen } from '../components/ui';
import { useMeta, useStore } from '../store';
import { NeedsTip, useCan } from '../components/access';

type Provider = IntegrationDTO['provider'];
type Form = { provider: Provider; name: string; apiKey: string; webhookSecret: string; agentIds: string; baseUrl: string; pollMinutes: number | string; enabled: boolean };

const PROVIDERS: Record<Provider, { label: string; keyHelp: string; secretHelp: string; agentHelp: string; baseHelp: string }> = {
  elevenlabs: {
    label: 'ElevenLabs Agents',
    keyHelp: 'An API key with Conversational AI read access (xi-api-key).',
    secretHelp: 'The HMAC secret ElevenLabs shows when you add a post-call webhook. Signatures arrive in the ElevenLabs-Signature header.',
    agentHelp: 'Agent IDs to pull (agent_…), comma-separated. Leave empty for every agent on the key.',
    baseHelp: 'Leave empty for api.elevenlabs.io, or pick a data-residency region.',
  },
  retell: {
    label: 'Retell AI',
    keyHelp: 'A Retell API key. Retell signs webhooks with the key marked for webhooks, so use that one.',
    secretHelp: 'Not needed: Retell signs webhooks (x-retell-signature) with the API key.',
    agentHelp: 'Retell agent IDs to pull, comma-separated. Leave empty for every agent.',
    baseHelp: 'Leave empty for api.retellai.com.',
  },
  treppan: {
    label: 'Treppan CRM',
    keyHelp: 'API token for the CRM export of lead stages.',
    secretHelp: 'Optional shared secret if the CRM pushes outcomes to the API.',
    agentHelp: 'Not used for the CRM.',
    baseHelp: 'Base URL of the CRM API.',
  },
  apollo: {
    label: 'Apollo.io',
    keyHelp: 'An Apollo API key with People Search and People Enrichment access (sent as x-api-key).',
    secretHelp: 'Not needed.',
    agentHelp: 'Not used for a lead finder.',
    baseHelp: 'Leave empty for api.apollo.io.',
  },
};
/** Voice platforms send calls; Treppan sends CRM outcomes; Apollo finds leads for the built-in CRM. */
const isVoice = (p: Provider) => p === 'elevenlabs' || p === 'retell';
const EL_REGIONS = [
  { value: '', label: 'Default · api.elevenlabs.io' },
  { value: 'https://api.us.elevenlabs.io', label: 'US · api.us.elevenlabs.io' },
  { value: 'https://api.eu.residency.elevenlabs.io', label: 'EU residency' },
  { value: 'https://api.in.residency.elevenlabs.io', label: 'India residency' },
  { value: 'https://api.sg.residency.elevenlabs.io', label: 'Singapore residency' },
];
const blank = (provider: Provider = 'elevenlabs'): Form => ({ provider, name: '', apiKey: '', webhookSecret: '', agentIds: '', baseUrl: '', pollMinutes: 15, enabled: true });
const CSV_SAMPLE = 'lead_id,stage,occurred_at,project,value_aed,external_id\nL-10293,meeting_attended,2026-10-18T10:00:00Z,Project A,,crm-881\nL-10293,reservation,2026-10-29T15:30:00Z,Project A,1650000,crm-902';

export function IntegrationsPage() {
  const p = usePal();
  const meta = useMeta();
  const { reloadMeta } = useStore();
  const list = useApi<IntegrationDTO[]>('/api/integrations');
  const jobs = useApi<JobDTO[]>('/api/jobs?limit=20');
  const running = (jobs.data ?? []).some((j) => j.status === 'queued' || j.status === 'running');
  usePoll(() => { jobs.reload(); if (running) list.reload(); }, running ? 3000 : 15000);
  const [adding, setAdding] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const can = useCan();
  const [csv, setCsv] = useState('');
  const [csvBusy, setCsvBusy] = useState(false);

  const seed = () => {
    setSeeding(true);
    apiSend('POST', '/api/demo/seed')
      .then(() => { notifications.show({ title: 'Demo data loading', message: 'Synthetic calls are being generated and scored by the pipeline.', color: 'ink' }); jobs.reload(); window.setTimeout(reloadMeta, 3000); })
      .catch((e) => notifications.show({ title: 'Couldn’t load demo data', message: errMsg(e), color: 'accent' }))
      .finally(() => setSeeding(false));
  };
  const importCsv = () => {
    setCsvBusy(true);
    apiSendText<{ imported?: number; credited?: number; skipped?: number }>('/api/crm/outcomes/csv', csv)
      .then((r) => { notifications.show({ title: 'Outcomes imported', message: `${r?.imported ?? 'All'} rows imported${r?.credited !== undefined ? `, ${r.credited} credited to a call` : ''}${r?.skipped ? `, ${r.skipped} skipped` : ''}.`, color: 'ink' }); setCsv(''); })
      .catch((e) => notifications.show({ title: 'Import failed', message: errMsg(e), color: 'accent' }))
      .finally(() => setCsvBusy(false));
  };

  const items = list.data ?? [];
  const voice = items.filter((i) => isVoice(i.provider));
  const crm = items.filter((i) => i.provider === 'treppan');
  const finders = items.filter((i) => i.provider === 'apollo');

  return (
    <>
      <PageHeader
        eyebrow="Data · Admins"
        title="Integrations"
        description="Connect the voice platforms the agent runs on. Calls arrive by webhook as soon as they end and by a scheduled pull as a safety net; each one runs through the evaluation pipeline. CRM outcomes join on the lead ID."
        right={<NeedsTip perm="integrations:manage"><Button leftSection={<IconPlus size={16} />} onClick={() => setAdding(true)} disabled={adding || !can('integrations:manage')}>Add integration</Button></NeedsTip>}
      />

      {meta.dataMode === 'empty' && (
        <Alert color="gray" variant="light" radius="lg" mb="lg" icon={<IconPlugConnected />} title="No calls yet">
          <Text size="sm">Add an ElevenLabs or Retell AI integration below, upload recordings under Audio logs, or load synthetic demo data to explore every view.</Text>
          <NeedsTip perm="settings:manage"><Button mt="sm" size="xs" variant="default" loading={seeding} disabled={!can('settings:manage')} onClick={seed}>Load demo data</Button></NeedsTip>
        </Alert>
      )}
      {meta.dataMode === 'demo' && (
        <Alert color="gray" variant="light" radius="lg" mb="lg" title="Showing demo data">
          <Text size="sm">The console is showing synthetic calls. Connect a provider to score real calls; live calls are kept apart from demo ones.</Text>
        </Alert>
      )}

      {adding && <IntegrationForm initial={blank()} onCancel={() => setAdding(false)} onSaved={() => { setAdding(false); list.reload(); reloadMeta(); }} />}

      <SectionTitle note="Webhooks deliver each call when it ends; the scheduled pull catches anything a webhook missed.">Voice platforms</SectionTitle>
      {list.error && !list.data && <ErrorState error={list.error} onRetry={list.reload} />}
      {!list.data && !list.error && <Loading />}
      {list.data && voice.length === 0 && !adding && (
        <Card mb="lg"><Text size="sm" c="dimmed">No voice platform connected yet. Add ElevenLabs or Retell AI to start pulling calls.</Text></Card>
      )}
      <Stack gap="md" mb="xl">
        {voice.map((i) => <IntegrationCard key={i.id} item={i} onChanged={() => { list.reload(); jobs.reload(); reloadMeta(); }} />)}
      </Stack>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg" mb="lg">
        <Card>
          <SectionTitle note="Meeting attended, site visit, reservation, broker registration and deal value come from the CRM and are credited to the most recent call within the attribution window.">CRM outcomes</SectionTitle>
          {crm.map((i) => <Box key={i.id} mb="md"><IntegrationCard item={i} compact onChanged={() => list.reload()} /></Box>)}
          <Text size="sm" mb={4}>Paste a CSV export, or POST JSON to <Mono size="sm">/api/crm/outcomes</Mono>.</Text>
          <Textarea autosize minRows={4} maxRows={12} placeholder={CSV_SAMPLE} value={csv} onChange={(e) => setCsv(e.currentTarget.value)} styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } }} />
          <Group gap="sm" mt="sm">
            <NeedsTip perm="crm:write"><Button size="xs" loading={csvBusy} disabled={!csv.trim() || !can('crm:write')} onClick={importCsv}>Import outcomes</Button></NeedsTip>
            <Anchor component="button" size="xs" onClick={() => setCsv(CSV_SAMPLE)}>Use the example</Anchor>
          </Group>
          <Text size="xs" c="dimmed" mt="sm">Stages: meeting_booked, meeting_attended, site_visit, reservation, sale, broker_registered, broker_deal, advisor_rating. Attribution window: {meta.settings.attributionDays} days ({meta.settings.reservationAttributionDays} for reservations).</Text>
        </Card>

        <Card>
          <SectionTitle right={<ActionIcon variant="default" aria-label="Refresh jobs" onClick={jobs.reload}><IconRefresh size={16} /></ActionIcon>} note="Ingestion, scoring, syncs and recommendation runs, newest first.">Pipeline jobs</SectionTitle>
          {jobs.error && !jobs.data && <Text size="sm" c={p.warnText}>{jobs.error}</Text>}
          {jobs.data && jobs.data.length === 0 && <Text size="sm" c="dimmed">No jobs yet.</Text>}
          {jobs.data && jobs.data.length > 0 && (
            <Table.ScrollContainer minWidth={460}>
              <Table verticalSpacing={4} fz="sm">
                <Table.Thead><Table.Tr><Table.Th>Job</Table.Th><Table.Th>Status</Table.Th><Table.Th ta="right">Tries</Table.Th><Table.Th>Updated</Table.Th></Table.Tr></Table.Thead>
                <Table.Tbody>
                  {jobs.data.map((j) => (
                    <Table.Tr key={j.id}>
                      <Table.Td><Mono size="xs">{j.kind}</Mono>{summarisePayload(j.payload) && <Text size="xs" c="dimmed" truncate maw={220}>{summarisePayload(j.payload)}</Text>}</Table.Td>
                      <Table.Td>
                        <Badge size="sm" tt="none" color={j.status === 'failed' ? 'accent' : j.status === 'done' ? 'gray' : 'ink'} variant={j.status === 'running' ? 'filled' : 'light'}>{j.status}</Badge>
                        {j.lastError && <Text size="xs" c={p.warnText} truncate maw={220} title={j.lastError}>{j.lastError}</Text>}
                      </Table.Td>
                      <Table.Td ta="right"><Mono size="xs">{j.attempts}</Mono></Table.Td>
                      <Table.Td><Text size="xs" c="dimmed">{fmtWhen(j.updatedAt)}</Text></Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </Card>
      </SimpleGrid>

      <Card mb="lg">
        <SectionTitle note="Apollo.io finds people who match the ideal customer profile from Business setup and fills the built-in CRM; enrichment backfills emails, titles and, with a public HTTPS address, phone numbers. Found leads are consent-unknown until you record consent.">Lead finders</SectionTitle>
        {finders.length === 0 && <Text size="sm" c="dimmed">No lead finder connected. Add an Apollo.io integration, or set APOLLO_API_KEY on the API.</Text>}
        <Stack gap="sm">{finders.map((i) => <IntegrationCard key={i.id} item={i} compact onChanged={() => list.reload()} />)}</Stack>
      </Card>

      <Card>
        <SectionTitle>Setting up a provider</SectionTitle>
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
          <Box>
            <Text fw={600} mb={4}>ElevenLabs Agents</Text>
            <List size="sm" spacing={4}>
              <List.Item>Create an API key with Conversational AI access and add the integration here.</List.Item>
              <List.Item>In ElevenLabs, add a post-call webhook with the URL shown on the integration, enable transcription events, and paste its HMAC secret here.</List.Item>
              <List.Item>Pass <Code>customer_name</Code>, <Code>known_facts</Code>, <Code>recent_history</Code>, <Code>objective</Code> and <Code>lead_id</Code> as dynamic variables so calls are scored against their opening context and joined to the CRM.</List.Item>
            </List>
          </Box>
          <Box>
            <Text fw={600} mb={4}>Retell AI</Text>
            <List size="sm" spacing={4}>
              <List.Item>Add the integration with the API key that has the webhook badge in Retell.</List.Item>
              <List.Item>Set the agent’s webhook URL to the one shown on the integration, with the <Code>call_analyzed</Code> event enabled.</List.Item>
              <List.Item>Use the same dynamic variable names in <Code>retell_llm_dynamic_variables</Code>; Retell’s multi-channel recording gives the cleanest audio scores.</List.Item>
            </List>
          </Box>
        </SimpleGrid>
      </Card>
    </>
  );
}

function summarisePayload(pl: Record<string, unknown> | null | undefined) {
  if (!pl) return '';
  const keys = ['callId', 'externalId', 'integrationId', 'since', 'count'];
  return keys.filter((k) => pl[k] !== undefined && pl[k] !== null).map((k) => `${k} ${String(pl[k])}`).join(' · ');
}

function IntegrationCard({ item, onChanged, compact = false }: { item: IntegrationDTO; onChanged: () => void; compact?: boolean }) {
  const p = usePal();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [since, setSince] = useState('');
  const [test, setTest] = useState<{ ok: boolean; message: string; agents?: unknown } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const hook = item.webhookUrl.startsWith('/') ? `${window.location.origin}${item.webhookUrl}` : item.webhookUrl;
  const prov = PROVIDERS[item.provider];

  const run = (key: string, fn: () => Promise<unknown>) => { setBusy(key); fn().finally(() => setBusy(null)); };
  const testIt = () => run('test', () => apiSend<{ ok: boolean; message: string; agents?: unknown }>('POST', `/api/integrations/${item.id}/test`).then(setTest).catch((e) => setTest({ ok: false, message: errMsg(e) })));
  const sync = () => run('sync', () => apiSend('POST', `/api/integrations/${item.id}/sync`, since ? { since: new Date(since).toISOString() } : {})
    .then(() => { notifications.show({ title: 'Sync queued', message: since ? `Backfilling calls since ${since}.` : 'Pulling calls since the last sync.', color: 'ink' }); onChanged(); })
    .catch((e) => notifications.show({ title: 'Couldn’t start the sync', message: errMsg(e), color: 'accent' })));
  const toggle = () => run('toggle', () => apiSend('PATCH', `/api/integrations/${item.id}`, { enabled: !item.enabled }).then(onChanged).catch((e) => notifications.show({ title: 'Couldn’t update', message: errMsg(e), color: 'accent' })));
  const remove = () => run('delete', () => apiSend('DELETE', `/api/integrations/${item.id}`).then(onChanged).catch((e) => notifications.show({ title: 'Couldn’t delete', message: errMsg(e), color: 'accent' })));

  if (editing) {
    return <IntegrationForm id={item.id} initial={{ provider: item.provider, name: item.name, apiKey: '', webhookSecret: '', agentIds: item.agentIds.join(', '), baseUrl: item.baseUrl ?? '', pollMinutes: item.pollMinutes, enabled: item.enabled }} hasKey={item.hasApiKey} hasSecret={item.hasWebhookSecret} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); onChanged(); }} />;
  }

  return (
    <Paper withBorder p={compact ? 'sm' : 'md'} radius="lg" style={{ borderColor: item.lastError ? p.warn : undefined, opacity: item.enabled ? 1 : 0.75 }}>
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
        <Stack gap={4} style={{ minWidth: 0, flex: '1 1 380px' }}>
          <Group gap={8} wrap="wrap">
            <Text fw={650}>{item.name}</Text>
            <Badge variant="light" color="gray" tt="none">{prov.label}</Badge>
            <Badge variant={item.enabled ? 'filled' : 'outline'} color="ink" tt="none">{item.enabled ? 'Enabled' : 'Paused'}</Badge>
          </Group>
          <Text size="sm" c="dimmed">
            {item.hasApiKey ? `Key ${item.apiKeyHint ?? 'set'}` : 'No API key'}
            {item.provider === 'apollo' ? ' · searches from the ideal customer profile in Business setup' : ` · ${item.provider === 'retell' ? 'webhooks signed with the key' : item.hasWebhookSecret ? 'webhook secret set' : 'no webhook secret'}`}
            {isVoice(item.provider) && ` · ${item.agentIds.length ? `${item.agentIds.length} agent${item.agentIds.length > 1 ? 's' : ''}` : 'all agents'} · pulls every ${item.pollMinutes} min`}
          </Text>
          {item.provider !== 'apollo' && (
            <Text size="sm">
              {item.callsImported.toLocaleString('en-US')} {item.provider === 'treppan' ? 'outcomes' : 'calls'} imported · last sync {item.lastSyncAt ? fmtWhen(item.lastSyncAt) : 'never'}{item.lastSyncStatus ? ` · ${item.lastSyncStatus}` : ''}
            </Text>
          )}
          {item.lastError && <Text size="sm" c={p.warnText}>Last error: {item.lastError}</Text>}
        </Stack>
        <Group gap="xs" wrap="wrap">
          <Switch checked={item.enabled} onChange={toggle} disabled={busy === 'toggle'} label="Enabled" />
          <Button size="xs" variant="default" onClick={() => setEditing(true)}>Edit</Button>
          {confirmDelete
            ? <><Button size="xs" color="accent" loading={busy === 'delete'} onClick={remove}>Delete for good</Button><Button size="xs" variant="default" onClick={() => setConfirmDelete(false)}>Keep</Button></>
            : <ActionIcon variant="default" size="lg" aria-label={`Delete ${item.name}`} onClick={() => setConfirmDelete(true)}><IconTrash size={16} /></ActionIcon>}
        </Group>
      </Group>

      {isVoice(item.provider) && (
        <Box mt="sm">
          <Text size="xs" fw={600} c="dimmed" mb={2}>Webhook URL · paste into {prov.label}</Text>
          <Group gap={6} wrap="nowrap">
            <Code style={{ flex: 1, overflowWrap: 'anywhere' }}>{hook}</Code>
            <CopyButton value={hook}>{({ copied, copy }) => (
              <Tooltip label={copied ? 'Copied' : 'Copy'}><ActionIcon variant="default" onClick={copy} aria-label="Copy webhook URL">{copied ? <IconCheck size={16} /> : <IconCopy size={16} />}</ActionIcon></Tooltip>
            )}</CopyButton>
          </Group>
        </Box>
      )}

      <Group gap="sm" mt="sm" align="flex-end" wrap="wrap">
        <Button size="xs" variant="default" loading={busy === 'test'} onClick={testIt}>Test connection</Button>
        {isVoice(item.provider) && <>
          <TextInput size="xs" type="date" label="Backfill since (optional)" value={since} onChange={(e) => setSince(e.currentTarget.value)} w={180} />
          <Button size="xs" loading={busy === 'sync'} disabled={!item.enabled} onClick={sync}>{since ? 'Backfill' : 'Sync now'}</Button>
        </>}
      </Group>
      {test && (
        <Alert mt="sm" color={test.ok ? 'gray' : 'accent'} variant="light" radius="md" p="sm" icon={test.ok ? <IconCheck size={16} /> : undefined}>
          <Text size="sm">{test.message}</Text>
          {Array.isArray(test.agents) && test.agents.length > 0 && <Text size="xs" c="dimmed" mt={4}>Agents: {(test.agents as any[]).map((a) => (typeof a === 'string' ? a : a?.name ?? a?.id)).join(', ')}</Text>}
        </Alert>
      )}
    </Paper>
  );
}

function IntegrationForm({ id, initial, hasKey = false, hasSecret = false, onCancel, onSaved }: { id?: string; initial: Form; hasKey?: boolean; hasSecret?: boolean; onCancel: () => void; onSaved: () => void }) {
  const [f, setF] = useState<Form>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const prov = PROVIDERS[f.provider];
  const editing = !!id;

  const save = () => {
    setBusy(true); setErr(null);
    const body: Record<string, unknown> = {
      provider: f.provider,
      name: f.name.trim() || prov.label,
      agentIds: f.agentIds.split(',').map((s) => s.trim()).filter(Boolean),
      baseUrl: f.baseUrl.trim() || null,
      pollMinutes: typeof f.pollMinutes === 'number' ? f.pollMinutes : parseInt(f.pollMinutes, 10) || 15,
      enabled: f.enabled,
    };
    if (f.apiKey.trim()) body.apiKey = f.apiKey.trim();
    if (f.webhookSecret.trim()) body.webhookSecret = f.webhookSecret.trim();
    const req = editing ? apiSend('PATCH', `/api/integrations/${id}`, body) : apiSend('POST', '/api/integrations', body);
    req.then(() => { notifications.show({ title: editing ? 'Integration updated' : 'Integration added', message: editing ? 'Changes saved.' : 'Run Test connection, then paste the webhook URL into the provider.', color: 'ink' }); onSaved(); })
      .catch((e) => setErr(errMsg(e)))
      .finally(() => setBusy(false));
  };

  return (
    <Card mb="lg">
      <SectionTitle>{editing ? `Edit ${initial.name}` : 'Add an integration'}</SectionTitle>
      <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} mb="sm">
        <Select label="Provider" disabled={editing} value={f.provider} onChange={(v) => v && set('provider', v as Provider)} data={(Object.keys(PROVIDERS) as Provider[]).map((k) => ({ value: k, label: PROVIDERS[k].label }))} />
        <TextInput label="Name" placeholder={prov.label} value={f.name} onChange={(e) => set('name', e.currentTarget.value)} />
        <PasswordInput label="API key" description={prov.keyHelp} placeholder={editing && hasKey ? 'Leave empty to keep the stored key' : ''} value={f.apiKey} onChange={(e) => set('apiKey', e.currentTarget.value)} />
        {(f.provider === 'elevenlabs' || f.provider === 'treppan') && <PasswordInput label="Webhook secret" description={prov.secretHelp} placeholder={editing && hasSecret ? 'Leave empty to keep the stored secret' : ''} value={f.webhookSecret} onChange={(e) => set('webhookSecret', e.currentTarget.value)} />}
        {isVoice(f.provider) && <TextInput label="Agent IDs" description={prov.agentHelp} placeholder="agent_…" value={f.agentIds} onChange={(e) => set('agentIds', e.currentTarget.value)} />}
        {f.provider === 'elevenlabs'
          ? <Select label="Region" description={prov.baseHelp} value={f.baseUrl} onChange={(v) => set('baseUrl', v ?? '')} data={EL_REGIONS} />
          : <TextInput label="Base URL" description={prov.baseHelp} placeholder={f.provider === 'retell' ? 'https://api.retellai.com' : f.provider === 'apollo' ? 'https://api.apollo.io/api/v1' : 'https://crm.example.com/api'} value={f.baseUrl} onChange={(e) => set('baseUrl', e.currentTarget.value)} />}
        {isVoice(f.provider) && <NumberInput label="Pull every (minutes)" description="Safety-net poll for calls a webhook missed." min={5} max={1440} value={f.pollMinutes} onChange={(v) => set('pollMinutes', v)} />}
      </SimpleGrid>
      <Switch label="Enabled" checked={f.enabled} onChange={() => set('enabled', !f.enabled)} mb="sm" />
      {err && <Text size="sm" c="var(--mantine-color-accent-filled)" mb="sm">{err}</Text>}
      <Group gap="sm">
        <Button loading={busy} disabled={!editing && !f.apiKey.trim()} onClick={save}>{editing ? 'Save changes' : 'Add integration'}</Button>
        <Button variant="default" onClick={onCancel}>Cancel</Button>
      </Group>
    </Card>
  );
}
