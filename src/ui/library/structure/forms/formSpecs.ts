/**
 * The review forms, declared per kind (spec §4.5): a "Key stats" group that is always open, then
 * collapsed groups (the first group with a warning opens). Plain fields render through controls.tsx;
 * `editor` fields name a bespoke editor (editors.tsx, RowsEditor, LevelTableEditor, PackageEditor,
 * ParentClassSelect).
 */
import {
  ABILITIES,
  ABILITY_NAMES,
  CREATURE_SIZES,
  SKILLS,
  SKILL_NAMES,
  type ItemData,
  type SpellData,
  type StructuredKind,
} from '@/types';
import type { AnyData } from './context';
import type { Option } from './controls';

export type SuggestKey = 'classes' | 'damageTypes' | 'weaponPhrases' | 'armorPhrases' | 'tools' | 'properties';
export type EditorKey =
  | 'monsterSize'
  | 'speeds'
  | 'abilityScores'
  | 'cr'
  | 'spellArea'
  | 'cantripDice'
  | 'rarity'
  | 'attunement'
  | 'baseItem'
  | 'bonuses'
  | 'dexCap'
  | 'abilityIncrease'
  | 'backgroundAbilities'
  | 'originFeat'
  | 'span'
  | 'traits'
  | 'lineageTrait'
  | 'lineages'
  | 'legacyFeature'
  | 'legacyIncreases'
  | 'features'
  | 'packages'
  | 'levelTable'
  | 'parentClass'
  | 'alwaysPrepared'
  | 'primaryAbilities'
  | 'skillChoices'
  | 'casting';

type When = (data: AnyData) => boolean;

export type FieldSpec = { path: string; label: string; hint?: string; when?: When; wide?: boolean } & (
  | { type: 'text'; optional?: boolean; placeholder?: string }
  | { type: 'number'; min?: number; max?: number; signed?: boolean; decimal?: boolean; unit?: string }
  | { type: 'select'; options: readonly Option[]; optional?: boolean; numeric?: boolean; emptyLabel?: string }
  | { type: 'segment'; options: readonly Option[] }
  | { type: 'check' }
  | { type: 'chips'; options: readonly Option[]; max?: number }
  | { type: 'tags'; suggest?: SuggestKey; optional?: boolean }
  | { type: 'editor'; editor: EditorKey }
);

export interface FormGroup {
  id: string;
  title: string;
  /** The always-open "Key stats" group. */
  key?: boolean;
  fields: readonly FieldSpec[];
  when?: When;
}

export const ABILITY_OPTIONS: readonly Option[] = ABILITIES.map((a) => ({ value: a, label: ABILITY_NAMES[a] }));
export const SIZE_OPTIONS: readonly Option[] = CREATURE_SIZES.map((s) => ({ value: s, label: s }));
export const SKILL_OPTIONS: readonly Option[] = SKILLS.map((s) => ({ value: s, label: SKILL_NAMES[s] }));
const opts = (pairs: readonly (readonly [string, string])[]): Option[] => pairs.map(([value, label]) => ({ value, label }));

const SCHOOLS = opts(
  ['Abjuration', 'Conjuration', 'Divination', 'Enchantment', 'Evocation', 'Illusion', 'Necromancy', 'Transmutation'].map((s) => [s, s] as const),
);
const SPELL_LEVELS = opts([['0', 'Cantrip'], ...Array.from({ length: 9 }, (_, i) => [String(i + 1), `Level ${i + 1}`] as const)]);
export const MAGIC_CATEGORIES = opts([
  ['armor', 'Armor'], ['shield', 'Shield'], ['weapon', 'Weapon'], ['ammunition', 'Ammunition'], ['potion', 'Potion'], ['ring', 'Ring'],
  ['rod', 'Rod'], ['scroll', 'Scroll'], ['staff', 'Staff'], ['wand', 'Wand'], ['wondrous-item', 'Wondrous item'], ['other', 'Other'],
]);
export const RARITIES = opts([
  ['common', 'Common'], ['uncommon', 'Uncommon'], ['rare', 'Rare'], ['very rare', 'Very rare'], ['legendary', 'Legendary'],
  ['artifact', 'Artifact'], ['varies', 'Varies'],
]);
const ITEM_CATEGORIES = opts([['weapon', 'Weapon'], ['armor', 'Armor'], ['shield', 'Shield'], ['gear', 'Gear'], ['tool', 'Tool'], ['pack', 'Pack']]);
const FEAT_CATEGORIES = opts([['origin', 'Origin'], ['general', 'General'], ['fighting-style', 'Fighting Style'], ['epic-boon', 'Epic Boon']]);
const HIT_DICE = opts([['6', 'd6'], ['8', 'd8'], ['10', 'd10'], ['12', 'd12']]);
export const CASTER_TYPES = opts([['none', 'Not a spellcaster'], ['full', 'Full caster'], ['half', 'Half caster'], ['third', 'Third caster'], ['pact', 'Pact magic']]);

export const SUGGESTIONS: Readonly<Record<Exclude<SuggestKey, 'classes' | 'tools'>, readonly string[]>> = {
  damageTypes: ['acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic', 'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder'],
  weaponPhrases: ['Simple weapons', 'Martial weapons'],
  armorPhrases: ['Light armor', 'Medium armor', 'Heavy armor', 'Shields'],
  properties: ['Ammunition', 'Finesse', 'Heavy', 'Light', 'Loading', 'Reach', 'Thrown', 'Two-Handed', 'Versatile'],
};

const item = (test: (d: ItemData) => boolean): When => (d) => test(d as ItemData);
const spell = (test: (d: SpellData) => boolean): When => (d) => test(d as SpellData);

export const FORM_SPECS: Readonly<Record<StructuredKind, readonly FormGroup[]>> = {
  monster: [
    {
      id: 'key',
      title: 'Key stats',
      key: true,
      fields: [
        { type: 'editor', editor: 'monsterSize', path: 'size', label: 'Size' },
        { type: 'text', path: 'type', label: 'Type', placeholder: 'Dragon' },
        { type: 'number', path: 'ac', label: 'AC', min: 1, max: 40 },
        { type: 'text', path: 'acNote', label: 'Note', optional: true, placeholder: 'natural armor' },
        { type: 'number', path: 'hp', label: 'HP', min: 1, max: 2000 },
        { type: 'text', path: 'hitDice', label: 'Dice', optional: true, placeholder: '8d10 + 8' },
        { type: 'editor', editor: 'speeds', path: 'speeds', label: 'Speed', wide: true },
        { type: 'number', path: 'initiative', label: 'Initiative', signed: true, min: -10, max: 20 },
        { type: 'number', path: 'reachFt', label: 'Reach', unit: 'ft', min: 5, max: 60 },
        { type: 'editor', editor: 'cr', path: 'cr', label: 'CR', wide: true },
      ],
    },
    {
      id: 'abilities',
      title: 'Abilities and senses',
      fields: [
        { type: 'editor', editor: 'abilityScores', path: 'abilities', label: 'Ability scores', wide: true },
        { type: 'text', path: 'senses', label: 'Senses', optional: true, wide: true },
        { type: 'number', path: 'passivePerception', label: 'Passive Perception', min: 0, max: 60 },
        { type: 'text', path: 'languages', label: 'Languages', optional: true, wide: true },
      ],
    },
    {
      id: 'defenses',
      title: 'Defenses',
      fields: [
        { type: 'text', path: 'resistances', label: 'Resistances', optional: true, wide: true },
        { type: 'text', path: 'immunities', label: 'Immunities', optional: true, wide: true },
        { type: 'text', path: 'vulnerabilities', label: 'Vulnerabilities', optional: true, wide: true },
      ],
    },
    {
      id: 'more',
      title: 'Type details',
      fields: [
        { type: 'tags', path: 'tags', label: 'Tags', optional: true, hint: 'The words in parentheses after the type, like Goblinoid.' },
        { type: 'text', path: 'alignment', label: 'Alignment', optional: true },
        { type: 'check', path: 'legendary', label: 'Legendary (has legendary actions)' },
      ],
    },
  ],
  spell: [
    {
      id: 'key',
      title: 'Key stats',
      key: true,
      fields: [
        { type: 'select', path: 'level', label: 'Level', options: SPELL_LEVELS, numeric: true },
        { type: 'select', path: 'school', label: 'School', options: SCHOOLS },
        { type: 'tags', path: 'classes', label: 'Classes', suggest: 'classes', wide: true, hint: 'The spell lists it appears on.' },
        { type: 'check', path: 'ritual', label: 'Ritual' },
        { type: 'check', path: 'concentration', label: 'Concentration' },
        { type: 'text', path: 'range', label: 'Range', placeholder: '150 feet' },
        { type: 'editor', editor: 'spellArea', path: 'area', label: 'Area', wide: true },
      ],
    },
    {
      id: 'casting',
      title: 'Casting',
      fields: [
        { type: 'text', path: 'castingTime', label: 'Casting time', placeholder: 'Action' },
        { type: 'text', path: 'components', label: 'Components', optional: true },
        { type: 'text', path: 'duration', label: 'Duration', placeholder: 'Instantaneous' },
      ],
    },
    {
      id: 'effect',
      title: 'Saves, attacks and damage',
      fields: [
        { type: 'select', path: 'saveAbility', label: 'Saving throw', options: ABILITY_OPTIONS, optional: true },
        { type: 'select', path: 'attack', label: 'Spell attack', options: opts([['melee', 'Melee'], ['ranged', 'Ranged']]), optional: true },
        { type: 'text', path: 'damage', label: 'Damage dice', optional: true, placeholder: '3d8' },
        { type: 'tags', path: 'damageTypes', label: 'Damage types', suggest: 'damageTypes', optional: true },
        { type: 'editor', editor: 'cantripDice', path: 'damageByCharacterLevel', label: 'Cantrip damage', wide: true, when: spell((d) => d.level === 0) },
      ],
    },
  ],
  'magic-item': [
    {
      id: 'key',
      title: 'Key stats',
      key: true,
      fields: [
        { type: 'select', path: 'category', label: 'Category', options: MAGIC_CATEGORIES },
        { type: 'editor', editor: 'rarity', path: 'rarity', label: 'Rarity' },
        { type: 'editor', editor: 'attunement', path: 'attunement', label: 'Attunement', wide: true },
        { type: 'editor', editor: 'baseItem', path: 'baseItem', label: 'Base item', wide: true },
      ],
    },
    { id: 'bonuses', title: 'Bonuses', fields: [{ type: 'editor', editor: 'bonuses', path: 'bonuses', label: 'Bonuses', wide: true }] },
    { id: 'charges', title: 'Charges', fields: [{ type: 'number', path: 'charges', label: 'Charges', min: 1, max: 100 }] },
  ],
  item: [
    {
      id: 'key',
      title: 'Key stats',
      key: true,
      fields: [
        { type: 'segment', path: 'category', label: 'Category', options: ITEM_CATEGORIES, wide: true },
        { type: 'segment', path: 'weaponCategory', label: 'Weapon kind', options: opts([['simple', 'Simple'], ['martial', 'Martial']]), when: item((d) => d.category === 'weapon') },
        { type: 'segment', path: 'weaponType', label: 'Melee or ranged', options: opts([['melee', 'Melee'], ['ranged', 'Ranged']]), when: item((d) => d.category === 'weapon') },
        { type: 'text', path: 'damage', label: 'Damage dice', placeholder: '1d8', when: item((d) => d.category === 'weapon') },
        { type: 'text', path: 'damageType', label: 'Damage type', placeholder: 'slashing', when: item((d) => d.category === 'weapon') },
        { type: 'tags', path: 'properties', label: 'Properties', suggest: 'properties', optional: true, wide: true, when: item((d) => d.category === 'weapon') },
        { type: 'text', path: 'mastery', label: 'Mastery', optional: true, when: item((d) => d.category === 'weapon') },
        { type: 'text', path: 'range', label: 'Range', optional: true, placeholder: '80/320', when: item((d) => d.category === 'weapon') },
        { type: 'segment', path: 'armorType', label: 'Armor type', options: opts([['light', 'Light'], ['medium', 'Medium'], ['heavy', 'Heavy']]), when: item((d) => d.category === 'armor') },
        { type: 'number', path: 'armorClass', label: 'AC', min: 0, max: 30, when: item((d) => d.category === 'armor') },
        { type: 'editor', editor: 'dexCap', path: 'dexCap', label: 'Dexterity bonus', when: item((d) => d.category === 'armor') },
        { type: 'number', path: 'strengthRequirement', label: 'Strength needed', min: 1, max: 30, when: item((d) => d.category === 'armor') },
        { type: 'check', path: 'stealthDisadvantage', label: 'Disadvantage on Stealth', when: item((d) => d.category === 'armor') },
        { type: 'number', path: 'armorClass', label: 'AC bonus', min: 0, max: 30, when: item((d) => d.category === 'shield') },
      ],
    },
    {
      id: 'cost',
      title: 'Cost and weight',
      fields: [
        { type: 'number', path: 'costGp', label: 'Cost', unit: 'GP', decimal: true, min: 0 },
        { type: 'number', path: 'weight', label: 'Weight', unit: 'lb.', decimal: true, min: 0 },
      ],
    },
  ],
  feat: [
    {
      id: 'key',
      title: 'Key stats',
      key: true,
      fields: [
        { type: 'select', path: 'category', label: 'Category', options: FEAT_CATEGORIES },
        { type: 'text', path: 'prerequisite', label: 'Prerequisite', optional: true, placeholder: 'Level 4+' },
        { type: 'number', path: 'minLevel', label: 'Minimum level', min: 1, max: 20, hint: 'From “Level N+”: the only part of a prerequisite the app checks.' },
        { type: 'check', path: 'repeatable', label: 'Repeatable' },
      ],
    },
    { id: 'increase', title: 'Ability increase', fields: [{ type: 'editor', editor: 'abilityIncrease', path: 'abilityIncrease', label: 'Ability increase', wide: true }] },
    { id: 'text', title: 'Text', fields: [{ type: 'editor', editor: 'span', path: 'text', label: 'Text', wide: true }] },
  ],
  background: [
    {
      id: 'key',
      title: 'Key stats',
      key: true,
      fields: [
        { type: 'editor', editor: 'backgroundAbilities', path: 'abilityScores', label: 'Ability scores', wide: true },
        { type: 'editor', editor: 'originFeat', path: 'feat', label: 'Origin feat', wide: true },
        { type: 'chips', path: 'skills', label: 'Skill proficiencies', options: SKILL_OPTIONS, wide: true },
        { type: 'text', path: 'tool', label: 'Tool proficiency', placeholder: "Tinker's Tools" },
      ],
    },
    { id: 'equipment', title: 'Equipment', fields: [{ type: 'editor', editor: 'packages', path: 'equipment', label: 'Equipment', wide: true }] },
    {
      id: 'older',
      title: 'Languages and feature',
      fields: [
        { type: 'tags', path: 'languages', label: 'Languages', optional: true, hint: 'Suggested for the two language choices, never added.' },
        { type: 'editor', editor: 'legacyFeature', path: 'legacyFeature', label: 'Background feature', wide: true },
      ],
    },
  ],
  species: [
    {
      id: 'key',
      title: 'Key stats',
      key: true,
      fields: [
        { type: 'text', path: 'creatureType', label: 'Creature type', placeholder: 'Humanoid' },
        { type: 'chips', path: 'sizes', label: 'Sizes', options: SIZE_OPTIONS, wide: true },
        { type: 'number', path: 'speed', label: 'Speed', unit: 'ft', min: 0, max: 300 },
        { type: 'number', path: 'darkvision', label: 'Darkvision', unit: 'ft', min: 1, max: 300 },
        { type: 'editor', editor: 'traits', path: 'traits', label: 'Traits', wide: true },
      ],
    },
    {
      id: 'lineages',
      title: 'Lineages',
      fields: [
        { type: 'editor', editor: 'lineageTrait', path: 'lineageTrait', label: 'Trait that offers the lineages' },
        { type: 'editor', editor: 'lineages', path: 'lineages', label: 'Lineages', wide: true },
      ],
    },
    {
      id: 'older',
      title: 'Older edition',
      when: (d) => (d as { format: string }).format !== '2024' || 'legacyAbilityIncreases' in d || 'languages' in d,
      fields: [{ type: 'editor', editor: 'legacyIncreases', path: 'legacyAbilityIncreases', label: 'Set aside', wide: true }],
    },
  ],
  class: [
    {
      id: 'key',
      title: 'Key stats',
      key: true,
      fields: [
        { type: 'select', path: 'hitDie', label: 'Hit die', options: HIT_DICE, numeric: true },
        { type: 'number', path: 'subclassLevel', label: 'Subclass at level', min: 1, max: 3 },
        { type: 'editor', editor: 'primaryAbilities', path: 'primaryAbilities', label: 'Primary ability', wide: true },
        { type: 'chips', path: 'savingThrows', label: 'Saving throws (2)', options: ABILITY_OPTIONS, max: 2, wide: true },
        { type: 'editor', editor: 'casting', path: 'casterType', label: 'Spellcasting', wide: true },
      ],
    },
    {
      id: 'proficiencies',
      title: 'Proficiencies',
      fields: [
        { type: 'editor', editor: 'skillChoices', path: 'skillChoices', label: 'Skills', wide: true },
        { type: 'tags', path: 'weaponProficiencies', label: 'Weapons', suggest: 'weaponPhrases', wide: true },
        { type: 'tags', path: 'armorTraining', label: 'Armor training', suggest: 'armorPhrases', wide: true },
        { type: 'tags', path: 'tools', label: 'Tools', suggest: 'tools', wide: true },
        { type: 'number', path: 'weaponMasteryCount', label: 'Weapon mastery (kinds)', min: 0, max: 10 },
      ],
    },
    { id: 'equipment', title: 'Starting equipment', fields: [{ type: 'editor', editor: 'packages', path: 'startingEquipment', label: 'Starting equipment', wide: true }] },
    {
      id: 'spells',
      title: 'Spell list',
      fields: [
        { type: 'text', path: 'spellListName', label: 'Uses another class’s list', optional: true, placeholder: 'Wizard', hint: 'Leave empty when the class has its own list.' },
        { type: 'tags', path: 'spellNames', label: 'Spells its list prints', optional: true, wide: true },
      ],
    },
    { id: 'features', title: 'Features', fields: [{ type: 'editor', editor: 'features', path: 'features', label: 'Features', wide: true }] },
    { id: 'table', title: 'Level table', fields: [{ type: 'editor', editor: 'levelTable', path: 'levelTable', label: 'Level table', wide: true }] },
  ],
  subclass: [
    {
      id: 'key',
      title: 'Key stats',
      key: true,
      fields: [
        { type: 'editor', editor: 'parentClass', path: 'parentClassId', label: 'Attaches to', wide: true },
        { type: 'text', path: 'summary', label: 'Tagline', optional: true, wide: true },
        { type: 'editor', editor: 'features', path: 'features', label: 'Features', wide: true },
      ],
    },
    { id: 'prepared', title: 'Always-prepared spells', fields: [{ type: 'editor', editor: 'alwaysPrepared', path: 'alwaysPreparedSpells', label: 'Always-prepared spells', wide: true }] },
    {
      id: 'casting',
      title: 'Subclass spellcasting',
      fields: [
        { type: 'select', path: 'casterType', label: 'Spellcasting', options: opts([['third', 'Third caster (grants Spellcasting)']]), optional: true, emptyLabel: 'No spellcasting' },
        { type: 'select', path: 'spellcastingAbility', label: 'Spellcasting ability', options: ABILITY_OPTIONS, optional: true },
      ],
    },
  ],
};

/** Data paths an editor writes besides its own (for "Go to field" and opening the right group). */
export const EDITOR_COVERS: Partial<Readonly<Record<EditorKey, readonly string[]>>> = {
  monsterSize: ['sizes'],
  speeds: ['speed'],
  cr: ['crValue', 'xp', 'pb'],
  rarity: ['rarityText'],
  primaryAbilities: ['primaryAbilityRule'],
  casting: ['spellcastingAbility'],
  parentClass: ['parentClass'],
  legacyIncreases: ['languages'],
};

/** The paths a field spec stands for. */
export function pathsOf(field: FieldSpec): string[] {
  return field.type === 'editor' ? [field.path, ...(EDITOR_COVERS[field.editor] ?? [])] : [field.path];
}

const covers = (field: FieldSpec, path: string) =>
  pathsOf(field).some((p) => p === path || path.startsWith(`${p}.`) || p.startsWith(`${path}.`));

/** The group (of those shown) that holds a data path. */
export function groupOfPath(groups: readonly FormGroup[], path: string): FormGroup | undefined {
  return groups.find((g) => g.fields.some((f) => covers(f, path)));
}

/** The groups that apply to this data (conditional groups and fields filtered). */
export function groupsFor(kind: StructuredKind, data: AnyData): FormGroup[] {
  return FORM_SPECS[kind]
    .filter((g) => !g.when || g.when(data))
    .map((g) => ({ ...g, fields: g.fields.filter((f) => !f.when || f.when(data)) }))
    .filter((g) => g.fields.length > 0);
}

/** A label for a data path, for notices and the proposal diff ("hp" → "HP"). */
export function labelForPath(kind: StructuredKind, path: string): string {
  const root = path.split('.')[0];
  for (const group of FORM_SPECS[kind]) {
    for (const f of group.fields) if (f.path === path) return f.label;
  }
  for (const group of FORM_SPECS[kind]) {
    for (const f of group.fields) if (f.path === root) return f.label;
  }
  if (root === 'name') return 'Name';
  if (root === 'format') return 'Edition';
  return root.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}
