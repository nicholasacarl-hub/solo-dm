/**
 * The feat normalizer (spec §3.9), shared by the offline parser and Claude's answers, plus the helpers
 * every option normalizer (feat, background, species, class, subclass) uses: the record name, excerpts
 * and their grounding, Claude's note, "not this kind", and the confidence grade.
 *
 * Owner: E4. Pure. Every message is app-written; no book text is quoted beyond short excerpts.
 */
import { ABILITIES, type Ability, type Adaptation, type FeatData, type RecordWarning, type StructuredDataByKind, type TextSpan } from '@/types';
import type { CandidateBlock } from '../segment';
import type { Wire } from '../wire';
import { adaptation } from '../adaptations';
import { featLine } from '../parse/feat';
import { parseAbilityList } from '../parse/srdRulesOptions';
import type { NormalizeContext, Normalized } from './index';
import { checkSpan, excerptsOf, fullTextOf, gradeConfidence, limitText, missing, modelNoteOf, ungrounded, warning } from './text';

// ---------------------------------------------------------------------------
// Shared by the option normalizers
// ---------------------------------------------------------------------------

export type OptionKind = 'feat' | 'background' | 'species' | 'class' | 'subclass';

const KIND_WORD: Readonly<Record<OptionKind, string>> = {
  feat: 'a feat',
  background: 'a background',
  species: 'a species',
  class: 'a class',
  subclass: 'a subclass',
};

/** The parts every option normalizer starts from. */
export interface OptionBase {
  name: string;
  warnings: RecordWarning[];
  excerpts: Normalized<OptionKind>['excerpts'];
  modelNote?: string;
  fullText: string;
}

/**
 * Name, excerpts (grounded against the candidate's full text), an `ungrounded` warning per excerpt that
 * isn't in the text (on the data field it fills, from `fields`), Claude's note, and "not this kind".
 */
export function beginOption(
  kind: OptionKind,
  wire: { matchesKind: boolean; name: string; notes: string },
  ctx: NormalizeContext,
  fields: Readonly<Record<string, string>>,
): OptionBase {
  const warnings: RecordWarning[] = [];
  const fullText = fullTextOf(ctx.blocks);
  const fallbackName = ctx.blocks[0]?.title ?? '';
  const name = limitText(wire.name.trim() || fallbackName, 120, 'name', warnings) || fallbackName;
  const excerpts = excerptsOf(wire, fullText);
  for (const e of excerpts) {
    if (!e.grounded) warnings.push(ungrounded(e.text, fields[e.field.split(/[.[]/)[0]] ?? e.field));
  }
  if (!wire.matchesKind) {
    warnings.push(warning('not-this-kind', 'block', `Claude says this isn't ${KIND_WORD[kind]}. Keep it as text, or change what it is.`, 'kind'));
  }
  const modelNote = modelNoteOf(wire.notes);
  if (modelNote) warnings.push(warning('model-note', 'info', 'Claude left a note about this entry.'));
  return { name, warnings, excerpts, ...(modelNote ? { modelNote } : {}), fullText };
}

/** The finished result: confidence from the warnings (§3.9.2), a missing key field from the offline parser. */
export function finishOption<K extends OptionKind>(
  kind: K,
  base: OptionBase,
  data: StructuredDataByKind[K] | null,
  adaptations: Adaptation[],
  opts: { matchesKind: boolean; keyFields: readonly string[]; ctx: NormalizeContext },
): Normalized<K> {
  const missingKey = data === null || (opts.ctx.missing ?? []).some((f) => opts.keyFields.includes(f));
  return {
    data,
    name: base.name,
    warnings: base.warnings,
    adaptations,
    excerpts: base.excerpts,
    confidence: gradeConfidence(kind, base.warnings, { matchesKind: opts.matchesKind, missingKey }),
    ...(base.modelNote ? { modelNote: base.modelNote } : {}),
  };
}

/** The `info` warning for a rule default the app filled ("Not printed: the app used Humanoid"). */
export function defaultUsed(field: string, message: string): RecordWarning {
  return warning('default-used', 'info', message, field);
}

/**
 * The option's name for validateData (which gets no wire): the given name, else its first block's title
 * without a "Fighter Subclass:" or "Feature:" prefix.
 */
export function optionNameOf(ctx: NormalizeContext, name?: string): string {
  const title = ctx.blocks[0]?.title ?? '';
  return name?.trim() || title.replace(/^.+? Subclass:\s*/i, '').replace(/^Feature:\s*/i, '').trim() || title;
}

/** A span's block, by the TextSpan's first entry. */
export function blockOfSpan(span: TextSpan, blocks: readonly CandidateBlock[]): CandidateBlock | undefined {
  return blocks.find((b) => b.entryIds[0] === span.entryIds[0]);
}

/** Re-check stored spans (review edits, packs): each one resolves and starts at its name. */
export function spanWarnings(spans: readonly { name: string; text: TextSpan; field: string }[], ctx: NormalizeContext): RecordWarning[] {
  return spans.flatMap((s) => {
    const w = checkSpan(s.text, s.name, ctx.entriesById, s.field);
    return w ? [w] : [];
  });
}

// ---------------------------------------------------------------------------
// Feats
// ---------------------------------------------------------------------------

const FEAT_FIELDS = { categoryText: 'category', prerequisiteText: 'prerequisite', abilityIncreaseText: 'abilityIncrease' } as const;

/** "Prerequisite: Level 4+" → "Level 4+". */
export function cleanPrerequisite(text: string): string {
  return text
    .replace(/^\s*\(?\s*Prerequisites?\s*:\s*/i, '')
    .replace(/\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Level 4+" anywhere in a prerequisite → 4 (the only part the app checks). */
export function minLevelOf(prerequisite: string | undefined): number | undefined {
  const m = /\bLevel (\d{1,2})\+/i.exec(prerequisite ?? '');
  const level = m ? Number(m[1]) : NaN;
  return level >= 1 && level <= 20 ? level : undefined;
}

/** "Increase your Wisdom or Charisma score by 1" → { abilities: [wis, cha], amount: 1 }; "one ability score of your choice" → all six. */
export function abilityIncreaseOf(text: string): FeatData['abilityIncrease'] {
  const t = text.trim();
  if (!t) return undefined;
  const amount = /\bby 2\b/i.test(t) ? 2 : 1;
  const named = [...new Set(parseAbilityList(t))];
  const abilities: Ability[] = named.length ? named : /\bof your choice\b/i.test(t) ? [...ABILITIES] : [];
  return abilities.length ? { abilities, amount } : undefined;
}

/** The feat's text: its paragraphs after the category (or prerequisite) line. */
function featSpan(block: CandidateBlock | undefined): TextSpan | null {
  if (!block?.paragraphs.length) return null;
  const from = featLine(block.paragraphs[0]) ? 2 : 1;
  return from <= block.paragraphs.length ? { entryIds: [...block.entryIds], from, to: block.paragraphs.length } : null;
}

/** §5.6: a feat with no category is treated as General. */
export function featAdaptations(name: string, data: Pick<FeatData, 'format' | 'category'>, printedCategory?: string): Adaptation[] {
  const unprinted = printedCategory === undefined ? data.format === '2014' && data.category === 'general' : printedCategory === 'unknown';
  return unprinted ? [adaptation('feat-general', { name })] : [];
}

export function normalizeFeat(wire: Wire<'feat'>, ctx: NormalizeContext): Normalized<'feat'> {
  const base = beginOption('feat', wire, ctx, FEAT_FIELDS);
  const text = featSpan(ctx.blocks[0]);
  if (!text) base.warnings.push(missing('text', "The feat's text"));
  const printed = featLine(wire.categoryText)?.category;
  if (printed && printed !== 'unknown' && wire.category !== 'unknown' && printed !== wire.category) {
    base.warnings.push(warning('cross-check', 'warn', `The category line says ${printed.replace('-', ' ')}, but the category is ${wire.category.replace('-', ' ')}.`, 'category'));
  }
  const category = wire.category === 'unknown' ? 'general' : wire.category;
  const prerequisite = cleanPrerequisite(limitText(wire.prerequisiteText, 400, 'prerequisite', base.warnings));
  const minLevel = minLevelOf(prerequisite);
  const abilityIncrease = abilityIncreaseOf(wire.abilityIncreaseText);
  if (wire.abilityIncreaseText.trim() && !abilityIncrease) {
    base.warnings.push(warning('cross-check', 'warn', 'No ability is named in the increase sentence: check which abilities it raises.', 'abilityIncrease'));
  }
  const data: FeatData | null = text
    ? {
        format: wire.format,
        category,
        ...(prerequisite ? { prerequisite } : {}),
        ...(minLevel !== undefined ? { minLevel } : {}),
        repeatable: wire.repeatable,
        ...(abilityIncrease ? { abilityIncrease } : {}),
        text,
      }
    : null;
  return finishOption('feat', base, data, featAdaptations(base.name, { format: wire.format, category }, wire.category), {
    matchesKind: wire.matchesKind,
    keyFields: ['category', 'categoryText'],
    ctx,
  });
}

/** validateData for a feat: its text span, and the adaptation its fields imply. */
export function validateFeat(data: FeatData, ctx: NormalizeContext, name?: string): Pick<Normalized<'feat'>, 'warnings' | 'adaptations' | 'confidence'> {
  const featName = optionNameOf(ctx, name);
  const warnings = spanWarnings([{ name: featName, text: data.text, field: 'text' }], ctx);
  if (data.prerequisite && data.minLevel === undefined && minLevelOf(data.prerequisite) !== undefined) {
    warnings.push(warning('cross-check', 'warn', 'The prerequisite names a level, but no minimum level is set.', 'minLevel'));
  }
  return {
    warnings,
    adaptations: featAdaptations(featName, data),
    confidence: gradeConfidence('feat', warnings, { matchesKind: true, missingKey: false }),
  };
}
