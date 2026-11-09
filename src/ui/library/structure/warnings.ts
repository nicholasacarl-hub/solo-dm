/**
 * Which warnings a record carries after the player edits it (pure). validateData re-checks the fields
 * it can (ranges, cross-checks, spans); the producer's notices about fields the player didn't touch
 * stay (an excerpt for HP that wasn't in the text is still worth checking after AC was fixed);
 * detection's name notices and Claude's note always stay; "not read", "failed", "declined" and
 * "isn't this kind" go once the player has filled the fields in.
 */
import type { RecordWarning, StructuredDataByKind, StructuredKind } from '@/types';
import { dataPathsFor } from './forms/fieldMap';
import { getPath } from './forms/paths';

const CONTEXT = new Set<RecordWarning['code']>(['name-collision', 'engine-name', 'spell-list', 'model-note', 'stale-text']);
const RUN = new Set<RecordWarning['code']>(['needs-claude', 'failed', 'refused', 'not-this-kind', 'newer-version']);

const same = (a: RecordWarning, b: RecordWarning) => a.code === b.code && (a.field ?? '') === (b.field ?? '');

/** True when none of the data paths a warning names changed between two versions of the data. */
function untouched(kind: StructuredKind, field: string | undefined, before: unknown, after: unknown): boolean {
  const paths = dataPathsFor(kind, field);
  if (paths.length === 0) return false;
  return paths.every((p) => JSON.stringify(getPath(before, p)) === JSON.stringify(getPath(after, p)));
}

export function mergeWarnings<K extends StructuredKind>(
  kind: K,
  before: StructuredDataByKind[K] | null,
  after: StructuredDataByKind[K],
  stored: readonly RecordWarning[],
  fresh: readonly RecordWarning[],
): RecordWarning[] {
  const out: RecordWarning[] = [...fresh];
  for (const w of stored) {
    if (RUN.has(w.code)) continue;
    if (out.some((x) => same(x, w))) continue;
    if (CONTEXT.has(w.code) || (before !== null && w.field !== undefined && untouched(kind, w.field, before, after))) out.push(w);
  }
  return out;
}

/** Severity order for display: problems first. */
export function bySeverity(a: RecordWarning, b: RecordWarning): number {
  const rank = { block: 0, warn: 1, info: 2 } as const;
  return rank[a.severity] - rank[b.severity];
}
