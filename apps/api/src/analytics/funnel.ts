// Business view: each persona down the sales funnel, with CRM outcomes credited to calls.
// Rates are fractions (0–1); lost reasons and drop-offs are percentages.

import { LOST_REASON_LABELS, PERSONAS, scenarioById, type FunnelBrokerRow, type FunnelDTO, type FunnelInvestorRow } from '@calleval/framework';
import type { Db } from '../db';
import { getSettings } from '../lib/settings';
import { parseSlice, sliceWhere } from './filters';

export async function funnel(db: Db, q: Record<string, unknown>): Promise<FunnelDTO> {
  const f = parseSlice(q);
  const w = await sliceWhere(db, f, ['ver', 'path']);
  const settings = await getSettings(db);
  const crm = await db.one<{ n: number }>('select count(*)::int as n from lead_outcome');
  const crmConnected = (crm?.n ?? 0) > 0;

  const per = await db.query<{ pid: string; n: number; qual: number; ns: number; mb: number; mins: number; lift: number; unreg: number }>(
    `select c.persona as pid, count(*)::int as n, count(*) filter (where c.qualified)::int as qual,
       count(*) filter (where c.next_step is not null)::int as ns, count(*) filter (where c.next_step = 'meeting')::int as mb,
       avg(c.duration_s) / 60.0 as mins,
       count(*) filter (where exists (select 1 from call_event e where e.call_id = c.call_id and e.type = 'intent_rose'))::int as lift,
       count(*) filter (where exists (select 1 from call_tag t where t.call_id = c.call_id and t.tag_key = 'facet:broker_registration' and t.value = 'Unregistered'))::int as unreg
     from calls c where ${w.sql} and c.persona is not null group by c.persona`,
    w.params,
  );
  const out = await db.query<{ pid: string; stage: string; n: number; value: number | null }>(
    `select c.persona as pid, o.stage, count(*)::int as n, sum(o.value_aed) as value
     from lead_outcome o join calls c on c.call_id = o.credited_call_id where ${w.sql} group by c.persona, o.stage`,
    w.params,
  );
  const stage = (pid: string, s: string | string[]) => out.filter((o) => o.pid === pid && (Array.isArray(s) ? s.includes(o.stage) : o.stage === s)).reduce((a, o) => a + o.n, 0);
  const value = (pid: string) => out.filter((o) => o.pid === pid && ['reservation', 'sale'].includes(o.stage)).reduce((a, o) => a + (Number(o.value) || 0), 0);
  const row = (pid: string) => per.find((p) => p.pid === pid);
  const safe = (a: number, b: number) => (b ? a / b : 0);

  const investor: FunnelInvestorRow[] = PERSONAS.filter((p) => p.path === 'Investor').map((p) => {
    const r = row(p.id);
    const n = r?.n ?? 0, qual = r?.qual ?? 0, mb = r?.mb ?? 0;
    return {
      id: p.id, name: p.name, n, q: safe(qual, n), ns: safe(r?.ns ?? 0, n), mb: Math.min(1, safe(mb, qual)),
      show: crmConnected ? Math.min(1, safe(stage(p.id, 'meeting_attended'), mb)) : null,
      sv: crmConnected ? Math.min(1, safe(stage(p.id, 'site_visit'), qual)) : null,
      res: crmConnected ? Math.min(1, safe(stage(p.id, ['reservation', 'sale']), qual)) : null,
      qual, value: crmConnected ? value(p.id) / 1_000_000 : null, lift: safe(r?.lift ?? 0, n), mins: +(Number(r?.mins) || 0).toFixed(1),
    };
  });
  const broker: FunnelBrokerRow[] = PERSONAS.filter((p) => p.path === 'Broker').map((p) => {
    const r = row(p.id);
    const n = r?.n ?? 0, unreg = r?.unreg ?? 0;
    const reg = stage(p.id, 'broker_registered'), bdm = stage(p.id, 'bdm_call_held'), lead = stage(p.id, ['broker_first_lead', 'broker_deal']);
    return {
      id: p.id, name: p.name, n, unreg, reg, bdm, lead,
      act: crmConnected ? Math.min(1, safe(reg, unreg)) : null, bdmR: crmConnected ? Math.min(1, safe(bdm, reg)) : null, leadR: crmConnected ? Math.min(1, safe(lead, reg)) : null,
      ns: safe(r?.ns ?? 0, n), mins: +(Number(r?.mins) || 0).toFixed(1),
    };
  });

  // Lost reasons: objection events on target calls that ended with no next step.
  const lostRows = await db.query<{ pid: string; type: string; n: number }>(
    `select c.persona as pid, e.type, count(*)::int as n from call_event e join calls c on c.call_id = e.call_id
     where ${w.sql} and c.next_step is null and c.persona_path in ('Investor','Broker') and e.type = any($${w.params.length + 1}::text[])
     group by c.persona, e.type`,
    [...w.params, Object.keys(LOST_REASON_LABELS)],
  );
  const lostKeys = Object.keys(LOST_REASON_LABELS);
  const lost: Record<string, number[]> = {};
  for (const p of PERSONAS.filter((x) => x.path !== 'Non-target')) {
    const counts = lostKeys.map((k) => lostRows.find((r) => r.pid === p.id && r.type === k)?.n ?? 0);
    const tot = counts.reduce((a, b) => a + b, 0);
    lost[p.id] = counts.map((c) => (tot ? Math.round((c / tot) * 100) : 0));
  }

  // Drop-off: where calls with no next step left their expected path.
  const dropRows = await db.query<{ pid: string; sid: string; path: any; phases: any }>(
    `select c.persona as pid, c.scenario as sid, s.path, s.phases from calls c join call_score s on s.call_id = c.call_id
     where ${w.sql} and c.next_step is null and c.persona_path in ('Investor','Broker')`,
    w.params,
  );
  const drops: Record<string, [string, string, number][]> = {};
  for (const p of PERSONAS.filter((x) => x.path !== 'Non-target')) {
    const list = dropRows.filter((r) => r.pid === p.id && r.path?.deviation);
    const counts = new Map<string, { phase: string; n: number }>();
    for (const r of list) {
      const steps = r.path.steps as { label: string; hit: boolean; turn: number | null }[];
      const lastHit = [...steps].reverse().find((s) => s.hit && s.turn !== null);
      const phase = lastHit ? (r.phases?.phases ?? []).find((ph: any) => lastHit.turn! >= ph.from && lastHit.turn! <= ph.to)?.name ?? 'Body' : 'Introduction';
      const key = `${r.path.deviation} · ${r.sid}`;
      const cur = counts.get(key) ?? { phase, n: 0 };
      cur.n++; counts.set(key, cur);
    }
    const tot = list.length;
    drops[p.id] = Array.from(counts, ([k, v]) => [k, v.phase, tot ? Math.round((v.n / tot) * 100) : 0] as [string, string, number]).sort((a, b) => b[2] - a[2]).slice(0, 3);
  }

  const calls = per.reduce((a, r) => a + r.n, 0);
  const targetIds = PERSONAS.filter((p) => p.path !== 'Non-target').map((p) => p.id);
  const target = per.filter((r) => targetIds.includes(r.pid));
  void scenarioById;
  return {
    range: String(f.range),
    totals: {
      calls, targetCalls: target.reduce((a, r) => a + r.n, 0), qualified: target.reduce((a, r) => a + r.qual, 0),
      nextStep: per.reduce((a, r) => a + r.ns, 0), nonTarget: per.filter((r) => ['P9', 'P10', 'P11'].includes(r.pid)).reduce((a, r) => a + r.n, 0),
    },
    investor, broker, lostLabels: lostKeys.map((k) => LOST_REASON_LABELS[k]), lost, drops, crmConnected, attributionDays: settings.attributionDays,
  };
}
