import { describe, expect, it } from 'vitest';
import { CONDITION_IDS } from '@/types';
import { CONDITIONS, conditionDetails, conditionName, matchStandardCondition, normalizeConditionId } from './conditions';

describe('CONDITIONS (SRD 5.2.1 Rules Glossary)', () => {
  it('covers all 15 conditions with a summary and effects', () => {
    expect(Object.keys(CONDITIONS).sort()).toEqual([...CONDITION_IDS].sort());
    for (const id of CONDITION_IDS) {
      const info = CONDITIONS[id];
      expect(info.id).toBe(id);
      expect(info.name.toLowerCase()).toBe(id);
      expect(info.summary.endsWith('.')).toBe(true);
      expect(info.effects.length).toBeGreaterThan(0);
    }
  });

  it('reflects the 2024 rules', () => {
    expect(CONDITIONS.exhaustion.effects.join(' ')).toMatch(/2 × your Exhaustion level/);
    expect(CONDITIONS.exhaustion.effects.join(' ')).toMatch(/die at level 6/);
    expect(CONDITIONS.unconscious.effects[0]).toMatch(/remain Prone/);
    expect(CONDITIONS.stunned.effects.join(' ')).not.toMatch(/Speed/);
    expect(CONDITIONS.petrified.effects).toContain('You have Immunity to the Poisoned condition.');
  });
});

describe('normalizeConditionId', () => {
  it('maps free text to standard ids', () => {
    expect(normalizeConditionId('Poisoned')).toBe('poisoned');
    expect(normalizeConditionId('knocked prone')).toBe('prone');
    expect(normalizeConditionId('knocked out')).toBe('unconscious');
    expect(normalizeConditionId('Frightened of the dragon')).toBe('frightened');
    expect(normalizeConditionId('Exhaustion 2')).toBe('exhaustion');
    expect(normalizeConditionId('paralysed')).toBe('paralyzed');
    expect(normalizeConditionId('turned to stone')).toBe('petrified');
    expect(normalizeConditionId('blind')).toBe('blinded');
  });

  it('returns null for anything else', () => {
    expect(normalizeConditionId('')).toBeNull();
    expect(normalizeConditionId('hungry')).toBeNull();
  });
});

describe('matchStandardCondition', () => {
  it('accepts a condition or a phrase that starts with one', () => {
    expect(matchStandardCondition('Restrained')).toEqual({ id: 'restrained', detail: '' });
    expect(matchStandardCondition('knocked prone')).toEqual({ id: 'prone', detail: '' });
    expect(matchStandardCondition('Charmed (by the vampire)')).toEqual({ id: 'charmed', detail: 'by the vampire' });
  });

  it('leaves homebrew names alone', () => {
    expect(matchStandardCondition('Poison Mist')).toBeNull();
    expect(matchStandardCondition('Charm of Warding')).toBeNull();
  });

  it('takes the noun and adjective forms of the SRD 5.2.1 Rules Glossary condition names as those conditions', () => {
    expect(matchStandardCondition('Blindness')).toEqual({ id: 'blinded', detail: '' });
    expect(matchStandardCondition('deafness')).toEqual({ id: 'deafened', detail: '' });
    expect(matchStandardCondition('Sleeping')).toEqual({ id: 'unconscious', detail: '' });
    expect(matchStandardCondition('Unconsciousness')).toEqual({ id: 'unconscious', detail: '' });
    expect(matchStandardCondition('Petrification')).toEqual({ id: 'petrified', detail: '' });
    expect(matchStandardCondition('Terrified')).toEqual({ id: 'frightened', detail: '' });
    // Exhaustion written with its cause, as a condition's name takes a detail.
    expect(matchStandardCondition('Exhausted (forced march)')).toEqual({ id: 'exhaustion', detail: 'forced march' });
    expect(matchStandardCondition('Exhausted from the climb')).toEqual({ id: 'exhaustion', detail: 'from the climb' });
    expect(matchStandardCondition('Exhaustion 2')).toEqual({ id: 'exhaustion', detail: '2' });
  });

  it("keeps a name with a condition's word inside it as homebrew; normalizeConditionId still spots the word", () => {
    const named: [string, string][] = [
      ['Protection from Poison', 'poisoned'],
      ['See Invisibility', 'invisible'],
      ['Mark of the Invisible Hand', 'invisible'],
      ['Sleeping Curse', 'unconscious'],
      ['Blindness Ward', 'blinded'],
      ["KO'd", 'unconscious'],
    ];
    for (const [name, word] of named) {
      expect(matchStandardCondition(name)).toBeNull();
      expect(normalizeConditionId(name)).toBe(word);
    }
  });
});

describe('conditionName', () => {
  it('names standard and homebrew conditions', () => {
    expect(conditionName('poisoned')).toBe('Poisoned');
    expect(conditionName('UNCONSCIOUS')).toBe('Unconscious');
    expect(conditionName('dazed')).toBe('Dazed');
    expect(conditionName('Hexed by Morgra')).toBe('Hexed by Morgra');
    expect(conditionName('covered-in-oil')).toBe('Covered in oil');
  });
});

describe('conditionDetails (SRD 5.2.1 srd:rule:condition: various rules define how a condition ends)', () => {
  it('gives the duration, then the source, and nothing for a condition set without them', () => {
    expect(conditionDetails({ id: 'frightened', duration: 'until the end of your next turn', source: 'Ghost' })).toBe(
      ' (until the end of your next turn; Ghost)',
    );
    expect(conditionDetails({ id: 'restrained', duration: 'until freed' })).toBe(' (until freed)');
    expect(conditionDetails({ id: 'Hexed', source: 'Morgra' })).toBe(' (Morgra)');
    expect(conditionDetails({ id: 'prone' })).toBe('');
    expect(conditionDetails({ id: 'poisoned', duration: '  ', source: '' })).toBe('');
  });

  it('leaves Exhaustion to its level', () => {
    expect(conditionDetails({ id: 'exhaustion', level: 2, source: 'the forced march' })).toBe('');
  });

  it('keeps each part on one line, cut near 60 characters at a word end and never inside an emoji', () => {
    expect(conditionDetails({ id: 'charmed', source: 'the hag\n\nMorgra' })).toBe(' (the hag Morgra)');
    const long = conditionDetails({
      id: 'Cursed',
      duration: 'until the drowned bell in the lighthouse tolls three times at midnight',
      source: 'the hag Morgra and her shell charm that sings a drowned 🐉 song at dusk',
    });
    expect(long).toBe(' (until the drowned bell in the lighthouse tolls three times…; the hag Morgra and her shell charm that sings a drowned 🐉…)');
    const dragons = conditionDetails({ id: 'Dazzled', source: '🐉'.repeat(40) });
    expect(dragons).toBe(` (${'🐉'.repeat(29)}…)`);
    expect(dragons).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});
