import { useEffect, useState } from 'react';
import { Alert, Anchor, Badge, Button, Card, Chip, Code, Drawer, Group, List, MultiSelect, NumberInput, SegmentedControl, Select, SimpleGrid, Stack, Switch, Table, TagsInput, Text, TextInput, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconBuildingStore, IconCheck, IconWand } from '@tabler/icons-react';
import type { BusinessDTO, BusinessProfile, BusinessProposalDTO, BusinessSection, SettingsDTO } from '@calleval/framework';
import { apiSend, errMsg, useApi } from '../api';
import { ErrorState, Loading, PageHeader, SectionTitle, StatCard, useLookups } from '../components/ui';
import { CopilotQuestions, CopilotUsageLine, CopilotWorking, NO_CLAUDE_KEY } from '../components/copilot';
import { useStore } from '../store';
import { NeedsTip, useAllow, useCan } from '../components/access';

const SENIORITIES = ['owner', 'founder', 'c_suite', 'partner', 'vp', 'head', 'director', 'manager', 'senior', 'entry', 'intern'];
const EMPLOYEE_RANGES = ['1,10', '11,20', '21,50', '51,100', '101,200', '201,500', '501,1000', '1001,2000', '2001,5000', '5001,10000', '10001,1000000'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const num = (v: string | number) => (v === '' || v === null || v === undefined ? null : Number(v));
const SECTIONS: { key: BusinessSection; label: string }[] = [
  { key: 'company', label: 'Company' }, { key: 'icp', label: 'Ideal customer profile' }, { key: 'goals', label: 'Goals' }, { key: 'calling', label: 'Calling rules' },
];
const FIELD_LABELS: Record<string, string> = {
  name: 'Name', website: 'Website', industry: 'Industry', description: 'Description', offer: 'What the agent sells', markets: 'Markets', languages: 'Languages',
  titles: 'Job titles', excludeTitles: 'Exclude titles', seniorities: 'Seniority', industries: 'Industries', personLocations: 'Person locations',
  organizationLocations: 'Company locations', employeeRanges: 'Company size', keywords: 'Keywords', personaHint: 'Expected persona',
  meetingsPerWeek: 'Meetings per week', targetMeetingRate: 'Meeting rate target (%)', targetCqs: 'Median CQS target', leadsPerWeek: 'New leads per week',
  monthlyCallBudget: 'Monthly call budget', focusPersonas: 'Focus personas', focusScenarios: 'Focus scenarios',
  timezone: 'Time zone', startHour: 'From (hour)', endHour: 'Until (hour)', days: 'Days', maxAttemptsPerLead: 'Attempts per lead', allowUnknownConsent: 'Call leads with unknown consent',
};
function fmtValue(field: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.length ? (field === 'days' ? v.map((d) => DAYS[Number(d)] ?? d) : v).join(', ') : '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function BusinessPage() {
  const { meta, reloadMeta, go } = useStore();
  const data = useApi<BusinessDTO>('/api/business');
  const [p, setP] = useState<BusinessProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [copilot, setCopilot] = useState(false);
  const { personas, scenarios } = useLookups();
  const can = useCan();
  const allow = useAllow();
  useEffect(() => { if (data.data && !p) setP(data.data.profile); }, [data.data, p]);

  if (data.error && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />;
  if (!data.data || !p) return <Loading />;
  const features = meta!.settings.features;
  const prog = data.data.progress;

  const set = <K extends keyof BusinessProfile>(k: K, patch: Partial<BusinessProfile[K]>) => setP((x) => (x ? { ...x, [k]: { ...(x[k] as object), ...patch } } : x));
  const save = () => {
    setBusy(true);
    apiSend<BusinessProfile>('PUT', '/api/business', { company: p.company, icp: p.icp, goals: p.goals, calling: p.calling, onboarded: true })
      .then((saved) => { setP(saved); data.reload(); notifications.show({ title: 'Business setup saved', message: 'Lead finders, campaigns and the improvement loop now work from this profile.', color: 'ink' }); })
      .catch((e) => notifications.show({ title: 'Couldn’t save', message: errMsg(e), color: 'accent' }))
      .finally(() => setBusy(false));
  };
  const setFeature = (patch: Partial<SettingsDTO['features']>) => apiSend<SettingsDTO>('PUT', '/api/settings', { features: patch })
    .then(() => reloadMeta())
    .catch((e) => notifications.show({ title: 'Couldn’t change the module', message: errMsg(e), color: 'accent' }));
  const track = (v: boolean | null) => (v === null ? undefined : v ? 'ok' as const : 'warn' as const);

  return (
    <>
      <PageHeader eyebrow="Grow · Sales leadership" title="Business setup"
        description="Who the agent sells for, who it should reach, and the goals it is held to. Lead finders search from the ideal customer profile, campaigns follow the calling rules, and the self-improvement loop ranks fixes by the goals."
        right={(
          <Group gap="xs">
            <Button variant="default" leftSection={<IconWand size={16} />} onClick={() => setCopilot(true)}>Co-pilot</Button>
            <NeedsTip perm="business:manage"><Button loading={busy} disabled={!can('business:manage')} onClick={save}>{prog.onboarded ? 'Save changes' : 'Finish onboarding'}</Button></NeedsTip>
          </Group>
        )} />

      {!prog.onboarded && (
        <Alert color="gray" variant="light" radius="lg" mb="lg" icon={<IconBuildingStore />} title="Start here">
          <Text size="sm">Describe the business and the people you want to reach, set the weekly goals, then turn on the CRM to find and call leads. The <Anchor component="button" size="sm" onClick={() => setCopilot(true)}>co-pilot</Anchor> can draft all of it from a description or your website.</Text>
        </Alert>
      )}

      <SimpleGrid cols={{ base: 2, sm: 3, lg: 5 }} mb="lg">
        <StatCard label="Meetings this week" value={prog.week.meetings} note={prog.goals.meetingsPerWeek !== null ? `goal ${prog.goals.meetingsPerWeek}` : 'no goal set'} tone={track(prog.onTrack.meetings)} />
        <StatCard label="Meeting rate" value={prog.week.meetingRate === null ? '—' : `${prog.week.meetingRate}%`} note={prog.goals.targetMeetingRate !== null ? `target ${prog.goals.targetMeetingRate}%` : `${prog.week.calls} calls`} tone={track(prog.onTrack.meetingRate)} />
        <StatCard label="Median CQS" value={prog.week.cqs ?? '—'} note={prog.goals.targetCqs !== null ? `target ${prog.goals.targetCqs}` : 'last 7 days'} tone={track(prog.onTrack.cqs)} />
        <StatCard label="New leads this week" value={prog.week.newLeads} note={prog.goals.leadsPerWeek !== null ? `goal ${prog.goals.leadsPerWeek}` : 'no goal set'} tone={track(prog.onTrack.leads)} />
        <StatCard label="Calls this month" value={prog.month.calls} note={prog.goals.monthlyCallBudget !== null ? `budget ${prog.goals.monthlyCallBudget}` : 'no budget set'} tone={prog.onTrack.budget === false ? 'warn' : undefined} />
      </SimpleGrid>

      <Card mb="lg">
        <SectionTitle note="Optional modules. Campaigns need the CRM; the improvement mode decides what the self-improvement loop may do on its own.">Modules</SectionTitle>
        <Group gap="xl" wrap="wrap" align="flex-start">
          <NeedsTip perm="settings:manage" feature={features.crm ? undefined : 'crm'}><Switch label="Built-in CRM" description="Leads, stages and lead finders" checked={features.crm} disabled={!allow('settings:manage', features.crm ? undefined : 'crm')} onChange={() => setFeature({ crm: !features.crm })} /></NeedsTip>
          <NeedsTip perm="settings:manage" feature={features.campaigns ? undefined : 'campaigns'}><Switch label="Batch calling" description="Outbound campaigns from CRM leads" checked={features.campaigns} disabled={!allow('settings:manage', features.campaigns ? undefined : 'campaigns')} onChange={() => setFeature({ campaigns: !features.campaigns })} /></NeedsTip>
          <Stack gap={4}>
            <Text size="sm" fw={500}>Self-improvement</Text>
            <NeedsTip perm="settings:manage" feature={features.improvement === 'off' ? 'improvement' : undefined}>
              <SegmentedControl size="xs" value={features.improvement} disabled={!can('settings:manage')} onChange={(v) => setFeature({ improvement: v as SettingsDTO['features']['improvement'] })}
                data={[{ value: 'off', label: 'Off' }, { value: 'propose', label: 'Propose (approve each change)', disabled: !allow('settings:manage', 'improvement') }, { value: 'auto', label: 'Auto (verified wins)', disabled: !allow('settings:manage', 'improvement') }]} />
            </NeedsTip>
            <Text size="xs" c="dimmed" maw={460}>Auto promotes a challenger prompt only after live calls show a 95% interval above zero with no rise in gate failures; edits that touch compliance rules always wait for a person.</Text>
          </Stack>
          <Group gap="xs">
            {features.crm && <Button variant="default" size="xs" onClick={() => go('leads')}>Open the CRM</Button>}
            {features.crm && <Button variant="default" size="xs" onClick={() => go('funnels')}>Design funnels</Button>}
            <Button variant="default" size="xs" onClick={() => go('taxonomy', { copilot: 'draft' })}>Define the taxonomy</Button>
          </Group>
        </Group>
      </Card>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg" mb="lg">
        <Card>
          <SectionTitle>Company</SectionTitle>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput label="Name" value={p.company.name} onChange={(e) => set('company', { name: e.currentTarget.value })} />
            <TextInput label="Website" value={p.company.website} onChange={(e) => set('company', { website: e.currentTarget.value })} />
            <TextInput label="Industry" value={p.company.industry} onChange={(e) => set('company', { industry: e.currentTarget.value })} />
            <TagsInput label="Markets" placeholder="UAE, UK…" value={p.company.markets} onChange={(v) => set('company', { markets: v })} />
          </SimpleGrid>
          <Textarea mt="sm" label="What the agent sells" autosize minRows={2} value={p.company.offer} onChange={(e) => set('company', { offer: e.currentTarget.value })} />
          <Textarea mt="sm" label="Description" autosize minRows={2} value={p.company.description} onChange={(e) => set('company', { description: e.currentTarget.value })} />
        </Card>

        <Card>
          <SectionTitle note="Lead finders search with these filters (Apollo's vocabulary).">Ideal customer profile</SectionTitle>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TagsInput label="Job titles" placeholder="Real estate broker…" value={p.icp.titles} onChange={(v) => set('icp', { titles: v })} />
            <TagsInput label="Exclude titles" value={p.icp.excludeTitles} onChange={(v) => set('icp', { excludeTitles: v })} />
            <MultiSelect label="Seniority" data={SENIORITIES} value={p.icp.seniorities} onChange={(v) => set('icp', { seniorities: v })} />
            <TagsInput label="Industries" value={p.icp.industries} onChange={(v) => set('icp', { industries: v })} />
            <TagsInput label="Person locations" placeholder="London, United Kingdom" value={p.icp.personLocations} onChange={(v) => set('icp', { personLocations: v })} />
            <TagsInput label="Company locations" value={p.icp.organizationLocations} onChange={(v) => set('icp', { organizationLocations: v })} />
            <MultiSelect label="Company size (employees)" data={EMPLOYEE_RANGES.map((r) => ({ value: r, label: r.replace(',', '–') }))} value={p.icp.employeeRanges} onChange={(v) => set('icp', { employeeRanges: v })} />
            <TextInput label="Keywords" value={p.icp.keywords} onChange={(e) => set('icp', { keywords: e.currentTarget.value })} />
            <Select label="Expected persona" description="Applied to found leads" clearable data={personas.map((x) => ({ value: x.id, label: `${x.id} ${x.name}` }))} value={p.icp.personaHint} onChange={(v) => set('icp', { personaHint: v })} />
          </SimpleGrid>
          <Text size="xs" c="dimmed" mt="sm" mb={4}>Apollo search this profile produces{data.data.leadFinder.apollo ? '' : ' (connect Apollo under Integrations to run it)'}:</Text>
          <Code block fz={11}>{JSON.stringify(data.data.apolloQuery, null, 1)}</Code>
        </Card>

        <Card>
          <SectionTitle note="Progress shows above; the improvement loop ranks fixes in the focus personas and scenarios first.">Goals</SectionTitle>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <NumberInput label="Meetings per week" min={0} value={p.goals.meetingsPerWeek ?? ''} onChange={(v) => set('goals', { meetingsPerWeek: num(v) })} />
            <NumberInput label="Meeting rate target (%)" min={0} max={100} value={p.goals.targetMeetingRate ?? ''} onChange={(v) => set('goals', { targetMeetingRate: num(v) })} />
            <NumberInput label="Median CQS target" min={0} max={100} value={p.goals.targetCqs ?? ''} onChange={(v) => set('goals', { targetCqs: num(v) })} />
            <NumberInput label="New leads per week" min={0} value={p.goals.leadsPerWeek ?? ''} onChange={(v) => set('goals', { leadsPerWeek: num(v) })} />
            <NumberInput label="Monthly call budget" min={0} value={p.goals.monthlyCallBudget ?? ''} onChange={(v) => set('goals', { monthlyCallBudget: num(v) })} />
          </SimpleGrid>
          <MultiSelect mt="sm" label="Focus personas" data={personas.map((x) => ({ value: x.id, label: `${x.id} ${x.name}` }))} value={p.goals.focusPersonas} onChange={(v) => set('goals', { focusPersonas: v })} />
          <MultiSelect mt="sm" label="Focus scenarios" data={scenarios.map((x) => ({ value: x.id, label: `${x.id} ${x.name}` }))} value={p.goals.focusScenarios} onChange={(v) => set('goals', { focusScenarios: v })} />
        </Card>

        <Card>
          <SectionTitle note="Campaigns only dial inside these hours, in the leads' business time zone.">Calling rules</SectionTitle>
          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            <TextInput label="Time zone" value={p.calling.timezone} onChange={(e) => set('calling', { timezone: e.currentTarget.value })} />
            <NumberInput label="From (hour)" min={0} max={23} value={p.calling.startHour} onChange={(v) => set('calling', { startHour: Number(v) })} />
            <NumberInput label="Until (hour)" min={1} max={24} value={p.calling.endHour} onChange={(v) => set('calling', { endHour: Number(v) })} />
          </SimpleGrid>
          <Text size="sm" fw={500} mt="sm" mb={4}>Days</Text>
          <Chip.Group multiple value={p.calling.days.map(String)} onChange={(v) => set('calling', { days: v.map(Number).sort() })}>
            <Group gap={6}>{DAYS.map((d, i) => <Chip key={d} value={String(i)} size="xs">{d}</Chip>)}</Group>
          </Chip.Group>
          <NumberInput mt="sm" label="Attempts per lead" min={1} max={20} w={180} value={p.calling.maxAttemptsPerLead} onChange={(v) => set('calling', { maxAttemptsPerLead: Number(v) })} />
          <Switch mt="md" label="Call leads with unknown consent" description="Off by default: leads from lead finders have no recorded consent. Turn on only where your local rules allow calling them."
            checked={p.calling.allowUnknownConsent} onChange={() => set('calling', { allowUnknownConsent: !p.calling.allowUnknownConsent })} />
        </Card>
      </SimpleGrid>

      <BusinessCopilot opened={copilot} onClose={() => setCopilot(false)} profile={p} llm={meta!.llm.enabled}
        onApplied={(saved, sections) => { setP((x) => (x ? { ...x, ...Object.fromEntries(sections.map((k) => [k, saved[k]])) } : x)); data.reload(); }} />
    </>
  );
}

function BusinessCopilot({ opened, onClose, profile, llm, onApplied }: {
  opened: boolean; onClose: () => void; profile: BusinessProfile; llm: boolean; onApplied: (saved: BusinessProfile, sections: BusinessSection[]) => void;
}) {
  const { go } = useStore();
  const [description, setDescription] = useState('');
  const [website, setWebsite] = useState('');
  const [sections, setSections] = useState<string[]>(SECTIONS.map((x) => x.key));
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<BusinessProposalDTO | null>(null);
  const [applied, setApplied] = useState<BusinessSection[]>([]);
  const [applying, setApplying] = useState<string | null>(null);
  const can = useCan();
  const allow = useAllow();
  useEffect(() => {
    if (!opened) return;
    if (!description) setDescription([profile.company.description, profile.company.offer].filter(Boolean).join('\n\n'));
    if (!website) setWebsite(profile.company.website);
  }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps

  const ask = () => {
    setBusy(true);
    setOut(null);
    setApplied([]);
    apiSend<BusinessProposalDTO>('POST', '/api/business/copilot', { description, ...(website.trim() ? { website: website.trim() } : {}), sections })
      .then(setOut)
      .catch((e) => notifications.show({ title: 'The co-pilot couldn’t draft the profile', message: errMsg(e), color: 'accent' }))
      .finally(() => setBusy(false));
  };
  const proposed = out ? SECTIONS.filter((x) => out.profile[x.key] !== undefined) : [];
  const apply = (keys: BusinessSection[]) => {
    if (!out || !keys.length) return;
    setApplying(keys.length > 1 ? 'all' : keys[0]);
    apiSend<BusinessProfile>('PUT', '/api/business', Object.fromEntries(keys.map((k) => [k, out.profile[k]])))
      .then((saved) => {
        setApplied((a) => Array.from(new Set([...a, ...keys])));
        onApplied(saved, keys);
        notifications.show({ title: 'Business setup updated', message: `${keys.map((k) => SECTIONS.find((x) => x.key === k)?.label).join(', ')} saved.`, color: 'ink' });
      })
      .catch((e) => notifications.show({ title: 'Couldn’t apply it', message: errMsg(e), color: 'accent' }))
      .finally(() => setApplying(null));
  };
  const remaining = proposed.map((x) => x.key).filter((k) => !applied.includes(k));

  return (
    <Drawer opened={opened} onClose={onClose} position="right" size="xl" title={<Group gap={8}><IconWand size={18} /><Text fw={650}>Business setup co-pilot</Text></Group>}>
      <Stack gap="md">
        {!llm && <Alert color="accent" variant="light" radius="md">{NO_CLAUDE_KEY}</Alert>}
        <Text size="sm" c="dimmed">Describe what you sell, to whom and where, and what a good week looks like. The co-pilot drafts the profile, the ideal customer profile in Apollo’s vocabulary, goals and calling rules. You apply each section yourself.</Text>
        <Textarea label="About the business" autosize minRows={5} maxRows={14} value={description} onChange={(e) => setDescription(e.currentTarget.value)}
          placeholder="We sell off-plan apartments in Dubai to overseas investors and work with UK brokers. The agent books online walkthroughs; we want 40 meetings a week." />
        <TextInput label="Website (optional)" description="Read with Claude’s web fetch, limited to this site" placeholder="https://example.com" value={website} onChange={(e) => setWebsite(e.currentTarget.value)} />
        <div>
          <Text size="sm" fw={500} mb={4}>Draft</Text>
          <Chip.Group multiple value={sections} onChange={setSections}>
            <Group gap={6}>{SECTIONS.map((x) => <Chip key={x.key} value={x.key} size="xs">{x.label}</Chip>)}</Group>
          </Chip.Group>
        </div>
        <Group><NeedsTip perm={['copilot:use', 'business:manage']} feature="copilot"><Button leftSection={<IconWand size={16} />} loading={busy} disabled={!llm || busy || (!description.trim() && !website.trim()) || !sections.length || !allow(['copilot:use', 'business:manage'], 'copilot')} onClick={ask}>Draft the profile</Button></NeedsTip></Group>
        {busy && <CopilotWorking label={website.trim() ? 'Reading the website and drafting the profile…' : 'Drafting the profile…'} />}

        {out && (
          <>
            <Group justify="space-between">
              <Text size="sm" c="dimmed">{out.websiteRead ? `Read ${website.trim()}.` : website.trim() ? 'Couldn’t read the website; drafted from the description only.' : 'Drafted from the description.'}</Text>
              {remaining.length > 1 && <Button size="xs" loading={applying === 'all'} disabled={!can('business:manage')} onClick={() => apply(remaining)}>Apply all</Button>}
            </Group>
            {proposed.length === 0 && <Text size="sm" c="dimmed">No changes proposed.</Text>}
            {proposed.map((sec) => {
              const changes = out.changes.filter((c) => c.section === sec.key);
              const done = applied.includes(sec.key);
              return (
                <Card key={sec.key} withBorder padding="md">
                  <Group justify="space-between" mb="xs">
                    <Text fw={650}>{sec.label}</Text>
                    {done ? <Badge tt="none" variant="light" color="ink" leftSection={<IconCheck size={12} />}>Applied</Badge>
                      : <Button size="xs" loading={applying === sec.key} disabled={!!applying || !can('business:manage')} onClick={() => apply([sec.key])}>Apply</Button>}
                  </Group>
                  {changes.length === 0 ? <Text size="sm" c="dimmed">Same as the current profile.</Text> : (
                    <Table fz="sm" verticalSpacing={4} highlightOnHover={false}>
                      <Table.Thead><Table.Tr><Table.Th w="26%">Field</Table.Th><Table.Th>Now</Table.Th><Table.Th>Proposed</Table.Th></Table.Tr></Table.Thead>
                      <Table.Tbody>{changes.map((c) => (
                        <Table.Tr key={c.field}>
                          <Table.Td><Text size="sm" fw={500}>{FIELD_LABELS[c.field] ?? c.field}</Text></Table.Td>
                          <Table.Td><Text size="sm" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>{fmtValue(c.field, c.from)}</Text></Table.Td>
                          <Table.Td><Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{fmtValue(c.field, c.to)}</Text></Table.Td>
                        </Table.Tr>
                      ))}</Table.Tbody>
                    </Table>
                  )}
                </Card>
              );
            })}
            {out.assumptions.length > 0 && (
              <div>
                <Text size="sm" fw={600} mb={4}>Assumptions</Text>
                <List size="sm" spacing={4}>{out.assumptions.map((a) => <List.Item key={a}>{a}</List.Item>)}</List>
              </div>
            )}
            <CopilotQuestions questions={out.questions} />
            <CopilotUsageLine usage={out.usage} />
            {applied.length > 0 && (
              <Alert color="gray" variant="light" radius="md" title="Next">
                <Text size="sm">With the profile in place, the co-pilot can <Anchor component="button" size="sm" onClick={() => { onClose(); go('taxonomy', { copilot: 'draft' }); }}>draft the taxonomy</Anchor> (personas and scenarios) and <Anchor component="button" size="sm" onClick={() => { onClose(); go('funnels'); }}>design the lead funnels</Anchor>.</Text>
              </Alert>
            )}
          </>
        )}
      </Stack>
    </Drawer>
  );
}
