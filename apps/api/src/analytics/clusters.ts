// Monthly clustering of calls the taxonomy doesn't describe well (Other, Unclassified, low-confidence,
// out-of-scope), to surface journeys nobody has named yet. With a Claude key the summaries are
// grouped by meaning; without one, recurring caller phrases stand in for themes.

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { PERSONAS, SCENARIOS, scenarioById, personaById, type CanonicalCall } from '@calleval/framework';
import { config, llmEnabled } from '../config';
import type { Db } from '../db';
import { newId } from '../lib/ids';
import { errMsg, log } from '../lib/log';
import { getSettings } from '../lib/settings';

const STOP = new Set('the a an and or but to of in on for with is it i you we my me your this that be are was do can what how about just so if not no yes okay ok there have has like would could should will from at by as they them our us its im dont thats want looking call calling get know thanks thank please much sure really actually also some more then than here when where which who whom whose does done tell need right good great fine well maybe think said told again still into over very many much bedrooms bedroom price prices'.split(' '));

type Candidate = { call_id: string; persona: string | null; scenario: string | null; summary: string | null; canonical: CanonicalCall };

async function candidates(db: Db): Promise<Candidate[]> {
  const s = await getSettings(db);
  return db.query<Candidate>(
    `select c.call_id, c.persona, c.scenario, (select value from call_tag t where t.call_id = c.call_id and t.tag_key = 'summary') as summary, c.canonical
     from calls c where c.status = 'scored' and c.started_at > now() - interval '30 days' and (
       c.persona in ('P0','P11') or c.scenario = 'S11'
       or exists (select 1 from call_tag t where t.call_id = c.call_id and t.tag_key in ('persona','scenario_primary') and t.layer in ('classifier','heuristic') and t.confidence < $1)
       or exists (select 1 from call_event e where e.call_id = c.call_id and e.type = 'off_topic_request'))
     order by c.started_at desc limit 400`,
    [s.confidenceThreshold],
  );
}

// Themes the v1 taxonomy folds into Other or Out of scope. Without a Claude key these known themes
// are counted; with one, the summaries are grouped by meaning and new themes surface on their own.
const THEMES: { label: string; rx: RegExp }[] = [
  { label: 'Golden visa eligibility through a purchase', rx: /\bgolden visa\b/i },
  { label: 'Reselling an off-plan unit before handover', rx: /\bresell|re-sell|sell (it|my unit) before handover\b/i },
  { label: 'Payment plan changes for an existing buyer', rx: /\b(change|move|defer|reschedule) (my|the) (payment plan|instalment|installment)\b|\bnext instalment\b/i },
  { label: 'Mortgage pre-approval timing', rx: /\bmortgage|pre-?approval|non-resident.{0,20}loan\b/i },
  { label: 'Caller switches language mid-call', rx: /\b(arabic|hindi|urdu|russian|french)\b|^(marhaba|shukran|ahlan)/i },
];

function phraseClusters(cands: Candidate[]) {
  const out: { label: string; ids: string[] }[] = [];
  const used = new Set<string>();
  const callerText = (c: Candidate) => (c.canonical?.turns ?? []).filter((t) => t.speaker === 'caller').map((t) => t.text).join(' ');
  for (const th of THEMES) {
    const ids = cands.filter((c) => !used.has(c.call_id) && th.rx.test(callerText(c))).map((c) => c.call_id);
    if (ids.length >= 5) { out.push({ label: th.label, ids }); ids.forEach((i) => used.add(i)); }
  }
  return out;
}

async function llmClusters(cands: Candidate[]): Promise<{ label: string; ids: string[]; nearest: string }[]> {
  const client = new Anthropic({ maxRetries: 2 });
  const lines = cands.map((c, i) => `${i}\t${c.persona ?? 'P0'}/${c.scenario ?? '-'}\t${(c.summary ?? '').slice(0, 200)}`).join('\n');
  const schema = {
    type: 'object', additionalProperties: false, required: ['clusters'],
    properties: { clusters: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'members', 'nearest_tag'], properties: { label: { type: 'string' }, members: { type: 'array', items: { type: 'integer' } }, nearest_tag: { type: 'string' } } } } },
  };
  const taxonomy = [...PERSONAS.map((p) => `${p.id} ${p.name}`), ...SCENARIOS.map((s) => `${s.id} ${s.name}`)].join('; ');
  const msg = await client.messages.create({
    model: config.llm.model, max_tokens: 16000,
    system: 'You maintain the call taxonomy for an AI voice sales agent selling off-plan property in Dubai. Group call summaries into themes the current taxonomy does not name yet. Ignore themes the taxonomy already covers well.',
    messages: [{ role: 'user', content: `Current taxonomy: ${taxonomy}\n\nSummaries (index, current tags, summary):\n${lines}\n\nReturn up to 8 clusters of at least 5 calls each: a short label for the shared need, the member indexes, and the nearest existing tag id.` }],
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
  });
  const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
  const o = z.object({ clusters: z.array(z.object({ label: z.string(), members: z.array(z.number().int()), nearest_tag: z.string() })) }).parse(JSON.parse(text));
  return o.clusters.map((c) => ({ label: c.label, ids: c.members.filter((i) => cands[i]).map((i) => cands[i].call_id), nearest: c.nearest_tag }));
}

export async function runClusters(db: Db) {
  const cands = await candidates(db);
  if (cands.length < 5) return { clusters: 0, candidates: cands.length };
  let clusters: { label: string; ids: string[]; nearest?: string }[] = [];
  if (llmEnabled()) {
    try { clusters = await llmClusters(cands); } catch (e) { log.warn('LLM clustering failed; using phrase clusters', { error: errMsg(e) }); }
  }
  if (!clusters.length) clusters = phraseClusters(cands);
  const proposed = new Set((await db.query<{ label: string }>('select label from cluster where proposed')).map((r) => r.label.toLowerCase()));
  await db.tx(async (t) => {
    await t.query('delete from cluster where not proposed');
    for (const c of clusters) {
      if (proposed.has(c.label.toLowerCase())) continue;
      const members = cands.filter((x) => c.ids.includes(x.call_id));
      const near = c.nearest ?? (() => {
        const counts = new Map<string, number>();
        for (const m of members) { const k = m.scenario === 'S11' || !m.persona ? `${m.scenario}` : `${m.persona}`; counts.set(k, (counts.get(k) ?? 0) + 1); }
        return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—';
      })();
      const nearLabel = near?.startsWith('S') ? `${near} ${scenarioById(near)?.name ?? ''}` : near?.startsWith('P') ? `${near} ${personaById(near).name}` : near;
      await t.query('insert into cluster (id, label, size, nearest, call_ids) values ($1,$2,$3,$4,$5::jsonb)', [newId('cl'), c.label, c.ids.length, nearLabel, JSON.stringify(c.ids.slice(0, 50))]);
    }
  });
  return { clusters: clusters.length, candidates: cands.length };
}
