import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/engine', () => import('./testing/fakeEngine'));
vi.mock('@/data', () => import('./testing/fakeData'));
vi.mock('@/state/gameStore', () => import('./testing/fakeGameStoreModule'));

import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaRefusalStopDetails,
  BetaToolResultBlockParam,
  MessageCreateParamsBase,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { DmLogEntry } from '@/types';
import { NOTES } from './agent';
import { resetDmDeps } from './deps';
import { DM_INSTRUCTIONS } from './prompts';
import { makeMessage, textBlock, thinkingBlock, toolUseBlock } from './scripted';
import { canRegenerate } from './index';
import { WRAP_UP_REQUEST } from './session';
import { fakeDice } from './testing/fakeEngine';
import { answerRolls, setupHarness } from './testing/harness';

beforeEach(() => fakeDice.reset());
afterEach(() => resetDmDeps());

const end = (text: string) => makeMessage([textBlock(text)], 'end_turn');

function blocksOf(param: BetaMessageParam): BetaContentBlockParam[] {
  if (param.role === 'system' || typeof param.content === 'string') return [];
  return param.content;
}

function textOfUser(param: BetaMessageParam, index: number): string {
  const block = blocksOf(param)[index];
  return block?.type === 'text' ? block.text : '';
}

function toolResults(param: BetaMessageParam): BetaToolResultBlockParam[] {
  return blocksOf(param).filter((b): b is BetaToolResultBlockParam => b.type === 'tool_result');
}

const refusal: BetaRefusalStopDetails = {
  type: 'refusal',
  category: null,
  explanation: null,
  fallback_credit_token: null,
  fallback_has_prefill_claim: null,
  recommended_model: null,
};

/** The append-only invariant: identical system/tools, and each request extends the previous one. */
function expectAppendOnly(requests: MessageCreateParamsBase[]): void {
  const [first] = requests;
  for (const [i, request] of requests.entries()) {
    expect(JSON.stringify(request.system), `system of request ${i}`).toBe(JSON.stringify(first.system));
    expect(JSON.stringify(request.tools), `tools of request ${i}`).toBe(JSON.stringify(first.tools));
    if (i === 0) continue;
    const previous = requests[i - 1].messages;
    expect(request.messages.length).toBeGreaterThan(previous.length);
    previous.forEach((m, j) => expect(JSON.stringify(request.messages[j]), `request ${i} message ${j}`).toBe(JSON.stringify(m)));
  }
}

describe('beginOrResume', () => {
  it('freezes a system prompt, logs the session start, and lets the DM open the adventure', async () => {
    fakeDice.queue(9);
    const h = setupHarness({
      steps: [
        makeMessage(
          [
            thinkingBlock('Open on the docks.', 'sig-open'),
            toolUseBlock('toolu_scene', 'set_scene', { location: 'Saltmarsh Docks', time_of_day: 'dusk', new_scene: true }),
            toolUseBlock('toolu_journal', 'update_journal', { entries: [{ kind: 'npc', name: 'Captain Ysolde', summary: 'Harbor master with a secret.' }] }),
          ],
          'tool_use',
        ),
        end('The fog parts. **Captain Ysolde** waits on the pier.\n\n```choices\nGreet her\nHang back\n```'),
      ],
    });
    await h.controller.beginOrResume();

    const s = h.s();
    expect(s.activeSession?.number).toBe(1);
    expect(s.campaign?.sessionCount).toBe(1);
    const prompt = s.activeSession?.systemPrompt ?? '';
    expect(prompt.startsWith(DM_INSTRUCTIONS)).toBe(true);
    expect(prompt).toContain('The Drowned Lantern');
    expect(h.client.requests[0].system).toEqual([{ type: 'text', text: prompt, cache_control: { type: 'ephemeral', ttl: '1h' } }]);

    expect(s.log[0]).toMatchObject({ kind: 'session', event: 'start', sessionNumber: 1 });
    expect(s.log.at(-1)).toMatchObject({ kind: 'dm', choices: ['Greet her', 'Hang back'] });
    expect(textOfUser(s.transcript[0].param, 1)).toContain('<app_request type="session_start" session="1">');
    expect(s.campaign?.scene.location).toBe('Saltmarsh Docks');
    expect(s.journal.some((j) => j.name === 'Captain Ysolde')).toBe(true);

    // No-op when a session is already active.
    await h.controller.beginOrResume();
    expect(h.client.requests).toHaveLength(2);
  });

  it('opens later sessions with a "previously" instruction and the chronicle in the prompt', async () => {
    const h = setupHarness({
      campaign: { sessionCount: 1 },
      state: {
        sessions: [
          {
            id: 'old',
            campaignId: 'camp-1',
            number: 1,
            status: 'ended',
            model: 'claude-opus-5-5',
            systemPrompt: 'old prompt',
            startedAt: 1,
            endedAt: 2,
            recap: 'You found the drowned bell.',
            dmNotes: 'The bell is cursed.',
            usage: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0 },
            contextTokens: 0,
          },
        ],
      },
      steps: [end('*Previously…* You found the drowned bell.')],
    });
    await h.controller.beginOrResume();
    const s = h.s();
    expect(s.activeSession?.number).toBe(2);
    expect(s.activeSession?.systemPrompt).toContain('You found the drowned bell.');
    expect(s.activeSession?.systemPrompt).toContain('The bell is cursed.');
    expect(textOfUser(s.transcript[0].param, 1)).toContain('session="2"');
  });
});

describe('the append-only invariant', () => {
  it('keeps system and tools byte-identical and only ever extends the messages', async () => {
    fakeDice.queue(9, 14);
    const h = setupHarness({
      steps: [
        makeMessage([thinkingBlock('Plan the opening.', 'sig-1'), toolUseBlock('toolu_1', 'set_scene', { location: 'Docks', new_scene: true })], 'tool_use'),
        makeMessage([thinkingBlock('Now narrate.', 'sig-2'), textBlock('The docks are quiet.')], 'end_turn'),
        makeMessage([thinkingBlock('A stealth check.', 'sig-3'), toolUseBlock('toolu_2', 'roll_dice', { expression: '1d20+1', purpose: 'Guard Perception', secret: true })], 'tool_use'),
        makeMessage([textBlock('The guard yawns.')], 'end_turn'),
        makeMessage([thinkingBlock('Look it up.', 'sig-4'), toolUseBlock('toolu_3', 'lookup_rules', { query: 'opportunity attacks' })], 'tool_use'),
        end('You slip past.'),
      ],
    });
    await h.controller.beginOrResume();
    h.s().queueDmNotice('The player changed narration length to brief.');
    await h.controller.sendPlayerMessage('I sneak past the guard.');
    await h.controller.sendPlayerMessage('OOC: what triggers an opportunity attack?');

    expect(h.client.requests).toHaveLength(6);
    expectAppendOnly(h.client.requests);
    // The notice arrived as a system message right after that turn's user message.
    const third = h.client.requests[2].messages;
    expect(third.at(-1)?.role).toBe('system');
    expect(third.at(-2)?.role).toBe('user');
    // Thinking blocks were passed back unchanged.
    expect(JSON.stringify(h.client.requests[5].messages)).toContain('"signature":"sig-1"');
    // No request ever ended with a finished assistant message (no prefill).
    for (const r of h.client.requests) expect(r.messages.at(-1)?.role).not.toBe('assistant');
  });
});

describe('regenerate', () => {
  it('re-runs the last response when it only read state, trimming from the end', async () => {
    const h = setupHarness({
      withSession: true,
      steps: [
        makeMessage([toolUseBlock('toolu_s', 'get_character_sheet', {})], 'tool_use'),
        end('First draft.'),
        end('Second draft.'),
      ],
    });
    h.s().queueDmNotice('Settings changed.');
    await h.controller.sendPlayerMessage('Describe my gear.');
    expect(h.controller.regenerateProblem()).toBeNull();
    expect(canRegenerate()).toBe(true);
    await h.controller.regenerate();

    const s = h.s();
    expect(s.log.map((e) => e.kind)).toEqual(['player', 'dm']);
    expect((s.log[1] as DmLogEntry).text).toBe('Second draft.');
    expect(s.transcript.map((m) => m.param.role)).toEqual(['user', 'system', 'assistant']);
    // The regenerated request is exactly the original turn's first request.
    expect(h.client.requests[2].messages).toEqual(h.client.requests[0].messages);
  });

  it('refuses when the last response changed the game state', async () => {
    fakeDice.queue(12);
    const h = setupHarness({
      withSession: true,
      steps: [makeMessage([toolUseBlock('toolu_r', 'roll_dice', { expression: '1d20', purpose: 'Luck' })], 'tool_use'), end('Fate decides.')],
    });
    await h.controller.sendPlayerMessage('I trust to luck.');
    expect(canRegenerate()).toBe(false);
    await expect(h.controller.regenerate()).rejects.toThrow(/already changed the game.*roll_dice/);
    expect(h.client.requests).toHaveLength(2);
  });

  it('refuses when there is nothing to regenerate', async () => {
    const h = setupHarness({ withSession: true });
    await expect(h.controller.regenerate()).rejects.toThrow(/no DM response/i);
  });
});

describe('endSession', () => {
  it('records final notes, writes the recap privately, and ends the session', async () => {
    const h = setupHarness({
      withSession: true,
      steps: [
        end('You reach the lighthouse.'),
        makeMessage([toolUseBlock('toolu_j', 'update_journal', { entries: [{ kind: 'location', name: 'The Lighthouse', summary: 'Cold and lit.' }] })], 'tool_use'),
        end('## Recap\nYou reached the lighthouse and found it lit.\n\n## DM Notes\nThe keeper is the drowned thing.'),
      ],
    });
    await h.controller.sendPlayerMessage('I go to the lighthouse.');
    await h.controller.endSession();

    const s = h.s();
    expect(s.activeSession).toBeNull();
    const ended = s.sessions.find((x) => x.id === 'sess-1');
    expect(ended).toMatchObject({ status: 'ended', recap: 'You reached the lighthouse and found it lit.', dmNotes: 'The keeper is the drowned thing.' });
    expect(s.log.slice(-2)).toMatchObject([
      { kind: 'recap', sessionNumber: 1, text: 'You reached the lighthouse and found it lit.' },
      { kind: 'session', event: 'end', sessionNumber: 1 },
    ]);
    // The private notes never reached the visible log.
    expect(JSON.stringify(s.log)).not.toContain('drowned thing');
    expect(textOfUser(h.client.requests[1].messages.at(-1) as BetaMessageParam, 1)).toBe(WRAP_UP_REQUEST);
  });

  it('uses the whole text as the recap when the headings are missing', async () => {
    const h = setupHarness({ withSession: true, steps: [end('Hello.'), end('You survived the night.')] });
    await h.controller.sendPlayerMessage('Hi.');
    await h.controller.endSession();
    expect(h.s().sessions[0]).toMatchObject({ recap: 'You survived the night.', dmNotes: null });
  });

  it('closes a session where nothing was played without asking for a recap', async () => {
    const h = setupHarness({ withSession: true });
    await h.controller.endSession();
    expect(h.client.requests).toHaveLength(0);
    expect(h.s().activeSession).toBeNull();
    expect(h.s().log.at(-1)).toMatchObject({ kind: 'session', event: 'end' });
  });
});

describe('player rolls and cancellation', () => {
  it('waits for the roll dialog in prompt mode and reports the result', async () => {
    const h = setupHarness({
      withSession: true,
      campaignSettings: { playerRollMode: 'prompt' },
      steps: [
        makeMessage([toolUseBlock('toolu_p', 'request_player_roll', { roll_type: 'skill', skill: 'stealth', dc: 15, reason: 'Slip past — or be seen' })], 'tool_use'),
        end('You melt into the shadows.'),
      ],
    });
    const statuses: string[] = [];
    const unsubscribe = h.store.subscribe((s) => statuses.push(s.dm.phase));
    answerRolls(h.store, 14);
    await h.controller.sendPlayerMessage('I sneak.');
    unsubscribe();

    expect(statuses).toContain('waiting-player');
    const [result] = toolResults(h.s().transcript[2].param);
    // Mira's Stealth: DEX +2, not proficient → 16 vs DC 15.
    expect(String(result.content)).toMatch(/16.*DC 15.*success/);
    expect(h.s().log.find((e) => e.kind === 'roll')).toMatchObject({ actor: 'player', roll: { total: 16, success: true } });
  });

  it('cancel() while the player is rolling cancels the dialog and keeps the transcript valid', async () => {
    const h = setupHarness({
      withSession: true,
      campaignSettings: { playerRollMode: 'prompt' },
      steps: [
        makeMessage(
          [
            toolUseBlock('toolu_w', 'request_player_roll', { roll_type: 'save', ability: 'dex', dc: 13, reason: 'Dodge the falling beam' }),
            toolUseBlock('toolu_after', 'roll_dice', { expression: '2d6', purpose: 'Beam damage' }),
          ],
          'tool_use',
        ),
      ],
    });
    const unsubscribe = h.store.subscribe((s) => {
      if (s.interaction) queueMicrotask(() => h.controller.cancel());
    });
    await h.controller.sendPlayerMessage('I run under the beam.');
    unsubscribe();

    const s = h.s();
    expect(s.interaction).toBeNull();
    expect(s.dm.phase).toBe('idle');
    expect(s.transcript.map((m) => m.param.role)).toEqual(['user', 'assistant', 'user']);
    const results = toolResults(s.transcript[2].param);
    expect(results.map((r) => [r.tool_use_id, r.is_error])).toEqual([
      ['toolu_w', true],
      ['toolu_after', true],
    ]);
    expect(String(results[1].content)).toBe(NOTES.cancelled);
    expect(h.client.requests).toHaveLength(1);

    // The next turn appends cleanly after the cancelled one.
    h.client.push(end('The dust settles.'));
    await h.controller.sendPlayerMessage('I look around.');
    expect(h.s().transcript.map((m) => m.param.role)).toEqual(['user', 'assistant', 'user', 'user', 'assistant']);
  });

  it('a roll the player dismisses comes back as an error result and the DM carries on', async () => {
    const h = setupHarness({
      withSession: true,
      campaignSettings: { playerRollMode: 'physical' },
      steps: [makeMessage([toolUseBlock('toolu_d', 'request_player_roll', { roll_type: 'ability', ability: 'str', reason: 'Lift the gate' })], 'tool_use'), end('Fine — the gate stays shut.')],
    });
    const unsubscribe = h.store.subscribe((s) => {
      const pending = s.interaction;
      if (pending) queueMicrotask(() => h.s().cancelInteraction(pending.id, 'dismissed'));
    });
    await h.controller.sendPlayerMessage('I lift the gate.');
    unsubscribe();
    const [result] = toolResults(h.s().transcript[2].param);
    expect(result).toMatchObject({ is_error: true });
    expect(String(result.content)).toMatch(/dismissed/);
    expect(h.s().transcript.at(-1)?.param.role).toBe('assistant');
  });
});

describe('unanswered turns', () => {
  it('sets aside a refused turn (and re-sends its notices) when the player sends a new message', async () => {
    const h = setupHarness({
      withSession: true,
      steps: [makeMessage([], 'refusal', { stopDetails: refusal }), end('A better idea.')],
    });
    h.s().queueDmNotice('The player vetoed the homebrew "Blood Pact".');
    await h.controller.sendPlayerMessage('Something refused.');
    expect(h.s().transcript.map((m) => m.param.role)).toEqual(['user', 'system']);

    await h.controller.sendPlayerMessage('Something else.');
    const t = h.s().transcript;
    expect(t.map((m) => m.param.role)).toEqual(['user', 'system', 'assistant']);
    expect(textOfUser(t[0].param, 1)).toBe('Something else.');
    expect(JSON.stringify(t[1].param)).toContain('Blood Pact');
    // The second request no longer carries the refused words.
    expect(JSON.stringify(h.client.requests[1].messages)).not.toContain('Something refused.');
  });

  it('demo mode makes no API calls', async () => {
    const h = setupHarness({ settings: { mockMode: true } });
    await h.controller.beginOrResume();
    expect(h.client.requests).toHaveLength(0);
    expect(h.s().log.some((e) => e.kind === 'dm')).toBe(true);
  });
});
