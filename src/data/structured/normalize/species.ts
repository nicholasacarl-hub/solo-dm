/**
 * The species normalizer (spec §3.9), shared by the offline parser and Claude's answers. Traits and
 * lineages are spans (the book's words are copied at merge time); a lineage printed as one table row is
 * marked 'table-row' (merge builds the SRD-style "… Level 3: X. Level 5: Y." text from its cells). Older
 * books (§5.6): printed ability score increases are kept for reference, never applied; printed languages
 * are suggestions for the two 2024 picks.
 *
 * Owner: E4. Pure.
 */
import { nameKey } from '@/lib/id';
import { ABILITIES, type Ability, type Adaptation, type RecordWarning, type SpeciesData } from '@/types';
import type { Wire } from '../wire';
import { adaptation } from '../adaptations';
import { parseAbilityList, sizesIn } from '../parse/srdRulesOptions';
import { languagesOf } from './background';
import type { NormalizeContext, Normalized } from './index';
import { beginOption, blockOfSpan, defaultUsed, finishOption, optionNameOf, spanWarnings } from './feat';
import { gradeConfidence, limitText, missing, spanFromWire, titleCase, warning } from './text';

const FIELDS = {
  creatureTypeText: 'creatureType',
  sizeText: 'sizes',
  speedText: 'speed',
  darkvisionText: 'darkvision',
  abilityIncreasesText: 'legacyAbilityIncreases',
  languagesText: 'languages',
} as const;

const feet = (text: string) => {
  const m = /(\d+)\s*(?:feet|foot|ft\b)/i.exec(text);
  return m ? Number(m[1]) : null;
};

const WORD_COUNT: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

/** "Your Constitution score increases by 2, and your Wisdom score increases by 1." → con +2, wis +1; "Two different ability scores of your choice increase by 1" → any +1 ×2. */
export function legacyIncreasesOf(text: string): NonNullable<SpeciesData['legacyAbilityIncreases']> {
  const out: NonNullable<SpeciesData['legacyAbilityIncreases']> = [];
  for (const m of text.matchAll(/\b(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) score increases by (\d)/gi)) {
    const [ability] = parseAbilityList(m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase());
    if (ability) out.push({ ability, amount: Number(m[2]) });
  }
  const choice = /\b(one|two|three|\d) (?:other |different )?ability scores? of your choice (?:each )?increases? by (\d)/i.exec(text);
  if (choice) {
    const count = WORD_COUNT[choice[1].toLowerCase()] ?? (Number(choice[1]) || 1);
    for (let i = 0; i < count; i++) out.push({ ability: 'any', amount: Number(choice[2]) });
  }
  if (!out.length && /\bability scores each increase by (\d)/i.test(text)) {
    const amount = Number(/\bability scores each increase by (\d)/i.exec(text)?.[1] ?? 1);
    for (const ability of ABILITIES as readonly Ability[]) out.push({ ability, amount });
  }
  return out.filter((a) => a.amount >= 1 && a.amount <= 5);
}

/** §5.6 notes for an older species. */
export function speciesAdaptations(name: string, data: Pick<SpeciesData, 'legacyAbilityIncreases' | 'languages'>): Adaptation[] {
  const out: Adaptation[] = [];
  if (data.legacyAbilityIncreases?.length) out.push(adaptation('species-asi-not-applied', { name }));
  if (data.languages?.length) out.push(adaptation('species-languages-suggested', { name }));
  return out;
}

function limits(data: SpeciesData): RecordWarning[] {
  const out: RecordWarning[] = [];
  if (data.traits.length > 24) out.push(warning('out-of-range', 'block', `${data.traits.length} traits is more than the 24 the app keeps.`, 'traits'));
  if ((data.lineages?.length ?? 0) > 16) out.push(warning('out-of-range', 'block', `${data.lineages?.length} lineages is more than the 16 the app keeps.`, 'lineages'));
  if (data.speed > 300) out.push(warning('out-of-range', 'block', `A speed of ${data.speed} feet is more than the app allows.`, 'speed'));
  return out;
}

export function normalizeSpecies(wire: Wire<'species'>, ctx: NormalizeContext): Normalized<'species'> {
  const base = beginOption('species', wire, ctx, FIELDS);
  const w = base.warnings;
  const creatureType = titleCase(wire.creatureTypeText.replace(/[.;]\s*$/, '')) || 'Humanoid';
  if (!wire.creatureTypeText.trim()) w.push(defaultUsed('creatureType', 'No creature type is printed: the app used Humanoid.'));
  const sizes = sizesIn(wire.sizeText);
  if (!sizes.length) w.push(missing('sizes', 'Its size', 'block'));
  const speed = feet(wire.speedText);
  if (speed === null) w.push(missing('speed', 'Its speed', 'block'));
  const darkvision = feet(wire.darkvisionText) ?? undefined;

  const traits: SpeciesData['traits'] = [];
  wire.traits.forEach((t, i) => {
    const { span, warning: problem } = spanFromWire(t.text, t.name, ctx.blocks, `traits[${i}]`);
    if (problem) w.push(problem);
    if (span && t.name.trim()) traits.push({ name: limitText(t.name, 120, `traits[${i}]`, w), text: span });
  });
  if (!traits.length) w.push(missing('traits', 'Its traits', 'warn'));

  const lineages: NonNullable<SpeciesData['lineages']> = [];
  wire.lineages.forEach((l, i) => {
    const { span, warning: problem } = spanFromWire(l.text, l.name, ctx.blocks, `lineages[${i}]`);
    if (problem) w.push(problem);
    if (!span || !l.name.trim()) return;
    const row = span.from === span.to ? blockOfSpan(span, ctx.blocks)?.paragraphs[span.from - 1] : undefined;
    lineages.push({ name: limitText(l.name, 120, `lineages[${i}]`, w), text: span, form: row?.trim().startsWith('|') ? 'table-row' : 'paragraphs' });
  });

  const traitName = wire.lineageTraitName.trim();
  const lineageTrait = traitName ? traits.find((t) => nameKey(t.name) === nameKey(traitName))?.name : undefined;
  if (traitName && !lineageTrait) {
    w.push(warning('cross-check', 'warn', 'The trait that offers the lineages isn’t one of the traits: choose it.', 'lineageTrait'));
  }
  const increases = legacyIncreasesOf(wire.abilityIncreasesText);
  if (wire.abilityIncreasesText.trim() && !increases.length) {
    w.push(warning('cross-check', 'warn', 'The ability score increases couldn’t be read: check them.', 'legacyAbilityIncreases'));
  }
  const languages = languagesOf(wire.languagesText);
  const data: SpeciesData | null =
    sizes.length && speed !== null
      ? {
          format: wire.format,
          creatureType: limitText(creatureType, 120, 'creatureType', w),
          sizes,
          speed,
          ...(darkvision ? { darkvision } : {}),
          traits,
          ...(lineageTrait ? { lineageTrait } : {}),
          ...(lineages.length ? { lineages } : {}),
          ...(increases.length ? { legacyAbilityIncreases: increases } : {}),
          ...(languages.length ? { languages } : {}),
        }
      : null;
  if (data) w.push(...limits(data));
  return finishOption('species', base, data, data ? speciesAdaptations(base.name, data) : [], {
    matchesKind: wire.matchesKind,
    keyFields: ['sizeText', 'speedText', 'traits'],
    ctx,
  });
}

export function validateSpecies(data: SpeciesData, ctx: NormalizeContext, name?: string): Pick<Normalized<'species'>, 'warnings' | 'adaptations' | 'confidence'> {
  const speciesName = optionNameOf(ctx, name);
  const warnings = [
    ...limits(data),
    ...spanWarnings(
      [
        ...data.traits.map((t, i) => ({ name: t.name, text: t.text, field: `traits[${i}]` })),
        ...(data.lineages ?? [])
          .map((l, i) => ({ name: l.name, text: l.text, field: `lineages[${i}]`, form: l.form }))
          .filter((l) => l.form === 'paragraphs'),
      ],
      ctx,
    ),
  ];
  if (data.lineageTrait && !data.traits.some((t) => nameKey(t.name) === nameKey(data.lineageTrait ?? ''))) {
    warnings.push(warning('cross-check', 'warn', 'The trait that offers the lineages isn’t one of the traits: choose it.', 'lineageTrait'));
  }
  return {
    warnings,
    adaptations: speciesAdaptations(speciesName, data),
    confidence: gradeConfidence('species', warnings, { matchesKind: true, missingKey: false }),
  };
}
