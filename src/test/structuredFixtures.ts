/**
 * The invented mini-book for structured imports (spec §8.1): "The Gloamwood Almanac". ORIGINAL INVENTED
 * CONTENT ONLY — every name, sentence and stat block below was written for these tests (rules phrasing
 * follows SRD 5.2.1 where a rule needs words); nothing is taken from a published book.
 *
 * - GLOAMWOOD_MD: SRD-style Markdown with a few older-format (2014-layout) entries.
 * - GLOAMWOOD_MIXED: the same book with the Wickwright chapter, the Glimmerwing Drake and Mothkin
 *   flattened by flatten() (parse/flatten.ts) the way pdfLayout.ts flattens PDFs. flatten() keeps
 *   paragraph numbering, so chunk ids and every span below hold in BOTH dialects.
 * - GLOAMWOOD_MARKERS: eight invented sentences that appear nowhere else (privacy checks).
 * - SCRIPTED_WIRE: the wire answers FakeExtractionClient returns, keyed by the title of the request's
 *   first block (= the candidate's primary entry name).
 * - expectedData() / EXPECTED_DATA: the stored data per structured entry (the book's truth).
 * - EXPECTED_MERGED: the merged BuilderData for an SRD subset (GLOAMWOOD_SRD_SUBSET: Cleric, Fighter,
 *   every SRD feat, a few SRD items) plus the book's accepted options.
 * - Factories: gloamwoodEntries, gloamwoodSource, structuredRecord, gloamwoodRecords, gloamwoodSnapshot,
 *   extractionJob, importedRef.
 *
 * Owner after Day 0: E1 (upkeep). Paragraph numbering follows spec §3.3 (splitParagraphs): blank-line
 * blocks; each list item and each table body row its own paragraph (table header and separator rows
 * dropped); a heading line its own paragraph; trimmed, empty ones dropped. Entry texts are what
 * chunkDocument() makes (a rules entry's text excludes its own heading).
 */
import builderRaw from '../../public/srd/builder.json?raw';
import { chunkDocument } from '@/data/chunk';
import type { LibrarySnapshot } from '@/data/rulesIndexStore';
import { flatten } from '@/data/structured/parse/flatten';
import type { Wire } from '@/data/structured/wire';
import { nameKey, slugify } from '@/lib/id';
import { bookFingerprint, textFingerprint } from '@/lib/importedContent';
import {
  PARSER_VERSION,
  STRUCTURED_SCHEMA_VERSION,
  type Adaptation,
  type AdaptationCode,
  type BackgroundData,
  type BackgroundOption,
  type BuilderData,
  type ClassData,
  type ClassFeatureDef,
  type ClassOption,
  type CompendiumEntry,
  type CostEstimate,
  type EquipmentOption,
  type EquipmentPackage,
  type ExtractionJob,
  type FeatData,
  type FeatOption,
  type ImportedRef,
  type ItemData,
  type LibrarySource,
  type MagicItemData,
  type MonsterData,
  type OptionSource,
  type RecordSpan,
  type RecordStatus,
  type RecordWarning,
  type SourceFormat,
  type SpeciesData,
  type SpeciesOption,
  type SpeciesTrait,
  type SpellData,
  type StructuredDataByKind,
  type StructuredKind,
  type StructuredRecord,
  type SubclassData,
  type SubclassOption,
  type TextSpan,
  type UsageTotals,
} from '@/types';

// ---------------------------------------------------------------------------
// Names and markers
// ---------------------------------------------------------------------------

export const GLOAMWOOD_TITLE = 'The Gloamwood Almanac';
/** The source id unit tests use (imports in e2e tests get a random one: pass it to the factories). */
export const GLOAMWOOD_SOURCE_ID = 'gloam';

/** Invented sentences placed in Ember Ward, Kindled Strikes, Dusk Sight, the Ashwing lineage, Moth's Grace, Ferryman's Right, Wick Sense and Steady Flame. */
export const GLOAMWOOD_MARKERS = [
  'The ember answers only to a patient hand.',
  'A struck spark remembers the blade that freed it.',
  'Every moth remembers the first lamp it ever circled.',
  'Ash settles softly where a promise was kept.',
  'Soft wings leave no footprints on the dew.',
  'The river keeps a ledger of every crossing.',
  'A wick leans toward the hand that will light it.',
  'Patience is the oil that feeds the longest night.',
] as const;
const [M_EMBER_WARD, M_KINDLED, M_DUSK_SIGHT, M_ASHWING, M_MOTHS_GRACE, M_FERRYMAN, M_WICK_SENSE, M_STEADY_FLAME] = GLOAMWOOD_MARKERS;

/** Every invented proper name in the book (schemas and system prompts must contain none of them). */
export const GLOAMWOOD_NAMES = [
  'Gloamwood', 'Long Dusk', 'Mothkin', 'Dusk Sight', 'Powdered Wings', 'Lamp-Drawn', 'Ashwing', 'Silverwing',
  'Bramblefolk', 'Thorn Hide', 'Thornback', 'Mossback', 'Briar Guard', 'Lamplighter', 'Ferry Hand', "Ferryman's Right",
  "Moth's Grace", 'Lantern Bearer', 'Lantern Ward', 'Watchlight Vigil', 'Hooked Reach', 'Ember Warden', 'Ember Ward',
  'Kindled Strikes', 'Smoke Step', 'Dusk Domain', 'Hearthlight Blessing', 'Settling Gloom', 'Evening Bell', 'Wickwright',
  'Wick Sense', 'Long Wick', 'Steady Flame', 'Bright Line', 'Glimmerwing', 'Bramble Hound', 'Thorn Coat', 'Ashen Choir',
  'Cinder Mote', 'Hollow Light', 'Mothsilk', "Warden's Mail", 'Hookstaff', 'Wick Lantern',
] as const;

// ---------------------------------------------------------------------------
// Feature and trait texts (paragraphs). The book prints them; EXPECTED_MERGED's descriptions are these
// paragraphs joined by "\n\n" (featureText: run-in labels equal to the name are not part of them).
// ---------------------------------------------------------------------------

export const TEXT = {
  emberWard: [
    'When you take damage, you can take a Reaction to wrap yourself in a shell of banked heat. You gain Temporary Hit Points equal to your Fighter level plus your Constitution modifier.',
    `You can use this feature a number of times equal to your Proficiency Bonus, and you regain all expended uses when you finish a Long Rest. ${M_EMBER_WARD}`,
  ],
  kindledStrikes: [
    `Once on each of your turns when you hit a creature with a weapon, you can make the weapon flare. The target takes an extra 1d6 Fire damage. ${M_KINDLED}`,
  ],
  smokeStep: [
    'When a creature you can see hits you with an attack roll, you can take a Reaction to vanish in a puff of smoke and reappear in an unoccupied space you can see within 15 feet of yourself. The attack still hits.',
  ],
  hearthlightBlessing: [
    'At 1st level, you can kindle a small flame in your palm as a bonus action. It sheds bright light in a 10-foot radius and dim light for an additional 10 feet until you dismiss it.',
  ],
  settlingGloom: [
    'Starting at 2nd level, you can use your Channel Divinity to draw the dusk around you. As an action, you fill a 30-foot radius around you with dim light for 1 minute, and creatures of your choice in that area have advantage on Dexterity (Stealth) checks.',
  ],
  eveningBell: [
    'Starting at 6th level, when a creature within 30 feet of you drops to 0 hit points, you can use your reaction to ring an unseen bell. Each ally within 30 feet of you gains temporary hit points equal to your cleric level.',
  ],
  spellcasting: [
    'You have learned to shape spells in the light of a lantern. See "Spells" for the rules on spellcasting. The information below details how you use those rules with Wickwright spells, which appear on the Wickwright spell list later in this chapter.',
    '_**Spell Slots.**_ The Wickwright Features table shows how many spell slots you have to cast your level 1+ spells. You regain all expended slots when you finish a Long Rest.',
    '_**Prepared Spells of Level 1+.**_ You prepare the list of level 1+ spells that are available for you to cast with this feature. To start, choose two level 1 Wickwright spells. The number of spells on your list increases as you gain Wickwright levels, as shown in the Prepared Spells column of the Wickwright Features table.',
    '_**Spellcasting Ability.**_ Intelligence is your spellcasting ability for your Wickwright spells.',
    '_**Spellcasting Focus.**_ You can use a lit lantern as a Spellcasting Focus for your Wickwright spells.',
  ],
  wickSense: [
    'You can feel the flames around you as if they were your own breath. As a Bonus Action, you learn the location of every lit flame within 60 feet of yourself until the end of your turn, and you can snuff or rekindle one of them that is no larger than a torch.',
    `You can use this feature a number of times shown in the Wicks column of the Wickwright Features table, and you regain all expended uses when you finish a Long Rest. ${M_WICK_SENSE}`,
  ],
  wickwrightSubclass: [
    "You gain a Wickwright subclass of your choice. The Order of the Long Wick subclass is detailed after this class's description. A subclass is a specialization that grants you features at certain Wickwright levels. For the rest of your career, you gain each of your subclass's features that are of your Wickwright level or lower.",
  ],
  abilityScoreImprovement: [
    'You gain the Ability Score Improvement feat (see "Feats") or another feat of your choice for which you qualify.',
  ],
  steadyFlame: [
    `When you cast a spell with a spell slot, you can make one flame you can see within 30 feet of yourself burn without fuel for the next 24 hours. While it burns, wind and water can't put it out. ${M_STEADY_FLAME}`,
  ],
  brightLine: [
    'As a Magic action, you send a line of light 60 feet long and 5 feet wide from a flame you can see. Each creature of your choice in the line has Disadvantage on attack rolls against you until the start of your next turn.',
  ],
  duskSight: [
    `You have Darkvision with a range of 60 feet. Within that range, you can also see the faint warmth of any lit flame through smoke or fog. ${M_DUSK_SIGHT}`,
  ],
  powderedWings: [
    "When you fall and aren't Incapacitated, you can spread your wings to reduce any falling damage you take by an amount equal to five times your character level.",
  ],
  lampDrawn: [
    'You are drawn to one kind of light, which marks your lineage. Choose a lineage from the Mothkin Lineages table. You gain the level 1 benefit of that lineage.',
    'When you reach character levels 3 and 5, you learn a higher-level spell, as shown on the table. You always have that spell prepared. You can cast it once without a spell slot, and you regain the ability to cast it in that way when you finish a Long Rest.',
    'Intelligence, Wisdom, or Charisma is your spellcasting ability for the spells you cast with this trait (choose the ability when you select the lineage).',
  ],
  bramblefolkDarkvision: ['Bramblefolk eyes gather starlight. Within 60 feet of you, you can see in darkness as if it were dim light.'],
  thornHide: ['Bitter sap runs under your bark, and you have resistance to poison damage.'],
  subrace: ['Two kinds of bramblefolk grow in the Gloamwood: thornbacks and mossbacks. Choose one of them.'],
  thornback: [
    'Thornbacks grow sharp spines along their arms and shoulders.',
    '***Briar Guard.*** When a creature within 5 feet of you hits you with a melee attack, you can use your reaction to deal 1d4 piercing damage to it.',
  ],
  mossback: ['Mossbacks are soft-footed and green-bearded.', '***Soft Step.*** You have proficiency in the Stealth skill.'],
  ferrymansRight: [
    `Ferry folk on every river know your face. You and your companions can cross any river or lake in the Gloamwood by ferry for free, and the ferry folk will hide you from pursuers for a night. ${M_FERRYMAN}`,
  ],
  mothsGrace: [
    `You move as lightly as a moth's wing. You can take the Disengage action as a Bonus Action, and you make no sound when you land after a fall. ${M_MOTHS_GRACE}`,
  ],
  lanternBearer: [
    'You gain the following benefits.',
    '_**Ability Score Increase.**_ Increase your Wisdom or Charisma score by 1, to a maximum of 20.',
    '_**Lantern Ward.**_ While you hold a lit lantern, you and allies within 10 feet of you have Advantage on saving throws to avoid or end the Frightened condition.',
  ],
  watchlightVigil: [
    "You can stay awake through the night without tiring. You don't need to sleep, and during a Long Rest you can keep watch for 8 hours while still gaining its benefits. While keeping watch, you can't be surprised.",
  ],
  hookedReach: [
    'While you wield a weapon that has the Reach property, you gain a +1 bonus to attack rolls with it, and when you hit a Large or smaller creature with it, you can pull the creature up to 5 feet closer to you.',
  ],
} as const satisfies Record<string, readonly string[]>;

/** The Mothkin Lineages table's cells (Lineage, Level 1, Level 3, Level 5). */
export const MOTHKIN_LINEAGE_ROWS = [
  ['Ashwing', `You know the Light cantrip. Your wings shed dim light in a 5-foot radius whenever you choose. ${M_ASHWING}`, 'Burning Hands', 'Continual Flame'],
  ['Silverwing', 'You know the Dancing Lights cantrip. Moonlight never dazzles you, and you have Advantage on saving throws to avoid or end the Blinded condition.', 'Faerie Fire', 'Moonbeam'],
] as const;

/** The spell names the Wickwright Spell List prints, in order (SRD spells plus the book's two). */
export const WICKWRIGHT_SPELL_NAMES = [
  'Ashen Choir', 'Burning Hands', 'Cinder Mote', 'Continual Flame', 'Daylight', 'Detect Magic', 'Faerie Fire', 'Fireball',
  'Fire Shield', 'Flaming Sphere', 'Light', 'Mending',
] as const;

/** The Wickwright Features table: [level, proficiency bonus, class features, wicks, prepared spells, slots 1st–5th]. */
const WICKWRIGHT_TABLE: readonly [number, number, string, number, number, number, number, number, number, number][] = [
  [1, 2, 'Spellcasting, Wick Sense', 2, 2, 2, 0, 0, 0, 0],
  [2, 2, '—', 2, 3, 2, 0, 0, 0, 0],
  [3, 2, 'Wickwright Subclass', 2, 4, 3, 0, 0, 0, 0],
  [4, 2, 'Ability Score Improvement', 3, 5, 3, 0, 0, 0, 0],
  [5, 3, '—', 3, 6, 4, 2, 0, 0, 0],
  [6, 3, '—', 3, 6, 4, 2, 0, 0, 0],
  [7, 3, 'Subclass feature', 4, 7, 4, 3, 0, 0, 0],
  [8, 3, '—', 4, 7, 4, 3, 0, 0, 0],
  [9, 4, '—', 4, 9, 4, 3, 2, 0, 0],
  [10, 4, '—', 4, 9, 4, 3, 2, 0, 0],
  [11, 4, '—', 5, 10, 4, 3, 3, 0, 0],
  [12, 4, '—', 5, 10, 4, 3, 3, 0, 0],
  [13, 5, '—', 5, 11, 4, 3, 3, 1, 0],
  [14, 5, '—', 5, 11, 4, 3, 3, 1, 0],
  [15, 5, '—', 6, 12, 4, 3, 3, 2, 0],
  [16, 5, '—', 6, 12, 4, 3, 3, 2, 0],
  [17, 6, '—', 6, 14, 4, 3, 3, 3, 1],
  [18, 6, '—', 6, 14, 4, 3, 3, 3, 1],
  [19, 6, '—', 7, 15, 4, 3, 3, 3, 2],
  [20, 6, '—', 7, 15, 4, 3, 3, 3, 2],
];

// ---------------------------------------------------------------------------
// The book
// ---------------------------------------------------------------------------

const p = (...paras: readonly string[]) => paras.join('\n\n');
const runIn = (label: string, paras: readonly string[], style: '2024' | '2014' = '2024') =>
  [`${style === '2024' ? `_**${label}.**_` : `***${label}.***`} ${paras[0]}`, ...paras.slice(1)].join('\n\n');
const dash = (n: number) => (n === 0 ? '—' : String(n));

const FRONT = p(
  `# ${GLOAMWOOD_TITLE}`,
  'An almanac of the Gloamwood: its folk, its lamp roads and the creatures that hunt between the lanterns.',
  '## The Long Dusk',
  'Once each year the sun hangs low over the Gloamwood for nine days and will not set. The folk of the forest call it the Long Dusk. Lanterns are hung on every branch, ferries run through the night, and old debts are forgiven at the river crossings.',
  'Travelers who arrive during the Long Dusk are welcomed at any hearth, so long as they bring a candle of their own.',
);

const MOTHKIN = p(
  '## Mothkin',
  'Mothkin are small, soft-winged folk who gather wherever lanterns burn late. Their wings are too frail for true flight, but they glide on warm air and never quite stop being drawn to light.',
  [
    '- **Creature Type:** Humanoid',
    '- **Size:** Small (about 3–4 feet tall) or Medium (about 4–5 feet tall), chosen when you select this species',
    '- **Speed:** 30 feet',
  ].join('\n'),
  'As a Mothkin, you have these special traits.',
  runIn('Dusk Sight', TEXT.duskSight),
  runIn('Powdered Wings', TEXT.powderedWings),
  runIn('Lamp-Drawn', TEXT.lampDrawn),
  '### Mothkin Lineages',
  ['| Lineage | Level 1 | Level 3 | Level 5 |', '|---|---|---|---|', ...MOTHKIN_LINEAGE_ROWS.map((r) => `| ${r.join(' | ')} |`)].join('\n'),
);

const BRAMBLEFOLK = p(
  '## Bramblefolk',
  "Bramblefolk are small, bark-skinned people who grow from the thorn thickets at the forest's edge. They are slow to trust and slower to forget, and they guard the old paths through the briars.",
  '***Ability Score Increase.*** Your Constitution score increases by 2, and your Wisdom score increases by 1.',
  '***Age.*** Bramblefolk are counted as grown at twenty and may live to see two hundred winters.',
  '***Size.*** Bramblefolk stand about 3 feet tall. Your size is Small.',
  '***Speed.*** Your walking speed is 25 feet.',
  runIn('Darkvision', TEXT.bramblefolkDarkvision, '2014'),
  runIn('Thorn Hide', TEXT.thornHide, '2014'),
  '***Languages.*** You know Common and Sylvan.',
  runIn('Subrace', TEXT.subrace, '2014'),
  '### Thornback',
  p(...TEXT.thornback),
  '### Mossback',
  p(...TEXT.mossback),
);

const PEOPLES = p(
  '# Peoples of the Gloamwood',
  'Many peoples make their homes under the forest roof. Two of them are described here.',
);

const BACKGROUNDS = p(
  '# Backgrounds',
  'The lives that heroes of the Gloamwood led before they took up adventuring.',
  '## Lamplighter',
  'Lamplighters walk the forest roads at dusk, trimming wicks and filling lamps so that no traveler has to finish a journey in the dark.',
  [
    '- **Ability Scores:** Dexterity, Wisdom, Charisma',
    "- **Feat:** Moth's Grace",
    '- **Skill Proficiencies:** Perception and Stealth',
    "- **Tool Proficiency:** Tinker's Tools",
    "- **Equipment:** _Choose A or B:_ (A) Tinker's Tools, Hookstaff, Hooded Lantern, Oil (2 flasks), Traveler's Clothes, 6 GP; or (B) 50 GP",
  ].join('\n'),
  '## Ferry Hand',
  'You have spent years poling flatboats across the black rivers of the Gloamwood, and you know every snag, eddy and toll-keeper along the way.',
  '**Skill Proficiencies:** Athletics, Survival',
  '**Tool Proficiencies:** Vehicles (Water)',
  '**Languages:** Elvish',
  "**Equipment:** Traveler's Clothes, Rope, Hooded Lantern, Oil (2 flasks), 10 GP",
  "### Feature: Ferryman's Right",
  p(...TEXT.ferrymansRight),
);

const OPTIONS = p(
  '# Character Options',
  'New paths for heroes who walk the lamp roads.',
  '## Fighter Subclass: Ember Warden',
  '_Guard the Flame Within_',
  'Ember Wardens carry a coal from the hearth they swore to protect, and their blades remember its heat. They stand between travelers and the dark, burning brighter the harder they are pressed.',
  '### Level 3: Ember Ward',
  p(...TEXT.emberWard),
  '### Level 3: Kindled Strikes',
  p(...TEXT.kindledStrikes),
  '### Level 7: Smoke Step',
  p(...TEXT.smokeStep),
  '## Cleric Domains',
  'Some clerics of the Gloamwood serve the dusk itself.',
  '### Dusk Domain',
  'Priests of the dusk keep watch over the hour between lamplight and dark. They guide travelers home before nightfall and tend the shrines that mark the forest roads.',
  'Each spell on the Dusk Domain Spells table is always prepared for you once you reach the cleric level shown.',
  ['| Cleric Level | Spells |', '|---|---|', '| 1st | Faerie Fire, Sleep |', '| 3rd | Ashen Choir, Darkness |', '| 5th | Daylight, Hypnotic Pattern |'].join('\n'),
  '#### Hearthlight Blessing',
  p(...TEXT.hearthlightBlessing),
  '#### Channel Divinity: Settling Gloom',
  p(...TEXT.settlingGloom),
  '#### Evening Bell',
  p(...TEXT.eveningBell),
);

const WICKWRIGHT = p(
  '# Wickwright',
  'Wickwrights coax magic from small, patient flames. They carry lanterns on long poles, trim their wicks by starlight, and read the shapes smoke makes before a storm.',
  '## Core Wickwright Traits',
  [
    '| Primary Ability | Intelligence |',
    '|---|---|',
    '| Hit Point Die | D8 per Wickwright level |',
    '| Saving Throw Proficiencies | Intelligence and Wisdom |',
    '| Skill Proficiencies | Choose 2: Arcana, History, Insight, Investigation, Medicine, or Perception |',
    '| Weapon Proficiencies | Simple weapons |',
    '| Armor Training | Light armor |',
    "| Starting Equipment | Choose A or B: (A) Leather Armor, Dagger, Hookstaff, Wick Lantern, Explorer's Pack, and 8 GP; or (B) 75 GP |",
  ].join('\n'),
  '## Wickwright Class Features',
  'As a Wickwright, you gain the following class features when you reach the specified Wickwright levels. These features are listed in the Wickwright Features table.',
  [
    '| Level | Proficiency Bonus | Class Features | Wicks | Prepared Spells | 1st | 2nd | 3rd | 4th | 5th |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...WICKWRIGHT_TABLE.map(([lv, pb, feats, wicks, prep, ...slots]) => `| ${lv} | +${pb} | ${feats} | ${wicks} | ${prep} | ${slots.map(dash).join(' | ')} |`),
  ].join('\n'),
  '### Level 1: Spellcasting',
  p(...TEXT.spellcasting),
  '### Level 1: Wick Sense',
  p(...TEXT.wickSense),
  '### Level 3: Wickwright Subclass',
  p(...TEXT.wickwrightSubclass),
  '### Level 4: Ability Score Improvement',
  p(...TEXT.abilityScoreImprovement),
  '## Wickwright Spell List',
  'The Wickwright spell list includes these spells.',
  WICKWRIGHT_SPELL_NAMES.map((n) => `- ${n}`).join('\n'),
  '## Wickwright Subclass: Order of the Long Wick',
  '_Tend the Flame That Outlasts the Night_',
  'Wickwrights of the Order of the Long Wick keep lamps burning on the roads through the Gloamwood. They learn to make a single flame last for days and to send its light farther than any lantern should reach.',
  '### Level 3: Steady Flame',
  p(...TEXT.steadyFlame),
  '### Level 7: Bright Line',
  p(...TEXT.brightLine),
);

const FEATS = p(
  '# Feats',
  'Feats of the lamp roads.',
  '## Origin Feats',
  "### Moth's Grace",
  '_Origin Feat_',
  p(...TEXT.mothsGrace),
  '## General Feats',
  '### Lantern Bearer',
  '_General Feat (Prerequisite: Level 4+)_',
  p(...TEXT.lanternBearer),
  '### Watchlight Vigil',
  '_General Feat (Prerequisite: Level 8+)_',
  p(...TEXT.watchlightVigil),
  '## Fighting Style Feats',
  '### Hooked Reach',
  '_Fighting Style Feat (Prerequisite: Fighting Style Feature)_',
  p(...TEXT.hookedReach),
);

const SPELLS = p(
  '# Spells',
  'These spells appear on the spell lists named in each description.',
  '## Ashen Choir',
  '_Level 2 Evocation (Sorcerer, Wizard, Wickwright)_',
  ['- **Casting Time:** Action', '- **Range:** Self (15-foot cone)', '- **Components:** V, S, M (a pinch of ash)', '- **Duration:** Instantaneous'].join('\n'),
  'Ash rises from your hands and sings as it burns. Each creature in a 15-foot Cone makes a Dexterity saving throw, taking 3d8 Fire damage on a failed save or half as much damage on a successful one.',
  '_**Using a Higher-Level Spell Slot.**_ The damage increases by 1d8 for each spell slot level above 2.',
  '## Cinder Mote',
  '_Evocation Cantrip (Wickwright)_',
  ['- **Casting Time:** Action', '- **Range:** 60 feet', '- **Components:** V, S', '- **Duration:** Instantaneous'].join('\n'),
  'You flick a glowing cinder at a creature or an object within range. Make a ranged spell attack against the target. On a hit, the target takes 1d10 Fire damage.',
  '_**Cantrip Upgrade.**_ The damage increases by 1d10 when you reach levels 5 (2d10), 11 (3d10), and 17 (4d10).',
);

const MAGIC_ITEMS = p(
  '# Magic Items',
  'The lamp-makers of the Gloamwood craft these wonders.',
  '## Lantern of Hollow Light',
  '_Wondrous Item, Uncommon (Requires Attunement)_',
  'This lantern burns without oil. While it is lit, you can take a Magic action to expend 1 of its charges and make every Invisible creature within 30 feet of it visible until the end of your next turn.',
  'The lantern has 3 charges and regains all expended charges daily at dusk.',
  '## Mothsilk Cloak',
  '_Wondrous Item, Uncommon (Requires Attunement)_',
  'Woven from the silk of a thousand moths, this cloak is lighter than air. You gain a +1 bonus to Armor Class and saving throws while you wear it.',
  "## Warden's Mail",
  '_Armor (Chain Mail), Rare_',
  'This chain mail is darkened by old smoke. You have a +1 bonus to Armor Class while you wear this armor.',
);

const GEAR = p(
  '# Gloamwood Gear',
  'Travelers buy these goods in the forest towns.',
  '## Gloamwood Arms',
  'Smiths in the forest towns forge a few weapons for the roads.',
  ['| Martial Melee Weapons | Damage | Properties | Mastery | Weight | Cost |', '|---|---|---|---|---|---|', '| Hookstaff | 1d8 Bludgeoning | Reach, Two-Handed | Topple | 6 lb. | 12 GP |'].join('\n'),
  '## Wick Lantern',
  ['- **Cost:** 2 GP', '- **Weight:** 1 lb.'].join('\n'),
  'A narrow tin lantern with a long-burning wick. It sheds Bright Light in a 15-foot radius and Dim Light for an additional 15 feet, and one wick burns for 8 hours.',
);

const BRAMBLE_HOUND = p(
  '## Bramble Hound',
  '_Medium monstrosity, unaligned_',
  '**Armor Class** 13 (natural armor)',
  '**Hit Points** 22 (4d8 + 4)',
  '**Speed** 40 ft.',
  ['| STR | DEX | CON | INT | WIS | CHA |', '|---|---|---|---|---|---|', '| 14 (+2) | 13 (+1) | 12 (+1) | 3 (−4) | 12 (+1) | 6 (−2) |'].join('\n'),
  '**Skills** Perception +3, Stealth +3',
  '**Senses** passive Perception 13',
  "**Languages** understands Sylvan but can't speak",
  '**Challenge** 1 (200 XP)',
  '***Thorn Coat.*** A creature that touches the hound or hits it with a melee attack while within 5 feet of it takes 2 (1d4) piercing damage.',
  '### Actions',
  '***Bite.*** *Melee Weapon Attack:* +4 to hit, reach 5 ft., one target. *Hit:* 7 (1d10 + 2) piercing damage.',
);

const GLIMMERWING_DRAKE = p(
  '## Glimmerwing Drake',
  '_Large Dragon, Unaligned_',
  ['- **AC** 17 (natural armor)', '- **Initiative** +2 (12)', '- **HP** 52 (8d10 + 8)', '- **Speed** 30 ft., Fly 60 ft. (hover)'].join('\n'),
  [
    '|  | Str. | Dex. | Con. | Int. | Wis. | Cha. |',
    '|---|---|---|---|---|---|---|',
    '| **Score** | 16 | 14 | 13 | 6 | 12 | 10 |',
    '| **Modifier** | +3 | +2 | +1 | -2 | +1 | +0 |',
    '| **Saving Throw** | +3 | +4 | +1 | -2 | +1 | +0 |',
  ].join('\n'),
  ['- **Skills** Perception +3', '- **Senses** Darkvision 60 ft.; Passive Perception 13', '- **Languages** Draconic', '- **CR** 3 (XP 700; PB +2)'].join('\n'),
  '### Traits',
  "_**Glimmer.**_ The drake's scales shed Dim Light in a 10-foot radius.",
  '### Actions',
  '_**Bite.**_ _Melee Attack Roll:_ +5, reach 10 ft. _Hit:_ 12 (2d8 + 3) Piercing damage.',
  '_**Glimmer Breath (Recharge 5–6).**_ _Dexterity Saving Throw:_ DC 11, each creature in a 15-foot Cone. _Failure:_ 14 (4d6) Radiant damage. _Success:_ Half damage.',
);

const GOBLIN_WARRIOR = p(
  '## Goblin Warrior',
  '_Small Fey (Goblinoid), Chaotic Neutral_',
  ['- **AC** 15', '- **Initiative** +2 (12)', '- **HP** 10 (3d6)', '- **Speed** 30 ft.', '- **CR** 1/4 (XP 50; PB +2)'].join('\n'),
  'Goblins of the Gloamwood lurk at the edges of the lamp roads and steal lanterns for their burrows.',
  '### Actions',
  '_**Scimitar.**_ _Melee Attack Roll:_ +4, reach 5 ft. _Hit:_ 5 (1d6 + 2) Slashing damage.',
);

const BESTIARY = (flat: boolean) =>
  p('# Bestiary', 'Creatures that hunt between the lanterns.', BRAMBLE_HOUND, flat ? flatten(GLIMMERWING_DRAKE) : GLIMMERWING_DRAKE, GOBLIN_WARRIOR);

const book = (flat: boolean) =>
  p(
    FRONT,
    PEOPLES,
    flat ? flatten(MOTHKIN) : MOTHKIN,
    BRAMBLEFOLK,
    BACKGROUNDS,
    OPTIONS,
    flat ? flatten(WICKWRIGHT) : WICKWRIGHT,
    FEATS,
    SPELLS,
    MAGIC_ITEMS,
    GEAR,
    BESTIARY(flat),
  );

/** SRD-style Markdown with a few older-format entries. */
export const GLOAMWOOD_MD: string = book(false);
/** The same book with the Wickwright chapter, the Glimmerwing Drake and Mothkin flattened like a PDF's text layer. */
export const GLOAMWOOD_MIXED: string = book(true);

/** The book as the importer chunks it (chunkDocument), for a source id. */
export function gloamwoodEntries(sourceId = GLOAMWOOD_SOURCE_ID, dialect: 'md' | 'mixed' = 'md') {
  return chunkDocument(dialect === 'md' ? GLOAMWOOD_MD : GLOAMWOOD_MIXED, { sourceId, sourceName: GLOAMWOOD_TITLE });
}


// ---------------------------------------------------------------------------
// What detection should find (segment, §3.2). Reading order; the queue sorts by STRUCTURED_KINDS first.
// ---------------------------------------------------------------------------

export interface GloamwoodCandidate {
  kind: StructuredKind;
  /** The record name (a subclass without its "Fighter Subclass:" prefix). */
  name: string;
  span: RecordSpan;
  /** Entry names in reading order, one block each: B1, B2, … of the request (the first is the primary entry). */
  entries: readonly string[];
  /** A subclass found inside a class chapter. */
  parentClassName?: string;
}

export const GLOAMWOOD_CANDIDATES: readonly GloamwoodCandidate[] = [
  { kind: 'species', name: 'Mothkin', span: 'section', entries: ['Mothkin', 'Mothkin Lineages'] },
  { kind: 'species', name: 'Bramblefolk', span: 'section', entries: ['Bramblefolk', 'Thornback', 'Mossback'] },
  { kind: 'background', name: 'Lamplighter', span: 'section', entries: ['Lamplighter'] },
  { kind: 'background', name: 'Ferry Hand', span: 'section', entries: ['Ferry Hand', "Feature: Ferryman's Right"] },
  {
    kind: 'subclass',
    name: 'Ember Warden',
    span: 'section',
    entries: ['Fighter Subclass: Ember Warden', 'Level 3: Ember Ward', 'Level 3: Kindled Strikes', 'Level 7: Smoke Step'],
  },
  { kind: 'subclass', name: 'Dusk Domain', span: 'section', entries: ['Dusk Domain', 'Hearthlight Blessing', 'Channel Divinity: Settling Gloom', 'Evening Bell'] },
  {
    kind: 'class',
    name: 'Wickwright',
    span: 'section',
    entries: [
      'Wickwright', 'Core Wickwright Traits', 'Wickwright Class Features', 'Level 1: Spellcasting', 'Level 1: Wick Sense',
      'Level 3: Wickwright Subclass', 'Level 4: Ability Score Improvement', 'Wickwright Spell List',
    ],
  },
  {
    kind: 'subclass',
    name: 'Order of the Long Wick',
    span: 'section',
    entries: ['Wickwright Subclass: Order of the Long Wick', 'Level 3: Steady Flame', 'Level 7: Bright Line'],
    parentClassName: 'Wickwright',
  },
  { kind: 'feat', name: "Moth's Grace", span: 'entry', entries: ["Moth's Grace"] },
  { kind: 'feat', name: 'Lantern Bearer', span: 'entry', entries: ['Lantern Bearer'] },
  { kind: 'feat', name: 'Watchlight Vigil', span: 'entry', entries: ['Watchlight Vigil'] },
  { kind: 'feat', name: 'Hooked Reach', span: 'entry', entries: ['Hooked Reach'] },
  { kind: 'spell', name: 'Ashen Choir', span: 'entry', entries: ['Ashen Choir'] },
  { kind: 'spell', name: 'Cinder Mote', span: 'entry', entries: ['Cinder Mote'] },
  { kind: 'magic-item', name: 'Lantern of Hollow Light', span: 'entry', entries: ['Lantern of Hollow Light'] },
  { kind: 'magic-item', name: 'Mothsilk Cloak', span: 'entry', entries: ['Mothsilk Cloak'] },
  { kind: 'magic-item', name: "Warden's Mail", span: 'entry', entries: ["Warden's Mail"] },
  { kind: 'item', name: 'Gloamwood Arms', span: 'table', entries: ['Gloamwood Arms'] },
  { kind: 'item', name: 'Wick Lantern', span: 'entry', entries: ['Wick Lantern'] },
  { kind: 'monster', name: 'Bramble Hound', span: 'entry', entries: ['Bramble Hound'] },
  { kind: 'monster', name: 'Glimmerwing Drake', span: 'entry', entries: ['Glimmerwing Drake'] },
  { kind: 'monster', name: 'Goblin Warrior', span: 'entry', entries: ['Goblin Warrior'] },
];

/** Entries that stay plain rules text (no candidate): chapter introductions and lore. */
export const GLOAMWOOD_RULE_ENTRIES = [
  GLOAMWOOD_TITLE, 'The Long Dusk', 'Peoples of the Gloamwood', 'Backgrounds', 'Character Options', 'Cleric Domains', 'Feats',
  'Spells', 'Magic Items', 'Gloamwood Gear', 'Bestiary',
] as const;

/** The book's "<Class> Spell List" (§3.2 rule 5): Wickwright, naming SRD spells and the book's own. */
export const GLOAMWOOD_SPELL_LISTS = [{ className: 'Wickwright', entryName: 'Wickwright Spell List', spellNames: [...WICKWRIGHT_SPELL_NAMES] }] as const;

// ---------------------------------------------------------------------------
// SCRIPTED_WIRE: what the fake Claude answers, by the title of the request's first block. Spans use the
// candidate's block ids (GLOAMWOOD_CANDIDATES entries → B1, B2, …) and §3.3 paragraph numbers.
// One deliberate misreading: the Glimmerwing Drake's hpText is "58 (8d10 + 8)" (the book prints 52), so
// normalizing it gives hp 58 with `ungrounded` and `cross-check` warnings; the review fixes it to 52.
// ---------------------------------------------------------------------------

export type ScriptedAnswer = { [K in StructuredKind]: { kind: K; wire: Wire<K> } }[StructuredKind];
const answer = <K extends StructuredKind>(kind: K, wire: Wire<K>) => ({ kind, wire }) as ScriptedAnswer;
const NO_TEXT = { block: '', from: 0, to: 0 };
const head = (name: string, format: SourceFormat = '2024') => ({ matchesKind: true, name, format });

const levelTableWire = () => {
  const col = (header: string, pick: (row: (typeof WICKWRIGHT_TABLE)[number]) => string) => ({ header, values: WICKWRIGHT_TABLE.map(pick) });
  return [
    col('Proficiency Bonus', (r) => `+${r[1]}`),
    col('Class Features', (r) => r[2]),
    col('Wicks', (r) => String(r[3])),
    col('Prepared Spells', (r) => String(r[4])),
    ...['1st', '2nd', '3rd', '4th', '5th'].map((h, i) => col(h, (r) => dash(r[5 + i] as number))),
  ];
};

export const SCRIPTED_WIRE: Readonly<Record<string, ScriptedAnswer>> = {
  Mothkin: answer('species', {
    ...head('Mothkin'),
    creatureTypeText: 'Humanoid',
    sizeText: 'Small (about 3–4 feet tall) or Medium (about 4–5 feet tall), chosen when you select this species',
    speedText: '30 feet',
    darkvisionText: 'a range of 60 feet',
    traits: [
      { name: 'Dusk Sight', text: { block: 'B1', from: 6, to: 6 } },
      { name: 'Powdered Wings', text: { block: 'B1', from: 7, to: 7 } },
      { name: 'Lamp-Drawn', text: { block: 'B1', from: 8, to: 10 } },
    ],
    lineageTraitName: 'Lamp-Drawn',
    lineages: [
      { name: 'Ashwing', text: { block: 'B2', from: 1, to: 1 } },
      { name: 'Silverwing', text: { block: 'B2', from: 2, to: 2 } },
    ],
    abilityIncreasesText: '',
    languagesText: '',
    notes: '',
  }),
  Bramblefolk: answer('species', {
    ...head('Bramblefolk', '2014'),
    creatureTypeText: '',
    sizeText: 'Small',
    speedText: '25 feet',
    darkvisionText: 'Within 60 feet of you',
    traits: [
      { name: 'Darkvision', text: { block: 'B1', from: 6, to: 6 } },
      { name: 'Thorn Hide', text: { block: 'B1', from: 7, to: 7 } },
      { name: 'Subrace', text: { block: 'B1', from: 9, to: 9 } },
    ],
    lineageTraitName: 'Subrace',
    lineages: [
      { name: 'Thornback', text: { block: 'B2', from: 1, to: 2 } },
      { name: 'Mossback', text: { block: 'B3', from: 1, to: 2 } },
    ],
    abilityIncreasesText: 'Your Constitution score increases by 2, and your Wisdom score increases by 1.',
    languagesText: 'Common and Sylvan',
    notes: '',
  }),
  Lamplighter: answer('background', {
    ...head('Lamplighter'),
    abilityScoresText: 'Dexterity, Wisdom, Charisma',
    featText: "Moth's Grace",
    skillsText: 'Perception and Stealth',
    toolText: "Tinker's Tools",
    equipmentText: "Choose A or B: (A) Tinker's Tools, Hookstaff, Hooded Lantern, Oil (2 flasks), Traveler's Clothes, 6 GP; or (B) 50 GP",
    languagesText: '',
    legacyFeature: { name: '', text: NO_TEXT },
    notes: '',
  }),
  'Ferry Hand': answer('background', {
    ...head('Ferry Hand', '2014'),
    abilityScoresText: '',
    featText: '',
    skillsText: 'Athletics, Survival',
    toolText: 'Vehicles (Water)',
    equipmentText: "Traveler's Clothes, Rope, Hooded Lantern, Oil (2 flasks), 10 GP",
    languagesText: 'Elvish',
    legacyFeature: { name: "Ferryman's Right", text: { block: 'B2', from: 1, to: 1 } },
    notes: '',
  }),
  'Fighter Subclass: Ember Warden': answer('subclass', {
    ...head('Ember Warden'),
    parentClassText: 'Fighter',
    taglineText: 'Guard the Flame Within',
    features: [
      { level: 3, name: 'Ember Ward', text: { block: 'B2', from: 1, to: 2 } },
      { level: 3, name: 'Kindled Strikes', text: { block: 'B3', from: 1, to: 1 } },
      { level: 7, name: 'Smoke Step', text: { block: 'B4', from: 1, to: 1 } },
    ],
    casterType: 'none',
    spellcastingAbility: 'none',
    alwaysPreparedSpells: [],
    notes: '',
  }),
  'Dusk Domain': answer('subclass', {
    ...head('Dusk Domain', '2014'),
    parentClassText: 'Cleric',
    taglineText: 'Priests of the dusk keep watch over the hour between lamplight and dark.',
    features: [
      { level: 1, name: 'Hearthlight Blessing', text: { block: 'B2', from: 1, to: 1 } },
      { level: 2, name: 'Channel Divinity: Settling Gloom', text: { block: 'B3', from: 1, to: 1 } },
      { level: 6, name: 'Evening Bell', text: { block: 'B4', from: 1, to: 1 } },
    ],
    casterType: 'none',
    spellcastingAbility: 'none',
    alwaysPreparedSpells: [
      { level: 1, spells: ['Faerie Fire', 'Sleep'] },
      { level: 3, spells: ['Ashen Choir', 'Darkness'] },
      { level: 5, spells: ['Daylight', 'Hypnotic Pattern'] },
    ],
    notes: '',
  }),
  Wickwright: answer('class', {
    ...head('Wickwright'),
    primaryAbilityText: 'Intelligence',
    hitDieText: 'D8 per Wickwright level',
    savingThrowsText: 'Intelligence and Wisdom',
    skillsText: 'Choose 2: Arcana, History, Insight, Investigation, Medicine, or Perception',
    weaponsText: 'Simple weapons',
    armorText: 'Light armor',
    toolsText: '',
    equipmentText: "Choose A or B: (A) Leather Armor, Dagger, Hookstaff, Wick Lantern, Explorer's Pack, and 8 GP; or (B) 75 GP",
    casterType: 'half',
    spellcastingAbility: 'int',
    preparedSpellsText: '',
    spellListText: '',
    subclassLevel: 3,
    levelTable: levelTableWire(),
    features: [
      { level: 1, name: 'Spellcasting', text: { block: 'B4', from: 1, to: 5 } },
      { level: 1, name: 'Wick Sense', text: { block: 'B5', from: 1, to: 2 } },
      { level: 3, name: 'Wickwright Subclass', text: { block: 'B6', from: 1, to: 1 } },
      { level: 4, name: 'Ability Score Improvement', text: { block: 'B7', from: 1, to: 1 } },
    ],
    notes: '',
  }),
  'Wickwright Subclass: Order of the Long Wick': answer('subclass', {
    ...head('Order of the Long Wick'),
    parentClassText: 'Wickwright',
    taglineText: 'Tend the Flame That Outlasts the Night',
    features: [
      { level: 3, name: 'Steady Flame', text: { block: 'B2', from: 1, to: 1 } },
      { level: 7, name: 'Bright Line', text: { block: 'B3', from: 1, to: 1 } },
    ],
    casterType: 'none',
    spellcastingAbility: 'none',
    alwaysPreparedSpells: [],
    notes: '',
  }),
  "Moth's Grace": answer('feat', {
    ...head("Moth's Grace"),
    categoryText: 'Origin Feat',
    category: 'origin',
    prerequisiteText: '',
    repeatable: false,
    abilityIncreaseText: '',
    notes: '',
  }),
  'Lantern Bearer': answer('feat', {
    ...head('Lantern Bearer'),
    categoryText: 'General Feat (Prerequisite: Level 4+)',
    category: 'general',
    prerequisiteText: 'Level 4+',
    repeatable: false,
    abilityIncreaseText: 'Increase your Wisdom or Charisma score by 1, to a maximum of 20.',
    notes: '',
  }),
  'Watchlight Vigil': answer('feat', {
    ...head('Watchlight Vigil'),
    categoryText: 'General Feat (Prerequisite: Level 8+)',
    category: 'general',
    prerequisiteText: 'Level 8+',
    repeatable: false,
    abilityIncreaseText: '',
    notes: '',
  }),
  'Hooked Reach': answer('feat', {
    ...head('Hooked Reach'),
    categoryText: 'Fighting Style Feat (Prerequisite: Fighting Style Feature)',
    category: 'fighting-style',
    prerequisiteText: 'Fighting Style Feature',
    repeatable: false,
    abilityIncreaseText: '',
    notes: '',
  }),
  'Ashen Choir': answer('spell', {
    ...head('Ashen Choir'),
    levelText: 'Level 2 Evocation (Sorcerer, Wizard, Wickwright)',
    level: 2,
    school: 'evocation',
    classesText: 'Sorcerer, Wizard, Wickwright',
    castingTimeText: 'Action',
    rangeText: 'Self (15-foot cone)',
    componentsText: 'V, S, M (a pinch of ash)',
    durationText: 'Instantaneous',
    ritual: false,
    concentration: false,
    areaText: '15-foot Cone',
    saveAbility: 'dex',
    attack: 'none',
    damageText: '3d8 Fire damage',
    cantripScalingText: '',
    notes: '',
  }),
  'Cinder Mote': answer('spell', {
    ...head('Cinder Mote'),
    levelText: 'Evocation Cantrip (Wickwright)',
    level: 0,
    school: 'evocation',
    classesText: 'Wickwright',
    castingTimeText: 'Action',
    rangeText: '60 feet',
    componentsText: 'V, S',
    durationText: 'Instantaneous',
    ritual: false,
    concentration: false,
    areaText: '',
    saveAbility: 'none',
    attack: 'ranged',
    damageText: '1d10 Fire damage',
    cantripScalingText: 'levels 5 (2d10), 11 (3d10), and 17 (4d10)',
    notes: '',
  }),
  'Lantern of Hollow Light': answer('magic-item', {
    ...head('Lantern of Hollow Light'),
    typeLineText: 'Wondrous Item, Uncommon (Requires Attunement)',
    category: 'wondrous-item',
    rarity: 'uncommon',
    attunement: 'required',
    attunementText: '',
    baseItemText: '',
    acBonus: 0,
    saveBonus: 0,
    attackBonus: 0,
    damageBonus: 0,
    bonusText: '',
    acCondition: 'always',
    chargesText: 'has 3 charges',
    notes: '',
  }),
  'Mothsilk Cloak': answer('magic-item', {
    ...head('Mothsilk Cloak'),
    typeLineText: 'Wondrous Item, Uncommon (Requires Attunement)',
    category: 'wondrous-item',
    rarity: 'uncommon',
    attunement: 'required',
    attunementText: '',
    baseItemText: '',
    acBonus: 1,
    saveBonus: 1,
    attackBonus: 0,
    damageBonus: 0,
    bonusText: '+1 bonus to Armor Class and saving throws',
    acCondition: 'always',
    chargesText: '',
    notes: '',
  }),
  "Warden's Mail": answer('magic-item', {
    ...head("Warden's Mail"),
    typeLineText: 'Armor (Chain Mail), Rare',
    category: 'armor',
    rarity: 'rare',
    attunement: 'none',
    attunementText: '',
    baseItemText: 'Chain Mail',
    acBonus: 1,
    saveBonus: 0,
    attackBonus: 0,
    damageBonus: 0,
    bonusText: '+1 bonus to Armor Class',
    acCondition: 'always',
    chargesText: '',
    notes: '',
  }),
  'Gloamwood Arms': answer('item', {
    ...head('Gloamwood Arms'),
    items: [
      {
        name: 'Hookstaff',
        category: 'weapon',
        costText: '12 GP',
        weightText: '6 lb.',
        weaponCategory: 'martial',
        weaponType: 'melee',
        damageText: '1d8 Bludgeoning',
        propertiesText: 'Reach, Two-Handed',
        masteryText: 'Topple',
        armorType: 'none',
        acText: '',
        strengthText: '',
        stealthDisadvantage: false,
      },
    ],
    notes: '',
  }),
  'Wick Lantern': answer('item', {
    ...head('Wick Lantern'),
    items: [
      {
        name: 'Wick Lantern',
        category: 'gear',
        costText: '2 GP',
        weightText: '1 lb.',
        weaponCategory: 'none',
        weaponType: 'none',
        damageText: '',
        propertiesText: '',
        masteryText: '',
        armorType: 'none',
        acText: '',
        strengthText: '',
        stealthDisadvantage: false,
      },
    ],
    notes: '',
  }),
  'Bramble Hound': answer('monster', {
    ...head('Bramble Hound', '2014'),
    sizeText: 'Medium',
    typeText: 'monstrosity',
    alignmentText: 'unaligned',
    acText: '13 (natural armor)',
    hpText: '22 (4d8 + 4)',
    speedText: '40 ft.',
    initiativeText: '',
    crText: '1 (200 XP)',
    abilityScores: { str: 14, dex: 13, con: 12, int: 3, wis: 12, cha: 6 },
    sensesText: 'passive Perception 13',
    languagesText: "understands Sylvan but can't speak",
    resistancesText: '',
    immunitiesText: '',
    vulnerabilitiesText: '',
    reachText: 'reach 5 ft.',
    legendary: false,
    notes: '',
  }),
  'Glimmerwing Drake': answer('monster', {
    ...head('Glimmerwing Drake'),
    sizeText: 'Large',
    typeText: 'Dragon',
    alignmentText: 'Unaligned',
    acText: '17 (natural armor)',
    hpText: '58 (8d10 + 8)',
    speedText: '30 ft., Fly 60 ft. (hover)',
    initiativeText: '+2 (12)',
    crText: '3 (XP 700; PB +2)',
    abilityScores: { str: 16, dex: 14, con: 13, int: 6, wis: 12, cha: 10 },
    sensesText: 'Darkvision 60 ft.; Passive Perception 13',
    languagesText: 'Draconic',
    resistancesText: '',
    immunitiesText: '',
    vulnerabilitiesText: '',
    reachText: 'reach 10 ft.',
    legendary: false,
    notes: '',
  }),
  'Goblin Warrior': answer('monster', {
    ...head('Goblin Warrior'),
    sizeText: 'Small',
    typeText: 'Fey (Goblinoid)',
    alignmentText: 'Chaotic Neutral',
    acText: '15',
    hpText: '10 (3d6)',
    speedText: '30 ft.',
    initiativeText: '+2 (12)',
    crText: '1/4 (XP 50; PB +2)',
    abilityScores: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 },
    sensesText: '',
    languagesText: '',
    resistancesText: '',
    immunitiesText: '',
    vulnerabilitiesText: '',
    reachText: 'reach 5 ft.',
    legendary: false,
    notes: 'The stat block prints no ability scores.',
  }),
};

// ---------------------------------------------------------------------------
// EXPECTED_DATA: the stored data per entry (the book's truth; spans on the given source's entry ids).
// Normalizer choices it fixes: monster type and alignment title-cased; `speed` app-written from
// `speeds` ("30 ft., fly 60 ft. (hover)"); a single size → no `sizes`; feats' `repeatable: false` kept
// (the field is required); gear has no description (no book text is copied); weapons get the SRD's
// app-written description pattern.
// ---------------------------------------------------------------------------

const idCache = new Map<string, Map<string, CompendiumEntry>>();
/** name → entry of the book for a source id (ids are the same in both dialects). */
function entriesByName(sourceId: string): Map<string, CompendiumEntry> {
  let map = idCache.get(sourceId);
  if (!map) idCache.set(sourceId, (map = new Map(gloamwoodEntries(sourceId).map((e) => [e.name, e]))));
  return map;
}
/** The chunk id of a book entry by its name ("Level 3: Ember Ward" → "lib:gloam:15"). */
export function gloamwoodEntryId(name: string, sourceId = GLOAMWOOD_SOURCE_ID): string {
  const entry = entriesByName(sourceId).get(name);
  if (!entry) throw new Error(`structuredFixtures: no Gloamwood entry named "${name}"`);
  return entry.id;
}
const ordinalOf = (id: string) => Number(id.slice(id.lastIndexOf(':') + 1));

const LAMPLIGHTER_EQUIPMENT: EquipmentPackage[] = [
  {
    label: 'Option A',
    items: [
      { name: "Tinker's Tools", quantity: 1 },
      { name: 'Hookstaff', quantity: 1 },
      { name: 'Hooded Lantern', quantity: 1 },
      { name: 'Oil', quantity: 2 },
      { name: "Traveler's Clothes", quantity: 1 },
    ],
    gp: 6,
  },
  { label: 'Option B', items: [], gp: 50 },
];
const FERRY_HAND_EQUIPMENT: EquipmentPackage[] = [
  {
    label: 'Option A',
    items: [
      { name: "Traveler's Clothes", quantity: 1 },
      { name: 'Rope', quantity: 1 },
      { name: 'Hooded Lantern', quantity: 1 },
      { name: 'Oil', quantity: 2 },
    ],
    gp: 10,
  },
];
const WICKWRIGHT_EQUIPMENT: EquipmentPackage[] = [
  {
    label: 'Option A',
    items: [
      { name: 'Leather Armor', quantity: 1 },
      { name: 'Dagger', quantity: 1 },
      { name: 'Hookstaff', quantity: 1 },
      { name: 'Wick Lantern', quantity: 1 },
      { name: "Explorer's Pack", quantity: 1 },
    ],
    gp: 8,
  },
  { label: 'Option B', items: [], gp: 75 },
];
const WICKWRIGHT_LEVEL_TABLE = WICKWRIGHT_TABLE.map(([level, proficiencyBonus, features, wicks, preparedSpells, slot1, slot2, slot3, slot4, slot5]) => ({
  level, proficiencyBonus, features, wicks, preparedSpells, slot1, slot2, slot3, slot4, slot5,
}));

export function expectedData(sourceId = GLOAMWOOD_SOURCE_ID) {
  const span = (entry: string, from: number, to = from): TextSpan => ({ entryIds: [gloamwoodEntryId(entry, sourceId)], from, to });
  return {
    Wickwright: {
      format: '2024',
      hitDie: 8,
      primaryAbilities: ['int'],
      primaryAbilityRule: 'all',
      savingThrows: ['int', 'wis'],
      skillChoices: { count: 2, from: ['arcana', 'history', 'insight', 'investigation', 'medicine', 'perception'] },
      weaponProficiencies: ['Simple weapons'],
      armorTraining: ['Light armor'],
      tools: [],
      casterType: 'half',
      spellcastingAbility: 'int',
      spellNames: [...WICKWRIGHT_SPELL_NAMES],
      weaponMasteryCount: 0,
      startingEquipment: WICKWRIGHT_EQUIPMENT,
      subclassLevel: 3,
      features: [
        { level: 1, name: 'Spellcasting', text: span('Level 1: Spellcasting', 1, 5) },
        { level: 1, name: 'Wick Sense', text: span('Level 1: Wick Sense', 1, 2) },
        { level: 3, name: 'Wickwright Subclass', text: span('Level 3: Wickwright Subclass', 1) },
        { level: 4, name: 'Ability Score Improvement', text: span('Level 4: Ability Score Improvement', 1) },
      ],
      levelTable: WICKWRIGHT_LEVEL_TABLE,
    } satisfies ClassData as ClassData,
    'Ember Warden': {
      format: '2024',
      parentClass: 'Fighter',
      summary: 'Guard the Flame Within',
      features: [
        { level: 3, name: 'Ember Ward', text: span('Level 3: Ember Ward', 1, 2) },
        { level: 3, name: 'Kindled Strikes', text: span('Level 3: Kindled Strikes', 1) },
        { level: 7, name: 'Smoke Step', text: span('Level 7: Smoke Step', 1) },
      ],
    } satisfies SubclassData as SubclassData,
    'Dusk Domain': {
      format: '2014',
      parentClass: 'Cleric',
      summary: 'Priests of the dusk keep watch over the hour between lamplight and dark.',
      features: [
        { level: 1, name: 'Hearthlight Blessing', text: span('Hearthlight Blessing', 1) },
        { level: 2, name: 'Channel Divinity: Settling Gloom', text: span('Channel Divinity: Settling Gloom', 1) },
        { level: 6, name: 'Evening Bell', text: span('Evening Bell', 1) },
      ],
      alwaysPreparedSpells: [
        { level: 1, spells: ['Faerie Fire', 'Sleep'] },
        { level: 3, spells: ['Ashen Choir', 'Darkness'] },
        { level: 5, spells: ['Daylight', 'Hypnotic Pattern'] },
      ],
    } satisfies SubclassData as SubclassData,
    'Order of the Long Wick': {
      format: '2024',
      parentClass: 'Wickwright',
      summary: 'Tend the Flame That Outlasts the Night',
      features: [
        { level: 3, name: 'Steady Flame', text: span('Level 3: Steady Flame', 1) },
        { level: 7, name: 'Bright Line', text: span('Level 7: Bright Line', 1) },
      ],
    } satisfies SubclassData as SubclassData,
    Mothkin: {
      format: '2024',
      creatureType: 'Humanoid',
      sizes: ['Small', 'Medium'],
      speed: 30,
      darkvision: 60,
      traits: [
        { name: 'Dusk Sight', text: span('Mothkin', 6) },
        { name: 'Powdered Wings', text: span('Mothkin', 7) },
        { name: 'Lamp-Drawn', text: span('Mothkin', 8, 10) },
      ],
      lineageTrait: 'Lamp-Drawn',
      lineages: [
        { name: 'Ashwing', text: span('Mothkin Lineages', 1), form: 'table-row' },
        { name: 'Silverwing', text: span('Mothkin Lineages', 2), form: 'table-row' },
      ],
    } satisfies SpeciesData as SpeciesData,
    Bramblefolk: {
      format: '2014',
      creatureType: 'Humanoid',
      sizes: ['Small'],
      speed: 25,
      darkvision: 60,
      traits: [
        { name: 'Darkvision', text: span('Bramblefolk', 6) },
        { name: 'Thorn Hide', text: span('Bramblefolk', 7) },
        { name: 'Subrace', text: span('Bramblefolk', 9) },
      ],
      lineageTrait: 'Subrace',
      lineages: [
        { name: 'Thornback', text: span('Thornback', 1, 2), form: 'paragraphs' },
        { name: 'Mossback', text: span('Mossback', 1, 2), form: 'paragraphs' },
      ],
      legacyAbilityIncreases: [
        { ability: 'con', amount: 2 },
        { ability: 'wis', amount: 1 },
      ],
      languages: ['Common', 'Sylvan'],
    } satisfies SpeciesData as SpeciesData,
    Lamplighter: {
      format: '2024',
      abilityScores: ['dex', 'wis', 'cha'],
      feat: "Moth's Grace",
      skills: ['perception', 'stealth'],
      tool: "Tinker's Tools",
      equipment: LAMPLIGHTER_EQUIPMENT,
    } satisfies BackgroundData as BackgroundData,
    'Ferry Hand': {
      format: '2014',
      abilityScores: [],
      feat: '',
      skills: ['athletics', 'survival'],
      tool: 'Vehicles (Water)',
      equipment: FERRY_HAND_EQUIPMENT,
      languages: ['Elvish'],
      legacyFeature: { name: "Ferryman's Right", text: span("Feature: Ferryman's Right", 1) },
    } satisfies BackgroundData as BackgroundData,
    "Moth's Grace": { format: '2024', category: 'origin', repeatable: false, text: span("Moth's Grace", 2) } satisfies FeatData as FeatData,
    'Lantern Bearer': {
      format: '2024',
      category: 'general',
      prerequisite: 'Level 4+',
      minLevel: 4,
      repeatable: false,
      abilityIncrease: { abilities: ['wis', 'cha'], amount: 1 },
      text: span('Lantern Bearer', 2, 4),
    } satisfies FeatData as FeatData,
    'Watchlight Vigil': {
      format: '2024',
      category: 'general',
      prerequisite: 'Level 8+',
      minLevel: 8,
      repeatable: false,
      text: span('Watchlight Vigil', 2),
    } satisfies FeatData as FeatData,
    'Hooked Reach': {
      format: '2024',
      category: 'fighting-style',
      prerequisite: 'Fighting Style Feature',
      repeatable: false,
      text: span('Hooked Reach', 2),
    } satisfies FeatData as FeatData,
    'Ashen Choir': {
      format: '2024',
      level: 2,
      school: 'Evocation',
      classes: ['Sorcerer', 'Wizard', 'Wickwright'],
      ritual: false,
      concentration: false,
      castingTime: 'Action',
      range: 'Self (15-foot cone)',
      components: 'V, S, M (a pinch of ash)',
      duration: 'Instantaneous',
      area: { shape: 'cone', sizeFt: 15 },
      saveAbility: 'dex',
      damage: '3d8',
      damageTypes: ['fire'],
    } satisfies SpellData as SpellData,
    'Cinder Mote': {
      format: '2024',
      level: 0,
      school: 'Evocation',
      classes: ['Wickwright'],
      ritual: false,
      concentration: false,
      castingTime: 'Action',
      range: '60 feet',
      components: 'V, S',
      duration: 'Instantaneous',
      attack: 'ranged',
      damage: '1d10',
      damageTypes: ['fire'],
      damageByCharacterLevel: { '5': '2d10', '11': '3d10', '17': '4d10' },
    } satisfies SpellData as SpellData,
    'Lantern of Hollow Light': {
      format: '2024',
      category: 'wondrous-item',
      rarity: 'uncommon',
      attunement: true,
      charges: 3,
    } satisfies MagicItemData as MagicItemData,
    'Mothsilk Cloak': {
      format: '2024',
      category: 'wondrous-item',
      rarity: 'uncommon',
      attunement: true,
      bonuses: { ac: 1, savingThrows: 1 },
    } satisfies MagicItemData as MagicItemData,
    "Warden's Mail": {
      format: '2024',
      category: 'armor',
      rarity: 'rare',
      attunement: false,
      baseItem: 'Chain Mail',
      bonuses: { ac: 1 },
    } satisfies MagicItemData as MagicItemData,
    Hookstaff: {
      format: '2024',
      category: 'weapon',
      costGp: 12,
      weight: 6,
      weaponCategory: 'martial',
      weaponType: 'melee',
      damage: '1d8',
      damageType: 'bludgeoning',
      properties: ['Reach', 'Two-Handed'],
      mastery: 'Topple',
      description: 'Martial Melee Weapon',
    } satisfies ItemData as ItemData,
    'Wick Lantern': { format: '2024', category: 'gear', costGp: 2, weight: 1 } satisfies ItemData as ItemData,
    'Bramble Hound': {
      format: '2014',
      size: 'Medium',
      type: 'Monstrosity',
      alignment: 'Unaligned',
      ac: 13,
      acNote: 'natural armor',
      hp: 22,
      hitDice: '4d8 + 4',
      speed: '40 ft.',
      speeds: { walk: 40 },
      initiative: 1,
      reachFt: 5,
      cr: '1',
      crValue: 1,
      xp: 200,
      pb: 2,
      abilities: { str: 14, dex: 13, con: 12, int: 3, wis: 12, cha: 6 },
      senses: 'passive Perception 13',
      passivePerception: 13,
      languages: "understands Sylvan but can't speak",
      legendary: false,
    } satisfies MonsterData as MonsterData,
    'Glimmerwing Drake': {
      format: '2024',
      size: 'Large',
      type: 'Dragon',
      alignment: 'Unaligned',
      ac: 17,
      acNote: 'natural armor',
      hp: 52,
      hitDice: '8d10 + 8',
      speed: '30 ft., fly 60 ft. (hover)',
      speeds: { walk: 30, fly: 60, hover: true },
      initiative: 2,
      reachFt: 10,
      cr: '3',
      crValue: 3,
      xp: 700,
      pb: 2,
      abilities: { str: 16, dex: 14, con: 13, int: 6, wis: 12, cha: 10 },
      senses: 'Darkvision 60 ft.; Passive Perception 13',
      passivePerception: 13,
      languages: 'Draconic',
      legendary: false,
    } satisfies MonsterData as MonsterData,
  };
}
export type GloamwoodDataName = keyof ReturnType<typeof expectedData>;
export const EXPECTED_DATA = expectedData();

/** Adaptations the normalizers attach (merge-time ones, such as Dusk Domain's, are in EXPECTED_MERGED). */
export const ADAPTATION_NOTES: Readonly<Record<AdaptationCode, (name: string) => string>> = {
  'species-asi-not-applied': (n) => `Older edition: ${n}'s ability score increases aren't used. In the 2024 rules your background sets your ability scores.`,
  'species-languages-suggested': (n) => `Older edition: the languages ${n} lists are suggested for your two language choices.`,
  'background-any-three': (n) => `Older edition: ${n} doesn't list ability scores, so you choose any three to increase.`,
  'background-feat-choice': (n) => `Older edition: ${n} doesn't grant an Origin feat, so you choose one.`,
  'background-feature-kept': (f) => `Older edition: its feature “${f}” is kept on your sheet as a background feature.`,
  'background-languages-suggested': (n) => `Older edition: the languages ${n} grants are suggested for your two language choices.`,
  'feat-general': (n) => `No feat category is printed, so ${n} is treated as a General feat.`,
  'fighting-style-inline': (n) => `${n} lists its own fighting styles; they're offered alongside the Fighting Style feats.`,
  'subclass-early-features': (n) => n,
  'subclass-overlap': (n) => n,
  'subclass-at-level-1': (n) => `${n} chooses its subclass at level 1: pick it in the builder.`,
  'prepared-2024-column': (n) => n,
  'half-caster-slots-2024': () => 'Spell slots follow the 2024 table, which gives half casters slots from level 1.',
  'monster-2014-statblock': () => "Older stat block: its initiative is its Dexterity modifier and its proficiency bonus comes from its CR.",
};
const adapt = (code: AdaptationCode, arg: string): Adaptation => ({ code, note: ADAPTATION_NOTES[code](arg) });

export const EXPECTED_ADAPTATIONS: Readonly<Partial<Record<GloamwoodDataName, readonly Adaptation[]>>> = {
  Bramblefolk: [adapt('species-asi-not-applied', 'Bramblefolk'), adapt('species-languages-suggested', 'Bramblefolk')],
  'Ferry Hand': [
    adapt('background-any-three', 'Ferry Hand'),
    adapt('background-feat-choice', 'Ferry Hand'),
    adapt('background-feature-kept', "Ferryman's Right"),
    adapt('background-languages-suggested', 'Ferry Hand'),
  ],
  'Bramble Hound': [adapt('monster-2014-statblock', 'Bramble Hound')],
};
/** Merge-time adaptations of Dusk Domain on the SRD Cleric (§5.1 rule 5). */
export const DUSK_DOMAIN_MERGE_ADAPTATIONS: readonly Adaptation[] = [
  { code: 'subclass-early-features', note: 'Older edition: you choose Dusk Domain at Cleric level 3 here; features it gives earlier arrive then.' },
  { code: 'subclass-overlap', note: "Written for the older rules: some of Dusk Domain's features may overlap the 2024 Cleric's own. Ask your DM which to keep." },
];

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export const FIXTURE_TIME = 1_700_000_000_000;

/** The library row for the book, with its fingerprint (bookFingerprint of the entries as imported). */
export function gloamwoodSource(sourceId = GLOAMWOOD_SOURCE_ID, dialect: 'md' | 'mixed' = 'md', overrides: Partial<LibrarySource> = {}): LibrarySource {
  const entries = gloamwoodEntries(sourceId, dialect);
  return {
    id: sourceId,
    title: GLOAMWOOD_TITLE,
    kind: 'import',
    format: dialect === 'md' ? 'markdown' : 'pdf',
    enabled: true,
    entryCount: entries.length,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    fingerprint: bookFingerprint(entries.map((e) => e.text)),
    ...overrides,
  };
}

export const zeroUsage = (): UsageTotals => ({ requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0 });

/** A record with the app's id conventions (§2.6); everything else defaults to a clean pending parser read. */
export function structuredRecord<K extends StructuredKind>(
  kind: K,
  name: string,
  overrides: Partial<StructuredRecord<K>> = {},
  sourceId = GLOAMWOOD_SOURCE_ID,
): StructuredRecord<K> {
  const slug = slugify(name);
  const entryIds = overrides.entryIds ?? [`lib:${sourceId}:1`];
  const span = overrides.span ?? 'entry';
  return {
    id: `rec:${sourceId}:${kind}:${slug}`,
    sourceId,
    kind,
    name,
    schemaVersion: STRUCTURED_SCHEMA_VERSION,
    publicId: span === 'entry' ? entryIds[0] : `lib:${sourceId}:${kind}:${slug}`,
    entryIds,
    span,
    candidateKey: `${kind}:${nameKey(name)}:${entryIds[0]}${span === 'row' ? `:r${overrides.rowIndex ?? 0}` : ''}`,
    status: 'pending',
    confidence: kind === 'class' || kind === 'subclass' ? 'medium' : 'high',
    origin: 'parser',
    data: null,
    warnings: [],
    adaptations: [],
    excerpts: [],
    edited: false,
    textHash: '',
    parserVersion: PARSER_VERSION,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    ...overrides,
  };
}

const KIND_OF: Readonly<Record<GloamwoodDataName, StructuredKind>> = {
  Wickwright: 'class', 'Ember Warden': 'subclass', 'Dusk Domain': 'subclass', 'Order of the Long Wick': 'subclass',
  Mothkin: 'species', Bramblefolk: 'species', Lamplighter: 'background', 'Ferry Hand': 'background', "Moth's Grace": 'feat',
  'Lantern Bearer': 'feat', 'Watchlight Vigil': 'feat', 'Hooked Reach': 'feat', 'Ashen Choir': 'spell', 'Cinder Mote': 'spell',
  'Lantern of Hollow Light': 'magic-item', 'Mothsilk Cloak': 'magic-item', "Warden's Mail": 'magic-item', Hookstaff: 'item',
  'Wick Lantern': 'item', 'Bramble Hound': 'monster', 'Glimmerwing Drake': 'monster',
};

/**
 * Every record detection + review would hold for the book, in reading order: one per candidate, plus the
 * Hookstaff row of the Gloamwood Arms table (the table record keeps data null). Subclasses carry their
 * parentClassId (SRD Fighter / SRD Cleric / the Wickwright's publicId). The Goblin Warrior has no data
 * (its ability scores aren't printed) and a block warning.
 */
export function gloamwoodRecords(sourceId = GLOAMWOOD_SOURCE_ID, opts: { status?: RecordStatus } = {}): StructuredRecord[] {
  const data = expectedData(sourceId);
  const byName = entriesByName(sourceId);
  const textHashOf = (entryNames: readonly string[]) => textFingerprint(entryNames.map((n) => byName.get(n)?.text ?? '').join('\n\n'));
  const status = opts.status ?? 'pending';
  const parents: Record<string, string> = {
    'Ember Warden': 'srd:class:fighter',
    'Dusk Domain': 'srd:class:cleric',
    'Order of the Long Wick': `lib:${sourceId}:class:wickwright`,
  };
  const records: StructuredRecord[] = [];
  for (const c of GLOAMWOOD_CANDIDATES) {
    const entryIds = c.entries.map((n) => gloamwoodEntryId(n, sourceId));
    const base = { entryIds, span: c.span, status, textHash: textHashOf(c.entries) };
    if (c.name === 'Gloamwood Arms') {
      const table = structuredRecord('item', c.name, { ...base, status: 'pending' }, sourceId);
      records.push(table, structuredRecord('item', 'Hookstaff', {
        ...base,
        span: 'row',
        rowIndex: 0,
        tableRecordId: table.id,
        data: data.Hookstaff,
      }, sourceId));
      continue;
    }
    if (c.name === 'Goblin Warrior') {
      const warnings: RecordWarning[] = [{ code: 'missing', severity: 'block', field: 'abilityScores', message: 'The ability scores are missing.' }];
      records.push(structuredRecord('monster', c.name, { ...base, status: 'pending', confidence: 'low', warnings }, sourceId));
      continue;
    }
    const name = c.name as GloamwoodDataName;
    const warnings: RecordWarning[] =
      name === 'Bramble Hound'
        ? [{ code: 'default-used', severity: 'info', field: 'initiative', message: 'No Initiative line: the app used the Dexterity modifier.' }]
        : [];
    records.push(
      structuredRecord(KIND_OF[name], c.name, {
        ...base,
        data: data[name] as StructuredDataByKind[StructuredKind],
        adaptations: [...(EXPECTED_ADAPTATIONS[name] ?? [])],
        warnings,
        ...(parents[c.name] ? { parentClassId: parents[c.name] } : {}),
        ...(c.name === 'Dusk Domain' ? { origin: 'claude' as const } : {}),
      }, sourceId),
    );
  }
  return records;
}

/** The LibrarySnapshot of a library holding only this book, every record with data accepted (E4's merge input). */
export function gloamwoodSnapshot(sourceId = GLOAMWOOD_SOURCE_ID, version = 1): LibrarySnapshot {
  return {
    version,
    sources: [gloamwoodSource(sourceId)],
    entriesById: new Map(gloamwoodEntries(sourceId).map((e) => [e.id, e])),
    accepted: gloamwoodRecords(sourceId, { status: 'accepted' }).filter((r) => r.data !== null),
  };
}

const zeroEstimate = (model: string): CostEstimate => ({
  model, requests: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0,
  usd: 0, usdLow: 0, usdHigh: 0, minutesLow: 0, minutesHigh: 0, byKind: {},
});

export function extractionJob(overrides: Partial<ExtractionJob> = {}): ExtractionJob {
  const model = overrides.model ?? 'claude-opus-5-5';
  return {
    id: 'job:fixture',
    sourceId: GLOAMWOOD_SOURCE_ID,
    status: 'queued',
    model,
    useFallbacks: true,
    concurrency: 3,
    budgetUsd: 5,
    scope: { kinds: ['class', 'species', 'monster'], claudeFor: 'misses' },
    estimate: zeroEstimate(model),
    usage: zeroUsage(),
    counts: { queued: 0, running: 0, done: 0, failed: 0, refused: 0, skipped: 0 },
    interrupted: 0,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    ...overrides,
  };
}

/** A ref for copied text from the book (defaults: Ember Ward on the Ember Warden option). */
export function importedRef(overrides: Partial<ImportedRef> = {}, sourceId = GLOAMWOOD_SOURCE_ID): ImportedRef {
  const text = TEXT.emberWard.join('\n\n');
  return {
    sourceId,
    sourceTitle: GLOAMWOOD_TITLE,
    bookFingerprint: gloamwoodSource(sourceId).fingerprint,
    entryId: `lib:${sourceId}:subclass:ember-warden`,
    kind: 'subclass',
    entryName: 'Ember Warden',
    part: 'Ember Ward',
    level: 3,
    at: { ordinals: [ordinalOf(gloamwoodEntryId('Level 3: Ember Ward', sourceId))], from: 1, to: 2 },
    textHash: textFingerprint(text),
    textCopied: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// EXPECTED_MERGED: mergeBuilderData(GLOAMWOOD_SRD_SUBSET, importedOptions(gloamwoodSnapshot())).
// Merge choices it fixes: descriptions are featureText (the paragraphs; run-in labels equal to the name
// dropped), ClassFeatureDef.summary follows the SRD build's firstParagraphs(description, 300); every
// imported subclass gets firstLevel (its lowest printed feature level); FeatOption.repeatable is set
// only when true (as the SRD); a table-row lineage's description is built from its cells ("<Level 1>
// Level 3: <spell>. Level 5: <spell>."); refs carry the option id, the part, the level (the def's
// level, after any move), `at` and the text's fingerprint. Imports follow the SRD, sorted by name.
// ---------------------------------------------------------------------------

/** The SRD 5.2.1 builder data (CC-BY-4.0), parsed once. */
export const SRD_BUILDER_DATA: BuilderData = deepFreeze(JSON.parse(builderRaw) as BuilderData);

const SRD_SUBSET_ITEMS = new Set(['Chain Mail', 'Dagger', "Explorer's Pack", 'Hooded Lantern', 'Leather Armor', 'Oil', 'Rope', 'Shield', "Tinker's Tools", "Traveler's Clothes"]);
const srdClass = (id: string): ClassOption => {
  const found = SRD_BUILDER_DATA.classes.find((c) => c.id === id);
  if (!found) throw new Error(`structuredFixtures: no SRD class ${id}`);
  return found;
};

/** The SRD side of the merge: Cleric and Fighter, every SRD feat, and the SRD items the book's packages name. Frozen. */
export const GLOAMWOOD_SRD_SUBSET: BuilderData = deepFreeze({
  classes: [srdClass('srd:class:cleric'), srdClass('srd:class:fighter')],
  species: [],
  backgrounds: [],
  feats: [...SRD_BUILDER_DATA.feats],
  equipment: SRD_BUILDER_DATA.equipment.filter((e) => SRD_SUBSET_ITEMS.has(e.name)),
});

/** The SRD build's feature summary: leading paragraphs while they fit in `max` chars (else the first, cut at a sentence). */
function firstParagraphs(md: string, max = 300): string | undefined {
  const paras = md.split(/\n{2,}/).map((x) => x.trim()).filter((x) => x && !x.startsWith('|') && !x.startsWith('#'));
  let out = '';
  for (const para of paras) {
    const next = out ? `${out}\n\n${para}` : para;
    if (next.length > max) {
      if (!out) {
        const cut = para.slice(0, max);
        const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'));
        out = end > max * 0.4 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, '')}…`;
      }
      break;
    }
    out = next;
  }
  return out || undefined;
}

export function expectedMerged(sourceId = GLOAMWOOD_SOURCE_ID): BuilderData {
  const source = gloamwoodSource(sourceId);
  const option = (kind: StructuredKind, name: string, publicId: string, format: SourceFormat, adaptations: readonly Adaptation[] = []) => ({
    id: publicId,
    name,
    source: { sourceId, title: GLOAMWOOD_TITLE, recordId: `rec:${sourceId}:${kind}:${slugify(name)}`, format, adaptations: [...adaptations] } satisfies OptionSource,
  });
  const section = (kind: StructuredKind, name: string) => `lib:${sourceId}:${kind}:${slugify(name)}`;
  const entry = (name: string) => gloamwoodEntryId(name, sourceId);
  const ref = (o: { id: string; name: string }, kind: StructuredKind, entryName: string, from: number, to: number, text: string, part?: string, level?: number): ImportedRef => ({
    sourceId,
    sourceTitle: GLOAMWOOD_TITLE,
    bookFingerprint: source.fingerprint,
    entryId: o.id,
    kind,
    entryName: o.name,
    ...(part !== undefined ? { part } : {}),
    ...(level !== undefined ? { level } : {}),
    at: { ordinals: [ordinalOf(entry(entryName))], from, to },
    textHash: textFingerprint(text),
    textCopied: true,
  });
  const feature = (o: { id: string; name: string }, kind: 'class' | 'subclass', level: number, name: string, entryName: string, paras: readonly string[], from = 1): ClassFeatureDef => {
    const description = paras.join('\n\n');
    return { level, name, description, summary: firstParagraphs(description), ref: ref(o, kind, entryName, from, from + paras.length - 1, description, name, level) };
  };
  const trait = (o: { id: string; name: string }, kind: StructuredKind, name: string, entryName: string, from: number, paras: readonly string[]): SpeciesTrait => {
    const description = paras.join('\n\n');
    return { name, description, ref: ref(o, kind, entryName, from, from + paras.length - 1, description, name) };
  };

  // Subclasses
  const emberBase = option('subclass', 'Ember Warden', section('subclass', 'Ember Warden'), '2024');
  const ember: SubclassOption = {
    ...emberBase,
    summary: 'Guard the Flame Within',
    features: [
      feature(emberBase, 'subclass', 3, 'Ember Ward', 'Level 3: Ember Ward', TEXT.emberWard),
      feature(emberBase, 'subclass', 3, 'Kindled Strikes', 'Level 3: Kindled Strikes', TEXT.kindledStrikes),
      feature(emberBase, 'subclass', 7, 'Smoke Step', 'Level 7: Smoke Step', TEXT.smokeStep),
    ],
    firstLevel: 3,
  };
  const duskBase = option('subclass', 'Dusk Domain', section('subclass', 'Dusk Domain'), '2014', DUSK_DOMAIN_MERGE_ADAPTATIONS);
  const dusk: SubclassOption = {
    ...duskBase,
    summary: 'Priests of the dusk keep watch over the hour between lamplight and dark.',
    features: [
      // Printed at levels 1 and 2: on the SRD Cleric (subclass level 3) they arrive at 3 (subclass-early-features).
      feature(duskBase, 'subclass', 3, 'Hearthlight Blessing', 'Hearthlight Blessing', TEXT.hearthlightBlessing),
      feature(duskBase, 'subclass', 3, 'Channel Divinity: Settling Gloom', 'Channel Divinity: Settling Gloom', TEXT.settlingGloom),
      feature(duskBase, 'subclass', 6, 'Evening Bell', 'Evening Bell', TEXT.eveningBell),
    ],
    firstLevel: 1,
    alwaysPreparedSpells: [
      { level: 1, spells: ['Faerie Fire', 'Sleep'] },
      { level: 3, spells: ['Ashen Choir', 'Darkness'] },
      { level: 5, spells: ['Daylight', 'Hypnotic Pattern'] },
    ],
  };
  const orderBase = option('subclass', 'Order of the Long Wick', section('subclass', 'Order of the Long Wick'), '2024');
  const order: SubclassOption = {
    ...orderBase,
    summary: 'Tend the Flame That Outlasts the Night',
    features: [
      feature(orderBase, 'subclass', 3, 'Steady Flame', 'Level 3: Steady Flame', TEXT.steadyFlame),
      feature(orderBase, 'subclass', 7, 'Bright Line', 'Level 7: Bright Line', TEXT.brightLine),
    ],
    firstLevel: 3,
  };

  // The class
  const wickBase = option('class', 'Wickwright', section('class', 'Wickwright'), '2024');
  const wickwright: ClassOption = {
    ...wickBase,
    summary: 'd8 Hit Die · Half caster (Intelligence) · Subclass at level 3',
    hitDie: 8,
    primaryAbilities: ['int'],
    savingThrows: ['int', 'wis'],
    skillChoices: { count: 2, from: ['arcana', 'history', 'insight', 'investigation', 'medicine', 'perception'] },
    weaponProficiencies: ['Simple weapons'],
    armorTraining: ['Light armor'],
    tools: [],
    casterType: 'half',
    spellcastingAbility: 'int',
    weaponMasteryCount: 0,
    startingEquipment: WICKWRIGHT_EQUIPMENT,
    subclassLevel: 3,
    subclasses: [order],
    features: [
      feature(wickBase, 'class', 1, 'Spellcasting', 'Level 1: Spellcasting', TEXT.spellcasting),
      feature(wickBase, 'class', 1, 'Wick Sense', 'Level 1: Wick Sense', TEXT.wickSense),
      feature(wickBase, 'class', 3, 'Wickwright Subclass', 'Level 3: Wickwright Subclass', TEXT.wickwrightSubclass),
      feature(wickBase, 'class', 4, 'Ability Score Improvement', 'Level 4: Ability Score Improvement', TEXT.abilityScoreImprovement),
    ],
    levelTable: WICKWRIGHT_LEVEL_TABLE,
    primaryAbilityRule: 'all',
    spellNames: [...WICKWRIGHT_SPELL_NAMES],
  };
  const cleric = srdClass('srd:class:cleric');
  const fighter = srdClass('srd:class:fighter');

  // Species
  const mothBase = option('species', 'Mothkin', section('species', 'Mothkin'), '2024');
  const lineage = (row: (typeof MOTHKIN_LINEAGE_ROWS)[number], paragraph: number) => {
    const description = `${row[1]} Level 3: ${row[2]}. Level 5: ${row[3]}.`;
    return { name: row[0], description, ref: ref(mothBase, 'species', 'Mothkin Lineages', paragraph, paragraph, description, row[0]) };
  };
  const mothkin: SpeciesOption = {
    ...mothBase,
    summary: 'Small or Medium Humanoid · Speed 30 ft. · Darkvision 60 ft.',
    creatureType: 'Humanoid',
    sizes: ['Small', 'Medium'],
    speed: 30,
    darkvision: 60,
    traits: [
      trait(mothBase, 'species', 'Dusk Sight', 'Mothkin', 6, TEXT.duskSight),
      trait(mothBase, 'species', 'Powdered Wings', 'Mothkin', 7, TEXT.powderedWings),
      trait(mothBase, 'species', 'Lamp-Drawn', 'Mothkin', 8, TEXT.lampDrawn),
    ],
    lineages: [lineage(MOTHKIN_LINEAGE_ROWS[0], 1), lineage(MOTHKIN_LINEAGE_ROWS[1], 2)],
    lineageTrait: 'Lamp-Drawn',
  };
  const brambleBase = option('species', 'Bramblefolk', section('species', 'Bramblefolk'), '2014', EXPECTED_ADAPTATIONS.Bramblefolk);
  const bramblefolk: SpeciesOption = {
    ...brambleBase,
    summary: 'Small Humanoid · Speed 25 ft. · Darkvision 60 ft.',
    creatureType: 'Humanoid',
    sizes: ['Small'],
    speed: 25,
    darkvision: 60,
    traits: [
      trait(brambleBase, 'species', 'Darkvision', 'Bramblefolk', 6, TEXT.bramblefolkDarkvision),
      trait(brambleBase, 'species', 'Thorn Hide', 'Bramblefolk', 7, TEXT.thornHide),
      trait(brambleBase, 'species', 'Subrace', 'Bramblefolk', 9, TEXT.subrace),
    ],
    lineages: [
      trait(brambleBase, 'species', 'Thornback', 'Thornback', 1, TEXT.thornback),
      trait(brambleBase, 'species', 'Mossback', 'Mossback', 1, TEXT.mossback),
    ],
    lineageTrait: 'Subrace',
    legacyAbilityIncreases: [
      { ability: 'con', amount: 2 },
      { ability: 'wis', amount: 1 },
    ],
    languages: ['Common', 'Sylvan'],
  };

  // Backgrounds
  const lampBase = option('background', 'Lamplighter', section('background', 'Lamplighter'), '2024');
  const lamplighter: BackgroundOption = {
    ...lampBase,
    summary: "Dex, Wis, Cha · Moth's Grace · Perception, Stealth",
    abilityScores: ['dex', 'wis', 'cha'],
    feat: "Moth's Grace",
    skills: ['perception', 'stealth'],
    tool: "Tinker's Tools",
    equipment: LAMPLIGHTER_EQUIPMENT,
  };
  const ferryBase = option('background', 'Ferry Hand', section('background', 'Ferry Hand'), '2014', EXPECTED_ADAPTATIONS['Ferry Hand']);
  const ferryHand: BackgroundOption = {
    ...ferryBase,
    summary: 'Any three abilities · Origin feat: your choice · Athletics, Survival',
    abilityScores: [],
    feat: '',
    skills: ['athletics', 'survival'],
    tool: 'Vehicles (Water)',
    equipment: FERRY_HAND_EQUIPMENT,
    abilityChoice: 'any',
    featChoice: true,
    languages: ['Elvish'],
    legacyFeature: trait(ferryBase, 'background', "Ferryman's Right", "Feature: Ferryman's Right", 1, TEXT.ferrymansRight),
  };

  // Feats
  const feat = (name: string, paras: readonly string[], rest: Omit<FeatOption, 'id' | 'name' | 'description' | 'source' | 'ref'>): FeatOption => {
    const base = option('feat', name, entry(name), '2024');
    const description = paras.join('\n\n');
    return { ...base, description, ...rest, ref: ref(base, 'feat', name, 2, 1 + paras.length, description) };
  };
  const feats = [
    feat('Hooked Reach', TEXT.hookedReach, { category: 'fighting-style', prerequisite: 'Fighting Style Feature' }),
    feat('Lantern Bearer', TEXT.lanternBearer, { category: 'general', prerequisite: 'Level 4+', minLevel: 4, abilityIncrease: { abilities: ['wis', 'cha'], amount: 1 } }),
    feat("Moth's Grace", TEXT.mothsGrace, { category: 'origin' }),
    feat('Watchlight Vigil', TEXT.watchlightVigil, { category: 'general', prerequisite: 'Level 8+', minLevel: 8 }),
  ];

  // Equipment
  const chainMail = GLOAMWOOD_SRD_SUBSET.equipment.find((e) => e.name === 'Chain Mail') as EquipmentOption;
  const equipment: EquipmentOption[] = [
    {
      ...option('item', 'Hookstaff', section('item', 'Hookstaff'), '2024'),
      category: 'weapon',
      costGp: 12,
      weight: 6,
      weaponCategory: 'martial',
      weaponType: 'melee',
      damage: '1d8',
      damageType: 'bludgeoning',
      properties: ['Reach', 'Two-Handed'],
      mastery: 'Topple',
      description: 'Martial Melee Weapon',
    },
    {
      ...option('magic-item', 'Mothsilk Cloak', entry('Mothsilk Cloak'), '2024'),
      category: 'gear',
      magic: { rarity: 'uncommon', attunement: true, bonuses: { ac: 1, savingThrows: 1 } },
    },
    {
      ...chainMail,
      ...option('magic-item', "Warden's Mail", entry("Warden's Mail"), '2024'),
      magic: { rarity: 'rare', attunement: false, bonuses: { ac: 1 }, baseItemId: chainMail.id },
    },
    { ...option('item', 'Wick Lantern', entry('Wick Lantern'), '2024'), category: 'gear', costGp: 2, weight: 1 },
  ];

  return deepFreeze({
    classes: [
      { ...cleric, subclasses: [...cleric.subclasses, dusk] },
      { ...fighter, subclasses: [...fighter.subclasses, ember] },
      wickwright,
    ],
    species: [bramblefolk, mothkin],
    backgrounds: [ferryHand, lamplighter],
    feats: [...GLOAMWOOD_SRD_SUBSET.feats, ...feats],
    equipment: [...GLOAMWOOD_SRD_SUBSET.equipment, ...equipment],
  });
}
export const EXPECTED_MERGED: BuilderData = expectedMerged();

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
