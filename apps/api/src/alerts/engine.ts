// Six alert rules: compliance, quality, latency, tools, the funnel and the taxonomy. Each alert has a
// dedupe key, so re-running the rules never raises the same alert twice.

import { median, quantile, gateById, personaById, scenarioById, type AlertDTO, type AlertsDTO } from '@calleval/framework';
import { iso, type Db } from '../db';
import { newId } from '../lib/ids';
import { getSettings } from '../lib/settings';

export const ALERT_RULES: { name: string; when: string; urgency: string }[] = [
  { name: 'Gate failure', when: 'Any call fails a compliance gate', urgency: 'Within the hour' },
  { name: 'Quality drop', when: 'A cell’s median CQS falls 5 or more points week on week, with 30 or more calls in both weeks', urgency: 'Next working day' },
  { name: 'Latency', when: 'p90 response latency above 4 s across a day', urgency: 'Same day' },
  { name: 'Tool failure', when: 'Any tool fails on more than 5% of its calls in a day', urgency: 'Same day' },
  { name: 'Funnel drop', when: 'A persona’s next-step rate falls 10 or more points week on week', urgency: 'Weekly review' },
  { name: 'Taxonomy drift', when: 'Unclassified plus Other above 5% of calls for a week', urgency: 'Monthly review' },
];
const urgency = (rule: string) => ALERT_RULES.find((r) => r.name === rule)!.urgency;

async function raise(db: Db, a: { rule: string; text: string; page: string; link: string; params?: Record<string, string>; dedupe: string; at?: Date }) {
  const rows = await db.query(
    `insert into alert (id, rule, urgency, fired_at, text, page, link_label, params, dedupe_key) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
     on conflict (dedupe_key) do nothing returning id`,
    [newId('al'), a.rule, urgency(a.rule), (a.at ?? new Date()).toISOString(), a.text, a.page, a.link, JSON.stringify(a.params ?? {}), a.dedupe],
  );
  return rows.length > 0;
}

const cellName = (pid: string | null, sid: string | null) => `${personaById(pid).id} ${personaById(pid).name}${scenarioById(sid) ? ` × ${sid} ${scenarioById(sid)!.name}` : ''}`;
const dayStr = (d: Date) => d.toISOString().slice(0, 10);
const fmtDay = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Raised as soon as a gated call is scored. */
export async function gateAlert(db: Db, callId: string) {
  const c = await db.one(`select c.call_id, c.external_id, c.persona, c.scenario, c.started_at, s.gates from calls c join call_score s on s.call_id = c.call_id where c.call_id = $1`, [callId]);
  if (!c || !(c.gates ?? []).length) return;
  const g = c.gates[0];
  await raise(db, {
    rule: 'Gate failure', dedupe: `gate:${callId}`, at: new Date(c.started_at), page: 'calls', link: 'Open the call', params: { id: callId },
    text: `${c.external_id} · ${cellName(c.persona, c.scenario)}. ${gateById(g.id)?.text.replace(/\.$/, '') ?? g.id}${g.detail ? `: ${g.detail}` : ''}${c.gates.length > 1 ? ` (+${c.gates.length - 1} more gate${c.gates.length > 2 ? 's' : ''})` : ''}`,
  });
}

/** Evaluate the time-window rules over the last `lookbackDays` (1 for the hourly run). */
export async function runAlertRules(db: Db, lookbackDays = 2): Promise<number> {
  const settings = await getSettings(db);
  let raised = 0;
  const now = new Date();

  // Latency and tool failure, per day.
  for (let i = 0; i < lookbackDays; i++) {
    const day = new Date(now.getTime() - i * 86_400_000);
    const d = dayStr(day);
    const lats = await db.query<{ total: number }>(
      `select sum(t.duration_s) as total from trace_span t join calls c on c.call_id = t.call_id
       where t.kind in ('eot','llm','tool','tts') and to_char(c.started_at at time zone 'UTC', 'YYYY-MM-DD') = $1 group by t.call_id, t.turn`,
      [d],
    );
    if (lats.length >= 20) {
      const p90 = quantile(lats.map((l) => Number(l.total)), 0.9);
      if (p90 > 4) {
        const top = await db.one<{ name: string; d: number }>(
          `select t.name, avg(t.duration_s) as d from trace_span t join calls c on c.call_id = t.call_id
           where t.kind = 'tool_call' and to_char(c.started_at at time zone 'UTC', 'YYYY-MM-DD') = $1 group by t.name order by avg(t.duration_s) desc limit 1`, [d]);
        if (await raise(db, { rule: 'Latency', dedupe: `latency:${d}`, at: new Date(`${d}T20:00:00Z`), page: 'traces', link: 'See the spans in Traces', text: `p90 response latency was ${p90.toFixed(1)} s across ${fmtDay(day)}, above the 4 s line${top ? `; ${top.name} was the slowest tool at ${Number(top.d).toFixed(1)} s on average` : ''}.` })) raised++;
      }
    }
    const tools = await db.query<{ name: string; n: number; errs: number }>(
      `select t.name, count(*)::int as n, count(*) filter (where t.status = 'error')::int as errs from trace_span t join calls c on c.call_id = t.call_id
       where t.kind = 'tool_call' and to_char(c.started_at at time zone 'UTC', 'YYYY-MM-DD') = $1 group by t.name`, [d]);
    for (const t of tools) {
      if (t.n >= 10 && t.errs / t.n > 0.05) {
        if (await raise(db, { rule: 'Tool failure', dedupe: `tool:${t.name}:${d}`, at: new Date(`${d}T20:00:00Z`), page: 'traces', link: 'Check tool spans', text: `${t.name} failed on ${((t.errs / t.n) * 100).toFixed(1)}% of its ${t.n} calls on ${fmtDay(day)}, above the 5% line.` })) raised++;
      }
    }
  }

  // Week-on-week rules: quality drop per cell, funnel drop per persona, taxonomy drift.
  const weeks = Math.max(1, Math.ceil(lookbackDays / 7));
  for (let wk = 0; wk < weeks; wk++) {
    const end = new Date(now.getTime() - wk * 7 * 86_400_000);
    const mid = new Date(end.getTime() - 7 * 86_400_000), start = new Date(end.getTime() - 14 * 86_400_000);
    const rows = await db.query<{ pid: string; sid: string; cqs: number; ns: boolean; this_week: boolean; persona_conf: number | null }>(
      `select c.persona as pid, c.scenario as sid, c.cqs, c.next_step is not null as ns, c.started_at > $2 as this_week,
         (select t.confidence from call_tag t where t.call_id = c.call_id and t.tag_key = 'persona' and t.layer in ('classifier','heuristic')) as persona_conf
       from calls c where c.status = 'scored' and c.started_at > $1 and c.started_at <= $3`,
      [start.toISOString(), mid.toISOString(), end.toISOString()],
    );
    const tag = dayStr(end);
    const cells = new Map<string, { a: number[]; b: number[] }>();
    for (const r of rows) { const k = `${r.pid}|${r.sid}`; const g = cells.get(k) ?? { a: [], b: [] }; (r.this_week ? g.b : g.a).push(Number(r.cqs)); cells.set(k, g); }
    for (const [k, g] of cells) {
      if (g.a.length < settings.minCellCalls || g.b.length < settings.minCellCalls) continue;
      const prev = Math.round(median(g.a)), cur = Math.round(median(g.b));
      if (prev - cur >= 5) {
        const [pid, sid] = k.split('|');
        if (await raise(db, { rule: 'Quality drop', dedupe: `quality:${k}:${tag}`, at: end, page: 'matrix', link: 'Inspect the cell in the quality matrix', params: { sel: k }, text: `${cellName(pid, sid)}: median CQS fell from ${prev} to ${cur} week on week (${g.a.length} and ${g.b.length} calls).` })) raised++;
      }
    }
    const per = new Map<string, { a: boolean[]; b: boolean[] }>();
    for (const r of rows) { if (personaById(r.pid).path === 'Non-target' || r.pid === 'P0') continue; const g = per.get(r.pid) ?? { a: [], b: [] }; (r.this_week ? g.b : g.a).push(r.ns); per.set(r.pid, g); }
    for (const [pid, g] of per) {
      if (g.a.length < settings.minCellCalls || g.b.length < settings.minCellCalls) continue;
      const pa = (g.a.filter(Boolean).length / g.a.length) * 100, pb = (g.b.filter(Boolean).length / g.b.length) * 100;
      if (pa - pb >= 10) {
        if (await raise(db, { rule: 'Funnel drop', dedupe: `funnel:${pid}:${tag}`, at: end, page: 'funnel', link: 'Open the funnel', params: { persona: pid }, text: `${pid} ${personaById(pid).name}: next-step rate fell from ${Math.round(pa)}% to ${Math.round(pb)}% week on week.` })) raised++;
      }
    }
    const thisWeek = rows.filter((r) => r.this_week);
    if (thisWeek.length >= 50) {
      const unc = thisWeek.filter((r) => r.pid === 'P0' || (r.persona_conf !== null && Number(r.persona_conf) < settings.confidenceThreshold)).length;
      const oth = thisWeek.filter((r) => r.pid === 'P11').length;
      const share = ((unc + oth) / thisWeek.length) * 100;
      if (share > 5) {
        if (await raise(db, { rule: 'Taxonomy drift', dedupe: `drift:${tag}`, at: end, page: 'taxonomy', link: 'Open taxonomy health', text: `Unclassified plus Other reached ${share.toFixed(1)}% of calls for the week ending ${fmtDay(end)}, above the 5% line.` })) raised++;
      }
    }
  }
  return raised;
}

export async function listAlerts(db: Db, status: string, rule: string | null): Promise<AlertsDTO> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (status === 'open') conds.push('not acked');
  if (status === 'ack') conds.push('acked');
  if (rule) { params.push(rule); conds.push(`rule = $${params.length}`); }
  const rows = await db.query(`select * from alert ${conds.length ? `where ${conds.join(' and ')}` : ''} order by fired_at desc limit 300`, params);
  const open = await db.query<{ rule: string; n: number }>('select rule, count(*)::int as n from alert where not acked group by rule');
  const alerts: AlertDTO[] = rows.map((a) => ({
    id: a.id, rule: a.rule, urgency: a.urgency, firedAt: iso(a.fired_at)!,
    when: new Date(a.fired_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Dubai' }),
    text: a.text, page: a.page, link: a.link_label, params: a.params ?? {}, acked: !!a.acked,
  }));
  return { alerts, rules: ALERT_RULES.map((r) => ({ ...r, open: open.find((o) => o.rule === r.name)?.n ?? 0 })) };
}

export async function ackAlert(db: Db, id: string, acked: boolean) {
  await db.query('update alert set acked = $2, acked_at = case when $2 then now() else null end where id = $1', [id, acked]);
  return { acked };
}
