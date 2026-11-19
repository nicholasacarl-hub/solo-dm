/**
 * Restore on a device that has the book (spec §7.4): fill book text back into a character's ref'd
 * features that are empty or placeholders (a save or GitHub pull left the text out). Resolution, first
 * hit wins:
 *   1. the same option (ref.entryId) in this device's merged builder data → its part;
 *   2. the same book by fingerprint and location (works for a book imported but not structured, or
 *      switched off) → the paragraphs at ref.at, restored only when their fingerprint matches;
 *   3. the same book by title → an accepted option of the kind and name → its part (a different text
 *      still restores, counted in `differs`);
 *   4. the same words anywhere: exactly one accepted option part with the ref's text fingerprint;
 *   5. otherwise the placeholder stays and the ref is listed in `missing`.
 * A fighting style the class feature prints itself (§5.6 fighting-style-inline) is a feature of its own,
 * under a ref naming the style as its part at its own paragraph (or, copied earlier, the Fighting Style
 * feature's whole ref): every step restores only that style's text, never the whole feature (the
 * preamble and every style under one style's name).
 * Text the player or DM wrote is never overwritten; ids in refs are never rewritten (two devices with
 * different source ids keep syncing the same file); a restored ref loses `redacted`. Items are left
 * alone: their copied text is the DM's own words, which the book can't give back (the inventory shows
 * the entry's text live instead).
 *
 * gameStore.restoreImportedText() loads this through a dynamic import and writes the character as is.
 */
import { listLibrarySources, getLibraryEntries } from '@/storage';
import { nameKey } from '@/lib/id';
import { copiedTextMissing, textFingerprint } from '@/lib/importedContent';
import type { BuilderData, Character, CompendiumEntry, Feature, ImportedRef, LibrarySource } from '@/types';
import { loadBuilderData } from '../builderData';
import { inlineFightingStyles } from '../options/classFeatures';
import { featureText, resolveSpan } from './paragraphs';
import { lineageRowText, splitRow } from './parse/srdRulesOptions';

export interface LibraryLookup {
  entriesById: ReadonlyMap<string, CompendiumEntry>;        // every library entry on this device, any source, on or off
  sourcesByFingerprint: ReadonlyMap<string, LibrarySource>;
  sourcesByTitle: ReadonlyMap<string, LibrarySource[]>;      // nameKey(title)
  builder: BuilderData;                                      // merged (enabled books)
}
export interface RestoreReport { restored: number; differs: number; missing: { book: string; entryName: string; part?: string }[] }

/** I/O wrapper: reads every library source and entry on this device plus the merged builder data. */
export async function buildLibraryLookup(): Promise<LibraryLookup> {
  const [sources, builder] = await Promise.all([listLibrarySources(), loadBuilderData()]);
  const imports = sources.filter((s) => s.kind === 'import');
  const entries = imports.length ? await getLibraryEntries(imports.map((s) => s.id)) : [];
  const byFingerprint = new Map<string, LibrarySource>();
  const byTitle = new Map<string, LibrarySource[]>();
  for (const s of imports) {
    if (s.fingerprint && !byFingerprint.has(s.fingerprint)) byFingerprint.set(s.fingerprint, s);
    const key = nameKey(s.title);
    byTitle.set(key, [...(byTitle.get(key) ?? []), s]);
  }
  return { entriesById: new Map(entries.map((e) => [e.id, e])), sourcesByFingerprint: byFingerprint, sourcesByTitle: byTitle, builder };
}

/**
 * A feature whose book text left this copy (empty or a placeholder) and may come back. A stale
 * `ref.redacted` over text the DM wrote since doesn't count: that text is never overwritten.
 */
export function featureNeedsRestore(f: Pick<Feature, 'description' | 'ref'>): boolean {
  return copiedTextMissing(f);
}

/** Pure. Returns the same character object when nothing was restored. */
export function restoreImportedText(c: Character, lookup: LibraryLookup): { character: Character; report: RestoreReport } {
  const report: RestoreReport = { restored: 0, differs: 0, missing: [] };
  let changed = false;
  const features = c.features.map((f) => {
    if (!f.ref || !featureNeedsRestore(f)) return f;
    const found = resolveText(f.ref, f.name, lookup);
    if (!found) {
      report.missing.push({ book: f.ref.sourceTitle, entryName: f.ref.entryName, ...(f.ref.part ? { part: f.ref.part } : {}) });
      return f;
    }
    report.restored += 1;
    if (found.differs) report.differs += 1;
    changed = true;
    const { redacted: _was, ...ref } = f.ref;
    return { ...f, description: found.text, ref };
  });
  return { character: changed ? { ...c, features } : c, report };
}

interface Found { text: string; differs: boolean }

/** The text to restore into the feature named `name` (its ref's part, or the one style of it the feature is). */
function resolveText(ref: ImportedRef, name: string, lookup: LibraryLookup): Found | null {
  const sameHash = (text: string) => ref.textHash !== '' && textFingerprint(text) === ref.textHash;
  const own = (text: string | null) => (text === null ? null : ownText(text, ref, name));
  // 1. The same option, by id.
  const byId = optionParts(lookup.builder, ref.kind).filter((p) => p.optionId === ref.entryId);
  const exact = own(pickPart(byId, ref));
  if (exact) return { text: exact, differs: ref.textHash !== '' && !sameHash(exact) };
  // 2. The same book, by fingerprint and the text's location.
  const atLocation = textAtLocation(ref, name, lookup);
  if (atLocation) return { text: atLocation, differs: false };
  // 3. The same book, by title: an accepted option of this kind and name.
  const titled = lookup.sourcesByTitle.get(nameKey(ref.sourceTitle)) ?? [];
  if (titled.length) {
    const ids = new Set(titled.map((s) => s.id));
    const parts = optionParts(lookup.builder, ref.kind).filter((p) => p.sourceId !== undefined && ids.has(p.sourceId) && nameKey(p.optionName) === nameKey(ref.entryName));
    const text = own(pickPart(parts, ref));
    if (text) return { text, differs: !sameHash(text) };
  }
  // 4. The same words anywhere: exactly one accepted option part with this fingerprint.
  if (ref.textHash) {
    const matches = optionParts(lookup.builder, ref.kind)
      .filter((p) => p.sourceId !== undefined && nameKey(p.optionName) === nameKey(ref.entryName) && partMatches(p, ref))
      .map((p) => own(p.text))
      .filter((text): text is string => text !== null && sameHash(text));
    if (matches.length === 1) return { text: matches[0], differs: false };
  }
  return null;
}

/**
 * The feature's own words in its part's text. A fighting style the class feature prints itself (spec §5.6
 * fighting-style-inline) is copied as a feature of its own, named for the style, under the Fighting Style
 * feature's ref: its text is the style named like the feature (or, renamed, the one with its words), and
 * null when the part no longer prints it — never the whole feature, the preamble and every style under one
 * style's name. Any other feature is its part's whole text ("Divine Order (Protector)" included).
 */
function ownText(text: string, ref: ImportedRef, name: string): string | null {
  if (ref.part === undefined || nameKey(name) === nameKey(ref.part)) return text;
  if (ref.textHash !== '' && textFingerprint(text) === ref.textHash) return text;
  const styles = inlineFightingStyles({ level: ref.level ?? 1, name: ref.part, description: text });
  if (!styles.length) return text;
  const style =
    styles.find((s) => nameKey(s.name) === nameKey(name)) ??
    styles.find((s) => ref.textHash !== '' && textFingerprint(s.description) === ref.textHash);
  return style?.description ?? null;
}

/**
 * One piece of an option's text: a class or subclass feature (and each fighting style a class's Fighting
 * Style feature prints, at that feature's level, for a ref that names the style as its part), a trait, a
 * lineage, a legacy feature, or a feat's whole text.
 */
interface OptionPart { optionId: string; optionName: string; sourceId?: string; part?: string; level?: number; text: string }

function optionParts(builder: BuilderData, kind: ImportedRef['kind']): OptionPart[] {
  const out: OptionPart[] = [];
  const push = (o: { id: string; name: string; source?: { sourceId: string } }, part: string | undefined, text: string | undefined, level?: number) => {
    if (text?.trim()) out.push({ optionId: o.id, optionName: o.name, sourceId: o.source?.sourceId, ...(part !== undefined ? { part } : {}), ...(level !== undefined ? { level } : {}), text });
  };
  switch (kind) {
    case 'class':
      for (const cls of builder.classes) {
        for (const f of cls.features) push(cls, f.name, f.description, f.level);
        // After every feature, so a feature of the same name wins.
        for (const f of cls.features) for (const style of inlineFightingStyles(f)) push(cls, style.name, style.description, f.level);
      }
      break;
    case 'subclass':
      for (const cls of builder.classes) for (const sub of cls.subclasses) for (const f of sub.features) push(sub, f.name, f.description, f.level);
      break;
    case 'species':
      for (const sp of builder.species) {
        for (const t of sp.traits) push(sp, t.name, t.description);
        for (const l of sp.lineages ?? []) push(sp, l.name, l.description);
      }
      break;
    case 'background':
      for (const bg of builder.backgrounds) if (bg.legacyFeature) push(bg, bg.legacyFeature.name, bg.legacyFeature.description);
      break;
    case 'feat':
      for (const feat of builder.feats) push(feat, undefined, feat.description);
      break;
    default:
      break;
  }
  return out;
}

/** The ref's part ("Ember Ward" at level 3; the whole text when the ref names no part). */
function partMatches(p: OptionPart, ref: ImportedRef): boolean {
  if (ref.part === undefined) return p.part === undefined;
  return p.part !== undefined && nameKey(p.part) === nameKey(ref.part) && (ref.level === undefined || p.level === undefined || p.level === ref.level);
}

/** The text of the ref's part among one option's parts; by name alone when the level moved (a merge-time placement). */
function pickPart(parts: readonly OptionPart[], ref: ImportedRef): string | null {
  const exact = parts.filter((p) => partMatches(p, ref));
  if (exact.length) return exact[0].text;
  if (ref.part === undefined) return null;
  const named = parts.filter((p) => p.part !== undefined && nameKey(p.part) === nameKey(ref.part as string));
  return named.length === 1 ? named[0].text : null;
}

/** Step 2: the paragraphs at ref.at in the book with ref.bookFingerprint (the feature's own words in them), when they hash to ref.textHash. */
function textAtLocation(ref: ImportedRef, name: string, lookup: LibraryLookup): string | null {
  if (!ref.bookFingerprint || !ref.at || !ref.textHash) return null;
  const source = lookup.sourcesByFingerprint.get(ref.bookFingerprint);
  if (!source) return null;
  const span = { entryIds: ref.at.ordinals.map((n) => `lib:${source.id}:${n}`), from: ref.at.from, to: ref.at.to };
  const candidates: string[] = [];
  const text = featureText(span, ref.part ?? ref.entryName, lookup.entriesById);
  if (text) candidates.push(text);
  // A lineage printed as a table row: the app builds its text from the row's cells (as the merge does).
  const row = resolveSpan(span, lookup.entriesById);
  if (row && row.trim().startsWith('|')) candidates.push(lineageRowText(splitRow(row)));
  return candidates.map((t) => ownText(t, ref, name)).find((t): t is string => t !== null && textFingerprint(t) === ref.textHash) ?? null;
}
