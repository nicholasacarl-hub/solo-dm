import { describe, expect, it } from 'vitest';
import { isAttackPurpose, targetLabel } from './rollDisplay';

// srd:rule:concentration: "If you take damage, you must succeed on a Constitution saving throw to maintain
// Concentration." D8: a creature named like "Attack Dog" never gets an attack card, even when the roll is logged without
// its kind (the DM's roll_dice, RX3).
describe('a roll read from its purpose', () => {
  it('is no attack when the purpose names a save or saving throw, whatever the creature is called', () => {
    for (const purpose of [
      "Attack Dog's Constitution save to keep concentration",
      'Attack Dog saves against Hold Person',
      'Dexterity saving throw against the breath attack',
      'Saving Throws for the Attack Drone',
    ]) {
      expect(isAttackPurpose(purpose), purpose).toBe(false);
      expect(targetLabel({ purpose }), purpose).toBe('DC');
    }
  });

  it('is still an attack when it names one and no save: vs AC', () => {
    for (const purpose of ['Goblin attack', 'Bandit 1 attacks Mira', 'Attack Dog bite', 'Attack on the guard the hero saved']) {
      expect(isAttackPurpose(purpose), purpose).toBe(true);
      expect(targetLabel({ purpose }), purpose).toBe('AC');
    }
    expect(isAttackPurpose('Insight check')).toBe(false);
  });

  it("goes by the roll's kind when it has one, whatever the purpose says", () => {
    expect(targetLabel({ rollType: 'save', purpose: 'Goblin attack' })).toBe('DC');
    expect(targetLabel({ rollType: 'skill', purpose: "Athletics check to break the Attack Dog's grapple" })).toBe('DC');
    expect(targetLabel({ rollType: 'attack', purpose: 'Wisdom save' })).toBe('AC');
  });
});
