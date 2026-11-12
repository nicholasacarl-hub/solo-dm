/**
 * Export redaction of book text copied onto a character (spec §7.3, pure): ref'd descriptions and spell notes
 * become the placeholder sentence (ref.redacted = true) and the DM's tool_use inputs that echo them are
 * replaced too — in the export copy only (rule 1: the stored campaign and transcript never change).
 * redactImportedDeep (backup.ts) then removes every wrapped lookup passage.
 *
 * Names stay (option, feature, item and spell names, book titles), as they always have in saves; only text
 * copied from a book — or the DM's words about such an entry (ref.textCopied) — leaves the copy.
 * Whatever the DM writes about an item from a book is its words about that entry (§7.1): an
 * inventory_add or inventory_update description of one leaves the transcript copy, and so does that
 * description on the sheet, even where the item was linked without one (its ref still says nothing copied).
 * A spell's notes leave it when they repeat a book's words (the DM tools mark them). A call the app refused
 * never reached the sheet, so nothing there marks its text: while a book is in play, every text field and long string
 * in it leaves the copy, whatever the tool (as the refusal's own preview quotes them, handlers.ts). So does, while a book is in play, a call's text the sheet no longer holds under that
 * name (the spell or item was removed, renamed, stacked onto another or rewritten): nothing marks it any more.
 */
import { matchByName } from '@/engine/util';
import { nameKey } from '@/lib/id';
import { hasImported, importedPlaceholder, isImportedPlaceholder } from '@/lib/importedContent';
import type { Character, Feature, InventoryItem, KnownSpell, TranscriptMessage } from '@/types';
import type { CampaignData } from './types';

export interface ExportReport { books: string[]; passages: number }

type EchoKind = 'feature' | 'item' | 'spell';

/**
 * DM tool inputs that can carry a feature's, an item's or a spell's text: tool → list field → what its entries
 * (a name and its text) describe. A feature entry names its feature exactly (addFeature); an item entry
 * finds its item as the engine does (updateItem: "Lantern" is the Lantern of Hollow Light); a spell entry names
 * its spell (addSpell).
 */
const ECHOING_INPUTS: Readonly<Record<string, Readonly<Record<string, EchoKind>>>> = {
  level_up: { new_features: 'feature' },
  update_character: { features_add: 'feature', inventory_add: 'item', inventory_update: 'item', spells_add: 'spell' },
};

/** Each kind's text field in those entries. */
const TEXT_FIELD: Readonly<Record<EchoKind, 'description' | 'notes'>> = { feature: 'description', item: 'description', spell: 'notes' };

/** What stands in an export for the text of a call the app refused. */
export const REFUSED_CALL_TEXT = '[Text of a call the app refused was left out of this copy.]';
/** Keys whose values the refusal preview quotes by length (src/dm/tools/handlers.ts TEXT_KEYS; keep in step), and its long-string bound. */
const REFUSED_TEXT_KEYS = new Set(['description', 'notes', 'details', 'text', 'summary']);
const REFUSED_LONG = 120;

/** A refused call's input with every text field and long string replaced, whatever its shape; unchanged parts shared. */
function refusedInput(value: unknown, key = ''): unknown {
  if (typeof value === 'string') return REFUSED_TEXT_KEYS.has(key) || value.length > REFUSED_LONG ? REFUSED_CALL_TEXT : value;
  if (Array.isArray(value)) {
    const next = value.map((v) => refusedInput(v));
    return next.some((v, i) => v !== value[i]) ? next : value;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.entries(record).map(([k, v]) => [k, refusedInput(v, k)] as const);
    return entries.some(([k, v]) => v !== record[k]) ? Object.fromEntries(entries) : value;
  }
  return value;
}

/** What stands in an export for a call's text that the sheet no longer holds. */
export const STALE_CALL_TEXT = '[Text no longer on the sheet was left out of this copy.]';

type Described = Pick<Feature, 'name' | 'description' | 'ref'> | Pick<InventoryItem, 'name' | 'description' | 'ref'>;

/** Text someone wrote or copied: not empty, not the placeholder. */
const hasText = (description: string | undefined): description is string => Boolean(description?.trim()) && !isImportedPlaceholder(description);

/** Pure. The export copy only: the stored campaign, character and transcript are never changed (rule 1). */
export function redactCopiedImports(data: CampaignData): { data: CampaignData; report: ExportReport } {
  const books = new Set<string>();
  let passages = 0;
  const leftOut = (title: string) => {
    books.add(title);
    passages += 1;
  };
  /** nameKey → book title of every feature whose copied text left the copy. */
  const redactedFeatures = new Map<string, string>();
  const inventory = data.character?.inventory ?? [];
  /** nameKey → book title of every spell whose notes are a book's words (on the sheet now, or left out before). */
  const copiedSpells = new Map<string, string>();
  for (const sp of data.character?.spellcasting?.spells ?? []) if (sp.ref?.textCopied) copiedSpells.set(nameKey(sp.name), sp.ref.sourceTitle);
  /** The item a DM tool entry names, when it is one from a book. */
  const bookItem = (name: string): InventoryItem | undefined => {
    const item = matchByName(inventory, name, (i) => i.name).match;
    return item?.ref ? item : undefined;
  };
  /**
   * For the transcript copy: the book a DM tool entry's words came from. A name that now fits several items
   * ("Lantern" after the hero picks up a "Lantern Hook") counts as the book item's when any of them is one:
   * when unsure, the words stay out of the copy.
   */
  const bookItemTitle = (name: string): string | undefined => {
    const found = matchByName(inventory, name, (i) => i.name);
    const options = found.match ? [found.match] : found.candidates;
    return options.find((i) => i.ref)?.ref?.sourceTitle;
  };
  /** Per book item id: the descriptions the DM's tool calls gave it. */
  const dmWords = new Map<string, Set<string>>();
  for (const echo of itemEchoes(data.transcript)) {
    const item = bookItem(echo.name);
    if (item) dmWords.set(item.id, (dmWords.get(item.id) ?? new Set<string>()).add(echo.description.trim()));
  }

  const redactOne = <T extends Described>(x: T, copied: boolean): T => {
    if (!x.ref || !copied) return x;
    if (!hasText(x.description)) {
      // Already a placeholder (a save made elsewhere): mark it, count nothing.
      return isImportedPlaceholder(x.description) && !x.ref.redacted ? { ...x, ref: { ...x.ref, redacted: true } } : x;
    }
    leftOut(x.ref.sourceTitle);
    return { ...x, description: importedPlaceholder(x.ref.sourceTitle), ref: { ...x.ref, textCopied: true, redacted: true } };
  };
  const redactFeature = (f: Feature): Feature => {
    const out = redactOne(f, Boolean(f.ref?.textCopied));
    if (f.ref && out.description !== f.description) redactedFeatures.set(nameKey(f.name), f.ref.sourceTitle);
    return out;
  };
  // Copied when the ref says so, or when the DM gave the item this very description in a tool call.
  const redactItem = (i: InventoryItem): InventoryItem =>
    redactOne(i, Boolean(i.ref?.textCopied || (i.description && dmWords.get(i.id)?.has(i.description.trim()))));
  // A spell's notes: copied when its ref says so (the DM tools mark notes that repeat a book's words).
  const redactSpell = (sp: KnownSpell): KnownSpell => {
    if (!sp.ref?.textCopied) return sp;
    const out = redactOne({ name: sp.name, description: sp.notes, ref: sp.ref }, true);
    return out.description === sp.notes && out.ref === sp.ref ? sp : { ...sp, notes: out.description, ref: out.ref };
  };

  const character = data.character ? redactCharacter(data.character, redactFeature, redactItem, redactSpell) : data.character;
  const titleOf = (kind: EchoKind, name: string) =>
    kind === 'feature' ? redactedFeatures.get(nameKey(name)) : kind === 'spell' ? copiedSpells.get(nameKey(name)) : bookItemTitle(name);
  // A refused call's text, only while a book is in play: something on the sheet came from one, or the DM looked one up.
  const booksInPlay = sheetFromBooks(data.character) || data.transcript.some(looksUpBook);
  const refused = booksInPlay ? refusedCalls(data.transcript) : new Set<string>();
  // A call's text the sheet still holds under that name is accounted for above; anything else, while a book is in play, goes.
  const onSheet = (kind: EchoKind, name: string, text: string) => !booksInPlay || sheetHolds(data.character, kind, name, text);
  const echoesToFind = booksInPlay || redactedFeatures.size > 0 || copiedSpells.size > 0 || inventory.some((i) => i.ref);
  const transcript = echoesToFind ? data.transcript.map((m) => redactToolInputs(m, titleOf, leftOut, refused, onSheet)) : data.transcript;

  const changed = character !== data.character || transcript.some((m, i) => m !== data.transcript[i]);
  return {
    data: changed ? { ...data, character, transcript } : data,
    report: { books: [...books].sort((a, b) => a.localeCompare(b)), passages },
  };
}

function redactCharacter(
  c: Character,
  redactFeature: (f: Feature) => Feature,
  redactItem: (i: InventoryItem) => InventoryItem,
  redactSpell: (s: KnownSpell) => KnownSpell,
): Character {
  const features = c.features.map(redactFeature);
  const inventory = c.inventory.map(redactItem);
  const known = c.spellcasting?.spells ?? [];
  const spells = known.map(redactSpell);
  const same = features.every((f, i) => f === c.features[i]) && inventory.every((x, i) => x === c.inventory[i]) && spells.every((s, i) => s === known[i]);
  if (same) return c;
  return { ...c, features, inventory, ...(c.spellcasting ? { spellcasting: { ...c.spellcasting, spells } } : {}) };
}

/** Something on the sheet came from one of the player's books. */
function sheetFromBooks(c: Character | null): boolean {
  if (!c) return false;
  return c.features.some((f) => f.ref) || c.inventory.some((i) => i.ref) || (c.spellcasting?.spells ?? []).some((s) => s.ref);
}

/** A user message whose tool results quote a book (the DM looked one up). */
function looksUpBook(m: TranscriptMessage): boolean {
  if (m.param.role !== 'user' || !Array.isArray(m.param.content)) return false;
  return m.param.content.some((b) => b.type === 'tool_result' && hasImported(typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')));
}

/** The sheet still holds this text under this name: a feature's description, an item's (found as the engine finds it), a spell's notes. */
function sheetHolds(c: Character | null, kind: EchoKind, name: string, text: string): boolean {
  if (!c) return false;
  const same = (x: string | undefined) => x?.trim() === text.trim();
  if (kind === 'item') {
    // Found as the engine finds it; a name that now fits several items holds the text if any of them does.
    return matchByName(c.inventory, name, (i) => i.name).candidates.some((i) => same(i.description));
  }
  const key = nameKey(name);
  if (kind === 'spell') return (c.spellcasting?.spells ?? []).some((s) => nameKey(s.name) === key && same(s.notes));
  return c.features.some((f) => nameKey(f.name) === key && same(f.description));
}

/** The tool_use ids whose calls the app refused (an is_error result). */
function refusedCalls(transcript: readonly TranscriptMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of transcript) {
    if (m.param.role !== 'user' || !Array.isArray(m.param.content)) continue;
    for (const b of m.param.content) if (b.type === 'tool_result' && b.is_error) ids.add(b.tool_use_id);
  }
  return ids;
}

interface Echo { name: string; description: string }

/** A tool-input list entry that names something and gives it text (in `field`), or null. */
function echoOf(entry: unknown, field: 'description' | 'notes' = 'description'): Echo | null {
  if (!entry || typeof entry !== 'object') return null;
  const { name } = entry as { name?: unknown };
  const description = (entry as Record<string, unknown>)[field];
  if (typeof name !== 'string' || typeof description !== 'string' || !hasText(description)) return null;
  return { name, description };
}

/** The echoing fields of an assistant message's tool_use block, with its input, or null. */
function echoingInput(block: { type: string; name?: string; input?: unknown }): { input: Record<string, unknown>; fields: [string, EchoKind][] } | null {
  const fields = block.type === 'tool_use' && block.name ? ECHOING_INPUTS[block.name] : undefined;
  if (!fields || !block.input || typeof block.input !== 'object') return null;
  return { input: block.input as Record<string, unknown>, fields: Object.entries(fields) };
}

const assistantBlocks = (m: TranscriptMessage) => (m.param.role === 'assistant' && Array.isArray(m.param.content) ? m.param.content : null);

/** Every item entry with a description in the DM's tool inputs (inventory_add, inventory_update). */
function itemEchoes(transcript: readonly TranscriptMessage[]): Echo[] {
  return transcript.flatMap((m) =>
    (assistantBlocks(m) ?? []).flatMap((block) => {
      const echoing = echoingInput(block);
      if (!echoing) return [];
      return echoing.fields.flatMap(([field, kind]) => {
        const list = echoing.input[field];
        return kind === 'item' && Array.isArray(list) ? list.map((entry: unknown) => echoOf(entry)).filter((e): e is Echo => e !== null) : [];
      });
    }),
  );
}

/**
 * An assistant message whose level_up / update_character inputs echo a redacted feature's text, describe
 * an item from a book or give a book's words as a spell's notes, copied with those texts replaced; in a call the
 * app refused (`refused`), every text is replaced.
 */
function redactToolInputs(
  m: TranscriptMessage,
  titleOf: (kind: EchoKind, name: string) => string | undefined,
  counted: (title: string) => void,
  refused: ReadonlySet<string>,
  onSheet: (kind: EchoKind, name: string, text: string) => boolean,
): TranscriptMessage {
  const content = assistantBlocks(m);
  if (!content) return m;
  let changed = false;
  const blocks = content.map((block) => {
    if (block.type !== 'tool_use') return block;
    if (refused.has(block.id)) {
      const input = refusedInput(block.input);
      if (input === block.input) return block;
      changed = true;
      return { ...block, input };
    }
    const echoing = echoingInput(block);
    if (!echoing) return block;
    const { input } = echoing;
    let inputChanged = false;
    const nextInput: Record<string, unknown> = { ...input };
    for (const [field, kind] of echoing.fields) {
      const list = input[field];
      if (!Array.isArray(list)) continue;
      const text = TEXT_FIELD[kind];
      const next = list.map((item: unknown) => {
        const echo = echoOf(item, text);
        if (!echo) return item;
        const title = titleOf(kind, echo.name);
        if (title) {
          counted(title);
          return { ...(item as object), [text]: importedPlaceholder(title) };
        }
        return onSheet(kind, echo.name, echo.description) ? item : { ...(item as object), [text]: STALE_CALL_TEXT };
      });
      if (next.some((x, i) => x !== list[i])) {
        nextInput[field] = next;
        inputChanged = true;
      }
    }
    if (!inputChanged) return block;
    changed = true;
    return { ...block, input: nextInput };
  });
  return changed ? { ...m, param: { ...m.param, content: blocks } as TranscriptMessage['param'] } : m;
}
