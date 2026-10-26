// Step 5: code checks. Counts, timings, tool order and duplicates, banned phrases, time limit —
// everything measurable without judging the meaning of the words.

import {
  ALLOWED_DELIVERY_TAGS, BANNED_PHRASES, INVESTOR_DISCOVERY, BROKER_DISCOVERY, quantile, median,
  type CanonicalCall, type CanonicalToolCall, type CanonicalTurn, type ContextRecord, type Phases,
} from '@calleval/framework';
import { BUYER_DISCOVERY_RX, FIELD_ASK_RX, hasNewContact, lc, questionCount, RX, sentiment, stripTags, turnEnd, wordCount } from './text';

export type RawMetric = { raw: number | null; applicable: boolean; evidence: number[]; rationale?: string; value?: number | null };
export type CodeGate = { id: string; failed: boolean; turn: number | null; detail: string | null };
export type ToolAnalysis = {
  expected: { tool: string; turn: number; reason: string; met: boolean }[];
  made: { tc: CanonicalToolCall; correct: boolean; argsOk: boolean; seqOk: boolean; fidelityOk: boolean | null; prompt: boolean | null; why: string[] }[];
  nextStep: 'meeting' | 'callback' | 'document' | 'transfer' | 'note' | null;
  nextStepTool: CanonicalToolCall | null;
  meetingKind: string | null;
  deadAir: { turn: number; gap: number; tool: string }[];
};

export type CodeInput = {
  call: CanonicalCall;
  ctx: ContextRecord;
  phases: Phases;
  personaPath: 'Investor' | 'Broker' | 'Non-target' | '—';
  scenario: string | null;
  fields: Record<string, string | null>;
  /** Turn timing comes from word timestamps or a provider that measures it (not estimated). */
  measuredTiming: boolean;
};

const has = (o: Record<string, unknown>, k: string) => o[k] !== undefined && o[k] !== null && o[k] !== '';
const okResult = (tc: CanonicalToolCall) => tc.ok !== false && !/\b(fail|failed|error|unavailable)\b/i.test(tc.resultText ?? '');
const pct = (a: number, b: number) => (b ? (a / b) * 100 : null);

function responseLatencies(call: CanonicalCall) {
  const out: { turn: number; lat: number }[] = [];
  for (const t of call.turns) {
    if (t.speaker !== 'agent') continue;
    const prev = call.turns[t.idx - 1];
    if (!prev || prev.speaker !== 'caller') continue;
    const lat = t.latencyS ?? (t.startS - turnEnd(prev));
    if (isFinite(lat) && lat > -2 && lat < 60) out.push({ turn: t.idx, lat: Math.max(0, lat) });
  }
  return out;
}

export function analyseTools(call: CanonicalCall, ctx: ContextRecord, personaPath: CodeInput['personaPath']): ToolAnalysis {
  const turns = call.turns;
  const expected: ToolAnalysis['expected'] = [];
  const made: ToolAnalysis['made'] = [];
  const calledBefore = (name: string, idx: number) => call.toolCalls.some((tc) => tc.name === name && tc.turnIdx <= idx && okResult(tc));
  const toolsAt = (idx: number) => call.toolCalls.filter((tc) => tc.turnIdx === idx);

  // Expected calls: every moment a tool's trigger fired.
  for (const t of turns) {
    const s = lc(t.text);
    if (t.speaker === 'agent' && RX.projectFact.test(s)) expected.push({ tool: 'get_project_details', turn: t.idx, reason: 'Project fact stated', met: calledBefore('get_project_details', t.idx) });
    if (t.speaker !== 'caller') continue;
    const nextA = turns.find((x) => x.idx > t.idx && x.speaker === 'agent');
    const within = (name: string, n = 2) => call.toolCalls.some((tc) => tc.name === name && tc.turnIdx > t.idx && tc.turnIdx <= (turns.filter((x) => x.idx > t.idx && x.speaker === 'agent')[n - 1]?.idx ?? Infinity));
    if (/\b(it'?s|i'?m|my name is|this is) [A-Z][a-z]+\b/.test(stripTags(t.text)) || /@|\b\d{7,}\b/.test(t.text)) expected.push({ tool: 'update_caller_details', turn: t.idx, reason: 'Caller gave a contact detail', met: within('update_caller_details', 1) });
    if (/\b(send (me|it|over)|brochure|floor plans?)\b/i.test(s) && !/\bno\b/.test(s)) expected.push({ tool: 'send_documents', turn: t.idx, reason: 'Caller asked for a document', met: within('send_documents', 3) });
    if (/\b(call me (back|later)|call back later|can you call me)\b/i.test(s)) expected.push({ tool: 'schedule_callback', turn: t.idx, reason: 'Caller asked to be called later', met: within('schedule_callback', 4) });
    if (/\b(speak to (a|someone|an?) (person|human|advisor|agent)|real person|transfer me)\b/i.test(s)) expected.push({ tool: 'request_live_transfer', turn: t.idx, reason: 'Caller wants a person now', met: within('request_live_transfer', 2) });
    if (/\bcancel (it|the (visit|meeting))\b/i.test(s)) expected.push({ tool: 'cancel_meeting', turn: t.idx, reason: 'Caller cancelled', met: within('cancel_meeting', 2) });
    if (personaPath === 'Broker' && /\b(no,? not yet|not registered|aren'?t registered)\b/i.test(s)) expected.push({ tool: 'send_broker_registration_link', turn: t.idx, reason: 'Unregistered broker', met: within('send_broker_registration_link', 2) });
    void nextA;
  }
  const transferTo = call.toolCalls.find((tc) => tc.name === 'request_live_transfer' && /transfer_to/i.test(tc.resultText ?? ''));
  if (transferTo) expected.push({ tool: 'transfer_to_number', turn: transferTo.turnIdx, reason: 'request_live_transfer returned transfer_to', met: call.toolCalls.some((tc) => tc.name === 'transfer_to_number') });
  if (call.endReason === 'natural_close' && call.provider !== 'upload') expected.push({ tool: 'end_call', turn: turns[turns.length - 1]?.idx ?? 0, reason: 'Conclusion finished', met: call.toolCalls.some((tc) => tc.name === 'end_call') });

  // Calls made, checked against the tool map.
  const seenDocs = new Set<string>();
  for (const tc of call.toolCalls) {
    const a = tc.args as Record<string, unknown>;
    const why: string[] = [];
    let correct = true, argsOk = true, seqOk = true;
    let fidelityOk: boolean | null = null;
    let prompt: boolean | null = null;
    const before = turns.filter((t) => t.idx < tc.turnIdx).slice(-4);
    const at = turns[tc.turnIdx];
    switch (tc.name) {
      case 'send_broker_registration_link':
        if (personaPath !== 'Broker') { correct = false; why.push('Called for a non-broker'); }
        if (!('registered' in a)) { argsOk = false; why.push('registered missing'); }
        if (!has(a, 'channel')) { argsOk = false; why.push('channel missing'); }
        prompt = !turns.some((t) => t.speaker === 'caller' && t.idx < tc.turnIdx - 4 && /\b(not yet|not registered)\b/i.test(t.text));
        break;
      case 'send_documents': {
        const key = JSON.stringify(a.project_ids ?? a.project_id ?? '') + String(a.doc_type ?? '');
        if (seenDocs.has(key)) { correct = false; why.push('Duplicate send'); }
        seenDocs.add(key);
        const asked = before.some((t) => t.speaker === 'caller' && /\b(yes|send|brochure|floor plan|please)\b/i.test(t.text));
        if (!asked) { correct = false; why.push('Unsolicited send'); }
        if (!has(a, 'channel')) { argsOk = false; why.push('channel missing'); }
        {
          // The destination must be named before the send ("the number ending 47", "this number").
          // A number or email the caller has just given must also be read back and confirmed.
          const named = turns.some((t) => t.speaker === 'agent' && t.idx <= tc.turnIdx && t.idx >= tc.turnIdx - 4 && RX.readBack.test(t.text));
          const confirmed = before.some((t) => t.speaker === 'caller' && /\b(yes|that one|correct|right|fine)\b/i.test(t.text));
          const fresh = turns.some((t) => t.speaker === 'caller' && t.idx < tc.turnIdx && hasNewContact(t.text));
          if (!named || (fresh && !confirmed)) { seqOk = false; why.push('No read-back before the send'); }
        }
        break;
      }
      case 'schedule_meeting': {
        const kind = String(a.meeting_kind ?? '');
        if (!['site_visit', 'online', 'office', 'bdm_call'].includes(kind)) { argsOk = false; why.push('meeting_kind missing or unknown'); }
        if (!has(a, 'date') || !has(a, 'time')) { argsOk = false; why.push('date or time missing'); }
        if (kind === 'site_visit' && !(Array.isArray(a.project_ids) && a.project_ids.length)) { argsOk = false; why.push('site visit without a project'); }
        if (personaPath === 'Investor' && !turns.some((t) => t.speaker === 'agent' && t.idx <= tc.turnIdx && /\b(in person|online|walkthrough|office|site visit)\b.*\?/i.test(t.text))) { seqOk = false; why.push('Meeting fork skipped'); }
        if (personaPath === 'Broker' && !call.toolCalls.some((x) => x.name === 'send_broker_registration_link' && x.turnIdx <= tc.turnIdx) && !/registered/i.test(turns.filter((t) => t.speaker === 'caller').map((t) => t.text).join(' '))) { seqOk = false; why.push('Registration link not sent first'); }
        break;
      }
      case 'schedule_callback':
        if (!has(a, 'time')) { argsOk = false; why.push('time missing'); }
        if (!before.some((t) => t.speaker === 'agent' && /\b(\d{1,2}(:\d\d)?\s*(a\.?m\.?|p\.?m\.?)|today at|tomorrow at)\b.*\?/i.test(t.text))) { seqOk = false; why.push('Time not repeated back'); }
        break;
      case 'request_live_transfer':
        if (!(at && at.speaker === 'agent' && tc.startS !== undefined && tc.startS >= at.startS - 0.01)) { seqOk = false; why.push('No filler line before the transfer request'); }
        break;
      case 'transfer_to_number': {
        const req = call.toolCalls.find((x) => x.name === 'request_live_transfer' && /transfer_to/i.test(x.resultText ?? ''));
        if (!req) { correct = false; why.push('No transfer_to result before it'); }
        break;
      }
      case 'update_caller_details': {
        const keys = Object.keys(a);
        if (keys.some((k) => ['budget', 'bedrooms', 'location'].includes(k))) { correct = false; why.push('Used for budget, bedrooms or location'); }
        const given = turns.filter((t) => t.speaker === 'caller' && t.idx < tc.turnIdx && /\b(it'?s|my name is|i'?m) [A-Z][a-z]+/.test(stripTags(t.text))).slice(-1)[0];
        if (given) {
          const agentTurnsBetween = turns.filter((t) => t.speaker === 'agent' && t.idx > given.idx && t.idx <= tc.turnIdx).length;
          prompt = agentTurnsBetween <= 1;
        }
        break;
      }
      case 'end_call': {
        const last = turns.filter((t) => t.speaker === 'agent' && t.idx <= tc.turnIdx).slice(-1)[0];
        if (!last || !/\b(goodbye|bye|have a (good|great|nice))\b/i.test(last.text)) { seqOk = false; why.push('Ended without a farewell'); }
        if (call.toolCalls.some((x) => x.name === 'request_live_transfer' && /transfer_to/i.test(x.resultText ?? '')) && !call.toolCalls.some((x) => x.name === 'transfer_to_number')) { correct = false; why.push('Ended during a transfer'); }
        break;
      }
    }
    // Result fidelity: what the agent says next must match what the tool returned.
    const nextAgent = turns.filter((t) => t.speaker === 'agent' && t.idx >= tc.turnIdx).slice(0, 2);
    if (tc.resultText !== undefined && nextAgent.length && tc.name !== 'end_call') {
      const claimsSuccess = nextAgent.some((t) => /\b(done|sent|booked|you'?re (all )?(booked|set)|cancell?ed|on (its|your) way|putting you through|connecting you)\b/i.test(t.text));
      const saysFailure = nextAgent.some((t) => /\b(didn'?t go through|instead|not available|nobody is free|has just gone|couldn'?t|sorry)\b/i.test(t.text));
      fidelityOk = okResult(tc) ? true : !claimsSuccess || saysFailure;
      if (!okResult(tc) && claimsSuccess && !saysFailure) why.push('Claimed success after a failed result');
    }
    made.push({ tc, correct, argsOk, seqOk, fidelityOk, prompt, why });
  }

  // Next step secured: a meeting, callback, document sent, live transfer or saved note confirmed by the tool.
  const order: [string, ToolAnalysis['nextStep']][] = [['schedule_meeting', 'meeting'], ['transfer_to_number', 'transfer'], ['schedule_callback', 'callback'], ['send_documents', 'document'], ['save_note', 'note']];
  let nextStep: ToolAnalysis['nextStep'] = null, nextStepTool: CanonicalToolCall | null = null;
  for (const [name, kind] of order) {
    const tc = call.toolCalls.find((x) => x.name === name && okResult(x) && !(name === 'save_note' && /do-not-contact|dnc/i.test(JSON.stringify(x.args))));
    if (tc) { nextStep = kind; nextStepTool = tc; break; }
  }
  const meetingKind = nextStep === 'meeting' ? String((nextStepTool?.args as any)?.meeting_kind ?? '') || null : null;

  // Tool dead air: a tool that ran before the agent said anything, leaving the caller in silence.
  const deadAir: ToolAnalysis['deadAir'] = [];
  for (const tc of call.toolCalls) {
    if (['end_call', 'transfer_to_number'].includes(tc.name)) continue;
    const t = turns[tc.turnIdx];
    if (!t || t.speaker !== 'agent') continue;
    const prev = turns[t.idx - 1];
    const startedBeforeSpeech = tc.startS !== undefined ? tc.startS < t.startS - 0.05 : false;
    if (!startedBeforeSpeech || !prev) continue;
    const gap = t.startS - turnEnd(prev);
    if (gap > 0) deadAir.push({ turn: t.idx, gap, tool: tc.name });
  }
  void ctx;
  return { expected, made, nextStep, nextStepTool, meetingKind, deadAir };
}

export function codeMetrics(inp: CodeInput, tools: ToolAnalysis): Record<string, RawMetric> {
  const { call, ctx, phases, personaPath } = inp;
  const turns = call.turns;
  const agent = turns.filter((t) => t.speaker === 'agent');
  const caller = turns.filter((t) => t.speaker === 'caller');
  const m: Record<string, RawMetric> = {};
  const hasBody = phases.phases.some((p) => p.name === 'Body');
  const bodyTurns = (pred: (t: CanonicalTurn) => boolean) => {
    const b = phases.phases.find((p) => p.name === 'Body');
    return b ? turns.filter((t) => t.idx >= b.from && t.idx <= b.to && pred(t)) : [];
  };

  // ---------- Voice and timing ----------
  const lats = responseLatencies(call);
  if (lats.length) {
    const xs = lats.map((l) => l.lat);
    const p50 = quantile(xs, 0.5), p90 = quantile(xs, 0.9);
    const s50 = p50 <= 1.2 ? 100 : p50 >= 2.5 ? 0 : ((2.5 - p50) / 1.3) * 100;
    const s90 = p90 <= 2.5 ? 100 : p90 >= 4 ? 0 : ((4 - p90) / 1.5) * 100;
    const worst = [...lats].sort((a, b) => b.lat - a.lat)[0];
    m.rl = { raw: +p90.toFixed(2), applicable: true, value: Math.round(Math.min(s50, s90)), evidence: [worst.turn], rationale: `p50 ${p50.toFixed(1)} s, p90 ${p90.toFixed(1)} s; slowest turn #${worst.turn} at ${worst.lat.toFixed(1)} s.` };
  } else m.rl = { raw: null, applicable: false, evidence: [] };

  if (call.toolCalls.length) {
    const worst = [...tools.deadAir].sort((a, b) => b.gap - a.gap)[0];
    m.tda = { raw: worst ? +worst.gap.toFixed(2) : 0, applicable: true, evidence: worst ? [worst.turn] : [], rationale: worst ? `${worst.gap.toFixed(1)} s of silence while ${worst.tool} ran with no filler line.` : 'Every blocking tool call had a filler line before it.' };
  } else m.tda = { raw: null, applicable: false, evidence: [] };

  const silences = lats.filter((l) => l.lat > 4);
  m.ls = { raw: silences.length, applicable: lats.length > 0, evidence: silences.map((s) => s.turn), rationale: silences.length ? `${silences.length} gap(s) over 4 s on the agent's turn.` : undefined };

  const barges = caller.filter((c) => {
    const prev = turns[c.idx - 1];
    if (!prev || prev.speaker !== 'agent') return false;
    if (RX.backchannel.test(stripTags(c.text))) return false;
    return prev.interrupted || c.startS < turnEnd(prev) - 0.15;
  });
  m.cbr = { raw: agent.length ? +((barges.length / agent.length) * 100).toFixed(1) : null, applicable: agent.length > 0, evidence: barges.map((b) => b.idx) };
  if (barges.length) {
    const recovered = barges.filter((b) => {
      const prevAgent = turns[b.idx - 1];
      const nextA = turns.find((t) => t.idx > b.idx && t.speaker === 'agent');
      if (!nextA) return true;
      const pw = new Set(lc(prevAgent.text).split(/\s+/));
      const nw = lc(nextA.text).split(/\s+/);
      const overlap = nw.filter((w) => pw.has(w) && w.length > 3).length / Math.max(1, nw.length);
      return overlap < 0.6;
    });
    m.br = { raw: +((recovered.length / barges.length) * 100).toFixed(1), applicable: true, evidence: barges.map((b) => b.idx) };
  } else m.br = { raw: null, applicable: false, evidence: [] };

  const cutIns = agent.filter((a) => {
    const prev = turns[a.idx - 1];
    return prev && prev.speaker === 'caller' && inp.measuredTiming && a.startS < turnEnd(prev) - 0.2;
  });
  m.aci = { raw: caller.length ? +((cutIns.length / caller.length) * 100).toFixed(1) : null, applicable: inp.measuredTiming && caller.length > 0, evidence: cutIns.map((c) => c.idx) };

  const wc = agent.map((a) => wordCount(stripTags(a.text)));
  if (wc.length) {
    const med = median(wc), long = wc.filter((w) => w > 50).length / wc.length;
    const sMed = med <= 30 ? 100 : med >= 45 ? 0 : ((45 - med) / 15) * 100;
    const sLong = long <= 0.1 ? 100 : long >= 0.3 ? 0 : ((0.3 - long) / 0.2) * 100;
    const longest = agent[wc.indexOf(Math.max(...wc))];
    m.atl = { raw: med, applicable: true, value: Math.round(Math.min(sMed, sLong)), evidence: [longest.idx], rationale: `Median ${med} words; ${(long * 100).toFixed(0)}% of turns over 50 words.` };
  } else m.atl = { raw: null, applicable: false, evidence: [] };

  const dur = (ts: CanonicalTurn[]) => ts.reduce((a, t) => a + Math.max(0, turnEnd(t) - t.startS), 0);
  const aDur = dur(agent), cDur = dur(caller);
  m.tr = { raw: aDur + cDur > 0 ? +((aDur / (aDur + cDur)) * 100).toFixed(1) : null, applicable: aDur + cDur > 0 && caller.length > 1, evidence: [] };

  m.sra = { raw: null, applicable: false, evidence: [] }; // needs a human-checked reference transcript

  const entityTurns = caller.filter((c) => /\b(it'?s|my name is|i'?m) [A-Z][a-z]+|@|\b\d{7,}\b|\b(one|two|three|four|\d) bed/i.test(stripTags(c.text)) || Object.values(inp.fields).some((v) => v && v.length > 1 && c.text.includes(v)));
  const entityCorrections = caller.filter((c) => RX.correction.test(lc(c.text)) && /\b(name|said|not|we said)\b/i.test(c.text));
  m.ent = entityTurns.length
    ? { raw: +(100 * (1 - Math.min(entityCorrections.length, entityTurns.length) / entityTurns.length)).toFixed(1), applicable: true, evidence: entityCorrections.map((c) => c.idx) }
    : { raw: null, applicable: false, evidence: [] };

  const artefacts: number[] = [];
  for (const a of agent) {
    const unknownTags = (a.tags ?? []).filter((t) => !ALLOWED_DELIVERY_TAGS.includes(t));
    if (unknownTags.length || /[*#_`]|https?:\/\/|\{\{|\}\}|<[a-z]+>/i.test(a.text)) artefacts.push(a.idx);
  }
  m.va = { raw: artefacts.length, applicable: agent.length > 0, evidence: artefacts, rationale: artefacts.length ? 'Delivery tags, symbols or markup that the voice would read aloud.' : undefined };

  // ---------- Understanding (code parts) ----------
  const corrections = caller.filter((c) => RX.correction.test(lc(c.text)));
  m.cc = { raw: corrections.length, applicable: caller.length > 0, evidence: corrections.map((c) => c.idx) };

  const reasks: number[] = [];
  const knownText = typeof ctx.knownFacts === 'string' ? ctx.knownFacts.toLowerCase() : ctx.knownFacts ? JSON.stringify(ctx.knownFacts).toLowerCase() : '';
  for (const a of agent) {
    const s = lc(a.text);
    for (const [field, rx] of Object.entries(FIELD_ASK_RX)) {
      if (!rx.test(s) || !/\?/.test(a.text)) continue;
      const givenEarlier = caller.some((c) => c.idx < a.idx && (field === 'name' ? /\b(it'?s|my name is|i'?m) [A-Z][a-z]+/.test(stripTags(c.text)) : field === 'persona' ? /\b(broker|for myself|for my family|invest)/i.test(c.text) : field === 'project_interest' ? /\b(residences|gardens|heights|seafront|project)\b/i.test(c.text) : field === 'bedrooms' ? /\bbed(room)?s?\b/i.test(c.text) : field === 'budget' ? /\b(million|budget|aed|dirhams)\b/i.test(c.text) : false));
      const known = (field === 'name' && ctx.identity === 'known') || (field !== 'name' && knownText.includes(field.replace('_interest', '')))
        || (field === 'persona' && ctx.persona !== 'unknown') || (field === 'project_interest' && /interest|project/.test(knownText));
      if (givenEarlier || known) { reasks.push(a.idx); break; }
    }
  }
  m.reask = { raw: reasks.length, applicable: agent.length > 0, evidence: reasks, rationale: reasks.length ? 'Asked for something already given in this call or in known_facts.' : undefined };

  m.fca = { raw: null, applicable: false, evidence: [] }; // filled when an answer key exists

  // ---------- Introduction (code parts) ----------
  const firstAgent = agent[0];
  const agentIdx = (n: number) => agent[n - 1]?.idx ?? Infinity;
  if (firstAgent) {
    const errs: string[] = [];
    const s = lc(firstAgent.text);
    if (ctx.direction === 'outbound' && ctx.objective === 'empty' && ctx.history === 'new') {
      if (!RX.timeCheck.test(s)) errs.push('skipped the time check');
      if (RX.howCanIHelp.test(s)) errs.push('“how can I help” on an outbound call');
    }
    if (ctx.direction === 'outbound' && ctx.objective === 'callback' && !RX.callbackMention.test(s)) errs.push('a cold introduction on a requested callback');
    if (ctx.direction === 'inbound' && RX.timeCheck.test(s)) errs.push('“is now a good time” on an inbound call');
    if (ctx.history === 'returning' && (wordCount(s) > 35 || (s.match(/,/g) ?? []).length >= 3)) errs.push('read the history out as a list');
    if (ctx.identity === 'known' && agent.some((a) => a.idx <= agentIdx(4) && RX.nameAsk.test(lc(a.text)))) errs.push('asked for a name already known');
    if (ctx.persona !== 'unknown' && agent.some((a) => RX.personaFork.test(lc(a.text)))) errs.push('asked investor-or-broker again');
    m.ch = { raw: errs.length ? 0 : 1, applicable: true, evidence: errs.length ? [firstAgent.idx] : [], rationale: errs.length ? `Opening ${errs.join('; ')}.` : 'Opening matches its context.' };
  }

  const forkTurn = agent.find((a) => RX.personaFork.test(lc(a.text)));
  // The caller settled the persona themselves before any fork was asked ("I'm a broker", "for myself").
  const volunteerTurn = turns.find((t) => t.speaker === 'caller' && /\b(i'?m (a|an independent) broker|broker, actually|for myself|as an investment|looking at investments|i'?m an investor)\b/i.test(t.text));
  const personaVolunteered = !!volunteerTurn && (!forkTurn || volunteerTurn.idx < forkTurn.idx);
  if (ctx.persona === 'unknown' && personaPath !== 'Non-target' && !(personaVolunteered && !forkTurn)) {
    if (!forkTurn) m.pfd = { raw: 0, applicable: true, evidence: [], rationale: 'The investor-or-broker fork was never asked.' };
    else {
      const alone = questionCount(forkTurn.text) <= 1 && !/\b(and|also)\b[^?]*\?/.test(lc(forkTurn.text).split(/broker/)[1] ?? '') && !RX.liveOrInvest.test(lc(forkTurn.text).replace(/\binvestor\b/, ''));
      const onTime = forkTurn.idx <= (ctx.direction === 'outbound' ? agentIdx(2) : agentIdx(3));
      const askedAfterVolunteer = personaVolunteered;
      m.pfd = { raw: alone && onTime && !askedAfterVolunteer ? 1 : 0, applicable: true, evidence: [forkTurn.idx], rationale: [!alone && 'paired with another question', !onTime && 'asked late', askedAfterVolunteer && 'asked after the caller had already said'].filter(Boolean).join('; ') || 'Asked alone and on time.' };
    }
  } else m.pfd = { raw: null, applicable: false, evidence: [] };

  const nameAsks = agent.filter((a) => RX.nameAsk.test(lc(a.text)));
  if (ctx.identity === 'unknown') {
    const first = nameAsks[0];
    const byFive = first ? first.idx <= agentIdx(5) : false;
    const given = first ? caller.find((c) => c.idx > first.idx) : undefined;
    const saved = given ? call.toolCalls.some((tc) => tc.name === 'update_caller_details' && tc.turnIdx > given.idx && tc.turnIdx <= (turns.find((t) => t.idx > given.idx && t.speaker === 'agent')?.idx ?? -1)) : false;
    const short = turns.length < 6 || personaPath === 'Non-target';
    m.nc = short && !first ? { raw: null, applicable: false, evidence: [] } : { raw: first && byFive && nameAsks.length === 1 && saved ? 1 : 0, applicable: true, evidence: first ? [first.idx] : [], rationale: !first ? 'Name never asked.' : [!byFive && 'asked after agent turn 5', nameAsks.length > 1 && 'asked more than once', !saved && 'update_caller_details not called in that turn'].filter(Boolean).join('; ') || 'Asked once, early, and saved.' };
  } else m.nc = { raw: nameAsks.length ? 0 : 1, applicable: true, evidence: nameAsks.map((a) => a.idx), rationale: nameAsks.length ? 'Asked for a name that was already known.' : 'Used the known name.' };

  // ---------- Body (code parts) ----------
  // Discovery only has an opportunity in journeys built on it (discovery, enquiry, objection, broker onboarding).
  if (hasBody && (personaPath === 'Investor' || personaPath === 'Broker') && ['S1', 'S2', 'S7', 'S8'].includes(inp.scenario ?? '')) {
    const spec = personaPath === 'Broker' ? BROKER_DISCOVERY : INVESTOR_DISCOVERY;
    const covered = spec.filter((f) => f.fields.some((k) => inp.fields[k] && inp.fields[k] !== 'Not captured' || (knownText && knownText.includes(k.replace('_', ' ')))));
    m.dc = { raw: +((covered.length / spec.length) * 100).toFixed(1), applicable: true, evidence: [], rationale: `${covered.length} of ${spec.length} discovery fields captured (${spec.filter((f) => !covered.includes(f)).map((f) => f.label.toLowerCase()).join(', ') || 'none missing'}).` };
  } else m.dc = { raw: null, applicable: false, evidence: [] };

  if (hasBody) {
    const viol: number[] = [];
    const bAgent = bodyTurns((t) => t.speaker === 'agent');
    bAgent.forEach((a, i) => {
      if (questionCount(a.text) >= 2) viol.push(a.idx);
      const prevA = bAgent[i - 1];
      if (prevA && prevA.idx === a.idx - 2 && RX.bareQuestion.test(stripTags(a.text)) && RX.bareQuestion.test(stripTags(prevA.text))) viol.push(a.idx);
    });
    m.qd = { raw: viol.length, applicable: bAgent.length > 0, evidence: viol, rationale: viol.length ? `${viol.length} turn(s) with two questions, or two bare questions in a row.` : undefined };
  } else m.qd = { raw: null, applicable: false, evidence: [] };

  const ecal: number[] = [];
  let sighs = 0;
  agent.forEach((a, i) => {
    const s = lc(a.text);
    if (BANNED_PHRASES.some((p) => s.includes(p))) ecal.push(a.idx);
    const tags = a.tags ?? [];
    if (tags.some((t) => !ALLOWED_DELIVERY_TAGS.includes(t))) ecal.push(a.idx);
    const sents = a.text.split(/(?<=[.!?])\s+/);
    if (sents.some((x) => (x.match(/\[[a-z]/gi) ?? []).length > 1)) ecal.push(a.idx);
    sighs += tags.filter((t) => t === 'sighs').length;
    const prevCaller = turns[a.idx - 1]?.speaker === 'caller' ? turns[a.idx - 1] : null;
    if (tags.includes('enthusiastically') && prevCaller && !/!|\b(great|amazing|love|excited|perfect)\b/i.test(prevCaller.text)) ecal.push(a.idx);
    if (tags.length && i > 0 && (agent[i - 1].tags ?? []).length && agent[i - 1].idx === a.idx - 2) ecal.push(a.idx);
  });
  if (sighs > 1) ecal.push(agent.find((a) => (a.tags ?? []).includes('sighs'))!.idx);
  m.ecal = { raw: new Set(ecal).size, applicable: agent.length > 0, evidence: Array.from(new Set(ecal)), rationale: ecal.length ? 'Banned phrases or delivery tags used outside the prompt’s rules.' : undefined };

  if (personaPath === 'Broker') {
    const buyerQs = agent.filter((a) => BUYER_DISCOVERY_RX.test(lc(a.text)) && /\?/.test(a.text));
    m.bpp = { raw: buyerQs.length, applicable: true, evidence: buyerQs.map((b) => b.idx), rationale: buyerQs.length ? 'Buyer discovery questions asked to a broker.' : 'No buyer questions to the broker.' };
  } else m.bpp = { raw: null, applicable: false, evidence: [] };

  // ---------- Conclusion ----------
  const nssApplies = (personaPath === 'Investor' || personaPath === 'Broker') && !['S10', 'S12'].includes(inp.scenario ?? '');
  m.nss = nssApplies ? { raw: tools.nextStep ? 1 : 0, applicable: true, evidence: tools.nextStepTool ? [tools.nextStepTool.turnIdx] : [], rationale: tools.nextStep ? `Next step: ${tools.nextStep}.` : 'Ended with no meeting, callback, document, transfer or note.' } : { raw: null, applicable: false, evidence: [] };

  if (call.durationS > 900) {
    const wrap = phases.closingSignal ? turns[phases.closingSignal.turn]?.startS ?? Infinity : Infinity;
    const end = call.toolCalls.find((tc) => tc.name === 'end_call');
    const endAt = end ? turns[end.turnIdx]?.startS ?? call.durationS : call.durationS;
    m.tlh = { raw: wrap <= 930 && endAt <= 955 && !!end ? 1 : 0, applicable: true, evidence: phases.closingSignal ? [phases.closingSignal.turn] : [], rationale: `Wrap-up at ${Math.round(wrap)} s, end at ${Math.round(endAt)} s.` };
  } else m.tlh = { raw: null, applicable: false, evidence: [] };

  const last = turns[turns.length - 1];
  const abandoned = call.endReason === 'caller_hangup' && (!phases.closingSignal || (last?.speaker === 'agent' && !!last.interrupted) || (last?.speaker === 'agent' && /[—-]$/.test(last.text.trim())));
  m.ab = turns.length > 2 && !['S12'].includes(inp.scenario ?? '') ? { raw: abandoned ? 0 : 1, applicable: true, evidence: abandoned && last ? [last.idx] : [], rationale: abandoned ? 'The caller hung up mid-flow, with no close.' : undefined } : { raw: null, applicable: false, evidence: [] };

  // ---------- Tool use ----------
  if (tools.made.length || tools.expected.length) {
    const made = tools.made.filter((x) => x.tc.name !== 'end_call' || tools.made.length === 1);
    const correct = made.filter((x) => x.correct);
    m.tp = made.length ? { raw: pct(correct.length, made.length), applicable: true, evidence: made.filter((x) => !x.correct).map((x) => x.tc.turnIdx), rationale: made.filter((x) => !x.correct).map((x) => `${x.tc.name}: ${x.why.join(', ')}`).join('; ') || undefined } : { raw: null, applicable: false, evidence: [] };
    const exp = tools.expected;
    m.trc = exp.length ? { raw: pct(exp.filter((e) => e.met).length, exp.length), applicable: true, evidence: exp.filter((e) => !e.met).map((e) => e.turn), rationale: exp.filter((e) => !e.met).map((e) => `${e.tool} expected at #${e.turn} (${e.reason.toLowerCase()})`).join('; ') || undefined } : { raw: null, applicable: false, evidence: [] };
    const argChecked = made.filter((x) => ['send_broker_registration_link', 'send_documents', 'schedule_meeting', 'schedule_callback'].includes(x.tc.name));
    m.aa = argChecked.length ? { raw: pct(argChecked.filter((x) => x.argsOk).length, argChecked.length), applicable: true, evidence: argChecked.filter((x) => !x.argsOk).map((x) => x.tc.turnIdx) } : { raw: null, applicable: false, evidence: [] };
    const seqChecked = made.filter((x) => ['send_documents', 'schedule_meeting', 'schedule_callback', 'request_live_transfer', 'end_call', 'send_broker_registration_link'].includes(x.tc.name));
    m.seq = seqChecked.length ? { raw: pct(seqChecked.filter((x) => x.seqOk).length, seqChecked.length), applicable: true, evidence: seqChecked.filter((x) => !x.seqOk).map((x) => x.tc.turnIdx), rationale: seqChecked.filter((x) => !x.seqOk).map((x) => `${x.tc.name}: ${x.why.join(', ')}`).join('; ') || undefined } : { raw: null, applicable: false, evidence: [] };
    const fid = made.filter((x) => x.fidelityOk !== null);
    m.rf = fid.length ? { raw: pct(fid.filter((x) => x.fidelityOk).length, fid.length), applicable: true, evidence: fid.filter((x) => !x.fidelityOk).map((x) => x.tc.turnIdx) } : { raw: null, applicable: false, evidence: [] };
    const pr = made.filter((x) => x.prompt !== null);
    const missedUpdates = tools.expected.filter((e) => e.tool === 'update_caller_details' && !e.met);
    m.pr = pr.length || missedUpdates.length ? { raw: pct(pr.filter((x) => x.prompt).length, pr.length + missedUpdates.length), applicable: true, evidence: [...pr.filter((x) => !x.prompt).map((x) => x.tc.turnIdx), ...missedUpdates.map((e) => e.turn)] } : { raw: null, applicable: false, evidence: [] };
    const spam = made.filter((x) => x.tc.name === 'send_documents' && !x.correct);
    m.sp = made.some((x) => x.tc.name === 'send_documents') ? { raw: spam.length, applicable: true, evidence: spam.map((x) => x.tc.turnIdx) } : { raw: null, applicable: false, evidence: [] };
  } else for (const k of ['tp', 'trc', 'aa', 'seq', 'rf', 'pr', 'sp']) m[k] = { raw: null, applicable: false, evidence: [] };

  // ---------- Emotion and realism (transcript side) ----------
  const sents = caller.map((c) => ({ idx: c.idx, v: sentiment(c.text), words: wordCount(c.text) }));
  if (sents.length >= 3) {
    const start = (sents[0].v + sents[1].v) / 2, end = (sents[sents.length - 1].v + sents[sents.length - 2].v) / 2;
    m.cet = { raw: +(end - start).toFixed(2), applicable: true, evidence: [sents[0].idx, sents[sents.length - 1].idx], rationale: `Caller sentiment ${start.toFixed(1)} at the start, ${end.toFixed(1)} at the end (transcript).` };
  } else m.cet = { raw: null, applicable: false, evidence: [] };
  const frus = caller.filter((c) => RX.frustration.test(lc(c.text)));
  if (frus.length) {
    const acked = frus.filter((f) => { const n = turns.find((t) => t.idx > f.idx && t.speaker === 'agent'); return n && RX.empathy.test(lc(n.text)); });
    m.fe = { raw: +((acked.length / frus.length) * 100).toFixed(1), applicable: true, evidence: frus.map((f) => f.idx), rationale: `${frus.length} frustration event(s), ${acked.length} acknowledged.` };
  } else m.fe = { raw: null, applicable: false, evidence: [] };
  const latter = sents.slice(Math.floor(sents.length / 2));
  let run = 0, maxRun = 0, runEnd = -1;
  latter.forEach((s, i) => { if (s.words <= 3 && (i === 0 || s.words <= latter[i - 1].words + 1)) { run++; if (run > maxRun) { maxRun = run; runEnd = s.idx; } } else run = 0; });
  m.dis = sents.length >= 4 ? { raw: maxRun >= 3 ? 0 : 1, applicable: true, evidence: maxRun >= 3 ? [runEnd] : [], rationale: maxRun >= 3 ? 'Caller answers got shorter and flatter over 3 or more turns.' : undefined } : { raw: null, applicable: false, evidence: [] };
  const over = agent.filter((a) => {
    const prev = turns[a.idx - 1];
    return (RX.enthusiasm.test(stripTags(a.text)) || (a.tags ?? []).includes('enthusiastically')) && prev?.speaker === 'caller' && !/!|\b(great|amazing|love|excited)\b/i.test(prev.text);
  });
  m.od = agent.length ? { raw: over.length, applicable: true, evidence: over.map((o) => o.idx) } : { raw: null, applicable: false, evidence: [] };
  if (inp.measuredTiming) {
    const rates = agent.map((a) => ({ idx: a.idx, wpm: (wordCount(stripTags(a.text)) / Math.max(0.5, turnEnd(a) - a.startS)) * 60 })).filter((r) => isFinite(r.wpm) && wordCount(turns[r.idx].text) >= 5);
    m.srate = rates.length ? { raw: Math.round(median(rates.map((r) => r.wpm))), applicable: true, evidence: [] } : { raw: null, applicable: false, evidence: [] };
  } else m.srate = { raw: null, applicable: false, evidence: [] };
  const withWords = agent.filter((a) => a.words && a.words.length > 4);
  if (withWords.length) {
    let unnatural = 0; const ev: number[] = [];
    for (const a of withWords) for (let i = 1; i < a.words!.length; i++) {
      const gap = a.words![i].s - a.words![i - 1].e;
      if (gap > 0.7 && !/[.,!?;:—-]$/.test(a.words![i - 1].w)) { unnatural++; ev.push(a.idx); }
    }
    m.pp = { raw: unnatural, applicable: true, evidence: Array.from(new Set(ev)) };
  } else m.pp = { raw: null, applicable: false, evidence: [] };
  return m;
}

/** Gates that code can decide from the tool log and the transcript. */
export function codeGates(inp: CodeInput, tools: ToolAnalysis): CodeGate[] {
  const { call } = inp;
  const turns = call.turns;
  const gates: CodeGate[] = [];

  // G5: contact continued after a do-not-contact request.
  const dnc = turns.find((t) => t.speaker === 'caller' && RX.dnc.test(lc(t.text)));
  if (dnc) {
    const pitch = turns.find((t) => t.idx > dnc.idx && t.speaker === 'agent' && !/\banything else\b/i.test(t.text) && (RX.projectFact.test(lc(t.text)) || /\b(offer|payment plan|special|before you go|would you like|can i (send|book)|shall i|book you)\b/i.test(t.text)));
    gates.push({ id: 'G5', failed: !!pitch, turn: pitch?.idx ?? dnc.idx, detail: pitch ? 'Kept selling after the caller asked not to be contacted.' : null });
  }
  // G6: a document sent to a number or email that was not read back and confirmed.
  for (const x of tools.made.filter((m) => m.tc.name === 'send_documents')) {
    if (!x.seqOk && x.why.includes('No read-back before the send')) { gates.push({ id: 'G6', failed: true, turn: x.tc.turnIdx, detail: 'Sent without reading the number or email back and confirming it.' }); break; }
  }
  // G8: a booking, cancellation or send claimed without the tool confirming it.
  const claimRx: [RegExp, string[]][] = [
    [/\b(you'?re (all )?booked|(is|has been) booked|booked (you|it) (in|for))\b/i, ['schedule_meeting']],
    [/\b((is|has been) cancell?ed|cancell?ed (it|your|the))\b/i, ['cancel_meeting']],
    [/\b(it'?s on your (whatsapp|email)|(is|are) on your (whatsapp|email) now|sent —|sent it|has been sent)\b/i, ['send_documents', 'send_broker_registration_link']],
  ];
  for (const t of turns) {
    if (t.speaker !== 'agent') continue;
    for (const [rx, names] of claimRx) {
      if (!rx.test(t.text)) continue;
      const confirmed = call.toolCalls.some((tc) => names.includes(tc.name) && tc.turnIdx <= t.idx && tc.ok !== false && !/\b(fail|failed|error|unavailable)\b/i.test(tc.resultText ?? ''));
      if (!confirmed) { gates.push({ id: 'G8', failed: true, turn: t.idx, detail: `Claimed “${t.text.slice(0, 60)}…” without ${names[0]} confirming it.` }); break; }
    }
  }
  // G9: the call ended after transfer_to, while an advisor was waiting on hold.
  const tt = call.toolCalls.find((tc) => tc.name === 'request_live_transfer' && /transfer_to/i.test(tc.resultText ?? ''));
  if (tt && !call.toolCalls.some((tc) => tc.name === 'transfer_to_number')) gates.push({ id: 'G9', failed: true, turn: tt.turnIdx, detail: 'Ended after transfer_to without transferring; the advisor was left waiting.' });
  return gates;
}
