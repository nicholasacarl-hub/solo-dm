/**
 * Offline feat parser (spec §3.9): fills the wire Claude would return from the feat's own entry.
 * Reads `_<Category> Feat (Prerequisite: X)_` (2024, with or without emphasis), a bare
 * `Prerequisite: X` line and no category (older books → "unknown", adapted to General by the
 * normalizer), `_**Repeatable.**_`, and the "Increase your X or Y score by 1" sentence. A feat under a
 * heading such as "Fighting Style Feats" takes its category from that heading.
 *
 * Owner: E4. Pure.
 */
import type { Candidate } from '../segment';
import type { Wire } from '../wire';
import type { OfflineParse } from './index';
import { plainText, runIn, sentences } from './srdRulesOptions';

type Category = Wire<'feat'>['category'];

const CATEGORY_LINE = /^(Origin|General|Fighting Style|Epic Boon) Feat\b\s*(?:\(\s*Prerequisites?:\s*(.+?)\s*\))?\.?$/i;
const PREREQUISITE_LINE = /^Prerequisites?\s*:\s*(.+?)\.?$/i;
const HEADING_CATEGORY = /^(Origin|General|Fighting Style|Epic Boon) Feats$/i;

export function featCategory(word: string): Category {
  const key = word.toLowerCase().replace(/\s+/g, '-');
  return key === 'origin' || key === 'general' || key === 'fighting-style' || key === 'epic-boon' ? key : 'unknown';
}

/** The category line of a feat's first paragraph, as the wire reads it (null when there is none). */
export function featLine(paragraph: string | undefined): { categoryText: string; category: Category; prerequisite: string } | null {
  const first = plainText(paragraph ?? '');
  const cat = CATEGORY_LINE.exec(first);
  if (cat) return { categoryText: first, category: featCategory(cat[1]), prerequisite: cat[2]?.trim() ?? '' };
  const pre = PREREQUISITE_LINE.exec(first);
  return pre ? { categoryText: '', category: 'unknown', prerequisite: pre[1].trim() } : null;
}

/** The sentence that increases ability scores, copied whole ("Increase your Wisdom or Charisma score by 1, to a maximum of 20."). */
export function abilityIncreaseSentence(paragraphs: readonly string[]): string {
  for (const p of paragraphs) {
    const text = plainText(runIn(p)?.rest ?? p);
    const found = sentences(text).find((s) => /^Increase (?:your|one|two|three)\b[^.]*\bby [12]\b/i.test(s));
    if (found) return found;
  }
  return '';
}

export function parseFeat(candidate: Candidate): OfflineParse<'feat'> {
  const block = candidate.blocks[0];
  const paragraphs = block?.paragraphs ?? [];
  const line = featLine(paragraphs[0]);
  const fromHeading = [...(block?.path ?? [])].reverse().map((t) => HEADING_CATEGORY.exec(t)).find(Boolean);
  const category = line?.category !== 'unknown' && line ? line.category : fromHeading ? featCategory(fromHeading[1]) : 'unknown';
  const wire: Wire<'feat'> = {
    matchesKind: true,
    name: candidate.name,
    format: line?.categoryText ? '2024' : '2014',
    categoryText: line?.categoryText ?? '',
    category,
    prerequisiteText: line?.prerequisite ?? '',
    repeatable: paragraphs.some((p) => /^repeatable$/i.test(runIn(p)?.label ?? '') || /^Repeatable\.\s/.test(plainText(p))),
    abilityIncreaseText: abilityIncreaseSentence(paragraphs),
    notes: '',
  };
  // Every feat wire field is optional in print (older feats have no category line); the normalizer checks the text.
  return { wire, missing: [] };
}
