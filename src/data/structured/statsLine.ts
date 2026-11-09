/**
 * The stats line (spec §6.7, pure): one line per kind — "Reviewed stats: Large Dragon · AC 17 (natural
 * armor) · …" — then "Adapted for 2024: …" when the entry has adaptation notes. The same text the DM's
 * lookups carry (inside the imported-content wrapper) and the review page previews.
 *
 * It reads the materialized entry's `data` (materialize.ts writes it from the accepted record), defensively:
 * a field that isn't there is left out, never guessed. Every word here is written by the app.
 */
import { ABILITY_NAMES, SKILL_NAMES, type Ability, type CompendiumEntry, type Skill } from '@/types';
import { costText, isReviewedImport, signed } from './materialize';

type Data = Record<string, unknown>;

const str = (d: Data, k: string): string | undefined => (typeof d[k] === 'string' && (d[k] as string).trim() ? (d[k] as string).trim() : undefined);
const num = (d: Data, k: string): number | undefined => (typeof d[k] === 'number' && Number.isFinite(d[k]) ? (d[k] as number) : undefined);
const strings = (d: Data, k: string): string[] => (Array.isArray(d[k]) ? (d[k] as unknown[]).filter((v): v is string => typeof v === 'string' && v.trim() !== '') : []);
const obj = (d: Data, k: string): Data | undefined => (d[k] && typeof d[k] === 'object' && !Array.isArray(d[k]) ? (d[k] as Data) : undefined);
const join = (parts: readonly (string | undefined | false)[], sep = ' · ') => parts.filter((p): p is string => Boolean(p)).join(sep);

const ABILITY_SHORT = (a: Ability) => a.charAt(0).toUpperCase() + a.slice(1);
const abilityName = (a: string): string => ABILITY_NAMES[a as Ability] ?? a;
const skillName = (s: string): string => SKILL_NAMES[s as Skill] ?? s;
const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** "CR 3 (700 XP; PB +2)". */
function crText(d: Data): string | undefined {
  const cr = str(d, 'cr');
  if (!cr) return undefined;
  const xp = num(d, 'xp');
  const pb = num(d, 'pb');
  const extra = join([xp !== undefined && `${xp.toLocaleString('en-US')} XP`, pb !== undefined && `PB ${signed(pb)}`], '; ');
  return `CR ${cr}${extra ? ` (${extra})` : ''}`;
}

function monsterLine(d: Data): string {
  const sizes = strings(d, 'sizes');
  const size = sizes.length > 1 ? sizes.join(' or ') : str(d, 'size');
  const tags = strings(d, 'tags');
  const type = str(d, 'type');
  const ac = num(d, 'ac');
  const hp = num(d, 'hp');
  const initiative = num(d, 'initiative');
  const reach = num(d, 'reachFt');
  return join([
    join([size, type, tags.length ? `(${tags.join(', ')})` : undefined], ' '),
    ac !== undefined && `AC ${ac}${str(d, 'acNote') ? ` (${str(d, 'acNote')})` : ''}`,
    hp !== undefined && `HP ${hp}${str(d, 'hitDice') ? ` (${str(d, 'hitDice')})` : ''}`,
    str(d, 'speed') && `Speed ${str(d, 'speed')}`,
    initiative !== undefined && `Initiative ${signed(initiative)}`,
    crText(d),
    reach !== undefined && `Reach ${reach} ft.`,
    d.legendary === true && 'Legendary Actions',
  ]);
}

function areaText(d: Data): string | undefined {
  const area = obj(d, 'area');
  if (!area) return undefined;
  const shape = str(area, 'shape');
  const size = num(area, 'size');
  if (!shape || size === undefined) return undefined;
  const width = num(area, 'widthFt');
  const height = num(area, 'heightFt');
  const more = join([width !== undefined && `${width} ft wide`, height !== undefined && `${height} ft high`], ', ');
  return `${size}-ft ${shape}${more ? ` (${more})` : ''}`;
}

function spellLine(d: Data): string {
  const level = num(d, 'level');
  const school = str(d, 'school') ?? '';
  const head = level === 0 ? `${school} cantrip`.trim() : level !== undefined ? `Level ${level} ${school}`.trim() : school;
  const save = str(d, 'saveAbility');
  const attack = str(d, 'attack');
  const damage = str(d, 'damage');
  const types = strings(d, 'damageTypes');
  return join([
    join([head, d.ritual === true && '(ritual)'], ' '),
    str(d, 'castingTime'),
    str(d, 'range'),
    areaText(d),
    d.concentration === true && 'Concentration',
    save && `${save.toUpperCase()} save`,
    attack && `${attack} spell attack`,
    damage && join([damage, types.join('/') || undefined], ' '),
    strings(d, 'classes').join(', ') || undefined,
  ]);
}

const MAGIC_CATEGORY: Readonly<Record<string, string>> = {
  'wondrous-item': 'Wondrous item', armor: 'Armor', shield: 'Shield', weapon: 'Weapon', ammunition: 'Ammunition', potion: 'Potion',
  ring: 'Ring', rod: 'Rod', scroll: 'Scroll', staff: 'Staff', wand: 'Wand', other: 'Magic item',
};

/** "+1 AC and saving throws while worn", "+2 attack and damage rolls". */
function bonusText(d: Data): string | undefined {
  const b = obj(d, 'bonuses');
  if (!b) return undefined;
  const ac = num(b, 'ac');
  const saves = num(b, 'savingThrows');
  const attack = num(b, 'attack');
  const damage = num(b, 'damage');
  const when = str(b, 'acOnlyWhen');
  const worn: string[] = [];
  if (ac !== undefined && saves !== undefined && ac === saves) worn.push(`${signed(ac)} AC and saving throws`);
  else {
    if (ac !== undefined) worn.push(`${signed(ac)} AC`);
    if (saves !== undefined) worn.push(`${signed(saves)} saving throws`);
  }
  const condition = when === 'no-armor' ? ' (AC without armor)' : when === 'no-armor-no-shield' ? ' (AC without armor or a shield)' : '';
  const rolls =
    attack !== undefined && damage !== undefined && attack === damage
      ? `${signed(attack)} attack and damage rolls`
      : join([attack !== undefined && `${signed(attack)} attack rolls`, damage !== undefined && `${signed(damage)} damage rolls`], ', ') || undefined;
  return join([worn.length ? `${worn.join(', ')} while worn${condition}` : undefined, rolls], ', ') || undefined;
}

function magicItemLine(d: Data): string {
  const category = str(d, 'category') ?? 'other';
  const base = str(d, 'baseItem');
  const rarity = str(d, 'rarity');
  const attunement = d.attunement;
  const charges = num(d, 'charges');
  const kind = `${MAGIC_CATEGORY[category] ?? 'Magic item'}${base ? ` (${base})` : ''}`;
  const rarityWords = rarity === 'varies' ? (str(d, 'rarityText') ?? 'rarity varies').toLowerCase() : rarity;
  const attune = attunement === true ? 'requires attunement' : typeof attunement === 'string' && attunement.trim() ? `requires attunement ${attunement.trim()}` : undefined;
  return join([join([kind, rarityWords, attune], ', '), bonusText(d), charges !== undefined && `${charges} charges`]);
}

function weightText(d: Data): string | undefined {
  const w = num(d, 'weight');
  return w !== undefined ? `${w} lb.` : undefined;
}

/** "AC 14 + Dex (max 2)", "AC 16", "+2 AC". */
function armorText(d: Data): string | undefined {
  const ac = num(d, 'armorClass');
  if (ac === undefined) return undefined;
  if (str(d, 'category') === 'shield') return `${signed(ac)} AC`;
  const cap = d.dexCap;
  const dex = cap === null || cap === undefined ? ' + Dex' : typeof cap === 'number' && cap > 0 ? ` + Dex (max ${cap})` : '';
  return `AC ${ac}${dex}`;
}

const GEAR_CATEGORY: Readonly<Record<string, string>> = { gear: 'Adventuring gear', tool: 'Tool', pack: 'Equipment pack' };

function itemLine(d: Data): string {
  const category = str(d, 'category');
  const cost = num(d, 'costGp');
  const price = join([cost !== undefined && costText(cost), weightText(d)], ', ') || undefined;
  if (category === 'weapon') {
    const props = strings(d, 'properties');
    const range = str(d, 'range');
    return join([
      `${capitalize(str(d, 'weaponCategory') ?? '')} ${str(d, 'weaponType') ?? ''} weapon`.replace(/\s+/g, ' ').trim(),
      join([str(d, 'damage'), str(d, 'damageType')], ' ') || undefined,
      props.length ? props.join(', ') : undefined,
      range && !props.some((p) => p.includes(range)) && `range ${range}`,
      str(d, 'mastery') && `mastery ${str(d, 'mastery')}`,
      price,
    ]);
  }
  if (category === 'armor' || category === 'shield') {
    const strength = num(d, 'strengthRequirement');
    return join([
      category === 'shield' ? 'Shield' : `${capitalize(str(d, 'armorType') ?? '')} armor`.trim(),
      armorText(d),
      strength !== undefined && `Str ${strength}`,
      d.stealthDisadvantage === true && 'Stealth disadvantage',
      price,
    ]);
  }
  return join([GEAR_CATEGORY[category ?? ''] ?? 'Gear', price]);
}

const FEAT_CATEGORY: Readonly<Record<string, string>> = {
  origin: 'Origin feat', general: 'General feat', 'fighting-style': 'Fighting Style feat', 'epic-boon': 'Epic Boon feat',
};

function featLine(d: Data): string {
  const inc = obj(d, 'abilityIncrease');
  const incAbilities = inc ? strings(inc, 'abilities') : [];
  const amount = inc ? num(inc, 'amount') : undefined;
  return join([
    FEAT_CATEGORY[str(d, 'category') ?? ''] ?? 'Feat',
    str(d, 'prerequisite') && `Prerequisite: ${str(d, 'prerequisite')}`,
    incAbilities.length && amount !== undefined ? `${signed(amount)} ${incAbilities.map(abilityName).join(' or ')}` : undefined,
    d.repeatable === true && 'repeatable',
  ]);
}

function backgroundLine(d: Data): string {
  const abilities = strings(d, 'abilityScores');
  const feat = str(d, 'feat');
  return join([
    abilities.length ? abilities.map((a) => ABILITY_SHORT(a as Ability)).join(', ') : 'Any three abilities',
    feat ? `Origin feat ${feat}` : 'Origin feat of your choice',
    strings(d, 'skills').map(skillName).join(', ') || undefined,
    str(d, 'tool'),
  ]);
}

function speciesLine(d: Data): string {
  const speed = num(d, 'speed');
  const darkvision = num(d, 'darkvision');
  const lineages = strings(d, 'lineages');
  return join([
    join([strings(d, 'sizes').join(' or ') || undefined, str(d, 'creatureType')], ' ') || undefined,
    speed !== undefined && `Speed ${speed} ft.`,
    darkvision !== undefined && `Darkvision ${darkvision} ft.`,
    lineages.length ? `lineages ${lineages.join(', ')}` : undefined,
  ]);
}

const CASTER: Readonly<Record<string, string>> = { full: 'full caster', half: 'half caster', third: 'third caster', pact: 'Pact Magic' };

function classLine(d: Data): string {
  const hitDie = num(d, 'hitDie');
  const saves = strings(d, 'savingThrows');
  const caster = str(d, 'casterType');
  const ability = str(d, 'spellcastingAbility');
  const subclassLevel = num(d, 'subclassLevel');
  return join([
    hitDie !== undefined && `d${hitDie} Hit Die`,
    saves.length ? `saves ${saves.map((s) => s.toUpperCase()).join(', ')}` : undefined,
    caster && caster !== 'none' ? `${CASTER[caster] ?? caster}${ability ? ` (${abilityName(ability)})` : ''}` : 'no spellcasting',
    subclassLevel !== undefined && `subclass at level ${subclassLevel}`,
  ]);
}

function subclassLine(d: Data): string {
  const levels = [...new Set((Array.isArray(d.featureLevels) ? d.featureLevels : []).filter((n): n is number => typeof n === 'number'))].sort((a, b) => a - b);
  return join([
    `${str(d, 'class') ?? 'Class'} subclass`,
    levels.length ? `features at level${levels.length > 1 ? 's' : ''} ${levels.join(', ')}` : undefined,
  ]);
}

const LINES: Readonly<Record<string, (d: Data) => string>> = {
  monster: monsterLine,
  spell: spellLine,
  'magic-item': magicItemLine,
  item: itemLine,
  feat: featLine,
  background: backgroundLine,
  species: speciesLine,
  class: classLine,
  subclass: subclassLine,
};

/** '' for anything that isn't a reviewed import (SRD entries, raw chunks). */
export function statsLine(entry: CompendiumEntry): string {
  if (!isReviewedImport(entry)) return '';
  const line = LINES[entry.kind];
  if (!line) return '';
  const data = entry.data ?? {};
  const body = line(data);
  const notes = strings(data, 'adaptations');
  return [body ? `Reviewed stats: ${body}` : '', notes.length ? `Adapted for 2024: ${notes.join(' ')}` : ''].filter(Boolean).join('\n');
}
