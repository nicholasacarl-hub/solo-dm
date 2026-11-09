/**
 * The class normalizer (spec §3.9, §3.9.1), shared by the offline parser and Claude's answers: core
 * traits through the build script's helpers (so the strings match the builder's regexes), the level
 * table keyed like builder.json, features as spans, and the older-format adaptations of §5.6.
 *
 * Owner: E4. Pure.
 */
import { nameKey } from '@/lib/id';
import type { Adaptation, ClassData, RecordWarning } from '@/types';
import type { Wire } from '../wire';
import { adaptation } from '../adaptations';
import { blockText } from '../paragraphs';
import {
  equipmentPackages,
  levelTableKey,
  parseAbilityList,
  parseArmorTraining,
  parseSkillChoices,
  parseWeaponProficiencies,
  plainText,
  runInParts,
  typeLevelTable,
} from '../parse/srdRulesOptions';
import { cleanOptionName } from './background';
import type { NormalizeContext, Normalized } from './index';
import { beginOption, defaultUsed, finishOption, optionNameOf, spanWarnings } from './feat';
import { featuresOf } from './subclass';
import { gradeConfidence, limitText, missing, warning } from './text';

const FIELDS = {
  primaryAbilityText: 'primaryAbilities',
  hitDieText: 'hitDie',
  savingThrowsText: 'savingThrows',
  skillsText: 'skillChoices',
  weaponsText: 'weaponProficiencies',
  armorText: 'armorTraining',
  toolsText: 'tools',
  equipmentText: 'startingEquipment',
  preparedSpellsText: 'levelTable',
  spellListText: 'spellListName',
} as const;

/** The 2024 Prepared Spells columns by caster type (the SRD Cleric's and Paladin's, builder.json). */
export const PREPARED_2024: Readonly<Record<'full' | 'half', readonly number[]>> = {
  full: [4, 5, 6, 7, 9, 10, 11, 12, 14, 15, 16, 16, 17, 17, 18, 18, 19, 20, 21, 22],
  half: [2, 3, 4, 5, 6, 6, 7, 7, 9, 9, 10, 10, 11, 11, 12, 12, 14, 14, 15, 15],
};

const PB = (level: number) => 2 + Math.floor((level - 1) / 4);

interface TableResult {
  rows: ClassData['levelTable'];
  /** The prepared-spells column was written from the 2024 progression. */
  prepared2024: boolean;
}

/** §3.9.1: headers through levelTableKey, cells through typeLevelTable; level and PB synthesized; 20 rows. */
function levelTableOf(wire: Wire<'class'>, w: RecordWarning[]): TableResult {
  const columns: { key: string; values: string[] }[] = [];
  for (const col of wire.levelTable) {
    const key = levelTableKey(col.header);
    if (key === 'level') continue;
    if (col.values.length !== 20) {
      w.push(warning('out-of-range', 'block', `The ${plainText(col.header) || 'unnamed'} column has ${col.values.length} rows; a class table has 20.`, 'levelTable'));
      continue;
    }
    if (columns.some((c) => c.key === key)) continue;
    columns.push({ key, values: col.values.map((v) => plainText(String(v))) });
  }
  if (columns.length + 1 > 16) w.push(warning('out-of-range', 'block', 'The class table has more than 16 columns.', 'levelTable'));
  const raw: Record<string, string | number>[] = Array.from({ length: 20 }, (_, i) => {
    const row: Record<string, string | number> = { level: i + 1 };
    for (const c of columns.slice(0, 15)) row[c.key] = c.values[i];
    return row;
  });
  let rows = typeLevelTable(raw);
  if (!columns.some((c) => c.key === 'proficiencyBonus')) {
    rows = rows.map((r) => ({ ...r, proficiencyBonus: PB(Number(r.level)) }));
    w.push(defaultUsed('levelTable', 'No Proficiency Bonus column: the app filled in the standard one.'));
  } else if (rows.some((r) => r.proficiencyBonus !== PB(Number(r.level)))) {
    w.push(warning('cross-check', 'warn', "The Proficiency Bonus column isn't +2 to +6 by level: check it.", 'levelTable'));
  }
  const kind = wire.casterType === 'full' || wire.casterType === 'half' ? wire.casterType : null;
  const hasPrepared = columns.some((c) => c.key === 'preparedSpells' || c.key === 'spellsKnown');
  if (wire.preparedSpellsText.trim() && !hasPrepared && kind) {
    rows = rows.map((r, i) => ({ ...r, preparedSpells: PREPARED_2024[kind][i] }));
    return { rows, prepared2024: true };
  }
  return { rows, prepared2024: false };
}

/** "D8 per Wickwright level" → 8 (6, 8, 10 or 12). */
function hitDieOf(text: string): ClassData['hitDie'] | null {
  const n = Number(/d(\d+)/i.exec(text)?.[1]);
  return n === 6 || n === 8 || n === 10 || n === 12 ? n : null;
}

/** "the Wizard spell list" → "Wizard". */
function spellListNameOf(text: string, className: string): string | undefined {
  const t = plainText(text);
  if (!t) return undefined;
  const name = (/\bthe (.+?) spell list\b/i.exec(t)?.[1] ?? t.replace(/\s*spell list\s*$/i, '')).trim();
  return name && nameKey(name) !== nameKey(className) ? name : undefined;
}

/** Row 1's mastery column, else "mastery properties of N kinds of" in a level-1 feature's text. */
function weaponMasteryOf(rows: ClassData['levelTable'], wire: Wire<'class'>, ctx: NormalizeContext): number {
  const fromTable = Object.entries(rows[0] ?? {}).find(([k]) => /mastery/i.test(k))?.[1];
  if (typeof fromTable === 'number') return Math.max(0, Math.min(10, fromTable));
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  for (const f of wire.features) {
    if (f.level !== 1) continue;
    const block = ctx.blocks.find((b) => b.id.toLowerCase() === f.text.block.toLowerCase());
    const text = block ? block.paragraphs.slice(Math.max(0, f.text.from - 1), f.text.to).join(' ') : '';
    const m = /mastery properties of (\w+) kinds? of/i.exec(text);
    if (m) return words[m[1].toLowerCase()] ?? (Number(m[1]) || 0);
  }
  return 0;
}

/** A Fighting Style feature that prints its own options (≥ 2 run-ins): offered next to the feats (§5.6). */
function hasInlineFightingStyles(data: Pick<ClassData, 'features'>, ctx: NormalizeContext): boolean {
  return data.features.some((f) => {
    if (!/^fighting style$/i.test(f.name.trim())) return false;
    const text = blockText(f.text.entryIds, ctx.entriesById);
    if (text === null) return false;
    return runInParts(text.split(/\n{2,}/)).length >= 2;
  });
}

/** §5.6 notes a class can carry. */
export function classAdaptations(
  name: string,
  data: Pick<ClassData, 'subclassLevel' | 'casterType' | 'levelTable' | 'features'>,
  ctx: NormalizeContext,
  prepared2024: boolean,
): Adaptation[] {
  const out: Adaptation[] = [];
  if (prepared2024 && (data.casterType === 'full' || data.casterType === 'half')) out.push(adaptation('prepared-2024-column', { name, caster: data.casterType }));
  if (data.casterType === 'half' && data.levelTable[0] && data.levelTable[0].slot1 === 0) out.push(adaptation('half-caster-slots-2024', { name }));
  if (data.subclassLevel === 1) out.push(adaptation('subclass-at-level-1', { name }));
  if (hasInlineFightingStyles(data, ctx)) out.push(adaptation('fighting-style-inline', { name }));
  return out;
}

function crossChecks(data: ClassData): RecordWarning[] {
  const out: RecordWarning[] = [];
  const named = data.features.find((f) => / Subclass$/i.test(f.name));
  if (named && named.level !== data.subclassLevel) {
    out.push(warning('cross-check', 'warn', `${named.name} is a level ${named.level} feature, but the subclass level is ${data.subclassLevel}.`, 'subclassLevel'));
  }
  if (data.features.length > 60) out.push(warning('out-of-range', 'block', `${data.features.length} features is more than the 60 the app keeps.`, 'features'));
  if (data.spellNames && data.spellNames.length > 400) out.push(warning('out-of-range', 'block', 'The spell list names more than 400 spells.', 'spellNames'));
  return out;
}

export function normalizeClass(wire: Wire<'class'>, ctx: NormalizeContext): Normalized<'class'> {
  const base = beginOption('class', wire, ctx, FIELDS);
  const w = base.warnings;
  const hitDie = hitDieOf(wire.hitDieText);
  if (hitDie === null) w.push(warning('missing', 'block', "Its Hit Point Die (d6, d8, d10 or d12) wasn't found.", 'hitDie'));
  const primaryAbilities = [...new Set(parseAbilityList(wire.primaryAbilityText))];
  if (!primaryAbilities.length) w.push(missing('primaryAbilities', 'Its primary ability'));
  const savingThrows = [...new Set(parseAbilityList(wire.savingThrowsText))];
  if (savingThrows.length !== 2) {
    w.push(warning('cross-check', 'block', `A class has two saving throw proficiencies; ${savingThrows.length} were found.`, 'savingThrows'));
  }
  const skills = parseSkillChoices(plainText(wire.skillsText));
  if (!skills) w.push(warning('cross-check', 'warn', "Its skill choices couldn't be read: check them.", 'skillChoices'));
  for (const name of skills?.unknown ?? []) w.push(warning('cross-check', 'warn', `“${name}” isn't a skill the app knows.`, 'skillChoices'));
  const subclassLevel = Number.isInteger(wire.subclassLevel) && wire.subclassLevel >= 1 && wire.subclassLevel <= 3 ? wire.subclassLevel : 3;
  if (subclassLevel !== wire.subclassLevel) {
    w.push(warning('cross-check', 'warn', `The subclass level ${wire.subclassLevel || 'wasn’t found'}; the app used 3.`, 'subclassLevel'));
  }
  const features = featuresOf(
    wire.features.filter((f) => !/^subclass feature$/i.test(f.name.trim())),
    ctx,
    w,
    60,
  );
  if (!features.length) w.push(missing('features', 'Its features', 'warn'));
  const table = levelTableOf(wire, w);
  const spellListName = spellListNameOf(wire.spellListText, base.name);
  const hint = ctx.spellLists.find((h) => nameKey(h.className) === nameKey(spellListName ?? base.name));
  const ability = wire.spellcastingAbility === 'none' ? undefined : wire.spellcastingAbility;
  if (wire.casterType !== 'none' && !ability) w.push(warning('missing', 'warn', 'It casts spells, but no spellcasting ability was found.', 'spellcastingAbility'));
  const tools = cleanOptionName(plainText(wire.toolsText));
  const data: ClassData | null =
    hitDie !== null && primaryAbilities.length && savingThrows.length === 2
      ? {
          format: wire.format,
          hitDie,
          primaryAbilities,
          primaryAbilityRule: /\bor\b/i.test(wire.primaryAbilityText) ? 'any' : 'all',
          savingThrows,
          skillChoices: { count: Math.min(18, skills?.count ?? 0), from: skills?.from ?? [] },
          weaponProficiencies: wire.weaponsText.trim() ? parseWeaponProficiencies(wire.weaponsText).filter(Boolean) : [],
          armorTraining: wire.armorText.trim() ? parseArmorTraining(wire.armorText) : [],
          tools: tools ? [limitText(tools, 400, 'tools', w)] : [],
          casterType: wire.casterType,
          ...(ability ? { spellcastingAbility: ability } : {}),
          ...(spellListName ? { spellListName: limitText(spellListName, 120, 'spellListName', w) } : {}),
          ...(hint?.spellNames.length ? { spellNames: [...hint.spellNames] } : {}),
          weaponMasteryCount: weaponMasteryOf(table.rows, wire, ctx),
          startingEquipment: equipmentPackages(wire.equipmentText).slice(0, 6),
          subclassLevel,
          features,
          levelTable: table.rows,
        }
      : null;
  if (data) w.push(...crossChecks(data));
  if (hint) w.push(warning('spell-list', 'info', `Its spell list comes from the book's “${hint.className} Spell List”.`, 'spellNames'));
  return finishOption('class', base, data, data ? classAdaptations(base.name, data, ctx, table.prepared2024) : [], {
    matchesKind: wire.matchesKind,
    keyFields: ['hitDieText', 'savingThrowsText', 'casterType', 'subclassLevel', 'features', 'levelTable'],
    ctx,
  });
}

export function validateClass(data: ClassData, ctx: NormalizeContext, name?: string): Pick<Normalized<'class'>, 'warnings' | 'adaptations' | 'confidence'> {
  const className = optionNameOf(ctx, name);
  const warnings = [...crossChecks(data), ...spanWarnings(data.features.map((f, i) => ({ name: f.name, text: f.text, field: `features[${i}]` })), ctx)];
  if (data.levelTable.some((r, i) => r.proficiencyBonus !== undefined && Number(r.proficiencyBonus) !== PB(i + 1))) {
    warnings.push(warning('cross-check', 'warn', "The Proficiency Bonus column isn't +2 to +6 by level: check it.", 'levelTable'));
  }
  const prepared = data.levelTable.map((r) => Number(r.preparedSpells));
  const kind = data.casterType === 'full' || data.casterType === 'half' ? data.casterType : null;
  const prepared2024 = data.format === '2014' && kind !== null && prepared.every((n, i) => n === PREPARED_2024[kind][i]);
  return {
    warnings,
    adaptations: classAdaptations(className, data, ctx, prepared2024),
    confidence: gradeConfidence('class', warnings, { matchesKind: true, missingKey: false }),
  };
}
