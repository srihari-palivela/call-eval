// Synthetic conversations for demo mode and tests. Each call is built turn by turn from the persona
// and scenario, with tool calls, timings and dynamic variables shaped like a real provider export.
// Known failure modes from the framework (a project fact with no tool output behind it, two
// questions in one turn, tool dead air, a list of three instead of a two-option fork, …) are
// injected with a probability that depends on the persona, the scenario and the prompt version, so
// the analytics have realistic variance and the pipeline has something real to find.

import { PERSONAS, SCENARIOS, type CanonicalCall, type CanonicalToolCall, type CanonicalTurn, type Direction, type EndReason } from '@calleval/framework';
import { mulberry32 } from '@calleval/framework';

export const DEMO_PROJECTS = [
  { id: 'island_park', name: 'Island Park Residences', community: 'Dubai Islands', vibe: 'the quieter one, set back from the beach with a park inside the community', beds: { 1: [980_000, 780], 2: [1_600_000, 1_200], 3: [2_450_000, 1_750] }, handover: 'Q4 2027' },
  { id: 'seafront_one', name: 'Seafront One', community: 'Dubai Islands', vibe: 'on the beachfront with more amenities, handing over later', beds: { 1: [1_150_000, 820], 2: [1_950_000, 1_280], 3: [3_100_000, 1_900] }, handover: 'Q2 2028' },
  { id: 'circle_gardens', name: 'Circle Gardens', community: 'JVC', vibe: 'the value option, close to schools and the circle park', beds: { 1: [720_000, 760], 2: [1_100_000, 1_150], 3: [1_650_000, 1_600] }, handover: 'Q1 2027' },
  { id: 'creek_heights', name: 'Creek Heights', community: 'Dubai Creek Harbour', vibe: 'the skyline option with metro access and a marina promenade', beds: { 1: [1_300_000, 800], 2: [2_100_000, 1_250], 3: [3_200_000, 1_850] }, handover: 'Q3 2027' },
] as const;

type Project = (typeof DEMO_PROJECTS)[number];
const fmtAed = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 100_000 === 0 ? 1 : 2).replace(/\.?0+$/, '')} million dirhams` : `${Math.round(n / 1000)},000 dirhams`);

// Weekly call mix by persona (rows) and scenario (columns), from the framework's sample volumes.
const VOL = [
  [38, 22, 14, 12, 5, 6, 0, 16, 14, 6, 4, 3], [20, 16, 10, 8, 4, 2, 0, 8, 6, 4, 6, 2], [14, 24, 12, 6, 4, 2, 0, 10, 8, 4, 12, 2],
  [10, 12, 10, 8, 3, 3, 0, 5, 5, 3, 9, 3], [16, 12, 6, 6, 3, 4, 0, 8, 7, 3, 3, 1], [6, 10, 8, 6, 1, 0, 0, 6, 3, 22, 2, 4],
  [0, 3, 4, 2, 2, 1, 26, 1, 3, 2, 1, 1], [0, 3, 3, 2, 1, 1, 20, 1, 2, 2, 1, 1], [0, 1, 1, 1, 4, 1, 0, 0, 1, 1, 16, 1],
  [0, 1, 0, 0, 1, 0, 0, 0, 0, 4, 10, 1], [0, 0, 0, 0, 1, 0, 0, 0, 0, 3, 3, 12],
];
// How well the agent tends to handle each persona and scenario (0–1), and what a prompt version changed.
const PQ = [0.74, 0.56, 0.46, 0.52, 0.72, 0.56, 0.38, 0.46, 0.62, 0.72, 0.78];
const SQ = [0.04, -0.04, 0.05, 0.08, -0.12, 0.02, -0.08, -0.08, 0.04, 0.06, -0.08, 0.05];
function versionDelta(ver: string, pi: number, si: number) {
  if (ver !== 'v3') return 0;
  let d = 0.03;
  if (si === 6 && (pi === 6 || pi === 7)) d -= 0.12; // the longer v3 prompt muddled the broker flow
  if (si === 0) d += 0.06;                            // two-option fork rule added
  if (si === 7) d += 0.03;
  if (si === 4) d -= 0.08;                            // longer prompt slowed transfers
  if (pi === 3) d -= 0.05;                            // overseas time-zone handling regressed
  return d;
}

const WEAK: Record<string, string[]> = {
  P2: ['discovery', 'reask'], P3: ['scope', 'pitch'], P4: ['intro', 'timezone', 'close'], P5: ['pitch'], P6: ['push', 'close'],
  P7: ['broker', 'tools', 'intro', 'close'], P8: ['tools', 'broker', 'intro', 'close'],
  S1: ['pitch'], S2: ['pitch', 'tools', 'discovery'], S3: ['tools', 'readback'], S5: ['transfer', 'tools'], S6: ['tools'], S7: ['broker', 'intro'],
  S8: ['objection', 'push'], S10: ['push'], S11: ['scope'],
};
// v3 added the two-option fork and broker-path rules (fixing pitch and broker faults) but its longer
// prompt slowed transfers, lost the time zone on overseas bookings and loosened tool discipline.
const VER_WEAK: Record<string, string[]> = { v2: ['pitch', 'broker', 'discovery'], v3: ['transfer', 'timezone', 'tools'] };

const NAMES = ['Rahul', 'Priya', 'Daniel', 'Aisha', 'Omar', 'Sara', 'James', 'Fatima', 'Arjun', 'Layla', 'Michael', 'Noura', 'Chen', 'Elena', 'Yousef', 'Hannah', 'Ravi', 'Mariam', 'Tom', 'Zainab'];
const COMPETITORS = ['Dubai Marina', 'Business Bay', 'Downtown'];

type Rng = () => number;
const pick = <T,>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const chance = (r: Rng, p: number) => r() < p;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export type DemoOptions = { count: number; days: number; seed?: number; now?: Date; versions?: { label: string; fromDaysAgo: number; toDaysAgo: number }[] };

class Builder {
  turns: CanonicalTurn[] = [];
  tools: CanonicalToolCall[] = [];
  t = 0;
  ended = false;
  constructor(private r: Rng, private q: number, private slow: boolean) {}
  private lat() {
    const base = 0.75 + this.r() * 0.6;
    return this.slow && chance(this.r, 0.35) ? base + 1.6 + this.r() * 2.2 : base;
  }
  agent(text: string, opts: { tag?: string; latency?: number; interrupted?: boolean } = {}) {
    if (this.ended) return -1;
    const prev = this.turns[this.turns.length - 1];
    const gap = prev?.speaker === 'caller' ? opts.latency ?? this.lat() : prev ? 0.25 : 0;
    const start = this.t + gap;
    const body = opts.tag ? `[${opts.tag}] ${text}` : text;
    const words = text.split(/\s+/).length;
    const rate = 2.45 + this.r() * 0.35 + (this.q < 0.45 && chance(this.r, 0.3) ? 0.6 : 0);
    const end = start + words / rate;
    this.turns.push({ idx: this.turns.length, speaker: 'agent', text: body, startS: +start.toFixed(2), endS: +end.toFixed(2), tags: opts.tag ? [opts.tag] : undefined, interrupted: opts.interrupted, latencyS: prev?.speaker === 'caller' ? +gap.toFixed(2) : undefined });
    this.t = end;
    return this.turns.length - 1;
  }
  caller(text: string, opts: { barge?: boolean } = {}) {
    if (this.ended) return -1;
    const prev = this.turns[this.turns.length - 1];
    let start = this.t + 0.4 + this.r() * 0.5;
    if (opts.barge && prev?.speaker === 'agent') { start = Math.max(prev.startS + 1, (prev.endS ?? this.t) - 1.5); prev.interrupted = true; }
    const end = start + 0.4 + text.split(/\s+/).length / (1.9 + this.r() * 0.5);
    this.turns.push({ idx: this.turns.length, speaker: 'caller', text, startS: +start.toFixed(2), endS: +end.toFixed(2) });
    this.t = end;
    return this.turns.length - 1;
  }
  /** A tool called from agent turn `turnIdx`; `blocking` means the agent waits for it before speaking. */
  tool(turnIdx: number, name: string, args: Record<string, unknown>, result: unknown, ok = true, dur = 0.3 + this.r() * 0.9) {
    if (this.ended) return;
    const startS = this.t;
    this.tools.push({ id: `tc_${this.tools.length}_${Math.floor(this.r() * 1e6)}`, turnIdx, name, args, result, resultText: typeof result === 'string' ? result : JSON.stringify(result), ok, startS: +startS.toFixed(2), durationS: +dur.toFixed(2) });
    return dur;
  }
  /** Blocking tool before the agent's next turn: the caller hears silence for the tool's duration. */
  blockingTool(name: string, args: Record<string, unknown>, result: unknown, filler: string | null, dur: number) {
    if (filler) { const i = this.agent(filler); this.tool(i, name, args, result, true, dur); this.t += dur; return i; }
    // No filler: the tool runs in the gap before the next agent turn.
    this.tool(this.turns.length, name, args, result, true, dur);
    this.t += dur;
    return -1;
  }
}

function projectsFor(r: Rng, beds: number, community: string | null, n: number) {
  const pool = DEMO_PROJECTS.filter((p) => !community || p.community === community);
  const rest = DEMO_PROJECTS.filter((p) => !pool.includes(p));
  return [...pool, ...rest].slice(0, n).map((p) => ({ id: p.id, name: p.name, community: p.community, from_aed: p.beds[beds as 1 | 2 | 3][0], size_sqft: p.beds[beds as 1 | 2 | 3][1], handover: p.handover }));
}

export function generateCall(seedNo: number, opts: { at: Date; version: string; pi?: number; si?: number; rng?: Rng }): CanonicalCall {
  const r = opts.rng ?? mulberry32(seedNo * 7919 + 13);
  // Persona and scenario from the weekly mix.
  let pi = opts.pi, si = opts.si;
  if (pi === undefined || si === undefined) {
    const total = VOL.flat().reduce((a, b) => a + b, 0);
    let x = r() * total;
    outer: for (let i = 0; i < VOL.length; i++) for (let j = 0; j < 12; j++) { x -= VOL[i][j]; if (x <= 0) { pi = i; si = j; break outer; } }
    pi ??= 0; si ??= 0;
  }
  const persona = PERSONAS[pi], scen = SCENARIOS[si];
  const q = clamp(PQ[pi] + SQ[si] + versionDelta(opts.version, pi, si) + (r() - 0.5) * 0.35, 0.05, 0.98);
  // Each persona and scenario has weak spots (like the framework's sample data), and each prompt
  // version fixed some and broke others; faults in a weak family are much more likely.
  const weakFams = new Set([...(WEAK[persona.id] ?? []), ...(WEAK[scen.id] ?? [])]);
  const verFams = new Set(VER_WEAK[opts.version] ?? []);
  const fault = (base: number, fam?: string) => chance(r, clamp(base * (1.3 - q) * 1.9 * (fam && weakFams.has(fam) ? 2.6 : 1) * (fam && verFams.has(fam) ? 1.9 : 1), 0, 0.92));
  const slow = fault(0.35);
  const b = new Builder(r, q, slow);

  const returning = si === 8 || chance(r, 0.15);
  const inbound = si === 8 ? chance(r, 0.3) : si === 11 ? chance(r, 0.4) : chance(r, 0.55);
  const direction: Direction = inbound ? 'inbound' : 'outbound';
  const name = pick(r, NAMES);
  const nameKnown = returning || (!inbound && chance(r, 0.6));
  const objective = si === 8 ? pick(r, ['Send the floor plans for Island Park Residences', 'Confirm the site visit time']) : !inbound && si === 3 ? 'requested callback' : null;
  const knownFacts = returning ? { persona: persona.path === 'Broker' ? 'broker' : 'investor', bedrooms: 2, interest: 'Island Park Residences' } : null;
  const beds = pi === 2 || pi === 3 ? 1 : pi === 0 || pi === 4 ? (chance(r, 0.6) ? 2 : 3) : 2;
  const community = pick(r, ['Dubai Islands', 'Dubai Islands', 'JVC', 'Dubai Creek Harbour']);
  const fields: Record<string, string> = {};
  let endReason: EndReason = 'natural_close';
  let nextStep: string | null = null;
  const isBroker = persona.path === 'Broker';
  const nonTarget = persona.path === 'Non-target';

  // ---------- Introduction ----------
  if (si === 11) {
    // Voicemail, silence or wrong number.
    b.agent(inbound ? 'Thanks for calling the sales line. Are you looking for a property today?' : `Hi, this is the sales assistant calling about your enquiry on ${community}. Is now a good time?`);
    if (chance(r, 0.5)) {
      b.caller('Sorry, wrong number.');
      const i = b.agent('No problem at all — sorry to bother you. Goodbye.');
      b.tool(i, 'end_call', {}, 'ended');
    } else {
      endReason = chance(r, 0.5) ? 'voicemail' : 'caller_hangup';
      if (endReason === 'voicemail') { const i = b.agent('Hi, this is the sales assistant returning your enquiry — we will try you again later. Goodbye.'); b.tool(i, 'end_call', {}, 'ended'); }
    }
    return finish();
  }

  let firstAgent: string;
  if (objective === 'requested callback') firstAgent = `Hi ${name}, you asked us to call you back about ${community} — is now still a good time?`;
  else if (returning) firstAgent = fault(0.25, 'intro')
    ? `Hi ${name}, last time we spoke you were a ${knownFacts!.persona}, looking at ${knownFacts!.bedrooms}-bedroom homes in Island Park Residences, and we sent you the brochure. What can I help with today?`
    : `Hi ${name}, good to hear from you again — last time we talked about two-bedrooms in Island Park Residences. What can I help with today?`;
  else if (inbound) firstAgent = nameKnown ? `Thanks for calling, ${name}. Are you looking for a property today?` : 'Thanks for calling the sales line. Are you looking for a property today?';
  else firstAgent = fault(0.3, 'intro')
    ? `Hi${nameKnown ? ' ' + name : ' there'}, this is the sales assistant calling about your enquiry on ${community}. How can I help you?`
    : `Hi${nameKnown ? ' ' + name : ' there'}, this is the sales assistant calling about your enquiry on ${community}. Is now a good time for a couple of minutes?`;
  b.agent(firstAgent);

  const openers: Record<number, string> = {
    0: `Yes. We need more space — we have two kids and the lease ends next year.`,
    1: `Yes, I'm thinking of buying my first place, but I don't really know how off-plan works.`,
    2: `I'm looking at investments. What kind of rental return would I get?`,
    3: `Yes, I'm calling from London — I want to invest in Dubai.`,
    4: `Yes, we live in Dubai Marina now and want to upgrade before our lease ends.`,
    5: `Just looking for now, really.`,
    6: `Yes, go ahead. I'm a broker, actually — I have clients in London asking about Dubai.`,
    7: `I'm an independent broker here in Dubai. I have a couple of buyers.`,
    8: `I already own a unit in Island Park Residences — I have a question about the service charge.`,
    9: `I'm actually looking to rent, not buy.`,
    10: `Hi, I'm calling about a job opening I saw.`,
  };
  const reveal = chance(r, 0.85) ? ({ 0: ' It’s about a bigger place for my family.', 1: ' It would be my first home.', 2: ' I’m looking at it as an investment.', 3: ' I’m calling from London about investing.', 4: ' We want to upgrade before our lease ends.', 5: ' I’m just looking really.', 6: ' I’m a broker with clients in London.', 7: ' I’m an independent broker here in Dubai.' } as Record<number, string>)[pi] ?? '' : '';
  if (si === 3) b.caller(`I'm driving right now — can you call me back later?${reveal}`);
  else if (si === 5) b.caller(`I have a site visit booked for Saturday and I need to move it.${reveal}`);
  else if (si === 4) b.caller(`Can I just speak to a person, please?${reveal}`);
  else if (si === 9 && pi !== 10) b.caller(chance(r, 0.4) ? `Please don't call me again — take my number off your list.` : `I'm not interested, thanks.${reveal}`);
  else b.caller(openers[pi]);

  const personaKnown = returning && knownFacts?.persona;
  const forkNeeded = !personaKnown && !isBroker && !nonTarget && ![3, 4, 5, 9].includes(si);
  let personaResolved = isBroker || nonTarget;
  if (forkNeeded) {
    if (fault(0.25, 'intro')) b.agent('Lovely. Are you buying for yourself, or are you a broker — and what budget do you have in mind?');
    else if (fault(0.12, 'intro') && !isBroker) b.agent('Great. And what kind of brokerage do you work with?'); // wrong path
    else b.agent('Lovely. Are you buying for yourself, or are you a broker?');
    b.caller(pi === 0 ? 'For myself — for my family.' : pi === 2 || pi === 3 ? 'For myself, as an investment.' : 'For myself.');
    personaResolved = true;
  } else if (personaKnown && fault(0.2, 'reask')) {
    b.agent('Before we start — are you buying for yourself, or are you a broker?');
    b.caller(`I told you last time, I'm buying for myself.`);
  }
  fields.persona = isBroker ? 'Broker' : nonTarget ? 'Non-target' : 'Investor';

  if (!nameKnown && ![3, 9].includes(si) && pi !== 10) {
    const i = b.agent(fault(0.2, 'intro') ? 'May I take your name, and the best email to reach you on?' : 'May I take your name?');
    b.caller(`It's ${name}.`);
    const late = fault(0.25, 'tools');
    const j = b.agent(`Thanks, ${name}.`);
    if (!late) b.tool(j, 'update_caller_details', { name }, 'ok');
    void i;
  } else if (nameKnown && fault(0.12, 'reask') && ![3, 9].includes(si)) {
    b.agent('Sorry — may I take your name again?');
    b.caller(`It's ${name}, you used it a minute ago.`);
  }
  if (nameKnown || ![3, 9].includes(si)) fields.name = name;

  // ---------- Body ----------
  const projectTool = (n: number, filler: boolean, comm: string | null = community) => {
    const res = { projects: projectsFor(r, beds, comm, n) };
    const dur = slow && chance(r, 0.6) ? 3.5 + r() * 3.5 : 0.5 + r() * 1.2;
    b.blockingTool('get_project_details', { bedrooms: beds, communities: comm ? [comm] : [] }, res, filler ? pick(r, ['Let me check which ones are open right now.', 'One moment while I pull that up.', 'Let me look that up for you.']) : null, dur);
    return res.projects;
  };
  const discovery = (deep: boolean) => {
    const investorCaller = pi === 2 || pi === 3;
    const timelineA = pi === 0 || pi === 4 ? 'Within the year, our lease ends next summer.' : investorCaller ? 'In the next year or so — there is no rush.' : pi === 1 ? 'Maybe within the year, once I understand the process.' : 'Not sure yet, honestly.';
    const mustA = pi === 0 ? 'A park for the kids, and the metro for work.' : investorCaller ? 'Strong rental demand near the metro, and a firm handover date.' : pi === 4 ? 'More space than our current flat, and close to the marina.' : pi === 1 ? 'Something simple near the metro.' : 'I do not really know yet.';
    const whoA = pi === 0 ? 'The four of us — me, my wife and the two kids.' : investorCaller ? 'It would be rented out, as an investment.' : pi === 4 ? 'My wife and me.' : 'Just me for now.';
    const qs: [string, string, string, string][] = [
      [investorCaller ? 'When are you looking to buy?' : 'When would you want to move in — is there a date your lease ends?', timelineA, 'timeline', pi === 5 ? 'Not captured' : '3–12 months'],
      [`How many bedrooms are you after?`, `${beds} bedrooms ideally.`, 'bedrooms', String(beds)],
      ['Which areas are you considering?', `${community} mainly.`, 'location', community],
      ['Besides that, what matters most — a park, the beach, being near the metro?', mustA, 'must_haves', 'Park, metro access'],
      [investorCaller ? 'Is it for you to live in, or to rent out?' : 'Will it be just you living there, or family too?', whoA, 'who_for', pi === 0 ? 'Family of four' : investorCaller ? 'Investment' : 'Self'],
    ];
    const n = deep ? 4 + Math.floor(r() * 2) : 2 + Math.floor(r() * 2);
    const reacts = ['Got it.', 'That helps.', 'Makes sense.', 'Noted.', 'Good to know.'];
    let lastAnswer = '';
    for (const [aq, ca, k, v] of qs.slice(0, n)) {
      const doubled = fault(0.22, 'discovery');
      const react = lastAnswer && !fault(0.45, 'discovery') ? `${pick(r, reacts)} ${k === 'who_for' && /kids|family/.test(lastAnswer) ? 'With the kids in mind, space matters.' : k === 'must_haves' ? 'Then the community matters as much as the home.' : 'That narrows it down.'} ` : '';
      b.agent(doubled ? `${react}${aq} And have you set a budget yet?` : `${react}${aq}`);
      lastAnswer = ca;
      b.caller(ca);
      fields[k] = v;
      if (doubled) fields.budget = chance(r, 0.5) ? 'Up to 2 million AED' : 'Not captured';
    }
    fields.buy_intent = pi === 2 || pi === 3 ? 'Investment' : 'Live in';
    fields.property_type = 'Apartment';
    if (!fields.budget && chance(r, 0.5)) {
      if (returning && fault(0.3, 'reask')) { b.agent('Which project were you interested in again?'); b.caller('Island Park — the one we talked about last time.', { barge: true }); }
      b.agent('Have you set a budget yet?'); b.caller(chance(r, 0.6) ? 'Around two million dirhams.' : `Let's see what's there first.`);
      fields.budget = 'Up to 2 million AED';
    }
  };
  const pitch = () => {
    const filler = !fault(0.35, 'tools');
    const list = fault(0.4, 'pitch');
    let projs: ReturnType<typeof projectsFor> = [];
    if (fault(0.025)) {
      // Ungrounded: states a fact without calling the tool, sometimes inventing the number.
      const fake = 1_400_000 + Math.floor(r() * 6) * 50_000;
      b.agent(`There's a great option on ${community} — two-bedrooms start at around ${fmtAed(fake)} and hand over in 2027.`, { tag: 'confidently' });
      b.caller('Okay, and what else is there?');
    }
    projs = projectTool(list ? 3 : 2, filler);
    if (list) b.agent(`There are three that could work: ${projs.map((p) => `${p.name} in ${p.community}`).join(', ')}.`, { tag: 'confidently' });
    else {
      const [a, c] = projs;
      const pa = DEMO_PROJECTS.find((p) => p.id === a.id)!, pc = DEMO_PROJECTS.find((p) => p.id === c.id)!;
      b.agent(`Two fit what you described${pi === 0 && !fault(0.4, 'pitch') ? ', with the kids in mind' : ''}: ${a.name} is ${pa.vibe}, and ${c.name} is ${pc.vibe}. Which sounds closer?`);
    }
    if (fault(0.15, 'pitch')) {
      b.caller(`Not ${projs[projs.length - 1].community} — we said ${community}. Which is better for a family?`, { barge: true });
      if (!fault(0.5, 'objection')) b.agent(`Sorry — you're right, ${community} it is.`);
    } else b.caller(`The first one sounds right. How much are the ${beds}-bedrooms there?`);
    const p = projs[0];
    if (fault(0.02)) b.agent(`In ${p.name}, ${beds}-bedrooms start from about ${fmtAed(p.from_aed - 150_000)}, and there's a 60/40 payment plan with a guaranteed 8% return.`, { tag: 'enthusiastically' });
    else b.agent(`In ${p.name}, ${beds}-bedrooms start from about ${fmtAed(p.from_aed)} on the current price list, at around ${p.size_sqft.toLocaleString('en-US')} square feet. Does that sit in your range?`);
    if (fault(0.18, 'pitch')) {
      b.agent(`${p.name} also has a residents' pool deck, a gym, a children's play area, landscaped parks, retail on the ground floor, covered parking, a concierge, smart-home features in every unit, and the payment plan spreads over construction with a portion on handover, so you would not pay everything up front, and there are several layouts to choose from depending on the view you prefer.`);
      b.caller('Okay, okay — that is a lot. What about the price for a family?', { barge: true });
    }
    fields.project_interest = p.name;
    return p;
  };
  const objection = (kind: 'budget' | 'location' | 'timing' | 'family') => {
    const lines = { budget: `It's a bit above what we wanted to spend.`, location: `I'm not sure about the location — it's far from my office.`, timing: `The handover is too late for us.`, family: `I need to talk to my wife before deciding anything.` };
    b.caller(lines[kind]);
    if (fault(0.3, 'objection')) {
      b.agent(`Great question! Honestly it's one of the most exciting launches this year — you really shouldn't miss it.`, { tag: 'enthusiastically' });
      b.caller('I said it is too expensive.');
      b.agent('I understand, but prices are only going up — shall I book you a viewing anyway?');
      b.caller(`No. Not now.`);
      return false;
    }
    b.agent(kind === 'family' ? 'That makes sense — it is a family decision. Would it help if I sent the floor plans so you can look together?' : `Fair enough — that matters. The layouts without the study come in a little lower; would a brochure with both help you compare?`, { tag: 'empathetically' });
    b.caller(chance(r, q) ? 'Yes, send it over.' : 'No, I think I will leave it for now.');
    return b.turns[b.turns.length - 1].text.startsWith('Yes');
  };
  const sendDocs = (p: { name: string; id: string }) => {
    const readBack = !fault(0.02, 'readback');
    if (readBack) { b.agent('Should it go to your WhatsApp, on the number ending 47?'); b.caller('Yes, that one.'); }
    const claimFirst = fault(0.04, 'readback');
    if (claimFirst) { const i = b.agent(`Done — it's on your WhatsApp now.`); b.tool(i, 'send_documents', { project_ids: [p.id], doc_type: 'brochure', channel: 'whatsapp' }, { status: chance(r, 0.15) ? 'failed' : 'sent' }); }
    else {
      const ok = !chance(r, 0.05);
      const i = b.agent('Sending it now.');
      b.tool(i, 'send_documents', { project_ids: [p.id], doc_type: 'brochure', channel: readBack ? 'whatsapp' : '' }, ok ? { status: 'sent', channel: 'whatsapp' } : { status: 'sent', channel: 'email', note: 'WhatsApp undeliverable; sent by email instead' }, true);
      b.agent(ok ? `Sent — the ${p.name} brochure is on your WhatsApp.` : `WhatsApp didn't go through, so I've sent it to your email instead.`);
    }
    if (!fault(0.3, 'tools')) { b.agent('While you look through it — is it the two-bedroom layout you want to compare, or the three?'); b.caller('The two-bedroom.'); }
    return 'document' as const;
  };
  const bookMeeting = (p: { id: string; name: string }, kind: 'site_visit' | 'online' | 'bdm_call') => {
    const forkAsked = kind === 'bdm_call' || !fault(0.25, 'tools');
    if (forkAsked && kind !== 'bdm_call') { b.agent('Would you like to see it in person, or start with an online walkthrough?'); b.caller(kind === 'site_visit' ? 'In person — Saturday morning works.' : 'Online is easier, maybe Tuesday evening.'); }
    else if (kind !== 'bdm_call') { b.caller('Can I come and see it?'); }
    const tz = pi === 3 && !fault(0.3, 'timezone') ? ' UAE time' : '';
    const date = kind === 'site_visit' ? `Saturday the 17th at 10 a.m.${tz}` : kind === 'online' ? `Tuesday the 20th at 7 p.m.${tz}` : `Tuesday the 27th at 11 a.m. UAE time`;
    const i = b.agent('One moment while I book it.');
    const toolKind = forkAsked ? kind : 'site_visit';
    const ok = !chance(r, 0.04);
    b.tool(i, 'schedule_meeting', { meeting_kind: toolKind, project_ids: kind === 'bdm_call' ? [] : [p.id], date: '2026-10-17', time: kind === 'online' ? '19:00' : '10:00' }, ok ? { status: 'confirmed', slot: date } : { status: 'unavailable' }, ok, 0.8 + r() * 0.8);
    if (!ok) { b.agent('That slot has just gone — could Sunday morning work instead?'); b.caller('Sunday is fine.'); const j = b.agent('Booking Sunday.'); b.tool(j, 'schedule_meeting', { meeting_kind: toolKind, project_ids: [p.id], date: '2026-10-18', time: '10:00' }, { status: 'confirmed', slot: 'Sunday the 18th at 10 a.m.' }); }
    const misread = fault(0.15, 'close');
    b.agent(misread ? `You're booked for Saturday at 11 — see you then.` : `You're booked for ${ok ? date : 'Sunday the 18th at 10 a.m.'}${kind === 'site_visit' ? ` at the ${p.name} sales gallery` : ''}. The confirmation will come on WhatsApp.`, { tag: 'confidently' });
    b.caller('Perfect, thank you.');
    return 'meeting' as const;
  };
  const callback = () => {
    const repeat = !fault(0.25, 'tools');
    b.agent('Of course — what time suits you?');
    b.caller('After six this evening.');
    if (repeat) { b.agent('So, today at 6 p.m. — is that right?'); b.caller('Yes.'); }
    const i = b.agent(`I'll call you at 6 p.m.`);
    b.tool(i, 'schedule_callback', { time: '18:00', date: 'today' }, { status: 'scheduled' });
    return 'callback' as const;
  };
  const transfer = () => {
    const filler = !fault(0.3, 'transfer');
    const idx = filler ? b.agent('Of course — let me see who is free right now.') : -1;
    const free = chance(r, 0.55 + q * 0.3);
    const dur = 1.5 + r() * 4 + (slow ? 2 : 0);
    if (idx >= 0) b.tool(idx, 'request_live_transfer', { reason: 'caller asked for a person' }, free ? { status: 'transfer_to', number: '+97140000000' } : { status: 'unavailable' }, true, dur);
    else b.tool(b.turns.length, 'request_live_transfer', { reason: 'caller asked for a person' }, free ? { status: 'transfer_to', number: '+97140000000' } : { status: 'unavailable' }, true, dur);
    b.t += dur;
    if (free) {
      if (fault(0.06, 'transfer')) { const j = b.agent(`Connecting you now — thanks for calling, goodbye.`); b.tool(j, 'end_call', {}, 'ended'); endReason = 'natural_close'; b.ended = true; return 'transfer_failed' as const; }
      const j = b.agent('Putting you through to an advisor now.');
      b.tool(j, 'transfer_to_number', { number: '+97140000000' }, 'transferred');
      endReason = 'transfer';
      b.ended = true;
      return 'transfer' as const;
    }
    b.agent(`Nobody is free right this minute. I can have an advisor call you back — would 4 p.m. work?`);
    b.caller('Yes, 4 is fine.');
    const k = b.agent('Done — an advisor will call you at 4 p.m.');
    b.tool(k, 'schedule_callback', { time: '16:00', reason: 'transfer fallback' }, { status: 'scheduled' });
    return 'callback' as const;
  };

  const meetProp = clamp([0.42, 0.32, 0.3, 0.28, 0.4, 0.12, 0.3, 0.26, 0.01, 0, 0][pi] * [1.5, 1.1, 0.6, 0.5, 0.7, 0.9, 1.3, 0.95, 1.3, 0.1, 0.15, 0][si] * (0.6 + q * 0.8), 0, 0.92);

  if (nonTarget) {
    if (pi === 8 && chance(r, 0.35)) {
      b.caller(chance(r, 0.5) ? 'Actually, can I resell my unit before handover? I want to know if that is allowed.' : 'I want to change my payment plan — can I move the next instalment?');
      b.agent('That one is for the customer relations team — I can pass your details to them so they call you today.');
      b.caller('Okay, thank you.');
      const i = b.agent('Done — I have noted it for the customer relations team.');
      b.tool(i, 'save_note', { note: 'Existing buyer: resale or payment plan question' }, 'saved');
      nextStep = 'note';
    } else if (pi === 8) {
      if (fault(0.25, 'push')) { b.agent(`I can help with that — and while you're here, Seafront One has some great new launches you might like.`); b.caller(`I just need the service charge team.`); }
      b.agent('That one is for the community team rather than sales — I can pass your number to them so they call you today. Is that okay?');
      b.caller('Yes, please.');
      const i = b.agent('Done — I have noted it for the community team.');
      b.tool(i, 'save_note', { note: 'Owner query: service charge, route to community team' }, 'saved');
      nextStep = 'note';
    } else if (pi === 9) {
      if (fault(0.25, 'push')) { b.agent('We do have some lovely units for sale that could work better than renting — have you thought about buying?'); b.caller('No, I only want to rent.'); }
      b.agent(`We only sell new homes on this line, so I can't help with rentals — a brokerage or a rental portal is the best place to look. Sorry I can't do more.`);
      b.caller('Okay, thanks.');
    } else {
      b.agent(`This line is for property sales, so I can't help with jobs — the careers page on the website has the openings. Thanks for calling.`);
      b.caller('Alright.');
    }
  } else if (si === 3) {
    nextStep = callback();
  } else if (si === 4) {
    nextStep = transfer();
  } else if (si === 5) {
    if (chance(r, 0.6)) {
      b.agent(`No problem — which day would suit better?`); b.caller('Sunday morning instead.');
      const i = b.agent('Moving it to Sunday at 10 a.m.');
      b.tool(i, 'schedule_meeting', { meeting_kind: 'site_visit', date: '2026-10-18', time: '10:00', reschedule: true }, { status: 'confirmed', slot: 'Sunday the 18th at 10 a.m.' });
      b.agent(`Done — your visit is now Sunday the 18th at 10 a.m.`); b.caller('Great.');
      nextStep = 'meeting';
    } else {
      b.agent('Do you want to move it to another day, or cancel it?'); b.caller('Cancel it for now, please.');
      const i = b.agent('Cancelling it.');
      b.tool(i, 'cancel_meeting', { meeting_id: 'mtg_1' }, { status: 'cancelled' });
      b.agent('That visit is cancelled. If you want to rebook, just call this line.'); b.caller('Thanks.');
    }
  } else if (si === 9) {
    const dnc = b.turns[b.turns.length - 1].text.includes(`don't call`);
    if (fault(0.03, 'push')) { b.agent('I understand — but before you go, Island Park has a special payment plan this month. Can I send you the details?'); b.caller('No. I said no.'); }
    b.agent(dnc ? `Of course — I've removed your number, and you won't hear from us again. Sorry for the bother.` : 'No problem at all — thanks for your time.');
    if (dnc) { const i = b.turns.length - 1; b.tool(i, 'save_note', { note: 'do-not-contact' }, 'saved'); }
  } else if (isBroker) {
    if (fault(0.22, 'tools')) {
      // v3's longer prompt sometimes lost the fork: a broker is treated as a buyer.
      b.agent('Lovely. Will it be just you living there, or family too?');
      b.caller(`No — I said I'm a broker. I'm asking for my clients.`, { barge: true });
      if (fault(0.4, 'tools')) { b.agent('Sorry — are you buying for yourself, or are you a broker?'); b.caller('A broker. As I said.'); }
    }
    b.agent('Are you an independent agent, or with an agency?');
    b.caller(pi === 6 ? 'With an agency in London. We sell off-plan to UK buyers.' : 'Independent, here in Dubai.');
    fields.broker_type = pi === 6 ? 'Agency, London' : 'Independent, Dubai';
    if (fault(0.3, 'broker')) { b.agent('What budget are your clients working with, and how many bedrooms are they after?'); b.caller('It varies.'); }
    b.agent('Is your agency already registered with us as a broker partner?');
    const registered = chance(r, 0.3);
    b.caller(registered ? 'Yes, we registered last year.' : 'No, not yet.');
    fields.registration = registered ? 'Registered' : 'Unregistered';
    const hold = fault(0.2, 'broker');
    if (!registered && !hold) {
      b.agent('I can send the registration link now. Should it go to this number on WhatsApp?'); b.caller('Yes, this number is fine.');
      const i = b.agent('Sending the registration link now.');
      b.tool(i, 'send_broker_registration_link', { registered: false, broker_type: pi === 6 ? 'agency' : 'independent', channel: 'whatsapp' }, { status: 'sent' });
    }
    b.caller(`Thanks. What's the handover on the Dubai Islands projects?`);
    if (fault(0.03)) b.agent('Handover is planned for the second quarter of 2027, and two-bedrooms start at around 1.5 million dirhams.', { tag: 'confidently' });
    else { const projs = projectTool(2, true, 'Dubai Islands'); b.agent(`${projs[0].name} hands over in ${projs[0].handover}, and ${projs[1].name} in ${projs[1].handover}; two-bedrooms start from ${fmtAed(projs[0].from_aed)} and ${fmtAed(projs[1].from_aed)}.`); }
    fields.project_interest = 'Dubai Islands';
    if (chance(r, meetProp * 1.4)) {
      b.agent(`Would a call with our broker team help — they can take you through commissions and allocations?`);
      b.caller(`Yes — make it 11 a.m. UAE time, that's morning for me.`);
      nextStep = bookMeeting({ id: '', name: 'broker team' }, 'bdm_call');
    }
    if (!registered && hold) { const i = b.agent(`And I'll send you the registration link.`); b.tool(i, 'send_broker_registration_link', { registered: false, channel: 'whatsapp' }, { status: 'sent' }); }
  } else if (si === 10) {
    const topic = pick(r, ['visa', 'visa', 'mortgage', 'yield']);
    b.caller(topic === 'visa' ? pick(r, ['Would buying here get me a golden visa?', 'Does a purchase here qualify me for the golden visa?', 'How does the golden visa work if I buy off-plan?']) : topic === 'mortgage' ? 'Can you tell me if I would get a mortgage as a non-resident?' : 'What rental yield can I expect on a one-bed?');
    if (fault(0.04, 'scope')) b.agent(topic === 'yield' ? 'You can expect around 7 to 8 percent net on a one-bed there, which is very strong.' : topic === 'visa' ? 'Yes, any purchase above 2 million qualifies you for the golden visa, so you would be fine.' : 'As a non-resident you can usually borrow up to 50 percent, so that should be fine.', { tag: 'confidently' });
    else b.agent(`That's one for an advisor — I can't advise on ${topic === 'yield' ? 'returns' : topic + 's'}, but they can take you through it. In the meantime, can I tell you what's available?`);
    b.caller('Sure.');
    const p = pitch();
    if (chance(r, meetProp + 0.2)) nextStep = sendDocs(p);
  } else {
    // Investor journeys S1, S2, S3, S8, S9 and related.
    if (si === 1 || (si === 2 && chance(r, 0.5))) {
      b.caller(`Can you tell me about ${pick(r, DEMO_PROJECTS).name}? How much are the ${beds}-bedrooms?`);
      if (fault(0.03)) {
        b.agent(`Two-bedrooms there start from about ${fmtAed(1_450_000)}, and it hands over at the end of 2027.`, { tag: 'confidently' });
        b.caller('And how big are they?');
      }
      const projs = projectTool(1, !fault(0.35, 'tools'), null);
      b.agent(`${projs[0].name} ${beds}-bedrooms start from about ${fmtAed(projs[0].from_aed)}, around ${projs[0].size_sqft.toLocaleString('en-US')} square feet, handing over in ${projs[0].handover}.`);
      if (!fault(0.35, 'discovery')) { b.agent('Is it for you to live in, or as an investment?'); b.caller(pi === 2 ? 'As an investment.' : 'To live in.'); fields.buy_intent = pi === 2 ? 'Investment' : 'Live in'; }
      fields.project_interest = projs[0].name;
      if (pi === 2 && chance(r, 0.6)) {
        b.caller(`And how does that compare with the ${pick(r, COMPETITORS)} places I've seen?`);
        if (fault(0.3, 'scope')) b.agent('Honestly this is far better than anything in that area — the returns will be much higher.', { tag: 'enthusiastically' });
        else b.agent(`I can't compare other developers' projects, but I can tell you what's included here. Shall I send the brochure?`);
      }
      if (chance(r, meetProp)) nextStep = bookMeeting({ id: projs[0].id, name: projs[0].name }, chance(r, 0.6) ? 'site_visit' : 'online');
      else if (chance(r, 0.6)) { b.caller('Can you just send me the brochure?'); nextStep = sendDocs({ id: projs[0].id, name: projs[0].name }); }
    } else if (si === 2) {
      b.caller('Can you send me the brochure?');
      if (!fault(0.25, 'readback')) { b.agent('Of course — which project should I send it for?'); b.caller('Island Park Residences.'); }
      nextStep = sendDocs({ id: 'island_park', name: 'Island Park Residences' });
    } else if (si === 8 && objective) {
      b.caller(objective.startsWith('Send') ? 'You were going to send me the floor plans.' : 'I wanted to check the visit time.');
      if (objective.startsWith('Send')) nextStep = sendDocs({ id: 'island_park', name: 'Island Park Residences' });
      else { b.agent('Your visit is on Saturday the 17th at 10 a.m. at the Island Park sales gallery.'); b.caller('Great, thanks.'); nextStep = 'meeting'; }
    } else {
      // S1 discovery to meeting, S8 objection-led, P6 browsers, S9 without objective.
      discovery(si === 0 || pi === 0 || pi === 4);
      const p = pitch();
      if (si === 7 || (pi === 5 && chance(r, 0.6))) {
        const ok = objection(pick(r, ['budget', 'location', 'timing', 'family'] as const));
        if (ok) nextStep = sendDocs(p);
        else if (chance(r, 0.4)) nextStep = callback();
      } else if (chance(r, meetProp)) {
        nextStep = bookMeeting(p, chance(r, 0.7) ? 'site_visit' : 'online');
      } else if (chance(r, 0.4)) {
        b.caller('Let me think about it. Can you send me something to read?');
        nextStep = sendDocs(p);
      } else if (chance(r, 0.35)) {
        b.caller(`Let me think about it and talk it over at home.`);
        b.agent('Of course — take your time. If anything comes up, just call this line.');
      } else if (chance(r, 0.5)) {
        b.caller(`I'll think about it.`);
        const i = b.agent('Of course. I will note that you are interested so an advisor can follow up next week.');
        b.tool(i, 'save_note', { note: `Interested in ${p.name}, follow up next week` }, 'saved');
        nextStep = 'note';
      }
    }
  }

  // ---------- Conclusion ----------
  if (!b.ended && si === 9) {
    const i = b.turns.length - 1;
    if (b.turns[i]?.speaker === 'agent' && !b.tools.some((t) => t.name === 'end_call')) { const j = b.agent('Goodbye.'); b.tool(j, 'end_call', {}, 'ended'); }
    b.ended = true;
  }
  if (!b.ended) {
    const abandon = fault(0.1, 'close');
    if (abandon) {
      b.agent(`Would you like a call with an advisor to talk through the numbers? They can cover payment stages, the community and anything you're comparing against, and I can book it for—`, { interrupted: true });
      endReason = 'caller_hangup';
    } else {
      if (chance(r, 0.6)) { b.agent('Is there anything else I can help with?'); b.caller(`No, that's all. Thanks.`); }
      const closeName = !fault(0.3, 'close') && fields.name;
      const i = b.agent(closeName ? `Thank you, ${fields.name}. Have a good day — goodbye.` : 'Thanks for calling. Goodbye.');
      if (!fault(0.1, 'tools')) b.tool(i, 'end_call', {}, 'ended');
    }
  }
  return finish();

  function finish(): CanonicalCall {
    const dur = Math.max(b.t + 0.5, 4);
    const id = `demo_${seedNo.toString(36)}_${Math.floor(r() * 1e9).toString(36)}`;
    const dyn: Record<string, unknown> = { customer_name: nameKnown ? name : '', known_facts: knownFacts ? JSON.stringify(knownFacts) : '', recent_history: returning ? 'Brochure sent for Island Park Residences two weeks ago' : '', objective: objective ?? '', lead_id: `lead_${seedNo}`, direction, demo_persona: persona.id, demo_scenario: scen.id };
    return {
      provider: 'demo',
      externalId: id,
      agentExternalId: 'demo_sales_agent',
      agentName: 'Sales voice agent (demo)',
      agentVersion: opts.version,
      startedAt: opts.at.toISOString(),
      durationS: +dur.toFixed(1),
      direction,
      endReason,
      endReasonRaw: endReason,
      language: 'en',
      dynamicVariables: dyn,
      turns: b.turns,
      toolCalls: b.tools,
      // Demo calls stand in for dual-channel recordings with no audio model attached, so the
      // transcript-side emotion metrics apply and the audio-only ones drop out.
      recording: { available: true, channels: 2, url: null },
      providerAnalysis: { summary: `${persona.name} · ${scen.name}`, successful: nextStep !== null },
      latency: null,
      cost: { amount: +(dur / 60 * 0.6).toFixed(2), currency: 'AED' },
      leadId: `lead_${seedNo}`,
      promptVersionHint: opts.version,
    };
  }
}

/** A batch of demo calls spread over the last `days`, with prompt versions by date. */
export function generateDemoCalls(o: DemoOptions): CanonicalCall[] {
  const now = o.now ?? new Date();
  const versions = o.versions ?? [{ label: 'v2', fromDaysAgo: o.days, toDaysAgo: Math.floor(o.days / 3) + 1 }, { label: 'v3', fromDaysAgo: Math.floor(o.days / 3), toDaysAgo: 0 }];
  const r = mulberry32(o.seed ?? 42);
  const out: CanonicalCall[] = [];
  for (let i = 0; i < o.count; i++) {
    const daysAgo = r() * o.days;
    const at = new Date(now.getTime() - daysAgo * 86_400_000);
    // Business hours in Dubai (UTC+4): 9:00–21:00.
    at.setUTCHours(5 + Math.floor(r() * 12), Math.floor(r() * 60), Math.floor(r() * 60));
    if (at > now) at.setTime(now.getTime() - 60_000 * (1 + Math.floor(r() * 600)));
    const v = versions.find((x) => daysAgo <= x.fromDaysAgo && daysAgo >= x.toDaysAgo) ?? versions[versions.length - 1];
    out.push(generateCall(i + 1 + (o.seed ?? 42) * 100_000, { at, version: v.label }));
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** CRM outcomes for demo leads: meetings attended, site visits, reservations with AED values. */
export function demoOutcomes(calls: { leadId: string | null; startedAt: string; nextStep: string | null; meetingKind: string | null; persona: string | null; cqs: number | null }[], seed = 9) {
  const r = mulberry32(seed);
  const out: { lead_id: string; stage: string; occurred_at: string; project: string | null; value_aed: number | null; external_id: string }[] = [];
  const deal: Record<string, number> = { P1: 2.1, P2: 1.3, P3: 1.6, P4: 2.4, P5: 2.6, P6: 1.2 };
  for (const c of calls) {
    if (!c.leadId) continue;
    const t0 = new Date(c.startedAt).getTime();
    const q = (c.cqs ?? 70) / 100;
    const at = (d: number) => new Date(Math.min(Date.now() - 3_600_000, t0 + d * 86_400_000)).toISOString();
    if (c.nextStep === 'meeting' && c.meetingKind === 'bdm_call') {
      if (chance(r, 0.6)) out.push({ lead_id: c.leadId, stage: 'broker_registered', occurred_at: at(2 + r() * 5), project: null, value_aed: null, external_id: `${c.leadId}_reg` });
      if (chance(r, 0.5)) out.push({ lead_id: c.leadId, stage: 'bdm_call_held', occurred_at: at(4 + r() * 6), project: null, value_aed: null, external_id: `${c.leadId}_bdm` });
      if (chance(r, 0.2)) out.push({ lead_id: c.leadId, stage: 'broker_deal', occurred_at: at(20 + r() * 60), project: 'Island Park Residences', value_aed: 1_600_000, external_id: `${c.leadId}_bdeal` });
      continue;
    }
    if (c.nextStep !== 'meeting' && !(c.nextStep === 'document' && chance(r, 0.12))) continue;
    if (!chance(r, 0.45 + q * 0.35)) continue;
    out.push({ lead_id: c.leadId, stage: 'meeting_attended', occurred_at: at(2 + r() * 6), project: 'Island Park Residences', value_aed: null, external_id: `${c.leadId}_att` });
    if (chance(r, 0.55)) out.push({ lead_id: c.leadId, stage: 'site_visit', occurred_at: at(3 + r() * 10), project: 'Island Park Residences', value_aed: null, external_id: `${c.leadId}_sv` });
    if (chance(r, 0.05 + q * 0.06)) {
      const v = (deal[c.persona ?? ''] ?? 1.5) * (0.8 + r() * 0.5) * 1_000_000;
      out.push({ lead_id: c.leadId, stage: 'reservation', occurred_at: at(8 + r() * 20), project: 'Island Park Residences', value_aed: Math.round(v / 1000) * 1000, external_id: `${c.leadId}_res` });
    }
  }
  return out;
}
