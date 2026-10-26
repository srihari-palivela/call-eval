// Transcript helpers and the phrase patterns the code checks rely on. They cover English, which is
// the language in scope for v1; other languages fall through to the LLM judge.

import type { CanonicalCall, CanonicalTurn } from '@calleval/framework';

export const words = (s: string) => (s.match(/[\p{L}\p{N}'’]+/gu) ?? []);
export const wordCount = (s: string) => words(s).length;
export const stripTags = (s: string) => s.replace(/\[[a-z][a-z _-]{1,30}\]\s*/gi, '').trim();
export const lc = (s: string) => stripTags(s).toLowerCase();
export const questionCount = (s: string) => (stripTags(s).match(/\?/g) ?? []).length;
export const sentences = (s: string) => stripTags(s).split(/(?<=[.!?])\s+/).filter(Boolean);

export const RX = {
  backchannel: /^(yeah|yes|yep|mm+|mhm|uh-huh|okay|ok|right|sure|got it|i see)[.!]?$/i,
  goodbye: /\b(bye|goodbye|that'?s all|that is all|nothing else|that'?s it|have a (good|nice) (day|one))\b/i,
  dnc: /\b(don'?t call|do not call|stop calling|take my number off|remove my number|never call)\b/i,
  refusal: /^(no\b|no,|not (interested|now|really)|i'?m not interested|i said no|no thanks|i'?ll leave it|i think i will leave it)/i,
  reopen: /\b(one more thing|actually|also|another question|wait)\b|\?/i,
  objection: {
    objection_budget: /\b(too expensive|above (what|our)|over (my|our) budget|can'?t afford|a bit (much|high)|pricey|cheaper)\b/i,
    objection_location: /\b(location|too far|far from|not sure about the (area|community))\b/i,
    objection_timing: /\b(handover is too late|too late for us|not (ready|in a rush)|timing)\b/i,
    objection_family: /\b(talk to my (wife|husband|partner|family)|consult (my )?(family|wife|husband)|family decision)\b/i,
    objection_just_looking: /\b(just looking|only looking|browsing)\b/i,
    competitor_mentioned: /\b(compare[sd]? with|other developer|dubai marina places|business bay places|downtown places|i'?ve seen elsewhere)\b/i,
  } as Record<string, RegExp>,
  askedIfAi: /\b(are you (a )?(bot|robot|ai|real person|human|computer)|is this (a )?(bot|recording|ai))\b/i,
  offTopic: /\b(visa|golden visa|mortgage|rental (return|yield)|yield|rent(ing)?\b|service charge|snagging|job|vacancy|wrong number|complaint)\b/i,
  frustration: /\b(i said|i told you|already told|okay,? okay|just send|you used it|we said|for the (second|third) time|that'?s not what i)\b/i,
  correction: /\b(no,? i said|not .{1,40}(—|-|,) ?(we|i) said|that'?s not what i|i told you|you used it|we said|i said)\b/i,
  timeCheck: /\b(good time|is now (still )?(a )?(good|ok|okay|convenient)|have a (minute|moment|couple of minutes)|couple of minutes)\b/i,
  howCanIHelp: /\bhow can i help( you)?\b/i,
  callbackMention: /\b(call(ing)? you back|asked us to call|requested a call|you asked (us|me) to call)\b/i,
  personaFork: /\b(buying for yourself|for yourself,? or|are you a broker|or (are you )?a broker|investor or (a )?broker|buyer or (a )?broker)\b/i,
  liveOrInvest: /\b(live in|to live|or (is it|as an?) investment|invest(ment)?)\b/i,
  nameAsk: /\b(your name|who am i speaking|may i (take|have|get) your name|what'?s your name|name again)\b/i,
  readBack: /\b(ending (in )?\d{2,4}|is that (right|correct)|this number|that number|confirm (the|your)|@[a-z0-9.-]+|on whatsapp,? on|should it go to)\b/i,
  greeting: /\b(thanks for calling|thank you for calling|hi|hello|good (morning|afternoon|evening))\b/i,
  thanksName: /\b(thank you|thanks)\b/i,
  empathy: /\b(sorry|i understand|understood|fair|that makes sense|you'?re right|apolog|of course|no problem)\b/i,
  enthusiasm: /(!|\b(amazing|exciting|incredible|fantastic|so much going for it|one of the most)\b)/i,
  positive: /\b(great|perfect|lovely|thanks|thank you|sounds (good|right|great)|yes|sure|good|wonderful|excellent)\b/i,
  negative: /\b(no\b|not\b|too expensive|frustrat|annoy|i said|already|don'?t|can'?t|won'?t|leave it|just send|okay,? okay)\b/i,
  projectFact: /(\b\d[\d,.]*\s*(million|thousand|k)?\s*(dirhams|aed)\b|\baed\s*\d|\b\d[\d,]*\s*(square feet|sq ?ft|sqft)\b|\bhand(s|ing)? ?over\b.*\b(20\d\d|q[1-4])\b|\b(q[1-4])\s*20\d\d\b)/i,
  yieldAdvice: /\b\d+(\.\d+)?\s*(to \d+(\.\d+)?\s*)?(%|percent)\b.{0,40}\b(net|yield|return|returns)\b|\b(net|yield|return)s?\b.{0,30}\b\d+(\.\d+)?\s*(%|percent)/i,
  visaAdvice: /\b(qualif(y|ies) (you )?for (the|a) golden visa|you would (be fine|qualify)|any purchase above .{0,30} qualif)/i,
  mortgageAdvice: /\b(you can (usually )?borrow up to|you('?ll| will) (easily )?get a mortgage|ltv of)\b/i,
  promise: /\b(guarantee(d)?|discount|special (price|offer|payment plan)|\d+% return|free (dld|registration))\b/i,
  negated: /\b(can'?t|cannot|not able to|no way to|don'?t|unable to)\b/,
  denyAi: /\b(i'?m (a )?(real|human) (person|being)|i'?m not a (bot|robot|machine|ai)|no,? i'?m (a )?(human|person))\b/i,
  otherCustomer: /\b(another (client|customer|buyer) (of ours )?(named|called|bought|just)|(mr|mrs|ms)\.? [a-z]+ (bought|purchased|reserved))\b/i,
  bareQuestion: /^[^.!]{0,90}\?$/,
};

export const BUYER_DISCOVERY_RX = /\b(budget|how many bedrooms|bedrooms are they|when would you (want to )?move|timeline|live in (it )?yourself|which areas|must-haves?)\b/i;

export const FIELD_ASK_RX: Record<string, RegExp> = {
  name: RX.nameAsk,
  budget: /\b(budget|price range|how much (are you|were you) (looking|planning) to spend)\b/i,
  bedrooms: /\bhow many bedrooms\b/i,
  location: /\b(which areas|where (are you|would you like) (looking|to live))\b/i,
  timeline: /\b(when would you (want to )?move|timeline|lease ends)\b/i,
  project_interest: /\bwhich project\b/i,
  persona: RX.personaFork,
};

export function fmtTime(t: number) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function agentTurns(call: CanonicalCall) { return call.turns.filter((t) => t.speaker === 'agent'); }
export function callerTurns(call: CanonicalCall) { return call.turns.filter((t) => t.speaker === 'caller'); }
export function prevTurn(call: CanonicalCall, t: CanonicalTurn) { return call.turns[t.idx - 1]; }
export function nextAgentTurn(call: CanonicalCall, idx: number) { return call.turns.find((t) => t.idx > idx && t.speaker === 'agent'); }
export function turnEnd(t: CanonicalTurn) { return t.endS ?? t.startS + Math.max(0.6, wordCount(t.text) / 2.5); }

/** Caller sentiment per turn in [-1, 1] from a small lexicon (transcript side of the emotion metrics). */
export function sentiment(text: string): number {
  const s = lc(text);
  const pos = (s.match(new RegExp(RX.positive.source, 'gi')) ?? []).length;
  const neg = (s.match(new RegExp(RX.negative.source, 'gi')) ?? []).length + (RX.frustration.test(s) ? 2 : 0);
  if (!pos && !neg) return 0;
  return Math.max(-1, Math.min(1, (pos - neg) / Math.max(2, pos + neg)));
}

export const quoteOf = (call: CanonicalCall, idx: number | null | undefined) => (idx === null || idx === undefined ? null : call.turns[idx]?.text ?? null);

// Voice agents usually write numbers out as words so the TTS reads them naturally ("one point two
// five million dirhams"). Number checks normalise them to digits first.
const UNITS: Record<string, number> = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const bare = (w: string | undefined) => (w ?? '').toLowerCase().replace(/[^a-z]/g, '');

function readNumber(ws: string[], i: number): { value: number; next: number } | null {
  let total = 0, cur = 0, seen = false, afterHundred = false, j = i;
  while (j < ws.length) {
    const w = bare(ws[j]);
    if (w in UNITS || w in TENS) { cur += UNITS[w] ?? TENS[w]; seen = true; afterHundred = false; j++; }
    else if (w === 'hundred' && seen) { cur = (cur || 1) * 100; afterHundred = true; j++; }
    else if (w === 'thousand' && seen) { total += cur * 1000; cur = 0; j++; }
    else if (w === 'and' && seen && bare(ws[j + 1]) === 'a' && bare(ws[j + 2]) === 'half') { cur += 0.5; j += 3; break; }
    else if (w === 'and' && afterHundred && (bare(ws[j + 1]) in UNITS || bare(ws[j + 1]) in TENS)) { j++; }
    else if (w === 'point' && seen) {
      let k = j + 1, dec = '';
      while (k < ws.length && bare(ws[k]) in UNITS && UNITS[bare(ws[k])] < 10) { dec += UNITS[bare(ws[k])]; k++; }
      if (dec) { cur += Number(`0.${dec}`); j = k; }
      break;
    } else break;
    if (/[,;.!?]$/.test(ws[j - 1] ?? '')) break;
  }
  return seen ? { value: total + cur, next: j } : null;
}

/** Replace spelled-out numbers with digits: "one and a half million" → "1.5 million". */
export function wordsToDigits(text: string): string {
  const ws = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < ws.length;) {
    const r = readNumber(ws, i);
    if (r) { const tail = (ws[r.next - 1].match(/[,;.!?]+$/) ?? [''])[0]; out.push(`${+r.value.toFixed(4)}${tail}`); i = r.next; }
    else out.push(ws[i++]);
  }
  return out.join(' ');
}

/** Money amounts in AED stated in a sentence, written or spoken. */
export function moneyAmounts(text: string): number[] {
  const s = wordsToDigits(stripTags(text));
  const out: number[] = [];
  const rx = /(?:\b(?:aed|dhs?)\s*)?(\d[\d,]*(?:\.\d+)?)(?:\s*(million|mn|m|thousand|k)\b)?(?:\s*(aed|dirhams?|dhs?)\b)?/gi;
  for (const m of s.matchAll(rx)) {
    const n = Number(m[1].replace(/,/g, ''));
    if (!isFinite(n)) continue;
    const scale = (m[2] ?? '').toLowerCase();
    const currency = !!m[3] || /^(aed|dh)/i.test(m[0]);
    const v = scale === 'million' || scale === 'mn' || scale === 'm' ? n * 1_000_000 : scale === 'thousand' || scale === 'k' ? n * 1000 : n;
    // A bare number counts only when it carries a currency or a scale (bedrooms and years do not).
    if ((scale || currency) && v >= 10_000) out.push(Math.round(v));
  }
  return out;
}

/** Numbers in a tool result, with "1.25M"-style scales applied. */
export function numbersIn(text: string): number[] {
  return Array.from(text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(million|m|k)?\b/gi)).map((m) => {
    const n = Number(m[1].replace(/,/g, ''));
    const sc = (m[2] ?? '').toLowerCase();
    return sc === 'million' || sc === 'm' ? n * 1_000_000 : sc === 'k' ? n * 1000 : n;
  }).filter((n) => isFinite(n));
}

/** True when the caller gives a contact the agent does not already hold (a new number or email). */
export const NEW_CONTACT = /@|\b(gmail|hotmail|outlook|yahoo|icloud)\b|\bdot com\b|\b(different|another|other|new|my work|my personal) (number|email|e-mail|whatsapp)\b|\bmy e-?mail (is|address)\b|\bsend it to my e-?mail\b|\d{7,}/i;
export const hasNewContact = (text: string) => NEW_CONTACT.test(wordsToDigits(text).replace(/(\d)[\s-]+(?=\d)/g, '$1'));
