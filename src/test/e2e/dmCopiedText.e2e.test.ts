/**
 * P2 and P3 end to end at function level: the real update_character handler and engine (the DM harness's
 * in-memory store and fake index), then the real export over fake-indexeddb (P2) or the real restore (P3).
 * What the DM writes about an item or a feature from a book leaves saves, and shows where it was written.
 * Invented book content only (the Gloamwood fixture).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/data', () => import('../../dm/testing/fakeData'));
vi.mock('@/state/gameStore', () => import('../../dm/testing/fakeGameStoreModule'));

import { restoreImportedText, type LibraryLookup } from '@/data/structured/restore';
import { deps, resetDmDeps } from '@/dm/deps';
import { SAMPLE_RULES } from '@/dm/testing/fakeData';
import { setupHarness } from '@/dm/testing/harness';
import type { ToolContext } from '@/dm/tools/context';
import { runTool } from '@/dm/tools/handlers';
import { characterSheetText } from '@/engine/summary';
import { nameKey } from '@/lib/id';
import { importedPlaceholder, textFingerprint } from '@/lib/importedContent';
import { exportCampaignBundleWithReport, serializeBundle } from '@/storage/backup';
import { writeCampaignData } from '@/storage/campaignData';
import { db } from '@/storage/db';
import { redactCopiedImports } from '@/storage/redact';
import { campaignGraph, resetDatabase } from '@/storage/testData';
import { sampleCharacter } from '@/test/fixtures';
import {
  EXPECTED_MERGED,
  GLOAMWOOD_SOURCE_ID,
  GLOAMWOOD_SRD_SUBSET,
  GLOAMWOOD_TITLE,
  gloamwoodEntries,
  gloamwoodEntryId,
  gloamwoodSource,
} from '@/test/structuredFixtures';
import type { Character, CompendiumEntry, TranscriptMessage } from '@/types';

beforeEach(resetDatabase);
afterEach(() => resetDmDeps());

const toolContext = (): ToolContext => ({ deps: deps(), signal: new AbortController().signal, status: vi.fn() });

/** The DM's update_character calls as the transcript keeps them (tool_use, then its result). */
async function dmCalls(ctx: ToolContext, sessionId: string, inputs: Record<string, unknown>[]): Promise<TranscriptMessage[]> {
  const out: TranscriptMessage[] = [];
  for (const [n, input] of inputs.entries()) {
    const result = await runTool('update_character', input, ctx);
    expect(result.isError, String(result.content)).toBeUndefined();
    const id = `tu-${n}`;
    out.push(
      { id: `use-${n}`, sessionId, seq: 100 + 2 * n, createdAt: 1, param: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'update_character', input }] } },
      { id: `res-${n}`, sessionId, seq: 101 + 2 * n, createdAt: 2, param: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: String(result.content) }] } },
    );
  }
  return out;
}

describe('P2: the DM’s inventory_update words about a book item, through the tool and the export', () => {
  const lantern: CompendiumEntry = {
    id: gloamwoodEntryId('Lantern of Hollow Light'),
    sourceId: GLOAMWOOD_SOURCE_ID,
    sourceName: GLOAMWOOD_TITLE,
    kind: 'magic-item',
    name: 'Lantern of Hollow Light',
    text: 'Lantern of Hollow Light.',
    data: { recordId: 'rec:gloam:magic-item:lantern-of-hollow-light', rarity: 'uncommon', attunement: true },
  };
  // Invented: what the DM restates about the item after reading it with get_entry.
  const RESTATED = 'While it burns, the lantern shows hidden things to everyone within 30 feet.';

  it('P2: linked without a description, then described ("Lantern"): neither the sheet nor the transcript keeps the words in a save', async () => {
    const h = setupHarness({
      withSession: true,
      rules: [...SAMPLE_RULES, lantern],
      campaignSettings: { enabledSources: ['srd-5.2.1', GLOAMWOOD_SOURCE_ID] },
      character: { ...sampleCharacter(), inventory: [] },
    });
    const g = campaignGraph('p2');
    const sessionId = g.sessions[g.sessions.length - 1].id;
    const calls = await dmCalls(toolContext(), sessionId, [
      { inventory_add: [{ name: 'Lantern of Hollow Light', quantity: 1 }] },
      { inventory_update: [{ name: 'Lantern', attuned: true, description: RESTATED }] },
    ]);
    const played = h.s().character as Character;
    expect(played.inventory.find((i) => i.name === 'Lantern of Hollow Light')).toMatchObject({ attuned: true, description: RESTATED, ref: { entryId: lantern.id } });

    const character = { ...played, id: g.campaign.characterId as string, campaignId: g.campaign.id };
    await writeCampaignData({ ...g, character, transcript: [...g.transcript, ...calls] });
    const { bundle, report } = await exportCampaignBundleWithReport(g.campaign.id);
    expect(serializeBundle(bundle)).not.toContain(RESTATED);
    expect(bundle.character?.inventory.find((i) => i.name === 'Lantern of Hollow Light')).toMatchObject({
      attuned: true,
      description: importedPlaceholder(GLOAMWOOD_TITLE),
      ref: { textCopied: true, redacted: true },
    });
    expect(report).toEqual({ books: [GLOAMWOOD_TITLE], passages: 2 });
    // Rule 1: the stored campaign keeps the DM's words; only the export copy leaves them out.
    expect(JSON.stringify(await db.characters.get(character.id))).toContain(RESTATED);
    expect(JSON.stringify(await db.transcript.get('use-1'))).toContain(RESTATED);
  });

  it('P2: the sheet’s ref marks the words copied, so they leave saves even once the transcript no longer holds the call', async () => {
    const h = setupHarness({
      withSession: true,
      rules: [...SAMPLE_RULES, lantern],
      campaignSettings: { enabledSources: ['srd-5.2.1', GLOAMWOOD_SOURCE_ID] },
      character: { ...sampleCharacter(), inventory: [] },
    });
    const g = campaignGraph('p2-trimmed');
    const sessionId = g.sessions[g.sessions.length - 1].id;
    const calls = await dmCalls(toolContext(), sessionId, [
      { inventory_add: [{ name: 'Lantern of Hollow Light', quantity: 1 }] },
      { inventory_update: [{ name: 'Lantern', description: RESTATED }] },
    ]);
    const played = h.s().character as Character;
    const item = played.inventory.find((i) => i.name === 'Lantern of Hollow Light');
    expect(item).toMatchObject({ description: RESTATED, ref: { entryId: lantern.id, textCopied: true, textHash: textFingerprint(RESTATED) } });

    // The inventory_update call (its tool_use and result) is trimmed from the end; the sheet keeps the words.
    const character = { ...played, id: g.campaign.characterId as string, campaignId: g.campaign.id };
    await writeCampaignData({ ...g, character, transcript: [...g.transcript, ...calls.slice(0, 2)] });
    const { bundle, report } = await exportCampaignBundleWithReport(g.campaign.id);
    expect(serializeBundle(bundle)).not.toContain(RESTATED);
    expect(bundle.character?.inventory.find((i) => i.name === 'Lantern of Hollow Light')).toMatchObject({
      description: importedPlaceholder(GLOAMWOOD_TITLE),
      ref: { textCopied: true, redacted: true },
    });
    expect(report).toEqual({ books: [GLOAMWOOD_TITLE], passages: 1 });
    expect(JSON.stringify(await db.characters.get(character.id))).toContain(RESTATED);
  });

  it('P2: words the DM writes over a pulled placeholder are copied text again, no longer marked left out', async () => {
    const g = campaignGraph('p2-pulled');
    // Device A described the lantern; device B pulled the save (placeholder, ref.redacted).
    const a = setupHarness({ withSession: true, rules: [...SAMPLE_RULES, lantern], campaignSettings: { enabledSources: ['srd-5.2.1', GLOAMWOOD_SOURCE_ID] }, character: { ...sampleCharacter(), inventory: [] } });
    await dmCalls(toolContext(), 'sess-a', [{ inventory_add: [{ name: 'Lantern of Hollow Light', quantity: 1, description: RESTATED }] }]);
    const pulled = redactCopiedImports({ ...g, character: a.s().character as Character }).data.character as Character;
    expect(pulled.inventory[0]).toMatchObject({ description: importedPlaceholder(GLOAMWOOD_TITLE), ref: { redacted: true } });

    const RULING = 'DM ruling: the lantern lights only while its bearer whispers.';
    const b = setupHarness({ withSession: true, character: pulled });
    await dmCalls(toolContext(), 'sess-b', [{ inventory_update: [{ name: 'Lantern of Hollow Light', description: RULING }] }]);
    const ruled = (b.s().character as Character).inventory[0];
    expect(ruled).toMatchObject({ description: RULING, ref: { entryId: lantern.id, textCopied: true, textHash: textFingerprint(RULING) } });
    expect(ruled.ref?.redacted).toBeUndefined();
    const { data } = redactCopiedImports({ ...g, character: b.s().character as Character });
    expect(JSON.stringify(data.character)).not.toContain(RULING);
  });
});

describe('P3: a ruling the DM writes over a pulled placeholder', () => {
  const ember = EXPECTED_MERGED.classes.find((c) => c.id === 'srd:class:fighter')?.subclasses.find((s) => s.name === 'Ember Warden');
  const def = ember?.features.find((f) => f.name === 'Ember Ward');
  if (!def?.ref) throw new Error('fixture changed');
  const RULING = 'DM ruling: once per turn, add 1d4 fire damage.';

  it('P3: shows to the DM on a device without the book, survives the book coming back, and still leaves saves', async () => {
    // Device A copied the feature at level-up; device B pulled the save (placeholder, ref.redacted).
    const deviceA: Character = { ...sampleCharacter(), features: [{ id: 'f1', name: 'Ember Ward', source: 'subclass', sourceName: 'Ember Warden 3', description: def.description, ref: def.ref }] };
    const graph = campaignGraph('p3');
    const pulled = redactCopiedImports({ ...graph, character: deviceA }).data.character as Character;
    expect(pulled.features[0]).toMatchObject({ description: importedPlaceholder(GLOAMWOOD_TITLE), ref: { redacted: true } });
    expect(characterSheetText(pulled)).toContain(`text from the player's book “${GLOAMWOOD_TITLE}” isn't on this device`);

    // Device B has no copy of the book: the DM rules from the name.
    const h = setupHarness({ withSession: true, builderData: GLOAMWOOD_SRD_SUBSET, character: pulled });
    await dmCalls(toolContext(), 'sess-b', [{ features_add: [{ name: 'Ember Ward', description: RULING, source: 'subclass' }] }]);
    const ruled = h.s().character as Character;
    const sheet = characterSheetText(ruled);
    expect(sheet).toContain(RULING);
    expect(sheet).not.toContain("isn't on this device");

    // The player imports the book on device B: the DM's ruling is never overwritten.
    const entries = gloamwoodEntries();
    const source = gloamwoodSource();
    const lookup: LibraryLookup = {
      entriesById: new Map(entries.map((e) => [e.id, e])),
      sourcesByFingerprint: new Map([[source.fingerprint as string, source]]),
      sourcesByTitle: new Map([[nameKey(GLOAMWOOD_TITLE), [source]]]),
      builder: EXPECTED_MERGED,
    };
    const restored = restoreImportedText(ruled, lookup);
    expect(restored.report).toEqual({ restored: 0, differs: 0, missing: [] });
    expect(restored.character.features.find((f) => f.name === 'Ember Ward')?.description).toBe(RULING);

    // The ruling is the DM's words about the book's feature: the next save leaves it out too.
    const { data } = redactCopiedImports({ ...graph, character: ruled });
    expect(JSON.stringify(data.character)).not.toContain(RULING);
  });
});
