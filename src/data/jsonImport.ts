/**
 * JSON imports: a CompendiumEntry[] or { entries: [...] } file (our own format, for backups and
 * sharing), or a "solo-dm-pack" file (entries with their structured records, spec §3.12), routed to
 * parsePack. Legacy entries are validated, then re-homed in the new library source, exactly as before.
 */
import { z } from 'zod';
import { CONTENT_KINDS, type CompendiumEntry, type ContentKind } from '@/types';
import { guessKind } from './chunk';
import { isPackFile, parsePack, type PackImport } from './structured/packs';

const MAX_ISSUES_SHOWN = 5;

const entrySchema = z.object({
  id: z.string().optional(),
  sourceId: z.string().optional(),
  sourceName: z.string().optional(),
  kind: z.string().optional(),
  name: z.string().trim().min(1, 'needs a name'),
  summary: z.string().nullish(),
  text: z.string({ error: 'needs text' }),
  path: z.array(z.string()).nullish(),
  data: z.record(z.string(), z.unknown()).nullish(),
});

const KINDS = new Set<string>(CONTENT_KINDS);

function entriesOf(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object' && Array.isArray((json as { entries?: unknown }).entries)) {
    return (json as { entries: unknown[] }).entries;
  }
  throw new Error('This JSON file isn\'t a Solo DM library export: expected a list of entries or { "entries": [...] }.');
}

function describeIssue(index: number, raw: unknown, error: z.ZodError): string {
  const rawName = raw && typeof raw === 'object' ? (raw as { name?: unknown }).name : undefined;
  const name = typeof rawName === 'string' && rawName.trim() ? ` ("${rawName.trim()}")` : '';
  const issue = error.issues[0];
  const field = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  return `Entry ${index + 1}${name}: ${field}${issue?.message ?? 'invalid'}`;
}

/**
 * Parse and validate a JSON import. Throws a readable Error when the file is invalid. Entries get
 * new ids ("lib:<sourceId>:<n>") and the new source's id and name; a missing or unknown kind is
 * guessed from the text.
 */
export function parseJsonImport(input: string | unknown, opts: { sourceId: string; sourceName: string }): CompendiumEntry[] {
  let json: unknown = input;
  if (typeof input === 'string') {
    try {
      json = JSON.parse(input);
    } catch (err) {
      throw new Error(`That isn't valid JSON (${err instanceof Error ? err.message : 'parse error'}).`, { cause: err });
    }
  }
  const raw = entriesOf(json);
  if (!raw.length) throw new Error('The JSON file has no entries.');
  const issues: string[] = [];
  const entries: CompendiumEntry[] = [];
  raw.forEach((item, index) => {
    const result = entrySchema.safeParse(item);
    if (!result.success) {
      issues.push(describeIssue(index, item, result.error));
      return;
    }
    const e = result.data;
    const kind: ContentKind = e.kind && KINDS.has(e.kind) ? (e.kind as ContentKind) : e.kind ? 'other' : guessKind(e.name, e.text);
    entries.push({
      id: `lib:${opts.sourceId}:${entries.length + 1}`,
      sourceId: opts.sourceId,
      sourceName: opts.sourceName,
      kind,
      name: e.name,
      ...(e.summary ? { summary: e.summary } : {}),
      text: e.text,
      ...(e.path?.length ? { path: e.path } : {}),
      ...(e.data && Object.keys(e.data).length ? { data: e.data } : {}),
    });
  });
  if (issues.length) {
    const more = issues.length > MAX_ISSUES_SHOWN ? `\n…and ${issues.length - MAX_ISSUES_SHOWN} more.` : '';
    throw new Error(`Some entries in the JSON file are invalid:\n${issues.slice(0, MAX_ISSUES_SHOWN).join('\n')}${more}`);
  }
  return entries;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`That isn't valid JSON (${err instanceof Error ? err.message : 'parse error'}).`, { cause: err });
  }
}

/** What a JSON import holds: a pack (entries and records) or plain entries (the legacy shapes, unchanged). */
export type JsonImport = { type: 'pack'; pack: PackImport } | { type: 'entries'; entries: CompendiumEntry[] };

/** Route one JSON text: { "format": "solo-dm-pack" } → parsePack; anything else → parseJsonImport. */
export function routeJsonImport(text: string, opts: { sourceId: string; sourceName: string }): JsonImport {
  const json = parseJson(text);
  if (isPackFile(json)) return { type: 'pack', pack: parsePack(json, opts) };
  return { type: 'entries', entries: parseJsonImport(json, opts) };
}
