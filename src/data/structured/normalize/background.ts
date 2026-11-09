/**
 * The background normalizer (spec §3.9), shared by the offline parser and Claude's answers. Older-format
 * backgrounds are adapted (§5.6): no ability scores → the player picks any three; no Origin feat → the
 * player picks one; a named feature is kept as a background feature; printed languages are suggestions.
 *
 * Owner: E4. Pure.
 */
import type { Adaptation, BackgroundData, RecordWarning, Skill } from '@/types';
import type { Wire } from '../wire';
import { adaptation } from '../adaptations';
import { equipmentPackages, parseAbilityList, skillByName } from '../parse/srdRulesOptions';
import type { NormalizeContext, Normalized } from './index';
import { beginOption, finishOption, optionNameOf, spanWarnings } from './feat';
import { gradeConfidence, limitText, missing, quote, spanFromWire, warning } from './text';

const FIELDS = {
  abilityScoresText: 'abilityScores',
  featText: 'feat',
  skillsText: 'skills',
  toolText: 'tool',
  equipmentText: 'equipment',
  languagesText: 'languages',
} as const;

/** "Magic Initiate (Cleric) (see “Feats”)." → "Magic Initiate (Cleric)". */
export function cleanOptionName(text: string): string {
  return text
    .replace(/\s*\(see [“"][^”"]+[”"]\)/gi, '')
    .replace(/[.;]\s*$/, '')
    .replace(/^none$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Skill names of "Perception and Stealth" / "Athletics, Survival"; unknown names come back separately. */
export function skillsOf(text: string): { skills: Skill[]; unknown: string[] } {
  const skills: Skill[] = [];
  const unknown: string[] = [];
  for (const raw of text.split(/,\s*(?:and\s+|or\s+)?|\s+and\s+|\s+or\s+/)) {
    const name = raw.replace(/[.;]\s*$/, '').trim();
    if (!name) continue;
    const skill = skillByName(name);
    if (skill && !skills.includes(skill)) skills.push(skill);
    else if (!skill) unknown.push(name);
  }
  return { skills, unknown };
}

const NOT_A_LANGUAGE = /^(?:one|two|three|four|any|other|of|your|choice|languages?|plus|extra|additional|standard|exotic|which|you|choose)$/i;

/** Language names a text prints ("Common and Sylvan" → Common, Sylvan; "Two of your choice" → none). */
export function languagesOf(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/^(?:You (?:know|can speak, read, and write)|You speak)\s+/i, '').split(/,\s*|\s+and\s+|\s+or\s+/)) {
    const name = raw.replace(/[.;]\s*$/, '').replace(/\s*\(.*\)$/, '').trim();
    if (!/^[A-Z][A-Za-z'’ -]{1,30}$/.test(name)) continue;
    if (name.split(/\s+/).some((w) => NOT_A_LANGUAGE.test(w))) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** A block titled "Feature: <name>" starts at the feature: check the span against that title. */
function featureTitle(name: string, blockId: string, ctx: NormalizeContext): string {
  const block = ctx.blocks.find((b) => b.id.toLowerCase() === blockId.trim().toLowerCase());
  const titled = block && /^Feature\s*:\s*(.+)$/i.exec(block.title);
  return titled && titled[1].trim().toLowerCase() === name.toLowerCase() ? block.title : name;
}

/** The same check for a stored span: the entry's title "Feature: <name>" counts as its start. */
function storedFeatureName(name: string, entryId: string | undefined, ctx: NormalizeContext): string {
  const title = entryId ? ctx.entriesById.get(entryId)?.name : undefined;
  const titled = title && /^Feature\s*:\s*(.+)$/i.exec(title);
  return titled && titled[1].trim().toLowerCase() === name.toLowerCase() ? title : name;
}

/** §5.6 notes, in the order the review lists them. */
export function backgroundAdaptations(name: string, data: BackgroundData): Adaptation[] {
  const out: Adaptation[] = [];
  if (!data.abilityScores.length) out.push(adaptation('background-any-three', { name }));
  if (!data.feat) out.push(adaptation('background-feat-choice', { name }));
  if (data.legacyFeature) out.push(adaptation('background-feature-kept', { name, feature: data.legacyFeature.name }));
  if (data.languages?.length) out.push(adaptation('background-languages-suggested', { name }));
  return out;
}

function crossChecks(data: BackgroundData, printedAbilities: number): RecordWarning[] {
  const out: RecordWarning[] = [];
  if (data.format === '2024' && data.abilityScores.length !== 3) {
    out.push(warning('cross-check', 'warn', `A background in the 2024 layout lists three ability scores; ${printedAbilities} were found.`, 'abilityScores'));
  }
  if (!data.skills.length) out.push(missing('skills', 'Its skill proficiencies', 'warn'));
  return out;
}

export function normalizeBackground(wire: Wire<'background'>, ctx: NormalizeContext): Normalized<'background'> {
  const base = beginOption('background', wire, ctx, FIELDS);
  const printed = [...new Set(parseAbilityList(wire.abilityScoresText))];
  const { skills, unknown } = skillsOf(wire.skillsText);
  for (const name of unknown) base.warnings.push(warning('cross-check', 'warn', `${quote(name)} isn't a skill the app knows.`, 'skills'));
  let legacyFeature: BackgroundData['legacyFeature'];
  const featureName = wire.legacyFeature.name.trim();
  if (featureName || wire.legacyFeature.text.block) {
    const { span, warning: spanWarning } = spanFromWire(wire.legacyFeature.text, featureTitle(featureName, wire.legacyFeature.text.block, ctx), ctx.blocks, 'legacyFeature');
    if (spanWarning) base.warnings.push(spanWarning);
    if (span && featureName) legacyFeature = { name: limitText(featureName, 120, 'legacyFeature', base.warnings), text: span };
  }
  const languages = languagesOf(wire.languagesText);
  const data: BackgroundData = {
    format: wire.format,
    abilityScores: printed.length === 3 ? printed : [],
    feat: limitText(cleanOptionName(wire.featText), 120, 'feat', base.warnings),
    skills,
    tool: limitText(cleanOptionName(wire.toolText), 400, 'tool', base.warnings),
    equipment: equipmentPackages(wire.equipmentText).slice(0, 6),
    ...(languages.length ? { languages } : {}),
    ...(legacyFeature ? { legacyFeature } : {}),
  };
  base.warnings.push(...crossChecks(data, printed.length));
  if (!data.equipment.length && wire.equipmentText.trim()) {
    base.warnings.push(warning('cross-check', 'warn', "The equipment couldn't be read into packages: check it.", 'equipment'));
  }
  return finishOption('background', base, data, backgroundAdaptations(base.name, data), {
    matchesKind: wire.matchesKind,
    keyFields: ['abilityScoresText', 'skillsText', 'equipmentText'],
    ctx,
  });
}

export function validateBackground(data: BackgroundData, ctx: NormalizeContext, name?: string): Pick<Normalized<'background'>, 'warnings' | 'adaptations' | 'confidence'> {
  const bgName = optionNameOf(ctx, name);
  const warnings = [
    ...crossChecks(data, data.abilityScores.length),
    ...(data.legacyFeature
      ? spanWarnings([{ name: storedFeatureName(data.legacyFeature.name, data.legacyFeature.text.entryIds[0], ctx), text: data.legacyFeature.text, field: 'legacyFeature' }], ctx)
      : []),
  ];
  return {
    warnings,
    adaptations: backgroundAdaptations(bgName, data),
    confidence: gradeConfidence('background', warnings, { matchesKind: true, missingKey: false }),
  };
}
