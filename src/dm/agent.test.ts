import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/engine', () => import('./testing/fakeEngine'));
vi.mock('@/data', () => import('./testing/fakeData'));
vi.mock('@/state/gameStore', () => import('./testing/fakeGameStoreModule'));

import {
  AnthropicError,
  APIConnectionError,
  AuthenticationError,
  BadRequestError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaRefusalStopDetails,
  BetaToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { DmLogEntry, LogEntry } from '@/types';
import { MAX_ITERATIONS, NOTES, SOFT_LIMIT_PREFIX } from './agent';
import { resetDmDeps } from './deps';
import { makeMessage, textBlock, thinkingBlock, toolUseBlock } from './scripted';
import { fakeDice } from './testing/fakeEngine';
import { setupHarness } from './testing/harness';

beforeEach(() => fakeDice.reset());
afterEach(() => resetDmDeps());

const end = (text: string) => makeMessage([textBlock(text)], 'end_turn');

function blocksOf(param: BetaMessageParam): BetaContentBlockParam[] {
  if (param.role === 'system' || typeof param.content === 'string') return [];
  return param.content;
}

function toolResults(param: BetaMessageParam): BetaToolResultBlockParam[] {
  return blocksOf(param).filter((b): b is BetaToolResultBlockParam => b.type === 'tool_result');
}

function dmEntries(log: LogEntry[]): DmLogEntry[] {
  return log.filter((e): e is DmLogEntry => e.kind === 'dm');
}

const refusalDetails: BetaRefusalStopDetails = {
  type: 'refusal',
  category: 'general_harms',
  explanation: null,
  fallback_credit_token: null,
  fallback_has_prefill_claim: null,
  recommended_model: null,
};

describe('agent loop: a text-only turn', () => {
  it('streams narration into one DM entry, parses choices, and appends user + assistant', async () => {
    const h = setupHarness({
      withSession: true,
      steps: [end('Fog rolls off the water.\n\n```choices\nLook around\nWait for the tide\n```')],
    });
    await h.controller.sendPlayerMessage('I walk to the docks.');

    const s = h.s();
    expect(s.log.map((e) => e.kind)).toEqual(['player', 'dm']);
    const [entry] = dmEntries(s.log);
    expect(entry.text).toBe('Fog rolls off the water.');
    expect(entry.choices).toEqual(['Look around', 'Wait for the tide']);
    expect(entry.streaming).toBe(false);

    expect(s.transcript.map((m) => m.param.role)).toEqual(['user', 'assistant']);
    const user = blocksOf(s.transcript[0].param);
    expect(user).toHaveLength(2);
    expect(user[0].type === 'text' && user[0].text.startsWith('<game_state>')).toBe(true);
    expect(user[1]).toEqual({ type: 'text', text: 'I walk to the docks.' });
    // The assistant message is the complete final content, unchanged (choices block included).
    expect(blocksOf(s.transcript[1].param)).toEqual([
      { type: 'text', text: 'Fog rolls off the water.\n\n```choices\nLook around\nWait for the tide\n```', citations: null },
    ]);
    expect(s.dm.phase).toBe('idle');
  });

  it('wraps OOC messages in <ooc> tags for Claude but logs them as typed', async () => {
    const h = setupHarness({ withSession: true, steps: [end('Grappling uses an Unarmed Strike.')] });
    await h.controller.sendPlayerMessage('OOC: how does grappling work?');
    const s = h.s();
    expect(s.log[0]).toMatchObject({ kind: 'player', text: 'OOC: how does grappling work?' });
    expect(blocksOf(s.transcript[0].param)[1]).toEqual({ type: 'text', text: '<ooc>how does grappling work?</ooc>' });
  });

  it('delivers pending DM notices as a system message right after the player message', async () => {
    const h = setupHarness({ withSession: true, steps: [end('Noted.')] });
    h.s().queueDmNotice('The player edited their character sheet: HP 12 → 17.');
    await h.controller.sendPlayerMessage('I check my wounds.');
    const roles = h.s().transcript.map((m) => m.param.role);
    expect(roles).toEqual(['user', 'system', 'assistant']);
    const system = h.s().transcript[1].param;
    expect(system.role === 'system' && typeof system.content === 'string' && system.content).toContain('HP 12 → 17');
    expect(h.s().pendingDmNotices).toEqual([]);
  });

  it('shows thinking as the entry reasoning only when thinking display is on', async () => {
    const reply = () => makeMessage([thinkingBlock('The guard is bribable.', 'sig-1'), textBlock('The guard nods.')], 'end_turn');
    const shown = setupHarness({ withSession: true, settings: { thinkingDisplay: 'summarized' }, steps: [reply()] });
    await shown.controller.sendPlayerMessage('I offer a coin.');
    expect(dmEntries(shown.s().log)[0].reasoning).toBe('The guard is bribable.');

    const hidden = setupHarness({ withSession: true, settings: { thinkingDisplay: 'omitted' }, steps: [reply()] });
    await hidden.controller.sendPlayerMessage('I offer a coin.');
    expect(dmEntries(hidden.s().log)[0].reasoning).toBeUndefined();
    // Thinking blocks go back to the API unchanged, signature included.
    expect(blocksOf(hidden.s().transcript[1].param)[0]).toEqual({ type: 'thinking', thinking: 'The guard is bribable.', signature: 'sig-1' });
  });
});

describe('agent loop: tools', () => {
  it('runs a tool, returns its result in one user message, then streams the final narration', async () => {
    fakeDice.queue(15);
    const h = setupHarness({
      withSession: true,
      steps: [
        makeMessage(
          [textBlock('You hold your breath.'), toolUseBlock('toolu_1', 'roll_dice', { expression: '1d20+2', purpose: 'Bandit Stealth', secret: true })],
          'tool_use',
        ),
        end('Nothing stirs.'),
      ],
    });
    await h.controller.sendPlayerMessage('I listen at the door.');

    const s = h.s();
    expect(s.transcript.map((m) => m.param.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const [result] = toolResults(s.transcript[2].param);
    expect(result.tool_use_id).toBe('toolu_1');
    expect(result.is_error).toBeUndefined();
    expect(String(result.content)).toContain('17');
    expect(s.log.map((e) => e.kind)).toEqual(['player', 'dm', 'roll', 'dm']);
    expect(s.log[2]).toMatchObject({ kind: 'roll', actor: 'dm', secret: true, purpose: 'Bandit Stealth' });
    // The second request carried the tool result.
    expect(h.client.requests[1].messages).toHaveLength(3);
  });

  it('returns all tool results of one assistant turn in a single user message', async () => {
    fakeDice.queue(4, 9);
    const h = setupHarness({
      withSession: true,
      steps: [
        makeMessage(
          [
            toolUseBlock('toolu_a', 'roll_dice', { expression: '1d6', purpose: 'Damage A' }),
            toolUseBlock('toolu_b', 'roll_dice', { expression: '1d10', purpose: 'Damage B' }),
          ],
          'tool_use',
        ),
        end('Both land.'),
      ],
    });
    await h.controller.sendPlayerMessage('Fire both bolts.');
    const results = toolResults(h.s().transcript[2].param);
    expect(results.map((r) => r.tool_use_id)).toEqual(['toolu_a', 'toolu_b']);
  });

  it('answers invalid tool input with an is_error result and never runs the handler', async () => {
    const h = setupHarness({
      withSession: true,
      steps: [makeMessage([toolUseBlock('toolu_bad', 'roll_dice', { purpose: 'Missing the expression' })], 'tool_use'), end('Let me fix that.')],
    });
    await h.controller.sendPlayerMessage('Roll for it.');
    const [result] = toolResults(h.s().transcript[2].param);
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toMatch(/Invalid input for roll_dice.*expression/);
    expect(h.s().log.some((e) => e.kind === 'roll')).toBe(false);
  });

  it('answers unknown tools with an error result', async () => {
    const h = setupHarness({
      withSession: true,
      steps: [makeMessage([toolUseBlock('toolu_x', 'teleport_party', {})], 'tool_use'), end('Never mind.')],
    });
    await h.controller.sendPlayerMessage('Go.');
    expect(toolResults(h.s().transcript[2].param)[0]).toMatchObject({ is_error: true });
  });

  it('continues a pause_turn by re-sending the transcript with no new user message', async () => {
    const h = setupHarness({ withSession: true, steps: [makeMessage([textBlock('Part one…')], 'pause_turn'), end('Part two.')] });
    await h.controller.sendPlayerMessage('Tell me a story.');
    expect(h.s().transcript.map((m) => m.param.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(h.client.requests[1].messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('stops after the iteration cap and hands the turn back', async () => {
    const steps = Array.from({ length: MAX_ITERATIONS }, (_, i) =>
      makeMessage([toolUseBlock(`toolu_${i}`, 'get_character_sheet', {})], 'tool_use'),
    );
    const h = setupHarness({ withSession: true, steps });
    await h.controller.sendPlayerMessage('Think hard.');
    expect(h.client.requests).toHaveLength(MAX_ITERATIONS);
    expect(h.s().log.at(-1)).toMatchObject({ kind: 'system', text: NOTES.iterationLimit });
    expect(h.s().transcript.at(-1)?.param.role).toBe('user');
  });

  it('answers tool calls left hanging by a closed tab before the next turn', async () => {
    const h = setupHarness({ withSession: true, steps: [end('Where were we?')] });
    await h.s().appendTranscript([
      { role: 'user', content: [{ type: 'text', text: '<game_state>\n</game_state>' }, { type: 'text', text: 'Earlier.' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_dangling', name: 'get_character_sheet', input: {} }] },
    ]);
    await h.controller.sendPlayerMessage('I wake up.');
    const t = h.s().transcript;
    expect(toolResults(t[2].param)[0]).toMatchObject({ tool_use_id: 'toolu_dangling', is_error: true, content: NOTES.interrupted });
    expect(t.map((m) => m.param.role)).toEqual(['user', 'assistant', 'user', 'user', 'assistant']);
  });
});

describe('agent loop: stop reasons and errors', () => {
  it('handles a refusal before reading content: runs nothing, discards partial text, logs a note', async () => {
    const h = setupHarness({
      withSession: true,
      steps: [
        makeMessage(
          [textBlock('You begin to'), toolUseBlock('toolu_r', 'update_character', { hp: { amount: 5, kind: 'damage' } })],
          'refusal',
          { stopDetails: refusalDetails },
        ),
      ],
    });
    const hpBefore = h.s().character?.hp.current;
    await h.controller.sendPlayerMessage('Something the classifier dislikes.');
    const s = h.s();
    expect(s.character?.hp.current).toBe(hpBefore);
    expect(s.transcript.map((m) => m.param.role)).toEqual(['user']);
    expect(dmEntries(s.log)).toHaveLength(0);
    expect(s.log.at(-1)).toMatchObject({ kind: 'system', level: 'warning', text: NOTES.refusedTurn });
    expect(s.dm.phase).toBe('idle');
  });

  it('never runs a tool call cut off by max_tokens, appends nothing, and can retry', async () => {
    const h = setupHarness({
      withSession: true,
      steps: [makeMessage([textBlock('You swing'), toolUseBlock('toolu_t', 'update_character', { hp: { amount: 5, kind: 'damage' } })], 'max_tokens')],
    });
    const hpBefore = h.s().character?.hp.current;
    await h.controller.sendPlayerMessage('I attack.');
    let s = h.s();
    expect(s.character?.hp.current).toBe(hpBefore);
    expect(s.transcript.map((m) => m.param.role)).toEqual(['user']);
    expect(s.log.at(-1)).toMatchObject({ kind: 'error', text: NOTES.truncatedTool, retryable: true });
    expect(s.dm).toMatchObject({ phase: 'error', retryable: true });

    h.client.push(end('You swing again — and connect.'));
    await h.controller.retry();
    s = h.s();
    expect(s.log.some((e) => e.kind === 'error')).toBe(false);
    expect(dmEntries(s.log).map((e) => e.text)).toEqual(['You swing again — and connect.']);
    expect(s.transcript.map((m) => m.param.role)).toEqual(['user', 'assistant']);
  });

  it('keeps a text reply cut off by max_tokens and adds a note', async () => {
    const h = setupHarness({ withSession: true, steps: [makeMessage([textBlock('The tale goes on and')], 'max_tokens')] });
    await h.controller.sendPlayerMessage('Go on.');
    expect(h.s().transcript.map((m) => m.param.role)).toEqual(['user', 'assistant']);
    expect(h.s().log.at(-1)).toMatchObject({ kind: 'system', text: NOTES.truncatedText });
  });

  it('cancel() mid-stream finalizes the partial narration and appends nothing', async () => {
    const h = setupHarness({ withSession: true });
    h.client.push({
      message: end('The door creaks open, and beyond it the corridor stretches into a darkness that seems to breathe.'),
      stream: {
        chunkSize: 8,
        beforeEvent: (index) => {
          if (index === 6) h.controller.cancel();
        },
      },
    });
    await h.controller.sendPlayerMessage('I open the door.');
    const s = h.s();
    const [entry] = dmEntries(s.log);
    expect(entry.streaming).toBe(false);
    expect(entry.text.length).toBeGreaterThan(0);
    expect(entry.text.length).toBeLessThan(40);
    expect(s.transcript.map((m) => m.param.role)).toEqual(['user']);
    expect(s.log.some((e) => e.kind === 'error')).toBe(false);
    expect(s.dm.phase).toBe('idle');
    expect(h.controller.isBusy()).toBe(false);
  });

  it('re-issues a request whose tool input JSON could not be parsed (twice at most)', async () => {
    const parseError = () => new AnthropicError('Unable to parse tool parameter JSON from model.');
    const failing = () => ({ message: end('Half a thought that never'), stream: { chunkSize: 6, failAt: { atEvent: 4, error: parseError() } } });
    const h = setupHarness({ withSession: true, steps: [failing(), failing(), end('A clean answer.')] });
    await h.controller.sendPlayerMessage('Hello?');
    expect(h.client.requests).toHaveLength(3);
    expect(dmEntries(h.s().log).map((e) => e.text)).toEqual(['A clean answer.']);

    const giveUp = setupHarness({ withSession: true, steps: [failing(), failing(), failing()] });
    await giveUp.controller.sendPlayerMessage('Hello?');
    expect(giveUp.client.requests).toHaveLength(3);
    expect(giveUp.s().log.at(-1)).toMatchObject({ kind: 'error', retryable: true });
  });

  it.each([
    [new AuthenticationError(401, undefined, 'invalid x-api-key', new Headers()), 'Your Anthropic API key was rejected — check Settings', true],
    [new RateLimitError(429, undefined, 'rate limited', new Headers()), 'rate limit', true],
    [new APIConnectionError({ message: 'offline' }), 'network error', true],
    [new BadRequestError(400, undefined, 'messages: bad shape', new Headers()), 'Claude rejected the request', false],
  ])('maps API errors to friendly retryable/non-retryable log entries (%#)', async (error, text, retryable) => {
    const h = setupHarness({ withSession: true, steps: [{ error }] });
    await h.controller.sendPlayerMessage('Hi.');
    const last = h.s().log.at(-1);
    expect(last?.kind).toBe('error');
    expect(last && 'text' in last ? last.text : '').toContain(text);
    expect(last).toMatchObject({ retryable });
    expect(h.s().dm).toMatchObject({ phase: 'error', retryable });
    expect(h.client.requests).toHaveLength(1);
  });

  it('retry() re-runs the failed request from the current transcript', async () => {
    const h = setupHarness({ withSession: true, steps: [{ error: new RateLimitError(429, undefined, 'slow down', new Headers()) }] });
    await h.controller.sendPlayerMessage('Hi.');
    h.client.push(end('Welcome back.'));
    await h.controller.retry();
    const s = h.s();
    expect(h.client.requests).toHaveLength(2);
    expect(h.client.requests[1].messages).toEqual(h.client.requests[0].messages);
    expect(s.log.map((e) => e.kind)).toEqual(['player', 'dm']);
    expect(s.dm.phase).toBe('idle');
  });
});

describe('agent loop: usage', () => {
  it('adds usage with the cache-write TTL split, tracks context size, and warns once past the soft limit', async () => {
    const usage = {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 2000,
      cache_creation: { ephemeral_1h_input_tokens: 2000, ephemeral_5m_input_tokens: 0 },
    };
    const h = setupHarness({
      withSession: true,
      settings: { sessionSoftLimitTokens: 5000 },
      steps: [makeMessage([textBlock('One.')], 'end_turn', { usage }), makeMessage([textBlock('Two.')], 'end_turn', { usage })],
    });
    await h.controller.sendPlayerMessage('First.');
    let s = h.s();
    expect(s.campaign?.usage).toMatchObject({ requests: 1, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 2000 });
    // Opus 5.5: 1000×$4 + 200×$20 + 5000×$0.20 + 2000×$8 (1h writes), per million.
    expect(s.campaign?.usage.estimatedCostUsd).toBeCloseTo(0.025, 10);
    expect(s.activeSession?.contextTokens).toBe(8000);
    expect(s.log.filter((e) => e.kind === 'system' && e.text.startsWith(SOFT_LIMIT_PREFIX))).toHaveLength(1);

    await h.controller.sendPlayerMessage('Second.');
    s = h.s();
    expect(s.campaign?.usage.requests).toBe(2);
    expect(s.log.filter((e) => e.kind === 'system' && e.text.startsWith(SOFT_LIMIT_PREFIX))).toHaveLength(1);
  });
});
