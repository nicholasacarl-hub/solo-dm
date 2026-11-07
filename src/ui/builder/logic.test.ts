/**
 * Character-builder rules (SRD 5.2.1 "Creating a Character"; Character Origins; Equipment).
 * The engine is replaced by a small fake so these tests only exercise the builder's own logic.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rng } from '@/engine';
import type { AbilityScores } from '@/types';
import { builderFixture, spellFixture } from './testing/builderFixture';
import { clearRolls, queueRolls } from './testing/fakeEngine';
import {
  POINT_BUY_BUDGET,
  adjustPointBuy,
  applyBonuses,
  assignScore,
  attacksForInventory,
  backgroundBonuses,
  buildCharacter,
  canAdjustPointBuy,
  classChoiceFeatures,
  emptyDraft,
  expertiseCount,
  featureChoiceOptions,
  findEquipment,
  firstIncompleteStep,
  gearFromPackages,
  inferFeatureUses,
  isWeaponProficient,
  lineageEffects,
  optionGrants,
  pointBuyCost,
  pointBuyRemaining,
  pointBuySpent,
  previewStats,
  recommendedAssignment,
  recommendedBonuses,
  rollAbilityScores,
  selectBackground,
  selectClass,
  speciesChoices,
  spellInfo,
  spellPlan,
  validateAbilities,
  validateStep,
  type BuilderContext,
  type BuilderDraft,
} from './logic';
import { letDmBuildAll, letDmDecide } from './autofill';
import { rollDice } from '@/engine';

vi.mock('@/engine', async () => (await import('./testing/fakeEngine')).fakeEngine);

const data = builderFixture();
const spells = spellFixture().map(spellInfo);
const ctx: BuilderContext = { data, spells };
const fixedRng: Rng = { next: () => 0 };

const cls = (name: string) => data.classes.find((c) => c.name === name)!;
const bg = (name: string) => data.backgrounds.find((b) => b.name === name)!;
const species = (name: string) => data.species.find((s) => s.name === name)!;
const spellId = (name: string) => spells.find((s) => s.name === name)!.id;
const eight: AbilityScores = { str: 8, dex: 8, con: 8, int: 8, wis: 8, cha: 8 };

function wizardDraft(): BuilderDraft {
  return {
    ...emptyDraft(),
    classId: cls('Wizard').id,
    backgroundId: bg('Sage').id,
    bonusPlus2: 'int',
    bonusPlus1: 'wis',
    speciesId: species('Elf').id,
    lineage: 'High Elf',
    lineageAbility: 'int',
    speciesSkill: 'perception',
    abilityMethod: 'standard',
    // 15, 14, 13, 12, 10, 8 -> INT 15, WIS 14, CON 13, DEX 12, CHA 10, STR 8
    assignment: { int: 0, wis: 1, con: 2, dex: 3, cha: 4, str: 5 },
    classSkills: ['investigation', 'insight'],
    languages: ['Elvish', 'Draconic'],
    classEquipment: 0,
    backgroundEquipment: 0,
    cantrips: [spellId('Fire Bolt'), spellId('Light'), spellId('Mage Hand')],
    spellbook: ['Magic Missile', 'Shield', 'Sleep', 'Detect Magic', 'Feather Fall', 'Mage Armor'].map(spellId),
    prepared: ['Magic Missile', 'Shield', 'Sleep', 'Detect Magic'].map(spellId),
    magicInitiate: {
      Wizard: { ability: 'int', cantrips: [spellId('Ray of Frost'), spellId('Dancing Lights')], spell: spellId('Thunderwave') },
    },
    name: 'Mira Voss',
  };
}

function fighterDraft(): BuilderDraft {
  return {
    ...emptyDraft(),
    classId: cls('Fighter').id,
    fightingStyle: 'Defense',
    backgroundId: bg('Soldier').id,
    bonusPlus2: 'str',
    bonusPlus1: 'con',
    speciesId: species('Dwarf').id,
    assignment: { str: 0, dex: 1, con: 2, cha: 3, wis: 4, int: 5 },
    classSkills: ['perception', 'survival'],
    languages: ['Dwarvish', 'Giant'],
    classEquipment: 0,
    backgroundEquipment: 0,
    weaponMasteries: ['Greatsword', 'Javelin', 'Flail'],
    name: 'Brakka Stonehew',
  };
}

beforeEach(() => clearRolls());

describe('point buy (SRD 5.2.1 Ability Score Point Costs)', () => {
  it('uses the SRD cost table', () => {
    expect([8, 9, 10, 11, 12, 13, 14, 15].map(pointBuyCost)).toEqual([0, 1, 2, 3, 4, 5, 7, 9]);
    expect(pointBuyCost(16)).toBeNull();
    expect(pointBuyCost(7)).toBeNull();
  });

  it('counts the standard array as a full 27-point buy', () => {
    const scores = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 };
    expect(pointBuySpent(scores)).toBe(POINT_BUY_BUDGET);
    expect(pointBuyRemaining(scores)).toBe(0);
  });

  it('keeps scores between 8 and 15 and within the budget', () => {
    expect(canAdjustPointBuy(eight, 'str', -1)).toBe(false);
    const fifteen = { ...eight, str: 15 };
    expect(canAdjustPointBuy(fifteen, 'str', 1)).toBe(false);
    const spentOut = { str: 15, dex: 15, con: 15, int: 8, wis: 8, cha: 8 };
    expect(pointBuyRemaining(spentOut)).toBe(0);
    expect(canAdjustPointBuy(spentOut, 'int', 1)).toBe(false);
    expect(adjustPointBuy(spentOut, 'int', 1)).toBe(spentOut);
    expect(adjustPointBuy(eight, 'wis', 1).wis).toBe(9);
  });
});

describe('assigning generated scores', () => {
  it('swaps when a number is already used by another ability', () => {
    const assignment = assignScore({ str: 0, dex: 1 }, 'dex', 0);
    expect(assignment).toEqual({ str: 1, dex: 0 });
  });

  it('moves a number to an unassigned ability without duplicating it', () => {
    expect(assignScore({ str: 0 }, 'dex', 0)).toEqual({ dex: 0 });
  });

  it('recommends the SRD standard-array placement for a class', () => {
    const pool = [15, 14, 13, 12, 10, 8];
    const assignment = recommendedAssignment(cls('Wizard'), pool);
    const scores = Object.fromEntries(Object.entries(assignment).map(([a, i]) => [a, pool[i!]]));
    expect(scores).toEqual({ str: 8, dex: 12, con: 13, int: 15, wis: 14, cha: 10 });
  });

  it('rolls 4d6 and drops the lowest die, six times', () => {
    queueRolls(...Array.from({ length: 6 }, () => [6, 1, 4, 5]).flat());
    const rolls = rollAbilityScores((e) => rollDice(e));
    expect(rolls).toHaveLength(6);
    expect(rolls[0]).toEqual({ total: 15, dice: [6, 1, 4, 5], droppedIndex: 1 });
  });
});

describe('background ability score increases', () => {
  const sage = bg('Sage');

  it('applies +2 / +1 only to the background abilities', () => {
    expect(backgroundBonuses({ bonusMode: 'two-one', bonusPlus2: 'int', bonusPlus1: 'wis' }, sage)).toEqual({ int: 2, wis: 1 });
    expect(backgroundBonuses({ bonusMode: 'two-one', bonusPlus2: 'str', bonusPlus1: 'wis' }, sage)).toEqual({ wis: 1 });
  });

  it('applies +1 to all three in the +1/+1/+1 mode', () => {
    expect(backgroundBonuses({ bonusMode: 'one-one-one', bonusPlus2: null, bonusPlus1: null }, sage)).toEqual({ con: 1, int: 1, wis: 1 });
  });

  it('never raises a score above 20', () => {
    expect(applyBonuses({ ...eight, int: 19 }, { int: 2 }).int).toBe(20);
  });

  it('recommends +2 to the class priority ability', () => {
    expect(recommendedBonuses(cls('Wizard'), sage)).toEqual({ bonusMode: 'two-one', bonusPlus2: 'int', bonusPlus1: 'wis' });
  });

  it('requires two different abilities for +2/+1', () => {
    const draft = { ...wizardDraft(), bonusPlus1: 'int' as const };
    expect(validateAbilities(draft, sage)).toContain('Choose a different ability for the +1 increase.');
    expect(validateAbilities(wizardDraft(), sage)).toEqual([]);
  });
});

describe('class data', () => {
  it('parses "choose one of the following" options', () => {
    const options = featureChoiceOptions(cls('Cleric').features[1].description);
    expect(options?.map((o) => o.name)).toEqual(['Protector', 'Thaumaturge']);
    expect(classChoiceFeatures(cls('Fighter'))).toEqual([]);
  });

  it('does not take rules headings for options when the sentence offers no choice (SRD Rage)', () => {
    const rage = [
      'You can enter your Rage the number of times shown for your Barbarian level in the Rages column of the Barbarian Features table.',
      '_**Damage Resistance.**_ You have Resistance to Bludgeoning, Piercing, and Slashing damage.',
      '_**Strength Advantage.**_ You have Advantage on Strength checks and Strength saving throws.',
      '_**Duration.**_ The Rage lasts until the end of your next turn. If your Rage is still active on your next turn, you can extend the Rage for another round by doing one of the following:',
      '- Make an attack roll against an enemy.\n- Take a Bonus Action to extend your Rage.',
    ].join('\n\n');
    expect(featureChoiceOptions(rage)).toBeNull();
    // Only the headed block right after the choice sentence counts.
    const choice = '_**Note.**_ Read this first.\n\nYou gain one of the following options of your choice.\n\n_**A.**_ First.\n\n_**B.**_ Second.\n\nAfterwards you rest.\n\n_**Rule.**_ Not an option.';
    expect(featureChoiceOptions(choice)?.map((o) => o.name)).toEqual(['A', 'B']);
  });

  it('reads skill bonuses from chosen options (Thaumaturge, Magician)', () => {
    const magician =
      'You know one extra cantrip from the Druid spell list. In addition, your mystical connection to nature gives you a bonus to your Intelligence (Arcana or Nature) checks. The bonus equals your Wisdom modifier (minimum bonus of +1).';
    expect(optionGrants(magician)).toMatchObject({ extraCantrips: 1, skillBonus: { skills: ['arcana', 'nature'], ability: 'wis', minimum: 1 } });
    expect(optionGrants('Trained for battle, you gain proficiency with Martial weapons.').skillBonus).toBeNull();
  });

  it('reads Expertise and spell counts', () => {
    expect(expertiseCount(cls('Rogue'))).toBe(2);
    expect(spellPlan(wizardDraft(), data)).toMatchObject({ casting: true, cantrips: 3, prepared: 4, spellbook: 6 });
  });

  it('adds the Thaumaturge extra cantrip', () => {
    const draft = { ...emptyDraft(), classId: cls('Cleric').id, classOptions: { 'Divine Order': 'Thaumaturge' } };
    expect(spellPlan(draft, data).cantrips).toBe(4);
  });
});

describe('species choices', () => {
  it('offers Human size, skill and Origin feat choices', () => {
    const choices = speciesChoices(species('Human'));
    expect(choices.sizes).toEqual(['Medium', 'Small']);
    expect(choices.skill).toEqual({ from: 'any', trait: 'Skillful' });
    expect(choices.originFeat).toEqual({ trait: 'Versatile' });
  });

  it('offers elven lineages with a spellcasting ability and Keen Senses skills', () => {
    const choices = speciesChoices(species('Elf'));
    expect(choices.lineages.map((l) => l.name)).toEqual(['Drow', 'High Elf', 'Wood Elf']);
    expect(choices.lineageNeedsAbility).toBe(true);
    expect(choices.skill?.from).toEqual(['insight', 'perception', 'survival']);
  });

  it('reads lineage speed, darkvision and cantrips', () => {
    expect(lineageEffects('Your Speed increases to 35 feet. You also know the Druidcraft cantrip.')).toMatchObject({ speed: 35, cantrips: ['Druidcraft'] });
    expect(lineageEffects('The range of your Darkvision increases to 120 feet.').darkvision).toBe(120);
    expect(lineageEffects('You know the _Mending_ and _Prestidigitation_ cantrips.').cantrips).toEqual(['Mending', 'Prestidigitation']);
  });
});

describe('feature uses', () => {
  const usesCtx = { level: 1, proficiencyBonus: 2, scores: { ...eight, cha: 16 } };

  it('reads uses from the level table column, with the column as its scale', () => {
    const def = cls('Fighter').features[1];
    expect(inferFeatureUses(def.name, def.description, { ...usesCtx, cls: cls('Fighter') })).toEqual({
      max: 2,
      used: 0,
      recharge: 'long',
      scale: { by: 'table', className: 'Fighter', values: [2, 2, 2, 3] },
    });
    // A name an older builder decorated still finds its column.
    expect(inferFeatureUses('Second Wind (Duration)', def.description, { ...usesCtx, level: 4, cls: cls('Fighter') })?.max).toBe(3);
  });

  it('reads uses from a use count in the name (SRD "Action Surge (one use)")', () => {
    const text = 'Once you use this feature, you can’t do so again until you finish a Short or Long Rest. Starting at level 17, you can use it twice before a rest but only once on a turn.';
    expect(inferFeatureUses('Action Surge (one use)', text, { ...usesCtx, level: 2 })).toEqual({ max: 1, used: 0, recharge: 'short' });
    expect(inferFeatureUses('Action Surge (two uses)', text, { ...usesCtx, level: 17 })?.max).toBe(2);
  });

  it('reads Proficiency Bonus and ability-modifier uses', () => {
    const breath = species('Dragonborn').traits[1];
    expect(inferFeatureUses(breath.name, breath.description, usesCtx)).toEqual({ max: 2, used: 0, recharge: 'long', scale: { by: 'proficiency-bonus' } });
    const bardic = 'You can confer a Bardic Inspiration die a number of times equal to your Charisma modifier (minimum of once), and you regain all expended uses when you finish a Long Rest.';
    expect(inferFeatureUses('Bardic Inspiration', bardic, usesCtx)?.max).toBe(3);
  });

  it('handles short-rest recharge, pools and later-level traits', () => {
    const adrenaline = 'You can use this trait a number of times equal to your Proficiency Bonus, and you regain all expended uses when you finish a Short or Long Rest.';
    expect(inferFeatureUses('Adrenaline Rush', adrenaline, usesCtx)?.recharge).toBe('short');
    const layOnHands = 'With that pool, you can restore a total number of Hit Points equal to five times your Paladin level.';
    expect(inferFeatureUses('Lay On Hands', layOnHands, usesCtx)).toMatchObject({ max: 5, scale: { by: 'class-level', className: 'Paladin', multiplier: 5 } });
    expect(inferFeatureUses('Lay On Hands', layOnHands, { ...usesCtx, level: 2 })?.max).toBe(10);
    expect(inferFeatureUses('Draconic Flight', species('Dragonborn').traits[4].description, usesCtx)).toBeUndefined();
    expect(inferFeatureUses('Elven Lineage', species('Elf').traits[1].description, usesCtx)).toBeUndefined();
  });
});

describe('equipment → inventory and attacks', () => {
  const catalog = data.equipment;

  it('matches package names to the catalog', () => {
    expect(findEquipment('Daggers', catalog)?.option.name).toBe('Dagger');
    expect(findEquipment('Arcane Focus (Quarterstaff)', catalog)).toMatchObject({ via: 'parenthetical', base: 'Arcane Focus' });
    expect(findEquipment('Book (prayers)', catalog)?.option.name).toBe('Book');
    expect(findEquipment('Lute', catalog)).toBeNull();
  });

  it('stacks duplicates, equips trained armor and adds up the coins', () => {
    const gear = gearFromPackages([cls('Fighter').startingEquipment[0], bg('Soldier').equipment[0]], catalog, {
      armorTraining: cls('Fighter').armorTraining,
    });
    expect(gear.gp).toBe(18);
    const chainMail = gear.items.find((i) => i.name === 'Chain Mail');
    expect(chainMail).toMatchObject({ category: 'armor', equipped: true, weight: 55, compendiumId: 'srd:item:chain-mail' });
    expect(gear.items.find((i) => i.name === 'Javelin')?.quantity).toBe(8);
    expect(gear.items.find((i) => i.name === "Dungeoneer's Pack")?.category).toBe('gear');
  });

  it('does not equip armor the character is not trained with', () => {
    const gear = gearFromPackages([cls('Cleric').startingEquipment[0]], catalog, { armorTraining: [] });
    expect(gear.items.find((i) => i.name === 'Chain Shirt')?.equipped).toBeUndefined();
  });

  it('names focus weapons and builds weapon attacks', () => {
    const gear = gearFromPackages([cls('Wizard').startingEquipment[0]], catalog, { armorTraining: [] });
    expect(gear.items.map((i) => i.name)).toContain('Quarterstaff (arcane focus)');
    const attacks = attacksForInventory(gear.items, catalog, { weaponProficiencies: ['Simple weapons'], masteries: [] });
    expect(attacks.map((a) => a.name)).toEqual(['Dagger', 'Quarterstaff', 'Unarmed Strike']);
    expect(attacks[0]).toMatchObject({ ability: 'finesse', proficient: true, damage: '1d4', damageType: 'piercing', range: '5 ft. or 20/60 ft. thrown' });
    expect(attacks[0].mastery).toBeUndefined();
    expect(attacks[1].notes).toBe('Versatile: 1d8 two-handed');
  });

  it('uses DEX for ranged weapons and records masteries', () => {
    const gear = gearFromPackages([cls('Fighter').startingEquipment[1]], catalog, { armorTraining: cls('Fighter').armorTraining });
    const attacks = attacksForInventory(gear.items, catalog, { weaponProficiencies: cls('Fighter').weaponProficiencies, masteries: ['Longbow'] });
    expect(attacks.find((a) => a.name === 'Longbow')).toMatchObject({ ability: 'dex', range: '150/600 ft.', mastery: 'Slow' });
    expect(attacks.find((a) => a.name === 'Scimitar')).toMatchObject({ ability: 'finesse', mastery: undefined });
  });

  it('checks limited martial proficiencies (Rogue)', () => {
    const profs = cls('Rogue').weaponProficiencies;
    const byName = (n: string) => catalog.find((o) => o.name === n)!;
    expect(isWeaponProficient(byName('Shortsword'), profs)).toBe(true);
    expect(isWeaponProficient(byName('Rapier'), profs)).toBe(true);
    expect(isWeaponProficient(byName('Longsword'), profs)).toBe(false);
    expect(isWeaponProficient(byName('Mace'), profs)).toBe(true);
  });
});

describe('building a level 1 character', () => {
  it('builds a High Elf Sage wizard', () => {
    const c = buildCharacter(wizardDraft(), ctx, { campaignId: 'camp-1' });
    expect(c.classes).toEqual([{ classId: 'srd:class:wizard', name: 'Wizard', level: 1, hitDie: 6, casterType: 'full', spellcastingAbility: 'int' }]);
    expect(c.abilityScores).toEqual({ str: 8, dex: 12, con: 13, int: 17, wis: 15, cha: 10 });
    // HP at level 1 = hit die maximum + CON modifier.
    expect(c.hp).toEqual({ max: 7, current: 7, temp: 0 });
    expect(c.hitDice).toEqual([{ die: 6, total: 1, spent: 0 }]);
    expect(c.species).toBe('Elf (High Elf lineage)');
    expect(c.skills).toEqual({ arcana: 1, history: 1, perception: 1, investigation: 1, insight: 1 });
    expect(c.languages).toEqual(['Common', 'Elvish', 'Draconic']);
    expect(c.tools).toEqual(["Calligrapher's Supplies"]);
    expect(c.armorClass).toBe(11);
    expect(c.currency.gp).toBe(13);
    const spellsByName = Object.fromEntries((c.spellcasting?.spells ?? []).map((s) => [s.name, s]));
    expect(Object.keys(spellsByName)).toEqual(
      expect.arrayContaining(['Fire Bolt', 'Light', 'Mage Hand', 'Ray of Frost', 'Dancing Lights', 'Thunderwave', 'Prestidigitation', 'Mage Armor']),
    );
    expect(spellsByName['Mage Armor'].prepared).toBe(false);
    expect(spellsByName['Thunderwave']).toMatchObject({ alwaysPrepared: true, source: 'Magic Initiate (Wizard)' });
    expect(spellsByName['Prestidigitation']).toMatchObject({ source: 'High Elf', notes: 'Spellcasting ability: Intelligence' });
    expect(spellsByName['Detect Magic']).toMatchObject({ ritual: true, concentration: true });
    expect(c.spellcasting?.ability).toBe('int');
    expect(c.spellcasting?.slots[1]).toEqual({ max: 2, used: 0 });
    expect(c.attacks.map((a) => a.name)).toEqual(['Dagger', 'Quarterstaff', 'Unarmed Strike', 'Fire Bolt', 'Ray of Frost']);
    const features = Object.fromEntries(c.features.map((f) => [f.name, f]));
    expect(features['Arcane Recovery'].uses).toEqual({ max: 1, used: 0, recharge: 'long' });
    expect(features['Magic Initiate (Wizard)']).toMatchObject({ source: 'feat', sourceName: 'Sage (Origin feat)', uses: { max: 1 } });
    expect(features['Elven Lineage (High Elf)'].source).toBe('species');
    expect(features['Keen Senses (Perception)']).toBeDefined();
  });

  it('builds a Dwarf Soldier fighter in chain mail with Defense', () => {
    const c = buildCharacter(fighterDraft(), ctx, { campaignId: 'camp-1', id: 'char-keep' });
    expect(c.id).toBe('char-keep');
    // 10 (d10) + CON 15 (+2) + Dwarven Toughness 1
    expect(c.hp.max).toBe(13);
    expect(c.armorClass).toBe(17);
    expect(c.acFormula).toContain('Defense 1');
    expect(c.weaponMasteries).toEqual(['Greatsword', 'Javelin', 'Flail']);
    expect(c.attacks.find((a) => a.name === 'Greatsword')).toMatchObject({ ability: 'str', proficient: true, mastery: 'Graze' });
    expect(c.features.find((f) => f.name === 'Second Wind')?.uses).toEqual({
      max: 2,
      used: 0,
      recharge: 'long',
      scale: { by: 'table', className: 'Fighter', values: [2, 2, 2, 3] },
    });
    expect(c.features.find((f) => f.name === 'Defense')?.sourceName).toBe('Fighting Style (Fighter 1)');
    expect(c.features.find((f) => f.name === 'Stonecunning')?.uses).toEqual({ max: 2, used: 0, recharge: 'long', scale: { by: 'proficiency-bonus' } });
    expect(c.darkvision).toBe(120);
    expect(c.spellcasting).toBeUndefined();
    // Dwarven Resilience (SRD 5.2.1 Dwarf): Resistance to Poison damage.
    expect(c.damageResistances).toEqual(['poison']);
    expect(c.skillBonuses).toBeUndefined();
  });

  it('records the Dragonborn ancestry’s damage type as a Resistance', () => {
    const draft: BuilderDraft = { ...fighterDraft(), speciesId: species('Dragonborn').id, lineage: 'Silver' };
    const c = buildCharacter(draft, ctx, { campaignId: 'camp-1' });
    expect(c.damageResistances).toEqual(['cold']);
    // The lineage feature holds only the chosen ancestry.
    const ancestry = c.features.find((f) => f.name === 'Draconic Ancestry (Silver)');
    expect(ancestry?.description).toBe('Your lineage stems from a dragon progenitor. Choose the kind of dragon from the table.\n\n**Silver.** Cold');
  });

  it('gives a Thaumaturge Cleric WIS (min +1) on Arcana and Religion checks', () => {
    const draft: BuilderDraft = {
      ...fighterDraft(),
      classId: cls('Cleric').id,
      fightingStyle: null,
      classOptions: { 'Divine Order': 'Thaumaturge' },
      weaponMasteries: [],
    };
    const c = buildCharacter(draft, ctx, { campaignId: 'camp-1' });
    expect(c.skillBonuses).toEqual([{ skills: ['arcana', 'religion'], ability: 'wis', minimum: 1, source: 'Thaumaturge (Divine Order)' }]);
    expect(c.features.map((f) => f.name)).toContain('Divine Order (Thaumaturge)');
  });

  it('marks scaling cantrip attacks and the Monk’s Unarmed Strike', () => {
    const c = buildCharacter(wizardDraft(), ctx, { campaignId: 'camp-1' });
    // Fire Bolt's Cantrip Upgrade multiplies its dice; the engine scales 'cantrip' attacks by level.
    expect(c.attacks.find((a) => a.name === 'Fire Bolt')).toMatchObject({ damage: '1d10', scaling: 'cantrip', notes: 'Cantrip' });
    expect(c.attacks.find((a) => a.name === 'Unarmed Strike')?.scaling).toBeUndefined();
    expect(attacksForInventory([], data.equipment, { weaponProficiencies: [], masteries: [], martialArts: true, martialArtsDie: '1d6' })).toEqual([
      expect.objectContaining({ name: 'Unarmed Strike', ability: 'finesse', damage: '1d6', scaling: 'martial-arts' }),
    ]);
  });

  it('applies Protector training and the Alert initiative bonus', () => {
    const draft: BuilderDraft = {
      ...fighterDraft(),
      classId: cls('Cleric').id,
      classOptions: { 'Divine Order': 'Protector' },
      backgroundId: bg('Criminal').id,
      bonusPlus2: 'dex',
      bonusPlus1: 'con',
      weaponMasteries: [],
    };
    const c = buildCharacter(draft, ctx, { campaignId: 'camp-1' });
    expect(c.weaponProficiencies).toEqual(['Simple weapons', 'Martial weapons']);
    expect(c.armorTraining).toContain('Heavy armor');
    expect(c.initiativeBonusExtra).toBe(2);
    const stats = previewStats(c);
    // DEX 16 (+3) plus the Proficiency Bonus from Alert.
    expect(stats.initiative).toBe(3 + 2);
    expect(stats.spell).toEqual({ ability: 'wis', saveDc: 8 + 2 + 0, attackBonus: 2 });
  });

  it('gives Humans starting Heroic Inspiration (Resourceful)', () => {
    const draft = { ...fighterDraft(), speciesId: species('Human').id, size: 'Small' as const, speciesSkill: 'stealth' as const, speciesFeat: 'srd:feat:alert' };
    const c = buildCharacter(draft, ctx, { campaignId: 'camp-1' });
    expect(c.heroicInspiration).toBe(true);
    expect(c.size).toBe('Small');
    expect(c.skills.stealth).toBe(1);
    expect(c.features.map((f) => f.name)).toEqual(expect.arrayContaining(['Alert', 'Versatile (Alert)', 'Skillful (Stealth)']));
  });

  it('computes the preview from the engine', () => {
    const stats = previewStats(buildCharacter(wizardDraft(), ctx, { campaignId: 'camp-1' }));
    expect(stats).toMatchObject({ proficiencyBonus: 2, hp: 7, ac: 11, initiative: 1, passivePerception: 14 });
    expect(stats.abilities.find((a) => a.ability === 'int')).toEqual({ ability: 'int', score: 17, modifier: 3, save: 5, saveProficient: true });
    expect(stats.spell).toEqual({ ability: 'int', saveDc: 13, attackBonus: 5 });
    expect(stats.attacks.find((a) => a.name === 'Fire Bolt')).toMatchObject({ bonus: 5, damage: '1d10' });
  });
});

describe('step validation', () => {
  it('passes a complete draft', () => {
    expect(validateStep('review', wizardDraft(), ctx)).toEqual([]);
    expect(firstIncompleteStep(fighterDraft(), ctx)).toBeNull();
  });

  it('requires a Fighting Style and a Divine Order', () => {
    expect(validateStep('class', { ...fighterDraft(), fightingStyle: null }, ctx)).toEqual(['Choose a Fighting Style.']);
    expect(validateStep('class', { ...emptyDraft(), classId: cls('Cleric').id }, ctx)).toEqual(['Choose your Divine Order.']);
  });

  it('flags class skills that the background already grants', () => {
    const draft: BuilderDraft = {
      ...fighterDraft(),
      classId: cls('Rogue').id,
      fightingStyle: null,
      backgroundId: bg('Criminal').id,
      classSkills: ['stealth', 'acrobatics', 'perception', 'insight'],
      expertise: ['acrobatics', 'perception'],
      languages: ['Dwarvish', 'Giant', 'Elvish'],
    };
    expect(validateStep('skills', draft, ctx)).toEqual(['Stealth is already granted by your origin — choose a replacement.']);
  });

  it('requires the extra Rogue language and Expertise picks', () => {
    const draft: BuilderDraft = {
      ...fighterDraft(),
      classId: cls('Rogue').id,
      backgroundId: bg('Criminal').id,
      classSkills: ['acrobatics', 'perception', 'insight', 'deception'],
      expertise: ['history'],
    };
    expect(validateStep('skills', draft, ctx)).toEqual([
      "Expertise needs a skill you're proficient in (History).",
      'Choose 2 skills for Expertise (1 chosen).',
      'Choose 3 languages besides Common (2 chosen).',
    ]);
  });

  it('checks equipment, masteries, spells and the name', () => {
    expect(validateStep('equipment', { ...fighterDraft(), classEquipment: null, weaponMasteries: ['Greatsword'] }, ctx)).toEqual([
      'Choose your class starting equipment (or the gold).',
      'Choose 3 weapons for Weapon Mastery (1 chosen).',
    ]);
    expect(validateStep('spells', { ...wizardDraft(), cantrips: [] }, ctx)).toEqual(['Choose 3 cantrips (0 chosen).']);
    expect(validateStep('spells', { ...wizardDraft(), prepared: [spellId('Mage Armor')] }, ctx)).toEqual([
      'Prepare 4 spells from your spellbook (1 prepared).',
    ]);
    expect(validateStep('details', { ...wizardDraft(), name: '  ' }, ctx)).toEqual(['Give your character a name.']);
  });

  it('skips spell validation when the spell list is unavailable', () => {
    expect(validateStep('spells', { ...wizardDraft(), cantrips: [] }, { data, spells: [] })).toEqual([]);
  });

  it('resets class-dependent choices when the class changes', () => {
    const changed = selectClass(fighterDraft(), cls('Rogue').id);
    expect(changed).toMatchObject({ classSkills: [], weaponMasteries: [], classEquipment: null, fightingStyle: null });
    expect(selectBackground(changed, bg('Sage').id)).toMatchObject({ bonusPlus2: null, backgroundEquipment: null });
  });
});

describe('Let the DM decide', () => {
  it('builds a complete, valid character from an empty draft', () => {
    const draft = letDmBuildAll(emptyDraft(), ctx, fixedRng);
    expect(draft.step).toBe('review');
    expect(firstIncompleteStep(draft, ctx)).toBeNull();
    const c = buildCharacter(draft, ctx, { campaignId: 'camp-1' });
    expect(c.name).not.toBe('');
    expect(c.classes).toHaveLength(1);
  });

  it('keeps the player’s valid choices', () => {
    const start = { ...emptyDraft(), classId: cls('Wizard').id, name: 'Quill' };
    const draft = letDmBuildAll(start, ctx, fixedRng);
    expect(draft.classId).toBe(cls('Wizard').id);
    expect(draft.name).toBe('Quill');
    // The wizard gets the SRD-recommended cantrips first.
    expect(draft.cantrips.map((id) => spells.find((s) => s.id === id)?.name)).toEqual(['Light', 'Mage Hand', 'Ray of Frost']);
    expect(draft.bonusPlus2).toBe('int');
  });

  it('re-decides a single step', () => {
    const draft = letDmDecide('abilities', { ...wizardDraft(), assignment: {} }, ctx, fixedRng);
    expect(validateStep('abilities', draft, ctx)).toEqual([]);
    expect(buildCharacter(draft, ctx, { campaignId: 'c' }).abilityScores.int).toBe(17);
  });

  it('fills a point-buy spread that spends exactly 27 points', () => {
    const draft = letDmDecide('abilities', { ...wizardDraft(), abilityMethod: 'point-buy' }, ctx, fixedRng);
    expect(pointBuySpent(draft.pointBuy)).toBe(27);
    expect(draft.pointBuy.int).toBe(15);
  });
});
