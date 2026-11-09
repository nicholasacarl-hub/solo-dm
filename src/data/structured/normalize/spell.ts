/**
 * The spell normalizer (spec §3.9): level and school checked against the printed level line, classes
 * from the excerpt or the book's "<Class> Spells" list, ritual and Concentration from the casting time
 * and duration (SRD 5.2.1 "Spells": Casting Time, Duration › Concentration), the area through
 * engine/areas.ts parseAreaText, the first damage and a cantrip's damage by character level.
 *
 * Owner: E2. Pure.
 */
import { nameKey } from '@/lib/id';
import { parseAreaText } from '@/engine/areas';
import type { RecordWarning, SpellArea, SpellData, SpellSchool } from '@/types';
import { SPELL_LINE } from '../parse/spell';
import type { SpellListHint } from '../segment';
import type { Wire } from '../wire';
import type { NormalizeContext, Normalized } from './index';
import { beginNormalize, finishNormalize, gradeConfidence, missing, warning } from './text';

export const SPELL_FIELDS: Readonly<Record<string, string>> = {
  levelText: 'level', classesText: 'classes', castingTimeText: 'castingTime', rangeText: 'range', componentsText: 'components',
  durationText: 'duration', areaText: 'area', damageText: 'damage', cantripScalingText: 'damageByCharacterLevel',
};
const KEY_FIELDS = ['levelText', 'castingTimeText', 'rangeText', 'durationText'];

const SCHOOLS: readonly SpellSchool[] = ['Abjuration', 'Conjuration', 'Divination', 'Enchantment', 'Evocation', 'Illusion', 'Necromancy', 'Transmutation'];
const schoolOf = (word: string | undefined): SpellSchool | undefined => SCHOOLS.find((s) => s.toLowerCase() === word?.toLowerCase());

/** The level and school a printed level line states. */
export function levelLineValues(text: string): { level?: number; school?: SpellSchool } {
  const m = SPELL_LINE.exec(text.replace(/[*_]/g, ''));
  if (!m) return {};
  return { level: Number(m[1] ?? m[4] ?? 0), school: schoolOf(m[2] ?? m[3] ?? m[5]) };
}

/** "Sorcerer, Wizard and Wickwright" → ["Sorcerer", "Wizard", "Wickwright"] (as printed). */
export function classesOf(text: string): string[] {
  return text
    .replace(/[*_]/g, '')
    .split(/\s*,\s*|\s+and\s+|\s+or\s+/i)
    .map((c) => c.replace(/^(?:and|or)\s+/i, '').trim())
    .filter(Boolean);
}

/** A spell's area from its excerpt, else the first area phrase of its text (engine/areas.ts). */
function areaOf(areaText: string, fullText: string): SpellArea | undefined {
  const found = parseAreaText(areaText) ?? parseAreaText(fullText.replace(/[*_]/g, ''));
  if (!found) return undefined;
  return {
    shape: found.shape,
    sizeFt: found.sizeFt,
    ...(found.widthFt !== undefined ? { widthFt: found.widthFt } : {}),
    ...(found.heightFt !== undefined ? { heightFt: found.heightFt } : {}),
  } as SpellArea;
}

const DAMAGE_TYPES = new Set(['acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic', 'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder']);
const DICE = String.raw`\d+d\d+(?:\s*[+−-]\s*\d+)?`;

/** "8d6 Fire damage" / "Force damage equal to 4d12" → dice and type; "3d8 damage" (a chosen type) → dice only. */
export function damageOf(text: string): { damage: string; types: string[] } | null {
  const t = text.replace(/[*_]/g, '');
  const before = new RegExp(`(${DICE})\\s+(\\w+)\\s+damage`, 'i').exec(t);
  const after = new RegExp(`\\b(\\w+)\\s+damage\\s+equal\\s+to\\s+(${DICE})`, 'i').exec(t);
  const bare = new RegExp(`(${DICE})\\s+damage`, 'i').exec(t);
  const tidy = (dice: string) => dice.replace(/\s+/g, ' ').replace(/−/g, '-');
  if (before && DAMAGE_TYPES.has(before[2].toLowerCase())) return { damage: tidy(before[1]), types: [before[2].toLowerCase()] };
  if (after && DAMAGE_TYPES.has(after[1].toLowerCase())) return { damage: tidy(after[2]), types: [after[1].toLowerCase()] };
  const dice = before?.[1] ?? bare?.[1];
  return dice ? { damage: tidy(dice), types: [] } : null;
}
const SCALING_PAIR = /(\d{1,2})(?:st|nd|rd|th)?(?:\s+level)?\s*\((\d+d\d+)\)/gi;

/** The classes a book's spell lists give a spell (every "<Class> Spells" list that names it). */
export function classesFromLists(name: string, lists: readonly SpellListHint[]): string[] {
  const key = nameKey(name);
  return [...new Set(lists.filter((l) => l.spellNames.some((n) => nameKey(n) === key)).map((l) => l.className))];
}

export function normalizeSpell(wire: Wire<'spell'>, ctx: NormalizeContext): Normalized<'spell'> {
  const base = beginNormalize('a spell', wire, ctx, SPELL_FIELDS);
  const w: RecordWarning[] = [];
  const printed = levelLineValues(wire.levelText);
  const level = printed.level ?? wire.level;
  if (printed.level !== undefined && printed.level !== wire.level) {
    w.push(warning('cross-check', 'warn', `The level line says level ${printed.level}, but level ${wire.level} was read.`, 'level'));
  }
  const school = printed.school ?? schoolOf(wire.school);
  if (printed.school && wire.school !== 'unknown' && printed.school.toLowerCase() !== wire.school) {
    w.push(warning('cross-check', 'warn', `The level line says ${printed.school}, but ${wire.school} was read.`, 'school'));
  }
  if (!school) w.push(missing('school', 'The school of magic'));
  if (!wire.levelText && !Number.isInteger(wire.level)) w.push(missing('level', 'The spell level'));
  const castingTime = wire.castingTimeText.replace(/[*_]/g, '').replace(/\s*,?\s*or\s+Ritual\s*$/i, '').trim();
  if (!castingTime) w.push(missing('castingTime', 'The casting time'));
  const range = wire.rangeText.replace(/[*_]/g, '').trim();
  if (!range) w.push(missing('range', 'The range'));
  const duration = wire.durationText.replace(/[*_]/g, '').trim();
  if (!duration) w.push(missing('duration', 'The duration'));
  if (!school || !castingTime || !range || !duration || !Number.isInteger(level)) {
    return finishNormalize('spell', base, null, [], { matchesKind: wire.matchesKind, keyFields: KEY_FIELDS, ctx, extra: w });
  }

  let classes = classesOf(wire.classesText);
  if (!classes.length) {
    classes = classesFromLists(base.name, ctx.spellLists);
    if (classes.length) w.push(warning('spell-list', 'info', `Classes taken from the book's ${classes.join(', ')} spell list${classes.length > 1 ? 's' : ''}.`, 'classes'));
  }
  const concentration = wire.concentration || /^concentration\b/i.test(duration);
  const damage = damageOf(wire.damageText);
  const scaling = level === 0 ? [...wire.cantripScalingText.matchAll(SCALING_PAIR)] : [];
  const area = areaOf(wire.areaText, base.fullText);
  const data: SpellData = {
    format: wire.format,
    level,
    school,
    classes,
    ritual: wire.ritual || /\britual\b/i.test(wire.castingTimeText) || /\britual\b/i.test(wire.levelText),
    concentration,
    castingTime,
    range,
    ...(wire.componentsText.trim() ? { components: wire.componentsText.replace(/[*_]/g, '').trim() } : {}),
    duration,
    ...(area ? { area } : {}),
    ...(wire.saveAbility !== 'none' ? { saveAbility: wire.saveAbility } : {}),
    ...(wire.attack !== 'none' ? { attack: wire.attack } : {}),
    ...(damage ? { damage: damage.damage, ...(damage.types.length ? { damageTypes: damage.types } : {}) } : {}),
    ...(scaling.length ? { damageByCharacterLevel: Object.fromEntries(scaling.map((m) => [m[1], m[2]])) } : {}),
  };
  if (/\bcantrip\b/i.test(wire.levelText) && level !== 0) w.push(warning('cross-check', 'warn', `A cantrip is level 0, but level ${level} was read.`, 'level'));
  return finishNormalize('spell', base, data, [], { matchesKind: wire.matchesKind, keyFields: KEY_FIELDS, ctx, extra: [...w, ...spellChecks(data)] });
}

/** Ranges and consistency on the data (shared by normalize and validate). */
export function spellChecks(data: SpellData): RecordWarning[] {
  const out: RecordWarning[] = [];
  if (!Number.isInteger(data.level) || data.level < 0 || data.level > 9) {
    out.push(warning('out-of-range', 'block', `Spell level ${data.level} isn't 0 (a cantrip) to 9.`, 'level'));
  }
  if (data.concentration && !/concentration/i.test(data.duration)) {
    out.push(warning('cross-check', 'warn', "It's marked Concentration, but the duration doesn't say so.", 'concentration'));
  }
  if (!data.concentration && /^concentration\b/i.test(data.duration)) {
    out.push(warning('cross-check', 'warn', "The duration says Concentration, but it isn't marked so.", 'concentration'));
  }
  if (data.damageByCharacterLevel && data.level !== 0) {
    out.push(warning('cross-check', 'warn', 'Damage by character level is for cantrips, but this spell has a level.', 'damageByCharacterLevel'));
  }
  return out;
}

export function validateSpell(data: SpellData, ctx: NormalizeContext): Pick<Normalized<'spell'>, 'warnings' | 'adaptations' | 'confidence'> {
  void ctx;
  const warnings = spellChecks(data);
  return { warnings, adaptations: [], confidence: gradeConfidence('spell', warnings, { matchesKind: true, missingKey: false }) };
}
