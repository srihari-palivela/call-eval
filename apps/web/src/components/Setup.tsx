// The setup checklist: the steps from sign-up to a first campaign, with the co-pilot where it helps. A card on
// Needs attention until the required steps are done (or it is hidden), and the full list from the user menu.
import { useCallback, useEffect, useState } from 'react';
import { Badge, Box, Button, Card, Drawer, Group, Progress, Stack, Text, ThemeIcon } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconLock, IconWand } from '@tabler/icons-react';
import type { SetupDTO, SetupStepDTO } from '@calleval/framework';
import { apiGet, apiSend, errMsg } from '../api';
import { PageKey, PAGE_KEYS, useStore } from '../store';
import { PLAN_LABEL } from './plan';
import { usePal } from '../theme';

const SETUP_EVENT = 'calleval:setup';

/** The checklist, kept in step between the card and the drawer. */
function useSetup(active = true) {
  const [data, setData] = useState<SetupDTO | null>(null);
  const load = useCallback(() => {
    apiGet<SetupDTO>('/api/setup').then(setData).catch(() => setData(null));
  }, []);
  useEffect(() => {
    if (!active) return;
    load();
    window.addEventListener(SETUP_EVENT, load);
    return () => window.removeEventListener(SETUP_EVENT, load);
  }, [active, load]);
  const dismiss = (dismissed: boolean) => apiSend<SetupDTO>('POST', '/api/setup/dismiss', { dismissed })
    .then((d) => { setData(d); try { window.dispatchEvent(new Event(SETUP_EVENT)); } catch { /* no window */ } })
    .catch((e) => notifications.show({ title: 'Couldn’t update the checklist', message: errMsg(e), color: 'accent' }));
  return { data, dismiss, reload: load };
}

const requiredDone = (d: SetupDTO) => d.steps.filter((s) => !s.optional).every((s) => s.done);

function StepRow({ step, n, onGo }: { step: SetupStepDTO; n: number; onGo: () => void }) {
  const p = usePal();
  return (
    <Group gap="sm" wrap="nowrap" align="flex-start" py={8} style={{ borderBottom: `1px solid ${p.line}` }}>
      <ThemeIcon size={24} radius="xl" variant={step.done ? 'filled' : 'light'} color="ink" style={{ flex: 'none' }} aria-label={step.done ? 'Done' : `Step ${n}`}>
        {step.done ? <IconCheck size={14} /> : <Text fz={11} fw={600}>{n}</Text>}
      </ThemeIcon>
      <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
        <Group gap={6} wrap="wrap">
          <Text size="sm" fw={600} td={step.done ? 'line-through' : undefined} c={step.done ? 'dimmed' : undefined}>{step.title}</Text>
          {step.copilot && <Badge size="xs" variant="light" color="ink" tt="none" leftSection={<IconWand size={10} />}>Co-pilot</Badge>}
          {step.optional && <Badge size="xs" variant="outline" color="gray" tt="none">Optional</Badge>}
        </Group>
        <Text size="xs" c="dimmed">{step.detail}</Text>
      </Stack>
      {!step.available ? (
        <Group gap={4} wrap="nowrap" style={{ flex: 'none' }}>
          <IconLock size={14} />
          <Text size="xs" c="dimmed">{step.upgrade ? `Upgrade to ${PLAN_LABEL[step.upgrade]}` : 'Not in your plan'}</Text>
        </Group>
      ) : !step.done && (
        <Button size="xs" variant="default" onClick={onGo} style={{ flex: 'none' }}>Go</Button>
      )}
    </Group>
  );
}

function StepList({ data, onGo }: { data: SetupDTO; onGo: (s: SetupStepDTO) => void }) {
  return <Box>{data.steps.map((s, i) => <StepRow key={s.id} step={s} n={i + 1} onGo={() => onGo(s)} />)}</Box>;
}

function useOpenStep(after?: () => void) {
  const { go } = useStore();
  return (s: SetupStepDTO) => {
    const page = (PAGE_KEYS as string[]).includes(s.page) ? (s.page as PageKey) : 'attention';
    go(page, s.params ?? {});
    after?.();
  };
}

/** On Needs attention: the checklist until the required steps are done, unless hidden. */
export function GettingStartedCard() {
  const { data, dismiss } = useSetup();
  const open = useOpenStep();
  if (!data || data.dismissed || !data.steps.length || requiredDone(data)) return null;
  const next = data.steps.find((s) => !s.done && s.available && !s.optional);
  return (
    <Card mb="lg">
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm" mb="xs">
        <Stack gap={2}>
          <Text fw={650} fz={17}>Getting started</Text>
          <Text size="sm" c="dimmed">{data.done} of {data.total} steps done{next ? ` · next: ${next.title.toLowerCase()}` : ''}. The co-pilot drafts where it can; nothing applies until you confirm it.</Text>
        </Stack>
        <Group gap="xs">
          {next && <Button size="xs" onClick={() => open(next)}>Continue</Button>}
          <Button size="xs" variant="subtle" onClick={() => dismiss(true)}>Hide</Button>
        </Group>
      </Group>
      <Progress value={data.total ? (data.done / data.total) * 100 : 0} color="ink" size="sm" mb="sm" aria-label={`${data.done} of ${data.total} setup steps done`} />
      <StepList data={data} onGo={open} />
    </Card>
  );
}

/** From the user menu: the whole checklist, and bringing the card back. */
export function SetupDrawer({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { data, dismiss } = useSetup(opened);
  const open = useOpenStep(onClose);
  return (
    <Drawer opened={opened} onClose={onClose} position="right" size="md" title={<Text fw={650}>Setup checklist</Text>}>
      {!data ? <Text size="sm" c="dimmed">The checklist isn’t available.</Text> : (
        <Stack gap="sm">
          <Text size="sm" c="dimmed">{data.done} of {data.total} steps done.</Text>
          <Progress value={data.total ? (data.done / data.total) * 100 : 0} color="ink" size="sm" />
          <StepList data={data} onGo={open} />
          {data.dismissed && !requiredDone(data) && (
            <Group><Button size="xs" variant="default" onClick={() => dismiss(false)}>Show it on Needs attention</Button></Group>
          )}
        </Stack>
      )}
    </Drawer>
  );
}
