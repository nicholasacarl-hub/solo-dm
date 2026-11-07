import { describe, expect, it } from 'vitest';
import type { Combatant, CombatState } from '@/types';
import { sampleCombat } from '@/test/fixtures';
import {
  addCombatant,
  createCombat,
  currentCombatant,
  damageCombatant,
  findCombatant,
  healCombatant,
  healthDescriptor,
  nextTurn,
  removeCombatant,
  sortCombatants,
  summarizeCombat,
  updateCombatant,
} from './combat';

const npc = (id: string, name: string, initiative: number, extra: Partial<Combatant> = {}): Combatant => ({
  id,
  name,
  side: 'enemy',
  isPlayer: false,
  initiative,
  initiativeBonus: 0,
  hp: { max: 10, current: 10, temp: 0 },
  conditions: [],
  defeated: false,
  ...extra,
});
const names = (s: CombatState) => s.combatants.map((c) => c.name);

describe('ordering', () => {
  it('sorts by initiative, then bonus, then the player, then name', () => {
    const list = [
      npc('a', 'Ogre', 12),
      npc('b', 'Goblin 10', 15, { initiativeBonus: 2 }),
      npc('c', 'Goblin 2', 15, { initiativeBonus: 2 }),
      { ...npc('p', 'Mira', 15, { initiativeBonus: 2 }), isPlayer: true, side: 'player' as const },
      npc('d', 'Wolf', 15, { initiativeBonus: 3 }),
    ];
    expect(sortCombatants(list).map((c) => c.id)).toEqual(['d', 'p', 'c', 'b', 'a']);
  });

  it('createCombat starts round 1 at the top and numbers duplicate names', () => {
    const state = createCombat([npc('a', 'Goblin', 10), npc('b', 'Goblin', 14), npc('c', 'Bugbear', 8)], 'Cave mouth');
    expect(state).toMatchObject({ active: true, round: 1, turnIndex: 0, encounterName: 'Cave mouth' });
    expect(names(state)).toEqual(['Goblin 2', 'Goblin 1', 'Bugbear']);
    expect(currentCombatant(state)?.id).toBe('b');
  });
});

describe('turns', () => {
  it('advances to the next creature', () => {
    const s = nextTurn(sampleCombat());
    expect(s.turnIndex).toBe(2);
    expect(s.round).toBe(2);
    expect(currentCombatant(s)?.name).toBe('Bandit 2');
  });

  it('skips defeated creatures and increments the round when wrapping', () => {
    const base = sampleCombat();
    const withDown = { ...base, turnIndex: 2, combatants: base.combatants.map((c) => (c.id === 'c-4' ? { ...c, defeated: true } : c)) };
    const s = nextTurn(withDown);
    expect(s.turnIndex).toBe(0);
    expect(s.round).toBe(3);
    const allDown = { ...base, combatants: base.combatants.map((c) => ({ ...c, defeated: true })) };
    expect(nextTurn(allDown)).toBe(allDown);
  });

  it('wraps a lone survivor into the next round', () => {
    const s = createCombat([npc('a', 'Lich', 20), npc('b', 'Skeleton', 5, { defeated: true })]);
    expect(nextTurn(s)).toMatchObject({ turnIndex: 0, round: 2 });
  });
});

describe('adding, removing and updating', () => {
  it('adding before the current creature keeps the same creature current', () => {
    const base = sampleCombat(); // Bandit 1 (init 14) is up
    const s = addCombatant(base, npc('x', 'Wolf', 16));
    expect(names(s)).toEqual(['Mira Voss', 'Wolf', 'Bandit 1', 'Bandit 2', 'Old Tam']);
    expect(currentCombatant(s)?.id).toBe('c-2');
    const later = addCombatant(base, npc('y', 'Rat', 1));
    expect(later.turnIndex).toBe(1);
    expect(names(later).at(-1)).toBe('Rat');
  });

  it('numbers a duplicate name when adding', () => {
    expect(names(addCombatant(sampleCombat(), npc('z', 'Bandit 1', 3))).at(-1)).toBe('Bandit 3');
    const s = createCombat([npc('a', 'Goblin', 10)]);
    expect(names(addCombatant(s, npc('b', 'goblin', 9)))).toEqual(['Goblin', 'goblin 2']);
  });

  it('removing keeps the current creature, or passes the turn on', () => {
    const before = removeCombatant(sampleCombat(), 'c-1');
    expect(currentCombatant(before)?.id).toBe('c-2');
    const current = removeCombatant(sampleCombat(), 'c-2');
    expect(currentCombatant(current)?.id).toBe('c-3');
    expect(current.round).toBe(2);
    const last = removeCombatant({ ...sampleCombat(), turnIndex: 3 }, 'c-4');
    expect(last).toMatchObject({ turnIndex: 0, round: 3 });
    const lastStanding = sampleCombat();
    const everyoneDown = { ...lastStanding, turnIndex: 3, combatants: lastStanding.combatants.map((c) => ({ ...c, defeated: c.id !== 'c-4' })) };
    expect(removeCombatant(everyoneDown, 'c-4').turnIndex).toBe(2);
    expect(removeCombatant(sampleCombat(), 'nobody')).toEqual(sampleCombat());
  });

  it('re-sorts on an initiative change without losing the current turn', () => {
    const s = updateCombatant(sampleCombat(), 'c-4', { initiative: 20 });
    expect(names(s)[0]).toBe('Old Tam');
    expect(currentCombatant(s)?.id).toBe('c-2');
    const noted = updateCombatant(sampleCombat(), 'c-3', { notes: 'Hiding behind crates', id: 'hacked' });
    expect(findCombatant(noted, 'c-3')?.notes).toBe('Hiding behind crates');
  });

  it('finds by id, name, or a unique partial name', () => {
    const s = sampleCombat();
    expect(findCombatant(s, 'c-3')?.name).toBe('Bandit 2');
    expect(findCombatant(s, 'bandit 2')?.id).toBe('c-3');
    expect(findCombatant(s, 'tam')?.id).toBe('c-4');
    expect(findCombatant(s, 'bandit')).toBeUndefined(); // ambiguous
  });
});

describe('NPC hit points', () => {
  it('damage spends temp HP first and defeats at 0', () => {
    const s = updateCombatant(sampleCombat(), 'c-4', { hp: { max: 9, current: 9, temp: 3 } });
    const hit = damageCombatant(s, 'c-4', 5);
    expect(findCombatant(hit.state, 'c-4')?.hp).toEqual({ max: 9, current: 7, temp: 0 });
    expect(hit.events[0].message).toBe('Old Tam takes 5 damage (HP 9 → 7, 3 absorbed by temporary HP)');
    const down = damageCombatant(sampleCombat(), 'c-2', 10);
    expect(findCombatant(down.state, 'c-2')).toMatchObject({ defeated: true, hp: { current: 0 } });
    expect(down.events[0].message).toBe('Bandit 1 takes 10 damage (down) — defeated');
  });

  it('hidden HP stay hidden in messages; the player is refused', () => {
    const r = damageCombatant(sampleCombat(), 'Bandit 2', 6);
    expect(r.events[0].message).toBe('Bandit 2 takes 6 damage (bloodied)');
    expect(damageCombatant(sampleCombat(), 'c-1', 5).events[0].type).toBe('warning');
    expect(damageCombatant(sampleCombat(), 'nobody', 5).events[0].type).toBe('warning');
  });

  it('healing brings a defeated creature back', () => {
    const down = damageCombatant(sampleCombat(), 'c-2', 10).state;
    const up = healCombatant(down, 'c-2', 3);
    expect(findCombatant(up.state, 'c-2')).toMatchObject({ defeated: false, hp: { current: 3 } });
    expect(up.events[0].message).toMatch(/back in the fight/);
    expect(findCombatant(healCombatant(sampleCombat(), 'c-4', 50).state, 'c-4')?.hp?.current).toBe(9);
  });

  it('health descriptor bands', () => {
    const at = (current: number) => healthDescriptor({ max: 20, current, temp: 0 });
    expect([20, 11, 10, 6, 5, 1, 0].map(at)).toEqual(['unhurt', 'scratched', 'bloodied', 'bloodied', 'critical', 'critical', 'down']);
  });
});

describe('summarizeCombat', () => {
  it('lists the turn order for the DM with exact HP', () => {
    const text = summarizeCombat(sampleCombat());
    expect(text.split('\n')[0]).toBe("Combat: Ambush on the docks — round 2, Bandit 1's turn");
    expect(text).toContain('→ 2. Bandit 1 (enemy) · Init 14 · AC 12 · HP 4/11');
    expect(text).toContain('Bandit 2 (enemy) · Init 9 · AC 12 · HP 11/11 · Prone');
    expect(summarizeCombat(sampleCombat())).toBe(text);
  });

  it('hides hidden HP from the player', () => {
    const text = summarizeCombat(sampleCombat(), { forPlayer: true });
    expect(text).toContain('Bandit 1 (enemy) · Init 14 · AC 12 · bloodied');
    expect(text).not.toContain('4/11');
    expect(text).toContain('Old Tam (ally) · Init 5 · AC 11 · HP 9/9');
    expect(text).toContain('1. Mira Voss (you) · Init 17 · AC 12');
    expect(summarizeCombat(sampleCombat())).toContain('1. Mira Voss (PC) · Init 17 · AC 12');
    expect(summarizeCombat({ ...sampleCombat(), active: false })).toBe('Combat ended: Ambush on the docks.');
  });
});
