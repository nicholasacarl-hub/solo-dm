/**
 * The review form's draft (spec §4.5): a record's name, its data and (for a subclass) the class it
 * attaches to. Pure helpers: empty drafts for "Fill in yourself", the fields the app writes itself
 * (a monster's speed line and CR value, a gear row's description), friendly issues from DATA_SCHEMAS,
 * and recordFromDraft (the homebrewFromDraft pattern) for saving.
 */
import { DATA_SCHEMAS } from '@/data';
import {
  ABILITIES,
  type CreatureSpeeds,
  type ItemData,
  type MonsterData,
  type StructuredDataByKind,
  type StructuredKind,
  type StructuredRecord,
} from '@/types';

export interface RecordDraft<K extends StructuredKind = StructuredKind> {
  name: string;
  data: StructuredDataByKind[K];
  /** Subclasses: the class option it attaches to (stored on the record, required to accept). */
  parentClassId?: string;
}

export function draftOf<K extends StructuredKind>(record: StructuredRecord<K>): RecordDraft<K> | null {
  if (record.data === null) return null;
  return { name: record.name, data: record.data, ...(record.parentClassId ? { parentClassId: record.parentClassId } : {}) };
}

// ---------------------------------------------------------------------------
// App-written fields
// ---------------------------------------------------------------------------

/** "30 ft., fly 60 ft. (hover)": the walking speed first, then the others in the SRD's order. */
export function speedLine(speeds: CreatureSpeeds): string {
  const parts = [`${speeds.walk ?? 0} ft.`];
  for (const mode of ['burrow', 'climb', 'fly', 'swim'] as const) {
    const ft = speeds[mode];
    if (ft === undefined || ft <= 0) continue;
    parts.push(`${mode} ${ft} ft.${mode === 'fly' && speeds.hover ? ' (hover)' : ''}`);
  }
  return parts.join(', ');
}

export const CR_OPTIONS: readonly string[] = ['0', '1/8', '1/4', '1/2', ...Array.from({ length: 30 }, (_, i) => String(i + 1))];

/** "1/4" → 0.25. */
export function crNumber(cr: string): number {
  const [num, den] = cr.split('/').map(Number);
  return den ? num / den : num;
}

/** XP by challenge rating (SRD 5.2.1, "Experience Points by Challenge Rating"). */
export const XP_BY_CR: Readonly<Record<string, number>> = {
  '0': 10, '1/8': 25, '1/4': 50, '1/2': 100, '1': 200, '2': 450, '3': 700, '4': 1100, '5': 1800, '6': 2300, '7': 2900,
  '8': 3900, '9': 5000, '10': 5900, '11': 7200, '12': 8400, '13': 10000, '14': 11500, '15': 13000, '16': 15000,
  '17': 18000, '18': 20000, '19': 22000, '20': 25000, '21': 33000, '22': 41000, '23': 50000, '24': 62000, '25': 75000,
  '26': 90000, '27': 105000, '28': 120000, '29': 135000, '30': 155000,
};

/** Proficiency bonus by challenge rating (SRD 5.2.1 "Proficiency Bonus by CR"). */
export function pbForCr(cr: string): number {
  const v = crNumber(cr);
  return v < 5 ? 2 : Math.min(9, 2 + Math.floor((Math.ceil(v) - 1) / 4));
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The builder's description for a gear row, in the SRD's patterns ("Martial Melee Weapon", "Heavy Armor: AC 16", "Shield: +2 AC"). */
export function itemDescription(item: ItemData): string | undefined {
  if (item.category === 'weapon' && item.weaponCategory && item.weaponType) {
    return `${cap(item.weaponCategory)} ${cap(item.weaponType)} Weapon`;
  }
  if (item.category === 'armor' && item.armorType && item.armorClass !== undefined) {
    const dex = item.dexCap === null ? ' + Dex modifier' : item.dexCap ? ` + Dex modifier (max ${item.dexCap})` : '';
    return `${cap(item.armorType)} Armor: AC ${item.armorClass}${dex}`;
  }
  if (item.category === 'shield' && item.armorClass !== undefined) return `Shield: +${item.armorClass} AC`;
  return item.description;
}

const ITEM_SHAPE: readonly (keyof ItemData)[] = ['category', 'weaponCategory', 'weaponType', 'armorType', 'armorClass', 'dexCap'];

/** Re-write the fields the app derives, when the fields they come from changed. */
export function withDerived<K extends StructuredKind>(kind: K, prev: StructuredDataByKind[K], next: StructuredDataByKind[K]): StructuredDataByKind[K] {
  if (kind === 'monster') {
    const p = prev as MonsterData;
    let n = next as MonsterData;
    if (JSON.stringify(p.speeds) !== JSON.stringify(n.speeds)) n = { ...n, speed: speedLine(n.speeds) };
    if (p.cr !== n.cr) {
      n = { ...n, crValue: crNumber(n.cr) };
      // XP and PB follow the CR when they were the old CR's (a misread CR fixed in one step).
      if (n.xp === undefined || n.xp === XP_BY_CR[p.cr]) n = { ...n, xp: XP_BY_CR[n.cr] };
      if (n.pb === undefined || n.pb === pbForCr(p.cr)) n = { ...n, pb: pbForCr(n.cr) };
    }
    return n as StructuredDataByKind[K];
  }
  if (kind === 'magic-item') {
    const n = next as StructuredDataByKind['magic-item'];
    const bonuses = n.bonuses;
    if (bonuses && bonuses.ac === undefined && bonuses.acOnlyWhen !== undefined) {
      const { acOnlyWhen: _gone, ...rest } = bonuses;
      return { ...n, bonuses: rest } as StructuredDataByKind[K];
    }
    if (bonuses && Object.keys(bonuses).length === 0) {
      const { bonuses: _none, ...rest } = n;
      return rest as StructuredDataByKind[K];
    }
  }
  if (kind === 'item') {
    const p = prev as ItemData;
    const n = next as ItemData;
    if (ITEM_SHAPE.some((k) => p[k] !== n[k])) {
      const description = itemDescription(n);
      const { description: _old, ...rest } = n;
      return (description ? { ...rest, description } : rest) as StructuredDataByKind[K];
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Empty drafts ("Fill in yourself")
// ---------------------------------------------------------------------------

const proficiencyAt = (level: number) => 2 + Math.floor((level - 1) / 4);

/** A starting point for a kind: valid where a default is safe, blank where the player must decide. */
export function emptyData<K extends StructuredKind>(kind: K, ctx: { entryId: string; paragraphs: number }): StructuredDataByKind[K] {
  const span = { entryIds: [ctx.entryId], from: 1, to: Math.max(1, ctx.paragraphs) };
  const format = '2024' as const;
  const byKind: { [P in StructuredKind]: () => StructuredDataByKind[P] } = {
    monster: () => ({
      format, size: 'Medium', type: '', ac: 10, hp: 1, speed: '30 ft.', speeds: { walk: 30 }, initiative: 0, reachFt: 5,
      cr: '0', crValue: 0, abilities: Object.fromEntries(ABILITIES.map((a) => [a, 10])) as MonsterData['abilities'], legendary: false,
    }),
    spell: () => ({ format, level: 1, school: 'Evocation', classes: [], ritual: false, concentration: false, castingTime: 'Action', range: '', duration: '' }),
    'magic-item': () => ({ format, category: 'wondrous-item', rarity: 'uncommon', attunement: false }),
    item: () => ({ format, category: 'gear' }),
    feat: () => ({ format, category: 'general', repeatable: false, text: span }),
    background: () => ({ format, abilityScores: [], feat: '', skills: [], tool: '', equipment: [] }),
    species: () => ({ format, creatureType: 'Humanoid', sizes: ['Medium'], speed: 30, traits: [] }),
    class: () => ({
      format, hitDie: 8, primaryAbilities: ['str'], primaryAbilityRule: 'all', savingThrows: ['str', 'con'],
      skillChoices: { count: 2, from: [] }, weaponProficiencies: ['Simple weapons'], armorTraining: [], tools: [],
      casterType: 'none', weaponMasteryCount: 0, startingEquipment: [], subclassLevel: 3, features: [],
      levelTable: Array.from({ length: 20 }, (_, i) => ({ level: i + 1, proficiencyBonus: proficiencyAt(i + 1), features: '—' })),
    }),
    subclass: () => ({ format, parentClass: '', summary: '', features: [] }),
  };
  return byKind[kind]() as StructuredDataByKind[K];
}

// ---------------------------------------------------------------------------
// Issues (DATA_SCHEMAS, shown on the field)
// ---------------------------------------------------------------------------

interface IssueLike {
  code: string;
  path: PropertyKey[];
  message: string;
  origin?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  expected?: string;
  divisor?: number | bigint;
}

function friendly(issue: IssueLike): string {
  switch (issue.code) {
    case 'too_small':
      if (issue.origin === 'string') return Number(issue.minimum) <= 1 ? 'Required.' : `At least ${issue.minimum} characters.`;
      if (issue.origin === 'array') return Number(issue.minimum) <= 1 ? 'Add at least one.' : `Add at least ${issue.minimum}.`;
      return `At least ${issue.minimum}.`;
    case 'too_big':
      if (issue.origin === 'string') return `At most ${issue.maximum} characters.`;
      if (issue.origin === 'array') return `At most ${issue.maximum}.`;
      return `At most ${issue.maximum}.`;
    case 'invalid_type':
      return issue.expected === 'number' || issue.expected === 'int' ? 'Enter a whole number.' : 'Required.';
    case 'invalid_value':
      return 'Pick one of the options.';
    case 'not_multiple_of':
      return `Use a multiple of ${issue.divisor}.`;
    default:
      return issue.message;
  }
}

/** DATA_SCHEMAS problems by data path ("abilities.str" → "At most 30."); the first issue per path. */
export function issuesOf(kind: StructuredKind, data: unknown): Record<string, string> {
  const parsed = DATA_SCHEMAS[kind].safeParse(data);
  if (parsed.success) return {};
  const out: Record<string, string> = {};
  for (const issue of parsed.error.issues as IssueLike[]) {
    const path = issue.path.map(String).join('.') || '_';
    out[path] ??= friendly(issue);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

/**
 * The record a saved draft becomes (pure): the new name, data and parent class, marked edited; a record
 * that had no data becomes the player's own entry. Warnings and confidence are recomputed when it is
 * saved (reviewActions.saveRecordEdit), not here.
 */
export function recordFromDraft<K extends StructuredKind>(draft: RecordDraft<K>, record: StructuredRecord<K>, now: number): StructuredRecord<K> {
  const name = draft.name.trim() || record.name;
  const next: StructuredRecord<K> = {
    ...record,
    name,
    data: draft.data,
    edited: true,
    origin: record.data === null ? 'manual' : record.origin,
    updatedAt: now,
  };
  if (record.kind === 'subclass') {
    if (draft.parentClassId) next.parentClassId = draft.parentClassId;
    else delete next.parentClassId;
  }
  return next;
}
