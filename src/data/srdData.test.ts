/**
 * Sanity checks of the generated SRD files in public/srd/ (scripts/build-srd.mjs) and of the
 * rules index built over them.
 */
import { describe, expect, it } from 'vitest';
import builderRaw from '../../public/srd/builder.json?raw';
import compendiumRaw from '../../public/srd/compendium.json?raw';
import manifestRaw from '../../public/srd/manifest.json?raw';
import { ABILITIES, CONTENT_KINDS, SKILLS, type BuilderData, type CompendiumEntry } from '@/types';
import { SRD_ATTRIBUTION } from './index';
import { createRulesIndex } from './search';
import { isCompendiumEntry, type SrdManifest } from './srd';

const builder = JSON.parse(builderRaw) as BuilderData;
const compendium = JSON.parse(compendiumRaw) as CompendiumEntry[];
const manifest = JSON.parse(manifestRaw) as SrdManifest;
const byId = new Map(compendium.map((e) => [e.id, e]));
const cls = (name: string) => {
  const found = builder.classes.find((c) => c.name === name);
  if (!found) throw new Error(`no class ${name}`);
  return found;
};

describe('public/srd/builder.json', () => {
  it('has all 12 classes with complete 20-level tables', () => {
    expect(builder.classes.map((c) => c.name)).toEqual([
      'Barbarian', 'Bard', 'Cleric', 'Druid', 'Fighter', 'Monk', 'Paladin', 'Ranger', 'Rogue', 'Sorcerer', 'Warlock', 'Wizard',
    ]);
    for (const c of builder.classes) {
      expect(c.levelTable).toHaveLength(20);
      c.levelTable.forEach((row, i) => {
        expect(row.level).toBe(i + 1);
        expect(row.proficiencyBonus).toBe(Math.ceil((i + 1) / 4) + 1);
      });
      expect([6, 8, 10, 12]).toContain(c.hitDie);
      expect(c.savingThrows).toHaveLength(2);
      for (const a of [...c.savingThrows, ...c.primaryAbilities]) expect(ABILITIES).toContain(a);
      expect(c.skillChoices.count).toBeGreaterThanOrEqual(2);
      for (const s of c.skillChoices.from) expect(SKILLS).toContain(s);
      expect(c.startingEquipment.length).toBeGreaterThanOrEqual(2);
      expect(c.startingEquipment.at(-1)?.items).toEqual([]);
      expect(c.subclassLevel).toBe(3);
      expect(c.subclasses).toHaveLength(1);
      expect(c.subclasses[0].features.length).toBeGreaterThan(2);
      expect(c.features.filter((f) => f.level === 1).length).toBeGreaterThan(0);
      for (const f of c.features) {
        expect(f.description.length).toBeGreaterThan(20);
        // Short form for sheets and prompts (an extra field beyond ClassFeatureDef).
        const summary = (f as { summary?: string }).summary ?? '';
        expect(summary.length).toBeGreaterThan(20);
        expect(summary.length).toBeLessThanOrEqual(301);
        expect(f.description.startsWith(summary.slice(0, 20))).toBe(true);
      }
      expect(c.casterType === 'none').toBe(c.spellcastingAbility === undefined);
    }
  });

  it('matches the SRD class text where Open5e is wrong or incomplete', () => {
    expect(cls('Fighter').savingThrows).toEqual(['str', 'con']);
    expect(cls('Monk').savingThrows).toEqual(['str', 'dex']);
    expect(cls('Druid').levelTable[1].wildShape).toBe(2);
    expect(cls('Monk').levelTable[1].unarmoredMovement).toBe('+10 ft.');
  });

  it('has spell slots, pact magic and class columns', () => {
    const wizard = cls('Wizard');
    expect(wizard).toMatchObject({ hitDie: 6, savingThrows: ['int', 'wis'], casterType: 'full', spellcastingAbility: 'int' });
    expect(wizard.levelTable[0]).toMatchObject({ cantrips: 3, preparedSpells: 4, slot1: 2, slot2: 0 });
    expect(wizard.levelTable[19]).toMatchObject({ slot9: 1, slot7: 2 });
    expect(cls('Warlock').levelTable[10]).toMatchObject({ pactSlots: 3, pactSlotLevel: 5 });
    expect(cls('Warlock').spellcastingAbility).toBe('cha');
    expect(cls('Paladin').casterType).toBe('half');
    expect(cls('Barbarian').levelTable[0]).toMatchObject({ rages: 2, rageDamage: 2, weaponMastery: 2 });
    expect(cls('Rogue').levelTable[19].sneakAttack).toBe('10d6');
  });

  it('parses proficiencies, weapon mastery and starting equipment', () => {
    const fighter = cls('Fighter');
    expect(fighter.armorTraining).toEqual(['Light armor', 'Medium armor', 'Heavy armor', 'Shields']);
    expect(fighter.weaponProficiencies).toEqual(['Simple weapons', 'Martial weapons']);
    expect(fighter.weaponMasteryCount).toBe(3);
    expect(fighter.startingEquipment).toHaveLength(3);
    expect(fighter.startingEquipment[0]).toEqual({
      label: 'Option A',
      items: [
        { name: 'Chain Mail', quantity: 1 },
        { name: 'Greatsword', quantity: 1 },
        { name: 'Flail', quantity: 1 },
        { name: 'Javelin', quantity: 8 },
        { name: "Dungeoneer's Pack", quantity: 1 },
      ],
      gp: 4,
    });
    expect(cls('Rogue').weaponProficiencies).toEqual(['Simple weapons', 'Martial weapons that have the Finesse or Light property']);
    expect(cls('Rogue').tools).toEqual(["Thieves' Tools"]);
    expect(cls('Paladin').weaponMasteryCount).toBe(2);
    expect(cls('Wizard').weaponMasteryCount).toBe(0);
    expect(cls('Bard').skillChoices).toEqual({ count: 3, from: [...SKILLS] });
    expect(cls('Wizard').skillChoices.from).toContain('insight');
  });

  it('keeps choice options in feature descriptions', () => {
    const divineOrder = cls('Cleric').features.find((f) => f.name === 'Divine Order');
    expect(divineOrder?.description).toMatch(/_\*\*Protector\.\*\*_/);
    expect(cls('Wizard').features.find((f) => f.name === 'Spellcasting')?.description).toMatch(/starts with six level 1 Wizard spells/);
  });

  it('has 9 species with their lineages', () => {
    expect(builder.species).toHaveLength(9);
    const lineages = Object.fromEntries(builder.species.map((s) => [s.name, s.lineages?.map((l) => l.name) ?? []]));
    expect(lineages.Elf).toEqual(['Drow', 'High Elf', 'Wood Elf']);
    expect(lineages.Dragonborn).toHaveLength(10);
    expect(lineages.Gnome).toEqual(['Forest Gnome', 'Rock Gnome']);
    expect(lineages.Goliath).toEqual(['Cloud Giant', 'Fire Giant', 'Frost Giant', 'Hill Giant', 'Stone Giant', 'Storm Giant']);
    expect(lineages.Tiefling).toEqual(['Abyssal', 'Chthonic', 'Infernal']);
    const human = builder.species.find((s) => s.name === 'Human');
    expect(human?.sizes).toEqual(['Medium', 'Small']);
    expect(builder.species.find((s) => s.name === 'Dwarf')?.darkvision).toBe(120);
    expect(builder.species.find((s) => s.name === 'Goliath')?.speed).toBe(35);
  });

  it('has 4 backgrounds and 17 feats', () => {
    expect(builder.backgrounds.map((b) => [b.name, b.feat, b.abilityScores.length, b.skills.length, b.equipment.length])).toEqual([
      ['Acolyte', 'Magic Initiate (Cleric)', 3, 2, 2],
      ['Criminal', 'Alert', 3, 2, 2],
      ['Sage', 'Magic Initiate (Wizard)', 3, 2, 2],
      ['Soldier', 'Savage Attacker', 3, 2, 2],
    ]);
    const categories = builder.feats.reduce<Record<string, number>>((acc, f) => ({ ...acc, [f.category]: (acc[f.category] ?? 0) + 1 }), {});
    expect(categories).toEqual({ origin: 4, general: 2, 'fighting-style': 4, 'epic-boon': 7 });
  });

  it('has the weapons, armor and gear the builder needs', () => {
    const of = (category: string) => builder.equipment.filter((e) => e.category === category);
    expect(of('weapon')).toHaveLength(38);
    for (const w of of('weapon')) expect(w.damage && w.damageType && w.mastery).toBeTruthy();
    expect(of('armor')).toHaveLength(12);
    expect(of('shield')).toHaveLength(1);
    expect(of('pack')).toHaveLength(7);
    expect(builder.equipment.find((e) => e.name === 'Chain Mail')).toMatchObject({ armorClass: 16, dexCap: 0, strengthRequirement: 13, stealthDisadvantage: true });
    expect(builder.equipment.find((e) => e.name === 'Longbow')?.properties).toContain('Ammunition (Range 150/600; Arrow)');
    expect(new Set(builder.equipment.map((e) => e.id)).size).toBe(builder.equipment.length);
  });
});

describe('public/srd/compendium.json', () => {
  it('contains every SRD 5.2.1 entry exactly once, well formed', () => {
    expect(compendium.every(isCompendiumEntry)).toBe(true);
    expect(byId.size).toBe(compendium.length);
    for (const e of compendium) {
      expect(e.id.startsWith(`srd:${e.kind}:`)).toBe(true);
      expect(e.sourceId).toBe('srd-5.2.1');
      expect(CONTENT_KINDS).toContain(e.kind);
    }
    expect(manifest.counts).toMatchObject({ spell: 339, monster: 330, 'magic-item': 258, condition: 15, class: 12, species: 9, background: 4, feat: 17 });
    const counts: Record<string, number> = {};
    for (const e of compendium) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    expect(counts).toEqual(manifest.counts);
  });

  it('links every builder option to a compendium entry', () => {
    const ids = [
      ...builder.classes.flatMap((c) => [c.id, ...c.subclasses.map((s) => s.id)]),
      ...builder.species.map((s) => s.id),
      ...builder.backgrounds.map((b) => b.id),
      ...builder.feats.map((f) => f.id),
    ];
    for (const id of ids) expect(byId.has(id)).toBe(true);
  });

  it('carries the structured spell and monster fields', () => {
    expect(byId.get('srd:spell:fireball')).toMatchObject({
      summary: 'Level 3 Evocation · Sorcerer, Wizard',
      data: { level: 3, school: 'Evocation', classes: ['Sorcerer', 'Wizard'], saveAbility: 'dex', damage: '8d6', concentration: false },
    });
    expect(byId.get('srd:spell:detect-magic')?.data).toMatchObject({ ritual: true, concentration: true, castingTime: 'Action' });
    expect(byId.get('srd:monster:goblin-warrior')).toMatchObject({
      summary: 'CR 1/4 (50 XP) · Small Fey',
      data: { cr: '1/4', xp: 50, size: 'Small', type: 'Fey', ac: 15, hp: 10, hitDice: '3d6', initiative: 2 },
    });
    expect(byId.get('srd:magic-item:bag-of-holding')?.summary).toBe('Wondrous Item, uncommon');
    expect(byId.get('srd:condition:grappled')?.path).toEqual(['Rules Glossary', 'Grappled']);
  });

  it('includes the magic items added in SRD 5.2.1', () => {
    for (const slug of ['cloak-of-invisibility', 'hat-of-many-spells', 'potion-of-longevity', 'sending-stones', 'thunderous-greatclub']) {
      expect(byId.has(`srd:magic-item:${slug}`)).toBe(true);
    }
  });
});

describe('public/srd/manifest.json', () => {
  it('carries the exact attribution and the pinned sources', () => {
    expect(manifest.version).toBe('5.2.1');
    expect(manifest.attribution).toBe(SRD_ATTRIBUTION);
    expect(manifest.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(manifest.sources.map((s) => s.name)).toEqual(['your5e/5e-srd-markdown', 'open5e/open5e-api']);
    for (const s of manifest.sources) expect(s.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.modifications).toBe('Converted to JSON, split into entries, summaries added.');
  });
});

describe('rules index over the SRD', () => {
  const index = createRulesIndex(compendium);

  it('finds entries by name', () => {
    expect(index.findByName('Fireball')?.id).toBe('srd:spell:fireball');
    expect(index.findByName('goblin warrior')?.kind).toBe('monster');
    expect(index.findByName('Opportunity Attacks')?.id).toBe('srd:rule:opportunity-attacks');
    expect(index.findByName('Shield', { kind: 'item' })?.id).toBe('srd:item:shield');
    expect(index.findByName('Blinded')?.kind).toBe('condition');
  });

  it('answers typical DM rules questions', () => {
    const top = (q: string, n = 3) => index.search(q, { limit: n }).map((h) => h.entry.name);
    expect(top('opportunity attack')).toContain('Opportunity Attacks');
    expect(top('grapple')).toEqual(expect.arrayContaining(['Grappling']));
    expect(top('death saving throw')).toContain('Death Saving Throw');
    expect(index.search('fireball', { kinds: ['spell'] })[0].entry.name).toBe('Fireball');
    expect(index.search('prone', { kinds: ['condition'] })[0].entry.name).toBe('Prone');
  });

  it('resolves builder variant ids to their base item', () => {
    const variant = builder.equipment.find((e) => e.name === 'Arcane Focus (Crystal)');
    expect(variant?.id).toBe('srd:item:arcane-focus:crystal');
    expect(index.get(variant?.id ?? '')?.name).toBe('Arcane Focus');
    for (const option of builder.equipment) expect(index.get(option.id)).toBeDefined();
  });
});
