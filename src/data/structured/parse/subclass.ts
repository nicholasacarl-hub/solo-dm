/**
 * Offline subclass parser (spec §3.9): "X Subclass: Name" headings with "Level N: Feature" children
 * (2024), and older books' feature headings whose text starts "At 1st level" / "Starting at 6th level".
 * The tagline is the first paragraph when it is set apart in italics, else the first sentence. A table of
 * class levels and spell names gives the always-prepared spells.
 *
 * Owner: E4. Pure.
 */
import type { Candidate, CandidateBlock } from '../segment';
import type { Wire } from '../wire';
import type { OfflineParse } from './index';
import { plainText, sentences, splitRow, splitTopLevel } from './srdRulesOptions';

const LEVEL_TITLE = /^Level\s+(\d{1,2})\s*:\s*(.+)$/i;
const OLDER_LEVEL = /^(?:At|Starting at|Beginning at|When you reach) (\d{1,2})(?:st|nd|rd|th) level\b/i;
const SUBCLASS_TITLE = /^(.+?) Subclass:\s*(.+)$/i;
const GROUP_TITLE = /^(.+?) (?:Subclass(?:es)?|Domains?|Circles?|Oaths?|Colleges?|Paths?|Patrons?|Traditions?|Archetypes?|Origins?|Orders?)$/i;
const SPELLS_INTRO = /\b(?:always prepared|always have .* prepared|subclass spells|domain spells|oath spells|circle spells|expanded spell list)\b/i;

/** The class a subclass belongs to by its title or heading path: "Fighter Subclass: …", "Cleric Domains". */
export function parentFromTitles(blocks: readonly CandidateBlock[]): string {
  const first = blocks[0];
  if (!first) return '';
  const titled = SUBCLASS_TITLE.exec(first.title);
  if (titled) return titled[1].trim();
  for (const ancestor of [...first.path.slice(0, -1)].reverse()) {
    const group = GROUP_TITLE.exec(ancestor) ?? SUBCLASS_TITLE.exec(ancestor);
    if (group) return group[1].trim();
  }
  return '';
}

/** "1st" / "3" / "Level 5" → 5 (null for anything else). */
export function levelCell(cell: string): number | null {
  const m = /^(?:Level\s+)?(\d{1,2})(?:st|nd|rd|th)?$/i.exec(plainText(cell));
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= 20 ? n : null;
}

/** "| 1st | Faerie Fire, Sleep |" rows of a block: class level and spell names. */
export function preparedSpellRows(paragraphs: readonly string[]): Wire<'subclass'>['alwaysPreparedSpells'] {
  const out: Wire<'subclass'>['alwaysPreparedSpells'] = [];
  for (const p of paragraphs) {
    if (!p.trim().startsWith('|')) continue;
    const [first, ...cells] = splitRow(p);
    const level = levelCell(first ?? '');
    const spells = cells.flatMap((c) => splitTopLevel(plainText(c), ',')).map((s) => s.trim()).filter((s) => s && s !== '—');
    if (level !== null && spells.length) out.push({ level, spells });
  }
  return out;
}

export function parseSubclass(candidate: Candidate): OfflineParse<'subclass'> {
  const [intro, ...rest] = candidate.blocks;
  const features: Wire<'subclass'>['features'] = [];
  for (const block of rest) {
    if (!block.paragraphs.length) continue;
    const titled = LEVEL_TITLE.exec(block.title);
    const older = titled ? null : OLDER_LEVEL.exec(plainText(block.paragraphs[0]));
    if (titled) features.push({ level: Number(titled[1]), name: titled[2].trim(), text: { block: block.id, from: 1, to: block.paragraphs.length } });
    else if (older) features.push({ level: Number(older[1]), name: block.title.trim(), text: { block: block.id, from: 1, to: block.paragraphs.length } });
  }
  features.sort((a, b) => a.level - b.level);

  const paragraphs = intro?.paragraphs ?? [];
  const first = paragraphs[0] ?? '';
  const setApart = /^[*_]+[^*_]+[*_]+$/.test(first.trim());
  const tagline = setApart ? plainText(first) : (sentences(plainText(first))[0] ?? '');
  const spellsAt = paragraphs.findIndex((p) => SPELLS_INTRO.test(plainText(p)));
  const prepared = preparedSpellRows(spellsAt >= 0 ? paragraphs.slice(spellsAt) : []);

  const wire: Wire<'subclass'> = {
    matchesKind: true,
    name: candidate.name,
    format: rest.some((b) => LEVEL_TITLE.test(b.title)) ? '2024' : '2014',
    parentClassText: candidate.parentClassName?.trim() || parentFromTitles(candidate.blocks),
    taglineText: tagline,
    features,
    casterType: 'none',
    spellcastingAbility: 'none',
    alwaysPreparedSpells: prepared,
    notes: '',
  };
  const missing = [...(wire.parentClassText ? [] : ['parentClassText']), ...(features.length ? [] : ['features'])];
  return { wire, missing };
}
