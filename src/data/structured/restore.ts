/**
 * Restore on a device that has the book (spec §7.4): fill book text back into a character's ref'd
 * features (and items with copied text) that are empty, placeholders or redacted. By option id → by
 * fingerprint and location → by title, kind, name and part → by a unique hash match. Never overwrites
 * text the player or DM wrote; never rewrites ids.
 *
 * CONTRACT (Day 0 stub). Owner: E1. gameStore.restoreImportedText() loads this through a dynamic import.
 */
import type { BuilderData, Character, CompendiumEntry, LibrarySource } from '@/types';

export interface LibraryLookup {
  entriesById: ReadonlyMap<string, CompendiumEntry>;        // every library entry on this device, any source, on or off
  sourcesByFingerprint: ReadonlyMap<string, LibrarySource>;
  sourcesByTitle: ReadonlyMap<string, LibrarySource[]>;      // nameKey(title)
  builder: BuilderData;                                      // merged (enabled books)
}
export interface RestoreReport { restored: number; differs: number; missing: { book: string; entryName: string; part?: string }[] }

/** I/O wrapper: reads every library source and entry on this device plus the merged builder data. */
export async function buildLibraryLookup(): Promise<LibraryLookup> {
  throw new Error('data/structured/restore: buildLibraryLookup not implemented');
}

/** Pure. Returns the same character object when nothing was restored. */
export function restoreImportedText(c: Character, lookup: LibraryLookup): { character: Character; report: RestoreReport } {
  void [c, lookup];
  throw new Error('data/structured/restore: restoreImportedText not implemented');
}
