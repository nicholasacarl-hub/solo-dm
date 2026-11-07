/**
 * A small slice of SRD 5.2.1 builder data (CC-BY-4.0) for tests and the dev preview.
 * Descriptions are abridged; the live app loads the full data from public/srd/builder.json.
 */
import type { BuilderData, ClassOption, CompendiumEntry, EquipmentOption } from '@/types';

const spellcastingTable = (cantrips: number, prepared: number[], slots: number[][]) =>
  prepared.map((p, i) => ({
    level: i + 1,
    proficiencyBonus: 2,
    Cantrips: cantrips + (i >= 3 ? 1 : 0),
    'Prepared Spells': p,
    '1st': slots[i][0] ?? '—',
    '2nd': slots[i][1] ?? '—',
  }));

const fighter: ClassOption = {
  id: 'srd:class:fighter',
  name: 'Fighter',
  summary: 'A master of martial combat, skilled with a variety of weapons and armor.',
  hitDie: 10,
  primaryAbilities: ['str', 'dex'],
  savingThrows: ['str', 'con'],
  skillChoices: {
    count: 2,
    from: ['acrobatics', 'animal-handling', 'athletics', 'history', 'insight', 'intimidation', 'persuasion', 'perception', 'survival'],
  },
  weaponProficiencies: ['Simple weapons', 'Martial weapons'],
  armorTraining: ['Light armor', 'Medium armor', 'Heavy armor', 'Shields'],
  tools: [],
  casterType: 'none',
  weaponMasteryCount: 3,
  startingEquipment: [
    {
      label: 'Option A',
      items: [
        { name: 'Chain Mail', quantity: 1 },
        { name: 'Greatsword', quantity: 1 },
        { name: 'Flail', quantity: 1 },
        { name: 'Javelin', quantity: 8 },
        { name: "Dungeoneer's Pack", quantity: 1 },
      ],
      gp: 4,
    },
    {
      label: 'Option B',
      items: [
        { name: 'Studded Leather Armor', quantity: 1 },
        { name: 'Scimitar', quantity: 1 },
        { name: 'Shortsword', quantity: 1 },
        { name: 'Longbow', quantity: 1 },
        { name: 'Arrows', quantity: 20 },
        { name: 'Quiver', quantity: 1 },
        { name: "Dungeoneer's Pack", quantity: 1 },
      ],
      gp: 11,
    },
    { label: 'Option C', items: [], gp: 155 },
  ],
  subclassLevel: 3,
  subclasses: [
    {
      id: 'srd:subclass:champion',
      name: 'Champion',
      summary: 'Pursue physical excellence in combat.',
      features: [
        { level: 3, name: 'Improved Critical', description: 'Your attack rolls with weapons and Unarmed Strikes can score a Critical Hit on a roll of 19 or 20 on the d20.' },
        { level: 3, name: 'Remarkable Athlete', description: 'You have Advantage on Initiative rolls and Strength (Athletics) checks.' },
      ],
    },
  ],
  features: [
    { level: 1, name: 'Fighting Style', description: 'You have honed your martial prowess and gain a Fighting Style feat of your choice (see "Feats"). Defense is recommended.' },
    {
      level: 1,
      name: 'Second Wind',
      description:
        'As a Bonus Action, you can use it to regain Hit Points equal to 1d10 plus your Fighter level.\n\nYou can use this feature twice. You regain one expended use when you finish a Short Rest, and you regain all expended uses when you finish a Long Rest.',
    },
    { level: 1, name: 'Weapon Mastery', description: 'Your training with weapons allows you to use the mastery properties of three kinds of Simple or Martial weapons of your choice.' },
    { level: 2, name: 'Action Surge', description: 'You can push yourself beyond your normal limits for a moment. Once you use this feature, you can’t do so again until you finish a Short or Long Rest.' },
    { level: 2, name: 'Tactical Mind', description: 'When you fail an ability check, you can expend a use of your Second Wind to push yourself toward success.' },
    { level: 3, name: 'Fighter Subclass', description: 'You gain a Fighter subclass of your choice.' },
    { level: 4, name: 'Ability Score Improvement', description: 'You gain the Ability Score Improvement feat or another feat of your choice for which you qualify.' },
  ],
  levelTable: [1, 2, 3, 4].map((level) => ({ level, proficiencyBonus: 2, 'Second Wind': level >= 4 ? 3 : 2, 'Weapon Mastery': level >= 4 ? 4 : 3 })),
};

const wizard: ClassOption = {
  id: 'srd:class:wizard',
  name: 'Wizard',
  summary: 'A scholarly magic-user capable of manipulating the structures of reality.',
  hitDie: 6,
  primaryAbilities: ['int'],
  savingThrows: ['int', 'wis'],
  skillChoices: { count: 2, from: ['arcana', 'history', 'insight', 'investigation', 'medicine', 'nature', 'religion'] },
  weaponProficiencies: ['Simple weapons'],
  armorTraining: [],
  tools: [],
  casterType: 'full',
  spellcastingAbility: 'int',
  weaponMasteryCount: 0,
  startingEquipment: [
    {
      label: 'Option A',
      items: [
        { name: 'Dagger', quantity: 2 },
        { name: 'Arcane Focus (Quarterstaff)', quantity: 1 },
        { name: 'Robe', quantity: 1 },
        { name: 'Spellbook', quantity: 1 },
        { name: "Scholar's Pack", quantity: 1 },
      ],
      gp: 5,
    },
    { label: 'Option B', items: [], gp: 55 },
  ],
  subclassLevel: 3,
  subclasses: [
    {
      id: 'srd:subclass:evoker',
      name: 'Evoker',
      summary: 'Create explosive elemental effects.',
      features: [{ level: 3, name: 'Potent Cantrip', description: 'Your damaging cantrips affect even creatures that avoid the brunt of the effect.' }],
    },
  ],
  features: [
    {
      level: 1,
      name: 'Spellcasting',
      description:
        '_**Cantrips.**_ You know three Wizard cantrips of your choice. _Light_, _Mage Hand_, and _Ray of Frost_ are recommended.\n\n_**Spellbook.**_ The book contains the level 1+ spells you know. It starts with six level 1 Wizard spells of your choice. _Detect Magic_, _Feather Fall_, _Mage Armor_, _Magic Missile_, _Sleep_, and _Thunderwave_ are recommended.\n\n_**Prepared Spells of Level 1+.**_ To do so, choose four spells from your spellbook.',
    },
    { level: 1, name: 'Ritual Adept', description: 'You can cast any spell as a Ritual if that spell has the Ritual tag and the spell is in your spellbook.' },
    {
      level: 1,
      name: 'Arcane Recovery',
      description:
        'When you finish a Short Rest, you can choose expended spell slots to recover. Once you use this feature, you can’t do so again until you finish a Long Rest.',
    },
    { level: 2, name: 'Scholar', description: 'You have studied a particular field of knowledge.' },
    { level: 3, name: 'Wizard Subclass', description: 'You gain a Wizard subclass of your choice.' },
  ],
  levelTable: spellcastingTable(3, [4, 5, 6, 7], [[2], [3], [4, 2], [4, 3]]),
};

const rogue: ClassOption = {
  id: 'srd:class:rogue',
  name: 'Rogue',
  summary: 'A dexterous expert in stealth and subterfuge.',
  hitDie: 8,
  primaryAbilities: ['dex'],
  savingThrows: ['dex', 'int'],
  skillChoices: {
    count: 4,
    from: ['acrobatics', 'athletics', 'deception', 'insight', 'intimidation', 'investigation', 'perception', 'persuasion', 'sleight-of-hand', 'stealth'],
  },
  weaponProficiencies: ['Simple weapons', 'Martial weapons that have the Finesse or Light property'],
  armorTraining: ['Light armor'],
  tools: ["Thieves' Tools"],
  casterType: 'none',
  weaponMasteryCount: 2,
  startingEquipment: [
    {
      label: 'Option A',
      items: [
        { name: 'Leather Armor', quantity: 1 },
        { name: 'Dagger', quantity: 2 },
        { name: 'Shortsword', quantity: 1 },
        { name: 'Shortbow', quantity: 1 },
        { name: 'Arrows', quantity: 20 },
        { name: 'Quiver', quantity: 1 },
        { name: "Thieves' Tools", quantity: 1 },
        { name: "Burglar's Pack", quantity: 1 },
      ],
      gp: 8,
    },
    { label: 'Option B', items: [], gp: 100 },
  ],
  subclassLevel: 3,
  subclasses: [{ id: 'srd:subclass:thief', name: 'Thief', summary: 'Hone your skills in larceny.', features: [] }],
  features: [
    { level: 1, name: 'Expertise', description: 'You gain Expertise in two of your skill proficiencies of your choice. Sleight of Hand and Stealth are recommended if you have proficiency in them.' },
    { level: 1, name: 'Sneak Attack', description: 'Once per turn, you can deal an extra 1d6 damage to one creature you hit with an attack roll if you have Advantage on the roll.' },
    { level: 1, name: "Thieves' Cant", description: 'You know Thieves’ Cant and one other language of your choice, which you choose from the language tables in "Character Creation."' },
    { level: 1, name: 'Weapon Mastery', description: 'Your training with weapons allows you to use the mastery properties of two kinds of weapons of your choice with which you have proficiency.' },
  ],
  levelTable: [1, 2, 3, 4].map((level) => ({ level, proficiencyBonus: 2, 'Sneak Attack': `${Math.ceil(level / 2)}d6` })),
};

const cleric: ClassOption = {
  id: 'srd:class:cleric',
  name: 'Cleric',
  summary: 'A miraculous priest of divine power.',
  hitDie: 8,
  primaryAbilities: ['wis'],
  savingThrows: ['wis', 'cha'],
  skillChoices: { count: 2, from: ['history', 'insight', 'medicine', 'persuasion', 'religion'] },
  weaponProficiencies: ['Simple weapons'],
  armorTraining: ['Light armor', 'Medium armor', 'Shields'],
  tools: [],
  casterType: 'full',
  spellcastingAbility: 'wis',
  weaponMasteryCount: 0,
  startingEquipment: [
    {
      label: 'Option A',
      items: [
        { name: 'Chain Shirt', quantity: 1 },
        { name: 'Shield', quantity: 1 },
        { name: 'Mace', quantity: 1 },
        { name: 'Holy Symbol', quantity: 1 },
        { name: "Priest's Pack", quantity: 1 },
      ],
      gp: 7,
    },
    { label: 'Option B', items: [], gp: 110 },
  ],
  subclassLevel: 3,
  subclasses: [{ id: 'srd:subclass:life', name: 'Life Domain', summary: 'Soothe the hurts of the world.', features: [] }],
  features: [
    {
      level: 1,
      name: 'Spellcasting',
      description:
        '_**Cantrips.**_ You know three cantrips of your choice from the Cleric spell list. _Guidance_, _Sacred Flame_, and _Thaumaturgy_ are recommended.\n\n_**Prepared Spells of Level 1+.**_ To start, choose four level 1 spells from the Cleric spell list. _Bless_, _Cure Wounds_, _Guiding Bolt_, and _Shield of Faith_ are recommended.',
    },
    {
      level: 1,
      name: 'Divine Order',
      description:
        'You have dedicated yourself to one of the following sacred roles of your choice.\n\n_**Protector.**_ Trained for battle, you gain proficiency with Martial weapons and training with Heavy armor.\n\n_**Thaumaturge.**_ You know one extra cantrip from the Cleric spell list. In addition, your mystical connection to the divine gives you a bonus to your Intelligence (Arcana or Religion) checks. The bonus equals your Wisdom modifier (minimum of +1).',
    },
  ],
  levelTable: spellcastingTable(3, [4, 5, 6, 7], [[2], [3], [4, 2], [4, 3]]),
};

const equipment: EquipmentOption[] = [
  { id: 'srd:item:dagger', name: 'Dagger', category: 'weapon', costGp: 2, weight: 1, damage: '1d4', damageType: 'Piercing', properties: ['Finesse', 'Light', 'Thrown (Range 20/60)'], mastery: 'Nick' },
  { id: 'srd:item:quarterstaff', name: 'Quarterstaff', category: 'weapon', costGp: 0.2, weight: 4, damage: '1d6', damageType: 'Bludgeoning', properties: ['Versatile (1d8)'], mastery: 'Topple' },
  { id: 'srd:item:mace', name: 'Mace', category: 'weapon', costGp: 5, weight: 4, damage: '1d6', damageType: 'Bludgeoning', properties: [], mastery: 'Sap' },
  { id: 'srd:item:javelin', name: 'Javelin', category: 'weapon', costGp: 0.5, weight: 2, damage: '1d6', damageType: 'Piercing', properties: ['Thrown (Range 30/120)'], mastery: 'Slow' },
  { id: 'srd:item:spear', name: 'Spear', category: 'weapon', costGp: 1, weight: 3, damage: '1d6', damageType: 'Piercing', properties: ['Thrown (Range 20/60)', 'Versatile (1d8)'], mastery: 'Sap' },
  { id: 'srd:item:shortbow', name: 'Shortbow', category: 'weapon', costGp: 25, weight: 2, damage: '1d6', damageType: 'Piercing', properties: ['Ammunition (Range 80/320; Arrow)', 'Two-Handed'], mastery: 'Vex' },
  { id: 'srd:item:flail', name: 'Flail', category: 'weapon', costGp: 10, weight: 2, damage: '1d8', damageType: 'Bludgeoning', properties: [], mastery: 'Sap' },
  { id: 'srd:item:greatsword', name: 'Greatsword', category: 'weapon', costGp: 50, weight: 6, damage: '2d6', damageType: 'Slashing', properties: ['Heavy', 'Two-Handed'], mastery: 'Graze' },
  { id: 'srd:item:longsword', name: 'Longsword', category: 'weapon', costGp: 15, weight: 3, damage: '1d8', damageType: 'Slashing', properties: ['Versatile (1d10)'], mastery: 'Sap' },
  { id: 'srd:item:rapier', name: 'Rapier', category: 'weapon', costGp: 25, weight: 2, damage: '1d8', damageType: 'Piercing', properties: ['Finesse'], mastery: 'Vex' },
  { id: 'srd:item:scimitar', name: 'Scimitar', category: 'weapon', costGp: 25, weight: 3, damage: '1d6', damageType: 'Slashing', properties: ['Finesse', 'Light'], mastery: 'Nick' },
  { id: 'srd:item:shortsword', name: 'Shortsword', category: 'weapon', costGp: 10, weight: 2, damage: '1d6', damageType: 'Piercing', properties: ['Finesse', 'Light'], mastery: 'Vex' },
  { id: 'srd:item:longbow', name: 'Longbow', category: 'weapon', costGp: 50, weight: 2, damage: '1d8', damageType: 'Piercing', properties: ['Ammunition (Range 150/600; Arrow)', 'Heavy', 'Two-Handed'], mastery: 'Slow' },
  { id: 'srd:item:leather-armor', name: 'Leather Armor', category: 'armor', costGp: 10, weight: 10, armorClass: 11, dexCap: null, armorType: 'light' },
  { id: 'srd:item:studded-leather-armor', name: 'Studded Leather Armor', category: 'armor', costGp: 45, weight: 13, armorClass: 12, dexCap: null, armorType: 'light' },
  { id: 'srd:item:chain-shirt', name: 'Chain Shirt', category: 'armor', costGp: 50, weight: 20, armorClass: 13, dexCap: 2, armorType: 'medium' },
  { id: 'srd:item:chain-mail', name: 'Chain Mail', category: 'armor', costGp: 75, weight: 55, armorClass: 16, dexCap: 0, strengthRequirement: 13, stealthDisadvantage: true, armorType: 'heavy' },
  { id: 'srd:item:shield', name: 'Shield', category: 'shield', costGp: 10, weight: 6, armorClass: 2 },
  { id: 'srd:item:arrows', name: 'Arrows (20)', category: 'gear', costGp: 1, weight: 1 },
  { id: 'srd:item:quiver', name: 'Quiver', category: 'gear', costGp: 1, weight: 1 },
  { id: 'srd:item:robe', name: 'Robe', category: 'gear', costGp: 1, weight: 4 },
  { id: 'srd:item:spellbook', name: 'Spellbook', category: 'gear', costGp: 50, weight: 3 },
  { id: 'srd:item:holy-symbol', name: 'Holy Symbol', category: 'gear', costGp: 5, weight: 1 },
  { id: 'srd:item:book', name: 'Book', category: 'gear', costGp: 25, weight: 5 },
  { id: 'srd:item:parchment', name: 'Parchment', category: 'gear', costGp: 0.1 },
  { id: 'srd:item:crowbar', name: 'Crowbar', category: 'gear', costGp: 2, weight: 5 },
  { id: 'srd:item:pouch', name: 'Pouch', category: 'gear', costGp: 0.5, weight: 1 },
  { id: 'srd:item:travelers-clothes', name: "Traveler's Clothes", category: 'gear', costGp: 2, weight: 4 },
  { id: 'srd:item:healers-kit', name: "Healer's Kit", category: 'gear', costGp: 5, weight: 3 },
  { id: 'srd:item:thieves-tools', name: "Thieves' Tools", category: 'tool', costGp: 25, weight: 1 },
  { id: 'srd:item:calligraphers-supplies', name: "Calligrapher's Supplies", category: 'tool', costGp: 10, weight: 5 },
  { id: 'srd:item:gaming-set', name: 'Gaming Set', category: 'tool', costGp: 1 },
  { id: 'srd:item:dungeoneers-pack', name: "Dungeoneer's Pack", category: 'pack', costGp: 12, weight: 55, description: 'Backpack, Caltrops, Crowbar, 2 flasks of Oil, 10 days of Rations, Rope, Tinderbox, 10 Torches, Waterskin.' },
  { id: 'srd:item:scholars-pack', name: "Scholar's Pack", category: 'pack', costGp: 40, weight: 22, description: 'Backpack, Book, Ink, Ink Pen, Lamp, 10 flasks of Oil, 10 sheets of Parchment, Tinderbox.' },
  { id: 'srd:item:priests-pack', name: "Priest's Pack", category: 'pack', costGp: 33, weight: 29, description: 'Backpack, Blanket, Holy Water, Lamp, 7 days of Rations, Robe, Tinderbox.' },
  { id: 'srd:item:burglars-pack', name: "Burglar's Pack", category: 'pack', costGp: 16, weight: 42, description: 'Backpack, Ball Bearings, Bell, 10 Candles, Crowbar, Hooded Lantern, 7 flasks of Oil, 5 days of Rations, Rope, Tinderbox, Waterskin.' },
];

export function builderFixture(): BuilderData {
  return {
    classes: [cleric, fighter, rogue, wizard],
    backgrounds: [
      {
        id: 'srd:background:acolyte',
        name: 'Acolyte',
        summary: 'You devoted yourself to service in a temple.',
        abilityScores: ['int', 'wis', 'cha'],
        feat: 'Magic Initiate (Cleric)',
        skills: ['insight', 'religion'],
        tool: "Calligrapher's Supplies",
        equipment: [
          {
            label: 'Option A',
            items: [
              { name: "Calligrapher's Supplies", quantity: 1 },
              { name: 'Book (prayers)', quantity: 1 },
              { name: 'Holy Symbol', quantity: 1 },
              { name: 'Parchment (10 sheets)', quantity: 1 },
              { name: 'Robe', quantity: 1 },
            ],
            gp: 8,
          },
          { label: 'Option B', items: [], gp: 50 },
        ],
      },
      {
        id: 'srd:background:criminal',
        name: 'Criminal',
        summary: 'You eked out a living in dark alleyways.',
        abilityScores: ['dex', 'con', 'int'],
        feat: 'Alert',
        skills: ['sleight-of-hand', 'stealth'],
        tool: "Thieves' Tools",
        equipment: [
          {
            label: 'Option A',
            items: [
              { name: 'Dagger', quantity: 2 },
              { name: "Thieves' Tools", quantity: 1 },
              { name: 'Crowbar', quantity: 1 },
              { name: 'Pouch', quantity: 2 },
              { name: "Traveler's Clothes", quantity: 1 },
            ],
            gp: 16,
          },
          { label: 'Option B', items: [], gp: 50 },
        ],
      },
      {
        id: 'srd:background:sage',
        name: 'Sage',
        summary: 'You spent your formative years traveling between manors and monasteries.',
        abilityScores: ['con', 'int', 'wis'],
        feat: 'Magic Initiate (Wizard)',
        skills: ['arcana', 'history'],
        tool: "Calligrapher's Supplies",
        equipment: [
          {
            label: 'Option A',
            items: [
              { name: 'Quarterstaff', quantity: 1 },
              { name: "Calligrapher's Supplies", quantity: 1 },
              { name: 'Book (history)', quantity: 1 },
              { name: 'Parchment (8 sheets)', quantity: 1 },
              { name: 'Robe', quantity: 1 },
            ],
            gp: 8,
          },
          { label: 'Option B', items: [], gp: 50 },
        ],
      },
      {
        id: 'srd:background:soldier',
        name: 'Soldier',
        summary: 'You began training for war as soon as you reached adulthood.',
        abilityScores: ['str', 'dex', 'con'],
        feat: 'Savage Attacker',
        skills: ['athletics', 'intimidation'],
        tool: 'Gaming Set (choose one)',
        equipment: [
          {
            label: 'Option A',
            items: [
              { name: 'Spear', quantity: 1 },
              { name: 'Shortbow', quantity: 1 },
              { name: 'Arrows', quantity: 20 },
              { name: 'Gaming Set', quantity: 1 },
              { name: "Healer's Kit", quantity: 1 },
              { name: 'Quiver', quantity: 1 },
              { name: "Traveler's Clothes", quantity: 1 },
            ],
            gp: 14,
          },
          { label: 'Option B', items: [], gp: 50 },
        ],
      },
    ],
    species: [
      {
        id: 'srd:species:dragonborn',
        name: 'Dragonborn',
        summary: 'The ancestors of dragonborn hatched from the eggs of chromatic and metallic dragons.',
        creatureType: 'Humanoid',
        sizes: ['Medium'],
        speed: 30,
        darkvision: 60,
        traits: [
          { name: 'Draconic Ancestry', description: 'Your lineage stems from a dragon progenitor. Choose the kind of dragon from the table.' },
          {
            name: 'Breath Weapon',
            description:
              'Each creature in that area must make a Dexterity saving throw (DC 8 plus your Constitution modifier and Proficiency Bonus). This damage increases by 1d10 when you reach character levels 5 (2d10), 11 (3d10), and 17 (4d10).\n\nYou can use this Breath Weapon a number of times equal to your Proficiency Bonus, and you regain all expended uses when you finish a Long Rest.',
          },
          { name: 'Damage Resistance', description: 'You have Resistance to the damage type determined by your Draconic Ancestry trait.' },
          { name: 'Darkvision', description: 'You have Darkvision with a range of 60 feet.' },
          { name: 'Draconic Flight', description: 'When you reach character level 5, you can channel draconic magic to give yourself temporary flight. Once you use this trait, you can’t use it again until you finish a Long Rest.' },
        ],
        lineages: [
          { name: 'Black', description: 'Acid' },
          { name: 'Gold', description: 'Fire' },
          { name: 'Red', description: 'Fire' },
          { name: 'Silver', description: 'Cold' },
        ],
      },
      {
        id: 'srd:species:dwarf',
        name: 'Dwarf',
        summary: 'Dwarves were raised from the earth in the elder days by a deity of the forge.',
        creatureType: 'Humanoid',
        sizes: ['Medium'],
        speed: 30,
        darkvision: 120,
        traits: [
          { name: 'Darkvision', description: 'You have Darkvision with a range of 120 feet.' },
          { name: 'Dwarven Resilience', description: 'You have Resistance to Poison damage.' },
          { name: 'Dwarven Toughness', description: 'Your Hit Point maximum increases by 1, and it increases by 1 again whenever you gain a level.' },
          {
            name: 'Stonecunning',
            description:
              'As a Bonus Action, you gain Tremorsense with a range of 60 feet for 10 minutes.\n\nYou can use this Bonus Action a number of times equal to your Proficiency Bonus, and you regain all expended uses when you finish a Long Rest.',
          },
        ],
      },
      {
        id: 'srd:species:elf',
        name: 'Elf',
        summary: 'Created by the god Corellon, the first elves could change their forms at will.',
        creatureType: 'Humanoid',
        sizes: ['Medium'],
        speed: 30,
        darkvision: 60,
        traits: [
          { name: 'Darkvision', description: 'You have Darkvision with a range of 60 feet.' },
          {
            name: 'Elven Lineage',
            description:
              'You are part of a lineage that grants you supernatural abilities. Choose a lineage from the table.\n\nWhen you reach character levels 3 and 5, you learn a higher-level spell. You can cast it once without a spell slot.\n\nIntelligence, Wisdom, or Charisma is your spellcasting ability for the spells you cast with this trait (choose the ability when you select the lineage).',
          },
          { name: 'Fey Ancestry', description: 'You have Advantage on saving throws you make to avoid or end the Charmed condition.' },
          { name: 'Keen Senses', description: 'You have proficiency in the Insight, Perception, or Survival skill.' },
          { name: 'Trance', description: 'You don’t need to sleep, and magic can’t put you to sleep.' },
        ],
        lineages: [
          { name: 'Drow', description: 'The range of your Darkvision increases to 120 feet. You also know the Dancing Lights cantrip.' },
          { name: 'High Elf', description: 'You know the Prestidigitation cantrip. Whenever you finish a Long Rest, you can replace that cantrip with a different cantrip from the Wizard spell list.' },
          { name: 'Wood Elf', description: 'Your Speed increases to 35 feet. You also know the Druidcraft cantrip.' },
        ],
      },
      {
        id: 'srd:species:human',
        name: 'Human',
        summary: 'Found throughout the multiverse, humans are as varied as they are numerous.',
        creatureType: 'Humanoid',
        sizes: ['Medium', 'Small'],
        speed: 30,
        traits: [
          { name: 'Resourceful', description: 'You gain Heroic Inspiration whenever you finish a Long Rest.' },
          { name: 'Skillful', description: 'You gain proficiency in one skill of your choice.' },
          { name: 'Versatile', description: 'You gain an Origin feat of your choice (see "Feats"). Skilled is recommended.' },
        ],
      },
    ],
    feats: [
      { id: 'srd:feat:alert', name: 'Alert', category: 'origin', description: '**Initiative Proficiency.** When you roll Initiative, you can add your Proficiency Bonus to the roll.' },
      {
        id: 'srd:feat:magic-initiate',
        name: 'Magic Initiate',
        category: 'origin',
        repeatable: true,
        description:
          '**Two Cantrips.** You learn two cantrips of your choice from the Cleric, Druid, or Wizard spell list.\n\n**Level 1 Spell.** You always have that spell prepared. You can cast it once without a spell slot, and you regain the ability to cast it in that way when you finish a Long Rest.',
      },
      { id: 'srd:feat:savage-attacker', name: 'Savage Attacker', category: 'origin', description: 'Once per turn when you hit a target with a weapon, you can roll the weapon’s damage dice twice and use either roll against the target.' },
      { id: 'srd:feat:skilled', name: 'Skilled', category: 'origin', repeatable: true, description: 'You gain proficiency in any combination of three skills or tools of your choice.' },
      { id: 'srd:feat:archery', name: 'Archery', category: 'fighting-style', prerequisite: 'Fighting Style Feature', description: 'You gain a +2 bonus to attack rolls you make with Ranged weapons.' },
      { id: 'srd:feat:defense', name: 'Defense', category: 'fighting-style', prerequisite: 'Fighting Style Feature', description: 'While you’re wearing Light, Medium, or Heavy armor, you gain a +1 bonus to Armor Class.' },
      { id: 'srd:feat:great-weapon-fighting', name: 'Great Weapon Fighting', category: 'fighting-style', prerequisite: 'Fighting Style Feature', description: 'When you roll damage for an attack you make with a Melee weapon that you are holding with two hands, you can treat any 1 or 2 on a damage die as a 3.' },
      { id: 'srd:feat:ability-score-improvement', name: 'Ability Score Improvement', category: 'general', prerequisite: 'Level 4+', repeatable: true, description: 'Increase one ability score by 2, or increase two ability scores by 1.' },
    ],
    equipment,
  };
}

function spell(name: string, level: number, school: string, classes: string[], text: string, extra: Record<string, unknown> = {}): CompendiumEntry {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    id: `srd:spell:${slug}`,
    sourceId: 'srd-5.2.1',
    sourceName: 'SRD 5.2.1',
    kind: 'spell',
    name,
    summary: `${level === 0 ? `${school} Cantrip` : `Level ${level} ${school}`} (${classes.join(', ')})`,
    text,
    data: { level, school: school.toLowerCase(), classes, ...extra },
  };
}

/** Spells for tests and the dev preview (abridged SRD 5.2.1 text). */
export function spellFixture(): CompendiumEntry[] {
  return [
    spell('Fire Bolt', 0, 'Evocation', ['Sorcerer', 'Wizard'], 'You hurl a mote of fire. Make a ranged spell attack against the target. On a hit, the target takes 1d10 Fire damage.\n\n_**Cantrip Upgrade.**_ The damage increases by 1d10 when you reach levels 5 (2d10), 11 (3d10), and 17 (4d10).', { range: '120 feet' }),
    spell('Ray of Frost', 0, 'Evocation', ['Sorcerer', 'Wizard'], 'Make a ranged spell attack against the target. On a hit, it takes 1d8 Cold damage, and its Speed is reduced by 10 feet.\n\n_**Cantrip Upgrade.**_ The damage increases by 1d8 when you reach levels 5 (2d8), 11 (3d8), and 17 (4d8).', { range: '60 feet' }),
    spell('Light', 0, 'Evocation', ['Bard', 'Cleric', 'Sorcerer', 'Wizard'], 'You touch one Large or smaller object. The object sheds Bright Light in a 20-foot radius.'),
    spell('Mage Hand', 0, 'Conjuration', ['Bard', 'Sorcerer', 'Warlock', 'Wizard'], 'A spectral, floating hand appears at a point you choose within range.'),
    spell('Prestidigitation', 0, 'Transmutation', ['Bard', 'Sorcerer', 'Warlock', 'Wizard'], 'You create a magical effect within range: a harmless sensory effect.'),
    spell('Dancing Lights', 0, 'Illusion', ['Bard', 'Sorcerer', 'Wizard'], 'You create up to four torch-size lights within range.', { concentration: true }),
    spell('Druidcraft', 0, 'Transmutation', ['Druid'], 'Whispering to the spirits of nature, you create one of several effects.'),
    spell('Guidance', 0, 'Divination', ['Cleric', 'Druid'], 'You touch a willing creature and choose a skill. Until the spell ends, the creature adds 1d4 to any ability check using the chosen skill.', { concentration: true }),
    spell('Sacred Flame', 0, 'Evocation', ['Cleric'], 'Flame-like radiance descends on a creature. The target must succeed on a Dexterity saving throw or take 1d8 Radiant damage.'),
    spell('Thaumaturgy', 0, 'Transmutation', ['Cleric'], 'You manifest a minor wonder within range.'),
    spell('Magic Missile', 1, 'Evocation', ['Sorcerer', 'Wizard'], 'You create three glowing darts of magical force. Each dart hits a creature and deals 1d4 + 1 Force damage.'),
    spell('Shield', 1, 'Abjuration', ['Sorcerer', 'Wizard'], 'An imperceptible barrier of magical force protects you. Until the start of your next turn, you have a +5 bonus to AC.'),
    spell('Sleep', 1, 'Enchantment', ['Bard', 'Sorcerer', 'Wizard'], 'Each creature of your choice in a 5-foot-radius Sphere must succeed on a Wisdom saving throw or have the Incapacitated condition.', { concentration: true }),
    spell('Detect Magic', 1, 'Divination', ['Bard', 'Cleric', 'Druid', 'Paladin', 'Ranger', 'Sorcerer', 'Wizard'], 'For the duration, you sense the presence of magical effects within 30 feet of yourself.', { ritual: true, concentration: true }),
    spell('Feather Fall', 1, 'Transmutation', ['Bard', 'Sorcerer', 'Wizard'], 'Choose up to five falling creatures within range. A falling creature’s rate of descent slows to 60 feet per round.'),
    spell('Mage Armor', 1, 'Abjuration', ['Sorcerer', 'Wizard'], 'You touch a willing creature who isn’t wearing armor. Until the spell ends, the target’s base AC becomes 13 plus its Dexterity modifier.'),
    spell('Thunderwave', 1, 'Evocation', ['Bard', 'Druid', 'Sorcerer', 'Wizard'], 'You unleash a wave of thunderous energy. Each creature in a 15-foot Cube originating from you makes a Constitution saving throw.'),
    spell('Bless', 1, 'Enchantment', ['Cleric', 'Paladin'], 'You bless up to three creatures within range. Whenever a target makes an attack roll or a saving throw before the spell ends, the target adds 1d4.', { concentration: true }),
    spell('Cure Wounds', 1, 'Abjuration', ['Bard', 'Cleric', 'Druid', 'Paladin', 'Ranger'], 'A creature you touch regains a number of Hit Points equal to 2d8 plus your spellcasting ability modifier.'),
    spell('Guiding Bolt', 1, 'Evocation', ['Cleric'], 'You hurl a bolt of light toward a creature within range. Make a ranged spell attack against the target. On a hit, it takes 4d6 Radiant damage.'),
    spell('Shield of Faith', 1, 'Abjuration', ['Cleric', 'Paladin'], 'A shimmering field surrounds a creature of your choice within range, granting it a +2 bonus to AC for the duration.', { concentration: true }),
    spell('Healing Word', 1, 'Abjuration', ['Bard', 'Cleric', 'Druid'], 'A creature of your choice that you can see within range regains Hit Points equal to 2d4 plus your spellcasting ability modifier.'),
    spell('Misty Step', 2, 'Conjuration', ['Sorcerer', 'Warlock', 'Wizard'], 'Briefly surrounded by silvery mist, you teleport up to 30 feet to an unoccupied space you can see.'),
  ];
}
