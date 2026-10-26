// Step 3: cut the transcript into introduction, body and conclusion by fixed rules, so two reviewers
// cut the same call in the same places, and tag each body turn with a segment.

import { type CanonicalCall, type ContextRecord, type Phases, type SegmentName } from '@calleval/framework';
import { lc, RX } from './text';

const ACTION_TOOLS = new Set(['send_documents', 'schedule_callback', 'schedule_meeting', 'cancel_meeting', 'request_live_transfer', 'transfer_to_number', 'save_note', 'send_broker_registration_link']);
const BROKER_SIGNAL = /\b(i'?m (a|an independent) broker|broker|brokerage|agency|my clients|realtor)\b/i;
const INVESTOR_SIGNAL = /\b(for myself|for my family|buying for (me|us|my)|to live in|as an investment|i'?m an investor|looking at investments|looking to invest|want to invest|my first (home|place)|buying my first)\b/i;
const NONTARGET_SIGNAL = /\b(rent(ing)?\b|already own|service charge|job (opening|vacancy)|wrong number|snagging)\b/i;

/** First caller turn that settles investor or broker (or non-target), unless known from history. */
export function findPersonaResolution(call: CanonicalCall, ctx: ContextRecord): number | null {
  if (ctx.persona !== 'unknown') return call.turns.find((t) => t.speaker === 'agent')?.idx ?? 0;
  for (const t of call.turns) {
    if (t.speaker !== 'caller') continue;
    const s = lc(t.text);
    if (BROKER_SIGNAL.test(s) || INVESTOR_SIGNAL.test(s) || NONTARGET_SIGNAL.test(s)) return t.idx;
  }
  return null;
}

type Signal = { turn: number; kind: string };

export function closingSignals(call: CanonicalCall): Signal[] {
  const sig: Signal[] = [];
  let refusals = 0;
  const okTool = (name: string) => call.toolCalls.filter((tc) => tc.name === name && tc.ok !== false);
  for (const tc of [...okTool('schedule_meeting'), ...okTool('schedule_callback')]) {
    // The booking is confirmed; the wrap-up starts at the next agent turn that reads it back.
    const confirm = call.turns.find((t) => t.idx >= tc.turnIdx && t.speaker === 'agent' && /\b(booked|scheduled|i'?ll call you|confirmation|you'?re (all )?set|moved|now (sunday|saturday|monday|tuesday|wednesday|thursday|friday))\b/i.test(t.text));
    sig.push({ turn: confirm?.idx ?? tc.turnIdx, kind: 'booking_confirmed' });
  }
  for (const tc of call.toolCalls.filter((t) => t.name === 'request_live_transfer')) sig.push({ turn: tc.turnIdx, kind: 'live_transfer' });
  for (const t of call.turns) {
    if (t.speaker !== 'caller') {
      if (t.startS >= 900) sig.push({ turn: t.idx, kind: 'time_limit' });
      continue;
    }
    const s = lc(t.text);
    if (RX.dnc.test(s)) sig.push({ turn: t.idx, kind: 'do_not_contact' });
    if (RX.refusal.test(s)) { refusals++; if (refusals === 2) sig.push({ turn: t.idx, kind: 'second_refusal' }); }
    if (RX.goodbye.test(s)) sig.push({ turn: t.idx, kind: 'caller_goodbye' });
  }
  // The agent's own farewell closes a call that has no other signal.
  const end = call.toolCalls.find((tc) => tc.name === 'end_call');
  if (end) sig.push({ turn: end.turnIdx, kind: 'farewell' });
  return sig.sort((a, b) => a.turn - b.turn);
}

function segmentOfTurn(call: CanonicalCall, idx: number, prev: SegmentName | null): SegmentName {
  const t = call.turns[idx];
  const s = lc(t.text);
  const tools = call.toolCalls.filter((tc) => tc.turnIdx === idx);
  if (t.speaker === 'agent') {
    if (tools.some((tc) => ACTION_TOOLS.has(tc.name))) return 'Action';
    if (tools.some((tc) => tc.name === 'get_project_details') || RX.projectFact.test(s)) return 'Pitch';
    const prevCaller = call.turns[idx - 1];
    if (prevCaller?.speaker === 'caller') {
      const c = lc(prevCaller.text);
      if (Object.values(RX.objection).some((rx) => rx.test(c))) return 'Objection';
      if (RX.offTopic.test(c)) return 'Off-topic';
    }
    if (/\b(send|book|schedule|call you|connect you|put you through|registration link|whatsapp)\b/.test(s)) return 'Action';
    if (/\?/.test(s)) return prev === 'Pitch' && /\b(which|sounds|in person|online|walkthrough|visit)\b/.test(s) ? 'Pitch' : 'Discovery';
    return prev ?? 'Discovery';
  }
  if (Object.values(RX.objection).some((rx) => rx.test(s))) return 'Objection';
  if (RX.offTopic.test(s)) return 'Off-topic';
  if (/\b(send me|call me|book|speak to (a|someone)|person|brochure|visit)\b/.test(s)) return 'Action';
  if (/\b(how much|price|which|tell me about|what do you have|available|handover|how big)\b/.test(s)) return 'Pitch';
  return prev ?? 'Discovery';
}

export function segmentCall(call: CanonicalCall, ctx: ContextRecord, hint: { personaResolvedAt?: number | null; turnSegments?: Record<number, SegmentName> } = {}): Phases {
  const n = call.turns.length;
  if (!n) return { phases: [], segments: [], turnSegments: {}, personaResolvedAt: null, closingSignal: null };
  const personaResolvedAt = hint.personaResolvedAt !== undefined && hint.personaResolvedAt !== null ? hint.personaResolvedAt : findPersonaResolution(call, ctx);

  // Introduction ends when persona is resolved; on an inbound call, also once the caller's first
  // question has been answered (the agent turn after it).
  let introEnd = personaResolvedAt ?? -1;
  if (introEnd >= 0 && ctx.direction === 'inbound') {
    const firstQ = call.turns.find((t) => t.speaker === 'caller' && /\?/.test(t.text));
    if (firstQ && firstQ.idx < introEnd + 4) {
      const answer = call.turns.find((t) => t.idx > firstQ.idx && t.speaker === 'agent');
      if (answer) introEnd = Math.max(introEnd, answer.idx);
    }
  }

  // Conclusion starts at the first closing signal the caller does not reopen.
  const signals = closingSignals(call).filter((s) => s.turn > introEnd);
  let closing: Signal | null = null;
  for (let i = 0; i < signals.length; i++) {
    const s = signals[i];
    const reopen = call.turns.find((t) => t.idx > s.turn && t.speaker === 'caller' && RX.reopen.test(t.text) && !RX.goodbye.test(t.text));
    if (!reopen) { closing = s; break; }
    // The body resumes; the conclusion restarts at the next closing signal after the reopen.
    const later = signals.slice(i + 1).find((x) => x.turn > reopen.idx);
    if (!later) { closing = s; break; }
    i = signals.indexOf(later) - 1;
  }
  const conclStart = closing ? closing.turn : Math.max(introEnd + 1, n - 1);

  const phases: Phases['phases'] = [];
  const turnSegments: Record<number, SegmentName> = {};
  if (personaResolvedAt === null || introEnd < 0) {
    // Ended before persona was resolved: no body; score the introduction and conclusion only.
    const introTo = Math.max(0, Math.min(n - 1, conclStart - 1));
    phases.push({ name: 'Introduction', from: 0, to: introTo });
    if (conclStart <= n - 1 && conclStart > introTo) phases.push({ name: 'Conclusion', from: conclStart, to: n - 1 });
    return { phases, segments: [], turnSegments, personaResolvedAt: null, closingSignal: closing };
  }
  phases.push({ name: 'Introduction', from: 0, to: Math.min(introEnd, n - 1) });
  const bodyFrom = introEnd + 1, bodyTo = Math.min(conclStart - 1, n - 1);
  if (bodyTo >= bodyFrom) phases.push({ name: 'Body', from: bodyFrom, to: bodyTo });
  if (conclStart <= n - 1) phases.push({ name: 'Conclusion', from: Math.max(conclStart, bodyFrom), to: n - 1 });

  const segments: Phases['segments'] = [];
  let prev: SegmentName | null = null;
  for (let i = bodyFrom; i <= bodyTo; i++) {
    const seg: SegmentName = hint.turnSegments?.[i] ?? segmentOfTurn(call, i, prev);
    turnSegments[i] = seg;
    const last = segments[segments.length - 1];
    if (last && last.name === seg && last.to === i - 1) last.to = i;
    else segments.push({ name: seg, from: i, to: i });
    prev = seg;
  }
  return { phases, segments, turnSegments, personaResolvedAt, closingSignal: closing };
}

export const phaseOf = (p: Phases, idx: number) => p.phases.find((ph) => idx >= ph.from && idx <= ph.to)?.name ?? null;
