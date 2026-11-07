/**
 * Spell options for the builder, read from rules-index entries (kind 'spell'). Entry `data` fields
 * are preferred (level, classes, ritual, concentration); the one-line summary
 * ("Level 1 Evocation (Sorcerer, Wizard)") is the fallback.
 */
import type { Attack, ClassOption, CompendiumEntry, KnownSpell } from '@/types';
import { nameKey, newId } from '@/lib/id';

export interface SpellInfo {
  id: string;
  name: string;
  /** 0 = cantrip. */
  level: number;
  school?: string;
  ritual: boolean;
  concentration: boolean;
  /** Normalized class keys ("wizard", "cleric"). */
  classes: string[];
  entry: CompendiumEntry;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** "srd:class:wizard", "srd-2024_wizard", "Wizard" -> "wizard". */
export function classKey(idOrName: string): string {
  const last = idOrName.split(/[:/_]/).pop() ?? idOrName;
  return nameKey(last);
}

function levelFrom(entry: CompendiumEntry): number {
  const raw = entry.data?.level;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
  const summary = entry.summary ?? '';
  if (/cantrip/i.test(summary)) return 0;
  const match = /level\s*(\d)/i.exec(summary);
  return match ? Number(match[1]) : 0;
}

function classesFrom(entry: CompendiumEntry): string[] {
  const raw = entry.data?.classes;
  if (Array.isArray(raw)) return raw.filter((c): c is string => typeof c === 'string').map(classKey);
  if (typeof raw === 'string') return raw.split(/,\s*/).map(classKey);
  const paren = /\(([^)]+)\)\s*$/.exec(entry.summary ?? '');
  return paren ? paren[1].split(/,\s*/).map(classKey) : [];
}

export function spellInfo(entry: CompendiumEntry): SpellInfo {
  const data = entry.data ?? {};
  const summary = entry.summary ?? '';
  return {
    id: entry.id,
    name: entry.name,
    level: levelFrom(entry),
    school: str(data.school) ?? /(?:level\s*\d\s+|^)(\w+)/i.exec(summary.replace(/cantrip/i, ''))?.[1],
    ritual: bool(data.ritual) ?? /ritual/i.test(summary),
    concentration: bool(data.concentration) ?? /concentration/i.test(`${summary} ${str(data.duration) ?? ''}`),
    classes: classesFrom(entry),
    entry,
  };
}

/** Spells on a class's list (by class name or id), sorted by name. */
export function spellsForClass(spells: SpellInfo[], className: string, level?: number): SpellInfo[] {
  const key = classKey(className);
  return spells
    .filter((s) => s.classes.includes(key) && (level === undefined || s.level === level))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function spellsForClassOption(spells: SpellInfo[], cls: ClassOption, level?: number): SpellInfo[] {
  const byName = spellsForClass(spells, cls.name, level);
  return byName.length ? byName : spellsForClass(spells, cls.id, level);
}

export function findSpellByName(spells: SpellInfo[], name: string): SpellInfo | undefined {
  const key = nameKey(name);
  return spells.find((s) => nameKey(s.name) === key);
}

/** A KnownSpell for the sheet. Unknown names get a generated id (the sheet looks those up by name). */
export function knownSpell(
  spell: SpellInfo | undefined,
  fallback: { name: string; level: number },
  extra: Partial<KnownSpell> = {},
): KnownSpell {
  return {
    id: spell?.id ?? newId(),
    name: spell?.name ?? fallback.name,
    level: spell?.level ?? fallback.level,
    prepared: true,
    ...(spell?.ritual ? { ritual: true } : {}),
    ...(spell?.concentration ? { concentration: true } : {}),
    ...extra,
  };
}

/** An attack for a spell-attack cantrip such as Fire Bolt ("Make a ranged spell attack … 1d10 Fire damage"). */
export function spellAttack(spell: SpellInfo): Attack | null {
  const text = spell.entry.text;
  const kind = /make an? (melee|ranged) spell attack/i.exec(text);
  if (!kind) return null;
  const damage = /(\d+d\d+)\s+(\w+)\s+damage/i.exec(text);
  if (!damage) return null;
  const rangeData = str(spell.entry.data?.range);
  const rangeText = rangeData ?? /\*\*Range:\*\*\s*([^\n]+)/i.exec(text)?.[1] ?? /Range:\s*([^\n]+)/i.exec(text)?.[1];
  return {
    id: newId(),
    name: spell.name,
    ability: 'spell',
    proficient: true,
    damage: damage[1],
    damageType: damage[2].toLowerCase(),
    addAbilityToDamage: false,
    range: rangeText ? rangeText.replace(/\s*feet\b/i, ' ft.').trim() : kind[1].toLowerCase() === 'melee' ? 'Touch' : undefined,
    notes: 'Cantrip',
  };
}
