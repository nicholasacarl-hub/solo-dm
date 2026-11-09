/**
 * Offline species parser (spec §3.9): the 2024 labels Creature Type / Size / Speed; traits = the
 * emphasized run-in paragraphs (each runs to the paragraph before the next run-in or heading); the
 * lineage trait by name (/Lineage|Ancestry|Legacy/) or by its text ("choose a lineage"); lineages from a
 * table (one body row = one lineage) or ≥ 2 run-ins inside the lineage trait; older books' run-ins
 * Ability Score Increase / Size / Speed / Languages, with subrace headings as lineages.
 *
 * The PDF text layer (no emphasis, tables as loose lines) is left to Claude: without run-ins no trait is
 * found and `traits` is reported missing.
 *
 * Owner: E4. Pure.
 */
import type { Candidate, CandidateBlock } from '../segment';
import type { Wire } from '../wire';
import type { OfflineParse } from './index';
import { findLabel, plainText, runInParts, splitRow, type RunInPart } from './srdRulesOptions';

/** Run-ins that describe the species itself rather than a trait (2024 bullets and 2014 run-ins). */
const META = /^(?:Creature Type|Size|Speed|Ability Score Increases?|Age|Alignment|Languages?)$/i;
const LINEAGE_NAME = /Lineage|Ancestry|Legacy/i;
const LINEAGE_TEXT = /\bchoose (?:an?|one) (?:\w+ )?(?:lineage|ancestry|legacy)\b|\bfrom the [\w' -]+ (?:Lineages?|Ancestr(?:y|ies)|Legac(?:y|ies)) table\b/i;
const SUBRACE = /^Subraces?$/i;
const LINEAGE_BLOCK = /\b(?:Lineages?|Ancestr(?:y|ies)|Legac(?:y|ies))$/i;

const named = (block: string, from: number, to: number, name: string) => ({ name, text: { block, from, to } });

/** Table body rows of a block's paragraphs: one lineage per row, named by its first cell. */
function tableLineages(block: CandidateBlock, from = 1, to = block.paragraphs.length): Wire<'species'>['lineages'] {
  const out: Wire<'species'>['lineages'] = [];
  for (let i = from; i <= to; i++) {
    const p = block.paragraphs[i - 1];
    if (!p?.trim().startsWith('|')) continue;
    const name = plainText(splitRow(p)[0] ?? '');
    if (name && !/^[-:]+$/.test(name)) out.push(named(block.id, i, i, name));
  }
  return out;
}

/** The value of a 2014 run-in ("Your size is Small." → "Small"; "Your walking speed is 25 feet." → "25 feet"). */
function olderValue(part: RunInPart | undefined, re: RegExp): string {
  if (!part) return '';
  const m = re.exec(plainText(part.rest));
  return m ? m[1].trim() : '';
}

export function parseSpecies(candidate: Candidate): OfflineParse<'species'> {
  const [main, ...rest] = candidate.blocks;
  const all = main ? runInParts(main.paragraphs) : [];
  // SRD-style books set traits as "_**Name.**_" (older ones "***Name.***") and a trait's own options in
  // bold: when traits are set that way, bold run-ins stay inside their trait.
  const strongEm = all.some((p) => p.emphasis === 'strong-em' && !META.test(p.label));
  const parts = strongEm ? runInParts(main.paragraphs, { emphasis: ['strong-em'] }) : all;
  const byLabel = (re: RegExp) => parts.find((p) => re.test(p.label));
  const traitParts = parts.filter((p) => !META.test(p.label));
  const traits = traitParts.map((p) => named(main.id, p.from, p.to, p.label));

  const lineageTrait =
    traitParts.find((p) => LINEAGE_NAME.test(p.label)) ??
    traitParts.find((p) => LINEAGE_TEXT.test(main.paragraphs.slice(p.from - 1, p.to).join('\n'))) ??
    traitParts.find((p) => SUBRACE.test(p.label));

  let lineages: Wire<'species'>['lineages'] = [];
  const lineageBlock = rest.find((b) => LINEAGE_BLOCK.test(b.title));
  if (lineageBlock) lineages = tableLineages(lineageBlock);
  if (!lineages.length && lineageTrait) lineages = tableLineages(main, lineageTrait.from, lineageTrait.to);
  if (!lineages.length && lineageTrait) {
    const inner = runInParts(main.paragraphs.slice(lineageTrait.from, lineageTrait.to));
    if (inner.length >= 2) lineages = inner.map((p) => named(main.id, lineageTrait.from + p.from, lineageTrait.from + p.to, p.label));
  }
  // Older books: each subrace is a heading of its own after the species' traits.
  if (!lineages.length && rest.length && (lineageTrait ? SUBRACE.test(lineageTrait.label) : true)) {
    lineages = rest.filter((b) => b.paragraphs.length).map((b) => named(b.id, 1, b.paragraphs.length, b.title));
  }

  const label = (name: string) => findLabel(main ? [main] : [], name)?.value ?? '';
  const sizeLabel = label('Size');
  const speedLabel = label('Speed');
  const allTraitText = traitParts.map((p) => main.paragraphs.slice(p.from - 1, p.to).map(plainText).join(' ')).join(' ');
  const darkvision =
    /\b(?:Darkvision )?(?:with )?(a range of \d+ (?:feet|ft\.?))/i.exec(allTraitText)?.[1] ??
    /\b((?:with)?in \d+ (?:feet|ft\.?) of you)\b/i.exec(allTraitText)?.[1] ??
    '';
  const asi = byLabel(/^Ability Score Increases?$/i);
  const languages = byLabel(/^Languages?$/i);

  const wire: Wire<'species'> = {
    matchesKind: true,
    name: candidate.name,
    format: asi ? '2014' : '2024',
    creatureTypeText: label('Creature Type'),
    sizeText: asi ? olderValue(byLabel(/^Size$/i), /\bYour size is (\w+)/i) || sizeLabel : sizeLabel,
    speedText: asi ? olderValue(byLabel(/^Speed$/i), /\bspeed is (\d+ (?:feet|ft\.?))/i) || speedLabel : speedLabel,
    darkvisionText: darkvision,
    traits,
    lineageTraitName: lineages.length && lineageTrait ? lineageTrait.label : '',
    lineages,
    abilityIncreasesText: asi ? plainText(asi.rest) : '',
    languagesText: languages ? olderValue(languages, /^(?:You (?:know|can speak, read, and write)|You speak)\s+(.+?)\.?$/i) || plainText(languages.rest) : '',
    notes: '',
  };
  const missing = (['sizeText', 'speedText'] as const).filter((f) => !wire[f]) as string[];
  if (!traits.length) missing.push('traits');
  return { wire, missing };
}
