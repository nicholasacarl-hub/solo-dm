/**
 * Export redaction of book text copied onto a character (spec §7.3, pure): ref'd descriptions become
 * the placeholder sentence (ref.redacted = true) and the DM's tool_use inputs that echo them are
 * replaced too — in the export copy only (rule 1: the stored campaign and transcript never change).
 * redactImportedDeep (backup.ts) then removes every wrapped lookup passage.
 *
 * Names stay (option, feature and item names, book titles), as they always have in saves; only text
 * copied from a book — or the DM's words about such an entry (ref.textCopied) — leaves the copy.
 */
import { nameKey } from '@/lib/id';
import { importedPlaceholder, isImportedPlaceholder } from '@/lib/importedContent';
import type { Character, Feature, ImportedRef, InventoryItem, TranscriptMessage } from '@/types';
import type { CampaignData } from './types';

export interface ExportReport { books: string[]; passages: number }

/** DM tool inputs that can carry a feature's or item's text: tool → list field (the entries have name + description). */
const ECHOING_INPUTS: Readonly<Record<string, readonly string[]>> = {
  level_up: ['new_features'],
  update_character: ['features_add', 'inventory_add'],
};

type Described = Pick<Feature, 'name' | 'description' | 'ref'> | Pick<InventoryItem, 'name' | 'description' | 'ref'>;

const needsRedaction = (x: Described): x is Described & { ref: ImportedRef } =>
  Boolean(x.ref?.textCopied && x.description?.trim() && !isImportedPlaceholder(x.description));

/** Pure. The export copy only: the stored campaign, character and transcript are never changed (rule 1). */
export function redactCopiedImports(data: CampaignData): { data: CampaignData; report: ExportReport } {
  const books = new Set<string>();
  let passages = 0;
  /** nameKey → book title of every feature or item whose copied text left the copy. */
  const redactedNames = new Map<string, string>();

  const redactOne = <T extends Described>(x: T): T => {
    if (!x.ref?.textCopied) return x;
    if (!needsRedaction(x)) {
      // Already a placeholder (a save made elsewhere): mark it, count nothing.
      return isImportedPlaceholder(x.description) && !x.ref.redacted ? { ...x, ref: { ...x.ref, redacted: true } } : x;
    }
    const title = x.ref.sourceTitle;
    books.add(title);
    passages += 1;
    redactedNames.set(nameKey(x.name), title);
    return { ...x, description: importedPlaceholder(title), ref: { ...x.ref, redacted: true } };
  };

  const character = data.character ? redactCharacter(data.character, redactOne) : data.character;
  const transcript = redactedNames.size
    ? data.transcript.map((m) =>
        redactToolInputs(m, redactedNames, (title) => {
          books.add(title);
          passages += 1;
        }),
      )
    : data.transcript;

  const changed = character !== data.character || transcript.some((m, i) => m !== data.transcript[i]);
  return {
    data: changed ? { ...data, character, transcript } : data,
    report: { books: [...books].sort((a, b) => a.localeCompare(b)), passages },
  };
}

function redactCharacter(c: Character, redactOne: <T extends Described>(x: T) => T): Character {
  const features = c.features.map((f) => redactOne(f));
  const inventory = c.inventory.map((i) => redactOne(i));
  const same = features.every((f, i) => f === c.features[i]) && inventory.every((x, i) => x === c.inventory[i]);
  return same ? c : { ...c, features, inventory };
}

/** An assistant message whose level_up / update_character inputs echo a redacted feature's or item's text, copied with those descriptions replaced. */
function redactToolInputs(m: TranscriptMessage, names: ReadonlyMap<string, string>, counted: (title: string) => void): TranscriptMessage {
  const content = m.param.role === 'assistant' ? m.param.content : null;
  if (!Array.isArray(content)) return m;
  let changed = false;
  const blocks = content.map((block) => {
    if (block.type !== 'tool_use') return block;
    const fields = ECHOING_INPUTS[block.name];
    if (!fields || !block.input || typeof block.input !== 'object') return block;
    const input = block.input as Record<string, unknown>;
    let inputChanged = false;
    const nextInput: Record<string, unknown> = { ...input };
    for (const field of fields) {
      const list = input[field];
      if (!Array.isArray(list)) continue;
      const next = list.map((item: unknown) => {
        if (!item || typeof item !== 'object') return item;
        const entry = item as { name?: unknown; description?: unknown };
        const title = typeof entry.name === 'string' ? names.get(nameKey(entry.name)) : undefined;
        if (!title || typeof entry.description !== 'string' || !entry.description.trim() || isImportedPlaceholder(entry.description)) return item;
        counted(title);
        return { ...entry, description: importedPlaceholder(title) };
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
