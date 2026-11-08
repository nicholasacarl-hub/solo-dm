import { describe, expect, it, vi } from 'vitest';

vi.mock('@/engine', () => import('./testing/fakeEngine'));
vi.mock('@/data', () => import('./testing/fakeData'));
vi.mock('@/state/gameStore', () => import('./testing/fakeGameStoreModule'));

import { sampleCampaign, sampleCharacter, sampleClocks, sampleCombat, sampleJournal, sampleMappedCombat, sampleStopCombat } from '@/test/fixtures';
import type { BattleMap, CombatState, JournalEntry, TurnMove } from '@/types';
import { mapStateLines } from './mapText';
import { buildGameState, findMentionedEntries, mentions, MAX_ENTITY_CARDS, type GameStateInput } from './state';

function input(overrides: Partial<GameStateInput> = {}): GameStateInput {
  return {
    campaign: sampleCampaign(),
    character: sampleCharacter(),
    combat: null,
    clocks: sampleClocks(),
    journal: sampleJournal(),
    playerText: '',
    previousNarration: '',
    ...overrides,
  };
}

describe('mentions', () => {
  it('matches whole words, case-insensitively', () => {
    expect(mentions('I ask old tam about it', 'Old Tam')).toBe(true);
    expect(mentions('Old  Tam, are you there?', 'Old Tam')).toBe(true);
    expect(mentions('I ask Old Tamsin', 'Old Tam')).toBe(false);
    expect(mentions('Ask the dockhand', 'dockhand')).toBe(true);
    expect(mentions('a', 'Al')).toBe(false);
  });
});

describe('buildGameState', () => {
  it('has the hero status, scene, tension and open clocks', () => {
    const block = buildGameState(input());
    expect(block.startsWith('<game_state>\n')).toBe(true);
    expect(block.endsWith('\n</game_state>')).toBe(true);
    expect(block).toContain('Hero: Mira Voss (Wizard 3) · HP 12/17');
    expect(block).toContain('Scene: Saltmarsh Docks · dusk · fog rolling in · mood: uneasy · Tension 5/9');
    expect(block).toContain('Clocks: Something stirs below 2/6 (threat, secret) · The tide turns 1/4 (countdown)');
    expect(block).not.toContain('Combat:');
    expect(block).not.toContain('Mentioned');
  });

  it('adds the combat summary when a fight is on', () => {
    expect(buildGameState(input({ combat: sampleCombat() }))).toMatch(/Combat:\nRound 2/);
  });

  it('adds cards for journal entries named in the player text or the last narration, secrets marked', () => {
    const block = buildGameState(
      input({ playerText: 'I ask Tam about Keeper Halvard.', previousNarration: 'The drowned lantern burns green.' }),
    );
    expect(block).toContain('- Keeper Halvard (NPC, missing) [secret]: The missing keeper.');
    expect(block).toContain('- The Drowned Lantern (Location): The abandoned lighthouse');
    expect(block).not.toContain('Old Tam (NPC');
  });

  it('matches tags as aliases and caps the number of cards', () => {
    expect(findMentionedEntries(sampleJournal(), 'Where is the witness?', '').map((j) => j.name)).toEqual(['Old Tam']);
    const many: JournalEntry[] = Array.from({ length: 10 }, (_, i) => ({ ...sampleJournal()[0], id: `n${i}`, name: `Sailor ${i + 1}`, tags: [] }));
    const text = many.map((j) => j.name).join(', ');
    expect(findMentionedEntries(many, text, '')).toHaveLength(MAX_ENTITY_CARDS);
  });

  it('ranks names the player used, then names in the narration, then tag aliases', () => {
    const found = findMentionedEntries(sampleJournal(), 'Old Tam', 'Keeper Halvard and the lighthouse');
    expect(found.map((j) => j.name)).toEqual(['Old Tam', 'Keeper Halvard', 'The Drowned Lantern']);
  });
});

const hero = sampleCharacter();
const block = (combat: CombatState, answered: (seq: number) => boolean = () => false) => mapStateLines(combat, hero, answered).join('\n');

/** The hero's turn after the player moved B6 → C7 (5 ft); `toldSeq` marks the user message that reported it. */
function movedOnce(move: Partial<TurnMove> = {}): CombatState {
  const base = sampleMappedCombat({ heroTurn: true });
  const m: TurnMove = { by: 'player', kind: 'move', from: { x: 1, y: 5 }, to: { x: 2, y: 6 }, path: [{ x: 2, y: 6 }], costFt: 5, provoked: [], entered: [], ...move };
  return {
    ...base,
    combatants: base.combatants.map((c) => (c.isPlayer ? { ...c, position: m.to } : c)),
    map: {
      ...(base.map as BattleMap),
      turn: { combatantId: 'c-1', round: 2, movedFt: m.costFt, dashFt: m.dashed ? 30 : 0, dashes: m.dashed ? 1 : 0, disengaged: m.disengaged ?? false, stoodUp: false, moves: [m] },
    },
  };
}

describe('the battle map in <game_state> (spec §5.4)', () => {
  it('Example 1: positions, distances, cover and the turn, within its budget', () => {
    const text = block(sampleMappedCombat({ heroTurn: true }));
    // The computed facts (amendment 11): Bandit 2's Half Cover from the hero comes from Bandit 1.
    expect(text).toBe(
      [
        'Map: Dockside warehouse 16×12 (A1 top-left; full layout: check_map show)',
        '- Mira Voss (hero) B6 (the loading door) · reach 5 ft',
        '- Bandit 1 F4 · 20 ft · Half cover (crates)',
        '- [hidden] Cutthroat M8 · 55 ft',
        '- Bandit 2 F3 · 20 ft · Half cover (Bandit 1)',
        '- Old Tam B5 (the loading door) · 5 ft',
        '- Dock Ogre H10:I11 · 30 ft',
        'In reach: none',
        'Turn: Mira Voss — 30 ft of movement.',
      ].join('\n'),
    );
    expect(text.length).toBeLessThanOrEqual(700);
  });

  it("Example 2: a pending player stop, reported once with the exact call to finish the move, within its budget", () => {
    const text = block(sampleStopCombat());
    expect(text).toBe(
      [
        'Map: Dockside warehouse 16×12 (A1 top-left; full layout: check_map show)',
        "- Mira Voss (hero) B6 (the loading door) · reach 5 ft · within 5 ft of Bandit 1 and Dock Ogre (Mira Voss's ranged attacks have Disadvantage)",
        '- Bandit 1 C5 · 5 ft · Reaction used',
        '- [hidden] Cutthroat M8 · 55 ft · Half cover (crates)',
        '- Bandit 2 F3 · 20 ft · Half cover (crates, Bandit 1)',
        '- Old Tam B5 (the loading door) · 5 ft',
        '- Dock Ogre C7:D8 · 5 ft',
        'In reach: Bandit 1 ↔ Mira Voss · Bandit 1 ↔ Old Tam · Dock Ogre ↔ Mira Voss',
        "Turn: Mira Voss — hasn't moved (30 ft of movement).",
        'New since your last reply: the player moved Mira Voss toward A7 and the move stopped at B6 — leaving Dock Ogre\'s reach there provokes its Opportunity Attack (its Reaction is unused). The player meant to go on to A7 (5 ft more). Resolve the attack (roll_dice), then finish the move with move_tokens {"moves":[{"who":"hero","to":"A7"}]} unless it stops the hero.',
      ].join('\n'),
    );
    expect(text.length).toBeLessThanOrEqual(1000);
  });

  it("adds the turn check only when the tracker isn't on the hero (D54)", () => {
    expect(block(sampleMappedCombat())).toContain("Turn check: the tracker is on Bandit 1's turn. If that turn is over, call update_combat next_turn first.");
    expect(block(sampleMappedCombat({ heroTurn: true }))).not.toContain('Turn check');
    expect(block(sampleStopCombat())).not.toContain('Turn check');
  });

  it('sits right after the Combat block, and only when the fight has a map', () => {
    const state = buildGameState(input({ combat: sampleMappedCombat({ heroTurn: true }) }));
    expect(state).toMatch(/Combat:\n[\s\S]*\nMap: Dockside warehouse 16×12/);
    expect(state.indexOf('Map: Dockside')).toBeGreaterThan(state.indexOf('Combat:'));
    expect(state.indexOf('Map: Dockside')).toBeLessThan(state.indexOf('Clocks:'));
    expect(buildGameState(input({ combat: sampleCombat() }))).not.toContain('Map:');
  });

  it('reports a player move until the DM has answered the message that carried it, then only in the totals (D48)', () => {
    expect(block(movedOnce())).toContain('New since your last reply: the player moved Mira Voss B6 → C7 (5 ft).');
    // Stamped with seq 7 but never answered (the request failed): still new.
    expect(block(movedOnce({ toldSeq: 7 }), () => false)).toContain('New since your last reply: the player moved Mira Voss B6 → C7 (5 ft).');
    const seen = block(movedOnce({ toldSeq: 7 }), (seq) => seq === 7);
    expect(seen).not.toContain('New since your last reply');
    expect(seen).toContain('Turn: Mira Voss — moved 5 of 30 ft (B6 C7), 25 ft left.');
  });

  it('says how the player moved: Disengage, Dash, a hidden reactor, a hidden creature in the way', () => {
    expect(block(movedOnce({ disengaged: true, dashed: true }))).toContain(
      'the player moved Mira Voss B6 → C7 (5 ft) after taking the Disengage action and the Dash action.',
    );
    expect(block(movedOnce({ disengaged: true }))).toContain('Turn: Mira Voss — moved 5 of 30 ft (B6 C7), 25 ft left; took the Disengage action.');
    const unseenOa = block(movedOnce({ provoked: [{ reactorId: 'c-5', at: { x: 1, y: 5 }, hidden: true }] }));
    expect(unseenOa).toContain(
      'leaving B6 gave the [hidden] Cutthroat an unseen Opportunity Attack — resolve it if it takes it; if it stops the hero, put Mira Voss back on B6 with move_tokens kind "place".',
    );
    const blocked = block(movedOnce({ revealedHidden: true, blockedById: 'c-5' }));
    expect(blocked).toContain("Mira Voss's move stopped at C7: the [hidden] Cutthroat (M8) blocks the way — the player saw the hero stop and nothing more.");
  });

  it("notes the hero's spent Reaction, as for anyone else", () => {
    const base = sampleMappedCombat({ heroTurn: true });
    const spent: CombatState = { ...base, combatants: base.combatants.map((c) => (c.isPlayer ? { ...c, reactionUsed: true } : c)) };
    expect(block(spent)).toContain('- Mira Voss (hero) B6 (the loading door) · reach 5 ft · Reaction used\n');
  });

  it('lists lasting effects and map warnings', () => {
    const base = sampleMappedCombat({ heroTurn: true });
    const map = base.map as BattleMap;
    const web = { id: 'e20', label: 'Web', spec: { shape: 'squares' as const, rects: [{ x0: 6, y0: 6, x1: 9, y1: 9 }] }, rects: [{ x0: 6, y0: 6, x1: 9, y1: 9 }], terrain: ['difficult' as const, 'obscured' as const], duration: 'lasting' as const, round: 2, turnOfId: 'c-1' };
    const state: CombatState = {
      ...base,
      combatants: base.combatants.map((c) => (c.name === 'Bandit 2' ? { ...c, elevationFt: 10 } : c)),
      map: { ...map, effects: [web] },
    };
    const text = block(state);
    expect(text).toContain('Effects: Web G7:J10 (difficult, obscured)');
    expect(text).toContain('- Bandit 2 F3 · ↑10 ft, not flying · 20 ft');
    expect(text).toContain('Check: Bandit 2 is 10 ft up without a Fly Speed — correct its height with move_tokens kind "place" if it isn\'t on a ledge.');
  });
});
