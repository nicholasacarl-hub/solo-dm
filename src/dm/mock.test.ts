import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/engine', () => import('./testing/fakeEngine'));
vi.mock('@/data', () => import('./testing/fakeData'));
vi.mock('@/state/gameStore', () => import('./testing/fakeGameStoreModule'));

import type { BetaContentBlockParam, BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { DmLogEntry, LogEntry, TranscriptMessage } from '@/types';
import { resetDmDeps } from './deps';
import { fakeDice } from './testing/fakeEngine';
import { answerRolls, setupHarness } from './testing/harness';

beforeEach(() => fakeDice.reset());
afterEach(() => resetDmDeps());

function blocks(param: BetaMessageParam): BetaContentBlockParam[] {
  return param.role === 'system' || typeof param.content === 'string' ? [] : param.content;
}

/** Every tool call is answered by the next message, and no message is empty. */
function expectValidTranscript(transcript: TranscriptMessage[]): void {
  transcript.forEach((m, i) => {
    if (m.param.role !== 'system') expect(blocks(m.param).length, `message ${i} has content`).toBeGreaterThan(0);
    const uses = blocks(m.param).filter((b) => b.type === 'tool_use');
    if (m.param.role !== 'assistant' || uses.length === 0) return;
    const next = transcript[i + 1]?.param;
    expect(next?.role, `message ${i + 1} answers the tool calls`).toBe('user');
    const answered = new Set(blocks(next).flatMap((b) => (b.type === 'tool_result' ? [b.tool_use_id] : [])));
    for (const use of uses) if (use.type === 'tool_use') expect(answered.has(use.id)).toBe(true);
    for (const use of uses) if (use.type === 'tool_use') expect(use.id).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
}

const lastDm = (log: LogEntry[]) => log.filter((e): e is DmLogEntry => e.kind === 'dm').at(-1);
const toolNames = (log: LogEntry[]) => log.flatMap((e) => (e.kind === 'tool' ? [e.tool] : []));

describe('the offline demo DM', () => {
  it('plays a whole session through the real handlers without any API call', async () => {
    const h = setupHarness({ settings: { mockMode: true }, campaignSettings: { playerRollMode: 'prompt' } });
    answerRolls(h.store, 15);

    // Opening: set_scene + update_journal, then narration with suggestions.
    await h.controller.beginOrResume();
    let s = h.s();
    expect(s.activeSession?.number).toBe(1);
    expect(s.campaign?.scene.location).toBe('The Crooked Lantern Inn');
    expect(s.journal.some((j) => j.name === 'Wren Hollowell')).toBe(true);
    expect(lastDm(s.log)?.text).toContain('Demo mode');
    expect(lastDm(s.log)?.choices?.length).toBeGreaterThan(1);

    // Turn 1: a skill check through the roll dialog.
    await h.controller.sendPlayerMessage('I scan the room.');
    s = h.s();
    expect(s.log.filter((e) => e.kind === 'roll')).toHaveLength(1);
    expect(lastDm(s.log)?.text).toContain('hooded figure');

    // Turn 2: combat — initiative dialog, a DM attack, damage applied, the turn passes.
    await h.controller.sendPlayerMessage('I confront the hooded figure.');
    s = h.s();
    expect(s.combat?.active).toBe(true);
    expect(s.combat?.combatants.map((c) => c.name)).toContain('Cutpurse');
    expect(toolNames(s.log)).toEqual(expect.arrayContaining(['start_combat', 'update_character']));
    expect(s.character?.hp.current).toBe(8);
    expect(s.log.some((e) => e.kind === 'roll' && e.actor === 'dm' && e.purpose.startsWith('Cutpurse attacks'))).toBe(true);

    // Turn 3: the hero strikes back; the fight ends and a quest appears.
    await h.controller.sendPlayerMessage('I stab with my dagger.');
    s = h.s();
    expect(s.combat).toBeNull();
    expect(s.quests.some((q) => q.title === 'Who hired the cutpurse?')).toBe(true);

    // Turn 4: a secret clock, the oracle, homebrew and a boon on the sheet.
    await h.controller.sendPlayerMessage('I ask Wren about the token.');
    s = h.s();
    expect(s.clocks.find((c) => c.name === 'The Lantern Guild closes in')).toMatchObject({ filled: 1, segments: 6, secret: true });
    expect(s.homebrew.map((x) => x.name)).toEqual(['Lantern-Touched']);
    expect(s.character?.features.some((f) => f.name === 'Lantern-Touched')).toBe(true);
    expect(s.character?.heroicInspiration).toBe(true);
    expect(toolNames(s.log)).toEqual(expect.arrayContaining(['update_clocks', 'consult_oracle', 'create_homebrew']));

    // OOC and free play.
    await h.controller.sendPlayerMessage('OOC: what are you?');
    expect(lastDm(h.s().log)?.text).toContain('Out of character');
    await h.controller.sendPlayerMessage('I rest by the fire.');
    expectValidTranscript(h.s().transcript);

    // Ending: a final journal entry, then the recap; the private notes stay private.
    await h.controller.endSession();
    s = h.s();
    expect(s.activeSession).toBeNull();
    expect(s.sessions[0].recap).toContain('Crooked Lantern Inn');
    expect(s.sessions[0].dmNotes).toContain('Lantern Guild hired the cutpurse');
    expect(s.log.at(-2)).toMatchObject({ kind: 'recap', sessionNumber: 1 });
    expect(JSON.stringify(s.log)).not.toContain('Wren knows more than she has said');
    expect(s.journal.find((j) => j.name === 'The Lantern Guild')).toMatchObject({ secret: true });

    expect(h.client.requests).toHaveLength(0);
    expect(s.dm.phase).toBe('idle');
  });

  it('opens a later session with a "previously" from the last recap', async () => {
    const h = setupHarness({ settings: { mockMode: true }, campaignSettings: { playerRollMode: 'auto' } });
    await h.controller.beginOrResume();
    await h.controller.sendPlayerMessage('I look around.');
    await h.controller.endSession();
    await h.controller.beginOrResume();
    const s = h.s();
    expect(s.activeSession?.number).toBe(2);
    expect(lastDm(s.log)?.text).toContain('Previously…');
  });

  it('keeps the transcript valid when the player cancels mid-script', async () => {
    const h = setupHarness({ settings: { mockMode: true }, campaignSettings: { playerRollMode: 'prompt' } });
    await h.controller.beginOrResume();
    const unsubscribe = h.store.subscribe((state) => {
      if (state.interaction) queueMicrotask(() => h.controller.cancel());
    });
    await h.controller.sendPlayerMessage('I scan the room.');
    unsubscribe();
    expectValidTranscript(h.s().transcript);
    answerRolls(h.store, 10);
    await h.controller.sendPlayerMessage('I try again.');
    expectValidTranscript(h.s().transcript);
    expect(h.s().dm.phase).toBe('idle');
  });
});
