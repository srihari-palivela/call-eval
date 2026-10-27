import { useState } from 'react';
import { ActionIcon, Alert, Badge, Box, Button, Code, CopyButton, Group, Menu, Select, Stack, Switch, Table, Tabs, Text, TextInput, Tooltip, Card } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconCopy, IconDots, IconKey, IconLink, IconLogout, IconTrash, IconUserPlus } from '@tabler/icons-react';
import type { AccessDTO, ApiTokenDTO, AuditEventDTO, InviteDTO, Role, RoleDTO, UserDTO, WorkspaceDTO } from '@calleval/framework';
import { usePal } from '../theme';
import { apiSend, errMsg, qs, useApi } from '../api';
import { ErrorState, Loading, Mono, PageHeader, SectionTitle, fmtWhen } from '../components/ui';
import { ROLE_LABEL, useCan } from '../components/access';
import { useMeta, useStore } from '../store';
import { PLAN_LABEL } from '../components/plan';

const failed = (title: string) => (e: unknown) => notifications.show({ title, message: errMsg(e), color: 'accent' });

/** Roles I may grant: their permissions are within mine, and only an owner makes owners. */
function grantable(roles: RoleDTO[], mine: string[], myRole: Role): RoleDTO[] {
  return roles.filter((r) => r.permissions.every((p) => mine.includes(p)) && (r.id !== 'owner' || myRole === 'owner'));
}

export function AccessPage() {
  const meta = useMeta();
  const can = useCan();
  const [tab, setTab] = useState<string | null>('users');
  const a = useApi<AccessDTO>('/api/access');

  const header = (
    <PageHeader
      eyebrow="Governance · Admins"
      title="Users and access"
      description="Who can sign in and what each role may do. Invitations and password resets are links you send yourself; API tokens act with a role of their own, never more than their creator’s."
    />
  );
  if (a.error && !a.data) return <>{header}<ErrorState error={a.error} onRetry={a.reload} /></>;
  if (!a.data) return <>{header}<Loading /></>;
  const d = a.data;
  const roles = grantable(d.roles, meta.me.permissions, meta.me.role);

  return (
    <>
      {header}
      <WorkspaceCard />
      <Tabs value={tab} onChange={setTab}>
        <Tabs.List mb="md">
          <Tabs.Tab value="users">Users · {d.users.length}</Tabs.Tab>
          <Tabs.Tab value="invites">Invites · {d.invites.length}</Tabs.Tab>
          <Tabs.Tab value="tokens">API tokens · {d.tokens.length}</Tabs.Tab>
          {can('audit:read') && <Tabs.Tab value="audit">Audit log</Tabs.Tab>}
          <Tabs.Tab value="roles">Roles</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="users"><Users users={d.users} roles={roles} reload={a.reload} /></Tabs.Panel>
        <Tabs.Panel value="invites"><Invites invites={d.invites} roles={roles} reload={a.reload} /></Tabs.Panel>
        <Tabs.Panel value="tokens"><Tokens tokens={d.tokens} reload={a.reload} /></Tabs.Panel>
        {can('audit:read') && <Tabs.Panel value="audit">{tab === 'audit' && <Audit />}</Tabs.Panel>}
        <Tabs.Panel value="roles"><Roles d={d} /></Tabs.Panel>
      </Tabs>
    </>
  );
}

/** The workspace (company) these users belong to: its name, plan and size. */
function WorkspaceCard() {
  const can = useCan();
  const { go, reloadMeta } = useStore();
  const w = useApi<WorkspaceDTO>('/api/workspace');
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!w.data) return null;
  const ws = w.data;
  const save = () => {
    if (!name?.trim()) return;
    setBusy(true);
    apiSend<WorkspaceDTO>('PATCH', '/api/workspace', { name: name.trim() })
      .then((x) => { w.setData(x); setName(null); reloadMeta(); notifications.show({ title: 'Workspace renamed', message: x.name, color: 'ink' }); })
      .catch(failed('Couldn’t rename the workspace'))
      .finally(() => setBusy(false));
  };
  return (
    <Card mb="lg">
      <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
        <Group gap="xl" align="flex-end" wrap="wrap">
          {name === null ? (
            <Stack gap={2}>
              <Text size="xs" c="dimmed">Workspace</Text>
              <Group gap="xs"><Text fw={650}>{ws.name}</Text>{can('users:manage') && <Button size="compact-xs" variant="subtle" onClick={() => setName(ws.name)}>Rename</Button>}</Group>
            </Stack>
          ) : (
            <Group gap="xs" align="flex-end">
              <TextInput label="Workspace name" value={name} onChange={(e) => setName(e.currentTarget.value)} w={260} autoFocus />
              <Button size="xs" loading={busy} disabled={!name.trim() || name.trim() === ws.name} onClick={save}>Save</Button>
              <Button size="xs" variant="subtle" onClick={() => setName(null)}>Cancel</Button>
            </Group>
          )}
          {ws.billing && <Stack gap={2}><Text size="xs" c="dimmed">Plan</Text><Text size="sm">{PLAN_LABEL[ws.plan]}{ws.status === 'trial' && ws.trialEndsAt ? ` trial, until ${fmtWhen(ws.trialEndsAt)}` : ws.status === 'past_due' ? ', payment failed' : ws.status === 'cancelled' ? ', cancelled' : ''}</Text></Stack>}
          <Stack gap={2}><Text size="xs" c="dimmed">Members</Text><Text size="sm">{ws.members}</Text></Stack>
          <Stack gap={2}><Text size="xs" c="dimmed">Created</Text><Text size="sm">{fmtWhen(ws.createdAt)}</Text></Stack>
        </Group>
        {ws.billing && can('settings:manage') && <Button size="xs" variant="default" onClick={() => go('billing')}>Billing</Button>}
      </Group>
    </Card>
  );
}

function LinkCard({ invite, onClose }: { invite: InviteDTO; onClose: () => void }) {
  if (!invite.url) return null;
  return (
    <Alert color="ink" variant="light" radius="md" icon={<IconLink size={18} />} withCloseButton onClose={onClose}
      title={invite.kind === 'reset' ? `Password reset link for ${invite.email}` : `Invitation for ${invite.email}`}>
      <Stack gap={6}>
        <Group gap="xs" wrap="nowrap">
          <Code style={{ flex: 1, overflowWrap: 'anywhere' }}>{invite.url}</Code>
          <CopyButton value={invite.url}>
            {({ copied, copy }) => <Tooltip label={copied ? 'Copied' : 'Copy'}><ActionIcon variant="default" onClick={copy} aria-label="Copy the link">{copied ? <IconCheck size={16} /> : <IconCopy size={16} />}</ActionIcon></Tooltip>}
          </CopyButton>
        </Group>
        <Text size="xs" c="dimmed">Send it to them yourself; nothing is emailed. It works once and expires {fmtWhen(invite.expiresAt)}.</Text>
      </Stack>
    </Alert>
  );
}

function Users({ users, roles, reload }: { users: UserDTO[]; roles: RoleDTO[]; reload: () => void }) {
  const meta = useMeta();
  const [busy, setBusy] = useState<string | null>(null);
  const [link, setLink] = useState<InviteDTO | null>(null);
  const isOwner = meta.me.role === 'owner';

  const patch = (u: UserDTO, body: Partial<Pick<UserDTO, 'role' | 'status'>>) => {
    setBusy(u.id);
    apiSend('PATCH', `/api/access/users/${encodeURIComponent(u.id)}`, body)
      .then(reload).catch(failed(`Couldn’t change ${u.name || u.email}`)).finally(() => setBusy(null));
  };
  const reset = (u: UserDTO) => {
    setBusy(u.id);
    apiSend<InviteDTO>('POST', `/api/access/users/${encodeURIComponent(u.id)}/reset`)
      .then((i) => { setLink(i); reload(); }).catch(failed('Couldn’t create a reset link')).finally(() => setBusy(null));
  };
  const signOutEverywhere = (u: UserDTO) => {
    if (!window.confirm(`Sign ${u.name || u.email} out of every session?`)) return;
    setBusy(u.id);
    apiSend<{ ok: boolean; revoked: number }>('DELETE', `/api/access/users/${encodeURIComponent(u.id)}/sessions`)
      .then((r) => { notifications.show({ title: 'Signed out', message: `${r.revoked} session${r.revoked === 1 ? '' : 's'} ended.`, color: 'ink' }); reload(); })
      .catch(failed('Couldn’t sign them out')).finally(() => setBusy(null));
  };

  return (
    <Stack gap="md">
      {link && <LinkCard invite={link} onClose={() => setLink(null)} />}
      <Card padding={0}>
        <Table.ScrollContainer minWidth={820}>
          <Table>
            <Table.Thead><Table.Tr><Table.Th>Person</Table.Th><Table.Th w={200}>Role</Table.Th><Table.Th w={110}>Active</Table.Th><Table.Th>Last seen</Table.Th><Table.Th ta="right">Sessions</Table.Th><Table.Th w={48} /></Table.Tr></Table.Thead>
            <Table.Tbody>
              {users.map((u) => {
                const me = u.id === meta.me.id;
                // An owner's role and status are an owner's to change; a role outside mine isn't mine to keep or give.
                const locked = (u.role === 'owner' && !isOwner) || !roles.some((r) => r.id === u.role);
                const options = locked ? [{ value: u.role, label: ROLE_LABEL[u.role] ?? u.role }] : roles.map((r) => ({ value: r.id, label: r.name }));
                return (
                  <Table.Tr key={u.id}>
                    <Table.Td>
                      <Group gap={6} wrap="nowrap"><Text size="sm" fw={600}>{u.name || '—'}</Text>{me && <Badge size="xs" variant="light" color="gray" tt="none">You</Badge>}</Group>
                      <Text size="xs" c="dimmed">{u.email}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Select size="xs" data={options} value={u.role} disabled={locked || busy === u.id} onChange={(v) => v && v !== u.role && patch(u, { role: v as Role })} aria-label={`Role of ${u.email}`} />
                    </Table.Td>
                    <Table.Td>
                      <Switch checked={u.status === 'active'} disabled={locked || busy === u.id} onChange={(e) => patch(u, { status: e.currentTarget.checked ? 'active' : 'disabled' })}
                        aria-label={`${u.email} can sign in`} label={u.status === 'active' ? 'Yes' : 'Disabled'} size="sm" />
                    </Table.Td>
                    <Table.Td><Text size="sm" c="dimmed">{u.lastSeenAt ? fmtWhen(u.lastSeenAt) : 'Never'}</Text></Table.Td>
                    <Table.Td ta="right"><Mono size="sm">{u.sessions}</Mono></Table.Td>
                    <Table.Td>
                      <Menu position="bottom-end" withinPortal>
                        <Menu.Target><ActionIcon loading={busy === u.id} aria-label={`Actions for ${u.email}`}><IconDots size={16} /></ActionIcon></Menu.Target>
                        <Menu.Dropdown>
                          <Menu.Item leftSection={<IconKey size={16} />} disabled={locked} onClick={() => reset(u)}>Password reset link</Menu.Item>
                          <Menu.Item leftSection={<IconLogout size={16} />} disabled={locked || !u.sessions} onClick={() => signOutEverywhere(u)}>Sign out everywhere</Menu.Item>
                        </Menu.Dropdown>
                      </Menu>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>
      <Text size="xs" c="dimmed">Disabling someone signs them out and stops their API tokens. The last active owner can’t be demoted or disabled.</Text>
    </Stack>
  );
}

function Invites({ invites, roles, reload }: { invites: InviteDTO[]; roles: RoleDTO[]; reload: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role | null>(roles.some((r) => r.id === 'viewer') ? 'viewer' : roles[0]?.id ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [link, setLink] = useState<InviteDTO | null>(null);

  const invite = () => {
    if (!role) return;
    setBusy('invite');
    apiSend<InviteDTO>('POST', '/api/access/invites', { email: email.trim(), role })
      .then((i) => { setLink(i); setEmail(''); reload(); }).catch(failed('Couldn’t create the invitation')).finally(() => setBusy(null));
  };
  const revoke = (i: InviteDTO) => {
    setBusy(i.id);
    apiSend('DELETE', `/api/access/invites/${encodeURIComponent(i.id)}`)
      .then(() => { if (link?.id === i.id) setLink(null); reload(); }).catch(failed('Couldn’t revoke the link')).finally(() => setBusy(null));
  };

  return (
    <Stack gap="md">
      <Card>
        <SectionTitle note="They choose their own name and password from the link.">Invite someone</SectionTitle>
        <form onSubmit={(e) => { e.preventDefault(); invite(); }}>
          <Group align="flex-end" wrap="wrap" gap="sm">
            <TextInput label="Email" type="email" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.currentTarget.value)} style={{ flex: 1, minWidth: 220 }} />
            <Select label="Role" data={roles.map((r) => ({ value: r.id, label: r.name }))} value={role} onChange={(v) => setRole(v as Role)} w={200} />
            <Button type="submit" leftSection={<IconUserPlus size={16} />} loading={busy === 'invite'} disabled={!email.trim() || !role}>Create invitation</Button>
          </Group>
        </form>
        {role && <Text size="xs" c="dimmed" mt="xs">{roles.find((r) => r.id === role)?.description}</Text>}
      </Card>
      {link && <LinkCard invite={link} onClose={() => setLink(null)} />}
      <Card padding={0}>
        {invites.length === 0 ? <Text size="sm" c="dimmed" p="lg">No open invitations or reset links.</Text> : (
          <Table.ScrollContainer minWidth={680}>
            <Table>
              <Table.Thead><Table.Tr><Table.Th>Email</Table.Th><Table.Th>Kind</Table.Th><Table.Th>Role</Table.Th><Table.Th>Created by</Table.Th><Table.Th>Expires</Table.Th><Table.Th w={48} /></Table.Tr></Table.Thead>
              <Table.Tbody>
                {invites.map((i) => (
                  <Table.Tr key={i.id}>
                    <Table.Td><Text size="sm">{i.email}</Text></Table.Td>
                    <Table.Td><Badge size="sm" variant="light" color="gray" tt="none">{i.kind === 'reset' ? 'Password reset' : 'Invitation'}</Badge></Table.Td>
                    <Table.Td><Text size="sm">{ROLE_LABEL[i.role] ?? i.role}</Text></Table.Td>
                    <Table.Td><Text size="sm" c="dimmed">{i.createdBy ?? '—'}</Text></Table.Td>
                    <Table.Td><Text size="sm" c="dimmed">{fmtWhen(i.expiresAt)}</Text></Table.Td>
                    <Table.Td><Tooltip label="Revoke"><ActionIcon color="accent" loading={busy === i.id} onClick={() => revoke(i)} aria-label={`Revoke the link for ${i.email}`}><IconTrash size={16} /></ActionIcon></Tooltip></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>
    </Stack>
  );
}

function Tokens({ tokens, reload }: { tokens: ApiTokenDTO[]; reload: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const revoke = (t: ApiTokenDTO) => {
    if (!window.confirm(`Revoke “${t.name}”? Anything using it stops working at once.`)) return;
    setBusy(t.id);
    apiSend('DELETE', `/api/auth/tokens/${encodeURIComponent(t.id)}`).then(reload).catch(failed('Couldn’t revoke the token')).finally(() => setBusy(null));
  };
  return (
    <Stack gap="xs">
      <Text size="sm" c="dimmed">Everyone’s tokens. People create their own under Your account (top right).</Text>
      <Card padding={0}>
        {tokens.length === 0 ? <Text size="sm" c="dimmed" p="lg">No API tokens.</Text> : (
          <Table.ScrollContainer minWidth={760}>
            <Table>
              <Table.Thead><Table.Tr><Table.Th>Token</Table.Th><Table.Th>Belongs to</Table.Th><Table.Th>Role</Table.Th><Table.Th>Created</Table.Th><Table.Th>Last used</Table.Th><Table.Th>Expires</Table.Th><Table.Th w={48} /></Table.Tr></Table.Thead>
              <Table.Tbody>
                {tokens.map((t) => (
                  <Table.Tr key={t.id}>
                    <Table.Td><Text size="sm" fw={600}>{t.name}</Text><Mono size="xs" c="dimmed">{t.prefix}…</Mono></Table.Td>
                    <Table.Td><Text size="sm">{t.userEmail ?? '—'}</Text></Table.Td>
                    <Table.Td><Text size="sm">{ROLE_LABEL[t.role] ?? t.role}</Text></Table.Td>
                    <Table.Td><Text size="sm" c="dimmed">{fmtWhen(t.createdAt)}</Text></Table.Td>
                    <Table.Td><Text size="sm" c="dimmed">{t.lastUsedAt ? fmtWhen(t.lastUsedAt) : 'Never'}</Text></Table.Td>
                    <Table.Td><Text size="sm" c="dimmed">{t.expiresAt ? fmtWhen(t.expiresAt) : 'Never'}</Text></Table.Td>
                    <Table.Td><Tooltip label="Revoke"><ActionIcon color="accent" loading={busy === t.id} onClick={() => revoke(t)} aria-label={`Revoke ${t.name}`}><IconTrash size={16} /></ActionIcon></Tooltip></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>
    </Stack>
  );
}

function Audit() {
  const p = usePal();
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [query, setQuery] = useState({ actor: '', action: '' });
  const log = useApi<AuditEventDTO[]>(`/api/access/audit${qs({ limit: 200, actor: query.actor, action: query.action })}`);
  return (
    <Stack gap="md">
      <form onSubmit={(e) => { e.preventDefault(); setQuery({ actor: actor.trim(), action: action.trim() }); }}>
        <Group align="flex-end" gap="sm" wrap="wrap">
          <TextInput label="Who" placeholder="Email or name" value={actor} onChange={(e) => setActor(e.currentTarget.value)} w={220} />
          <TextInput label="Action" placeholder="auth.login, PUT /api/settings…" value={action} onChange={(e) => setAction(e.currentTarget.value)} w={260} />
          <Button type="submit" variant="default">Filter</Button>
        </Group>
      </form>
      {log.error && !log.data ? <ErrorState error={log.error} onRetry={log.reload} /> : !log.data ? <Loading /> : (
        <Card padding={0}>
          {log.data.length === 0 ? <Text size="sm" c="dimmed" p="lg">Nothing recorded for this filter.</Text> : (
            <Table.ScrollContainer minWidth={820}>
              <Table>
                <Table.Thead><Table.Tr><Table.Th w={150}>When</Table.Th><Table.Th>Who</Table.Th><Table.Th>Action</Table.Th><Table.Th>Target</Table.Th><Table.Th ta="right" w={80}>Status</Table.Th></Table.Tr></Table.Thead>
                <Table.Tbody>
                  {log.data.map((e) => (
                    <Table.Tr key={e.id}>
                      <Table.Td><Text size="sm" c="dimmed" title={e.at}>{fmtWhen(e.at)}</Text></Table.Td>
                      <Table.Td><Text size="sm">{e.actor}</Text>{e.ip && <Mono size="xs" c="dimmed">{e.ip}</Mono>}</Table.Td>
                      <Table.Td><Mono size="sm">{e.action}</Mono></Table.Td>
                      <Table.Td><Text size="sm" c="dimmed" style={{ overflowWrap: 'anywhere' }}>{e.target ?? '—'}</Text></Table.Td>
                      <Table.Td ta="right">
                        {e.status === null ? <Text size="sm" c="dimmed">—</Text>
                          : <Mono size="sm" c={e.status >= 400 ? p.warnText : undefined}>{e.status}</Mono>}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </Card>
      )}
    </Stack>
  );
}

function Roles({ d }: { d: AccessDTO }) {
  const p = usePal();
  return (
    <Stack gap="xs">
      <Text size="sm" c="dimmed">The roles are fixed. Marked permissions spend money, place calls, change what every call is scored by, or change the live agent.</Text>
      <Card padding={0}>
        <Table.ScrollContainer minWidth={860}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Permission</Table.Th>
                {d.roles.map((r) => <Table.Th key={r.id} ta="center"><Tooltip label={r.description} multiline maw={260}><Text size="sm" fw={600} span>{r.name}</Text></Tooltip></Table.Th>)}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {d.permissions.map((perm) => (
                <Table.Tr key={perm.id}>
                  <Table.Td>
                    <Group gap={6} wrap="nowrap">
                      <Text size="sm" fw={600}>{perm.label}</Text>
                      {perm.risky && <Badge size="xs" color="accent" variant="light" tt="none">Risky</Badge>}
                    </Group>
                    <Text size="xs" c="dimmed">{perm.description}</Text>
                  </Table.Td>
                  {d.roles.map((r) => (
                    <Table.Td key={r.id} ta="center">
                      {r.permissions.includes(perm.id) ? <IconCheck size={16} aria-label="Allowed" /> : <Box component="span" c={p.text3} aria-label="Not allowed">—</Box>}
                    </Table.Td>
                  ))}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>
    </Stack>
  );
}
