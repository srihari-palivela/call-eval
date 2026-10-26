// Step 4, layer 1: tags set by rules from call data, with no judgement needed. Higher layers
// (classifier, then human review) take over everything rules leave open.

import type { CallEventRec, CanonicalCall, ContextRecord, TagValue } from '@calleval/framework';
import { lc, RX, wordCount } from './text';

export type RuleTags = {
  persona?: TagValue;
  personaPath?: 'Investor' | 'Broker' | null;
  scenarioPrimary?: TagValue;
  scenarioCandidates: string[];
  returning: boolean;
  failedCall: boolean;
  brokerRegistration: 'Registered' | 'Unregistered' | null;
  events: CallEventRec[];
};

const rule = (value: string, evidence: number[]): TagValue => ({ value, confidence: 1, layer: 'rule', evidence });

export function ruleTags(call: CanonicalCall, ctx: ContextRecord): RuleTags {
  const out: RuleTags = { scenarioCandidates: [], returning: ctx.history === 'returning', failedCall: false, brokerRegistration: null, events: [] };
  const called = (name: string) => call.toolCalls.filter((t) => t.name === name);
  const callerWords = call.turns.filter((t) => t.speaker === 'caller').reduce((a, t) => a + wordCount(t.text), 0);

  // Under 3 caller words, a voicemail greeting or a dropped line → S12, P0.
  if (callerWords < 3 || call.endReason === 'voicemail' || call.endReason === 'no_answer') {
    out.failedCall = true;
    out.persona = rule('P0', []);
    out.scenarioPrimary = rule('S12', call.turns.slice(0, 2).map((t) => t.idx));
    return out;
  }

  const reg = called('send_broker_registration_link');
  if (reg.length) {
    const args = reg[0].args as Record<string, unknown>;
    const type = String(args.broker_type ?? '').toLowerCase();
    const callerText = call.turns.filter((t) => t.speaker === 'caller').map((t) => lc(t.text)).join(' ');
    const overseas = /\b(london|uk|abroad|overseas|international|india|europe|my clients in)\b/.test(callerText) || type.includes('international') || type.includes('overseas');
    out.persona = rule(overseas ? 'P7' : 'P8', [reg[0].turnIdx]);
    out.personaPath = 'Broker';
    out.scenarioPrimary = rule('S7', [reg[0].turnIdx]);
    out.brokerRegistration = args.registered === true ? 'Registered' : args.registered === false ? 'Unregistered' : null;
  }
  const transfer = called('request_live_transfer');
  if (!out.scenarioPrimary && transfer.length) out.scenarioPrimary = rule('S5', [transfer[0].turnIdx]);
  const cancel = called('cancel_meeting');
  const moved = called('schedule_meeting').filter((t) => (t.args as any)?.reschedule || (t.args as any)?.meeting_id);
  if (!out.scenarioPrimary && (cancel.length || moved.length)) out.scenarioPrimary = rule('S6', [(cancel[0] ?? moved[0]).turnIdx]);
  const cb = called('schedule_callback');
  const otherActions = call.toolCalls.filter((t) => ['schedule_meeting', 'send_documents', 'request_live_transfer', 'send_broker_registration_link'].includes(t.name));
  if (!out.scenarioPrimary && cb.length && !otherActions.length) out.scenarioPrimary = rule('S4', [cb[0].turnIdx]);
  if (ctx.objective !== 'empty' || ctx.history === 'returning') out.scenarioCandidates.push('S9');

  // Events that code can see.
  for (const tc of call.toolCalls) {
    if (tc.ok === false) out.events.push({ type: 'tool_failure', turn: tc.turnIdx, detail: tc.name, source: 'code' });
    if (tc.name === 'request_live_transfer' && /unavailable|no advisor|busy/i.test(tc.resultText ?? '')) out.events.push({ type: 'transfer_unavailable', turn: tc.turnIdx, detail: null, source: 'code' });
    if (tc.name === 'send_documents' && /fail|undeliverable|fallback|by email instead/i.test(tc.resultText ?? '')) {
      const fallback = call.turns.find((t) => t.idx >= tc.turnIdx && t.speaker === 'agent' && /\bemail\b/i.test(t.text));
      if (fallback) out.events.push({ type: 'whatsapp_fallback_email', turn: fallback.idx, detail: null, source: 'code' });
    }
  }
  if (call.durationS >= 900 || call.endReason === 'time_limit') out.events.push({ type: 'time_limit_reached', turn: call.turns[call.turns.length - 1]?.idx ?? 0, detail: null, source: 'code' });
  let corrective = 0;
  for (const t of call.turns) {
    if (t.speaker !== 'caller') continue;
    const s = lc(t.text);
    if (RX.askedIfAi.test(s)) out.events.push({ type: 'asked_if_ai', turn: t.idx, detail: null, source: 'code' });
    if (RX.dnc.test(s)) out.events.push({ type: 'dnc_request', turn: t.idx, detail: null, source: 'code' });
    if (RX.correction.test(s)) { corrective++; if (corrective === 3) out.events.push({ type: 'interruption_burst', turn: t.idx, detail: null, source: 'code' }); }
  }
  return out;
}
