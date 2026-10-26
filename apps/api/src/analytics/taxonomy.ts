// Taxonomy health: whether personas and scenarios still describe the calls. Unclassified and Other
// share, classifier confidence, reviewer agreement, classifier-vs-reviewer match, and clusters.

import { JUDGED_METRICS } from '../pipeline/judge/types';
import { cohensKappa, type TaxonomyHealthDTO, TAXONOMY_VERSION } from '@calleval/framework';
import { iso, type Db } from '../db';
import { getSettings } from '../lib/settings';

const BINS = ['0.3', '0.4', '0.5', '0.6', '0.7', '0.8', '0.9'];

export async function taxonomyHealth(db: Db): Promise<TaxonomyHealthDTO> {
  const settings = await getSettings(db);
  const thr = settings.confidenceThreshold;

  // Weekly Unclassified (P0 or a model tag under the confidence line) and Other (P11) share.
  const weeks = await db.query<{ week: Date; n: number; unc: number; oth: number }>(
    `select date_trunc('week', c.started_at) as week, count(*)::int as n,
       count(*) filter (where c.persona = 'P0' or exists (select 1 from call_tag t where t.call_id = c.call_id and t.tag_key in ('persona','scenario_primary') and t.layer in ('classifier','heuristic') and t.confidence < $1))::int as unc,
       count(*) filter (where c.persona = 'P11')::int as oth
     from calls c where c.status = 'scored' and c.started_at > now() - interval '8 weeks'
     group by 1 order by 1`,
    [thr],
  );

  const conf: TaxonomyHealthDTO['conf'] = { persona: BINS.map(() => 0), scenario: BINS.map(() => 0), intent: BINS.map(() => 0) };
  const confRows = await db.query<{ k: string; bin: number; n: number }>(
    `select t.tag_key as k, least(6, greatest(0, floor(t.confidence * 10)::int - 3)) as bin, count(*)::int as n
     from call_tag t join calls c on c.call_id = t.call_id
     where t.tag_key in ('persona','scenario_primary','intent_end') and t.layer in ('classifier','heuristic') and c.started_at > now() - interval '30 days'
     group by 1, 2`,
  );
  for (const r of confRows) {
    const key = r.k === 'persona' ? 'persona' : r.k === 'scenario_primary' ? 'scenario' : 'intent';
    conf[key][Number(r.bin)] += r.n;
  }

  // Judge vs reviewer agreement per judged metric (pass at 50 or above).
  const labels = await db.query<{ call_id: string; key: string; value: string; reviewer: string }>('select call_id, key, value, reviewer from review_label');
  const metricVals = await db.query<{ call_id: string; metric_key: string; value: number | null }>(
    `select m.call_id, m.metric_key, m.value from metric_result m where m.call_id in (select distinct call_id from review_label where key like 'metric:%')`,
  );
  const kappa = JUDGED_METRICS.map((m) => {
    const pairs: [string, string][] = [];
    for (const l of labels.filter((x) => x.key === `metric:${m.key}`)) {
      const j = metricVals.find((v) => v.call_id === l.call_id && v.metric_key === m.key);
      if (!j || j.value === null) continue;
      pairs.push([Number(j.value) >= 50 ? 'pass' : 'fail', Number(l.value) >= 50 ? 'pass' : 'fail']);
    }
    // Kappa is undefined when the sample has no variation (every call passed); report it as not measured.
    const varied = new Set(pairs.map((p) => p[0])).size > 1 || new Set(pairs.map((p) => p[1])).size > 1;
    const k = varied ? cohensKappa(pairs) : null;
    return { name: m.name.replace(' (counts twice)', ''), v: k === null ? null : +k.toFixed(2), n: pairs.length };
  });

  // Reviewer agreement: two different reviewers on the same call and tag.
  const agreement = (key: string) => {
    const by = new Map<string, { reviewer: string; value: string }[]>();
    for (const l of labels.filter((x) => x.key === key)) { const a = by.get(l.call_id) ?? []; a.push(l); by.set(l.call_id, a); }
    const pairs: [string, string][] = [];
    for (const ls of by.values()) { const a = ls[0]; const b = ls.find((x) => x.reviewer !== a.reviewer); if (b) pairs.push([a.value, b.value]); }
    return { k: cohensKappa(pairs), n: pairs.length };
  };
  const ap = agreement('persona'), as = agreement('scenario_primary');

  // Classifier vs reviewer: resolved review items record the model's value next to the reviewer's.
  const resolved = await db.query<{ tag_key: string | null; resolution: any }>("select tag_key, resolution from review_item where status = 'done' and resolution ? 'modelValue'");
  const match = (key: string) => {
    const rs = resolved.filter((r) => (r.tag_key ?? 'persona') === key && r.resolution?.value);
    return rs.length ? { v: rs.filter((r) => r.resolution.value === r.resolution.modelValue).length / rs.length, n: rs.length } : { v: null, n: 0 };
  };
  const mp = match('persona'), ms = match('scenario_primary');

  const queue = await db.one<{ open: number; low: number; sample: number }>(
    "select count(*)::int as open, count(*) filter (where kind = 'tag')::int as low, count(*) filter (where kind = 'sample')::int as sample from review_item where status = 'open'",
  );
  const clusters = await db.query('select * from cluster order by size desc');
  const versions = await db.query('select * from taxonomy_version order by created_at');
  const lastRun = await db.one<{ t: Date | null }>('select max(run_at) as t from cluster');
  const fmtWeek = (d: Date) => new Date(new Date(d).getTime() + 6 * 86_400_000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return {
    version: versions.find((v) => v.status === 'active')?.version ?? TAXONOMY_VERSION,
    lastClusterRun: iso(lastRun?.t ?? null),
    weeks: weeks.map((w) => ({ week: fmtWeek(w.week), unc: w.n ? +((w.unc / w.n) * 100).toFixed(1) : 0, oth: w.n ? +((w.oth / w.n) * 100).toFixed(1) : 0 })),
    confBins: BINS,
    conf,
    kappa,
    agreement: { persona: ap.k === null ? null : +ap.k.toFixed(2), scenario: as.k === null ? null : +as.k.toFixed(2), n: ap.n + as.n },
    classifierMatch: { persona: mp.v === null ? null : +mp.v.toFixed(2), scenario: ms.v === null ? null : +ms.v.toFixed(2), n: mp.n + ms.n },
    reviewQueue: { open: queue?.open ?? 0, lowConfidence: queue?.low ?? 0, sample: queue?.sample ?? 0 },
    clusters: clusters.map((c) => ({ id: c.id, label: c.label, size: c.size, nearest: c.nearest ?? '—', proposed: !!c.proposed })),
    versions: versions.map((v) => ({ version: v.version, status: v.status, approvedAt: iso(v.approved_at), notes: v.notes })),
  };
}
