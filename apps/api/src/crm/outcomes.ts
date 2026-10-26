// CRM outcomes (Treppan or any CRM that can export lead stages). Outcomes join to calls through
// lead_id and are credited to the most recent call before each stage, within the attribution
// window (30 days by default; reservations and deals use the longer window, 90 days by default,
// because off-plan decisions take longer). A stage with no call in the window is stored but not
// credited to the agent.

import { getJson } from '../lib/http';
import { type Db } from '../db';
import { newId, sha } from '../lib/ids';
import { getSettings } from '../lib/settings';

export const STAGES = ['meeting_booked', 'meeting_attended', 'site_visit', 'reservation', 'sale', 'broker_registered', 'bdm_call_held', 'broker_first_lead', 'broker_deal'] as const;
const SYNONYMS: Record<string, string> = {
  attended: 'meeting_attended', meeting_held: 'meeting_attended', visit: 'site_visit', sitevisit: 'site_visit', site_visit_done: 'site_visit',
  reserved: 'reservation', booking: 'reservation', eoi: 'reservation', spa_signed: 'sale', sold: 'sale', closed_won: 'sale',
  registered: 'broker_registered', broker_registration: 'broker_registered', bdm_call: 'bdm_call_held', first_lead: 'broker_first_lead', deal: 'broker_deal',
};
const LONG_WINDOW = new Set(['reservation', 'sale', 'broker_deal', 'broker_first_lead']);

export type OutcomeInput = { lead_id: string; stage: string; occurred_at: string; project?: string | null; value_aed?: number | string | null; external_id?: string | null; source?: string };

export function normaliseStage(s: string): string | null {
  const k = s.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if ((STAGES as readonly string[]).includes(k)) return k;
  return SYNONYMS[k] ?? null;
}

export async function upsertOutcomes(db: Db, rows: OutcomeInput[], source = 'api') {
  let imported = 0, skipped = 0;
  const leads = new Set<string>();
  for (const r of rows) {
    const stage = normaliseStage(String(r.stage ?? ''));
    const at = new Date(String(r.occurred_at ?? ''));
    if (!r.lead_id || !stage || isNaN(at.getTime())) { skipped++; continue; }
    const value = r.value_aed === null || r.value_aed === undefined || r.value_aed === '' ? null : Number(String(r.value_aed).replace(/[^\d.]/g, ''));
    const ext = r.external_id || `${source}:${sha(`${r.lead_id}|${stage}|${at.toISOString()}`, 20)}`;
    await db.query(
      `insert into lead_outcome (id, lead_id, stage, occurred_at, project, value_aed, source, external_id) values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (external_id) do update set stage = excluded.stage, occurred_at = excluded.occurred_at, project = excluded.project, value_aed = excluded.value_aed`,
      [newId('out'), String(r.lead_id), stage, at.toISOString(), r.project ?? null, value !== null && isFinite(value) ? value : null, r.source ?? source, ext],
    );
    leads.add(String(r.lead_id));
    imported++;
  }
  const credited = await attribute(db, Array.from(leads));
  return { imported, skipped, credited };
}

/** Credit each outcome to the most recent call for the lead before it, within the window. */
export async function attribute(db: Db, leadIds?: string[]): Promise<number> {
  const s = await getSettings(db);
  const rows = await db.query<{ id: string }>(
    `update lead_outcome o set credited_call_id = (
       select c.call_id from calls c
       where c.lead_id = o.lead_id and c.started_at <= o.occurred_at
         and c.started_at >= o.occurred_at - (case when o.stage = any($3::text[]) then $2::int else $1::int end) * interval '1 day'
       order by c.started_at desc limit 1)
     where $4::text[] is null or o.lead_id = any($4::text[])
     returning o.id`,
    [s.attributionDays, s.reservationAttributionDays, Array.from(LONG_WINDOW), leadIds?.length ? leadIds : null],
  );
  const n = await db.one<{ n: number }>(`select count(*)::int as n from lead_outcome where credited_call_id is not null ${leadIds?.length ? 'and lead_id = any($1::text[])' : ''}`, leadIds?.length ? [leadIds] : []);
  void rows;
  return n?.n ?? 0;
}

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const clean = rows.filter((r) => r.some((c) => c.trim()));
  if (!clean.length) return [];
  const head = clean[0].map((h) => h.trim().toLowerCase());
  return clean.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/**
 * Pull outcomes from the CRM. Treppan's export API is not public, so this adapter expects an
 * endpoint returning `[{ lead_id, stage, occurred_at, project, value_aed, id }]` (or `{ items: [...] }`)
 * for `?since=<ISO>`; point TREPPAN_API_URL at it or at a small mapping service in front of Treppan.
 */
export async function pullCrm(db: Db, baseUrl: string, apiKey: string, since: Date | null) {
  const url = `${baseUrl.replace(/\/$/, '')}/outcomes${since ? `?since=${encodeURIComponent(since.toISOString())}` : ''}`;
  const body = await getJson<any>(url, apiKey ? { authorization: `Bearer ${apiKey}` } : {});
  const items: any[] = Array.isArray(body) ? body : body?.items ?? [];
  return upsertOutcomes(db, items.map((x) => ({ lead_id: x.lead_id ?? x.leadId, stage: x.stage, occurred_at: x.occurred_at ?? x.occurredAt ?? x.date, project: x.project ?? null, value_aed: x.value_aed ?? x.valueAed ?? x.value ?? null, external_id: x.id ? `treppan:${x.id}` : null })), 'treppan');
}
