import { ReactNode, useEffect, useState } from 'react';
import { ActionIcon, Alert, AppShell, Badge, Burger, Button, Group, Menu, NavLink, ScrollArea, Stack, Text, Tooltip, useComputedColorScheme, useMantineColorScheme } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconAlertTriangle, IconLayoutGrid, IconPhoneCall, IconGitCompare, IconActivityHeartbeat, IconWaveSine,
  IconChartFunnel, IconTarget, IconTags, IconBell, IconCalculator, IconSun, IconMoon, IconBulb, IconChecklist, IconPlugConnected,
  IconBuildingStore, IconAddressBook, IconPhoneOutgoing, IconSparkles, IconFilter, IconUsers, IconUserCircle, IconLogout, IconKey, IconChevronDown,
  IconCreditCard, IconShieldCheck, IconListCheck, IconClock,
} from '@tabler/icons-react';
import type { WorkspaceDTO } from '@calleval/framework';
import { PageKey, useStore } from '../store';
import { OpenModeBanner, useAuth } from '../auth';
import { apiGet, PAYMENT_REQUIRED_EVENT } from '../api';
import { notifications } from '@mantine/notifications';
import { AccountDrawer } from './Account';
import { SetupDrawer } from './Setup';
import { PAGE_PERMISSION, ROLE_LABEL, useCan } from './access';
import { PLAN_LABEL } from './plan';

const NAV: { group: string; items: { key: PageKey; label: string; icon: any }[] }[] = [
  { group: 'Overview', items: [{ key: 'attention', label: 'Needs attention', icon: IconAlertTriangle }] },
  { group: 'Improve', items: [
    { key: 'recommendations', label: 'Recommendations', icon: IconBulb },
    { key: 'improvement', label: 'Self-improvement', icon: IconSparkles },
    { key: 'fix', label: 'Where to fix first', icon: IconTarget },
  ] },
  { group: 'AI team', items: [
    { key: 'matrix', label: 'Quality matrix', icon: IconLayoutGrid },
    { key: 'calls', label: 'Call drill-down', icon: IconPhoneCall },
    { key: 'version', label: 'Version report', icon: IconGitCompare },
    { key: 'traces', label: 'Traces', icon: IconActivityHeartbeat },
  ] },
  { group: 'Shared with sales', items: [
    { key: 'funnel', label: 'Funnel by persona', icon: IconChartFunnel },
  ] },
  { group: 'Grow', items: [
    { key: 'business', label: 'Business setup', icon: IconBuildingStore },
    { key: 'leads', label: 'Leads', icon: IconAddressBook },
    { key: 'funnels', label: 'Funnels', icon: IconFilter },
    { key: 'campaigns', label: 'Campaigns', icon: IconPhoneOutgoing },
  ] },
  { group: 'Governance', items: [
    { key: 'review', label: 'Review queue', icon: IconChecklist },
    { key: 'taxonomy', label: 'Taxonomy', icon: IconTags },
    { key: 'alerts', label: 'Alerts', icon: IconBell },
    { key: 'scoring', label: 'Scoring model', icon: IconCalculator },
    { key: 'compliance', label: 'Calling compliance', icon: IconShieldCheck },
    { key: 'access', label: 'Users and access', icon: IconUsers },
  ] },
  { group: 'Data', items: [
    { key: 'integrations', label: 'Integrations', icon: IconPlugConnected },
    { key: 'audio', label: 'Audio logs', icon: IconWaveSine },
  ] },
  { group: 'Account', items: [
    { key: 'billing', label: 'Billing', icon: IconCreditCard },
  ] },
];

/** Follow the viewer's explicit theme choice (data-theme on the root) when the host sets one. */
function useHostTheme() {
  const { setColorScheme } = useMantineColorScheme();
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const t = root.getAttribute('data-theme');
      if (t === 'dark' || t === 'light') setColorScheme(t);
    };
    apply();
    const mo = new MutationObserver(apply);
    mo.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, [setColorScheme]);
}

export function Shell({ children }: { children: ReactNode }) {
  const [opened, { toggle, close }] = useDisclosure();
  const { page, go, openAlerts, openAttention, meta, reloadMeta } = useStore();
  const can = useCan();
  const [account, setAccount] = useState(false);
  const [setup, setSetup] = useState(false);
  const ws = meta?.me?.workspace ?? null;
  // The plan or credit refused something: point to Billing (the page that asked shows the API's own message).
  const canBill = can('settings:manage');
  useEffect(() => {
    const on = () => notifications.show({
      id: 'payment-required', color: 'accent', title: 'Needs a plan change or credit',
      message: canBill
        ? <Button size="compact-xs" variant="default" mt={4} onClick={() => { notifications.hide('payment-required'); go('billing'); }}>Open billing</Button>
        : 'Ask an admin to change the plan or add credit.',
    });
    window.addEventListener(PAYMENT_REQUIRED_EVENT, on);
    return () => window.removeEventListener(PAYMENT_REQUIRED_EVENT, on);
  }, [canBill, go]);
  const mode = meta?.dataMode === 'live' ? { label: 'Live data', tip: 'Calls pulled from your connected voice platforms', variant: 'filled' as const }
    : meta?.dataMode === 'demo' ? { label: 'Demo data', tip: 'Synthetic calls generated by the demo loader, scored by the real pipeline', variant: 'outline' as const }
    : meta ? { label: 'No data yet', tip: 'Connect ElevenLabs or Retell AI under Integrations, or load demo data', variant: 'outline' as const }
    : { label: 'Connecting…', tip: 'Loading from the API', variant: 'outline' as const };
  const judge = meta ? (meta.llm.enabled ? `Judge · ${meta.llm.model ?? 'Claude'}` : 'Heuristic judge') : null;
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme('light', { getInitialValueInEffect: false });
  useHostTheme();

  return (
    <AppShell header={{ height: 60 }} navbar={{ width: 250, breakpoint: 'sm', collapsed: { mobile: !opened } }} padding="md">
      <AppShell.Header px="md">
        <Group h="100%" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="Toggle navigation" />
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Group gap={8} wrap="nowrap">
                <Text fw={700} fz={16} lh={1.2}>Call Evaluation</Text>
                {ws && <Text fz={14} c="dimmed" lh={1.2} truncate maw={220} visibleFrom="xs">· {ws.name}</Text>}
                {ws?.billing && <Badge size="sm" variant="outline" color="ink" tt="none" visibleFrom="sm" style={{ cursor: can('settings:manage') ? 'pointer' : undefined }} onClick={() => { if (can('settings:manage')) go('billing'); }}>{ws.status === 'trial' ? `${PLAN_LABEL[ws.plan]} trial` : PLAN_LABEL[ws.plan]}</Badge>}
              </Group>
              <Text fz={12} c="dimmed" lh={1.2} visibleFrom="xs">Sales voice agent · Framework {meta?.frameworkVersion ?? 'v1'} · Taxonomy v{meta?.taxonomyVersion ?? '1.0'}</Text>
            </Stack>
          </Group>
          <Group gap="sm" wrap="nowrap">
            {judge && (
              <Tooltip label={meta?.llm.enabled ? 'Judged metrics and tags are scored by Claude with one rubric per metric' : 'No ANTHROPIC_API_KEY on the API: judged metrics use transcript heuristics'}>
                <Badge variant="light" color="gray" size="lg" tt="none" fw={500} visibleFrom="md">{judge}</Badge>
              </Tooltip>
            )}
            <Tooltip label={mode.tip}>
              <Badge variant={mode.variant} color="ink" size="lg" style={{ cursor: meta?.dataMode === 'empty' ? 'pointer' : undefined }} onClick={() => { if (meta?.dataMode === 'empty') go('integrations'); }}>{mode.label}</Badge>
            </Tooltip>
            <ActionIcon size="lg" variant="default" aria-label="Toggle colour scheme" onClick={() => setColorScheme(scheme === 'dark' ? 'light' : 'dark')}>
              {scheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
            </ActionIcon>
            <UserMenu onAccount={() => setAccount(true)} onSetup={() => setSetup(true)} />
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm">
        <ScrollArea type="never">
          <Stack gap="md">
            {NAV.filter((g) => g.items.some((it) => can(PAGE_PERMISSION[it.key]))).map((g) => (
              <Stack key={g.group} gap={2}>
                <Text size="xs" fw={600} tt="uppercase" c="dimmed" px="sm" pb={4} style={{ letterSpacing: '0.08em' }}>{g.group}</Text>
                {g.items.filter((it) => can(PAGE_PERMISSION[it.key])).map((it) => {
                  const badge = it.key === 'alerts' && openAlerts ? openAlerts : it.key === 'attention' && openAttention ? openAttention : 0;
                  return (
                    <NavLink
                      key={it.key}
                      label={it.label}
                      active={page === it.key}
                      onClick={() => { go(it.key); close(); }}
                      leftSection={<it.icon size={18} stroke={1.7} />}
                      rightSection={badge ? <Badge size="sm" color="accent" variant="filled" circle={badge < 10}>{badge}</Badge> : null}
                      variant="filled"
                      style={{ borderRadius: 999 }}
                      aria-current={page === it.key ? 'page' : undefined}
                    />
                  );
                })}
              </Stack>
            ))}
          </Stack>
        </ScrollArea>
      </AppShell.Navbar>

      <AppShell.Main>
        <div style={{ maxWidth: 1400, marginInline: 'auto', paddingBottom: 48 }}>
          <OpenModeBanner onCreated={reloadMeta} />
          {ws?.billing && ws.status === 'trial' && <TrialBanner />}
          {ws?.status === 'past_due' && can('settings:manage') && (
            <Alert color="accent" variant="light" radius="md" mb="md" icon={<IconCreditCard size={18} />}>
              <Group justify="space-between" gap="sm"><Text size="sm">The last payment didn’t go through. Update the card to keep scoring calls.</Text><Button size="xs" onClick={() => go('billing')}>Open billing</Button></Group>
            </Alert>
          )}
          {children}
        </div>
      </AppShell.Main>
      <AccountDrawer opened={account} onClose={() => setAccount(false)} />
      <SetupDrawer opened={setup} onClose={() => setSetup(false)} />
    </AppShell>
  );
}

/** Days left in the trial, with the way to choose a plan for those who can. */
function TrialBanner() {
  const { go } = useStore();
  const can = useCan();
  const [ws, setWs] = useState<WorkspaceDTO | null>(null);
  useEffect(() => { apiGet<WorkspaceDTO>('/api/workspace').then(setWs).catch(() => { /* banner only */ }); }, []);
  if (!ws?.trialEndsAt) return null;
  const days = Math.max(0, Math.ceil((new Date(ws.trialEndsAt).getTime() - Date.now()) / 86_400_000));
  return (
    <Group justify="space-between" gap="sm" mb="md" px="md" py={8} wrap="wrap" style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 12 }}>
      <Group gap={8} wrap="nowrap"><IconClock size={16} /><Text size="sm">{days === 0 ? 'Your trial ends today.' : `Trial ends in ${days} day${days === 1 ? '' : 's'}.`}</Text></Group>
      {can('settings:manage') && <Button size="xs" variant="default" onClick={() => go('billing')}>Choose a plan</Button>}
    </Group>
  );
}

/** Who is signed in, their account, the setup checklist, and signing out. API-token sessions can only forget the token on this browser. */
function UserMenu({ onAccount, onSetup }: { onAccount: () => void; onSetup: () => void }) {
  const { me, signOut, refresh } = useAuth();
  if (!me || me.via === 'open') return null;
  const viaToken = me.via === 'token' || me.via === 'env';
  const forgetToken = () => {
    try { window.localStorage.removeItem('calleval.token'); } catch { /* storage blocked */ }
    refresh();
  };
  return (
    <Menu position="bottom-end" width={240} shadow="md">
      <Menu.Target>
        <Button variant="default" size="sm" leftSection={viaToken ? <IconKey size={16} /> : <IconUserCircle size={16} />} rightSection={<IconChevronDown size={14} />} aria-label="Your account">
          <Text size="sm" truncate maw={140} visibleFrom="sm">{viaToken ? 'API token' : me.name || me.email}</Text>
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>
          <Stack gap={2}>
            <Text size="sm" fw={600} c="var(--mantine-color-text)" truncate>{viaToken ? (me.via === 'env' ? 'The server’s API token' : 'An API token') : me.name}</Text>
            {me.email && <Text size="xs" c="dimmed" truncate>{me.email}</Text>}
            <Badge size="sm" variant="filled" color="ink" tt="none" w="fit-content">{ROLE_LABEL[me.role] ?? me.role}</Badge>
          </Stack>
        </Menu.Label>
        <Menu.Divider />
        {viaToken ? (
          <Menu.Item leftSection={<IconLogout size={16} />} onClick={forgetToken}>Forget the token on this browser</Menu.Item>
        ) : (
          <>
            <Menu.Item leftSection={<IconUserCircle size={16} />} onClick={onAccount}>Your account</Menu.Item>
            <Menu.Item leftSection={<IconListCheck size={16} />} onClick={onSetup}>Setup checklist</Menu.Item>
            <Menu.Item leftSection={<IconLogout size={16} />} onClick={() => { signOut(); }}>Sign out</Menu.Item>
          </>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
