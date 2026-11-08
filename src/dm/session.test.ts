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
import { APIConnectionError } from '@anthropic-ai/sdk';
import { isToldAndAnswered } from '@/engine';
import { isSeqAnswered } from '@/lib/answered';
import { sampleMappedCombat, sampleStopCombat } from '@/test/fixtures';
import type { BattleMap, CombatState, DmLogEntry, PlayerLogEntry, TurnMove } from '@/types';
import { MAX_ITERATIONS, MAX_MAPPED_ITERATIONS, NOTES } from './agent';
import { resetDmDeps } from './deps';
import { DM_INSTRUCTIONS } from './prompts';
import { makeMessage, textBlock, thinkingBlock, toolUseBlock } from './scripted';
import { canRegenerate } from './index';
import { WRAP_UP_REQUEST } from './session';
import { fakeDice } from './testing/fakeEngine';
import { answerRolls, NO_IMAGE_KEY, setupHarness } from './testing/harness';

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

  it('finds the recap even when it comes before the last tool call', async () => {
    const h = setupHarness({
      withSession: true,
      steps: [
        end('Hello.'),
        makeMessage(
          [textBlock('## Recap\nYou slept.\n\n## DM Notes\nWolves at dawn.'), toolUseBlock('toolu_q', 'update_quest', { title: 'Survive', status: 'completed' })],
          'tool_use',
        ),
        end('All saved.'),
      ],
    });
    await h.controller.sendPlayerMessage('Hi.');
    await h.controller.endSession();
    expect(h.s().sessions[0]).toMatchObject({ recap: 'You slept.', dmNotes: 'Wolves at dawn.\n\nAll saved.' });
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
    // Mira's Stealth: DEX +2, not proficient → 16 vs DC 15. The DM gets the verdict…
    expect(String(result.content)).toMatch(/16.*DC 15.*success/);
    // …but the DC wasn't revealed, so the player's roll card shows the total without target or verdict.
    const card = h.s().log.find((e) => e.kind === 'roll');
    expect(card).toMatchObject({ actor: 'player', roll: { total: 16, natural: 14 } });
    expect(card?.kind === 'roll' && card.roll).not.toHaveProperty('dc');
    expect(card?.kind === 'roll' && card.roll).not.toHaveProperty('success');
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

describe('stopping a turn', () => {
  it('a send right after Stop waits for the stopped run to unwind instead of failing (the X-card mid-stream)', async () => {
    const h = setupHarness({ withSession: true });
    let xCard: Promise<void> | undefined;
    let phaseAfterCancel: string | undefined;
    const idleWhileBusy: string[] = [];
    const unsubscribe = h.store.subscribe((s) => {
      if (s.dm.phase === 'idle' && h.controller.isBusy()) idleWhileBusy.push(s.dm.activity ?? '');
    });
    h.client.push({
      message: end('A hooded figure waits beyond, a knife in one hand and something worse in the other.'),
      stream: {
        chunkSize: 6,
        beforeEvent: (index) => {
          if (index !== 4) return;
          h.controller.cancel();
          phaseAfterCancel = h.s().dm.phase;
          xCard = h.controller.sendPlayerMessage('[X-card] Please steer away from the current content.');
        },
      },
    });
    h.client.push(end('The moment passes. You are back at the bar, the fire crackling.'));
    await h.controller.sendPlayerMessage('I open the door.');
    await xCard;
    unsubscribe();

    // The DM never looked idle while it was still unwinding, and the X-card was not refused.
    expect(phaseAfterCancel).not.toBe('idle');
    expect(idleWhileBusy).toEqual([]);
    expect(h.client.requests).toHaveLength(2);
    const second = h.client.requests[1].messages;
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'system']);
    // The DM sees what was on screen when the player played the X-card.
    expect(JSON.stringify(second[1])).toContain('A hooded fig');
    expect(textOfUser(second[2], 1)).toBe('[X-card] Please steer away from the current content.');
    expect(JSON.stringify(second[3])).toContain('stopped your last reply partway');
    expect(h.s().dm.phase).toBe('idle');
    expect(h.controller.isBusy()).toBe(false);
  });
});

describe('notices at a session start', () => {
  it('delivers notices queued between sessions with the opening request instead of discarding them', async () => {
    const h = setupHarness({ steps: [end('Session two opens on the docks.')] });
    h.s().queueDmNotice('The player vetoed the homebrew "Lantern-Touched". Retire or rework it.');
    await h.controller.beginOrResume();
    const t = h.s().transcript;
    expect(t.map((m) => m.param.role)).toEqual(['user', 'system', 'assistant']);
    expect(textOfUser(t[0].param, 1)).toContain('<app_request type="session_start"');
    expect(JSON.stringify(t[1].param)).toContain('Lantern-Touched');
    expect(JSON.stringify(t[1].param)).toContain('since the last session');
    expect(h.s().pendingDmNotices).toEqual([]);
  });

  it('keeps an unanswered opening (and its notices) when the player speaks first', async () => {
    const h = setupHarness();
    h.s().queueDmNotice('Narration length is now brief.');
    h.client.push({
      message: makeMessage([thinkingBlock('Plan the opening.', 'sig-o'), textBlock('The fog parts.')], 'end_turn'),
      stream: {
        beforeEvent: (index) => {
          if (index === 2) h.controller.cancel();
        },
      },
    });
    await h.controller.beginOrResume();
    expect(h.s().transcript.map((m) => m.param.role)).toEqual(['user', 'system']);

    h.client.push(end('The fog parts, and you step onto the pier.'));
    await h.controller.sendPlayerMessage('I look around.');
    const t = h.s().transcript;
    expect(t.map((m) => m.param.role)).toEqual(['user', 'user', 'system', 'assistant']);
    expect(textOfUser(t[0].param, 1)).toContain('<app_request type="session_start"');
    expect(textOfUser(t[1].param, 1)).toBe('I look around.');
    expect(JSON.stringify(t[2].param)).toContain('Narration length is now brief.');
  });

  it("lists the imported books switched on in the player's Library in the prompt", async () => {
    const h = setupHarness({ libraryImports: [{ id: 'lib-phb', name: 'My PHB notes' }], steps: [end('Hello.')] });
    await h.controller.beginOrResume();
    expect(h.s().activeSession?.systemPrompt).toContain('- My PHB notes (imported by the player');
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

describe('setting changes reach the DM mid-session as one-line notes', () => {
  const systemNotes = (h: ReturnType<typeof setupHarness>) =>
    h.s().transcript.filter((m) => m.param.role === 'system').map((m) => JSON.stringify(m.param));

  it('tells the DM once when illustrations become available, with the prompt and tools frozen', async () => {
    let keyed = false;
    const h = setupHarness({
      images: { available: () => (keyed ? { ok: true } : { ok: false, reason: NO_IMAGE_KEY }) },
      steps: [end('The docks.'), end('Fog rolls in.'), end('Gulls cry.')],
    });
    await h.controller.beginOrResume();
    expect(h.s().activeSession?.systemPrompt).toContain('## Illustrations: Not set up');
    // In Settings → Illustrations the player adds an OpenAI key and picks key moments.
    keyed = true;
    h.settings.images = { ...h.settings.images, openaiApiKey: 'sk-openai-test', frequency: 'moments' };
    await h.controller.sendPlayerMessage('I look around.');
    await h.controller.sendPlayerMessage('I wait for the tide.');

    expectAppendOnly(h.client.requests);
    expect(JSON.stringify(h.client.requests[0].tools)).toMatch(/"name":"transform_character".*"name":"show_image"/);
    const notes = systemNotes(h);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('Setting update — Illustrations: Key moments.');
    expect(notes[0]).toContain('at most about once per scene');
    expect(h.s().activeSession?.systemPrompt).toContain('## Illustrations: Not set up');
  });

  it('tells the DM when the transformations rule changes (the full guidance only after Off)', async () => {
    const h = setupHarness({ campaignSettings: { transformations: 'off' }, steps: [end('Hello.'), end('Onward.'), end('Again.')] });
    await h.controller.beginOrResume();
    const setRule = (transformations: 'off' | 'offered' | 'consequences') =>
      h.s().updateCampaign((c) => ({ ...c, settings: { ...c.settings, transformations } }));

    await setRule('consequences');
    await h.controller.sendPlayerMessage('I go on.');
    const [first] = systemNotes(h);
    expect(first).toContain('Setting update — Transformations: Consequences.');
    expect(first).toContain('Telegraph the danger clearly');
    expect(first).toContain('No quota');

    await setRule('offered');
    await h.controller.sendPlayerMessage('I go on again.');
    const second = systemNotes(h)[1];
    expect(second).toContain('Setting update — Transformations: Offered.');
    expect(second).not.toContain('No quota');
    expectAppendOnly(h.client.requests);
  });

  it('re-sends a note from a set-aside turn only once, as it stands now', async () => {
    let keyed = false;
    const h = setupHarness({
      images: { available: () => (keyed ? { ok: true } : { ok: false, reason: NO_IMAGE_KEY }) },
      steps: [end('The docks.'), makeMessage([], 'refusal', { stopDetails: refusal }), end('A better idea.')],
    });
    await h.controller.beginOrResume();
    keyed = true;
    await h.controller.sendPlayerMessage('Something refused.');
    expect(systemNotes(h)).toHaveLength(1);
    await h.controller.sendPlayerMessage('Something else.');
    const notes = systemNotes(h);
    expect(notes).toHaveLength(1);
    expect(notes[0].match(/Setting update — Illustrations: On request\./g)).toHaveLength(1);
    expect(h.s().pendingDmNotices).toEqual([]);
  });

  it('sends nothing for a session whose prompt predates these sections', async () => {
    const h = setupHarness({ withSession: true, steps: [end('Fine.')], images: { available: () => ({ ok: true }) } });
    h.settings.images = { ...h.settings.images, frequency: 'moments' };
    await h.s().updateCampaign((c) => ({ ...c, settings: { ...c.settings, transformations: 'consequences' } }));
    await h.controller.sendPlayerMessage('Hello.');
    expect(h.s().transcript.map((m) => m.param.role)).toEqual(['user', 'assistant']);
  });
});


// ---------------------------------------------------------------------------
// The battle map: what the DM was told of the player's moves (D48), the bubble's note (D51), the request cap (D52)
// ---------------------------------------------------------------------------

/** The hero's turn after the player moved B6 → C7 (5 ft), not yet reported to the DM. */
function heroMovedToC7(): CombatState {
  const base = sampleMappedCombat({ heroTurn: true });
  const move: TurnMove = { by: 'player', kind: 'move', from: { x: 1, y: 5 }, to: { x: 2, y: 6 }, path: [{ x: 2, y: 6 }], costFt: 5, provoked: [], entered: [] };
  return {
    ...base,
    combatants: base.combatants.map((c) => (c.isPlayer ? { ...c, position: { x: 2, y: 6 } } : c)),
    map: { ...(base.map as BattleMap), turn: { combatantId: 'c-1', round: 2, movedFt: 5, dashFt: 0, dashes: 0, disengaged: false, stoodUp: false, moves: [move] } },
  };
}

const gameStateOf = (param: BetaMessageParam) => textOfUser(param, 0);
const lastUserState = (request: MessageCreateParamsBase) => {
  const users = request.messages.filter((m) => m.role === 'user' && blocksOf(m)[0]?.type === 'text');
  return gameStateOf(users.at(-1) as BetaMessageParam);
};

describe("the player's map moves reach the DM once, with the next message (D48, D51)", () => {
  it('reports unseen moves in <game_state>, stamps them with that message, and puts a note on the bubble', async () => {
    const h = setupHarness({ withSession: true, state: { combat: heroMovedToC7() }, steps: [end('You duck behind the crates.'), end('The bandits hesitate.')] });
    await h.controller.sendPlayerMessage('I take cover.');
    const first = h.s().transcript[0];
    expect(gameStateOf(first.param)).toContain('New since your last reply: the player moved Mira Voss B6 → C7 (5 ft).');
    expect(h.s().combat?.map?.turn?.moves[0].toldSeq).toBe(first.seq);
    const bubble = h.s().log.find((e): e is PlayerLogEntry => e.kind === 'player');
    expect(bubble).toMatchObject({ text: 'I take cover.', mapNote: 'Moved B6 → C7 · 5 ft' });

    // Seen now that the DM answered: the next turn shows it in the totals only, and the bubble has no note.
    await h.controller.sendPlayerMessage('I wait.');
    const second = lastUserState(h.client.requests[1]);
    expect(second).not.toContain('New since your last reply');
    expect(second).toContain('Turn: Mira Voss — moved 5 of 30 ft (B6 C7), 25 ft left.');
    expect(h.s().log.filter((e): e is PlayerLogEntry => e.kind === 'player')[1]).not.toHaveProperty('mapNote');
    expect(h.s().combat?.map?.turn?.moves[0].toldSeq).toBe(first.seq);
  });

  it('reports a stop again after a failed request, and it counts as seen once the DM answers', async () => {
    const h = setupHarness({
      withSession: true,
      state: { combat: sampleStopCombat() },
      steps: [{ error: new APIConnectionError({ message: 'offline' }) }, end('The ogre swings as you go.')],
    });
    await h.controller.sendPlayerMessage('I keep moving to A7.');
    expect(h.s().dm.phase).toBe('error');
    const stamped = h.s().combat?.map?.stop?.toldSeq;
    expect(stamped).toBe(h.s().transcript[0].seq);

    await h.controller.sendPlayerMessage('I keep moving to A7.');
    const resent = lastUserState(h.client.requests[1]);
    expect(resent).toContain("the move stopped at B6 — leaving Dock Ogre's reach there provokes its Opportunity Attack");
    const stop = h.s().combat?.map?.stop;
    expect(stop?.toldSeq).toBe(h.s().transcript[0].seq);
    expect(isToldAndAnswered(stop ?? {}, (seq) => isSeqAnswered(h.s().transcript, seq))).toBe(true);
  });

  it('a regenerate re-runs on the same message, which still carries the moves', async () => {
    const h = setupHarness({ withSession: true, state: { combat: heroMovedToC7() }, steps: [end('First draft.'), end('Second draft.')] });
    await h.controller.sendPlayerMessage('I take cover.');
    await h.controller.regenerate();
    expect(h.client.requests[1].messages).toEqual(h.client.requests[0].messages);
    expect(lastUserState(h.client.requests[1])).toContain('New since your last reply: the player moved Mira Voss B6 → C7 (5 ft).');
    expect((h.s().log.at(-1) as DmLogEntry).text).toBe('Second draft.');
  });
});

describe('the request cap (D52)', () => {
  const reading = (n: number) => Array.from({ length: n }, (_, i) => makeMessage([toolUseBlock(`toolu_r${i}`, 'get_character_sheet', {})], 'tool_use'));

  it('allows 40 requests a turn while the fight is on a battle map', async () => {
    const h = setupHarness({ withSession: true, state: { combat: sampleMappedCombat({ heroTurn: true }) }, steps: reading(MAX_MAPPED_ITERATIONS) });
    await h.controller.sendPlayerMessage('I wait and watch.');
    expect(MAX_MAPPED_ITERATIONS).toBe(40);
    expect(h.client.requests).toHaveLength(40);
    expect(h.s().log.at(-1)).toMatchObject({ kind: 'system', text: NOTES.iterationLimit });
  });

  it('keeps 24 without a map', async () => {
    const h = setupHarness({ withSession: true, steps: reading(MAX_MAPPED_ITERATIONS) });
    await h.controller.sendPlayerMessage('I wait and watch.');
    expect(h.client.requests).toHaveLength(MAX_ITERATIONS);
    expect(MAX_ITERATIONS).toBe(24);
  });
});

describe('a mapped fight keeps the transcript append-only', () => {
  it('holds system, tools and every earlier message fixed across setup, a player move and the enemy turn', async () => {
    // Mira 20+2 beats the bandit's 1+1.
    fakeDice.queue(20, 1);
    const START = {
      encounter_name: 'Ambush in the warehouse',
      map: {
        name: 'Dockside warehouse',
        width: 16,
        height: 12,
        terrain: [{ kind: 'half-cover', squares: 'E5:F6', label: 'crates' }],
        places: [{ name: 'the loading door', squares: 'A5:B7' }],
      },
      hero_position: 'B6',
      combatants: [{ name: 'Bandit', side: 'enemy', ac: 12, hp_max: 11, initiative_bonus: 1, stat_block: 'Bandit', position: 'F4' }],
    };
    const h = setupHarness({
      withSession: true,
      campaignSettings: { playerRollMode: 'auto' },
      steps: [
        makeMessage([toolUseBlock('toolu_start', 'start_combat', START)], 'tool_use'),
        makeMessage([toolUseBlock('toolu_look', 'check_map', { show: true })], 'tool_use'),
        end('A bandit vaults the crates. Your move.'),
        makeMessage([toolUseBlock('toolu_next', 'update_combat', { action: 'next_turn' })], 'tool_use'),
        makeMessage([toolUseBlock('toolu_move', 'move_tokens', { moves: [{ who: 'Bandit', to: 'hero' }] })], 'tool_use'),
        makeMessage([toolUseBlock('toolu_hit', 'roll_dice', { expression: '1d20+3', purpose: 'Bandit attacks', dc: 12, is_attack: true, attacker: 'Bandit', target: 'hero' })], 'tool_use'),
        end('Steel rings off the crates.'),
      ],
    });
    await h.controller.sendPlayerMessage('I draw my dagger.');
    expect(h.s().combat?.map?.name).toBe('Dockside warehouse');
    const moved = await h.s().commitHeroMove({ to: { x: 2, y: 6 }, prefer: 'safest', dash: false, disengage: false, standUp: false });
    expect(moved.ok).toBe(true);
    await h.controller.sendPlayerMessage('I take cover.');

    expect(h.client.requests).toHaveLength(7);
    expectAppendOnly(h.client.requests);
    expect(lastUserState(h.client.requests[3])).toContain('New since your last reply: the player moved Mira Voss B6 → C7 (5 ft).');
    const results = toolResults(h.s().transcript.at(-2)?.param as BetaMessageParam);
    expect(String(results[0].content)).toContain('Map: in reach (5 ft)');
    expect(h.s().log.some((e) => e.kind === 'player' && e.mapNote === 'Moved B6 → C7 · 5 ft')).toBe(true);
  });
});

describe('the battle-maps table rule mid-session', () => {
  it('tells the DM once when the rule changes, with the prompt frozen', async () => {
    const h = setupHarness({ steps: [end('The docks.'), end('Fog rolls in.'), end('Gulls cry.')] });
    await h.controller.beginOrResume();
    expect(h.s().activeSession?.systemPrompt).toContain('## Battle maps: When it helps');
    await h.s().updateCampaign((c) => ({ ...c, settings: { ...c.settings, battleMaps: 'off' } }));
    await h.controller.sendPlayerMessage('I look around.');
    await h.controller.sendPlayerMessage('I wait for the tide.');
    const notes = h.s().transcript.filter((m) => m.param.role === 'system').map((m) => JSON.stringify(m.param));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('Setting update — Battle maps: Off.');
    expectAppendOnly(h.client.requests);
  });
});
