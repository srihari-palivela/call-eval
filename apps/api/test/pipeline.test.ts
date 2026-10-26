import { describe, expect, it } from 'vitest';
import { GATE_CAP } from '@calleval/framework';
import { generateCall } from '../src/connectors/demo';
import { normaliseElevenLabs } from '../src/connectors/elevenlabs';
import { normaliseRetell } from '../src/connectors/retell';
import { DEFAULT_SETTINGS } from '../src/lib/settings';
import { evaluateCall } from '../src/pipeline/evaluate';
import { heuristic } from '../src/pipeline/judge/heuristic';
import { elevenLabsConversation, retellCall } from './fixtures';

const run = (call: ReturnType<typeof normaliseElevenLabs>) => evaluateCall(call, { callId: 'test', judge: heuristic, settings: DEFAULT_SETTINGS });

describe('evaluation pipeline', () => {
  it('scores a clean ElevenLabs investor call end to end', async () => {
    const { evaluation: ev } = await run(normaliseElevenLabs(elevenLabsConversation()));
    expect(ev.judgeMode).toBe('heuristic');
    expect(ev.cqs).toBeGreaterThan(0);
    expect(ev.cqs).toBeLessThanOrEqual(100);
    expect(ev.gates.filter((g) => g.failed)).toEqual([]);
    expect(ev.outcome.nextStep).toBe('document');
    expect(ev.tags.persona.value).toMatch(/^P\d+$/);
    // Every metric is either scored 0–100 or explicitly not applicable; nothing defaults to 100.
    for (const m of ev.metrics) {
      if (m.applicable) expect(m.value === null || (m.value >= 0 && m.value <= 100)).toBe(true);
      else expect(m.value).toBeNull();
    }
    const docs = ev.toolStats.find((t) => t.name === 'send_documents');
    expect(docs?.made).toBe(1);
  });

  it('fails G8 and caps the score when a send is claimed without the tool', async () => {
    const raw = elevenLabsConversation('conv_claim');
    raw.transcript = raw.transcript.filter((t) => !t.tool_calls?.some((c) => c.tool_name === 'send_documents') && !t.tool_results?.some((r) => r.tool_name === 'send_documents'));
    raw.transcript.push({ role: 'agent', message: "Done — it's on your WhatsApp now.", time_in_call_secs: 40 });
    const { evaluation: ev } = await run(normaliseElevenLabs(raw));
    const g8 = ev.gates.find((g) => g.id === 'G8');
    expect(g8?.failed).toBe(true);
    expect(ev.cqs).toBeLessThanOrEqual(GATE_CAP);
  });

  it('recognises a transfer as the next step on a Retell call', async () => {
    const { evaluation: ev } = await run(normaliseRetell(retellCall()));
    expect(ev.outcome.nextStep).toBe('transfer');
    expect(ev.context.direction).toBe('inbound');
  });

  it('tags synthetic calls with the persona and scenario they were generated for', async () => {
    let persona = 0, scenario = 0;
    const n = 120;
    for (let i = 0; i < n; i++) {
      const call = generateCall(1000 + i, { at: new Date(Date.now() - i * 3600_000), version: 'v3' });
      const { evaluation: ev } = await evaluateCall(call, { callId: `t${i}`, judge: heuristic, settings: DEFAULT_SETTINGS });
      if (ev.tags.persona.value === call.dynamicVariables.demo_persona) persona++;
      if (ev.tags.scenarioPrimary.value === call.dynamicVariables.demo_scenario) scenario++;
      if (ev.gates.some((g) => g.failed)) expect(ev.cqs).toBeLessThanOrEqual(GATE_CAP);
    }
    expect(persona / n).toBeGreaterThan(0.75);
    // The generator deliberately includes ambiguous calls (two needs, early hang-ups), so scenario agreement is lower.
    expect(scenario / n).toBeGreaterThan(0.6);
  });
});
