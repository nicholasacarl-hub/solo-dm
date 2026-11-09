/**
 * Port identity (spec §3.9, §8.2): the TS ports equal scripts/build-srd.mjs's exported helpers on shared
 * strings (the script runs main() only when invoked directly). The unexported ones (parseSpeeds,
 * CR_LINE) are covered by the SRD parity test, and their older-format extensions here.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- the build script is plain JavaScript without type declarations; this test compares behavior only.
import * as script from '../../../../scripts/build-srd.mjs';
import { slugify } from '@/lib/id';
import {
  boldBullets,
  parseCostGp,
  parseCrLine,
  parseMagicItemSubtitle,
  parseSpeeds,
  parseTables,
  parseWeightLb,
  proficiencyBonusForCr,
  splitTopLevel,
} from './srdRulesEntity';

describe('port identity with scripts/build-srd.mjs', () => {
  it('splitTopLevel', () => {
    for (const s of ['Finesse, Light, Thrown (Range 20/60)', 'a, (b, c), d', '', 'Versatile (1d10)', 'x;y;(z;w)']) {
      expect(splitTopLevel(s)).toEqual(script.splitTopLevel(s));
      expect(splitTopLevel(s, ';')).toEqual(script.splitTopLevel(s, ';'));
    }
  });

  it('parseTables and boldBullets', () => {
    const md = '| A | B |\n|---|:-:|\n| 1 | 2 |\n| 3 | 4 |\n\ntext\n\n| X |\n|---|\n\n- **AC** 17\n- **Casting Time:** Action\n- **Speed:** 30 ft.';
    expect(parseTables(md)).toEqual(script.parseTables(md));
    expect([...boldBullets(md)]).toEqual([...script.boldBullets(md)]);
  });

  it('slugify (the app id helper matches the script)', () => {
    for (const s of ['Fire Bolt', "Moth's Grace", 'Ænima — Ünder', '  -x- ', 'Antipathy/Sympathy']) expect(slugify(s)).toBe(script.slugify(s));
  });

  it('parseMagicItemSubtitle on SRD lines', () => {
    for (const s of [
      '_Armor (Chain Mail), Rare (Requires Attunement)_',
      '_Wondrous Item, Uncommon_',
      '_Weapon (Any Sword), Uncommon (+1), Rare (+2), or Very Rare (+3)_',
      '_Ring, Rare (Requires Attunement by a Wizard)_',
      '_Armor (Any Medium or Heavy, Except Hide Armor), Uncommon_',
      '_Wondrous Item, Rarity Varies (Requires Attunement)_',
    ]) {
      expect(parseMagicItemSubtitle(s)).toEqual(script.parseMagicItemSubtitle(s));
    }
  });

  it('parseCostGp, parseWeightLb and proficiencyBonusForCr', () => {
    for (const s of ['1 SP', '1,500 GP', 'Varies', '5 cp', '2.5 GP', undefined]) expect(parseCostGp(s)).toBe(script.parseCostGp(s));
    for (const s of ['2 lb.', '1/4 lb.', '58 1/2 lb.', '—', '1,000 lb.']) expect(parseWeightLb(s)).toBe(script.parseWeightLb(s));
    for (const cr of [0, 0.125, 1, 4, 5, 8, 9, 12, 13, 16, 17, 20, 21, 24, 25, 28, 29, 30]) expect(proficiencyBonusForCr(cr)).toBe(script.proficiencyBonusForCr(cr));
  });
});

describe('older-format extensions (SRD 5.2.1 "Monsters": CR, XP and proficiency bonus)', () => {
  it('parseCrLine reads the 2024 and the older CR lines', () => {
    expect(parseCrLine('3 (XP 700; PB +2)')).toEqual({ cr: '3', crValue: 3, xp: 700, pb: 2 });
    expect(parseCrLine('10 (XP 5,900, or 7,200 in lair; PB +4)')).toEqual({ cr: '10', crValue: 10, xp: 5900, xpInLair: 7200, pb: 4 });
    expect(parseCrLine('1 (200 XP)')).toEqual({ cr: '1', crValue: 1, xp: 200 });
    expect(parseCrLine('1/4 (50 XP)')).toEqual({ cr: '1/4', crValue: 0.25, xp: 50 });
    expect(parseCrLine('1/2')).toEqual({ cr: '1/2', crValue: 0.5, xp: 100 });
    expect(parseCrLine('none')).toBeNull();
  });

  it('parseSpeeds reads lowercase older speeds and hover', () => {
    expect(parseSpeeds('30 ft., Fly 60 ft. (hover)')).toEqual({ walk: 30, fly: 60, hover: true });
    expect(parseSpeeds('40 ft., fly 80 ft., swim 40 ft.')).toEqual({ walk: 40, fly: 80, swim: 40 });
    expect(parseSpeeds('0 ft., Fly 30 ft. (hover)')).toEqual({ walk: 0, fly: 30, hover: true });
  });

  it('parseMagicItemSubtitle reads a lowercase older type line', () => {
    expect(parseMagicItemSubtitle('Armor (plate), rare (requires attunement by a wizard)')).toMatchObject({
      category: 'armor', baseItem: 'plate', rarity: 'rare', attunement: 'by a wizard',
    });
  });
});
