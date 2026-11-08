import { beforeEach, describe, expect, it } from 'vitest';
import { applyHeroMove, applyMove, nextTurn, reachableSquares } from '@/engine';
import { heroMoveBlock } from '@/state/gameStore';
import { sampleCharacter, sampleMappedCombat } from '@/test/fixtures';
import type { CombatState, TranscriptMessage } from '@/types';
import { changesSince, movedAnnouncement, planAnnouncement, squareAnnouncement, terrainWords, tokenAt, turnStartAnnouncement } from './announcer';
import { buildModelCore, displayBlock, resetShownBudgetForTests, secretTokensOf, turnRecordHidden, unseenHeroMoves, type BattleMapModel, type ModelInputs } from './model';
import { turnPillText } from './text';
import { previewMove } from './preview';

const hero = sampleCharacter();

function modelFor(combat: CombatState, over: Partial<ModelInputs> = {}): BattleMapModel {
  const core = buildModelCore({ combat, hero, rawBlock: null, canUndo: false, dmPhase: 'idle', hasSession: true, transcript: [], ...over });
  if (!core) throw new Error('no model');
  const reachable = core.canMove ? reachableSquares(core.view, hero, core.heroId, { perspective: 'player' }) : [];
  return { ...core, reachable, secretTokens: [], secretLabels: new Map() };
}

/** The Cutthroat (hidden) acting right after the hero: the player's view still shows the hero's turn (D42). */
function hiddenRightAfterHero(): CombatState {
  const base = sampleMappedCombat({ heroTurn: true });
  const [mira, bandit1, cutthroat, ...rest] = base.combatants;
  return { ...base, combatants: [mira, { ...cutthroat, initiative: 16 }, bandit1, ...rest], turnIndex: 1 };
}

beforeEach(() => resetShownBudgetForTests());

describe('the map model: one player view (D63)', () => {
  it('leaves the hidden Cutthroat out of everything it computes', () => {
    const m = modelFor(sampleMappedCombat({ heroTurn: true }));
    expect(m.view.combatants.map((c) => c.name)).not.toContain('Cutthroat');
    expect(m.snapshot.tokens.map((t) => t.name)).not.toContain('Cutthroat');
    expect([...m.labels.values()]).not.toContain('C');
    expect(m.nameOf('c-5')).toBe('someone');
    expect(m.reachable.length).toBeGreaterThan(0);
    // Its square is open ground to the player.
    expect(tokenAt(m, { x: 12, y: 7 })).toBeNull();
    expect(squareAnnouncement(m, { x: 12, y: 7 })).not.toMatch(/Cutthroat/);
    // "Show DM secrets" draws it from the true state, apart from every computation.
    expect(secretTokensOf(sampleMappedCombat({ heroTurn: true }), hero).map((t) => t.name)).toEqual(['Cutthroat']);
  });

  it('shows whose turn the player sees, and the store’s gate as the reason', () => {
    const npc = modelFor(sampleMappedCombat(), { rawBlock: 'not-your-turn' });
    expect(npc).toMatchObject({ yourTurn: false, currentId: 'c-2', block: 'not-your-turn', canMove: false, budget: null });
    // The Cutthroat's turn (after Bandit 1): the player still sees Bandit 1's.
    const hidden = modelFor({ ...sampleMappedCombat(), turnIndex: 2 }, { rawBlock: 'not-your-turn' });
    expect(hidden.currentId).toBe('c-2');
    expect(hidden.block).toBe('not-your-turn');
  });

  it('a hidden creature acting right after the hero looks like the hero’s turn: busy while the DM works, then a neutral wait', () => {
    const combat = hiddenRightAfterHero();
    expect(heroMoveBlock({ campaign: {} as never, character: hero, combat, dm: { phase: 'idle' } as never, interaction: null, activeSession: {} as never, transcript: [], heroMoveUndo: [] })).toBe(
      'not-your-turn',
    );
    const busy = modelFor(combat, { rawBlock: 'not-your-turn', dmPhase: 'tool' });
    expect(busy).toMatchObject({ yourTurn: true, block: 'dm-busy', canMove: false });
    const idle = modelFor(combat, { rawBlock: 'not-your-turn', dmPhase: 'idle' });
    expect(idle).toMatchObject({ yourTurn: true, block: 'waiting', canMove: false });
    expect(displayBlock('not-your-turn', true, false)).toBe('waiting');
    expect(displayBlock('not-your-turn', false, false)).toBe('not-your-turn');
    expect(displayBlock('dm-busy', true, true)).toBe('dm-busy');
  });

  it('keeps the hero’s last movement readout while a hidden creature acts right after the hero', () => {
    // The hero moves B6 → C7 (5 ft) on the hero's own turn.
    const start = sampleMappedCombat({ heroTurn: true });
    const moved = applyHeroMove(start, hero, { to: { x: 2, y: 6 }, prefer: 'safest', dash: false, disengage: false, standUp: false }, { stopResolved: true });
    if (moved.status === 'refused') throw new Error('refused');
    expect(modelFor(moved.state).budget?.leftFt).toBe(25);
    // Then the hidden Cutthroat's turn: its own (fresh) turn record replaces the hero's, which the view drops.
    const [mira, ...others] = moved.state.combatants;
    const cut = others.find((c) => c.id === 'c-5');
    const order = [mira, { ...(cut as (typeof others)[number]), initiative: 16 }, ...others.filter((c) => c.id !== 'c-5')];
    const hiddenTurn: CombatState = {
      ...moved.state,
      combatants: order,
      turnIndex: 1,
      map: { ...(moved.state.map as NonNullable<CombatState['map']>), turn: { combatantId: 'c-5', round: 2, movedFt: 10, dashFt: 0, dashes: 0, disengaged: false, stoodUp: false, moves: [] } },
    };
    const during = modelFor(hiddenTurn, { rawBlock: 'not-your-turn', dmPhase: 'tool' });
    expect(during.yourTurn).toBe(true);
    expect(during.budget?.leftFt).toBe(25);
  });

  it('U8: a page loaded during the hidden turn never shows the hero’s movement reset to full Speed', () => {
    // Mira 17, the Cutthroat 16 (hidden), Bandit 1 14…: the hero moves B6 → B8 (10 ft) on the hero's own turn.
    const base = sampleMappedCombat({ heroTurn: true });
    const [mira, bandit1, cutthroat, ...rest] = base.combatants;
    const ordered: CombatState = { ...base, combatants: [mira, { ...cutthroat, initiative: 16 }, bandit1, ...rest], turnIndex: 0 };
    const moved = applyHeroMove(ordered, hero, { to: { x: 1, y: 7 }, prefer: 'safest', dash: false, disengage: false, standUp: false }, { stopResolved: true });
    if (moved.status === 'refused') throw new Error('refused');
    expect(modelFor(moved.state).budget?.leftFt).toBe(20);
    const hiddenTurn = nextTurn(moved.state);
    // Reloaded before the Cutthroat does anything: the hero's record is still on the map, and it tells the truth…
    resetShownBudgetForTests();
    expect(turnRecordHidden(hiddenTurn)).toBe(false);
    expect(modelFor(hiddenTurn, { rawBlock: 'not-your-turn' }).budget?.leftFt).toBe(20);
    // …and is kept when the Cutthroat's move replaces that record on the same page.
    const cutMoved = applyMove(hiddenTurn, hero, { moverId: 'c-5', kind: 'move', by: 'dm', to: { kind: 'square', at: { x: 11, y: 7 } } });
    if (cutMoved.status === 'refused') throw new Error('refused');
    expect(turnRecordHidden(cutMoved.state)).toBe(true);
    expect(modelFor(cutMoved.state, { rawBlock: 'not-your-turn' }).budget?.leftFt).toBe(20);
    // Reloaded after the Cutthroat moved: the hero's movement can't be known here; no fresh "30 ft" (the turn would
    // look restarted), just "Your turn".
    resetShownBudgetForTests();
    const reloaded = modelFor(cutMoved.state, { rawBlock: 'not-your-turn' });
    expect(reloaded.yourTurn).toBe(true);
    expect(reloaded.budget).toBeNull();
    expect(turnPillText({ yourTurn: reloaded.yourTurn, currentName: null, budget: reloaded.budget })).toBe('Your turn');
  });

  it('lists the hero’s moves the DM hasn’t answered yet (D48)', () => {
    const start = sampleMappedCombat({ heroTurn: true });
    const moved = applyHeroMove(start, hero, { to: { x: 2, y: 6 }, prefer: 'safest', dash: false, disengage: false, standUp: false }, { stopResolved: true });
    if (moved.status === 'refused') throw new Error('refused');
    expect(unseenHeroMoves(moved.state, 'c-1', [])).toHaveLength(1);
    // Stamped with the user message seq 7 and answered by an assistant message after it: seen.
    const turn = (moved.state.map as NonNullable<CombatState['map']>).turn as NonNullable<NonNullable<CombatState['map']>['turn']>;
    const stamped: CombatState = { ...moved.state, map: { ...(moved.state.map as NonNullable<CombatState['map']>), turn: { ...turn, moves: turn.moves.map((m) => ({ ...m, toldSeq: 7 })) } } };
    const transcript = [
      { seq: 7, param: { role: 'user', content: 'I take cover.' } },
      { seq: 8, param: { role: 'assistant', content: [] } },
    ] as unknown as TranscriptMessage[];
    expect(unseenHeroMoves(stamped, 'c-1', transcript)).toEqual([]);
    expect(unseenHeroMoves(stamped, 'c-1', transcript.slice(0, 1))).toHaveLength(1);
  });
});

describe('the live region (spec §7.9)', () => {
  it('reads a square under the cursor: terrain, where it is from you, and the movement', () => {
    const m = modelFor(sampleMappedCombat({ heroTurn: true }));
    expect(squareAnnouncement(m, { x: 3, y: 7 })).toBe('D8: open ground. 10 feet south-east of you. Move: 10 feet.');
    // Crates are half cover and Difficult Terrain to cross (spec §3.3.1): 15 ft away, 20 ft of movement.
    expect(squareAnnouncement(m, { x: 4, y: 4 })).toBe('E5: crates, half cover. 15 feet east of you. Move: 20 feet.');
    expect(squareAnnouncement(m, { x: 1, y: 5 })).toBe('B6 (the loading door): you.');
    expect(terrainWords(m, { x: 13, y: 4 })).toBe('office door, closed door');
  });

  it('reads a creature: name, side, health it shows, and distance', () => {
    const m = modelFor(sampleMappedCombat({ heroTurn: true }));
    expect(squareAnnouncement(m, { x: 5, y: 3 })).toBe('F4: Bandit 1, enemy, bloodied. 20 feet from you.');
    expect(squareAnnouncement(m, { x: 5, y: 2 })).toBe('F3: Bandit 2, enemy, unhurt, Prone. 20 feet from you.');
  });

  it('reads a plan, with its Opportunity Attack', () => {
    const base = sampleMappedCombat({ heroTurn: true });
    const adjacent = { ...base, combatants: base.combatants.map((c) => (c.id === 'c-2' ? { ...c, position: { x: 2, y: 4 } } : c)) };
    const m = modelFor(adjacent);
    const preview = previewMove(m, { to: { x: 3, y: 7 }, prefer: 'safest', dash: false, disengage: false, standUp: false });
    expect(planAnnouncement(preview, m.nameOf, null)).toBe(
      'Plan: D8, 10 feet, 20 left. Leaves the reach of Bandit 1: Opportunity Attack. Press Enter to move.',
    );
    expect(movedAnnouncement({ x: 3, y: 7 })).toBe('Moved to D8.');
  });

  it('sums up what visibly changed since the hero’s last turn', () => {
    const before = sampleMappedCombat();
    const after: CombatState = {
      ...before,
      combatants: before.combatants.map((c) => (c.id === 'c-2' ? { ...c, position: { x: 2, y: 4 } } : c.id === 'c-3' ? { ...c, defeated: true } : c)),
    };
    const m = modelFor(after);
    const changes = changesSince(modelFor(before).view, m.view, m.nameOf);
    expect(changes).toEqual(['Bandit 1 moved to C5', 'Bandit 2 is down']);
    expect(turnStartAnnouncement(30, changes)).toBe('Your turn. 30 feet of movement. Since your last turn: Bandit 1 moved to C5; Bandit 2 is down.');
  });
});
