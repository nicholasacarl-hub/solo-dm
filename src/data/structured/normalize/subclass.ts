/**
 * The subclass normalizer (spec §3.9), shared by the offline parser and Claude's answers. The parent
 * class is the printed name, else the title's "X Subclass:" or a "Cleric Domains" heading; the review
 * confirms which class option it attaches to (StructuredRecord.parentClassId). The early-features
 * adaptation is added at merge time, not here (it depends on the parent's subclass level).
 *
 * Owner: E4. Pure.
 */
import type { RecordWarning, SubclassData } from '@/types';
import type { Wire } from '../wire';
import { parentFromTitles } from '../parse/subclass';
import { plainText } from '../parse/srdRulesOptions';
import type { NormalizeContext, Normalized } from './index';
import { beginOption, finishOption, spanWarnings } from './feat';
import { gradeConfidence, limitText, missing, spanFromWire, warning } from './text';

const FIELDS = { parentClassText: 'parentClass', taglineText: 'summary' } as const;

/** Features as stored: spans resolved, levels 1–20 (a level outside them is a block). */
export function featuresOf(
  wire: readonly Wire<'subclass'>['features'][number][],
  ctx: NormalizeContext,
  warnings: RecordWarning[],
  limit: number,
): SubclassData['features'] {
  const out: SubclassData['features'] = [];
  wire.forEach((f, i) => {
    const field = `features[${i}]`;
    const name = f.name.replace(/^\s*Level\s+\d{1,2}\s*:\s*/i, '').trim();
    if (!name) return;
    if (!Number.isInteger(f.level) || f.level < 1 || f.level > 20) {
      warnings.push(warning('out-of-range', 'block', `${name}: level ${f.level} isn't a class level (1–20).`, field));
      return;
    }
    const { span, warning: problem } = spanFromWire(f.text, name, ctx.blocks, field);
    if (problem) warnings.push(problem);
    if (span) out.push({ level: f.level, name: limitText(name, 120, field, warnings), text: span });
  });
  if (out.length > limit) warnings.push(warning('out-of-range', 'block', `${out.length} features is more than the ${limit} the app keeps.`, 'features'));
  return out.sort((a, b) => a.level - b.level);
}

function parentWarning(parentClass: string): RecordWarning[] {
  return parentClass ? [] : [warning('unresolved-ref', 'block', "The class this subclass belongs to isn't named: choose it.", 'parentClass')];
}

export function normalizeSubclass(wire: Wire<'subclass'>, ctx: NormalizeContext): Normalized<'subclass'> {
  const base = beginOption('subclass', wire, ctx, FIELDS);
  const w = base.warnings;
  const parentClass = limitText(plainText(wire.parentClassText) || ctx.parentClassName?.trim() || parentFromTitles(ctx.blocks), 120, 'parentClass', w);
  w.push(...parentWarning(parentClass));
  const features = featuresOf(wire.features, ctx, w, 30);
  if (!features.length) w.push(missing('features', 'Its features', 'warn'));
  const third = wire.casterType === 'third';
  const ability = wire.spellcastingAbility === 'none' ? undefined : wire.spellcastingAbility;
  if (third && !ability) w.push(warning('missing', 'warn', 'It grants spellcasting, but no spellcasting ability was found.', 'spellcastingAbility'));
  const prepared = wire.alwaysPreparedSpells
    .map((row) => ({ level: row.level, spells: row.spells.map((s) => plainText(s)).filter(Boolean) }))
    .filter((row) => Number.isInteger(row.level) && row.level >= 1 && row.level <= 20 && row.spells.length);
  const data: SubclassData = {
    format: wire.format,
    parentClass,
    summary: limitText(plainText(wire.taglineText), 200, 'summary', w),
    features,
    ...(third ? { casterType: 'third' as const } : {}),
    ...(third && ability ? { spellcastingAbility: ability } : {}),
    ...(prepared.length ? { alwaysPreparedSpells: prepared } : {}),
  };
  return finishOption('subclass', base, data, [], { matchesKind: wire.matchesKind, keyFields: ['parentClassText', 'features'], ctx });
}

export function validateSubclass(data: SubclassData, ctx: NormalizeContext): Pick<Normalized<'subclass'>, 'warnings' | 'adaptations' | 'confidence'> {
  const warnings = [
    ...parentWarning(data.parentClass),
    ...spanWarnings(data.features.map((f, i) => ({ name: f.name, text: f.text, field: `features[${i}]` })), ctx),
  ];
  return { warnings, adaptations: [], confidence: gradeConfidence('subclass', warnings, { matchesKind: true, missingKey: false }) };
}
