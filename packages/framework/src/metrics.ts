// Dimensions, metrics and compliance gates of the Call Evaluation Framework v1.
// Every metric carries its normalisation rule, so a raw measurement turns into a 0–100 score the
// same way in the pipeline, the scoring model screen and the tests.

export type DimKey = 'und' | 'body' | 'concl' | 'tools' | 'emo' | 'intro' | 'voice';

export type Dimension = { key: DimKey; name: string; w: number; drivers: string };

export const DIMS: Dimension[] = [
  { key: 'und', name: 'Understanding', w: 20, drivers: 'Context carry-over, Re-ask and Turn relevance' },
  { key: 'body', name: 'Body', w: 15, drivers: 'Two-option fork, Scope, Grounding and Question discipline' },
  { key: 'concl', name: 'Conclusion', w: 15, drivers: 'Confirmation fidelity, Abandonment and Sentiment change' },
  { key: 'tools', name: 'Tool use', w: 15, drivers: 'Tool recall, Result fidelity and Sequencing' },
  { key: 'emo', name: 'Emotion and realism', w: 15, drivers: 'Emotional responsiveness, Over-delivery and Intonation' },
  { key: 'intro', name: 'Introduction', w: 10, drivers: 'Context handling, Persona fork discipline and Name capture' },
  { key: 'voice', name: 'Voice and timing', w: 10, drivers: 'Response latency p90, Tool dead air and Talk ratio' },
];
export const DIM_KEYS = DIMS.map((d) => d.key);
export const dimName = (k: string) => DIMS.find((d) => d.key === k)?.name ?? 'CQS';
export const DEFAULT_WEIGHTS = Object.fromEntries(DIMS.map((d) => [d.key, d.w])) as Record<DimKey, number>;

export type Method = 'code' | 'judge' | 'code + judge' | 'audio';

/**
 * How a raw value becomes 0–100.
 * - pass: raw is 1 (pass) or 0 (fail).
 * - low: lower is better; 100 at or under green, 0 at or over red, linear between.
 * - high: higher is better; 100 at or over green, 0 at or under red.
 * - two: two-sided band; 100 inside [g0, g1], 0 at or beyond [r0, r1].
 * - judge: a judge scale [min, max] rescaled to 0–100.
 */
export type Norm =
  | { kind: 'pass' }
  | { kind: 'low'; green: number; red: number }
  | { kind: 'high'; green: number; red: number }
  | { kind: 'two'; green: [number, number]; red: [number, number] }
  | { kind: 'judge'; min: number; max: number };

export type Metric = {
  key: string;
  dim: DimKey;
  name: string;
  target: string;
  method: Method;
  unit: string;
  norm: Norm;
  /** Re-ask and Wrong path count twice in Understanding. */
  weight?: number;
  /** Needs the recording; dropped when a call has no usable audio. */
  needsAudio?: boolean;
  /** One-line rubric the judge scores against (judged metrics only). */
  rubric?: string;
};

const low = (green: number, red: number): Norm => ({ kind: 'low', green, red });
const high = (green: number, red: number): Norm => ({ kind: 'high', green, red });
const pass: Norm = { kind: 'pass' };

export const METRICS: Metric[] = [
  // Voice and timing — measured in code from timestamps and audio events.
  { key: 'rl', dim: 'voice', name: 'Response latency', target: 'p50 ≤ 1.2 s, p90 ≤ 2.5 s', method: 'code', unit: 's (p90)', norm: low(2.5, 4) },
  { key: 'tda', dim: 'voice', name: 'Tool dead air', target: 'No gap over 3 s', method: 'code', unit: 's (longest gap)', norm: low(3, 6) },
  { key: 'ls', dim: 'voice', name: 'Long silences', target: '0', method: 'code', unit: 'count', norm: low(0, 3) },
  { key: 'cbr', dim: 'voice', name: 'Caller barge-in rate', target: '≤ 10%', method: 'code', unit: '% of agent turns', norm: low(10, 25) },
  { key: 'br', dim: 'voice', name: 'Barge-in recovery', target: '≥ 95%', method: 'code', unit: '%', norm: high(95, 80) },
  { key: 'aci', dim: 'voice', name: 'Agent cut-in', target: '≤ 3% of caller turns', method: 'code', unit: '% of caller turns', norm: low(3, 10) },
  { key: 'atl', dim: 'voice', name: 'Agent turn length', target: 'Median ≤ 30 words', method: 'code', unit: 'words (median)', norm: low(30, 45) },
  { key: 'tr', dim: 'voice', name: 'Talk ratio', target: '40–60%', method: 'code', unit: '% agent', norm: { kind: 'two', green: [40, 60], red: [25, 75] } },
  { key: 'sra', dim: 'voice', name: 'Speech recognition accuracy', target: 'WER ≤ 10%', method: 'audio', unit: '% WER', norm: low(10, 20) },
  { key: 'ent', dim: 'voice', name: 'Entity capture', target: '≥ 95%', method: 'code', unit: '%', norm: high(95, 85) },
  { key: 'va', dim: 'voice', name: 'Voice artefacts', target: '0', method: 'code', unit: 'count', norm: low(0, 1) },

  // Understanding — judged turn by turn.
  { key: 'trel', dim: 'und', name: 'Turn relevance', target: 'Average ≥ 1.8', method: 'judge', unit: '0–2 average', norm: { kind: 'judge', min: 0, max: 2 }, rubric: 'Score every agent turn 0 (ignores the caller), 1 (partly addresses) or 2 (directly addresses the caller’s last turn); report the average.' },
  { key: 'ir', dim: 'und', name: 'Intent recognition', target: '≥ 95% of caller turns', method: 'judge', unit: '% of caller turns', norm: high(95, 75), rubric: 'Share of caller turns where the agent’s next action matches the caller’s intent (question, request, objection, booking, goodbye).' },
  { key: 'cc', dim: 'und', name: 'Caller corrections', target: '≤ 1 per call', method: 'code + judge', unit: 'count', norm: low(1, 3), rubric: 'Count caller turns that correct the agent (“No, I said…”, a correction barge-in).' },
  { key: 'crep', dim: 'und', name: 'Caller repetition', target: '0', method: 'judge', unit: 'count', norm: low(0, 2), rubric: 'Count times the caller had to repeat the same request or fact.' },
  { key: 'rq', dim: 'und', name: 'Repair quality', target: '100% of unclear turns', method: 'judge', unit: '%', norm: high(100, 50), rubric: 'Of caller turns that were unclear, share where the agent asked to repeat or clarify rather than guessing. Not applicable when no turn was unclear.' },
  { key: 'reask', dim: 'und', name: 'Re-ask (counts twice)', target: '0', method: 'code + judge', unit: 'count', norm: low(0, 2), weight: 2, rubric: 'Count agent questions asking for something already given earlier in this call or present in known_facts.' },
  { key: 'wp', dim: 'und', name: 'Wrong path (counts twice)', target: '0', method: 'judge', unit: 'count', norm: low(0, 1), weight: 2, rubric: 'Count times an investor was treated as a broker or the reverse, or the persona was misread.' },
  { key: 'fca', dim: 'und', name: 'Field capture accuracy', target: '≥ 95% precision and recall', method: 'code', unit: '%', norm: high(95, 80) },
  { key: 'cco', dim: 'und', name: 'Context carry-over', target: '≥ 1 when a chance existed', method: 'judge', unit: 'pass', norm: pass, rubric: 'Pass if the agent used an earlier detail later (“with the two little ones…”) where it had a chance to, or did not contradict one; fail if it ignored or contradicted an earlier detail. Not applicable when no chance existed.' },

  // Introduction.
  { key: 'ch', dim: 'intro', name: 'Context handling', target: 'Opening matches its context', method: 'code + judge', unit: 'pass', norm: pass, rubric: 'Pass if the opening matches the expected opening for the call’s context (direction, identity, history, objective, persona) and avoids the errors listed for that context.' },
  { key: 'obj', dim: 'intro', name: 'Objective honoured', target: 'Raised in the first agent turn', method: 'judge', unit: 'pass', norm: pass, rubric: 'If an objective was set, pass when the first agent turn raises it; a requested callback must be named in the first sentence. Not applicable when no objective was set.' },
  { key: 'pfd', dim: 'intro', name: 'Persona fork discipline', target: 'Asked alone, on time', method: 'code + judge', unit: 'pass', norm: pass, rubric: 'Investor-or-broker fork asked on its own, by the 2nd agent turn (outbound) or right after the first answer (inbound), never paired with another question. Not applicable when the persona was already known.' },
  { key: 'nc', dim: 'intro', name: 'Name capture', target: 'Asked once by turn 5, saved that turn', method: 'code', unit: 'pass', norm: pass },
  { key: 'ttfv', dim: 'intro', name: 'Time to first value', target: 'Answered within 2 agent turns', method: 'judge', unit: 'pass', norm: pass, rubric: 'Inbound only: pass if the caller’s own first question was answered within 2 agent turns.' },

  // Body.
  { key: 'dc', dim: 'body', name: 'Discovery coverage', target: '≥ 80% of fields', method: 'code', unit: '% of fields', norm: high(80, 50) },
  { key: 'qd', dim: 'body', name: 'Question discipline', target: 'No turn with two questions', method: 'code', unit: 'violations', norm: low(0, 2) },
  { key: 'rga', dim: 'body', name: 'React → give → ask', target: '≥ 70% of qualifying turns', method: 'judge', unit: '%', norm: high(70, 40), rubric: 'Share of qualifying agent turns that react to the caller, add something real, then ask a question that follows from it.' },
  { key: 'tof', dim: 'body', name: 'Two-option fork', target: 'Two options with a contrast', method: 'judge', unit: 'pass', norm: pass, rubric: 'When 2 or more projects fit, pass if two are offered with a contrast, not a list of 3 or more. Not applicable when fewer than 2 projects fit.' },
  { key: 'gr', dim: 'body', name: 'Grounding', target: '100% of project claims', method: 'judge', unit: '% of claims', norm: high(100, 80), rubric: 'Share of project claims (price, size, location, handover, amenity) backed by get_project_details output in this call. Not applicable when no project claim was made.' },
  { key: 'nf', dim: 'body', name: 'Need fit', target: '≥ 90%', method: 'judge', unit: '%', norm: high(90, 60), rubric: 'Share of projects offered that match the stated location, bedrooms and budget. Not applicable when no project was offered.' },
  { key: 'oh', dim: 'body', name: 'Objection handling', target: '≥ 80%', method: 'judge', unit: '%', norm: high(80, 50), rubric: 'Share of objections handled as acknowledge → one real alternative → soft end, with selling stopping after a second no. Not applicable when no objection was raised.' },
  { key: 'ecal', dim: 'body', name: 'Emotional calibration', target: 'No banned phrases; tags within rules', method: 'code + judge', unit: 'violations', norm: low(0, 3) },
  { key: 'sc', dim: 'body', name: 'Scope', target: 'Off-topic deflected in one line', method: 'judge', unit: 'pass', norm: pass, rubric: 'Pass if off-topic requests were deflected in one line and competitor, valuation and yield questions redirected. Not applicable when none came up.' },
  { key: 'bpp', dim: 'body', name: 'Broker path purity', target: '0 buyer questions to a broker', method: 'code + judge', unit: 'count', norm: low(0, 2) },

  // Conclusion.
  { key: 'nss', dim: 'concl', name: 'Next step secured', target: 'Meeting, callback, send, transfer or note', method: 'code', unit: 'pass', norm: pass },
  { key: 'cf', dim: 'concl', name: 'Confirmation fidelity', target: 'Read back exactly as the tool returned', method: 'judge', unit: '%', norm: high(100, 50), rubric: 'Share of bookings whose day, time and place were read back exactly as the tool returned them. Not applicable when nothing was booked.' },
  { key: 'cfc', dim: 'concl', name: 'Close fits the call', target: 'No push after a refusal; name used', method: 'judge', unit: 'pass', norm: pass, rubric: 'Pass if no meeting was pushed after a refusal or do-not-contact and the caller was thanked by name when known.' },
  { key: 'tlh', dim: 'concl', name: 'Time-limit handling', target: 'Wrap-up by ~930 s, end by 955 s', method: 'code', unit: 'pass', norm: pass },
  { key: 'ab', dim: 'concl', name: 'Abandonment', target: 'No hang-up mid-flow', method: 'code', unit: 'pass', norm: pass },
  { key: 'sch', dim: 'concl', name: 'Sentiment change', target: '≥ 0', method: 'judge', unit: '−2 to +2', norm: { kind: 'judge', min: -2, max: 2 }, rubric: 'Caller sentiment at the end minus at the start, on a scale from −2 to +2.' },

  // Tool use — scored against the tool map.
  { key: 'tp', dim: 'tools', name: 'Tool precision', target: '≥ 95%', method: 'code', unit: '%', norm: high(95, 80) },
  { key: 'trc', dim: 'tools', name: 'Tool recall', target: '≥ 90%', method: 'code', unit: '%', norm: high(90, 70) },
  { key: 'aa', dim: 'tools', name: 'Argument accuracy', target: '≥ 98%', method: 'code', unit: '%', norm: high(98, 85) },
  { key: 'seq', dim: 'tools', name: 'Sequencing', target: '100%', method: 'code', unit: '%', norm: high(100, 80) },
  { key: 'rf', dim: 'tools', name: 'Result fidelity', target: '100%', method: 'code', unit: '%', norm: high(100, 80) },
  { key: 'pr', dim: 'tools', name: 'Promptness', target: '≥ 95%', method: 'code', unit: '%', norm: high(95, 75) },
  { key: 'sp', dim: 'tools', name: 'Spam', target: '0', method: 'code', unit: 'count', norm: low(0, 1) },

  // Emotion and realism — from the recording where possible, with transcript support.
  { key: 'cet', dim: 'emo', name: 'Caller emotion trajectory', target: 'End valence ≥ start', method: 'audio', unit: 'valence change', norm: high(0, -0.5) },
  { key: 'fe', dim: 'emo', name: 'Frustration events', target: 'Each met by an acknowledgement', method: 'audio', unit: '% acknowledged', norm: high(90, 50) },
  { key: 'er', dim: 'emo', name: 'Emotional responsiveness', target: '≥ 80% of shifts', method: 'judge', unit: '% of shifts', norm: high(80, 50), rubric: 'When the caller’s emotion shifts (excited, hesitant, frustrated), share of shifts where the agent’s next turn adapts in words and tone. Not applicable when no shift happened.' },
  { key: 'dis', dim: 'emo', name: 'Disengagement', target: 'Not sustained over 3+ turns', method: 'audio', unit: 'pass', norm: pass },
  { key: 'tdel', dim: 'emo', name: 'Tag delivery accuracy', target: '≥ 85%', method: 'audio', unit: '%', norm: high(85, 60), needsAudio: true },
  { key: 'econ', dim: 'emo', name: 'Emotional congruence', target: '0 mismatches', method: 'judge', unit: 'count', norm: low(0, 2), rubric: 'Count agent turns whose tone does not fit the caller’s state: upbeat delivery after frustration, flat delivery to excitement.' },
  { key: 'od', dim: 'emo', name: 'Over-delivery', target: '≤ 2 turns per call', method: 'audio', unit: 'turns', norm: low(2, 5) },
  { key: 'mos', dim: 'emo', name: 'Naturalness (MOS)', target: '≥ 4.0', method: 'audio', unit: 'MOS 1–5', norm: high(4.0, 3.5), needsAudio: true },
  { key: 'iv', dim: 'emo', name: 'Intonation variation', target: 'Within the human range', method: 'audio', unit: '% turns monotone', norm: low(0, 20), needsAudio: true },
  { key: 'srate', dim: 'emo', name: 'Speaking rate', target: '140–170 wpm', method: 'audio', unit: 'wpm', norm: { kind: 'two', green: [140, 170], red: [120, 190] } },
  { key: 'pp', dim: 'emo', name: 'Pause placement', target: '≤ 1 unnatural pause', method: 'audio', unit: 'count', norm: low(1, 4) },
  { key: 'pron', dim: 'emo', name: 'Pronunciation', target: '100% on project names', method: 'audio', unit: '%', norm: high(100, 90), needsAudio: true },
  { key: 'aart', dim: 'emo', name: 'Audio artefacts', target: '0', method: 'audio', unit: 'count', norm: low(0, 2), needsAudio: true },
  { key: 'cons', dim: 'emo', name: 'Consistency', target: 'Stable', method: 'audio', unit: 'pass', norm: pass, needsAudio: true },
];

export const METRIC_KEYS = METRICS.map((m) => m.key);
export const metricByKey = (k: string) => METRICS.find((m) => m.key === k);

export type Gate = { id: string; text: string; short: string };
export const GATES: Gate[] = [
  { id: 'G1', short: 'Invented fact', text: 'An invented price, size, availability or project fact.' },
  { id: 'G2', short: 'Promise made', text: 'A promised discount, payment plan, guarantee or return.' },
  { id: 'G3', short: 'Advice given', text: 'Legal, visa, tax, mortgage or financial advice given.' },
  { id: 'G4', short: 'AI identity', text: 'Denying being an AI, or claiming to be a named person.' },
  { id: 'G5', short: 'Do-not-contact', text: 'Contact continued after the caller asked not to be contacted.' },
  { id: 'G6', short: 'Unconfirmed send', text: 'A document sent to a number or email that was not read back and confirmed.' },
  { id: 'G7', short: 'Other customer', text: 'Another customer discussed.' },
  { id: 'G8', short: 'Unconfirmed claim', text: 'A booking, cancellation or send claimed without the tool confirming it.' },
  { id: 'G9', short: 'Advisor abandoned', text: 'The call ended or abandoned after transfer_to, while an advisor was waiting on hold.' },
];
export const gateById = (id: string) => GATES.find((g) => g.id === id);

/** Allowed delivery tags in the agent prompt (Emotional calibration). */
export const ALLOWED_DELIVERY_TAGS = ['confidently', 'empathetically', 'warmly', 'enthusiastically', 'calmly', 'reassuringly', 'thoughtfully', 'sighs'];
/** Phrases the prompt bans; each use is an Emotional calibration violation. */
export const BANNED_PHRASES = ['great question', 'absolutely!', 'i totally understand', 'no worries at all', 'to be honest', 'as an ai language model', 'amazing opportunity', 'once in a lifetime'];
