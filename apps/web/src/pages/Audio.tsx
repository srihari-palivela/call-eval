import { useEffect, useRef, useState } from 'react';
import { Alert, Anchor, Badge, Box, Button, Card, Checkbox, Group, List, Paper, SegmentedControl, Select, SimpleGrid, Stack, Stepper, Table, Text, TextInput, ThemeIcon } from '@mantine/core';
import { Dropzone, FileRejection } from '@mantine/dropzone';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconFileMusic, IconUpload, IconX } from '@tabler/icons-react';
import type { AudioRowDTO } from '@calleval/framework';
import { usePal } from '../theme';
import { apiUpload, errMsg, qs, useApi, usePoll } from '../api';
import { ErrorState, Loading, Mono, PageHeader, SectionTitle } from '../components/ui';
import { useMeta, useStore } from '../store';

type Upload = {
  id: string; name: string; size: number; url: string | null;
  status: 'checking' | 'ready' | 'uploading' | 'queued' | 'rejected' | 'failed';
  dur: number | null; ch: number | null; rate: number | null; decodeFail: boolean;
  conv: string; dir: string; prompt: string; layout: string; consent: boolean; when: string;
  serverId: string | null; callId: string | null; error: string | null;
};

const PIPELINE_STEPS: [string, string][] = [
  ['Upload and check', 'Length, channels and sample rate, plus the recording-notice confirmation.'],
  ['Transcribe', 'Per-turn timestamps on each channel (ElevenLabs Scribe); the audio fills in timing the transcript lacks.'],
  ['Segment and tag', 'Introduction, body and conclusion; persona, scenarios, facets and events.'],
  ['Score', 'Code, judge and audio checks into seven dimension scores, the CQS and the gates.'],
  ['Store and join', 'Written to the call tables, linked to its trace, and joined to CRM outcomes.'],
];

const AUDIO_RE = /\.(wav|mp3|m4a|ogg|flac|aac|webm)$/i;
const fmtDur = (s: number | null) => {
  if (s === null || !isFinite(s)) return '—';
  let m = Math.floor(s / 60), r = Math.round(s % 60);
  if (r === 60) { m++; r = 0; }
  return `${m}:${String(r).padStart(2, '0')}`;
};
const fmtSize = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

function warningsOf(f: Upload) {
  const w: string[] = [];
  if (f.status === 'rejected') w.push('Not an audio file, so it can’t be scored. Remove it and upload the recording itself.');
  if (f.ch === 1) w.push('Mono recording: speakers will be separated by diarisation, and caller emotion is less reliable than on dual-channel audio.');
  if (f.ch !== null && f.ch > 2) w.push(`${f.ch} channels: only the first two are used, as agent and caller.`);
  if (f.rate && f.rate <= 8000) w.push('8 kHz phone audio: emotion models are less reliable here; check them against human labels before trusting them.');
  if (f.dur !== null && f.dur > 955) w.push('Longer than the 955 s call limit; the time-limit handling metric will apply.');
  if (f.dur !== null && f.dur < 10) w.push('Under 10 seconds: likely to be tagged S12 Failed call.');
  if (f.decodeFail) w.push('Your browser couldn’t decode this file to check it. It can still be queued; the pipeline checks it again.');
  return w;
}

export function AudioPage() {
  const p = usePal();
  const { go } = useStore();
  const meta = useMeta();
  const [files, setFiles] = useState<Upload[]>([]);
  const [filter, setFilter] = useState('all');
  const urls = useRef<string[]>([]);
  const blobs = useRef<Record<string, File>>({});
  const lib = useApi<AudioRowDTO[]>(`/api/recordings${qs({ group: filter === 'all' ? null : filter })}`);
  const inFlight = files.some((f) => f.status === 'queued') || (lib.data ?? []).some((r) => r.group === 'pipeline');
  usePoll(lib.reload, 5000, inFlight);

  useEffect(() => () => { urls.current.forEach((u) => { try { URL.revokeObjectURL(u); } catch { /* noop */ } }); }, []);

  const patch = (id: string, pt: Partial<Upload>) => setFiles((fs) => fs.map((f) => (f.id === id ? { ...f, ...pt } : f)));
  const defaultPrompt = meta.liveVersion ?? 'unknown';

  const addFiles = (list: File[], forceReject = false) => {
    list.forEach((file) => {
      const id = 'f' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
      const isAudio = !forceReject && (/^audio\//.test(file.type || '') || AUDIO_RE.test(file.name || ''));
      let url: string | null = null;
      if (isAudio) { try { url = URL.createObjectURL(file); urls.current.push(url); } catch { url = null; } }
      blobs.current[id] = file;
      setFiles((fs) => fs.concat([{ id, name: file.name, size: file.size, url, status: isAudio ? 'checking' : 'rejected', dur: null, ch: null, rate: null, decodeFail: false, conv: '', dir: 'in', prompt: defaultPrompt, layout: 'al', consent: false, when: '', serverId: null, callId: null, error: null }]));
      if (!isAudio) return;
      // WAV header: channels at byte 22, sample rate at byte 24.
      file.slice(0, 44).arrayBuffer().then((buf) => {
        if (buf.byteLength < 28) return;
        const v = new DataView(buf);
        const tag = String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3));
        if (tag === 'RIFF') patch(id, { rate: v.getUint32(24, true), ch: v.getUint16(22, true) });
      }).catch(() => { /* header unreadable */ });
      // Full decode for duration and channel count.
      file.arrayBuffer().then((buf) => {
        const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
        if (!Ctx) throw new Error('no audio context');
        const ctx = new Ctx();
        return new Promise<AudioBuffer>((res, rej) => ctx.decodeAudioData(buf, res, rej)).then((ab) => {
          patch(id, { dur: ab.duration, ch: ab.numberOfChannels, status: 'ready' });
          try { ctx.close(); } catch { /* noop */ }
        });
      }).catch(() => patch(id, { status: 'ready', decodeFail: true }));
    });
  };

  const remove = (f: Upload) => {
    try { if (f.url) URL.revokeObjectURL(f.url); } catch { /* noop */ }
    delete blobs.current[f.id];
    setFiles((fs) => fs.filter((x) => x.id !== f.id));
  };

  const queue = (f: Upload) => {
    const file = blobs.current[f.id];
    if (!file) return;
    const form = new FormData();
    form.append('conv', f.conv);
    form.append('dir', f.dir);
    form.append('prompt', f.prompt);
    form.append('layout', f.ch === 2 ? f.layout : 'mono');
    form.append('consent', String(f.consent));
    if (f.dur !== null) form.append('duration', String(f.dur));
    if (f.ch !== null) form.append('channels', String(f.ch));
    if (f.rate !== null) form.append('sampleRate', String(f.rate));
    form.append('file', file, file.name);
    patch(f.id, { status: 'uploading', error: null });
    apiUpload<{ id: string; callId: string | null; status: string }>('/api/uploads', form)
      .then((r) => {
        const d = new Date();
        patch(f.id, { status: 'queued', serverId: r.id, callId: r.callId, when: `at ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` });
        notifications.show({ title: 'Queued for scoring', message: `${f.conv || f.name} is uploaded and moving through the pipeline.`, color: 'ink' });
        lib.reload();
      })
      .catch((e) => {
        patch(f.id, { status: 'failed', error: errMsg(e) });
        notifications.show({ title: 'Upload failed', message: errMsg(e), color: 'accent' });
      });
  };

  const rows = lib.data ?? [];
  const rowFor = (f: Upload) => rows.find((r) => r.id === f.serverId || (f.callId && r.callId === f.callId)) ?? null;

  return (
    <>
      <PageHeader
        eyebrow="Data · Upload and track recordings"
        title="Audio logs"
        description="Upload call recordings to run them through the same pipeline as live calls. Dual-channel audio, with agent and caller on separate channels, gives the cleanest emotion and realism scores."
      />

      <Card mb="lg">
        <Dropzone
          onDrop={(fs) => addFiles(fs)}
          onReject={(rs: FileRejection[]) => addFiles(rs.map((r) => r.file), true)}
          accept={{ 'audio/*': ['.wav', '.mp3', '.m4a', '.ogg', '.flac', '.aac', '.webm'] }}
          multiple
          radius="lg"
          p="xl"
        >
          <Group justify="center" gap="lg" mih={140} style={{ pointerEvents: 'none' }} wrap="nowrap">
            <Dropzone.Accept><IconUpload size={40} stroke={1.6} /></Dropzone.Accept>
            <Dropzone.Reject><IconX size={40} stroke={1.6} color={p.warn} /></Dropzone.Reject>
            <Dropzone.Idle><IconFileMusic size={40} stroke={1.6} /></Dropzone.Idle>
            <Stack gap={4}>
              <Text size="lg" fw={600}>Drop call recordings here, or click to choose files</Text>
              <Text size="sm" c="dimmed">WAV, MP3, M4A, OGG or FLAC · each file is checked in your browser for length, channels and sample rate, then transcribed and scored</Text>
            </Stack>
          </Group>
        </Dropzone>

        {files.length === 0 && <Text size="sm" c="dimmed" mt="md">No recordings uploaded in this session yet.</Text>}

        <Stack gap="md" mt={files.length ? 'md' : 0}>
          {files.map((f) => {
            const warnings = warningsOf(f);
            const facts = [fmtSize(f.size), f.status === 'checking' ? 'checking…' : fmtDur(f.dur)];
            if (f.ch) facts.push(f.ch === 2 ? 'dual-channel' : f.ch === 1 ? 'mono' : `${f.ch} channels`);
            if (f.rate) facts.push(`${(f.rate / 1000).toFixed(f.rate % 1000 ? 1 : 0)} kHz`);
            const row = f.status === 'queued' ? rowFor(f) : null;
            const status = f.status === 'checking' ? { label: 'Checking', color: 'gray', variant: 'light' }
              : f.status === 'uploading' ? { label: 'Uploading', color: 'gray', variant: 'light' }
              : f.status === 'queued' ? { label: row?.group === 'scored' ? 'Scored' : row?.group === 'attention' ? 'Needs attention' : 'In pipeline', color: row?.group === 'attention' ? 'accent' : 'ink', variant: 'filled' }
              : f.status === 'rejected' ? { label: 'Not audio', color: 'accent', variant: 'filled' }
              : f.status === 'failed' ? { label: 'Upload failed', color: 'accent', variant: 'filled' }
              : warnings.length ? { label: 'Ready · check warnings', color: 'accent', variant: 'light' } : { label: 'Ready', color: 'ink', variant: 'light' };
            const editable = f.status === 'ready' || f.status === 'checking' || f.status === 'failed';
            const stage = row ? Math.min(5, row.stage + (row.group === 'pipeline' ? 0 : 1)) : 1;
            return (
              <Paper key={f.id} withBorder p="md" radius="lg" style={{ borderColor: f.status === 'rejected' || f.status === 'failed' ? p.warn : undefined }}>
                <Group justify="space-between" wrap="wrap" gap="sm" mb="sm">
                  <Stack gap={0} style={{ minWidth: 0 }}><Text fw={600} truncate maw={520}>{f.name}</Text><Mono size="xs" c="dimmed">{facts.join(' · ')}</Mono></Stack>
                  <Badge color={status.color} variant={status.variant as any} size="lg" tt="none">{status.label}</Badge>
                </Group>
                {f.url && f.status !== 'rejected' && (
                  <audio controls preload="metadata" src={f.url} style={{ width: '100%', marginBottom: 10 }}
                    onLoadedMetadata={(e) => { const d = (e.target as HTMLAudioElement).duration; if (f.dur === null && d && isFinite(d)) patch(f.id, { dur: d }); }} />
                )}
                {warnings.length > 0 && (
                  <Alert color="accent" variant="light" radius="md" icon={<IconAlertTriangle size={18} />} mb="sm" p="sm">
                    <List size="sm" spacing={2}>{warnings.map((w) => <List.Item key={w}>{w}</List.Item>)}</List>
                  </Alert>
                )}
                {f.error && <Text size="sm" c={p.warnText} mb="sm">{f.error}</Text>}
                {editable && (
                  <>
                    <SimpleGrid cols={{ base: 1, sm: 2, md: f.ch === 2 ? 4 : 3 }} mb="sm">
                      <TextInput label="Conversation ID (optional)" placeholder="e.g. conv_8d12" value={f.conv} onChange={(e) => patch(f.id, { conv: e.currentTarget.value })} />
                      <Select label="Direction" data={[{ value: 'in', label: 'Inbound' }, { value: 'out', label: 'Outbound' }]} value={f.dir} onChange={(v) => v && patch(f.id, { dir: v })} />
                      <Select label="Prompt version" data={[...meta.promptVersions.map((v) => ({ value: v.label, label: v.label === meta.liveVersion ? `${v.label} (live)` : v.label })), { value: 'unknown', label: 'Unknown' }].filter((o, i, a) => a.findIndex((x) => x.value === o.value) === i)} value={f.prompt} onChange={(v) => v && patch(f.id, { prompt: v })} />
                      {f.ch === 2 && <Select label="Channel layout" data={[{ value: 'al', label: 'Agent left, caller right' }, { value: 'cl', label: 'Caller left, agent right' }]} value={f.layout} onChange={(v) => v && patch(f.id, { layout: v })} />}
                    </SimpleGrid>
                    <Checkbox mb="sm" checked={f.consent} onChange={() => patch(f.id, { consent: !f.consent })} label="This call’s recording notice covers transcript, classifier and audio analysis." />
                    <Group gap="sm">
                      <Button onClick={() => queue(f)} disabled={f.status !== 'ready' && f.status !== 'failed' || !f.consent}>Queue for scoring</Button>
                      <Button variant="default" onClick={() => remove(f)}>Remove</Button>
                    </Group>
                  </>
                )}
                {f.status === 'uploading' && <Text size="sm" c="dimmed">Uploading…</Text>}
                {f.status === 'rejected' && <Button variant="default" onClick={() => remove(f)}>Remove</Button>}
                {f.status === 'queued' && (
                  <Stack gap="sm">
                    <Stepper active={stage} size="xs" iconSize={24} allowNextStepsSelect={false}>
                      {['Uploaded', 'Transcribe', 'Segment and tag', 'Score', 'Store'].map((s) => <Stepper.Step key={s} label={s} />)}
                    </Stepper>
                    <Text size="sm" c="dimmed">Queued {f.when} as {f.conv || 'a new upload'}{row ? ` · ${row.note}` : ''}.{row?.cqs && row.cqs !== '—' ? ` CQS ${row.cqs}.` : ''}</Text>
                    <Group gap="sm">
                      {(row?.callId || f.callId) && row?.link && <Button variant="default" onClick={() => go('calls', { id: (row?.callId ?? f.callId)! })}>Open in Call drill-down</Button>}
                      <Button variant="default" onClick={() => remove(f)}>Hide</Button>
                    </Group>
                  </Stack>
                )}
              </Paper>
            );
          })}
        </Stack>
      </Card>

      <Card mb="lg">
        <SectionTitle>What happens to a recording</SectionTitle>
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 5 }}>
          {PIPELINE_STEPS.map(([t, d], i) => (
            <Paper key={t} p="md" bg={p.soft}>
              <ThemeIcon variant="filled" color="ink" radius="xl" size={28} mb="sm"><Mono size="xs" fw={600}>{String(i + 1).padStart(2, '0')}</Mono></ThemeIcon>
              <Text fw={600} size="sm">{t}</Text>
              <Text size="sm" c="dimmed">{d}</Text>
            </Paper>
          ))}
        </SimpleGrid>
      </Card>

      <Card>
        <SectionTitle right={<SegmentedControl size="xs" value={filter} onChange={setFilter} data={[{ value: 'all', label: 'All' }, { value: 'scored', label: 'Scored' }, { value: 'pipeline', label: 'In pipeline' }, { value: 'attention', label: 'Needs attention' }]} />}>Recordings</SectionTitle>
        {lib.error && !lib.data && <ErrorState error={lib.error} onRetry={lib.reload} />}
        {!lib.data && !lib.error && <Loading />}
        {lib.data && rows.length === 0 && <Text size="sm" c="dimmed">No recordings in this group yet.</Text>}
        {rows.length > 0 && (
          <Table.ScrollContainer minWidth={820}>
            <Table>
              <Table.Thead><Table.Tr><Table.Th>Recording</Table.Th><Table.Th>Source</Table.Th><Table.Th ta="right">Length</Table.Th><Table.Th>Channels</Table.Th><Table.Th>Pipeline</Table.Th><Table.Th ta="right">CQS</Table.Th><Table.Th /></Table.Tr></Table.Thead>
              <Table.Tbody>
                {rows.map((r) => {
                  const att = r.group === 'attention';
                  return (
                    <Table.Tr key={r.id}>
                      <Table.Td><Mono size="sm" fw={500}>{r.id}</Mono></Table.Td>
                      <Table.Td><Text size="sm">{r.src}</Text></Table.Td>
                      <Table.Td ta="right"><Mono size="sm">{r.len}</Mono></Table.Td>
                      <Table.Td><Text size="sm">{r.ch}</Text></Table.Td>
                      <Table.Td>
                        <Group gap={8} wrap="nowrap">
                          <Group gap={3} wrap="nowrap" aria-hidden>{[0, 1, 2, 3, 4].map((i) => <Box key={i} w={8} h={8} style={{ borderRadius: 99, background: i <= r.stage ? (att && i === 4 ? p.warn : p.bar) : p.track }} />)}</Group>
                          <Text size="sm" c={att ? p.warnText : 'dimmed'} fw={att ? 600 : 400}>{r.note}</Text>
                        </Group>
                      </Table.Td>
                      <Table.Td ta="right"><Mono size="sm" fw={500}>{r.cqs}</Mono></Table.Td>
                      <Table.Td>{r.link && r.callId && <Anchor component="button" size="sm" fw={600} c="inherit" onClick={() => go('calls', { id: r.callId! })}>Open →</Anchor>}</Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>
    </>
  );
}
