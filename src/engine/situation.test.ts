import { describe, expect, it } from 'vitest';
import type { Character, PlayerRollRequest } from '@/types';
import { sampleCharacter } from '@/test/fixtures';
import { combineAdvantage, hasLuckTrait, rollSituation } from './situation';

const mira = (overrides: Partial<Character> = {}) => sampleCharacter(overrides);
const req = (patch: Partial<PlayerRollRequest>): PlayerRollRequest => ({ rollType: 'skill', revealDc: false, advantage: 'normal', reason: 'test', ...patch });

describe('combineAdvantage (SRD 5.2.1 Advantage)', () => {
  it("doesn't stack and cancels out", () => {
    expect(combineAdvantage('advantage', 'advantage')).toBe('advantage');
    expect(combineAdvantage('advantage', 'disadvantage', 'disadvantage')).toBe('normal');
    expect(combineAdvantage('normal', undefined)).toBe('normal');
    expect(combineAdvantage('normal', { advantage: [], disadvantage: ['Poisoned'], autoFail: null, notes: [] })).toBe('disadvantage');
  });
});

describe('rollSituation', () => {
  it('conditions that hamper attacks and checks', () => {
    const poisoned = mira({ conditions: [{ id: 'poisoned' }, { id: 'prone' }] });
    expect(rollSituation(poisoned, req({ rollType: 'attack', attackName: 'Dagger' })).disadvantage).toEqual(['Poisoned', 'Prone']);
    expect(rollSituation(poisoned, req({ skill: 'arcana' })).disadvantage).toEqual(['Poisoned']);
    expect(rollSituation(poisoned, req({ rollType: 'save', ability: 'con' })).disadvantage).toEqual([]);
    const scared = rollSituation(mira({ conditions: [{ id: 'frightened' }] }), req({ skill: 'stealth' }));
    expect(scared.disadvantage).toEqual([]);
    expect(scared.notes[0]).toMatch(/source of fear is in sight/);
  });

  it('Invisible grants Advantage on attacks and initiative', () => {
    const unseen = mira({ conditions: [{ id: 'invisible' }] });
    expect(rollSituation(unseen, req({ rollType: 'attack', attackName: 'Dagger' })).advantage).toEqual(['Invisible']);
    expect(combineAdvantage('normal', rollSituation(unseen, req({ rollType: 'initiative' })))).toBe('advantage');
  });

  it('automatic failures on Strength and Dexterity saves', () => {
    const stunned = mira({ conditions: [{ id: 'stunned' }] });
    expect(rollSituation(stunned, req({ rollType: 'save', ability: 'dex' })).autoFail).toMatch(/^Stunned: automatically fails/);
    expect(rollSituation(stunned, req({ rollType: 'save', ability: 'wis' })).autoFail).toBeNull();
    expect(rollSituation(mira({ conditions: [{ id: 'restrained' }] }), req({ rollType: 'save', ability: 'dex' })).disadvantage).toEqual(['Restrained']);
  });

  it('armor: Stealth Disadvantage and untrained armor', () => {
    const plate = mira({
      armorTraining: ['Heavy armor'],
      inventory: [{ id: 'p', name: 'Plate Armor', quantity: 1, equipped: true, category: 'armor' }],
    });
    expect(rollSituation(plate, req({ skill: 'stealth' })).disadvantage).toEqual(['Plate Armor (Stealth)']);
    expect(rollSituation(plate, req({ skill: 'arcana' })).disadvantage).toEqual([]);
    const untrained = { ...plate, armorTraining: [] };
    expect(rollSituation(untrained, req({ rollType: 'attack', attackName: 'Dagger' })).disadvantage).toEqual(['Plate Armor (untrained)']);
    expect(rollSituation(untrained, req({ rollType: 'save', ability: 'wis' })).disadvantage).toEqual([]);
  });

  it("a Champion's weapon attacks score a Critical Hit on 19–20 (SRD 5.2.1 Champion: Improved Critical)", () => {
    const champion = mira({ classes: [{ classId: 'srd:class:fighter', name: 'Fighter', level: 3, hitDie: 10, casterType: 'none', subclass: 'Champion' }] });
    expect(rollSituation(champion, req({ rollType: 'attack', attackName: 'Dagger' })).critRange).toBe(19);
    expect(rollSituation(champion, req({ rollType: 'attack', attackName: 'Fire Bolt' })).critRange).toBeUndefined();
    expect(rollSituation(champion, req({ skill: 'athletics' })).critRange).toBeUndefined();
    expect(rollSituation(mira(), req({ rollType: 'attack', attackName: 'Dagger' })).critRange).toBeUndefined();
  });

  it('Halfling Luck on every D20 Test, death saves included (SRD 5.2.1 Halfling)', () => {
    const halfling = mira({ species: 'Halfling', features: [{ id: 'luck', name: 'Luck', source: 'species', sourceName: 'Halfling', description: '' }] });
    expect(rollSituation(halfling, req({ skill: 'stealth' })).luck).toMatch(/^Luck \(Halfling\)/);
    expect(rollSituation(halfling, req({ rollType: 'save', ability: 'dex' })).luck).toBeDefined();
    expect(rollSituation(halfling, req({ rollType: 'death-save' })).luck).toBeDefined();
    expect(rollSituation(halfling, req({ rollType: 'damage', attackName: 'Dagger' })).luck).toBeUndefined();
    expect(hasLuckTrait(mira({ species: 'Halfling', features: [] }))).toBe(true); // no traits recorded
    expect(hasLuckTrait(mira())).toBe(false);
  });

  it('ignores rolls that are not d20 tests', () => {
    expect(rollSituation(mira({ conditions: [{ id: 'poisoned' }] }), req({ rollType: 'damage', attackName: 'Dagger' }))).toEqual({
      advantage: [],
      disadvantage: [],
      autoFail: null,
      notes: [],
    });
  });
});
