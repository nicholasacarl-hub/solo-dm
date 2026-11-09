import { describe, expect, it } from 'vitest';
import { APIUserAbortError, AuthenticationError, BadRequestError, OverloadedError, RateLimitError } from '@anthropic-ai/sdk';
import type { BetaTextBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { SCRIPTED_WIRE } from '@/test/structuredFixtures';
import { buildExtractionRequest, type ExtractionBlock } from '../libraryRequests';
import { FakeExtractionClient } from './fakeExtractionClient';

const block = (title: string): ExtractionBlock => ({ id: 'B1', title, path: ['Bestiary', title], paragraphs: ['Some text.'], abbreviated: false });
const request = (title: string, kind: 'monster' | 'species' = 'monster') =>
  buildExtractionRequest({ kind, model: 'claude-opus-5-5', useFallbacks: true, blocks: [block(title)] });

async function run(client: FakeExtractionClient, params = request('Glimmerwing Drake'), signal?: AbortSignal) {
  const stream = client.beta.messages.stream(params, { signal, maxRetries: 0 });
  let events = 0;
  for await (const _event of stream) events += 1;
  return { message: await stream.finalMessage(), events };
}

describe('FakeExtractionClient', () => {
  it('answers by the first block title with the SCRIPTED_WIRE JSON and records the request', async () => {
    let t = 1000;
    const client = new FakeExtractionClient({ now: () => (t += 10) });
    const { message, events } = await run(client);
    const text = (message.content.find((b) => b.type === 'text') as BetaTextBlock).text;
    expect(JSON.parse(text)).toEqual(SCRIPTED_WIRE['Glimmerwing Drake'].wire);
    expect(message.stop_reason).toBe('end_turn');
    expect(events).toBeGreaterThan(2);
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]).toMatchObject({ n: 1, title: 'Glimmerwing Drake', kind: 'monster', options: { maxRetries: 0, hasSignal: false } });
    expect(client.requests[0].firstEventAt).toBeGreaterThan(client.requests[0].at);
    expect(client.requests[0].endedAt).not.toBeNull();
  });

  it('writes the kind cache on its first request and reads it afterwards', async () => {
    const client = new FakeExtractionClient();
    const first = (await run(client)).message.usage;
    const second = (await run(client)).message.usage;
    expect(first.cache_creation_input_tokens).toBeGreaterThan(600);
    expect(first.cache_read_input_tokens).toBe(0);
    expect(second.cache_read_input_tokens).toBe(first.cache_creation_input_tokens);
  });

  it('plays scripted steps per title in order, then falls back to the scripted answer', async () => {
    const client = new FakeExtractionClient().script('Glimmerwing Drake', { type: 'max_tokens' }, { type: 'refusal', category: 'general_harms' });
    expect((await run(client)).message.stop_reason).toBe('max_tokens');
    const refused = (await run(client)).message;
    expect(refused.stop_reason).toBe('refusal');
    expect(refused.stop_details?.category).toBe('general_harms');
    expect((await run(client)).message.stop_reason).toBe('end_turn');
  });

  it('throws typed SDK errors when the stream is read (429 with retry-after, 529, 401, 400)', async () => {
    const client = new FakeExtractionClient().failNext(
      { type: 'error', status: 429, retryAfter: 40 },
      { type: 'error', status: 529 },
      { type: 'error', status: 401 },
      { type: 'error', status: 400, message: 'Schema is too complex' },
    );
    const rate = await run(client).catch((e: unknown) => e);
    expect(rate).toBeInstanceOf(RateLimitError);
    expect((rate as RateLimitError).headers.get('retry-after')).toBe('40');
    await expect(run(client)).rejects.toBeInstanceOf(OverloadedError);
    await expect(run(client)).rejects.toBeInstanceOf(AuthenticationError);
    await expect(run(client)).rejects.toBeInstanceOf(BadRequestError);
    expect(client.requests.map((r) => r.firstEventAt)).toEqual([null, null, null, null]);
  });

  it('builds mid-stream fallbacks whose joined text (continue) or tail (restart) is the answer', async () => {
    const client = new FakeExtractionClient().script('Mothkin', { type: 'fallback', mode: 'continue' }, { type: 'fallback', mode: 'restart' });
    const texts = (m: { content: { type: string }[] }) => m.content.filter((b) => b.type === 'text').map((b) => (b as BetaTextBlock).text);
    const cont = (await run(client, request('Mothkin', 'species'))).message;
    expect(cont.content.map((b) => b.type)).toEqual(['text', 'fallback', 'text']);
    expect(JSON.parse(texts(cont).join(''))).toEqual(SCRIPTED_WIRE.Mothkin.wire);
    const restart = (await run(client, request('Mothkin', 'species'))).message;
    expect(JSON.parse(texts(restart)[1])).toEqual(SCRIPTED_WIRE.Mothkin.wire);
    expect(restart.model).toBe('claude-sonnet-5-5');
  });

  it('stalls until aborted, for the idle watchdog', async () => {
    const client = new FakeExtractionClient().failNext({ type: 'stall' });
    const controller = new AbortController();
    const pending = run(client, request('Glimmerwing Drake'), controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(APIUserAbortError);
    expect(client.requests[0].firstEventAt).toBeNull();
  });
});
