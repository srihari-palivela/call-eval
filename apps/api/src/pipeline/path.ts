// Path adherence: the bridge between the scenario taxonomy and the metrics. A call scores the share
// of its scenario's checkpoints it reached in order; the first missed checkpoint is its deviation.

import { PATHS, type CanonicalCall, type PathOutcome, type Phases } from '@calleval/framework';
import type { ToolAnalysis } from './code-checks';
import { lc, RX } from './text';

export function judgeCheckpoints(scenario: string | null) {
  return (PATHS[scenario ?? ''] ?? []).filter((c) => c.detect.by === 'judge').map((c) => ({ id: c.id, label: c.label, hint: c.hint }));
}

export function evaluatePath(call: CanonicalCall, scenario: string | null, phases: Phases, tools: ToolAnalysis, fields: Record<string, string | null>, judged: Record<string, { hit: boolean; turn: number | null }>): PathOutcome | null {
  const cps = PATHS[scenario ?? ''];
  if (!cps?.length) return null;
  const turns = call.turns;
  const okTool = (names: string[]) => call.toolCalls.find((tc) => names.includes(tc.name) && tc.ok !== false && !/\b(fail|failed|unavailable)\b/i.test(tc.resultText ?? ''));
  const steps = cps.map((cp) => {
    let hit = false, turn: number | null = null;
    const d = cp.detect;
    if (d.by === 'tool') { const tc = okTool(d.tools); hit = !!tc; turn = tc?.turnIdx ?? null; }
    else if (d.by === 'judge') { const j = judged[cp.id]; hit = !!j?.hit; turn = j?.turn ?? null; }
    else switch (d.rule) {
      case 'persona_resolved': hit = phases.personaResolvedAt !== null; turn = phases.personaResolvedAt; break;
      case 'discovery': {
        const disc = phases.segments.find((s) => s.name === 'Discovery');
        const n = ['bedrooms', 'location', 'budget', 'timeline', 'must_haves', 'who_for'].filter((k) => fields[k]).length;
        hit = !!disc && n >= 2; turn = disc?.from ?? null; break;
      }
      case 'filler_before_transfer': {
        const tc = call.toolCalls.find((t) => t.name === 'request_live_transfer');
        const at = tc ? turns[tc.turnIdx] : undefined;
        hit = !!(tc && at && at.speaker === 'agent' && (tc.startS === undefined || tc.startS >= at.startS - 0.05));
        turn = at?.idx ?? null; break;
      }
      case 'transfer_outcome': {
        const tc = okTool(['transfer_to_number', 'schedule_callback', 'save_note']);
        hit = !!tc; turn = tc?.turnIdx ?? null; break;
      }
      case 'short_call': hit = call.durationS <= 60 || turns.length <= 4; turn = turns[turns.length - 1]?.idx ?? 0; break;
      case 'tool_confirmed_readback': {
        const tc = okTool(['schedule_meeting', 'cancel_meeting']);
        const rb = tc ? turns.find((t) => t.idx >= tc.turnIdx && t.speaker === 'agent' && /\b(booked|cancell?ed|moved|now|done)\b/i.test(t.text)) : undefined;
        hit = !!rb; turn = rb?.idx ?? null; break;
      }
      case 'question_after_send': {
        const tc = okTool(['send_documents']);
        const q = tc ? turns.find((t) => t.idx > tc.turnIdx && t.speaker === 'agent' && /\?/.test(t.text) && !/anything else/i.test(t.text)) : undefined;
        hit = !!q; turn = q?.idx ?? null; break;
      }
      case 'no_further_pitch': {
        const refusals = turns.filter((t) => t.speaker === 'caller' && (RX.refusal.test(lc(t.text)) || RX.dnc.test(lc(t.text))));
        const pivot = refusals[cp.id === 'stop' ? 1 : 0] ?? refusals[0];
        if (!pivot) { hit = cp.id !== 'stop'; turn = null; break; }
        const push = turns.find((t) => t.idx > pivot.idx && t.speaker === 'agent' && /\b(book|viewing|before you go|special|prices are only going up)\b/i.test(t.text));
        hit = !push; turn = pivot.idx; break;
      }
    }
    return { id: cp.id, label: cp.label, hit, turn };
  });
  // Reached in order: a checkpoint counts if it was hit at or after the previous hit checkpoint.
  let lastTurn = -1, count = 0, deviation: string | null = null;
  for (const s of steps) {
    const inOrder = s.hit && (s.turn === null || s.turn >= lastTurn);
    if (inOrder) { count++; if (s.turn !== null) lastTurn = s.turn; } else if (!deviation) deviation = s.label;
  }
  void tools;
  return { scenario: scenario!, steps, hit: count, total: steps.length, deviation };
}
