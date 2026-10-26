// Demo mode: a realistic quarter of synthetic calls run through the real pipeline (heuristic judge,
// no API spend), plus CRM outcomes, reviewer labels, alerts, clusters and recommendations, so every
// screen has something real to show before a provider is connected.

import { evaluateCall } from '../pipeline/evaluate';
import { heuristic } from '../pipeline/judge/heuristic';
import { storeEvaluation } from '../pipeline/store';
import { storeCanonical } from '../pipeline/ingest';
import { demoOutcomes, generateDemoCalls } from '../connectors/demo';
import { upsertOutcomes } from '../crm/outcomes';
import { runAlertRules, gateAlert } from '../alerts/engine';
import { runClusters } from '../analytics/clusters';
import { generateRecommendations, updateRecommendation, verifyShipped } from '../recommendations/engine';
import { getSettings } from '../lib/settings';
import { newId } from '../lib/ids';
import { log } from '../lib/log';
import { mulberry32, JUDGED_METRIC_KEYS } from './util';
import type { Db } from '../db';

export async function seedDemo(db: Db, opts: { count?: number; days?: number; seed?: number } = {}) {
  const count = opts.count ?? 5000, days = opts.days ?? 90;
  const t0 = Date.now();
  const settings = await getSettings(db);
  const calls = generateDemoCalls({ count, days, seed: opts.seed ?? 42 });
  const scored: { leadId: string | null; startedAt: string; nextStep: string | null; meetingKind: string | null; persona: string | null; cqs: number | null; callId: string; gated: boolean; truth: { p: string; s: string } }[] = [];
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    const callId = await storeCanonical(db, c, null, { integrationId: null, source: 'demo', keepRaw: false });
    const r = await evaluateCall(c, { callId, judge: heuristic, settings });
    await storeEvaluation(db, c, r.evaluation, r.runs, r.summary);
    scored.push({ leadId: c.leadId ?? null, startedAt: c.startedAt, nextStep: r.evaluation.outcome.nextStep, meetingKind: r.evaluation.outcome.meetingKind, persona: r.evaluation.tags.persona.value, cqs: r.evaluation.cqs, callId, gated: r.evaluation.gates.some((g) => g.failed), truth: { p: String(c.dynamicVariables.demo_persona), s: String(c.dynamicVariables.demo_scenario) } });
    if ((i + 1) % 500 === 0) log.info('demo seed progress', { done: i + 1, of: calls.length });
  }

  // CRM outcomes credited to the calls that preceded them.
  const outcomes = demoOutcomes(scored);
  const crm = await upsertOutcomes(db, outcomes, 'demo-crm');

  // Two reviewers label a sample, as the rollout's first phase asks: persona, scenario and judged metrics.
  const rnd = mulberry32(7);
  const sample = scored.filter(() => rnd() < 0.05).slice(0, 150);
  for (const s of sample) {
    const items = await db.query<{ id: string; kind: string; tag_key: string | null; current_value: string | null }>("select id, kind, tag_key, current_value from review_item where call_id = $1 and status = 'open'", [s.callId]);
    await db.query("insert into review_label (id, call_id, reviewer, key, value) values ($1,$2,'reviewer-a','persona',$3), ($4,$2,'reviewer-a','scenario_primary',$5)", [newId('lbl'), s.callId, s.truth.p, newId('lbl'), s.truth.s]);
    if (rnd() < 0.5) {
      const p2 = rnd() < 0.9 ? s.truth.p : 'P6', s2 = rnd() < 0.88 ? s.truth.s : 'S8';
      await db.query("insert into review_label (id, call_id, reviewer, key, value) values ($1,$2,'reviewer-b','persona',$3), ($4,$2,'reviewer-b','scenario_primary',$5)", [newId('lbl'), s.callId, p2, newId('lbl'), s2]);
    }
    for (const it of items.filter((x) => x.kind === 'tag' || x.kind === 'sample')) {
      const key = it.tag_key ?? 'persona';
      const value = key === 'persona' ? s.truth.p : key === 'scenario_primary' ? s.truth.s : it.current_value;
      await db.query("update review_item set status = 'done', resolved_at = now(), resolution = $2::jsonb where id = $1", [it.id, JSON.stringify({ value, reviewer: 'reviewer-a', modelValue: it.current_value ?? (key === 'persona' ? s.persona : null) })]);
    }
  }

  // Judged metrics: reviewers score a balanced sample (half failing, half passing) per metric, so
  // agreement is measured where the judge has to discriminate. Some metrics agree less, as in practice.
  const looser = new Set(['er', 'econ', 'rga', 'oh']);
  for (const key of JUDGED_METRIC_KEYS) {
    const rows = await db.query<{ call_id: string; value: number }>(
      `(select call_id, value from metric_result where metric_key = $1 and applicable and value < 50 order by md5(call_id) limit 25)
       union all (select call_id, value from metric_result where metric_key = $1 and applicable and value >= 50 order by md5(call_id) limit 25)`, [key]);
    for (const m of rows) {
      const agree = rnd() < (looser.has(key) ? 0.8 : 0.93);
      const v = agree ? Number(m.value) : Number(m.value) >= 50 ? 30 : 80;
      await db.query("insert into review_label (id, call_id, reviewer, key, value) values ($1,$2,'reviewer-a',$3,$4)", [newId('lbl'), m.call_id, `metric:${key}`, String(v)]);
    }
  }

  // Alerts over the last three weeks, gate alerts for the last week.
  for (const s of scored.filter((x) => x.gated && Date.now() - new Date(x.startedAt).getTime() < 7 * 86_400_000)) await gateAlert(db, s.callId);
  await runAlertRules(db, 21);
  await db.query("update alert set acked = true, acked_at = now() where fired_at < now() - interval '5 days'");

  await runClusters(db);
  const rec = await generateRecommendations(db, { useLlm: false });

  // Close the loop: v3 shipped the fix for the metric that improved most from v2, and the version
  // report verifies it; the top open item is accepted for the next prompt.
  const recs = await db.query<{ id: string; key: { metric?: string; gate?: string } }>(
    "select id, baseline->'key' as key from recommendation where status = 'proposed' and (baseline->'key' ? 'metric' or baseline->'key' ? 'gate') order by priority desc");
  const gains = await db.query<{ k: string; d: number }>(
    `select m.metric_key as k, avg(m.value) filter (where c.prompt_version = 'v3') - avg(m.value) filter (where c.prompt_version = 'v2') as d
     from metric_result m join calls c on c.call_id = m.call_id where m.applicable and m.value is not null group by 1`);
  const gain = (r: { key: { metric?: string } }) => Number(gains.find((g) => g.k === r.key?.metric)?.d ?? -1e9);
  for (const r of [...recs].filter((x) => x.key?.metric && gain(x) > 0).sort((a, b) => gain(b) - gain(a)).slice(0, 5)) {
    await db.query("update recommendation set status = 'in_prompt', target_version = 'v3', baseline = jsonb_set(coalesce(baseline, '{}'::jsonb), '{version}', '\"v2\"') where id = $1", [r.id]);
    if (await verifyShipped(db)) break;
    await db.query("update recommendation set status = 'proposed', target_version = null, note = null where id = $1", [r.id]);
  }
  const top = await db.one<{ id: string }>("select id from recommendation where status = 'proposed' order by priority desc limit 1");
  if (top) await updateRecommendation(db, top.id, { status: 'accepted', note: 'Planned for the next prompt release.' });
  const elapsed = Math.round((Date.now() - t0) / 1000);
  log.info('demo seed done', { calls: calls.length, outcomes: crm.imported, recommendations: rec.created, seconds: elapsed });
  return { calls: calls.length, outcomes: crm.imported, credited: crm.credited, recommendations: rec.created, seconds: elapsed };
}
