import { describe, expect, it } from 'vitest';
import { elevenlabs, mapTermination, normaliseElevenLabs } from '../src/connectors/elevenlabs';
import { mapDisconnection, normaliseRetell, retell } from '../src/connectors/retell';
import { sttToTurns } from '../src/connectors/upload';
import { elevenLabsConversation, elevenLabsSignature, retellCall, retellSignature } from './fixtures';

describe('ElevenLabs normalisation', () => {
  const c = normaliseElevenLabs(elevenLabsConversation());

  it('keeps spoken turns and drops tool-only items and backchannels', () => {
    expect(c.turns.map((t) => t.speaker)).toEqual(['agent', 'caller', 'agent', 'caller', 'agent', 'agent', 'caller', 'agent', 'agent']);
    expect(c.turns.some((t) => t.text === 'mm-hmm')).toBe(false);
    expect(c.turns.every((t, i) => t.idx === i)).toBe(true);
  });

  it('estimates turn ends that never overlap the next turn', () => {
    for (let i = 0; i < c.turns.length - 1; i++) expect(c.turns[i].endS!).toBeLessThanOrEqual(c.turns[i + 1].startS);
  });

  it('attaches tool calls to the agent turn that made them, with results and latency', () => {
    expect(c.toolCalls).toHaveLength(2);
    const [details, docs] = c.toolCalls;
    expect(details).toMatchObject({ name: 'get_project_details', ok: true, durationS: 0.8, args: { project: 'Treppan Tower', bedrooms: 1 }, result: { starting_price_aed: 1250000 } });
    expect(c.turns[details.turnIdx].text).toMatch(/check the latest availability/);
    expect(c.turns[docs.turnIdx].text).toMatch(/send the brochure/);
  });

  it('maps metadata, direction, lead and prompt version', () => {
    expect(c).toMatchObject({
      provider: 'elevenlabs', externalId: 'conv_01', agentExternalId: 'agent_el_1', agentVersion: 'agtvrsn_7', direction: 'outbound',
      endReason: 'natural_close', language: 'en', fromNumber: '+97140000000', toNumber: '+971500000001', leadId: 'lead_123', promptVersionHint: 'v7',
      cost: { amount: 412, currency: 'credits' },
    });
    expect(c.recording?.available).toBe(true);
    expect(c.turns[2].turnMetrics).toEqual({ convai_llm_service_ttfb: 0.62, convai_tts_service_ttfb: 0.21 });
    expect(c.providerAnalysis?.successful).toBe(true);
    expect(c.providerAnalysis?.dataCollection?.budget.value).toBe('1.5M AED');
  });

  it('maps termination reasons', () => {
    expect(mapTermination('Remote party ended call')).toBe('caller_hangup');
    expect(mapTermination('Maximum duration exceeded')).toBe('time_limit');
    expect(mapTermination('voicemail detected')).toBe('voicemail');
    expect(mapTermination(null)).toBe('unknown');
  });

  it('parses post-call webhooks', () => {
    const data = elevenLabsConversation('conv_9');
    expect(elevenlabs.parseWebhook({ type: 'post_call_transcription', data })).toEqual({ kind: 'call', externalId: 'conv_9', event: 'post_call_transcription', raw: data });
    expect(elevenlabs.parseWebhook({ type: 'post_call_audio', data: { conversation_id: 'conv_9' } }).kind).toBe('ignore');
    expect(elevenlabs.parseWebhook({ hello: 'world' }).kind).toBe('ignore');
  });
});

describe('Retell normalisation', () => {
  const c = normaliseRetell(retellCall());

  it('builds turns from word timings and leaves the human advisor out', () => {
    expect(c.turns).toHaveLength(5);
    expect(c.turns.some((t) => /Ahmed/.test(t.text))).toBe(false);
    expect(c.turns[0].startS).toBeCloseTo(0.2);
    expect(c.turns[0].words?.length).toBeGreaterThan(5);
  });

  it('places a tool call made after the caller spoke on the agent turn that follows', () => {
    const docs = c.toolCalls.find((t) => t.name === 'send_documents')!;
    expect(c.turns[docs.turnIdx].speaker).toBe('agent');
    expect(c.turns[docs.turnIdx].text).toMatch(/connect you/);
    expect(docs.args).toMatchObject({ channel: 'whatsapp' });
  });

  it('maps provider built-in tools onto the framework names', () => {
    const xfer = c.toolCalls.find((t) => t.rawName === 'transfer_to_sales')!;
    expect(xfer.name).toBe('transfer_to_number');
    expect(xfer.ok).toBe(true);
  });

  it('converts latency, cost and recording', () => {
    expect(c.latency).toMatchObject({ e2eP50: 1.1, e2eP90: 2.3, llmP90: 0.9, ttsP50: 0.2 });
    expect(c.cost).toEqual({ amount: 0.375, currency: 'USD' });
    expect(c.recording).toMatchObject({ available: true, channels: 2 });
    expect(c).toMatchObject({ direction: 'inbound', endReason: 'transfer', agentVersion: '3', leadId: 'lead_456', promptVersionHint: 'v2', durationS: 30 });
  });

  it('maps disconnection reasons', () => {
    expect(mapDisconnection('user_hangup')).toBe('caller_hangup');
    expect(mapDisconnection('agent_hangup')).toBe('natural_close');
    expect(mapDisconnection('dial_no_answer')).toBe('no_answer');
    expect(mapDisconnection('agent_hangup', true)).toBe('voicemail');
    expect(mapDisconnection('error_llm_websocket_open')).toBe('error');
  });

  it('parses call webhooks', () => {
    const call = retellCall('call_x');
    expect(retell.parseWebhook({ event: 'call_analyzed', call })).toMatchObject({ kind: 'call', externalId: 'call_x', raw: call });
    // call_started carries no transcript yet: ignored.
    expect(retell.parseWebhook({ event: 'call_started', call: { call_id: 'call_x' } }).kind).toBe('ignore');
  });
});

describe('webhook signatures', () => {
  const body = JSON.stringify({ event: 'call_analyzed', call: { call_id: 'c1' } });

  it('accepts a valid Retell signature and rejects tampering, staleness and a wrong key', async () => {
    const creds = { apiKey: 'key_retell_test', agentIds: [] };
    expect(await retell.verifyWebhook(body, { 'x-retell-signature': retellSignature('key_retell_test', body) }, creds)).toBe(true);
    expect(await retell.verifyWebhook(body + ' ', { 'x-retell-signature': retellSignature('key_retell_test', body) }, creds)).toBe(false);
    expect(await retell.verifyWebhook(body, { 'x-retell-signature': retellSignature('key_retell_test', body, Date.now() - 10 * 60_000) }, creds)).toBe(false);
    expect(await retell.verifyWebhook(body, { 'x-retell-signature': retellSignature('other_key', body) }, creds)).toBe(false);
    expect(await retell.verifyWebhook(body, {}, creds)).toBe(false);
  });

  it('accepts a valid ElevenLabs signature and rejects tampering, staleness and a missing secret', async () => {
    const creds = { apiKey: 'xi_key', webhookSecret: 'wsec_test', agentIds: [] };
    expect(await elevenlabs.verifyWebhook(body, { 'elevenlabs-signature': elevenLabsSignature('wsec_test', body) }, creds)).toBe(true);
    expect(await elevenlabs.verifyWebhook(body.replace('c1', 'c2'), { 'elevenlabs-signature': elevenLabsSignature('wsec_test', body) }, creds)).toBe(false);
    expect(await elevenlabs.verifyWebhook(body, { 'elevenlabs-signature': elevenLabsSignature('wsec_test', body, Math.floor(Date.now() / 1000) - 3600) }, creds)).toBe(false);
    expect(await elevenlabs.verifyWebhook(body, { 'elevenlabs-signature': elevenLabsSignature('wsec_test', body) }, { ...creds, webhookSecret: null })).toBe(false);
  });
});

describe('uploaded recordings', () => {
  it('turns a two-channel transcript into ordered agent and caller turns', () => {
    const w = (text: string, start: number) => text.split(' ').map((x, i) => ({ text: x, start: start + i * 0.3, end: start + i * 0.3 + 0.25, type: 'word' as const }));
    const stt = {
      transcripts: [
        { language_code: 'en', text: '', channel_index: 0, words: [...w('Hello this is Sara', 0), ...w('Which project interests you?', 6)] },
        { language_code: 'en', text: '', channel_index: 1, words: w('Hi I saw your ad', 2.5) },
      ],
    };
    const { turns, language } = sttToTurns(stt as any, { layout: 'al' });
    expect(turns.map((t) => t.speaker)).toEqual(['agent', 'caller', 'agent']);
    expect(language).toBe('en');
  });
});
