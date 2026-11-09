/**
 * "From “The Gloamwood Almanac”…" on a sheet row whose text the rules index can't give (spec §6.6, §7.5): an
 * item or spell from one of the player's books reads its text live, so when it doesn't resolve the row says
 * where the text is — switched off in the Library, or not on this device at all — and never claims a book
 * is missing while the Library is still loading or the book is there (S4).
 */
import { useLibrarySources } from '@/storage';
import type { ImportedRef, LibrarySource } from '@/types';

type BookRef = Pick<ImportedRef, 'sourceId' | 'sourceTitle' | 'bookFingerprint'>;

/** The row's line for a book's entry the index doesn't have, given this device's library (undefined while it loads). */
export function fromBookLine(ref: BookRef, sources: readonly LibrarySource[] | undefined): string {
  const from = `From “${ref.sourceTitle}”`;
  if (!sources) return `${from}.`;
  // This device's copy: the same source, or another import of the same book (its fingerprint).
  const copies = sources.filter((s) => s.kind === 'import' && (s.id === ref.sourceId || (ref.bookFingerprint !== undefined && s.fingerprint === ref.bookFingerprint)));
  if (!copies.length) return `${from}, which isn't on this device.`;
  return copies.some((s) => s.enabled) ? `${from}.` : `${from}, which is switched off in your Library.`;
}

export function FromBookLine({ bookRef, className }: { bookRef: BookRef; className?: string }) {
  const sources = useLibrarySources();
  return <p className={className}>{fromBookLine(bookRef, sources)}</p>;
}
