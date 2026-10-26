// Improvement recommendations: the framework's output. Findings come from compliance gates, metrics
// below the line, the fix-first cells, routing (non-target share) and taxonomy drift. Each finding is
// sized by impact (calls × points below the line), backed by quoted evidence turns, and turned into a
// concrete change — a prompt rule, a tool change, a routing fix or a new tag. With a Claude key the
// change is written against the agent's actual prompt. A shipped fix is verified when the next prompt
// version measurably moves the metric it targeted.

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import {
  DIMS, GATES, METRICS, bootstrapMedianDiff, gateById, median, metricByKey, personaById, scenarioById, type CanonicalCall, type RecommendationDTO,
} from '@calleval/framework';
import { config, llmEnabled } from '../config';
import { iso, type Db } from '../db';
import { newId, sha } from '../lib/ids';
import { errMsg, log } from '../lib/log';
import { getSettings } from '../lib/settings';
import { fixMap } from '../analytics/matrix';
import { resolveVersion, versionPairsSql } from '../analytics/filters';
import { PLAYBOOK } from './playbook';

type Evidence = RecommendationDTO['evidence'][number];
type Finding = {
  fingerprint: string;
  scope: RecommendationDTO['scope'];
  scopeKey: string | null;
  kind: RecommendationDTO['kind'];
  title: string;
  problem: string;
  proposal: string;
  promptPatch: string | null;
  evidence: Evidence[];
  metrics: string[];
  impact: RecommendationDTO['impact'];
  priority: number;
  baselineKey: { metric?: string; gate?: string; cell?: string };
};

const scopeLabel = (scope: string, key: string | null) => {
  if (!key) return 'all calls';
  if (scope === 'persona') return `${key} ${personaById(key).name}`;
  if (scope === 'scenario') return `${key} ${scenarioById(key)?.name ?? ''}`;
  if (scope === 'cell') { const [p, s] = key.split('|'); return `${p} ${personaById(p).name} × ${s} ${scenarioById(s)?.name ?? ''}`; }
  return key;
};

async function quoteEvidence(db: Db, rows: { call_id: string; turn: number | null; metric?: string | null }[]): Promise<Evidence[]> {
  const out: Evidence[] = [];
  for (const r of rows) {
    const c = await db.one<{ canonical: CanonicalCall }>('select canonical from calls where call_id = $1', [r.call_id]);
    const t = r.turn !== null && c?.canonical?.turns ? c.canonical.turns[r.turn] : undefined;
    out.push({ callId: r.call_id, turn: r.turn, quote: t ? t.text.slice(0, 280) : null, metric: r.metric ?? null });
  }
  return out;
}

export async function collectFindings(db: Db, opts: { rangeDays: number; agent: string }): Promise<{ findings: Finding[]; version: string | null; calls: number }> {
  const settings = await getSettings(db);
  const line = settings.goodLine;
  const ver = await resolveVersion(db, 'live', opts.agent);
  const params: unknown[] = [new Date(Date.now() - opts.rangeDays * 86_400_000).toISOString()];
  let where = "c.status = 'scored' and c.started_at > $1";
  if (ver.perAgent) where += ` and ${versionPairsSql(ver.perAgent, (v) => { params.push(v); return `$${params.length}`; })}`;
  else if (ver.label) { params.push(ver.label); where += ` and c.prompt_version = $${params.length}`; }
  if (opts.agent !== 'all') { params.push(opts.agent); where += ` and c.agent_id = $${params.length}`; }
  const total = (await db.one<{ n: number }>(`select count(*)::int as n from calls c where ${where}`, params))?.n ?? 0;
  const findings: Finding[] = [];
  if (!total) return { findings, version: ver.label, calls: 0 };

  // 1. Compliance gates: every failure caps a call at 40 and goes to human review.
  const gateRows = await db.query<{ id: string; call_id: string; turn: number | null; detail: string | null; raw: number; pid: string; sid: string }>(
    `select g->>'id' as id, c.call_id, nullif(g->>'turn','')::int as turn, g->>'detail' as detail, s.raw_cqs as raw, c.persona as pid, c.scenario as sid
     from calls c join call_score s on s.call_id = c.call_id, jsonb_array_elements(s.gates) g where ${where}`,
    params,
  );
  for (const g of GATES) {
    const rows = gateRows.filter((r) => r.id === g.id);
    if (!rows.length) continue;
    const byScen = new Map<string, number>();
    rows.forEach((r) => byScen.set(r.sid, (byScen.get(r.sid) ?? 0) + 1));
    const [topScen, topN] = [...byScen].sort((a, b) => b[1] - a[1])[0];
    const concentrated = rows.length >= 3 && topN / rows.length >= 0.6;
    const pb = PLAYBOOK[g.id];
    const lost = rows.reduce((a, r) => a + Math.max(0, Number(r.raw) - 40), 0);
    findings.push({
      fingerprint: sha(`gate|${g.id}`), scope: concentrated ? 'scenario' : 'global', scopeKey: concentrated ? topScen : null, kind: pb.kind,
      title: pb.title,
      problem: `${g.text.replace(/\.$/, '')} on ${rows.length} call${rows.length > 1 ? 's' : ''} (${((rows.length / total) * 100).toFixed(1)}% of ${total})${concentrated ? `, mostly in ${scopeLabel('scenario', topScen)}` : ''}. Each one caps the call at 40 and sends it to human review.`,
      proposal: pb.fix, promptPatch: pb.promptRule ? `Add to the prompt's compliance rules:\n${pb.promptRule}` : null,
      evidence: await quoteEvidence(db, rows.slice(0, 3).map((r) => ({ call_id: r.call_id, turn: r.turn, metric: g.id }))),
      metrics: [g.id], impact: { calls: rows.length, pointsBelow: Math.round(lost / rows.length), score: Math.round(lost), valueAtStake: null },
      priority: 1000 + lost, baselineKey: { gate: g.id },
    });
  }

  // 2. Metrics below the line, located to the persona, scenario or cell where the shortfall concentrates.
  const mrows = await db.query<{ k: string; pid: string; sid: string; n: number; below: number; pts: number; avg: number }>(
    `select m.metric_key as k, c.persona as pid, c.scenario as sid, count(*)::int as n, count(*) filter (where m.value < $${params.length + 1})::int as below,
       sum(greatest(0, $${params.length + 1} - m.value)) as pts, avg(m.value) as avg
     from metric_result m join calls c on c.call_id = m.call_id where ${where} and m.applicable and m.value is not null group by 1, 2, 3`,
    [...params, line],
  );
  const dimW = Object.fromEntries(DIMS.map((d) => [d.key, settings.weights[d.key] / 100]));
  const metricFindings: Finding[] = [];
  for (const m of METRICS) {
    const rows = mrows.filter((r) => r.k === m.key);
    const n = rows.reduce((a, r) => a + r.n, 0);
    if (n < 10 || !PLAYBOOK[m.key]) continue;
    const avg = rows.reduce((a, r) => a + Number(r.avg) * r.n, 0) / n;
    const below = rows.reduce((a, r) => a + r.below, 0);
    const pts = rows.reduce((a, r) => a + Number(r.pts), 0);
    if (avg >= line && below / n < 0.25) continue;
    const share = (key: (r: (typeof rows)[number]) => string) => {
      const acc = new Map<string, number>();
      rows.forEach((r) => acc.set(key(r), (acc.get(key(r)) ?? 0) + Number(r.pts)));
      const top = [...acc].sort((a, b) => b[1] - a[1])[0];
      return top && pts ? { key: top[0], share: top[1] / pts } : null;
    };
    const cell = share((r) => `${r.pid}|${r.sid}`), pers = share((r) => r.pid), scen = share((r) => r.sid);
    let scope: Finding['scope'] = 'global', scopeKey: string | null = null;
    if (cell && cell.share >= 0.6) { scope = 'cell'; scopeKey = cell.key; }
    else if (scen && scen.share >= 0.6) { scope = 'scenario'; scopeKey = scen.key; }
    else if (pers && pers.share >= 0.6) { scope = 'persona'; scopeKey = pers.key; }
    const pb = PLAYBOOK[m.key];
    const worst = await db.query<{ call_id: string; ev: number[] }>(
      `select m.call_id, m.evidence as ev from metric_result m join calls c on c.call_id = m.call_id
       where ${where} and m.metric_key = $${params.length + 1} and m.applicable and m.value < $${params.length + 2}
       ${scope === 'cell' ? `and c.persona || '|' || c.scenario = $${params.length + 3}` : scope === 'scenario' ? `and c.scenario = $${params.length + 3}` : scope === 'persona' ? `and c.persona = $${params.length + 3}` : ''}
       order by m.value asc, c.started_at desc limit 3`,
      scope === 'global' ? [...params, m.key, line] : [...params, m.key, line, scopeKey],
    );
    const score = pts * (dimW[m.dim] ?? 0.1) * (m.weight ?? 1);
    metricFindings.push({
      fingerprint: sha(`metric|${m.key}|${scope}|${scopeKey ?? ''}`), scope, scopeKey, kind: pb.kind, title: pb.title,
      problem: `${m.name} averages ${Math.round(avg)} (target ${m.target}) over ${n} calls; ${below} (${Math.round((below / n) * 100)}%) fall below ${line}${scope !== 'global' ? `, concentrated in ${scopeLabel(scope, scopeKey)}` : ''}. It sits in ${DIMS.find((d) => d.key === m.dim)!.name}, weight ${settings.weights[m.dim]}.`,
      proposal: pb.fix, promptPatch: pb.promptRule ? `Add to the prompt:\n${pb.promptRule}` : null,
      evidence: await quoteEvidence(db, worst.map((w) => ({ call_id: w.call_id, turn: (w.ev ?? [])[0] ?? null, metric: m.key }))),
      metrics: [m.key], impact: { calls: below, pointsBelow: Math.round(pts / Math.max(1, below)), score: Math.round(score), valueAtStake: null },
      priority: score, baselineKey: { metric: m.key },
    });
  }
  findings.push(...metricFindings.sort((a, b) => b.priority - a.priority).slice(0, 12));

  // 3. The fix-first cells: high value, handled badly.
  const fix = await fixMap(db, { range: String(opts.rangeDays), agent: opts.agent, vm: 'meet' });
  for (const c of fix.top5) {
    const weakDim = c.weak.key;
    const ms = mrows.filter((r) => r.pid === c.pid && r.sid === c.sid && metricByKey(r.k)?.dim === weakDim && r.n >= 3)
      .sort((a, b) => Number(a.avg) - Number(b.avg)).slice(0, 2);
    const keys = ms.map((x) => x.k);
    const fixes = keys.map((k) => `${metricByKey(k)!.name}: ${PLAYBOOK[k]?.fix ?? ''}`).join(' ');
    const rules = keys.map((k) => PLAYBOOK[k]?.promptRule).filter(Boolean);
    const worst = await db.query<{ call_id: string; ev: number[]; k: string }>(
      `select m.call_id, m.evidence as ev, m.metric_key as k from metric_result m join calls c on c.call_id = m.call_id
       where ${where} and c.persona = $${params.length + 1} and c.scenario = $${params.length + 2} and m.metric_key = any($${params.length + 3}::text[]) and m.applicable
       order by m.value asc limit 3`,
      [...params, c.pid, c.sid, keys.length ? keys : ['__none__']],
    );
    findings.push({
      fingerprint: sha(`cell|${c.key}|${weakDim}`), scope: 'cell', scopeKey: c.key, kind: keys[0] ? PLAYBOOK[keys[0]]?.kind ?? 'prompt' : 'prompt',
      title: `Fix first: ${c.pid} × ${c.sid} — ${c.weak.name.toLowerCase()}`,
      problem: `${scopeLabel('cell', c.key)} is high value (meeting-booked rate ${c.meet.toFixed(1)}% against a ${fix.med.toFixed(1)}% median) but handled badly: median CQS ${c.cqs} over ${c.n} calls, weakest dimension ${c.weak.name} at ${c.dims[weakDim]}${keys.length ? `, driven by ${keys.map((k) => metricByKey(k)!.name).join(' and ')}` : ''}.`,
      proposal: fixes || 'Review the lowest calls in this cell and the weakest dimension’s metrics.',
      promptPatch: rules.length ? `Add to the prompt:\n${rules.join('\n')}` : null,
      evidence: await quoteEvidence(db, worst.map((w) => ({ call_id: w.call_id, turn: (w.ev ?? [])[0] ?? null, metric: w.k }))),
      metrics: keys, impact: { calls: c.n, pointsBelow: Math.max(0, settings.goodLine - c.cqs), score: Math.round(c.n * Math.max(1, settings.goodLine - c.cqs)), valueAtStake: +((c.n * c.meet) / 100).toFixed(1) },
      priority: 500 + c.depth * 100, baselineKey: { cell: c.key },
    });
  }

  // 4. Routing: owners, renters and other non-buyers on the sales line.
  const nt = await db.one<{ n: number }>(`select count(*)::int as n from calls c where ${where} and c.persona in ('P9','P10','P11')`, params);
  if (nt && nt.n / total > 0.08) {
    findings.push({
      fingerprint: sha('routing|nontarget'), scope: 'global', scopeKey: null, kind: 'routing', title: 'Route non-buyers away from the sales line',
      problem: `${nt.n} calls (${((nt.n / total) * 100).toFixed(1)}%) were existing owners, renters or other non-buyers. This is usually a routing or marketing problem upstream, not an agent failure.`,
      proposal: 'Report the share to the team that owns each lead source (wrong numbers on ads, residents calling the sales line). Add an IVR option or a separate number for owners and renters; keep the agent’s short, polite redirect.',
      promptPatch: null, evidence: [], metrics: [], impact: { calls: nt.n, pointsBelow: 0, score: nt.n * 5, valueAtStake: null }, priority: nt.n * 5, baselineKey: {},
    });
  }

  // 5. Taxonomy: clusters big enough to become tags, and drift.
  const clusters = await db.query<{ id: string; label: string; size: number; nearest: string | null }>('select id, label, size, nearest from cluster where size >= 20 and not proposed');
  for (const cl of clusters) {
    findings.push({
      fingerprint: sha(`taxonomy|${cl.label.toLowerCase()}`), scope: 'global', scopeKey: null, kind: 'taxonomy', title: `New tag: ${cl.label}`,
      problem: `${cl.size} calls cluster around “${cl.label}”, nearest existing tag ${cl.nearest ?? 'none'}. Calls like these are counted as Other or forced into the nearest tag.`,
      proposal: 'Review the cluster with the taxonomy owner; if it is a distinct journey, add it in the next taxonomy version, write its expected path, and re-tag past calls so trends stay comparable.',
      promptPatch: null, evidence: [], metrics: [], impact: { calls: cl.size, pointsBelow: 0, score: cl.size * 3, valueAtStake: null }, priority: cl.size * 3, baselineKey: {},
    });
  }
  return { findings, version: ver.label, calls: total };
}

// ---------- LLM tailoring ----------

const TailorSchema = {
  type: 'object', additionalProperties: false,
  required: ['title', 'problem', 'proposal', 'patch_mode', 'patch_section', 'patch_before', 'patch_after', 'expected_effect'],
  properties: {
    title: { type: 'string', description: 'Imperative, under 10 words.' },
    problem: { type: 'string', description: 'What goes wrong and how often, in two sentences, citing the numbers given.' },
    proposal: { type: 'string', description: 'The change to make, concrete enough to implement today. Name the tool, prompt section or setting.' },
    patch_mode: { type: 'string', enum: ['add', 'replace', 'none'] },
    patch_section: { type: 'string', description: 'Heading or rule in the current prompt the patch belongs to; empty if none.' },
    patch_before: { type: 'string', description: 'For replace: the exact current prompt text to replace. Empty otherwise.' },
    patch_after: { type: 'string', description: 'The new prompt text to add or to replace it with. Empty for none.' },
    expected_effect: { type: 'string', description: 'Which metric or cell should move, and how the next version report will show it.' },
  },
};
const zTailor = z.object({ title: z.string(), problem: z.string(), proposal: z.string(), patch_mode: z.enum(['add', 'replace', 'none']), patch_section: z.string(), patch_before: z.string(), patch_after: z.string(), expected_effect: z.string() });

async function tailor(f: Finding, prompt: string | null): Promise<Partial<Finding> | null> {
  const client = new Anthropic({ maxRetries: 2, timeout: 10 * 60 * 1000 });
  const rubric = f.metrics.map((k) => metricByKey(k) ? `${metricByKey(k)!.name} (target ${metricByKey(k)!.target})${metricByKey(k)!.rubric ? `: ${metricByKey(k)!.rubric}` : ''}` : gateById(k)?.text ?? k).join('\n');
  const ev = f.evidence.map((e) => `- call ${e.callId}, turn #${e.turn ?? '?'}: “${e.quote ?? ''}”`).join('\n');
  const system = `You improve an AI voice sales agent for a Dubai real-estate developer. You turn evaluation findings into changes a prompt engineer can ship today: prefer one precise prompt edit over general advice, keep the agent's existing structure and tone, and never weaken a compliance rule. If the fix is not a prompt change (a tool, routing, voice or data change), say so and leave the patch empty.`;
  const user = `CURRENT AGENT PROMPT\n${prompt ? prompt.slice(0, 60_000) : '(not available — write the patch as a standalone rule)'}\n\nFINDING\nTitle: ${f.title}\nKind: ${f.kind}\nScope: ${scopeLabel(f.scope, f.scopeKey)}\nProblem: ${f.problem}\nMetric definitions:\n${rubric || '—'}\nPlaybook suggestion: ${f.proposal}${f.promptPatch ? `\nPlaybook rule: ${f.promptPatch}` : ''}\nEvidence from calls:\n${ev || '—'}\n\nWrite the recommendation.`;
  const params: Parameters<Anthropic['beta']['messages']['stream']>[0] = {
    model: config.llm.model,
    max_tokens: 32000,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { effort: config.llm.recommendationEffort, format: { type: 'json_schema', schema: TailorSchema } },
  };
  const send = (fb: boolean) => client.beta.messages.stream(fb ? { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : params).finalMessage();
  let msg;
  try { msg = await send(config.llm.fallbacks); }
  catch (e) { if (e instanceof Anthropic.BadRequestError && /fallback/i.test(e.message)) msg = await send(false); else throw e; }
  if (msg.stop_reason === 'refusal' || msg.stop_reason === 'max_tokens') return null;
  const text = msg.content.filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text').map((b) => b.text).join('');
  const o = zTailor.parse(JSON.parse(text));
  const patch = o.patch_mode === 'none' || !o.patch_after.trim() ? null
    : o.patch_mode === 'replace' && o.patch_before.trim() ? `Replace${o.patch_section ? ` in “${o.patch_section}”` : ''}:\n${o.patch_before.trim()}\n\nWith:\n${o.patch_after.trim()}`
    : `Add${o.patch_section ? ` to “${o.patch_section}”` : ' to the prompt'}:\n${o.patch_after.trim()}`;
  return { title: o.title, problem: o.problem, proposal: `${o.proposal}\n\nExpected effect: ${o.expected_effect}`, promptPatch: patch };
}

export async function generateRecommendations(db: Db, opts: { rangeDays?: number; agent?: string; useLlm?: boolean } = {}) {
  const rangeDays = opts.rangeDays ?? 30, agent = opts.agent ?? 'all';
  const { findings, version } = await collectFindings(db, { rangeDays, agent });
  findings.sort((a, b) => b.priority - a.priority);
  const useLlm = (opts.useLlm ?? true) && llmEnabled();
  let tailored = 0;
  if (useLlm) {
    const agentRow = await db.one<{ prompt_text: string | null }>(`select prompt_text from agent ${agent !== 'all' ? 'where id = $1' : 'order by updated_at desc limit 1'}`, agent !== 'all' ? [agent] : []);
    for (const f of findings.filter((x) => x.kind !== 'taxonomy' && x.kind !== 'routing').slice(0, 8)) {
      const existing = await db.one<{ source: string; status: string; updated_at: Date }>('select source, status, updated_at from recommendation where fingerprint = $1', [f.fingerprint]);
      if (existing?.source === 'llm' && existing.status !== 'proposed') continue;
      try {
        const t = await tailor(f, agentRow?.prompt_text ?? null);
        if (t) { Object.assign(f, t); (f as Finding & { source?: string }).source = 'llm'; tailored++; }
      } catch (e) { log.warn('recommendation tailoring failed; keeping the playbook version', { title: f.title, error: errMsg(e) }); }
    }
  }
  let created = 0, updated = 0;
  const keep = new Set<string>();
  for (const f of findings) {
    keep.add(f.fingerprint);
    const source = (f as Finding & { source?: string }).source ?? 'playbook';
    const cur = await db.one<{ id: string; status: string }>('select id, status from recommendation where fingerprint = $1', [f.fingerprint]);
    if (!cur) {
      await db.query(
        `insert into recommendation (id, scope, scope_key, kind, title, problem, proposal, prompt_patch, evidence, metrics, impact, priority, status, source, baseline, fingerprint)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,'proposed',$13,$14::jsonb,$15)`,
        [newId('rec'), f.scope, f.scopeKey, f.kind, f.title, f.problem, f.proposal, f.promptPatch, JSON.stringify(f.evidence), JSON.stringify(f.metrics), JSON.stringify(f.impact), f.priority, source, JSON.stringify({ version, key: f.baselineKey }), f.fingerprint],
      );
      created++;
    } else if (cur.status === 'proposed') {
      await db.query(
        `update recommendation set scope = $2, scope_key = $3, kind = $4, title = $5, problem = $6, proposal = $7, prompt_patch = $8, evidence = $9::jsonb, metrics = $10::jsonb,
           impact = $11::jsonb, priority = $12, source = $13, baseline = $14::jsonb, updated_at = now() where id = $1`,
        [cur.id, f.scope, f.scopeKey, f.kind, f.title, f.problem, f.proposal, f.promptPatch, JSON.stringify(f.evidence), JSON.stringify(f.metrics), JSON.stringify(f.impact), f.priority, source, JSON.stringify({ version, key: f.baselineKey })],
      );
      updated++;
    } else if (cur.status === 'accepted' || cur.status === 'in_prompt') {
      await db.query('update recommendation set impact = $2::jsonb, evidence = $3::jsonb, priority = $4, updated_at = now() where id = $1', [cur.id, JSON.stringify(f.impact), JSON.stringify(f.evidence), f.priority]);
      updated++;
    }
  }
  // Proposals whose finding has gone away are withdrawn.
  const stale = await db.query<{ id: string; fingerprint: string }>("select id, fingerprint from recommendation where status = 'proposed' and scope <> 'call'");
  let withdrawn = 0;
  for (const s of stale) if (!keep.has(s.fingerprint)) { await db.query('delete from recommendation where id = $1', [s.id]); withdrawn++; }
  const verified = await verifyShipped(db);
  return { created, updated, withdrawn, tailored, verified, version };
}

/** A shipped fix is verified when its target version moves the metric, gate or cell it was for. */
export async function verifyShipped(db: Db): Promise<number> {
  const recs = await db.query<{ id: string; target_version: string | null; baseline: any; metrics: string[] }>("select id, target_version, baseline, metrics from recommendation where status = 'in_prompt' and target_version is not null");
  const settings = await getSettings(db);
  let n = 0;
  for (const r of recs) {
    const from = r.baseline?.version as string | null, to = r.target_version!;
    if (!from || from === to) continue;
    const key = r.baseline?.key ?? {};
    let a: number[] = [], b: number[] = [], label = '';
    if (key.metric) {
      const rows = await db.query<{ v: string; x: number }>("select c.prompt_version as v, m.value as x from metric_result m join calls c on c.call_id = m.call_id where m.metric_key = $1 and m.applicable and c.prompt_version in ($2,$3)", [key.metric, from, to]);
      a = rows.filter((x) => x.v === from).map((x) => Number(x.x)); b = rows.filter((x) => x.v === to).map((x) => Number(x.x));
      label = metricByKey(key.metric)?.name ?? key.metric;
    } else if (key.cell) {
      const [pid, sid] = String(key.cell).split('|');
      const rows = await db.query<{ v: string; x: number }>("select prompt_version as v, cqs as x from calls where status = 'scored' and persona = $1 and scenario = $2 and prompt_version in ($3,$4)", [pid, sid, from, to]);
      a = rows.filter((x) => x.v === from).map((x) => Number(x.x)); b = rows.filter((x) => x.v === to).map((x) => Number(x.x));
      label = `median CQS of ${key.cell}`;
    } else if (key.gate) {
      const rows = await db.query<{ v: string; x: number }>("select c.prompt_version as v, case when s.gates @> $1::jsonb then 0 else 100 end as x from calls c join call_score s on s.call_id = c.call_id where c.prompt_version in ($2,$3)", [JSON.stringify([{ id: key.gate }]), from, to]);
      a = rows.filter((x) => x.v === from).map((x) => Number(x.x)); b = rows.filter((x) => x.v === to).map((x) => Number(x.x));
      label = `${key.gate}-free call share`;
    }
    if (a.length < settings.minCellCalls || b.length < settings.minCellCalls) continue;
    // Pass/fail metrics and gates only take 0 or 100, so their median barely moves; compare pass rates.
    const binary = !!key.gate || [...a, ...b].every((x) => x === 0 || x === 100);
    const stat = binary ? (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length : median;
    if (binary && key.metric) label = `${label} pass rate`;
    const res = bootstrapMedianDiff(a, b, 800, 5, stat);
    if (res.lo > 0) {
      await db.query("update recommendation set status = 'verified', note = $2, updated_at = now() where id = $1", [r.id, `${label} moved from ${stat(a).toFixed(1)} on ${from} to ${stat(b).toFixed(1)} on ${to} (95% interval ${res.lo.toFixed(1)} to ${res.hi.toFixed(1)}, ${a.length} and ${b.length} calls).`]);
      n++;
    } else if (res.hi < 0) {
      await db.query('update recommendation set note = $2, updated_at = now() where id = $1', [r.id, `Regressed: ${label} fell from ${stat(a).toFixed(1)} on ${from} to ${stat(b).toFixed(1)} on ${to} (95% interval ${res.lo.toFixed(1)} to ${res.hi.toFixed(1)}). Check what else changed in ${to}.`]);
    } else {
      await db.query('update recommendation set note = $2, updated_at = now() where id = $1', [r.id, `Not verified yet: ${label} ${stat(a).toFixed(1)} on ${from} → ${stat(b).toFixed(1)} on ${to}; the 95% interval (${res.lo.toFixed(1)} to ${res.hi.toFixed(1)}) still includes zero.`]);
    }
  }
  return n;
}

function toDTO(r: any): RecommendationDTO {
  return {
    id: r.id, scope: r.scope, scopeKey: r.scope_key, kind: r.kind, title: r.title, problem: r.problem, proposal: r.proposal, promptPatch: r.prompt_patch,
    evidence: r.evidence ?? [], metrics: r.metrics ?? [], impact: r.impact ?? { calls: 0, pointsBelow: 0, score: 0, valueAtStake: null }, priority: Number(r.priority),
    status: r.status, source: r.source, targetVersion: r.target_version, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!, note: r.note,
  };
}

export async function listRecommendations(db: Db, opts: { status?: string | null; scope?: string | null; scopeKey?: string | null; kind?: string | null; callId?: string } = {}): Promise<RecommendationDTO[]> {
  const conds: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); conds.push(sql.replace('?', `$${params.length}`)); };
  if (opts.status === 'active') conds.push("status in ('proposed','accepted','in_prompt')");
  else if (opts.status && opts.status !== 'all') add('status = ?', opts.status);
  if (opts.scope === 'call' && opts.scopeKey) {
    // A call's page shows recommendations whose evidence quotes it.
    add('evidence @> ?::jsonb', JSON.stringify([{ callId: opts.scopeKey }]));
  } else {
    if (opts.scope) add('scope = ?', opts.scope);
    if (opts.scopeKey) add('scope_key = ?', opts.scopeKey);
  }
  if (opts.kind) add('kind = ?', opts.kind);
  const rows = await db.query(`select * from recommendation ${conds.length ? `where ${conds.join(' and ')}` : ''} order by case status when 'proposed' then 0 when 'accepted' then 1 when 'in_prompt' then 2 when 'verified' then 3 else 4 end, priority desc limit 200`, params);
  return rows.map(toDTO);
}

export async function updateRecommendation(db: Db, id: string, patch: { status?: string; note?: string | null; targetVersion?: string | null }) {
  const cur = await db.one('select * from recommendation where id = $1', [id]);
  if (!cur) throw Object.assign(new Error('Recommendation not found'), { statusCode: 404 });
  const status = patch.status ?? cur.status;
  if (!['proposed', 'accepted', 'in_prompt', 'verified', 'rejected'].includes(status)) throw Object.assign(new Error('Unknown status'), { statusCode: 400 });
  // Accepting re-baselines on the live version, so verification compares like with like.
  let baseline = cur.baseline;
  if (patch.status === 'accepted' && cur.status === 'proposed') {
    const v = await resolveVersion(db, 'live', 'all');
    baseline = { ...(cur.baseline ?? {}), version: v.label };
  }
  await db.query('update recommendation set status = $2, note = coalesce($3, note), target_version = coalesce($4, target_version), baseline = $5::jsonb, updated_at = now() where id = $1',
    [id, status, patch.note ?? null, patch.targetVersion ?? null, JSON.stringify(baseline)]);
  if (status === 'in_prompt') await verifyShipped(db);
  return toDTO(await db.one('select * from recommendation where id = $1', [id]));
}
