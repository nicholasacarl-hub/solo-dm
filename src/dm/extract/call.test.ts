/**
 * One extraction request (spec §3.8) against FakeExtractionClient: stop_reason before content, the
 * joined text and the post-fallback text, case-folded enums, usage priced by usageDelta (fallback
 * iterations at their own rates), the first-event signal, and the idle watchdog.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APIUserAbortError, RateLimitError } from '@anthropic-ai/sdk';
import type { BetaContentBlock, BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { SCRIPTED_WIRE } from '@/test/structuredFixtures';
import { FakeExtractionClient } from '../testing/fakeExtractionClient';
import type { ExtractionBlock, ExtractionRequestInput } from '../libraryRequests';
import { IDLE_TIMEOUT_MS, IdleTimeoutError, answerCandidates, readWire, runExtraction } from './call';

const block = (title: string): ExtractionBlock => ({ id: 'B1', title, path: [title], paragraphs: ['Some text.'], abbreviated: false });
const input = (title: string, kind: ExtractionRequestInput['kind'] = 'monster'): ExtractionRequestInput & { kind: typeof kind } => ({
  kind, model: 'claude-opus-5-5', useFallbacks: true, blocks: [block(title)],
});
const text = (t: string): BetaContentBlock => ({ type: 'text', text: t, citations: null });
const fallbackBlock = { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-sonnet-5-5' } } as unknown as BetaContentBlock;

afterEach(() => vi.useRealTimers());

describe('runExtraction', () => {
  it('returns the wire, the serving model, priced usage and cache reads', async () => {
    const client = new FakeExtractionClient();
    const first = await runExtraction(client, input('Glimmerwing Drake'), {});
    expect(first).toMatchObject({ type: 'ok', wire: SCRIPTED_WIRE['Glimmerwing Drake'].wire, model: 'claude-opus-5-5', cacheRead: 0 });
    const second = await runExtraction(client, input('Bramble Hound'), {});
    expect(second.type === 'ok' && second.cacheRead).toBeGreaterThan(600);
    expect(first.usage).toMatchObject({ requests: 1, outputTokens: 400 });
    expect(first.usage.estimatedCostUsd).toBeGreaterThan(0);
    expect(client.requests[0].options).toEqual({ maxRetries: 0, hasSignal: true });
  });

  it('reports a refusal with its category without reading the content', async () => {
    const client = new FakeExtractionClient().script('Mothkin', { type: 'refusal', category: 'general_harms', partialText: '{"matchesKind": true}' });
    const out = await runExtraction(client, input('Mothkin', 'species'), {});
    expect(out).toMatchObject({ type: 'refused', category: 'general_harms' });
    expect(out).not.toHaveProperty('wire');
  });

  it('reports max_tokens as truncated', async () => {
    const client = new FakeExtractionClient().script('Glimmerwing Drake', { type: 'max_tokens' });
    expect(await runExtraction(client, input('Glimmerwing Drake'), {})).toMatchObject({ type: 'truncated' });
  });

  it('reports non-JSON and schema-invalid answers as invalid', async () => {
    const client = new FakeExtractionClient().script('Glimmerwing Drake', { type: 'answer', text: 'Sorry, here is a summary.' }, { type: 'answer', wire: { name: 'x' } });
    expect(await runExtraction(client, input('Glimmerwing Drake'), {})).toMatchObject({ type: 'invalid', issue: expect.stringMatching(/JSON/) });
    expect(await runExtraction(client, input('Glimmerwing Drake'), {})).toMatchObject({ type: 'invalid', issue: expect.stringMatching(/format/) });
  });

  it('reads the joined text after a mid-stream fallback, and the tail after a restart; the fallback model is reported', async () => {
    const client = new FakeExtractionClient().script('Mothkin', { type: 'fallback', mode: 'continue' }, { type: 'fallback', mode: 'restart' });
    const cont = await runExtraction(client, input('Mothkin', 'species'), {});
    expect(cont).toMatchObject({ type: 'ok', wire: SCRIPTED_WIRE.Mothkin.wire, model: 'claude-sonnet-5-5' });
    const restart = await runExtraction(client, input('Mothkin', 'species'), {});
    expect(restart).toMatchObject({ type: 'ok', wire: SCRIPTED_WIRE.Mothkin.wire });
  });

  it('folds the case of enum values before validating', async () => {
    const wire = { ...SCRIPTED_WIRE['Ashen Choir'].wire, school: 'EVOCATION', saveAbility: 'Dex', attack: 'None' };
    const client = new FakeExtractionClient().script('Ashen Choir', { type: 'answer', wire });
    const out = await runExtraction(client, input('Ashen Choir', 'spell'), {});
    expect(out).toMatchObject({ type: 'ok', wire: { school: 'evocation', saveAbility: 'dex', attack: 'none' } });
  });

  it('prices every billed attempt of a fallback at its own model’s rates (usage.iterations)', async () => {
    const iterations = [
      { type: 'message', model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null },
      { type: 'fallback_message', model: 'claude-sonnet-5-5', input_tokens: 2000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null },
    ] as unknown as BetaUsage['iterations'];
    const client = new FakeExtractionClient().script('Glimmerwing Drake', { type: 'answer', model: 'claude-sonnet-5-5', usage: { iterations } });
    const out = await runExtraction(client, input('Glimmerwing Drake'), {});
    // Opus 1000 in × $4 + 100 out × $20; Sonnet 2000 in × $2 + 200 out × $10 (per million tokens).
    expect(out.usage).toMatchObject({ inputTokens: 3000, outputTokens: 300 });
    expect(out.usage.estimatedCostUsd).toBeCloseTo(0.012, 10);
  });

  it('calls onFirstEvent once, before the stream completes', async () => {
    const client = new FakeExtractionClient();
    const seen: number[] = [];
    const first = vi.fn(() => seen.push(client.requests[0].endedAt ?? -1));
    await runExtraction(client, input('Glimmerwing Drake'), { onFirstEvent: first });
    expect(first).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([-1]);
  });

  it('aborts a stream that sends nothing for IDLE_TIMEOUT_MS and says so', async () => {
    vi.useFakeTimers();
    const client = new FakeExtractionClient().failNext({ type: 'stall' });
    const pending = runExtraction(client, input('Glimmerwing Drake'), {});
    const caught = pending.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1);
    expect(client.requests[0].endedAt).toBeNull();
    await vi.advanceTimersByTimeAsync(2);
    expect(await caught).toBeInstanceOf(IdleTimeoutError);
  });

  it('passes cancellation through and lets typed SDK errors reach the runner', async () => {
    const controller = new AbortController();
    const stalled = new FakeExtractionClient().failNext({ type: 'stall' });
    const pending = runExtraction(stalled, input('Glimmerwing Drake'), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(APIUserAbortError);
    const limited = new FakeExtractionClient().failNext({ type: 'error', status: 429, retryAfter: 30 });
    await expect(runExtraction(limited, input('Glimmerwing Drake'), {})).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe('answerCandidates and readWire', () => {
  it('offers the joined text, then the text after the last fallback block', () => {
    expect(answerCandidates([text('{"a"'), fallbackBlock, text(': 1}')])).toEqual(['{"a": 1}', ': 1}']);
    expect(answerCandidates([text('  ')])).toEqual([]);
    expect(answerCandidates([text('{}')])).toEqual(['{}']);
  });

  it('parses a fenced answer and rejects one without text', () => {
    const wire = SCRIPTED_WIRE['Moth\'s Grace'].wire;
    expect(readWire('feat', [text(`\`\`\`json\n${JSON.stringify(wire)}\n\`\`\``)])).toEqual({ ok: true, wire });
    expect(readWire('feat', [])).toMatchObject({ ok: false });
  });

  it('drops unknown keys instead of keeping them (raw objects never reach a record)', () => {
    const wire = SCRIPTED_WIRE['Moth\'s Grace'].wire;
    const json = `{"__proto__": {"polluted": true}, ${JSON.stringify({ ...wire, extra: 1 }).slice(1)}`;
    const read = readWire('feat', [text(json)]);
    expect(read.ok && read.wire).toEqual(wire);
    expect(read.ok && Object.keys(read.wire)).not.toContain('__proto__');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
