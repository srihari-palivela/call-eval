// "Your account": name, password, and personal API tokens (shown once when created, revocable).
import { useEffect, useState } from 'react';
import { ActionIcon, Alert, Badge, Button, Code, CopyButton, Divider, Drawer, Group, PasswordInput, Select, Stack, Table, Text, TextInput, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconCopy, IconKey, IconTrash } from '@tabler/icons-react';
import type { ApiTokenDTO, MeDTO, Role, RoleDTO } from '@calleval/framework';
import { apiGet, apiSend, errMsg, useApi } from '../api';
import { useAuth } from '../auth';
import { Mono, SectionTitle, fmtWhen } from './ui';
import { NeedsTip, ROLE_LABEL } from './access';
import { usePlan } from './plan';

const EXPIRY = [{ value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: '365', label: 'A year' }, { value: 'never', label: 'Never' }];

export function AccountDrawer({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { me } = useAuth();
  return (
    <Drawer opened={opened} onClose={onClose} position="right" size="lg" title={<Text fw={650}>Your account</Text>}>
      {me && me.id ? <AccountBody me={me} /> : (
        <Text size="sm" c="dimmed">
          {me?.via === 'open' ? 'No accounts exist yet. Create the first owner from the banner at the top of the page.' : 'You’re using an API token, so there’s no account to edit here.'}
        </Text>
      )}
    </Drawer>
  );
}

function AccountBody({ me }: { me: MeDTO }) {
  const { refresh } = useAuth();
  const [name, setName] = useState(me.name);
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [busy, setBusy] = useState<string | null>(null);

  const saveName = () => {
    setBusy('name');
    apiSend<MeDTO>('PUT', '/api/auth/me', { name: name.trim() })
      .then(() => { notifications.show({ title: 'Name saved', message: 'Reviews and changes you make show this name.', color: 'ink' }); return refresh(); })
      .catch((e) => notifications.show({ title: 'Couldn’t save your name', message: errMsg(e), color: 'accent' }))
      .finally(() => setBusy(null));
  };
  const changePassword = () => {
    if (pw.next.length < 12) { notifications.show({ title: 'Password too short', message: 'Use at least 12 characters.', color: 'accent' }); return; }
    if (pw.next !== pw.confirm) { notifications.show({ title: 'The passwords don’t match', message: 'Type the new password the same way twice.', color: 'accent' }); return; }
    setBusy('password');
    apiSend<MeDTO>('PUT', '/api/auth/me', { currentPassword: pw.current, newPassword: pw.next })
      .then(() => { setPw({ current: '', next: '', confirm: '' }); notifications.show({ title: 'Password changed', message: 'Your other sessions were signed out.', color: 'ink' }); })
      .catch((e) => notifications.show({ title: 'Couldn’t change the password', message: errMsg(e), color: 'accent' }))
      .finally(() => setBusy(null));
  };

  return (
    <Stack gap="lg">
      <Group gap="xs">
        <Text size="sm">{me.email}</Text>
        <Badge variant="filled" color="ink" tt="none">{ROLE_LABEL[me.role] ?? me.role}</Badge>
      </Group>
      <Stack gap="xs">
        <SectionTitle>Profile</SectionTitle>
        <Group align="flex-end" wrap="nowrap">
          <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} style={{ flex: 1 }} />
          <Button variant="default" loading={busy === 'name'} disabled={!name.trim() || name.trim() === me.name} onClick={saveName}>Save</Button>
        </Group>
      </Stack>
      <Divider />
      <Stack gap="xs">
        <SectionTitle note="Changing it signs you out everywhere else.">Password</SectionTitle>
        <PasswordInput label="Current password" autoComplete="current-password" value={pw.current} onChange={(e) => { const v = e.currentTarget.value; setPw((x) => ({ ...x, current: v })); }} />
        <PasswordInput label="New password" description="At least 12 characters." autoComplete="new-password" value={pw.next} onChange={(e) => { const v = e.currentTarget.value; setPw((x) => ({ ...x, next: v })); }} />
        <PasswordInput label="Confirm new password" autoComplete="new-password" value={pw.confirm} onChange={(e) => { const v = e.currentTarget.value; setPw((x) => ({ ...x, confirm: v })); }} />
        <Group><Button variant="default" loading={busy === 'password'} disabled={!pw.current || !pw.next} onClick={changePassword}>Change password</Button></Group>
      </Stack>
      <Divider />
      <Tokens me={me} />
    </Stack>
  );
}

function Tokens({ me }: { me: MeDTO }) {
  const list = useApi<ApiTokenDTO[]>('/api/auth/tokens');
  const { has } = usePlan();
  // Roles a token may have: those within mine, as the API lists them.
  const [roles, setRoles] = useState<{ value: Role; label: string }[]>([{ value: me.role, label: ROLE_LABEL[me.role] ?? me.role }]);
  useEffect(() => {
    apiGet<RoleDTO[]>('/api/auth/roles').then((rs) => {
      if (rs.length) setRoles(rs.map((r) => ({ value: r.id, label: r.name })));
    }).catch(() => { /* keep my own role */ });
  }, [me.role]);
  const [f, setF] = useState<{ name: string; role: Role; expiry: string }>({ name: '', role: me.role, expiry: '90' });
  const [created, setCreated] = useState<ApiTokenDTO | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const create = () => {
    setBusy('create');
    apiSend<ApiTokenDTO>('POST', '/api/auth/tokens', { name: f.name.trim(), role: f.role, expiresDays: f.expiry === 'never' ? null : Number(f.expiry) })
      .then((t) => { setCreated(t); setF((x) => ({ ...x, name: '' })); list.reload(); })
      .catch((e) => notifications.show({ title: 'Couldn’t create the token', message: errMsg(e), color: 'accent' }))
      .finally(() => setBusy(null));
  };
  const revoke = (t: ApiTokenDTO) => {
    if (!window.confirm(`Revoke “${t.name}”? Anything using it stops working at once.`)) return;
    setBusy(t.id);
    apiSend('DELETE', `/api/auth/tokens/${encodeURIComponent(t.id)}`)
      .then(() => { if (created?.id === t.id) setCreated(null); list.reload(); })
      .catch((e) => notifications.show({ title: 'Couldn’t revoke the token', message: errMsg(e), color: 'accent' }))
      .finally(() => setBusy(null));
  };

  return (
    <Stack gap="xs">
      <SectionTitle note="For scripts and integrations: send it as Authorization: Bearer <token>. A token can do what its role allows, never more than yours.">API tokens</SectionTitle>
      {created?.token && (
        <Alert color="ink" variant="light" radius="md" icon={<IconKey size={18} />} title="Copy it now: you won’t see it again">
          <Group gap="xs" wrap="nowrap">
            <Code style={{ flex: 1, overflowWrap: 'anywhere' }}>{created.token}</Code>
            <CopyButton value={created.token}>
              {({ copied, copy }) => <Tooltip label={copied ? 'Copied' : 'Copy'}><ActionIcon variant="default" onClick={copy} aria-label="Copy the token">{copied ? <IconCheck size={16} /> : <IconCopy size={16} />}</ActionIcon></Tooltip>}
            </CopyButton>
          </Group>
        </Alert>
      )}
      <Group align="flex-end" wrap="wrap" gap="sm">
        <TextInput label="Name" placeholder="CI export" value={f.name} onChange={(e) => { const v = e.currentTarget.value; setF((x) => ({ ...x, name: v })); }} style={{ flex: 1, minWidth: 160 }} />
        <Select label="Role" data={roles} value={f.role} onChange={(v) => v && setF((x) => ({ ...x, role: v as Role }))} w={160} disabled={roles.length < 2} />
        <Select label="Expires" data={EXPIRY} value={f.expiry} onChange={(v) => v && setF((x) => ({ ...x, expiry: v }))} w={120} />
        <NeedsTip perm={[]} feature="api_tokens"><Button loading={busy === 'create'} disabled={!f.name.trim() || !has('api_tokens')} onClick={create}>Create token</Button></NeedsTip>
      </Group>
      {list.error && <Text size="sm" c="accent.7">{list.error}</Text>}
      {list.data && list.data.length === 0 && <Text size="sm" c="dimmed">No tokens yet.</Text>}
      {list.data && list.data.length > 0 && (
        <Table.ScrollContainer minWidth={520}>
          <Table>
            <Table.Thead><Table.Tr><Table.Th>Name</Table.Th><Table.Th>Role</Table.Th><Table.Th>Last used</Table.Th><Table.Th>Expires</Table.Th><Table.Th w={40} /></Table.Tr></Table.Thead>
            <Table.Tbody>
              {list.data.map((t) => (
                <Table.Tr key={t.id}>
                  <Table.Td><Text size="sm" fw={600}>{t.name}</Text><Mono size="xs" c="dimmed">{t.prefix}…</Mono></Table.Td>
                  <Table.Td><Text size="sm">{ROLE_LABEL[t.role] ?? t.role}</Text></Table.Td>
                  <Table.Td><Text size="sm" c="dimmed">{t.lastUsedAt ? fmtWhen(t.lastUsedAt) : 'Never'}</Text></Table.Td>
                  <Table.Td><Text size="sm" c="dimmed">{t.expiresAt ? fmtWhen(t.expiresAt) : 'Never'}</Text></Table.Td>
                  <Table.Td>
                    <Tooltip label="Revoke"><ActionIcon color="accent" loading={busy === t.id} onClick={() => revoke(t)} aria-label={`Revoke ${t.name}`}><IconTrash size={16} /></ActionIcon></Tooltip>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Stack>
  );
}
