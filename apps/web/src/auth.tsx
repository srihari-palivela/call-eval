// Sign-in gate around the console: self-serve sign-up and email verification, the first owner's setup, sign-in,
// forgotten passwords, invitation and password-reset links, and the way back to sign-in when a session ends.
// Before anyone has an account (and without self-serve sign-up) the API is open, and the console runs with a
// banner offering to create the first owner.
import { ChangeEvent, createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Alert, Anchor, Box, Button, Card, Group, Modal, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconLock, IconMail } from '@tabler/icons-react';
import type { AuthStatusDTO, MeDTO, PlanId, Role, SignupResultDTO } from '@calleval/framework';
import { apiGet, apiSend, errMsg, UNAUTHORIZED_EVENT } from './api';
import { ErrorState, Loading } from './components/ui';
import { ROLE_LABEL } from './components/access';

type Auth = {
  status: AuthStatusDTO;
  me: MeDTO | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<Auth | null>(null);

export function useAuth(): Auth {
  const a = useContext(Ctx);
  if (!a) throw new Error('AuthGate missing');
  return a;
}

const MIN_PASSWORD = 12;

type AuthRoute = { kind: 'accept' | 'verify' | 'signup' | 'forgot' | null; params: URLSearchParams };

/** Pages before sign-in, from the hash: `#accept?token=…` (invitation or reset), `#verify?token=…`, `#signup?plan=…`, `#forgot`. */
function authRoute(): AuthRoute {
  try {
    const [p, q] = window.location.hash.replace('#', '').split('?');
    const params = new URLSearchParams(q ?? '');
    if ((p === 'accept' || p === 'verify') && params.get('token')) return { kind: p, params };
    if (p === 'signup' || p === 'forgot') return { kind: p, params };
  } catch { /* hash unavailable */ }
  return { kind: null, params: new URLSearchParams() };
}

function setHash(h: string) {
  try { window.history.replaceState(null, '', h); } catch { /* sandboxed */ }
}

function leaveAcceptLink() {
  setHash('#attention');
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatusDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState<AuthRoute>(authRoute);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setStatus(await apiGet<AuthStatusDTO>('/api/auth/status'));
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  // A request came back 401 (signed out elsewhere, session expired): re-check, which shows sign-in if so.
  useEffect(() => {
    const on = () => { refresh(); };
    window.addEventListener(UNAUTHORIZED_EVENT, on);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, on);
  }, [refresh]);
  useEffect(() => {
    const on = () => setRoute(authRoute());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const goRoute = (h: string) => { setHash(h); setRoute(authRoute()); };

  const signOut = useCallback(async () => {
    try { await apiSend('POST', '/api/auth/logout'); } catch { /* the session may already be gone */ }
    await refresh();
  }, [refresh]);

  const signedIn = (me: MeDTO) => {
    setStatus((s) => ({ signedIn: true, me, setupRequired: false, setupNeedsToken: s?.setupNeedsToken ?? false, signupOpen: s?.signupOpen ?? false }));
  };
  const leave = () => { leaveAcceptLink(); setRoute(authRoute()); };

  const token = route.params.get('token');
  if (route.kind === 'accept' && token) {
    return <AcceptPage token={token} onDone={(me) => { leave(); signedIn(me); }} onLeave={() => { leave(); refresh(); }} />;
  }
  if (route.kind === 'verify' && token) {
    return <VerifyPage token={token} onDone={(me) => { leave(); signedIn(me); }} onLeave={() => { goRoute('#'); refresh(); }} />;
  }
  if (!status) {
    return (
      <Centre>
        {error ? <ErrorState error={`The Call Evaluation API isn’t reachable (${error}).`} onRetry={refresh} /> : <Loading label="Connecting to the Call Evaluation API…" />}
      </Centre>
    );
  }
  if (status.signedIn) {
    if (route.kind === 'signup' || route.kind === 'forgot') leaveAcceptLink();
    return <Ctx.Provider value={{ status, me: status.me, refresh, signOut }}>{children}</Ctx.Provider>;
  }
  if (route.kind === 'forgot') return <ForgotPage onBack={() => goRoute('#')} />;
  if (route.kind === 'signup') {
    return status.signupOpen
      ? <SignupPage plan={route.params.get('plan')} onSignIn={() => goRoute('#')} />
      : (
        <AuthCard title="Sign-up is closed">
          <Text size="sm">This installation doesn’t take new workspaces. Ask your admin for an invitation.</Text>
          <Group><Button variant="default" onClick={() => goRoute('#')}>Go to sign in</Button></Group>
        </AuthCard>
      );
  }
  if (status.setupRequired && !status.signupOpen) {
    return (
      <AuthCard title="Create the first owner" icon>
        <Text size="sm" c="dimmed">No one has an account yet. The first account is the owner: it invites everyone else and decides what each person can do.</Text>
        <SetupForm needsToken={status.setupNeedsToken} onDone={signedIn} />
      </AuthCard>
    );
  }
  return <SignInPage onDone={signedIn} signupOpen={status.signupOpen} onSignup={() => goRoute('#signup')} onForgot={() => goRoute('#forgot')} />;
}

function Centre({ children }: { children: ReactNode }) {
  return <Box mih="100vh" px="md" py={48} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Box w="100%" maw={440}>{children}</Box></Box>;
}

function AuthCard({ title, icon, children }: { title: string; icon?: boolean; children: ReactNode }) {
  return (
    <Centre>
      <Stack gap="lg">
        <Stack gap={0} align="center">
          <Text fw={700} fz={18}>Call Evaluation</Text>
          <Text fz={13} c="dimmed">Sales voice agent</Text>
        </Stack>
        <Card>
          <Stack gap="md">
            <Group gap={8} wrap="nowrap">{icon && <IconLock size={20} />}<Title order={3} fz={20}>{title}</Title></Group>
            {children}
          </Stack>
        </Card>
      </Stack>
    </Centre>
  );
}

function FormError({ error }: { error: string | null }) {
  if (!error) return null;
  return <Alert color="accent" variant="light" icon={<IconAlertTriangle size={18} />} radius="md">{error}</Alert>;
}

/** New password and its confirmation, checked before anything is sent. */
function passwordProblem(pw: string, confirm: string): string | null {
  if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (pw !== confirm) return 'The two passwords don’t match.';
  return null;
}

function SignInPage({ onDone, signupOpen, onSignup, onForgot }: { onDone: (me: MeDTO) => void; signupOpen: boolean; onSignup: () => void; onForgot: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    setBusy(true);
    setError(null);
    apiSend<MeDTO>('POST', '/api/auth/login', { email: email.trim(), password })
      .then(onDone)
      .catch((e) => setError(errMsg(e)))
      .finally(() => setBusy(false));
  };
  return (
    <AuthCard title="Sign in" icon>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Stack gap="sm">
          <TextInput label="Email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.currentTarget.value)} data-autofocus autoFocus />
          <PasswordInput label="Password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.currentTarget.value)} />
          <FormError error={error} />
          <Button type="submit" loading={busy} disabled={!email.trim() || !password}>Sign in</Button>
          <Group justify="space-between" gap="xs">
            <Anchor component="button" type="button" size="xs" onClick={onForgot}>Forgot your password?</Anchor>
            {signupOpen && <Anchor component="button" type="button" size="xs" onClick={onSignup}>Create an account</Anchor>}
          </Group>
        </Stack>
      </form>
    </AuthCard>
  );
}

const PLAN_NAME: Record<PlanId, string> = { payg: 'pay as you go', starter: 'Starter', growth: 'Growth', scale: 'Scale', enterprise: 'Enterprise' };
const SIGNUP_PLANS: PlanId[] = ['payg', 'starter', 'growth', 'scale'];

/** A new workspace: no session until the email is verified. */
function SignupPage({ plan, onSignIn }: { plan: string | null; onSignIn: () => void }) {
  const chosen: PlanId = SIGNUP_PLANS.includes(plan as PlanId) ? (plan as PlanId) : 'growth';
  const [f, setF] = useState({ workspaceName: '', name: '', email: '', password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<SignupResultDTO | null>(null);
  const set = (k: keyof typeof f) => (e: ChangeEvent<HTMLInputElement>) => { const v = e.currentTarget.value; setF((x) => ({ ...x, [k]: v })); };
  const submit = () => {
    const problem = passwordProblem(f.password, f.confirm);
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    apiSend<SignupResultDTO>('POST', '/api/auth/signup', { email: f.email.trim(), name: f.name.trim(), password: f.password, workspaceName: f.workspaceName.trim(), plan: chosen })
      .then(setSent)
      .catch((e) => setError(errMsg(e)))
      .finally(() => setBusy(false));
  };
  if (sent) return <CheckEmail result={sent} onSignIn={onSignIn} />;
  return (
    <AuthCard title="Create your workspace" icon>
      <Text size="sm" c="dimmed">{chosen === 'payg' ? 'Starting on pay as you go: you add credit when you’re ready to score calls.' : `Starting a 14-day trial of ${PLAN_NAME[chosen]}, no card needed.`}</Text>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Stack gap="sm">
          <TextInput label="Company or workspace name" required value={f.workspaceName} onChange={set('workspaceName')} data-autofocus autoFocus />
          <TextInput label="Your name" autoComplete="name" required value={f.name} onChange={set('name')} />
          <TextInput label="Work email" type="email" autoComplete="username" required value={f.email} onChange={set('email')} />
          <PasswordInput label="Password" description={`At least ${MIN_PASSWORD} characters.`} autoComplete="new-password" required value={f.password} onChange={set('password')} />
          <PasswordInput label="Confirm password" autoComplete="new-password" required value={f.confirm} onChange={set('confirm')} />
          <FormError error={error} />
          <Button type="submit" loading={busy} disabled={!f.workspaceName.trim() || !f.name.trim() || !f.email.trim() || !f.password}>Create workspace</Button>
          <Text size="xs" c="dimmed">Already have an account? <Anchor component="button" type="button" size="xs" onClick={onSignIn}>Sign in</Anchor></Text>
        </Stack>
      </form>
    </AuthCard>
  );
}

/** After sign-up: the verification email is on its way; it can be sent again. */
function CheckEmail({ result, onSignIn }: { result: SignupResultDTO; onSignIn: () => void }) {
  const [busy, setBusy] = useState(false);
  const resend = () => {
    setBusy(true);
    apiSend('POST', '/api/auth/resend', { email: result.email })
      .then(() => notifications.show({ title: 'Sent again', message: `Check ${result.email}, and its spam folder.`, color: 'ink' }))
      .catch((e) => notifications.show({ title: 'Couldn’t send the email', message: errMsg(e), color: 'accent' }))
      .finally(() => setBusy(false));
  };
  return (
    <AuthCard title="Check your email">
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <IconMail size={22} style={{ flex: 'none' }} />
        <Text size="sm">{result.sent
          ? <>We’ve sent a link to <b>{result.email}</b>. Open it to verify your email and start using your workspace.</>
          : result.devLink
            ? <>Verify <b>{result.email}</b> with the link below to start using your workspace.</>
            : <>This server can’t send email yet, so no link went to <b>{result.email}</b>. Ask whoever runs it to set up email.</>}</Text>
      </Group>
      {result.devLink && (
        <Alert color="gray" variant="light" radius="md" title="Development link">
          <Text size="xs" mb={6}>This server sends no email (SMTP isn’t configured), so here is the verification link.</Text>
          <Anchor href={result.devLink} size="xs" style={{ wordBreak: 'break-all' }}>{result.devLink}</Anchor>
        </Alert>
      )}
      <Group gap="xs">
        <Button variant="default" loading={busy} onClick={resend}>Send it again</Button>
        <Button variant="subtle" onClick={onSignIn}>Go to sign in</Button>
      </Group>
    </AuthCard>
  );
}

/** A verification link: confirms the email and signs in. */
function VerifyPage({ token, onDone, onLeave }: { token: string; onDone: (me: MeDTO) => void; onLeave: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    apiSend<MeDTO>('POST', '/api/auth/verify', { token }).then(onDone).catch((e) => setError(errMsg(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  if (!error) return <Centre><Loading label="Verifying your email…" /></Centre>;
  return (
    <AuthCard title="This link doesn’t work">
      <Text size="sm">It may have been used already or have expired. Sign in, or sign up again to get a new link.</Text>
      <Text size="xs" c="dimmed">{error}</Text>
      <Group><Button variant="default" onClick={onLeave}>Go to sign in</Button></Group>
    </AuthCard>
  );
}

/** A forgotten password: the reply never says whether the account exists. */
function ForgotPage({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const submit = () => {
    setBusy(true);
    setError(null);
    apiSend('POST', '/api/auth/forgot', { email: email.trim() })
      .then(() => setSent(true))
      .catch((e) => setError(errMsg(e)))
      .finally(() => setBusy(false));
  };
  return (
    <AuthCard title="Reset your password" icon>
      {sent ? (
        <>
          <Text size="sm">If an account exists for <b>{email.trim()}</b>, we’ve sent a link to set a new password. It works once.</Text>
          <Group><Button variant="default" onClick={onBack}>Back to sign in</Button></Group>
        </>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <Stack gap="sm">
            <Text size="sm" c="dimmed">Enter the email you sign in with, and we’ll send a link to set a new password.</Text>
            <TextInput label="Email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.currentTarget.value)} autoFocus />
            <FormError error={error} />
            <Button type="submit" loading={busy} disabled={!email.trim()}>Send the link</Button>
            <Anchor component="button" type="button" size="xs" onClick={onBack}>Back to sign in</Anchor>
          </Stack>
        </form>
      )}
    </AuthCard>
  );
}

/** The first owner: on the setup page, or from the open-mode banner. */
export function SetupForm({ needsToken, onDone }: { needsToken: boolean; onDone: (me: MeDTO) => void }) {
  const [f, setF] = useState({ email: '', name: '', password: '', confirm: '', setupToken: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: ChangeEvent<HTMLInputElement>) => { const v = e.currentTarget.value; setF((x) => ({ ...x, [k]: v })); };
  const submit = () => {
    const problem = passwordProblem(f.password, f.confirm);
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    apiSend<MeDTO>('POST', '/api/auth/setup', { email: f.email.trim(), name: f.name.trim(), password: f.password, ...(needsToken ? { setupToken: f.setupToken.trim() } : {}) })
      .then(onDone)
      .catch((e) => setError(errMsg(e)))
      .finally(() => setBusy(false));
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <Stack gap="sm">
        <TextInput label="Email" type="email" autoComplete="username" required value={f.email} onChange={set('email')} />
        <TextInput label="Name" autoComplete="name" required value={f.name} onChange={set('name')} />
        <PasswordInput label="Password" description={`At least ${MIN_PASSWORD} characters.`} autoComplete="new-password" required value={f.password} onChange={set('password')} />
        <PasswordInput label="Confirm password" autoComplete="new-password" required value={f.confirm} onChange={set('confirm')} />
        {needsToken && (
          <PasswordInput label="Setup token" description="The API_TOKEN set on the server. It proves you run this installation." required value={f.setupToken} onChange={set('setupToken')} />
        )}
        <FormError error={error} />
        <Button type="submit" loading={busy} disabled={!f.email.trim() || !f.name.trim() || !f.password || (needsToken && !f.setupToken.trim())}>Create the owner account</Button>
      </Stack>
    </form>
  );
}

type InviteInfo = { email: string; role: Role; kind: 'invite' | 'reset'; expiresAt: string };

function AcceptPage({ token, onDone, onLeave }: { token: string; onDone: (me: MeDTO) => void; onLeave: () => void }) {
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [f, setF] = useState({ name: '', password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = `/api/auth/invites/${encodeURIComponent(token)}`;

  useEffect(() => {
    let alive = true;
    apiGet<InviteInfo>(path).then((i) => { if (alive) setInfo(i); }).catch((e) => { if (alive) setLoadError(errMsg(e)); });
    return () => { alive = false; };
  }, [path]);

  if (loadError) {
    return (
      <AuthCard title="This link doesn’t work">
        <Text size="sm">It may have been used already, revoked, or have expired. Ask an admin for a new one.</Text>
        <Text size="xs" c="dimmed">{loadError}</Text>
        <Group><Button variant="default" onClick={onLeave}>Go to sign in</Button></Group>
      </AuthCard>
    );
  }
  if (!info) return <Centre><Loading label="Checking the link…" /></Centre>;

  const reset = info.kind === 'reset';
  const submit = () => {
    const problem = passwordProblem(f.password, f.confirm);
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    apiSend<MeDTO>('POST', `${path}/accept`, { name: reset ? undefined : f.name.trim(), password: f.password })
      .then(onDone)
      .catch((e) => setError(errMsg(e)))
      .finally(() => setBusy(false));
  };
  const set = (k: keyof typeof f) => (e: ChangeEvent<HTMLInputElement>) => { const v = e.currentTarget.value; setF((x) => ({ ...x, [k]: v })); };
  return (
    <AuthCard title={reset ? 'Set a new password' : 'Join Call Evaluation'} icon>
      <Text size="sm">
        {reset ? <>For <b>{info.email}</b>.</> : <>You’re invited as <b>{ROLE_LABEL[info.role] ?? info.role}</b>, with the email <b>{info.email}</b>.</>}
      </Text>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Stack gap="sm">
          {!reset && <TextInput label="Your name" autoComplete="name" required value={f.name} onChange={set('name')} />}
          <PasswordInput label={reset ? 'New password' : 'Password'} description={`At least ${MIN_PASSWORD} characters.`} autoComplete="new-password" required value={f.password} onChange={set('password')} />
          <PasswordInput label="Confirm password" autoComplete="new-password" required value={f.confirm} onChange={set('confirm')} />
          <FormError error={error} />
          <Button type="submit" loading={busy} disabled={(!reset && !f.name.trim()) || !f.password}>{reset ? 'Set password and sign in' : 'Create account'}</Button>
          <Text size="xs" c="dimmed">This link works once and expires {new Date(info.expiresAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.</Text>
        </Stack>
      </form>
    </AuthCard>
  );
}

/** Open mode: nobody has an account, so anyone who reaches the app can use it. */
export function OpenModeBanner({ onCreated }: { onCreated: () => void }) {
  const { me, status, refresh } = useAuth();
  const [open, setOpen] = useState(false);
  if (me?.via !== 'open') return null;
  return (
    <>
      <Alert color="accent" variant="light" radius="md" mb="md" icon={<IconAlertTriangle size={18} />}>
        <Group justify="space-between" gap="sm">
          <Text size="sm">No users yet: anyone who can reach this app can use it.</Text>
          <Button size="xs" onClick={() => setOpen(true)}>Create the first owner</Button>
        </Group>
      </Alert>
      <Modal opened={open} onClose={() => setOpen(false)} title="Create the first owner">
        <Stack gap="sm">
          <Text size="sm" c="dimmed">From then on, everyone signs in, and the owner invites the rest of the team.</Text>
          <SetupForm needsToken={status.setupNeedsToken} onDone={() => { setOpen(false); refresh().then(onCreated); }} />
        </Stack>
      </Modal>
    </>
  );
}
