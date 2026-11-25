/**
 * Sheet spells from the builder's spell options (knownSpell): the rules-index entry's id, level and flags, a book's
 * ref, and a homebrew spell's entry id as `homebrewId`, which the hero's sheet tags "homebrew" so the DM's prompt
 * snapshot and get_character_sheet don't list it like an SRD spell. The real engine; the abridged SRD spell fixture
 * plus invented homebrew and book spells only.
 */
import { describe, expect, it } from 'vitest';
import { characterSheetText } from '@/engine';
import { HOMEBREW_SOURCE_ID, type CompendiumEntry, type HomebrewEntry } from '@/types';
import { buildCharacter, emptyDraft, type BuilderContext, type BuilderDraft } from './logic';
import { knownSpell, spellInfo } from './spells';
import { builderFixture, spellFixture } from './testing/builderFixture';

/** A spell the player saved in the Library, with the summary in the Homebrew dialog's hint format. */
const homebrewSpell = (id: string, name: string, level: number, campaignId: string | null): HomebrewEntry => ({
  id,
  sourceId: HOMEBREW_SOURCE_ID,
  sourceName: 'Homebrew',
  kind: 'spell',
  name,
  summary: level ? `Level ${level} Evocation (Wizard)` : 'Evocation Cantrip (Wizard)',
  text: `${name}: an invented spell.`,
  campaignId,
  origin: 'player',
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
});

const HOMEBREW = [
  homebrewSpell('hb:ember-spark', 'Ember Spark', 0, 'camp-1'),
  homebrewSpell('hb:cinder-veil', 'Cinder Veil', 1, 'camp-1'),
  homebrewSpell('hb:lantern-ward', 'Lantern Ward', 1, null),
];
const data = builderFixture();
const srdSpells = spellFixture().map(spellInfo);
const spells = [...spellFixture(), ...HOMEBREW].map(spellInfo);
const ctx: BuilderContext = { data, spells };
const spell = (name: string) => spells.find((s) => s.name === name)!;
const ids = (...names: string[]) => names.map((name) => spell(name).id);

/** A complete High Elf Sage wizard (as logic.test.ts builds one), with the spells given. */
function wizardDraft(patch: Partial<BuilderDraft> = {}): BuilderDraft {
  return {
    ...emptyDraft(),
    classId: data.classes.find((c) => c.name === 'Wizard')!.id,
    backgroundId: data.backgrounds.find((b) => b.name === 'Sage')!.id,
    bonusPlus2: 'int',
    bonusPlus1: 'wis',
    speciesId: data.species.find((s) => s.name === 'Elf')!.id,
    lineage: 'High Elf',
    lineageAbility: 'int',
    speciesSkill: 'perception',
    abilityMethod: 'standard',
    assignment: { int: 0, wis: 1, con: 2, dex: 3, cha: 4, str: 5 },
    classSkills: ['investigation', 'insight'],
    languages: ['Elvish', 'Draconic'],
    classEquipment: 0,
    backgroundEquipment: 0,
    cantrips: ids('Fire Bolt', 'Light', 'Mage Hand'),
    spellbook: ids('Magic Missile', 'Shield', 'Sleep', 'Detect Magic', 'Feather Fall', 'Mage Armor'),
    prepared: ids('Magic Missile', 'Shield', 'Sleep', 'Detect Magic'),
    magicInitiate: { Wizard: { ability: 'int', cantrips: ids('Ray of Frost', 'Dancing Lights'), spell: spell('Thunderwave').id } },
    name: 'Mira Voss',
    ...patch,
  };
}

describe('knownSpell', () => {
  it("gives a homebrew spell its entry's id as homebrewId", () => {
    const veil = spell('Cinder Veil');
    expect(knownSpell(veil, veil, { source: 'Wizard' })).toEqual({
      id: 'hb:cinder-veil',
      name: 'Cinder Veil',
      level: 1,
      prepared: true,
      homebrewId: 'hb:cinder-veil',
      source: 'Wizard',
    });
  });

  it("gives an SRD spell, a book's spell and a name the index doesn't hold no homebrewId", () => {
    const missile = spell('Magic Missile');
    expect(knownSpell(missile, missile)).toEqual({ id: missile.id, name: 'Magic Missile', level: 1, prepared: true });
    const book: CompendiumEntry = { id: 'lib:ember:3', sourceId: 'ember', sourceName: 'The Ember Folio', kind: 'spell', name: 'Glimmer Thread', summary: 'Level 1 Illusion (Wizard)', text: 'Invented.' };
    const thread = knownSpell(spellInfo(book), { name: 'Glimmer Thread', level: 1 });
    expect(thread).toMatchObject({ id: 'lib:ember:3', ref: { entryId: 'lib:ember:3', kind: 'spell', textCopied: false } });
    expect(thread).not.toHaveProperty('homebrewId');
    expect(knownSpell(undefined, { name: 'Lost Hymn', level: 1 })).not.toHaveProperty('homebrewId');
  });
});

describe('a homebrew spell chosen in the builder', () => {
  const draft = wizardDraft({
    cantrips: ids('Ember Spark', 'Light', 'Mage Hand'),
    spellbook: ids('Cinder Veil', 'Magic Missile', 'Shield', 'Sleep', 'Detect Magic', 'Feather Fall'),
    prepared: ids('Cinder Veil', 'Magic Missile', 'Shield', 'Sleep'),
    magicInitiate: { Wizard: { ability: 'int', cantrips: ids('Ray of Frost', 'Dancing Lights'), spell: spell('Lantern Ward').id } },
  });
  const hero = buildCharacter(draft, ctx, { campaignId: 'camp-1' });
  const known = (name: string) => hero.spellcasting?.spells.find((s) => s.name === name);

  it("carries its entry's id as homebrewId, as a cantrip, from the spellbook and through Magic Initiate", () => {
    expect(known('Ember Spark')).toMatchObject({ id: 'hb:ember-spark', homebrewId: 'hb:ember-spark', source: 'Wizard' });
    expect(known('Cinder Veil')).toMatchObject({ id: 'hb:cinder-veil', homebrewId: 'hb:cinder-veil', prepared: true });
    expect(known('Lantern Ward')).toMatchObject({ id: 'hb:lantern-ward', homebrewId: 'hb:lantern-ward', alwaysPrepared: true, source: 'Magic Initiate (Wizard)' });
    // The SRD spells beside them carry none.
    expect(hero.spellcasting?.spells.filter((s) => s.homebrewId).map((s) => s.name)).toEqual(['Ember Spark', 'Cinder Veil', 'Lantern Ward']);
  });

  it('is tagged "homebrew" on the sheet text the DM reads, and the SRD spells are not', () => {
    const lines = characterSheetText(hero).split('\n');
    expect(lines).toContain(
      '- Cantrips: Dancing Lights (C, Magic Initiate (Wizard)), Ember Spark (homebrew), Light, Mage Hand, Prestidigitation (High Elf), Ray of Frost (Magic Initiate (Wizard))',
    );
    expect(lines).toContain(
      '- Level 1: Cinder Veil (homebrew), Detect Magic (R, C, not prepared), Feather Fall (not prepared), Lantern Ward (always prepared, Magic Initiate (Wizard), homebrew), Magic Missile, Shield, Sleep (C)',
    );
  });

  it('leaves an SRD-only hero exactly as before: no homebrewId and no tag', () => {
    const srdHero = buildCharacter(wizardDraft(), { data, spells: srdSpells }, { campaignId: 'camp-1' });
    expect(srdHero.spellcasting?.spells.length).toBeGreaterThan(0);
    expect(srdHero.spellcasting?.spells.some((s) => 'homebrewId' in s)).toBe(false);
    expect(characterSheetText(srdHero)).not.toContain('homebrew');
  });
});
