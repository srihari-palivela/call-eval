// Human review: low-confidence tags, every gated call, and a random sample. Reviewer decisions
// override the classifier, feed agreement and classifier-match figures, and re-score the call.

import { personaById, scenarioById, type ReviewItemDTO } from '@calleval/framework';
import { iso, type Db } from '../db';
import { newId } from '../lib/ids';
import { enqueue } from '../jobs/queue';
import type { HumanOverrides } from '../pipeline/evaluate';

const describe = (key: string | null, v: string | null) => {
  if (!v) return v;
  if (key === 'persona') return `${v} ${personaById(v).name}`;
  if (key?.startsWith('scenario')) return `${v} ${scenarioById(v)?.name ?? ''}`.trim();
  return v;
};

export async function listReview(db: Db, opts: { status?: string; kind?: string; callId?: string; limit?: number }): Promise<ReviewItemDTO[]> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (opts.status && opts.status !== 'all') { params.push(opts.status); conds.push(`r.status = $${params.length}`); }
  if (opts.kind) { params.push(opts.kind); conds.push(`r.kind = $${params.length}`); }
  if (opts.callId) { params.push(opts.callId); conds.push(`r.call_id = $${params.length}`); }
  const rows = await db.query(
    `select r.*, c.persona, c.scenario from review_item r left join calls c on c.call_id = r.call_id
     ${conds.length ? `where ${conds.join(' and ')}` : ''}
     order by case r.kind when 'gate' then 0 when 'tag' then 1 else 2 end, r.created_at desc limit ${Math.min(500, opts.limit ?? 200)}`,
    params,
  );
  return rows.map((r) => ({
    id: r.id, callId: r.call_id, kind: r.kind, tagKey: r.tag_key, reason: r.reason, status: r.status,
    currentValue: describe(r.tag_key, r.current_value), confidence: r.confidence === null ? null : Number(r.confidence),
    createdAt: iso(r.created_at)!, resolvedAt: iso(r.resolved_at), resolution: r.resolution,
    title: `${personaById(r.persona).id} ${personaById(r.persona).name}${scenarioById(r.scenario) ? ` × ${r.scenario} ${scenarioById(r.scenario)!.name}` : ''}`,
  }));
}

export async function resolveReview(db: Db, id: string, body: { value?: string | null; gateConfirmed?: boolean; note?: string }, reviewer = 'console') {
  const item = await db.one('select * from review_item where id = $1', [id]);
  if (!item) throw Object.assign(new Error('Review item not found'), { statusCode: 404 });
  const labels: [string, string][] = [];
  if (item.kind === 'gate' && typeof body.gateConfirmed === 'boolean') {
    for (const g of String(item.current_value ?? '').split(',').filter(Boolean)) labels.push([`gate:${g}`, body.gateConfirmed ? 'confirmed' : 'overturned']);
  } else if (item.kind === 'metric' && body.value !== undefined && body.value !== null) {
    labels.push([`metric:${item.tag_key}`, String(body.value)]);
  } else if (body.value !== undefined) {
    labels.push([item.tag_key ?? 'persona', body.value ?? 'none']);
  }
  // Keep the model's value next to the reviewer's so classifier-vs-reviewer match can be measured.
  const tagKey = item.kind === 'gate' || item.kind === 'metric' ? null : item.tag_key ?? 'persona';
  const modelValue = tagKey ? item.current_value ?? (await db.one<{ value: string | null }>('select value from call_tag where call_id = $1 and tag_key = $2', [item.call_id, tagKey]))?.value ?? null : null;
  await db.tx(async (t) => {
    for (const [key, value] of labels) await t.query('insert into review_label (id, call_id, reviewer, key, value) values ($1,$2,$3,$4,$5)', [newId('lbl'), item.call_id, reviewer, key, value]);
    await t.query("update review_item set status = 'done', resolved_at = now(), resolution = $2::jsonb where id = $1", [id, JSON.stringify({ ...body, reviewer, ...(tagKey ? { modelValue } : {}) })]);
  });
  // A changed tag or an overturned gate changes what applies to the call, so it is scored again.
  const prev = String(modelValue ?? item.current_value ?? '');
  const changed = labels.some(([k, v]) => (k.startsWith('gate:') ? v === 'overturned' : !k.startsWith('metric:') && v !== prev));
  if (changed) await enqueue(db, 'evaluate_call', { callId: item.call_id, reason: 'human review' }, { dedupeKey: `eval:${item.call_id}`, priority: 5 });
  return { ok: true, reevaluating: changed };
}

/** The latest human label per key for a call, as overrides for the pipeline. */
export async function humanOverrides(db: Db, callId: string): Promise<HumanOverrides> {
  const rows = await db.query<{ key: string; value: string }>(
    'select distinct on (key) key, value from review_label where call_id = $1 order by key, created_at desc', [callId],
  );
  const out: HumanOverrides = { tags: {}, answerKey: null, gates: {} };
  for (const r of rows) {
    if (r.key.startsWith('gate:')) out.gates![r.key.slice(5)] = r.value === 'confirmed';
    else if (r.key.startsWith('field:')) (out.answerKey ??= {})[r.key.slice(6)] = r.value;
    else if (!r.key.startsWith('metric:') && r.value !== 'none') out.tags![r.key] = r.value;
  }
  return out;
}
