/**
 * Export redaction of book text copied onto a character (spec §7.3, pure): ref'd descriptions become
 * the placeholder sentence (ref.redacted = true) and the DM's tool_use inputs that echo them are
 * replaced too — in the export copy only (rule 1: the stored campaign and transcript never change).
 * redactImportedDeep (backup.ts) then removes every wrapped lookup passage.
 *
 * Names stay (option, feature and item names, book titles), as they always have in saves; only text
 * copied from a book — or the DM's words about such an entry (ref.textCopied) — leaves the copy.
 * Whatever the DM writes about an item from a book is its words about that entry (§7.1): an
 * inventory_add or inventory_update description of one leaves the transcript copy, and so does that
 * description on the sheet, even where the item was linked without one (its ref still says nothing copied).
 */
import { matchByName } from '@/engine/util';
import { nameKey } from '@/lib/id';
import { importedPlaceholder, isImportedPlaceholder } from '@/lib/importedContent';
import type { Character, Feature, InventoryItem, TranscriptMessage } from '@/types';
import type { CampaignData } from './types';

export interface ExportReport { books: string[]; passages: number }

type EchoKind = 'feature' | 'item';

/**
 * DM tool inputs that can carry a feature's or an item's text: tool → list field → what its entries
 * (name + description) describe. A feature entry names its feature exactly (addFeature); an item entry
 * finds its item as the engine does (updateItem: "Lantern" is the Lantern of Hollow Light).
 */
const ECHOING_INPUTS: Readonly<Record<string, Readonly<Record<string, EchoKind>>>> = {
  level_up: { new_features: 'feature' },
  update_character: { features_add: 'feature', inventory_add: 'item', inventory_update: 'item' },
};

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
  /** The item a DM tool entry names, when it is one from a book. */
  const bookItem = (name: string): InventoryItem | undefined => {
    const item = matchByName(inventory, name, (i) => i.name).match;
    return item?.ref ? item : undefined;
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

  const character = data.character ? redactCharacter(data.character, redactFeature, redactItem) : data.character;
  const titleOf = (kind: EchoKind, name: string) => (kind === 'feature' ? redactedFeatures.get(nameKey(name)) : bookItem(name)?.ref?.sourceTitle);
  const echoesToFind = redactedFeatures.size > 0 || inventory.some((i) => i.ref);
  const transcript = echoesToFind ? data.transcript.map((m) => redactToolInputs(m, titleOf, leftOut)) : data.transcript;

  const changed = character !== data.character || transcript.some((m, i) => m !== data.transcript[i]);
  return {
    data: changed ? { ...data, character, transcript } : data,
    report: { books: [...books].sort((a, b) => a.localeCompare(b)), passages },
  };
}

function redactCharacter(c: Character, redactFeature: (f: Feature) => Feature, redactItem: (i: InventoryItem) => InventoryItem): Character {
  const features = c.features.map(redactFeature);
  const inventory = c.inventory.map(redactItem);
  const same = features.every((f, i) => f === c.features[i]) && inventory.every((x, i) => x === c.inventory[i]);
  return same ? c : { ...c, features, inventory };
}

interface Echo { name: string; description: string }

/** A tool-input list entry that names something and gives it text, or null. */
function echoOf(entry: unknown): Echo | null {
  if (!entry || typeof entry !== 'object') return null;
  const { name, description } = entry as { name?: unknown; description?: unknown };
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
        return kind === 'item' && Array.isArray(list) ? list.map(echoOf).filter((e): e is Echo => e !== null) : [];
      });
    }),
  );
}

/**
 * An assistant message whose level_up / update_character inputs echo a redacted feature's text or describe
 * an item from a book, copied with those descriptions replaced.
 */
function redactToolInputs(m: TranscriptMessage, titleOf: (kind: EchoKind, name: string) => string | undefined, counted: (title: string) => void): TranscriptMessage {
  const content = assistantBlocks(m);
  if (!content) return m;
  let changed = false;
  const blocks = content.map((block) => {
    if (block.type !== 'tool_use') return block;
    const echoing = echoingInput(block);
    if (!echoing) return block;
    const { input } = echoing;
    let inputChanged = false;
    const nextInput: Record<string, unknown> = { ...input };
    for (const [field, kind] of echoing.fields) {
      const list = input[field];
      if (!Array.isArray(list)) continue;
      const next = list.map((item: unknown) => {
        const echo = echoOf(item);
        const title = echo ? titleOf(kind, echo.name) : undefined;
        if (!title) return item;
        counted(title);
        return { ...(item as object), description: importedPlaceholder(title) };
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
