/**
 * What a request carries (spec §3.6), and which records a job reads (§3.10): built from a record's
 * candidate (its blocks re-read from storage), never from other entries, the book's title, characters
 * or campaigns.
 *
 * - Entity kinds (monster, spell, magic item, feat, item): the candidate's blocks whole, at most 16,000
 *   characters (trailing paragraphs beyond are left out); a gear table sends its own rows (with the
 *   table's header) and the entry's prose around it.
 * - Section kinds (class, subclass, species, background): every block in reading order; a block over 600
 *   characters is abbreviated (each paragraph cut to its first 100 characters + "…", numbering intact)
 *   unless it is the section's first block, its title or first paragraph names core traits,
 *   proficiencies, hit points, starting equipment, spellcasting, pact magic, spells, lineage, ancestry,
 *   legacy or subrace, or it holds a table. At most 60,000 characters: trailing blocks beyond are left out.
 *
 * Owner: E2. Pure.
 */
import { gfmTables, requestParagraphs, type Candidate } from '@/data';
import { STRUCTURED_LIMITS } from '@/data/structured/schemas';
import { STRUCTURED_SCHEMA_VERSION, type StructuredKind, type StructuredRecord } from '@/types';
import type { ExtractionBlock } from '../libraryRequests';
import type { PlannedRequest } from './estimate';

const SECTION_KINDS = new Set<StructuredKind>(['class', 'subclass', 'species', 'background']);
const ABBREVIATE_OVER = 600;
const ABBREVIATED_PARAGRAPH = 100;
const KEEP_WHOLE = /core traits|proficienc|hit points?|hit point die|hit dice|starting equipment|spellcasting|pact magic|\bspells?\b|lineage|ancestry|legacy|subrace/i;

export interface RequestBlocks {
  blocks: ExtractionBlock[];
  /** Characters of the blocks' paragraphs as sent. */
  chars: number;
  /** Paragraphs or blocks left out to fit the request limit (§2.7). */
  cut: boolean;
}

const charsOf = (blocks: readonly ExtractionBlock[]) => blocks.reduce((s, b) => s + b.paragraphs.reduce((t, p) => t + p.length, 0), 0);
const abbreviate = (p: string) => (p.length > ABBREVIATED_PARAGRAPH ? `${p.slice(0, ABBREVIATED_PARAGRAPH).trimEnd()}…` : p);

/** A gear table's rows (header on the first) plus the block's prose that isn't another table. */
function tableParagraphs(text: string, table: NonNullable<Candidate['table']>): string[] {
  const paragraphs = requestParagraphs(text);
  const isRow = (p: string) => /^\s*\|/.test(p.split('\n').at(-1) ?? '');
  const prose = paragraphs.filter((p) => !isRow(p));
  const t = gfmTables(text)[table.index];
  if (!t) return paragraphs;
  const line = (cells: readonly string[]) => `| ${cells.join(' | ')} |`;
  const rows = t.rows.slice(table.firstRow, table.firstRow + table.rows).map(line);
  const head = `${line(t.header)}\n|${t.header.map(() => '---').join('|')}|`;
  return [...prose.slice(0, 2), ...(rows.length ? [`${head}\n${rows[0]}`, ...rows.slice(1)] : [])];
}

/** The request's blocks for a candidate (§3.6). */
export function requestBlocks(candidate: Candidate): RequestBlocks {
  const section = SECTION_KINDS.has(candidate.kind);
  let cut = false;
  const blocks: ExtractionBlock[] = candidate.blocks.map((b, i) => {
    const text = b.text ?? b.paragraphs.join('\n\n');
    const full = candidate.table && candidate.span !== 'entry' ? tableParagraphs(text, candidate.table) : requestParagraphs(text);
    const paragraphs = full.length === b.paragraphs.length || candidate.table ? full : b.paragraphs;
    const length = paragraphs.reduce((s, p) => s + p.length, 0);
    const keep =
      !section ||
      i === 0 ||
      length <= ABBREVIATE_OVER ||
      KEEP_WHOLE.test(b.title) ||
      KEEP_WHOLE.test(paragraphs[0] ?? '') ||
      paragraphs.some((p) => p.trimStart().startsWith('|'));
    return { id: b.id, title: b.title, path: b.path, paragraphs: keep ? paragraphs : paragraphs.map(abbreviate), abbreviated: !keep };
  });
  const max = section ? STRUCTURED_LIMITS.requestChars.section : STRUCTURED_LIMITS.requestChars.entity;
  if (section) {
    while (blocks.length > 1 && charsOf(blocks) > max) {
      blocks.pop();
      cut = true;
    }
  }
  for (let last = blocks[blocks.length - 1]; last && charsOf(blocks) > max && last.paragraphs.length > 1; ) {
    last.paragraphs = last.paragraphs.slice(0, -1);
    cut = true;
  }
  return { blocks, chars: charsOf(blocks), cut };
}

/** The planner's view of one request (for the estimate). */
export function planRequest(candidate: Candidate): PlannedRequest {
  const { blocks, chars } = requestBlocks(candidate);
  return {
    kind: candidate.kind,
    chars,
    blocks: blocks.length,
    paragraphs: blocks.reduce((s, b) => s + b.paragraphs.length, 0),
    rows: candidate.kind === 'item' ? (candidate.table?.rows ?? 1) : 0,
  };
}

/** A gear table whose rows exist is read; its rows never go to Claude on their own (their table does). */
function readTables(records: readonly StructuredRecord[]): Set<string> {
  return new Set(records.flatMap((r) => (r.span === 'row' && r.tableRecordId ? [r.tableRecordId] : [])));
}

/** A record Claude can read: not a row (its table is), not from a newer app version. */
const readable = (r: StructuredRecord) => r.span !== 'row' && r.schemaVersion <= STRUCTURED_SCHEMA_VERSION;

/** Records still needing Claude: no data, not kept as text, and not a gear table whose rows exist. */
export function missesOf(records: readonly StructuredRecord[]): StructuredRecord[] {
  const tables = readTables(records);
  return records.filter((r) => readable(r) && r.data === null && r.status !== 'rejected' && !(r.span === 'table' && tables.has(r.id)));
}

/**
 * The records a job reads (§3.10 JobChoices): the misses, everything not kept as text, or a selection
 * (a row selects its table), limited to `kinds` when given.
 */
export function jobRecords(
  records: readonly StructuredRecord[],
  choices: { claudeFor: 'misses' | 'all' | 'selection'; kinds?: readonly StructuredKind[]; recordIds?: readonly string[] },
): StructuredRecord[] {
  const byId = new Map(records.map((r) => [r.id, r]));
  let picked: StructuredRecord[];
  if (choices.claudeFor === 'selection') {
    const ids = new Set((choices.recordIds ?? []).map((id) => {
      const r = byId.get(id);
      return r?.span === 'row' && r.tableRecordId ? r.tableRecordId : id;
    }));
    picked = records.filter((r) => ids.has(r.id) && readable(r));
  } else if (choices.claudeFor === 'all') {
    picked = records.filter((r) => readable(r) && r.status !== 'rejected');
  } else {
    picked = missesOf(records);
  }
  return choices.kinds?.length ? picked.filter((r) => choices.kinds!.includes(r.kind)) : picked;
}
