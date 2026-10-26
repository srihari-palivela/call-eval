// Reference data for the console: taxonomy, metrics, prompt versions, agents, data mode, settings.

import { DIMS, EVENT_TYPES, FACETS, FRAMEWORK_VERSION, GATES, METRICS, P0, PERSONAS, SCENARIOS, TAXONOMY_VERSION, type MetaDTO } from '@calleval/framework';
import { config, llmEnabled } from '../config';
import { iso, type Db } from '../db';
import { getSettings } from '../lib/settings';
import { versions } from './filters';

export async function meta(db: Db): Promise<MetaDTO> {
  const settings = await getSettings(db);
  const vs = await versions(db, 'all');
  const agents = await db.query<{ id: string; name: string | null; provider: string; external_id: string }>('select id, name, provider, external_id from agent order by name');
  const pvAgents = await db.query<{ label: string; agent_id: string | null; name: string | null }>(
    'select distinct on (pv.label) pv.label, pv.agent_id, a.name from prompt_version pv left join agent a on a.id = pv.agent_id order by pv.label, pv.first_seen_at',
  );
  const totals = await db.one<{ calls: number; scored: number; last: Date | null; live: number; demo: number }>(
    `select count(*)::int as calls, count(*) filter (where status = 'scored')::int as scored, max(started_at) as last,
       count(*) filter (where source <> 'demo')::int as live, count(*) filter (where source = 'demo')::int as demo from calls`,
  );
  const tv = await db.one<{ version: string }>("select version from taxonomy_version where status = 'active' order by created_at desc limit 1");
  const live = vs[vs.length - 1]?.label ?? null;
  return {
    personas: PERSONAS, p0: P0, scenarios: SCENARIOS, dims: DIMS,
    metrics: METRICS.map(({ rubric: _r, ...m }) => m), gates: GATES, eventTypes: EVENT_TYPES, facets: FACETS,
    taxonomyVersion: tv?.version ?? TAXONOMY_VERSION, frameworkVersion: FRAMEWORK_VERSION, weights: settings.weights,
    promptVersions: vs.map((v) => ({ label: v.label, agentId: pvAgents.find((p) => p.label === v.label)?.agent_id ?? null, agentName: pvAgents.find((p) => p.label === v.label)?.name ?? null, firstSeen: iso(v.firstSeen)!, lastSeen: iso(v.lastSeen), calls: v.calls, live: v.label === live })),
    liveVersion: live, previousVersion: vs[vs.length - 2]?.label ?? null,
    agents: agents.map((a) => ({ id: a.id, name: a.name ?? a.external_id, provider: a.provider, externalId: a.external_id })),
    dataMode: (totals?.live ?? 0) > 0 ? 'live' : (totals?.demo ?? 0) > 0 ? 'demo' : 'empty',
    llm: { enabled: llmEnabled(), model: llmEnabled() ? config.llm.model : null },
    audioModel: { enabled: !!config.audioModelUrl },
    totals: { calls: totals?.calls ?? 0, scored: totals?.scored ?? 0, lastCallAt: iso(totals?.last ?? null) },
    settings,
  };
}

/** Taxonomy v1.0 rows, seeded once so versions can be added alongside it. */
export async function seedTaxonomy(db: Db) {
  const has = await db.one('select 1 from taxonomy_version limit 1');
  if (has) return;
  await db.tx(async (t) => {
    await t.query("insert into taxonomy_version (version, status, approved_by, approved_at, notes) values ($1, 'active', 'framework', now(), 'Taxonomy v1.0 from the Call Evaluation Framework; a draft for the sales team to confirm.')", [TAXONOMY_VERSION]);
    const rows: [string, string, string, unknown][] = [
      ...[...PERSONAS, P0].map((p) => [p.id, 'persona', p.name, p] as [string, string, string, unknown]),
      ...SCENARIOS.map((s) => [s.id, 'scenario', s.name, s] as [string, string, string, unknown]),
      ...EVENT_TYPES.map((e) => [e.id, 'event', e.label, e] as [string, string, string, unknown]),
      ...FACETS.map((f) => [f.id, 'facet', f.name, f] as [string, string, string, unknown]),
    ];
    for (const [id, kind, name, def] of rows) await t.query('insert into taxonomy (tag_id, version, kind, name, definition, active_from) values ($1,$2,$3,$4,$5::jsonb, now())', [id, TAXONOMY_VERSION, kind, name, JSON.stringify(def)]);
  });
}
