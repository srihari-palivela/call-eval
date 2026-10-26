// Step 2: the opening context. Five facts fixed before the agent says a word decide the expected
// path and which metrics apply: direction, identity, history, objective and persona.

import type { CanonicalCall, ContextRecord, Direction } from '@calleval/framework';
import { lc } from './text';

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : JSON.stringify(v));

function parseFacts(v: unknown): Record<string, unknown> | string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'object') return v as Record<string, unknown>;
  const s = String(v).trim();
  if (!s || s === '{}' || s === '[]' || s.toLowerCase() === 'none') return null;
  try { const o = JSON.parse(s); return o && typeof o === 'object' && Object.keys(o).length ? o : null; } catch { return s; }
}

export function inferDirection(call: CanonicalCall): Direction {
  if (call.direction !== 'unknown') return call.direction;
  const first = call.turns.find((t) => t.speaker === 'agent');
  if (!first) return 'unknown';
  const s = lc(first.text);
  if (/\b(thanks|thank you) for calling\b/.test(s)) return 'inbound';
  if (/\b(calling (you )?(about|from|back|regarding)|this is .{1,40} calling|following up)\b/.test(s)) return 'outbound';
  return 'unknown';
}

export function buildContext(call: CanonicalCall): ContextRecord {
  const dv = call.dynamicVariables ?? {};
  const name = str(dv.customer_name ?? dv.name ?? dv.caller_name);
  const facts = parseFacts(dv.known_facts);
  const history = str(dv.recent_history);
  const objective = str(dv.objective);
  let persona: ContextRecord['persona'] = 'unknown';
  const factText = typeof facts === 'string' ? facts.toLowerCase() : facts ? JSON.stringify(facts).toLowerCase() : '';
  if (/\bbroker\b/.test(factText)) persona = 'broker';
  else if (/\b(investor|buyer|end.?user|family)\b/.test(factText)) persona = 'investor';
  const objectiveKind: ContextRecord['objective'] = !objective ? 'empty' : /call ?back|callback/i.test(objective) ? 'callback' : 'set';
  return {
    direction: inferDirection(call),
    identity: name && !/^(there|unknown|null)$/i.test(name) ? 'known' : 'unknown',
    history: facts || history ? 'returning' : 'new',
    objective: objectiveKind,
    objectiveText: objective || null,
    persona,
    personaSource: persona === 'unknown' ? 'unresolved' : 'history',
    customerName: name || null,
    knownFacts: facts,
  };
}

/** Expected opening per context, as the framework lists it (used by the judge prompt and Context handling). */
export function expectedOpening(ctx: ContextRecord): { expected: string; errors: string } {
  if (ctx.persona !== 'unknown' && ctx.history === 'returning') return { expected: 'Brief acknowledgement of where things stand, then what they need today; skips the persona fork', errors: 'Re-asking anything in known_facts; reading history out as a list; offering a meeting or document already done; asking investor-or-broker again' };
  if (ctx.direction === 'outbound' && ctx.objective === 'callback') return { expected: 'First sentence says this is the callback they asked for', errors: 'A cold introduction' };
  if (ctx.history === 'returning') return { expected: 'Brief acknowledgement of where things stand, then what they need today', errors: 'Re-asking anything in known_facts; reading history out as a list; offering a meeting or document already done' };
  if (ctx.direction === 'outbound') return { expected: 'Warm greeting, check it is a good time, then the persona fork on its own', errors: 'Skipping the time check; stacking a second question onto the fork; “how can I help you”' };
  if (ctx.identity === 'known') return { expected: 'Uses the name, answers first, then the persona fork if still unknown', errors: 'Asking for the name' };
  return { expected: 'Asks if they are looking for a property, answers what they rang about, persona fork, name asked once early', errors: '“Is now a good time”; mentioning an enquiry; running the guide in order; never asking the name' };
}
