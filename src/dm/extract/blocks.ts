/**
 * What a request carries (spec §3.6), and which records a job reads (§3.10): built from a record's
 * candidate (its blocks re-read from storage), never from other entries, the book's title, characters
 * or campaigns.
 *
 * - Every block's heading path starts at the heading just above the candidate and never includes the
 *   document's top-level heading (often the book's title, or a heading the importer made from a file
 *   name, whatever the Library calls the book).
 * - Entity kinds (monster, spell, magic item, feat, item): the candidate's blocks whole, at most 16,000
 *   characters (trailing paragraphs beyond are left out); a gear table sends its own rows (with the
 *   table's header) and the entry's prose around it.
 * - Section kinds (class, subclass, species, background): every block in reading order; a block over 600
 *   characters is abbreviated (each paragraph cut to its first 100 characters + "…", numbering intact)
 *   unless it is the section's first block, its title or first paragraph names core traits,
 *   proficiencies, hit points, starting equipment, spellcasting, pact magic, spells, lineage, ancestry,
 *   legacy or subrace, or it holds a table. At most 60,000 characters: trailing blocks beyond are left out.
 * - A reading of a request cut to fit gets a `warn`; a section's features, traits and lineages in the
 *   blocks left out come from the offline heading scan (§2.7).
 *
 * Owner: E2. Pure.
 */
import { gfmTables, parseOffline, requestParagraphs, type Candidate, type Reading } from '@/data';
import { STRUCTURED_LIMITS } from '@/data/structured/schemas';
import type { Wire } from '@/data/structured/wire';
import { nameKey } from '@/lib/id';
import { STRUCTURED_SCHEMA_VERSION, type RecordWarning, type StructuredKind, type StructuredRecord } from '@/types';
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
  /** Ids of the candidate's blocks left out whole (a section's trailing blocks). */
  dropped: string[];
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

/**
 * A block's heading path as a request carries it: from the heading just above the candidate (its chapter:
 * "Spells", "3rd-Level Spells", "Cleric Domains") down, and never the document's top-level heading unless
 * that heading is the candidate's own (its name is the first block's title anyway). `rootDepth`: where the
 * candidate's own heading sits in its first block's path.
 */
export function requestPath(path: readonly string[], rootDepth: number): string[] {
  const from = rootDepth === 0 ? 0 : Math.max(1, rootDepth - 1);
  return path.slice(Math.max(0, Math.min(from, path.length - 1)));
}

/** The request's blocks for a candidate (§3.6). */
export function requestBlocks(candidate: Candidate): RequestBlocks {
  const section = SECTION_KINDS.has(candidate.kind);
  let cut = false;
  const rootDepth = Math.max(0, (candidate.blocks[0]?.path.length ?? 1) - 1);
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
    return { id: b.id, title: b.title, path: requestPath(b.path, rootDepth), paragraphs: keep ? paragraphs : paragraphs.map(abbreviate), abbreviated: !keep };
  });
  const max = section ? STRUCTURED_LIMITS.requestChars.section : STRUCTURED_LIMITS.requestChars.entity;
  const dropped: string[] = [];
  if (section) {
    while (blocks.length > 1 && charsOf(blocks) > max) {
      dropped.unshift((blocks.pop() as ExtractionBlock).id);
      cut = true;
    }
  }
  for (let last = blocks[blocks.length - 1]; last && charsOf(blocks) > max && last.paragraphs.length > 1; ) {
    last.paragraphs = last.paragraphs.slice(0, -1);
    cut = true;
  }
  return { blocks, chars: charsOf(blocks), cut, dropped };
}

/**
 * Claude's reading of a section cut to fit (§2.7): the features, traits and lineages the offline heading
 * scan finds in the blocks left out are added (Claude never saw them); Claude's own come first.
 */
export function withDroppedBlocks(candidate: Candidate, wire: Wire<StructuredKind>, dropped: readonly string[]): Wire<StructuredKind> {
  if (!dropped.length) return wire;
  const left = new Set(dropped.map((id) => id.toLowerCase()));
  const inLeft = (span: { block: string }) => left.has(span.block.toLowerCase());
  const offline = parseOffline(candidate).wire;
  const add = <T extends { name: string }>(own: readonly T[], scanned: readonly T[], span: (x: T) => { block: string }): T[] => {
    const have = new Set(own.map((x) => nameKey(x.name)));
    return [...own, ...scanned.filter((x) => inLeft(span(x)) && !have.has(nameKey(x.name)))];
  };
  switch (candidate.kind) {
    case 'class':
    case 'subclass': {
      const w = wire as Wire<'class'>;
      return { ...w, features: add(w.features, (offline as Wire<'class'>).features, (f) => f.text) };
    }
    case 'species': {
      const w = wire as Wire<'species'>;
      const o = offline as Wire<'species'>;
      return { ...w, traits: add(w.traits, o.traits, (t) => t.text), lineages: add(w.lineages, o.lineages, (l) => l.text) };
    }
    case 'background': {
      const w = wire as Wire<'background'>;
      const o = offline as Wire<'background'>;
      return !w.legacyFeature.name.trim() && o.legacyFeature.name.trim() && inLeft(o.legacyFeature.text) ? { ...w, legacyFeature: o.legacyFeature } : w;
    }
    default:
      return wire;
  }
}

/** The `warn` a reading of a request cut to fit gets (§2.7, §3.6). */
export function cutWarning(kind: StructuredKind): RecordWarning {
  const message = SECTION_KINDS.has(kind)
    ? 'This section was too long to send to Claude whole: its last parts were read on this device instead. Check its last features against the text.'
    : "This entry was too long to send to Claude whole: its last paragraphs weren't read. Check its last fields against the text.";
  return { code: 'missing', severity: 'warn', message };
}

/** A request's readings with the cut warning: a `warn` makes a confident reading `medium` (§3.9.2). */
export function withCutWarning(readings: readonly Reading[], kind: StructuredKind): Reading[] {
  const warning = cutWarning(kind);
  return readings.map((r) => ({
    ...r,
    normalized: { ...r.normalized, warnings: [...r.normalized.warnings, warning], confidence: r.normalized.confidence === 'high' ? 'medium' : r.normalized.confidence },
  }));
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

/**
 * Records still needing Claude: no data, not kept as text, not a gear table whose rows exist, and not a
 * reading Claude returned without data (it needs a fix, not a second paid read; only a selection re-reads it).
 */
export function missesOf(records: readonly StructuredRecord[]): StructuredRecord[] {
  const tables = readTables(records);
  return records.filter((r) => readable(r) && r.data === null && r.origin !== 'claude' && r.status !== 'rejected' && !(r.span === 'table' && tables.has(r.id)));
}

/** A reading made on this device by the offline reader: what "Also re-read the entries read on this device" sends. */
export const readOnDevice = (r: StructuredRecord): boolean => r.origin === 'parser' && r.data !== null && r.status !== 'rejected';

/**
 * The records a job reads (§3.10 JobChoices): the misses; 'all', the misses plus the readings made on
 * this device (a row's reading stands for its table) — never Claude's readings already paid for, a
 * pack's or hand-filled ones, which only a selection re-reads; or a selection (a row selects its
 * table). Limited to `kinds` when given.
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
    const misses = new Set(missesOf(records).map((r) => r.id));
    const tables = new Set(records.flatMap((r) => (r.span === 'row' && r.tableRecordId && readOnDevice(r) ? [r.tableRecordId] : [])));
    picked = records.filter((r) => readable(r) && (misses.has(r.id) || tables.has(r.id) || readOnDevice(r)));
  } else {
    picked = missesOf(records);
  }
  return choices.kinds?.length ? picked.filter((r) => choices.kinds!.includes(r.kind)) : picked;
}
