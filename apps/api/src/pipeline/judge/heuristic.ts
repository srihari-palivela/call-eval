// Heuristic judge and classifier: phrase patterns and the tool log stand in for the LLM when no
// Claude API key is configured (demo mode, tests, air-gapped installs). Every result it produces is
// marked layer/method "heuristic" so it is never mistaken for a judged score; with a key configured
// the Claude judge replaces it.

import { PERSONAS, type CanonicalCall, type CanonicalTurn, type Intent } from '@calleval/framework';
import { newId } from '../../lib/ids';
import { lc, moneyAmounts, numbersIn, questionCount, RX, sentiment, stripTags, wordCount, wordsToDigits } from '../text';
import type { ClassifierOutput, ClassifyInput, Judge, JudgeInput, JudgeOutput, JudgedMetric, ScoredTag } from './types';

const PERSONA_SIGNALS: Record<string, RegExp[]> = {
  P1: [/\b(family|kids|children|schools?|my wife|my husband|more space|second bedroom|two kids)\b/i],
  P2: [/\b(first (home|place)|how (does|do) (it|off-plan) work|off-plan works|never bought|first.?time)\b/i],
  P3: [/\b(yield|rental (return|income)|returns?|resale|investment|several units|roi)\b/i],
  P4: [/\b(calling from (london|abroad|the uk|india|overseas)|non-resident|time.?zone|from overseas|outside the uae)\b/i],
  P5: [/\b(we live in (dubai|the uae)|live in dubai marina|upgrade|moving up|relocat|our current (home|place|flat))\b/i],
  P6: [/\b(just looking|only looking|browsing|not sure yet)\b/i],
  P7: [/\bbroker\b.*\b(london|clients in|international|overseas|uk buyers)\b|\bagency in (london|the uk)\b/i],
  P8: [/\b(independent broker|freelance|broker here in dubai|independent, here in dubai)\b/i],
  P9: [/\b(already own|service charge|snagging|my unit|community team|handover of my)\b/i],
  P10: [/\b(looking to rent|want to rent|renting, not buying|rent,? not buy|rental listing)\b/i],
  P11: [/\b(job opening|vacancy|wrong number|supplier|vendor|recruit)\b/i],
};

const PROJECT_RX = /\b(island park residences|seafront one|circle gardens|creek heights)\b/i;
const callerText = (call: CanonicalCall) => call.turns.filter((t) => t.speaker === 'caller').map((t) => t.text).join(' \n ');
const nextAgent = (call: CanonicalCall, idx: number) => call.turns.find((t) => t.idx > idx && t.speaker === 'agent');
const ok = (s: string | undefined) => !/\b(fail|failed|error|unavailable)\b/i.test(s ?? '');

function parseMoney(s: string): number | null {
  return moneyAmounts(s)[0] ?? null;
}

function extractFields(call: CanonicalCall): { fields: Record<string, string | null>; budgetAed: number | null; timelineMonths: number | null } {
  const f: Record<string, string | null> = {};
  let budgetAed: number | null = null, timelineMonths: number | null = null;
  for (const t of call.turns) {
    if (t.speaker !== 'caller') continue;
    const s = stripTags(t.text);
    const name = /\b(?:it'?s|my name is|this is|i'?m) ([A-Z][a-z]+)\b/.exec(s);
    if (name && !/^(a|an|the|just|not|looking|calling|actually|with|independent|buying)$/i.test(name[1])) f.name = name[1];
    const beds = /\b(\d|one|two|three|four)[ -]?(bed|bedroom)s?\b|\b(\d|one|two|three) bedrooms\b/i.exec(s);
    if (beds) f.bedrooms = (beds[1] ?? beds[3]).replace(/one/i, '1').replace(/two/i, '2').replace(/three/i, '3').replace(/four/i, '4');
    const loc = /\b(dubai islands|jvc|dubai creek harbour|creek harbour|dubai marina|business bay|downtown)\b/i.exec(s);
    if (loc && !/\bcompare|seen\b/i.test(s)) f.location = loc[1];
    const money = parseMoney(s);
    if (money && /\b(budget|around|up to|spend|million)\b/i.test(s)) { budgetAed = money; f.budget = `${(money / 1_000_000).toFixed(1).replace(/\.0$/, '')}m AED`; }
    if (/\b(within the year|next (summer|year)|lease ends)\b/i.test(s)) { timelineMonths = 9; f.timeline = '3–12 months'; }
    else if (/\b(next (month|few weeks)|asap|immediately|right away)\b/i.test(s)) { timelineMonths = 1; f.timeline = 'Under 3 months'; }
    else if (/\b(in a (couple|few) of years|no rush|not in a hurry)\b/i.test(s)) { timelineMonths = 24; f.timeline = 'Over 12 months'; }
    const must = s.match(/\b(park|beach|metro|schools?|gym|pool|sea view|quiet)\b/gi);
    if (must && /\b(matters|need|want|for the kids|important|near)\b/i.test(s)) f.must_haves = Array.from(new Set(must.map((x) => x.toLowerCase()))).join(', ');
    if (/\b(four of us|my wife and|the kids|family)\b/i.test(s)) f.who_for = 'Family';
    else if (/\bjust me\b/i.test(s)) f.who_for = 'Self';
    if (/\b(to live in|live in it|for my family|for myself)\b/i.test(s)) f.buy_intent ??= 'Live in';
    if (/\b(investment|invest|rental)\b/i.test(s)) f.buy_intent = 'Investment';
    const type = /\b(apartment|villa|townhouse|penthouse|studio)\b/i.exec(s);
    if (type) f.property_type = type[1].toLowerCase();
    if (/\bagency\b/i.test(s)) f.broker_type = /london|uk/i.test(s) ? 'Agency, overseas' : 'Agency';
    if (/\bindependent\b/i.test(s)) f.broker_type = 'Independent';
    if (/\b(not yet|not registered)\b/i.test(s)) f.registration = 'Unregistered';
    if (/\b(we registered|already registered|yes, we'?re registered)\b/i.test(s)) f.registration = 'Registered';
    const proj = PROJECT_RX.exec(s);
    if (proj) f.project_interest = proj[1];
  }
  for (const t of call.turns) {
    if (t.speaker !== 'agent') continue;
    if (/\b(\d)-bedroom/i.test(t.text) && !f.bedrooms) f.bedrooms = /(\d)-bedroom/i.exec(t.text)![1];
    if (/\bapartment\b/i.test(t.text) && !f.property_type && /\bapartment\b/i.test(callerText(call))) f.property_type = 'apartment';
  }
  return { fields: f, budgetAed, timelineMonths };
}

function intentOf(text: string, booked: boolean, refused: boolean): Intent {
  if (booked) return 'hot';
  if (refused) return 'cold';
  if (/\b(just looking|not sure|not interested|maybe later)\b/i.test(text)) return 'cold';
  if (/\b(lease ends|need more space|want to buy|ready|this month|asap|within the year)\b/i.test(text)) return 'warm';
  return 'warm';
}

export function heuristicClassify(inp: ClassifyInput): ClassifierOutput {
  const { call, ctx, rules } = inp;
  const ct = callerText(call);
  const started = Date.now();
  const ex = extractFields(call);

  // Persona: judged at the end of the call, from all caller text.
  let persona: ScoredTag;
  if (rules.persona) persona = { value: rules.persona.value, confidence: rules.persona.confidence, evidence: rules.persona.evidence };
  else {
    // Specific signals (calling from abroad, first home, broker, owner) outweigh generic ones (investment, family).
    const W: Record<string, number> = { P2: 2, P4: 2, P7: 2, P8: 2, P9: 2, P10: 2, P11: 2, P5: 1.5, P6: 1.5 };
    const scores = Object.entries(PERSONA_SIGNALS).map(([id, rxs]) => {
      let s = 0; const ev: number[] = [];
      for (const t of call.turns) if (t.speaker === 'caller') for (const rx of rxs) if (rx.test(t.text)) { s += W[id] ?? 1; ev.push(t.idx); }
      return { id, s, ev };
    }).sort((a, b) => b.s - a.s);
    const [top, second] = scores;
    if (!top || top.s === 0) {
      const investor = /\b(for myself|buying|invest)\b/i.test(ct) || ctx.persona === 'investor';
      const broker = /\bbroker\b/i.test(ct) || ctx.persona === 'broker';
      persona = broker ? { value: 'P8', confidence: 0.55, evidence: [] } : investor ? { value: 'P1', confidence: 0.5, evidence: [] } : { value: 'P0', confidence: 0.8, evidence: [] };
    } else {
      // Clear winner → high confidence; a tie with another persona → under the review line.
      const margin = (top.s - (second?.s ?? 0)) / top.s;
      persona = { value: top.id, confidence: Math.min(0.96, +(0.6 + margin * 0.3 + Math.min(top.s, 3) * 0.03).toFixed(2)), evidence: Array.from(new Set(top.ev)).slice(0, 4) };
    }
  }
  const pDef = PERSONAS.find((p) => p.id === persona.value);

  // Scenario: the journey that decided the outcome is primary.
  const objections = call.turns.filter((t) => t.speaker === 'caller' && Object.values(RX.objection).some((rx) => rx.test(t.text) && !RX.objection.competitor_mentioned.test(t.text)));
  const booked = call.toolCalls.some((t) => t.name === 'schedule_meeting' && ok(t.resultText));
  const docs = call.toolCalls.some((t) => t.name === 'send_documents');
  const refused = call.turns.some((t) => t.speaker === 'caller' && (RX.refusal.test(stripTags(t.text)) || RX.dnc.test(t.text)));
  const firstCallers = call.turns.filter((t) => t.speaker === 'caller').slice(0, 3);
  const docAskedEarly = firstCallers.some((t) => /\b(send me|brochure)\b/i.test(t.text));
  const namedProject = firstCallers.some((t) => /\b(tell me about|about) .*(residences|gardens|heights|seafront|project)/i.test(t.text));
  const offTopic = call.turns.find((t) => t.speaker === 'caller' && RX.offTopic.test(t.text) && !RX.objection.competitor_mentioned.test(t.text));
  let sp: ScoredTag;
  if (rules.scenarioPrimary) sp = { value: rules.scenarioPrimary.value, confidence: 1, evidence: rules.scenarioPrimary.evidence };
  else if (pDef?.path === 'Non-target') sp = { value: offTopic || pDef.id !== 'P11' ? 'S11' : 'S10', confidence: 0.82, evidence: offTopic ? [offTopic.idx] : [] };
  else if (refused && !booked && !docs && call.turns.filter((t) => t.speaker === 'caller').length <= 4) sp = { value: 'S10', confidence: 0.82, evidence: call.turns.filter((t) => t.speaker === 'caller' && (RX.refusal.test(stripTags(t.text)) || RX.dnc.test(t.text))).map((t) => t.idx).slice(0, 2) };
  else if (rules.scenarioCandidates.includes('S9') && ctx.objective !== 'empty') sp = { value: 'S9', confidence: 0.84, evidence: [0] };
  else if (offTopic && /\b(visa|mortgage|yield|rental return)\b/i.test(offTopic.text) && call.turns.filter((t) => t.speaker === 'caller').indexOf(offTopic) <= 2) sp = { value: 'S11', confidence: 0.8, evidence: [offTopic.idx] };
  else if (docAskedEarly && !booked) sp = { value: 'S3', confidence: 0.84, evidence: firstCallers.filter((t) => /brochure|send me/i.test(t.text)).map((t) => t.idx) };
  else if (namedProject) sp = { value: 'S2', confidence: 0.8, evidence: firstCallers.map((t) => t.idx).slice(0, 2) };
  else if (objections.length && !booked) sp = { value: 'S8', confidence: 0.78, evidence: objections.map((o) => o.idx) };
  else sp = { value: 'S1', confidence: booked ? 0.88 : call.toolCalls.some((t) => t.name === 'get_project_details') ? 0.79 : 0.62, evidence: call.toolCalls.filter((t) => ['get_project_details', 'schedule_meeting'].includes(t.name)).map((t) => t.turnIdx).slice(0, 3) };
  let ss: ScoredTag = { value: null, confidence: 0, evidence: [] };
  if (objections.length && sp.value !== 'S8') ss = { value: 'S8', confidence: 0.7, evidence: objections.map((o) => o.idx) };
  else if (docs && sp.value !== 'S3' && !['S7'].includes(sp.value ?? '')) ss = { value: 'S3', confidence: 0.72, evidence: call.toolCalls.filter((t) => t.name === 'send_documents').map((t) => t.turnIdx) };
  else if (offTopic && sp.value !== 'S11') ss = { value: 'S11', confidence: 0.7, evidence: [offTopic.idx] };

  const firstC = firstCallers.map((t) => t.text).join(' ');
  const lastC = call.turns.filter((t) => t.speaker === 'caller').slice(-3).map((t) => t.text).join(' ');
  const iStart = intentOf(firstC, false, /just looking|not interested/i.test(firstC));
  const iEnd = intentOf(lastC, booked, refused && !booked && !docs);
  const events: { type: string; turn: number }[] = [];
  for (const t of call.turns) {
    if (t.speaker !== 'caller') continue;
    for (const [type, rx] of Object.entries(RX.objection)) if (rx.test(t.text)) events.push({ type, turn: t.idx });
    if (RX.frustration.test(lc(t.text))) events.push({ type: 'frustration', turn: t.idx });
    if (RX.offTopic.test(t.text) && !RX.objection.competitor_mentioned.test(t.text)) events.push({ type: 'off_topic_request', turn: t.idx });
    if (/\b(the (first|quieter|second) one sounds right|that one|i'?ll go with)\b/i.test(t.text)) events.push({ type: 'project_chosen', turn: t.idx });
    if (/\b(in person|come and see|site visit|see it)\b/i.test(t.text)) events.push({ type: 'visit_requested', turn: t.idx });
  }
  const rank = { cold: 0, warm: 1, hot: 2 };
  const last = call.turns[call.turns.length - 1]?.idx ?? 0;
  if (rank[iEnd] > rank[iStart]) events.push({ type: 'intent_rose', turn: last });
  if (rank[iEnd] < rank[iStart]) events.push({ type: 'intent_fell', turn: last });

  const out: ClassifierOutput = {
    persona,
    personaResolvedTurn: null,
    scenarioPrimary: sp,
    scenarioSecondary: ss,
    intentStart: { value: iStart, confidence: 0.7, evidence: firstCallers.map((t) => t.idx).slice(0, 2) },
    intentEnd: { value: iEnd, confidence: 0.75, evidence: call.turns.filter((t) => t.speaker === 'caller').slice(-2).map((t) => t.idx) },
    events,
    fields: ex.fields,
    budgetAed: ex.budgetAed,
    timelineMonths: ex.timelineMonths,
    language: call.language ?? 'en',
    summary: `${pDef?.name ?? 'Unclassified caller'}: ${stripTags(firstCallers[0]?.text ?? '').slice(0, 120)}`,
    run: { id: newId('run'), kind: 'classifier', mode: 'heuristic', model: null, inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - started, status: 'ok' },
  };
  return out;
}

// ---------- Judged metrics ----------

function m(applicable: boolean, raw: number | null, evidence: number[] = [], rationale = ''): JudgedMetric {
  return { applicable, raw: applicable ? raw : null, evidence, rationale };
}

const isFiller = (t: CanonicalTurn) => wordCount(stripTags(t.text)) <= 9 && /\b(let me|one moment|checking|pull that up|look that up|sending|booking|cancelling|moving)\b/i.test(t.text);

export function heuristicJudge(inp: JudgeInput): JudgeOutput {
  const { call, ctx, phases, personaPath, tools } = inp;
  const started = Date.now();
  const turns = call.turns;
  const agent = turns.filter((t) => t.speaker === 'agent');
  const caller = turns.filter((t) => t.speaker === 'caller');
  const out: Record<string, JudgedMetric> = {};
  const hasBody = phases.phases.some((p) => p.name === 'Body');
  const projectCalls = call.toolCalls.filter((t) => t.name === 'get_project_details' && ok(t.resultText));

  // Turn relevance: 2 directly addresses, 1 partly, 0 ignores the caller.
  const rel: { idx: number; s: number }[] = [];
  for (const a of agent) {
    const prev = turns[a.idx - 1];
    if (!prev || prev.speaker !== 'caller') continue;
    const c = lc(prev.text), s = lc(a.text);
    let score = 2;
    if (/\?/.test(c) && questionCount(a.text) >= 1 && !/[.!]\s/.test(stripTags(a.text)) && !isFiller(a)) score = 1;
    if ((RX.correction.test(c) || RX.frustration.test(c)) && !RX.empathy.test(s) && !/\b(sorry|you'?re right)\b/.test(s)) score = Math.min(score, 1);
    if ((RX.refusal.test(stripTags(prev.text)) || RX.dnc.test(c)) && /\b(book|viewing|special|offer|before you go)\b/.test(s)) score = 0;
    if (Object.entries(RX.objection).some(([k, rx]) => k !== 'competitor_mentioned' && rx.test(c)) && /\b(great question|exciting|shouldn'?t miss)\b/.test(s)) score = 0;
    rel.push({ idx: a.idx, s: score });
  }
  out.trel = rel.length ? m(true, +(rel.reduce((x, r) => x + r.s, 0) / rel.length).toFixed(2), rel.filter((r) => r.s < 2).map((r) => r.idx).slice(0, 4), rel.some((r) => r.s < 2) ? 'Some agent turns only partly addressed what the caller just said.' : 'Every agent turn addressed the caller’s last turn.') : m(false, null);

  // Intent recognition: does the agent's next action match the caller's intent?
  let intents = 0, matched = 0; const missEv: number[] = [];
  for (const c of caller) {
    const a = nextAgent(call, c.idx); if (!a) continue;
    const s = lc(c.text), r = lc(a.text);
    intents++;
    let good = true;
    if (/\b(send me|brochure|send it)\b/.test(s) && !/\b(send|which project|whatsapp|email)\b/.test(r)) good = false;
    if (/\b(speak to|person|human)\b/.test(s) && !call.toolCalls.some((t) => t.name === 'request_live_transfer' && t.turnIdx >= a.idx - 1)) good = false;
    if (Object.entries(RX.objection).some(([k, rx]) => k !== 'competitor_mentioned' && rx.test(s)) && !RX.empathy.test(r)) good = false;
    if ((RX.refusal.test(stripTags(c.text)) || RX.dnc.test(s)) && /\b(book|viewing|before you go|special)\b/.test(r)) good = false;
    if (/\?/.test(s) && /\b(how much|price|handover|how big)\b/.test(s) && !RX.projectFact.test(r) && !isFiller(a)) good = false;
    if (good) matched++; else missEv.push(c.idx);
  }
  out.ir = intents ? m(true, +((matched / intents) * 100).toFixed(1), missEv.slice(0, 4), missEv.length ? 'The agent’s next action did not match what the caller asked for.' : '') : m(false, null);

  // Caller repetition.
  const reps: number[] = [];
  caller.forEach((c, i) => {
    if (/\b(i said|i told you|already told|the one we'?ve been talking about|you used it|we said)\b/i.test(c.text)) { reps.push(c.idx); return; }
    const w = new Set(lc(c.text).split(/\s+/).filter((x) => x.length > 3));
    if (w.size >= 3 && caller.slice(0, i).some((p) => { const pw = lc(p.text).split(/\s+/).filter((x) => x.length > 3); return pw.filter((x) => w.has(x)).length / w.size > 0.6; })) reps.push(c.idx);
  });
  out.crep = m(caller.length > 0, reps.length, reps, reps.length ? 'The caller had to repeat themselves.' : '');

  // Repair quality: unclear caller turns met with a clarifying question.
  const unclear = caller.filter((c) => /^(what\??|sorry\??|pardon\??|huh\??)$/i.test(stripTags(c.text)) || (wordCount(c.text) <= 2 && /\?$/.test(c.text)));
  out.rq = unclear.length ? m(true, +((unclear.filter((u) => { const a = nextAgent(call, u.idx); return a && /\b(could you|say that again|repeat|do you mean)\b/i.test(a.text); }).length / unclear.length) * 100).toFixed(1), unclear.map((u) => u.idx)) : m(false, null);

  // Re-ask (judge side) adds asks for project or persona already given.
  const reask = agent.filter((a) => /\b(which project should i|which project were you|may i take your name again|are you buying for yourself, or are you a broker)\b/i.test(a.text) && turns.slice(0, a.idx).some((t) => t.speaker === 'caller' && /\b(residences|project|broker|for myself|it'?s [A-Z])/i.test(t.text)));
  out.reask = m(true, reask.length, reask.map((r) => r.idx), reask.length ? 'Asked for something the caller had already given.' : '');

  // Wrong path: investor treated as broker or the reverse.
  const wrong = agent.filter((a) => (personaPath === 'Investor' && /\b(brokerage|registered (with us )?as a broker|your agency)\b/i.test(a.text)) || (personaPath === 'Broker' && /\b(will it be just you living|to live in yourselves)\b/i.test(a.text)));
  out.wp = m(personaPath === 'Investor' || personaPath === 'Broker', wrong.length, wrong.map((w) => w.idx), wrong.length ? 'Persona misread: questions for the other path.' : '');

  // Context carry-over.
  const detailTurn = caller.find((c) => /\b(kids|children|family|wife|schools|lease ends|leaving)\b/i.test(c.text));
  const contradiction = caller.find((c) => /\bnot (jvc|dubai islands|creek|that one)\b.*\bwe said\b|\bnot .{1,30}— we said\b/i.test(c.text));
  if (contradiction) out.cco = m(true, 0, [contradiction.idx - 1, contradiction.idx], 'The agent offered something that contradicted an earlier detail.');
  else if (detailTurn && agent.some((a) => a.idx > detailTurn.idx + 2)) out.cco = m(true, agent.some((a) => a.idx > detailTurn.idx && /\b(family|kids|for the kids|schools|move date|lease)\b/i.test(a.text)) ? 1 : 0, [detailTurn.idx]);
  else out.cco = m(false, null);

  // Objective honoured.
  if (ctx.objective !== 'empty') {
    const first = agent[0];
    const keys = (ctx.objectiveText ?? '').toLowerCase().split(/\W+/).filter((w) => w.length > 3 && !['send', 'with', 'that', 'this', 'the'].includes(w));
    const hit = first && (ctx.objective === 'callback' ? RX.callbackMention.test(lc(first.text)) : keys.some((k) => lc(first.text).includes(k)) || /\blast time\b/i.test(first.text));
    out.obj = m(true, hit ? 1 : 0, first ? [first.idx] : [], hit ? 'Raised the objective in the first turn.' : 'The objective was not raised in the first agent turn.');
  } else out.obj = m(false, null);

  // Time to first value (inbound).
  const firstQ = caller.find((c) => /\?/.test(c.text));
  if (ctx.direction === 'inbound' && firstQ) {
    const next2 = agent.filter((a) => a.idx > firstQ.idx).slice(0, 2);
    const answered = next2.some((a) => (RX.projectFact.test(lc(a.text)) || /[.!]/.test(stripTags(a.text).replace(/\?.*$/, ''))) && !isFiller(a));
    out.ttfv = m(true, answered ? 1 : 0, [firstQ.idx], answered ? '' : 'The caller’s first question was not answered within two agent turns.');
  } else out.ttfv = m(false, null);

  // React → give → ask.
  if (hasBody) {
    const body = phases.phases.find((p) => p.name === 'Body')!;
    const q = agent.filter((a) => a.idx >= body.from && a.idx <= body.to && turns[a.idx - 1]?.speaker === 'caller' && !isFiller(a) && /\?/.test(a.text));
    // Qualifies when the turn reacts or gives something (a statement) before ending on its one question.
    const good = q.filter((a) => { const sents = stripTags(a.text).split(/(?<=[.!?—])\s+/).filter(Boolean); return sents.length >= 2 && !/\?$/.test(sents[0]) && /\?$/.test(sents[sents.length - 1]) && questionCount(a.text) === 1; });
    out.rga = q.length ? m(true, +((good.length / q.length) * 100).toFixed(1), q.filter((a) => !good.includes(a)).map((a) => a.idx).slice(0, 4)) : m(false, null);
  } else out.rga = m(false, null);

  // Two-option fork.
  const listed = agent.find((a) => /\b(there are (three|four|several)|three that could work)\b/i.test(a.text) || (a.text.match(/\b(residences|gardens|heights|seafront one)\b/gi) ?? []).length >= 3);
  const twoOpt = agent.find((a) => /\btwo (fit|options|that could work)\b/i.test(a.text) || ((a.text.match(/\b(residences|gardens|heights|seafront one)\b/gi) ?? []).length === 2 && /\b(and|while|whereas)\b/i.test(a.text)));
  const multiFit = projectCalls.some((t) => ((t.result as any)?.projects?.length ?? 0) >= 2) || !!listed || !!twoOpt;
  out.tof = multiFit ? m(true, listed ? 0 : twoOpt ? 1 : 0, [(listed ?? twoOpt)?.idx ?? projectCalls[0]?.turnIdx ?? 0].filter((x) => x !== undefined), listed ? 'A list of three or more projects instead of two with a contrast.' : '') : m(false, null);

  // Grounding: every project claim backed by get_project_details output in this call.
  const claims = agent.filter((a) => RX.projectFact.test(lc(wordsToDigits(a.text))));
  const unbacked: number[] = [];
  for (const c of claims) {
    const prior = projectCalls.filter((t) => t.turnIdx <= c.idx);
    if (!prior.length) { unbacked.push(c.idx); continue; }
    // Every amount stated must match a number in the tool output (within rounding, as speech rounds).
    const src = numbersIn(prior.map((t) => t.resultText ?? '').join(' '));
    const amounts = moneyAmounts(c.text);
    if (amounts.some((a) => !src.some((n) => Math.abs(n - a) <= Math.max(1000, a * 0.01)))) unbacked.push(c.idx);
  }
  out.gr = claims.length ? m(true, +(((claims.length - unbacked.length) / claims.length) * 100).toFixed(1), unbacked, unbacked.length ? 'Project facts stated without get_project_details output behind them.' : 'Every project claim matched the tool output.') : m(false, null);

  // Need fit.
  const offered = agent.filter((a) => PROJECT_RX.test(a.text));
  const mismatch = caller.filter((c) => /\bnot .{1,25}(—|-|,) ?we said\b|\bnot (jvc|dubai islands)\b/i.test(c.text));
  out.nf = offered.length ? m(true, Math.max(0, +((1 - mismatch.length / Math.max(1, offered.length)) * 100).toFixed(1)), mismatch.map((x) => x.idx)) : m(false, null);

  // Objection handling.
  const objs = caller.filter((c) => Object.entries(RX.objection).some(([k, rx]) => k !== 'competitor_mentioned' && rx.test(c.text)));
  if (objs.length) {
    const handled = objs.filter((o) => { const a = nextAgent(call, o.idx); return a && RX.empathy.test(lc(a.text)) && /\b(would|could|can i|instead|lower|send|brochure|floor plans|option)\b/i.test(a.text) && !/\b(shouldn'?t miss|prices are only going up)\b/i.test(a.text); });
    out.oh = m(true, +((handled.length / objs.length) * 100).toFixed(1), objs.filter((o) => !handled.includes(o)).map((o) => o.idx));
  } else out.oh = m(false, null);

  // Scope.
  const off = caller.filter((c) => /\b(visa|mortgage|yield|rental return|compare with|dubai marina places|rent,? not buy|job)\b/i.test(c.text));
  if (off.length) {
    const bad = off.filter((o) => { const a = nextAgent(call, o.idx); return !a || RX.yieldAdvice.test(a.text) || RX.visaAdvice.test(a.text) || RX.mortgageAdvice.test(a.text) || /\b(far better|much higher|definitely)\b/i.test(a.text) || /\bhave you thought about buying\b/i.test(a.text); });
    out.sc = m(true, bad.length ? 0 : 1, bad.map((b) => b.idx), bad.length ? 'An off-topic, competitor or yield question was answered instead of redirected.' : '');
  } else out.sc = m(false, null);

  // Confirmation fidelity.
  const bookings = call.toolCalls.filter((t) => ['schedule_meeting', 'schedule_callback'].includes(t.name) && ok(t.resultText));
  if (bookings.length) {
    let exact = 0; const ev: number[] = [];
    for (const b of bookings) {
      const slot = String((b.result as any)?.slot ?? '').toLowerCase();
      const time = String((b.args as any)?.time ?? '');
      const readBack = turns.find((t) => t.idx >= b.turnIdx && t.speaker === 'agent' && /\b(booked|i'?ll call you|moved|now)\b/i.test(t.text));
      const rb = lc(readBack?.text ?? '');
      const hour = time ? String(Number(time.split(':')[0]) % 12 || 12) : '';
      const okRb = !!readBack && (slot ? slot.split(/\s+/).filter((w) => /\d|day/.test(w)).every((w) => rb.includes(w.replace(/[^\w]/g, ''))) : hour ? rb.includes(hour) : true);
      if (okRb) exact++; else ev.push(readBack?.idx ?? b.turnIdx);
    }
    out.cf = m(true, +((exact / bookings.length) * 100).toFixed(1), ev, ev.length ? 'The booking was not read back exactly as the tool returned it.' : '');
  } else out.cf = m(false, null);

  // Close fits the call.
  const refusalIdx = caller.find((c) => RX.refusal.test(stripTags(c.text)) || RX.dnc.test(c.text))?.idx;
  const pushedAfter = refusalIdx !== undefined ? agent.find((a) => a.idx > refusalIdx && /\b(book (you|a)|viewing|before you go|special payment plan)\b/i.test(a.text)) : undefined;
  const lastA = agent[agent.length - 1];
  const nameKnown = inp.fields.name || ctx.customerName;
  const thanked = !nameKnown || (lastA && lastA.text.includes(String(nameKnown)));
  out.cfc = agent.length >= 2 ? m(true, !pushedAfter && thanked ? 1 : 0, [pushedAfter?.idx ?? lastA?.idx ?? 0], pushedAfter ? 'Pushed a meeting after a refusal.' : !thanked ? 'Closed without thanking the caller by name.' : '') : m(false, null);

  // Sentiment change, −2 to +2.
  if (caller.length >= 3) {
    const s0 = (sentiment(caller[0].text) + sentiment(caller[1].text)) / 2;
    const s1 = (sentiment(caller[caller.length - 1].text) + sentiment(caller[caller.length - 2].text)) / 2;
    out.sch = m(true, Math.max(-2, Math.min(2, Math.round((s1 - s0) * 2))), [caller[0].idx, caller[caller.length - 1].idx]);
  } else out.sch = m(false, null);

  // Emotional responsiveness and congruence.
  const shifts = caller.filter((c, i) => i > 0 && Math.abs(sentiment(c.text) - sentiment(caller[i - 1].text)) >= 0.5);
  out.er = shifts.length ? m(true, +((shifts.filter((s) => { const a = nextAgent(call, s.idx); return a && (sentiment(s.text) < 0 ? RX.empathy.test(lc(a.text)) : !RX.empathy.test(lc(a.text)) || true); }).length / shifts.length) * 100).toFixed(1), shifts.map((s) => s.idx)) : m(false, null);
  const mism = agent.filter((a) => { const p = turns[a.idx - 1]; return p?.speaker === 'caller' && sentiment(p.text) < 0 && (RX.enthusiasm.test(stripTags(a.text)) || (a.tags ?? []).includes('enthusiastically') || /\bgreat question\b/i.test(a.text)); });
  out.econ = m(agent.length > 0, mism.length, mism.map((x) => x.idx));

  // Judge-side extras for code + judge metrics.
  out.cc = m(true, caller.filter((c) => RX.correction.test(lc(c.text))).length, caller.filter((c) => RX.correction.test(lc(c.text))).map((c) => c.idx));
  out.ch = m(true, 1, []);
  out.pfd = m(false, null);

  // Gates.
  const gates: JudgeOutput['gates'] = {};
  const unbackedClaim = claims.find((c) => unbacked.includes(c.idx));
  gates.G1 = { failed: !!unbackedClaim, turn: unbackedClaim?.idx ?? null, detail: unbackedClaim ? `Project fact stated with no matching get_project_details output: “${stripTags(unbackedClaim.text).slice(0, 90)}”` : '' };
  const promise = agent.find((a) => RX.promise.test(a.text) && !RX.negated.test(lc(a.text)));
  gates.G2 = { failed: !!promise, turn: promise?.idx ?? null, detail: promise ? 'Promised a guarantee, discount or return.' : '' };
  const advice = agent.find((a) => (RX.yieldAdvice.test(a.text) || RX.visaAdvice.test(a.text) || RX.mortgageAdvice.test(a.text)) && !RX.negated.test(lc(a.text)));
  gates.G3 = { failed: !!advice, turn: advice?.idx ?? null, detail: advice ? 'Gave legal, visa, mortgage or financial advice.' : '' };
  const aiQ = caller.find((c) => RX.askedIfAi.test(c.text));
  const deny = aiQ ? agent.find((a) => a.idx > aiQ.idx && a.idx <= aiQ.idx + 2 && RX.denyAi.test(a.text)) : agent.find((a) => RX.denyAi.test(a.text));
  gates.G4 = { failed: !!deny, turn: deny?.idx ?? null, detail: deny ? 'Denied being an AI.' : '' };
  const other = agent.find((a) => RX.otherCustomer.test(a.text));
  gates.G7 = { failed: !!other, turn: other?.idx ?? null, detail: other ? 'Discussed another customer.' : '' };

  // Path checkpoints the judge decides.
  const checkpoints: JudgeOutput['checkpoints'] = {};
  const find = (rx: RegExp, from = 0, who: 'agent' | 'caller' = 'agent') => turns.find((t) => t.idx >= from && t.speaker === who && rx.test(t.text));
  const objTurn = objs[0]?.idx ?? 0;
  const hints: Record<string, () => CanonicalTurn | undefined> = {
    two_option: () => (twoOpt && !listed ? twoOpt : undefined),
    meeting_fork: () => find(/\b(in person|online walkthrough|site visit|office)\b.*\?/i),
    qualify: () => { const pt = projectCalls[0]?.turnIdx ?? 0; return turns.find((t) => t.idx > pt && t.speaker === 'agent' && /\?/.test(t.text) && /\b(live in|investment|bedrooms|budget|when|who)\b/i.test(t.text)); },
    next_step: () => find(/\b(would you like|shall i|can i send|book|send (you|it)|call with)\b/i),
    confirm: () => find(RX.readBack),
    repeat_time: () => find(/\b(\d{1,2}(:\d\d)?\s*(a\.?m\.?|p\.?m\.?)|today at)\b.*\?/i),
    identified: () => find(/\b(move it|cancel it|which day|another day)\b/i),
    type: () => find(/\b(independent|agency)\b.*\?/i),
    status: () => find(/\bregistered\b.*\?/i),
    brief: () => (projectCalls.length ? turns[projectCalls[0].turnIdx] ?? turns.find((t) => t.idx > projectCalls[0].turnIdx && t.speaker === 'agent') : undefined),
    bdm: () => find(/\b(broker team|partnerships|bdm)\b/i),
    ack: () => (inp.scenario === 'S9' ? (agent[0] && /\b(last time|again|good to hear)\b/i.test(agent[0].text) ? agent[0] : undefined) : find(RX.empathy, objTurn)),
    alternative: () => find(/\b(instead|lower|brochure|floor plans|option|would .* help)\b/i, objTurn),
    soft_end: () => find(/\b(no problem|of course|when you'?re ready|thanks for your time|if you want)\b/i, objTurn),
    objective: () => (ctx.objective === 'empty' ? undefined : turns[tools.nextStepTool?.turnIdx ?? -1] ?? find(/\b(your visit is|sent|booked)\b/i)),
    accept: () => { const r = caller.find((c) => RX.refusal.test(stripTags(c.text)) || RX.dnc.test(c.text)); const a = r ? nextAgent(call, r.idx) : undefined; return a && !/\b(but|before you go|special)\b/i.test(a.text) ? a : undefined; },
    close: () => (lastA && /\b(thank|thanks|goodbye|bye|sorry for the bother)\b/i.test(lastA.text) ? lastA : undefined),
    deflect: () => find(/\b(can'?t (advise|give|help with|compare)|that'?s one for an advisor|best place to look|only sell)\b/i),
    redirect: () => find(/\b(advisor|community team|careers page|brokerage|rental portal)\b/i),
    back: () => find(/\b(in the meantime|can i tell you|what'?s available|anything else)\b/i),
  };
  for (const cp of inp.checkpoints) {
    const t = hints[cp.id]?.();
    checkpoints[cp.id] = { hit: !!t, turn: t?.idx ?? null };
  }

  return {
    metrics: out,
    gates,
    checkpoints,
    coaching: [],
    run: { id: newId('run'), kind: 'judge', mode: 'heuristic', model: null, inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - started, status: 'ok' },
  };
}

export const heuristic: Judge = {
  mode: 'heuristic',
  model: null,
  async classify(i) { return heuristicClassify(i); },
  async judge(i) { return heuristicJudge(i); },
};
