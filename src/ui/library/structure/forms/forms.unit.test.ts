import { describe, expect, it } from 'vitest';
import { EXPECTED_DATA, structuredRecord } from '@/test/structuredFixtures';
import type { ItemData, MonsterData, RecordWarning, StructuredRecord, SubclassData } from '@/types';
import { mergeWarnings } from '../warnings';
import { checkedPaths, dataPathsFor, wireFieldsFor } from './fieldMap';
import { crNumber, draftOf, emptyData, issuesOf, itemDescription, pbForCr, recordFromDraft, speedLine, withDerived } from './draft';
import { groupOfPath, groupsFor, labelForPath } from './formSpecs';
import { getPath, isNamed, setPath } from './paths';

const drake = EXPECTED_DATA['Glimmerwing Drake'] as MonsterData;

describe('paths', () => {
  it('reads and writes dotted paths without touching the original', () => {
    const next = setPath(drake, 'speeds.fly', 80);
    expect(getPath(next, 'speeds.fly')).toBe(80);
    expect(drake.speeds.fly).toBe(60);
    expect(next.speeds.walk).toBe(30);
    expect('acNote' in setPath(drake, 'acNote', undefined)).toBe(false);
    expect(setPath({ list: ['a', 'b'] }, 'list.1', 'c')).toEqual({ list: ['a', 'c'] });
  });

  it('names a field, its parent or its parts', () => {
    const checks = new Set(['speeds', 'features.1.text']);
    expect(isNamed(checks, 'speeds.walk')).toBe(true);
    expect(isNamed(checks, 'features')).toBe(true);
    expect(isNamed(checks, 'features.1.text')).toBe(true);
    expect(isNamed(checks, 'hp')).toBe(false);
  });
});

describe('wire fields and form fields', () => {
  it('maps the wire field a warning names onto the inputs it filled', () => {
    expect(dataPathsFor('monster', 'hpText')).toEqual(['hp', 'hitDice']);
    expect(dataPathsFor('item', 'items[0].damageText')).toEqual(['damage', 'damageType']);
    expect(dataPathsFor('monster', 'hp')).toEqual(['hp']);
    expect(dataPathsFor('monster', undefined)).toEqual([]);
    expect(checkedPaths('monster', ['hpText', 'acText'])).toEqual(new Set(['hp', 'hitDice', 'ac', 'acNote']));
  });

  it('finds the excerpt to mark for a focused input', () => {
    expect(wireFieldsFor('monster', 'hp')).toContain('hpText');
    expect(wireFieldsFor('monster', 'speeds.walk')).toContain('speedText');
    expect(wireFieldsFor('magic-item', 'bonuses.ac')).toEqual(expect.arrayContaining(['acBonus', 'bonusText']));
  });

  it('labels paths and finds their group', () => {
    expect(labelForPath('monster', 'hp')).toBe('HP');
    expect(labelForPath('monster', 'speeds.walk')).toBe('Speed');
    expect(labelForPath('class', 'levelTable.3.cantrips')).toBe('Level table');
    const groups = groupsFor('monster', drake);
    expect(groupOfPath(groups, 'senses')?.id).toBe('abilities');
    expect(groupOfPath(groups, 'xp')?.id).toBe('key');
  });

  it('shows the fields that apply to a gear row', () => {
    const weapon = EXPECTED_DATA.Hookstaff as ItemData;
    const ids = (d: ItemData) => groupsFor('item', d)[0].fields.map((f) => f.label);
    expect(ids(weapon)).toContain('Damage dice');
    expect(ids(weapon)).not.toContain('Armor type');
    expect(ids({ format: '2024', category: 'armor' })).toContain('Armor type');
  });
});

describe('app-written fields', () => {
  it('writes the speed line from the speeds, walking speed first', () => {
    expect(speedLine({ walk: 30, fly: 60, hover: true })).toBe('30 ft., fly 60 ft. (hover)');
    expect(speedLine({ walk: 40 })).toBe('40 ft.');
    expect(speedLine({ swim: 40, burrow: 10 })).toBe('0 ft., burrow 10 ft., swim 40 ft.');
  });

  it('reads CR values and the proficiency bonus by CR (SRD 5.2.1, "Proficiency Bonus by CR")', () => {
    expect(crNumber('1/4')).toBe(0.25);
    expect(crNumber('3')).toBe(3);
    expect([pbForCr('1/2'), pbForCr('4'), pbForCr('5'), pbForCr('17'), pbForCr('30')]).toEqual([2, 2, 3, 6, 9]);
  });

  it("describes gear in the SRD's patterns", () => {
    expect(itemDescription(EXPECTED_DATA.Hookstaff as ItemData)).toBe('Martial Melee Weapon');
    expect(itemDescription({ format: '2024', category: 'armor', armorType: 'medium', armorClass: 12, dexCap: 2 })).toBe('Medium Armor: AC 12 + Dex modifier (max 2)');
    expect(itemDescription({ format: '2024', category: 'armor', armorType: 'light', armorClass: 11, dexCap: null })).toBe('Light Armor: AC 11 + Dex modifier');
    expect(itemDescription({ format: '2024', category: 'armor', armorType: 'heavy', armorClass: 16, dexCap: 0 })).toBe('Heavy Armor: AC 16');
    expect(itemDescription({ format: '2024', category: 'shield', armorClass: 2 })).toBe('Shield: +2 AC');
  });

  it('re-derives what follows an edit: speed line, CR value, XP and PB that matched the old CR', () => {
    const faster = withDerived('monster', drake, { ...drake, speeds: { walk: 40, fly: 60, hover: true } });
    expect(faster.speed).toBe('40 ft., fly 60 ft. (hover)');
    const tougher = withDerived('monster', drake, { ...drake, cr: '5' });
    expect(tougher).toMatchObject({ crValue: 5, xp: 1800, pb: 3 });
    const custom = withDerived('monster', { ...drake, xp: 650 }, { ...drake, xp: 650, cr: '5' });
    expect(custom.xp).toBe(650);
    const reshaped = withDerived('item', EXPECTED_DATA.Hookstaff as ItemData, { ...(EXPECTED_DATA.Hookstaff as ItemData), weaponCategory: 'simple' });
    expect(reshaped.description).toBe('Simple Melee Weapon');
  });
});

describe('drafts', () => {
  it('reports DATA_SCHEMAS problems on the field, in plain words', () => {
    expect(issuesOf('monster', drake)).toEqual({});
    expect(issuesOf('monster', { ...drake, ac: 45 })).toEqual({ ac: 'At most 40.' });
    const { hp: _hp, ...noHp } = drake;
    expect(issuesOf('monster', noHp).hp).toBe('Enter a whole number.');
    expect(issuesOf('monster', { ...drake, abilities: { ...drake.abilities, str: 31 } })['abilities.str']).toBe('At most 30.');
  });

  it('starts "Fill in yourself" from a blank of the kind, with what the player must decide left open', () => {
    expect(Object.keys(issuesOf('monster', emptyData('monster', { entryId: 'lib:gloam:1', paragraphs: 3 })))).toEqual(['type']);
    expect(Object.keys(issuesOf('spell', emptyData('spell', { entryId: 'lib:gloam:1', paragraphs: 3 }))).sort()).toEqual(['duration', 'range']);
    expect(issuesOf('feat', emptyData('feat', { entryId: 'lib:gloam:1', paragraphs: 3 }))).toEqual({});
    expect(issuesOf('class', emptyData('class', { entryId: 'lib:gloam:1', paragraphs: 3 }))).toEqual({});
  });

  it('turns a saved draft into the record to store', () => {
    const record = structuredRecord('monster', 'Glimmerwing Drake', { data: drake });
    const saved = recordFromDraft({ name: '  Glimmerwing Drake  ', data: { ...drake, hp: 52 } }, record, 5);
    expect(saved).toMatchObject({ name: 'Glimmerwing Drake', edited: true, origin: 'parser', updatedAt: 5, id: record.id, publicId: record.publicId });
    const unread = structuredRecord('monster', 'Goblin Warrior');
    expect(recordFromDraft({ name: 'Goblin Warrior', data: drake }, unread, 6).origin).toBe('manual');
    const sub = structuredRecord('subclass', 'Ember Warden', { data: EXPECTED_DATA['Ember Warden'] as SubclassData, parentClassId: 'srd:class:fighter' });
    expect(recordFromDraft({ ...draftOf(sub)!, parentClassId: undefined }, sub, 7).parentClassId).toBeUndefined();
    expect(recordFromDraft({ ...draftOf(sub)!, parentClassId: 'srd:class:cleric' }, sub, 7).parentClassId).toBe('srd:class:cleric');
  });
});

describe('warnings after an edit', () => {
  const ungrounded: RecordWarning = { code: 'ungrounded', severity: 'warn', field: 'hpText', message: '"58 (8d10 + 8)" is not in the text.' };
  const clash: RecordWarning = { code: 'name-collision', severity: 'info', message: 'The SRD also has one.' };
  const refused: RecordWarning = { code: 'refused', severity: 'warn', message: 'Claude declined.' };
  const stored = [ungrounded, clash, refused];

  it("keeps a notice about a field the player didn't touch", () => {
    const after = { ...drake, ac: 18 };
    expect(mergeWarnings('monster', drake, after, stored, [])).toEqual([ungrounded, clash]);
  });

  it('drops it once that field changed, and never doubles a fresh one', () => {
    const misread = { ...drake, hp: 58 };
    expect(mergeWarnings('monster', misread, drake, stored, [])).toEqual([clash]);
    const fresh: RecordWarning = { ...ungrounded, message: 'fresh' };
    expect(mergeWarnings('monster', drake, drake, stored, [fresh])).toEqual([fresh, clash]);
  });

  it('keeps nothing field-bound for a record the player filled in from nothing', () => {
    expect(mergeWarnings('monster', null, drake, stored as StructuredRecord['warnings'], [])).toEqual([clash]);
  });
});
