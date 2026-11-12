/**
 * JSON packs and "Download book data" (spec §3.12, documented in docs/PACKS.md): one `solo-dm-pack` v1
 * format built on DATA_SCHEMAS. Pure; the storage write is saveLibrarySourceWithRecords. Campaign
 * exports and sync never import this module (src/test/layering.test.ts).
 *
 * Import rules: entries are re-homed as lib:<sourceId>:<n> in file order; record spans name pack-local
 * entry ids (`{ entries, from, to }`) or give inline text (a plain string), which becomes a new `rule`
 * entry after the pack's entries; every record is validated with DATA_SCHEMAS and validateData, and an
 * invalid one is skipped with its issue while an invalid entry fails the whole file (an entry has nothing
 * to fall back on). Records always arrive pending (`origin: 'pack'`); "book data" records the other device
 * had accepted are marked `reviewedElsewhere` — offered to the player, never applied.
 */
import { z } from 'zod';
import { findSrdClass } from '@/engine/classData';
import { nameKey, slugify } from '@/lib/id';
import { bookFingerprint, textFingerprint } from '@/lib/importedContent';
import {
  CONTENT_KINDS,
  STRUCTURED_KINDS,
  STRUCTURED_SCHEMA_VERSION,
  type CompendiumEntry,
  type ContentKind,
  type LibrarySource,
  type RecordWarning,
  type StructuredDataByKind,
  type StructuredKind,
  type StructuredRecord,
  type SubclassData,
  type TextSpan,
} from '@/types';
import { GUESSED_ENTITY_KINDS, guessKind, headingAncestors, kindsAreGuesses, misreadBefore, withCurrentKinds } from '../chunk';
import { doubtMessage } from './notices';
import { validateData } from './normalize';
import { splitParagraphs } from './paragraphs';
import { DATA_SCHEMAS, RECORD_SCHEMA, STRUCTURED_LIMITS } from './schemas';
import type { CandidateBlock } from './segment';

export interface PackFileV1 {
  format: 'solo-dm-pack';
  version: 1;
  schemaVersion: 1;                    // STRUCTURED_SCHEMA_VERSION of the records' data
  title: string;
  license?: string; attribution?: string; notes?: string;
  /** "Download book data" files only: the book they were made from. */
  bookFingerprint?: string;
  /** "Download book data" files only: true when the entries' kinds are an importer's guesses (a book imported as text), false when they are its file's own. */
  kindsGuessed?: boolean;
  entries: { id: string; name: string; kind?: ContentKind; summary?: string; text: string; path?: string[] }[];
  records?: PackRecordV1[];
}
export interface PackRecordV1 {
  kind: StructuredKind;
  name: string;
  entries: string[];                   // pack-local entry ids, primary first
  span?: 'entry' | 'section' | 'row';  // default 'entry' for one entry, 'section' for several
  rowIndex?: number;
  parentClass?: string;                // subclass: a class record's name in this pack, or an SRD class name
  /** DATA_SCHEMAS[kind]; every TextSpan may be { entries: string[]; from; to } (pack-local ids) or a plain string (inline text). */
  data: unknown;
  /** Book-data files only: its status on the device that made the file. Never applied without the player's tap. */
  reviewedStatus?: 'accepted' | 'pending';
}
export interface PackImport {
  source: Pick<LibrarySource, 'title' | 'license' | 'attribution' | 'notes' | 'fingerprint' | 'kindsGuessed'>;
  entries: CompendiumEntry[]; records: StructuredRecord[];
  issues: { path: string; message: string }[];          // first 20 listed
  reviewedElsewhere: number;                             // records with reviewedStatus 'accepted'
}

export const PACK_FORMAT = 'solo-dm-pack';
export const PACK_VERSION = 1;
/** How many issues a PackImport lists (the rest are counted in the source's notes). */
export const PACK_ISSUES_LISTED = 20;

/** A parsed JSON value that claims to be a pack (`format: 'solo-dm-pack'`); parsePack checks the rest. */
export function isPackFile(json: unknown): boolean {
  return typeof json === 'object' && json !== null && (json as { format?: unknown }).format === PACK_FORMAT;
}

// ---------------------------------------------------------------------------
// The file's shape (lenient where a newer app might add fields; strict where data is read)
// ---------------------------------------------------------------------------

const L = STRUCTURED_LIMITS;
const head = z.object({
  title: z.string().trim().min(1, 'the pack has no title').max(200),
  license: z.string().max(4000).optional(),
  attribution: z.string().max(4000).optional(),
  notes: z.string().max(4000).optional(),
  bookFingerprint: z.string().regex(/^[0-9a-f]{16}$/, 'a book fingerprint is 16 hex characters').optional(),
  kindsGuessed: z.boolean().optional(),
  entries: z.array(z.unknown()).min(1, 'the pack has no entries').max(L.pack.entries, `a pack holds at most ${L.pack.entries} entries`),
  records: z.array(z.unknown()).max(L.pack.records, `a pack holds at most ${L.pack.records} records`).optional(),
});
const packEntry = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(300),
  kind: z.enum(CONTENT_KINDS as [ContentKind, ...ContentKind[]]).optional(),
  summary: z.string().max(1000).optional(),
  text: z.string().max(200_000),
  path: z.array(z.string().max(300)).max(20).optional(),
});
const packRecord = z.object({
  kind: z.enum(STRUCTURED_KINDS as [StructuredKind, ...StructuredKind[]]),
  name: z.string().trim().min(1).max(L.nameChars),
  entries: z.array(z.string().min(1)).min(1).max(L.entriesPerRecord),
  span: z.enum(['entry', 'section', 'row']).optional(),
  rowIndex: z.int().min(0).optional(),
  parentClass: z.string().trim().max(L.nameChars).optional(),
  // Kept as given (no copying), so a JSON "__proto__" own key still reaches DATA_SCHEMAS and fails there.
  data: z.custom<Record<string, unknown>>((v) => typeof v === 'object' && v !== null && !Array.isArray(v), 'data must be an object'),
  reviewedStatus: z.enum(['accepted', 'pending']).optional(),
});

const formatPath = (path: readonly PropertyKey[]) =>
  path.reduce<string>((out, key) => (typeof key === 'number' ? `${out}[${key}]` : out ? `${out}.${String(key)}` : String(key)), '');
const firstIssue = (error: z.ZodError, prefix: string) => {
  const issue = error.issues[0];
  const where = formatPath([...(prefix ? [prefix] : []), ...issue.path]);
  return { path: where || prefix || 'file', message: issue.message };
};
const invalid = (detail: string) => new Error(`This isn't a valid Solo DM pack: ${detail}`);

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** Pure. Throws a readable Error for a file that can't be imported at all; skips invalid records with issues. */
export function parsePack(json: unknown, opts: { sourceId: string; sourceName: string; now?: number }): PackImport {
  if (!isPackFile(json)) throw invalid('it is missing the "solo-dm-pack" format marker.');
  const raw = json as Record<string, unknown>;
  if (typeof raw.version === 'number' && raw.version > PACK_VERSION) {
    throw new Error(`This pack was made by a newer version of Solo DM (pack format ${raw.version}). Update the app, then import it again.`);
  }
  if (raw.version !== PACK_VERSION) throw invalid('its "version" must be 1.');
  if (typeof raw.schemaVersion === 'number' && raw.schemaVersion > STRUCTURED_SCHEMA_VERSION) {
    throw new Error(`This pack's records were made by a newer version of Solo DM (data version ${raw.schemaVersion}). Update the app, then import it again.`);
  }
  if (raw.schemaVersion !== 1) throw invalid('its "schemaVersion" must be 1.');
  const top = head.safeParse(raw);
  if (!top.success) {
    const { path, message } = firstIssue(top.error, '');
    throw invalid(`${path}: ${message}.`);
  }
  const now = opts.now ?? Date.now();
  // Book data of a book imported as text: the entry kinds are what the importer guessed on the other device,
  // so the ones an earlier version misread are corrected, and its records of them get the note. A file
  // without kindsGuessed comes from a version that didn't write it: its fingerprint says it is book data.
  const guessed = top.data.kindsGuessed ?? top.data.bookFingerprint !== undefined;
  const ctx = new PackContext(opts.sourceId, opts.sourceName, now, guessed);
  ctx.readEntries(top.data.entries);
  const records = ctx.readRecords(top.data.records ?? []);
  const fingerprint = top.data.bookFingerprint ?? bookFingerprint(ctx.packEntries.map((e) => e.text));
  const skipped = ctx.skippedNote();
  const notes = [top.data.notes?.trim(), skipped].filter(Boolean).join('\n');
  return {
    source: {
      title: top.data.title,
      ...(top.data.license ? { license: top.data.license } : {}),
      ...(top.data.attribution ? { attribution: top.data.attribution } : {}),
      ...(notes ? { notes } : {}),
      fingerprint,
      kindsGuessed: guessed,
    },
    entries: [...ctx.packEntries, ...ctx.inlineEntries],
    records,
    issues: ctx.issues.slice(0, PACK_ISSUES_LISTED),
    reviewedElsewhere: records.filter((r) => r.reviewedElsewhere).length,
  };
}

interface Draft {
  index: number;
  kind: StructuredKind;
  name: string;
  span: 'entry' | 'section' | 'row';
  rowIndex?: number;
  parentClass?: string;
  data: Record<string, unknown>;
  entryIds: string[];
  reviewedStatus?: 'accepted' | 'pending';
  id: string;
  publicId: string;
}

class PackContext {
  readonly packEntries: CompendiumEntry[] = [];
  readonly inlineEntries: CompendiumEntry[] = [];
  private readonly found: { index: number; path: string; message: string; note: string }[] = [];
  private readonly localToId = new Map<string, string>();
  private readonly byId = new Map<string, CompendiumEntry>();
  private readonly usedIds = new Set<string>();

  /** Issues in file order (records are read in two passes). */
  get issues(): { path: string; message: string }[] {
    return [...this.found].sort((a, b) => a.index - b.index).map(({ path, message }) => ({ path, message }));
  }

  constructor(
    private readonly sourceId: string,
    private readonly sourceName: string,
    private readonly now: number,
    /** The entry kinds are an importer's guesses (book data), not the file author's. */
    private readonly guessedKinds = false,
  ) {}

  private entryId(n: number): string {
    return `lib:${this.sourceId}:${n}`;
  }

  /** Every entry must read (an entry has nothing to fall back on): the first bad one fails the file. */
  readEntries(raw: readonly unknown[]): void {
    raw.forEach((value, i) => {
      const parsed = packEntry.safeParse(value);
      if (!parsed.success) {
        const { path, message } = firstIssue(parsed.error, `entries[${i}]`);
        throw invalid(`${path}: ${message}.`);
      }
      const e = parsed.data;
      if (this.localToId.has(e.id)) throw invalid(`entries[${i}].id: the id "${e.id}" appears twice.`);
      const id = this.entryId(i + 1);
      this.localToId.set(e.id, id);
      const entry: CompendiumEntry = {
        id,
        sourceId: this.sourceId,
        sourceName: this.sourceName,
        kind: e.kind ?? guessKind(e.name, e.text, headingAncestors(e.path, e.name)),
        name: e.name,
        ...(e.summary ? { summary: e.summary } : {}),
        text: e.text,
        ...(e.path?.length ? { path: e.path } : {}),
      };
      this.packEntries.push(entry);
      this.byId.set(id, entry);
    });
    if (!this.guessedKinds) return;
    const corrected = withCurrentKinds(this.packEntries);
    this.packEntries.splice(0, this.packEntries.length, ...corrected);
    for (const e of corrected) this.byId.set(e.id, e);
  }

  readRecords(raw: readonly unknown[]): StructuredRecord[] {
    const drafts: Draft[] = [];
    raw.forEach((value, index) => {
      const draft = this.draft(value, index);
      if (draft) drafts.push(draft);
    });
    const classes = new Map(drafts.filter((d) => d.kind === 'class').map((d) => [nameKey(d.name), d.publicId]));
    return drafts.flatMap((d) => {
      const record = this.record(d, classes);
      return record ? [record] : [];
    });
  }

  private skip(index: number, name: string | undefined, path: string, message: string): null {
    this.found.push({ index, path, message, note: `${name ?? `record ${index + 1}`} (${path}: ${message})` });
    return null;
  }

  /** The record's own fields, entry ids re-homed and its spans converted; null (skipped) when it can't be read. */
  private draft(value: unknown, index: number): Draft | null {
    const where = `records[${index}]`;
    const parsed = packRecord.safeParse(value);
    if (!parsed.success) {
      const { path, message } = firstIssue(parsed.error, where);
      const name = value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string' ? (value as { name: string }).name : undefined;
      return this.skip(index, name, path, message);
    }
    const r = parsed.data;
    const entryIds: string[] = [];
    for (const [i, local] of r.entries.entries()) {
      const id = this.localToId.get(local);
      if (!id) return this.skip(index, r.name, `${where}.entries[${i}]`, `no entry in this pack has the id "${local}"`);
      entryIds.push(id);
    }
    const span = r.span ?? (entryIds.length > 1 ? 'section' : 'entry');
    if (span === 'row' && r.rowIndex === undefined) return this.skip(index, r.name, `${where}.rowIndex`, 'a table row needs its rowIndex');
    // A JSON copy: the file's objects are never kept or mutated.
    const data = JSON.parse(JSON.stringify(r.data)) as Record<string, unknown>;
    const inline: string[] = [];
    for (const site of spanSites(r.kind, data, r.name)) {
      const converted = this.convertSpan(site.holder.text, r.name, site.part, inline);
      if ('issue' in converted) return this.skip(index, r.name, `${where}.data.${site.path}`, converted.issue);
      site.holder.text = converted.span;
    }
    const { id, publicId } = this.ids(r.kind, r.name, span, entryIds[0]);
    return {
      index,
      kind: r.kind,
      name: r.name,
      span,
      ...(r.rowIndex !== undefined ? { rowIndex: r.rowIndex } : {}),
      ...(r.parentClass ? { parentClass: r.parentClass } : {}),
      data,
      entryIds: [...entryIds, ...inline],
      ...(r.reviewedStatus ? { reviewedStatus: r.reviewedStatus } : {}),
      id,
      publicId,
    };
  }

  /** rec:<sourceId>:<kind>:<slug>[-n], and the publicId of §2.6 (a section's or row's shares the suffix). */
  private ids(kind: StructuredKind, name: string, span: Draft['span'], primary: string): { id: string; publicId: string } {
    const slug = slugify(name) || kind;
    let id = `rec:${this.sourceId}:${kind}:${slug}`;
    let suffix = '';
    for (let n = 2; this.usedIds.has(id); n++) {
      suffix = `-${n}`;
      id = `rec:${this.sourceId}:${kind}:${slug}${suffix}`;
    }
    this.usedIds.add(id);
    return { id, publicId: span === 'entry' ? primary : `lib:${this.sourceId}:${kind}:${slug}${suffix}` };
  }

  /** A pack span (`{ entries, from, to }` with pack-local ids, or inline text) as a stored TextSpan. */
  private convertSpan(value: unknown, recordName: string, part: string, inline: string[]): { span: TextSpan } | { issue: string } {
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text) return { issue: 'the inline text is empty' };
      const id = this.entryId(this.packEntries.length + this.inlineEntries.length + 1);
      const path = nameKey(part) === nameKey(recordName) ? [recordName] : [recordName, part];
      const entry: CompendiumEntry = { id, sourceId: this.sourceId, sourceName: this.sourceName, kind: 'rule', name: part, text, path };
      this.inlineEntries.push(entry);
      this.byId.set(id, entry);
      inline.push(id);
      return { span: { entryIds: [id], from: 1, to: Math.max(1, splitParagraphs(text).length) } };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { issue: 'a text span is { "entries": [...], "from": n, "to": n } or the text itself' };
    const s = value as { entries?: unknown; entryIds?: unknown; from?: unknown; to?: unknown };
    const locals = Array.isArray(s.entries) ? s.entries : Array.isArray(s.entryIds) ? s.entryIds : null;
    if (!locals?.length || !locals.every((x): x is string => typeof x === 'string')) return { issue: 'a text span needs the ids of the entries it is in' };
    const entryIds: string[] = [];
    for (const local of locals) {
      const id = this.localToId.get(local);
      if (!id) return { issue: `no entry in this pack has the id "${local}"` };
      entryIds.push(id);
    }
    return { span: { entryIds, from: s.from as number, to: s.to as number } };
  }

  /** Validated, graded and finished; null (skipped) when its data doesn't pass DATA_SCHEMAS. */
  private record(d: Draft, classes: ReadonlyMap<string, string>): StructuredRecord | null {
    const where = `records[${d.index}]`;
    const schema = DATA_SCHEMAS[d.kind] as z.ZodType;
    const checked = schema.safeParse(d.data);
    if (!checked.success) {
      const { path, message } = firstIssue(checked.error, `${where}.data`);
      return this.skip(d.index, d.name, path, message);
    }
    const data = checked.data as StructuredDataByKind[StructuredKind];
    const spanIssue = unresolvedSpan(d.kind, data, this.byId);
    if (spanIssue) return this.skip(d.index, d.name, `${where}.data.${spanIssue.path}`, spanIssue.message);
    const blocks = blocksOf(d.entryIds, this.byId);
    const graded = validateData(d.kind, data, { blocks, entriesById: this.byId, origin: 'pack', spellLists: [] });
    const warnings: RecordWarning[] = [...graded.warnings];
    let parentClassId: string | undefined;
    let confidence = graded.confidence;
    if (d.kind === 'subclass') {
      const parent = d.parentClass || (data as SubclassData).parentClass;
      parentClassId = classes.get(nameKey(parent)) ?? findSrdClass(parent)?.id;
      if (!parentClassId) {
        warnings.push({
          code: 'unresolved-ref',
          severity: 'block',
          field: 'parentClass',
          message: `Its class, ${parent || 'unnamed'}, isn't in this pack or the SRD. Choose the class it attaches to.`,
        });
        confidence = 'low';
      }
    }
    // A record of an entry an earlier version misread (book data from that version): offered with the note, never applied.
    const first = this.byId.get(d.entryIds[0]);
    if (this.guessedKinds && d.span === 'entry' && first && GUESSED_ENTITY_KINDS.includes(d.kind) && misreadBefore(d.kind, first.name, first.text, headingAncestors(first.path, first.name))) {
      warnings.push({ code: 'not-this-kind', severity: 'warn', field: 'kind', message: doubtMessage(d.kind) });
      if (confidence === 'high') confidence = 'medium';
    }
    const texts = d.entryIds.map((id) => this.byId.get(id)?.text ?? '');
    const record: StructuredRecord = {
      id: d.id,
      sourceId: this.sourceId,
      kind: d.kind,
      name: d.name,
      schemaVersion: STRUCTURED_SCHEMA_VERSION,
      publicId: d.publicId,
      entryIds: d.entryIds,
      span: d.span,
      ...(d.rowIndex !== undefined ? { rowIndex: d.rowIndex } : {}),
      candidateKey: `${d.kind}:${nameKey(d.name)}:${d.entryIds[0]}${d.span === 'row' ? `:r${d.rowIndex ?? 0}` : ''}`,
      status: 'pending',
      confidence,
      origin: 'pack',
      data,
      warnings,
      adaptations: graded.adaptations,
      excerpts: [],
      ...(parentClassId ? { parentClassId } : {}),
      edited: false,
      textHash: textFingerprint(texts.join('\n\n')),
      ...(d.reviewedStatus === 'accepted' ? { reviewedElsewhere: true as const } : {}),
      createdAt: this.now,
      updatedAt: this.now,
    };
    const whole = RECORD_SCHEMA.safeParse(record);
    if (!whole.success) {
      const { path, message } = firstIssue(whole.error, where);
      return this.skip(d.index, d.name, path, message);
    }
    return record;
  }

  /** "2 records in this pack couldn't be read and were skipped: Ashen Choir (…), …" for the library row. */
  skippedNote(): string {
    const skipped = [...this.found].sort((a, b) => a.index - b.index).map((f) => f.note);
    if (!skipped.length) return '';
    const shown = skipped.slice(0, 5).join('; ');
    const more = skipped.length > 5 ? `; and ${skipped.length - 5} more` : '';
    const n = skipped.length;
    return `${n} ${n === 1 ? 'record' : 'records'} in this pack couldn't be read and ${n === 1 ? 'was' : 'were'} skipped: ${shown}${more}.`;
  }
}

/** Where a kind's data holds text spans: the object holding `text`, its part name and its path in `data`. */
function spanSites(kind: StructuredKind, data: Record<string, unknown>, recordName: string): { holder: Record<string, unknown>; part: string; path: string }[] {
  const list = (key: string) =>
    (Array.isArray(data[key]) ? (data[key] as unknown[]) : []).flatMap((item, i) =>
      item && typeof item === 'object' && 'text' in item
        ? [{ holder: item as Record<string, unknown>, part: String((item as { name?: unknown }).name ?? recordName), path: `${key}[${i}].text` }]
        : [],
    );
  switch (kind) {
    case 'feat':
      return 'text' in data ? [{ holder: data, part: recordName, path: 'text' }] : [];
    case 'species':
      return [...list('traits'), ...list('lineages')];
    case 'background': {
      const f = data.legacyFeature;
      return f && typeof f === 'object' && 'text' in f
        ? [{ holder: f as Record<string, unknown>, part: String((f as { name?: unknown }).name ?? recordName), path: 'legacyFeature.text' }]
        : [];
    }
    case 'class':
    case 'subclass':
      return list('features');
    default:
      return [];
  }
}

/** Every span resolves (its entries exist; 1 ≤ from ≤ to ≤ the block's paragraph count), else where it fails. */
function unresolvedSpan(kind: StructuredKind, data: StructuredDataByKind[StructuredKind], byId: ReadonlyMap<string, CompendiumEntry>): { path: string; message: string } | null {
  for (const site of spanSites(kind, data as unknown as Record<string, unknown>, '')) {
    const span = site.holder.text as TextSpan;
    const texts = span.entryIds.map((id) => byId.get(id)?.text);
    if (texts.some((t) => t === undefined)) return { path: site.path, message: 'its entries are not in this pack' };
    const count = splitParagraphs(texts.join('\n\n')).length;
    if (span.from < 1 || span.from > span.to || span.to > count) {
      return { path: site.path, message: `paragraphs ${span.from}–${span.to} aren't in its text (it has ${count})` };
    }
  }
  return null;
}

/** The record's entries as review blocks (one entry, or a "Name (part N)" chain), numbered B1, B2… */
function blocksOf(entryIds: readonly string[], byId: ReadonlyMap<string, CompendiumEntry>): CandidateBlock[] {
  const PART = /^(.*) \(part (\d+)\)$/;
  const groups: CompendiumEntry[][] = [];
  for (const id of entryIds) {
    const e = byId.get(id);
    if (!e) continue;
    const last = groups[groups.length - 1];
    const base = PART.exec(e.name)?.[1];
    if (last && base && (PART.exec(last[0].name)?.[1] ?? last[0].name) === base) last.push(e);
    else groups.push([e]);
  }
  return groups.map((g, i) => {
    const text = g.map((e) => e.text).join('\n\n');
    return {
      id: `B${i + 1}`,
      entryIds: g.map((e) => e.id),
      title: PART.exec(g[0].name)?.[1] ?? g[0].name,
      path: g[0].path ?? [g[0].name],
      paragraphs: splitParagraphs(text),
      text,
    };
  });
}

// ---------------------------------------------------------------------------
// Export ("Download book data")
// ---------------------------------------------------------------------------

const ordinal = (id: string) => {
  const parts = id.split(':');
  return parts.length === 3 && /^\d+$/.test(parts[2]) ? Number(parts[2]) : Number.MAX_SAFE_INTEGER;
};

/** Pure. Every entry in ordinal order and every non-rejected record with its reviewedStatus. */
export function exportPack(source: LibrarySource, entries: CompendiumEntry[], records: StructuredRecord[]): PackFileV1 {
  const ordered = [...entries].sort((a, b) => ordinal(a.id) - ordinal(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const present = new Set(ordered.map((e) => e.id));
  const classNames = new Map(records.filter((r) => r.kind === 'class').map((r) => [r.publicId, r.name]));
  const packRecords = records
    .filter((r) => r.status !== 'rejected' && r.data !== null && r.span !== 'table' && r.entryIds.every((id) => present.has(id)))
    .map((r): PackRecordV1 => {
      const parentClass = r.kind === 'subclass' && r.parentClassId ? (classNames.get(r.parentClassId) ?? findSrdClass(r.parentClassId)?.name) : undefined;
      return {
        kind: r.kind,
        name: r.name,
        entries: [...r.entryIds],
        span: r.span === 'table' ? 'entry' : r.span,
        ...(r.rowIndex !== undefined ? { rowIndex: r.rowIndex } : {}),
        ...(parentClass ? { parentClass } : {}),
        data: packSpans(r.kind, r.data as StructuredDataByKind[StructuredKind]),
        reviewedStatus: r.status === 'accepted' ? 'accepted' : 'pending',
      };
    });
  return {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    schemaVersion: 1,
    title: source.title,
    ...(source.license ? { license: source.license } : {}),
    ...(source.attribution ? { attribution: source.attribution } : {}),
    ...(source.notes ? { notes: source.notes } : {}),
    // Whether the kinds are guesses, as this device treats them (a JSON book that didn't record it keeps its kinds
    // here), so the next device treats the book the same way.
    ...(source.fingerprint ? { bookFingerprint: source.fingerprint, kindsGuessed: kindsAreGuesses(source) } : {}),
    entries: ordered.map((e) => ({
      id: e.id,
      name: e.name,
      kind: e.kind,
      ...(e.summary ? { summary: e.summary } : {}),
      text: e.text,
      ...(e.path?.length ? { path: [...e.path] } : {}),
    })),
    records: packRecords,
  };
}

/** A copy of the data with every TextSpan written the pack's way: { entries, from, to } (the entry ids are the file's). */
function packSpans(kind: StructuredKind, data: StructuredDataByKind[StructuredKind]): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
  for (const site of spanSites(kind, copy, '')) {
    const span = site.holder.text as TextSpan;
    site.holder.text = { entries: span.entryIds, from: span.from, to: span.to };
  }
  return copy;
}
