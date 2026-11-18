// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { slugify as appSlugify } from '../src/lib/id.ts';
import {
  applyTextFixes,
  buildSrd,
  compactTables,
  groundedOpen5e,
  naturalName,
  parseArmorTraining,
  parseCostGp,
  parseEquipmentChoices,
  parseMagicItemSubtitle,
  parseSections,
  parseSkillChoices,
  parseTables,
  parseWeaponProficiencies,
  parseWeightLb,
  proficiencyBonusForCr,
  renderSubtree,
  ruleSections,
  slugify,
  spellOwnSection,
  titleCase,
} from './build-srd.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quietReport = { warn: () => {} };

describe('ids and names', () => {
  it('slugifies exactly like the app', () => {
    for (const name of ["Alchemist's Fire", 'Antipathy/Sympathy', "Will-o'-Wisp", 'Weapon, +1, +2, or +3', "Thieves' Tools", 'Ring of X-ray Vision']) {
      expect(slugify(name)).toBe(appSlugify(name));
    }
    expect(slugify('Antipathy/Sympathy')).toBe('antipathy-sympathy');
  });

  it('restores natural word order and title case', () => {
    expect(naturalName("Clothes, Traveler's")).toBe("Traveler's Clothes");
    expect(naturalName('Weapon (Any Simple)')).toBe('Weapon (Any Simple)');
    expect(titleCase('sprig of mistletoe')).toBe('Sprig of Mistletoe');
    expect(titleCase('three-dragon ante')).toBe('Three-Dragon Ante');
  });

  it('fixes the known PDF conversion slips', () => {
    expect(applyTextFixes('Choose 2: Arcana, History, In sight, Na ture, or Persua sion')).toBe('Choose 2: Arcana, History, Insight, Nature, or Persuasion');
    expect(applyTextFixes('you can throw the wwizareapon')).toBe('you can throw the weapon');
  });
});

describe('markdown helpers', () => {
  it('compacts and parses tables', () => {
    const md = '| Name   |  Cost |\n|--------|------:|\n| Rope   | 1 GP  |';
    expect(compactTables(md)).toBe('| Name | Cost |\n|---|---:|\n| Rope | 1 GP |');
    expect(parseTables(md)).toEqual([{ header: ['Name', 'Cost'], rows: [['Rope', '1 GP']] }]);
  });

  it('renders a section with re-leveled subsections', () => {
    const root = parseSections('# Combat\nIntro.\n## Cover\nWalls.\n#### Deep\nDeeper.');
    expect(renderSubtree(root.children[0])).toBe('Intro.\n\n### Cover\n\nWalls.\n\n#### Deep\n\nDeeper.');
  });

  it('keeps small sections whole and splits large ones', () => {
    const root = parseSections(`# Combat\nIntro text for combat.\n## Cover\n${'Walls. '.repeat(20)}\n## Reach\nLong arms.`);
    const whole = ruleSections(root.children[0], ['Playing the Game']);
    expect(whole.map((s) => s.name)).toEqual(['Combat']);
    const split = ruleSections(root.children[0], ['Playing the Game'], 50);
    expect(split.map((s) => s.path)).toEqual([
      ['Playing the Game', 'Combat'],
      ['Playing the Game', 'Combat', 'Cover'],
      ['Playing the Game', 'Combat', 'Reach'],
    ]);
  });
});

describe('parsers', () => {
  it('converts costs and weights', () => {
    expect(parseCostGp('1 SP')).toBe(0.1);
    expect(parseCostGp('5 CP')).toBe(0.05);
    expect(parseCostGp('1,500 GP')).toBe(1500);
    expect(parseCostGp('Varies')).toBeUndefined();
    expect(parseWeightLb('1/4 lb.')).toBe(0.25);
    expect(parseWeightLb('58 1/2 lb.')).toBe(58.5);
    expect(parseWeightLb('5 lb. (full)')).toBe(5);
    expect(parseWeightLb('—')).toBeUndefined();
  });

  it('parses starting-equipment choices', () => {
    const known = new Set(['dagger', 'javelin', 'arrow', 'pouch']);
    const text =
      'Choose A, B, or C: (A) Chain Mail, 8 Javelins, Book (occult lore), Parchment (10 sheets), and 4 GP; (B) 20 Arrows, 2 Pouches, Gaming Set (same as above), Musical Instrument of your choice, and 11 GP; or (C) 155 GP';
    expect(parseEquipmentChoices(text, known)).toEqual([
      {
        label: 'Option A',
        items: [
          { name: 'Chain Mail', quantity: 1 },
          { name: 'Javelin', quantity: 8 },
          { name: 'Book (occult lore)', quantity: 1 },
          { name: 'Parchment', quantity: 10 },
        ],
        gp: 4,
      },
      {
        label: 'Option B',
        items: [
          { name: 'Arrow', quantity: 20 },
          { name: 'Pouch', quantity: 2 },
          { name: 'Gaming Set', quantity: 1 },
          { name: 'Musical Instrument (of your choice)', quantity: 1 },
        ],
        gp: 11,
      },
      { label: 'Option C', items: [], gp: 155 },
    ]);
  });

  it('parses class proficiencies', () => {
    expect(parseSkillChoices('Choose 2: Arcana, History, Insight, or Religion', quietReport, 'test')).toEqual({
      count: 2,
      from: ['arcana', 'history', 'insight', 'religion'],
    });
    expect(parseSkillChoices('Choose any 3 skills (see "Playing the Game")', quietReport, 'test').count).toBe(3);
    expect(parseWeaponProficiencies('Simple and Martial weapons')).toEqual(['Simple weapons', 'Martial weapons']);
    expect(parseWeaponProficiencies('Simple weapons and Martial weapons that have the Light property')).toEqual([
      'Simple weapons',
      'Martial weapons that have the Light property',
    ]);
    expect(parseArmorTraining('Light, Medium, and Heavy armor and Shields')).toEqual(['Light armor', 'Medium armor', 'Heavy armor', 'Shields']);
    expect(parseArmorTraining('None')).toEqual([]);
  });

  it('parses magic item subtitles', () => {
    expect(parseMagicItemSubtitle('_Wondrous Item, Uncommon (Requires Attunement)_')).toMatchObject({
      category: 'wondrous-item',
      rarity: 'uncommon',
      attunement: true,
    });
    expect(parseMagicItemSubtitle('_Wand, Rare (Requires Attunement by a Spellcaster)_')).toMatchObject({ rarity: 'rare', attunement: 'by a Spellcaster' });
    expect(parseMagicItemSubtitle('_Armor (Any Light, Medium, or Heavy), Rare (+1), Very Rare (+2), or Legendary (+3)_')).toMatchObject({
      category: 'armor',
      baseItem: 'Any Light, Medium, or Heavy',
      rarity: 'varies',
      attunement: false,
    });
  });

  it('derives the proficiency bonus from CR', () => {
    expect([0, 0.25, 4, 5, 8, 9, 17, 21, 30].map(proficiencyBonusForCr)).toEqual([2, 2, 2, 3, 3, 4, 6, 7, 9]);
  });
});

describe("Open5e's spell fields", () => {
  const rec = {
    saving_throw_ability: 'constitution',
    attack_roll: true,
    damage_roll: '10d6',
    damage_types: ['cold'],
    shape_type: 'sphere',
    shape_size: 60,
    material_cost: '1500',
    material_consumed: true,
  };
  const scaling = [{ fields: { type: 'slot_level_7', damage_roll: '11d6' } }];

  it("keeps each field the spell's own text bears out", () => {
    const text =
      '- **Components:** V, S, M (a crystal worth 1,500+ GP, which the spell consumes)\n\nMake a ranged spell attack. Frost fills a ' +
      '60-foot-radius Sphere: each creature there makes a _Constitution saving throw_, taking 10d6 Cold damage on a failed save.';
    expect(groundedOpen5e('Rime Orb', text, rec, scaling, quietReport)).toEqual({
      saveAbility: 'con',
      attackRoll: true,
      damage: '10d6',
      damageTypes: ['cold'],
      area: { shape: 'sphere', size: 60 },
      materialCostGp: 1500,
      materialConsumed: true,
      damageBySlotLevel: { 7: '11d6' },
    });
  });

  it("leaves out, and reports, another spell's numbers (Freedom of Movement carried Freezing Sphere's)", () => {
    const warnings = [];
    const text = '- **Components:** V, S, M (a leather strap)\n\nYou touch a willing creature. Difficult Terrain no longer slows it.';
    const out = groundedOpen5e('Lantern Stride', text, rec, scaling, { warn: (scope, message) => warnings.push(`${scope}: ${message}`) });
    expect(out).toEqual({});
    expect(warnings).toEqual([
      'spells: Lantern Stride: Open5e damage "10d6" isn\'t in the spell\'s text; left out',
      'spells: Lantern Stride: Open5e damage type "cold" isn\'t in the spell\'s text; left out',
      'spells: Lantern Stride: Open5e save "con" isn\'t in the spell\'s text; left out',
      'spells: Lantern Stride: Open5e attack roll true isn\'t in the spell\'s text; left out',
      'spells: Lantern Stride: Open5e area {"shape":"sphere","size":60} isn\'t in the spell\'s text; left out',
      'spells: Lantern Stride: Open5e material cost 1500 isn\'t in the spell\'s text; left out',
      'spells: Lantern Stride: Open5e material consumed true isn\'t in the spell\'s text; left out',
    ]);
  });

  it('reads "a d8" as 1d8, and neither "attack rolls against you" nor an ability\'s modifier as an attack roll or a save', () => {
    const text =
      "The weapon's damage die becomes a d8, and it deals Force damage. It uses your Constitution modifier. Other creatures have " +
      'Disadvantage on attack rolls against you.';
    const fields = { damage_roll: '1d8', damage_types: ['force'], attack_roll: true, saving_throw_ability: 'constitution' };
    expect(groundedOpen5e('Oak Cudgel', text, fields, [], quietReport)).toEqual({
      damage: '1d8',
      damageTypes: ['force'],
    });
  });
});

describe("Open5e's spell fields, as the spell states them", () => {
  const fields = (text, rec) => groundedOpen5e('Lantern Ward', text, rec, [], quietReport);

  it('keeps a save the spell imposes, not one it gives Advantage on', () => {
    expect(fields('You have Advantage on Constitution saving throws.', { saving_throw_ability: 'constitution' })).toEqual({});
    expect(fields('The target must make a DC 15 Intelligence saving throw.', { saving_throw_ability: 'intelligence' })).toEqual({ saveAbility: 'int' });
    expect(fields('It makes a Strength or Dexterity saving throw (its choice).', { saving_throw_ability: 'dexterity' })).toEqual({ saveAbility: 'dex' });
  });

  it('keeps an attack roll only for a melee or ranged spell attack', () => {
    expect(fields('The target has Disadvantage on the next attack roll it makes.', { attack_roll: true })).toEqual({});
    expect(fields('Whenever you hit it with an attack roll, it takes an extra 1d6 Necrotic damage.', { attack_roll: true })).toEqual({});
    expect(fields('Make a melee spell attack against the target.', { attack_roll: true })).toEqual({ attackRoll: true });
  });

  it("keeps an area only where its size and shape are printed together, not a range's distance", () => {
    expect(fields('- **Range:** 60 feet\n\nYou touch a willing creature.', { shape_type: 'sphere', shape_size: 60 })).toEqual({});
    expect(fields('You make a Cube up to 100 feet on each side.', { shape_type: 'cube', shape_size: 100 })).toEqual({ area: { shape: 'cube', size: 100 } });
    expect(fields('A 100-foot-long, 5-foot-wide Line blasts out.', { shape_type: 'line', shape_size: 5 })).toEqual({ area: { shape: 'line', size: 5 } });
  });

  it('keeps a consumed material where the spell consumes or uses it up, by the SRD’s words for it', () => {
    expect(fields('Each time you cast this spell, you must use a different sapphire.', { material_consumed: true })).toEqual({ materialConsumed: true });
    expect(fields('When the spell ends, the container is destroyed.', { material_consumed: true })).toEqual({ materialConsumed: true });
    expect(fields('The spell ends if the replica chest is destroyed.', { material_consumed: true })).toEqual({});
  });

  it("reads a spell's own section, without a summoned creature's (Control Weather's tables stay)", () => {
    const [spell] = parseSections(
      '# Lantern Call\nYou call a spirit.\n## Lantern Spirit\n- **AC** 12\n- **HP** 20\n### Actions\nIt breathes a 15-foot Cone.\n## Gusts\n| Stage | Wind |\n|---|---|\n| 1 | Calm |',
    ).children;
    expect(spellOwnSection(spell)).toBe('You call a spirit.\n\n### Gusts\n\n| Stage | Wind |\n|---|---|\n| 1 | Calm |');
  });
});

// The full build needs the upstream sources (scripts/fetch-srd-sources.sh); CI without them skips this.
const sourcesDir = process.env.SRD_SOURCES_DIR ?? path.join(ROOT, '.srd-sources');
const haveSources = fs.existsSync(path.join(sourcesDir, 'your5e-srd-markdown')) && fs.existsSync(path.join(sourcesDir, 'open5e-api'));

describe.skipIf(!haveSources)('full build', () => {
  it('reproduces the committed public/srd files', () => {
    const result = buildSrd({ your5eDir: path.join(sourcesDir, 'your5e-srd-markdown'), open5eDir: path.join(sourcesDir, 'open5e-api') });
    const committed = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'srd', 'compendium.json'), 'utf8'));
    expect(result.compendium).toEqual(committed);
    expect(result.builder).toEqual(JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'srd', 'builder.json'), 'utf8')));
  });
});
